import * as SQLite from 'expo-sqlite';

type Rupiah = number;

/**
 * INVARIAN FEE INTEGRAL (EIR) — BUG-03.
 * ============================================================
 *
 * Fee integral pembiayaan punya siklus hidup sendiri di
 * `pinjaman_akuntansi_jasa`, dengan tiga jenis baris:
 *
 *   FEE_INTEGRAL_AMORTISASI  satu baris per pinjaman.
 *                            `saldo_akhir_carrying` = FEE AWAL, tidak
 *                            pernah berubah setelah ditulis.
 *   EIR_MONTHLY              amortisasi bulanan.
 *                            `pendapatan_akuntansi` = yang diakui.
 *   EIR_DERECOGNITION        penyelesaian sisa fee saat pelunasan
 *                            dipercepat / hapus buku.
 *
 * INVARIAN:
 *
 *     feeAwal = amortisasi + derecognition + sisa
 *     sisa >= 0
 *     amortisasi + derecognition <= feeAwal
 *
 * KENAPA MODUL INI ADA
 * --------------------
 * `getEirTersimpan()` menghitung sisa fee dengan
 * `Math.max(0, saldoAwal - SUM(EIR_MONTHLY))`. Dua masalah:
 *
 *  1. `Math.max(0, ...)` MENYEMBUNYIKAN over-amortisasi. Kalau bug
 *     membuat total amortisasi melebihi fee awal, sisanya dilaporkan 0
 *     dan tidak ada yang tahu. Fungsi di sini sengaja menghitung nilai
 *     MENTAH (boleh negatif) supaya pelanggaran terlihat.
 *  2. Ia TIDAK mengurangi baris EIR_DERECOGNITION. Itu benar untuk
 *     pemakaiannya sendiri — setelah derecognition,
 *     `eir_measurement_status` menjadi 'DERECOGNIZED' dan
 *     `getEirTersimpan` mengembalikan null, jadi tidak ada risiko
 *     pengakuan ganda. Tetapi untuk REKONSILIASI saldo GL, baris
 *     derecognition WAJIB ikut dikurangkan: jurnalnya sudah mendebit
 *     2-1300 sampai nol, sehingga subledger yang tidak
 *     memperhitungkannya akan melaporkan selisih palsu.
 */
export interface InvarianFeeEir {
  pinjamanId: string;
  /** Fee awal yang ditangguhkan (saldo_akhir_carrying baris FEE_INTEGRAL_AMORTISASI). */
  feeAwal: Rupiah;
  /** Total diakui lewat amortisasi bulanan (EIR_MONTHLY). */
  amortisasi: Rupiah;
  /** Total diakui lewat penyelesaian sisa (EIR_DERECOGNITION). */
  derecognition: Rupiah;
  /** amortisasi + derecognition. */
  totalDiakui: Rupiah;
  /**
   * feeAwal - totalDiakui. SENGAJA TIDAK di-clamp ke 0 — nilai negatif
   * berarti fee diakui melebihi yang ditangguhkan, dan itu harus
   * terlihat, bukan disembunyikan.
   */
  sisaFee: Rupiah;
  /** feeAwal - (totalDiakui + sisaFee). Harus 0 secara aljabar; dihitung sebagai sanity check. */
  variance: Rupiah;
  seimbang: boolean;
  /**
   * RC-S54 TAHAP 9 — penyesuaian bunga efektif akrual X (bertanda) yang
   * masih tercatat di 2-1300: Σ(pendapatan_akuntansi - amortisasi_fee) atas
   * baris EIR_MONTHLY dan EIR_DERECOGNITION. 0 setelah derecognition.
   */
  penyesuaianAkrual: Rupiah;
  /** Saldo komponen EIR pinjaman ini di 2-1300 = sisaFee - penyesuaianAkrual. */
  saldoKomponenEir: Rupiah;
}

const SQL_INVARIAN = `
  SELECT fi.pinjaman_id AS pinjaman_id,
         COALESCE(fi.saldo_akhir_carrying, 0) AS fee_awal,
         COALESCE((
           SELECT SUM(m.amortisasi_fee) FROM pinjaman_akuntansi_jasa m
           WHERE m.pinjaman_id = fi.pinjaman_id
             AND m.tipe_pengakuan = 'EIR_MONTHLY'
             AND m.status = 'DIAKUI'
         ), 0) AS amortisasi,
         COALESCE((
           SELECT SUM(d.amortisasi_fee) FROM pinjaman_akuntansi_jasa d
           WHERE d.pinjaman_id = fi.pinjaman_id
             AND d.tipe_pengakuan = 'EIR_DERECOGNITION'
             AND d.status = 'DIAKUI'
         ), 0) AS derecognition,
         COALESCE((
           SELECT SUM(x.pendapatan_akuntansi - x.amortisasi_fee) FROM pinjaman_akuntansi_jasa x
           WHERE x.pinjaman_id = fi.pinjaman_id
             AND x.tipe_pengakuan IN ('EIR_MONTHLY','EIR_DERECOGNITION')
             AND x.status = 'DIAKUI'
         ), 0) AS akrual
  FROM pinjaman_akuntansi_jasa fi
  WHERE fi.tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'
`;

function bangunInvarian(row: {
  pinjaman_id: string;
  fee_awal: number;
  amortisasi: number;
  derecognition: number;
  akrual: number;
}): InvarianFeeEir {
  const feeAwal = row.fee_awal ?? 0;
  const amortisasi = row.amortisasi ?? 0;
  const derecognition = row.derecognition ?? 0;
  const totalDiakui = amortisasi + derecognition;
  const sisaFee = feeAwal - totalDiakui;
  const variance = feeAwal - (totalDiakui + sisaFee);
  return {
    pinjamanId: row.pinjaman_id,
    feeAwal,
    amortisasi,
    derecognition,
    totalDiakui,
    sisaFee,
    variance,
    seimbang: variance === 0 && sisaFee >= 0 && totalDiakui <= feeAwal,
    penyesuaianAkrual: row.akrual ?? 0,
    saldoKomponenEir: sisaFee - (row.akrual ?? 0),
  };
}

/** Invarian fee EIR untuk SATU pinjaman. `null` bila pinjaman tidak ber-EIR. */
export async function hitungInvarianFeeEir(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string
): Promise<InvarianFeeEir | null> {
  const row = await db.getFirstAsync<{
    pinjaman_id: string;
    fee_awal: number;
    amortisasi: number;
    derecognition: number;
    akrual: number;
  }>(`${SQL_INVARIAN} AND fi.pinjaman_id = ?`, pinjamanId);
  return row ? bangunInvarian(row) : null;
}

/** Invarian fee EIR untuk SELURUH pinjaman ber-EIR. */
export async function hitungInvarianFeeEirSemua(
  db: SQLite.SQLiteDatabase
): Promise<InvarianFeeEir[]> {
  const rows = await db.getAllAsync<{
    pinjaman_id: string;
    fee_awal: number;
    amortisasi: number;
    derecognition: number;
    akrual: number;
  }>(SQL_INVARIAN);
  return rows.map(bangunInvarian);
}

/**
 * Total sisa fee integral yang MASIH mengendap di 2-1300.
 *
 * Dipakai rekonsiliasi deferred income. `Math.max(0, ...)` diterapkan
 * PER PINJAMAN — bukan pada totalnya — supaya satu pinjaman yang
 * over-amortized tidak menutupi kekurangan pinjaman lain. Pelanggaran
 * per pinjaman tetap terdeteksi lewat `hitungInvarianFeeEirSemua()`.
 */
export async function totalSisaFeeIntegral(db: SQLite.SQLiteDatabase): Promise<Rupiah> {
  const semua = await hitungInvarianFeeEirSemua(db);
  return semua.reduce((total, r) => total + Math.max(0, r.sisaFee), 0);
}

/**
 * RC-S54 TAHAP 9 — total komponen EIR di 2-1300 (bertanda per pinjaman):
 * Σ (max(0, sisaFee) - penyesuaianAkrual).
 *
 * Sejak pengukuran amortized cost, 2-1300 memuat selisih carrying amount
 * D = sisaFee - X, bukan hanya sisa fee. Rekonsiliasi deferred income
 * memakai fungsi ini; `totalSisaFeeIntegral` tetap ada untuk pemakai yang
 * memang hanya butuh komponen fee.
 */
export async function totalKomponenEirDi2_1300(db: SQLite.SQLiteDatabase): Promise<Rupiah> {
  const semua = await hitungInvarianFeeEirSemua(db);
  return semua.reduce((total, r) => total + Math.max(0, r.sisaFee) - r.penyesuaianAkrual, 0);
}

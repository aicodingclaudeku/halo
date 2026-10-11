import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { getAccountBalance, createJournal } from '@/accounting/AccountingEngine';
import { requirePermission } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';

/**
 * CashReconciliationService — Phase 11 (AUDIT_INTERNAL.md §5:
 * "CashReconciliationService: MISSING"). Mencocokkan saldo BUKU (hasil
 * hitung dari jurnal, `getAccountBalance`) dengan saldo FISIK (hasil
 * hitung uang tunai sungguhan, atau saldo di rekening koran bank —
 * diinput manual, app ini offline & tidak bisa mengambil data bank
 * secara otomatis).
 *
 * Dipakai sebagai SALAH SATU syarat sebelum periode boleh ditutup
 * (`PeriodCloseService.tutupPeriode`) — kalau ada rekonsiliasi
 * berstatus SELISIH yang belum "diselesaikan" (dicocokkan ulang jadi
 * COCOK) dalam periode itu, penutupan periode ditolak.
 */

export interface CatatRekonsiliasiInput {
  accountId: string;
  namaRekening: string;
  tanggal: string;
  saldoFisik: Rupiah;
  keterangan?: string;
  createdBy: string;
}

export interface RekonsiliasiRow {
  id: string;
  accountId: string;
  namaRekening: string;
  tanggal: string;
  saldoBuku: Rupiah;
  saldoFisik: Rupiah;
  selisih: Rupiah;
  status: 'COCOK' | 'SELISIH';
}

/**
 * RC-S67.9 — akun yang boleh direkonsiliasi: HANYA akun Kas/Bank, dengan
 * definisi yang SAMA dengan `KasBankService.listRekening()` (sumber
 * RekeningPicker): akun mapping KAS_UMUM / KAS_KECIL (DEFAULT) atau akun
 * yang terhubung ke `bank_account`. Akun COA lain (piutang, utang, beban,
 * dll.) ditolak di service — bukan hanya disembunyikan di UI.
 */
async function isAkunKasBank(db: SQLite.SQLiteDatabase, accountId: string): Promise<boolean> {
  const r = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (
       SELECT account_id FROM account_mapping
        WHERE transaction_type IN ('KAS_UMUM','KAS_KECIL') AND role = 'DEFAULT' AND account_id = ?
       UNION
       SELECT account_id FROM bank_account WHERE account_id = ?
     )`,
    accountId,
    accountId
  );
  return (r?.n ?? 0) > 0;
}

/**
 * RC-S67.9 — saldo buku rekening PER TANGGAL rekonsiliasi (read-only),
 * dengan fungsi yang sama yang dipakai `catatRekonsiliasi` saat mencatat.
 * Dipakai layar untuk pratinjau: tanggal historis → saldo historis,
 * bukan saldo saat ini.
 */
export async function getSaldoBukuPerTanggal(accountId: string, tanggal: string): Promise<Rupiah> {
  const db = await getDb();
  return getAccountBalance(db, accountId, tanggal);
}

async function catatDalamTransaksi(db: SQLite.SQLiteDatabase, input: CatatRekonsiliasiInput): Promise<RekonsiliasiRow> {
  await requirePermission(db, input.createdBy, 'kas_bank', 'create');

  // RC-S67.9 — validasi masukan di service (bukan hanya di layar).
  // Pembatasan rekening Kas/Bank diterapkan di `catatRekonsiliasiDanTindakLanjut`
  // (jalur layar); `catatRekonsiliasi` lama dipertahankan perilakunya karena
  // dipakai langsung oleh pemanggil/test lama dengan akun kas tanpa mapping.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.tanggal ?? '')) {
    throw new Error('Tanggal rekonsiliasi tidak valid.');
  }
  if (typeof input.saldoFisik !== 'number' || !Number.isFinite(input.saldoFisik) || !Number.isInteger(input.saldoFisik) || input.saldoFisik < 0) {
    throw new Error('Saldo eksternal harus berupa angka rupiah (tidak boleh kosong atau negatif).');
  }

  const saldoBuku = await getAccountBalance(db, input.accountId, input.tanggal);
  const selisih = input.saldoFisik - saldoBuku;
  const status: 'COCOK' | 'SELISIH' = selisih === 0 ? 'COCOK' : 'SELISIH';

  const id = newId();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO rekonsiliasi_kas_bank
      (id, account_id, nama_rekening, tanggal, saldo_buku, saldo_fisik, selisih, status, keterangan, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.accountId,
    input.namaRekening,
    input.tanggal,
    saldoBuku,
    input.saldoFisik,
    selisih,
    status,
    input.keterangan ?? null,
    input.createdBy,
    now
  );

  return {
    id,
    accountId: input.accountId,
    namaRekening: input.namaRekening,
    tanggal: input.tanggal,
    saldoBuku,
    saldoFisik: input.saldoFisik,
    selisih,
    status,
  };
}

/** Catat satu rekonsiliasi — saldo buku dihitung OTOMATIS saat itu juga, tidak diinput manual. */
export async function catatRekonsiliasi(input: CatatRekonsiliasiInput): Promise<RekonsiliasiRow> {
  return withTransaction((db) => catatDalamTransaksi(db, input));
}

/** Riwayat rekonsiliasi — untuk layar histori. */
export async function listRekonsiliasi(opts: { accountId?: string } = {}): Promise<RekonsiliasiRow[]> {
  const db = await getDb();
  const where = opts.accountId ? `WHERE account_id = ?` : '';
  const rows = await db.getAllAsync<any>(
    `SELECT * FROM rekonsiliasi_kas_bank ${where} ORDER BY tanggal DESC, created_at DESC`,
    ...(opts.accountId ? [opts.accountId] : [])
  );
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    namaRekening: r.nama_rekening,
    tanggal: r.tanggal,
    saldoBuku: r.saldo_buku,
    saldoFisik: r.saldo_fisik,
    selisih: r.selisih,
    status: r.status,
  }));
}

/**
 * Cek apakah ada rekonsiliasi SELISIH yang "belum terselesaikan" untuk
 * setiap akun — didefinisikan sebagai: rekonsiliasi TERAKHIR (paling
 * baru SECARA TANGGAL rekonsiliasi, bukan urutan input) untuk akun itu
 * (pada atau sebelum tanggalMaksimum) berstatus SELISIH. Kalau setelah
 * SELISIH ada rekonsiliasi baru yang COCOK, dianggap sudah
 * terselesaikan (mis. sudah dikoreksi/ditelusuri).
 *
 * PHASE 1.1 (harden): "terakhir" SEBELUMNYA ditentukan lewat
 * MAX(rowid) — yaitu urutan INPUT ke database, bukan urutan TANGGAL
 * rekonsiliasi. Ini salah kalau petugas menginput rekonsiliasi tidak
 * berurutan tanggalnya (mis. mencatat rekonsiliasi 31 Des dulu, lalu
 * belakangan menyusulkan rekonsiliasi 30 Des yang tertinggal) — rowid
 * yang lebih besar (30 Des, diinput belakangan) akan salah dianggap
 * "terbaru" padahal tanggalnya lebih lama dari 31 Des. Sekarang
 * "terakhir" ditentukan murni dari tanggal (DESC), lalu created_at
 * (DESC) untuk memecah dua rekonsiliasi bertanggal sama pada hari
 * yang sama, dan rowid (DESC) sebagai tie-breaker TERAKHIR kalau
 * created_at juga sama persis (mis. dua insert di milidetik yang
 * sama — pola yang sama seperti fix race-condition MAX(rowid) di
 * CashReconciliationService.test.ts Phase 11).
 */
export async function getRekonsiliasiTerakhirPerAkun(
  db: SQLite.SQLiteDatabase,
  tanggalMaksimum: string
): Promise<{
  accountId: string;
  namaRekening: string;
  status: 'COCOK' | 'SELISIH';
  selisih: Rupiah;
  tanggal: string;
  // RC-S78 — ditambahkan agar PeriodClose dapat menilai TINDAK LANJUT,
  // bukan sekadar ada/tidaknya selisih.
  statusPenyelesaian: 'DRAFT' | 'SELESAI';
  penyebab: PenyebabSelisih | null;
  perlakuan: PerlakuanSelisih | null;
  journalId: string | null;
}[]> {
  const rows = await db.getAllAsync<any>(
    `SELECT r.account_id, r.nama_rekening, r.status, r.selisih, r.tanggal,
            r.status_penyelesaian, r.penyebab, r.perlakuan, r.journal_id
     FROM rekonsiliasi_kas_bank r
     WHERE r.tanggal <= ?
       AND r.rowid = (
         SELECT r2.rowid FROM rekonsiliasi_kas_bank r2
         WHERE r2.account_id = r.account_id AND r2.tanggal <= ?
         ORDER BY r2.tanggal DESC, r2.created_at DESC, r2.rowid DESC
         LIMIT 1
       )`,
    tanggalMaksimum,
    tanggalMaksimum
  );
  return rows.map((r) => ({
    accountId: r.account_id,
    namaRekening: r.nama_rekening,
    status: r.status,
    selisih: r.selisih,
    tanggal: r.tanggal,
    statusPenyelesaian: r.status_penyelesaian,
    penyebab: (r.penyebab as PenyebabSelisih | null) ?? null,
    perlakuan: (r.perlakuan as PerlakuanSelisih | null) ?? null,
    journalId: (r.journal_id as string | null) ?? null,
  }));
}

/**
 * RC-S79 — status rekonsiliasi SETIAP rekening Kas/Bank aktif, DIBATASI
 * pada periode yang sedang ditutup.
 *
 * `getRekonsiliasiTerakhirPerAkun` mengambil baris terakhir dari
 * SELURUH histori sampai tanggal tertentu, sehingga pemeriksaan bulan
 * Juli bisa "memenuhi" penutupan bulan Agustus — periode yang sama
 * sekali belum diperiksa tetap lolos. Fungsi ini membatasi pencarian ke
 * rentang periodenya sendiri, dan mengembalikan rekening yang BELUM
 * punya pemeriksaan sama sekali sebagai `rekonsiliasi: null`.
 *
 * Rekening yang dianggap wajib: akun yang terdaftar sebagai kas
 * (`account_mapping` KAS_UMUM/KAS_KECIL) atau bank (`bank_account`
 * aktif) — sumber yang sama dengan `isAkunKasBank`, supaya daftar wajib
 * dan daftar yang boleh direkonsiliasi tidak pernah berbeda.
 */
export async function getStatusRekonsiliasiPeriode(
  db: SQLite.SQLiteDatabase,
  periodeMulai: string,
  periodeSelesai: string
): Promise<
  {
    accountId: string;
    namaRekening: string;
    rekonsiliasi: {
      status: 'COCOK' | 'SELISIH';
      statusPenyelesaian: 'DRAFT' | 'SELESAI';
      penyebab: PenyebabSelisih | null;
      perlakuan: PerlakuanSelisih | null;
      journalId: string | null;
      tanggal: string;
      /** RC-S80 — nominal selisih AKTUAL (bertanda), bukan penanda ada/tidak. */
      selisih: number;
    } | null;
  }[]
> {
  // Dua sumber, digabung:
  //   (a) rekening yang WAJIB direkonsiliasi — kas/bank terdaftar & aktif;
  //   (b) rekening yang SUDAH punya baris pemeriksaan dalam periode ini.
  //
  // (b) penting: baris yang sudah terlanjur ada tetap harus dinilai
  // walau rekeningnya tidak (lagi) terdaftar sebagai kas/bank —
  // pemeriksaan DRAFT yang menggantung tidak boleh hilang dari
  // pengawasan hanya karena mapping-nya berubah.
  // DISTINCT pada account_id saja: nama rekening yang tersimpan di baris
  // rekonsiliasi bisa berbeda dari nama akun di COA (mis. rekening
  // di-rename setelah pemeriksaan), dan UNION atas pasangan
  // (id, nama) akan memunculkan akun yang sama dua kali.
  const wajib = await db.getAllAsync<any>(
    `SELECT a.id AS account_id, a.nama AS nama
       FROM account a
      WHERE a.id IN (
              SELECT a2.id FROM account a2
               WHERE a2.is_active = 1
                 AND (a2.id IN (SELECT account_id FROM account_mapping
                                 WHERE transaction_type IN ('KAS_UMUM','KAS_KECIL') AND role = 'DEFAULT')
                   OR a2.id IN (SELECT account_id FROM bank_account WHERE aktif = 1))
              UNION
              SELECT r.account_id FROM rekonsiliasi_kas_bank r
               WHERE r.tanggal >= ? AND r.tanggal <= ?
            )
      ORDER BY a.kode`,
    periodeMulai,
    periodeSelesai
  );

  const hasil = [];
  for (const w of wajib) {
    // Pemeriksaan TERAKHIR DI DALAM periode — bukan yang terakhir
    // secara keseluruhan. Pemeriksaan September tidak boleh memenuhi
    // penutupan Agustus, dan Juli tidak boleh menggantikannya.
    const r = await db.getFirstAsync<any>(
      `SELECT status, status_penyelesaian, penyebab, perlakuan, journal_id, tanggal, nama_rekening, selisih
         FROM rekonsiliasi_kas_bank
        WHERE account_id = ? AND tanggal >= ? AND tanggal <= ?
        ORDER BY tanggal DESC, created_at DESC, rowid DESC
        LIMIT 1`,
      w.account_id,
      periodeMulai,
      periodeSelesai
    );
    hasil.push({
      accountId: w.account_id,
      namaRekening: (r?.nama_rekening as string) ?? (w.nama as string),
      rekonsiliasi: r
        ? {
            status: r.status,
            statusPenyelesaian: r.status_penyelesaian,
            penyebab: (r.penyebab as PenyebabSelisih | null) ?? null,
            perlakuan: (r.perlakuan as PerlakuanSelisih | null) ?? null,
            journalId: (r.journal_id as string | null) ?? null,
            tanggal: r.tanggal,
            selisih: (r.selisih as number) ?? 0,
          }
        : null,
    });
  }
  return hasil;
}

/**
 * RC-S78 — apakah satu baris rekonsiliasi MENGHALANGI tutup periode.
 *
 * Sebelumnya PeriodClose memblokir setiap baris `status === 'SELISIH'`,
 * dengan pesan "rekonsiliasi ulang sampai cocok". Itu keliru secara
 * operasional: perbedaan waktu yang sudah diperiksa dan dijelaskan
 * MEMANG membuat saldo buku dan rekening koran berbeda pada tanggal
 * yang sama, dan tidak akan pernah "cocok" hanya karena diulang.
 * Aturan lama mendorong orang menutup selisih dengan jurnal karangan
 * supaya periode bisa ditutup — persis yang RC ini larang.
 *
 * Yang benar-benar berbahaya adalah selisih yang BELUM ditindaklanjuti,
 * dan baris SELESAI yang isinya tidak konsisten (mengaku sudah dijurnal
 * tetapi tidak punya jurnal, atau sebaliknya).
 */
export function rekonsiliasiMenghalangiTutupPeriode(r: {
  status: 'COCOK' | 'SELISIH';
  statusPenyelesaian: 'DRAFT' | 'SELESAI';
  penyebab: PenyebabSelisih | null;
  perlakuan: PerlakuanSelisih | null;
  journalId: string | null;
}): boolean {
  if (r.status === 'COCOK') return false; // tidak ada yang perlu ditindaklanjuti
  if (r.statusPenyelesaian === 'DRAFT') return true; // selisih belum ditindaklanjuti

  // SELESAI — periksa konsistensinya. Baris yang mengaku selesai tetapi
  // isinya bertentangan lebih berbahaya daripada DRAFT yang jujur.
  if (r.penyebab === null || r.perlakuan === null) return true;
  if (!PENYEBAB_SELISIH.includes(r.penyebab)) return true;
  if (PERLAKUAN_SAH[r.penyebab] !== r.perlakuan) return true;
  if (r.perlakuan === 'PERLU_JURNAL' && r.journalId === null) return true;
  if (r.perlakuan === 'TIDAK_PERLU_JURNAL' && r.journalId !== null) return true;
  return false;
}

// ===========================================================================
// FASE 9 — PENYELESAIAN REKONSILIASI
// ===========================================================================
//
// PERLUASAN dari `catatRekonsiliasi()` di atas, BUKAN service kedua.
// Pencatatan saldo buku vs saldo eksternal tidak berubah sama sekali;
// yang ditambahkan adalah TINDAK LANJUT atas selisihnya:
//
//     selisih -> penyebab -> perlakuan -> (jurnal | tanpa jurnal) -> SELESAI
//
// Dua kolom status sengaja dipisah. `status` menjawab "apakah ada
// selisih" (COCOK/SELISIH) dan tidak pernah berubah setelah dicatat;
// `status_penyelesaian` menjawab "apakah selisih itu sudah
// ditindaklanjuti" (DRAFT/SELESAI). Menggabungkannya akan menghapus
// jejak bahwa selisihnya pernah ada.

export type PenyebabSelisih =
  | 'TRANSAKSI_BELUM_TERCATAT'
  | 'TIMING_DIFFERENCE'
  | 'BIAYA_ADMIN_BANK'
  | 'JASA_GIRO'
  | 'SELISIH_PENCATATAN'
  | 'SELISIH_FISIK'
  | 'KESALAHAN_BANK'
  | 'LAINNYA';

export type PerlakuanSelisih = 'TIDAK_PERLU_JURNAL' | 'PERLU_JURNAL';

export const PENYEBAB_SELISIH: readonly PenyebabSelisih[] = [
  'TRANSAKSI_BELUM_TERCATAT',
  'TIMING_DIFFERENCE',
  'BIAYA_ADMIN_BANK',
  'JASA_GIRO',
  'SELISIH_PENCATATAN',
  'SELISIH_FISIK',
  'KESALAHAN_BANK',
  'LAINNYA',
];

// ===========================================================================
// RC-S78 — MATRIKS PERLAKUAN
// ===========================================================================
//
// Rekonsiliasi adalah kontrol internal untuk mendukung keandalan saldo
// Kas/Bank, ketepatan pencatatan, dan dokumentasi penyelesaian
// perbedaan. Ia BUKAN alat untuk memaksa saldo buku menyamai saldo
// eksternal.
//
// Itulah aturan yang ditegakkan di bawah: hanya tiga penyebab yang
// memang merupakan transaksi koperasi sendiri yang boleh menghasilkan
// jurnal. Sisanya diselesaikan di tempat kejadiannya — transaksi asal,
// workflow koreksi, atau pihak bank.
//
// Membuat jurnal untuk penyebab lain berarti menutupi masalah: saldo
// terlihat cocok sementara transaksi yang hilang tetap hilang, atau
// kesalahan bank dibayar oleh pembukuan koperasi.

/** Perlakuan yang SAH untuk tiap penyebab. Ditegakkan service, bukan hanya UI. */
export const PERLAKUAN_SAH: Record<PenyebabSelisih, PerlakuanSelisih> = {
  // Transaksinya sendiri yang belum ada — dicatat lewat menu transaksi,
  // lalu rekonsiliasi diulang. Jurnal dari sini hanya akan menciptakan
  // pencatatan kedua yang tidak punya dokumen sumber.
  TRANSAKSI_BELUM_TERCATAT: 'TIDAK_PERLU_JURNAL',
  // Sudah tercatat, tetapi salah. Koreksinya milik transaksi asal;
  // jurnal penyeimbang dari sini akan menyisakan transaksi salah itu
  // apa adanya di buku.
  SELISIH_PENCATATAN: 'TIDAK_PERLU_JURNAL',
  // Bukan kesalahan siapa pun — hanya belum sampai di rekening koran.
  TIMING_DIFFERENCE: 'TIDAK_PERLU_JURNAL',
  // Kesalahan pihak bank. Menjurnalnya berarti koperasi membukukan
  // beban atas kekeliruan yang bukan miliknya.
  KESALAHAN_BANK: 'TIDAK_PERLU_JURNAL',
  // Exception, bukan pintu belakang untuk jurnal generik.
  LAINNYA: 'TIDAK_PERLU_JURNAL',
  // Tiga di bawah adalah transaksi koperasi yang nyata dan berdokumen.
  BIAYA_ADMIN_BANK: 'PERLU_JURNAL',
  JASA_GIRO: 'PERLU_JURNAL',
  SELISIH_FISIK: 'PERLU_JURNAL',
};

/**
 * Arah selisih yang sah untuk penyebab tertentu.
 * `null` = kedua arah sah.
 *
 * Biaya bank hanya mengurangi saldo; jasa giro hanya menambah. Kalau
 * arahnya terbalik, yang dipilih operator hampir pasti bukan penyebab
 * sebenarnya — dan menerimanya akan menghasilkan jurnal terbalik.
 */
export const ARAH_SAH: Partial<Record<PenyebabSelisih, 'KURANG' | 'LEBIH'>> = {
  BIAYA_ADMIN_BANK: 'KURANG',
  JASA_GIRO: 'LEBIH',
};

/** Penyebab yang hanya masuk akal untuk rekening BANK. */
export const PENYEBAB_KHUSUS_BANK: readonly PenyebabSelisih[] = [
  'TIMING_DIFFERENCE',
  'BIAYA_ADMIN_BANK',
  'JASA_GIRO',
  'KESALAHAN_BANK',
];

/** Penyebab yang hanya masuk akal untuk rekening KAS / KAS KECIL. */
export const PENYEBAB_KHUSUS_KAS: readonly PenyebabSelisih[] = ['SELISIH_FISIK'];

/** Penyebab yang WAJIB disertai catatan pemeriksaan. */
/**
 * RC-S81 — penyebab yang boleh LANGSUNG menjadi SELESAI.
 *
 * Sisanya adalah TEMUAN: memilih penyebabnya bukan menyelesaikannya.
 * "Transaksi belum tercatat" baru selesai setelah transaksinya
 * benar-benar dicatat; "salah pencatatan" setelah transaksi sumbernya
 * dikoreksi; "kesalahan bank" setelah bank memperbaikinya. Menutupnya
 * di sini berarti periode bisa ditutup atas dasar pengakuan operator,
 * bukan bukti — dan selisihnya hilang dari pengawasan.
 *
 * Yang boleh selesai seketika hanya dua kelompok:
 *   - TIMING_DIFFERENCE: penjelasannya sudah lengkap saat itu juga,
 *     dan saldo memang akan tetap berbeda pada tanggal itu.
 *   - tiga penyebab penyesuaian: jurnalnya dibukukan di transaksi yang
 *     sama, jadi buktinya ada.
 */
export const PENYEBAB_SELESAI_SEKETIKA: readonly PenyebabSelisih[] = [
  'TIMING_DIFFERENCE',
  'BIAYA_ADMIN_BANK',
  'JASA_GIRO',
  'SELISIH_FISIK',
];

/** Temuan yang disimpan sebagai DRAFT dan menunggu bukti penyelesaian. */
export function penyebabTetapDraft(penyebab: PenyebabSelisih): boolean {
  return !PENYEBAB_SELESAI_SEKETIKA.includes(penyebab);
}

export const PENYEBAB_WAJIB_CATATAN: readonly PenyebabSelisih[] = [
  'TRANSAKSI_BELUM_TERCATAT',
  'SELISIH_PENCATATAN',
  'TIMING_DIFFERENCE',
  'KESALAHAN_BANK',
  'SELISIH_FISIK',
  'LAINNYA',
  // Biaya bank & jasa giro wajib referensi/bukti bank — juga lewat `keterangan`.
  'BIAYA_ADMIN_BANK',
  'JASA_GIRO',
];

export interface RekonsiliasiDetailRow extends RekonsiliasiRow {
  readonly statusPenyelesaian: 'DRAFT' | 'SELESAI';
  readonly penyebab: PenyebabSelisih | null;
  readonly perlakuan: PerlakuanSelisih | null;
  readonly journalId: string | null;
  readonly diselesaikanOleh: string | null;
  readonly diselesaikanAt: string | null;
  readonly keterangan: string | null;
}

function petakanDetail(r: Record<string, unknown>): RekonsiliasiDetailRow {
  return {
    id: r.id as string,
    accountId: r.account_id as string,
    namaRekening: r.nama_rekening as string,
    tanggal: r.tanggal as string,
    saldoBuku: r.saldo_buku as number,
    saldoFisik: r.saldo_fisik as number,
    selisih: r.selisih as number,
    status: r.status as 'COCOK' | 'SELISIH',
    statusPenyelesaian: (r.status_penyelesaian as 'DRAFT' | 'SELESAI') ?? 'DRAFT',
    penyebab: (r.penyebab as PenyebabSelisih | null) ?? null,
    perlakuan: (r.perlakuan as PerlakuanSelisih | null) ?? null,
    journalId: (r.journal_id as string | null) ?? null,
    diselesaikanOleh: (r.diselesaikan_oleh as string | null) ?? null,
    diselesaikanAt: (r.diselesaikan_at as string | null) ?? null,
    keterangan: (r.keterangan as string | null) ?? null,
  };
}

export async function getRekonsiliasiDetail(id: string): Promise<RekonsiliasiDetailRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT * FROM rekonsiliasi_kas_bank WHERE id = ?`,
    id
  );
  return r ? petakanDetail(r) : null;
}

export async function listRekonsiliasiDetail(opts: {
  hanyaBelumSelesai?: boolean;
  accountId?: string;
} = {}): Promise<RekonsiliasiDetailRow[]> {
  const db = await getDb();
  // Penyaringan di SQL, bukan di layar: layar yang menyaring tetap
  // menerima seluruh baris lebih dulu, dan itu tidak berskala.
  const filter: string[] = [];
  const params: string[] = [];
  if (opts.hanyaBelumSelesai) filter.push("status_penyelesaian = 'DRAFT'");
  if (opts.accountId) {
    filter.push('account_id = ?');
    params.push(opts.accountId);
  }
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM rekonsiliasi_kas_bank
     ${filter.length > 0 ? `WHERE ${filter.join(' AND ')}` : ''}
     ORDER BY tanggal DESC, created_at DESC`,
    ...params
  );
  return rows.map(petakanDetail);
}

export interface SelesaikanRekonsiliasiInput {
  rekonsiliasiId: string;
  penyebab: PenyebabSelisih;
  perlakuan: PerlakuanSelisih;
  /**
   * Akun lawan untuk jurnal penyesuaian. WAJIB bila
   * `perlakuan === 'PERLU_JURNAL'`; diabaikan bila tidak.
   * Akun ditentukan pengurus — service tidak menebak akun mana yang
   * pantas untuk sebuah selisih.
   */
  akunLawanId?: string;
  catatan?: string;
  createdBy: string;
}

/**
 * SELESAIKAN REKONSILIASI.
 *
 * Dua jalur, keduanya berakhir di status SELESAI:
 *
 *   TIDAK_PERLU_JURNAL — mis. timing difference. Tidak ada jurnal
 *     dibuat. Penyebab, catatan, penyelesai, dan waktunya disimpan
 *     supaya keputusan itu dapat diaudit.
 *
 *   PERLU_JURNAL — jurnal penyesuaian dibuat lewat AccountingEngine,
 *     membawa saldo buku ke saldo eksternal. Arahnya mengikuti tanda
 *     selisih:
 *       selisih > 0 (eksternal lebih besar) -> Dr Kas/Bank, Cr akun lawan
 *       selisih < 0 (eksternal lebih kecil) -> Dr akun lawan, Cr Kas/Bank
 *
 * IDEMPOTEN: baris yang sudah SELESAI ditolak. Itu berarti dua pemanggil
 * yang berlomba hanya menghasilkan SATU jurnal — penjaminnya baris
 * database, bukan penjaga di memori.
 */
export async function selesaikanRekonsiliasi(
  input: SelesaikanRekonsiliasiInput
): Promise<RekonsiliasiDetailRow> {
  return withTransaction((db) => selesaikanDalamTransaksi(db, input));
}

async function selesaikanDalamTransaksi(
  db: SQLite.SQLiteDatabase,
  input: SelesaikanRekonsiliasiInput
): Promise<RekonsiliasiDetailRow> {
  {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');

    const row = await db.getFirstAsync<Record<string, unknown>>(
      `SELECT * FROM rekonsiliasi_kas_bank WHERE id = ?`,
      input.rekonsiliasiId
    );
    if (!row) throw new Error('Data rekonsiliasi tidak ditemukan.');
    const detail = petakanDetail(row);

    if (detail.statusPenyelesaian === 'SELESAI') {
      throw new Error('Rekonsiliasi ini sudah diselesaikan. Penyelesaian kedua ditolak.');
    }
    if (!PENYEBAB_SELISIH.includes(input.penyebab)) {
      throw new Error(`Penyebab selisih tidak dikenali: ${String(input.penyebab)}.`);
    }

    // RC-S78 — MATRIKS PERLAKUAN DITEGAKKAN DI SINI, bukan hanya di UI.
    // Layar boleh menyembunyikan pilihan; service yang menolaknya.
    const sah = PERLAKUAN_SAH[input.penyebab];
    if (input.perlakuan !== sah) {
      throw new Error(
        sah === 'TIDAK_PERLU_JURNAL'
          ? `Penyebab ini tidak diselesaikan dengan jurnal rekonsiliasi. Tindak lanjuti pada transaksi terkait atau pihak bank.`
          : `Penyebab ini memerlukan pencatatan penyesuaian.`
      );
    }

    // Arah selisih harus cocok dengan penyebabnya. Biaya bank hanya
    // mengurangi saldo, jasa giro hanya menambah.
    const arah = ARAH_SAH[input.penyebab];
    if (arah === 'KURANG' && detail.selisih >= 0) {
      throw new Error('Biaya bank hanya berlaku untuk selisih kurang.');
    }
    if (arah === 'LEBIH' && detail.selisih <= 0) {
      throw new Error('Jasa giro hanya berlaku untuk selisih lebih.');
    }

    // RC-S79 — JENIS REKENING harus cocok dengan penyebabnya.
    // "Biaya bank" pada rekening Kas, atau "selisih kas fisik" pada
    // rekening Bank, adalah kekeliruan pemilihan — bukan temuan. UI
    // sudah menyaringnya, tetapi UI bukan penjaganya.
    // Hanya tiga penyebab yang benar-benar MUSTAHIL pada rekening kas
    // (biaya bank, jasa giro, kesalahan bank) plus selisih kas fisik
    // yang mustahil pada bank. "Perbedaan waktu" sengaja TIDAK dibatasi
    // di service: setoran tunai yang belum masuk pembukuan kas juga
    // perbedaan waktu, dan UI sudah menyaringnya untuk bank.
    const KHUSUS_BANK_SERVICE: readonly PenyebabSelisih[] = ['BIAYA_ADMIN_BANK', 'JASA_GIRO', 'KESALAHAN_BANK'];
    if (KHUSUS_BANK_SERVICE.includes(input.penyebab) || PENYEBAB_KHUSUS_KAS.includes(input.penyebab)) {
      const bank = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM bank_account WHERE account_id = ?`,
        detail.accountId
      );
      const isBank = (bank?.n ?? 0) > 0;
      if (KHUSUS_BANK_SERVICE.includes(input.penyebab) && !isBank) {
        throw new Error('Penyebab ini hanya berlaku untuk rekening bank.');
      }
      if (PENYEBAB_KHUSUS_KAS.includes(input.penyebab) && isBank) {
        throw new Error('Penyebab ini hanya berlaku untuk rekening kas.');
      }
    }

    // RC-S79 — penyebab TANPA jurnal tidak boleh membawa akun lawan.
    // Akun yang tertinggal dari pilihan sebelumnya adalah niat yang
    // sudah dibatalkan; menyimpannya diam-diam membuat baris SELESAI
    // tampak seperti penyesuaian yang tidak pernah dibukukan.
    if (PERLAKUAN_SAH[input.penyebab] === 'TIDAK_PERLU_JURNAL' && input.akunLawanId) {
      throw new Error('Penyebab ini tidak memerlukan akun pencatatan.');
    }

    // Catatan pemeriksaan / referensi bukti. Tanpa ini, baris SELESAI
    // tidak menjelaskan apa pun kepada pemeriksa berikutnya.
    if (PENYEBAB_WAJIB_CATATAN.includes(input.penyebab)) {
      const catatan = (input.catatan ?? detail.keterangan ?? '').trim();
      if (catatan === '') {
        throw new Error('Catatan pemeriksaan wajib diisi untuk penyebab ini.');
      }
    }

    let journalId: string | null = null;

    if (input.perlakuan === 'PERLU_JURNAL') {
      if (detail.selisih === 0) {
        throw new Error('Tidak ada selisih yang perlu dijurnal pada rekonsiliasi ini.');
      }
      if (!input.akunLawanId) {
        throw new Error('Akun lawan wajib dipilih untuk penyesuaian yang memerlukan jurnal.');
      }
      // RC-S79 — KATEGORI AKUN LAWAN harus sesuai arah selisih.
      // Selisih kurang menambah beban; selisih lebih menambah
      // pendapatan. Akun di luar itu (mis. aset atau ekuitas) akan
      // menghasilkan jurnal yang seimbang tetapi salah arti — dan
      // kesalahan seperti itu tidak terlihat dari neraca saldo.
      const akun = await db.getFirstAsync<{ kategori: string; is_active: number }>(
        `SELECT kategori, is_active FROM account WHERE id = ?`,
        input.akunLawanId
      );
      if (!akun) throw new Error('Akun pencatatan tidak ditemukan.');
      if (!akun.is_active) throw new Error('Akun pencatatan sudah tidak aktif.');
      const diharapkan = detail.selisih < 0 ? 'BEBAN' : 'PENDAPATAN';
      if (akun.kategori !== diharapkan) {
        throw new Error(
          diharapkan === 'BEBAN'
            ? 'Selisih kurang harus dicatat ke akun Beban.'
            : 'Selisih lebih harus dicatat ke akun Pendapatan.'
        );
      }
      const tahun = parseInt(detail.tanggal.slice(0, 4), 10);
      const nomor = await nextSequence(db, 'REK', tahun);
      const nominal = Math.abs(detail.selisih);
      const lines =
        detail.selisih > 0
          ? [
              { accountId: detail.accountId, debit: nominal, kredit: 0 },
              { accountId: input.akunLawanId, debit: 0, kredit: nominal },
            ]
          : [
              { accountId: input.akunLawanId, debit: nominal, kredit: 0 },
              { accountId: detail.accountId, debit: 0, kredit: nominal },
            ];

      const hasil = await createJournal(db, {
        tanggal: detail.tanggal,
        sumberTransaksi: 'REKONSILIASI_KAS_BANK',
        sumberId: detail.id,
        nomorReferensi: nomor,
        deskripsi: `Penyesuaian rekonsiliasi ${detail.namaRekening} (${input.penyebab}) - ${nomor}`,
        createdBy: input.createdBy,
        lines,
      });
      journalId = hasil.journalId;
    }

    await db.runAsync(
      `UPDATE rekonsiliasi_kas_bank
          SET status_penyelesaian = 'SELESAI', penyebab = ?, perlakuan = ?, journal_id = ?,
              diselesaikan_oleh = ?, diselesaikan_at = ?,
              keterangan = COALESCE(?, keterangan)
        WHERE id = ?`,
      input.penyebab,
      input.perlakuan,
      journalId,
      input.createdBy,
      new Date().toISOString(),
      input.catatan ?? null,
      detail.id
    );

    const segar = await db.getFirstAsync<Record<string, unknown>>(
      `SELECT * FROM rekonsiliasi_kas_bank WHERE id = ?`,
      detail.id
    );
    return petakanDetail(segar as Record<string, unknown>);
  }
}

export interface TindakLanjutSelisihInput {
  penyebab: PenyebabSelisih;
  perlakuan: PerlakuanSelisih;
  akunLawanId?: string;
  catatan?: string;
}

/**
 * RC-S67.9 — satu langkah untuk layar sederhana: catat pemeriksaan saldo
 * dan (bila ada selisih & tindak lanjut dipilih) selesaikan dalam SATU
 * transaksi database. Semantik pencatatan & penyelesaian TIDAK berubah —
 * fungsi ini hanya memanggil dua langkah existing secara atomik, sehingga
 * bila penyesuaian ditolak (mis. periode CLOSED) pemeriksaannya ikut
 * dibatalkan: tidak ada catatan setengah jadi.
 * Saldo COCOK tidak pernah diteruskan ke penyelesaian.
 */
/**
 * RC-S81 — simpan TEMUAN pada baris rekonsiliasi yang sudah ada,
 * TANPA menutupnya.
 *
 * Menjalankan validasi yang sama dengan penyelesaian (perlakuan sah,
 * larangan akun pada penyebab non-jurnal, catatan wajib), lalu menulis
 * penyebab + perlakuan sambil MEMPERTAHANKAN
 * `status_penyelesaian = 'DRAFT'` dan `journal_id = NULL`.
 *
 * `diselesaikan_oleh`/`diselesaikan_at` sengaja TIDAK diisi: belum ada
 * yang menyelesaikan apa pun, dan mengisinya akan membuat baris DRAFT
 * tampak seperti sudah ditangani.
 */
async function simpanTemuanDraft(
  db: SQLite.SQLiteDatabase,
  input: {
    rekonsiliasiId: string;
    penyebab: PenyebabSelisih;
    perlakuan: PerlakuanSelisih;
    akunLawanId?: string;
    catatan?: string;
  }
): Promise<RekonsiliasiDetailRow> {
  const row = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT * FROM rekonsiliasi_kas_bank WHERE id = ?`,
    input.rekonsiliasiId
  );
  if (!row) throw new Error('Data rekonsiliasi tidak ditemukan.');
  const detail = petakanDetail(row);
  if (detail.status !== 'SELISIH') {
    throw new Error('Hanya rekonsiliasi dengan selisih yang memerlukan tindak lanjut.');
  }
  if (detail.statusPenyelesaian === 'SELESAI') {
    throw new Error('Rekonsiliasi ini sudah diselesaikan.');
  }
  if (!PENYEBAB_SELISIH.includes(input.penyebab)) {
    throw new Error(`Penyebab selisih tidak dikenali: ${String(input.penyebab)}.`);
  }
  // Temuan selalu tanpa jurnal — kalau pemanggil meminta jurnal untuk
  // penyebab ini, itu kombinasi ilegal yang sama seperti di jalur
  // penyelesaian.
  if (input.perlakuan !== PERLAKUAN_SAH[input.penyebab]) {
    throw new Error(
      'Penyebab ini tidak diselesaikan dengan jurnal rekonsiliasi. Tindak lanjuti pada transaksi terkait atau pihak bank.'
    );
  }
  if (input.akunLawanId) {
    throw new Error('Penyebab ini tidak memerlukan akun pencatatan.');
  }
  const catatan = (input.catatan ?? detail.keterangan ?? '').trim();
  if (catatan === '') {
    throw new Error('Catatan pemeriksaan wajib diisi untuk penyebab ini.');
  }

  await db.runAsync(
    `UPDATE rekonsiliasi_kas_bank
        SET penyebab = ?, perlakuan = ?, keterangan = COALESCE(?, keterangan)
      WHERE id = ?`,
    input.penyebab,
    input.perlakuan,
    input.catatan ?? null,
    detail.id
  );

  const segar = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT * FROM rekonsiliasi_kas_bank WHERE id = ?`,
    detail.id
  );
  return petakanDetail(segar as Record<string, unknown>);
}

export async function catatRekonsiliasiDanTindakLanjut(
  input: CatatRekonsiliasiInput & { tindakLanjut?: TindakLanjutSelisihInput }
): Promise<RekonsiliasiDetailRow> {
  return withTransaction(async (db) => {
    if (!(await isAkunKasBank(db, input.accountId))) {
      throw new Error('Rekening yang dipilih bukan rekening Kas/Bank. Rekonsiliasi hanya untuk Kas/Bank.');
    }
    const hasil = await catatDalamTransaksi(db, input);
    if (hasil.status === 'SELISIH' && input.tindakLanjut) {
      // RC-S81 — TEMUAN disimpan sebagai DRAFT, bukan diselesaikan.
      // Sebelumnya setiap penyebab dilewatkan ke
      // `selesaikanDalamTransaksi()`, yang menulis
      // `status_penyelesaian = 'SELESAI'` — sehingga memilih "transaksi
      // belum tercatat" langsung menutup temuannya dan periode dapat
      // ditutup walau transaksinya belum pernah dicatat.
      if (penyebabTetapDraft(input.tindakLanjut.penyebab)) {
        return simpanTemuanDraft(db, {
          rekonsiliasiId: hasil.id,
          penyebab: input.tindakLanjut.penyebab,
          perlakuan: input.tindakLanjut.perlakuan,
          akunLawanId: input.tindakLanjut.akunLawanId,
          catatan: input.tindakLanjut.catatan,
        });
      }
      return selesaikanDalamTransaksi(db, {
        rekonsiliasiId: hasil.id,
        penyebab: input.tindakLanjut.penyebab,
        perlakuan: input.tindakLanjut.perlakuan,
        akunLawanId: input.tindakLanjut.akunLawanId,
        catatan: input.tindakLanjut.catatan,
        createdBy: input.createdBy,
      });
    }
    const r = await db.getFirstAsync<Record<string, unknown>>(`SELECT * FROM rekonsiliasi_kas_bank WHERE id = ?`, hasil.id);
    return petakanDetail(r as Record<string, unknown>);
  });
}

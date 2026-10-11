import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import { hitungPenyusutanBulanan } from '@/services/PenyusutanService';
import { nextSequence, newId } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { isValidPeriode, tanggalAkhirPeriode, toPeriode, selisihBulan } from '@/accounting/PeriodeUtil';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * PENYUSUTAN PROPERTI INVESTASI — RC-S53 corrective.
 *
 * POLICY 03 menetapkan MODEL BIAYA. Di bawah model biaya, nilai tercatat
 * properti investasi adalah:
 *
 *     biaya perolehan
 *   - akumulasi penyusutan      <- ini yang sebelumnya TIDAK ADA
 *   - akumulasi penurunan nilai
 *
 * Sampai v63, `PenyusutanService` hanya bekerja atas `aset_tetap`;
 * tidak ada satu pun code path yang menyusutkan akun investasi. Berkas
 * ini menutup celah itu — TANPA mesin penyusutan kedua: nominal tetap
 * dihitung `hitungPenyusutanBulanan()` yang sama, tanggal tetap akhir
 * periode, dan jurnal tetap lewat `AccountingEngine.createJournal()`.
 *
 * YANG SENGAJA TIDAK DILAKUKAN DI SINI:
 *
 *   - TIDAK ada masa manfaat, nilai residu, metode, atau tanggal mulai
 *     bawaan. Kelimanya fakta tentang properti koperasi; selama belum
 *     diisi, fungsi ini MENOLAK, bukan memakai angka cadangan.
 *   - TIDAK menyusutkan TANAH.
 *   - TIDAK menaksir porsi bangunan pada objek campuran. Bila nilai
 *     bangunan belum dinyatakan, yang dikembalikan adalah DATA GAP.
 *   - TIDAK ada catch-up diam-diam. Periode tertunggak hanya
 *     DILAPORKAN lewat `getPeriodePenyusutanPropertiTertunggak()`;
 *     penjurnalan selalu per periode dan selalu atas perintah eksplisit.
 */

export type JenisObjekProperti = 'TANAH' | 'BANGUNAN' | 'TANAH_DAN_BANGUNAN';

export interface KonfigurasiPenyusutanProperti {
  jenisObjek: JenisObjekProperti;
  /** Nilai bangunan yang dapat disusutkan — untuk objek campuran WAJIB dinyatakan sendiri. */
  nilaiDapatDisusutkan: Rupiah;
  nilaiResidu: Rupiah;
  masaManfaatBulan: number;
  tanggalMulaiPenyusutan: string;
}

export interface InvestasiPenyusutanRow {
  id: string;
  investasiId: string;
  namaTujuan: string;
  periode: string;
  tanggal: string;
  nilaiPenyusutan: Rupiah;
  journalId: string;
}

/** Alasan sebuah properti belum dapat disusutkan — dipakai layar & laporan DATA GAP. */
export class PenyusutanPropertiBelumSiapError extends Error {
  readonly kode:
    | 'BUKAN_PROPERTI_INVESTASI'
    | 'BELUM_DIKONFIGURASI'
    | 'TANAH_TIDAK_DISUSUTKAN'
    | 'DATA_GAP_KOMPONEN'
    | 'MODEL_NILAI_WAJAR';
  constructor(kode: PenyusutanPropertiBelumSiapError['kode'], pesan: string) {
    super(pesan);
    this.name = 'PenyusutanPropertiBelumSiapError';
    this.kode = kode;
  }
}

interface BarisInvestasi {
  id: string;
  nama_tujuan: string;
  jenis_investasi: string;
  status: string;
  jumlah: number;
  jenis_objek_properti: string | null;
  nilai_dapat_disusutkan: number | null;
  nilai_residu_properti: number | null;
  masa_manfaat_bulan_properti: number | null;
  tanggal_mulai_penyusutan: string | null;
}

/**
 * Baca konfigurasi penyusutan sebuah properti investasi, atau lempar
 * alasan spesifik kenapa ia belum dapat disusutkan. Satu tempat, supaya
 * layar, service, dan laporan DATA GAP tidak pernah memakai aturan yang
 * berbeda-beda.
 */
export function bacaKonfigurasiPenyusutan(inv: BarisInvestasi): KonfigurasiPenyusutanProperti {
  if (inv.jenis_investasi !== 'PROPERTI_INVESTASI') {
    throw new PenyusutanPropertiBelumSiapError(
      'BUKAN_PROPERTI_INVESTASI',
      `"${inv.nama_tujuan}" bukan properti investasi — penyusutan ini hanya untuk properti investasi.`
    );
  }
  if (!inv.jenis_objek_properti) {
    throw new PenyusutanPropertiBelumSiapError(
      'BELUM_DIKONFIGURASI',
      `Sifat objek "${inv.nama_tujuan}" belum ditetapkan (tanah, bangunan, atau keduanya) — penyusutan tidak dapat dihitung.`
    );
  }
  if (inv.jenis_objek_properti === 'TANAH') {
    throw new PenyusutanPropertiBelumSiapError(
      'TANAH_TIDAK_DISUSUTKAN',
      `"${inv.nama_tujuan}" berupa tanah — tanah tidak disusutkan.`
    );
  }
  if (inv.nilai_dapat_disusutkan === null || inv.nilai_dapat_disusutkan === undefined) {
    // Objek campuran tanpa nilai bangunan = DATA GAP. Menaksir porsinya
    // berarti menghasilkan penyusutan yang salah, jadi ditolak.
    throw new PenyusutanPropertiBelumSiapError(
      'DATA_GAP_KOMPONEN',
      `Nilai bangunan yang dapat disusutkan pada "${inv.nama_tujuan}" belum dinyatakan — ` +
        `tanpa itu porsi bangunan tidak dapat ditentukan dan penyusutan tidak dihitung.`
    );
  }
  if (inv.nilai_residu_properti === null || inv.nilai_residu_properti === undefined) {
    throw new PenyusutanPropertiBelumSiapError(
      'BELUM_DIKONFIGURASI',
      `Nilai residu "${inv.nama_tujuan}" belum diisi — nilai residu tidak diasumsikan nol.`
    );
  }
  if (!inv.masa_manfaat_bulan_properti || inv.masa_manfaat_bulan_properti <= 0) {
    throw new PenyusutanPropertiBelumSiapError(
      'BELUM_DIKONFIGURASI',
      `Masa manfaat "${inv.nama_tujuan}" belum diisi — tidak ada masa manfaat bawaan.`
    );
  }
  if (!inv.tanggal_mulai_penyusutan) {
    throw new PenyusutanPropertiBelumSiapError(
      'BELUM_DIKONFIGURASI',
      `Tanggal mulai penyusutan "${inv.nama_tujuan}" belum diisi.`
    );
  }
  if (inv.nilai_dapat_disusutkan > inv.jumlah) {
    throw new PenyusutanPropertiBelumSiapError(
      'DATA_GAP_KOMPONEN',
      `Nilai bangunan yang dapat disusutkan tidak boleh melebihi nilai perolehan properti.`
    );
  }
  return {
    jenisObjek: inv.jenis_objek_properti as JenisObjekProperti,
    nilaiDapatDisusutkan: inv.nilai_dapat_disusutkan,
    nilaiResidu: inv.nilai_residu_properti,
    masaManfaatBulan: inv.masa_manfaat_bulan_properti,
    tanggalMulaiPenyusutan: inv.tanggal_mulai_penyusutan,
  };
}

/**
 * RC-S88 — tanggal properti ini BERALIH ke MODEL NILAI WAJAR (SAK EP Bab
 * 16), yaitu tanggal penyesuaian nilai wajar PERTAMA yang diposting; null
 * bila masih model biaya. Di bawah model nilai wajar properti investasi
 * TIDAK disusutkan: nilai tercatatnya = nilai wajar terakhir.
 */
export async function getTanggalModelNilaiWajarPadaDb(
  db: SQLite.SQLiteDatabase,
  investasiId: string
): Promise<string | null> {
  try {
    const r = await db.getFirstAsync<{ tanggal: string | null }>(
      `SELECT MIN(tanggal) AS tanggal FROM penyesuaian_nilai_wajar
        WHERE objek = 'PROPERTI_INVESTASI' AND investasi_id = ? AND status = 'DIPOSTING'`,
      investasiId
    );
    return r?.tanggal ?? null;
  } catch (e) {
    if (/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
}

/** Total penyusutan yang PERNAH dijurnal untuk satu properti — dari register, bukan ledger agregat. */
export async function getTotalPenyusutanProperti(
  db: SQLite.SQLiteDatabase,
  investasiId: string,
  asOfDate?: string
): Promise<Rupiah> {
  const filter = asOfDate ? 'AND tanggal <= ?' : '';
  const params = asOfDate ? [investasiId, asOfDate] : [investasiId];
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(nilai_penyusutan), 0) AS total
       FROM investasi_penyusutan WHERE investasi_id = ? ${filter}`,
    ...params
  );
  return row?.total ?? 0;
}

/**
 * Simpan parameter penyusutan sebuah properti investasi. Tidak menjurnal
 * apa pun — ia hanya melengkapi data yang memang harus datang dari
 * pengurus.
 */
export async function simpanKonfigurasiPenyusutanProperti(input: {
  investasiId: string;
  jenisObjek: JenisObjekProperti;
  nilaiDapatDisusutkan?: Rupiah;
  nilaiResidu?: Rupiah;
  masaManfaatBulan?: number;
  tanggalMulaiPenyusutan?: string;
  createdBy: string;
}): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'edit');

    const inv = await db.getFirstAsync<{ id: string; jenis_investasi: string }>(
      `SELECT id, jenis_investasi FROM investasi WHERE id = ?`,
      input.investasiId
    );
    if (!inv) throw new Error('Investasi tidak ditemukan.');
    if (inv.jenis_investasi !== 'PROPERTI_INVESTASI') {
      throw new Error('Parameter penyusutan hanya berlaku untuk properti investasi.');
    }

    if (input.jenisObjek !== 'TANAH') {
      if (input.nilaiDapatDisusutkan === undefined || input.nilaiDapatDisusutkan <= 0) {
        throw new Error('Nilai bangunan yang dapat disusutkan wajib diisi, lebih dari 0.');
      }
      if (input.nilaiResidu === undefined || input.nilaiResidu < 0) {
        throw new Error('Nilai residu wajib diisi (boleh 0, tetapi harus dinyatakan).');
      }
      if (!input.masaManfaatBulan || input.masaManfaatBulan <= 0) {
        throw new Error('Masa manfaat (bulan) wajib diisi, lebih dari 0.');
      }
      if (!input.tanggalMulaiPenyusutan) {
        throw new Error('Tanggal mulai penyusutan wajib diisi.');
      }
    }

    await db.runAsync(
      `UPDATE investasi
          SET jenis_objek_properti = ?,
              nilai_dapat_disusutkan = ?,
              nilai_residu_properti = ?,
              masa_manfaat_bulan_properti = ?,
              tanggal_mulai_penyusutan = ?,
              updated_at = ?
        WHERE id = ?`,
      input.jenisObjek,
      input.jenisObjek === 'TANAH' ? null : input.nilaiDapatDisusutkan ?? null,
      input.jenisObjek === 'TANAH' ? null : input.nilaiResidu ?? null,
      input.jenisObjek === 'TANAH' ? null : input.masaManfaatBulan ?? null,
      input.jenisObjek === 'TANAH' ? null : input.tanggalMulaiPenyusutan ?? null,
      new Date().toISOString(),
      input.investasiId
    );
  });
}

/**
 * Jurnal penyusutan satu properti untuk SATU periode.
 *
 *     Dr 5-1300 Beban Penyusutan
 *     Cr 1-1670 Akumulasi Penyusutan Properti Investasi
 *
 * Anti-duplikasi dua lapis, persis pola `prosesPenyusutanAset`: cek
 * (investasi_id, periode) lebih dulu, dan UNIQUE di database sebagai
 * penjaga terakhir bila ada race — INSERT gagal, seluruh transaksi
 * termasuk jurnalnya rollback.
 */
export async function prosesPenyusutanPropertiInvestasi(params: {
  investasiId: string;
  periode: string;
  createdBy: string;
  /** Tanggal acuan "hari ini" — ada demi determinisme test, bukan untuk melewati guard. */
  tanggalLaporan?: string;
}): Promise<{ dibuat: boolean; row: InvestasiPenyusutanRow }> {
  if (!isValidPeriode(params.periode)) {
    throw new Error('Format periode tidak valid (harus YYYY-MM).');
  }
  const periodeSaatIni = toPeriode(params.tanggalLaporan ?? getTanggalLokalHariIni());
  if (params.periode > periodeSaatIni) {
    throw new Error(
      `Periode ${params.periode} belum berjalan (periode saat ini ${periodeSaatIni}) — ` +
        `penyusutan tidak boleh diposting ke periode masa depan.`
    );
  }

  return withTransaction(async (db) => {
    await requirePermission(db, params.createdBy, 'kas_bank', 'create');

    const existing = await db.getFirstAsync<{
      id: string;
      investasi_id: string;
      periode: string;
      tanggal: string;
      nilai_penyusutan: number;
      journal_id: string;
      nama_tujuan: string;
    }>(
      `SELECT ip.*, i.nama_tujuan
         FROM investasi_penyusutan ip
         JOIN investasi i ON i.id = ip.investasi_id
        WHERE ip.investasi_id = ? AND ip.periode = ?`,
      params.investasiId,
      params.periode
    );
    if (existing) {
      return {
        dibuat: false,
        row: {
          id: existing.id,
          investasiId: existing.investasi_id,
          namaTujuan: existing.nama_tujuan,
          periode: existing.periode,
          tanggal: existing.tanggal,
          nilaiPenyusutan: existing.nilai_penyusutan,
          journalId: existing.journal_id,
        },
      };
    }

    const inv = await db.getFirstAsync<BarisInvestasi>(
      `SELECT id, nama_tujuan, jenis_investasi, status, jumlah,
              jenis_objek_properti, nilai_dapat_disusutkan, nilai_residu_properti,
              masa_manfaat_bulan_properti, tanggal_mulai_penyusutan
         FROM investasi WHERE id = ?`,
      params.investasiId
    );
    if (!inv) throw new Error('Investasi tidak ditemukan.');
    if (inv.status !== 'AKTIF') {
      throw new Error(`"${inv.nama_tujuan}" sudah tidak aktif — tidak ada penyusutan baru.`);
    }

    const konf = bacaKonfigurasiPenyusutan(inv);

    // RC-S88 — model nilai wajar: tidak ada penyusutan untuk periode yang
    // berakhir setelah properti mulai diukur pada nilai wajar.
    const tanggalNw = await getTanggalModelNilaiWajarPadaDb(db, inv.id);
    if (tanggalNw && tanggalAkhirPeriode(params.periode) > tanggalNw) {
      throw new PenyusutanPropertiBelumSiapError(
        'MODEL_NILAI_WAJAR',
        `"${inv.nama_tujuan}" diukur dengan model nilai wajar sejak ${tanggalNw} — properti investasi pada nilai wajar tidak disusutkan.`
      );
    }

    const idx = selisihBulan(toPeriode(konf.tanggalMulaiPenyusutan), params.periode);
    if (idx < 0) {
      throw new Error(
        `Penyusutan "${inv.nama_tujuan}" baru dimulai ${konf.tanggalMulaiPenyusutan} — ` +
          `periode ${params.periode} sebelum tanggal mulai.`
      );
    }
    if (idx >= konf.masaManfaatBulan) {
      throw new Error(
        `"${inv.nama_tujuan}" sudah melewati masa manfaat (${konf.masaManfaatBulan} bulan) — ` +
          `tidak ada penyusutan untuk periode ${params.periode}.`
      );
    }

    const nilaiBulanan = hitungPenyusutanBulanan(
      konf.nilaiDapatDisusutkan,
      konf.nilaiResidu,
      konf.masaManfaatBulan
    );
    if (nilaiBulanan <= 0) {
      throw new Error(
        `"${inv.nama_tujuan}" tidak memiliki nilai penyusutan (nilai yang dapat disusutkan sudah sama atau lebih kecil dari residu).`
      );
    }

    // Akumulasi tidak boleh melampaui dasar penyusutan — nilai buku tidak
    // pernah turun di bawah residu meski ada pembulatan rupiah.
    const akumulasi = await getTotalPenyusutanProperti(db, params.investasiId);
    const sisaDasar = konf.nilaiDapatDisusutkan - konf.nilaiResidu - akumulasi;
    if (sisaDasar <= 0) {
      throw new Error(
        `"${inv.nama_tujuan}" sudah tersusut penuh — tidak ada penyusutan untuk periode ${params.periode}.`
      );
    }
    const nilaiPenyusutan = Math.min(nilaiBulanan, sisaDasar);

    const bebanAccountId = await resolveAccountId(db, 'PENYUSUTAN_PROPERTI_INVESTASI', 'DEBIT_BEBAN');
    const akumulasiAccountId = await resolveAccountId(db, 'PENYUSUTAN_PROPERTI_INVESTASI', 'KREDIT_AKUMULASI');

    const tanggal = tanggalAkhirPeriode(params.periode);
    const year = new Date(tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'PPI', year);

    const { journalId } = await createJournal(db, {
      tanggal,
      sumberTransaksi: 'PENYUSUTAN_PROPERTI_INVESTASI',
      sumberId: inv.id,
      nomorReferensi: nomorTransaksi,
      deskripsi: `Penyusutan properti investasi ${inv.nama_tujuan} periode ${params.periode} - ${nomorTransaksi}`,
      createdBy: params.createdBy,
      lines: [
        { accountId: bebanAccountId, debit: nilaiPenyusutan, kredit: 0 },
        { accountId: akumulasiAccountId, debit: 0, kredit: nilaiPenyusutan },
      ],
    });

    const id = newId();
    await db.runAsync(
      `INSERT INTO investasi_penyusutan
        (id, investasi_id, periode, tanggal, nilai_penyusutan, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      id,
      params.investasiId,
      params.periode,
      tanggal,
      nilaiPenyusutan,
      journalId,
      params.createdBy,
      new Date().toISOString()
    );

    return {
      dibuat: true,
      row: {
        id,
        investasiId: params.investasiId,
        namaTujuan: inv.nama_tujuan,
        periode: params.periode,
        tanggal,
        nilaiPenyusutan,
        journalId,
      },
    };
  });
}

/**
 * Periode yang SEHARUSNYA sudah disusutkan tetapi belum pernah
 * dijurnal — DILAPORKAN saja, tidak pernah diproses otomatis.
 *
 * Inilah pemisah antara penyusutan periode berjalan dan penyusutan
 * historis yang belum tercatat: keduanya muncul di daftar ini, dan
 * keduanya hanya dijurnal lewat perintah eksplisit per periode. Tidak
 * ada catch-up diam-diam.
 */
export async function getPeriodePenyusutanPropertiTertunggak(
  investasiId: string,
  tanggalLaporan?: string
): Promise<string[]> {
  const db = await getDb();
  const inv = await db.getFirstAsync<BarisInvestasi>(
    `SELECT id, nama_tujuan, jenis_investasi, status, jumlah,
            jenis_objek_properti, nilai_dapat_disusutkan, nilai_residu_properti,
            masa_manfaat_bulan_properti, tanggal_mulai_penyusutan
       FROM investasi WHERE id = ?`,
    investasiId
  );
  if (!inv) throw new Error('Investasi tidak ditemukan.');
  const konf = bacaKonfigurasiPenyusutan(inv);
  const tanggalNw = await getTanggalModelNilaiWajarPadaDb(db, investasiId);

  const periodeSaatIni = toPeriode(tanggalLaporan ?? getTanggalLokalHariIni());
  const sudah = new Set(
    (
      await db.getAllAsync<{ periode: string }>(
        `SELECT periode FROM investasi_penyusutan WHERE investasi_id = ?`,
        investasiId
      )
    ).map((r) => r.periode)
  );

  const hasil: string[] = [];
  const mulai = toPeriode(konf.tanggalMulaiPenyusutan);
  for (let i = 0; i < konf.masaManfaatBulan; i += 1) {
    const [th, bl] = mulai.split('-').map(Number);
    const d = new Date(Date.UTC(th, bl - 1 + i, 1));
    const periode = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (periode > periodeSaatIni) break;
    // RC-S88 — sejak model nilai wajar, tidak ada lagi periode penyusutan.
    if (tanggalNw && tanggalAkhirPeriode(periode) > tanggalNw) break;
    if (!sudah.has(periode)) hasil.push(periode);
  }
  return hasil;
}

/** Riwayat penyusutan properti investasi — untuk layar, subledger, dan CALK. */
export async function listPenyusutanPropertiInvestasi(
  opts: { investasiId?: string } = {}
): Promise<InvestasiPenyusutanRow[]> {
  const db = await getDb();
  return listPenyusutanPropertiDenganDb(db, opts);
}

/** Varian yang menerima koneksi — dipakai di dalam transaksi & test. */
export async function listPenyusutanPropertiDenganDb(
  db: SQLite.SQLiteDatabase,
  opts: { investasiId?: string } = {}
): Promise<InvestasiPenyusutanRow[]> {
  const where = opts.investasiId ? 'WHERE ip.investasi_id = ?' : '';
  const params = opts.investasiId ? [opts.investasiId] : [];
  const rows = await db.getAllAsync<Record<string, string | number>>(
    `SELECT ip.*, i.nama_tujuan
       FROM investasi_penyusutan ip
       JOIN investasi i ON i.id = ip.investasi_id
       ${where}
      ORDER BY ip.periode DESC`,
    ...params
  );
  return rows.map((r) => ({
    id: r.id as string,
    investasiId: r.investasi_id as string,
    namaTujuan: r.nama_tujuan as string,
    periode: r.periode as string,
    tanggal: r.tanggal as string,
    nilaiPenyusutan: r.nilai_penyusutan as number,
    journalId: r.journal_id as string,
  }));
}

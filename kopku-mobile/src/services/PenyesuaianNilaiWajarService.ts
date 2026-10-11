import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, assertAccountingPeriodOpen } from '@/accounting/AccountingEngine';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { tanggalAkhirPeriode, toPeriode, selisihBulan } from '@/accounting/PeriodeUtil';
import { requirePermission } from '@/services/PermissionService';
import { getNilaiTercatatInvestasi as getNilaiTercatatResmi } from '@/services/InvestasiImpairmentService';
import { getDasarPenyusutanAsetPadaDb, getSelisihRevaluasiAsetPadaDb } from '@/services/PenyusutanService';
import { bacaKonfigurasiPenyusutan, getTanggalModelNilaiWajarPadaDb } from '@/services/PenyusutanPropertiInvestasiService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';

/**
 * ============================================================
 * PENYESUAIAN NILAI WAJAR & REVALUASI — SESUAI SAK EP (RC-S88)
 * ============================================================
 *
 * Menggantikan workflow "draft saja" (Fase 9 · RC-S54 #10, POLICY 03 =
 * model biaya, posting dinonaktifkan). Keputusan pengguna RC-S88:
 * terapkan rekomendasi pengukuran SAK EP (efektif 1 Januari 2025):
 *
 *  1. PROPERTI INVESTASI — MODEL NILAI WAJAR MELALUI LABA RUGI (Bab 16).
 *     Selisih nilai wajar vs nilai tercatat diakui di LABA RUGI:
 *        naik : Dr 1-1665 Penyesuaian Nilai Wajar PI / Cr 4-2100 Keuntungan
 *        turun: Dr 5-5000 Kerugian Nilai Wajar PI     / Cr 1-1665
 *     Tampil di LHU pada "Pendapatan dan Beban Lain". Sejak penilaian
 *     pertama diposting, properti TIDAK LAGI DISUSUTKAN (nilai tercatat =
 *     nilai wajar terakhir) — dijaga PenyusutanPropertiInvestasiService.
 *
 *  2. ASET TETAP — MODEL REVALUASI (Bab 17). Kenaikan diakui di
 *     PENGHASILAN KOMPREHENSIF LAIN (surplus revaluasi, ekuitas 3-6000),
 *     kecuali sebesar pemulihan penurunan yang dulu dibebankan ke laba
 *     rugi (4-2200). Penurunan dibebankan ke surplus revaluasi ASET YANG
 *     SAMA lebih dahulu (OCI negatif), sisanya ke laba rugi (5-5100):
 *        naik : Dr 1-1520 / Cr 4-2200 (pemulihan) + Cr 3-6000 (OCI)
 *        turun: Dr 3-6000 (s.d. surplus) + Dr 5-5100 / Cr 1-1520
 *     Penyusutan berikutnya dihitung prospektif dari nilai revaluasi atas
 *     sisa masa manfaat (PenyusutanService.getDasarPenyusutanAsetPadaDb).
 *
 * Akun penyesuai (1-1665, 1-1520) memisahkan penyesuaian dari biaya
 * perolehan, sehingga register perolehan tetap cocok dengan buku besar.
 *
 * SIKLUS: DRAFT → DIPOSTING (jurnal terbentuk, final) atau DRAFT →
 * DIBATALKAN. Penilaian yang sudah diposting tidak diedit/dibatalkan —
 * koreksinya adalah penilaian BARU pada tanggal sesudahnya.
 *
 * SATU PENYUSUN. Pratinjau di layar dan eksekusi posting memakai
 * `susunRencanaPosting()` yang sama, sehingga baris jurnal yang
 * ditampilkan identik dengan yang diposting.
 *
 * GERBANG POSTING (semua dicek ulang di dalam transaksi posting):
 *  - bukti wajib (dasar penilaian & referensi bukti);
 *  - objek masih aktif & eligible;
 *  - urutan kronologis: tidak ada penilaian DIPOSTING pada/sesudah tanggal ini;
 *  - tidak ada penyusutan/penurunan nilai/penarikan bertanggal sesudahnya;
 *  - penyusutan s.d. tanggal penilaian sudah lengkap (nilai tercatat benar);
 *  - periode akuntansi terbuka; izin `kas_bank:approve`.
 */

export type ObjekNilaiWajar = 'PROPERTI_INVESTASI' | 'ASET_TETAP';
export type ArahPerubahanNilai = 'KENAIKAN' | 'PENURUNAN' | 'TIDAK_BERUBAH';
export type StatusPenilaianNilaiWajar = 'DRAFT' | 'DIPOSTING' | 'DIBATALKAN';
export type StatusPostingNilaiWajar = 'BELUM_DIPOSTING' | 'DIPOSTING';

export type ModelPengukuranPropertiInvestasi = 'MODEL_BIAYA' | 'MODEL_NILAI_WAJAR';
export type ModelPengukuranAsetTetap = 'MODEL_BIAYA' | 'MODEL_REVALUASI';

/** Kebijakan pengukuran yang berlaku (RC-S88, rekomendasi SAK EP). */
export const KEBIJAKAN_PENGUKURAN_PROPERTI_INVESTASI: ModelPengukuranPropertiInvestasi = 'MODEL_NILAI_WAJAR';
export const KEBIJAKAN_PENGUKURAN_ASET_TETAP: ModelPengukuranAsetTetap = 'MODEL_REVALUASI';

/** Mapping akun nilai wajar/revaluasi AKTIF (lihat DEFAULT_ACCOUNT_MAPPING). */
export const MAPPING_NILAI_WAJAR_AKTIF = true;

/** Sumber jurnal penyesuaian nilai wajar properti investasi (laba rugi). */
export const SUMBER_TRANSAKSI_NILAI_WAJAR = 'PENYESUAIAN_NILAI_WAJAR';
/**
 * Sumber jurnal revaluasi aset tetap (OCI). Literal (bukan alias) supaya
 * pemindai klasifikasi arus kas dapat menyelesaikannya; kesamaannya dengan
 * `ociPolicy.SUMBER_JURNAL_REVALUASI_ASET_TETAP` dijaga test RC-S88.
 */
export const SUMBER_TRANSAKSI_REVALUASI_ASET_TETAP = 'REVALUASI_ASET_TETAP';

const MAPPING_PI = 'NILAI_WAJAR_PROPERTI_INVESTASI';
const MAPPING_AT = 'REVALUASI_ASET_TETAP';

export const JENIS_INVESTASI_ELIGIBLE_NILAI_WAJAR = 'PROPERTI_INVESTASI';

export const LABEL_OBJEK_NILAI_WAJAR: Record<ObjekNilaiWajar, string> = {
  PROPERTI_INVESTASI: 'Properti Investasi',
  ASET_TETAP: 'Aset Tetap',
};

/** Ringkasan perlakuan akuntansi per objek — dipakai layar & CALK. */
export const PERLAKUAN_NILAI_WAJAR: Record<ObjekNilaiWajar, { model: string; ringkas: string; dasar: string }> = {
  PROPERTI_INVESTASI: {
    model: 'Model nilai wajar',
    ringkas:
      'Selisih nilai wajar diakui di laba rugi (Pendapatan dan Beban Lain). Setelah penilaian pertama diposting, properti tidak lagi disusutkan.',
    dasar: 'SAK EP Bab 16 — Properti Investasi',
  },
  ASET_TETAP: {
    model: 'Model revaluasi',
    ringkas:
      'Kenaikan diakui di penghasilan komprehensif lain (surplus revaluasi); penurunan mengurangi surplus aset yang sama lebih dahulu, sisanya ke laba rugi. Penyusutan berikutnya dari nilai revaluasi atas sisa masa manfaat.',
    dasar: 'SAK EP Bab 17 — Aset Tetap',
  },
};

/** Kode penolakan domain — dipakai gerbang posting, layar & test. */
export const KODE_NILAI_WAJAR = {
  POLICY_DISABLED: 'FAIR_VALUE_POSTING_POLICY_DISABLED',
  MAPPING_NOT_ACTIVE: 'FAIR_VALUE_MAPPING_NOT_ACTIVE',
  NOT_FOUND: 'FAIR_VALUE_ASSESSMENT_NOT_FOUND',
  NOT_DRAFT: 'FAIR_VALUE_ASSESSMENT_NOT_DRAFT',
  EVIDENCE_REQUIRED: 'FAIR_VALUE_EVIDENCE_REQUIRED',
  ALREADY_POSTED: 'FAIR_VALUE_ASSESSMENT_ALREADY_POSTED',
  DUPLICATE_ASSESSMENT: 'FAIR_VALUE_ASSESSMENT_DUPLICATE',
  PROPERTY_NOT_ELIGIBLE: 'FAIR_VALUE_PROPERTY_NOT_ELIGIBLE',
  ASSET_NOT_ELIGIBLE: 'FAIR_VALUE_ASSET_NOT_ELIGIBLE',
  OUT_OF_ORDER: 'FAIR_VALUE_ASSESSMENT_OUT_OF_ORDER',
  LATER_TRANSACTIONS: 'FAIR_VALUE_LATER_TRANSACTIONS_EXIST',
  DEPRECIATION_INCOMPLETE: 'FAIR_VALUE_DEPRECIATION_INCOMPLETE',
  FUTURE_DATE: 'FAIR_VALUE_FUTURE_DATE',
} as const;
export type KodeNilaiWajar = (typeof KODE_NILAI_WAJAR)[keyof typeof KODE_NILAI_WAJAR];

export interface HambatanPosting {
  readonly kode: KodeNilaiWajar;
  readonly pesan: string;
}

export interface BarisJurnalNilaiWajar {
  readonly accountId: string;
  readonly kode: string;
  readonly nama: string;
  readonly debit: Rupiah;
  readonly kredit: Rupiah;
  readonly keterangan: string;
}

/** Rencana posting — satu sumber untuk pratinjau layar & eksekusi. */
export interface RencanaPostingNilaiWajar {
  readonly objek: ObjekNilaiWajar;
  readonly objekId: string;
  readonly namaObjek: string;
  readonly tanggal: string;
  readonly nilaiTercatatSebelum: Rupiah;
  readonly nilaiWajar: Rupiah;
  readonly selisih: Rupiah;
  readonly arahPerubahan: ArahPerubahanNilai;
  /** Bagian selisih yang masuk laba rugi (bertanda). */
  readonly jumlahLabaRugi: Rupiah;
  /** Bagian selisih yang masuk OCI / surplus revaluasi (bertanda). */
  readonly jumlahOci: Rupiah;
  readonly baris: readonly BarisJurnalNilaiWajar[];
  /** Kondisi yang membuat penilaian ini BELUM dapat diposting (kosong = siap). */
  readonly hambatan: readonly HambatanPosting[];
}

/** Bentuk lama (khusus properti investasi) — dipertahankan untuk kompatibilitas. */
export interface PreviewNilaiWajar {
  readonly investasiId: string;
  readonly namaInvestasi: string;
  readonly nilaiTercatatSebelum: Rupiah;
  readonly nilaiWajar: Rupiah;
  readonly selisih: Rupiah;
  readonly arahPerubahan: ArahPerubahanNilai;
  readonly dapatDiposting: boolean;
  readonly alasanTidakDapatDiposting: string | null;
}

export interface NilaiWajarRow {
  /** ID Transaksi. */
  readonly id: string;
  readonly objek: ObjekNilaiWajar;
  /** investasi_id (PROPERTI_INVESTASI) atau aset_tetap_id (ASET_TETAP). */
  readonly objekId: string;
  readonly investasiId: string | null;
  readonly asetTetapId: string | null;
  readonly namaObjek: string;
  readonly nomorObjek: string;
  /** Alias `namaObjek` — kompatibilitas pemanggil lama. */
  readonly namaInvestasi: string;
  /** Tanggal penilaian. */
  readonly tanggal: string;
  readonly nilaiTercatatSebelum: Rupiah;
  readonly nilaiWajar: Rupiah;
  readonly selisih: Rupiah;
  readonly arahPerubahan: ArahPerubahanNilai;
  readonly dasarPenilaian: string | null;
  readonly referensiBukti: string | null;
  readonly penilai: string | null;
  readonly catatan: string | null;
  readonly status: StatusPenilaianNilaiWajar;
  readonly jumlahLabaRugi: Rupiah;
  readonly jumlahOci: Rupiah;
  /** User Pembuat (id) & nama tampilannya. */
  readonly createdBy: string;
  readonly namaPembuat: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly jurnalId: string | null;
  readonly nomorJurnal: string | null;
  /** Waktu posting (ISO) — null selama belum diposting. */
  readonly tanggalPosting: string | null;
  /** Nama/ID user yang memposting — null selama belum diposting. */
  readonly userPosting: string | null;
  readonly statusPosting: StatusPostingNilaiWajar;
}

export interface PropertiInvestasiEligible {
  readonly id: string;
  readonly nomorInvestasi: string;
  readonly namaTujuan: string;
  readonly lokasiProperti: string | null;
}

export interface ObjekNilaiWajarEligible {
  readonly objek: ObjekNilaiWajar;
  readonly id: string;
  readonly nomor: string;
  readonly nama: string;
  /** Keterangan singkat (lokasi properti / kelompok aset). */
  readonly keterangan: string | null;
}

export interface AuditNilaiWajarEntry {
  readonly id: string;
  readonly userId: string;
  readonly action: string;
  readonly waktu: string;
  readonly dataSebelum: Record<string, unknown> | null;
  readonly dataSesudah: Record<string, unknown> | null;
}

// ------------------------------------------------------------------
// SATU SUMBER KEBENARAN PERHITUNGAN
// ------------------------------------------------------------------

/** Selisih = nilai wajar − nilai tercatat sebelum. Satu-satunya rumus. */
export function hitungSelisihNilaiWajar(nilaiWajar: Rupiah, nilaiTercatatSebelum: Rupiah): Rupiah {
  return nilaiWajar - nilaiTercatatSebelum;
}

/** Arah DITURUNKAN dari selisih — tidak pernah diketik pengguna. */
export function arahDariSelisih(selisih: Rupiah): ArahPerubahanNilai {
  if (selisih > 0) return 'KENAIKAN';
  if (selisih < 0) return 'PENURUNAN';
  return 'TIDAK_BERUBAH';
}

/**
 * Pembagian selisih revaluasi ASET TETAP antara laba rugi dan OCI
 * (SAK EP Bab 17), per aset:
 *  - kenaikan: memulihkan dulu kerugian revaluasi yang dahulu dibebankan
 *    ke laba rugi (netto, `kerugianLabaRugiTerdahulu`), sisanya ke OCI;
 *  - penurunan: mengurangi dulu surplus revaluasi aset tsb
 *    (`surplusTersedia`), sisanya ke laba rugi.
 * Fungsi murni — dipakai pratinjau, posting, dan test.
 */
export function bagiSelisihRevaluasi(
  selisih: Rupiah,
  surplusTersedia: Rupiah,
  kerugianLabaRugiTerdahulu: Rupiah
): { labaRugi: Rupiah; oci: Rupiah } {
  if (selisih > 0) {
    const pemulihan = Math.min(selisih, Math.max(kerugianLabaRugiTerdahulu, 0));
    return { labaRugi: pemulihan, oci: selisih - pemulihan };
  }
  if (selisih < 0) {
    const turun = -selisih;
    const dariSurplus = Math.min(turun, Math.max(surplusTersedia, 0));
    // `|| 0` menormalkan -0 (penurunan yang seluruhnya tertutup surplus).
    return { labaRugi: -(turun - dariSurplus) || 0, oci: -dariSurplus || 0 };
  }
  return { labaRugi: 0, oci: 0 };
}

// ------------------------------------------------------------------
// VALIDASI
// ------------------------------------------------------------------

function validasiNilaiWajar(nilai: unknown): asserts nilai is Rupiah {
  if (typeof nilai !== 'number' || !Number.isFinite(nilai) || nilai < 0) {
    throw new Error('Nilai wajar harus berupa angka dan tidak boleh negatif.');
  }
  if (!Number.isInteger(nilai)) {
    throw new Error('Nilai wajar harus berupa Rupiah bulat.');
  }
}

function validasiTanggal(tanggal: unknown): asserts tanggal is string {
  if (typeof tanggal !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) {
    throw new Error('Tanggal penilaian wajib diisi dengan format YYYY-MM-DD.');
  }
  const d = new Date(`${tanggal}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== tanggal) {
    throw new Error('Tanggal penilaian tidak valid.');
  }
}

function teksWajib(nilai: unknown): string | null {
  if (typeof nilai !== 'string') return null;
  const t = nilai.trim();
  return t === '' ? null : t;
}

function validasiBukti(input: { dasarPenilaian?: string; referensiBukti?: string }): {
  dasarPenilaian: string;
  referensiBukti: string;
} {
  const dasar = teksWajib(input.dasarPenilaian);
  const referensi = teksWajib(input.referensiBukti);
  if (dasar === null) {
    throw new Error(
      `${KODE_NILAI_WAJAR.EVIDENCE_REQUIRED}: Dasar penilaian wajib diisi (mis. laporan penilai, referensi pasar, dokumen transaksi).`
    );
  }
  if (referensi === null) {
    throw new Error(
      `${KODE_NILAI_WAJAR.EVIDENCE_REQUIRED}: Referensi bukti wajib diisi (nomor/referensi dokumen penilaian) agar dapat ditelusuri.`
    );
  }
  return { dasarPenilaian: dasar, referensiBukti: referensi };
}

// ------------------------------------------------------------------
// OBJEK ELIGIBLE & NILAI TERCATAT
// ------------------------------------------------------------------

const SQL_PROPERTI_ELIGIBLE = `SELECT id, nomor_investasi, nama_tujuan, lokasi_properti, tanggal
     FROM investasi
    WHERE jenis_investasi = '${JENIS_INVESTASI_ELIGIBLE_NILAI_WAJAR}' AND status = 'AKTIF'`;

const SQL_ASET_ELIGIBLE = `SELECT id, nomor_aset, nama_aset, kelompok_aset, sub_kelompok_aset, tanggal_perolehan,
          nilai_perolehan, nilai_residu, masa_manfaat_bulan
     FROM aset_tetap
    WHERE COALESCE(status, 'AKTIF') = 'AKTIF' AND COALESCE(jenis_aset, 'TETAP') = 'TETAP'`;

/** Picker Properti — HANYA properti investasi aktif. */
export async function listPropertiInvestasiEligible(): Promise<PropertiInvestasiEligible[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(`${SQL_PROPERTI_ELIGIBLE} ORDER BY nama_tujuan ASC`);
  return rows.map((r) => ({
    id: r.id as string,
    nomorInvestasi: r.nomor_investasi as string,
    namaTujuan: r.nama_tujuan as string,
    lokasiProperti: (r.lokasi_properti as string | null) ?? null,
  }));
}

/** Picker objek per jenis: properti investasi aktif, atau aset tetap (berwujud) aktif. */
export async function listObjekNilaiWajarEligible(objek: ObjekNilaiWajar): Promise<ObjekNilaiWajarEligible[]> {
  const db = await getDb();
  if (objek === 'PROPERTI_INVESTASI') {
    const rows = await db.getAllAsync<Record<string, unknown>>(`${SQL_PROPERTI_ELIGIBLE} ORDER BY nama_tujuan ASC`);
    return rows.map((r) => ({
      objek,
      id: r.id as string,
      nomor: r.nomor_investasi as string,
      nama: r.nama_tujuan as string,
      keterangan: (r.lokasi_properti as string | null) ?? null,
    }));
  }
  const rows = await db.getAllAsync<Record<string, unknown>>(`${SQL_ASET_ELIGIBLE} ORDER BY nama_aset ASC`);
  return rows.map((r) => ({
    objek,
    id: r.id as string,
    nomor: r.nomor_aset as string,
    nama: r.nama_aset as string,
    keterangan: [r.kelompok_aset, r.sub_kelompok_aset].filter(Boolean).join(' · ') || null,
  }));
}

interface ObjekTerbaca {
  objek: ObjekNilaiWajar;
  id: string;
  nama: string;
  nomor: string;
  tanggalPerolehan: string;
}

async function pastikanObjekEligible(
  db: SQLite.SQLiteDatabase,
  objek: ObjekNilaiWajar,
  objekId: string
): Promise<ObjekTerbaca> {
  if (objek === 'PROPERTI_INVESTASI') {
    const ada = await db.getFirstAsync<{ id: string }>(`SELECT id FROM investasi WHERE id = ?`, objekId);
    if (!ada) throw new Error('Data investasi tidak ditemukan.');
    const r = await db.getFirstAsync<{ id: string; nama_tujuan: string; nomor_investasi: string; tanggal: string }>(
      `${SQL_PROPERTI_ELIGIBLE} AND id = ?`,
      objekId
    );
    if (!r) {
      throw new Error(
        `${KODE_NILAI_WAJAR.PROPERTY_NOT_ELIGIBLE}: Penyesuaian nilai wajar hanya untuk properti investasi yang masih aktif.`
      );
    }
    return { objek, id: r.id, nama: r.nama_tujuan, nomor: r.nomor_investasi, tanggalPerolehan: r.tanggal.slice(0, 10) };
  }
  const ada = await db.getFirstAsync<{ id: string }>(`SELECT id FROM aset_tetap WHERE id = ?`, objekId);
  if (!ada) throw new Error('Data aset tetap tidak ditemukan.');
  const r = await db.getFirstAsync<{ id: string; nama_aset: string; nomor_aset: string; tanggal_perolehan: string }>(
    `${SQL_ASET_ELIGIBLE} AND id = ?`,
    objekId
  );
  if (!r) {
    throw new Error(
      `${KODE_NILAI_WAJAR.ASSET_NOT_ELIGIBLE}: Revaluasi hanya untuk aset tetap berwujud yang masih aktif (aset tak berwujud memakai model biaya).`
    );
  }
  return { objek, id: r.id, nama: r.nama_aset, nomor: r.nomor_aset, tanggalPerolehan: r.tanggal_perolehan.slice(0, 10) };
}

/** Nilai tercatat aset tetap per tanggal = perolehan + selisih revaluasi − akumulasi penyusutan. */
async function nilaiTercatatAsetPadaDb(db: SQLite.SQLiteDatabase, asetId: string, asOfDate?: string): Promise<Rupiah> {
  const aset = await db.getFirstAsync<{ nilai_perolehan: number }>(`SELECT nilai_perolehan FROM aset_tetap WHERE id = ?`, asetId);
  if (!aset) throw new Error('Data aset tetap tidak ditemukan.');
  const akum = await db.getFirstAsync<{ t: number }>(
    `SELECT COALESCE(SUM(nilai_penyusutan), 0) AS t FROM aset_penyusutan WHERE aset_id = ? ${asOfDate ? 'AND tanggal <= ?' : ''}`,
    ...(asOfDate ? [asetId, asOfDate] : [asetId])
  );
  const r = await getSelisihRevaluasiAsetPadaDb(db, asetId, asOfDate);
  return aset.nilai_perolehan + r - (akum?.t ?? 0);
}

async function nilaiTercatatPada(
  db: SQLite.SQLiteDatabase,
  objek: ObjekNilaiWajar,
  objekId: string,
  asOfDate?: string
): Promise<Rupiah> {
  if (objek === 'ASET_TETAP') return nilaiTercatatAsetPadaDb(db, objekId, asOfDate);
  // Rumus resmi repository — tidak ada engine perhitungan kedua.
  const { nilaiTercatat } = await getNilaiTercatatResmi(db, objekId, asOfDate);
  return nilaiTercatat;
}

/**
 * Nilai tercatat properti investasi DIBACA dari rumus resmi (perolehan −
 * akumulasi penyusutan − akumulasi penurunan nilai + penyesuaian nilai
 * wajar) — bukan diketik pengguna. `asOfDate` = tanggal penilaian.
 */
export async function getNilaiTercatatInvestasi(investasiId: string, asOfDate?: string): Promise<Rupiah> {
  const db = await getDb();
  const ada = await db.getFirstAsync<{ id: string }>(`SELECT id FROM investasi WHERE id = ?`, investasiId);
  if (!ada) throw new Error('Data investasi tidak ditemukan.');
  return nilaiTercatatPada(db, 'PROPERTI_INVESTASI', investasiId, asOfDate);
}

/** Nilai tercatat objek apa pun per tanggal (untuk layar). */
export async function getNilaiTercatatObjek(objek: ObjekNilaiWajar, objekId: string, asOfDate?: string): Promise<Rupiah> {
  const db = await getDb();
  return nilaiTercatatPada(db, objek, objekId, asOfDate);
}

// ------------------------------------------------------------------
// GERBANG POSTING — hambatan yang bergantung pada data
// ------------------------------------------------------------------

function tambahBulanPeriode(periode: string, n: number): string {
  const [th, bl] = periode.split('-').map(Number);
  const d = new Date(Date.UTC(th, bl - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Periode penyusutan yang SEHARUSNYA sudah dijurnal s.d. tanggal `D` tetapi belum. */
async function periodePenyusutanBelumLengkap(
  db: SQLite.SQLiteDatabase,
  objek: ObjekNilaiWajar,
  objekId: string,
  tanggal: string
): Promise<string[]> {
  if (objek === 'ASET_TETAP') {
    const aset = await db.getFirstAsync<{
      id: string;
      nilai_perolehan: number;
      nilai_residu: number | null;
      masa_manfaat_bulan: number;
      tanggal_perolehan: string;
    }>(`SELECT id, nilai_perolehan, nilai_residu, masa_manfaat_bulan, tanggal_perolehan FROM aset_tetap WHERE id = ?`, objekId);
    if (!aset) return [];
    const dasar = await getDasarPenyusutanAsetPadaDb(db, aset);
    if (dasar.nilaiBulanan <= 0) return []; // tidak ada lagi yang dapat disusutkan
    const sudah = new Set(
      (await db.getAllAsync<{ periode: string }>(`SELECT periode FROM aset_penyusutan WHERE aset_id = ?`, objekId)).map(
        (r) => r.periode
      )
    );
    const mulai = toPeriode(aset.tanggal_perolehan);
    const hasil: string[] = [];
    for (let i = 0; i < aset.masa_manfaat_bulan; i += 1) {
      const p = tambahBulanPeriode(mulai, i);
      if (tanggalAkhirPeriode(p) > tanggal) break;
      if (!sudah.has(p)) hasil.push(p);
    }
    return hasil;
  }
  // Properti investasi: hanya selama masih model biaya & terkonfigurasi.
  if (await getTanggalModelNilaiWajarPadaDb(db, objekId)) return [];
  const inv = await db.getFirstAsync<Parameters<typeof bacaKonfigurasiPenyusutan>[0]>(
    `SELECT id, nama_tujuan, jenis_investasi, status, jumlah,
            jenis_objek_properti, nilai_dapat_disusutkan, nilai_residu_properti,
            masa_manfaat_bulan_properti, tanggal_mulai_penyusutan
       FROM investasi WHERE id = ?`,
    objekId
  );
  if (!inv) return [];
  let konf: ReturnType<typeof bacaKonfigurasiPenyusutan>;
  try {
    konf = bacaKonfigurasiPenyusutan(inv);
  } catch {
    return []; // tanah / belum dikonfigurasi — tidak ada penyusutan yang ditunggu
  }
  const sudah = new Set(
    (await db.getAllAsync<{ periode: string }>(`SELECT periode FROM investasi_penyusutan WHERE investasi_id = ?`, objekId)).map(
      (r) => r.periode
    )
  );
  const mulai = toPeriode(konf.tanggalMulaiPenyusutan);
  const hasil: string[] = [];
  for (let i = 0; i < konf.masaManfaatBulan; i += 1) {
    const p = tambahBulanPeriode(mulai, i);
    if (selisihBulan(mulai, p) < 0) continue;
    if (tanggalAkhirPeriode(p) > tanggal) break;
    if (!sudah.has(p)) hasil.push(p);
  }
  return hasil;
}

async function hitungSesudah(db: SQLite.SQLiteDatabase, sql: string, ...params: unknown[]): Promise<number> {
  try {
    return (await db.getFirstAsync<{ n: number }>(sql, ...(params as string[])))?.n ?? 0;
  } catch (e) {
    if (/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) return 0;
    throw e;
  }
}

/** Seluruh hambatan posting yang bergantung pada data (bukan status baris). */
async function kumpulkanHambatanData(
  db: SQLite.SQLiteDatabase,
  objek: ObjekTerbaca,
  tanggal: string,
  kecualiId: string | null
): Promise<HambatanPosting[]> {
  const hambatan: HambatanPosting[] = [];
  const hariIni = getTanggalLokalHariIni();
  if (tanggal > hariIni) {
    hambatan.push({ kode: KODE_NILAI_WAJAR.FUTURE_DATE, pesan: `Tanggal penilaian ${tanggal} setelah hari ini (${hariIni}).` });
  }
  if (tanggal < objek.tanggalPerolehan) {
    hambatan.push({
      kode: KODE_NILAI_WAJAR.OUT_OF_ORDER,
      pesan: `Tanggal penilaian ${tanggal} sebelum tanggal perolehan ${objek.tanggalPerolehan}.`,
    });
  }
  const kolom = objek.objek === 'ASET_TETAP' ? 'aset_tetap_id' : 'investasi_id';
  const terakhir = await db.getFirstAsync<{ tanggal: string }>(
    `SELECT MAX(tanggal) AS tanggal FROM penyesuaian_nilai_wajar
      WHERE ${kolom} = ? AND status = 'DIPOSTING' AND id <> ?`,
    objek.id,
    kecualiId ?? ''
  );
  if (terakhir?.tanggal && terakhir.tanggal >= tanggal) {
    hambatan.push({
      kode: KODE_NILAI_WAJAR.OUT_OF_ORDER,
      pesan: `Sudah ada penilaian diposting per ${terakhir.tanggal}. Penilaian baru harus bertanggal sesudahnya.`,
    });
  }
  const sesudah =
    objek.objek === 'ASET_TETAP'
      ? await hitungSesudah(db, `SELECT COUNT(*) AS n FROM aset_penyusutan WHERE aset_id = ? AND tanggal > ?`, objek.id, tanggal)
      : (await hitungSesudah(db, `SELECT COUNT(*) AS n FROM investasi_penyusutan WHERE investasi_id = ? AND tanggal > ?`, objek.id, tanggal)) +
        (await hitungSesudah(db, `SELECT COUNT(*) AS n FROM investasi_impairment WHERE investasi_id = ? AND tanggal > ?`, objek.id, tanggal)) +
        (await hitungSesudah(db, `SELECT COUNT(*) AS n FROM investasi_penarikan WHERE investasi_id = ? AND tanggal > ?`, objek.id, tanggal));
  if (sesudah > 0) {
    hambatan.push({
      kode: KODE_NILAI_WAJAR.LATER_TRANSACTIONS,
      pesan: `Ada penyusutan/penurunan nilai bertanggal setelah ${tanggal}. Pilih tanggal penilaian pada/setelah transaksi terakhir.`,
    });
  }
  const belum = await periodePenyusutanBelumLengkap(db, objek.objek, objek.id, tanggal);
  if (belum.length > 0) {
    hambatan.push({
      kode: KODE_NILAI_WAJAR.DEPRECIATION_INCOMPLETE,
      pesan:
        `Penyusutan belum lengkap s.d. tanggal penilaian (${belum.length} periode, mulai ${belum[0]}). ` +
        'Proses penyusutan periode tersebut lebih dahulu agar nilai tercatat benar.',
    });
  }
  return hambatan;
}

// ------------------------------------------------------------------
// PENYUSUN RENCANA POSTING (satu sumber untuk pratinjau & eksekusi)
// ------------------------------------------------------------------

async function namaAkun(db: SQLite.SQLiteDatabase, accountId: string): Promise<{ kode: string; nama: string }> {
  const a = await db.getFirstAsync<{ kode: string; nama: string }>(`SELECT kode, nama FROM account WHERE id = ?`, accountId);
  return { kode: a?.kode ?? '', nama: a?.nama ?? '' };
}

async function susunRencanaPosting(
  db: SQLite.SQLiteDatabase,
  input: { objek: ObjekNilaiWajar; objekId: string; tanggal: string; nilaiWajar: Rupiah; kecualiId: string | null }
): Promise<RencanaPostingNilaiWajar> {
  const objek = await pastikanObjekEligible(db, input.objek, input.objekId);
  const nilaiTercatatSebelum = await nilaiTercatatPada(db, input.objek, input.objekId, input.tanggal);
  const selisih = hitungSelisihNilaiWajar(input.nilaiWajar, nilaiTercatatSebelum);
  const hambatan = await kumpulkanHambatanData(db, objek, input.tanggal, input.kecualiId);

  let jumlahLabaRugi = 0;
  let jumlahOci = 0;
  const mentah: { accountId: string; debit: number; kredit: number; keterangan: string }[] = [];

  if (selisih !== 0) {
    if (input.objek === 'PROPERTI_INVESTASI') {
      jumlahLabaRugi = selisih;
      const penyesuai = await resolveAccountId(db, MAPPING_PI, 'PENYESUAIAN_ASET');
      if (selisih > 0) {
        mentah.push({ accountId: penyesuai, debit: selisih, kredit: 0, keterangan: 'Kenaikan nilai wajar properti investasi' });
        mentah.push({
          accountId: await resolveAccountId(db, MAPPING_PI, 'KREDIT_KEUNTUNGAN'),
          debit: 0,
          kredit: selisih,
          keterangan: 'Keuntungan perubahan nilai wajar (laba rugi)',
        });
      } else {
        mentah.push({
          accountId: await resolveAccountId(db, MAPPING_PI, 'DEBIT_KERUGIAN'),
          debit: -selisih,
          kredit: 0,
          keterangan: 'Kerugian perubahan nilai wajar (laba rugi)',
        });
        mentah.push({ accountId: penyesuai, debit: 0, kredit: -selisih, keterangan: 'Penurunan nilai wajar properti investasi' });
      }
    } else {
      const lalu = await db.getFirstAsync<{ oci: number; lr: number }>(
        `SELECT COALESCE(SUM(jumlah_oci), 0) AS oci, COALESCE(SUM(jumlah_laba_rugi), 0) AS lr
           FROM penyesuaian_nilai_wajar
          WHERE aset_tetap_id = ? AND status = 'DIPOSTING' AND id <> ?`,
        input.objekId,
        input.kecualiId ?? ''
      );
      const bagian = bagiSelisihRevaluasi(selisih, lalu?.oci ?? 0, -(lalu?.lr ?? 0));
      jumlahLabaRugi = bagian.labaRugi;
      jumlahOci = bagian.oci;
      const penyesuai = await resolveAccountId(db, MAPPING_AT, 'PENYESUAIAN_ASET');
      const surplus = await resolveAccountId(db, MAPPING_AT, 'SURPLUS_OCI');
      if (selisih > 0) {
        mentah.push({ accountId: penyesuai, debit: selisih, kredit: 0, keterangan: 'Kenaikan nilai revaluasi aset tetap' });
        if (bagian.labaRugi > 0) {
          mentah.push({
            accountId: await resolveAccountId(db, MAPPING_AT, 'KREDIT_PEMULIHAN'),
            debit: 0,
            kredit: bagian.labaRugi,
            keterangan: 'Pemulihan kerugian revaluasi terdahulu (laba rugi)',
          });
        }
        if (bagian.oci > 0) {
          mentah.push({ accountId: surplus, debit: 0, kredit: bagian.oci, keterangan: 'Surplus revaluasi (penghasilan komprehensif lain)' });
        }
      } else {
        if (bagian.oci < 0) {
          mentah.push({ accountId: surplus, debit: -bagian.oci, kredit: 0, keterangan: 'Penurunan dibebankan ke surplus revaluasi (OCI)' });
        }
        if (bagian.labaRugi < 0) {
          mentah.push({
            accountId: await resolveAccountId(db, MAPPING_AT, 'DEBIT_KERUGIAN'),
            debit: -bagian.labaRugi,
            kredit: 0,
            keterangan: 'Kerugian revaluasi aset tetap (laba rugi)',
          });
        }
        mentah.push({ accountId: penyesuai, debit: 0, kredit: -selisih, keterangan: 'Penurunan nilai revaluasi aset tetap' });
      }
    }
  }

  const baris: BarisJurnalNilaiWajar[] = [];
  for (const l of mentah) baris.push({ ...l, ...(await namaAkun(db, l.accountId)) });

  return {
    objek: input.objek,
    objekId: input.objekId,
    namaObjek: objek.nama,
    tanggal: input.tanggal,
    nilaiTercatatSebelum,
    nilaiWajar: input.nilaiWajar,
    selisih,
    arahPerubahan: arahDariSelisih(selisih),
    jumlahLabaRugi,
    jumlahOci,
    baris,
    hambatan,
  };
}

/** Pratinjau lengkap (nilai, pembagian laba rugi/OCI, jurnal, hambatan) — tanpa menyimpan apa pun. */
export async function previewPenilaian(input: {
  objek: ObjekNilaiWajar;
  objekId: string;
  nilaiWajar: Rupiah;
  tanggal: string;
  kecualiId?: string | null;
}): Promise<RencanaPostingNilaiWajar> {
  validasiNilaiWajar(input.nilaiWajar);
  validasiTanggal(input.tanggal);
  const db = await getDb();
  return susunRencanaPosting(db, { ...input, kecualiId: input.kecualiId ?? null });
}

/** Pratinjau properti investasi (bentuk lama) — dipertahankan untuk kompatibilitas. */
export async function previewNilaiWajar(
  investasiId: string,
  nilaiWajar: Rupiah,
  tanggal?: string
): Promise<PreviewNilaiWajar> {
  validasiNilaiWajar(nilaiWajar);
  if (tanggal !== undefined) validasiTanggal(tanggal);
  const db = await getDb();
  const tgl = tanggal ?? getTanggalLokalHariIni();
  const inv = await pastikanObjekEligible(db, 'PROPERTI_INVESTASI', investasiId);
  const sebelum = await nilaiTercatatPada(db, 'PROPERTI_INVESTASI', investasiId, tanggal);
  const selisih = hitungSelisihNilaiWajar(nilaiWajar, sebelum);
  const hambatan = await kumpulkanHambatanData(db, inv, tgl, null);
  return {
    investasiId,
    namaInvestasi: inv.nama,
    nilaiTercatatSebelum: sebelum,
    nilaiWajar,
    selisih,
    arahPerubahan: arahDariSelisih(selisih),
    dapatDiposting: hambatan.length === 0,
    alasanTidakDapatDiposting: hambatan.length === 0 ? null : hambatan.map((h) => h.pesan).join(' '),
  };
}

// ------------------------------------------------------------------
// PENYIMPANAN, AUDIT TRAIL, LIFECYCLE
// ------------------------------------------------------------------

const SQL_ROW = `SELECT n.*,
       COALESCE(i.nama_tujuan, a.nama_aset) AS nama_objek,
       COALESCE(i.nomor_investasi, a.nomor_aset) AS nomor_objek,
       u.nama AS nama_pembuat,
       up.nama AS nama_pemosting,
       j.nomor_jurnal AS nomor_jurnal
  FROM penyesuaian_nilai_wajar n
  LEFT JOIN investasi i ON i.id = n.investasi_id
  LEFT JOIN aset_tetap a ON a.id = n.aset_tetap_id
  LEFT JOIN app_user u ON u.id = n.created_by
  LEFT JOIN app_user up ON up.id = n.diposting_oleh
  LEFT JOIN journal j ON j.id = n.journal_id`;

function petakan(r: Record<string, unknown>): NilaiWajarRow {
  const nilaiTercatatSebelum = r.nilai_tercatat_sebelum as number;
  const nilaiWajar = r.nilai_wajar as number;
  // Selisih & arah dibaca ulang dari SATU rumus, bukan dipercaya dari kolom.
  const selisih = hitungSelisihNilaiWajar(nilaiWajar, nilaiTercatatSebelum);
  const objek = ((r.objek as string) ?? 'PROPERTI_INVESTASI') as ObjekNilaiWajar;
  const investasiId = (r.investasi_id as string | null) ?? null;
  const asetTetapId = (r.aset_tetap_id as string | null) ?? null;
  const status = r.status as StatusPenilaianNilaiWajar;
  const namaObjek = (r.nama_objek as string) ?? '';
  return {
    id: r.id as string,
    objek,
    objekId: (objek === 'ASET_TETAP' ? asetTetapId : investasiId) ?? '',
    investasiId,
    asetTetapId,
    namaObjek,
    nomorObjek: (r.nomor_objek as string) ?? '',
    namaInvestasi: namaObjek,
    tanggal: r.tanggal as string,
    nilaiTercatatSebelum,
    nilaiWajar,
    selisih,
    arahPerubahan: arahDariSelisih(selisih),
    dasarPenilaian: (r.dasar_penilaian as string | null) ?? null,
    referensiBukti: (r.referensi_bukti as string | null) ?? null,
    penilai: (r.penilai as string | null) ?? null,
    catatan: (r.catatan as string | null) ?? null,
    status,
    jumlahLabaRugi: (r.jumlah_laba_rugi as number) ?? 0,
    jumlahOci: (r.jumlah_oci as number) ?? 0,
    createdBy: r.created_by as string,
    namaPembuat: (r.nama_pembuat as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    jurnalId: (r.journal_id as string | null) ?? null,
    nomorJurnal: (r.nomor_jurnal as string | null) ?? null,
    tanggalPosting: (r.diposting_at as string | null) ?? null,
    userPosting: ((r.nama_pemosting as string | null) ?? (r.diposting_oleh as string | null)) ?? null,
    statusPosting: status === 'DIPOSTING' ? 'DIPOSTING' : 'BELUM_DIPOSTING',
  };
}

async function bacaRow(db: SQLite.SQLiteDatabase, id: string): Promise<NilaiWajarRow | null> {
  const r = await db.getFirstAsync<Record<string, unknown>>(`${SQL_ROW} WHERE n.id = ?`, id);
  return r ? petakan(r) : null;
}

function snapshotAudit(row: NilaiWajarRow): Record<string, unknown> {
  return {
    objek: row.objek,
    investasiId: row.investasiId,
    asetTetapId: row.asetTetapId,
    tanggal: row.tanggal,
    nilaiTercatatSebelum: row.nilaiTercatatSebelum,
    nilaiWajar: row.nilaiWajar,
    selisih: row.selisih,
    arahPerubahan: row.arahPerubahan,
    dasarPenilaian: row.dasarPenilaian,
    referensiBukti: row.referensiBukti,
    penilai: row.penilai,
    catatan: row.catatan,
    status: row.status,
    jumlahLabaRugi: row.jumlahLabaRugi,
    jumlahOci: row.jumlahOci,
    journalId: row.jurnalId,
    createdBy: row.createdBy,
  };
}

/** Pola sama dengan RAKService/InvestasiService.writeAuditLog. */
async function tulisAudit(
  db: SQLite.SQLiteDatabase,
  userId: string,
  action: 'CREATE' | 'UPDATE' | 'VOID' | 'POST',
  entityId: string,
  dataSebelum: Record<string, unknown> | null,
  dataSesudah: Record<string, unknown> | null
): Promise<void> {
  const now = new Date();
  await db.runAsync(
    `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sebelum, data_sesudah, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId(),
    userId,
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    action,
    'penyesuaian_nilai_wajar',
    entityId,
    dataSebelum ? JSON.stringify(dataSebelum) : null,
    dataSesudah ? JSON.stringify(dataSesudah) : null,
    now.toISOString()
  );
}

/** Identitas penilaian: objek + tanggal, di antara penilaian yang masih berlaku (DRAFT/DIPOSTING). */
async function pastikanTidakDuplikat(
  db: SQLite.SQLiteDatabase,
  objek: ObjekNilaiWajar,
  objekId: string,
  tanggal: string,
  kecualiId: string | null
): Promise<void> {
  const kolom = objek === 'ASET_TETAP' ? 'aset_tetap_id' : 'investasi_id';
  const r = await db.getFirstAsync<{ id: string; status: string }>(
    `SELECT id, status FROM penyesuaian_nilai_wajar
      WHERE ${kolom} = ? AND tanggal = ? AND status IN ('DRAFT','DIPOSTING') AND id <> ?
      LIMIT 1`,
    objekId,
    tanggal,
    kecualiId ?? ''
  );
  if (r) {
    throw new Error(
      `${KODE_NILAI_WAJAR.DUPLICATE_ASSESSMENT}: Sudah ada penilaian ${r.status === 'DIPOSTING' ? 'yang diposting' : 'draft'} ` +
        `untuk objek ini pada tanggal ${tanggal}. ` +
        (r.status === 'DIPOSTING' ? 'Gunakan tanggal penilaian lain.' : 'Perbarui draft tersebut atau batalkan lebih dulu.')
    );
  }
}

export interface SimpanNilaiWajarInput {
  /** Default PROPERTI_INVESTASI (kompatibilitas). */
  objek?: ObjekNilaiWajar;
  /** Wajib bila objek = PROPERTI_INVESTASI. */
  investasiId?: string;
  /** Wajib bila objek = ASET_TETAP. */
  asetTetapId?: string;
  /** Tanggal penilaian (YYYY-MM-DD). */
  tanggal: string;
  nilaiWajar: Rupiah;
  /** Wajib. */
  dasarPenilaian?: string;
  /** Wajib. */
  referensiBukti?: string;
  /** Opsional — nama penilai/KJPP. */
  penilai?: string;
  catatan?: string;
  /** User yang melakukan aksi (maker pada simpan; editor pada perbarui). */
  createdBy: string;
}

function objekDariInput(input: SimpanNilaiWajarInput): { objek: ObjekNilaiWajar; objekId: string } {
  const objek: ObjekNilaiWajar = input.objek ?? 'PROPERTI_INVESTASI';
  const objekId = objek === 'ASET_TETAP' ? input.asetTetapId : input.investasiId;
  if (!objekId) {
    throw new Error(objek === 'ASET_TETAP' ? 'Pilih aset tetap terlebih dahulu.' : 'Pilih properti investasi terlebih dahulu.');
  }
  return { objek, objekId };
}

export async function simpanDraftNilaiWajar(input: SimpanNilaiWajarInput): Promise<NilaiWajarRow> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');

    const { objek, objekId } = objekDariInput(input);
    validasiNilaiWajar(input.nilaiWajar);
    validasiTanggal(input.tanggal);
    await pastikanObjekEligible(db, objek, objekId);
    const bukti = validasiBukti(input);
    await pastikanTidakDuplikat(db, objek, objekId, input.tanggal, null);

    const sebelum = await nilaiTercatatPada(db, objek, objekId, input.tanggal);
    const selisih = hitungSelisihNilaiWajar(input.nilaiWajar, sebelum);
    const id = newId();
    const now = new Date().toISOString();

    await db.runAsync(
      `INSERT INTO penyesuaian_nilai_wajar
        (id, objek, investasi_id, aset_tetap_id, tanggal, nilai_tercatat_sebelum, nilai_wajar, selisih,
         arah_perubahan, dasar_penilaian, referensi_bukti, penilai, catatan, status,
         created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?)`,
      id,
      objek,
      objek === 'PROPERTI_INVESTASI' ? objekId : null,
      objek === 'ASET_TETAP' ? objekId : null,
      input.tanggal,
      sebelum,
      input.nilaiWajar,
      selisih,
      arahDariSelisih(selisih),
      bukti.dasarPenilaian,
      bukti.referensiBukti,
      teksWajib(input.penilai),
      teksWajib(input.catatan),
      input.createdBy,
      now,
      now
    );

    const row = (await bacaRow(db, id)) as NilaiWajarRow;
    await tulisAudit(db, input.createdBy, 'CREATE', id, null, snapshotAudit(row));
    return row;
  });
}

export async function perbaruiDraftNilaiWajar(
  id: string,
  input: Omit<SimpanNilaiWajarInput, 'investasiId' | 'asetTetapId' | 'objek'>
): Promise<NilaiWajarRow> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    const lama = await bacaRow(db, id);
    if (!lama) throw new Error('Draft penyesuaian nilai wajar tidak ditemukan.');
    if (lama.status !== 'DRAFT') throw new Error('Hanya draft yang dapat diubah.');

    validasiNilaiWajar(input.nilaiWajar);
    validasiTanggal(input.tanggal);
    await pastikanObjekEligible(db, lama.objek, lama.objekId);
    const bukti = validasiBukti(input);
    await pastikanTidakDuplikat(db, lama.objek, lama.objekId, input.tanggal, id);

    const sebelum = await nilaiTercatatPada(db, lama.objek, lama.objekId, input.tanggal);
    const selisih = hitungSelisihNilaiWajar(input.nilaiWajar, sebelum);

    // `created_by` (maker) TIDAK pernah ditimpa; editor tercatat di audit_log.
    await db.runAsync(
      `UPDATE penyesuaian_nilai_wajar
          SET tanggal = ?, nilai_tercatat_sebelum = ?, nilai_wajar = ?, selisih = ?,
              arah_perubahan = ?, dasar_penilaian = ?, referensi_bukti = ?, penilai = ?, catatan = ?,
              updated_at = ?
        WHERE id = ? AND status = 'DRAFT'`,
      input.tanggal,
      sebelum,
      input.nilaiWajar,
      selisih,
      arahDariSelisih(selisih),
      bukti.dasarPenilaian,
      bukti.referensiBukti,
      teksWajib(input.penilai),
      teksWajib(input.catatan),
      new Date().toISOString(),
      id
    );

    const baru = (await bacaRow(db, id)) as NilaiWajarRow;
    await tulisAudit(db, input.createdBy, 'UPDATE', id, snapshotAudit(lama), snapshotAudit(baru));
    return baru;
  });
}

/**
 * DRAFT → DIBATALKAN. Alasan wajib dan tercatat di audit trail; catatan
 * penilaian semula TIDAK ditimpa. Baris tidak dihapus (histori tetap).
 * Penilaian yang sudah DIPOSTING tidak dapat dibatalkan.
 */
export async function batalkanPenilaianNilaiWajar(
  id: string,
  input: { alasan: string; userId: string }
): Promise<NilaiWajarRow> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'kas_bank', 'edit');
    const alasan = teksWajib(input.alasan);
    if (alasan === null) throw new Error('Alasan pembatalan wajib diisi.');
    const lama = await bacaRow(db, id);
    if (!lama) throw new Error(`${KODE_NILAI_WAJAR.NOT_FOUND}: Penilaian nilai wajar tidak ditemukan.`);
    if (lama.status === 'DIPOSTING') {
      throw new Error(
        `${KODE_NILAI_WAJAR.ALREADY_POSTED}: Penilaian ini sudah diposting dan tidak dapat dibatalkan. ` +
          'Koreksi dilakukan dengan penilaian baru pada tanggal sesudahnya.'
      );
    }
    if (lama.status !== 'DRAFT') {
      throw new Error(`${KODE_NILAI_WAJAR.NOT_DRAFT}: Hanya draft yang dapat dibatalkan.`);
    }
    await db.runAsync(
      `UPDATE penyesuaian_nilai_wajar SET status = 'DIBATALKAN', updated_at = ? WHERE id = ? AND status = 'DRAFT'`,
      new Date().toISOString(),
      id
    );
    const baru = (await bacaRow(db, id)) as NilaiWajarRow;
    await tulisAudit(db, input.userId, 'VOID', id, snapshotAudit(lama), {
      ...snapshotAudit(baru),
      alasanPembatalan: alasan,
    });
    return baru;
  });
}

/** Seluruh penilaian (semua objek & status), terbaru dulu. */
export async function listDraftNilaiWajar(): Promise<NilaiWajarRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(`${SQL_ROW} ORDER BY n.tanggal DESC, n.created_at DESC`);
  return rows.map(petakan);
}

/** Alias bernama jelas untuk `listDraftNilaiWajar` (mencakup DRAFT, DIPOSTING, DIBATALKAN). */
export const listPenilaianNilaiWajar = listDraftNilaiWajar;

export async function getPenilaianNilaiWajar(id: string): Promise<NilaiWajarRow | null> {
  const db = await getDb();
  return bacaRow(db, id);
}

/** Audit trail satu penilaian: maker, editor, pemosting, waktu, transisi status — urut kronologis. */
export async function getAuditTrailNilaiWajar(id: string): Promise<AuditNilaiWajarEntry[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT id, user_id, action, created_at, data_sebelum, data_sesudah
       FROM audit_log WHERE entity = 'penyesuaian_nilai_wajar' AND entity_id = ?
      ORDER BY created_at ASC, rowid ASC`,
    id
  );
  const parse = (v: unknown): Record<string, unknown> | null =>
    typeof v === 'string' ? (JSON.parse(v) as Record<string, unknown>) : null;
  return rows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    action: r.action as string,
    waktu: r.created_at as string,
    dataSebelum: parse(r.data_sebelum),
    dataSesudah: parse(r.data_sesudah),
  }));
}

// ------------------------------------------------------------------
// GERBANG POSTING & POSTING
// ------------------------------------------------------------------

export interface FaktaPostingNilaiWajar {
  readonly ditemukan: boolean;
  readonly status: StatusPenilaianNilaiWajar | null;
  readonly dasarPenilaian: string | null;
  readonly referensiBukti: string | null;
  /** Jumlah jurnal yang sudah terhubung ke identitas penilaian ini. */
  readonly jumlahJurnalTerkait: number;
  readonly kebijakan: ModelPengukuranPropertiInvestasi | ModelPengukuranAsetTetap;
  readonly mappingAktif: boolean;
}

/**
 * Evaluasi murni kelayakan posting berdasarkan STATUS baris (bukan data
 * lain). Mengembalikan SELURUH hambatan (kosong = tidak ada hambatan
 * status). Hambatan yang bergantung pada data (urutan, penyusutan, dst)
 * dievaluasi `susunRencanaPosting`.
 */
export function evaluasiKelayakanPostingNilaiWajar(f: FaktaPostingNilaiWajar): KodeNilaiWajar[] {
  if (!f.ditemukan) return [KODE_NILAI_WAJAR.NOT_FOUND];
  const hambatan: KodeNilaiWajar[] = [];
  if (f.status === 'DIPOSTING' || f.jumlahJurnalTerkait > 0) hambatan.push(KODE_NILAI_WAJAR.ALREADY_POSTED);
  else if (f.status !== 'DRAFT') hambatan.push(KODE_NILAI_WAJAR.NOT_DRAFT);
  if (teksWajib(f.dasarPenilaian) === null || teksWajib(f.referensiBukti) === null) {
    hambatan.push(KODE_NILAI_WAJAR.EVIDENCE_REQUIRED);
  }
  if (f.kebijakan !== 'MODEL_NILAI_WAJAR' && f.kebijakan !== 'MODEL_REVALUASI') hambatan.push(KODE_NILAI_WAJAR.POLICY_DISABLED);
  if (!f.mappingAktif) hambatan.push(KODE_NILAI_WAJAR.MAPPING_NOT_ACTIVE);
  return hambatan;
}

async function faktaPadaDb(db: SQLite.SQLiteDatabase, id: string): Promise<FaktaPostingNilaiWajar> {
  const row = await db.getFirstAsync<{
    status: string;
    objek: string;
    dasar_penilaian: string | null;
    referensi_bukti: string | null;
  }>(`SELECT status, objek, dasar_penilaian, referensi_bukti FROM penyesuaian_nilai_wajar WHERE id = ?`, id);
  const jurnal = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi IN (?, ?) AND sumber_id = ?`,
    SUMBER_TRANSAKSI_NILAI_WAJAR,
    SUMBER_TRANSAKSI_REVALUASI_ASET_TETAP,
    id
  );
  return {
    ditemukan: row !== null && row !== undefined,
    status: (row?.status as StatusPenilaianNilaiWajar | undefined) ?? null,
    dasarPenilaian: row?.dasar_penilaian ?? null,
    referensiBukti: row?.referensi_bukti ?? null,
    jumlahJurnalTerkait: jurnal?.n ?? 0,
    kebijakan: row?.objek === 'ASET_TETAP' ? KEBIJAKAN_PENGUKURAN_ASET_TETAP : KEBIJAKAN_PENGUKURAN_PROPERTI_INVESTASI,
    mappingAktif: MAPPING_NILAI_WAJAR_AKTIF,
  };
}

/** Baca fakta posting dari database (read-only). */
export async function getFaktaPostingNilaiWajar(id: string): Promise<FaktaPostingNilaiWajar> {
  return faktaPadaDb(await getDb(), id);
}

/** Pratinjau posting sebuah penilaian tersimpan (nilai dihitung ulang per hari ini). */
export async function previewPostingNilaiWajar(id: string): Promise<RencanaPostingNilaiWajar> {
  const db = await getDb();
  const row = await bacaRow(db, id);
  if (!row) throw new Error(`${KODE_NILAI_WAJAR.NOT_FOUND}: Penilaian nilai wajar tidak ditemukan.`);
  return susunRencanaPosting(db, {
    objek: row.objek,
    objekId: row.objekId,
    tanggal: row.tanggal,
    nilaiWajar: row.nilaiWajar,
    kecualiId: row.id,
  });
}

export interface HasilPostingNilaiWajar {
  readonly row: NilaiWajarRow;
  readonly journalId: string | null;
  readonly rencana: RencanaPostingNilaiWajar;
}

/**
 * POSTING — DRAFT → DIPOSTING, satu transaksi SQLite (rollback total bila
 * langkah mana pun gagal). Nilai tercatat DIHITUNG ULANG saat posting
 * (bisa berubah sejak draft disimpan, mis. ada penyusutan baru), lalu
 * jurnal dibentuk dari `susunRencanaPosting()` — penyusun yang sama
 * dengan pratinjau. Selisih nol: status DIPOSTING tanpa jurnal (penilaian
 * tetap tercatat; untuk properti investasi menandai model nilai wajar).
 */
export async function postingNilaiWajar(id: string, input: { userId: string }): Promise<HasilPostingNilaiWajar> {
  if (!input || !input.userId) throw new Error('User pemosting wajib diisi.');
  return withTransaction(async (db) => {
    await requirePermission(db, input.userId, 'kas_bank', 'approve');

    const fakta = await faktaPadaDb(db, id);
    const hambatanStatus = evaluasiKelayakanPostingNilaiWajar(fakta);
    if (hambatanStatus.includes(KODE_NILAI_WAJAR.NOT_FOUND)) {
      throw new Error(`${KODE_NILAI_WAJAR.NOT_FOUND}: Penilaian nilai wajar tidak ditemukan.`);
    }
    if (hambatanStatus.length > 0) {
      throw new Error(`${hambatanStatus.join(', ')}: Penilaian ini tidak dapat diposting.`);
    }

    const lama = (await bacaRow(db, id)) as NilaiWajarRow;
    const rencana = await susunRencanaPosting(db, {
      objek: lama.objek,
      objekId: lama.objekId,
      tanggal: lama.tanggal,
      nilaiWajar: lama.nilaiWajar,
      kecualiId: id,
    });
    if (rencana.hambatan.length > 0) {
      throw new Error(`${rencana.hambatan.map((h) => h.kode).join(', ')}: ${rencana.hambatan.map((h) => h.pesan).join(' ')}`);
    }
    await assertAccountingPeriodOpen(db, lama.tanggal);

    let journalId: string | null = null;
    if (rencana.baris.length > 0) {
      const tahun = parseInt(lama.tanggal.slice(0, 4), 10);
      const pi = lama.objek === 'PROPERTI_INVESTASI';
      const nomor = await nextSequence(db, pi ? 'NWP' : 'RVL', tahun);
      const hasil = await createJournal(db, {
        tanggal: lama.tanggal,
        // Literal (= SUMBER_TRANSAKSI_NILAI_WAJAR / SUMBER_TRANSAKSI_REVALUASI_ASET_TETAP)
        // supaya pemindai klasifikasi arus kas dapat menyelesaikannya.
        sumberTransaksi: pi ? 'PENYESUAIAN_NILAI_WAJAR' : 'REVALUASI_ASET_TETAP',
        sumberId: id,
        nomorReferensi: nomor,
        deskripsi: pi
          ? `Penyesuaian nilai wajar properti investasi ${rencana.namaObjek} per ${lama.tanggal} - ${nomor}`
          : `Revaluasi aset tetap ${rencana.namaObjek} (${lama.nomorObjek}) per ${lama.tanggal} - ${nomor}`,
        createdBy: input.userId,
        lines: rencana.baris.map((b) => ({ accountId: b.accountId, debit: b.debit, kredit: b.kredit, keterangan: b.keterangan })),
      });
      journalId = hasil.journalId;
    }

    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE penyesuaian_nilai_wajar
          SET status = 'DIPOSTING', nilai_tercatat_sebelum = ?, selisih = ?, arah_perubahan = ?,
              jumlah_laba_rugi = ?, jumlah_oci = ?, journal_id = ?, diposting_oleh = ?, diposting_at = ?,
              updated_at = ?
        WHERE id = ? AND status = 'DRAFT'`,
      rencana.nilaiTercatatSebelum,
      rencana.selisih,
      rencana.arahPerubahan,
      rencana.jumlahLabaRugi,
      rencana.jumlahOci,
      journalId,
      input.userId,
      now,
      now,
      id
    );
    const baru = (await bacaRow(db, id)) as NilaiWajarRow;
    if (baru.status !== 'DIPOSTING') {
      throw new Error(`${KODE_NILAI_WAJAR.NOT_DRAFT}: Status penilaian berubah selama posting; transaksi dibatalkan.`);
    }
    await tulisAudit(db, input.userId, 'POST', id, snapshotAudit(lama), snapshotAudit(baru));
    return { row: baru, journalId, rencana };
  });
}

// ------------------------------------------------------------------
// RINGKASAN
// ------------------------------------------------------------------

export interface RingkasanNilaiWajar {
  readonly jumlahDraft: number;
  readonly jumlahDiposting: number;
  /** Akumulasi selisih yang diposting ke laba rugi (bertanda). */
  readonly totalLabaRugi: Rupiah;
  /** Akumulasi selisih yang diposting ke OCI (bertanda). */
  readonly totalOci: Rupiah;
}

export async function getRingkasanNilaiWajar(): Promise<RingkasanNilaiWajar> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ d: number; p: number; lr: number; oci: number }>(
    `SELECT SUM(CASE WHEN status = 'DRAFT' THEN 1 ELSE 0 END) AS d,
            SUM(CASE WHEN status = 'DIPOSTING' THEN 1 ELSE 0 END) AS p,
            COALESCE(SUM(CASE WHEN status = 'DIPOSTING' THEN jumlah_laba_rugi ELSE 0 END), 0) AS lr,
            COALESCE(SUM(CASE WHEN status = 'DIPOSTING' THEN jumlah_oci ELSE 0 END), 0) AS oci
       FROM penyesuaian_nilai_wajar`
  );
  return {
    jumlahDraft: r?.d ?? 0,
    jumlahDiposting: r?.p ?? 0,
    totalLabaRugi: r?.lr ?? 0,
    totalOci: r?.oci ?? 0,
  };
}

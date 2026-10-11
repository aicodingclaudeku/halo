import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import { nextSequence, newId } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { JenisInvestasi } from '@/services/InvestasiService';

/**
 * Impairment Investasi (Phase 17 §8) — AUDIT DULU (§8, wajib sebelum
 * coding): SEBELUM audit ulang (permintaan pengguna §2/§3/§4), jenis
 * investasi yang dipakai aplikasi ini cuma DUA — `UNIT_USAHA`
 * (dinonaktifkan untuk transaksi baru, histori lama tetap ada) dan
 * `KOPERASI_LAIN`. Audit ulang menambahkan 5 jenis baru — Usaha Lain,
 * Tabungan/Giro/Deposito pada Bank Umum, dan Properti
 * Investasi (lihat InvestasiService.ts) — modul INI (Impairment
 * Investasi) TIDAK diminta berubah dan TIDAK diubah metodologinya:
 * fungsi di bawah murni bekerja dari `investasi.jumlah` & register
 * `investasi_impairment` secara generik per `investasiId`, TANPA
 * bercabang berdasarkan jenis — jadi otomatis tetap berfungsi untuk
 * ketujuh jenis tanpa perubahan kode. Catatan metodologi di bawah ini
 * (metode biaya, tanpa harga pasar/NAV, dinilai kualitatif oleh
 * pengurus) masih berlaku apa adanya untuk semua jenis investasi baru
 * tersebut juga — sama-sama tidak likuid & tidak punya kuotasi pasar
 * yang bisa diobservasi otomatis dari data yang ada di aplikasi ini
 * (termasuk Tabungan/Giro/Deposito & Properti — aplikasi ini tidak
 * mengintegrasikan feed harga/NAV/suku bunga pasar apa pun).
 * Keduanya/ketujuhnya SECARA STRUKTUR SAMA: penyertaan/penempatan
 * dana tidak likuid pada entitas/instrumen lain, dicatat sebesar
 * biaya perolehan (metode biaya — lihat AccountingPolicyService area
 * 'investasi'), TANPA harga pasar/NAV yang bisa diobservasi dari mana
 * pun di aplikasi ini. Karena itu SATU metode impairment (bukan
 * "universal" secara serampangan, tapi karena semuanya memang satu
 * jenis instrumen secara substansi dalam konteks aplikasi ini)
 * berlaku untuk semuanya — lihat §8.1 di bawah untuk kenapa metode
 * ini yang dipilih.
 *
 * §8.1 — JANGAN MENGARANG METODE:
 * Karena tidak ada harga pasar/kuotasi untuk instrumen ini di mana
 * pun dalam aplikasi (bukan keterbatasan implementasi — memang
 * begitu sifat penyertaan pada unit usaha/koperasi tujuan lain, atau
 * penempatan pada bank/properti tanpa integrasi feed pasar), nilai
 * yang dapat dipulihkan TIDAK BISA dihitung otomatis oleh sistem dari
 * data yang ada. Ini konsisten dengan praktik akuntansi umum untuk
 * instrumen ekuitas tanpa kuotasi yang diukur pada biaya perolehan:
 * penilaian penurunan nilai bersifat kualitatif (indikator) dan
 * nilai kerugiannya adalah ESTIMASI/JUDGEMENT pengurus berdasarkan
 * informasi terbaik yang tersedia (mis. laporan keuangan unit usaha
 * tujuan, kemampuan bayar, dst — semuanya di luar sistem ini), BUKAN
 * hasil kalkulasi rumus.
 *
 * Sistem ini karena itu TIDAK menghitung nilai impairment secara
 * otomatis — sistem hanya MENCATAT keputusan yang sudah dibuat
 * pengurus (indikasi apa yang terjadi, dasar penilaiannya apa, dan
 * berapa nilainya) secara terstruktur & auditable, lalu memposting
 * jurnalnya lewat AccountingEngine existing. Ini BUKAN keterbatasan
 * yang disembunyikan — ini didokumentasikan eksplisit di UI (§8.3)
 * dan di kebijakan akuntansi (AccountingPolicyService.ts).
 *
 * REVERSAL (§8.4): TIDAK diimplementasikan secara sengaja. Untuk
 * instrumen ekuitas tanpa kuotasi yang diukur pada biaya perolehan,
 * tidak ada bukti objektif yang bisa diandalkan untuk membuktikan
 * pemulihan nilai (beda dengan piutang, yang punya jadwal angsuran &
 * histori pembayaran sebagai bukti objektif — lihat
 * LoanImpairmentService yang MEMANG mendukung penyesuaian naik/turun
 * karena punya bukti semacam itu). Kebijakan: impairment investasi
 * bersifat permanen sampai investasi dilepas/dibatalkan.
 */

export interface EvaluasiImpairmentInput {
  investasiId: string;
  tanggal: string;
  /** Daftar indikator kualitatif yang dicentang pengurus (lihat INDIKATOR_IMPAIRMENT_INVESTASI) — digabung jadi satu teks. */
  indikasiTerpilih: string[];
  dasarPenilaian: string;
  nilaiImpairment: Rupiah;
  alasan: string;
  createdBy: string;
}

/**
 * Indikator kualitatif penurunan nilai investasi ekuitas tanpa
 * kuotasi (praktik umum untuk instrumen serupa dalam kerangka SAK
 * EP — bukan skedul otomatis, sekadar daftar bantu supaya evaluasi
 * terdokumentasi konsisten, pengurus tetap yang menilai substansinya).
 *
 * DIPERTAHANKAN (permintaan pengguna, request baru §8) untuk
 * kompatibilitas mundur — masih dipakai sebagai fallback generik
 * (lihat `getIndikatorImpairmentUntukJenis`) dan masih valid dipakai
 * langsung oleh caller lama (tidak ada validasi terhadap daftar
 * spesifik di `catatImpairmentInvestasi` — indikator disimpan sebagai
 * teks bebas gabungan, jadi mengganti daftar yang DITAWARKAN di form
 * TIDAK PERNAH merusak data histori yang sudah tersimpan).
 */
export const INDIKATOR_IMPAIRMENT_INVESTASI = [
  'Kesulitan keuangan signifikan pada unit usaha/koperasi tujuan investasi',
  'Kemungkinan unit usaha/koperasi tujuan mengalami kebangkrutan atau reorganisasi keuangan',
  'Penurunan signifikan dan berkelanjutan dalam kinerja usaha/hasil operasi unit usaha/koperasi tujuan',
  'Perubahan signifikan yang merugikan pada lingkungan teknologi, pasar, ekonomi, atau hukum tempat unit usaha/koperasi tujuan beroperasi',
  'Unit usaha/koperasi tujuan tidak lagi mampu memberikan hasil/bagi hasil sesuai yang diharapkan',
] as const;

/**
 * Audit ulang (permintaan pengguna, request baru §8 — "PALING
 * PENTING"): indikator penurunan nilai SEKARANG berbeda per Tujuan
 * Investasi (`JenisInvestasi`, lihat InvestasiService.ts), bukan satu
 * daftar generik yang sama untuk semua jenis. Mapping berdasarkan
 * VALUE INTERNAL enum yang sudah ada di source code (bukan tujuan
 * investasi baru yang dikarang) — cocok dengan pengelompokan Tujuan
 * Investasi yang sudah ada di InvestasiFormScreen.tsx:
 *
 *  - TABUNGAN_BANK_UMUM / GIRO_BANK_UMUM ("Bank Umum (simpanan > 3
 *    bulan)", §6) -> kategori A: indikator seputar kesehatan bank.
 *  - DEPOSITO_BANK_UMUM ("Deposito", §7) -> kategori B: indikator
 *    seputar bank + spesifik pencairan deposito (beda dari A karena
 *    deposito py istilah/karakteristik pencairan sendiri).
 *  - PROPERTI_INVESTASI -> kategori C: indikator seputar nilai pasar &
 *    kondisi fisik properti.
 *  - KOPERASI_LAIN / USAHA_LAIN / UNIT_USAHA (legacy) -> kategori D:
 *    indikator seputar kesehatan keuangan usaha/badan usaha tujuan
 *    (ketiganya sama-sama "penyertaan pada usaha/badan usaha lain"
 *    secara substansi — lihat komentar besar di atas soal metode biaya).
 *
 * Kategori E ("tujuan investasi lainnya") DISEDIAKAN sebagai fallback
 * pertahanan (`FALLBACK_INDIKATOR`) untuk value yang mungkin tidak
 * tercakup peta ini — saat ini TIDAK ADA jenis yang jatuh ke fallback
 * (ketujuh JenisInvestasi yang ada semuanya sudah dipetakan eksplisit
 * di bawah), tapi tetap disediakan untuk keamanan tipe & masa depan.
 */
const INDIKATOR_BANK_UMUM = [
  'Bank mengalami kesulitan keuangan',
  'Risiko gagal bayar bank',
  'Penurunan kemampuan bank memenuhi kewajiban',
  'Restrukturisasi atau permasalahan keuangan pada bank',
  'Penurunan kualitas kredit bank',
  'Kondisi lain yang menunjukkan dana berisiko tidak tertagih',
] as const;

const INDIKATOR_DEPOSITO = [
  'Risiko gagal bayar bank',
  'Bank mengalami kesulitan keuangan',
  'Deposito bermasalah',
  'Keterlambatan pencairan deposito',
  'Pembatasan pencairan deposito',
  'Penurunan kemampuan bank membayar',
] as const;

const INDIKATOR_PROPERTI = [
  'Penurunan nilai pasar properti',
  'Kerusakan fisik pada properti',
  'Penurunan tingkat hunian',
  'Penurunan pendapatan sewa',
  'Penurunan permintaan pasar',
  'Perubahan kondisi lokasi yang merugikan',
  'Penurunan estimasi nilai wajar properti',
] as const;

const INDIKATOR_USAHA = [
  'Kerugian signifikan',
  'Kesulitan keuangan',
  'Penurunan nilai aset usaha',
  'Penurunan kemampuan menghasilkan arus kas',
  'Restrukturisasi usaha',
  'Risiko gagal bayar/dividen tidak dapat diterima',
] as const;

/** Kategori E — fallback generik untuk jenis investasi yang tidak tercakup peta eksplisit (lihat komentar di atas). */
const FALLBACK_INDIKATOR = INDIKATOR_IMPAIRMENT_INVESTASI;

const INDIKATOR_IMPAIRMENT_PER_JENIS: Record<JenisInvestasi, readonly string[]> = {
  TABUNGAN_BANK_UMUM: INDIKATOR_BANK_UMUM,
  GIRO_BANK_UMUM: INDIKATOR_BANK_UMUM,
  DEPOSITO_BANK_UMUM: INDIKATOR_DEPOSITO,
  PROPERTI_INVESTASI: INDIKATOR_PROPERTI,
  KOPERASI_LAIN: INDIKATOR_USAHA,
  USAHA_LAIN: INDIKATOR_USAHA,
  UNIT_USAHA: INDIKATOR_USAHA,
};

/**
 * Ambil daftar indikator yang RELEVAN untuk satu jenis investasi
 * tertentu — dipakai form (§8) supaya checkbox yang ditampilkan
 * otomatis berubah mengikuti Tujuan Investasi yang dipilih. Menerima
 * string bebas (bukan hanya `JenisInvestasi`) supaya aman dipakai
 * langsung dari data baris investasi (`InvestasiListItem.jenisInvestasi`)
 * tanpa perlu type assertion di pemanggil, dan tetap punya fallback
 * yang aman kalau suatu saat ada value baru yang belum dipetakan.
 */
export function getIndikatorImpairmentUntukJenis(jenisInvestasi: string): readonly string[] {
  return INDIKATOR_IMPAIRMENT_PER_JENIS[jenisInvestasi as JenisInvestasi] ?? FALLBACK_INDIKATOR;
}

/** Nilai tercatat SATU investasi setelah dikurangi seluruh impairment yang pernah dicatat — dari register, bukan ledger agregat (lihat komentar schema.ts investasi_impairment). */
export async function getNilaiTercatatInvestasi(
  db: SQLite.SQLiteDatabase,
  investasiId: string,
  asOfDate?: string
): Promise<{
  nilaiAwal: Rupiah;
  akumulasiImpairment: Rupiah;
  akumulasiPenyusutan: Rupiah;
  totalDitarik: Rupiah;
  /** RC-S88 — akumulasi penyesuaian nilai wajar yang DIPOSTING (bertanda). */
  akumulasiPenyesuaianNilaiWajar: Rupiah;
  nilaiTercatat: Rupiah;
}> {
  const investasi = await db.getFirstAsync<{ jumlah: number }>(`SELECT jumlah FROM investasi WHERE id = ?`, investasiId);
  if (!investasi) throw new Error('Investasi tidak ditemukan.');

  const filterTanggal = asOfDate ? `AND tanggal <= ?` : '';
  const params = asOfDate ? [investasiId, asOfDate] : [investasiId];
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(nilai_impairment), 0) as total FROM investasi_impairment WHERE investasi_id = ? ${filterTanggal}`,
    ...params
  );
  const akumulasiImpairment = row?.total ?? 0;

  // RC-S53 corrective — POLICY 03 = MODEL BIAYA, sehingga nilai tercatat
  // adalah perolehan DIKURANGI akumulasi penyusutan DAN akumulasi
  // penurunan nilai. Sebelum perbaikan ini penyusutan tidak ikut
  // dikurangkan, sehingga nilai tercatat properti investasi yang sudah
  // disusutkan TERLALU TINGGI — dan batas atas impairment ikut terlalu
  // longgar. Register penyusutan dibaca langsung (bukan lewat import
  // service) supaya tidak ada ketergantungan melingkar.
  const rowSusut = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(nilai_penyusutan), 0) as total FROM investasi_penyusutan WHERE investasi_id = ? ${filterTanggal}`,
    ...params
  );
  const akumulasiPenyusutan = rowSusut?.total ?? 0;

  // v72 — pokok yang sudah ditarik SEBAGIAN (keputusan pengguna: nilai
  // tercatat berkurang sebesar dana ditarik). Nol untuk investasi tanpa
  // penarikan, sehingga hasil fungsi ini tidak berubah untuk data lama.
  // Tabel belum ada (database yang belum dimigrasi) diperlakukan sebagai
  // "belum pernah ada penarikan".
  let totalDitarik = 0;
  try {
    const rowTarik = await db.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(pokok_ditarik), 0) as total FROM investasi_penarikan WHERE investasi_id = ? AND jenis = 'SEBAGIAN' ${filterTanggal}`,
      ...params
    );
    totalDitarik = rowTarik?.total ?? 0;
  } catch (e) {
    if (!/no such table/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }

  // RC-S88 — MODEL NILAI WAJAR (SAK EP Bab 16): penyesuaian nilai wajar
  // yang sudah DIPOSTING (akun penyesuai 1-1665) ikut membentuk nilai
  // tercatat. Nol untuk investasi yang belum pernah dinilai, sehingga
  // hasil fungsi ini tidak berubah untuk data lama. Tabel/kolom belum
  // ada (database belum v73) = belum pernah ada penyesuaian.
  let akumulasiPenyesuaianNilaiWajar = 0;
  try {
    const rowNw = await db.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(selisih), 0) as total FROM penyesuaian_nilai_wajar
        WHERE investasi_id = ? AND objek = 'PROPERTI_INVESTASI' AND status = 'DIPOSTING' ${filterTanggal}`,
      ...params
    );
    akumulasiPenyesuaianNilaiWajar = rowNw?.total ?? 0;
  } catch (e) {
    if (!/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }

  return {
    nilaiAwal: investasi.jumlah,
    akumulasiImpairment,
    akumulasiPenyusutan,
    totalDitarik,
    akumulasiPenyesuaianNilaiWajar,
    nilaiTercatat: Math.max(
      investasi.jumlah - akumulasiPenyusutan - akumulasiImpairment - totalDitarik + akumulasiPenyesuaianNilaiWajar,
      0
    ),
  };
}

/**
 * Catat evaluasi & (kalau ada penurunan nilai) posting jurnal
 * impairment: DEBIT Beban Penurunan Nilai Investasi, KREDIT
 * Penyisihan Penurunan Nilai Investasi — lewat AccountingEngine
 * existing (createJournal), TIDAK bypass permission/audit log/period
 * close (semua sudah otomatis lewat createJournal & requirePermission,
 * pola sama seperti seluruh service lain di aplikasi ini).
 */
export async function catatImpairmentInvestasi(
  input: EvaluasiImpairmentInput
): Promise<{ id: string; journalId: string }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'edit');

    if (!input.indikasiTerpilih.length) {
      throw new Error('Pilih minimal satu indikasi penurunan nilai.');
    }
    if (!input.dasarPenilaian.trim()) {
      throw new Error('Dasar penilaian wajib diisi (jelaskan bagaimana nilai impairment ditentukan).');
    }
    if (!input.alasan.trim()) {
      throw new Error('Alasan/catatan wajib diisi.');
    }
    if (!Number.isFinite(input.nilaiImpairment) || input.nilaiImpairment <= 0) {
      throw new Error('Nilai impairment harus lebih dari 0.');
    }

    const investasi = await db.getFirstAsync<{ id: string; nama_tujuan: string; status: string }>(
      `SELECT id, nama_tujuan, status FROM investasi WHERE id = ?`,
      input.investasiId
    );
    if (!investasi) throw new Error('Investasi tidak ditemukan.');
    if (investasi.status !== 'AKTIF') {
      throw new Error('Investasi ini sudah tidak aktif (dibatalkan) — tidak bisa dicatat impairment-nya.');
    }

    const { nilaiTercatat } = await getNilaiTercatatInvestasi(db, input.investasiId);
    if (input.nilaiImpairment > nilaiTercatat) {
      throw new Error(
        `Nilai impairment (${input.nilaiImpairment}) tidak boleh melebihi nilai tercatat saat ini (${nilaiTercatat}).`
      );
    }

    const bebanAccountId = await resolveAccountId(db, 'IMPAIRMENT_INVESTASI', 'DEBIT_BEBAN');
    const penyisihanAccountId = await resolveAccountId(db, 'IMPAIRMENT_INVESTASI', 'KREDIT_PENYISIHAN');

    const year = new Date(input.tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'IMV', year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'IMPAIRMENT_INVESTASI',
      sumberId: input.investasiId,
      nomorReferensi: nomorTransaksi,
      deskripsi: `Penurunan nilai investasi pada ${investasi.nama_tujuan} - ${nomorTransaksi}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: bebanAccountId, debit: input.nilaiImpairment, kredit: 0 },
        { accountId: penyisihanAccountId, debit: 0, kredit: input.nilaiImpairment },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO investasi_impairment
        (id, investasi_id, tanggal, nilai_tercatat_sebelum, indikasi_penurunan_nilai, dasar_penilaian, nilai_impairment, alasan, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.investasiId,
      input.tanggal,
      nilaiTercatat,
      input.indikasiTerpilih.join('; '),
      input.dasarPenilaian.trim(),
      input.nilaiImpairment,
      input.alasan.trim(),
      journalId,
      input.createdBy,
      now
    );

    return { id, journalId };
  });
}

export interface RiwayatImpairmentRow {
  id: string;
  investasiId: string;
  namaTujuan: string;
  tanggal: string;
  nilaiTercatatSebelum: Rupiah;
  indikasiPenurunanNilai: string;
  dasarPenilaian: string;
  nilaiImpairment: Rupiah;
  alasan: string;
  journalId: string;
}

/** Riwayat seluruh evaluasi impairment (semua investasi, atau satu investasi kalau investasiId diisi) — untuk layar & CALK. */
export async function listRiwayatImpairmentInvestasi(opts: { investasiId?: string } = {}): Promise<RiwayatImpairmentRow[]> {
  const db = await getDb();
  const where = opts.investasiId ? 'WHERE ii.investasi_id = ?' : '';
  const params = opts.investasiId ? [opts.investasiId] : [];
  const rows = await db.getAllAsync<any>(
    `SELECT ii.*, i.nama_tujuan
     FROM investasi_impairment ii
     JOIN investasi i ON i.id = ii.investasi_id
     ${where}
     ORDER BY ii.tanggal DESC, ii.created_at DESC`,
    ...params
  );
  return rows.map((r) => ({
    id: r.id,
    investasiId: r.investasi_id,
    namaTujuan: r.nama_tujuan,
    tanggal: r.tanggal,
    nilaiTercatatSebelum: r.nilai_tercatat_sebelum,
    indikasiPenurunanNilai: r.indikasi_penurunan_nilai,
    dasarPenilaian: r.dasar_penilaian,
    nilaiImpairment: r.nilai_impairment,
    alasan: r.alasan,
    journalId: r.journal_id,
  }));
}

/** Total akumulasi impairment SELURUH investasi s.d. asOfDate — untuk rekonsiliasi & CALK (bandingkan dengan saldo akun 1-1900 di ledger). */
export async function getTotalImpairmentInvestasi(db: SQLite.SQLiteDatabase, asOfDate?: string): Promise<Rupiah> {
  const filterTanggal = asOfDate ? `WHERE tanggal <= ?` : '';
  const params = asOfDate ? [asOfDate] : [];
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(nilai_impairment), 0) as total FROM investasi_impairment ${filterTanggal}`,
    ...params
  );
  return row?.total ?? 0;
}

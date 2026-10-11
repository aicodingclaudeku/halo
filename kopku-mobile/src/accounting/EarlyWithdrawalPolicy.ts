import { Rupiah } from '@/utils/money';

/**
 * ============================================================
 * KEBIJAKAN PENARIKAN DINI SIMPANAN BERJANGKA — SATU SUMBER KEBENARAN
 * ============================================================
 *
 * SELURUH keputusan penarikan dini berasal dari modul ini. UI, service,
 * mesin perhitungan, jurnal, dan laporan TIDAK BOLEH memutuskan sendiri
 * apakah ada penalti, berapa bunga yang hangus, atau berapa biaya
 * admin — mereka hanya memanggil `evaluasiKebijakanEarlyWithdrawal()`
 * dan `calculateEarlyWithdrawalSettlement()`.
 *
 * ------------------------------------------------------------
 * YANG DIBANGUN DI S21 vs YANG TETAP KOSONG — dibedakan tegas
 * ------------------------------------------------------------
 * DIBANGUN  : arsitektur enam kapabilitas (penalti, forfeiture bunga,
 *             biaya admin, penyesuaian rate, perlakuan pokok, perlakuan
 *             bunga) — model, validasi, perhitungan, jurnal, subledger,
 *             laporan, dan tesnya.
 * TETAP KOSONG: ANGKA kebijakannya. Tidak ada satu pun default numerik
 *             di berkas ini. Koperasi belum menerbitkan keputusan
 *             tertulis berisi persentase penalti, porsi bunga yang
 *             hangus, besaran biaya admin, atau rate penarikan dini.
 *
 * Karena itu instalasi tanpa baris kebijakan berstatus
 * `POLICY_REQUIRED` dan penarikan dini DITOLAK — bukan dijalankan
 * dengan angka karangan. Menebak salah satu parameter berarti mengikat
 * anggota pada aturan keuangan yang tidak pernah diputuskan siapa pun,
 * dan jurnalnya sudah terlanjur terposting sebelum kekeliruannya
 * ketahuan.
 *
 * `KEBIJAKAN_PENARIKAN_DINI_TERSEDIA` di
 * `SimpananBerjangkaKebijakanPencairan.ts` tetap `false`: aplikasi
 * TIDAK mengapalkan kebijakan bawaan. Yang berubah di S21 hanyalah —
 * begitu pengurus mengisi kebijakan, tidak diperlukan lagi redesign.
 */

// ============================================================
// PARAMETER KEBIJAKAN (§C)
// ============================================================

/** Bentuk penalti. `TIDAK_ADA` = policy menyatakan tanpa penalti. */
export type JenisPenalti = 'TIDAK_ADA' | 'NOMINAL_TETAP' | 'PERSENTASE';

/**
 * Dasar perhitungan penalti persentase. WAJIB ditetapkan policy bila
 * jenisnya PERSENTASE — basis TIDAK PERNAH diasumsikan (§D).
 */
export type BasisPenalti = 'POKOK' | 'BUNGA_BRUTO' | 'TOTAL_SEBELUM_PENALTI';

/** Bentuk bunga hangus. */
export type JenisForfeiture = 'TIDAK_ADA' | 'SELURUH_BUNGA' | 'PERSENTASE_BUNGA' | 'NOMINAL_TETAP';

export type JenisBiayaAdmin = 'TIDAK_ADA' | 'NOMINAL_TETAP' | 'PERSENTASE';

export type BasisBiayaAdmin = 'POKOK' | 'BUNGA_BRUTO';

/** Apakah rate kontrak diganti rate penarikan dini. */
export type JenisPenyesuaianRate = 'TIDAK_ADA' | 'RATE_DINI';

/**
 * Sejauh mana rate dini berlaku. Tidak ada default: menghitung ulang
 * bunga historis diam-diam adalah persis yang dilarang §G.
 */
export type CakupanPenyesuaianRate = 'SEJAK_PENEMPATAN' | 'PERIODE_BERJALAN_SAJA';

/**
 * Ke mana potongan penalti/biaya admin dibebankan. Ini SATU-SATUNYA
 * pengendali arah potongan, supaya penalti mustahil terpotong dua kali
 * (sekali dari pokok, sekali dari bunga).
 */
export type PerlakuanPokok =
  | 'PENUH'
  | 'DIKURANGI_PENALTI'
  | 'DIKURANGI_BIAYA_ADMIN'
  | 'DIKURANGI_PENALTI_DAN_BIAYA';

/**
 * Perlakuan bunga.
 *   BAYAR_SETELAH_FORFEITURE — bunga bruto dikurangi bunga hangus.
 *   TIDAK_DIBAYAR            — seluruh bunga hangus (wajib konsisten
 *                              dengan forfeiture SELURUH_BUNGA).
 */
export type PerlakuanBunga = 'BAYAR_SETELAH_FORFEITURE' | 'TIDAK_DIBAYAR';

/**
 * KEBIJAKAN YANG MASIH DALAM PENYUSUNAN (RC-S44b).
 *
 * ------------------------------------------------------------
 * KENAPA TIPE INI ADA
 * ------------------------------------------------------------
 * Enam field keputusan di bawah — jenis penalti, jenis bunga hangus,
 * jenis biaya administrasi, jenis penyesuaian rate, perlakuan pokok,
 * dan perlakuan bunga — dulu bertipe non-null. Akibatnya layar
 * penetapan kebijakan harus mengisi sesuatu saat menyimpan, dan ia
 * mengisi `?? 'TIDAK_ADA'` / `?? 'PENUH'` / `?? 'BAYAR_SETELAH_FORFEITURE'`.
 *
 * Itu SALAH secara domain, dan salahnya halus:
 *
 *   null        = pengurus BELUM MEMUTUSKAN
 *   'TIDAK_ADA' = pengurus MEMUTUSKAN tidak ada penalti
 *
 * Keduanya menghasilkan perhitungan yang sama (penalti nol), sehingga
 * kekeliruannya tidak terlihat dari angka mana pun. Yang berbeda adalah
 * pertanggungjawabannya: yang pertama berarti aplikasi memutuskan
 * sendiri aturan yang mengikat anggota, dan jurnalnya sudah terposting
 * sebelum ada yang menyadari tidak pernah ada rapat yang memutuskannya.
 *
 * `null` karena itu HARUS dapat direpresentasikan dan disimpan apa
 * adanya. Kebijakan dengan keputusan yang masih null berstatus
 * POLICY_REQUIRED — tersimpan, tetapi tidak dapat dipakai.
 */
export interface KebijakanEarlyWithdrawalDraft
  extends Omit<
    KebijakanEarlyWithdrawal,
    | 'jenisPenalti'
    | 'jenisForfeiture'
    | 'jenisBiayaAdmin'
    | 'jenisPenyesuaianRate'
    | 'perlakuanPokok'
    | 'perlakuanBunga'
  > {
  jenisPenalti: JenisPenalti | null;
  jenisForfeiture: JenisForfeiture | null;
  jenisBiayaAdmin: JenisBiayaAdmin | null;
  jenisPenyesuaianRate: JenisPenyesuaianRate | null;
  perlakuanPokok: PerlakuanPokok | null;
  perlakuanBunga: PerlakuanBunga | null;
}

export interface KebijakanEarlyWithdrawal {
  /** Identitas versi kebijakan, mis. 'EW-2026-01'. Disimpan di setiap settlement. */
  versi: string;
  berlakuMulai: string;
  /** false = pengurus melarang penarikan dini sama sekali. */
  diizinkan: boolean;

  jenisPenalti: JenisPenalti;
  /** Rupiah bulat bila NOMINAL_TETAP; persen bila PERSENTASE. */
  nilaiPenalti: number | null;
  basisPenalti: BasisPenalti | null;
  /** Akun pendapatan penampung penalti. Tidak diturunkan/ditebak. */
  akunPenaltiId: string | null;

  jenisForfeiture: JenisForfeiture;
  nilaiForfeiture: number | null;

  jenisBiayaAdmin: JenisBiayaAdmin;
  nilaiBiayaAdmin: number | null;
  basisBiayaAdmin: BasisBiayaAdmin | null;
  akunBiayaAdminId: string | null;

  /** Rate penarikan dini (persen/tahun). */
  rateDini: number | null;
  jenisPenyesuaianRate: JenisPenyesuaianRate;
  cakupanPenyesuaianRate: CakupanPenyesuaianRate | null;

  perlakuanPokok: PerlakuanPokok;
  perlakuanBunga: PerlakuanBunga;

  /** Nomor SK/rapat yang menetapkan. Untuk audit trail (§AJ). */
  dasarPenetapan: string | null;
  ditetapkanOleh: string | null;
}

// ============================================================
// STATUS KEBIJAKAN (§AL)
// ============================================================

export type StatusKebijakanEarlyWithdrawal =
  /** Lengkap & konsisten — penarikan dini boleh dijalankan. */
  | 'AKTIF'
  /** Belum ada kebijakan, atau ada tetapi parameternya belum lengkap. */
  | 'POLICY_REQUIRED'
  /** Ada kebijakan tetapi parameternya saling bertentangan. */
  | 'POLICY_CONFLICT'
  /** Pengurus secara eksplisit melarang penarikan dini. */
  | 'DILARANG';

export interface HasilEvaluasiKebijakan {
  status: StatusKebijakanEarlyWithdrawal;
  /** Daftar parameter yang belum/keliru ditetapkan. Kosong bila AKTIF. */
  kekurangan: string[];
  /** Kalimat siap tampil untuk UI & pesan error service. */
  pesan: string;
}

export const PESAN_POLICY_REQUIRED =
  'Penarikan sebelum jatuh tempo belum dapat diproses karena ketentuan koperasi untuk penarikan dini ' +
  '(penalti, bunga hangus, biaya administrasi, rate, perlakuan pokok, dan perlakuan bunga) belum ditetapkan lengkap.';

export const PESAN_POLICY_DILARANG =
  'Ketentuan koperasi menyatakan simpanan berjangka tidak dapat dicairkan sebelum jatuh tempo.';

export const PESAN_POLICY_CONFLICT =
  'Ketentuan penarikan dini yang tersimpan saling bertentangan sehingga tidak dapat dijalankan. ' +
  'Perbaiki ketentuan tersebut lebih dahulu.';

export class KebijakanEarlyWithdrawalError extends Error {
  readonly status: StatusKebijakanEarlyWithdrawal;
  readonly kekurangan: string[];
  constructor(hasil: HasilEvaluasiKebijakan) {
    super(hasil.pesan);
    this.name = 'KebijakanEarlyWithdrawalError';
    this.status = hasil.status;
    this.kekurangan = hasil.kekurangan;
  }
}

function angkaPositif(nilai: number | null | undefined): boolean {
  return typeof nilai === 'number' && Number.isFinite(nilai) && nilai > 0;
}

function angkaNolAtauPositif(nilai: number | null | undefined): boolean {
  return typeof nilai === 'number' && Number.isFinite(nilai) && nilai >= 0;
}

/**
 * Evaluasi kelengkapan & konsistensi kebijakan. FUNGSI MURNI — tidak
 * menyentuh database, sehingga UI, service, dan test memakai penilaian
 * yang sama persis dan mustahil berbeda pendapat.
 *
 * `null` (belum ada baris kebijakan) -> POLICY_REQUIRED. Itu keadaan
 * bawaan aplikasi.
 */
export function evaluasiKebijakanEarlyWithdrawal(
  k: KebijakanEarlyWithdrawalDraft | KebijakanEarlyWithdrawal | null | undefined
): HasilEvaluasiKebijakan {
  if (!k) {
    return {
      status: 'POLICY_REQUIRED',
      kekurangan: ['kebijakan penarikan dini belum ditetapkan sama sekali'],
      pesan: PESAN_POLICY_REQUIRED,
    };
  }

  if (!k.diizinkan) {
    return { status: 'DILARANG', kekurangan: [], pesan: PESAN_POLICY_DILARANG };
  }

  const kurang: string[] = [];
  const konflik: string[] = [];

  if (!k.versi || !k.versi.trim()) kurang.push('versi kebijakan');
  if (!k.berlakuMulai) kurang.push('tanggal berlaku kebijakan');

  // ---- Keputusan yang belum diambil (RC-S44b) ----
  //
  // `null` DIPERIKSA TERPISAH dari nilainya. Pemeriksaan di bawah
  // sengaja memakai `=== null`, bukan falsy: 'TIDAK_ADA' dan 'PENUH'
  // adalah keputusan yang sah dan harus lolos, sedangkan belum
  // memutuskan tidak boleh.
  if (k.jenisPenalti === null || k.jenisPenalti === undefined) {
    kurang.push('keputusan jenis penalti');
  }
  if (k.jenisForfeiture === null || k.jenisForfeiture === undefined) {
    kurang.push('keputusan perlakuan bunga hangus');
  }
  if (k.jenisBiayaAdmin === null || k.jenisBiayaAdmin === undefined) {
    kurang.push('keputusan biaya administrasi');
  }
  if (k.jenisPenyesuaianRate === null || k.jenisPenyesuaianRate === undefined) {
    kurang.push('keputusan penyesuaian rate');
  }
  if (k.perlakuanPokok === null || k.perlakuanPokok === undefined) {
    kurang.push('keputusan perlakuan pokok');
  }
  if (k.perlakuanBunga === null || k.perlakuanBunga === undefined) {
    kurang.push('keputusan perlakuan bunga');
  }

  // ---- Penalti (§D) ----
  if (k.jenisPenalti === 'NOMINAL_TETAP') {
    if (!angkaPositif(k.nilaiPenalti)) kurang.push('nominal penalti');
    if (!k.akunPenaltiId) kurang.push('akun pendapatan penalti');
  } else if (k.jenisPenalti === 'PERSENTASE') {
    if (!angkaPositif(k.nilaiPenalti)) kurang.push('persentase penalti');
    if (!k.basisPenalti) kurang.push('basis perhitungan penalti');
    if (!k.akunPenaltiId) kurang.push('akun pendapatan penalti');
  }

  // ---- Biaya admin (§F) ----
  if (k.jenisBiayaAdmin === 'NOMINAL_TETAP') {
    if (!angkaPositif(k.nilaiBiayaAdmin)) kurang.push('nominal biaya administrasi');
    if (!k.akunBiayaAdminId) kurang.push('akun pendapatan biaya administrasi');
  } else if (k.jenisBiayaAdmin === 'PERSENTASE') {
    if (!angkaPositif(k.nilaiBiayaAdmin)) kurang.push('persentase biaya administrasi');
    if (!k.basisBiayaAdmin) kurang.push('basis perhitungan biaya administrasi');
    if (!k.akunBiayaAdminId) kurang.push('akun pendapatan biaya administrasi');
  }

  // ---- Forfeiture bunga (§E) ----
  if (k.jenisForfeiture === 'PERSENTASE_BUNGA') {
    if (!angkaPositif(k.nilaiForfeiture)) kurang.push('persentase bunga hangus');
  } else if (k.jenisForfeiture === 'NOMINAL_TETAP') {
    if (!angkaPositif(k.nilaiForfeiture)) kurang.push('nominal bunga hangus');
  }

  // ---- Penyesuaian rate (§G) ----
  if (k.jenisPenyesuaianRate === 'RATE_DINI') {
    if (!angkaNolAtauPositif(k.rateDini)) kurang.push('rate penarikan dini');
    if (!k.cakupanPenyesuaianRate) kurang.push('cakupan berlakunya rate penarikan dini');
  }

  // ---- Konsistensi antar-parameter ----
  // Perlakuan bunga TIDAK_DIBAYAR hanya sah bila forfeiture memang
  // menyatakan seluruh bunga hangus. Dua parameter yang mengatur hal
  // sama tidak boleh berselisih diam-diam.
  if (k.perlakuanBunga === 'TIDAK_DIBAYAR' && k.jenisForfeiture !== 'SELURUH_BUNGA') {
    konflik.push(
      'perlakuan bunga "tidak dibayar" tetapi jenis bunga hangus bukan "seluruh bunga"'
    );
  }
  if (k.perlakuanBunga === 'BAYAR_SETELAH_FORFEITURE' && k.jenisForfeiture === 'SELURUH_BUNGA') {
    konflik.push(
      'jenis bunga hangus "seluruh bunga" tetapi perlakuan bunga masih "bayar setelah forfeiture"'
    );
  }
  // Potongan pokok tidak boleh menunjuk komponen yang tidak berlaku:
  // itu tanda konfigurasi yang belum selesai, bukan potongan nol.
  if (
    (k.perlakuanPokok === 'DIKURANGI_PENALTI' ||
      k.perlakuanPokok === 'DIKURANGI_PENALTI_DAN_BIAYA') &&
    k.jenisPenalti === 'TIDAK_ADA'
  ) {
    konflik.push('perlakuan pokok memotong penalti padahal kebijakan menyatakan tanpa penalti');
  }
  if (
    (k.perlakuanPokok === 'DIKURANGI_BIAYA_ADMIN' ||
      k.perlakuanPokok === 'DIKURANGI_PENALTI_DAN_BIAYA') &&
    k.jenisBiayaAdmin === 'TIDAK_ADA'
  ) {
    konflik.push(
      'perlakuan pokok memotong biaya administrasi padahal kebijakan menyatakan tanpa biaya administrasi'
    );
  }

  if (kurang.length > 0) {
    return {
      status: 'POLICY_REQUIRED',
      kekurangan: kurang,
      pesan: `${PESAN_POLICY_REQUIRED} Belum ditetapkan: ${kurang.join(', ')}.`,
    };
  }
  if (konflik.length > 0) {
    return {
      status: 'POLICY_CONFLICT',
      kekurangan: konflik,
      pesan: `${PESAN_POLICY_CONFLICT} Pertentangan: ${konflik.join('; ')}.`,
    };
  }

  return { status: 'AKTIF', kekurangan: [], pesan: 'Kebijakan penarikan dini lengkap dan berlaku.' };
}

/**
 * Ke mana penalti & biaya admin dipotong. Diturunkan HANYA dari
 * `perlakuanPokok` supaya satu komponen mustahil dipotong dua kali.
 */
export function targetPotongan(perlakuan: PerlakuanPokok): {
  penaltiDariPokok: boolean;
  biayaDariPokok: boolean;
} {
  switch (perlakuan) {
    case 'PENUH':
      return { penaltiDariPokok: false, biayaDariPokok: false };
    case 'DIKURANGI_PENALTI':
      return { penaltiDariPokok: true, biayaDariPokok: false };
    case 'DIKURANGI_BIAYA_ADMIN':
      return { penaltiDariPokok: false, biayaDariPokok: true };
    case 'DIKURANGI_PENALTI_DAN_BIAYA':
      return { penaltiDariPokok: true, biayaDariPokok: true };
  }
}

/**
 * Tujuan akuntansi bunga yang dibatalkan.
 *
 * SATU-SATUNYA tujuan yang didukung: PEMBALIKAN akun beban bunga yang
 * dulu dipakai saat akrual (`SIMPANAN_BERJANGKA_BUNGA_AKRUAL` /
 * `DEBIT_BEBAN`). Ini BUKAN akun karangan — ia diturunkan dari jurnal
 * akrualnya sendiri: bunga yang tidak pernah menjadi hak anggota
 * berarti bebannya tidak pernah benar-benar terjadi, jadi yang benar
 * adalah membalik beban itu, bukan mengakuinya sebagai pendapatan baru
 * (§AE: "bunga yang dibatalkan tidak menjadi pendapatan palsu").
 *
 * Akun penalti & biaya admin BERBEDA — keduanya pendapatan sungguhan
 * yang tidak dapat diturunkan dari transaksi mana pun, jadi keduanya
 * WAJIB ditetapkan policy.
 */
export const TUJUAN_AKUNTANSI_FORFEITURE = 'PEMBALIKAN_BEBAN_BUNGA_AKRUAL' as const;

/** Ringkasan kebijakan untuk ditampilkan di UI/laporan (tanpa angka karangan). */
export function ringkasKebijakan(k: KebijakanEarlyWithdrawal): string[] {
  const baris: string[] = [];
  baris.push(
    k.jenisPenalti === 'TIDAK_ADA'
      ? 'Penalti: tidak ada'
      : k.jenisPenalti === 'NOMINAL_TETAP'
        ? `Penalti: nominal tetap ${k.nilaiPenalti}`
        : `Penalti: ${k.nilaiPenalti}% dari ${k.basisPenalti}`
  );
  baris.push(
    k.jenisForfeiture === 'TIDAK_ADA'
      ? 'Bunga hangus: tidak ada'
      : k.jenisForfeiture === 'SELURUH_BUNGA'
        ? 'Bunga hangus: seluruh bunga'
        : k.jenisForfeiture === 'PERSENTASE_BUNGA'
          ? `Bunga hangus: ${k.nilaiForfeiture}% dari bunga bruto`
          : `Bunga hangus: nominal tetap ${k.nilaiForfeiture}`
  );
  baris.push(
    k.jenisBiayaAdmin === 'TIDAK_ADA'
      ? 'Biaya administrasi: tidak ada'
      : k.jenisBiayaAdmin === 'NOMINAL_TETAP'
        ? `Biaya administrasi: nominal tetap ${k.nilaiBiayaAdmin}`
        : `Biaya administrasi: ${k.nilaiBiayaAdmin}% dari ${k.basisBiayaAdmin}`
  );
  baris.push(
    k.jenisPenyesuaianRate === 'TIDAK_ADA'
      ? 'Penyesuaian rate: tidak ada (memakai rate kontrak)'
      : `Penyesuaian rate: ${k.rateDini}%/tahun, berlaku ${k.cakupanPenyesuaianRate}`
  );
  baris.push(`Perlakuan pokok: ${k.perlakuanPokok}`);
  baris.push(`Perlakuan bunga: ${k.perlakuanBunga}`);
  return baris;
}

/** Nominal Rupiah bulat wajib — dipakai validator nilai kebijakan nominal. */
export function pastikanRupiahBulat(nilai: number, label: string): Rupiah {
  if (!Number.isInteger(nilai) || nilai < 0) {
    throw new Error(`${label} harus bilangan bulat Rupiah tidak negatif.`);
  }
  return nilai;
}


/**
 * Penyempit tipe: kebijakan yang LENGKAP dan dapat dipakai menghitung.
 *
 * Sengaja memanggil `evaluasiKebijakanEarlyWithdrawal()` alih-alih
 * memeriksa field satu per satu. Kalau kelengkapan didefinisikan di dua
 * tempat, cepat atau lambat keduanya berbeda — dan yang lebih longgar
 * yang akan dipakai penyempit tipe, sehingga `null` bisa lolos ke
 * kalkulasi lewat jalur yang dianggap sudah aman oleh compiler.
 *
 * Dengan ini, "lolos evaluator" dan "boleh dihitung" adalah satu
 * pernyataan yang sama, dijamin compiler.
 */
export function isKebijakanLengkap(
  k: KebijakanEarlyWithdrawalDraft | KebijakanEarlyWithdrawal | null | undefined
): k is KebijakanEarlyWithdrawal {
  return evaluasiKebijakanEarlyWithdrawal(k).status === 'AKTIF';
}

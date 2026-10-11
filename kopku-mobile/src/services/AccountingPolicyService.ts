import { getDb } from '@/database/db';
import { HARI_MINIMUM_NON_ACCRUAL_DEFAULT } from '@/accounting/NonAccrualPolicy';
import { KOLEKTIBILITAS_URUT, type Kolektibilitas } from '@/services/LoanImpairmentService';

/**
 * Kebijakan koperasi yang configurable (Phase 2, AUDIT_INTERNAL.md §5:
 * "AccountingPolicyService: MISSING — kebijakan tidak configurable di
 * manapun"). Dibangun di atas tabel `app_config` yang SUDAH ADA di
 * schema sejak awal tapi belum pernah dipakai satu service pun —
 * BUKAN tabel baru.
 *
 * Nilai-nilai di sini akan dipakai LiquidityService (Phase 4) &
 * LoanEligibilityService (Phase 6) untuk validasi — sengaja dipisah
 * dari logic validasinya sendiri supaya angka kebijakan tidak
 * ter-hardcode di tengah business rule (§ instruksi: "Jangan
 * hardcode kebijakan koperasi; buat configurable").
 *
 * DEFAULT semua kebijakan adalah "tidak membatasi" (0 = tanpa limit,
 * reserve 0) — supaya instalasi yang sudah berjalan TIDAK tiba-tiba
 * mulai menolak transaksi yang sebelumnya diterima hanya karena
 * service ini ditambahkan. Admin mengaktifkan pembatasan secara
 * eksplisit lewat layar Pengaturan (menyusul saat kebijakan ini
 * benar-benar dipakai gate transaksi, phase 4 & 6) — bukan angka yang
 * dikarang di sini.
 */

export type PolicyKey =
  | 'MINIMUM_CASH_RESERVE' // saldo kas minimum yang harus tersisa setelah pencairan/pengeluaran
  | 'RESERVED_LIQUIDITY' // dana yang sudah dialokasikan tapi belum keluar (mis. komitmen pencairan lain yang disetujui)
  | 'MAX_PINJAMAN_PER_ANGGOTA' // plafon pinjaman per anggota (0 = tanpa batas)
  | 'MAX_OUTSTANDING_PER_ANGGOTA' // total sisa pinjaman berjalan maksimum per anggota (0 = tanpa batas)
  | 'OVERDUE_LIMIT_HARI' // jumlah hari tunggakan yang membuat pengajuan baru ditolak (0 = tidak dicek)
  | 'MAX_TUNGGAKAN_AKTIF' // jumlah angsuran tertunggak yang membuat pengajuan baru ditolak (0 = tidak dicek)
  | 'MINIMUM_SALDO_SIMPANAN_PINJAMAN'; // syarat saldo simpanan minimum sebelum boleh mengajukan pinjaman (0 = tidak ada syarat)
  // Update pasca-Phase 18 (permintaan pengguna §17): PENYISIHAN_PERSEN_*
  // (dulu 4 key configurable admin) DIHAPUS dari sini — persentase
  // cadangan penyisihan piutang SEKARANG TETAP sesuai kategori
  // kolektibilitas (bukan lagi kebijakan lokal koperasi), lihat
  // `PERSENTASE_CADANGAN` di LoanImpairmentService.ts.

const POLICY_DEFAULTS: Record<PolicyKey, number> = {
  MINIMUM_CASH_RESERVE: 0,
  RESERVED_LIQUIDITY: 0,
  MAX_PINJAMAN_PER_ANGGOTA: 0,
  MAX_OUTSTANDING_PER_ANGGOTA: 0,
  OVERDUE_LIMIT_HARI: 0,
  MAX_TUNGGAKAN_AKTIF: 0,
  MINIMUM_SALDO_SIMPANAN_PINJAMAN: 0,
};

const CONFIG_KEY_PREFIX = 'policy.';

/** Ambil satu nilai kebijakan (numerik). Kembalikan default (lihat POLICY_DEFAULTS) kalau belum pernah diatur. */
export async function getPolicyValue(key: PolicyKey): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM app_config WHERE key = ?`,
    `${CONFIG_KEY_PREFIX}${key}`
  );
  if (!row) return POLICY_DEFAULTS[key];
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : POLICY_DEFAULTS[key];
}

/** Ambil semua kebijakan sekaligus — untuk layar Pengaturan Kebijakan. */
export async function getAllPolicies(): Promise<Record<PolicyKey, number>> {
  const keys = Object.keys(POLICY_DEFAULTS) as PolicyKey[];
  const entries = await Promise.all(keys.map(async (k) => [k, await getPolicyValue(k)] as const));
  return Object.fromEntries(entries) as Record<PolicyKey, number>;
}

/**
 * Set satu nilai kebijakan. Nilai harus >= 0 (kebijakan ini semuanya
 * berupa batas atas/reserve, tidak ada yang masuk akal negatif).
 * TIDAK memvalidasi siapa yang boleh mengubah — itu tanggung jawab
 * layar Pengaturan (requirePermission ke resource 'pengaturan',
 * konsisten dengan pola service lain) saat UI-nya dibangun.
 */
export async function setPolicyValue(key: PolicyKey, value: number): Promise<void> {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Nilai kebijakan "${key}" harus berupa angka >= 0.`);
  }
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    `${CONFIG_KEY_PREFIX}${key}`,
    String(value),
    now
  );
}

/**
 * PHASE 2 KOREKSI (permintaan pengguna) — boundary NON-ACCRUAL untuk
 * akrual jasa/bunga pinjaman (AkrualJasaPinjamanService). Ini adalah
 * APPLICATION ACCOUNTING POLICY milik koperasi, BUKAN aturan baku SAK
 * EP yang di-hardcode — SAK EP tidak secara eksplisit menetapkan
 * bahwa kolektibilitas "DIRAGUKAN" adalah titik non-accrual; itu
 * adalah judgment call implementasi Phase 2 awal, sekarang dijadikan
 * setting yang admin bisa ubah (lewat setNonAccrualMinKolektibilitas),
 * bukan fakta yang diklaim berasal langsung dari standar.
 *
 * DEFAULT tetap 'DIRAGUKAN' — SAMA seperti behavior Phase 2
 * sebelumnya (kolektibilitas DIRAGUKAN & MACET keduanya otomatis
 * masuk non-accrual lewat kolektibilitasMencapaiBoundary di bawah,
 * karena urutan keparahannya >= DIRAGUKAN) — supaya TIDAK ADA
 * perubahan behavior kecuali admin secara eksplisit mengubah setting
 * ini lewat layar Pengaturan (menyusul, sama seperti POLICY_DEFAULTS
 * numerik di atas — service ini menyiapkan mekanismenya, bukan
 * mengklaim keputusan bisnis final).
 */
export type NonAccrualPolicyKey = 'NON_ACCRUAL_MIN_KOLEKTIBILITAS';

const NON_ACCRUAL_MIN_KOLEKTIBILITAS_DEFAULT: Kolektibilitas = 'DIRAGUKAN';

// Penggolongan SOM Juklat 3/2025 hanya mengenal 4 kategori — kategori
// perbankan 'DALAM_PERHATIAN' sudah tidak ada lagi sejak
// LoanImpairmentService beralih ke SOM. Daftar ini mengikuti
// KOLEKTIBILITAS_URUT dari service itu, bukan daftar literal kedua,
// supaya penambahan/penghapusan kategori hanya perlu satu perubahan.
const KOLEKTIBILITAS_VALID: Kolektibilitas[] = KOLEKTIBILITAS_URUT;

/**
 * Urutan tingkat keparahan kolektibilitas — dipakai HANYA untuk
 * membandingkan terhadap boundary policy non-accrual ini. TIDAK
 * mengubah cara LoanImpairmentService mengklasifikasikan kolektibilitas
 * itu sendiri (file itu tidak disentuh sama sekali).
 */
const KOLEKTIBILITAS_URUTAN: Record<Kolektibilitas, number> = {
  LANCAR: 0,
  KURANG_LANCAR: 1,
  DIRAGUKAN: 2,
  MACET: 3,
};

/** true kalau `kolektibilitas` sudah mencapai/melewati `boundary` — dipakai policy non-accrual, bukan perbandingan SAK EP baku. */
export function kolektibilitasMencapaiBoundary(kolektibilitas: Kolektibilitas, boundary: Kolektibilitas): boolean {
  return KOLEKTIBILITAS_URUTAN[kolektibilitas] >= KOLEKTIBILITAS_URUTAN[boundary];
}

const CONFIG_KEY_NON_ACCRUAL_BOUNDARY = 'policy.NON_ACCRUAL_MIN_KOLEKTIBILITAS';

/** Ambil boundary non-accrual saat ini (default 'DIRAGUKAN' kalau belum pernah diatur admin — lihat catatan di atas). */
export async function getNonAccrualMinKolektibilitas(): Promise<Kolektibilitas> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM app_config WHERE key = ?`, CONFIG_KEY_NON_ACCRUAL_BOUNDARY);
  const nilai = row?.value as Kolektibilitas | undefined;
  return nilai && KOLEKTIBILITAS_VALID.includes(nilai) ? nilai : NON_ACCRUAL_MIN_KOLEKTIBILITAS_DEFAULT;
}

/**
 * Ubah boundary non-accrual — KEBIJAKAN KOPERASI yang dapat
 * dikonfigurasi, bukan aturan baku. TIDAK memvalidasi permission di
 * sini (tanggung jawab layar Pengaturan, pola sama dengan
 * setPolicyValue di atas — belum ada UI Phase 2, dipanggil langsung
 * lewat service/test untuk saat ini).
 */
export async function setNonAccrualMinKolektibilitas(value: Kolektibilitas): Promise<void> {
  if (!KOLEKTIBILITAS_VALID.includes(value)) {
    throw new Error(`Kolektibilitas "${value}" tidak valid.`);
  }
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    CONFIG_KEY_NON_ACCRUAL_BOUNDARY,
    value,
    now
  );
}

/**
 * SESI 2 §J — AMBANG NON-ACCRUAL BERBASIS HARI (kebijakan yang berlaku).
 *
 * Menggantikan boundary berbasis kolektibilitas di atas sebagai dasar
 * keputusan akrual. Alasan lengkapnya ada di
 * `src/accounting/NonAccrualPolicy.ts`; ringkasnya: titik non-accrual
 * sebelumnya adalah efek samping dari dua tabel ambang yang berbeda
 * (klasifikasi kolektibilitas + boundary kategori) sehingga jatuh di
 * 121 hari tanpa pernah tertulis sebagai kebijakan. Sekarang ambangnya
 * dinyatakan langsung dalam hari, default 90, dan tetap dapat diubah
 * admin karena ini kebijakan koperasi — bukan aturan baku standar.
 *
 * `getNonAccrualMinKolektibilitas`/`setNonAccrualMinKolektibilitas` di
 * atas SENGAJA dipertahankan (masih dipakai untuk pelaporan
 * kolektibilitas & pencadangan) tetapi TIDAK LAGI menentukan akrual.
 */
const CONFIG_KEY_NON_ACCRUAL_HARI = 'policy.NON_ACCRUAL_MIN_HARI_TUNGGAKAN';

/** Ambang hari tunggakan yang menghentikan akrual (default 90). */
export async function getNonAccrualMinHariTunggakan(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM app_config WHERE key = ?`,
    CONFIG_KEY_NON_ACCRUAL_HARI
  );
  const nilai = Number(row?.value);
  return Number.isFinite(nilai) && nilai >= 0 ? Math.floor(nilai) : HARI_MINIMUM_NON_ACCRUAL_DEFAULT;
}

/** Ubah ambang hari non-accrual. Nilai negatif ditolak (bukan didiamkan). */
export async function setNonAccrualMinHariTunggakan(hari: number): Promise<void> {
  if (!Number.isFinite(hari) || hari < 0) {
    throw new Error(`Ambang hari non-accrual "${hari}" tidak valid — harus bilangan >= 0.`);
  }
  const db = await getDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    CONFIG_KEY_NON_ACCRUAL_HARI,
    String(Math.floor(hari)),
    now
  );
}

/**
 *
 * BERBEDA TOTAL dari POLICY_DEFAULTS di atas (yang numerik, batas
 * transaksi seperti plafon/reserve) — bagian ini adalah TEKS
 * kebijakan akuntansi yang dipakai Catatan Atas Laporan Keuangan
 * (CALK, Prioritas 12/N). TIDAK ADA tabel/service baru — tetap di
 * file ini (instruksi eksplisit "Jangan menggantinya", diinterpretasi
 * sebagai "jangan ganti servicenya", bukan "jangan tambah isi baru").
 *
 * SETIAP kalimat di bawah HARUS benar-benar mencerminkan bagaimana
 * aplikasi ini mencatat transaksi sungguhan (§ instruksi: "Jangan
 * membuat teks kebijakan yang bertentangan dengan transaksi actual")
 * — bukan teks generik SAK yang dikarang. Ditulis berdasarkan audit
 * langsung ke source code tiap service terkait (dicantumkan di
 * `sumberKode` tiap butir untuk verifikasi/audit ulang di masa depan).
 */

import { NAMA_STANDAR_AKUNTANSI } from '@/config/defaultCOA';

export interface KebijakanAkuntansiItem {
  area: string;
  judul: string;
  narasi: string;
  /** File/fungsi tempat perilaku ini benar-benar diimplementasikan — untuk audit ulang, tidak ditampilkan ke user. */
  sumberKode: string;
}

/**
 * Narasi kebijakan akuntansi untuk CALK.
 *
 * Parameter `namaStandar` DIHAPUS (RC-S39 follow-up): ia dipakai untuk
 * mencetak nama standar apa adanya dari database, sehingga instalasi
 * lama menghasilkan "disusun berdasarkan SAK EMKM" di laporan aktif.
 * Kopku hanya punya satu standar, jadi tidak ada yang perlu diteruskan.
 */
export function getKebijakanAkuntansiNarasi(): KebijakanAkuntansiItem[] {
  return [
    {
      area: 'basis_akuntansi',
      judul: 'Dasar Penyusunan',
      narasi: `Laporan keuangan disusun berdasarkan ${NAMA_STANDAR_AKUNTANSI} dengan basis akrual — seluruh transaksi dicatat lewat jurnal berpasangan (double-entry) saat terjadi, bukan basis kas murni, kecuali dinyatakan lain secara eksplisit di bawah.`,
      sumberKode: 'AccountingEngine.createJournal',
    },
    {
      area: 'periode_pelaporan',
      judul: 'Periode Pelaporan',
      narasi: 'Tahun buku koperasi mengikuti tahun kalender (1 Januari s.d. 31 Desember).',
      sumberKode: 'AccountingEngine.getOrCreatePeriodeUntukTanggal',
    },
    {
      area: 'mata_uang',
      judul: 'Mata Uang Pelaporan',
      narasi: 'Seluruh nominal disajikan dalam Rupiah (Rp), dicatat sebagai bilangan bulat tanpa desimal.',
      sumberKode: 'schema.ts (komentar header: "semua nominal disimpan sebagai INTEGER")',
    },
    {
      area: 'kas_setara_kas',
      judul: 'Kas dan Setara Kas',
      narasi: 'Kas dan setara kas terdiri atas Kas Umum dan saldo rekening bank aktif milik koperasi.',
      sumberKode: 'FinancialReports.getArusKas (kasBankAccounts)',
    },
    {
      area: 'piutang',
      judul: 'Piutang Pinjaman Anggota',
      narasi: 'Piutang pinjaman anggota diakui sebesar nilai pokok yang dicairkan, dan diukur selanjutnya sebesar saldo pokok dan jasa yang belum tertagih dari jadwal angsuran.',
      sumberKode: 'PinjamanService, LoanImpairmentService.getKlasifikasiPinjamanAktif',
    },
    {
      area: 'penyisihan_piutang',
      judul: 'Penyisihan Piutang Tak Tertagih (Impairment)',
      narasi: 'Penyisihan piutang tak tertagih ditentukan berdasarkan kolektibilitas 5 kategori sesuai usia tunggakan angsuran (Lancar 0 hari: 0,5%; Dalam Perhatian 1-90 hari: 5%; Kurang Lancar 91-120 hari: 15%; Diragukan 121-180 hari: 50%; Macet >180 hari: 100%), dihitung dari saldo pokok outstanding. Penyisihan dicatat sebagai kontra-aset dan tidak mengurangi piutang bruto — pengurangan piutang bruto hanya terjadi melalui penghapusan (write-off) setelah RAT untuk piutang berkolektibilitas Macet.',
      sumberKode: 'LoanImpairmentService.ts',
    },
    {
      area: 'aset_tetap',
      judul: 'Aset Tetap',
      narasi: 'Aset tetap dicatat sebesar biaya perolehan dan disusutkan menggunakan metode garis lurus berdasarkan taksiran masa manfaat dan nilai residu. Aset tetap yang nilai wajarnya dapat diukur andal dapat diukur dengan model revaluasi (SAK EP Bab 17): nilai tercatat = nilai revaluasi dikurangi akumulasi penyusutan sesudahnya; kenaikan diakui di penghasilan komprehensif lain sebagai surplus revaluasi (ekuitas), kecuali sebesar pemulihan penurunan yang dahulu diakui di laba rugi; penurunan dibebankan ke surplus revaluasi aset yang sama lebih dahulu, sisanya ke laba rugi. Penyusutan sesudah revaluasi dihitung dari nilai revaluasi atas sisa masa manfaat.',
      sumberKode: 'AsetService.beliAset, PenyusutanService.hitungPenyusutanBulanan, PenyesuaianNilaiWajarService (REVALUASI_ASET_TETAP)',
    },
    {
      area: 'penyusutan',
      judul: 'Penyusutan Aset Tetap',
      narasi: 'Penyusutan dihitung bulanan dengan metode garis lurus: (nilai perolehan - nilai residu) / masa manfaat dalam bulan. Proses penyusutan dijalankan manual per periode oleh pengguna (aplikasi berjalan offline, bukan proses otomatis di latar belakang).',
      sumberKode: 'PenyusutanService.prosesPenyusutanAset',
    },
    {
      area: 'bunga_utang',
      judul: 'Akrual Bunga Utang Koperasi',
      narasi:
        'Bunga atas utang koperasi (bank/pihak lain) diakui secara akrual setiap bulan: Beban Bunga didebit dan Utang Bunga dikredit, tanpa melibatkan kas. ' +
        'Periodisasi memakai kebijakan BULAN PENUH (WHOLE_MONTH): tidak ada prorata harian. ' +
        'Sebuah bulan hanya diakru apabila utang sudah berlaku sejak tanggal 1 bulan tersebut — utang yang mulai di tengah bulan baru diakru mulai bulan berikutnya. ' +
        'Sebaliknya, pelunasan di tengah bulan tidak mengurangi akrual bulan berjalan; bulan berikutnya tidak lagi diakru. ' +
        'Tarif kontraktual dinyatakan per tahun atau per bulan (basis bunga); tarif tahunan dikonversi menjadi bulanan dengan pembagi 12. ' +
        'Dasar perhitungan untuk bunga FLAT adalah pokok kontraktual, sedangkan untuk bunga EFEKTIF adalah saldo pokok terutang pada awal periode. ' +
        'Utang yang basis bunganya belum ditentukan, atau yang jenis bunganya "Lainnya", tidak diakru otomatis dan dilaporkan sebagai pengecualian untuk ditinjau manual.',
      sumberKode: 'UtangBungaAccrualService.ts (KEBIJAKAN_PERIODE_AKRUAL_BUNGA_UTANG, rateBulanan, periodePertamaEligible)',
    },
    {
      area: 'aset_tak_berwujud',
      judul: 'Aset Tak Berwujud',
      narasi: 'Aset tak berwujud (mis. lisensi perangkat lunak, hak paten/merek) dicatat sebesar biaya perolehan, terpisah dari aset tetap berwujud.',
      sumberKode: 'AsetService.beliAset (jenisAset: TAK_BERWUJUD)',
    },
    {
      area: 'amortisasi',
      judul: 'Amortisasi Aset Tak Berwujud',
      narasi: 'Aset tak berwujud dengan umur manfaat terbatas diamortisasi dengan metode garis lurus, mekanisme dan formula yang sama dengan penyusutan aset tetap.',
      sumberKode: 'PenyusutanService.prosesPenyusutanAset (mapping AMORTISASI_ASET_TAK_BERWUJUD)',
    },
    {
      area: 'investasi',
      judul: 'Investasi',
      narasi: 'Investasi (penyertaan pada koperasi lain/usaha lain, penempatan pada bank umum berupa tabungan/giro/deposito, properti investasi, serta penyertaan pada unit usaha internal untuk histori lama) dicatat sebesar biaya perolehan (metode biaya). Properti investasi yang nilai wajarnya dapat diukur andal tanpa biaya atau upaya berlebihan diukur dengan model nilai wajar (SAK EP Bab 16): perubahan nilai wajar diakui di laba rugi (pendapatan/beban lain) dan properti tersebut tidak lagi disusutkan sejak penilaian nilai wajar pertama.',
      sumberKode: 'InvestasiService.catatInvestasi',
    },
    {
      area: 'impairment_investasi',
      judul: 'Penurunan Nilai Investasi',
      narasi: 'Karena investasi tidak memiliki harga pasar/kuotasi yang dapat diobservasi, penurunan nilai investasi TIDAK dihitung otomatis oleh sistem. Penurunan nilai dievaluasi berdasarkan indikator kualitatif (mis. kesulitan keuangan signifikan pada entitas tujuan investasi, penurunan berkelanjutan kinerja usaha, perubahan merugikan pada lingkungan usaha entitas tujuan) dan nilai kerugian ditentukan berdasarkan penilaian pengurus atas informasi terbaik yang tersedia, dicatat sebagai beban dan penyisihan (kontra-aset) pada saat evaluasi. Penurunan nilai investasi bersifat permanen — tidak dapat dipulihkan (reversal) melalui laporan hasil usaha, konsisten dengan tidak adanya bukti objektif yang andal untuk membuktikan pemulihan nilai instrumen ekuitas tanpa kuotasi pasar.',
      sumberKode: 'InvestasiImpairmentService.catatImpairmentInvestasi',
    },
    {
      area: 'utang',
      judul: 'Utang',
      // RC-S57 §1 — narasi lama ("diakui pada saat dibayar, atau diakrual
      // secara manual") bertentangan dengan area `bunga_utang`. Area ini kini
      // HANYA mengatur pokok & penyelesaian, dan merujuk `bunga_utang` untuk
      // pengakuan bunga, sehingga CALK tidak memuat dua perlakuan berbeda.
      narasi:
        'Utang bank/pihak lain/usaha diakui sebesar nilai pokok yang diterima/timbul dan berkurang sebesar pembayaran pokok. ' +
        'Pengakuan beban bunga mengikuti kebijakan Akrual Bunga Utang Koperasi: bunga diakui secara akrual otomatis setiap bulan (Beban Bunga / Utang Bunga). ' +
        'Pembayaran bunga yang sebelumnya sudah diakrual merupakan pelunasan Utang Bunga dan tidak diakui lagi sebagai beban. ' +
        'Bagian pembayaran bunga yang belum pernah diakrual diakui sebagai beban pada saat pembayaran, sebesar transaksi aktual. ' +
        'Akrual atau penyesuaian manual hanya dipakai sebagai mekanisme pengecualian dan pengendalian (mis. koreksi setelah reversal), bukan cara pencatatan rutin.',
      sumberKode: 'UtangService.bayarUtang (bagiPembayaranBunga), UtangBungaAccrualService (akrual otomatis), UtangService.penyesuaianManualBungaUtang — hanya pengecualian',
    },
    {
      area: 'simpanan_anggota',
      judul: 'Simpanan Anggota',
      narasi: 'Simpanan Pokok dan Simpanan Wajib diklasifikasikan sebagai bagian Ekuitas (setoran modal anggota yang tidak dapat ditarik selama keanggotaan berlangsung). Simpanan Sukarela diklasifikasikan sebagai Liabilitas (dapat ditarik sewaktu-waktu oleh anggota).',
      sumberKode: 'defaultCOA.ts (kategori akun 3-1000/3-1100 EKUITAS, 2-1200 LIABILITAS)',
    },
    {
      area: 'ekuitas',
      judul: 'Ekuitas',
      narasi: 'Ekuitas terdiri atas Simpanan Pokok, Simpanan Wajib, Cadangan, Ekuitas Lainnya, dan SHU/Laba Tahun Berjalan yang belum dialokasikan. SHU tahun buku yang telah dibagikan dialokasikan ke Cadangan, Ekuitas Lainnya, dan Simpanan Sukarela anggota sesuai konfigurasi persentase yang ditetapkan.',
      sumberKode: 'FinancialReports.getPosisiKeuangan, ShuService.bagikanSHU',
    },
    {
      area: 'pendapatan',
      judul: 'Pengakuan Pendapatan',
      narasi: 'Pendapatan jasa pinjaman diakui pada saat angsuran diterima dari anggota. Pendapatan yang diterima di muka diakui bertahap sebagai pendapatan sesuai jangka waktu manfaatnya.',
      sumberKode: 'PinjamanService (ANGSURAN_JASA), PendapatanDimukaService',
    },
    {
      area: 'beban',
      judul: 'Pengakuan Beban',
      narasi: 'Beban pada umumnya diakui pada saat terjadi/dibayar. Beban penyusutan, amortisasi, penyisihan piutang, imbalan kerja, dan bunga utang dapat diakui secara akrual sebelum pembayaran kas, sesuai penjelasan masing-masing area di atas.',
      sumberKode: 'BebanFormScreen, PenyusutanService, LoanImpairmentService, ImbalanKerjaService, UtangService',
    },
    {
      area: 'shu',
      judul: 'Sisa Hasil Usaha (SHU)',
      narasi: 'SHU dihitung dari hasil usaha (pendapatan dikurangi beban) periode berjalan, dan didistribusikan ke Cadangan, Jasa Modal, Jasa Usaha, Pendidikan, Sosial, Pengurus, Pengawas, Karyawan, Pembangunan Daerah Kerja, dan Ekuitas Lainnya sesuai persentase yang ditetapkan koperasi, setelah disahkan dalam Rapat Anggota Tahunan (RAT).',
      sumberKode: 'ShuCalculator.hitungRingkasanSHU, ShuService.bagikanSHU',
    },
    {
      area: 'imbalan_kerja',
      judul: 'Imbalan Kerja',
      narasi: 'Imbalan kerja (mis. THR, bonus) yang dibayar tunai langsung diakui sebagai beban pada saat dibayar. Apabila imbalan kerja telah menjadi kewajiban pada periode berjalan namun belum dibayar, kewajiban tersebut diakrual secara manual. Koperasi belum menerapkan perhitungan aktuaria untuk imbalan pasca-kerja.',
      sumberKode: 'ImbalanKerjaService.akruiImbalanKerja',
    },
    {
      area: 'biaya_pinjaman',
      judul: 'Biaya Pinjaman',
      // RC-S57 §1 — kontradiksi kedua yang sama ("diakrual manual") ditemukan di
      // area ini dan diselaraskan dengan `bunga_utang`.
      narasi:
        'Biaya pinjaman (bunga atas utang bank/pihak lain) diakui sebagai beban pada periode terjadinya melalui akrual bunga otomatis bulanan, sebagaimana dijelaskan pada kebijakan Akrual Bunga Utang Koperasi. ' +
        'Koperasi tidak mengkapitalisasi biaya pinjaman ke nilai perolehan aset.',
      sumberKode: 'UtangBungaAccrualService (akrual otomatis), UtangService.bayarUtang (penyelesaian)',
    },
  ];
}

import { Rupiah } from '@/utils/money';

/**
 * ExcelDataAwalParser — PEMBACA & PEMERIKSA berkas Excel "Import Data
 * Awal" (anggota, simpanan, pinjaman, simpanan berjangka).
 *
 * ============================================================
 * BERKAS INI MURNI FUNGSI — TANPA DATABASE, TANPA MODUL NATIVE
 * ============================================================
 * SENGAJA tidak ada satu pun import ke `@/database/db`, `expo-sqlite`,
 * `expo-file-system`, maupun `xlsx`. Yang masuk ke sini sudah berupa
 * ARRAY BARIS (`unknown[][]`) hasil pembacaan sheet, sehingga:
 *   - seluruh aturan pembacaan & validasi bisa diuji langsung dengan
 *     angka tanpa menyiapkan berkas Excel sungguhan;
 *   - `ImportDataAwalService` yang memegang berkas & database tidak
 *     perlu ikut diuji untuk membuktikan parsing-nya benar.
 *
 * ============================================================
 * PRINSIP: MUDAH DIISI DI EXCEL, TETAP TERBACA APLIKASI
 * ============================================================
 * Pengurus koperasi mengisi Excel dengan gaya masing-masing. Daripada
 * menolak berkasnya, pembaca ini bersikap PERMISIF pada BENTUK dan
 * KETAT pada MAKNA:
 *
 *   - NAMA KOLOM tidak harus sama persis. "Nama Lengkap", "nama_lengkap",
 *     "NAMA  LENGKAP", dan "Nama Lengkap *" dianggap sama (lihat
 *     `normalkanHeader`). Urutan kolom juga bebas — kolom dicari
 *     berdasarkan namanya, bukan posisinya.
 *   - BARIS HEADER tidak harus baris pertama. Judul/keterangan di atas
 *     tabel dilewati (lihat `cariBarisHeader`).
 *   - ANGKA boleh ditulis "1.000.000", "1,000,000", "Rp 1.500.000",
 *     atau sebagai angka Excel biasa (lihat `parseRupiah`).
 *   - TANGGAL boleh berupa tanggal Excel asli (angka serial),
 *     "2026-01-31", "31/01/2026", atau "31-01-2026" (lihat `parseTanggal`).
 *   - BARIS KOSONG diabaikan, bukan dianggap galat.
 *
 * Yang TIDAK dikompromikan: kolom wajib harus ada isinya, nominal tidak
 * boleh negatif, tanggal harus tanggal yang benar-benar ada, dan pilihan
 * seperti Sumber Dana harus salah satu nilai yang dikenal. Semua
 * pelanggaran dilaporkan PER BARIS dengan nomor baris Excel-nya supaya
 * pengguna bisa langsung memperbaiki di berkasnya.
 *
 * ============================================================
 * KENAPA ADA "KODE ANGGOTA" DI SETIAP SHEET
 * ============================================================
 * Nomor anggota dibuat OTOMATIS oleh aplikasi (`createAnggota` →
 * `generateNomorAnggotaBerikutnya`), jadi pengguna TIDAK bisa
 * menentukannya dari Excel. Karena itu sheet Anggota memakai kolom
 * "Kode Anggota" yang dibuat sendiri oleh pengguna (mis. `A1`, `A2`,
 * atau nomor anggota lama di buku manual), dan sheet Simpanan/Pinjaman/
 * Berjangka menunjuk anggotanya lewat kode yang sama. Aplikasi yang
 * memetakan kode itu ke anggota yang baru dibuat.
 */

// ===========================================================================
// JENIS SHEET
// ===========================================================================

export type JenisSheetImport = 'ANGGOTA' | 'SIMPANAN' | 'PINJAMAN' | 'BERJANGKA' | 'ASET' | 'JASA';

export const JUDUL_SHEET: Record<JenisSheetImport, string> = {
  ANGGOTA: '1. Anggota',
  SIMPANAN: '2. Simpanan',
  PINJAMAN: '3. Pinjaman',
  BERJANGKA: '4. Simpanan Berjangka',
  ASET: '5. Aset Tetap',
  JASA: '6. Jasa Dibayar',
};

export const LABEL_SHEET: Record<JenisSheetImport, string> = {
  ANGGOTA: 'Anggota',
  SIMPANAN: 'Simpanan Pokok / Wajib / Sukarela',
  PINJAMAN: 'Pinjaman',
  BERJANGKA: 'Simpanan Berjangka',
  ASET: 'Aset Tetap',
  JASA: 'Jasa Dibayar s.d. Cut-off',
};

/**
 * URUTAN PEMROSESAN — BUKAN sekadar urutan tampilan.
 *
 * Simpanan & berjangka MENAMBAH kas koperasi (Debit Kas), sedangkan
 * pencairan pinjaman MENGURANGI kas dan ditolak `checkLiquiditasPencairan`
 * bila kas/bank tidak cukup. Jadi simpanan HARUS diproses sebelum
 * pinjaman — persis seperti keadaan sungguhannya: simpanan anggotalah
 * yang membiayai pinjaman. Anggota jelas paling awal karena tiga sheet
 * lain menunjuk kepadanya.
 */
export const URUTAN_PROSES: JenisSheetImport[] = ['ANGGOTA', 'SIMPANAN', 'BERJANGKA', 'PINJAMAN', 'ASET', 'JASA'];

/**
 * Cocokkan NAMA SHEET di workbook ke jenis sheet aplikasi.
 *
 * DIPINDAH KE SINI RC-S108. Sebelumnya fungsi ini tinggal di
 * `ImportDataAwalService`, yang mengimpor expo-file-system/
 * document-picker/sharing sehingga tidak dapat dimuat ts-jest — dan
 * karena itu tidak pernah ada test yang menjaganya. Akibatnya nyata:
 * ketika sheet "5. Aset Tetap" ditambahkan (RC-S107), daftar di sini
 * TIDAK ikut diperbarui, sehingga sheet aset pada berkas sungguhan
 * tidak pernah dikenali sama sekali. Test parser lolos karena
 * memanggil `parseBerkasDataAwal({ ASET: ... })` langsung, melewati
 * pencocokan nama ini.
 *
 * Sekarang fungsinya murni dan ada test yang memeriksa SETIAP jenis
 * sheet dapat ditemukan dari judul resminya, sehingga jenis baru tidak
 * bisa lagi lolos tanpa dikenali.
 *
 * Pencocokan bersifat "mengandung" pada nama yang dinormalkan,
 * sehingga "1. Anggota", "Anggota", maupun "Data Anggota" sama-sama
 * dikenali. Sheet "Petunjuk" tidak cocok ke mana pun dan diabaikan.
 *
 * URUTAN PEMERIKSAAN PENTING: BERJANGKA diperiksa sebelum SIMPANAN
 * karena "Simpanan Berjangka" juga mengandung kata "simpanan".
 */
export function cocokkanJenisSheet(namaSheet: string): JenisSheetImport | null {
  const n = normalkanHeader(namaSheet);
  // RC-S133.4.3 — "6. Jasa Dibayar" diperiksa PALING AWAL: nama bebas
  // pengguna seperti "Jasa Pinjaman Anggota" juga mengandung kata
  // "pinjaman"/"anggota".
  if (n.includes('jasa')) return 'JASA';
  if (n.includes('berjangka')) return 'BERJANGKA';
  if (n.includes('anggota')) return 'ANGGOTA';
  if (n.includes('simpanan')) return 'SIMPANAN';
  if (n.includes('pinjaman')) return 'PINJAMAN';
  if (n.includes('aset')) return 'ASET';
  return null;
}

/**
 * RC-S133.4.6 — SHEET "7. Saldo Awal Akun" (neraca saldo per cut-off).
 *
 * SENGAJA TIDAK masuk `JenisSheetImport` / `URUTAN_PROSES`: sheet ini tidak
 * menunjuk anggota dan tidak punya buku pembantu — ia mengisi Saldo Awal
 * Akun (Kas/Bank, pendapatan & beban tahun berjalan, cadangan, utang, ...)
 * yang sebelumnya harus diketik satu per satu di menu Saldo Awal setelah
 * import. Uji setara RC-S133.4.5 menunjukkan langkah manual itulah tempat
 * selisih paling mudah terjadi.
 */
export const JUDUL_SHEET_SALDO_AWAL_AKUN = '7. Saldo Awal Akun';
export const LABEL_SHEET_SALDO_AWAL_AKUN = 'Saldo Awal Akun (Kas, pendapatan, beban, dll.)';

/** Nama sheet → sheet 7? Diperiksa SEBELUM `cocokkanJenisSheet` oleh pembaca workbook. */
export function cocokkanSheetSaldoAwalAkun(namaSheet: string): boolean {
  const n = normalkanHeader(namaSheet);
  if (n.includes('neracasaldo')) return true;
  return n.includes('saldoawal') && !n.includes('simpanan') && !n.includes('pinjaman') && !n.includes('anggota');
}

// ===========================================================================
// UTILITAS BENTUK: HEADER, ANGKA, TANGGAL
// ===========================================================================

/**
 * Nama kolom disederhanakan supaya perbedaan penulisan tidak membuat
 * kolom "tidak ditemukan": huruf kecil, tanda bintang/kurung wajib
 * dibuang, dan SELURUH karakter non-alfanumerik (spasi, garis bawah,
 * titik, garis miring) dihapus. "Tanggal Bergabung *" -> "tanggalbergabung".
 */
export function normalkanHeader(nilai: unknown): string {
  return String(nilai ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Angka Rupiah dari sel Excel. Menerima angka asli maupun teks bergaya
 * Indonesia ("Rp 1.500.000") atau Inggris ("1,500,000.00").
 *
 * PEMISAH RIBUAN vs DESIMAL dibedakan dari POSISI, bukan dari jenis
 * tandanya: tanda terakhir yang diikuti TEPAT 1-2 digit di akhir teks
 * dianggap desimal, selain itu dianggap pemisah ribuan. Dengan begitu
 * "1.500.000" terbaca 1.500.000 (bukan 1,5) dan "1.500,50" terbaca
 * 1500,5. Hasil akhir DIBULATKAN ke rupiah penuh karena seluruh nominal
 * di aplikasi ini bilangan bulat rupiah.
 *
 * Mengembalikan `null` bila sel kosong atau bukan angka sama sekali —
 * pemanggil yang memutuskan apakah itu galat atau boleh dianggap 0.
 */
export function parseRupiah(nilai: unknown): number | null {
  if (nilai === null || nilai === undefined) return null;
  if (typeof nilai === 'number') return Number.isFinite(nilai) ? Math.round(nilai) : null;

  let teks = String(nilai).trim();
  if (teks === '') return null;

  const negatif = /^\(.*\)$/.test(teks) || teks.startsWith('-');
  teks = teks.replace(/^\(|\)$/g, '').replace(/rp/gi, '').replace(/\s/g, '').replace(/^-/, '');
  if (teks === '') return null;
  if (!/^[\d.,]+$/.test(teks)) return null;

  const desimal = /[.,](\d{1,2})$/.exec(teks);
  let bulat: string;
  let pecahan = '';
  if (desimal && /[.,]/.test(teks.slice(0, teks.length - desimal[0].length))) {
    // Ada tanda lain sebelum tanda terakhir -> tanda terakhir = desimal.
    bulat = teks.slice(0, teks.length - desimal[0].length);
    pecahan = desimal[1];
  } else if (desimal && desimal[1].length === 2 && /,/.test(desimal[0])) {
    // "1500,50" — koma dengan 2 digit dianggap desimal gaya Indonesia.
    bulat = teks.slice(0, teks.length - desimal[0].length);
    pecahan = desimal[1];
  } else {
    bulat = teks;
  }

  const angka = Number(`${bulat.replace(/[.,]/g, '')}.${pecahan || '0'}`);
  if (!Number.isFinite(angka)) return null;
  return Math.round(negatif ? -angka : angka);
}

/**
 * RC-S133.6 (AUDIT B-3) — pembaca KOLOM HITUNGAN (Tenor, Angsuran Sudah
 * Dibayar/Tersisa, Tenor Bulan, Masa Manfaat Bulan).
 *
 * Dulu kolom-kolom ini dibaca lewat `parseRupiah`, yang (a) membulatkan
 * lebih dulu sehingga pemeriksaan `Number.isInteger` sesudahnya tidak
 * pernah gagal (2,5 → 3) dan (b) menganggap koma dengan satu digit sebagai
 * pemisah ribuan ("12,5" → 125). Untuk bilangan hitungan, pemisah ribuan
 * tidak masuk akal, jadi aturannya ketat:
 *   - angka sel apa adanya (tanpa pembulatan);
 *   - teks "12" → 12; "12,5"/"12.5" → 12,5 (pecahan → ditolak pemanggil);
 *   - teks lain (mis. "1.000", "12 bulan") → NaN (ditolak pemanggil).
 * `null` hanya untuk sel kosong — pemanggil memakainya untuk "wajib diisi".
 */
export function parseBilanganHitungan(nilai: unknown): number | null {
  if (nilai === null || nilai === undefined) return null;
  if (typeof nilai === 'number') return Number.isFinite(nilai) ? nilai : Number.NaN;
  const teks = String(nilai).trim().replace(/\s/g, '');
  if (teks === '') return null;
  if (/^-?\d+$/.test(teks)) return Number(teks);
  if (/^-?\d+[.,]\d{1,2}$/.test(teks)) return Number(teks.replace(',', '.'));
  return Number.NaN;
}

/**
 * RC-S133.6 (AUDIT B-2) — SEL BERFORMAT PERSEN.
 *
 * Bila pengguna mengetik "1,5%" di Excel, Excel MENYIMPAN angka 0,015
 * dengan format persen. Pembacaan `raw: true` lalu menyerahkan 0,015 ke
 * parser, yang membaca kolom "Jasa Persen"/"Bunga Persen Per Tahun"
 * sebagai angka persen apa adanya → 0,015% (100× lebih kecil), diam-diam.
 *
 * Fungsi ini (murni, dipanggil sebelum `sheet_to_json`) mengganti setiap
 * sel ANGKA yang tampil sebagai persen (teks tampilan `w` diakhiri "%",
 * atau format `z` memuat "%") dengan teks persennya, mis. "1.5%". Parser
 * persen yang sudah ada membaca teks itu sebagai 1,5 — sama dengan bila
 * pengguna mengetik "1,5" di sel berformat biasa. Sel lain tidak disentuh;
 * objek sheet asli tidak diubah (salinan dangkal hanya bila ada perubahan).
 */
export function normalkanSelPersen<T extends object>(sheet: T): T {
  let salinan: Record<string, unknown> | null = null;
  const asal = sheet as unknown as Record<string, unknown>;
  for (const alamat of Object.keys(asal)) {
    if (alamat.startsWith('!')) continue;
    const sel = asal[alamat] as { t?: unknown; v?: unknown; w?: unknown; z?: unknown } | null | undefined;
    if (!sel || typeof sel !== 'object' || sel.t !== 'n' || typeof sel.v !== 'number' || !Number.isFinite(sel.v)) continue;
    const tampil = typeof sel.w === 'string' ? sel.w.trim() : '';
    const format = typeof sel.z === 'string' ? sel.z : '';
    if (!tampil.endsWith('%') && !format.includes('%')) continue;
    const persen = Number((sel.v * 100).toPrecision(12));
    if (!salinan) salinan = { ...asal };
    salinan[alamat] = { t: 's', v: `${persen}%`, w: `${persen}%` };
  }
  return (salinan ?? sheet) as T;
}

function duaDigit(n: number): string {
  return String(n).padStart(2, '0');
}

function tanggalValid(tahun: number, bulan: number, hari: number): boolean {
  if (bulan < 1 || bulan > 12 || hari < 1 || hari > 31) return false;
  const d = new Date(tahun, bulan - 1, hari);
  return d.getFullYear() === tahun && d.getMonth() === bulan - 1 && d.getDate() === hari;
}

/**
 * Tanggal 'YYYY-MM-DD' dari sel Excel, atau `null` bila kosong/tidak sah.
 *
 * Bentuk yang diterima:
 *   - ANGKA SERIAL EXCEL (yang paling sering terjadi — sel bertipe
 *     tanggal terbaca sebagai angka, mis. 45000). Dihitung dari epoch
 *     Excel 1899-12-30 memakai UTC supaya tidak bergeser sehari di zona
 *     waktu mana pun.
 *   - `Date` (bila pembaca sheet sudah mengubahnya sendiri).
 *   - Teks 'YYYY-MM-DD', 'DD/MM/YYYY', 'DD-MM-YYYY'.
 *
 * Tanggal yang tidak benar-benar ada (mis. 31/02/2026) ditolak — bukan
 * digeser diam-diam ke 3 Maret seperti yang dilakukan `new Date()`.
 *
 * BATAS KEWAJARAN, HANYA UNTUK ANGKA SERIAL (lihat `TAHUN_SERIAL_MIN`/
 * `TAHUN_SERIAL_MAKS`): angka di kolom tanggal itu MENDUA — bisa tanggal
 * Excel sungguhan, bisa pula salah ketik. Tanpa batas, `12` terbaca
 * 1900-01-12 dan `2026` (pengguna hanya mengetik tahunnya) terbaca
 * 1905-07-18 — keduanya tersimpan diam-diam sebagai tanggal koperasi
 * yang mustahil. Serial di luar rentang wajar karena itu DITOLAK supaya
 * ketahuan saat pratinjau. Batas ini SENGAJA tidak diterapkan pada
 * tanggal berbentuk TEKS: '1948-05-01' tidak mendua — pengguna jelas
 * memaksudkan tanggal — jadi tanggal lahir tua tetap bisa diisi.
 */

/** Batas bawah/atas tahun yang dianggap wajar untuk angka serial Excel. */
export const TAHUN_SERIAL_MIN = 1950;
export const TAHUN_SERIAL_MAKS = 2100;
export function parseTanggal(nilai: unknown): string | null {
  if (nilai === null || nilai === undefined) return null;

  if (nilai instanceof Date) {
    if (Number.isNaN(nilai.getTime())) return null;
    return `${nilai.getFullYear()}-${duaDigit(nilai.getMonth() + 1)}-${duaDigit(nilai.getDate())}`;
  }

  if (typeof nilai === 'number') {
    if (!Number.isFinite(nilai) || nilai <= 0) return null;
    // Epoch Excel: hari ke-1 = 1900-01-01, dengan bug tahun kabisat 1900
    // yang membuat 1899-12-30 sebagai titik nol yang benar.
    const ms = Math.round(nilai) * 86400000 + Date.UTC(1899, 11, 30);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    const tahun = d.getUTCFullYear();
    if (tahun < TAHUN_SERIAL_MIN || tahun > TAHUN_SERIAL_MAKS) return null;
    return `${tahun}-${duaDigit(d.getUTCMonth() + 1)}-${duaDigit(d.getUTCDate())}`;
  }

  const teks = String(nilai).trim();
  if (teks === '') return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(teks);
  if (iso) {
    const [, y, m, d] = iso;
    if (!tanggalValid(+y, +m, +d)) return null;
    return `${y}-${duaDigit(+m)}-${duaDigit(+d)}`;
  }

  const lokal = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(teks);
  if (lokal) {
    const [, d, m, y] = lokal;
    if (!tanggalValid(+y, +m, +d)) return null;
    return `${y}-${duaDigit(+m)}-${duaDigit(+d)}`;
  }

  return null;
}

// ===========================================================================
// PEMBACAAN TABEL
// ===========================================================================

/** Sel dianggap kosong bila null/undefined/teks kosong. */
function selKosong(nilai: unknown): boolean {
  return nilai === null || nilai === undefined || String(nilai).trim() === '';
}

function barisKosong(baris: unknown[]): boolean {
  return !baris || baris.every(selKosong);
}

function teks(nilai: unknown): string {
  return String(nilai ?? '').trim();
}

/**
 * Cari baris header: baris pertama yang memuat SELURUH kolom wajib.
 * Judul & catatan di atas tabel otomatis terlewati. Mengembalikan -1
 * bila tidak ada baris yang cocok.
 */
export function cariBarisHeader(baris: unknown[][], kolomWajib: string[]): number {
  const batas = Math.min(baris.length, 30);
  for (let i = 0; i < batas; i++) {
    const header = (baris[i] ?? []).map(normalkanHeader);
    if (kolomWajib.every((k) => header.includes(k))) return i;
  }
  return -1;
}

/** Peta nama kolom ternormalisasi -> indeks kolom. Kolom duplikat: yang PERTAMA menang. */
function petaKolom(barisHeader: unknown[]): Map<string, number> {
  const peta = new Map<string, number>();
  (barisHeader ?? []).forEach((sel, i) => {
    const nama = normalkanHeader(sel);
    if (nama && !peta.has(nama)) peta.set(nama, i);
  });
  return peta;
}

// ===========================================================================
// HASIL
// ===========================================================================

export interface GalatBaris {
  /** Nomor baris sebagaimana terlihat di Excel (1-based), supaya pengguna bisa langsung menuju ke sana. */
  baris: number;
  pesan: string;
}

export interface BarisAnggota {
  baris: number;
  kode: string;
  namaLengkap: string;
  nik: string | null;
  /**
   * Nilai DOMAIN APLIKASI ('LAKI_LAKI'/'PEREMPUAN'), bukan huruf yang
   * diketik pengguna. Kolom `anggota.jenis_kelamin` punya CHECK
   * constraint pada kedua nilai itu, jadi meneruskan 'L'/'P' apa adanya
   * membuat SELURUH baris anggota ditolak database.
   */
  jenisKelamin: 'LAKI_LAKI' | 'PEREMPUAN' | null;
  tempatLahir: string | null;
  tanggalLahir: string | null;
  alamat: string | null;
  nomorHp: string | null;
  pekerjaan: string | null;
  tanggalBergabung: string;
}

export interface BarisSimpanan {
  baris: number;
  kode: string;
  tanggal: string;
  pokok: Rupiah;
  wajib: Rupiah;
  sukarela: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  /** RC-S133.6.1 — nomor rekening tujuan (kolom opsional "Rekening Bank"); hanya untuk Sumber Dana BANK. */
  rekeningBank?: string;
}

export interface BarisPinjaman {
  baris: number;
  kode: string;
  tanggal: string;
  jumlahPinjaman: Rupiah;
  tenor: number;
  satuanTenor: 'HARI' | 'MINGGU' | 'BULAN';
  metodeJasa: 'FLAT' | 'MENURUN' | 'EFEKTIF';
  /**
   * Persen jasa PER PERIODE angsuran — satu-satunya satuan yang dipakai
   * mesin pinjaman. Bila berkas mengisi "Satuan Jasa" = TAHUN, angka ini
   * SUDAH dikonversi (persen tahunan / 12, hanya untuk tenor BULAN).
   */
  persentaseJasa: number;
  /**
   * RC-S133.4.8 — satuan angka "Jasa Persen" SEBAGAIMANA DIISI di berkas.
   * Kosong/undefined = PERIODE (perilaku lama, berkas lama tetap sama).
   */
  satuanJasa?: 'PERIODE' | 'TAHUN';
  /** RC-S133.4.8 — angka "Jasa Persen" apa adanya dari berkas (sebelum konversi). */
  persentaseJasaDiisi?: number;
  sumberDana: 'KAS' | 'BANK';
  /** RC-S133.6.1 — nomor rekening sumber pencairan (kolom opsional "Rekening Bank"). */
  rekeningBank?: string;
  /** Berapa periode angsuran yang SUDAH dibayar sebelum data ini diimpor. */
  angsuranSudahDibayar: number;
  /**
   * RC-S102 — KOLOM MIGRASI SALDO AWAL PINJAMAN BERJALAN.
   *
   * Empat kolom di bawah hanya dipakai bila pinjaman berakad SEBELUM
   * tanggal cut-off pembukuan, yaitu pinjaman lama yang masih berjalan.
   * Untuk pinjaman itu pokoknya TIDAK dicairkan ulang lewat kas — lihat
   * `MigrasiPinjamanPlan` untuk alasannya. Semua opsional supaya berkas
   * lama (tanpa kolom ini) tetap terbaca apa adanya.
   */
  nomorPinjamanLama?: string;
  /** SISA POKOK pada tanggal cut-off — angka otoritatif untuk migrasi. */
  sisaPokok?: Rupiah;
  /** Banyaknya angsuran yang masih tersisa pada cut-off. */
  angsuranTersisa?: number;
  tunggakanPokok?: Rupiah;
  piutangJasa?: Rupiah;
}

/**
 * RC-S107 — satu aset tetap lama. Akumulasi penyusutan SENGAJA tidak
 * ada di sini: ia dihitung dari keempat kolom di bawah memakai rumus
 * yang sama dengan mesin penyusutan, supaya buku pembantu dan buku
 * besar tidak mungkin berselisih (lihat MigrasiAsetPlan).
 */
export interface BarisAset {
  baris: number;
  nomorAset: string;
  namaAset: string;
  tanggalPerolehan: string;
  nilaiPerolehan: Rupiah;
  masaManfaatBulan: number;
  nilaiResidu: Rupiah;
  kelompokAset?: string;
  subKelompokAset?: string;
}

export interface BarisBerjangka {
  baris: number;
  kode: string;
  tanggal: string;
  nominal: Rupiah;
  tenorBulan: 3 | 6 | 12;
  sukuBungaPerTahun: number | null;
  sumberDana: 'KAS' | 'BANK';
  /** RC-S133.6.1 — nomor rekening tujuan (kolom opsional "Rekening Bank"). */
  rekeningBank?: string;
}

/**
 * RC-S133.4.3 — sheet "6. Jasa Dibayar": jasa pinjaman yang SUDAH DIBAYAR
 * anggota pada tahun buku berjalan sampai cut-off. Dasar pembagian SHU
 * jasa usaha untuk periode sebelum koperasi memakai aplikasi. Tidak
 * dijurnal (lihat PartisipasiDataAwalService).
 */
export interface BarisJasa {
  baris: number;
  /** Kode Anggota di sheet 1 berkas ini, ATAU nomor anggota yang sudah ada di aplikasi (mis. A00001). */
  kode: string;
  /** Nama anggota — hanya untuk dibaca manusia & ditampilkan di log, tidak dicocokkan. */
  nama: string | null;
  jasa: number;
}

/** RC-S133.4.6 — satu baris sheet "7. Saldo Awal Akun". */
export interface BarisSaldoAwalAkun {
  baris: number;
  /** Kode akun COA aplikasi, mis. 1-1000. Dicocokkan ke Daftar Akun saat eksekusi. */
  kodeAkun: string;
  /** Hanya untuk dibaca manusia; tidak dicocokkan. */
  namaAkun: string | null;
  /** Saldo pada tanggal cut-off, menurut saldo normal akunnya (selalu > 0). */
  saldo: Rupiah;
  /** Bagian saldo awal pendapatan/beban yang SUDAH tunai; null = pakai bawaan aplikasi. */
  bagianTunai: Rupiah | null;
}

export interface HasilParseSheet<T> {
  /** false bila sheet tidak ada / baris header tidak ditemukan — `galatSheet` menjelaskan sebabnya. */
  terbaca: boolean;
  galatSheet: string | null;
  baris: T[];
  galat: GalatBaris[];
}

export interface HasilParseBerkas {
  anggota: HasilParseSheet<BarisAnggota>;
  simpanan: HasilParseSheet<BarisSimpanan>;
  pinjaman: HasilParseSheet<BarisPinjaman>;
  berjangka: HasilParseSheet<BarisBerjangka>;
  /**
   * RC-S107 — ASET TETAP LAMA. Tidak menunjuk anggota, jadi TIDAK ikut
   * pemeriksaan silang Kode Anggota di bawah.
   */
  aset: HasilParseSheet<BarisAset>;
  /**
   * RC-S133.4.3 — JASA DIBAYAR SEBELUM CUT-OFF. Kode boleh menunjuk
   * anggota yang SUDAH ADA di aplikasi (nomor anggota), jadi TIDAK ikut
   * pemeriksaan silang terhadap sheet Anggota; dicocokkan saat eksekusi.
   */
  jasa: HasilParseSheet<BarisJasa>;
  /**
   * RC-S133.4.6 — sheet "7. Saldo Awal Akun". Opsional supaya pemanggil
   * lama yang menyusun `HasilParseBerkas` sendiri tetap sah.
   */
  saldoAwalAkun?: HasilParseSheet<BarisSaldoAwalAkun>;
}

/**
 * Ambil hasil parse satu jenis sheet dari `HasilParseBerkas`.
 *
 * DIBUAT RC-S108. Layar pratinjau dulu memilihnya dengan rantai
 * ternary yang BERAKHIR pada `pinjaman` sebagai fallback. Ketika jenis
 * sheet baru (ASET) ditambahkan, tab "Aset Tetap" diam-diam
 * menampilkan baris PINJAMAN — persis keluhan pengguna. Pemetaan
 * eksplisit di sini membuat jenis baru mustahil jatuh ke sheet lain:
 * TypeScript menolak `Record` yang tidak lengkap.
 */
export function ambilHasilSheet(
  hasil: HasilParseBerkas,
  jenis: JenisSheetImport
): HasilParseSheet<{ baris: number }> {
  const peta: Record<JenisSheetImport, HasilParseSheet<{ baris: number }>> = {
    ANGGOTA: hasil.anggota,
    SIMPANAN: hasil.simpanan,
    PINJAMAN: hasil.pinjaman,
    BERJANGKA: hasil.berjangka,
    ASET: hasil.aset,
    JASA: hasil.jasa,
  };
  return peta[jenis];
}

/** Seluruh sheet dalam satu berkas, sudah dibaca menjadi array baris. */
export type SheetMentah = Partial<Record<JenisSheetImport, unknown[][]>> & {
  /** RC-S133.4.6 — sheet "7. Saldo Awal Akun". */
  SALDO_AWAL_AKUN?: unknown[][];
};

// ===========================================================================
// PEMBACA PER SHEET
// ===========================================================================

const SUMBER_DANA_DEFAULT: 'KAS' = 'KAS';

function bacaSumberDana(nilai: unknown): 'KAS' | 'BANK' | 'GALAT' {
  const t = teks(nilai).toUpperCase();
  if (t === '') return SUMBER_DANA_DEFAULT;
  if (t === 'KAS' || t === 'TUNAI') return 'KAS';
  if (t === 'BANK') return 'BANK';
  return 'GALAT';
}

/**
 * RC-S133.6.1 — kolom opsional "Rekening Bank" (keputusan pengguna setelah
 * audit manual-vs-impor: koperasi dengan lebih dari satu rekening bank tidak
 * bisa memakai Sumber Dana BANK lewat impor karena berkas tidak menyebut
 * rekeningnya).
 *
 * Isinya NOMOR REKENING sebagaimana tercatat di menu Data Bank. Spasi, titik,
 * dan tanda hubung diabaikan ("0123-456-789" = "0123456789"). Hanya boleh
 * diisi bila Sumber Dana = BANK — pada KAS (atau Sumber Dana kosong) isian
 * ini DITOLAK, bukan ditebak sebagai BANK.
 *
 * Mengembalikan `undefined` (kosong), string nomor (sah), atau `{ galat }`.
 */
export function normalkanNomorRekening(nilai: unknown): string {
  return teks(nilai).replace(/[\s.\-]/g, '');
}
function bacaRekeningBank(nilai: unknown, sumberDana: 'KAS' | 'BANK'): string | undefined | { galat: string } {
  if (selKosong(nilai)) return undefined;
  const nomor = normalkanNomorRekening(nilai);
  if (!/^\d{3,30}$/.test(nomor)) {
    return { galat: `Rekening Bank "${teks(nilai)}" tidak sah — isi nomor rekening (angka) seperti di menu Data Bank.` };
  }
  if (sumberDana !== 'BANK') {
    return { galat: 'Rekening Bank hanya diisi bila Sumber Dana = BANK. Isi Sumber Dana BANK, atau kosongkan Rekening Bank.' };
  }
  return nomor;
}

/** Satu rekening bank aktif, sebagaimana dibaca dari tabel bank_account. */
export interface RekeningBankAktif {
  id: string;
  namaBank: string;
  nomorRekening: string;
}

/**
 * RC-S133.6.1 — tentukan rekening untuk satu baris Sumber Dana BANK.
 * Dipakai DUA tempat dengan aturan yang sama: pratinjau (sebelum tulis apa
 * pun) dan eksekutor (pertahanan kedua). Tidak ada tebakan:
 *   - kolom kosong + tepat 1 rekening aktif  -> rekening itu;
 *   - kolom kosong + 0 atau >1 rekening      -> galat (minta isi kolom);
 *   - kolom diisi -> cocok persis dengan nomor rekening aktif (setelah
 *     spasi/titik/tanda hubung dibuang). Bila tidak ada yang persis sama,
 *     dicoba sekali lagi dengan nol di depan diabaikan (Excel membuang nol
 *     di depan pada sel angka) — dipakai HANYA bila hasilnya tepat satu.
 */
export function pilihRekeningBankImport(
  rekeningBank: string | undefined,
  daftar: RekeningBankAktif[]
): { id: string } | { galat: string } {
  const sebut = (d: RekeningBankAktif[]) => d.map((b) => `${b.namaBank} ${b.nomorRekening}`).join(', ');
  if (daftar.length === 0) {
    return { galat: 'Sumber Dana BANK memerlukan rekening bank aktif, tetapi belum ada rekening bank aktif. Tambahkan rekening di menu Data Bank, atau gunakan Sumber Dana KAS.' };
  }
  if (!rekeningBank) {
    if (daftar.length === 1) return { id: daftar[0].id };
    return { galat: `Sumber Dana BANK tanpa kolom Rekening Bank memerlukan tepat satu rekening bank aktif, tetapi ada ${daftar.length} (${sebut(daftar)}). Isi kolom Rekening Bank dengan nomor rekening yang dipakai.` };
  }
  const persis = daftar.filter((b) => normalkanNomorRekening(b.nomorRekening) === rekeningBank);
  const tanpaNol = (x: string) => x.replace(/^0+/, '');
  const kandidat = persis.length > 0 ? persis : daftar.filter((b) => tanpaNol(normalkanNomorRekening(b.nomorRekening)) === tanpaNol(rekeningBank));
  if (kandidat.length === 1) return { id: kandidat[0].id };
  if (kandidat.length > 1) {
    return { galat: `Rekening Bank "${rekeningBank}" cocok dengan lebih dari satu rekening aktif (${sebut(kandidat)}). Perbaiki nomor rekening di menu Data Bank.` };
  }
  return { galat: `Rekening Bank "${rekeningBank}" tidak ada di daftar rekening bank aktif (${sebut(daftar)}).` };
}

/**
 * Kerangka pembacaan yang sama untuk keempat sheet: temukan header,
 * lewati baris kosong, baca tiap baris lewat `bacaBaris`, dan kumpulkan
 * galat per baris. `bacaBaris` mengembalikan string = pesan galat, atau
 * objek = baris yang sah.
 */
function bacaSheet<T>(
  sheet: unknown[][] | undefined,
  namaSheet: string,
  kolomWajib: string[],
  bacaBaris: (ambil: (nama: string) => unknown, nomorBaris: number) => T | string
): HasilParseSheet<T> {
  if (!sheet || sheet.length === 0) {
    return { terbaca: false, galatSheet: `Sheet "${namaSheet}" tidak ditemukan atau kosong.`, baris: [], galat: [] };
  }
  const idxHeader = cariBarisHeader(sheet, kolomWajib);
  if (idxHeader < 0) {
    return {
      terbaca: false,
      galatSheet: `Sheet "${namaSheet}": baris judul kolom tidak ditemukan. Pastikan ada kolom ${kolomWajib
        .map((k) => `"${k}"`)
        .join(', ')}.`,
      baris: [],
      galat: [],
    };
  }

  const peta = petaKolom(sheet[idxHeader]);
  const hasil: T[] = [];
  const galat: GalatBaris[] = [];

  for (let i = idxHeader + 1; i < sheet.length; i++) {
    const baris = sheet[i] ?? [];
    if (barisKosong(baris)) continue;
    const nomorBaris = i + 1; // 1-based seperti tampilan Excel
    const ambil = (nama: string): unknown => {
      const idx = peta.get(normalkanHeader(nama));
      return idx === undefined ? undefined : baris[idx];
    };
    const r = bacaBaris(ambil, nomorBaris);
    if (typeof r === 'string') galat.push({ baris: nomorBaris, pesan: r });
    else hasil.push(r);
  }

  return { terbaca: true, galatSheet: null, baris: hasil, galat };
}

export function parseSheetAnggota(sheet: unknown[][] | undefined): HasilParseSheet<BarisAnggota> {
  return bacaSheet(sheet, JUDUL_SHEET.ANGGOTA, ['kodeanggota', 'namalengkap'], (ambil, baris) => {
    const kode = teks(ambil('Kode Anggota'));
    const nama = teks(ambil('Nama Lengkap'));
    if (!kode) return 'Kode Anggota wajib diisi.';
    if (!nama) return 'Nama Lengkap wajib diisi.';

    const rawBergabung = ambil('Tanggal Bergabung');
    let tanggalBergabung: string | null;
    if (selKosong(rawBergabung)) {
      return 'Tanggal Bergabung wajib diisi (format 31/01/2026 atau 2026-01-31).';
    }
    tanggalBergabung = parseTanggal(rawBergabung);
    if (!tanggalBergabung) return `Tanggal Bergabung "${teks(rawBergabung)}" tidak dikenali.`;

    const rawLahir = ambil('Tanggal Lahir');
    let tanggalLahir: string | null = null;
    if (!selKosong(rawLahir)) {
      tanggalLahir = parseTanggal(rawLahir);
      if (!tanggalLahir) return `Tanggal Lahir "${teks(rawLahir)}" tidak dikenali.`;
    }

    // Pengguna mengetik L/P di Excel (paling ringkas), tetapi yang
    // dikembalikan adalah nilai DOMAIN aplikasi — lihat komentar field
    // `jenisKelamin` di `BarisAnggota`.
    const jk = teks(ambil('Jenis Kelamin')).toUpperCase();
    let jenisKelamin: 'LAKI_LAKI' | 'PEREMPUAN' | null = null;
    if (jk !== '') {
      if (jk === 'L' || jk.startsWith('LAKI')) jenisKelamin = 'LAKI_LAKI';
      else if (jk === 'P' || jk.startsWith('PEREMPUAN') || jk.startsWith('WANITA')) jenisKelamin = 'PEREMPUAN';
      else return `Jenis Kelamin "${jk}" tidak dikenali — isi L atau P.`;
    }

    const nik = teks(ambil('NIK'));
    if (nik && !/^\d{16}$/.test(nik)) return `NIK "${nik}" harus 16 digit angka.`;

    return {
      baris,
      kode,
      namaLengkap: nama,
      nik: nik || null,
      jenisKelamin,
      tempatLahir: teks(ambil('Tempat Lahir')) || null,
      tanggalLahir,
      alamat: teks(ambil('Alamat')) || null,
      nomorHp: teks(ambil('No HP')) || null,
      pekerjaan: teks(ambil('Pekerjaan')) || null,
      tanggalBergabung,
    };
  });
}

export function parseSheetSimpanan(sheet: unknown[][] | undefined): HasilParseSheet<BarisSimpanan> {
  // RC-S124: ketiga kolom nominal simpanan WAJIB ada di baris judul.
  const kolomWajibSimpanan = ['kodeanggota', 'tanggal', 'simpananpokok', 'simpananwajib', 'simpanansukarela'];
  return bacaSheet(sheet, JUDUL_SHEET.SIMPANAN, kolomWajibSimpanan, (ambil, baris) => {
    const kode = teks(ambil('Kode Anggota'));
    if (!kode) return 'Kode Anggota wajib diisi.';

    const rawTanggal = ambil('Tanggal');
    if (selKosong(rawTanggal)) return 'Tanggal wajib diisi.';
    const tanggal = parseTanggal(rawTanggal);
    if (!tanggal) return `Tanggal "${teks(rawTanggal)}" tidak dikenali.`;

    const nominal = (nama: string): number | string => {
      const raw = ambil(nama);
      // RC-S124: sel kosong DITOLAK (dulu dianggap 0). Angka 0 tetap sah.
      if (selKosong(raw)) return `${nama} wajib diisi — tulis 0 bila tidak ada.`;
      const n = parseRupiah(raw);
      if (n === null) return `${nama} "${teks(raw)}" bukan angka yang sah.`;
      if (n < 0) return `${nama} tidak boleh negatif.`;
      return n;
    };
    const pokok = nominal('Simpanan Pokok');
    if (typeof pokok === 'string') return pokok;
    const wajib = nominal('Simpanan Wajib');
    if (typeof wajib === 'string') return wajib;
    const sukarela = nominal('Simpanan Sukarela');
    if (typeof sukarela === 'string') return sukarela;

    if (pokok + wajib + sukarela <= 0) {
      return 'Isi minimal salah satu dari Simpanan Pokok, Wajib, atau Sukarela.';
    }

    const sumberDana = bacaSumberDana(ambil('Sumber Dana'));
    if (sumberDana === 'GALAT') return 'Sumber Dana harus KAS atau BANK.';
    const rek = bacaRekeningBank(ambil('Rekening Bank'), sumberDana);
    if (typeof rek === 'object') return rek.galat;
    const rekeningBank = rek ? { rekeningBank: rek } : {};

    return { baris, kode, tanggal, pokok, wajib, sukarela, sumberDana, ...rekeningBank };
  });
}

export function parseSheetPinjaman(sheet: unknown[][] | undefined): HasilParseSheet<BarisPinjaman> {
  return bacaSheet(sheet, JUDUL_SHEET.PINJAMAN, ['kodeanggota', 'jumlahpinjaman'], (ambil, baris) => {
    const kode = teks(ambil('Kode Anggota'));
    if (!kode) return 'Kode Anggota wajib diisi.';

    const rawTanggal = ambil('Tanggal Pencairan');
    if (selKosong(rawTanggal)) return 'Tanggal Pencairan wajib diisi.';
    const tanggal = parseTanggal(rawTanggal);
    if (!tanggal) return `Tanggal Pencairan "${teks(rawTanggal)}" tidak dikenali.`;

    const jumlah = parseRupiah(ambil('Jumlah Pinjaman'));
    if (jumlah === null) return 'Jumlah Pinjaman wajib diisi.';
    if (jumlah <= 0) return 'Jumlah Pinjaman harus lebih besar dari 0.';

    const rawTenor = ambil('Tenor');
    const tenor = parseBilanganHitungan(rawTenor);
    if (tenor === null) return 'Tenor wajib diisi (jumlah periode angsuran).';
    if (!Number.isInteger(tenor) || tenor < 1) return 'Tenor harus bilangan bulat minimal 1.';

    const satuanRaw = teks(ambil('Satuan Tenor')).toUpperCase();
    const satuanTenor = satuanRaw === '' ? 'BULAN' : satuanRaw;
    if (satuanTenor !== 'HARI' && satuanTenor !== 'MINGGU' && satuanTenor !== 'BULAN') {
      return `Satuan Tenor "${satuanRaw}" tidak dikenali — isi HARI, MINGGU, atau BULAN.`;
    }

    const metodeRaw = teks(ambil('Metode Jasa')).toUpperCase();
    const metodeJasa = metodeRaw === '' ? 'FLAT' : metodeRaw;
    if (metodeJasa !== 'FLAT' && metodeJasa !== 'MENURUN' && metodeJasa !== 'EFEKTIF') {
      return `Metode Jasa "${metodeRaw}" tidak dikenali — isi FLAT, MENURUN, atau EFEKTIF.`;
    }

    const rawJasa = ambil('Jasa Persen');
    let persentaseJasa = 0;
    if (!selKosong(rawJasa)) {
      const j = Number(String(rawJasa).replace(/%/g, '').replace(/,/g, '.').trim());
      if (!Number.isFinite(j) || j < 0) return `Jasa Persen "${teks(rawJasa)}" tidak sah.`;
      persentaseJasa = j;
    }

    // RC-S133.4.8 — "Satuan Jasa": kosong/PERIODE = persen per periode
    // angsuran (perilaku lama); TAHUN = persen per tahun, dikonversi ke
    // per bulan (÷ 12). Konversi tahunan untuk tenor HARI/MINGGU DITOLAK:
    // banyaknya hari/minggu per tahun adalah konvensi yang harus diputuskan
    // koperasi, bukan ditebak aplikasi.
    const satuanJasaRaw = teks(ambil('Satuan Jasa')).toUpperCase().replace(/[\s_]+/g, ' ').trim();
    let satuanJasa: 'PERIODE' | 'TAHUN';
    if (satuanJasaRaw === '' || satuanJasaRaw === 'PERIODE' || satuanJasaRaw === 'PER PERIODE' || satuanJasaRaw === 'BULAN' || satuanJasaRaw === 'PER BULAN') {
      satuanJasa = 'PERIODE';
    } else if (satuanJasaRaw === 'TAHUN' || satuanJasaRaw === 'PER TAHUN' || satuanJasaRaw === 'TAHUNAN' || satuanJasaRaw === 'PA') {
      satuanJasa = 'TAHUN';
    } else {
      return `Satuan Jasa "${teks(ambil('Satuan Jasa'))}" tidak dikenali — isi PERIODE (per bulan/angsuran) atau TAHUN.`;
    }
    const persentaseJasaDiisi = persentaseJasa;
    if (satuanJasa === 'TAHUN') {
      if (satuanTenor !== 'BULAN') {
        return `Satuan Jasa TAHUN hanya untuk Satuan Tenor BULAN. Untuk tenor ${satuanTenor}, isi Jasa Persen per ${satuanTenor === 'HARI' ? 'hari' : 'minggu'} dan kosongkan Satuan Jasa.`;
      }
      // Dibulatkan 8 desimal supaya 18 → 1,5 persis dan angka tak berujung
      // (mis. 4,8449 / 12) tidak membawa ekor pecahan biner.
      persentaseJasa = Number((persentaseJasa / 12).toFixed(8));
    }

    const sumberDana = bacaSumberDana(ambil('Sumber Dana'));
    if (sumberDana === 'GALAT') return 'Sumber Dana harus KAS atau BANK.';
    const rek = bacaRekeningBank(ambil('Rekening Bank'), sumberDana);
    if (typeof rek === 'object') return rek.galat;
    const rekeningBank = rek ? { rekeningBank: rek } : {};

    const rawDibayar = ambil('Angsuran Sudah Dibayar');
    let angsuranSudahDibayar = 0;
    if (!selKosong(rawDibayar)) {
      const n = parseBilanganHitungan(rawDibayar);
      if (n === null || !Number.isInteger(n) || n < 0) {
        return `Angsuran Sudah Dibayar "${teks(rawDibayar)}" harus bilangan bulat 0 atau lebih.`;
      }
      if (n > tenor) return `Angsuran Sudah Dibayar (${n}) melebihi Tenor (${tenor}).`;
      angsuranSudahDibayar = n;
    }

    // --- RC-S102: kolom migrasi saldo awal (semuanya opsional) ---
    const nomorPinjamanLama = teks(ambil('Nomor Pinjaman Lama')) || undefined;

    const rawSisa = ambil('Sisa Pokok');
    let sisaPokok: number | undefined;
    if (!selKosong(rawSisa)) {
      const n = parseRupiah(rawSisa);
      if (n === null || n <= 0) return `Sisa Pokok "${teks(rawSisa)}" harus nominal lebih besar dari 0.`;
      if (n > jumlah) return `Sisa Pokok (${n}) tidak boleh melebihi Jumlah Pinjaman (${jumlah}).`;
      sisaPokok = n;
    }

    const rawTersisa = ambil('Angsuran Tersisa');
    let angsuranTersisa: number | undefined;
    if (!selKosong(rawTersisa)) {
      const n = parseBilanganHitungan(rawTersisa);
      if (n === null || !Number.isInteger(n) || n < 1) {
        return `Angsuran Tersisa "${teks(rawTersisa)}" harus bilangan bulat minimal 1.`;
      }
      angsuranTersisa = n;
    }

    const rawTunggakan = ambil('Tunggakan Pokok');
    let tunggakanPokok: number | undefined;
    if (!selKosong(rawTunggakan)) {
      const n = parseRupiah(rawTunggakan);
      if (n === null || n < 0) return `Tunggakan Pokok "${teks(rawTunggakan)}" tidak sah.`;
      tunggakanPokok = n;
    }

    const rawPiutangJasa = ambil('Piutang Jasa');
    let piutangJasa: number | undefined;
    if (!selKosong(rawPiutangJasa)) {
      const n = parseRupiah(rawPiutangJasa);
      if (n === null || n < 0) return `Piutang Jasa "${teks(rawPiutangJasa)}" tidak sah.`;
      piutangJasa = n;
    }

    // Sisa Pokok dan Angsuran Tersisa saling membutuhkan: satu tanpa yang
    // lain membuat jadwal sisa tidak dapat disusun, dan menebak salah
    // satunya berarti mengarang kewajiban anggota.
    if (sisaPokok !== undefined && angsuranTersisa === undefined) {
      return 'Sisa Pokok diisi tetapi Angsuran Tersisa kosong — keduanya wajib diisi bersama untuk migrasi saldo awal.';
    }
    if (angsuranTersisa !== undefined && sisaPokok === undefined) {
      return 'Angsuran Tersisa diisi tetapi Sisa Pokok kosong — keduanya wajib diisi bersama untuk migrasi saldo awal.';
    }
    if (tunggakanPokok !== undefined && sisaPokok !== undefined && tunggakanPokok > sisaPokok) {
      return `Tunggakan Pokok (${tunggakanPokok}) tidak boleh melebihi Sisa Pokok (${sisaPokok}).`;
    }

    return {
      baris,
      kode,
      tanggal,
      jumlahPinjaman: jumlah,
      nomorPinjamanLama,
      sisaPokok,
      angsuranTersisa,
      tunggakanPokok,
      piutangJasa,
      tenor,
      satuanTenor,
      metodeJasa,
      persentaseJasa,
      satuanJasa,
      persentaseJasaDiisi,
      sumberDana,
      ...rekeningBank,
      angsuranSudahDibayar,
    };
  });
}

export function parseSheetBerjangka(sheet: unknown[][] | undefined): HasilParseSheet<BarisBerjangka> {
  return bacaSheet(sheet, JUDUL_SHEET.BERJANGKA, ['kodeanggota', 'nominal'], (ambil, baris) => {
    const kode = teks(ambil('Kode Anggota'));
    if (!kode) return 'Kode Anggota wajib diisi.';

    const rawTanggal = ambil('Tanggal Penempatan');
    if (selKosong(rawTanggal)) return 'Tanggal Penempatan wajib diisi.';
    const tanggal = parseTanggal(rawTanggal);
    if (!tanggal) return `Tanggal Penempatan "${teks(rawTanggal)}" tidak dikenali.`;

    const nominal = parseRupiah(ambil('Nominal'));
    if (nominal === null) return 'Nominal wajib diisi.';
    if (nominal <= 0) return 'Nominal harus lebih besar dari 0.';

    const rawTenor = ambil('Tenor Bulan');
    if (selKosong(rawTenor)) return 'Tenor Bulan wajib diisi — pilih 3, 6, atau 12.';
    const tenor = parseBilanganHitungan(rawTenor);
    if (tenor !== 3 && tenor !== 6 && tenor !== 12) {
      return `Tenor Bulan "${teks(rawTenor)}" tidak sah — hanya 3, 6, atau 12.`;
    }

    const rawBunga = ambil('Bunga Persen Per Tahun');
    let sukuBungaPerTahun: number | null = null;
    if (!selKosong(rawBunga)) {
      const b = Number(String(rawBunga).replace(/%/g, '').replace(/,/g, '.').trim());
      if (!Number.isFinite(b) || b < 0) return `Bunga Persen Per Tahun "${teks(rawBunga)}" tidak sah.`;
      sukuBungaPerTahun = b;
    }

    const sumberDana = bacaSumberDana(ambil('Sumber Dana'));
    if (sumberDana === 'GALAT') return 'Sumber Dana harus KAS atau BANK.';
    const rek = bacaRekeningBank(ambil('Rekening Bank'), sumberDana);
    if (typeof rek === 'object') return rek.galat;
    const rekeningBank = rek ? { rekeningBank: rek } : {};

    return { baris, kode, tanggal, nominal, tenorBulan: tenor, sukuBungaPerTahun, sumberDana, ...rekeningBank };
  });
}

export function parseSheetAset(sheet: unknown[][] | undefined): HasilParseSheet<BarisAset> {
  return bacaSheet(sheet, JUDUL_SHEET.ASET, ['namaaset', 'nilaiperolehan'], (ambil, baris) => {
    const nomorAset = teks(ambil('Nomor Aset'));
    if (!nomorAset) return 'Nomor Aset wajib diisi — dipakai agar import ulang tidak menggandakan aset.';

    const namaAset = teks(ambil('Nama Aset'));
    if (!namaAset) return 'Nama Aset wajib diisi.';

    const rawTanggal = ambil('Tanggal Perolehan');
    if (selKosong(rawTanggal)) return 'Tanggal Perolehan wajib diisi.';
    const tanggalPerolehan = parseTanggal(rawTanggal);
    if (!tanggalPerolehan) return `Tanggal Perolehan "${teks(rawTanggal)}" tidak dikenali.`;

    const nilaiPerolehan = parseRupiah(ambil('Nilai Perolehan'));
    if (nilaiPerolehan === null) return 'Nilai Perolehan wajib diisi.';
    if (nilaiPerolehan <= 0) return 'Nilai Perolehan harus lebih besar dari 0.';

    const masa = parseBilanganHitungan(ambil('Masa Manfaat Bulan'));
    if (masa === null) return 'Masa Manfaat Bulan wajib diisi.';
    if (!Number.isInteger(masa) || masa <= 0) return 'Masa Manfaat Bulan harus bilangan bulat minimal 1.';

    const rawResidu = ambil('Nilai Residu');
    let nilaiResidu = 0;
    if (!selKosong(rawResidu)) {
      const n = parseRupiah(rawResidu);
      if (n === null || n < 0) return `Nilai Residu "${teks(rawResidu)}" tidak sah.`;
      nilaiResidu = n;
    }
    if (nilaiResidu >= nilaiPerolehan) {
      return `Nilai Residu (${nilaiResidu}) harus lebih kecil dari Nilai Perolehan (${nilaiPerolehan}).`;
    }

    const kelompokAset = teks(ambil('Kelompok Aset')) || undefined;
    const subKelompokAset = teks(ambil('Sub Kelompok Aset')) || undefined;

    return { baris, nomorAset, namaAset, tanggalPerolehan, nilaiPerolehan, masaManfaatBulan: masa, nilaiResidu, kelompokAset, subKelompokAset };
  });
}

export function parseSheetJasa(sheet: unknown[][] | undefined): HasilParseSheet<BarisJasa> {
  return bacaSheet(sheet, JUDUL_SHEET.JASA, ['kodeanggota', 'jasapinjamandibayar'], (ambil, baris) => {
    const kode = teks(ambil('Kode Anggota'));
    if (!kode) return 'Kode Anggota wajib diisi.';
    const raw = ambil('Jasa Pinjaman Dibayar');
    if (selKosong(raw)) return 'Jasa Pinjaman Dibayar wajib diisi — tulis 0 bila anggota tidak membayar jasa.';
    const jasa = parseRupiah(raw);
    if (jasa === null) return `Jasa Pinjaman Dibayar "${teks(raw)}" tidak dikenali.`;
    if (jasa < 0) return 'Jasa Pinjaman Dibayar tidak boleh negatif.';
    if (!Number.isInteger(jasa)) return 'Jasa Pinjaman Dibayar harus bilangan bulat rupiah.';
    const nama = teks(ambil('Nama Anggota')) || null;
    return { baris, kode, nama, jasa };
  });
}

/** Kode pada baris contoh sheet 7 — ditolak supaya tidak ikut terimpor. */
export const KODE_AKUN_CONTOH = 'CONTOH';

export function parseSheetSaldoAwalAkun(sheet: unknown[][] | undefined): HasilParseSheet<BarisSaldoAwalAkun> {
  const hasil = bacaSheet(sheet, JUDUL_SHEET_SALDO_AWAL_AKUN, ['kodeakun', 'saldo'], (ambil, baris) => {
    const kodeAkun = teks(ambil('Kode Akun'));
    if (!kodeAkun) return 'Kode Akun wajib diisi (lihat sheet "Daftar Akun", mis. 1-1000 untuk Kas).';
    if (kodeAkun.toUpperCase() === KODE_AKUN_CONTOH) return 'Ini baris contoh — hapus baris ini.';
    const raw = ambil('Saldo');
    if (selKosong(raw)) return 'Saldo wajib diisi. Akun yang saldonya 0 cukup dihapus barisnya.';
    const saldo = parseRupiah(raw);
    if (saldo === null) return `Saldo "${teks(raw)}" tidak dikenali.`;
    if (saldo <= 0) {
      return 'Saldo harus lebih dari 0 dan ditulis menurut saldo normal akunnya (aset & beban di debit, kewajiban, ekuitas & pendapatan di kredit).';
    }
    let bagianTunai: number | null = null;
    const rawTunai = ambil('Bagian Tunai');
    if (!selKosong(rawTunai)) {
      const t = parseRupiah(rawTunai);
      if (t === null || t < 0) return `Bagian Tunai "${teks(rawTunai)}" tidak sah.`;
      if (t > saldo) return 'Bagian Tunai tidak boleh melebihi Saldo.';
      bagianTunai = t;
    }
    return { baris, kodeAkun, namaAkun: teks(ambil('Nama Akun')) || null, saldo, bagianTunai };
  });
  // Satu akun cukup satu baris.
  const dipakai = new Map<string, number>();
  for (const r of hasil.baris) {
    const k = r.kodeAkun.toUpperCase();
    const sebelumnya = dipakai.get(k);
    if (sebelumnya !== undefined) {
      hasil.galat.push({ baris: r.baris, pesan: `Kode Akun "${r.kodeAkun}" sudah dipakai baris ${sebelumnya}. Satu akun cukup satu baris.` });
    } else {
      dipakai.set(k, r.baris);
    }
  }
  hasil.baris = hasil.baris.filter((r) => dipakai.get(r.kodeAkun.toUpperCase()) === r.baris);
  return hasil;
}

// ===========================================================================
// PEMERIKSAAN LINTAS-SHEET
// ===========================================================================

export interface RingkasanParse {
  hasil: HasilParseBerkas;
  /** Galat yang tidak melekat pada satu sheet saja (mis. kode anggota ganda / tidak dikenal). */
  galatUmum: string[];
  totalBarisSah: number;
  totalGalat: number;
  /** true bila tidak ada galat sama sekali di seluruh berkas. */
  siapDiimpor: boolean;
}

/**
 * Baca seluruh berkas + periksa keterkaitan antar-sheet.
 *
 * DUA pemeriksaan yang hanya bisa dilakukan di sini:
 *   1. Kode Anggota tidak boleh ganda di sheet Anggota — kalau ganda,
 *      sheet lain tidak punya cara menentukan anggota yang dimaksud.
 *   2. Kode yang dipakai sheet Simpanan/Pinjaman/Berjangka harus ada di
 *      sheet Anggota. Ini penyebab salah ketik yang paling sering, dan
 *      jauh lebih baik ketahuan SEBELUM ada satu baris pun yang ditulis.
 */
export function parseBerkasDataAwal(sheet: SheetMentah): RingkasanParse {
  const hasil: HasilParseBerkas = {
    anggota: parseSheetAnggota(sheet.ANGGOTA),
    simpanan: parseSheetSimpanan(sheet.SIMPANAN),
    pinjaman: parseSheetPinjaman(sheet.PINJAMAN),
    berjangka: parseSheetBerjangka(sheet.BERJANGKA),
    aset: parseSheetAset(sheet.ASET),
    jasa: parseSheetJasa(sheet.JASA),
  };
  // RC-S133.4.6 — sheet 7 hanya dibaca bila ada di berkas.
  if (sheet.SALDO_AWAL_AKUN) hasil.saldoAwalAkun = parseSheetSaldoAwalAkun(sheet.SALDO_AWAL_AKUN);

  const galatUmum: string[] = [];

  const kodeAnggota = new Set<string>();
  const kodeGanda = new Set<string>();
  for (const a of hasil.anggota.baris) {
    const k = a.kode.toUpperCase();
    if (kodeAnggota.has(k)) kodeGanda.add(a.kode);
    kodeAnggota.add(k);
  }
  for (const k of kodeGanda) {
    galatUmum.push(`Kode Anggota "${k}" dipakai lebih dari satu kali di sheet ${JUDUL_SHEET.ANGGOTA}.`);
  }

  // RC-S133.6.1 — NIK ganda DALAM berkas (temuan audit E06): kolom
  // anggota.nik UNIK di database, jadi baris kedua pasti gagal saat import
  // padahal pratinjau menyatakan siap. Kini galat di pratinjau.
  const nikPertama = new Map<string, number>();
  for (const a of hasil.anggota.baris) {
    const nik = (a.nik ?? '').trim();
    if (!nik) continue;
    const sebelumnya = nikPertama.get(nik);
    if (sebelumnya !== undefined) {
      hasil.anggota.galat.push({ baris: a.baris, pesan: `NIK ${nik} sudah dipakai baris ${sebelumnya} di sheet ${JUDUL_SHEET.ANGGOTA}. Satu NIK hanya untuk satu anggota.` });
    } else {
      nikPertama.set(nik, a.baris);
    }
  }

  // Baris yang kodenya tidak dikenal DIKELUARKAN dari daftar yang akan
  // diimpor dan dilaporkan sebagai galat — bukan diam-diam dilewati,
  // dan bukan pula dibiarkan lolos ke tahap eksekusi.
  const saring = <T extends { baris: number; kode: string }>(s: HasilParseSheet<T>): void => {
    for (const r of s.baris) {
      if (!kodeAnggota.has(r.kode.toUpperCase())) {
        s.galat.push({
          baris: r.baris,
          pesan: `Kode Anggota "${r.kode}" tidak ada di sheet ${JUDUL_SHEET.ANGGOTA}.`,
        });
      }
    }
    s.baris = s.baris.filter((r) => kodeAnggota.has(r.kode.toUpperCase()));
  };
  if (hasil.anggota.terbaca) {
    saring(hasil.simpanan);
    saring(hasil.pinjaman);
    saring(hasil.berjangka);
  }

  // Nomor aset ganda DALAM berkas — diperiksa di sini karena sifatnya
  // lintas-baris, sama seperti Kode Anggota ganda.
  const nomorAset = new Map<string, number>();
  for (const a of hasil.aset.baris) {
    const k = a.nomorAset.toUpperCase();
    const sebelumnya = nomorAset.get(k);
    if (sebelumnya !== undefined) {
      hasil.aset.galat.push({
        baris: a.baris,
        pesan: `Nomor Aset "${a.nomorAset}" sudah dipakai baris ${sebelumnya} di sheet ${JUDUL_SHEET.ASET}.`,
      });
    } else {
      nomorAset.set(k, a.baris);
    }
  }

  // RC-S133.4.3 — satu anggota cukup satu baris di sheet Jasa Dibayar.
  const kodeJasa = new Map<string, number>();
  for (const j of hasil.jasa.baris) {
    const k = j.kode.toUpperCase();
    const sebelumnya = kodeJasa.get(k);
    if (sebelumnya !== undefined) {
      hasil.jasa.galat.push({
        baris: j.baris,
        pesan: `Kode Anggota "${j.kode}" sudah dipakai baris ${sebelumnya} di sheet ${JUDUL_SHEET.JASA}. Satu anggota cukup satu baris.`,
      });
    } else {
      kodeJasa.set(k, j.baris);
    }
  }
  hasil.jasa.baris = hasil.jasa.baris.filter((j) => kodeJasa.get(j.kode.toUpperCase()) === j.baris);

  const semua: HasilParseSheet<unknown>[] = [hasil.anggota, hasil.simpanan, hasil.pinjaman, hasil.berjangka, hasil.aset, hasil.jasa];
  if (hasil.saldoAwalAkun) semua.push(hasil.saldoAwalAkun);
  const totalBarisSah = semua.reduce((t, s) => t + s.baris.length, 0);
  const totalGalat = semua.reduce((t, s) => t + s.galat.length, 0) + galatUmum.length;

  return {
    hasil,
    galatUmum,
    totalBarisSah,
    totalGalat,
    siapDiimpor: totalGalat === 0 && totalBarisSah > 0,
  };
}


import { JUDUL_SHEET, JenisSheetImport, JUDUL_SHEET_SALDO_AWAL_AKUN, KODE_AKUN_CONTOH } from '@/import/ExcelDataAwalParser';
import { DEFAULT_ACCOUNTS } from '@/config/defaultCOA';

/**
 * TemplateDataAwal — kerangka berkas Excel "Import Data Awal" yang
 * diunduh pengguna, lalu diisi, lalu dibaca kembali oleh aplikasi.
 *
 * ============================================================
 * BERKAS INI MURNI DATA — TANPA `xlsx`, TANPA MODUL NATIVE
 * ============================================================
 * Yang ada di sini hanya DESKRIPSI template (nama sheet, kolom, contoh
 * baris, lebar kolom). Pengubahannya menjadi `.xlsx` dilakukan
 * `ImportDataAwalService` dengan SheetJS. Pemisahan ini membuat isi
 * template bisa diuji langsung — termasuk test yang membuktikan setiap
 * kolom di template memang DIKENALI parser (lihat test RC-S96), sehingga
 * template dan pembaca tidak bisa lagi berjalan berbeda arah.
 *
 * ============================================================
 * PRINSIP ISI TEMPLATE
 * ============================================================
 *  - Kolom WAJIB ditandai `*` pada judulnya. Parser membuang tanda itu
 *    saat mencocokkan nama kolom, jadi penandaan ini murni untuk manusia.
 *  - Kolom pilihan menyebutkan pilihannya langsung di judul, mis.
 *    "Sumber Dana (KAS/BANK)" — pengguna tidak perlu membuka petunjuk.
 *  - Setiap sheet punya SATU baris contoh yang sudah terisi, diberi tanda
 *    `CONTOH` pada Kode Anggota supaya jelas harus dihapus. Baris contoh
 *    memakai kode yang TIDAK dipakai baris lain, jadi kalau pengguna lupa
 *    menghapusnya, yang terjadi hanyalah satu anggota bernama "(hapus
 *    baris ini)" — bukan data yang tercampur.
 *  - Sheet "Petunjuk" memuat urutan pengisian & hal-hal yang paling
 *    sering ditanyakan, supaya template bisa dipakai tanpa dokumen lain.
 */

/**
 * RC-S133.6.1 — kolom opsional "Rekening Bank" pada sheet Simpanan,
 * Pinjaman, dan Simpanan Berjangka. Aturannya ada di
 * `pilihRekeningBankImport` (ExcelDataAwalParser).
 */
const KOLOM_REKENING_BANK: KolomTemplate = {
  label: 'Rekening Bank',
  wajib: false,
  lebar: 20,
  contoh: '',
  format: 'nomor rekening',
  catatan:
    'Hanya untuk Sumber Dana BANK: nomor rekening persis seperti di menu Data Bank. Boleh kosong bila koperasi hanya punya satu rekening bank aktif; wajib diisi bila lebih dari satu. Kosongkan untuk Sumber Dana KAS.',
};

export const NAMA_SHEET_PETUNJUK = 'Petunjuk';

/** Kode pada baris contoh — dipakai juga oleh test & layar untuk menjelaskannya. */
export const KODE_CONTOH = 'CONTOH';

export interface KolomTemplate {
  /**
   * NAMA KOLOM yang dicocokkan parser. Ditulis tanpa tanda wajib maupun
   * keterangan — keduanya DITURUNKAN oleh `judulKolomExcel()`.
   */
  label: string;
  /** Wajib diisi. Menentukan tanda `*` di Excel DAN lencana "Wajib" di aplikasi. */
  wajib: boolean;
  /** Lebar kolom Excel (karakter). */
  lebar: number;
  /** Nilai baris contoh. */
  contoh: string | number;
  /** Nilai yang boleh diisi, mis. `['KAS', 'BANK']`. Ikut ditulis di judul Excel. */
  pilihan?: string[];
  /** Petunjuk isi singkat, mis. 'jumlah angsuran'. Ikut ditulis di judul Excel. */
  format?: string;
  /** Keterangan lebih panjang — HANYA untuk tampilan di aplikasi, tidak masuk Excel. */
  catatan?: string;
}

/**
 * Judul kolom sebagaimana ditulis di berkas Excel — DITURUNKAN dari
 * metadata di atas, bukan ditulis ulang.
 *
 * Kenapa diturunkan: dulu judul Excel diketik manual lengkap dengan
 * tanda `*` dan keterangan dalam kurung, sehingga tanda wajib bisa
 * berbeda dari kenyataan (kolom bertanda `*` yang sebenarnya boleh
 * kosong, atau sebaliknya) dan tampilan di aplikasi harus menebak
 * dengan membaca tanda bintang dari string. Sekarang satu metadata
 * melayani keduanya.
 *
 * Tanda `*` dan bagian dalam kurung SENGAJA tetap ditulis ke Excel
 * karena berguna bagi manusia; parser membuang keduanya saat
 * mencocokkan nama kolom (lihat `normalkanHeader`), jadi aman.
 */
export function judulKolomExcel(k: KolomTemplate): string {
  const keterangan = k.pilihan?.length ? k.pilihan.join('/') : k.format;
  return `${k.label}${k.wajib ? ' *' : ''}${keterangan ? ` (${keterangan})` : ''}`;
}

export interface SheetTemplate {
  jenis: JenisSheetImport;
  nama: string;
  /** Satu kalimat di baris pertama sheet — mengingatkan apa isi sheet ini. */
  keterangan: string;
  kolom: KolomTemplate[];
}

/**
 * Definisi sheet data (1–6).
 *
 * Kolom `Kode Anggota` ADA DI SEMUA SHEET dan menjadi satu-satunya
 * penghubung antar-sheet: nomor anggota dibuat otomatis oleh aplikasi
 * sehingga tidak bisa ditentukan dari Excel (lihat komentar di
 * `ExcelDataAwalParser`).
 */
export const SHEET_TEMPLATE: SheetTemplate[] = [
  {
    jenis: 'ANGGOTA',
    nama: JUDUL_SHEET.ANGGOTA,
    keterangan:
      'Daftar anggota. "Kode Anggota" bebas Anda tentukan (mis. A1, A2, atau nomor anggota lama) dan dipakai untuk menghubungkan sheet 2, 3, 4, dan 6.',
    kolom: [
      {
        label: 'Kode Anggota',
        wajib: true,
        lebar: 14,
        contoh: KODE_CONTOH,
        catatan: 'Penanda Anda sendiri untuk menghubungkan sheet. Tidak disimpan ke aplikasi — nomor anggota dibuat otomatis.',
      },
      { label: 'Nama Lengkap', wajib: true, lebar: 26, contoh: '(hapus baris ini)', catatan: 'Nama anggota sesuai identitas.' },
      {
        label: 'Tanggal Bergabung',
        wajib: true,
        lebar: 19,
        contoh: '01/01/2026',
        format: '31/01/2026',
        catatan: 'Tanggal masuk menjadi anggota.',
      },
      { label: 'NIK', wajib: false, lebar: 20, contoh: '', catatan: 'Bila diisi harus 16 digit angka.' },
      { label: 'Jenis Kelamin', wajib: false, lebar: 18, contoh: 'L', pilihan: ['L', 'P'] },
      { label: 'Tempat Lahir', wajib: false, lebar: 18, contoh: '' },
      { label: 'Tanggal Lahir', wajib: false, lebar: 15, contoh: '', format: '31/01/1990' },
      { label: 'Alamat', wajib: false, lebar: 30, contoh: '' },
      { label: 'No HP', wajib: false, lebar: 16, contoh: '' },
      { label: 'Pekerjaan', wajib: false, lebar: 18, contoh: '' },
    ],
  },
  {
    jenis: 'SIMPANAN',
    nama: JUDUL_SHEET.SIMPANAN,
    keterangan:
      'Saldo awal simpanan per anggota. Kolom Simpanan Pokok, Wajib, dan Sukarela WAJIB diisi ketiganya — tulis 0 bila memang tidak ada, minimal satu lebih dari 0. Satu anggota cukup satu baris.',
    kolom: [
      { label: 'Kode Anggota', wajib: true, lebar: 14, contoh: KODE_CONTOH, catatan: 'Harus sama dengan kode di sheet 1.' },
      { label: 'Tanggal', wajib: true, lebar: 13, contoh: '01/01/2026', format: '31/01/2026', catatan: 'Saldo lama: tanggal posisi saldo, harus SEBELUM cut-off. Transaksi baru: tanggal setoran.' },
      // RC-S124: ketiga kolom nominal simpanan DIWAJIBKAN (sebelumnya
      // opsional, sel kosong dianggap 0). Sel kosong kini ditolak parser
      // supaya "lupa mengisi" tidak lagi diam-diam tercatat sebagai 0 —
      // pengurus harus menulis 0 secara sadar bila memang tidak ada.
      {
        label: 'Simpanan Pokok',
        wajib: true,
        lebar: 16,
        contoh: 100000,
        catatan: 'Hanya boleh dicatat sekali per anggota. Tulis 0 bila sudah pernah dicatat.',
      },
      { label: 'Simpanan Wajib', wajib: true, lebar: 16, contoh: 50000, catatan: 'Tulis 0 bila tidak ada.' },
      { label: 'Simpanan Sukarela', wajib: true, lebar: 18, contoh: 0, catatan: 'Tulis 0 bila anggota tidak punya.' },
      { label: 'Sumber Dana', wajib: false, lebar: 22, contoh: 'KAS', pilihan: ['KAS', 'BANK'], catatan: 'Kosong dianggap KAS.' },
      // RC-S133.6.1 — keputusan pengguna (audit manual vs impor): kolom
      // opsional untuk koperasi yang punya lebih dari satu rekening bank.
      KOLOM_REKENING_BANK,
    ],
  },
  {
    jenis: 'PINJAMAN',
    nama: JUDUL_SHEET.PINJAMAN,
    keterangan:
      'Pinjaman yang masih berjalan. Isi "Angsuran Sudah Dibayar" dengan JUMLAH ANGSURAN yang sudah terbayar — aplikasi menghitung sendiri sisa pokok, jadwal, dan tunggakannya. Untuk data saldo lama, angsuran yang sudah dibayar TIDAK dicatat satu per satu; jasa yang sudah dibayar diisi di sheet 6.',
    kolom: [
      { label: 'Kode Anggota', wajib: true, lebar: 14, contoh: KODE_CONTOH, catatan: 'Harus sama dengan kode di sheet 1.' },
      {
        label: 'Tanggal Pencairan',
        wajib: true,
        lebar: 19,
        contoh: '01/01/2026',
        format: '31/01/2026',
        catatan: 'Tanggal akad/pencairan aslinya, boleh tanggal lampau.',
      },
      { label: 'Jumlah Pinjaman', wajib: true, lebar: 18, contoh: 12000000, catatan: 'Pokok pinjaman saat dicairkan (sesuai akad), BUKAN sisanya — sisa pokok dihitung aplikasi.' },
      { label: 'Tenor', wajib: true, lebar: 24, contoh: 12, format: 'jumlah angsuran', catatan: 'Banyaknya angsuran sesuai akad, mis. 12 untuk 12 bulan.' },
      { label: 'Satuan Tenor', wajib: false, lebar: 32, contoh: 'BULAN', pilihan: ['HARI', 'MINGGU', 'BULAN'], catatan: 'Kosong dianggap BULAN.' },
      { label: 'Metode Jasa', wajib: false, lebar: 34, contoh: 'FLAT', pilihan: ['FLAT', 'MENURUN', 'EFEKTIF'], catatan: 'Kosong dianggap FLAT.' },
      {
        label: 'Jasa Persen',
        wajib: false,
        lebar: 13,
        contoh: 1,
        catatan:
          'Persen jasa. Dibaca PER BULAN/PERIODE angsuran (1,5 = 1,5% sebulan). Bila angka Anda PER TAHUN (mis. 18% setahun), isi kolom Satuan Jasa = TAHUN. Boleh ditulis 1,5 atau 1,5%.',
      },
      // RC-S133.4.8 — satuan angka Jasa Persen. Kosong = PERIODE (perilaku
      // lama). TAHUN dikonversi ÷ 12 (hanya tenor BULAN). Ditambahkan
      // setelah kasus nyata: angka tahunan (18) terbaca 18% sebulan dan
      // piutang berjalan membengkak tiga kali lipat.
      {
        label: 'Satuan Jasa',
        wajib: false,
        lebar: 26,
        contoh: 'PERIODE',
        pilihan: ['PERIODE', 'TAHUN'],
        catatan: 'Kosong = PERIODE (Jasa Persen per bulan/angsuran). TAHUN = Jasa Persen per tahun, aplikasi membaginya 12 (hanya untuk tenor BULAN).',
      },
      { label: 'Sumber Dana', wajib: false, lebar: 22, contoh: 'KAS', pilihan: ['KAS', 'BANK'], catatan: 'Kosong dianggap KAS.' },
      // RC-S133.6.1 — keputusan pengguna (audit manual vs impor): kolom
      // opsional untuk koperasi yang punya lebih dari satu rekening bank.
      KOLOM_REKENING_BANK,
      {
        label: 'Angsuran Sudah Dibayar',
        wajib: false,
        lebar: 22,
        contoh: 6,
        catatan: 'BANYAKNYA angsuran (kali bayar, bukan rupiah) yang sudah terbayar sampai sebelum cut-off. Tidak boleh lebih dari Tenor. Kosong dianggap 0.',
      },
      // RC-S102 — KOLOM MIGRASI SALDO AWAL PINJAMAN BERJALAN.
      //
      // Dipakai HANYA untuk pinjaman lama (tanggal akad SEBELUM cut-off) —
      // pokoknya TIDAK dicairkan ulang lewat kas, lihat MigrasiPinjamanPlan.
      //
      // RC-S133.4.7 — CATATAN DIPERBAIKI. Sejak RC-S103 Nomor Pinjaman
      // Lama, Sisa Pokok, dan Angsuran Tersisa DITURUNKAN otomatis dari
      // Jumlah Pinjaman, Tenor & Angsuran Sudah Dibayar
      // (TurunanMigrasiPinjaman), tetapi catatannya masih berbunyi "WAJIB"
      // sehingga pengguna menghitung sendiri — sumber salah hitung.
      // Contoh barisnya juga dibuat konsisten (6 dari 12 angsuran dibayar
      // -> sisa 6.000.000, tersisa 6); sebelumnya 0 dibayar tetapi sisa
      // 5.000.000, yang justru mengajarkan isian yang tidak cocok.
      {
        label: 'Nomor Pinjaman Lama',
        wajib: false,
        lebar: 22,
        contoh: 'PJ-2024-001',
        catatan:
          'Opsional, dianjurkan. Nomor akad dari pembukuan lama agar mudah dicocokkan. Bila kosong, nomor dibuat otomatis (SA-kode-baris).',
      },
      {
        label: 'Sisa Pokok',
        wajib: false,
        lebar: 18,
        contoh: 6000000,
        catatan:
          'Opsional. Kosongkan agar dihitung otomatis dari Jumlah Pinjaman, Tenor & Angsuran Sudah Dibayar. Isi hanya bila sisa pokok di pembukuan lama berbeda (mis. pernah dilunasi sebagian). Bila diisi, Angsuran Tersisa wajib ikut diisi.',
      },
      {
        label: 'Angsuran Tersisa',
        wajib: false,
        lebar: 20,
        contoh: 6,
        catatan: 'Opsional, berpasangan dengan Sisa Pokok: banyaknya angsuran yang masih harus dibayar setelah cut-off.',
      },
      {
        label: 'Tunggakan Pokok',
        wajib: false,
        lebar: 20,
        contoh: 0,
        catatan:
          'Opsional. Pokok yang sudah jatuh tempo tetapi belum dibayar pada cut-off, maksimal sebesar Sisa Pokok. Bila sisa pokok cocok dengan jadwal akad, tunggakan dihitung dari jadwal itu dan isian ini hanya dibandingkan. Isian ini dipakai bila Sisa Pokok diisi berbeda dari jadwal.',
      },
      {
        label: 'Piutang Jasa',
        wajib: false,
        lebar: 18,
        contoh: 0,
        catatan:
          'Opsional. Isi HANYA bila pembukuan lama memang mengakui jasa secara akrual (jasa sudah diakui tetapi belum dibayar). Tidak dijurnal; menjadi saldo awal akun Piutang Jasa.',
      },
    ],
  },
  {
    jenis: 'BERJANGKA',
    nama: JUDUL_SHEET.BERJANGKA,
    keterangan:
      'Simpanan berjangka yang masih berjalan. Tenor hanya 3, 6, atau 12 bulan. Kosongkan kolom bunga bila tanpa bunga. ' +
      'Saldo lama: TIDAK menambah kas, dan bunga periode sebelum cut-off dianggap sudah masuk Simpanan Sukarela di sheet 2.',
    kolom: [
      { label: 'Kode Anggota', wajib: true, lebar: 14, contoh: KODE_CONTOH, catatan: 'Harus sama dengan kode di sheet 1.' },
      { label: 'Tanggal Penempatan', wajib: true, lebar: 20, contoh: '01/01/2026', format: '31/01/2026', catatan: 'Tanggal penempatan asli. Kontrak yang sudah jatuh tempo sebelum cut-off ditolak.' },
      { label: 'Nominal', wajib: true, lebar: 16, contoh: 10000000, catatan: 'Nominal pokok simpanan berjangka.' },
      { label: 'Tenor Bulan', wajib: true, lebar: 22, contoh: 12, pilihan: ['3', '6', '12'], catatan: 'Hanya 3, 6, atau 12.' },
      { label: 'Bunga Persen Per Tahun', wajib: false, lebar: 22, contoh: 6, catatan: 'Persen PER TAHUN, mis. 6. Kosongkan bila tanpa bunga.' },
      { label: 'Sumber Dana', wajib: false, lebar: 22, contoh: 'KAS', pilihan: ['KAS', 'BANK'], catatan: 'Kosong dianggap KAS.' },
      // RC-S133.6.1 — keputusan pengguna (audit manual vs impor): kolom
      // opsional untuk koperasi yang punya lebih dari satu rekening bank.
      KOLOM_REKENING_BANK,
    ],
  },
  {
    jenis: 'ASET',
    nama: JUDUL_SHEET.ASET,
    keterangan:
      'Aset tetap lama yang masih dipakai. TIDAK dibeli lewat kas saat import — kas koperasi tidak berkurang. ' +
      'Akumulasi penyusutan dihitung sendiri oleh aplikasi dari keempat kolom wajib, sampai tanggal cut-off.',
    kolom: [
      { label: 'Nomor Aset', wajib: true, lebar: 16, contoh: 'AST-CONTOH', catatan: 'Nomor dari pembukuan lama. Dipakai agar import ulang tidak menggandakan aset.' },
      { label: 'Nama Aset', wajib: true, lebar: 26, contoh: 'Meja Kantor (hapus baris ini)' },
      { label: 'Tanggal Perolehan', wajib: true, lebar: 20, contoh: '01/01/2024', format: '31/01/2026', catatan: 'Tanggal perolehan SESUNGGUHNYA, bukan tanggal import. Dari sinilah penyusutan masa lalu dihitung.' },
      { label: 'Nilai Perolehan', wajib: true, lebar: 18, contoh: 5000000, catatan: 'Harga perolehan awal, bukan nilai buku sekarang.' },
      { label: 'Masa Manfaat Bulan', wajib: true, lebar: 20, contoh: 48, catatan: 'Masa manfaat penuh menurut kebijakan koperasi, mis. 48 untuk 4 tahun.' },
      { label: 'Nilai Residu', wajib: false, lebar: 16, contoh: 0, catatan: 'Nilai sisa di akhir masa manfaat. Kosong dianggap 0.' },
      { label: 'Kelompok Aset', wajib: false, lebar: 22, contoh: '', catatan: 'Opsional, sekadar pengelompokan di laporan aset.' },
      { label: 'Sub Kelompok Aset', wajib: false, lebar: 22, contoh: '', catatan: 'Opsional.' },
    ],
  },
  // RC-S133.4.3 — JASA PINJAMAN YANG SUDAH DIBAYAR SEBELUM CUT-OFF.
  // Per ANGGOTA (bukan per pinjaman): pinjaman yang sudah lunas sebelum
  // cut-off tidak ada di sheet 3, padahal jasanya ikut pendapatan tahun
  // ini dan ikut dasar pembagian SHU jasa usaha.
  {
    jenis: 'JASA',
    nama: JUDUL_SHEET.JASA,
    keterangan:
      'Jasa pinjaman yang SUDAH DIBAYAR tiap anggota pada tahun buku berjalan sampai cut-off, termasuk pinjaman yang sudah lunas. ' +
      'Dipakai untuk pembagian SHU jasa usaha; tidak dijurnal. Kode Anggota = kode di sheet 1, atau nomor anggota di aplikasi bila anggotanya sudah ada.',
    kolom: [
      {
        label: 'Kode Anggota',
        wajib: true,
        lebar: 14,
        contoh: KODE_CONTOH,
        catatan: 'Kode di sheet 1 berkas ini, ATAU nomor anggota yang sudah ada di aplikasi (mis. A00001) — cukup unggah sheet ini saja bila data awal sudah pernah diimpor.',
      },
      { label: 'Nama Anggota', wajib: false, lebar: 26, contoh: '(hapus baris ini)', catatan: 'Hanya untuk memudahkan membaca; tidak dicocokkan.' },
      {
        label: 'Jasa Pinjaman Dibayar',
        wajib: true,
        lebar: 30,
        contoh: 250000,
        format: 'tahun ini s.d. cut-off',
        catatan:
          'Jumlah jasa pinjaman yang sudah DIBAYAR anggota sejak awal tahun buku sampai sebelum cut-off. Totalnya sebaiknya sama dengan saldo awal Pendapatan Jasa Pinjaman.',
      },
    ],
  },
];

/**
 * Sheet template dalam URUTAN TAMPILAN, yaitu urutan nomor pada namanya
 * (1. Anggota, 2. Simpanan, 3. Pinjaman, 4. Simpanan Berjangka,
 * 5. Aset Tetap, 6. Jasa Dibayar).
 *
 * SENGAJA BERBEDA dari `URUTAN_PROSES` (anggota, simpanan, berjangka,
 * pinjaman). Urutan proses ditentukan kebutuhan kas — simpanan harus
 * masuk sebelum pinjaman dicairkan — sedangkan urutan TAB di Excel harus
 * mengikuti nomor sheetnya, kalau tidak pengguna melihat tab berurutan
 * 1, 2, 4, 3 dan wajar menganggapnya keliru. Perbedaan ini tidak
 * berpengaruh apa pun: aplikasi mencari sheet berdasarkan namanya, bukan
 * posisinya (lihat `cocokkanJenisSheet`).
 */
export function sheetTemplateUrutTampilan(): SheetTemplate[] {
  return SHEET_TEMPLATE;
}

/**
 * RC-S133.4.6 — sheet tambahan yang tidak menunjuk anggota (bukan
 * `JenisSheetImport`), mis. "7. Saldo Awal Akun".
 */
export interface SheetTemplateTambahan {
  nama: string;
  keterangan: string;
  kolom: KolomTemplate[];
}

/**
 * RC-S133.4.6 — SHEET "7. Saldo Awal Akun" (neraca saldo per cut-off).
 *
 * Uji setara RC-S133.4.5: langkah "isi sendiri di menu Saldo Awal" setelah
 * import adalah satu-satunya bagian yang masih diketik manual dan tempat
 * selisih paling mudah terjadi. Sheet ini mengisinya dari berkas yang
 * sama, lewat service Saldo Awal yang sama dengan menu.
 */
export const SHEET_SALDO_AWAL_AKUN: SheetTemplateTambahan = {
  nama: JUDUL_SHEET_SALDO_AWAL_AKUN,
  keterangan:
    'Saldo akun buku besar per tanggal cut-off yang TIDAK terisi otomatis dari sheet 1–6: Kas, Bank, pendapatan & beban tahun berjalan s.d. cut-off, ' +
    'cadangan, modal, utang, dll. JANGAN isi piutang pinjaman, simpanan, simpanan berjangka, aset tetap & akumulasinya — sudah otomatis. Kode akun: sheet "Daftar Akun".',
  kolom: [
    {
      label: 'Kode Akun',
      wajib: true,
      lebar: 14,
      contoh: KODE_AKUN_CONTOH,
      catatan: 'Kode akun di aplikasi, mis. 1-1000 untuk Kas. Baris contoh ditolak — hapus.',
    },
    { label: 'Nama Akun', wajib: false, lebar: 34, contoh: '(hapus baris ini)', catatan: 'Hanya untuk memudahkan membaca; tidak dicocokkan.' },
    {
      label: 'Saldo',
      wajib: true,
      lebar: 18,
      contoh: 1000000,
      catatan: 'Saldo per cut-off menurut saldo normal akunnya (selalu angka positif). Akun bersaldo 0 tidak perlu ditulis.',
    },
    {
      label: 'Bagian Tunai',
      wajib: false,
      lebar: 22,
      contoh: '',
      format: 'khusus pendapatan/beban',
      catatan:
        'Bagian saldo pendapatan/beban yang sudah diterima/dibayar TUNAI sebelum cut-off (untuk SHU Basis Kas). Kosong = bawaan aplikasi: ' +
        'dianggap tunai, kecuali beban non-kas (penyusutan, amortisasi, penyisihan, bunga simpanan) dan pendapatan jasa sebesar piutang jasa.',
    },
  ],
};

/**
 * RC-S133.4.6 — TEMPLATE TERPISAH UNTUK "TRANSAKSI BARU".
 *
 * Dulu satu berkas melayani dua pilihan yang ARTINYA berbeda: kolom
 * Tanggal di sheet Simpanan berarti "saldo per tanggal" pada Saldo lama
 * tetapi "tanggal setoran" pada Transaksi baru, dan sheet 5/6 serta kolom
 * migrasi pinjaman tidak berlaku untuk Transaksi baru. Template ini hanya
 * memuat yang memang dipakai pilihan itu. Parser yang SAMA membacanya
 * (pencocokan nama sheet & kolom tidak berubah).
 */
// RC-S133.4.8 — dulu angka tetap 9; kolom "Satuan Jasa" yang disisipkan
// setelah "Jasa Persen" akan memotong "Angsuran Sudah Dibayar". Kini dihitung
// dari labelnya (Kode Anggota … Angsuran Sudah Dibayar).
const KOLOM_TERAKHIR_INTI_PINJAMAN = 'Angsuran Sudah Dibayar';

/**
 * RC-S133.4.7 — catatan kolom khusus Transaksi Baru. Catatan bawaan
 * menjelaskan arti kolom pada Saldo lama (posisi per cut-off); pada
 * template Transaksi Baru artinya lain, jadi catatannya diganti supaya
 * komentar judul kolom di Excel tidak menyesatkan.
 */
const CATATAN_TRANSAKSI_BARU: Record<string, string> = {
  Tanggal: 'Tanggal setoran. Kas/Bank bertambah pada tanggal ini.',
  'Jumlah Pinjaman': 'Pokok pinjaman yang dicairkan dari kas/bank pada Tanggal Pencairan.',
  'Tanggal Pencairan': 'Tanggal pinjaman dicairkan. Kas/Bank harus cukup pada tanggal ini.',
  'Angsuran Sudah Dibayar':
    'Banyaknya angsuran (kali bayar, bukan rupiah) yang sudah dibayar; dicatat satu per satu pada tanggal jatuh temponya. Tidak boleh lebih dari Tenor. Kosong dianggap 0.',
  'Tanggal Penempatan': 'Tanggal penempatan. Kas/Bank bertambah sebesar nominal pada tanggal ini.',
};
function catatanTransaksiBaru(kolom: KolomTemplate[]): KolomTemplate[] {
  return kolom.map((k) => (CATATAN_TRANSAKSI_BARU[k.label] ? { ...k, catatan: CATATAN_TRANSAKSI_BARU[k.label] } : k));
}

export const SHEET_TEMPLATE_TRANSAKSI_BARU: SheetTemplate[] = SHEET_TEMPLATE.filter((sh) =>
  ['ANGGOTA', 'SIMPANAN', 'PINJAMAN', 'BERJANGKA'].includes(sh.jenis)
).map((sh) => ({ ...sh, kolom: catatanTransaksiBaru(sh.kolom) })).map((sh) => {
  if (sh.jenis === 'SIMPANAN') {
    return {
      ...sh,
      keterangan:
        'Setoran simpanan. Satu baris = satu setoran pada tanggalnya (boleh beberapa baris per anggota, mis. simpanan wajib tiap bulan). ' +
        'Kas/Bank bertambah sebesar setoran. Simpanan Pokok hanya sekali per anggota; tulis 0 pada kolom yang tidak disetor.',
    };
  }
  if (sh.jenis === 'PINJAMAN') {
    return {
      ...sh,
      keterangan:
        'Pinjaman dicairkan dari kas pada Tanggal Pencairan (kas harus cukup), lalu angsuran yang sudah dibayar dicatat satu per satu pada tanggal jatuh temponya.',
      kolom: sh.kolom.slice(0, sh.kolom.findIndex((k) => k.label === KOLOM_TERAKHIR_INTI_PINJAMAN) + 1),
    };
  }
  if (sh.jenis === 'BERJANGKA') {
    return { ...sh, keterangan: 'Penempatan simpanan berjangka. Kas/Bank bertambah sebesar nominal. Tenor hanya 3, 6, atau 12 bulan.' };
  }
  return sh;
});

export type JenisTemplateDataAwal = 'SALDO_LAMA' | 'TRANSAKSI_BARU';

/** Sheet "Daftar Akun" — rujukan kode untuk sheet 7 (COA bawaan aplikasi). */
export const NAMA_SHEET_DAFTAR_AKUN = 'Daftar Akun';
export function barisDaftarAkun(): (string | number)[][] {
  return [
    ['DAFTAR AKUN BAWAAN KOPKU — rujukan Kode Akun untuk sheet "7. Saldo Awal Akun". Akun tambahan Anda (mis. rekening bank) lihat menu Daftar Akun di aplikasi.'],
    [],
    ['Kode Akun', 'Nama Akun', 'Kategori', 'Saldo Normal', 'Keterangan'],
    ...DEFAULT_ACCOUNTS.map((a) => [a.kode, a.nama, a.kategori, a.normalBalance, keteranganAkunTemplate(a.kode, a.nama)]),
  ];
}
function keteranganAkunTemplate(kode: string, nama: string): string {
  if (/^3-5000$/.test(kode)) return 'Penyeimbang otomatis — JANGAN diisi';
  if (/Piutang Pinjaman Anggota|Simpanan Pokok|Simpanan Wajib|Simpanan Sukarela|Berjangka\)|^Aset Tetap$|Akumulasi Penyusutan Aset Tetap/.test(nama)) {
    return 'Otomatis dari sheet 1–6 — jangan diisi';
  }
  // RC-S133.4.7 — dua pos otomatis yang sebelumnya tidak ditandai.
  if (/^Piutang Jasa Pinjaman$/.test(nama)) return 'Otomatis dari kolom Piutang Jasa di sheet 3 — jangan diisi';
  if (/^Pendapatan Diterima Dimuka$/.test(nama)) return 'Otomatis bila ada angsuran dibayar di muka (sheet 3)';
  if (/^Kas$|^Bank$/.test(nama)) return 'Isi di sheet 7 — uang yang benar-benar ada per cut-off';
  if (/^Pendapatan Jasa Pinjaman$/.test(nama)) return 'Isi di sheet 7 — sebaiknya = total sheet 6';
  return '';
}

/**
 * ATURAN PENGISIAN dalam bentuk TERSTRUKTUR — untuk layar "Struktur
 * Template" di dalam aplikasi.
 *
 * SENGAJA terpisah dari `BARIS_PETUNJUK` di bawah: yang ini objek
 * berjudul+isi yang bisa dirender rapi sebagai kartu, sedangkan
 * `BARIS_PETUNJUK` adalah baris-baris teks untuk sheet Excel. Keduanya
 * menjelaskan hal yang sama, tetapi memaksakan satu bentuk untuk dua
 * media akan membuat salah satunya tampil buruk — daftar Excel yang
 * dipaksa masuk ke layar akan muncul sebagai potongan kalimat terputus.
 */
export interface AturanTemplate {
  judul: string;
  isi: string;
}

export const ATURAN_UMUM: AturanTemplate[] = [
  {
    judul: 'Urutan & nama kolom boleh berbeda',
    isi: 'Aplikasi mencari kolom berdasarkan namanya, bukan posisinya. "Nama Lengkap", "nama_lengkap", dan "NAMA LENGKAP" dianggap sama.',
  },
  {
    judul: 'Tanggal',
    isi: 'Boleh 31/01/2026, 2026-01-31, atau memakai format tanggal Excel. Tanggal yang tidak ada (mis. 31/02) ditolak, bukan digeser.',
  },
  {
    judul: 'Nominal',
    isi: 'Boleh 1000000, 1.000.000, atau Rp 1.000.000. Jangan memakai rumus — isi angkanya langsung.',
  },
  {
    judul: 'Baris kosong diabaikan',
    isi: 'Aman bila ada sela antar-kelompok data. Baris judul atau catatan di atas tabel juga otomatis dilewati.',
  },
  {
    judul: 'Kode Anggota harus unik',
    isi: 'Satu Kode Anggota hanya boleh muncul sekali di sheet 1. Sheet 2, 3, 4, dan 6 menunjuk anggota lewat kode yang sama. Sheet 6 juga menerima nomor anggota yang sudah ada di aplikasi.',
  },
  {
    judul: 'Tanggal cut-off',
    isi:
      'Cut-off = hari pertama pembukuan di KOPKU (bawaan: hari ini, dapat diubah di layar Import). Untuk Saldo lama, seluruh tanggal di berkas harus SEBELUM cut-off dan seluruh saldo adalah posisi akhir hari sebelumnya.',
  },
  {
    judul: 'Hapus baris contoh',
    isi: 'Baris berlatar kuning bertanda "CONTOH" di setiap sheet wajib dihapus. Selama masih ada, tombol Import tidak dapat ditekan.',
  },
  {
    judul: 'Saldo lama: tanpa jurnal kas',
    isi:
      'Pilihan "Saldo lama koperasi" (bawaan untuk data awal): simpanan, simpanan berjangka & pinjaman lama dicatat di buku pembantu TANPA jurnal kas, ' +
      'angsuran yang sudah dibayar tidak dicatat satu per satu, dan Saldo Awal Akun untuk piutang pinjaman, simpanan, berjangka, dan aset diisi otomatis. ' +
      'Kas/Bank, pendapatan & beban tahun berjalan, cadangan, dan utang diisi dari sheet "7. Saldo Awal Akun" (atau sendiri di menu Saldo Awal).',
  },
  {
    judul: 'Transaksi baru: lewat kas',
    isi:
      'Pilihan "Transaksi baru": simpanan menambah kas, pinjaman dicairkan dari kas lalu angsuran yang sudah dibayar dicatat satu per satu. ' +
      'Simpanan diproses lebih dulu agar kas cukup untuk pencairan. Sheet 6 & 7 tidak dipakai — gunakan "Template Transaksi Baru".',
  },
];

/** Baris sheet "Petunjuk". */
export const BARIS_PETUNJUK: string[][] = [
  ['IMPORT DATA AWAL KOPERASI'],
  [],
  ['Berkas ini dipakai untuk memasukkan data awal koperasi ke aplikasi: anggota, simpanan,'],
  ['simpanan berjangka, pinjaman yang masih berjalan, aset tetap, jasa yang sudah dibayar,'],
  ['dan saldo awal akun (Kas, pendapatan & beban tahun berjalan, dll.).'],
  [],
  ['SEBELUM MULAI'],
  ['1.', 'Tentukan TANGGAL CUT-OFF = hari pertama pembukuan di KOPKU, mis. 01/07/2026.'],
  ['', 'Semua angka di berkas ini = posisi AKHIR HARI SEBELUMNYA (30/06/2026), dan semua tanggal'],
  ['', 'di berkas harus SEBELUM cut-off. Di layar Import, cut-off bawaan = hari ini — ubah bila berbeda.'],
  ['2.', 'Siapkan neraca saldo lama per tanggal itu dan pastikan sudah seimbang (debit = kredit).'],
  ['3.', 'Bila ada simpanan berjangka: atur Kebijakan Produk Simpanan Berjangka di aplikasi lebih dulu.'],
  ['4.', 'Penjelasan setiap kolom ada di sheet "Panduan Kolom". Arahkan kursor ke judul kolom (hijau)'],
  ['', 'untuk melihat catatan singkatnya. Di aplikasi: tombol "Panduan Pengisian" (slide bergambar).'],
  [],
  ['LANGKAH PENGISIAN'],
  ['', 'Isi sheet sesuai nomornya, dari kiri ke kanan:'],
  ['1.', 'Sheet "1. Anggota" — WAJIB diisi lebih dulu. Tentukan "Kode Anggota" sendiri'],
  ['', '(mis. A1, A2, atau nomor anggota lama Anda). Kode ini hanya dipakai di berkas ini'],
  ['', 'untuk menghubungkan sheet 2, 3, 4, dan 6 ke anggota yang tepat.'],
  ['2.', 'Sheet "2. Simpanan" — saldo awal Simpanan Pokok / Wajib / Sukarela per anggota.'],
  ['', 'Ketiga kolom simpanan WAJIB diisi; tulis 0 bila memang tidak ada.'],
  ['3.', 'Sheet "3. Pinjaman" — bila ada pinjaman yang masih berjalan. Jumlah Pinjaman = POKOK AWAL akad,'],
  ['', 'Angsuran Sudah Dibayar = berapa KALI sudah bayar. Sisa pokok & tunggakan dihitung aplikasi —'],
  ['', 'kolom Sisa Pokok dkk. boleh dikosongkan.'],
  ['4.', 'Sheet "4. Simpanan Berjangka" — bila ada simpanan berjangka yang masih berjalan.'],
  ['5.', 'Sheet "5. Aset Tetap" — aset lama yang masih dipakai.'],
  ['6.', 'Sheet "6. Jasa Dibayar" — jasa pinjaman yang SUDAH DIBAYAR tiap anggota sejak awal'],
  ['', 'tahun buku sampai cut-off (termasuk pinjaman yang sudah lunas). Dipakai untuk'],
  ['', 'pembagian SHU jasa usaha. Bila data awal SUDAH pernah diimpor, cukup isi sheet ini'],
  ['', 'saja dengan nomor anggota dari aplikasi (mis. A00001) lalu impor ulang.'],
  ['7.', 'Sheet "7. Saldo Awal Akun" — saldo per cut-off untuk Kas, Bank, pendapatan & beban'],
  ['', 'tahun berjalan, cadangan, modal, utang. Kode akun ada di sheet "Daftar Akun". Piutang,'],
  ['', 'simpanan, berjangka, dan aset TIDAK ditulis di sini — terisi otomatis dari sheet 1–6.'],
  ['8.', 'Hapus baris CONTOH di setiap sheet, lalu simpan berkas.'],
  ['9.', 'Buka aplikasi: Pengaturan > Import Data Awal > Pilih Berkas Excel.'],
  [],
  ['ATURAN PENGISIAN'],
  ['•', 'Kolom bertanda * wajib diisi. Kolom lain boleh dikosongkan.'],
  ['•', 'Urutan kolom boleh Anda ubah, dan nama kolom tidak harus sama persis —'],
  ['', 'aplikasi mencari kolom berdasarkan namanya, bukan posisinya.'],
  ['•', 'Tanggal boleh ditulis 01/01/2026, 2026-01-01, atau memakai format tanggal Excel.'],
  ['•', 'Nominal boleh ditulis 1000000, 1.000.000, atau Rp 1.000.000. Jangan pakai rumus.'],
  ['•', 'Satu Kode Anggota hanya boleh muncul SEKALI di sheet "1. Anggota" dan di sheet "6. Jasa Dibayar".'],
  ['•', 'Baris kosong diabaikan — aman bila ada sela antar-kelompok data.'],
  [],
  ['KESALAHAN YANG SERING TERJADI'],
  ['×', 'Jumlah Pinjaman diisi SISA pinjaman — yang benar pokok awal saat dicairkan.'],
  ['×', 'Angsuran Sudah Dibayar diisi rupiah — yang benar banyaknya angsuran (mis. 5).'],
  ['×', 'Sheet 2 diisi daftar setoran bulanan — untuk saldo lama cukup SATU baris saldo per anggota.'],
  ['×', 'Piutang pinjaman, simpanan, atau aset ditulis lagi di sheet 7 — akun itu sudah otomatis.'],
  ['×', 'Tanggal pada/setelah cut-off — baris itu diproses sebagai transaksi baru (kas ikut bergerak).'],
  ['×', 'Baris CONTOH (kuning) lupa dihapus — import ditahan sampai baris itu dihapus.'],
  [],
  ['YANG DILAKUKAN APLIKASI'],
  ['', 'Di layar import Anda memilih "Isi berkas ini". Hasilnya berbeda:'],
  [],
  ['A.', 'SALDO LAMA KOPERASI YANG SUDAH BERJALAN (bawaan — pilih ini untuk data awal)'],
  ['•', 'Nomor anggota dibuat OTOMATIS oleh aplikasi.'],
  ['•', 'Simpanan, simpanan berjangka & pinjaman lama dicatat di buku pembantu TANPA jurnal kas: kas TIDAK'],
  ['', 'bertambah karena simpanan lama dan TIDAK berkurang karena pinjaman lama — uangnya sudah lama bergerak.'],
  ['•', 'Bunga simpanan berjangka sebelum cut-off dianggap sudah masuk Simpanan Sukarela di sheet 2.'],
  ['•', 'Pinjaman: sisa pokok, jadwal, dan tunggakan dihitung dari "Angsuran Sudah Dibayar".'],
  ['', 'Angsuran yang sudah dibayar TIDAK dicatat satu per satu — karena itu jasanya diisi di sheet 6.'],
  ['•', 'Saldo Awal Akun untuk Piutang Pinjaman, Piutang Jasa, Simpanan, Simpanan Berjangka, dan Aset'],
  ['', 'Tetap diisi OTOMATIS.'],
  ['•', 'Kas/Bank, pendapatan & beban tahun berjalan sampai cut-off (mis. Pendapatan Jasa Pinjaman),'],
  ['', 'cadangan/modal, utang, dan akun lainnya diisi dari sheet 7 (atau sendiri di menu Saldo Awal).'],
  ['', 'Setelah import, layar menampilkan saldo "Saldo Awal Belum Sesuai" — harus Rp0.'],
  ['', 'SHU Basis Kas: saldo awal pendapatan & beban dianggap tunai, KECUALI beban non-kas (penyusutan,'],
  ['', 'amortisasi, penyisihan, bunga simpanan). Atur lewat kolom Bagian Tunai di sheet 7 atau tombol "Ubah".'],
  [],
  ['B.', 'TRANSAKSI BARU YANG UANGNYA BERGERAK SEKARANG'],
  ['•', 'Simpanan dicatat sebagai penerimaan kas/bank, sehingga kas koperasi bertambah.'],
  ['•', 'Pinjaman dicairkan dari kas pada tanggal yang Anda isi, lalu angsuran yang sudah dibayar'],
  ['', 'dicatat satu per satu (jasanya otomatis ikut dasar SHU). Sheet 6 & 7 tidak dipakai.'],
  ['', 'Untuk pilihan ini unduh "Template Transaksi Baru" — isinya hanya sheet yang dipakai.'],
  ['•', 'Simpanan diproses LEBIH DULU daripada pinjaman: kas harus terisi sebelum pinjaman'],
  ['', 'bisa dicairkan, sama seperti keadaan sungguhnya.'],
  [],
  ['SEBELUM IMPORT'],
  ['•', 'Aplikasi menampilkan PRATINJAU lebih dulu: jumlah baris dan daftar kesalahan per baris.'],
  ['', 'Tidak ada data yang tersimpan sampai Anda menekan tombol Import.'],
  ['•', 'Disarankan membuat Backup dulu lewat Pengaturan > Backup & Restore.'],
];

/** Lebar kolom sheet Petunjuk. */
export const LEBAR_KOLOM_PETUNJUK = [4, 76];

/**
 * RC-S133.4.6 — petunjuk untuk "Template Transaksi Baru" (berkas terpisah).
 * Tidak memuat penjelasan saldo lama supaya tidak tertukar.
 */
export const BARIS_PETUNJUK_TRANSAKSI_BARU: string[][] = [
  ['IMPORT TRANSAKSI BARU KOPERASI'],
  [],
  ['Berkas ini untuk koperasi yang BARU berdiri, atau untuk mencatat transaksi yang uangnya'],
  ['memang bergerak lewat kas/bank koperasi. Setiap baris menjadi transaksi berjurnal biasa —'],
  ['hasilnya sama dengan bila diinput satu per satu lewat menu.'],
  [],
  ['LANGKAH PENGISIAN'],
  ['1.', 'Sheet "1. Anggota" — WAJIB diisi lebih dulu. "Kode Anggota" bebas Anda tentukan.'],
  ['2.', 'Sheet "2. Simpanan" — satu baris = satu setoran pada tanggalnya. Boleh banyak baris per'],
  ['', 'anggota (mis. simpanan wajib tiap bulan). Kas bertambah sebesar setoran.'],
  ['3.', 'Sheet "3. Pinjaman" — dicairkan dari kas pada Tanggal Pencairan, lalu "Angsuran Sudah'],
  ['', 'Dibayar" dicatat satu per satu pada tanggal jatuh temponya.'],
  ['4.', 'Sheet "4. Simpanan Berjangka" — penempatan baru; kas bertambah sebesar nominal.'],
  ['5.', 'Hapus baris CONTOH, simpan, lalu buka Pengaturan > Import Data Awal, pilih "Transaksi baru".'],
  ['', 'Penjelasan setiap kolom ada di bawah, dan muncul saat kursor diarahkan ke judul kolom (hijau).'],
  ['', 'Bila ada simpanan berjangka: atur Kebijakan Produk Simpanan Berjangka di aplikasi lebih dulu.'],
  [],
  ['TIDAK ADA DI TEMPLATE INI (input lewat menu biasa)'],
  ['•', 'Penarikan simpanan, beban/biaya, pembelian aset, pendapatan lain, dan pembayaran angsuran yang'],
  ['', 'tidak tepat pada tanggal jatuh tempo.'],
  [],
  ['ATURAN PENGISIAN'],
  ['•', 'Kolom bertanda * wajib diisi. Urutan & penulisan nama kolom boleh berbeda.'],
  ['•', 'Tanggal boleh 01/01/2026, 2026-01-01, atau format tanggal Excel. Nominal tanpa rumus.'],
  ['•', 'Simpanan diproses LEBIH DULU daripada pinjaman: kas harus cukup sebelum pinjaman dicairkan.'],
  [],
  ['Untuk koperasi yang SUDAH berjalan dan baru mulai memakai aplikasi, gunakan "Template Saldo Lama".'],
  ['Disarankan membuat Backup dulu lewat Pengaturan > Backup & Restore.'],
  [],
  ['PANDUAN KOLOM'],
  ...SHEET_TEMPLATE_TRANSAKSI_BARU.flatMap((sh) => [
    ['', `Sheet "${sh.nama}"`],
    ...sh.kolom.map((k) => ['•', `${judulKolomExcel(k)} — ${catatanJudulKolom(k)}`]),
  ]),
];

/**
 * RC-S133.4.7 — SHEET "Panduan Kolom".
 *
 * Satu tabel berisi SETIAP kolom setiap sheet: wajib/opsional, cara
 * mengisi, dan contoh. Diturunkan dari metadata kolom yang sama dengan
 * judul Excel & layar Struktur Template — tidak ada daftar kedua yang
 * bisa berbeda arah. Nama sheet ini tidak mengandung kata kunci sheet
 * data (anggota/simpanan/pinjaman/aset/jasa/saldo awal) sehingga
 * diabaikan oleh pembaca berkas.
 */
export const NAMA_SHEET_PANDUAN_KOLOM = 'Panduan Kolom';

/** Legenda satu baris di atas judul kolom setiap sheet data. */
export function legendaSheetData(jenis: JenisTemplateDataAwal): string {
  return (
    '* = wajib · baris kuning = CONTOH, hapus · arahkan kursor ke judul kolom untuk catatan · panduan: sheet ' +
    (jenis === 'SALDO_LAMA' ? '"Panduan Kolom"' : '"Petunjuk"')
  );
}

/** Teks catatan (comment) untuk judul kolom di Excel. */
export function catatanJudulKolom(k: KolomTemplate): string {
  const bagian: string[] = [k.wajib ? 'WAJIB diisi.' : 'Opsional.'];
  if (k.pilihan?.length) bagian.push(`Pilihan: ${k.pilihan.join(' / ')}.`);
  else if (k.format) bagian.push(`Format: ${k.format}.`);
  if (k.catatan) bagian.push(k.catatan);
  return bagian.join(' ');
}

export function barisPanduanKolom(sheets: { nama: string; keterangan: string; kolom: KolomTemplate[] }[]): (string | number)[][] {
  const out: (string | number)[][] = [
    ['PANDUAN KOLOM — cara mengisi setiap kolom'],
    ['Kolom WAJIB harus diisi pada setiap baris data. Kolom OPSIONAL boleh dikosongkan. Contoh hanya ilustrasi — jangan disalin.'],
    [],
    ['Sheet', 'Kolom', 'Wajib?', 'Cara mengisi', 'Contoh'],
  ];
  for (const sh of sheets) {
    sh.kolom.forEach((k, i) => {
      const cara: string[] = [];
      if (k.pilihan?.length) cara.push(`Isi salah satu: ${k.pilihan.join(', ')}.`);
      if (k.format) cara.push(`Format: ${k.format}.`);
      if (k.catatan) cara.push(k.catatan);
      out.push([
        i === 0 ? sh.nama : '',
        k.label,
        k.wajib ? 'WAJIB' : 'opsional',
        cara.join(' ') || '—',
        /contoh|hapus baris ini/i.test(String(k.contoh)) ? '' : k.contoh,
      ]);
    });
  }
  return out;
}

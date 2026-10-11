/**
 * ISI PANDUAN APLIKASI (DATA MURNI).
 * ============================================================
 * Dipakai komponen `PanduanSlide` (slide beranimasi) dan tab Panduan di
 * menu Bunga Simpanan Sukarela. Setiap slide menunjuk satu ilustrasi UI
 * (`IlustrasiUi`) yang digambar dengan komponen aplikasi — bukan file
 * gambar — sehingga selalu sesuai warna & tata letak KOPKU.
 */

export type JenisIlustrasi =
  | 'SAMBUTAN'
  | 'DASHBOARD'
  | 'DATA_ANGGOTA'
  | 'TRANSAKSI_RIWAYAT'
  | 'PENYESUAIAN'
  | 'LAPORAN'
  | 'PENGATURAN'
  | 'LANGKAH_AWAL'
  | 'BUNGA_RUMUS'
  | 'BUNGA_KEBIJAKAN'
  | 'BUNGA_AKRUAL'
  | 'BUNGA_HASIL'
  | 'BUNGA_KOREKSI'
  | 'BUNGA_JASA_MODAL';

export interface SlidePanduan {
  kunci: string;
  ilustrasi: JenisIlustrasi;
  /** Label kecil di atas judul (mis. "Langkah 1"). */
  label: string;
  judul: string;
  isi: string;
  /** Poin singkat (maks. 3) di bawah isi. */
  poin?: readonly string[];
}

/** Panduan singkat penggunaan aplikasi — tampil setelah setup administrasi & dari Dashboard. */
export const PANDUAN_APLIKASI: readonly SlidePanduan[] = [
  {
    kunci: 'sambutan',
    ilustrasi: 'SAMBUTAN',
    label: 'Selamat datang',
    judul: 'KOPKU siap membantu pembukuan koperasi Anda',
    isi: 'Simpanan, pinjaman, kas, penyesuaian akhir periode, sampai laporan keuangan — tercatat rapi dalam satu aplikasi, mengikuti SAK EP dan Juklat SOM 2025.',
  },
  {
    kunci: 'dashboard',
    ilustrasi: 'DASHBOARD',
    label: 'Dashboard',
    judul: 'Ringkasan koperasi dalam satu layar',
    isi: 'Total simpanan, pinjaman, anggota aktif, dan tunggakan langsung terlihat. Ketuk kartu mana pun untuk membuka rinciannya.',
    poin: ['Tarik layar ke bawah untuk memperbarui angka', 'Kartu Identitas Koperasi mengingatkan data yang belum lengkap'],
  },
  {
    kunci: 'data',
    ilustrasi: 'DATA_ANGGOTA',
    label: 'Tab Data',
    judul: 'Mulai dari data anggota',
    isi: 'Daftarkan anggota, lalu lengkapi data pengurus, pengawas, karyawan, dan unit usaha. Detail anggota menampilkan simpanan, pinjaman, dan bunga tabungannya.',
  },
  {
    kunci: 'transaksi',
    ilustrasi: 'TRANSAKSI_RIWAYAT',
    label: 'Tab Transaksi',
    judul: 'Catat transaksi, lihat riwayatnya',
    isi: 'Penerimaan, Pengeluaran, dan Penyesuaian dikelompokkan rapi. Setiap menu punya dua bagian: formulir transaksi baru dan Riwayat.',
    poin: ['Ketuk transaksi di Riwayat untuk melihat detail', 'Koreksi dan pembatalan dilakukan dari detail transaksi'],
  },
  {
    kunci: 'penyesuaian',
    ilustrasi: 'PENYESUAIAN',
    label: 'Akhir periode',
    judul: 'Penyesuaian sebelum tutup buku',
    isi: 'Kolektibilitas piutang, penyusutan, nilai wajar, dan bunga simpanan sukarela ada di Transaksi › Penyesuaian. Sebagian berjalan otomatis setiap akhir bulan.',
  },
  {
    kunci: 'laporan',
    ilustrasi: 'LAPORAN',
    label: 'Tab Laporan',
    judul: 'Laporan keuangan siap cetak',
    isi: 'Posisi Keuangan, Perhitungan Hasil Usaha, Arus Kas, Perubahan Ekuitas, dan CALK. Export ke PDF (format Juklat atau Standar), Excel, atau CSV.',
    poin: ['Mode komparatif membandingkan dua periode', 'Tanda tangan pengurus tercetak otomatis'],
  },
  {
    kunci: 'pengaturan',
    ilustrasi: 'PENGATURAN',
    label: 'Tab Pengaturan',
    judul: 'Amankan data Anda',
    isi: 'Buat cadangan secara rutin di Backup & Restore. Atur pengguna dan hak aksesnya di User Management dan Permission Matrix.',
  },
  {
    kunci: 'mulai',
    ilustrasi: 'LANGKAH_AWAL',
    label: 'Siap memulai',
    judul: 'Tiga langkah pertama',
    isi: 'Ikuti urutan ini agar pembukuan langsung benar sejak awal. Panduan ini dapat dibuka kembali kapan saja dari Dashboard.',
    poin: ['1. Lengkapi Identitas Koperasi', '2. Masukkan saldo awal atau Import Data Awal', '3. Mulai catat transaksi harian'],
  },
];

/** Panduan bergambar menu Transaksi › Penyesuaian › Bunga Simpanan Sukarela. */
export const PANDUAN_BUNGA_SUKARELA: readonly SlidePanduan[] = [
  {
    kunci: 'rumus',
    ilustrasi: 'BUNGA_RUMUS',
    label: 'Cara dihitung',
    judul: 'Bunga dari saldo setiap hari',
    isi: 'Bunga satu hari = saldo akhir hari × tarif tahunan ÷ 365. Seluruh hari dalam bulan dihitung, dan setoran atau penarikan berlaku mulai tanggal transaksinya.',
    poin: ['Saldo nol atau negatif tidak berbunga', 'Tahun kabisat tetap memakai 365 hari'],
  },
  {
    kunci: 'kebijakan',
    ilustrasi: 'BUNGA_KEBIJAKAN',
    label: 'Langkah 1',
    judul: 'Satu kebijakan: Bunga Simpanan Sukarela',
    isi: 'Buka tab Kebijakan, nyalakan "Bunga Simpanan Sukarela", isi tarif tahunan (paling tinggi 9%), pilih bulan mulai berlaku, lalu "Simpan Kebijakan". Metode selalu Saldo Harian.',
    poin: ['Berlaku paling awal bulan berikutnya; bulan yang sudah lewat tidak berubah', 'Saat OFF, histori dan tarif lama tetap tersimpan'],
  },
  {
    kunci: 'akrual',
    ilustrasi: 'BUNGA_AKRUAL',
    label: 'Langkah 2',
    judul: 'Bunga dibukukan otomatis setelah bulan selesai',
    isi: 'Tidak ada tombol yang perlu ditekan. Setelah sebuah bulan berakhir, bunganya dibukukan otomatis saat aplikasi dibuka, kembali aktif, atau saat menu ini dibuka; bulan berjalan tidak pernah diakru. Statusnya terlihat di tab Akrual.',
    poin: ['Bunga neto langsung menambah saldo sukarela anggota', 'PPh dihitung otomatis oleh mesin pajak KOPKU'],
  },
  {
    kunci: 'hasil',
    ilustrasi: 'BUNGA_HASIL',
    label: 'Langkah 3',
    judul: 'Periksa hasilnya',
    isi: 'Riwayat akrual menampilkan bruto, PPh, dan neto setiap bulan. Ketuk "Lihat rincian" untuk per anggota, lalu Export ke PDF atau Excel.',
    poin: ['Detail Anggota menampilkan bunga hari ini dan bulan berjalan'],
  },
  {
    kunci: 'koreksi',
    ilustrasi: 'BUNGA_KOREKSI',
    label: 'Bila ada perubahan',
    judul: 'Koreksi otomatis, tanpa bunga ganda',
    isi: 'Setoran bertanggal mundur atau transaksi yang dibatalkan pada bulan yang sudah diakru akan dihitung ulang dan selisihnya dibukukan sebagai "Koreksi" di akrual berikutnya.',
    poin: ['Akrual hanya dapat dibatalkan dari bulan terakhir', 'Bulan yang dibatalkan dapat diakru ulang'],
  },
  {
    kunci: 'jasa-modal',
    ilustrasi: 'BUNGA_JASA_MODAL',
    label: 'Kebijakan SHU',
    judul: 'Perlakuan SHU ditentukan otomatis',
    isi: 'Tidak ada pengaturan terpisah. Selama bunga ON, simpanan sukarela tidak diperhitungkan sebagai basis jasa modal. Bila bunga OFF, perlakuannya mengikuti kebijakan pembagian SHU koperasi.',
    poin: ['Dikunci per tahun buku saat SHU pertama kali dihitung', 'Perubahan kebijakan tidak mengubah tahun buku yang sudah dikunci'],
  },
];

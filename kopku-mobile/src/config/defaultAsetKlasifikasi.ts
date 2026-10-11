/**
 * Master default Kelompok/Sub Kelompok Aset Tetap (Phase 18 §14-19,
 * permintaan pengguna) — SEBELUMNYA `aset_klasifikasi` sengaja dimulai
 * kosong (lihat komentar lama di AsetKlasifikasiService.ts), sekarang
 * diisi 4 kelompok utama + sub-kelompoknya sesuai daftar yang diberikan
 * pengguna. Admin TETAP bisa menambah/menonaktifkan/mengubah masa
 * manfaat lewat layar "Data Klasifikasi Aset" (tambahAsetKlasifikasi/
 * editAsetKlasifikasi di AsetKlasifikasiService.ts — TIDAK diubah,
 * cuma titik awalnya sekarang tidak kosong).
 *
 * "Kelompok Lainnya" (§19) SENGAJA TIDAK di-seed sebagai baris tetap
 * di sini — kolom `kelompok` di `aset_klasifikasi` sudah berupa TEXT
 * bebas (bukan enum kaku), jadi admin/pengguna sudah bisa langsung
 * menambah kelompok+sub-kelompok custom dengan masa manfaat sendiri
 * lewat `tambahAsetKlasifikasi()` yang sudah ada — tidak perlu baris
 * placeholder "Kelompok Lainnya" yang kosong maknanya. UI Data
 * Klasifikasi Aset & form Pembelian Aset yang menyediakan jalur
 * pintas "+ Kelompok Lainnya (custom)" ke alur tambah yang sama.
 */

export interface DefaultAsetKlasifikasiSeed {
  kelompok: string;
  subKelompok: string;
  /**
   * Audit ulang (permintaan pengguna §18): SEKARANG boleh `null` —
   * dulu wajib `number` (semua kelompok punya masa manfaat pasti).
   * Kelompok 5 ("Lainnya") sengaja TIDAK punya masa manfaat default
   * yang pasti (bisa sangat beragam), jadi `null` di sini berarti
   * "belum ditentukan", BUKAN 0 bulan (0 bulan akan salah secara
   * akuntansi — aset tidak boleh disusutkan dengan masa manfaat 0).
   * Kelompok 1-4 TETAP wajib berupa angka > 0 seperti sebelumnya.
   */
  masaManfaatBulanDefault: number | null;
}

export const DEFAULT_ASET_KLASIFIKASI: DefaultAsetKlasifikasiSeed[] = [
  // ============================================================
  // KELOMPOK 1 — masa manfaat 48 bulan
  // ============================================================
  { kelompok: 'Kelompok 1', subKelompok: 'Mebel dan peralatan dari kayu atau rotan', masaManfaatBulanDefault: 48 },
  { kelompok: 'Kelompok 1', subKelompok: 'Mesin kantor', masaManfaatBulanDefault: 48 },
  { kelompok: 'Kelompok 1', subKelompok: 'Perlengkapan lainnya', masaManfaatBulanDefault: 48 },
  { kelompok: 'Kelompok 1', subKelompok: 'Sepeda motor, sepeda, dan becak', masaManfaatBulanDefault: 48 },
  {
    kelompok: 'Kelompok 1',
    subKelompok: 'Alat perlengkapan khusus (tools) bagi industri atau jasa yang bersangkutan',
    masaManfaatBulanDefault: 48,
  },
  { kelompok: 'Kelompok 1', subKelompok: 'Dies, jigs, dan mould', masaManfaatBulanDefault: 48 },
  { kelompok: 'Kelompok 1', subKelompok: 'Alat-alat komunikasi', masaManfaatBulanDefault: 48 },
  {
    kelompok: 'Kelompok 1',
    subKelompok: 'Alat pertanian, perkebunan, kehutanan yang digerakkan bukan dengan mesin',
    masaManfaatBulanDefault: 48,
  },
  { kelompok: 'Kelompok 1', subKelompok: 'Mesin ringan yang dapat dipindah-pindahkan', masaManfaatBulanDefault: 48 },
  {
    kelompok: 'Kelompok 1',
    subKelompok: 'Mobil taksi, bus, dan truk yang digunakan sebagai angkutan umum',
    masaManfaatBulanDefault: 48,
  },
  { kelompok: 'Kelompok 1', subKelompok: 'Peralatan/alat lain yang termasuk Kelompok 1', masaManfaatBulanDefault: 48 },

  // ============================================================
  // KELOMPOK 2 — masa manfaat 96 bulan
  // ============================================================
  { kelompok: 'Kelompok 2', subKelompok: 'Mebel dan peralatan dari logam', masaManfaatBulanDefault: 96 },
  { kelompok: 'Kelompok 2', subKelompok: 'Mobil, bus, truk, speed boat, dan sejenisnya', masaManfaatBulanDefault: 96 },
  { kelompok: 'Kelompok 2', subKelompok: 'Alat pengatur udara', masaManfaatBulanDefault: 96 },
  {
    kelompok: 'Kelompok 2',
    subKelompok: 'Mesin pertanian, perkebunan, perikanan, dan kehutanan',
    masaManfaatBulanDefault: 96,
  },
  { kelompok: 'Kelompok 2', subKelompok: 'Mesin pengolahan', masaManfaatBulanDefault: 96 },
  { kelompok: 'Kelompok 2', subKelompok: 'Mesin yang mengolah produk nabati', masaManfaatBulanDefault: 96 },
  {
    kelompok: 'Kelompok 2',
    subKelompok: 'Mesin yang menghasilkan atau memproduksi minuman dan bahan-bahan minuman segala jenis',
    masaManfaatBulanDefault: 96,
  },
  {
    kelompok: 'Kelompok 2',
    subKelompok: 'Mesin yang menghasilkan atau memproduksi makanan dan bahan-bahan makanan segala jenis',
    masaManfaatBulanDefault: 96,
  },
  { kelompok: 'Kelompok 2', subKelompok: 'Mesin dan peralatan penebangan kayu', masaManfaatBulanDefault: 96 },
  {
    kelompok: 'Kelompok 2',
    subKelompok: 'Mesin yang mengolah atau menghasilkan atau memproduksi bahan atau barang kehutanan',
    masaManfaatBulanDefault: 96,
  },
  {
    kelompok: 'Kelompok 2',
    subKelompok: 'Peralatan konstruksi truk berat, dump truck, crane, bulldozer, dan sejenisnya',
    masaManfaatBulanDefault: 96,
  },

  // ============================================================
  // KELOMPOK 3 — masa manfaat 192 bulan.
  // Audit ulang (permintaan pengguna §17): placeholder "Sub Kelompok
  // Lainnya (tambahkan sesuai kebutuhan)" DIHAPUS, diganti 3 sub
  // kelompok sungguhan sesuai daftar yang diberikan pengguna. Masa
  // manfaat default TETAP 192 bulan (masa manfaat Kelompok 3 yang
  // sudah dipakai aplikasi, TIDAK diubah). Admin tetap bisa menambah
  // sub-kelompok lain lewat "Data Klasifikasi Aset" seperti biasa.
  // ============================================================
  { kelompok: 'Kelompok 3', subKelompok: 'Mesin pengolah pemintalan, pertenunan, dan pencelupan', masaManfaatBulanDefault: 192 },
  { kelompok: 'Kelompok 3', subKelompok: 'Mesin pengolah perkayuan', masaManfaatBulanDefault: 192 },
  { kelompok: 'Kelompok 3', subKelompok: 'Mesin dan peralatan penggergajian', masaManfaatBulanDefault: 192 },

  // ============================================================
  // KELOMPOK 4 — Bangunan
  // ============================================================
  { kelompok: 'Kelompok 4', subKelompok: 'Bangunan Permanen', masaManfaatBulanDefault: 240 },
  { kelompok: 'Kelompok 4', subKelompok: 'Bangunan Tidak Permanen', masaManfaatBulanDefault: 120 },

  // ============================================================
  // KELOMPOK 5 — Lainnya (permintaan pengguna §18). Masa manfaat
  // default SENGAJA `null` (opsional) — TIDAK dipaksa 0/1 bulan atau
  // angka default palsu lainnya, karena "Lainnya" mencakup aset yang
  // sangat beragam masa manfaatnya. Admin WAJIB mengisi masa manfaat
  // secara manual di form aset saat memilih Kelompok 5 (lihat validasi
  // di AsetService — aset yang akan disusutkan tidak boleh punya masa
  // manfaat 0/kosong).
  // ============================================================
  { kelompok: 'Kelompok 5', subKelompok: 'Lainnya', masaManfaatBulanDefault: null },
];

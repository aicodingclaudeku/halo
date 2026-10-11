/**
 * URUTAN PENYAJIAN LAPORAN POSISI KEUANGAN — SATU SUMBER (MURNI).
 * ============================================================
 * Dipindah dari `PosisiKeuanganScreen.tsx` supaya layar DAN export
 * (PDF/Excel/CSV, tunggal maupun komparatif) memakai urutan baris yang
 * SAMA PERSIS. Sebelumnya export memakai urutan kode akun mentah
 * sehingga PDF berbeda dari layar.
 *
 * PRESENTATION ONLY. Daftar ini TIDAK mengklasifikasikan akun sebagai
 * lancar/tidak lancar, TIDAK dipakai perhitungan apa pun, dan TIDAK
 * pernah menambah/menghapus baris. Total selalu dibaca dari hasil
 * `getPosisiKeuangan()` — bukan dari penjumlahan baris — sehingga urutan
 * ini secara struktural mustahil mengubah nilai.
 *
 * Akun yang TIDAK terdaftar disisipkan tepat setelah akun terdaftar
 * dengan kode terbesar yang masih <= kodenya (posisi relatif sama dengan
 * urutan kode akun sebelumnya).
 *
 * Riwayat posisi (dipertahankan):
 *  - RC-S49b: 1-1630/1-1640 tepat setelah Kas & Bank (di atas 1-1200).
 *  - RC-S53 §X: 1-1650 Deposito di bawah Piutang Jasa Pinjaman.
 *  - RC-S50 §5: RAKU di atas Aset Tetap.
 *  - Poin 11: RAKU (1-1800) kini TEPAT di bawah 1-1205 Piutang Jasa
 *    Pinjaman — tetap di atas Aset Tetap.
 *  - Juklat SOM 2025 (Lampiran contoh neraca): akun pengurang 1-1210
 *    Penyisihan Piutang tepat di bawah Piutang Pinjaman Anggota yang
 *    dikuranginya (RAKU tetap tepat di bawah Piutang Jasa Pinjaman).
 *  - Poin 9: baris SHU tahun berjalan TEPAT di bawah 3-2100 Cadangan
 *    Risiko. Baris SHU tidak punya kode akun (nilainya dari laba
 *    berjalan, bukan saldo 3-4000), jadi ia diberi kode penanda
 *    `KODE_BARIS_SHU_BERJALAN` yang terdaftar di urutan ekuitas.
 */

/** Kode penanda baris SHU/laba tahun berjalan pada penyajian ekuitas. */
export const KODE_BARIS_SHU_BERJALAN = '3-2100-SHU';

export const URUTAN_PENYAJIAN_ASET: readonly string[] = [
  '1-1000', // Kas
  '1-1100', // Bank
  '1-1630', // Tabungan pada Bank Umum
  '1-1640', // Giro pada Bank Umum
  '1-1200', // Piutang Pinjaman Anggota
  '1-1210', // Penyisihan Piutang (kontra) — tepat di bawah pinjaman yang dikuranginya, seperti Lampiran Juklat SOM 2025
  '1-1205', // Piutang Jasa Pinjaman
  '1-1800', // Rekening Antar Kantor/Unit (RAKU) — Poin 11: tepat di bawah Piutang Jasa Pinjaman
  '1-1650', // Deposito Berjangka (> 3 Bulan)
  '1-1400', // Biaya Dibayar Dimuka
  '1-1610', // Penyertaan pada Koperasi Lain
  '1-1620', // Investasi pada Usaha Lain
  '1-1900', // Penyisihan Penurunan Nilai Investasi (kontra) — tepat di bawah investasi yang dikuranginya
  '1-1660', // Properti Investasi
  '1-1500', // Aset Tetap
  '1-1510', // Akumulasi Penyusutan Aset Tetap (kontra)
  '1-1700', // Aset Tak Berwujud
  '1-1710', // Akumulasi Amortisasi Aset Tak Berwujud (kontra)
];

export const URUTAN_PENYAJIAN_EKUITAS: readonly string[] = [
  '3-1000', // Simpanan Pokok
  '3-1100', // Simpanan Wajib
  '3-1200', // Modal Tetap
  '3-1300', // Modal Tambahan
  '3-2000', // Cadangan Umum
  '3-2100', // Cadangan Risiko
  KODE_BARIS_SHU_BERJALAN, // Poin 9: baris SHU tahun berjalan tepat di bawah Cadangan Risiko
  '3-4000', // SHU Tahun Berjalan   <- sebelum Ekuitas Lainnya
  '3-3000', // Ekuitas Lainnya
  '3-5000', // Saldo Awal Belum Sesuai (Opening Balance Clearing)
];

/**
 * Mengurutkan baris untuk PENYAJIAN saja. Stabil, tidak menyaring, dan
 * selalu mengembalikan jumlah baris yang PERSIS SAMA dengan masukannya.
 */
export function urutkanUntukPenyajian<T extends { kode: string }>(rows: T[], urutan: readonly string[]): T[] {
  const peringkat = new Map(urutan.map((kode, i) => [kode, i]));
  const urutanTerurut = [...urutan].sort();
  const peringkatFallback = (kode: string): number => {
    let hasil = -1;
    for (const k of urutanTerurut) {
      if (k <= kode) hasil = peringkat.get(k) ?? hasil;
      else break;
    }
    return hasil;
  };
  return rows
    .map((row, indexAsli) => {
      const terdaftar = peringkat.get(row.kode);
      return {
        row,
        indexAsli,
        peringkat: terdaftar ?? peringkatFallback(row.kode),
        terdaftar: terdaftar !== undefined ? 0 : 1,
      };
    })
    .sort(
      (a, b) =>
        a.peringkat - b.peringkat ||
        a.terdaftar - b.terdaftar ||
        a.row.kode.localeCompare(b.row.kode) ||
        a.indexAsli - b.indexAsli
    )
    .map((x) => x.row);
}

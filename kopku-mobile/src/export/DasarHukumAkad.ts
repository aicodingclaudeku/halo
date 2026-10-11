/**
 * RC-S82 — DASAR HUKUM DOKUMEN PERJANJIAN PINJAMAN KOPERASI.
 * ============================================================
 * SATU tempat untuk seluruh rujukan peraturan pada dokumen perjanjian
 * (akad awal & akad ulang), supaya dapat ditinjau pengurus / penasihat
 * hukum koperasi tanpa menyentuh logika dokumen.
 *
 * Diverifikasi 24 September 2026:
 *  - UU 25/1992 tentang Perkoperasian MASIH BERLAKU. RUU Perubahan
 *    Keempat baru disetujui sebagai RUU usul inisiatif DPR (18 November
 *    2025) dan belum diundangkan; karena itu dirujuk "beserta
 *    perubahannya" (a.l. oleh UU 4/2023 P2SK) tanpa merinci rantai
 *    perubahan.
 *  - UU 25/1992 Pasal 30 ayat (2) huruf a: Pengurus berwenang mewakili
 *    Koperasi di dalam dan di luar pengadilan (dasar Ketua menandatangani
 *    atas nama koperasi).
 *  - Permenkop UKM No. 8 Tahun 2023 tentang Usaha Simpan Pinjam oleh Koperasi.
 * Bila peraturan berubah, PERBARUI DAFTAR INI (test mengunci isinya).
 */

export const DASAR_HUKUM_PERJANJIAN_PINJAMAN: readonly string[] = [
  'Kitab Undang-Undang Hukum Perdata, khususnya Pasal 1320 tentang syarat sahnya perjanjian, Pasal 1338 tentang kekuatan mengikat perjanjian, dan Pasal 1754 tentang pinjam-meminjam;',
  'Undang-Undang Nomor 25 Tahun 1992 tentang Perkoperasian beserta perubahannya;',
  'Peraturan Menteri Koperasi dan Usaha Kecil dan Menengah Nomor 8 Tahun 2023 tentang Usaha Simpan Pinjam oleh Koperasi;',
  'Undang-Undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi;',
  'Undang-Undang Nomor 10 Tahun 2020 tentang Bea Meterai;',
  'Anggaran Dasar dan Anggaran Rumah Tangga Koperasi.',
];

/** Kewenangan Ketua bertindak atas nama koperasi. */
export const DASAR_KEWENANGAN_PENGURUS =
  'Pasal 30 ayat (2) huruf a Undang-Undang Nomor 25 Tahun 1992 tentang Perkoperasian dan Anggaran Dasar Koperasi';

/** Tarif bea meterai tunggal menurut UU 10/2020 (penanda TEKS tempat meterai — tanpa kotak; BUKAN meterai elektronik). */
export const LABEL_METERAI = 'Meterai Rp10.000';

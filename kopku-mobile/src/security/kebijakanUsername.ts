/**
 * RC-S119 — KEBIJAKAN USERNAME (MODUL MURNI).
 *
 * Username adalah yang DIKETIK ULANG setiap kali masuk, sementara nama
 * lengkap hanya dibaca. Keduanya sering disamakan saat pemasangan
 * pertama, dan akibatnya baru terasa berbulan-bulan kemudian: username
 * "Koperasi Maju Bersama" harus diketik persis, spasi dan huruf
 * besarnya sekalian, pada layar masuk yang tidak memberi petunjuk apa
 * pun ketika salah.
 *
 * Karena itu aturannya dijaga di sini, sebelum tersimpan — bukan
 * disesali sesudahnya:
 *   - panjang wajar, tidak kosong;
 *   - tanpa spasi (sumber "sudah benar tapi ditolak" yang paling sering
 *     dan paling tidak mungkin didiagnosis pengguna sendiri);
 *   - hanya huruf, angka, titik, garis bawah, dan tanda hubung.
 *
 * ------------------------------------------------------------
 * KENAPA TIDAK DIUBAH KE HURUF KECIL
 * ------------------------------------------------------------
 * Menyimpan versi huruf kecil terasa rapi, tetapi `AuthService.login()`
 * mencocokkan `username = ?` PERSIS. Menormalkan di satu sisi saja
 * membuat username yang diketik "Admin" tidak pernah cocok dengan yang
 * tersimpan "admin" — kegagalan masuk yang penyebabnya tak terlihat di
 * layar mana pun. Jadi yang dilakukan hanya memangkas ujung, dan
 * apa yang diketik pengguna itulah yang tersimpan.
 */

export const PANJANG_MIN_USERNAME = 3;
export const PANJANG_MAKS_USERNAME = 32;

/** Huruf, angka, titik, garis bawah, tanda hubung. Sengaja tanpa spasi. */
const POLA_USERNAME = /^[A-Za-z0-9._-]+$/;

export type MasalahUsername =
  | 'KOSONG'
  | 'TERLALU_PENDEK'
  | 'TERLALU_PANJANG'
  | 'ADA_SPASI'
  | 'KARAKTER_TIDAK_DIIZINKAN';

export const PESAN_MASALAH_USERNAME: Record<MasalahUsername, string> = {
  KOSONG: 'Username wajib diisi.',
  TERLALU_PENDEK: `Username minimal ${PANJANG_MIN_USERNAME} karakter.`,
  TERLALU_PANJANG: `Username maksimal ${PANJANG_MAKS_USERNAME} karakter.`,
  ADA_SPASI: 'Username tidak boleh mengandung spasi.',
  KARAKTER_TIDAK_DIIZINKAN: 'Username hanya boleh huruf, angka, titik, garis bawah, dan tanda hubung.',
};

export interface HasilPeriksaUsername {
  sah: boolean;
  masalah: MasalahUsername[];
  /** Pesan pertama — yang ditampilkan di bawah kotak isian. */
  pesan: string | null;
}

/** Bentuk username yang disimpan: ujungnya dipangkas, isinya utuh. */
export function rapikanUsername(username: string): string {
  return (username ?? '').trim();
}

export function periksaUsername(username: string): HasilPeriksaUsername {
  const bersih = rapikanUsername(username);
  const masalah: MasalahUsername[] = [];

  if (bersih.length === 0) {
    masalah.push('KOSONG');
  } else {
    if (bersih.length < PANJANG_MIN_USERNAME) masalah.push('TERLALU_PENDEK');
    if (bersih.length > PANJANG_MAKS_USERNAME) masalah.push('TERLALU_PANJANG');
    /*
     * Spasi diperiksa SENDIRI, sebelum pemeriksaan karakter umum.
     * Keduanya akan sama-sama menolak, tetapi "tidak boleh ada spasi"
     * langsung menunjuk pada apa yang salah, sementara daftar karakter
     * yang diizinkan menyuruh pengguna membandingkannya satu per satu.
     */
    if (/\s/.test(bersih)) masalah.push('ADA_SPASI');
    else if (!POLA_USERNAME.test(bersih)) masalah.push('KARAKTER_TIDAK_DIIZINKAN');
  }

  return {
    sah: masalah.length === 0,
    masalah,
    pesan: masalah.length > 0 ? PESAN_MASALAH_USERNAME[masalah[0]] : null,
  };
}

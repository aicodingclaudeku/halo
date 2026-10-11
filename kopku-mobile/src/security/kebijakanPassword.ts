/**
 * RC-S117 — KEBIJAKAN PASSWORD (MODUL MURNI).
 *
 * ============================================================
 * KENAPA PASSWORD, DAN KENAPA TERPISAH DARI PIN
 * ============================================================
 * Sampai RC-S116, PIN 6 digit merangkap DUA peran yang sebenarnya
 * berbeda:
 *
 *   1. KREDENSIAL MASUK — membuktikan "saya Bendahara Siti", dipakai
 *      saat login dengan username;
 *   2. KUNCI LAYAR APLIKASI — membuka kembali sesi yang sedang terkunci
 *      di perangkat yang SUDAH dipegang orangnya.
 *
 * Untuk peran kedua, 6 digit memang memadai: penyerang harus sudah
 * memegang ponselnya, dan percobaannya dibatasi. Untuk peran pertama
 * tidak: ruang tebakannya hanya sejuta, dan ia menjadi satu-satunya
 * hal yang memisahkan seorang petugas dari wewenang Admin atas seluruh
 * buku besar koperasi.
 *
 * Sejak RC-S117 keduanya dipisah: PASSWORD untuk masuk, PIN hanya untuk
 * membuka kunci aplikasi.
 *
 * ============================================================
 * KENAPA ATURANNYA SEPERTI INI
 * ============================================================
 * Aturan password yang terlalu rewel justru menurunkan keamanan: orang
 * menulisnya di kertas yang ditempel di monitor, atau memakai
 * "Password1!" di semua tempat. Yang dipakai di sini hanya tiga syarat
 * yang benar-benar menutup pola paling rapuh, tanpa memaksa simbol yang
 * sulit diketik di papan ketik ponsel:
 *
 *   - panjang minimal 8 karakter — batas terendah yang masih masuk akal
 *     untuk melawan penebakan, apalagi hash-nya scrypt;
 *   - tidak boleh hanya angka — kalau boleh, orang akan menulis PIN
 *     lamanya dan seluruh pemisahan ini tidak menghasilkan apa-apa;
 *   - tidak boleh sama dengan username — kredensial yang setengahnya
 *     sudah tertulis di layar login bukan kredensial.
 */

export const PANJANG_MIN_PASSWORD = 8;
export const PANJANG_MAKS_PASSWORD = 128;

export type MasalahPassword =
  | 'KOSONG'
  | 'TERLALU_PENDEK'
  | 'TERLALU_PANJANG'
  | 'HANYA_ANGKA'
  | 'SAMA_DENGAN_USERNAME'
  | 'KONFIRMASI_TIDAK_COCOK';

export const PESAN_MASALAH_PASSWORD: Record<MasalahPassword, string> = {
  KOSONG: 'Password wajib diisi.',
  TERLALU_PENDEK: `Password minimal ${PANJANG_MIN_PASSWORD} karakter.`,
  TERLALU_PANJANG: `Password maksimal ${PANJANG_MAKS_PASSWORD} karakter.`,
  HANYA_ANGKA: 'Password tidak boleh hanya angka — itu PIN, bukan password. PIN dipakai terpisah untuk membuka kunci aplikasi.',
  SAMA_DENGAN_USERNAME: 'Password tidak boleh sama dengan username.',
  KONFIRMASI_TIDAK_COCOK: 'Konfirmasi password tidak sama.',
};

export interface HasilPeriksaPassword {
  sah: boolean;
  masalah: MasalahPassword[];
  /** Pesan pertama — yang ditampilkan di bawah kotak isian. */
  pesan: string | null;
}

/**
 * Periksa password. `konfirmasi` opsional supaya fungsi ini juga dapat
 * dipakai di tempat yang hanya punya satu kotak isian.
 *
 * Spasi di TENGAH password dibiarkan (ia menambah ruang tebakan dan
 * memang sah), tetapi spasi di UJUNG dipangkas lebih dulu: spasi yang
 * tidak terlihat di ujung adalah sumber "password saya benar tapi
 * ditolak" yang tidak mungkin didiagnosis pengguna sendiri.
 */
export function periksaPassword(input: {
  password: string;
  konfirmasi?: string;
  username?: string;
}): HasilPeriksaPassword {
  const password = (input.password ?? '').trim();
  const masalah: MasalahPassword[] = [];

  if (password.length === 0) {
    masalah.push('KOSONG');
  } else {
    if (password.length < PANJANG_MIN_PASSWORD) masalah.push('TERLALU_PENDEK');
    if (password.length > PANJANG_MAKS_PASSWORD) masalah.push('TERLALU_PANJANG');
    if (/^\d+$/.test(password)) masalah.push('HANYA_ANGKA');
    if (input.username && password.toLowerCase() === input.username.trim().toLowerCase()) {
      masalah.push('SAMA_DENGAN_USERNAME');
    }
  }

  if (input.konfirmasi !== undefined && password !== (input.konfirmasi ?? '').trim()) {
    masalah.push('KONFIRMASI_TIDAK_COCOK');
  }

  return {
    sah: masalah.length === 0,
    masalah,
    pesan: masalah.length > 0 ? PESAN_MASALAH_PASSWORD[masalah[0]] : null,
  };
}

/**
 * Bentuk password yang disimpan — dipangkas ujungnya, isi tengah utuh.
 * Dipakai BAIK saat menyimpan MAUPUN saat memeriksa, supaya keduanya
 * tidak pernah menyimpang.
 */
export function rapikanPassword(password: string): string {
  return (password ?? '').trim();
}

/**
 * Kekuatan kasar untuk umpan balik di layar. Bukan penentu diterima
 * atau tidak — itu tugas `periksaPassword()` — melainkan dorongan
 * supaya orang tidak berhenti tepat di batas minimum.
 */
export type TingkatKekuatan = 'LEMAH' | 'CUKUP' | 'KUAT';

export const LABEL_KEKUATAN: Record<TingkatKekuatan, string> = {
  LEMAH: 'Lemah',
  CUKUP: 'Cukup',
  KUAT: 'Kuat',
};

export function kekuatanPassword(password: string): TingkatKekuatan {
  const p = rapikanPassword(password);
  let ragam = 0;
  if (/[a-z]/.test(p)) ragam++;
  if (/[A-Z]/.test(p)) ragam++;
  if (/\d/.test(p)) ragam++;
  if (/[^A-Za-z0-9]/.test(p)) ragam++;

  if (p.length >= 12 && ragam >= 3) return 'KUAT';
  if (p.length >= 10 && ragam >= 2) return 'CUKUP';
  if (p.length >= PANJANG_MIN_PASSWORD && ragam >= 2) return 'CUKUP';
  return 'LEMAH';
}

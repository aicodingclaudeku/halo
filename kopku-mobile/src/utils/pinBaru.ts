/**
 * RC-S131 — validasi PIN baru di layar Keamanan (murni, tanpa I/O).
 *
 * Aturan format (6 digit angka) SAMA dengan `aturPinKunciAplikasi`;
 * service tetap menolak sendiri. Tambahannya hanya penolakan PIN yang
 * terlalu mudah ditebak, karena PIN 6 digit hanya punya sejuta
 * kemungkinan dan pola seperti 123456 / 111111 dicoba lebih dulu oleh
 * siapa pun yang menebak.
 */

export const PANJANG_PIN = 6;

/** true untuk 111111, 123456, 234567, 987654, dst. */
export function pinTerlaluMudah(pin: string): boolean {
  if (!/^\d{6}$/.test(pin)) return false;
  const d = pin.split('').map(Number);
  const sama = d.every((x) => x === d[0]);
  const naik = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  const turun = d.every((x, i) => i === 0 || x === d[i - 1] - 1);
  return sama || naik || turun;
}

export interface HasilValidasiPinBaru {
  /** Pesan untuk kolom PIN baru (null = baik). */
  galatPin: string | null;
  /** Pesan untuk kolom konfirmasi (null = baik / belum diisi lengkap). */
  galatKonfirmasi: string | null;
  /** Konfirmasi sudah lengkap dan sama persis. */
  cocok: boolean;
  bolehSimpan: boolean;
}

export function validasiPinBaru(pin: string, konfirmasi: string): HasilValidasiPinBaru {
  let galatPin: string | null = null;
  if (pin.length === PANJANG_PIN && !/^\d{6}$/.test(pin)) galatPin = 'PIN harus 6 digit angka.';
  else if (pinTerlaluMudah(pin)) galatPin = 'PIN terlalu mudah ditebak. Hindari angka berurutan atau angka yang sama semua.';
  const lengkap = konfirmasi.length === PANJANG_PIN;
  const cocok = lengkap && pin.length === PANJANG_PIN && konfirmasi === pin;
  const galatKonfirmasi = lengkap && !cocok ? 'Konfirmasi PIN berbeda dengan PIN baru.' : null;
  return { galatPin, galatKonfirmasi, cocok, bolehSimpan: pin.length === PANJANG_PIN && !galatPin && cocok };
}

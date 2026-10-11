/**
 * RC-S125 — PLATFORM PERANGKAT untuk pembagian slot lisensi.
 *
 * Satu lisensi KOPKU berlaku untuk 1 HP/Tablet + 1 Laptop/PC. Server
 * membedakan keduanya dari field `device_platform` yang dikirim saat
 * aktivasi. Nilainya dipilih Metro lewat ekstensi platform
 * (`devicePlatform.android.ts`, `.ios.ts`, `.windows.ts`, `.macos.ts`,
 * `.web.ts`) — tanpa mengimpor `react-native` ke LicenseService, sehingga
 * suite Jest (lingkungan Node) tetap bisa memuat service tersebut.
 *
 * Berkas ini adalah fallback (dipakai Jest & typecheck). Server
 * memperlakukan 'unknown' sebagai HP, sama seperti aplikasi versi lama.
 */
export function getDevicePlatform(): string {
  return 'unknown';
}

/**
 * KONFIGURASI TERPUSAT SISTEM LISENSI KOPKU
 * =========================================================================
 *
 * Semua angka kebijakan lisensi HANYA boleh didefinisikan di berkas ini.
 * Tidak ada service/screen yang boleh menuliskan ulang konstanta ini
 * (alasan sama dengan `resolveAccountId()` di domain akuntansi: satu
 * sumber kebenaran, supaya perubahan kebijakan tidak perlu diburu ke
 * belasan berkas dan tidak bisa berbeda-beda antar-lapisan).
 *
 * PENTING — TIDAK ADA SECRET DI BERKAS INI.
 * Berkas ini ikut ter-bundle ke dalam APK/AAB dan BISA dibaca siapa pun
 * yang membongkar aplikasi. Karena itu:
 *   - BOLEH  : base URL, batas waktu, public verification key.
 *   - DILARANG: TOKEN_SIGNING_SECRET, LICENSE_HMAC_SECRET, DB_PASSWORD,
 *               ADMIN_SETUP_TOKEN, atau "API secret" statis apa pun.
 * Lihat §20 & §28 master command.
 */

/** Base URL API lisensi. HTTPS saja — TIDAK ADA fallback HTTP (§21). */
export const LICENSE_API_BASE = 'https://koperasikufinanace.my.id/api' as const;

/**
 * Berapa lama aplikasi boleh dipakai tanpa berhasil menghubungi server
 * verifikasi, dihitung sejak verifikasi server SUKSES terakhir (§8).
 *
 * Ini BUKAN "offline berapa lama": aplikasi tetap 100% offline-first.
 * Ini adalah umur maksimum bukti "server masih mengakui lisensi ini".
 */
export const LICENSE_OFFLINE_GRACE_PERIOD_DAYS = 7;

/**
 * Jarak minimal antar-verifikasi ke server (§13). Verifikasi TIDAK
 * dijalankan setiap render — hanya saat startup bila sudah jatuh tempo,
 * setelah aktivasi, dan saat user menekan "Coba Verifikasi Lagi".
 */
export const LICENSE_VERIFY_INTERVAL_HOURS = 24;

/**
 * Ambang "grace period hampir habis". Bila sisa grace period di bawah
 * angka ini, aplikasi boleh mencoba verifikasi lebih agresif daripada
 * LICENSE_VERIFY_INTERVAL_HOURS (§13 poin terakhir).
 */
export const LICENSE_VERIFY_URGENT_REMAINING_HOURS = 48;

/** Timeout satu request HTTP ke license server, milidetik (§21). */
export const LICENSE_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Toleransi selisih jam perangkat, milidetik (§9).
 *
 * Jam perangkat wajar meleset beberapa menit (drift NTP, zona waktu baru
 * dipasang, boot tanpa RTC). Mundur DI BAWAH toleransi ini dianggap noise;
 * mundur DI ATAS toleransi ini dianggap rollback yang disengaja.
 */
export const LICENSE_CLOCK_ROLLBACK_TOLERANCE_MS = 10 * 60 * 1000; // 10 menit

/**
 * Toleransi token yang `iat`-nya berada di MASA DEPAN dibanding jam
 * perangkat (§5 poin 9). Server memakai UTC; perangkat bisa tertinggal
 * beberapa menit. Lebih dari ini = token/jam tidak masuk akal.
 */
export const LICENSE_TOKEN_IAT_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000; // 24 jam

/** Tipe lisensi yang dikenal server (lihat api/activate.php). */
export const LICENSE_TYPES = ['PERMANENT', 'TRIAL_3D', 'TRIAL_7D', 'TRIAL_1M'] as const;
export type LicenseType = (typeof LICENSE_TYPES)[number];

export function isKnownLicenseType(value: unknown): value is LicenseType {
  return typeof value === 'string' && (LICENSE_TYPES as readonly string[]).includes(value);
}

/** Format license key yang diterima server (includes/LicenseKey.php). */
export const LICENSE_KEY_PATTERN = /^KPK(-[A-Z0-9]{4}){4}$/;

export const LICENSE_GRACE_PERIOD_MS = LICENSE_OFFLINE_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
export const LICENSE_VERIFY_INTERVAL_MS = LICENSE_VERIFY_INTERVAL_HOURS * 60 * 60 * 1000;

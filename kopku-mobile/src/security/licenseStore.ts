/**
 * PENYIMPANAN STATE LISENSI — SecureStore SAJA
 * =========================================================================
 *
 * §4 & §16 master command: activation token TIDAK BOLEH berada di
 * AsyncStorage maupun SQLite. Semua yang ada di berkas ini disimpan di
 * `expo-secure-store`, yang di Android didukung Keystore dan di iOS
 * Keychain.
 *
 * Konsekuensi praktis yang penting untuk diketahui: menghapus data
 * aplikasi lewat Setelan Android JUGA menghapus SecureStore. Itu
 * memang membuat lisensi lokal hilang — tetapi TIDAK memberi keuntungan
 * apa pun kepada penyerang: hasilnya perangkat kembali ke layar
 * aktivasi, bukan masuk ke aplikasi. Menghapus state di sini hanya bisa
 * MEMPERKETAT, tidak pernah memperlonggar (lihat `licenseClock.ts`
 * untuk kenapa itu juga berlaku pada high-water mark jam).
 *
 * Namespace key mengikuti §4 (`kopku_license_*`), ditambah beberapa key
 * operasional yang dibutuhkan §7/§9/§13.
 */

import * as SecureStore from 'expo-secure-store';
import type { LicenseType } from '@/config/license';

/** Status terakhir yang diketahui dari server (§22). */
export type LicenseServerStatus =
  | 'VALID'
  | 'LICENSE_REVOKED'
  | 'LICENSE_EXPIRED'
  | 'INVALID_LICENSE'
  | 'DEVICE_MISMATCH'
  | 'DEVICE_DEACTIVATED'
  | 'COOPERATIVE_MISMATCH';

const KEYS = {
  activationToken: 'kopku_license_activation_token',
  deviceId: 'kopku_license_device_id',
  licenseType: 'kopku_license_type',
  expiresAt: 'kopku_license_expires_at',
  activatedAt: 'kopku_license_activated_at',
  cooperativeName: 'kopku_license_cooperative_name',
  // --- operasional (§7, §9, §13) ---
  lastVerifiedAt: 'kopku_license_last_verified_at',
  lastServerTime: 'kopku_license_last_server_time',
  lastServerStatus: 'kopku_license_last_server_status',
  clockHighWater: 'kopku_license_clock_high_water',
  clockSuspicious: 'kopku_license_clock_suspicious',
  // Ditulis saat pengguna menonaktifkan lisensi dari perangkat ini.
  // Dipakai HANYA untuk membedakan "Anda melepasnya" dari "belum pernah
  // aktivasi" di layar — keduanya sama-sama menolak akses.
  deactivatedAt: 'kopku_license_deactivated_at',
} as const;

/** Semua key yang dimiliki modul lisensi — dipakai `clearLicense()`. */
export const LICENSE_STORAGE_KEYS: readonly string[] = Object.values(KEYS);

export interface StoredLicense {
  readonly activationToken: string;
  readonly deviceId: string;
  readonly licenseType: LicenseType | null;
  readonly expiresAt: string | null;
  readonly activatedAt: string | null;
  readonly cooperativeName: string | null;
  readonly lastVerifiedAtMs: number | null;
  readonly lastServerTimeMs: number | null;
  readonly lastServerStatus: LicenseServerStatus | null;
}

/**
 * Baca satu item. SecureStore melempar bila keystore rusak/terkunci;
 * kegagalan baca diperlakukan sebagai "tidak ada" (fail-closed: tanpa
 * token, aplikasi minta aktivasi — bukan membuka pintu).
 */
async function readItem(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function writeItem(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

async function removeItem(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // Menghapus yang tidak ada bukan kesalahan.
  }
}

async function readNumber(key: string): Promise<number | null> {
  const raw = await readItem(key);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Device ID
// ---------------------------------------------------------------------------

export async function readDeviceId(): Promise<string | null> {
  return readItem(KEYS.deviceId);
}

export async function writeDeviceId(deviceId: string): Promise<void> {
  await writeItem(KEYS.deviceId, deviceId);
}

// ---------------------------------------------------------------------------
// Token & metadata
// ---------------------------------------------------------------------------

export async function readActivationToken(): Promise<string | null> {
  return readItem(KEYS.activationToken);
}

export interface PersistLicenseInput {
  readonly activationToken: string;
  readonly deviceId: string;
  readonly licenseType: LicenseType;
  readonly expiresAt: string | null;
  readonly activatedAt: string | null;
  readonly cooperativeName: string | null;
}

/**
 * Simpan lisensi hasil aktivasi.
 *
 * Token ditulis TERAKHIR — disengaja. Bila proses mati di tengah
 * penulisan, yang tertinggal adalah metadata tanpa token, dan itu
 * dibaca sebagai "belum aktif". Urutan sebaliknya akan meninggalkan
 * token tanpa metadata, yang jauh lebih ambigu.
 */
export async function persistLicense(input: PersistLicenseInput): Promise<void> {
  // RC-S52 — BUKTI TENTANG TOKEN LAMA IKUT DIBUANG.
  //
  // `lastServerStatus` dan `lastVerifiedAt` adalah catatan tentang token
  // yang SEDANG DIGANTI, bukan tentang token baru ini. Membiarkannya
  // menghasilkan dua kegagalan berlawanan bila proses mati di antara
  // `persistLicense()` dan `recordServerVerification()` di
  // `activateLicense()`:
  //
  //   - `lastServerStatus` basi ("LICENSE_EXPIRED") membuat token baru
  //     yang sah dibaca sebagai EXPIRED selamanya — pengguna yang baru
  //     saja membayar perpanjangan tetap terkunci;
  //   - `lastVerifiedAt` basi memberi grace period kepada token baru
  //     berdasarkan verifikasi lisensi LAMA — itu pelonggaran.
  //
  // Dibuang lebih dulu, sehingga jendela crash berakhir di
  // NEEDS_VERIFICATION: tetap terkunci, tetapi "Coba Verifikasi Lagi"
  // dengan token BARU dapat memulihkannya tanpa license key kedua.
  // Pada jalur normal tidak ada perubahan perilaku — keduanya ditulis
  // ulang beberapa baris kemudian oleh `recordServerVerification()`.
  await removeItem(KEYS.lastServerStatus);
  await removeItem(KEYS.lastVerifiedAt);

  await writeItem(KEYS.deviceId, input.deviceId);
  await writeItem(KEYS.licenseType, input.licenseType);
  if (input.expiresAt === null) {
    await removeItem(KEYS.expiresAt);
  } else {
    await writeItem(KEYS.expiresAt, input.expiresAt);
  }
  if (input.activatedAt === null) {
    await removeItem(KEYS.activatedAt);
  } else {
    await writeItem(KEYS.activatedAt, input.activatedAt);
  }
  if (input.cooperativeName === null) {
    await removeItem(KEYS.cooperativeName);
  } else {
    await writeItem(KEYS.cooperativeName, input.cooperativeName);
  }
  await writeItem(KEYS.activationToken, input.activationToken);
}

export async function readStoredLicense(): Promise<StoredLicense | null> {
  const activationToken = await readItem(KEYS.activationToken);
  const deviceId = await readItem(KEYS.deviceId);
  if (!activationToken || !deviceId) return null;

  const licenseTypeRaw = await readItem(KEYS.licenseType);
  const statusRaw = await readItem(KEYS.lastServerStatus);

  return {
    activationToken,
    deviceId,
    licenseType: (licenseTypeRaw as LicenseType | null) ?? null,
    expiresAt: await readItem(KEYS.expiresAt),
    activatedAt: await readItem(KEYS.activatedAt),
    cooperativeName: await readItem(KEYS.cooperativeName),
    lastVerifiedAtMs: await readNumber(KEYS.lastVerifiedAt),
    lastServerTimeMs: await readNumber(KEYS.lastServerTime),
    lastServerStatus: (statusRaw as LicenseServerStatus | null) ?? null,
  };
}

/** Catat hasil verifikasi server. `lastVerifiedAt` HANYA maju saat VALID. */
export async function recordServerVerification(params: {
  readonly status: LicenseServerStatus;
  readonly atMs: number;
  readonly serverTimeMs: number | null;
}): Promise<void> {
  await writeItem(KEYS.lastServerStatus, params.status);
  if (params.status === 'VALID') {
    await writeItem(KEYS.lastVerifiedAt, String(params.atMs));
  }
  if (params.serverTimeMs !== null) {
    await writeItem(KEYS.lastServerTime, String(params.serverTimeMs));
  }
}

/**
 * Kunci yang TIDAK boleh ikut terhapus saat lisensi dilepas.
 *
 * GAP-1 (diperbaiki di RC-S36). Sebelumnya hanya `deviceId` yang
 * dipertahankan, sehingga menonaktifkan lisensi ikut menghapus
 * `clockHighWater` dan `clockSuspicious` — seluruh bukti anti-rollback
 * jam. Deaktivasi adalah aksi yang dapat dipicu pengguna kapan saja,
 * jadi itu berarti proteksi jam dapat dibersihkan dengan dua ketukan.
 *
 * High-water mark bukan bagian dari lisensi; ia catatan tentang
 * PERANGKAT, sama seperti device ID. Menyimpannya melewati deaktivasi
 * tidak pernah memperlonggar apa pun — nilainya hanya bisa naik, dan
 * satu-satunya efeknya adalah membuat keputusan kedaluwarsa lebih
 * ketat, tidak pernah lebih longgar.
 */
const KEYS_YANG_DIPERTAHANKAN: readonly string[] = [
  // Identitas perangkat: menghapusnya membuat re-aktivasi di perangkat
  // yang sama terlihat sebagai perangkat baru oleh server dan memakan
  // slot `max_devices` kedua tanpa alasan.
  KEYS.deviceId,
  KEYS.clockHighWater,
  KEYS.clockSuspicious,
];

export async function readDeactivatedAt(): Promise<number | null> {
  return readNumber(KEYS.deactivatedAt);
}

export async function markDeactivated(atMs: number): Promise<void> {
  await writeItem(KEYS.deactivatedAt, String(atMs));
}

export async function clearDeactivatedMark(): Promise<void> {
  await removeItem(KEYS.deactivatedAt);
}

export async function clearLicenseState(): Promise<void> {
  for (const key of LICENSE_STORAGE_KEYS) {
    if (KEYS_YANG_DIPERTAHANKAN.includes(key)) continue;
    await removeItem(key);
  }
}

// ---------------------------------------------------------------------------
// Anti clock-rollback (§9)
// ---------------------------------------------------------------------------

export async function readClockHighWater(): Promise<number | null> {
  return readNumber(KEYS.clockHighWater);
}

export async function writeClockHighWater(ms: number): Promise<void> {
  await writeItem(KEYS.clockHighWater, String(ms));
}

export async function readClockSuspicious(): Promise<boolean> {
  return (await readItem(KEYS.clockSuspicious)) === '1';
}

export async function writeClockSuspicious(value: boolean): Promise<void> {
  if (value) {
    await writeItem(KEYS.clockSuspicious, '1');
  } else {
    await removeItem(KEYS.clockSuspicious);
  }
}

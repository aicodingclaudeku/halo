/**
 * IDENTITAS PERANGKAT (§3)
 * =========================================================================
 *
 * Server mengikat lisensi ke `SHA-256(device_id)`. Karena itu device_id
 * WAJIB stabil: kalau ia berubah setiap aplikasi dibuka, setiap startup
 * akan terlihat sebagai perangkat baru, `max_devices` habis dalam
 * hitungan menit, dan pengguna sah terkunci dari aplikasinya sendiri.
 *
 * ---------------------------------------------------------------------
 * KENAPA INSTALLATION ID, BUKAN "HARDWARE ID"
 * ---------------------------------------------------------------------
 * Keputusan ini diambil setelah menimbang pilihan yang benar-benar
 * tersedia di Expo SDK 54 — bukan yang ideal secara teori:
 *
 *   - IMEI / serial number: sejak Android 10 TIDAK dapat diakses aplikasi
 *     biasa. Bukan soal izin; API-nya memang ditutup.
 *   - `Application.getAndroidId()` (expo-application): tersedia, dan
 *     lebih tahan reinstall. TIDAK dipakai sebagai default karena akan
 *     menambah native module baru ke dependency produksi, dan nilainya
 *     tetap berubah pada factory reset maupun saat app-signing key
 *     berganti — jadi ia menukar satu kelemahan dengan kelemahan lain,
 *     bukan menghilangkannya. Lihat catatan "UPGRADE" di bawah bila
 *     Anda tetap menginginkannya.
 *   - MAC address: dirandomisasi oleh Android modern. Tidak berguna.
 *
 * Yang dipakai: INSTALLATION ID acak 256-bit yang dibuat sekali dengan
 * RNG kriptografis (`expo-crypto`) dan disimpan di SecureStore.
 *
 * ---------------------------------------------------------------------
 * BATASAN YANG DIDOKUMENTASIKAN SECARA JUJUR (§3)
 * ---------------------------------------------------------------------
 * 1. UNINSTALL/REINSTALL, "hapus data aplikasi", dan factory reset akan
 *    menghasilkan identitas BARU. Perangkat itu akan meminta slot
 *    aktivasi baru di server.
 * 2. Karena itu, alur operasional yang benar untuk pengguna yang
 *    memasang ulang adalah: admin menonaktifkan aktivasi lama lewat
 *    panel admin (atau pengguna menekan "Nonaktifkan Lisensi" SEBELUM
 *    uninstall), lalu aktivasi ulang.
 * 3. Ini BUKAN kelemahan keamanan yang bisa dieksploitasi untuk memakai
 *    satu lisensi di banyak perangkat: server tetap menghitung slot
 *    `max_devices` dan aktivasi lama tetap aktif sampai dinonaktifkan.
 *    Efeknya menyulitkan pengguna sah, bukan memudahkan pembajak.
 *
 * ---------------------------------------------------------------------
 * UPGRADE OPSIONAL
 * ---------------------------------------------------------------------
 * Bila Anda ingin identitas yang bertahan melewati reinstall:
 *
 *     npx expo install expo-application
 *
 * lalu campurkan `Application.getAndroidId()` ke dalam seed di
 * `createDeviceId()`. Versi paketnya sengaja TIDAK dituliskan di sini
 * supaya `expo install` yang memilih versi cocok untuk SDK 54 —
 * menebak nomor versi adalah cara klasik merusak `expo-doctor`.
 * Perubahan itu mengubah device_id semua perangkat, jadi perlakukan
 * sebagai migrasi: seluruh perangkat harus re-aktivasi.
 */

import * as Crypto from 'expo-crypto';
import { bytesToHex } from './bytes';
import { readDeviceId, writeDeviceId } from './licenseStore';

/** Prefix untuk memudahkan mengenali asal ID di log server/admin panel. */
const DEVICE_ID_PREFIX = 'KOPKU-INST-';
const RANDOM_BYTES = 32;

/** Bentuk yang dianggap sah. Server menolak <4 atau >255 karakter. */
const DEVICE_ID_PATTERN = /^KOPKU-INST-[0-9a-f]{64}$/;

function createDeviceId(): string {
  const random = Crypto.getRandomBytes(RANDOM_BYTES);
  return DEVICE_ID_PREFIX + bytesToHex(random);
}

/**
 * Cache proses. Bukan optimasi belaka: mencegah dua pemanggil paralel
 * (License Gate saat startup dan layar aktivasi) sama-sama melihat
 * SecureStore kosong lalu menulis DUA ID berbeda, yang membuat token
 * hasil aktivasi terikat ke ID yang kemudian tertimpa.
 */
let cachedDeviceId: string | null = null;
let inFlight: Promise<string> | null = null;

async function resolveDeviceId(): Promise<string> {
  const existing = await readDeviceId();
  if (existing && DEVICE_ID_PATTERN.test(existing)) {
    cachedDeviceId = existing;
    return existing;
  }

  // Ada nilai tetapi bentuknya asing (mis. sisa versi lama). Nilai lama
  // TETAP DIPAKAI bila panjangnya masih diterima server — mengganti ID
  // akan memutus lisensi yang sedang berjalan, dan itu kerusakan yang
  // jauh lebih besar daripada format yang tidak rapi.
  if (existing && existing.length >= 4 && existing.length <= 255) {
    cachedDeviceId = existing;
    return existing;
  }

  const created = createDeviceId();
  await writeDeviceId(created);
  cachedDeviceId = created;
  return created;
}

/** Ambil device ID stabil perangkat ini; buat sekali bila belum ada. */
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  if (inFlight) return inFlight;
  inFlight = resolveDeviceId().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Hanya untuk test — mengosongkan cache proses. */
export function __resetDeviceIdCacheForTests(): void {
  cachedDeviceId = null;
  inFlight = null;
}

/**
 * Bentuk device ID yang aman ditampilkan ke pengguna biasa.
 *
 * Device ID bukan rahasia kriptografis — ia tidak dapat dipakai untuk
 * memalsukan token, karena token harus ditandatangani server. Tetapi ia
 * TETAP pengidentifikasi yang stabil dan terikat ke satu instalasi, dan
 * pengenal semacam itu tidak perlu dipampang di layar yang dibuka
 * sehari-hari. Menampilkannya penuh juga mengundang orang menyalinnya
 * ke tiket dukungan atau tangkapan layar publik tanpa alasan.
 *
 * Bentuk penuh tetap tersedia di layar Diagnostik Keamanan, tempat ia
 * memang dibutuhkan untuk mencocokkan perangkat dengan catatan server.
 */
export function maskDeviceId(deviceId: string): string {
  if (!deviceId) return '—';
  const prefix = 'KOPKU-INST-';
  if (deviceId.startsWith(prefix)) {
    const hex = deviceId.slice(prefix.length);
    if (hex.length >= 12) {
      return `${prefix}${hex.slice(0, 6)}…${hex.slice(-4)}`;
    }
  }
  if (deviceId.length <= 12) return deviceId;
  return `${deviceId.slice(0, 6)}…${deviceId.slice(-4)}`;
}

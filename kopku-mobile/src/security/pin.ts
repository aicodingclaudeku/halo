import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { hashPinV2 as hashPinTerbaru, verifikasiPin } from './pinHash';

/**
 * PIN tidak pernah disimpan plaintext (PRD §31-32).
 * - Hash+salt PIN disimpan di kolom app_user.pin_hash/pin_salt (SQLite),
 *   supaya bisa dipakai lintas multi-user lokal.
 * - Session token aktif (siapa yang sedang login) disimpan di SecureStore,
 *   karena itu data keamanan sesi, bukan data utama (PRD §3).
 */

const SESSION_KEY = 'koperasi.session.userId';
const LOCK_TIMESTAMP_KEY = 'koperasi.session.lastActiveAt';

/**
 * RC-S114 — hash PIN kini scrypt (v2), bukan lagi SHA-256 satu putaran.
 *
 * Perhitungannya pindah ke `security/pinHash.ts` (murni, teruji);
 * berkas ini tetap menjadi pintu masuk yang sama bagi pemanggil lama
 * supaya tidak ada yang perlu tahu versi hash untuk sekadar MEMBUAT
 * PIN baru. Verifikasi yang sadar versi memakai `verifikasiPin()` di
 * modul itu — lihat AuthService.
 *
 * Tetap `async` walau perhitungannya sinkron: seluruh pemanggil sudah
 * meng-await-nya, dan mengubah tanda tangannya hanya akan menyebar
 * perubahan tanpa manfaat.
 */
export async function hashPin(pin: string, salt: string): Promise<string> {
  return hashPinTerbaru(pin, salt);
}


export function generateSalt(): string {
  const bytes = Crypto.getRandomBytes(16);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verifikasi PIN warisan (tanpa versi). Dipertahankan hanya untuk
 * pemanggil yang belum membaca `pin_hash_versi`; jalur login memakai
 * `verifikasiPin()` yang sadar versi supaya hash lama tetap bisa
 * diverifikasi DAN dinaikkan.
 */
export async function verifyPin(pin: string, salt: string, storedHash: string): Promise<boolean> {
  return verifikasiPin({ pin, salt, hashTersimpan: storedHash, versiTersimpan: 1 }).cocok
    || verifikasiPin({ pin, salt, hashTersimpan: storedHash, versiTersimpan: 2 }).cocok;
}

export async function setSession(userId: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, userId);
  await touchSession();
}

export async function getSession(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_KEY);
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
  await SecureStore.deleteItemAsync(LOCK_TIMESTAMP_KEY);
}

export async function touchSession(): Promise<void> {
  await SecureStore.setItemAsync(LOCK_TIMESTAMP_KEY, Date.now().toString());
}

export type AutoLockDuration = 1 | 5 | 15 | 30 | null; // menit, null = tidak pernah

/** Cek apakah sesi sudah melewati batas auto-lock (PRD §32). */
export async function isSessionLocked(autoLockMinutes: AutoLockDuration): Promise<boolean> {
  if (autoLockMinutes === null) return false;
  const lastActive = await SecureStore.getItemAsync(LOCK_TIMESTAMP_KEY);
  if (!lastActive) return true;
  const elapsedMs = Date.now() - parseInt(lastActive, 10);
  return elapsedMs > autoLockMinutes * 60 * 1000;
}

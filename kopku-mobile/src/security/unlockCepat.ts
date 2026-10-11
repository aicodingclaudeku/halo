import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { keHex, samaAman, teksKeBytes } from './pinHash';

/**
 * ============================================================
 * RC-S130 — VERIFIKASI CEPAT UNTUK MEMBUKA KUNCI LAYAR
 * ============================================================
 *
 * MASALAH. Hash PIN di database memakai scrypt N=2^14 (RC-S114) yang
 * dihitung dalam JavaScript murni (@noble/hashes). Di Hermes — mesin JS
 * aplikasi di HP, tanpa JIT — satu kali perhitungan memakan beberapa
 * detik (diukur 5,6 dtk di Node tanpa JIT, 92 ms dengan JIT). Kunci
 * layar terbuka setiap kali aplikasi dibuka dan setelah auto-lock 5
 * menit, jadi penantian itu terasa berulang kali sehari.
 *
 * SOLUSI. Setelah PIN SEKALI terbukti benar lewat scrypt, aplikasi
 * menyimpan pemverifikasi ringan di SecureStore (Android Keystore /
 * iOS Keychain — BUKAN di database dan TIDAK ikut berkas backup):
 *
 *     tag = HMAC-SHA256(pepper acak 32 byte, `${userId}:${ikatan}:${pin}`)
 *
 * Pembukaan kunci berikutnya cukup menghitung HMAC itu (< 1 ms).
 *
 * YANG TIDAK BERUBAH (ancaman RC-S114). Pemegang SALINAN DATABASE atau
 * berkas backup tetap hanya mendapat hash scrypt: pepper dan tag tidak
 * pernah ditulis ke SQLite maupun ke backup.
 *
 * BATASAN YANG DITERIMA. Pihak yang sudah menguasai perangkat dengan
 * akses root dapat membaca SecureStore lalu menebak PIN lebih cepat.
 * Pihak semacam itu juga sudah dapat membaca database aplikasi secara
 * langsung (data tidak terenkripsi di perangkat), jadi kerahasiaan PIN
 * tidak menambah perlindungan data dalam skenario itu.
 *
 * FAIL-CLOSED & TERIKAT KREDENSIAL.
 *  - `ikatan` = SHA-256 atas versi + salt + hash PIN yang tersimpan saat
 *    pemverifikasi dibuat. PIN diganti/di-reset, database dipulihkan,
 *    atau hash dinaikkan versinya -> ikatan berbeda -> catatan diabaikan
 *    dan verifikasi kembali ke scrypt penuh.
 *  - Catatan rusak, versi format tak dikenal, user berbeda, SecureStore
 *    gagal -> TIDAK_TERSEDIA -> scrypt penuh. Tidak pernah "lolos".
 *  - Logout menghapus catatan.
 *  - `VERIFIKASI_CEPAT_AKTIF = false` mematikan seluruh jalur ini.
 *
 * Hanya untuk KUNCI LAYAR (PIN). Login dengan password tetap scrypt penuh.
 */

export const VERIFIKASI_CEPAT_AKTIF = true;

export const KUNCI_VERIFIKASI_CEPAT = 'koperasi.pin.verifikasiCepat';
const VERSI_FORMAT = 1;

export type HasilVerifikasiCepat = 'COCOK' | 'TIDAK_COCOK' | 'TIDAK_TERSEDIA';

interface CatatanVerifikasiCepat {
  v: number;
  userId: string;
  ikatan: string;
  pepper: string;
  tag: string;
}

/** Sidik kredensial PIN yang tersimpan di database (bukan rahasia; hanya pengikat). */
export function ikatanKredensialPin(row: { pin_hash?: unknown; pin_salt?: unknown; pin_hash_versi?: unknown }): string | null {
  if (typeof row.pin_hash !== 'string' || !row.pin_hash || typeof row.pin_salt !== 'string' || !row.pin_salt) return null;
  const versi = Number(row.pin_hash_versi) === 2 ? 2 : 1;
  return keHex(sha256(teksKeBytes(`${versi}:${row.pin_salt}:${row.pin_hash}`)));
}

function hexKeBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hitungTag(pepperHex: string, userId: string, ikatan: string, pin: string): string {
  return keHex(hmac(sha256, hexKeBytes(pepperHex), teksKeBytes(`${userId}:${ikatan}:${pin}`)));
}

const HEX64 = /^[0-9a-f]{64}$/;

function bacaCatatan(raw: string | null): CatatanVerifikasiCepat | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw);
    if (
      !c ||
      c.v !== VERSI_FORMAT ||
      typeof c.userId !== 'string' ||
      !HEX64.test(String(c.ikatan)) ||
      !HEX64.test(String(c.pepper)) ||
      !HEX64.test(String(c.tag))
    ) {
      return null;
    }
    return c as CatatanVerifikasiCepat;
  } catch {
    return null;
  }
}

/**
 * Cocokkan PIN dengan pemverifikasi cepat.
 *  - COCOK          : PIN benar untuk kredensial yang tersimpan saat ini.
 *  - TIDAK_COCOK    : catatan sah & terikat ke kredensial saat ini, tetapi PIN salah.
 *  - TIDAK_TERSEDIA : tidak ada catatan sah untuk user + kredensial ini -> pakai scrypt.
 * Tidak pernah melempar.
 */
export async function cocokkanPinCepat(userId: string, ikatan: string | null, pin: string): Promise<HasilVerifikasiCepat> {
  if (!VERIFIKASI_CEPAT_AKTIF || !ikatan) return 'TIDAK_TERSEDIA';
  try {
    const c = bacaCatatan(await SecureStore.getItemAsync(KUNCI_VERIFIKASI_CEPAT));
    if (!c || c.userId !== userId || !samaAman(c.ikatan, ikatan)) return 'TIDAK_TERSEDIA';
    return samaAman(hitungTag(c.pepper, userId, ikatan, pin), c.tag) ? 'COCOK' : 'TIDAK_COCOK';
  } catch {
    return 'TIDAK_TERSEDIA';
  }
}

/**
 * Simpan pemverifikasi cepat. HANYA dipanggil setelah PIN terbukti benar
 * lewat scrypt. Best-effort: kegagalan tidak memengaruhi pembukaan kunci.
 */
export async function simpanPinCepat(userId: string, ikatan: string | null, pin: string): Promise<void> {
  if (!VERIFIKASI_CEPAT_AKTIF || !ikatan) return;
  try {
    const pepper = keHex(Crypto.getRandomBytes(32));
    const catatan: CatatanVerifikasiCepat = { v: VERSI_FORMAT, userId, ikatan, pepper, tag: hitungTag(pepper, userId, ikatan, pin) };
    await SecureStore.setItemAsync(KUNCI_VERIFIKASI_CEPAT, JSON.stringify(catatan));
  } catch {
    // Diabaikan: pembukaan berikutnya kembali memakai scrypt.
  }
}

export async function hapusPinCepat(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KUNCI_VERIFIKASI_CEPAT);
  } catch {
    // Diabaikan.
  }
}

/**
 * Jeda setelah PIN salah lewat jalur cepat — pengganti "biaya" scrypt
 * supaya penebakan lewat layar tetap lambat. Bertambah bila salah
 * berturut-turut: 3 kali pertama 0,8 dtk, lalu 2, 4, 8, 16, maks. 30 dtk.
 */
export function jedaSetelahGagalMs(gagalBeruntun: number): number {
  if (gagalBeruntun <= 3) return 800;
  return Math.min(30_000, 2_000 * 2 ** (gagalBeruntun - 4));
}

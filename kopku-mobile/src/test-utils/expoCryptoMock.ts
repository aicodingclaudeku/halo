/**
 * Mock Jest untuk `expo-crypto`.
 *
 * `expo-crypto` adalah native module Expo yang di-bundle sebagai ESM murni
 * (pakai `import`/`export`) dan tidak melalui Metro/Babel saat dijalankan
 * lewat Jest (preset proyek ini adalah `ts-jest`, bukan `jest-expo`), jadi
 * Jest gagal mem-parsingnya ("Cannot use import statement outside a
 * module"). Modul ini dipakai `src/utils/id.ts` (newId -> randomUUID) dan
 * `src/security/pin.ts` (hashPin/generateSalt), yang keduanya diimpor
 * secara transitif oleh cukup banyak service — jadi di-mock di sini,
 * bukan per test file, memakai implementasi setara dari `crypto` bawaan
 * Node (testEnvironment Jest proyek ini adalah 'node').
 */
import { randomUUID as nodeRandomUUID, randomBytes, createHash } from 'crypto';

export enum CryptoDigestAlgorithm {
  SHA1 = 'SHA-1',
  SHA256 = 'SHA-256',
  SHA384 = 'SHA-384',
  SHA512 = 'SHA-512',
  MD2 = 'MD2',
  MD4 = 'MD4',
  MD5 = 'MD5',
}

/**
 * NAMA ENUM INI HARUS PERSIS SAMA DENGAN expo-crypto.
 *
 * Versi sebelumnya mengekspor `CryptoDigestEncoding` — nama yang TIDAK
 * PERNAH ADA di expo-crypto. Akibatnya `Crypto.CryptoDigestEncoding.HEX`
 * di source produksi lolos typecheck DAN lolos seluruh test, lalu
 * melempar "Cannot read property 'HEX' of undefined" di perangkat dan
 * menggagalkan setiap aktivasi lisensi.
 *
 * Ini kegagalan yang sama bentuknya dengan bug SHA-512 noble: mock yang
 * lebih longgar daripada kenyataan tidak sekadar tidak berguna — ia
 * mengubah kesalahan yang seharusnya ketahuan saat compile menjadi crash
 * di tangan pengguna.
 *
 * `CryptoDigestEncoding` SENGAJA TIDAK diekspor lagi. Dengan begitu,
 * siapa pun yang menuliskannya kembali akan langsung ditolak compiler,
 * bukan ditemukan di lapangan.
 */
export enum CryptoEncoding {
  HEX = 'hex',
  BASE64 = 'base64',
}

/** Bentuk opsi seperti di expo-crypto. */
export type CryptoDigestOptions = { encoding?: CryptoEncoding };

const ALGO_TO_NODE: Record<string, string> = {
  'SHA-1': 'sha1',
  'SHA-256': 'sha256',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
  MD2: 'md2',
  MD4: 'md4',
  MD5: 'md5',
};

export function randomUUID(): string {
  return nodeRandomUUID();
}

export function getRandomBytes(byteCount: number): Uint8Array {
  return new Uint8Array(randomBytes(byteCount));
}

export async function getRandomBytesAsync(byteCount: number): Promise<Uint8Array> {
  return getRandomBytes(byteCount);
}

export async function digestStringAsync(
  algorithm: CryptoDigestAlgorithm,
  data: string,
  // Default expo-crypto: `{ encoding: CryptoEncoding.HEX }`.
  options: CryptoDigestOptions = { encoding: CryptoEncoding.HEX }
): Promise<string> {
  const nodeAlgo = ALGO_TO_NODE[algorithm] ?? 'sha256';
  return createHash(nodeAlgo)
    .update(data)
    .digest(options?.encoding === CryptoEncoding.BASE64 ? 'base64' : 'hex');
}

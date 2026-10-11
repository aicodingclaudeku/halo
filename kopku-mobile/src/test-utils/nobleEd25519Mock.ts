/**
 * Mock Jest untuk `@noble/ed25519`.
 *
 * KEPUTUSAN PENTING — dan alasannya perlu dibaca sebelum mengubah berkas ini.
 *
 * Mock ini TIDAK memalsukan hasil verifikasi. Ia meneruskan ke Ed25519
 * ASLI milik Node (`crypto.verify`, tersedia sejak Node 12). Jadi test
 * yang memakainya benar-benar menguji: tanda tangan sah lolos, tanda
 * tangan yang satu byte-nya diubah ditolak, kunci yang salah ditolak.
 *
 * Kalau mock ini sekadar `return true`, seluruh suite lisensi akan
 * hijau sambil tidak membuktikan apa pun tentang bagian yang paling
 * penting — dan itu justru jenis test yang berbahaya, karena ia
 * memberi rasa aman palsu.
 *
 * YANG TETAP TIDAK TERUJI DI SINI (jujur, jangan diklaim lebih):
 * apakah `@noble/ed25519` yang asli berjalan benar di Hermes/React
 * Native. Itu hanya bisa dibuktikan di perangkat/emulator. Yang diuji
 * berkas-berkas test adalah LOGIKA di sekitarnya: parsing token,
 * pemilihan pesan yang ditandatangani, device binding, kedaluwarsa.
 *
 * Paket aslinya di-ship sebagai ESM murni sehingga ts-jest tidak bisa
 * mem-parsingnya langsung — alasan teknis yang sama dengan mock
 * expo-crypto/expo-sqlite di folder ini.
 */

import { createPublicKey, verify as nodeVerify } from 'crypto';

/** Header ASN.1/SPKI untuk membungkus 32 byte public key Ed25519 mentah. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

function verifyRaw(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, toBuffer(publicKey)]),
      format: 'der',
      type: 'spki',
    });
    return nodeVerify(null, toBuffer(message), key, toBuffer(signature));
  } catch {
    return false;
  }
}

/**
 * SLOT SHA-512 — MENIRU DEFAULT noble v2, TERMASUK YANG RUSAK DI HERMES.
 * =========================================================================
 *
 * KENAPA MOCK INI DIPERKETAT (RC-S34).
 *
 * Versi sebelumnya menyediakan `etc` sebagai objek kosong dan
 * `verify`/`verifyAsync` langsung memanggil Node, tanpa pernah menyentuh
 * slot SHA-512. Akibatnya seluruh jalur penyuntikan hash di
 * `security/ed25519.ts` TIDAK PERNAH DIEKSEKUSI saat test — dan bug yang
 * membuat setiap verifikasi di Android mengembalikan `false` lolos
 * melewati 201 test yang semuanya hijau.
 *
 * Sekarang mock meniru default noble v2 apa adanya:
 *
 *   - `sha512Sync`  : `undefined`. Pustaka aslinya tidak menyetelnya;
 *     hanya metode async yang tersedia tanpa konfigurasi.
 *   - `sha512Async` : SUDAH TERISI, dan versi default itu MELEMPAR —
 *     persis seperti WebCrypto di Hermes, di mana `crypto.subtle`
 *     tidak ada.
 *
 * Konsekuensinya: adapter yang tidak menimpa `sha512Async` akan GAGAL
 * di sini, sama seperti gagalnya di perangkat. Itulah tujuannya. Mock
 * yang lebih longgar dari kenyataan bukan sekadar tidak berguna — ia
 * memberi rasa aman palsu, yang lebih buruk daripada tidak punya test.
 *
 * Perhitungan Ed25519-nya tetap memakai Node yang sesungguhnya, jadi
 * hasil verifikasinya tetap benar-benar diuji, bukan dipalsukan.
 */
const HERMES_DEFAULT_SHA512_ASYNC = async (): Promise<Uint8Array> => {
  throw new Error('crypto.subtle must be defined');
};

export const etc: {
  sha512Sync?: (...messages: Uint8Array[]) => Uint8Array;
  sha512Async?: (...messages: Uint8Array[]) => Promise<Uint8Array>;
  concatBytes?: (...arrays: Uint8Array[]) => Uint8Array;
} = {
  sha512Sync: undefined,
  sha512Async: HERMES_DEFAULT_SHA512_ASYNC,
  concatBytes: (...arrays: Uint8Array[]) => {
    let total = 0;
    for (const array of arrays) total += array.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const array of arrays) {
      out.set(array, offset);
      offset += array.length;
    }
    return out;
  },
};

/**
 * Pastikan hash yang disuntikkan benar-benar BEKERJA, bukan sekadar ada.
 *
 * noble memanggil SHA-512 di dalam verifikasi. Kalau penyuntikannya
 * salah bentuk — mengembalikan panjang keliru, atau melempar — verifikasi
 * asli juga akan gagal. Mock memeriksanya secara eksplisit supaya
 * kegagalan menunjuk ke penyebabnya, bukan muncul sebagai `false` yang
 * membingungkan.
 */
function assertDigest(digest: Uint8Array): void {
  if (!(digest instanceof Uint8Array) || digest.length !== 64) {
    throw new Error('sha512 provider mengembalikan nilai yang tidak sah');
  }
}

export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  // Meniru pustaka aslinya: jalur sinkron MEMBUTUHKAN sha512Sync, dan
  // melempar bila belum disuntikkan.
  if (typeof etc.sha512Sync !== 'function') {
    throw new Error('etc.sha512Sync belum disetel');
  }
  assertDigest(etc.sha512Sync(message));
  return verifyRaw(signature, message, publicKey);
}

export async function verifyAsync(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): Promise<boolean> {
  if (typeof etc.sha512Async !== 'function') {
    throw new Error('etc.sha512Async belum disetel');
  }
  assertDigest(await etc.sha512Async(message));
  return verifyRaw(signature, message, publicKey);
}

/** Hanya untuk test — kembalikan slot hash ke default noble v2. */
export function __resetHashSlotsForTests(): void {
  etc.sha512Sync = undefined;
  etc.sha512Async = HERMES_DEFAULT_SHA512_ASYNC;
}

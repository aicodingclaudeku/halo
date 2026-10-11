/**
 * ADAPTER VERIFIKASI Ed25519
 * =========================================================================
 *
 * Satu-satunya tempat di aplikasi ini yang menyentuh primitif kriptografi
 * kurva. Sengaja dipisah supaya:
 *   1. `licenseToken.ts` bisa diuji tanpa peduli library mana yang dipakai;
 *   2. bila suatu saat pindah ke native module (mis. react-native-nitro
 *      atau libsodium binding), HANYA berkas ini yang berubah.
 *
 * ---------------------------------------------------------------------
 * KENAPA `@noble/ed25519`, BUKAN IMPLEMENTASI SENDIRI
 * ---------------------------------------------------------------------
 * Master command §5 melarang menulis kriptografi sendiri — dan itu benar.
 * Ed25519 punya banyak jebakan halus (validasi titik, small-order point,
 * malleability, cofactor) yang tidak terlihat di test "tanda tangan yang
 * benar lolos".
 *
 * `expo-crypto` (SDK 54) TIDAK menyediakan verifikasi Ed25519 — ia hanya
 * punya digest, random bytes, dan UUID. Jadi library eksternal memang
 * dibutuhkan. `@noble/ed25519` dipilih karena:
 *   - JavaScript murni (BigInt) -> TIDAK butuh native module, TIDAK butuh
 *     `expo prebuild`/config plugin, jalan di Expo Go maupun EAS build;
 *   - sudah diaudit publik & dipakai luas;
 *   - untuk VERIFIKASI saja tidak butuh `getRandomValues`, sehingga
 *     polyfill `react-native-get-random-values` TIDAK diperlukan di sini
 *     (README noble menyebut polyfill itu untuk pembuatan KUNCI/tanda
 *     tangan — aplikasi ini tidak pernah melakukan keduanya).
 *
 * Hermes di React Native 0.81 mendukung BigInt, jadi syarat noble
 * terpenuhi.
 *
 * ---------------------------------------------------------------------
 * KOMPATIBILITAS v2 / v3
 * ---------------------------------------------------------------------
 * noble-ed25519 v2 menyuntikkan SHA-512 lewat `ed.etc.sha512Sync`,
 * sedangkan v3 memindahkannya ke `ed.hashes.sha512`. Berkas ini
 * mendeteksi keduanya saat runtime dan mengisi yang tersedia, supaya
 * `npm install` yang menaikkan mayor version tidak diam-diam membuat
 * verifikasi selalu gagal.
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

/**
 * Bentuk longgar modul noble untuk feature-detection lintas mayor
 * version. Sengaja memakai `unknown` + type guard, bukan `any`.
 */
interface NobleShape {
  etc?: {
    sha512Sync?: (...messages: Uint8Array[]) => Uint8Array;
    sha512Async?: (...messages: Uint8Array[]) => Promise<Uint8Array>;
    concatBytes?: (...arrays: Uint8Array[]) => Uint8Array;
  };
  hashes?: {
    sha512?: (message: Uint8Array) => Uint8Array;
    sha512Async?: (message: Uint8Array) => Promise<Uint8Array>;
  };
  verify?: (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean;
  verifyAsync?: (
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array
  ) => Promise<boolean>;
}

function concatBytes(arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const array of arrays) total += array.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

let wired = false;

/**
 * Suntikkan SHA-512 sekali saja. Idempoten: aman dipanggil dari banyak
 * jalur (verifikasi bisa terjadi di startup gate DAN di layar aktivasi).
 */
function ensureHashWired(): void {
  if (wired) return;
  const noble = ed as unknown as NobleShape;

  if (noble.hashes) {
    // noble-ed25519 v3
    if (!noble.hashes.sha512) {
      noble.hashes.sha512 = (message: Uint8Array) => sha512(message);
    }
    if (!noble.hashes.sha512Async) {
      noble.hashes.sha512Async = (message: Uint8Array) => Promise.resolve(sha512(message));
    }
  }

  if (noble.etc) {
    // noble-ed25519 v2
    //
    // KEDUANYA DITIMPA TANPA SYARAT — dan itu bukan kelalaian.
    //
    // Versi RC-S33 memakai `if (!noble.etc.sha512Async)` dengan maksud
    // "jangan menimpa yang sudah ada". Maksud itu keliru arah di sini:
    // noble v2 SUDAH mendefinisikan `sha512Async` secara default memakai
    // WebCrypto (`crypto.subtle`), karena hanya metode async yang
    // tersedia tanpa konfigurasi. Di Hermes `crypto.subtle` tidak ada,
    // sehingga default itu melempar dan SETIAP verifikasi berakhir di
    // `catch` sebagai `false` — termasuk seluruh vektor RFC 8032.
    //
    // Gejalanya sangat menyesatkan: enam pemeriksaan mengembalikan
    // `false`, dan tiga kasus negatif "lulus" karena `false` memang
    // jawaban yang diharapkannya. Diagnostik lalu melaporkan 3 dari 6
    // gagal, seolah kriptografinya setengah bekerja.
    //
    // README noble v2 untuk React Native memang menyuruh menyetel
    // KEDUANYA tanpa syarat. Itu yang dilakukan di sini.
    noble.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(concatBytes(messages));
    noble.etc.sha512Async = (...messages: Uint8Array[]) =>
      Promise.resolve(sha512(concatBytes(messages)));
  }

  wired = true;
}

export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

/**
 * Verifikasi tanda tangan Ed25519 detached.
 *
 * TIDAK PERNAH melempar: input tidak tepercaya (token dari jaringan/disk)
 * yang membuat library melempar harus berujung `false`, bukan crash yang
 * bisa dipakai untuk membedakan jenis kegagalan.
 */
export async function verifyEd25519(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): Promise<boolean> {
  if (signature.length !== ED25519_SIGNATURE_BYTES) return false;
  if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES) return false;

  try {
    ensureHashWired();
    const noble = ed as unknown as NobleShape;

    // JALUR SINKRON DIDAHULUKAN.
    //
    // `sha512Sync` adalah slot yang kita isi sendiri di atas, jadi
    // `verify()` tidak pernah bergantung pada WebCrypto maupun pada
    // default pustaka mana pun. `verifyAsync` disimpan sebagai cadangan
    // untuk versi noble yang mungkin tidak lagi mengekspor `verify`.
    //
    // Urutan ini juga membuat kesalahan konfigurasi hash gagal secara
    // deterministik, bukan bergantung pada ada-tidaknya API lingkungan.
    if (typeof noble.verify === 'function') {
      return noble.verify(signature, message, publicKey);
    }
    if (typeof noble.verifyAsync === 'function') {
      return await noble.verifyAsync(signature, message, publicKey);
    }
    return false;
  } catch {
    return false;
  }
}

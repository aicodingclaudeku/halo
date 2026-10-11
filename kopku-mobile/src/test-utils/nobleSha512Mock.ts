/**
 * Mock Jest untuk `@noble/hashes/sha512`.
 *
 * Dipakai `security/ed25519.ts` untuk menyuntikkan SHA-512 ke noble.
 * Di test, verifikasi sesungguhnya dilakukan Node (lihat
 * `nobleEd25519Mock.ts`), jadi fungsi ini tidak ikut jalur verifikasi —
 * tetapi ia HARUS ada dan HARUS benar, karena kalau suatu saat adapter
 * berubah dan mulai memakainya, hasil yang salah akan lolos diam-diam.
 *
 * Karena itu implementasinya memakai SHA-512 asli dari `crypto` Node,
 * bukan stub.
 */

import { createHash } from 'crypto';

export function sha512(message: Uint8Array): Uint8Array {
  const digest = createHash('sha512')
    .update(Buffer.from(message))
    .digest();
  return new Uint8Array(digest);
}

import * as Crypto from 'expo-crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';

/**
 * KRIPTOGRAFI KANAL SINKRON (Wi-Fi lokal/hotspot, tanpa internet).
 *
 * - Pemasangan: QR membawa rahasia acak 32 byte SEKALI PAKAI (berlaku
 *   10 menit). Kunci jangka panjang diturunkan HKDF-SHA256 dari rahasia
 *   QR + kontribusi acak kedua perangkat. QR tidak pernah membawa atau
 *   menyentuh lisensi.
 * - Setiap pesan dienkripsi & diautentikasi XChaCha20-Poly1305 (nonce
 *   acak 24 byte), dengan data terkait (AAD) yang mengikat ID perangkat
 *   dan jalur. Isi pesan memuat stempel waktu + ID permintaan untuk
 *   menolak pemutaran ulang (replay).
 * - Kanal HTTP polos di LAN aman karena seluruh isi terenkripsi
 *   ujung-ke-ujung; penyadap hanya melihat byte acak.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PANJANG_KUNCI = 32;
export const MASA_BERLAKU_PESAN_MS = 10 * 60 * 1000;

export function acak(n: number): Uint8Array {
  return Crypto.getRandomBytes(n);
}

export function turunkanKunci(bahan: Uint8Array, garam: string, info: string): Uint8Array {
  return hkdf(sha256, bahan, enc.encode(garam), enc.encode(info), PANJANG_KUNCI);
}

export function gabung(...bagian: Uint8Array[]): Uint8Array {
  const total = bagian.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const b of bagian) {
    out.set(b, i);
    i += b.length;
  }
  return out;
}

export interface Amplop {
  n: string;
  c: string;
}

export function segel(kunci: Uint8Array, aad: string, isi: unknown): Amplop {
  const nonce = acak(24);
  const ct = xchacha20poly1305(kunci, nonce, enc.encode(aad)).encrypt(enc.encode(JSON.stringify(isi)));
  return { n: b64(nonce), c: b64(ct) };
}

export function buka<T = unknown>(kunci: Uint8Array, aad: string, a: Amplop): T {
  const pt = xchacha20poly1305(kunci, dariB64(a.n), enc.encode(aad)).decrypt(dariB64(a.c));
  return JSON.parse(dec.decode(pt)) as T;
}

export function hashHex(data: Uint8Array): string {
  return hex(sha256(data));
}

export function pembuatHash() {
  return sha256.create();
}

export function hex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

const ABJAD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BALIK = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < ABJAD.length; i++) t[ABJAD.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62;
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

export function b64(bytes: Uint8Array): string {
  const potong: string[] = [];
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
    s += ABJAD[b0 >> 2];
    s += ABJAD[((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4)];
    s += b1 < 0 ? '=' : ABJAD[((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6)];
    s += b2 < 0 ? '=' : ABJAD[b2 & 63];
    if (s.length >= 8192) {
      potong.push(s);
      s = '';
    }
  }
  potong.push(s);
  return potong.join('');
}

export function dariB64(teks: string): Uint8Array {
  const out = new Uint8Array(Math.floor((teks.length * 3) / 4) + 3);
  let n = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < teks.length; i++) {
    const v = BALIK[teks.charCodeAt(i) & 255];
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (buf >> bits) & 255;
    }
  }
  return out.slice(0, n);
}

export function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function teksKeB64url(teks: string): string {
  return b64url(enc.encode(teks));
}

export function b64urlKeTeks(s: string): string {
  return dec.decode(dariB64(s));
}

export function idAcak(): string {
  return hex(acak(16));
}

/**
 * Codec byte tanpa dependency.
 *
 * Kenapa ditulis tangan dan bukan pakai `Buffer` / `atob`?
 * - `Buffer` adalah API Node, TIDAK ada di Hermes (React Native) kecuali
 *   di-polyfill; menambah polyfill global demi 40 baris kode adalah
 *   ongkos bundle & permukaan serangan yang tidak perlu.
 * - `atob`/`btoa` ada di Hermes modern tetapi bekerja pada STRING
 *   "binary" (latin-1). Untuk data biner (signature Ed25519) konversi
 *   bolak-balik lewat string sangat mudah salah dan diam-diam merusak
 *   byte >0x7F. Signature yang rusak = verifikasi gagal secara acak.
 *
 * Semua fungsi di sini murni, sinkron, dan tidak melempar untuk input
 * kotor — mereka mengembalikan `null`. Token dari luar HARUS dianggap
 * data tidak tepercaya (§5).
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64_LOOKUP: Readonly<Record<string, number>> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < B64_ALPHABET.length; i += 1) {
    map[B64_ALPHABET[i]] = i;
  }
  return map;
})();

/** Ubah base64url (RFC 4648 §5, tanpa padding) menjadi base64 standar. */
function base64UrlToBase64(input: string): string {
  const replaced = input.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = replaced.length % 4;
  if (remainder === 0) return replaced;
  if (remainder === 1) return replaced; // panjang mustahil -> biar decoder yang menolak
  return replaced + '='.repeat(4 - remainder);
}

/**
 * Decode base64 / base64url menjadi byte. Mengembalikan `null` bila ada
 * karakter di luar alfabet atau panjangnya tidak sah.
 */
export function base64ToBytes(input: string): Uint8Array | null {
  const normalized = base64UrlToBase64(input.trim());
  if (normalized.length % 4 !== 0) return null;

  const body = normalized.replace(/=+$/, '');
  const padding = normalized.length - body.length;
  if (padding > 2) return null;

  const outputLength = (normalized.length / 4) * 3 - padding;
  const out = new Uint8Array(outputLength);

  let outIndex = 0;
  for (let i = 0; i < body.length; i += 4) {
    const chunk = body.slice(i, i + 4);
    let accumulator = 0;
    let bits = 0;
    for (let j = 0; j < chunk.length; j += 1) {
      const value = B64_LOOKUP[chunk[j]];
      if (value === undefined) return null;
      accumulator = (accumulator << 6) | value;
      bits += 6;
    }
    // Buang bit sisa yang bukan byte utuh (kasus chunk terakhir).
    const usableBits = bits - (bits % 8);
    accumulator >>= bits - usableBits;
    for (let shift = usableBits - 8; shift >= 0; shift -= 8) {
      if (outIndex >= outputLength) break;
      out[outIndex] = (accumulator >> shift) & 0xff;
      outIndex += 1;
    }
  }

  return outIndex === outputLength ? out : null;
}

/** Decode base64url menjadi string UTF-8, atau `null` bila tidak sah. */
export function base64UrlToUtf8(input: string): string | null {
  const bytes = base64ToBytes(input);
  if (!bytes) return null;
  return utf8Decode(bytes);
}

/** Encode string ASCII/UTF-8 menjadi byte (UTF-8). */
export function utf8Encode(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    let code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i += 1;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return Uint8Array.from(out);
}

/** Decode byte UTF-8 menjadi string. Byte tidak sah -> U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i];
    let codePoint: number;
    let size: number;

    if (byte < 0x80) {
      codePoint = byte;
      size = 1;
    } else if ((byte & 0xe0) === 0xc0) {
      codePoint = byte & 0x1f;
      size = 2;
    } else if ((byte & 0xf0) === 0xe0) {
      codePoint = byte & 0x0f;
      size = 3;
    } else if ((byte & 0xf8) === 0xf0) {
      codePoint = byte & 0x07;
      size = 4;
    } else {
      result += '\uFFFD';
      i += 1;
      continue;
    }

    if (i + size > bytes.length) {
      result += '\uFFFD';
      break;
    }

    let valid = true;
    for (let j = 1; j < size; j += 1) {
      const cont = bytes[i + j];
      if ((cont & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (cont & 0x3f);
    }

    if (!valid) {
      result += '\uFFFD';
      i += 1;
      continue;
    }

    if (codePoint > 0xffff) {
      const adjusted = codePoint - 0x10000;
      result += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
    } else {
      result += String.fromCharCode(codePoint);
    }
    i += size;
  }
  return result;
}

/** Decode string hex (genap, case-insensitive) menjadi byte, atau `null`. */
export function hexToBytes(input: string): Uint8Array | null {
  const clean = input.trim().toLowerCase();
  if (clean.length === 0 || clean.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Perbandingan string dengan waktu (mendekati) konstan.
 *
 * Catatan jujur: JavaScript tidak memberi jaminan waktu-konstan yang
 * sesungguhnya (JIT, string interning, GC semuanya bisa membocorkan
 * timing). Fungsi ini menghilangkan kebocoran yang PALING kasar —
 * early-return pada karakter pertama yang berbeda — dan itu memang
 * sudah cukup untuk perbandingan yang dilakukan di sini (device hash,
 * bukan secret bernilai tinggi yang bisa di-oracle jutaan kali).
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLength; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

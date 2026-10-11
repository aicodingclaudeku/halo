/**
 * REGISTRY PUBLIC KEY YANG SUDAH TERVALIDASI
 * =========================================================================
 *
 * Kenapa lapisan ini ada — dan kenapa keberadaannya penting.
 *
 * Versi RC-S23 mendekode public key di dalam `licenseToken.ts`, dan
 * kunci yang formatnya rusak hanya DILEWATI diam-diam. Akibatnya, build
 * yang salah konfigurasi (mis. `EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS`
 * berisi kunci dalam format PEM) berperilaku seolah-olah kunci ADA
 * tetapi setiap token ditolak dengan `BAD_SIGNATURE`.
 *
 * Itu diagnosis yang menyesatkan: `BAD_SIGNATURE` berarti "server
 * menandatangani dengan kunci lain" — sesuatu yang akan membuat orang
 * mencurigai server, memutar kunci, atau menuduh token dipalsukan.
 * Padahal penyebabnya salah ketik di konfigurasi build.
 *
 * Aturan yang ditegakkan berkas ini:
 *
 *   - kunci divalidasi SEKALI, di satu tempat;
 *   - kunci yang rusak dilaporkan, bukan disembunyikan;
 *   - bila TIDAK ADA kunci yang sah, sistem berstatus BELUM
 *     DIKONFIGURASI (fail-closed), bukan "tanda tangan salah".
 *
 * Yang TIDAK dilakukan: melonggarkan parser agar lebih banyak bentuk
 * diterima. Bentuk yang diterima tetap persis tiga — base64, base64url,
 * hex — semuanya harus meng-decode menjadi tepat 32 byte.
 */

import { LICENSE_TOKEN_PUBLIC_KEYS, getConfiguredPublicKeyStrings } from '@/config/licensePublicKeys';
import { base64ToBytes, hexToBytes } from './bytes';
import { ED25519_PUBLIC_KEY_BYTES } from './ed25519';

export type PublicKeyRejectionReason =
  /** Kosong atau hanya spasi. */
  | 'EMPTY'
  /** Terlihat seperti PEM/SPKI — pembungkus ASN.1, bukan kunci mentah. */
  | 'WRAPPED_FORMAT'
  /** Bukan base64/base64url/hex yang sah. */
  | 'NOT_DECODABLE'
  /** Ter-decode, tetapi panjangnya bukan 32 byte. */
  | 'WRONG_LENGTH';

export interface PublicKeyEntry {
  /** Bentuk asli seperti dikonfigurasi — dipakai untuk pesan diagnostik. */
  readonly source: string;
  readonly bytes: Uint8Array;
}

export interface PublicKeyRejection {
  readonly source: string;
  readonly reason: PublicKeyRejectionReason;
  /** Panjang hasil decode bila sempat ter-decode. */
  readonly decodedLength?: number;
}

export interface PublicKeyRegistry {
  readonly valid: readonly PublicKeyEntry[];
  readonly rejected: readonly PublicKeyRejection[];
}

/** Kunci yang dibungkus ASN.1/PEM — kesalahan paling umum saat menyalin. */
function looksWrapped(value: string): boolean {
  return (
    value.includes('-----BEGIN') ||
    // SPKI/DER Ed25519 selalu diawali 302a300506032b6570 (hex) atau
    // "MCowBQYDK2Vw" (base64 dari byte yang sama).
    value.startsWith('MCowBQYDK2Vw') ||
    value.toLowerCase().startsWith('302a300506032b6570')
  );
}

function decodeOne(raw: string): PublicKeyEntry | PublicKeyRejection {
  const source = raw.trim();

  if (source.length === 0) {
    return { source: raw, reason: 'EMPTY' };
  }
  if (looksWrapped(source)) {
    return { source, reason: 'WRAPPED_FORMAT' };
  }

  // Hex dicoba lebih dulu HANYA bila panjangnya tepat 64 karakter.
  // Tanpa syarat panjang itu, string base64 yang kebetulan hanya
  // berisi karakter [0-9a-f] akan ter-decode sebagai hex dan
  // menghasilkan byte yang salah tanpa error apa pun.
  if (source.length === ED25519_PUBLIC_KEY_BYTES * 2) {
    const fromHex = hexToBytes(source);
    if (fromHex && fromHex.length === ED25519_PUBLIC_KEY_BYTES) {
      return { source, bytes: fromHex };
    }
  }

  const fromBase64 = base64ToBytes(source);
  if (!fromBase64) {
    return { source, reason: 'NOT_DECODABLE' };
  }
  if (fromBase64.length !== ED25519_PUBLIC_KEY_BYTES) {
    return { source, reason: 'WRONG_LENGTH', decodedLength: fromBase64.length };
  }
  return { source, bytes: fromBase64 };
}

function isEntry(value: PublicKeyEntry | PublicKeyRejection): value is PublicKeyEntry {
  return 'bytes' in value;
}

/**
 * Bangun registry dari konfigurasi saat ini.
 *
 * SENGAJA TIDAK DI-CACHE. Ongkosnya sepele (decode 32 byte), sedangkan
 * cache akan menjadi satu nilai tingkat modul yang menjawab "kunci apa
 * yang dipercaya" — persis bentuk yang paling nyaman untuk dibekukan
 * oleh siapa pun yang mem-patch bundle (§17/§19). Di test, cache juga
 * akan membuat kunci dari suite sebelumnya bocor ke suite berikutnya.
 *
 * Parameter `sources` adalah PARAMETER FUNGSI MURNI, bukan pintu
 * belakang. Ia tidak menyimpan state, tidak dapat mengubah kunci yang
 * dipercaya jalur verifikasi, dan seluruh pemanggil produksi
 * (`getUsablePublicKeys`, `isLicenseSigningConfigured`) memanggilnya
 * TANPA argumen sehingga selalu memakai konfigurasi sebenarnya.
 *
 * Keberadaannya membuat logika validasi dapat diuji secara langsung —
 * termasuk kasus "daftar kunci kosong", yang setelah kunci produksi
 * ditanam sudah tidak dapat lagi diciptakan lewat environment.
 * Alternatifnya adalah setter tingkat modul, dan itu justru akan
 * menjadi tombol rapi untuk memasang kunci milik penyerang.
 */
export function buildPublicKeyRegistry(
  sources: readonly string[] = getConfiguredPublicKeyStrings()
): PublicKeyRegistry {
  const valid: PublicKeyEntry[] = [];
  const rejected: PublicKeyRejection[] = [];

  for (const raw of sources) {
    const result = decodeOne(raw);
    if (isEntry(result)) {
      valid.push(result);
    } else {
      rejected.push(result);
    }
  }

  return { valid, rejected };
}

/** Kunci yang benar-benar dapat dipakai memverifikasi tanda tangan. */
export function getUsablePublicKeys(): readonly Uint8Array[] {
  return buildPublicKeyRegistry().valid.map((entry) => entry.bytes);
}

/**
 * Apakah sistem lisensi terkonfigurasi?
 *
 * PERBEDAAN PENTING dari versi sebelumnya: yang dihitung adalah kunci
 * yang SAH, bukan kunci yang tertulis. Satu kunci rusak tanpa kunci
 * sah lain = BELUM DIKONFIGURASI, dan aplikasi menampilkan pesan
 * konfigurasi — bukan "lisensi tidak valid".
 */
export function isLicenseSigningConfigured(): boolean {
  return buildPublicKeyRegistry().valid.length > 0;
}

/**
 * Ringkasan untuk layar diagnostik. TIDAK menampilkan kunci utuh:
 * public key memang bukan rahasia, tetapi menampilkannya penuh di UI
 * mengundang orang menyalinnya ke tempat yang salah. Sidik jari pendek
 * sudah cukup untuk mencocokkan dengan nilai di server.
 */
export function describePublicKeyConfiguration(): {
  readonly validCount: number;
  readonly fingerprints: readonly string[];
  readonly rejections: readonly PublicKeyRejection[];
  readonly hardcodedCount: number;
} {
  const registry = buildPublicKeyRegistry();
  const fingerprints = registry.valid.map((entry) => {
    let hex = '';
    for (let i = 0; i < 4; i += 1) hex += entry.bytes[i].toString(16).padStart(2, '0');
    let tail = '';
    for (let i = entry.bytes.length - 4; i < entry.bytes.length; i += 1) {
      tail += entry.bytes[i].toString(16).padStart(2, '0');
    }
    return `${hex}…${tail}`;
  });

  return {
    validCount: registry.valid.length,
    fingerprints,
    rejections: registry.rejected,
    hardcodedCount: LICENSE_TOKEN_PUBLIC_KEYS.length,
  };
}

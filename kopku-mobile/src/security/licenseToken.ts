/**
 * VERIFIKASI ACTIVATION TOKEN SECARA OFFLINE
 * =========================================================================
 *
 * Bentuk token yang diterbitkan server (`includes/Token.php`):
 *
 *     BASE64URL(JSON payload) . BASE64URL(signature Ed25519 64 byte)
 *
 * DETAIL YANG MUDAH SALAH — dan sudah diperiksa terhadap source server:
 * yang DITANDATANGANI adalah STRING base64url payload itu sendiri
 * (`sodium_crypto_sign_detached($body, ...)` di Token::issue), BUKAN
 * JSON hasil decode-nya. Jadi pesan yang diverifikasi di sini adalah byte
 * ASCII dari bagian pertama token, apa adanya. Kalau ini keliru
 * (mis. memverifikasi JSON hasil decode), SETIAP token akan ditolak dan
 * bug-nya sangat sulit dilacak karena "kodenya kelihatan benar".
 *
 * Server memisah token dengan `explode('.', $token, 2)` — pemisahan pada
 * titik PERTAMA. Berkas ini meniru persis perilaku itu.
 *
 * Semua kegagalan mengembalikan hasil bertipe (discriminated union),
 * TIDAK melempar. Token adalah input tidak tepercaya.
 */

import * as Crypto from 'expo-crypto';
import { base64ToBytes, base64UrlToUtf8, timingSafeEqualString, utf8Encode } from './bytes';
import { ED25519_SIGNATURE_BYTES, verifyEd25519 } from './ed25519';
import { getUsablePublicKeys, isLicenseSigningConfigured } from './publicKeyRegistry';
import {
  LICENSE_TOKEN_IAT_FUTURE_TOLERANCE_MS,
  isKnownLicenseType,
  type LicenseType,
} from '@/config/license';

/** Payload token setelah divalidasi. Hanya field yang benar-benar dipakai. */
export interface ActivationTokenPayload {
  readonly licenseId: number;
  readonly licenseType: LicenseType;
  readonly deviceHash: string;
  /**
   * Nama koperasi yang DITANDATANGANI server.
   *
   * `null` untuk token yang diterbitkan sebelum RC-S38 — field ini
   * ditambahkan secara additive, jadi token lama yang masih aktif tetap
   * sah. Begitu semua perangkat melakukan aktivasi ulang, ketiadaan
   * field ini dapat diperlakukan sebagai penolakan.
   */
  readonly cooperativeName: string | null;
  readonly activatedAt: string;
  /** `null` untuk PERMANENT. */
  readonly expiresAt: string | null;
  readonly issuedAt: string | null;
  readonly nonce: string | null;
}

export type TokenRejectionReason =
  /** Token tidak membawa binding koperasi padahal binding diwajibkan. */
  | 'COOPERATIVE_BINDING_MISSING'
  /** Token ditandatangani untuk koperasi yang berbeda. */
  | 'COOPERATIVE_MISMATCH'
  /** Public key belum dikonfigurasi di aplikasi (lihat config/licensePublicKeys.ts). */
  | 'NOT_CONFIGURED'
  /** Bentuk token salah: bukan dua bagian, base64 rusak, panjang signature salah. */
  | 'MALFORMED'
  /** Bentuk benar, tetapi tanda tangan tidak cocok dengan public key mana pun. */
  | 'BAD_SIGNATURE'
  /** Signature sah, tetapi isi payload tidak memenuhi kontrak. */
  | 'INVALID_PAYLOAD'
  /** Signature sah, tetapi token diterbitkan untuk perangkat lain. */
  | 'DEVICE_MISMATCH'
  /** Signature sah, tetapi masa berlaku sudah lewat. */
  | 'EXPIRED'
  /** `iat` berada terlalu jauh di masa depan dibanding jam yang dipakai. */
  | 'NOT_YET_VALID';

export type TokenVerificationResult =
  | { readonly ok: true; readonly payload: ActivationTokenPayload }
  | { readonly ok: false; readonly reason: TokenRejectionReason };

export interface VerifyTokenOptions {
  /** Device ID mentah perangkat ini. Server membandingkan SHA-256-nya. */
  readonly deviceId: string;
  /**
   * Waktu acuan (epoch ms, UTC) untuk pemeriksaan kedaluwarsa.
   * WAJIB diisi pemanggil dengan waktu yang sudah tahan rollback
   * (lihat `licenseClock.ts`) — sengaja TIDAK memakai `Date.now()`
   * di dalam sini supaya tidak ada jalur diam-diam yang memakai jam
   * perangkat mentah (§9).
   */
  readonly nowMs: number;
  /**
   * Nama koperasi yang sudah terikat di perangkat ini, bila ada.
   *
   * B5/B6 — begitu nilai ini ada, token WAJIB membawa
   * `cooperative_name` yang cocok. Token tanpa binding DITOLAK, bukan
   * diterima diam-diam: syarat keamanan yang hanya berlaku "kalau
   * datanya kebetulan ada" bukan syarat keamanan.
   *
   * `null` hanya untuk aktivasi pertama, saat memang belum ada binding
   * apa pun yang bisa dibandingkan.
   */
  readonly expectedCooperativeName?: string | null;
}

/** Normalisasi nama koperasi — HARUS sama dengan sisi server. */
function normalizeCooperativeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** SHA-256 hex lowercase, meniru `device_hash()` di api/_api_common.php. */
export async function computeDeviceHash(deviceId: string): Promise<string> {
  // `CryptoEncoding`, BUKAN `CryptoDigestEncoding`.
  //
  // Nama kedua itu tidak pernah ada di expo-crypto. Di perangkat,
  // `Crypto.CryptoDigestEncoding` bernilai `undefined`, sehingga
  // membaca `.HEX` darinya melempar
  //   "Cannot read property 'HEX' of undefined"
  // dan SELURUH aktivasi gagal — bukan karena lisensinya, melainkan
  // karena nama enum yang salah. HEX sebenarnya juga nilai default
  // `digestStringAsync()`, tetapi dituliskan eksplisit di sini karena
  // device_hash HARUS hex agar cocok dengan `hash('sha256', ...)` milik
  // PHP; membiarkannya bergantung pada default berarti perubahan
  // default di pustaka bisa memutus device binding secara diam-diam.
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, deviceId.trim(), {
    encoding: Crypto.CryptoEncoding.HEX,
  });
}

/** Parse tanggal ISO-8601 UTC. `null`/kosong -> null; tidak sah -> NaN sentinel. */
function parseIsoMs(value: unknown): number | null | 'INVALID' {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') return 'INVALID';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 'INVALID';
}

interface RawPayloadShape {
  license_id?: unknown;
  license_type?: unknown;
  device_hash?: unknown;
  cooperative_name?: unknown;
  activated_at?: unknown;
  expires_at?: unknown;
  iat?: unknown;
  nonce?: unknown;
}

/**
 * Verifikasi token lengkap: bentuk -> tanda tangan -> isi -> device
 * binding -> masa berlaku.
 *
 * URUTAN ITU DISENGAJA. Tanda tangan diperiksa SEBELUM isi payload
 * dipercaya sedikit pun, supaya tidak ada keputusan apa pun yang
 * diambil berdasarkan JSON yang belum terbukti berasal dari server.
 */
export async function verifyActivationTokenOffline(
  token: string,
  options: VerifyTokenOptions
): Promise<TokenVerificationResult> {
  if (!isLicenseSigningConfigured()) {
    return { ok: false, reason: 'NOT_CONFIGURED' };
  }

  if (typeof token !== 'string' || token.length === 0 || token.length > 8192) {
    return { ok: false, reason: 'MALFORMED' };
  }

  // --- 1. Bentuk token ---------------------------------------------------
  const separatorIndex = token.indexOf('.');
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const bodyPart = token.slice(0, separatorIndex);
  const signaturePart = token.slice(separatorIndex + 1);
  if (signaturePart.includes('.')) {
    return { ok: false, reason: 'MALFORMED' };
  }

  // --- 2. Decode signature ----------------------------------------------
  const signature = base64ToBytes(signaturePart);
  if (!signature || signature.length !== ED25519_SIGNATURE_BYTES) {
    return { ok: false, reason: 'MALFORMED' };
  }

  // --- 3. Decode payload (bentuk saja; isinya belum dipercaya) -----------
  const payloadJson = base64UrlToUtf8(bodyPart);
  if (payloadJson === null) {
    return { ok: false, reason: 'MALFORMED' };
  }

  // --- 4. Verifikasi Ed25519 terhadap STRING base64url payload ----------
  const message = utf8Encode(bodyPart);
  let signatureValid = false;
  // Kunci di sini SUDAH tervalidasi (32 byte, format benar) oleh
  // `publicKeyRegistry`. Tidak ada lagi cabang "lewati kunci rusak"
  // yang diam-diam mengubah salah-konfigurasi menjadi BAD_SIGNATURE.
  //
  // Tidak break-early demi konsistensi waktu antar-kunci; jumlahnya
  // selalu kecil (1-2 saat rotasi), jadi ongkosnya tidak berarti.
  for (const publicKey of getUsablePublicKeys()) {
    if (await verifyEd25519(signature, message, publicKey)) {
      signatureValid = true;
    }
  }
  if (!signatureValid) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }

  // --- 5. Parse & validasi isi (sekarang baru boleh dipercaya) ----------
  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: 'INVALID_PAYLOAD' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'INVALID_PAYLOAD' };
  }
  const shape = raw as RawPayloadShape;

  const licenseId =
    typeof shape.license_id === 'number' && Number.isInteger(shape.license_id)
      ? shape.license_id
      : null;
  if (licenseId === null || licenseId <= 0) {
    return { ok: false, reason: 'INVALID_PAYLOAD' };
  }

  if (!isKnownLicenseType(shape.license_type)) {
    return { ok: false, reason: 'INVALID_PAYLOAD' };
  }
  const licenseType = shape.license_type;

  const deviceHash = shape.device_hash;
  if (typeof deviceHash !== 'string' || !/^[0-9a-f]{64}$/.test(deviceHash)) {
    return { ok: false, reason: 'INVALID_PAYLOAD' };
  }

  const activatedAtMs = parseIsoMs(shape.activated_at);
  if (activatedAtMs === 'INVALID' || activatedAtMs === null) {
    return { ok: false, reason: 'INVALID_PAYLOAD' };
  }

  const expiresAtMs = parseIsoMs(shape.expires_at);
  if (expiresAtMs === 'INVALID') {
    return { ok: false, reason: 'INVALID_PAYLOAD' };
  }

  // Konsistensi silang: HANYA PERMANENT yang boleh tanpa kedaluwarsa.
  // Tanpa cek ini, token TRIAL yang `expires_at`-nya hilang (mis. server
  // salah, atau payload dipotong) akan diperlakukan seumur hidup — persis
  // celah yang paling menguntungkan penyerang.
  //
  // Sebaliknya, PERMANENT yang JUSTRU membawa `expires_at` tetap
  // dihormati batas waktunya di langkah 7. Arah keputusannya selalu
  // "lebih ketat", tidak pernah "lebih longgar".
  if (licenseType !== 'PERMANENT' && expiresAtMs === null) {
    return { ok: false, reason: 'INVALID_PAYLOAD' };
  }

  const issuedAtMs = parseIsoMs(shape.iat);
  if (issuedAtMs === 'INVALID') {
    return { ok: false, reason: 'INVALID_PAYLOAD' };
  }

  // --- 6. Device binding -------------------------------------------------
  const expectedHash = await computeDeviceHash(options.deviceId);
  if (!timingSafeEqualString(deviceHash, expectedHash)) {
    return { ok: false, reason: 'DEVICE_MISMATCH' };
  }

  // --- 6b. Binding koperasi (B5/B6) --------------------------------------
  //
  // Nilai yang dibandingkan berasal dari payload YANG DITANDATANGANI,
  // bukan dari field JSON di luar token dan bukan dari input pengguna.
  // Nama koperasi yang diketik di layar setup tidak pernah menjadi
  // otoritas keamanan — ia hanya dikirim ke server, dan server yang
  // memutuskan.
  const expected = options.expectedCooperativeName ?? null;
  if (expected !== null && expected.trim() !== '') {
    const inToken =
      typeof shape.cooperative_name === 'string' ? shape.cooperative_name.trim() : '';

    if (inToken === '') {
      return { ok: false, reason: 'COOPERATIVE_BINDING_MISSING' };
    }
    if (normalizeCooperativeName(inToken) !== normalizeCooperativeName(expected)) {
      return { ok: false, reason: 'COOPERATIVE_MISMATCH' };
    }
  }

  // --- 7. Waktu ----------------------------------------------------------
  if (issuedAtMs !== null && issuedAtMs - options.nowMs > LICENSE_TOKEN_IAT_FUTURE_TOLERANCE_MS) {
    return { ok: false, reason: 'NOT_YET_VALID' };
  }
  if (expiresAtMs !== null && options.nowMs >= expiresAtMs) {
    return { ok: false, reason: 'EXPIRED' };
  }

  return {
    ok: true,
    payload: {
      licenseId,
      licenseType,
      deviceHash,
      cooperativeName:
        typeof shape.cooperative_name === 'string' && shape.cooperative_name.trim() !== ''
          ? shape.cooperative_name
          : null,
      activatedAt: String(shape.activated_at),
      expiresAt: typeof shape.expires_at === 'string' ? shape.expires_at : null,
      issuedAt: typeof shape.iat === 'string' ? shape.iat : null,
      nonce: typeof shape.nonce === 'string' ? shape.nonce : null,
    },
  };
}

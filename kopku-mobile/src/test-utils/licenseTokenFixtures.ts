/**
 * PABRIK TOKEN UNTUK TEST — meniru `includes/Token.php` di server.
 *
 * Tujuannya bukan "bikin string yang lolos", melainkan MENIRU SERVER
 * SEPERSIS MUNGKIN, supaya test membuktikan aplikasi kompatibel dengan
 * penerbit token yang sesungguhnya. Dua detail yang paling mudah salah
 * dan karena itu ditiru secara eksplisit:
 *
 *   1. Yang DITANDATANGANI adalah STRING base64url payload, bukan JSON
 *      hasil decode-nya (`sodium_crypto_sign_detached($body, ...)`).
 *   2. base64url TANPA padding (`rtrim(strtr(base64_encode(...)), '=')`).
 *
 * Kalau salah satu dari dua hal itu ditiru keliru, test akan "hijau"
 * terhadap format karangan sendiri sementara aplikasi menolak token
 * asli di lapangan — kegagalan yang paling mahal untuk ditemukan.
 */

import { createHash, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'crypto';

export interface TestKeyPair {
  readonly privateKey: KeyObject;
  /** 32 byte public key mentah, base64 standar — bentuk yang ditanam di aplikasi. */
  readonly publicKeyBase64: string;
  readonly publicKeyHex: string;
}

export function generateTestKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  return {
    privateKey,
    publicKeyBase64: Buffer.from(raw).toString('base64'),
    publicKeyHex: Buffer.from(raw).toString('hex'),
  };
}

function base64url(input: Uint8Array): string {
  const buffer = Buffer.from(input);
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `device_hash()` di `api/_api_common.php`: SHA-256 hex dari device_id yang di-trim. */
export function deviceHashOf(deviceId: string): string {
  return createHash('sha256').update(deviceId.trim()).digest('hex');
}

export interface TokenPayloadInput {
  license_id?: unknown;
  license_type?: unknown;
  cooperative_name?: unknown;
  device_hash?: unknown;
  activated_at?: unknown;
  expires_at?: unknown;
  nonce?: unknown;
  iat?: unknown;
}

/** Terbitkan token bertanda tangan sah. Payload boleh sengaja dirusak oleh test. */
export function issueTestToken(keyPair: TestKeyPair, payload: TokenPayloadInput): string {
  const json = JSON.stringify(payload);
  const body = base64url(Buffer.from(json, 'utf8'));
  const signature = nodeSign(null, Buffer.from(body, 'utf8'), keyPair.privateKey);
  return `${body}.${base64url(signature)}`;
}

/** Payload PERMANENT yang sah untuk `deviceId`, dengan override opsional. */
export function permanentPayload(
  deviceId: string,
  overrides: TokenPayloadInput = {}
): TokenPayloadInput {
  return {
    license_id: 42,
    license_type: 'PERMANENT',
    device_hash: deviceHashOf(deviceId),
    activated_at: '2026-01-15T08:00:00+00:00',
    expires_at: null,
    nonce: 'a1b2c3d4e5f60718',
    iat: '2026-01-15T08:00:00+00:00',
    ...overrides,
  };
}

/** Payload TRIAL_7D dengan `expires_at` yang bisa diatur test. */
export function trialPayload(
  deviceId: string,
  expiresAtIso: string,
  overrides: TokenPayloadInput = {}
): TokenPayloadInput {
  return {
    license_id: 7,
    license_type: 'TRIAL_7D',
    device_hash: deviceHashOf(deviceId),
    activated_at: '2026-01-15T08:00:00+00:00',
    expires_at: expiresAtIso,
    nonce: 'ffeeddccbbaa9988',
    iat: '2026-01-15T08:00:00+00:00',
    ...overrides,
  };
}

/**
 * Rusakkan satu byte tanda tangan tanpa mengubah panjangnya.
 *
 * Dipakai untuk membedakan dua kegagalan yang sangat berbeda maknanya:
 * MALFORMED (bentuknya sudah salah) vs BAD_SIGNATURE (bentuknya benar,
 * tanda tangannya yang tidak cocok). Kalau keduanya tertukar, pesan ke
 * pengguna ikut salah dan diagnosis di lapangan jadi menyesatkan.
 */
export function tamperSignature(token: string): string {
  const dot = token.indexOf('.');
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const raw = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  raw[0] ^= 0xff;
  return `${body}.${base64url(raw)}`;
}

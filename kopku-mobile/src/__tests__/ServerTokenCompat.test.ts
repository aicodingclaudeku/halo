import { createHash, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'crypto';
import { verifyActivationTokenOffline } from '@/security/licenseToken';
import { generateTestKeyPair } from '@/test-utils/licenseTokenFixtures';

/**
 * KONTRAK SERVER ↔ APK — TEST KOMPATIBILITAS
 * =========================================================================
 *
 * MASALAH YANG DIPECAHKAN SUITE INI.
 * Token diterbitkan PHP (`includes/Token.php`) dan diverifikasi
 * TypeScript (`src/security/licenseToken.ts`). Keduanya diuji terpisah
 * dan bisa sama-sama "lulus" sambil tetap tidak kompatibel — cukup satu
 * beda kecil dalam encoding untuk membuat SETIAP aktivasi gagal di
 * lapangan dengan `BAD_SIGNATURE`, sementara kedua sisi terlihat benar.
 *
 * Yang paling berbahaya justru bukan bug besar, melainkan detail seperti:
 *   - padding base64url (PHP `rtrim(..., '=')` — tanpa padding);
 *   - `JSON_UNESCAPED_SLASHES` (PHP default menulis `\/`, bukan `/`);
 *   - `JSON_UNESCAPED_UNICODE` (PHP default menulis `\uXXXX`);
 *   - apa yang sebenarnya ditandatangani: STRING base64url payload,
 *     bukan JSON hasil decode.
 *
 * `issueLikePhp()` di bawah adalah port setia dari `Token::issue()`.
 * Token yang dihasilkannya diberikan ke verifier APK yang SESUNGGUHNYA —
 * bukan tiruan — sehingga suite ini menguji kontraknya, bukan asumsinya.
 *
 * BATAS YANG HARUS DIAKUI: ini port, bukan PHP yang dijalankan. Ia
 * membuktikan kedua ALGORITMA sepakat. Bahwa PHP produksi berperilaku
 * persis seperti port ini tetap harus dibuktikan dengan
 * `tools/license_selftest.php` di server.
 */

const DEVICE_ID = 'KOPKU-INST-' + 'a'.repeat(64);
const NOW = Date.parse('2026-09-07T00:00:00Z');

let keyPair: { privateKey: KeyObject; publicKeyBase64: string };
let previousEnv: string | undefined;

/** `base64url()` di Token.php: base64 standar, +/ -> -_, padding dibuang. */
function base64urlPhp(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `DATE_ATOM` PHP: 2026-09-07T00:00:00+00:00 */
function dateAtom(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/** `device_hash()` di api/_api_common.php. */
function deviceHashPhp(deviceId: string): string {
  return createHash('sha256').update(deviceId.trim()).digest('hex');
}

/**
 * Port setia `Token::issue()`.
 *
 * Urutan kunci mengikuti array yang dibangun `api/activate.php`, lalu
 * `iat` ditambahkan terakhir oleh `issue()` — sama seperti PHP, yang
 * mempertahankan urutan penyisipan saat `json_encode`.
 */
function issueLikePhp(
  privateKey: KeyObject,
  fields: {
    license_id: number;
    license_type: string;
    device_hash: string;
    activated_at: string;
    expires_at: string | null;
    nonce: string;
    iat: string;
  }
): string {
  // JSON.stringify tidak meng-escape '/' dan menulis UTF-8 apa adanya,
  // yang cocok dengan JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE.
  const json = JSON.stringify(fields);
  const body = base64urlPhp(Buffer.from(json, 'utf8'));
  const signature = nodeSign(null, Buffer.from(body, 'utf8'), privateKey);
  return `${body}.${base64urlPhp(signature)}`;
}

function permanentFields(deviceId: string, overrides: Record<string, unknown> = {}) {
  return {
    license_id: 1,
    license_type: 'PERMANENT',
    device_hash: deviceHashPhp(deviceId),
    activated_at: dateAtom(Date.parse('2026-09-01T08:00:00Z')),
    expires_at: null,
    nonce: 'a1b2c3d4e5f60718',
    iat: dateAtom(Date.parse('2026-09-01T08:00:00Z')),
    ...overrides,
  } as Parameters<typeof issueLikePhp>[1];
}

beforeAll(() => {
  const generated = generateKeyPairSync('ed25519');
  const raw = generated.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  keyPair = {
    privateKey: generated.privateKey,
    publicKeyBase64: Buffer.from(raw).toString('base64'),
  };
  previousEnv = process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS;
  process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS = keyPair.publicKeyBase64;
});

afterAll(() => {
  if (previousEnv === undefined) {
    delete process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS;
  } else {
    process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS = previousEnv;
  }
});

describe('bentuk token yang dihasilkan Token::issue()', () => {
  it('terdiri dari dua segmen base64url tanpa padding', () => {
    const token = issueLikePhp(keyPair.privateKey, permanentFields(DEVICE_ID));
    expect(token).not.toContain('=');
    expect(token.split('.')).toHaveLength(2);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('segmen tanda tangan ter-decode menjadi tepat 64 byte', () => {
    const token = issueLikePhp(keyPair.privateKey, permanentFields(DEVICE_ID));
    const signature = Buffer.from(token.split('.')[1], 'base64url');
    expect(signature.length).toBe(64);
  });

  it('payload JSON tidak meng-escape garis miring (JSON_UNESCAPED_SLASHES)', () => {
    // PHP default menulis "\/" — kalau flag itu hilang, byte payload
    // berubah dan tanda tangannya ikut berubah. Diperiksa lewat nilai
    // yang memang mengandung '/'.
    const token = issueLikePhp(
      keyPair.privateKey,
      permanentFields(DEVICE_ID, { nonce: 'a/b/c' })
    );
    const json = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
    expect(json).toContain('"a/b/c"');
    expect(json).not.toContain('a\\/b');
  });
});

describe('APK menerima token terbitan server', () => {
  it('A+B. token PERMANENT yang sah diterima verifier APK', async () => {
    const token = issueLikePhp(keyPair.privateKey, permanentFields(DEVICE_ID));
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.licenseType).toBe('PERMANENT');
      expect(result.payload.expiresAt).toBeNull();
      expect(result.payload.licenseId).toBe(1);
    }
  });

  it('token TRIAL_7D yang belum kedaluwarsa diterima', async () => {
    const token = issueLikePhp(
      keyPair.privateKey,
      permanentFields(DEVICE_ID, {
        license_type: 'TRIAL_7D',
        expires_at: dateAtom(NOW + 5 * 24 * 60 * 60 * 1000),
      })
    );
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result.ok).toBe(true);
  });

  it('L. tanda tangan memang dibuat terhadap STRING base64url payload', async () => {
    // Kontrol negatif untuk kontrak yang paling mudah salah: kalau
    // server menandatangani JSON hasil decode, APK menolak semuanya.
    const fields = permanentFields(DEVICE_ID);
    const json = JSON.stringify(fields);
    const body = base64urlPhp(Buffer.from(json, 'utf8'));

    const signedOverJson = nodeSign(null, Buffer.from(json, 'utf8'), keyPair.privateKey);
    const wrongToken = `${body}.${base64urlPhp(signedOverJson)}`;
    const wrong = await verifyActivationTokenOffline(wrongToken, {
      deviceId: DEVICE_ID,
      nowMs: NOW,
    });
    expect(wrong).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });

    const signedOverBody = nodeSign(null, Buffer.from(body, 'utf8'), keyPair.privateKey);
    const rightToken = `${body}.${base64urlPhp(signedOverBody)}`;
    const right = await verifyActivationTokenOffline(rightToken, {
      deviceId: DEVICE_ID,
      nowMs: NOW,
    });
    expect(right.ok).toBe(true);
  });
});

describe('APK menolak token yang cacat', () => {
  it('C. payload diubah setelah ditandatangani', async () => {
    const fields = permanentFields(DEVICE_ID, {
      license_type: 'TRIAL_7D',
      expires_at: dateAtom(NOW - 24 * 60 * 60 * 1000),
    });
    const token = issueLikePhp(keyPair.privateKey, fields);
    const [, signature] = token.split('.');

    const forged = { ...fields, license_type: 'PERMANENT', expires_at: null };
    const forgedBody = base64urlPhp(Buffer.from(JSON.stringify(forged), 'utf8'));

    const result = await verifyActivationTokenOffline(`${forgedBody}.${signature}`, {
      deviceId: DEVICE_ID,
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('D. tanda tangan diubah satu byte', async () => {
    const token = issueLikePhp(keyPair.privateKey, permanentFields(DEVICE_ID));
    const [body, signature] = token.split('.');
    const raw = Buffer.from(signature, 'base64url');
    raw[0] ^= 0xff;

    const result = await verifyActivationTokenOffline(`${body}.${base64urlPhp(raw)}`, {
      deviceId: DEVICE_ID,
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('E. token ditandatangani signing key lain', async () => {
    const attacker = generateTestKeyPair();
    const fields = permanentFields(DEVICE_ID);
    const body = base64urlPhp(Buffer.from(JSON.stringify(fields), 'utf8'));
    const signature = nodeSign(null, Buffer.from(body, 'utf8'), attacker.privateKey);

    const result = await verifyActivationTokenOffline(`${body}.${base64urlPhp(signature)}`, {
      deviceId: DEVICE_ID,
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('F. token diterbitkan untuk perangkat lain', async () => {
    const token = issueLikePhp(
      keyPair.privateKey,
      permanentFields(DEVICE_ID, { device_hash: deviceHashPhp('KOPKU-INST-' + 'b'.repeat(64)) })
    );
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result).toEqual({ ok: false, reason: 'DEVICE_MISMATCH' });
  });

  it('G. token TRIAL yang sudah lewat masa berlaku', async () => {
    const token = issueLikePhp(
      keyPair.privateKey,
      permanentFields(DEVICE_ID, {
        license_type: 'TRIAL_3D',
        expires_at: dateAtom(NOW - 60 * 60 * 1000),
      })
    );
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('license_type di luar daftar server ditolak', async () => {
    // Server hanya menerbitkan PERMANENT, TRIAL_3D, TRIAL_7D, TRIAL_1M
    // (lihat switch di api/activate.php). Nilai lain berarti payload
    // dikarang atau kedua sisi tidak sinkron.
    const token = issueLikePhp(
      keyPair.privateKey,
      permanentFields(DEVICE_ID, { license_type: 'LIFETIME_PLUS' })
    );
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result).toEqual({ ok: false, reason: 'INVALID_PAYLOAD' });
  });

  it('TRIAL tanpa expires_at ditolak', async () => {
    const token = issueLikePhp(
      keyPair.privateKey,
      permanentFields(DEVICE_ID, { license_type: 'TRIAL_1M', expires_at: null })
    );
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result).toEqual({ ok: false, reason: 'INVALID_PAYLOAD' });
  });
});

describe('keempat license_type server dapat dibaca APK', () => {
  it.each([
    ['PERMANENT', null],
    ['TRIAL_3D', dateAtom(NOW + 3 * 24 * 60 * 60 * 1000)],
    ['TRIAL_7D', dateAtom(NOW + 7 * 24 * 60 * 60 * 1000)],
    ['TRIAL_1M', dateAtom(NOW + 30 * 24 * 60 * 60 * 1000)],
  ])('%s diterima', async (licenseType, expiresAt) => {
    const token = issueLikePhp(
      keyPair.privateKey,
      permanentFields(DEVICE_ID, { license_type: licenseType, expires_at: expiresAt })
    );
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result.ok).toBe(true);
  });
});

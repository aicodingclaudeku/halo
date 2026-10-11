import { createHash } from 'crypto';
import {
  computeDeviceHash,
  verifyActivationTokenOffline,
} from '@/security/licenseToken';
import {
  deviceHashOf,
  generateTestKeyPair,
  issueTestToken,
  permanentPayload,
  tamperSignature,
  trialPayload,
  type TestKeyPair,
} from '@/test-utils/licenseTokenFixtures';

/**
 * §24 — VERIFIKASI TOKEN OFFLINE.
 *
 * Semua token di suite ini ditandatangani dengan Ed25519 SUNGGUHAN
 * (lihat komentar di `nobleEd25519Mock.ts`). Tidak ada satu pun
 * assertion di sini yang lolos hanya karena mock mengembalikan `true`.
 *
 * Kunci publik disuntikkan lewat `EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS`
 * — jalur yang sama persis dengan build produksi, bukan pintu belakang
 * khusus test.
 */

const DEVICE_ID = 'KOPKU-INST-' + 'a'.repeat(64);
const OTHER_DEVICE_ID = 'KOPKU-INST-' + 'b'.repeat(64);
const NOW = Date.parse('2026-02-01T00:00:00Z');

let keyPair: TestKeyPair;
let previousEnv: string | undefined;

beforeAll(() => {
  keyPair = generateTestKeyPair();
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

describe('verifyActivationTokenOffline', () => {
  it('menerima token PERMANENT yang sah untuk perangkat ini', async () => {
    const token = issueTestToken(keyPair, permanentPayload(DEVICE_ID));
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.licenseType).toBe('PERMANENT');
      expect(result.payload.expiresAt).toBeNull();
      expect(result.payload.licenseId).toBe(42);
    }
  });

  it('menerima token TRIAL yang belum kedaluwarsa', async () => {
    const token = issueTestToken(keyPair, trialPayload(DEVICE_ID, '2026-02-10T00:00:00+00:00'));
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result.ok).toBe(true);
  });

  it('menolak token TRIAL yang sudah lewat masa berlaku', async () => {
    const token = issueTestToken(keyPair, trialPayload(DEVICE_ID, '2026-01-20T00:00:00+00:00'));
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('menolak tanda tangan yang dirusak satu byte', async () => {
    // Bentuk token tetap sempurna; HANYA tanda tangannya yang salah.
    // Ini yang membedakan BAD_SIGNATURE dari MALFORMED.
    const token = tamperSignature(issueTestToken(keyPair, permanentPayload(DEVICE_ID)));
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('menolak token yang ditandatangani kunci lain', async () => {
    const attacker = generateTestKeyPair();
    const token = issueTestToken(attacker, permanentPayload(DEVICE_ID));
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('menolak payload yang diubah setelah ditandatangani', async () => {
    // Skenario nyata: seseorang mengubah TRIAL menjadi PERMANENT di
    // dalam token yang tersimpan. Tanda tangan menutupi payload, jadi
    // perubahan sekecil apa pun harus terdeteksi.
    const token = issueTestToken(keyPair, trialPayload(DEVICE_ID, '2026-01-20T00:00:00+00:00'));
    const [body, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    decoded.license_type = 'PERMANENT';
    decoded.expires_at = null;
    const forgedBody = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');

    const result = await verifyActivationTokenOffline(`${forgedBody}.${signature}`, {
      deviceId: DEVICE_ID,
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('menolak token milik perangkat lain', async () => {
    const token = issueTestToken(keyPair, permanentPayload(OTHER_DEVICE_ID));
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result).toEqual({ ok: false, reason: 'DEVICE_MISMATCH' });
  });

  it.each([
    ['string kosong', ''],
    ['tanpa pemisah titik', 'abcdefgh'],
    ['payload kosong', '.abcd'],
    ['tanda tangan kosong', 'abcd.'],
    ['tiga bagian', 'aaaa.bbbb.cccc'],
    ['base64 rusak', 'aa*aa.bbbb'],
  ])('menolak token malformed: %s', async (_label, token) => {
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('MALFORMED');
  });

  it('menolak tanda tangan yang panjangnya bukan 64 byte', async () => {
    const token = issueTestToken(keyPair, permanentPayload(DEVICE_ID));
    const body = token.split('.')[0];
    const shortSignature = Buffer.alloc(32).toString('base64url');
    const result = await verifyActivationTokenOffline(`${body}.${shortSignature}`, {
      deviceId: DEVICE_ID,
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('menolak TRIAL yang expires_at-nya dihilangkan', async () => {
    // Konsistensi silang: hanya PERMANENT yang boleh tanpa kedaluwarsa.
    // Tanpa aturan ini, menghapus satu field akan menyulap trial jadi
    // lisensi seumur hidup.
    const token = issueTestToken(
      keyPair,
      trialPayload(DEVICE_ID, '2026-02-10T00:00:00+00:00', { expires_at: null })
    );
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result).toEqual({ ok: false, reason: 'INVALID_PAYLOAD' });
  });

  it.each([
    ['license_id bukan angka', { license_id: 'dua' }],
    ['license_id nol', { license_id: 0 }],
    ['license_type asing', { license_type: 'LIFETIME_PLUS' }],
    ['device_hash bukan sha256 hex', { device_hash: 'bukan-hash' }],
    ['activated_at hilang', { activated_at: null }],
    ['expires_at bukan tanggal', { expires_at: 'kapan-kapan' }],
  ])('menolak payload tidak sah: %s', async (_label, override) => {
    const token = issueTestToken(keyPair, permanentPayload(DEVICE_ID, override));
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INVALID_PAYLOAD');
  });

  it('menolak token yang iat-nya jauh di masa depan', async () => {
    const token = issueTestToken(
      keyPair,
      permanentPayload(DEVICE_ID, { iat: '2027-01-01T00:00:00+00:00' })
    );
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result).toEqual({ ok: false, reason: 'NOT_YET_VALID' });
  });

  it('menerima token yang iat-nya sedikit di depan jam perangkat', async () => {
    // Perangkat yang jamnya tertinggal beberapa menit adalah hal biasa;
    // menolaknya akan membuat aktivasi gagal tanpa sebab yang jelas.
    const token = issueTestToken(
      keyPair,
      permanentPayload(DEVICE_ID, { iat: new Date(NOW + 60_000).toISOString() })
    );
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    expect(result.ok).toBe(true);
  });

  it('menerima public key dalam bentuk hex maupun base64', async () => {
    const token = issueTestToken(keyPair, permanentPayload(DEVICE_ID));
    process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS = keyPair.publicKeyHex;
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS = keyPair.publicKeyBase64;
    expect(result.ok).toBe(true);
  });

  it('menerima token lama saat rotasi kunci (dua public key aktif)', async () => {
    const newKey = generateTestKeyPair();
    const oldToken = issueTestToken(keyPair, permanentPayload(DEVICE_ID));
    process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS = `${newKey.publicKeyBase64},${keyPair.publicKeyBase64}`;
    const result = await verifyActivationTokenOffline(oldToken, { deviceId: DEVICE_ID, nowMs: NOW });
    process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS = keyPair.publicKeyBase64;
    expect(result.ok).toBe(true);
  });

  it('mengabaikan public key yang formatnya rusak tanpa ikut gagal', async () => {
    const token = issueTestToken(keyPair, permanentPayload(DEVICE_ID));
    process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS = `bukan-kunci,${keyPair.publicKeyBase64}`;
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS = keyPair.publicKeyBase64;
    expect(result.ok).toBe(true);
  });

  it('kunci produksi yang tertanam menolak token dari kunci lain', async () => {
    // Menggantikan test NOT_CONFIGURED yang lama.
    //
    // Sejak kunci produksi ditanam di `licensePublicKeys.ts`, keadaan
    // "belum dikonfigurasi" TIDAK DAPAT LAGI diciptakan dengan menghapus
    // environment variable — dan itu memang tujuannya. Logika
    // fail-closed-nya tetap diuji langsung di LicenseCrypto.test.ts
    // lewat `buildPublicKeyRegistry([])`.
    //
    // Yang diuji di sini adalah sifat yang menggantikannya: dengan hanya
    // kunci produksi yang aktif, token yang ditandatangani kunci lain
    // tetap ditolak.
    const token = issueTestToken(keyPair, permanentPayload(DEVICE_ID));
    delete process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS;
    const result = await verifyActivationTokenOffline(token, { deviceId: DEVICE_ID, nowMs: NOW });
    process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS = keyPair.publicKeyBase64;
    expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });
});

describe('computeDeviceHash — bentuk keluaran', () => {
  /**
   * Test ini ada karena bug enum `CryptoDigestEncoding` (yang tidak
   * pernah ada di expo-crypto) melempar di perangkat dan menggagalkan
   * SETIAP aktivasi, sementara seluruh suite tetap hijau — mock lama
   * mengekspor nama fiktif itu, jadi kekeliruannya tidak pernah terlihat.
   *
   * Yang dikunci di sini adalah BENTUK keluarannya, bukan sekadar
   * "fungsinya tidak melempar": device_hash harus SHA-256 heksadesimal
   * huruf kecil 64 karakter, karena itulah yang dihasilkan
   * `hash('sha256', ...)` di PHP. Bentuk lain apa pun — base64,
   * huruf besar, panjang berbeda — berarti device binding gagal
   * total di setiap perangkat.
   */
  it('menghasilkan SHA-256 hex tepat 64 karakter', async () => {
    const hash = await computeDeviceHash(DEVICE_ID);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('bukan base64 dan tidak memakai huruf besar', async () => {
    const hash = await computeDeviceHash(DEVICE_ID);
    expect(hash).not.toMatch(/[+/=]/);
    expect(hash).not.toMatch(/[A-Z]/);
  });

  it('deterministik untuk masukan yang sama', async () => {
    const a = await computeDeviceHash(DEVICE_ID);
    const b = await computeDeviceHash(DEVICE_ID);
    expect(a).toBe(b);
  });

  it('berbeda untuk perangkat yang berbeda', async () => {
    const a = await computeDeviceHash(DEVICE_ID);
    const b = await computeDeviceHash(OTHER_DEVICE_ID);
    expect(a).not.toBe(b);
  });

  it('cocok dengan digest SHA-256 yang dihitung independen', async () => {
    // Dibandingkan dengan `crypto` Node, bukan dengan fixture yang
    // memakai jalur kode yang sama — kalau keduanya salah bersama,
    // perbandingannya tidak membuktikan apa pun.
    const expected = createHash('sha256').update(DEVICE_ID).digest('hex');
    expect(await computeDeviceHash(DEVICE_ID)).toBe(expected);
  });
});

describe('computeDeviceHash', () => {
  it('menghasilkan hash yang sama persis dengan device_hash() di server', async () => {
    // Kalau kedua sisi menghitung hash dengan cara berbeda, SETIAP
    // aktivasi akan gagal dengan DEVICE_MISMATCH — dan penyebabnya
    // hampir mustahil ditebak dari pesan errornya.
    expect(await computeDeviceHash(DEVICE_ID)).toBe(deviceHashOf(DEVICE_ID));
  });

  it('mengabaikan spasi di ujung, sama seperti trim() di server', async () => {
    expect(await computeDeviceHash(`  ${DEVICE_ID}  `)).toBe(deviceHashOf(DEVICE_ID));
  });
});

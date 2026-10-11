import {
  LICENSE_GRACE_PERIOD_MS,
  LICENSE_VERIFY_INTERVAL_MS,
} from '@/config/license';
import {
  activateLicense,
  clearLicense,
  deactivateLicense,
  getLicenseStatus,
  hasValidLocalLicense,
  isClockRollbackDetected,
  isLicenseExpired,
  normalizeLicenseKey,
  verifyLicense,
  verifyLicenseIfDue,
} from '@/services/LicenseService';
import { getDeviceId, maskDeviceId, __resetDeviceIdCacheForTests } from '@/security/deviceId';
import { __clear, __dump } from '@/test-utils/expoSecureStoreMock';
import { verifyActivationTokenOffline } from '@/security/licenseToken';
import {
  deviceHashOf,
  generateTestKeyPair,
  issueTestToken,
  permanentPayload,
  trialPayload,
  type TestKeyPair,
} from '@/test-utils/licenseTokenFixtures';

/**
 * §24 — ALUR LICENSE SERVICE.
 *
 * Fokus suite ini adalah KEPUTUSAN, bukan HTTP: kapan aplikasi boleh
 * dibuka, kapan tidak, dan apa yang terjadi pada state lokal di setiap
 * cabang. Server ditiru pada level `fetch` supaya bentuk respons yang
 * diuji persis bentuk yang dikirim `api/*.php`.
 */

const BASE = Date.parse('2026-09-06T10:00:00Z');
const VALID_KEY = 'KPK-ABCD-EFGH-JKLM-NPQR';

let keyPair: TestKeyPair;
let previousEnv: string | undefined;
let nowSpy: jest.SpyInstance<number, []>;
let fetchMock: jest.Mock;

/** Bentuk respons `fetch` yang cukup untuk dipakai LicenseService. */
function jsonResponse(body: unknown, status = 200, dateHeader?: string): Response {
  const headers = new Map<string, string>();
  if (dateHeader) headers.set('date', dateHeader);
  return {
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function networkError(): never {
  throw new Error('Network request failed');
}

function abortError(): never {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  throw error;
}

async function currentDeviceId(): Promise<string> {
  return getDeviceId();
}

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

beforeEach(() => {
  __clear();
  __resetDeviceIdCacheForTests();
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(BASE);
  fetchMock = jest.fn();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

afterEach(() => {
  nowSpy.mockRestore();
});

/** Jalankan aktivasi yang berhasil dan kembalikan token yang diterbitkan. */
async function activateSuccessfully(payloadOverride?: Record<string, unknown>): Promise<string> {
  const deviceId = await currentDeviceId();
  // Token menyertakan `cooperative_name`, sama seperti yang diterbitkan
  // server sejak RC-S38B. Tanpa itu aktivasi ditolak dengan
  // COOPERATIVE_BINDING_MISSING — dan memang seharusnya begitu.
  const token = issueTestToken(
    keyPair,
    permanentPayload(deviceId, { cooperative_name: 'Koperasi Uji', ...(payloadOverride ?? {}) })
  );
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      success: true,
      message: 'License activated successfully',
      license_type: 'PERMANENT',
      activated_at: '2026-01-15T08:00:00+00:00',
      expires_at: null,
      activation_token: token,
    })
  );
  const result = await activateLicense({ licenseKey: VALID_KEY, cooperativeName: 'Koperasi Uji' });
  expect(result.ok).toBe(true);
  return token;
}

// ---------------------------------------------------------------------------

describe('normalizeLicenseKey', () => {
  it('menormalisasi persis seperti LicenseKey::normalize() di server', () => {
    // Kalau kedua sisi menormalisasi dengan cara berbeda, key yang sah
    // bisa ditolak sebelum sempat dikirim — atau lebih buruk, dikirim
    // dalam bentuk yang hash-nya tidak pernah cocok di database.
    expect(normalizeLicenseKey('  kpk-abcd-efgh-jklm-npqr  '.trim())).toBe(VALID_KEY);
    expect(normalizeLicenseKey('KPK ABCD EFGH JKLM NPQR')).toBe('KPKABCDEFGHJKLMNPQR');
    expect(normalizeLicenseKey('kpk-abcd-efgh-jklm-npqr')).toBe(VALID_KEY);
  });
});

describe('activateLicense', () => {
  it('menyimpan token dan mengizinkan aplikasi setelah aktivasi berhasil', async () => {
    await activateSuccessfully();

    const status = await getLicenseStatus();
    expect(status.state).toBe('ACTIVE');
    expect(status.allowAppAccess).toBe(true);
    expect(status.licenseType).toBe('PERMANENT');
    expect(status.cooperativeName).toBe('Koperasi Uji');
    expect(await hasValidLocalLicense()).toBe(true);
  });

  it('menyimpan token di SecureStore, bukan di tempat lain', async () => {
    const token = await activateSuccessfully();
    const dump = __dump();
    expect(dump.kopku_license_activation_token).toBe(token);
    expect(dump.kopku_license_type).toBe('PERMANENT');
  });

  it('menghitung aktivasi sebagai verifikasi server pertama', async () => {
    // §13: "verify pertama kali setelah activation". Aktivasi yang
    // berhasil SUDAH membuktikan server mengakui lisensi, jadi tidak
    // perlu request kedua hanya untuk memulai grace period.
    await activateSuccessfully();
    const status = await getLicenseStatus();
    expect(status.lastVerifiedAtMs).toBe(BASE);
    expect(status.graceRemainingMs).toBe(LICENSE_GRACE_PERIOD_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('mengirim license key yang sudah dinormalisasi ke server', async () => {
    const deviceId = await currentDeviceId();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        activation_token: issueTestToken(
          keyPair,
          permanentPayload(deviceId, { cooperative_name: 'Koperasi Uji' })
        ),
      })
    );
    await activateLicense({ licenseKey: '  kpk-abcd-efgh-jklm-npqr ', cooperativeName: 'Koperasi Uji' });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as Record<string, unknown>;
    expect(body.license_key).toBe(VALID_KEY);
    expect(body.device_id).toBe(deviceId);
  });

  it('menolak format license key yang salah tanpa menyentuh jaringan', async () => {
    const result = await activateLicense({ licenseKey: 'ABC-123', cooperativeName: 'Koperasi Uji' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_LICENSE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('menolak nama koperasi terlalu pendek tanpa menyentuh jaringan', async () => {
    const result = await activateLicense({ licenseKey: VALID_KEY, cooperativeName: 'AB' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_REQUEST');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['LICENSE_ALREADY_USED', 409],
    ['LICENSE_REVOKED', 403],
    ['LICENSE_EXPIRED', 403],
    ['INVALID_LICENSE', 404],
    ['RATE_LIMITED', 429],
  ])('meneruskan penolakan server %s', async (code, httpStatus) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: code }, httpStatus));
    const result = await activateLicense({ licenseKey: VALID_KEY, cooperativeName: 'Koperasi Uji' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
      // Pesan harus siap tampil dan tidak membocorkan detail teknis.
      expect(result.message).not.toMatch(/Error|stack|SQLSTATE/i);
    }
    expect(await hasValidLocalLicense()).toBe(false);
  });

  it('TIDAK menyimpan token yang gagal verifikasi lokal walau HTTP 200 dan success:true', async () => {
    // Inti §12: respons server yang "terlihat sukses" bukan bukti apa
    // pun. Siapa pun yang mengendalikan DNS/proxy/berkas hosts bisa
    // membuatnya. Yang tidak bisa dipalsukan adalah tanda tangannya.
    const attacker = generateTestKeyPair();
    const deviceId = await currentDeviceId();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        activation_token: issueTestToken(
          attacker,
          permanentPayload(deviceId, { cooperative_name: 'Koperasi Uji' })
        ),
      })
    );

    const result = await activateLicense({ licenseKey: VALID_KEY, cooperativeName: 'Koperasi Uji' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('TOKEN_REJECTED');
      expect(result.tokenReason).toBe('BAD_SIGNATURE');
    }
    expect(__dump().kopku_license_activation_token).toBeUndefined();
    expect(await hasValidLocalLicense()).toBe(false);
  });

  it('menolak token yang terikat perangkat lain', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        activation_token: issueTestToken(keyPair, {
          ...permanentPayload('KOPKU-INST-' + 'c'.repeat(64)),
          device_hash: deviceHashOf('perangkat-lain'),
        }),
      })
    );
    const result = await activateLicense({ licenseKey: VALID_KEY, cooperativeName: 'Koperasi Uji' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.tokenReason).toBe('DEVICE_MISMATCH');
    expect(await hasValidLocalLicense()).toBe(false);
  });

  it('melaporkan jaringan tidak tersedia tanpa menyimpan apa pun', async () => {
    fetchMock.mockImplementationOnce(networkError);
    const result = await activateLicense({ licenseKey: VALID_KEY, cooperativeName: 'Koperasi Uji' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NETWORK_UNAVAILABLE');
  });

  it('melaporkan timeout secara terpisah dari kegagalan jaringan', async () => {
    fetchMock.mockImplementationOnce(abortError);
    const result = await activateLicense({ licenseKey: VALID_KEY, cooperativeName: 'Koperasi Uji' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TIMEOUT');
  });

  it('menangani respons yang bukan JSON tanpa melempar', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => null },
      text: async () => '<html>502 Bad Gateway</html>',
    } as unknown as Response);
    const result = await activateLicense({ licenseKey: VALID_KEY, cooperativeName: 'Koperasi Uji' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MALFORMED_RESPONSE');
  });

  it('menangani respons sukses tanpa activation_token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, license_type: 'PERMANENT' }));
    const result = await activateLicense({ licenseKey: VALID_KEY, cooperativeName: 'Koperasi Uji' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MALFORMED_RESPONSE');
  });

  it('aktivasi ulang di perangkat yang sama menimpa token lama', async () => {
    const first = await activateSuccessfully();
    const second = await activateSuccessfully({ nonce: '0011223344556677' });
    expect(second).not.toBe(first);
    expect(__dump().kopku_license_activation_token).toBe(second);
    expect(await hasValidLocalLicense()).toBe(true);
  });
});

describe('verifyLicense', () => {
  it('memperbarui waktu verifikasi saat server menjawab valid', async () => {
    await activateSuccessfully();
    const later = BASE + 3 * 24 * 60 * 60 * 1000;
    nowSpy.mockReturnValue(later);

    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: true, license_type: 'PERMANENT', expires_at: null }));
    const result = await verifyLicense();

    expect(result.ok).toBe(true);
    const status = await getLicenseStatus();
    expect(status.lastVerifiedAtMs).toBe(later);
    expect(status.graceRemainingMs).toBe(LICENSE_GRACE_PERIOD_MS);
  });

  it.each([
    ['LICENSE_REVOKED', 'REVOKED'],
    ['LICENSE_EXPIRED', 'EXPIRED'],
    ['DEVICE_MISMATCH', 'DEVICE_MISMATCH'],
    ['INVALID_LICENSE', 'INVALID'],
  ])('mengunci aplikasi saat server menjawab %s', async (serverError, expectedState) => {
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: serverError }));

    const result = await verifyLicense();
    expect(result.ok).toBe(false);

    const status = await getLicenseStatus();
    expect(status.state).toBe(expectedState);
    expect(status.allowAppAccess).toBe(false);
    // §22: token TIDAK dihapus, supaya tombol "Coba Verifikasi Lagi"
    // masih punya sesuatu untuk dikirim bila admin membatalkan pencabutan.
    expect(__dump().kopku_license_activation_token).toBeDefined();
  });

  it('putusan negatif bertahan meski berikutnya offline', async () => {
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'LICENSE_REVOKED' }));
    await verifyLicense();

    // Cabut jaringan sepenuhnya. Aplikasi TIDAK boleh terbuka kembali
    // hanya karena server tidak bisa dihubungi lagi.
    fetchMock.mockImplementation(networkError);
    expect(await hasValidLocalLicense()).toBe(false);
    expect((await getLicenseStatus()).state).toBe('REVOKED');
  });

  it('membuka kembali aplikasi setelah server mengonfirmasi valid lagi', async () => {
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'LICENSE_REVOKED' }));
    await verifyLicense();
    expect(await hasValidLocalLicense()).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: true, license_type: 'PERMANENT', expires_at: null }));
    const result = await verifyLicense();

    expect(result.ok).toBe(true);
    expect(await hasValidLocalLicense()).toBe(true);
  });

  it('TIDAK mengubah status saat server tidak terjangkau', async () => {
    await activateSuccessfully();
    fetchMock.mockImplementationOnce(networkError);

    const result = await verifyLicense();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NETWORK_UNAVAILABLE');

    // Aplikasi tetap boleh dipakai: ini inti dari offline-first.
    const status = await getLicenseStatus();
    expect(status.state).toBe('ACTIVE');
    expect(status.lastVerifiedAtMs).toBe(BASE);
  });

  it('TIDAK mengubah status saat server membalas 500 tanpa field valid', async () => {
    // 500 bukan putusan tentang lisensi. Memperlakukannya sebagai
    // "tidak valid" akan mengunci seluruh pengguna setiap kali server
    // sedang bermasalah.
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'SERVER_ERROR' }, 500));

    const result = await verifyLicense();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SERVER_ERROR');
    expect((await getLicenseStatus()).state).toBe('ACTIVE');
  });

  it('menolak verifikasi bila belum pernah aktivasi', async () => {
    const result = await verifyLicense();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_ACTIVATED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('kebijakan offline & grace period', () => {
  it('mengizinkan aplikasi selama masih dalam grace period', async () => {
    await activateSuccessfully();
    nowSpy.mockReturnValue(BASE + 6 * 24 * 60 * 60 * 1000);
    fetchMock.mockImplementation(networkError);

    const status = await getLicenseStatus();
    expect(status.state).toBe('ACTIVE');
    expect(status.allowAppAccess).toBe(true);
  });

  it('menutup aplikasi setelah grace period habis', async () => {
    await activateSuccessfully();
    nowSpy.mockReturnValue(BASE + LICENSE_GRACE_PERIOD_MS + 1000);
    fetchMock.mockImplementation(networkError);

    const status = await getLicenseStatus();
    expect(status.state).toBe('NEEDS_VERIFICATION');
    expect(status.allowAppAccess).toBe(false);
    // Token TIDAK dihapus (§8): begitu online kembali dan server
    // mengonfirmasi, aplikasi langsung terbuka tanpa aktivasi ulang.
    expect(__dump().kopku_license_activation_token).toBeDefined();
  });

  it('membuka kembali aplikasi setelah verifikasi sukses melewati grace period', async () => {
    await activateSuccessfully();
    const late = BASE + LICENSE_GRACE_PERIOD_MS + 60 * 60 * 1000;
    nowSpy.mockReturnValue(late);
    expect(await hasValidLocalLicense()).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: true, license_type: 'PERMANENT', expires_at: null }));
    await verifyLicense();
    expect(await hasValidLocalLicense()).toBe(true);
  });

  it('lisensi PERMANENT tetap wajib verifikasi berkala', async () => {
    // "Permanen" berarti tanpa tanggal kedaluwarsa — BUKAN berarti
    // server kehilangan hak mencabutnya (§8).
    await activateSuccessfully();
    nowSpy.mockReturnValue(BASE + LICENSE_GRACE_PERIOD_MS + 1000);
    fetchMock.mockImplementation(networkError);

    const status = await getLicenseStatus();
    expect(status.licenseType).toBe('PERMANENT');
    expect(status.allowAppAccess).toBe(false);
  });

  it('memundurkan jam TIDAK memperpanjang grace period', async () => {
    await activateSuccessfully();
    // Biarkan waktu berjalan sampai grace habis...
    nowSpy.mockReturnValue(BASE + LICENSE_GRACE_PERIOD_MS + 1000);
    fetchMock.mockImplementation(networkError);
    expect(await hasValidLocalLicense()).toBe(false);

    // ...lalu mundurkan jam perangkat ke hari aktivasi.
    nowSpy.mockReturnValue(BASE);
    const status = await getLicenseStatus();
    expect(status.allowAppAccess).toBe(false);
    expect(status.clockRollbackDetected).toBe(true);
  });
});

describe('jadwal verifikasi (§13)', () => {
  it('tidak menghubungi server sebelum interval terlampaui', async () => {
    await activateSuccessfully();
    fetchMock.mockClear();
    nowSpy.mockReturnValue(BASE + LICENSE_VERIFY_INTERVAL_MS - 60_000);

    const result = await verifyLicenseIfDue();
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('menghubungi server setelah interval terlampaui', async () => {
    await activateSuccessfully();
    fetchMock.mockClear();
    nowSpy.mockReturnValue(BASE + LICENSE_VERIFY_INTERVAL_MS + 60_000);
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: true, license_type: 'PERMANENT', expires_at: null }));

    await verifyLicenseIfDue();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tidak menghubungi server sama sekali bila belum aktivasi', async () => {
    const result = await verifyLicenseIfDue();
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('lisensi TRIAL', () => {
  it('menutup aplikasi setelah tanggal kedaluwarsa lewat', async () => {
    const deviceId = await currentDeviceId();
    const expiresAt = new Date(BASE + 2 * 24 * 60 * 60 * 1000).toISOString();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        activation_token: issueTestToken(
          keyPair,
          trialPayload(deviceId, expiresAt, { cooperative_name: 'Koperasi Uji' })
        ),
      })
    );
    await activateLicense({ licenseKey: VALID_KEY, cooperativeName: 'Koperasi Uji' });
    expect(await hasValidLocalLicense()).toBe(true);

    nowSpy.mockReturnValue(BASE + 3 * 24 * 60 * 60 * 1000);
    const status = await getLicenseStatus();
    expect(status.state).toBe('EXPIRED');
    expect(status.allowAppAccess).toBe(false);
    expect(await isLicenseExpired()).toBe(true);
  });
});

describe('deactivateLicense', () => {
  it('menghapus state lokal HANYA setelah server mengonfirmasi', async () => {
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, message: 'Device deactivated.' }));

    const result = await deactivateLicense();
    expect(result.ok).toBe(true);
    expect(__dump().kopku_license_activation_token).toBeUndefined();
    // RC-S36: deaktivasi yang berhasil kini menghasilkan DEACTIVATED,
    // bukan NOT_ACTIVATED. Keduanya sama-sama menolak akses; yang
    // berbeda hanya penjelasan di layar.
    expect((await getLicenseStatus()).state).toBe('DEACTIVATED');
  });

  it('MEMPERTAHANKAN lisensi bila request deaktivasi gagal', async () => {
    // Kalau state dihapus lebih dulu lalu request gagal, slot perangkat
    // di server tetap terpakai sementara pengguna kehilangan aksesnya —
    // kegagalan paling buruk yang mungkin terjadi di alur ini.
    await activateSuccessfully();
    fetchMock.mockImplementationOnce(networkError);

    const result = await deactivateLicense();
    expect(result.ok).toBe(false);
    expect(await hasValidLocalLicense()).toBe(true);
  });

  it('mempertahankan device ID agar aktivasi ulang tidak memakan slot baru', async () => {
    const before = await currentDeviceId();
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    await deactivateLicense();

    __resetDeviceIdCacheForTests();
    expect(await getDeviceId()).toBe(before);
  });

  it('menolak deaktivasi bila belum pernah aktivasi', async () => {
    const result = await deactivateLicense();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_ACTIVATED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('siklus hidup perangkat', () => {
  it('lisensi bertahan melewati restart aplikasi', async () => {
    await activateSuccessfully();
    // Restart aplikasi = proses baru: cache memori hilang, SecureStore tetap.
    __resetDeviceIdCacheForTests();
    expect(await hasValidLocalLicense()).toBe(true);
  });

  it('reinstall (SecureStore kosong) mengembalikan aplikasi ke layar aktivasi', async () => {
    await activateSuccessfully();
    __clear();
    __resetDeviceIdCacheForTests();

    const status = await getLicenseStatus();
    expect(status.state).toBe('NOT_ACTIVATED');
    expect(status.allowAppAccess).toBe(false);
  });

  it('reinstall menghasilkan device ID baru — dan itu didokumentasikan, bukan celah', async () => {
    const before = await currentDeviceId();
    __clear();
    __resetDeviceIdCacheForTests();
    const after = await currentDeviceId();

    expect(after).not.toBe(before);
    // Perangkat baru harus meminta slot aktivasi baru di server; ia
    // TIDAK mewarisi izin apa pun dari pemasangan sebelumnya.
    expect(await hasValidLocalLicense()).toBe(false);
  });

  it('clearLicense menghapus akses tetapi mempertahankan identitas perangkat', async () => {
    const deviceId = await currentDeviceId();
    await activateSuccessfully();
    await clearLicense();

    expect(await hasValidLocalLicense()).toBe(false);
    __resetDeviceIdCacheForTests();
    expect(await getDeviceId()).toBe(deviceId);
  });
});

describe('device ID', () => {
  it('stabil di seluruh pemanggilan dalam satu sesi', async () => {
    const a = await getDeviceId();
    const b = await getDeviceId();
    expect(a).toBe(b);
  });

  it('stabil melewati restart proses', async () => {
    const a = await getDeviceId();
    __resetDeviceIdCacheForTests();
    expect(await getDeviceId()).toBe(a);
  });

  it('tidak pernah berupa license key maupun username', async () => {
    const deviceId = await getDeviceId();
    expect(deviceId).toMatch(/^KOPKU-INST-[0-9a-f]{64}$/);
    expect(deviceId).not.toContain(VALID_KEY);
  });

  it('pemanggilan paralel menghasilkan satu ID yang sama', async () => {
    // Kalau dua pemanggil sama-sama melihat SecureStore kosong dan
    // menulis ID berbeda, token hasil aktivasi akan terikat ke ID yang
    // kemudian tertimpa — dan aplikasi terkunci sendiri.
    const [a, b, c] = await Promise.all([getDeviceId(), getDeviceId(), getDeviceId()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('konfigurasi public key', () => {
  /**
   * Kedua test lama di blok ini menghapus EXPO_PUBLIC_* untuk memaksa
   * state NOT_CONFIGURED. Sejak kunci produksi ditanam di source, cara
   * itu tidak lagi menghasilkan keadaan tersebut — dan itu memang
   * hasil yang diinginkan: build produksi tidak boleh punya jalan
   * menuju "belum dikonfigurasi".
   *
   * Logika fail-closed-nya tetap terkunci, dipindah ke tempat yang
   * dapat mengujinya secara langsung: `buildPublicKeyRegistry([])` di
   * LicenseCrypto.test.ts.
   */
  it('lisensi tetap terkunci bila token ditandatangani kunci yang tidak dipercaya', async () => {
    await activateSuccessfully();
    delete process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS;

    // Hanya kunci produksi yang aktif. Token yang tersimpan
    // ditandatangani kunci uji, jadi ia tidak lagi dipercaya.
    const status = await getLicenseStatus();
    process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS = keyPair.publicKeyBase64;

    expect(status.state).toBe('INVALID');
    expect(status.allowAppAccess).toBe(false);
  });

  it('aktivasi ditolak bila server mengembalikan token dari kunci yang tidak dipercaya', async () => {
    delete process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS;
    const deviceId = await currentDeviceId();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        activation_token: issueTestToken(keyPair, permanentPayload(deviceId)),
      })
    );
    const result = await activateLicense({ licenseKey: VALID_KEY, cooperativeName: 'Koperasi Uji' });
    process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS = keyPair.publicKeyBase64;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('TOKEN_REJECTED');
      expect(result.tokenReason).toBe('BAD_SIGNATURE');
    }
    // Fail-closed: token yang tidak lolos verifikasi TIDAK PERNAH disimpan.
    expect(__dump().kopku_license_activation_token).toBeUndefined();
  });
});


// ===========================================================================
// LIFECYCLE LISENSI — RC-S36
// ===========================================================================

describe('G+H. pencabutan bersifat lengket melewati restart dan offline', () => {
  it('tetap REVOKED setelah restart proses, tanpa jaringan sama sekali', async () => {
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'LICENSE_REVOKED' }));
    await verifyLicense();
    expect((await getLicenseStatus()).state).toBe('REVOKED');

    // Restart: cache memori hilang, SecureStore bertahan. Jaringan mati
    // total — kalau status disimpan hanya di memori, di sinilah ia akan
    // hilang dan aplikasi terbuka kembali.
    __resetDeviceIdCacheForTests();
    fetchMock.mockImplementation(networkError);

    const status = await getLicenseStatus();
    expect(status.state).toBe('REVOKED');
    expect(status.allowAppAccess).toBe(false);
  });

  it('pencabutan TIDAK memakai offline grace sebagai jalan keluar', async () => {
    // Perbedaan penting: NEEDS_VERIFICATION boleh menunggu sampai grace
    // habis; REVOKED tidak pernah punya masa tenggang sama sekali.
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'LICENSE_REVOKED' }));
    await verifyLicense();

    fetchMock.mockImplementation(networkError);
    for (const jam of [1, 24, 24 * 6]) {
      nowSpy.mockReturnValue(BASE + jam * 60 * 60 * 1000);
      const status = await getLicenseStatus();
      expect(status.state).toBe('REVOKED');
      expect(status.allowAppAccess).toBe(false);
    }
  });

  it('verifyLicenseIfDue tetap mencoba server saat REVOKED (agar bisa pulih)', async () => {
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'LICENSE_REVOKED' }));
    await verifyLicense();

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: true, license_type: 'PERMANENT', expires_at: null }));
    await verifyLicenseIfDue();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await hasValidLocalLicense()).toBe(true);
  });
});

describe('I+J. deaktivasi perangkat', () => {
  it('berhasil -> state DEACTIVATED, bukan NOT_ACTIVATED', async () => {
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    const result = await deactivateLicense();

    expect(result.ok).toBe(true);
    const status = await getLicenseStatus();
    expect(status.state).toBe('DEACTIVATED');
    expect(status.allowAppAccess).toBe(false);
  });

  it('penanda deaktivasi bertahan melewati restart', async () => {
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    await deactivateLicense();

    __resetDeviceIdCacheForTests();
    expect((await getLicenseStatus()).state).toBe('DEACTIVATED');
  });

  it('gagal jaringan -> lisensi TIDAK dilepas dan tidak ditandai', async () => {
    await activateSuccessfully();
    fetchMock.mockImplementationOnce(networkError);

    const result = await deactivateLicense();
    expect(result.ok).toBe(false);
    // Tidak boleh memberi kesan slot server sudah bebas padahal belum.
    expect(await hasValidLocalLicense()).toBe(true);
    expect((await getLicenseStatus()).state).toBe('ACTIVE');
  });

  it('aktivasi ulang menghapus penanda deaktivasi', async () => {
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    await deactivateLicense();
    expect((await getLicenseStatus()).state).toBe('DEACTIVATED');

    await activateSuccessfully();
    const status = await getLicenseStatus();
    expect(status.state).toBe('ACTIVE');
    expect(status.allowAppAccess).toBe(true);
  });

  it('deaktivasi TIDAK menghapus bukti anti-rollback jam', async () => {
    // GAP-1. Deaktivasi dapat dipicu pengguna kapan saja; kalau ia ikut
    // menghapus high-water mark, proteksi jam bisa dibersihkan dengan
    // dua ketukan.
    await activateSuccessfully();
    const jauhDiDepan = BASE + 90 * 24 * 60 * 60 * 1000;
    nowSpy.mockReturnValue(jauhDiDepan);
    await getLicenseStatus(); // naikkan high-water

    nowSpy.mockReturnValue(BASE);
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    await deactivateLicense();

    // Jam dimundurkan 90 hari setelah deaktivasi -> harus tetap terdeteksi.
    expect(await isClockRollbackDetected()).toBe(true);
  });
});

describe('K. pelepasan slot perangkat', () => {
  it('device ID dipertahankan agar slot yang sama dipakai ulang', async () => {
    const sebelum = await currentDeviceId();
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }));
    await deactivateLicense();

    __resetDeviceIdCacheForTests();
    expect(await getDeviceId()).toBe(sebelum);
  });
});

describe('privasi ID perangkat', () => {
  it('bentuk tersamar tidak memuat ID penuh', async () => {
    const deviceId = await currentDeviceId();
    const masked = maskDeviceId(deviceId);
    expect(masked.length).toBeGreaterThan(0);
    expect(masked).toContain('…');
    expect(masked.length < deviceId.length).toBe(true);
    expect(deviceId).toContain(masked.split('…')[0]);
  });

  it('menangani nilai kosong tanpa melempar', () => {
    expect(maskDeviceId('')).toBe('—');
  });
});


// ===========================================================================
// RC-S38 — BINDING KOPERASI & PENONAKTIFAN PERANGKAT OLEH PENERBIT
// ===========================================================================

describe('D2. penonaktifan perangkat oleh penerbit', () => {
  it('verify DEVICE_DEACTIVATED -> state DEACTIVATED, akses ditolak', async () => {
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'DEVICE_DEACTIVATED' }));

    const result = await verifyLicense();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DEVICE_DEACTIVATED');

    const status = await getLicenseStatus();
    expect(status.state).toBe('DEACTIVATED');
    expect(status.allowAppAccess).toBe(false);
  });

  it('DEVICE_DEACTIVATED lengket melewati restart tanpa jaringan', async () => {
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'DEVICE_DEACTIVATED' }));
    await verifyLicense();

    __resetDeviceIdCacheForTests();
    fetchMock.mockImplementation(networkError);
    expect((await getLicenseStatus()).state).toBe('DEACTIVATED');
  });

  it('DEVICE_DEACTIVATED tidak mendapat offline grace', async () => {
    // Sama kuatnya dengan REVOKED: tidak ada masa tenggang sama sekali.
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'DEVICE_DEACTIVATED' }));
    await verifyLicense();

    fetchMock.mockImplementation(networkError);
    for (const jam of [1, 24, 24 * 6]) {
      nowSpy.mockReturnValue(BASE + jam * 60 * 60 * 1000);
      expect((await getLicenseStatus()).allowAppAccess).toBe(false);
    }
  });

  it('penerbit dapat mengaktifkan kembali -> akses pulih', async () => {
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'DEVICE_DEACTIVATED' }));
    await verifyLicense();
    expect(await hasValidLocalLicense()).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: true, license_type: 'PERMANENT', expires_at: null }));
    await verifyLicense();
    expect(await hasValidLocalLicense()).toBe(true);
  });

  it('DEVICE_DEACTIVATED dibedakan dari INVALID_LICENSE', async () => {
    // Inti perbaikan server: kalau keduanya dipetakan sama, pengguna
    // melihat "Lisensi Tidak Valid" untuk keadaan yang sebenarnya
    // disengaja penerbit.
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'INVALID_LICENSE' }));
    await verifyLicense();
    expect((await getLicenseStatus()).state).toBe('INVALID');
  });
});

describe('F+G. binding koperasi', () => {
  it('COOPERATIVE_MISMATCH saat aktivasi ditolak dan tidak menyimpan apa pun', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'COOPERATIVE_MISMATCH' }, 409)
    );
    const result = await activateLicense({
      licenseKey: VALID_KEY,
      cooperativeName: 'Koperasi Dua',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('COOPERATIVE_MISMATCH');
      expect(result.message).toBe('License ini terdaftar untuk koperasi lain.');
    }
    expect(__dump().kopku_license_activation_token).toBeUndefined();
    expect(await hasValidLocalLicense()).toBe(false);
  });

  it('COOPERATIVE_MISMATCH dari verify mengunci aplikasi', async () => {
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'COOPERATIVE_MISMATCH' }));
    await verifyLicense();

    const status = await getLicenseStatus();
    expect(status.state).toBe('COOPERATIVE_MISMATCH');
    expect(status.allowAppAccess).toBe(false);
  });

  it('nama koperasi dibaca dari payload YANG DITANDATANGANI', async () => {
    // Field di luar token dapat diubah siapa pun di jalur jaringan.
    // Yang dipakai untuk keputusan keamanan harus yang di dalam tanda
    // tangan.
    const deviceId = await currentDeviceId();
    const token = issueTestToken(
      keyPair,
      permanentPayload(deviceId, { cooperative_name: 'Koperasi Satu' })
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        // Nilai di LUAR token sengaja dibuat berbeda.
        cooperative_name: 'Koperasi Palsu',
        activation_token: token,
      })
    );
    await activateLicense({ licenseKey: VALID_KEY, cooperativeName: 'Koperasi Satu' });

    const verified = await verifyActivationTokenOffline(token, {
      deviceId,
      nowMs: BASE,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.payload.cooperativeName).toBe('Koperasi Satu');
  });

  it('B6. token TANPA cooperative_name DITOLAK bila binding diwajibkan', async () => {
    /**
     * Ini membatalkan keputusan kompatibilitas RC-S38A.
     *
     * Versi sebelumnya menerima token lama tanpa binding, dengan alasan
     * "additive, jangan merusak token aktif". Alasan itu keliru: syarat
     * keamanan yang hanya berlaku bila datanya kebetulan ada bukan
     * syarat keamanan. Token apa pun yang field-nya dihilangkan akan
     * lolos lewat cabang yang sama.
     *
     * Konsekuensinya jujur: perangkat yang tokennya terbitan lama harus
     * aktivasi ulang. Itu ongkos yang disengaja, bukan efek samping.
     */
    const deviceId = await currentDeviceId();
    const token = issueTestToken(keyPair, permanentPayload(deviceId));
    const verified = await verifyActivationTokenOffline(token, {
      deviceId,
      nowMs: BASE,
      expectedCooperativeName: 'Koperasi Satu',
    });
    expect(verified).toEqual({ ok: false, reason: 'COOPERATIVE_BINDING_MISSING' });
  });

  it('token tanpa binding tetap dibaca saat belum ada binding sama sekali', async () => {
    // Aktivasi pertama: belum ada apa pun untuk dibandingkan.
    const deviceId = await currentDeviceId();
    const token = issueTestToken(keyPair, permanentPayload(deviceId));
    const verified = await verifyActivationTokenOffline(token, { deviceId, nowMs: BASE });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.payload.cooperativeName).toBeNull();
  });

  it('B5. token untuk koperasi LAIN ditolak walau tanda tangannya sah', async () => {
    const deviceId = await currentDeviceId();
    const token = issueTestToken(
      keyPair,
      permanentPayload(deviceId, { cooperative_name: 'Koperasi Dua' })
    );
    const verified = await verifyActivationTokenOffline(token, {
      deviceId,
      nowMs: BASE,
      expectedCooperativeName: 'Koperasi Satu',
    });
    expect(verified).toEqual({ ok: false, reason: 'COOPERATIVE_MISMATCH' });
  });

  it('perbedaan kapitalisasi dan spasi TIDAK dianggap koperasi lain', async () => {
    // Yang dijaga identitas koperasi, bukan format ketikannya.
    const deviceId = await currentDeviceId();
    const token = issueTestToken(
      keyPair,
      permanentPayload(deviceId, { cooperative_name: 'Koperasi  SATU' })
    );
    const verified = await verifyActivationTokenOffline(token, {
      deviceId,
      nowMs: BASE,
      expectedCooperativeName: '  koperasi satu ',
    });
    expect(verified.ok).toBe(true);
  });

  it('aktivasi ditolak bila server menerbitkan token untuk koperasi lain', async () => {
    const deviceId = await currentDeviceId();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        activation_token: issueTestToken(
          keyPair,
          permanentPayload(deviceId, { cooperative_name: 'Koperasi Lain' })
        ),
      })
    );
    const result = await activateLicense({
      licenseKey: VALID_KEY,
      cooperativeName: 'Koperasi Uji',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.tokenReason).toBe('COOPERATIVE_MISMATCH');
    expect(__dump().kopku_license_activation_token).toBeUndefined();
  });

  it('verify COOPERATIVE_BINDING_MISSING mengunci aplikasi', async () => {
    await activateSuccessfully();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ valid: false, error: 'COOPERATIVE_BINDING_MISSING' })
    );
    await verifyLicense();
    const status = await getLicenseStatus();
    expect(status.state).toBe('COOPERATIVE_MISMATCH');
    expect(status.allowAppAccess).toBe(false);
  });
});

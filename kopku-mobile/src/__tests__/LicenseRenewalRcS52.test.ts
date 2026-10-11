import { readFileSync } from 'fs';
import { join } from 'path';
import {
  activateLicense,
  getLicenseStatus,
  hasValidLocalLicense,
  verifyLicense,
} from '@/services/LicenseService';
import { getDeviceId, __resetDeviceIdCacheForTests } from '@/security/deviceId';
import { __clear, __dump, __seed } from '@/test-utils/expoSecureStoreMock';
import { persistLicense, readStoredLicense } from '@/security/licenseStore';
import {
  generateTestKeyPair,
  issueTestToken,
  permanentPayload,
  trialPayload,
  type TestKeyPair,
} from '@/test-utils/licenseTokenFixtures';

/**
 * RC-S52 — JALAN KELUAR DARI LISENSI YANG HABIS.
 *
 * MASALAH YANG DIPERBAIKI.
 * Ketika trial 3/7 hari atau lisensi berjangka habis, `getLicenseStatus()`
 * benar mengembalikan EXPIRED dan LicenseGate benar mengunci aplikasi.
 * Yang salah ada di layar: `LicenseActivationScreen` hanya menampilkan
 * form License Key untuk NOT_ACTIVATED / DEVICE_MISMATCH /
 * COOPERATIVE_MISMATCH / INVALID. Pada EXPIRED, REVOKED, dan DEACTIVATED
 * satu-satunya tombol adalah "Coba Verifikasi Lagi" — yang mengirim
 * token LAMA, yaitu token yang justru sudah ditolak. Pengguna yang sudah
 * memegang License Key baru yang sah TIDAK punya tempat untuk
 * memasukkannya.
 *
 * Suite ini menjaga dua hal sekaligus, dan keduanya harus tetap benar:
 *   1. jalan keluar itu ADA (bagian A & B);
 *   2. jalan keluar itu BUKAN bypass — setiap lapisan lama tetap
 *      menolak, dan hanya server yang dapat membukanya (bagian C).
 */

const BASE = Date.parse('2026-09-06T10:00:00Z');
const VALID_KEY = 'KPK-ABCD-EFGH-JKLM-NPQR';
const KEY_BARU = 'KPK-ZZZZ-YYYY-XXXX-WWWW';
const NAMA = 'Koperasi Uji';

let keyPair: TestKeyPair;
let previousEnv: string | undefined;
let nowSpy: jest.SpyInstance<number, []>;
let fetchMock: jest.Mock;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function networkError(): never {
  throw new Error('Network request failed');
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

/** Aktivasi trial yang habis setelah `hariBerlaku` hari. */
async function aktivasiTrial(hariBerlaku: number): Promise<void> {
  const deviceId = await getDeviceId();
  const expiresAt = new Date(BASE + hariBerlaku * 24 * 60 * 60 * 1000).toISOString();
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      success: true,
      activation_token: issueTestToken(
        keyPair,
        trialPayload(deviceId, expiresAt, {
          license_type: hariBerlaku <= 3 ? 'TRIAL_3D' : hariBerlaku <= 7 ? 'TRIAL_7D' : 'TRIAL_1M',
          cooperative_name: NAMA,
        })
      ),
    })
  );
  const hasil = await activateLicense({ licenseKey: VALID_KEY, cooperativeName: NAMA });
  expect(hasil.ok).toBe(true);
}

/** Sajikan satu respons aktivasi sukses untuk lisensi 1 bulan. */
function siapkanKeyBaru(deviceId: string, expiresAtIso: string | null): void {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      success: true,
      activation_token: issueTestToken(keyPair, {
        ...permanentPayload(deviceId, { cooperative_name: NAMA }),
        license_id: 99,
        license_type: expiresAtIso === null ? 'PERMANENT' : 'TRIAL_1M',
        expires_at: expiresAtIso,
        nonce: '00112233445566aa',
      }),
    })
  );
}

// ---------------------------------------------------------------------------
// A. Trial & lisensi berjangka yang habis tetap terkunci
// ---------------------------------------------------------------------------

describe('A. masa berlaku habis -> EXPIRED & terkunci', () => {
  it.each([
    [3, 'trial 3 hari'],
    [7, 'trial 7 hari'],
    [30, 'lisensi 1 bulan'],
  ])('%s hari: habis -> EXPIRED, aplikasi TIDAK terbuka', async (hari) => {
    await aktivasiTrial(hari as number);
    expect(await hasValidLocalLicense()).toBe(true);

    nowSpy.mockReturnValue(BASE + ((hari as number) + 1) * 24 * 60 * 60 * 1000);
    const status = await getLicenseStatus();
    expect(status.state).toBe('EXPIRED');
    expect(status.allowAppAccess).toBe(false);
    // Token TIDAK dihapus: statusnya tetap EXPIRED, bukan menurun jadi
    // NOT_ACTIVATED. Pembedaan itu yang dipakai layar untuk memilih copy
    // "Lisensi Kedaluwarsa" dan tombol "Aktivasi Lisensi Baru".
    expect(__dump().kopku_license_activation_token).toBeDefined();
    expect(status.hasStoredLicense).toBe(true);
  });

  it('EXPIRED dari server juga terkunci dan tetap terkunci saat offline', async () => {
    await aktivasiTrial(30);
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'LICENSE_EXPIRED' }));
    await verifyLicense();
    expect((await getLicenseStatus()).state).toBe('EXPIRED');

    // Cabut jaringan: putusan negatif harus LENGKET.
    fetchMock.mockImplementation(networkError);
    const status = await getLicenseStatus();
    expect(status.state).toBe('EXPIRED');
    expect(status.allowAppAccess).toBe(false);
  });

  it('nama koperasi tetap tersedia saat EXPIRED, jadi layar dapat mengisinya otomatis', async () => {
    await aktivasiTrial(3);
    nowSpy.mockReturnValue(BASE + 4 * 24 * 60 * 60 * 1000);
    const status = await getLicenseStatus();
    expect(status.state).toBe('EXPIRED');
    expect(status.cooperativeName).toBe(NAMA);
  });
});

// ---------------------------------------------------------------------------
// B. License Key baru membuka kembali aplikasi
// ---------------------------------------------------------------------------

describe('B. aktivasi License Key baru setelah EXPIRED', () => {
  it('key baru yang sah -> ACTIVE, dengan expiresAt/licenseType/lastVerifiedAtMs BARU', async () => {
    await aktivasiTrial(3);
    const habis = BASE + 4 * 24 * 60 * 60 * 1000;
    nowSpy.mockReturnValue(habis);
    expect((await getLicenseStatus()).state).toBe('EXPIRED');

    const deviceId = await getDeviceId();
    const expiresBaru = new Date(habis + 30 * 24 * 60 * 60 * 1000).toISOString();
    siapkanKeyBaru(deviceId, expiresBaru);

    const hasil = await activateLicense({ licenseKey: KEY_BARU, cooperativeName: NAMA });
    expect(hasil.ok).toBe(true);

    const status = await getLicenseStatus();
    expect(status.state).toBe('ACTIVE');
    expect(status.allowAppAccess).toBe(true);
    expect(status.expiresAt).toBe(expiresBaru);
    expect(status.licenseType).toBe('TRIAL_1M');
    expect(status.lastVerifiedAtMs).toBe(habis);
  });

  it('`activateLicense()` yang SUDAH ADA dipakai ulang — tidak ada jalur aktivasi kedua', () => {
    const source = readFileSync(
      join(__dirname, '..', 'services', 'LicenseService.ts'),
      'utf8'
    );
    const aktivasi = source.match(/export async function activate[A-Za-z]*\s*\(/g) ?? [];
    // DIPERBARUI RC-S133.3 — `activateLicenseCompanion` adalah SATU-SATUNYA
    // jalur tambahan yang diizinkan: lisensi KOPKU Desktop dari HP yang sudah
    // aktif (api/activate_companion.php). Ia BUKAN jalur perpanjangan/aktivasi
    // ulang License Key: tidak menerima License Key sama sekali, server menuntut
    // token TERKINI milik HP yang masih aktif, dan tokennya diverifikasi Ed25519
    // dengan verifikasi lokal yang sama. Aktivasi ulang setelah EXPIRED tetap
    // hanya lewat `activateLicense()` (diuji di atas).
    expect(aktivasi).toEqual(['export async function activateLicense(', 'export async function activateLicenseCompanion(']);
    const pendamping = source.slice(source.indexOf('export async function activateLicenseCompanion('));
    expect(pendamping).not.toMatch(/license_key/);
    expect(pendamping).toMatch(/verifyActivationTokenOffline\(/);
  });

  it('restart aplikasi setelah aktivasi baru tetap mempertahankan lisensi baru', async () => {
    await aktivasiTrial(3);
    const habis = BASE + 4 * 24 * 60 * 60 * 1000;
    nowSpy.mockReturnValue(habis);

    const deviceId = await getDeviceId();
    siapkanKeyBaru(deviceId, new Date(habis + 30 * 24 * 60 * 60 * 1000).toISOString());
    await activateLicense({ licenseKey: KEY_BARU, cooperativeName: NAMA });

    // "Restart": cache di memori dibuang, hanya SecureStore yang tersisa.
    __resetDeviceIdCacheForTests();
    fetchMock.mockImplementation(networkError);
    const status = await getLicenseStatus();
    expect(status.state).toBe('ACTIVE');
    expect(status.allowAppAccess).toBe(true);
  });

  it('REVOKED: key baru tetap harus melewati server — server yang memutuskan', async () => {
    await aktivasiTrial(30);
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'LICENSE_REVOKED' }));
    await verifyLicense();
    expect((await getLicenseStatus()).state).toBe('REVOKED');

    // Server menolak key baru -> tetap terkunci.
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'LICENSE_REVOKED' }));
    const ditolak = await activateLicense({ licenseKey: KEY_BARU, cooperativeName: NAMA });
    expect(ditolak.ok).toBe(false);
    expect((await getLicenseStatus()).allowAppAccess).toBe(false);

    // Server menerima key baru -> terbuka, lewat jalur yang sama persis.
    const deviceId = await getDeviceId();
    siapkanKeyBaru(deviceId, null);
    const diterima = await activateLicense({ licenseKey: KEY_BARU, cooperativeName: NAMA });
    expect(diterima.ok).toBe(true);
    expect((await getLicenseStatus()).state).toBe('ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// C. Tidak ada bypass
// ---------------------------------------------------------------------------

describe('C. tidak ada bypass pada jalur aktivasi baru', () => {
  it('key dengan format salah ditolak tanpa menyentuh jaringan', async () => {
    await aktivasiTrial(3);
    nowSpy.mockReturnValue(BASE + 4 * 24 * 60 * 60 * 1000);
    fetchMock.mockClear();

    const hasil = await activateLicense({ licenseKey: 'bukan-key', cooperativeName: NAMA });
    expect(hasil.ok).toBe(false);
    if (!hasil.ok) expect(hasil.code).toBe('INVALID_LICENSE');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getLicenseStatus()).state).toBe('EXPIRED');
  });

  it('key yang ditolak server TIDAK mengubah apa pun secara lokal', async () => {
    await aktivasiTrial(3);
    nowSpy.mockReturnValue(BASE + 4 * 24 * 60 * 60 * 1000);
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'INVALID_LICENSE' }));

    const hasil = await activateLicense({ licenseKey: KEY_BARU, cooperativeName: NAMA });
    expect(hasil.ok).toBe(false);
    const status = await getLicenseStatus();
    expect(status.state).toBe('EXPIRED');
    expect(status.allowAppAccess).toBe(false);
  });

  it('token yang tanda tangannya bukan dari server ini DITOLAK walau HTTP 200', async () => {
    // Inti pertahanan: `success: true` bukan bukti apa pun. Yang tidak
    // bisa dipalsukan adalah tanda tangan Ed25519-nya.
    await aktivasiTrial(3);
    nowSpy.mockReturnValue(BASE + 4 * 24 * 60 * 60 * 1000);

    const penyerang = generateTestKeyPair();
    const deviceId = await getDeviceId();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        activation_token: issueTestToken(
          penyerang,
          permanentPayload(deviceId, { cooperative_name: NAMA })
        ),
      })
    );

    const hasil = await activateLicense({ licenseKey: KEY_BARU, cooperativeName: NAMA });
    expect(hasil.ok).toBe(false);
    if (!hasil.ok) expect(hasil.code).toBe('TOKEN_REJECTED');
    expect((await getLicenseStatus()).allowAppAccess).toBe(false);
  });

  it('offline saat lisensi sudah habis TIDAK membuka aplikasi', async () => {
    await aktivasiTrial(3);
    nowSpy.mockReturnValue(BASE + 4 * 24 * 60 * 60 * 1000);
    fetchMock.mockImplementation(networkError);

    const hasil = await activateLicense({ licenseKey: KEY_BARU, cooperativeName: NAMA });
    expect(hasil.ok).toBe(false);
    if (!hasil.ok) expect(hasil.code).toBe('NETWORK_UNAVAILABLE');
    expect(await hasValidLocalLicense()).toBe(false);
    expect((await getLicenseStatus()).state).toBe('EXPIRED');
  });

  it('DEACTIVATED: server menolak -> tetap DEACTIVATED, penanda tidak dihapus', async () => {
    await aktivasiTrial(30);
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'DEVICE_DEACTIVATED' }));
    await verifyLicense();
    expect((await getLicenseStatus()).state).toBe('DEACTIVATED');

    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'DEVICE_DEACTIVATED' }));
    const hasil = await activateLicense({ licenseKey: KEY_BARU, cooperativeName: NAMA });
    expect(hasil.ok).toBe(false);

    const status = await getLicenseStatus();
    expect(status.state).toBe('DEACTIVATED');
    expect(status.allowAppAccess).toBe(false);
  });

  it('DEACTIVATED masih menyimpan token, jadi tombol verifikasi tetap punya isi', async () => {
    await aktivasiTrial(30);
    fetchMock.mockResolvedValueOnce(jsonResponse({ valid: false, error: 'DEVICE_DEACTIVATED' }));
    await verifyLicense();

    const status = await getLicenseStatus();
    expect(status.state).toBe('DEACTIVATED');
    expect(status.hasStoredLicense).toBe(true);
  });

  it('token baru TIDAK mewarisi bukti verifikasi lisensi lama', async () => {
    // Kalau `lastVerifiedAt` lama ikut terbawa, token baru mendapat grace
    // period berdasarkan verifikasi lisensi yang sudah diganti.
    await aktivasiTrial(3);
    const habis = BASE + 4 * 24 * 60 * 60 * 1000;
    nowSpy.mockReturnValue(habis);

    const deviceId = await getDeviceId();
    siapkanKeyBaru(deviceId, null);
    await activateLicense({ licenseKey: KEY_BARU, cooperativeName: NAMA });

    // Bukti yang dipakai adalah verifikasi BARU (saat aktivasi), bukan
    // yang tercatat pada BASE.
    expect((await getLicenseStatus()).lastVerifiedAtMs).toBe(habis);
  });

  it('persistLicense() MEMBUANG putusan server & bukti verifikasi milik token lama', async () => {
    /**
     * Ini menguji JENDELA CRASH di dalam `activateLicense()`: proses mati
     * setelah `persistLicense()` tetapi sebelum `recordServerVerification()`.
     *
     * Tanpa pembuangan ini ada dua kegagalan berlawanan:
     *   - `lastServerStatus: 'LICENSE_EXPIRED'` yang basi membuat token
     *     BARU yang sah dibaca EXPIRED selamanya — pengguna yang baru
     *     membayar perpanjangan tetap terkunci;
     *   - `lastVerifiedAt` yang basi memberi grace period kepada token
     *     baru berdasarkan verifikasi lisensi LAMA — itu pelonggaran.
     *
     * Diuji langsung di level store, bukan lewat `activateLicense()`,
     * karena `recordServerVerification()` di jalur normal akan segera
     * menulis ulang keduanya dan menyembunyikan bug ini.
     */
    __seed('kopku_license_last_server_status', 'LICENSE_EXPIRED');
    __seed('kopku_license_last_verified_at', String(BASE - 60 * 24 * 60 * 60 * 1000));

    await persistLicense({
      activationToken: 'token-baru',
      deviceId: 'device-uji',
      licenseType: 'TRIAL_1M',
      expiresAt: '2026-12-31T00:00:00+00:00',
      activatedAt: '2026-09-10T00:00:00+00:00',
      cooperativeName: NAMA,
    });

    const tersimpan = await readStoredLicense();
    expect(tersimpan?.lastServerStatus).toBeNull();
    expect(tersimpan?.lastVerifiedAtMs).toBeNull();
    expect(tersimpan?.activationToken).toBe('token-baru');
  });
});

// ---------------------------------------------------------------------------
// D. Layar & gate — dibaca dari source, karena inilah bug aslinya
// ---------------------------------------------------------------------------

function baca(relatif: string): string {
  return readFileSync(join(__dirname, '..', '..', relatif), 'utf8');
}

/** Buang komentar supaya niat di komentar tidak terhitung sebagai kode. */
function tanpaKomentar(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('D. LicenseActivationScreen menyediakan aktivasi lisensi baru', () => {
  const layar = baca('src/screens/License/LicenseActivationScreen.tsx');
  const layarBersih = tanpaKomentar(layar);
  const gate = tanpaKomentar(baca('src/components/LicenseGate.tsx'));

  it('EXPIRED, REVOKED, dan DEACTIVATED sama-sama menampilkan form', () => {
    expect(layarBersih).toMatch(/const isRenewal\s*=/);
    for (const state of ['EXPIRED', 'REVOKED', 'DEACTIVATED']) {
      expect(layarBersih).toMatch(new RegExp(`status\\.state === '${state}'`));
    }
    expect(layarBersih).toMatch(/const showForm =[\s\S]{0,400}isRenewal/);
  });

  it('tombol "Aktivasi Lisensi Baru" dan label "License Key Baru" ada', () => {
    expect(layarBersih).toContain('Aktivasi Lisensi Baru');
    expect(layarBersih).toContain('License Key Baru');
  });

  it('tombol "Coba Verifikasi Lagi" TIDAK dihapus', () => {
    expect(layarBersih).toContain('Coba Verifikasi Lagi');
    expect(layarBersih).toMatch(/verifyLicense\s*\(\)/);
  });

  it('dua aksi memakai fungsi yang berbeda dan keduanya dari LicenseService', () => {
    expect(layarBersih).toMatch(/await activateLicense\(/);
    expect(layarBersih).toMatch(/await verifyLicense\(\)/);
    expect(layarBersih).toMatch(
      /import \{[\s\S]{0,200}activateLicense,[\s\S]{0,200}\} from '@\/services\/LicenseService'/
    );
  });

  it('copy EXPIRED menyebut "Lisensi Kedaluwarsa" dan mengarahkan ke key baru', () => {
    expect(layar).toContain("title: 'Lisensi Kedaluwarsa'");
    expect(layar).toMatch(/Masukkan License Key baru untuk melanjutkan/);
  });

  it('nama koperasi diisi otomatis dari lisensi tersimpan', () => {
    expect(layarBersih).toMatch(/useState\(status\.cooperativeName \?\? ''\)/);
  });

  it('layar TIDAK menyentuh state keamanan secara langsung', () => {
    // Semua keputusan tetap milik LicenseService. Layar yang boleh
    // menghapus penanda deaktivasi atau membersihkan state lisensi
    // ADALAH bypass, seberapa pun rapi pembungkusnya.
    for (const terlarang of [
      'clearDeactivatedMark',
      'clearLicenseState',
      'clearLicense',
      'markDeactivated',
      'persistLicense',
      'recordServerVerification',
      'allowAppAccess =',
      'SecureStore',
    ]) {
      expect(layarBersih).not.toContain(terlarang);
    }
  });

  it('onLicensed hanya dipanggil setelah hasil ok dari LicenseService', () => {
    const panggilan = layarBersih.match(/onLicensed\(\)/g) ?? [];
    // Dua: satu di jalur aktivasi sukses, satu di jalur verifikasi sukses.
    expect(panggilan.length).toBe(2);
    expect(layarBersih).toMatch(/if \(!result\.ok\)[\s\S]{0,200}return;[\s\S]{0,300}onLicensed\(\)/);
  });

  it('gate tetap satu-satunya penegak: BLOCKED -> layar, bukan aplikasi', () => {
    expect(gate).toMatch(/<LicenseActivationScreen status=\{status\}/);
    expect(gate).toMatch(/onLicensed=\{\(\) => void evaluate\(true\)\}/);
    expect(gate).toMatch(/if \(next\.allowAppAccess\) \{\s*setPhase\('ALLOWED'\);/);
    // `onLicensed` TIDAK membuka aplikasi; ia hanya memicu evaluasi ulang.
    expect(gate).not.toMatch(/onLicensed=\{[^}]*setPhase\('ALLOWED'\)/);
  });
});

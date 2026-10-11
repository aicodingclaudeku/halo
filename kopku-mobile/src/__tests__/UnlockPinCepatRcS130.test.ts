import { readFileSync } from 'fs';
import { join } from 'path';
import * as SecureStoreMock from '../test-utils/expoSecureStoreMock';
import {
  cocokkanPinCepat,
  hapusPinCepat,
  ikatanKredensialPin,
  jedaSetelahGagalMs,
  KUNCI_VERIFIKASI_CEPAT,
  simpanPinCepat,
  VERIFIKASI_CEPAT_AKTIF,
} from '@/security/unlockCepat';
import { hashPinV1, hashPinV2, hashPinV2Async, verifikasiPin, verifikasiPinAsync } from '@/security/pinHash';

/**
 * RC-S130 — buka kunci PIN cepat & layar kunci tanpa papan ketik otomatis.
 *
 * Memakai implementasi @noble/hashes ASLI (scrypt/HMAC), bukan tiruan.
 */
const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const ss = SecureStoreMock as unknown as {
  __clear(): void;
  __dump(): Record<string, string>;
  __seed(k: string, v: string): void;
  __setFailure(m: 'NONE' | 'READ' | 'WRITE' | 'ALL'): void;
};

const SALT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const BARIS = { pin_hash: hashPinV2('123456', SALT), pin_salt: SALT, pin_hash_versi: 2 };

beforeEach(() => ss.__clear());

describe('RC-S130 §A — scrypt asinkron identik dengan scrypt sinkron', () => {
  it('hash v2 asinkron = hash v2 sinkron (parameter sama)', async () => {
    expect(await hashPinV2Async('123456', SALT)).toBe(BARIS.pin_hash);
  });

  it('verifikasi asinkron memberi hasil yang sama untuk v1, v2, salah, dan versi asing', async () => {
    const kasus = [
      { pin: '123456', salt: SALT, hashTersimpan: BARIS.pin_hash, versiTersimpan: 2 as const },
      { pin: '654321', salt: SALT, hashTersimpan: BARIS.pin_hash, versiTersimpan: 2 as const },
      { pin: '123456', salt: SALT, hashTersimpan: hashPinV1('123456', SALT), versiTersimpan: 1 as const },
      { pin: '123456', salt: SALT, hashTersimpan: BARIS.pin_hash, versiTersimpan: 3 as unknown as 2 },
    ];
    for (const k of kasus) expect(await verifikasiPinAsync(k)).toEqual(verifikasiPin(k));
    expect((await verifikasiPinAsync(kasus[2])).perluDinaikkan).toBe(true);
  });
});

describe('RC-S130 §B — pemverifikasi cepat terikat kredensial', () => {
  const ik = ikatanKredensialPin(BARIS)!;

  it('aktif secara bawaan; ikatan berubah bila hash, salt, atau versi berubah', () => {
    expect(VERIFIKASI_CEPAT_AKTIF).toBe(true);
    expect(ik).toMatch(/^[0-9a-f]{64}$/);
    expect(ikatanKredensialPin({ ...BARIS, pin_hash: hashPinV2('111111', SALT) })).not.toBe(ik);
    expect(ikatanKredensialPin({ ...BARIS, pin_salt: 'ff' + SALT.slice(2) })).not.toBe(ik);
    expect(ikatanKredensialPin({ ...BARIS, pin_hash_versi: 1 })).not.toBe(ik);
    expect(ikatanKredensialPin({ pin_hash: null, pin_salt: SALT })).toBeNull();
  });

  it('tanpa catatan -> TIDAK_TERSEDIA (jatuh ke scrypt)', async () => {
    expect(await cocokkanPinCepat('u1', ik, '123456')).toBe('TIDAK_TERSEDIA');
    expect(await cocokkanPinCepat('u1', null, '123456')).toBe('TIDAK_TERSEDIA');
  });

  it('setelah disimpan: PIN benar COCOK, PIN salah TIDAK_COCOK', async () => {
    await simpanPinCepat('u1', ik, '123456');
    expect(await cocokkanPinCepat('u1', ik, '123456')).toBe('COCOK');
    expect(await cocokkanPinCepat('u1', ik, '123457')).toBe('TIDAK_COCOK');
    expect(await cocokkanPinCepat('u1', ik, '')).toBe('TIDAK_COCOK');
  });

  it('PIN diganti / user lain / database dipulihkan -> catatan diabaikan', async () => {
    await simpanPinCepat('u1', ik, '123456');
    const ikBaru = ikatanKredensialPin({ ...BARIS, pin_hash: hashPinV2('999999', SALT) });
    expect(await cocokkanPinCepat('u1', ikBaru, '123456')).toBe('TIDAK_TERSEDIA');
    expect(await cocokkanPinCepat('u1', ikBaru, '999999')).toBe('TIDAK_TERSEDIA');
    expect(await cocokkanPinCepat('u2', ik, '123456')).toBe('TIDAK_TERSEDIA');
  });

  it('catatan TIDAK memuat PIN maupun hash database; tiap simpan memakai pepper baru', async () => {
    await simpanPinCepat('u1', ik, '123456');
    const a = ss.__dump()[KUNCI_VERIFIKASI_CEPAT];
    expect(a).not.toContain('123456');
    expect(a).not.toContain(BARIS.pin_hash);
    await simpanPinCepat('u1', ik, '123456');
    const b = ss.__dump()[KUNCI_VERIFIKASI_CEPAT];
    expect(JSON.parse(a).pepper).not.toBe(JSON.parse(b).pepper);
    expect(JSON.parse(a).tag).not.toBe(JSON.parse(b).tag);
  });

  it('fail-closed: catatan rusak, format asing, atau SecureStore gagal -> TIDAK_TERSEDIA', async () => {
    await simpanPinCepat('u1', ik, '123456');
    const sah = JSON.parse(ss.__dump()[KUNCI_VERIFIKASI_CEPAT]);
    for (const rusak of ['{bukan json', JSON.stringify({ ...sah, v: 2 }), JSON.stringify({ ...sah, tag: 'zz' }), JSON.stringify({ ...sah, pepper: undefined })]) {
      ss.__seed(KUNCI_VERIFIKASI_CEPAT, rusak);
      expect(await cocokkanPinCepat('u1', ik, '123456')).toBe('TIDAK_TERSEDIA');
    }
    ss.__seed(KUNCI_VERIFIKASI_CEPAT, JSON.stringify(sah));
    ss.__setFailure('READ');
    expect(await cocokkanPinCepat('u1', ik, '123456')).toBe('TIDAK_TERSEDIA');
    ss.__setFailure('WRITE');
    // Tidak melempar walau SecureStore gagal menulis.
    await simpanPinCepat('u1', ik, '123456');
    await hapusPinCepat();
  });

  it('hapus (logout) -> TIDAK_TERSEDIA', async () => {
    await simpanPinCepat('u1', ik, '123456');
    await hapusPinCepat();
    expect(await cocokkanPinCepat('u1', ik, '123456')).toBe('TIDAK_TERSEDIA');
  });

  it('jeda PIN salah bertahap: 0,8 dtk x3 lalu 2, 4, 8, 16, maks. 30 dtk', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map(jedaSetelahGagalMs)).toEqual([800, 800, 800, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});

describe('RC-S130 §C — sambungan di AuthService', () => {
  const auth = tanpaKomentar(baca('src/services/AuthService.ts'));
  const blok = auth.slice(auth.indexOf('export async function unlockWithPin'), auth.indexOf('let gagalBeruntunPin'));

  it('jalur cepat dicoba dulu, scrypt penuh hanya bila TIDAK_TERSEDIA, lalu pemverifikasi disiapkan', () => {
    expect(blok.indexOf('cocokkanPinCepat(')).toBeGreaterThan(0);
    expect(blok.indexOf('cocokkanPinCepat(')).toBeLessThan(blok.indexOf("verifikasiDanNaikkan(db, row, pin, 'pin')"));
    expect(blok.indexOf("verifikasiDanNaikkan(db, row, pin, 'pin')")).toBeLessThan(blok.indexOf('simpanPinCepat('));
    expect(blok).toMatch(/cepat === 'TIDAK_COCOK'[\s\S]{0,200}jeda\(jedaSetelahGagalMs\(gagalBeruntunPin\)\)[\s\S]{0,80}throw new InvalidCredentialsError\(\)/);
  });

  it('scrypt kini asinkron; logout menghapus pemverifikasi; login password tidak memakai jalur cepat', () => {
    expect(auth).toMatch(/await verifikasiPinAsync\(/);
    expect(auth).toMatch(/await clearSession\(\);\s*await hapusPinCepat\(\);/);
    const login = auth.slice(auth.indexOf('export async function login'), auth.indexOf('export async function logout'));
    expect(login).not.toMatch(/PinCepat/);
  });

  it('pemverifikasi cepat tidak pernah ditulis ke database/backup', () => {
    const modul = baca('src/security/unlockCepat.ts');
    expect(modul).not.toMatch(/@\/database\/db|getDb|runAsync/);
    expect(modul).toMatch(/SecureStore\.setItemAsync\(KUNCI_VERIFIKASI_CEPAT/);
  });
});

describe('RC-S130 §D — layar kunci', () => {
  const lock = tanpaKomentar(baca('src/screens/Setup/LockScreen.tsx'));

  it('papan ketik TIDAK terbuka otomatis (tidak mengganggu animasi pembuka)', () => {
    expect(lock).not.toMatch(/autoFocus/);
    expect(lock).toMatch(/Ketuk kotak PIN untuk mulai mengetik/);
  });

  it('digit ke-6 langsung diverifikasi; dobel-submit dicegah; status memverifikasi tampil', () => {
    expect(lock).toMatch(/if \(v\.length === PANJANG_PIN\) void submitPin\(v\)/);
    expect(lock).toMatch(/if \(sedangVerifikasi\.current \|\| nilai\.length !== PANJANG_PIN\) return;/);
    expect(lock).toMatch(/Memverifikasi PIN/);
  });

  it('PIN salah: getar (native driver), isian dikosongkan, pesan jelas', () => {
    expect(lock).toMatch(/useNativeDriver: true/);
    expect(lock).toMatch(/setPin\(''\)/);
    expect(lock).toMatch(/PIN salah\. Silakan coba lagi\./);
  });

  it('biometrik hanya ditampilkan bila tersedia; tanpa dialog otomatis saat layar muncul', () => {
    expect(lock).toMatch(/\{biometrikTersedia \? \(/);
    const efek = lock.slice(lock.indexOf('useEffect('), lock.indexOf('const getarkan'));
    expect(efek).not.toMatch(/unlockWithBiometric|focus\(/);
  });
});

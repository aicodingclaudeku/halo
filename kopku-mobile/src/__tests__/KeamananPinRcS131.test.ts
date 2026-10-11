import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';
import * as SecureStoreMock from '../test-utils/expoSecureStoreMock';

/**
 * RC-S131 — Keamanan: PIN baru bisa dibuat/diganti.
 *
 * BUG: formulir PIN hanya muncul pada PIN_ENABLED_SETUP_REQUIRED, sehingga
 * PIN tidak pernah bisa diganti dan pengguna buatan Admin (PIN awal acak,
 * tidak dapat dipakai) tidak pernah bisa membuat PIN sendiri.
 *
 * Integrasi memakai SQLite + scrypt/HMAC @noble/hashes ASLI.
 */
let testDb: TestDb;

jest.mock('@/database/db', () => ({
  ...jest.requireActual('@/database/db'),
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import { login, siapkanPinCepatSetelahDiatur, unlockWithPin, verifikasiIdentitasPengguna, _resetGagalPinUntukTest } from '@/services/AuthService';
import { aturPinKunciAplikasi, createUser } from '@/services/UserManagementService';
import { cocokkanPinCepat, ikatanKredensialPin, KUNCI_VERIFIKASI_CEPAT } from '@/security/unlockCepat';
import { hashPinV2 } from '@/security/pinHash';
import { pinTerlaluMudah, validasiPinBaru } from '@/utils/pinBaru';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ss = SecureStoreMock as unknown as { __clear(): void; __dump(): Record<string, string> };

// ---------------------------------------------------------------------------
describe('RC-S131 §A — validasi PIN baru (murni)', () => {
  it('menolak PIN yang terlalu mudah ditebak', () => {
    for (const p of ['111111', '000000', '123456', '234567', '987654', '654321']) expect([p, pinTerlaluMudah(p)]).toEqual([p, true]);
    for (const p of ['135790', '112233', '120456', '908172']) expect([p, pinTerlaluMudah(p)]).toEqual([p, false]);
  });

  it('kecocokan konfirmasi hanya dinilai setelah 6 digit', () => {
    expect(validasiPinBaru('', '')).toEqual({ galatPin: null, galatKonfirmasi: null, cocok: false, bolehSimpan: false });
    expect(validasiPinBaru('135790', '1357')).toMatchObject({ galatKonfirmasi: null, cocok: false, bolehSimpan: false });
    expect(validasiPinBaru('135790', '135791')).toMatchObject({ galatKonfirmasi: 'Konfirmasi PIN berbeda dengan PIN baru.', bolehSimpan: false });
    expect(validasiPinBaru('135790', '135790')).toMatchObject({ galatPin: null, cocok: true, bolehSimpan: true });
    expect(validasiPinBaru('123456', '123456')).toMatchObject({ cocok: true, bolehSimpan: false });
    expect(validasiPinBaru('123456', '123456').galatPin).toMatch(/terlalu mudah/);
  });
});

// ---------------------------------------------------------------------------
describe('RC-S131 §B — alur nyata (SQLite + scrypt asli)', () => {
  const now = () => new Date().toISOString();
  const SALT_ADMIN = 'aa00aa00aa00aa00aa00aa00aa00aa00';
  const SALT_PW = 'bb11bb11bb11bb11bb11bb11bb11bb11';

  beforeEach(async () => {
    ss.__clear();
    _resetGagalPinUntukTest();
    testDb = await createTestDb();
    await testDb.runAsync(
      `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, pin_hash_versi,
         password_hash, password_salt, password_hash_versi, biometric_enabled, aktif, created_at, updated_at)
       VALUES ('admin-1','Admin','admin','ADMIN',?,?,2,?,?,2,0,1,?,?)`,
      hashPinV2('246810', SALT_ADMIN), SALT_ADMIN, hashPinV2('rahasiaAdmin1', SALT_PW), SALT_PW, now(), now()
    );
  });

  it('pengguna buatan Admin (PIN awal acak) dapat membuat PIN sendiri lewat password, lalu membuka kunci dengannya', async () => {
    const { id } = await createUser('admin-1', { nama: 'Budi', username: 'budi', role: 'PETUGAS' as any, password: 'rahasiaBudi9' });
    await login('budi', 'rahasiaBudi9');

    // Sebelum RC-S131 tidak ada cara apa pun: PIN acaknya tidak diketahui siapa pun.
    await expect(unlockWithPin('135790')).rejects.toThrow();

    // Bukti identitas dengan password login -> diterima.
    expect(await verifikasiIdentitasPengguna(id, 'rahasiaBudi9')).toBe(true);
    await aturPinKunciAplikasi(id, id, '135790');
    await siapkanPinCepatSetelahDiatur(id, '135790');

    // Jalur cepat langsung siap untuk PIN baru — pembukaan pertama pun instan.
    const row = await testDb.getFirstAsync<any>(`SELECT * FROM app_user WHERE id = ?`, id);
    expect(await cocokkanPinCepat(id, ikatanKredensialPin(row), '135790')).toBe('COCOK');
    await expect(unlockWithPin('135790')).resolves.toMatchObject({ id, username: 'budi' });
  });

  it('mengganti PIN yang sudah ada: diterima dengan PIN lama; PIN lama tidak berlaku lagi', async () => {
    await login('admin', 'rahasiaAdmin1');
    await unlockWithPin('246810'); // menyiapkan jalur cepat untuk PIN lama
    expect(await verifikasiIdentitasPengguna('admin-1', '246810')).toBe(true);

    await aturPinKunciAplikasi('admin-1', 'admin-1', '908172');
    await siapkanPinCepatSetelahDiatur('admin-1', '908172');

    await expect(unlockWithPin('908172')).resolves.toMatchObject({ id: 'admin-1' });
    await expect(unlockWithPin('246810')).rejects.toThrow();
    expect(ss.__dump()[KUNCI_VERIFIKASI_CEPAT]).not.toContain('908172');
  });

  it('verifikasi identitas menolak PIN/password salah dan pengguna nonaktif', async () => {
    expect(await verifikasiIdentitasPengguna('admin-1', '111222')).toBe(false);
    expect(await verifikasiIdentitasPengguna('admin-1', 'bukanPassword')).toBe(false);
    expect(await verifikasiIdentitasPengguna('admin-1', '')).toBe(false);
    await testDb.runAsync(`UPDATE app_user SET aktif = 0 WHERE id = 'admin-1'`);
    expect(await verifikasiIdentitasPengguna('admin-1', 'rahasiaAdmin1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('RC-S131 §C — struktur layar Keamanan', () => {
  const k = tanpaKomentar(baca('src/screens/Pengaturan/KeamananScreen.tsx'));
  const simpan = k.slice(k.indexOf('const simpanPinBaru'), k.indexOf('useEffect(', k.indexOf('const simpanPinBaru')));

  it('formulir PIN tidak lagi HANYA untuk SETUP_REQUIRED: ada tombol Ganti/Atur PIN', () => {
    expect(k).toMatch(/const formTerbuka = perluBuatPin \|\| formGanti;/);
    expect(k).toMatch(/\{formTerbuka && \(/);
    expect(k).toMatch(/pinAktif \? 'Ganti PIN' : 'Atur PIN'/);
    expect(k).toMatch(/setFormGanti\(true\)/);
  });

  it('ganti PIN memverifikasi identitas DULU, baru menyimpan, lalu menyiapkan jalur cepat', () => {
    const iV = simpan.indexOf('verifikasiIdentitasPengguna(');
    const iS = simpan.indexOf('await aturPinKunciAplikasi(currentUser.id, currentUser.id, pinBaru);');
    const iC = simpan.indexOf('await siapkanPinCepatSetelahDiatur(currentUser.id, pinBaru);');
    expect(iV).toBeGreaterThan(0);
    expect(iV).toBeLessThan(iS);
    expect(iS).toBeLessThan(iC);
    expect(simpan).toMatch(/if \(!sah\) \{[\s\S]{0,120}return;/);
  });

  it('verifikasi identitas menerima PIN saat ini ATAU password; layar kunci menunjukkan jalan keluar bila lupa PIN', () => {
    expect(k).toMatch(/label="PIN saat ini atau password login"/);
    expect(k).toMatch(/secureTextEntry/);
    expect(baca('src/screens/Setup/LockScreen.tsx')).toMatch(/Lupa PIN\? Keluar, lalu masuk dengan password/);
  });
});

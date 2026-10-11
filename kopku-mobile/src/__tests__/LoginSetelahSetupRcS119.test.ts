/**
 * RC-S119 — BUKTI UJUNG-KE-UJUNG: SETUP LALU MASUK.
 *
 * Test struktural hanya membaca kode. Yang harus dibuktikan di sini
 * adalah perilakunya terhadap database sungguhan, memakai fungsi hash
 * dan verifikasi yang ASLI (scrypt), bukan tiruan:
 *
 *   setupKoperasi({ adminUsername, adminPassword })  ->  login(...)
 *
 * Kenapa bukan sekadar memeriksa "kolom password terisi": kolom itu
 * SELALU terisi, termasuk pada kondisi rusak yang ditutup RC-S119 —
 * dulu ia berisi cermin hash PIN ACAK yang tidak dapat diketik siapa
 * pun. Hanya login sungguhan yang membedakan keduanya.
 */
import { createTestDb, TestDb } from './testDb';

let testDb: TestDb;

jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

jest.mock('expo-local-authentication', () => ({}));

/*
 * `@/security/pin` menyentuh expo-secure-store & expo-crypto (native).
 * Yang di-mock HANYA bagian native itu; `hashPin` tetap memanggil
 * implementasi scrypt yang asli lewat modul murni `@/security/pinHash`,
 * karena kecocokan hash inilah yang sedang diuji. Impor langsung dari
 * modul murni, bukan lewat modul yang sedang di-mock, supaya tiruan ini
 * tidak mengganti dirinya sendiri.
 */
let nomorSalt = 0;
jest.mock('@/security/pin', () => {
  const { hashPinV2 } = jest.requireActual('@/security/pinHash');
  let sesi: string | null = null;
  return {
    hashPin: jest.fn(async (rahasia: string, salt: string) => hashPinV2(rahasia, salt)),
    // Setiap panggilan menghasilkan salt BERBEDA, seperti aslinya —
    // salt konstan akan menyembunyikan tepat bug yang diperbaiki di
    // sini (password dan PIN berbagi satu salt).
    generateSalt: jest.fn(() => `salt-uji-${++nomorSalt}`),
    setSession: jest.fn(async (id: string) => { sesi = id; }),
    getSession: jest.fn(async () => sesi),
    clearSession: jest.fn(async () => { sesi = null; }),
    touchSession: jest.fn(async () => {}),
    isSessionLocked: jest.fn(async () => false),
    verifyPin: jest.fn(async () => false),
  };
});

import { setupKoperasi } from '@/services/SetupService';
import { login } from '@/services/AuthService';

const DASAR = { nama: 'Koperasi Uji', tahunBuku: 2026 };

describe('RC-S119 — admin dapat masuk dengan password yang dipilih saat setup', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  test('login berhasil dengan username & password dari wizard', async () => {
    await setupKoperasi({
      ...DASAR,
      adminNama: 'Ketua Koperasi',
      adminUsername: 'ketua',
      adminPassword: 'RahasiaKoperasi9',
    });

    const user = await login('ketua', 'RahasiaKoperasi9');
    expect(user.username).toBe('ketua');
    expect(user.role).toBe('ADMIN');
  });

  test('password yang salah tetap ditolak', async () => {
    await setupKoperasi({ ...DASAR, adminUsername: 'ketua', adminPassword: 'RahasiaKoperasi9' });
    await expect(login('ketua', 'RahasiaKoperasi8')).rejects.toThrow();
  });

  test('password TIDAK ikut menjadi PIN — keduanya peran terpisah', async () => {
    await setupKoperasi({ ...DASAR, adminUsername: 'ketua', adminPassword: 'RahasiaKoperasi9' });
    const row = await testDb.getFirstAsync<any>(
      `SELECT pin_hash, pin_salt, password_hash, password_salt FROM app_user WHERE username = 'ketua'`
    );
    expect(row.password_hash).not.toBe(row.pin_hash);
    expect(row.password_salt).not.toBe(row.pin_salt);
  });

  test('spasi di ujung username dipangkas, dan login tetap memakai bentuk yang tersimpan', async () => {
    await setupKoperasi({ ...DASAR, adminUsername: '  ketua  ', adminPassword: 'RahasiaKoperasi9' });
    const user = await login('ketua', 'RahasiaKoperasi9');
    expect(user.username).toBe('ketua');
  });

  test('username tidak sah ditolak service, bukan diam-diam tersimpan', async () => {
    await expect(
      setupKoperasi({ ...DASAR, adminUsername: 'ketua koperasi', adminPassword: 'RahasiaKoperasi9' })
    ).rejects.toThrow(/spasi/i);
  });

  test('password tidak sah ditolak service', async () => {
    // Hanya angka = PIN, bukan password. Aturannya datang dari modul
    // kebijakan yang sama dengan yang dipakai layar.
    await expect(
      setupKoperasi({ ...DASAR, adminUsername: 'ketua', adminPassword: '12345678' })
    ).rejects.toThrow(/PIN/i);
  });

  test('pemanggil lama tanpa adminPassword TIDAK berubah perilakunya', async () => {
    // Jalur non-wizard (mis. test lain) tetap mencerminkan hash PIN
    // seperti semula, supaya tidak ada yang berubah diam-diam.
    await setupKoperasi({ ...DASAR, adminUsername: 'admin', adminPin: '135790' });
    const row = await testDb.getFirstAsync<any>(
      `SELECT pin_hash, password_hash FROM app_user WHERE username = 'admin'`
    );
    expect(row.password_hash).toBe(row.pin_hash);
    const user = await login('admin', '135790');
    expect(user.username).toBe('admin');
  });
});

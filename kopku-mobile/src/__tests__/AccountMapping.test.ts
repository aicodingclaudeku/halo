import { createTestDb, TestDb } from './testDb';
import {
  resolveAccountId,
  resolveKasBankAccountId,
  InactiveAccountError,
  InactiveBankAccountError,
  MissingAccountMappingError,
} from '@/accounting/AccountMapping';

/**
 * Test khusus Phase 2 (AUDIT_INTERNAL.md §5 & §4 "account active"):
 * resolveAccountId/resolveKasBankAccountId sekarang menolak akun atau
 * rekening bank yang sudah dinonaktifkan, bukan diam-diam tetap
 * mengembalikan account_id-nya.
 */

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, isActive: boolean) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,?,0,?,?)`,
    id,
    kode,
    nama,
    'ASET',
    'DEBIT',
    isActive ? 1 : 0,
    now,
    now
  );
}

describe('AccountMapping — validasi akun/rekening aktif (Phase 2)', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await createTestDb();
  });

  test('resolveAccountId: akun aktif berhasil di-resolve', async () => {
    await seedAccount(testDb, 'acc-1', '1-1000', 'Kas', true);
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
      'map-1',
      'KAS_UMUM',
      'DEFAULT',
      'acc-1'
    );

    const id = await resolveAccountId(testDb as any, 'KAS_UMUM', 'DEFAULT');
    expect(id).toBe('acc-1');
  });

  test('resolveAccountId: akun NONAKTIF ditolak dengan pesan jelas', async () => {
    await seedAccount(testDb, 'acc-2', '1-1000', 'Kas Lama', false);
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
      'map-2',
      'KAS_UMUM',
      'DEFAULT',
      'acc-2'
    );

    await expect(resolveAccountId(testDb as any, 'KAS_UMUM', 'DEFAULT')).rejects.toThrow(InactiveAccountError);
    await expect(resolveAccountId(testDb as any, 'KAS_UMUM', 'DEFAULT')).rejects.toThrow(/Kas Lama/);
  });

  test('resolveAccountId: mapping tidak ada tetap error seperti sebelumnya', async () => {
    await expect(resolveAccountId(testDb as any, 'TIDAK_ADA', 'DEFAULT')).rejects.toThrow(MissingAccountMappingError);
  });

  test('resolveKasBankAccountId: rekening bank aktif berhasil di-resolve', async () => {
    await seedAccount(testDb, 'acc-bank', '1-1100', 'Bank', true);
    await testDb.runAsync(
      `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      'bank-1',
      'BCA',
      '12345',
      'Koperasi',
      0,
      'acc-bank',
      1,
      new Date().toISOString()
    );

    const id = await resolveKasBankAccountId(testDb as any, 'BANK', 'bank-1');
    expect(id).toBe('acc-bank');
  });

  test('resolveKasBankAccountId: rekening bank NONAKTIF ditolak', async () => {
    await seedAccount(testDb, 'acc-bank2', '1-1100', 'Bank', true);
    await testDb.runAsync(
      `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      'bank-2',
      'BNI (ditutup)',
      '99999',
      'Koperasi',
      0,
      'acc-bank2',
      0,
      new Date().toISOString()
    );

    await expect(resolveKasBankAccountId(testDb as any, 'BANK', 'bank-2')).rejects.toThrow(InactiveBankAccountError);
  });
});

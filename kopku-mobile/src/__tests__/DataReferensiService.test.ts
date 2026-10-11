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

import { listDataReferensi, tambahDataReferensi, editDataReferensi, hapusDataReferensi } from '@/services/DataReferensiService';

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    new Date().toISOString(),
    new Date().toISOString()
  );
  return db;
}

describe('DataReferensiService', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('tambahDataReferensi lalu listDataReferensi mengembalikan entri yang baru dibuat', async () => {
    await tambahDataReferensi({ jenis: 'PEMASOK', nama: 'Toko Elektronik Jaya', createdBy: 'user-1' });
    const daftar = await listDataReferensi('PEMASOK');
    expect(daftar).toHaveLength(1);
    expect(daftar[0].nama).toBe('Toko Elektronik Jaya');
    expect(daftar[0].aktif).toBe(true);
  });

  test('jenis berbeda tidak saling tercampur', async () => {
    await tambahDataReferensi({ jenis: 'PEMASOK', nama: 'Toko A', createdBy: 'user-1' });
    await tambahDataReferensi({ jenis: 'PEMBERI_PINJAMAN_BANK', nama: 'Bank BRI', createdBy: 'user-1' });
    expect(await listDataReferensi('PEMASOK')).toHaveLength(1);
    expect(await listDataReferensi('PEMBERI_PINJAMAN_BANK')).toHaveLength(1);
    expect(await listDataReferensi('PEMBERI_PINJAMAN_PIHAK_LAIN')).toHaveLength(0);
  });

  test('menambah nama yang sama (case-insensitive) TIDAK membuat duplikat — mengembalikan entri yang sudah ada', async () => {
    const pertama = await tambahDataReferensi({ jenis: 'PEMASOK', nama: 'Toko Jaya', createdBy: 'user-1' });
    const kedua = await tambahDataReferensi({ jenis: 'PEMASOK', nama: 'toko jaya', createdBy: 'user-1' });
    expect(kedua.id).toBe(pertama.id);
    expect(await listDataReferensi('PEMASOK')).toHaveLength(1);
  });

  test('listDataReferensi tanpa termasukNonaktif hanya mengembalikan entri aktif', async () => {
    const { id } = await tambahDataReferensi({ jenis: 'BEBAN_LAIN', nama: 'Sumbangan Sosial', createdBy: 'user-1' });
    await editDataReferensi({ id, nama: 'Sumbangan Sosial', aktif: false, updatedBy: 'user-1' });

    expect(await listDataReferensi('BEBAN_LAIN')).toHaveLength(0);
    expect(await listDataReferensi('BEBAN_LAIN', { termasukNonaktif: true })).toHaveLength(1);
  });

  test('tambahDataReferensi menolak nama kosong', async () => {
    await expect(tambahDataReferensi({ jenis: 'PEMASOK', nama: '   ', createdBy: 'user-1' })).rejects.toThrow(/[Nn]ama/);
  });

  test('Phase 17 §U/§V: tambahDataReferensi & editDataReferensi menyimpan alamat', async () => {
    const item = await tambahDataReferensi({ jenis: 'PEMASOK', nama: 'Toko Bangunan Makmur', alamat: 'Jl. Merdeka No. 10', createdBy: 'user-1' });
    expect(item.alamat).toBe('Jl. Merdeka No. 10');

    await editDataReferensi({ id: item.id, nama: item.nama, alamat: 'Jl. Merdeka No. 20', aktif: true, updatedBy: 'user-1' });
    const daftar = await listDataReferensi('PEMASOK');
    expect(daftar[0].alamat).toBe('Jl. Merdeka No. 20');
  });

  test('Phase 17 §U/§V: hapusDataReferensi menghapus entri secara permanen', async () => {
    const item = await tambahDataReferensi({ jenis: 'PEMBERI_PINJAMAN_PIHAK_LAIN', nama: 'Budi Santoso', alamat: 'Jl. Kenanga No. 5', createdBy: 'user-1' });
    await hapusDataReferensi('user-1', item.id);
    expect(await listDataReferensi('PEMBERI_PINJAMAN_PIHAK_LAIN', { termasukNonaktif: true })).toHaveLength(0);
  });

  test('hapusDataReferensi untuk id yang tidak ada melempar error', async () => {
    await expect(hapusDataReferensi('user-1', 'id-tidak-ada')).rejects.toThrow(/tidak ditemukan/i);
  });
});

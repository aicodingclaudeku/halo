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

import {
  listKelompokAset,
  listSubKelompokAset,
  listAsetKlasifikasi,
  tambahAsetKlasifikasi,
  editAsetKlasifikasi,
} from '@/services/AsetKlasifikasiService';

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

describe('AsetKlasifikasiService (Bagian G)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('createTestDb() murni (tanpa lewat SetupService) tetap dimulai kosong — tidak ada data bawaan/angka SAK yang dikarang di level repository', async () => {
    // CATATAN Phase 18 §14-19: instalasi SUNGGUHAN (lewat
    // SetupService.setupKoperasi untuk instalasi baru, atau migration
    // v20 untuk instalasi lama) SEKARANG diisi 4 kelompok default
    // (lihat SetupService.test.ts & MigrationV18.test.ts). Test ini
    // HANYA memverifikasi bahwa AsetKlasifikasiService sendiri tidak
    // diam-diam mengarang/menyuntik data — tabel kosong di sini karena
    // fixture-nya sengaja tidak memanggil SetupService/migration sama
    // sekali, bukan karena keseluruhan app masih berperilaku kosong.
    expect(await listAsetKlasifikasi({ termasukNonaktif: true })).toHaveLength(0);
    expect(await listKelompokAset()).toHaveLength(0);
  });

  test('tambahAsetKlasifikasi lalu listKelompokAset/listSubKelompokAset mengembalikan entri yang baru dibuat', async () => {
    await tambahAsetKlasifikasi({
      kelompok: 'Peralatan & Perlengkapan',
      subKelompok: 'Komputer & Laptop',
      masaManfaatBulanDefault: 48,
      createdBy: 'user-1',
    });

    expect(await listKelompokAset()).toEqual(['Peralatan & Perlengkapan']);
    const subList = await listSubKelompokAset('Peralatan & Perlengkapan');
    expect(subList).toHaveLength(1);
    expect(subList[0].subKelompok).toBe('Komputer & Laptop');
    expect(subList[0].masaManfaatBulanDefault).toBe(48);
  });

  test('menambah kombinasi kelompok+sub-kelompok yang SAMA (case-insensitive) DITOLAK', async () => {
    await tambahAsetKlasifikasi({
      kelompok: 'Kendaraan',
      subKelompok: 'Roda Dua',
      masaManfaatBulanDefault: 48,
      createdBy: 'user-1',
    });
    await expect(
      tambahAsetKlasifikasi({ kelompok: 'kendaraan', subKelompok: 'roda dua', masaManfaatBulanDefault: 60, createdBy: 'user-1' })
    ).rejects.toThrow(/sudah ada/);
  });

  test('tambahAsetKlasifikasi menolak masa manfaat 0 atau negatif', async () => {
    await expect(
      tambahAsetKlasifikasi({ kelompok: 'Bangunan', subKelompok: 'Gedung Kantor', masaManfaatBulanDefault: 0, createdBy: 'user-1' })
    ).rejects.toThrow(/lebih dari 0/);
  });

  // Audit ulang (permintaan pengguna §18): masa manfaat default SEKARANG
  // boleh null (mis. Kelompok 5 "Lainnya") — sebelumnya wajib angka > 0.
  test('tambahAsetKlasifikasi menerima masa manfaat null (masa manfaat belum ditentukan)', async () => {
    const item = await tambahAsetKlasifikasi({
      kelompok: 'Kelompok 5',
      subKelompok: 'Lainnya',
      masaManfaatBulanDefault: null,
      createdBy: 'user-1',
    });
    expect(item.masaManfaatBulanDefault).toBeNull();

    const sub = await listSubKelompokAset('Kelompok 5');
    expect(sub[0].masaManfaatBulanDefault).toBeNull();
  });

  test('editAsetKlasifikasi bisa mengubah masa manfaat kembali menjadi null', async () => {
    const item = await tambahAsetKlasifikasi({
      kelompok: 'Kelompok 5',
      subKelompok: 'Lainnya',
      masaManfaatBulanDefault: 100,
      createdBy: 'user-1',
    });
    await editAsetKlasifikasi({ id: item.id, masaManfaatBulanDefault: null, aktif: true, updatedBy: 'user-1' });
    const sub = await listSubKelompokAset('Kelompok 5');
    expect(sub[0].masaManfaatBulanDefault).toBeNull();
  });

  test('editAsetKlasifikasi mengubah masa manfaat default & bisa menonaktifkan', async () => {
    const item = await tambahAsetKlasifikasi({
      kelompok: 'Kendaraan',
      subKelompok: 'Roda Empat',
      masaManfaatBulanDefault: 96,
      createdBy: 'user-1',
    });

    await editAsetKlasifikasi({ id: item.id, masaManfaatBulanDefault: 120, aktif: true, updatedBy: 'user-1' });
    let sub = await listSubKelompokAset('Kendaraan');
    expect(sub[0].masaManfaatBulanDefault).toBe(120);

    await editAsetKlasifikasi({ id: item.id, masaManfaatBulanDefault: 120, aktif: false, updatedBy: 'user-1' });
    sub = await listSubKelompokAset('Kendaraan'); // default: hanya aktif
    expect(sub).toHaveLength(0);
    const semua = await listSubKelompokAset('Kendaraan', { termasukNonaktif: true });
    expect(semua).toHaveLength(1);
  });

  test('listSubKelompokAset untuk kelompok berbeda tidak saling tercampur', async () => {
    await tambahAsetKlasifikasi({ kelompok: 'Kendaraan', subKelompok: 'Roda Dua', masaManfaatBulanDefault: 48, createdBy: 'user-1' });
    await tambahAsetKlasifikasi({ kelompok: 'Bangunan', subKelompok: 'Gedung Kantor', masaManfaatBulanDefault: 240, createdBy: 'user-1' });

    expect(await listSubKelompokAset('Kendaraan')).toHaveLength(1);
    expect(await listSubKelompokAset('Bangunan')).toHaveLength(1);
    expect(await listKelompokAset()).toEqual(['Bangunan', 'Kendaraan']); // urut alfabet
  });
});

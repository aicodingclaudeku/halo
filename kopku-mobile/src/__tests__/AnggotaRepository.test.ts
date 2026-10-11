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

import { createAnggota, updateAnggota, getAnggotaById } from '@/repositories/AnggotaRepository';

async function seedUser(db: TestDb) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
}

const BASE_INPUT = {
  namaLengkap: 'Anggota Uji',
  tanggalBergabung: '2026-01-01',
};

describe('AnggotaRepository — nomor anggota otomatis (Phase 17 §C)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb);
  });

  test('createAnggota menghasilkan nomor anggota otomatis format A00001 untuk anggota pertama', async () => {
    const a = await createAnggota('user-1', { ...BASE_INPUT });
    expect(a.nomorAnggota).toBe('A00001');
  });

  test('nomor anggota berurut & unik untuk anggota berikutnya', async () => {
    const a1 = await createAnggota('user-1', { ...BASE_INPUT, namaLengkap: 'Anggota 1' });
    const a2 = await createAnggota('user-1', { ...BASE_INPUT, namaLengkap: 'Anggota 2' });
    const a3 = await createAnggota('user-1', { ...BASE_INPUT, namaLengkap: 'Anggota 3' });
    expect([a1.nomorAnggota, a2.nomorAnggota, a3.nomorAnggota]).toEqual(['A00001', 'A00002', 'A00003']);
  });

  test('nomor anggota lanjut dari nomor tertinggi yang sudah ada (data lama/import), tidak mulai dari 0', async () => {
    // Simulasikan anggota lama yang sudah ada di database tanpa lewat
    // generator ini (mis. hasil import), dengan nomor tinggi.
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('anggota-lama','A00050','Anggota Lama','2020-01-01','AKTIF',?,?)`,
      now,
      now
    );
    const baru = await createAnggota('user-1', { ...BASE_INPUT });
    expect(baru.nomorAnggota).toBe('A00051');
  });

  test('nomor anggota TIDAK berubah ketika anggota diedit', async () => {
    const a = await createAnggota('user-1', { ...BASE_INPUT });
    await updateAnggota('user-1', a.id, {
      namaLengkap: 'Nama Baru Setelah Edit',
      tanggalBergabung: a.tanggalBergabung,
      status: 'AKTIF',
    } as any);
    const setelahEdit = await getAnggotaById(a.id);
    expect(setelahEdit?.nomorAnggota).toBe(a.nomorAnggota);
    expect(setelahEdit?.namaLengkap).toBe('Nama Baru Setelah Edit');
  });

  // Catatan: keamanan terhadap insert bersamaan didapat secara struktural
  // dari pola yang sama dengan `nextSequence` (baca MAX + UPDATE counter
  // di DALAM transaksi DB yang sama dengan INSERT anggota-nya) — SQLite
  // di app ini (baik expo-sqlite native maupun harness test di sini)
  // memakai satu koneksi dengan transaksi yang serial, jadi tidak ada
  // celah antara baca nilai terakhir dan penulisannya. Test eksplisit
  // "dua insert paralel" tidak realistis untuk ditulis di atas harness
  // sql.js single-connection ini (transaksi nested akan error), jadi
  // yang diuji langsung adalah hasil akhirnya: berurut & tidak dobel
  // (test-test di atas).
});

describe('listAnggota — update pasca-Phase 18/19 §Q (tidak lagi LIMIT 50 default untuk layar Anggota)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb);
  });

  test('semuaData: true mengembalikan SELURUH anggota tanpa LIMIT (lebih dari 50)', async () => {
    for (let i = 0; i < 60; i++) {
      await createAnggota('user-1', { ...BASE_INPUT, namaLengkap: `Anggota ${String(i).padStart(3, '0')}` });
    }

    const { listAnggota } = await import('@/repositories/AnggotaRepository');
    const semua = await listAnggota({ semuaData: true });
    expect(semua).toHaveLength(60);
  });

  test('tanpa semuaData: tetap LIMIT 50 default (picker/pemakai lain TIDAK berubah perilakunya)', async () => {
    for (let i = 0; i < 60; i++) {
      await createAnggota('user-1', { ...BASE_INPUT, namaLengkap: `Anggota ${String(i).padStart(3, '0')}` });
    }

    const { listAnggota } = await import('@/repositories/AnggotaRepository');
    const dibatasi = await listAnggota({});
    expect(dibatasi).toHaveLength(50);
  });

  test('semuaData: true tetap menghormati search & filter status', async () => {
    await createAnggota('user-1', { ...BASE_INPUT, namaLengkap: 'Budi Santoso', status: 'AKTIF' });
    await createAnggota('user-1', { ...BASE_INPUT, namaLengkap: 'Sari Wulan', status: 'TIDAK_AKTIF' });

    const { listAnggota } = await import('@/repositories/AnggotaRepository');
    const hasilSearch = await listAnggota({ search: 'Budi', semuaData: true });
    expect(hasilSearch).toHaveLength(1);
    expect(hasilSearch[0].namaLengkap).toBe('Budi Santoso');

    const hasilStatus = await listAnggota({ status: 'TIDAK_AKTIF', semuaData: true });
    expect(hasilStatus).toHaveLength(1);
    expect(hasilStatus[0].namaLengkap).toBe('Sari Wulan');
  });
});

describe('AnggotaRepository — Jenis Kelamin (permintaan pengguna §8)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb);
  });

  test('createAnggota: jenisKelamin tersimpan & terbaca kembali', async () => {
    const a = await createAnggota('user-1', { ...BASE_INPUT, jenisKelamin: 'PEREMPUAN' });
    const loaded = await getAnggotaById(a.id);
    expect(loaded?.jenisKelamin).toBe('PEREMPUAN');
  });

  test('createAnggota TANPA jenisKelamin (anggota lama/opsional): tetap berhasil, nilainya null', async () => {
    const a = await createAnggota('user-1', { ...BASE_INPUT });
    const loaded = await getAnggotaById(a.id);
    expect(loaded?.jenisKelamin ?? null).toBeNull();
  });

  test('updateAnggota: jenisKelamin bisa diubah/diisi belakangan tanpa merusak field lain', async () => {
    const a = await createAnggota('user-1', { ...BASE_INPUT });
    const before = await getAnggotaById(a.id);
    await updateAnggota('user-1', a.id, { ...before!, jenisKelamin: 'LAKI_LAKI' } as any);
    const after = await getAnggotaById(a.id);
    expect(after?.jenisKelamin).toBe('LAKI_LAKI');
    expect(after?.namaLengkap).toBe(BASE_INPUT.namaLengkap);
  });
});

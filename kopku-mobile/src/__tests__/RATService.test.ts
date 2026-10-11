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

import { simpanRAT, hapusRAT, getRATByTahunBuku, listRAT } from '@/services/RATService';

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  return db;
}

describe('RATService (update pasca-Phase 18 §12/§13)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('simpanRAT: data tersimpan SUNGGUHAN ke database (bukan cuma state UI)', async () => {
    const rat = await simpanRAT({ tahunBuku: 2026, tanggalRat: '2026-05-01', nomorRat: 'RAT/2026/01', keterangan: 'RAT Tahunan', createdBy: 'user-1' });
    expect(rat.tahunBuku).toBe(2026);

    const baris = await testDb.getFirstAsync<any>(`SELECT * FROM rat WHERE tahun_buku = 2026`);
    expect(baris).not.toBeNull();
    expect(baris.tanggal_rat).toBe('2026-05-01');
    expect(baris.nomor_rat).toBe('RAT/2026/01');
  });

  test('getRATByTahunBuku: null kalau belum ada RAT untuk tahun tsb', async () => {
    expect(await getRATByTahunBuku(2026)).toBeNull();
  });

  test('getRATByTahunBuku: mengembalikan data setelah disimpan', async () => {
    await simpanRAT({ tahunBuku: 2026, tanggalRat: '2026-05-01', createdBy: 'user-1' });
    const rat = await getRATByTahunBuku(2026);
    expect(rat?.tahunBuku).toBe(2026);
  });

  test('§13: satu RAT per tahun buku — panggil dua kali untuk tahun yang sama UPDATE baris yang sama, bukan duplikat', async () => {
    await simpanRAT({ tahunBuku: 2026, tanggalRat: '2026-05-01', keterangan: 'Draft awal', createdBy: 'user-1' });
    await simpanRAT({ tahunBuku: 2026, tanggalRat: '2026-05-15', keterangan: 'Jadwal final', createdBy: 'user-1' });

    const semua = await testDb.getAllAsync<any>(`SELECT * FROM rat WHERE tahun_buku = 2026`);
    expect(semua).toHaveLength(1);
    expect(semua[0].tanggal_rat).toBe('2026-05-15');
    expect(semua[0].keterangan).toBe('Jadwal final');
  });

  test('simpanRAT: DITOLAK kalau tanggal RAT kosong (field wajib §12)', async () => {
    await expect(simpanRAT({ tahunBuku: 2026, tanggalRat: '', createdBy: 'user-1' })).rejects.toThrow(/[Tt]anggal pelaksanaan RAT wajib/);
  });

  test('listRAT: mengembalikan semua RAT terbaru dulu', async () => {
    await simpanRAT({ tahunBuku: 2025, tanggalRat: '2025-05-01', createdBy: 'user-1' });
    await simpanRAT({ tahunBuku: 2026, tanggalRat: '2026-05-01', createdBy: 'user-1' });

    const semua = await listRAT();
    expect(semua.map((r) => r.tahunBuku)).toEqual([2026, 2025]);
  });
});

describe('RATService — hapusRAT (permintaan pengguna §13)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('hapusRAT: baris terhapus dari database & audit_log tercatat (CREATE dari simpanRAT + DELETE)', async () => {
    const rat = await simpanRAT({ tahunBuku: 2026, tanggalRat: '2026-05-01', createdBy: 'user-1' });
    await hapusRAT({ id: rat.id, alasan: 'Salah input tahun buku', actingUserId: 'user-1' });

    expect(await getRATByTahunBuku(2026)).toBeNull();

    const audit = await testDb.getAllAsync<any>(`SELECT action FROM audit_log WHERE entity = 'rat' AND entity_id = ? ORDER BY created_at ASC`, rat.id);
    expect(audit.map((a) => a.action)).toEqual(['CREATE', 'DELETE']);
  });

  test('hapusRAT: DITOLAK kalau alasan kosong', async () => {
    const rat = await simpanRAT({ tahunBuku: 2026, tanggalRat: '2026-05-01', createdBy: 'user-1' });
    await expect(hapusRAT({ id: rat.id, alasan: '   ', actingUserId: 'user-1' })).rejects.toThrow(/[Aa]lasan/);
    expect(await getRATByTahunBuku(2026)).not.toBeNull();
  });

  test('hapusRAT: DITOLAK kalau periode akuntansi tahun buku terkait sudah CLOSED', async () => {
    const rat = await simpanRAT({ tahunBuku: 2026, tanggalRat: '2026-05-01', createdBy: 'user-1' });
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p-2026',2026,'2026-01-01','2026-12-31','CLOSED')`
    );

    await expect(hapusRAT({ id: rat.id, alasan: 'Coba hapus', actingUserId: 'user-1' })).rejects.toThrow(/sudah ditutup/);
    expect(await getRATByTahunBuku(2026)).not.toBeNull();
  });

  test('hapusRAT: TETAP BOLEH kalau periode tahun buku lain (bukan tahun buku RAT ini) yang CLOSED', async () => {
    const rat = await simpanRAT({ tahunBuku: 2026, tanggalRat: '2026-05-01', createdBy: 'user-1' });
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p-2025',2025,'2025-01-01','2025-12-31','CLOSED')`
    );

    await hapusRAT({ id: rat.id, alasan: 'Salah input', actingUserId: 'user-1' });
    expect(await getRATByTahunBuku(2026)).toBeNull();
  });

  test('hapusRAT: DITOLAK kalau sudah dipakai mengesahkan SHU (shu_konfigurasi.rat_id terisi)', async () => {
    const rat = await simpanRAT({ tahunBuku: 2026, tanggalRat: '2026-05-01', createdBy: 'user-1' });
    // Bug fix (test): INSERT manual sebelumnya tidak mengisi
    // created_at/updated_at yang NOT NULL di skema shu_konfigurasi
    // (lihat schema.ts) — sebelumnya melempar "NOT NULL constraint
    // failed", bukan menguji skenario yang dimaksud sama sekali.
    const nowIso = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO shu_konfigurasi (id, tahun_buku, persen_cadangan, persen_jasa_modal, persen_jasa_usaha, persen_pendidikan, persen_sosial, persen_pengurus, persen_pengawas, rat_id, created_at, updated_at)
       VALUES ('shu-2026',2026,20,25,25,10,10,5,5,?,?,?)`,
      rat.id,
      nowIso,
      nowIso
    );

    await expect(hapusRAT({ id: rat.id, alasan: 'Coba hapus', actingUserId: 'user-1' })).rejects.toThrow(/sudah dipakai untuk mengesahkan SHU/);
    expect(await getRATByTahunBuku(2026)).not.toBeNull();
  });

  test('hapusRAT: DITOLAK kalau id tidak ditemukan', async () => {
    await expect(hapusRAT({ id: 'tidak-ada', alasan: 'Alasan', actingUserId: 'user-1' })).rejects.toThrow(/tidak ditemukan/);
  });
});

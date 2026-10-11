import { createTestDb, TestDb } from './testDb';
import { runMigrations } from '@/database/db';
import { SCHEMA_VERSION } from '@/database/schema';

/**
 * ============================================================
 * MIGRASI v54 -> v55 — TABEL PENARIKAN DINI SIMPANAN BERJANGKA (S21)
 * ============================================================
 *
 * Yang dibuktikan:
 *   1) dua tabel baru terbentuk dengan indeks uniknya;
 *   2) TIDAK ADA kolom baru pada `simpanan_berjangka` maupun
 *      `simpanan_berjangka_bunga` — migrasi minimal (§M);
 *   3) data kontrak & jurnal yang sudah ada TIDAK disentuh;
 *   4) tabel kebijakan tetap KOSONG setelah migrasi — instalasi lama
 *      TIDAK mendadak mengizinkan penarikan dini (§AL);
 *   5) integrity_check `ok`, foreign_key_check kosong;
 *   6) idempoten: dijalankan dua kali menghasilkan keadaan identik.
 */

let testDb: TestDb;
const NOW = '2026-01-01T00:00:00.000Z';

async function siapkanInstalasiV54(db: TestDb) {
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`
  );
  await db.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 54)`);

  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES ('acc-berjangka','2-1210','Simpanan Anggota (Berjangka)','LIABILITAS','KREDIT',1,1,?,?)`,
    NOW, NOW
  );
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('a-1','A001','1111111111111111','Anggota Uji','2020-01-01','AKTIF',?,?)`,
    NOW, NOW
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  // Kontrak lama yang sudah berjalan — harus lolos migrasi tanpa berubah.
  await db.runAsync(
    `INSERT INTO simpanan_berjangka
      (id, anggota_id, nomor_transaksi, tanggal_mulai, tanggal_jatuh_tempo, nominal,
       tenor_bulan, suku_bunga, status, sumber_dana, bunga_terakru, bunga_dibayar,
       created_by, created_at, updated_at)
     VALUES ('k-1','a-1','SPB-2026-000001','2026-06-12','2026-12-12',24000000,6,6,'AKTIF','KAS',
             240000,0,'user-1',?,?)`,
    NOW, NOW
  );
  // Tabel v55 sengaja DIHAPUS supaya benar-benar meniru instalasi v54.
  await db.execAsync(`DROP TABLE IF EXISTS simpanan_berjangka_pencairan_dini;`);
  await db.execAsync(`DROP TABLE IF EXISTS simpanan_berjangka_kebijakan_dini;`);
}

const adaTabel = async (db: TestDb, nama: string) =>
  !!(await db.getFirstAsync(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, nama));

const kolom = async (db: TestDb, tabel: string) =>
  (await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${tabel})`)).map((c) => c.name);

const indeks = async (db: TestDb, tabel: string) =>
  (
    await db.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      tabel
    )
  ).map((i) => i.name);

const angka = async (db: TestDb, sql: string) =>
  (await db.getFirstAsync<{ n: number }>(sql))!.n;

beforeEach(async () => {
  testDb = await createTestDb();
  await siapkanInstalasiV54(testDb);
});

test('§1 dua tabel baru terbentuk beserta indeks uniknya; versi naik ke SCHEMA_VERSION', async () => {
  expect(await adaTabel(testDb, 'simpanan_berjangka_kebijakan_dini')).toBe(false);

  await runMigrations(testDb as any);

  expect(await adaTabel(testDb, 'simpanan_berjangka_kebijakan_dini')).toBe(true);
  expect(await adaTabel(testDb, 'simpanan_berjangka_pencairan_dini')).toBe(true);
  expect(await indeks(testDb, 'simpanan_berjangka_kebijakan_dini')).toEqual([
    'idx_sb_kebijakan_dini_aktif',
  ]);
  expect(await indeks(testDb, 'simpanan_berjangka_pencairan_dini')).toEqual([
    'idx_sb_dini_idempotency',
    'idx_sb_dini_kontrak',
  ]);
  expect(await angka(testDb, `SELECT version as n FROM schema_meta`)).toBe(SCHEMA_VERSION);
});

test('§2 MIGRASI MINIMAL — tidak ada kolom baru pada tabel simpanan berjangka yang sudah ada', async () => {
  const kolomSebelum = await kolom(testDb, 'simpanan_berjangka');
  const bungaSebelum = await kolom(testDb, 'simpanan_berjangka_bunga');

  await runMigrations(testDb as any);

  expect(await kolom(testDb, 'simpanan_berjangka')).toEqual(kolomSebelum);
  expect(await kolom(testDb, 'simpanan_berjangka_bunga')).toEqual(bungaSebelum);
});

test('§3 data kontrak lama tidak berubah sedikit pun', async () => {
  const sebelum = await testDb.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM simpanan_berjangka ORDER BY id`
  );
  await runMigrations(testDb as any);
  expect(await testDb.getAllAsync(`SELECT * FROM simpanan_berjangka ORDER BY id`)).toEqual(sebelum);
});

test('§4 tabel kebijakan KOSONG setelah migrasi — penarikan dini tidak mendadak aktif', async () => {
  await runMigrations(testDb as any);
  expect(await angka(testDb, `SELECT COUNT(*) as n FROM simpanan_berjangka_kebijakan_dini`)).toBe(0);
  expect(await angka(testDb, `SELECT COUNT(*) as n FROM simpanan_berjangka_pencairan_dini`)).toBe(0);
});

test('§5 integrity_check ok & foreign_key_check kosong', async () => {
  await runMigrations(testDb as any);
  const ic = await testDb.getAllAsync<Record<string, string>>(`PRAGMA integrity_check`);
  expect(Object.values(ic[0])[0]).toBe('ok');
  expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toEqual([]);
});

test('§6 idempoten — dijalankan dua kali menghasilkan keadaan identik', async () => {
  await runMigrations(testDb as any);
  const snapshot = async () => ({
    versi: await angka(testDb, `SELECT version as n FROM schema_meta`),
    kolomKebijakan: await kolom(testDb, 'simpanan_berjangka_kebijakan_dini'),
    kolomSettlement: await kolom(testDb, 'simpanan_berjangka_pencairan_dini'),
    idxKebijakan: await indeks(testDb, 'simpanan_berjangka_kebijakan_dini'),
    idxSettlement: await indeks(testDb, 'simpanan_berjangka_pencairan_dini'),
    kontrak: await testDb.getAllAsync(`SELECT * FROM simpanan_berjangka ORDER BY id`),
  });
  const pertama = await snapshot();

  await runMigrations(testDb as any);
  expect(await snapshot()).toEqual(pertama);
});

test('§7 indeks unik kebijakan benar-benar menegakkan satu kebijakan AKTIF', async () => {
  await runMigrations(testDb as any);
  const isi = (versi: string, status: string) =>
    testDb.runAsync(
      `INSERT INTO simpanan_berjangka_kebijakan_dini
        (id, versi, berlaku_mulai, diizinkan, jenis_penalti, jenis_forfeiture,
         jenis_biaya_admin, jenis_penyesuaian_rate, perlakuan_pokok, perlakuan_bunga,
         status, created_by, created_at, updated_at)
       VALUES (?,?,'2026-01-01',1,'TIDAK_ADA','TIDAK_ADA','TIDAK_ADA','TIDAK_ADA',
               'PENUH','BAYAR_SETELAH_FORFEITURE',?, 'user-1',?,?)`,
      `kbj-${versi}`, versi, status, NOW, NOW
    );

  await isi('EW-1', 'AKTIF');
  await expect(isi('EW-2', 'AKTIF')).rejects.toThrow();
  await isi('EW-3', 'NONAKTIF'); // versi nonaktif boleh banyak
  expect(
    await angka(testDb, `SELECT COUNT(*) as n FROM simpanan_berjangka_kebijakan_dini`)
  ).toBe(2);
});

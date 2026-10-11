import { createTestDb, TestDb } from './testDb';
import { runMigrations } from '@/database/db';

/**
 * MIGRASI v50 -> v51 — SIMPANAN BERJANGKA.
 *
 * Yang dibuktikan test ini:
 *   1) tabel `simpanan_berjangka` beserta indeksnya dibuat untuk
 *      instalasi lama;
 *   2) mapping COA `SIMPANAN_BERJANGKA -> KREDIT_DEFAULT -> 2-1210`
 *      dibuat lewat self-heal COA, tanpa duplikat;
 *   3) akun 2-1210 yang sudah ada dari v50 DIPERTAHANKAN (id-nya tidak
 *      berubah), sehingga saldo/jurnal historis tetap menunjuk akun
 *      yang sama;
 *   4) DATA SIMPANAN & JURNAL EXISTING (POKOK/WAJIB/SUKARELA) TIDAK
 *      berubah sedikit pun — migrasi ini murni aditif;
 *   5) idempoten: dijalankan dua kali tidak menduplikasi apa pun;
 *   6) integritas database tetap bersih setelah migrasi.
 */

let testDb: TestDb;

async function siapkanInstalasiV50(db: TestDb) {
  const now = '2026-01-01T00:00:00.000Z';

  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`
  );
  await db.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 50)`);

  // Instalasi v50 belum punya tabel simpanan berjangka.
  await db.execAsync(`DROP TABLE IF EXISTS simpanan_berjangka;`);
  // ...dan belum punya mapping-nya.
  await db.runAsync(`DELETE FROM account_mapping WHERE transaction_type = 'SIMPANAN_BERJANGKA'`);

  // Akun 2-1210 SUDAH ada sejak v50 — dibiarkan supaya bisa dibuktikan
  // tidak dibuat ulang / tidak berganti id.
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES ('acc-2-1210','2-1210','Simpanan Anggota (Berjangka)','LIABILITAS','KREDIT',1,0,?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES ('acc-kas','1-1000','Kas','ASET','DEBIT',1,1,?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES ('acc-sukarela','2-1200','Simpanan Sukarela Anggota','LIABILITAS','KREDIT',1,1,?,?)`,
    now,
    now
  );

  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('anggota-lama','A001','1234567890123456','Budi','2020-01-01','AKTIF',?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );

  // Data simpanan SUKARELA historis + jurnalnya.
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('j-lama','JRN-1','2026-02-01','p2026','SIMPANAN_SUKARELA','setoran lama','POSTED','user-1',?,?,?)`,
    now,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('je-1','j-lama','acc-kas',2000000,0,0)`
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('je-2','j-lama','acc-sukarela',0,2000000,1)`
  );
  await db.runAsync(
    `INSERT INTO simpanan_transaksi
      (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, journal_id, created_by, created_at)
     VALUES ('sp-lama','anggota-lama','SUKARELA','SETOR','2026-02-01',2000000,'KAS','SP-2026-000001','j-lama','user-1',?)`,
    now
  );
}

async function potretDataExisting(db: TestDb) {
  return {
    simpanan: await db.getAllAsync(`SELECT * FROM simpanan_transaksi ORDER BY id`),
    journal: await db.getAllAsync(`SELECT * FROM journal ORDER BY id`),
    journalEntry: await db.getAllAsync(`SELECT * FROM journal_entry ORDER BY id`),
    akun2_1210: await db.getFirstAsync(`SELECT * FROM account WHERE kode = '2-1210'`),
  };
}

beforeEach(async () => {
  testDb = await createTestDb();
  await siapkanInstalasiV50(testDb);
});

test('tabel simpanan_berjangka dibuat beserta indeksnya', async () => {
  const sebelum = await testDb.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='simpanan_berjangka'`
  );
  expect(sebelum).toBeNull();

  await runMigrations(testDb as any);

  const sesudah = await testDb.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='simpanan_berjangka'`
  );
  expect(sesudah?.name).toBe('simpanan_berjangka');

  const indeks = await testDb.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='simpanan_berjangka'`
  );
  const namaIndeks = indeks.map((i) => i.name);
  expect(namaIndeks).toEqual(
    expect.arrayContaining([
      'idx_simpanan_berjangka_anggota',
      'idx_simpanan_berjangka_jatuh_tempo',
      'idx_simpanan_berjangka_tanggal',
      'idx_simpanan_berjangka_idempotency',
    ])
  );
});

test('mapping SIMPANAN_BERJANGKA -> 2-1210 dibuat, tanpa duplikat', async () => {
  await runMigrations(testDb as any);

  const mapping = await testDb.getAllAsync<{ account_id: string; role: string }>(
    `SELECT account_id, role FROM account_mapping WHERE transaction_type = 'SIMPANAN_BERJANGKA'`
  );
  expect(mapping).toHaveLength(1);
  expect(mapping[0].role).toBe('KREDIT_DEFAULT');
  expect(mapping[0].account_id).toBe('acc-2-1210');
});

test('akun 2-1210 existing DIPERTAHANKAN — id tidak berubah, tidak dibuat ulang', async () => {
  await runMigrations(testDb as any);

  const akun = await testDb.getAllAsync<{ id: string; kategori: string; normal_balance: string }>(
    `SELECT id, kategori, normal_balance FROM account WHERE kode = '2-1210'`
  );
  expect(akun).toHaveLength(1);
  expect(akun[0].id).toBe('acc-2-1210');
  expect(akun[0].kategori).toBe('LIABILITAS');
  expect(akun[0].normal_balance).toBe('KREDIT');
});

test('§28 data simpanan & jurnal EXISTING tidak berubah sama sekali', async () => {
  const sebelum = await potretDataExisting(testDb);
  await runMigrations(testDb as any);
  const sesudah = await potretDataExisting(testDb);

  expect(sesudah.simpanan).toEqual(sebelum.simpanan);
  expect(sesudah.journal).toEqual(sebelum.journal);
  expect(sesudah.journalEntry).toEqual(sebelum.journalEntry);
  expect(sesudah.akun2_1210).toEqual(sebelum.akun2_1210);
});

test('CHECK jenis pada simpanan_transaksi TIDAK diubah — BERJANGKA tetap ditolak di tabel lama', async () => {
  await runMigrations(testDb as any);
  await expect(
    testDb.runAsync(
      `INSERT INTO simpanan_transaksi
        (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES ('sp-x','anggota-lama','BERJANGKA','SETOR','2026-03-01',1000,'KAS','SP-X','user-1','2026-03-01')`
    )
  ).rejects.toThrow();
});

test('idempoten: migrasi dijalankan dua kali tidak menduplikasi apa pun', async () => {
  await runMigrations(testDb as any);
  await testDb.runAsync(`UPDATE schema_meta SET version = 50`);
  await runMigrations(testDb as any);

  const mapping = await testDb.getAllAsync(
    `SELECT id FROM account_mapping WHERE transaction_type = 'SIMPANAN_BERJANGKA'`
  );
  expect(mapping).toHaveLength(1);

  const akun = await testDb.getAllAsync(`SELECT id FROM account WHERE kode = '2-1210'`);
  expect(akun).toHaveLength(1);
});

test('§43 integritas database bersih setelah migrasi', async () => {
  await runMigrations(testDb as any);

  const integrity = await testDb.getAllAsync<{ integrity_check: string }>(`PRAGMA integrity_check`);
  expect(integrity[0].integrity_check).toBe('ok');

  const fk = await testDb.getAllAsync(`PRAGMA foreign_key_check`);
  expect(fk).toHaveLength(0);
});

test('CHECK tenor & suku bunga ditegakkan di level database', async () => {
  await runMigrations(testDb as any);
  const kolom = `(id, anggota_id, nomor_transaksi, tanggal_mulai, tanggal_jatuh_tempo, nominal,
     tenor_bulan, suku_bunga, status, sumber_dana, created_by, created_at, updated_at)`;

  // tenor 9 bulan ditolak
  await expect(
    testDb.runAsync(
      `INSERT INTO simpanan_berjangka ${kolom}
       VALUES ('x1','anggota-lama','SPB-X1','2026-01-01','2026-10-01',1000,9,0,'AKTIF','KAS','user-1','x','x')`
    )
  ).rejects.toThrow();

  // suku bunga negatif ditolak
  await expect(
    testDb.runAsync(
      `INSERT INTO simpanan_berjangka ${kolom}
       VALUES ('x2','anggota-lama','SPB-X2','2026-01-01','2026-04-01',1000,3,-1,'AKTIF','KAS','user-1','x','x')`
    )
  ).rejects.toThrow();

  // status di luar daftar ditolak
  await expect(
    testDb.runAsync(
      `INSERT INTO simpanan_berjangka ${kolom}
       VALUES ('x3','anggota-lama','SPB-X3','2026-01-01','2026-04-01',1000,3,0,'LUNAS','KAS','user-1','x','x')`
    )
  ).rejects.toThrow();
});

import { createTestDb, TestDb } from './testDb';
import { runMigrations } from '@/database/db';

/**
 * MIGRASI v51 -> v52 — LIFECYCLE BUNGA & PENCAIRAN SIMPANAN BERJANGKA.
 *
 * Yang dibuktikan:
 *   1) kolom turunan bunga/pencairan ditambahkan ke `simpanan_berjangka`;
 *   2) tabel event `simpanan_berjangka_bunga` + indeks uniknya dibuat;
 *   3) akun 2-1710 / 5-1955 dan mapping akrual & pencairan dibuat lewat
 *      self-heal COA, tanpa duplikat;
 *   4) §46 kontrak v51 yang sudah ada TETAP VALID: pokok, rate, tenor,
 *      jatuh tempo, dan status tidak berubah, bunga terakru mulai dari 0;
 *   5) §46 TIDAK ADA bunga retroaktif yang dijurnal oleh migrasi —
 *      jumlah jurnal & journal_entry sebelum dan sesudah IDENTIK;
 *   6) idempoten: dijalankan dua kali tidak menduplikasi apa pun;
 *   7) integritas database tetap bersih.
 */

let testDb: TestDb;

const NOW = '2026-01-01T00:00:00.000Z';

async function siapkanInstalasiV51(db: TestDb) {
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`
  );
  await db.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 51)`);

  // Instalasi v51: tabel event bunga belum ada, mapping bunga belum ada.
  await db.execAsync(`DROP TABLE IF EXISTS simpanan_berjangka_bunga;`);
  await db.runAsync(
    `DELETE FROM account_mapping WHERE transaction_type IN ('SIMPANAN_BERJANGKA_BUNGA_AKRUAL','SIMPANAN_BERJANGKA_PENCAIRAN')`
  );

  // Rekonstruksi tabel simpanan_berjangka BENTUK v51 (tanpa kolom
  // bunga/pencairan) supaya `tambahKolomJikaBelumAda` benar-benar diuji.
  await db.execAsync(`
    DROP TABLE IF EXISTS simpanan_berjangka;
    CREATE TABLE simpanan_berjangka (
      id TEXT PRIMARY KEY,
      anggota_id TEXT NOT NULL REFERENCES anggota(id),
      nomor_transaksi TEXT NOT NULL UNIQUE,
      tanggal_mulai TEXT NOT NULL,
      tanggal_jatuh_tempo TEXT NOT NULL,
      nominal INTEGER NOT NULL,
      tenor_bulan INTEGER NOT NULL CHECK (tenor_bulan IN (3, 6, 12)),
      suku_bunga REAL NOT NULL DEFAULT 0 CHECK (suku_bunga >= 0),
      status TEXT NOT NULL CHECK (status IN ('AKTIF','JATUH_TEMPO','DICAIRKAN','DIBATALKAN')),
      sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
      bank_account_id TEXT REFERENCES bank_account(id),
      keterangan TEXT,
      journal_id TEXT REFERENCES journal(id),
      idempotency_key TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES ('acc-kas','1-1000','Kas','ASET','DEBIT',1,1,?,?)`,
    NOW,
    NOW
  );
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES ('acc-2-1210','2-1210','Simpanan Anggota (Berjangka)','LIABILITAS','KREDIT',1,0,?,?)`,
    NOW,
    NOW
  );
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('anggota-lama','A001','1234567890123456','Budi','2020-01-01','AKTIF',?,?)`,
    NOW,
    NOW
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );

  // Kontrak v51 + jurnal penempatannya.
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('j-setor','JRN-1','2026-01-05','p2026','SIMPANAN_BERJANGKA','setoran','POSTED','user-1',?,?,?)`,
    NOW,
    NOW,
    NOW
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('je-1','j-setor','acc-kas',10000000,0,0)`
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('je-2','j-setor','acc-2-1210',0,10000000,1)`
  );
  await db.runAsync(
    `INSERT INTO simpanan_berjangka
      (id, anggota_id, nomor_transaksi, tanggal_mulai, tanggal_jatuh_tempo, nominal, tenor_bulan,
       suku_bunga, status, sumber_dana, journal_id, created_by, created_at, updated_at)
     VALUES ('kontrak-lama','anggota-lama','SPB-2026-000001','2026-01-05','2027-01-05',10000000,12,
             12,'AKTIF','KAS','j-setor','user-1',?,?)`,
    NOW,
    NOW
  );
}

async function kolomTabel(db: TestDb, tabel: string): Promise<string[]> {
  const rows = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${tabel})`);
  return rows.map((r) => r.name);
}

beforeEach(async () => {
  testDb = await createTestDb();
  await siapkanInstalasiV51(testDb);
});

test('kolom bunga & pencairan ditambahkan ke simpanan_berjangka', async () => {
  const sebelum = await kolomTabel(testDb, 'simpanan_berjangka');
  expect(sebelum).not.toContain('bunga_terakru');

  await runMigrations(testDb as any);

  const sesudah = await kolomTabel(testDb, 'simpanan_berjangka');
  expect(sesudah).toEqual(
    expect.arrayContaining([
      'bunga_terakru',
      'bunga_dibayar',
      'tanggal_pencairan',
      'journal_pencairan_id',
      'idempotency_key_pencairan',
    ])
  );
});

test('tabel event simpanan_berjangka_bunga + indeks unik periode dibuat', async () => {
  await runMigrations(testDb as any);

  const tabel = await testDb.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='simpanan_berjangka_bunga'`
  );
  expect(tabel?.name).toBe('simpanan_berjangka_bunga');

  const indeks = await testDb.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='simpanan_berjangka_bunga'`
  );
  expect(indeks.map((i) => i.name)).toEqual(
    expect.arrayContaining(['idx_sb_bunga_periode', 'idx_sb_bunga_kontrak'])
  );
});

test('indeks unik periode benar-benar mencegah akrual ganda di level database', async () => {
  await runMigrations(testDb as any);
  const kolom = `(id, simpanan_berjangka_id, nomor_periode, tanggal_akhir_periode, bunga, created_by, created_at)`;

  await testDb.runAsync(
    `INSERT INTO simpanan_berjangka_bunga ${kolom}
     VALUES ('b1','kontrak-lama',1,'2026-02-05',100000,'user-1','x')`
  );
  await expect(
    testDb.runAsync(
      `INSERT INTO simpanan_berjangka_bunga ${kolom}
       VALUES ('b2','kontrak-lama',1,'2026-02-05',100000,'user-1','x')`
    )
  ).rejects.toThrow();
});

test('akun & mapping bunga/pencairan dibuat lewat self-heal, tanpa duplikat', async () => {
  await runMigrations(testDb as any);

  for (const kode of ['2-1710', '5-1955']) {
    const akun = await testDb.getAllAsync<{ id: string; kategori: string }>(
      `SELECT id, kategori FROM account WHERE kode = ?`,
      kode
    );
    expect(akun).toHaveLength(1);
  }
  expect(
    (await testDb.getFirstAsync<{ kategori: string }>(`SELECT kategori FROM account WHERE kode='2-1710'`))
      ?.kategori
  ).toBe('LIABILITAS');
  expect(
    (await testDb.getFirstAsync<{ kategori: string }>(`SELECT kategori FROM account WHERE kode='5-1955'`))
      ?.kategori
  ).toBe('BEBAN');

  for (const tipe of ['SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'SIMPANAN_BERJANGKA_PENCAIRAN']) {
    const mapping = await testDb.getAllAsync(
      `SELECT id FROM account_mapping WHERE transaction_type = ?`,
      tipe
    );
    expect(mapping.length).toBeGreaterThan(0);
  }
});

test('§46 kontrak v51 tetap valid; bunga mulai dari 0, bukan dikarang', async () => {
  await runMigrations(testDb as any);

  const k = await testDb.getFirstAsync<any>(
    `SELECT * FROM simpanan_berjangka WHERE id = 'kontrak-lama'`
  );
  expect(k.nominal).toBe(10000000);
  expect(k.suku_bunga).toBe(12);
  expect(k.tenor_bulan).toBe(12);
  expect(k.tanggal_jatuh_tempo).toBe('2027-01-05');
  expect(k.status).toBe('AKTIF');
  // Migrasi TIDAK mengarang bunga historis.
  expect(k.bunga_terakru).toBe(0);
  expect(k.bunga_dibayar).toBe(0);
  expect(k.tanggal_pencairan).toBeNull();
});

test('§46 TIDAK ADA jurnal bunga retroaktif yang dibuat migrasi', async () => {
  const jurnalSebelum = await testDb.getAllAsync(`SELECT * FROM journal ORDER BY id`);
  const barisSebelum = await testDb.getAllAsync(`SELECT * FROM journal_entry ORDER BY id`);

  await runMigrations(testDb as any);

  expect(await testDb.getAllAsync(`SELECT * FROM journal ORDER BY id`)).toEqual(jurnalSebelum);
  expect(await testDb.getAllAsync(`SELECT * FROM journal_entry ORDER BY id`)).toEqual(barisSebelum);
  expect(await testDb.getAllAsync(`SELECT id FROM simpanan_berjangka_bunga`)).toHaveLength(0);
});

test('idempoten: dijalankan dua kali tidak menduplikasi apa pun', async () => {
  await runMigrations(testDb as any);
  await testDb.runAsync(`UPDATE schema_meta SET version = 51`);
  await runMigrations(testDb as any);

  expect(await testDb.getAllAsync(`SELECT id FROM account WHERE kode='2-1710'`)).toHaveLength(1);
  expect(await testDb.getAllAsync(`SELECT id FROM account WHERE kode='5-1955'`)).toHaveLength(1);
  // Pencairan memang punya DUA role (DEBIT_POKOK -> 2-1210 dan
  // DEBIT_UTANG_BUNGA -> 2-1710); yang diuji adalah tidak ada role yang
  // TERDUPLIKASI setelah migrasi dijalankan dua kali.
  const mappingPencairan = await testDb.getAllAsync<{ role: string }>(
    `SELECT role FROM account_mapping WHERE transaction_type = 'SIMPANAN_BERJANGKA_PENCAIRAN' ORDER BY role`
  );
  expect(mappingPencairan.map((m) => m.role)).toEqual(['DEBIT_POKOK', 'DEBIT_UTANG_BUNGA']);

  const mappingAkrual = await testDb.getAllAsync<{ role: string }>(
    `SELECT role FROM account_mapping WHERE transaction_type = 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL' ORDER BY role`
  );
  expect(mappingAkrual.map((m) => m.role)).toEqual(['DEBIT_BEBAN', 'KREDIT_UTANG_BUNGA']);
  // Kolom tidak digandakan (ALTER TABLE kedua akan gagal bila tidak idempoten).
  const kolom = await kolomTabel(testDb, 'simpanan_berjangka');
  expect(kolom.filter((c) => c === 'bunga_terakru')).toHaveLength(1);
});

test('§54 integritas database bersih setelah migrasi', async () => {
  await runMigrations(testDb as any);

  const integrity = await testDb.getAllAsync<{ integrity_check: string }>(`PRAGMA integrity_check`);
  expect(integrity[0].integrity_check).toBe('ok');
  expect(await testDb.getAllAsync(`PRAGMA foreign_key_check`)).toHaveLength(0);
});

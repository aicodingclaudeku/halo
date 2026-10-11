import { createTestDb, TestDb } from './testDb';
import { runMigrations } from '@/database/db';
import { SCHEMA_VERSION } from '@/database/schema';

/**
 * ============================================================
 * MIGRASI v53 -> v54 — bank_transaksi.tipe MENERIMA 'KOREKSI' (S20/P1)
 * ============================================================
 *
 * Yang dibuktikan (§E/§F master command S20):
 *   1) CHECK `bank_transaksi.tipe` memuat 'KOREKSI' setelah migrasi,
 *      dan HANYA tabel itu yang diubah (kas_transaksi tidak disentuh,
 *      tidak ada tabel lain yang ikut menerima 'KOREKSI');
 *   2) rebuild tidak mengubah journal / journal_entry / nominal
 *      historis, tidak menghapus transaksi, tidak membuat orphan;
 *   3) kolom `arah_transfer` dari v53 IKUT TERBAWA (regresi S19 tidak
 *      boleh hilang gara-gara rebuild);
 *   4) indeks `idx_bank_tanggal` & `idx_bank_idempotency` (UNIQUE)
 *      dibuat ulang — kalau tidak, guard idempotensi bank diam-diam
 *      berhenti bekerja setelah upgrade;
 *   5) integrity_check `ok`, foreign_key_check kosong;
 *   6) idempoten (dijalankan 2x menghasilkan keadaan identik);
 *   7) aman pada database tanpa transaksi bank, database kas-saja, dan
 *      database yang belum punya tabel bank_transaksi sama sekali.
 */

let testDb: TestDb;
const NOW = '2026-01-01T00:00:00.000Z';

/** Bentuk skema v53: SEMUA kolom v53, TAPI CHECK tipe tanpa 'KOREKSI'. */
async function siapkanInstalasiV53(db: TestDb, opsi: { tanpaTabelBank?: boolean } = {}) {
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`
  );
  await db.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 53)`);

  // Data referensi minimal (akun, rekening, periode) — dipakai semua
  // test, termasuk yang tidak menyeed transaksi.
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES ('acc-bank','1-1100','Bank','ASET','DEBIT',1,1,?,?)`,
    NOW, NOW
  );
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES ('acc-lain','4-2000','Pendapatan Lain','PENDAPATAN','KREDIT',1,1,?,?)`,
    NOW, NOW
  );
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, saldo_awal, aktif, created_at)
     VALUES ('bank-1','Bank Uji','111','Koperasi','acc-bank',0,1,?)`,
    NOW
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );

  await db.execAsync(`DROP TABLE IF EXISTS bank_transaksi;`);
  if (opsi.tanpaTabelBank) return;

  await db.execAsync(`
    CREATE TABLE bank_transaksi (
      id TEXT PRIMARY KEY,
      bank_account_id TEXT NOT NULL REFERENCES bank_account(id),
      tipe TEXT NOT NULL CHECK (tipe IN ('PENERIMAAN','PENGELUARAN','TRANSFER')),
      arah_transfer TEXT CHECK (arah_transfer IS NULL OR arah_transfer IN ('MASUK','KELUAR')),
      tanggal TEXT NOT NULL,
      nominal INTEGER NOT NULL,
      akun_lawan_id TEXT REFERENCES account(id),
      kategori TEXT,
      keterangan TEXT,
      nomor_transaksi TEXT NOT NULL UNIQUE,
      journal_id TEXT REFERENCES journal(id),
      reversal_of_id TEXT REFERENCES bank_transaksi(id),
      idempotency_key TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bank_tanggal ON bank_transaksi(tanggal);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_idempotency ON bank_transaksi(idempotency_key) WHERE idempotency_key IS NOT NULL;
  `);
}

/** Data historis: akun, rekening, jurnal, dan baris subledger bank. */
async function seedHistoris(db: TestDb) {
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
     VALUES ('j-1','JU-2026-000001','2026-03-31','p2026','BANK_PENERIMAAN_LAIN','pemasukan','POSTED','user-1',?,?)`,
    NOW, NOW
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('je-1','j-1','acc-bank',5000000,0,0)`
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('je-2','j-1','acc-lain',0,5000000,1)`
  );
  // Tiga baris: PENERIMAAN biasa, TRANSFER dengan arah (regresi v53),
  // dan satu baris ber-idempotency_key (regresi indeks UNIQUE).
  await db.runAsync(
    `INSERT INTO bank_transaksi (id, bank_account_id, tipe, arah_transfer, tanggal, nominal, akun_lawan_id, nomor_transaksi, journal_id, idempotency_key, created_by, created_at)
     VALUES ('bt-1','bank-1','PENERIMAAN',NULL,'2026-03-31',5000000,'acc-lain','BANK_PENERIMAAN_LAIN-2026-000001','j-1','idem-abc','user-1',?)`,
    NOW
  );
  await db.runAsync(
    `INSERT INTO bank_transaksi (id, bank_account_id, tipe, arah_transfer, tanggal, nominal, akun_lawan_id, nomor_transaksi, journal_id, created_by, created_at)
     VALUES ('bt-2','bank-1','TRANSFER','MASUK','2026-04-01',2000000,'acc-bank','TRANSFER_MASUK-2026-000001','j-1','user-1',?)`,
    NOW
  );
  await db.runAsync(
    `INSERT INTO bank_transaksi (id, bank_account_id, tipe, arah_transfer, tanggal, nominal, akun_lawan_id, nomor_transaksi, journal_id, reversal_of_id, created_by, created_at)
     VALUES ('bt-3','bank-1','PENGELUARAN',NULL,'2026-04-02',750000,'acc-lain','BANK_PENGELUARAN_LAIN-2026-000001','j-1','bt-1','user-1',?)`,
    NOW
  );
}

async function angka(db: TestDb, sql: string, ...p: any[]): Promise<number> {
  return (await db.getFirstAsync<{ n: number }>(sql, ...p))!.n;
}

async function snapshot(db: TestDb) {
  return {
    journal: await angka(db, `SELECT COUNT(*) as n FROM journal`),
    journalEntry: await angka(db, `SELECT COUNT(*) as n FROM journal_entry`),
    debit: await angka(db, `SELECT COALESCE(SUM(debit),0) as n FROM journal_entry`),
    kredit: await angka(db, `SELECT COALESCE(SUM(kredit),0) as n FROM journal_entry`),
    bankRows: await angka(db, `SELECT COUNT(*) as n FROM bank_transaksi`),
    bankNominal: await angka(db, `SELECT COALESCE(SUM(nominal),0) as n FROM bank_transaksi`),
    kasRows: await angka(db, `SELECT COUNT(*) as n FROM kas_transaksi`),
  };
}

async function ddl(db: TestDb, tabel: string): Promise<string> {
  return (await db.getFirstAsync<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`, tabel
  ))!.sql;
}

async function indeks(db: TestDb, tabel: string): Promise<string[]> {
  return (await db.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`, tabel
  )).map((r) => r.name);
}

beforeEach(async () => {
  testDb = await createTestDb();
  await siapkanInstalasiV53(testDb);
});

test('§E CHECK bank_transaksi.tipe memuat KOREKSI setelah migrasi; versi naik ke versi aplikasi', async () => {
  expect(await ddl(testDb, 'bank_transaksi')).not.toContain("'KOREKSI'");

  await runMigrations(testDb as any);

  expect(await ddl(testDb, 'bank_transaksi')).toContain("'KOREKSI'");
  // Literal 54 diganti SCHEMA_VERSION pada S21 (versi aplikasi naik ke
  // 55 untuk tabel penarikan dini). Maksud assertion tidak berubah:
  // rantai migrasi berjalan tuntas sampai versi aplikasi terkini.
  expect(await angka(testDb, `SELECT version as n FROM schema_meta`)).toBe(SCHEMA_VERSION);

  // Nilai KOREKSI benar-benar bisa ditulis sekarang (bukti runtime,
  // bukan sekadar teks DDL).
  await testDb.runAsync(
    `INSERT INTO bank_transaksi (id, bank_account_id, tipe, tanggal, nominal, nomor_transaksi, created_by, created_at)
     VALUES ('bt-koreksi','bank-1','KOREKSI','2026-05-01',1,'KOREKSI-UJI','user-1',?)`,
    NOW
  );
  expect(await angka(testDb, `SELECT COUNT(*) as n FROM bank_transaksi WHERE tipe='KOREKSI'`)).toBe(1);
});

test('§E KOREKSI TIDAK ditambahkan ke tabel yang tidak memerlukannya', async () => {
  await runMigrations(testDb as any);

  // kas_transaksi memang sudah punya KOREKSI sejak sebelum S20 —
  // dipastikan tidak berubah, bukan ditambah lagi.
  expect(await ddl(testDb, 'kas_transaksi')).toContain("'KOREKSI'");

  // Tabel lain yang punya CHECK `tipe` TIDAK boleh ikut kena.
  const kandidat = await testDb.getAllAsync<{ name: string; sql: string }>(
    `SELECT name, sql FROM sqlite_master
      WHERE type='table' AND sql LIKE '%tipe TEXT NOT NULL CHECK%'
        AND name NOT IN ('kas_transaksi','bank_transaksi','simpanan_transaksi')`
  );
  for (const t of kandidat) {
    expect(t.sql).not.toContain("'KOREKSI'");
  }
});

test('§F migrasi tidak mengubah jurnal, nominal, atau jumlah baris historis', async () => {
  await seedHistoris(testDb);
  const sebelum = await snapshot(testDb);

  await runMigrations(testDb as any);

  const sesudah = await snapshot(testDb);
  expect(sesudah.journal).toBe(sebelum.journal);
  expect(sesudah.journalEntry).toBe(sebelum.journalEntry);
  expect(sesudah.debit).toBe(sebelum.debit);
  expect(sesudah.kredit).toBe(sebelum.kredit);
  expect(sesudah.debit).toBe(sesudah.kredit);
  expect(sesudah.bankRows).toBe(sebelum.bankRows);
  expect(sesudah.bankNominal).toBe(sebelum.bankNominal);

  // Isi per baris identik apa adanya — termasuk reversal_of_id.
  const baris = await testDb.getAllAsync<any>(
    `SELECT id, tipe, arah_transfer, tanggal, nominal, nomor_transaksi, journal_id, reversal_of_id, idempotency_key
       FROM bank_transaksi ORDER BY id`
  );
  expect(baris.map((b) => b.id)).toEqual(['bt-1', 'bt-2', 'bt-3']);
  expect(baris[0].idempotency_key).toBe('idem-abc');
  expect(baris[1].nominal).toBe(2000000);
  expect(baris[2].reversal_of_id).toBe('bt-1');
});

test('§F regresi S19: kolom & nilai arah_transfer ikut terbawa rebuild', async () => {
  await seedHistoris(testDb);
  await runMigrations(testDb as any);

  const kolom = (await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(bank_transaksi)`)).map((r) => r.name);
  expect(kolom).toContain('arah_transfer');

  const tf = await testDb.getFirstAsync<{ arah_transfer: string | null }>(
    `SELECT arah_transfer FROM bank_transaksi WHERE id='bt-2'`
  );
  expect(tf!.arah_transfer).toBe('MASUK');

  // CHECK arah_transfer juga harus ikut, bukan cuma kolomnya.
  await expect(
    testDb.runAsync(
      `INSERT INTO bank_transaksi (id, bank_account_id, tipe, arah_transfer, tanggal, nominal, nomor_transaksi, created_by, created_at)
       VALUES ('bt-x','bank-1','TRANSFER','NAIK','2026-05-01',1,'X-1','user-1',?)`,
      NOW
    )
  ).rejects.toThrow(/CHECK constraint/);
});

test('§F indeks dibuat ulang setelah rebuild — termasuk UNIQUE idempotency', async () => {
  await seedHistoris(testDb);
  const sebelum = await indeks(testDb, 'bank_transaksi');
  await runMigrations(testDb as any);
  const sesudah = await indeks(testDb, 'bank_transaksi');

  expect(sesudah).toContain('idx_bank_tanggal');
  expect(sesudah).toContain('idx_bank_idempotency');
  expect(sesudah).toEqual(sebelum);

  // UNIQUE-nya benar-benar aktif, bukan cuma ada namanya.
  await expect(
    testDb.runAsync(
      `INSERT INTO bank_transaksi (id, bank_account_id, tipe, tanggal, nominal, nomor_transaksi, idempotency_key, created_by, created_at)
       VALUES ('bt-dup','bank-1','PENERIMAAN','2026-05-01',1,'DUP-1','idem-abc','user-1',?)`,
      NOW
    )
  ).rejects.toThrow(/UNIQUE/);
});

test('§F integrity_check ok, foreign_key_check kosong, tanpa orphan', async () => {
  await seedHistoris(testDb);
  await runMigrations(testDb as any);

  const integrity = await testDb.getAllAsync<{ integrity_check: string }>(`PRAGMA integrity_check`);
  expect(integrity.map((r) => r.integrity_check)).toEqual(['ok']);

  const fk = await testDb.getAllAsync(`PRAGMA foreign_key_check`);
  expect(fk).toEqual([]);

  expect(
    await angka(testDb, `SELECT COUNT(*) as n FROM bank_transaksi bt
                          LEFT JOIN bank_account ba ON ba.id = bt.bank_account_id
                         WHERE ba.id IS NULL`)
  ).toBe(0);
  expect(
    await angka(testDb, `SELECT COUNT(*) as n FROM bank_transaksi bt
                         WHERE bt.journal_id IS NOT NULL
                           AND bt.journal_id NOT IN (SELECT id FROM journal)`)
  ).toBe(0);
});

test('§F idempoten: migrasi kedua tidak mengubah apa pun', async () => {
  await seedHistoris(testDb);
  await runMigrations(testDb as any);
  const pertama = await snapshot(testDb);
  const ddlPertama = await ddl(testDb, 'bank_transaksi');
  const idxPertama = await indeks(testDb, 'bank_transaksi');

  await runMigrations(testDb as any);

  expect(await snapshot(testDb)).toEqual(pertama);
  expect(await ddl(testDb, 'bank_transaksi')).toBe(ddlPertama);
  expect(await indeks(testDb, 'bank_transaksi')).toEqual(idxPertama);
  expect(await angka(testDb, `SELECT COUNT(*) as n FROM sqlite_master WHERE name='bank_transaksi_new'`)).toBe(0);
});

test('§F database tanpa transaksi bank sama sekali: migrasi tetap jalan', async () => {
  await runMigrations(testDb as any);
  expect(await ddl(testDb, 'bank_transaksi')).toContain("'KOREKSI'");
  expect(await angka(testDb, `SELECT COUNT(*) as n FROM bank_transaksi`)).toBe(0);
  // Literal 54 -> SCHEMA_VERSION (S21). Lihat catatan di §E.
  expect(await angka(testDb, `SELECT version as n FROM schema_meta`)).toBe(SCHEMA_VERSION);
});

test('§F database kas-saja (ada baris kas, bank kosong) tidak terpengaruh', async () => {
  await testDb.runAsync(
    `INSERT INTO kas_transaksi (id, jenis_kas, tipe, tanggal, nominal, nomor_transaksi, created_by, created_at)
     VALUES ('kt-1','KAS','PENERIMAAN','2026-03-31',1000000,'KAS-1','user-1',?)`,
    NOW
  );

  await runMigrations(testDb as any);

  expect(await angka(testDb, `SELECT COUNT(*) as n FROM kas_transaksi`)).toBe(1);
  expect(await angka(testDb, `SELECT nominal as n FROM kas_transaksi WHERE id='kt-1'`)).toBe(1000000);
  expect(await ddl(testDb, 'bank_transaksi')).toContain("'KOREKSI'");
});

test('§F instalasi sangat lama tanpa tabel bank_transaksi: rantai migrasi tidak gagal', async () => {
  testDb = await createTestDb();
  await siapkanInstalasiV53(testDb, { tanpaTabelBank: true });

  await runMigrations(testDb as any);

  // Guard `if (!tabelAda) return;` membuat rebuild DILEWATI, bukan
  // menggagalkan seluruh rantai migrasi — pola yang sama dengan guard
  // tabel absen pada backfill v53.
  // Literal 54 -> SCHEMA_VERSION (S21). Lihat catatan di §E.
  expect(await angka(testDb, `SELECT version as n FROM schema_meta`)).toBe(SCHEMA_VERSION);

  // CATATAN JUJUR: self-heal skema (`pastikanIntegritasSchemaWajib`)
  // saat ini HANYA memulihkan `pinjaman_akuntansi_jasa`, jadi
  // `bank_transaksi` yang hilang TETAP hilang setelah migrasi. Itu
  // perilaku yang sudah ada sejak sebelum S20 dan TIDAK diubah di sini
  // (di luar lingkup perintah). Yang diuji: migrasi v54 tidak
  // memperburuknya dan tidak melempar.
  const masihHilang = await testDb.getFirstAsync<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='bank_transaksi'`
  );
  expect(masihHilang).toBeNull();
});

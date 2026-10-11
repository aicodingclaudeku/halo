import { createTestDb, TestDb } from './testDb';
import { runMigrations } from '@/database/db';
import { SCHEMA_VERSION } from '@/database/schema';
import { jalankanRekonsiliasiLengkap } from '@/accounting/FullReconciliation';

/**
 * ============================================================
 * MIGRASI v52 -> v53 — ARAH TRANSFER DI SUBLEDGER (S19/P2)
 * ============================================================
 *
 * Yang dibuktikan:
 *   1) kolom `arah_transfer` ditambahkan ke kas_transaksi & bank_transaksi;
 *   2) baris TRANSFER lama di-backfill DETERMINISTIK dari
 *      `nomor_transaksi` (bukti yang memang sudah tersimpan di
 *      SUBLEDGER — bukan dari jurnal, supaya rekonsiliasi tetap
 *      non-sirkular);
 *   3) baris transfer yang arahnya TIDAK dapat direkonstruksi
 *      dibiarkan NULL dan DILAPORKAN, bukan ditebak;
 *   4) migrasi tidak menyentuh jurnal: jumlah journal/journal_entry,
 *      total debit/kredit, dan nominal subledger identik sebelum-sesudah;
 *   5) integritas & foreign key tetap bersih;
 *   6) idempoten.
 */

let testDb: TestDb;
const NOW = '2026-01-01T00:00:00.000Z';

async function siapkanInstalasiV52(db: TestDb) {
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`
  );
  await db.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 52)`);

  // Rekonstruksi kedua subledger dalam BENTUK v52 — tanpa kolom
  // `arah_transfer` — supaya migrasinya benar-benar diuji.
  await db.execAsync(`
    DROP TABLE IF EXISTS kas_transaksi;
    DROP TABLE IF EXISTS bank_transaksi;
    CREATE TABLE kas_transaksi (
      id TEXT PRIMARY KEY,
      jenis_kas TEXT NOT NULL CHECK (jenis_kas IN ('KAS','KAS_KECIL')),
      tipe TEXT NOT NULL CHECK (tipe IN ('PENERIMAAN','PENGELUARAN','TRANSFER','KOREKSI')),
      tanggal TEXT NOT NULL,
      nominal INTEGER NOT NULL,
      akun_lawan_id TEXT REFERENCES account(id),
      kategori TEXT,
      keterangan TEXT,
      nomor_transaksi TEXT NOT NULL UNIQUE,
      journal_id TEXT REFERENCES journal(id),
      reversal_of_id TEXT REFERENCES kas_transaksi(id),
      idempotency_key TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE bank_transaksi (
      id TEXT PRIMARY KEY,
      bank_account_id TEXT NOT NULL REFERENCES bank_account(id),
      tipe TEXT NOT NULL CHECK (tipe IN ('PENERIMAAN','PENGELUARAN','TRANSFER')),
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
  `);

  for (const [id, kode, nama, kategori, nb] of [
    ['acc-kas', '1-1000', 'Kas', 'ASET', 'DEBIT'],
    ['acc-bank', '1-1100', 'Bank BRI', 'ASET', 'DEBIT'],
    ['acc-pendapatan', '4-2000', 'Pendapatan Lain-lain', 'PENDAPATAN', 'KREDIT'],
  ]) {
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES (?,?,?,?,?,1,1,?,?)`,
      id, kode, nama, kategori, nb, NOW, NOW
    );
  }
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id)
     VALUES ('m-kas','KAS_UMUM','DEFAULT','acc-kas')`
  );
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, saldo_awal, aktif, created_at)
     VALUES ('bank-1','Bank BRI','123','Koperasi','acc-bank',0,1,?)`,
    NOW
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );

  // Jurnal transfer Kas -> Bank Rp20.000.000 (satu jurnal, dua baris subledger).
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('j-transfer','JRN-TF','2026-03-31','p2026','TRANSFER_BANK','transfer','POSTED','user-1',?,?,?)`,
    NOW, NOW, NOW
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('je-tf-1','j-transfer','acc-bank',20000000,0,0)`
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('je-tf-2','j-transfer','acc-kas',0,20000000,1)`
  );
  await db.runAsync(
    `INSERT INTO kas_transaksi (id, jenis_kas, tipe, tanggal, nominal, akun_lawan_id, nomor_transaksi, journal_id, created_by, created_at)
     VALUES ('kt-keluar','KAS','TRANSFER','2026-03-31',20000000,'acc-bank','TRANSFER_KELUAR-2026-000001','j-transfer','user-1',?)`,
    NOW
  );
  await db.runAsync(
    `INSERT INTO bank_transaksi (id, bank_account_id, tipe, tanggal, nominal, akun_lawan_id, nomor_transaksi, journal_id, created_by, created_at)
     VALUES ('bt-masuk','bank-1','TRANSFER','2026-03-31',20000000,'acc-kas','TRANSFER_MASUK-2026-000001','j-transfer','user-1',?)`,
    NOW
  );

  // Penerimaan kas biasa — kontrol: tidak boleh ikut terisi arah.
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('j-terima','JRN-TR','2026-02-01','p2026','KAS_PENERIMAAN_LAIN','terima','POSTED','user-1',?,?,?)`,
    NOW, NOW, NOW
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('je-tr-1','j-terima','acc-kas',5000000,0,0)`
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('je-tr-2','j-terima','acc-pendapatan',0,5000000,1)`
  );
  await db.runAsync(
    `INSERT INTO kas_transaksi (id, jenis_kas, tipe, tanggal, nominal, akun_lawan_id, nomor_transaksi, journal_id, created_by, created_at)
     VALUES ('kt-terima','KAS','PENERIMAAN','2026-02-01',5000000,'acc-pendapatan','KAS-2026-000001','j-terima','user-1',?)`,
    NOW
  );
}

/**
 * Baris transfer WARISAN yang nomor transaksinya TIDAK mengikuti pola
 * mana pun — mensimulasikan data dari versi aplikasi yang jauh lebih
 * lama atau hasil restore backup asing. Arahnya memang tidak dapat
 * dibuktikan dari data.
 */
async function tambahTransferTanpaJejakArah(db: TestDb) {
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('j-legacy','JRN-LG','2026-04-01','p2026','TRANSFER_BANK','transfer lama','POSTED','user-1',?,?,?)`,
    NOW, NOW, NOW
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('je-lg-1','j-legacy','acc-bank',1000000,0,0)`
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan)
     VALUES ('je-lg-2','j-legacy','acc-kas',0,1000000,1)`
  );
  await db.runAsync(
    `INSERT INTO kas_transaksi (id, jenis_kas, tipe, tanggal, nominal, akun_lawan_id, nomor_transaksi, journal_id, created_by, created_at)
     VALUES ('kt-legacy','KAS','TRANSFER','2026-04-01',1000000,'acc-bank','TF-LAMA-0001','j-legacy','user-1',?)`,
    NOW
  );
}

async function kolomTabel(db: TestDb, tabel: string): Promise<string[]> {
  return (await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${tabel})`)).map((r) => r.name);
}

async function angka(db: TestDb, sql: string): Promise<number> {
  return (await db.getFirstAsync<{ n: number }>(sql))!.n;
}

beforeEach(async () => {
  testDb = await createTestDb();
  await siapkanInstalasiV52(testDb);
});

test('kolom arah_transfer ditambahkan ke kedua subledger', async () => {
  expect(await kolomTabel(testDb, 'kas_transaksi')).not.toContain('arah_transfer');
  expect(await kolomTabel(testDb, 'bank_transaksi')).not.toContain('arah_transfer');

  await runMigrations(testDb as any);

  expect(await kolomTabel(testDb, 'kas_transaksi')).toContain('arah_transfer');
  expect(await kolomTabel(testDb, 'bank_transaksi')).toContain('arah_transfer');
  // Rantai migrasi selalu berjalan sampai versi APLIKASI terkini, jadi
  // yang diperiksa di sini adalah "migrasi v53 dilewati sampai tuntas",
  // bukan "berhenti di 53". Angka literalnya (54 pada S20) DIGANTI
  // dengan SCHEMA_VERSION pada S21 karena versi aplikasi naik ke 55:
  // yang dimaksud test ini sejak awal adalah "rantai migrasi tuntas
  // sampai versi aplikasi terkini", bukan angka 54 itu sendiri.
  // Assertion tetap kesamaan PERSIS — tidak dilonggarkan menjadi >=.
  expect(await angka(testDb, `SELECT version as n FROM schema_meta`)).toBe(SCHEMA_VERSION);
});

test('backfill deterministik dari nomor_transaksi — bukan dari jurnal', async () => {
  await runMigrations(testDb as any);

  const kas = await testDb.getFirstAsync<{ arah_transfer: string | null }>(
    `SELECT arah_transfer FROM kas_transaksi WHERE id = 'kt-keluar'`
  );
  const bank = await testDb.getFirstAsync<{ arah_transfer: string | null }>(
    `SELECT arah_transfer FROM bank_transaksi WHERE id = 'bt-masuk'`
  );
  expect(kas!.arah_transfer).toBe('KELUAR');
  expect(bank!.arah_transfer).toBe('MASUK');

  // Baris NON-transfer tidak ikut terisi.
  const terima = await testDb.getFirstAsync<{ arah_transfer: string | null }>(
    `SELECT arah_transfer FROM kas_transaksi WHERE id = 'kt-terima'`
  );
  expect(terima!.arah_transfer).toBeNull();
});

test('transfer warisan tanpa jejak arah dibiarkan NULL — arah TIDAK ditebak', async () => {
  await tambahTransferTanpaJejakArah(testDb);
  await runMigrations(testDb as any);

  const legacy = await testDb.getFirstAsync<{ arah_transfer: string | null }>(
    `SELECT arah_transfer FROM kas_transaksi WHERE id = 'kt-legacy'`
  );
  expect(legacy!.arah_transfer).toBeNull();
});

test('baris tanpa arah DILAPORKAN rekonsiliasi, bukan disamarkan menjadi nol', async () => {
  await tambahTransferTanpaJejakArah(testDb);
  await runMigrations(testDb as any);

  const rekon = await jalankanRekonsiliasiLengkap(testDb as any);
  const kas = rekon.baris.find((b) => b.domain === 'Cash')!;
  expect(kas.status).toBe('SELISIH');
  expect(kas.catatan).toMatch(/tidak punya arah/i);
  expect(kas.catatan).toMatch(/1 baris transfer/);
});

test('migrasi TIDAK menyentuh jurnal, nominal, maupun jumlah baris', async () => {
  const sebelum = {
    journal: await angka(testDb, `SELECT COUNT(*) n FROM journal`),
    entry: await angka(testDb, `SELECT COUNT(*) n FROM journal_entry`),
    debit: await angka(testDb, `SELECT COALESCE(SUM(debit),0) n FROM journal_entry`),
    kredit: await angka(testDb, `SELECT COALESCE(SUM(kredit),0) n FROM journal_entry`),
    kas: await angka(testDb, `SELECT COUNT(*) n FROM kas_transaksi`),
    bank: await angka(testDb, `SELECT COUNT(*) n FROM bank_transaksi`),
    nominalKas: await angka(testDb, `SELECT COALESCE(SUM(nominal),0) n FROM kas_transaksi`),
    nominalBank: await angka(testDb, `SELECT COALESCE(SUM(nominal),0) n FROM bank_transaksi`),
  };

  await runMigrations(testDb as any);

  const sesudah = {
    journal: await angka(testDb, `SELECT COUNT(*) n FROM journal`),
    entry: await angka(testDb, `SELECT COUNT(*) n FROM journal_entry`),
    debit: await angka(testDb, `SELECT COALESCE(SUM(debit),0) n FROM journal_entry`),
    kredit: await angka(testDb, `SELECT COALESCE(SUM(kredit),0) n FROM journal_entry`),
    kas: await angka(testDb, `SELECT COUNT(*) n FROM kas_transaksi`),
    bank: await angka(testDb, `SELECT COUNT(*) n FROM bank_transaksi`),
    nominalKas: await angka(testDb, `SELECT COALESCE(SUM(nominal),0) n FROM kas_transaksi`),
    nominalBank: await angka(testDb, `SELECT COALESCE(SUM(nominal),0) n FROM bank_transaksi`),
  };

  expect(sesudah).toEqual(sebelum);
  expect(sesudah.debit).toBe(sesudah.kredit);
});

test('integritas database & foreign key tetap bersih setelah migrasi', async () => {
  await runMigrations(testDb as any);
  const integrity = await testDb.getAllAsync<Record<string, string>>(`PRAGMA integrity_check`);
  expect(Object.values(integrity[0])[0]).toBe('ok');
  expect(await testDb.getAllAsync<unknown>(`PRAGMA foreign_key_check`)).toEqual([]);
});

test('idempoten — dijalankan dua kali tidak mengubah apa pun', async () => {
  await runMigrations(testDb as any);
  const snapshot = await testDb.getAllAsync<Record<string, unknown>>(
    `SELECT id, tipe, arah_transfer, nominal FROM kas_transaksi ORDER BY id`
  );
  await runMigrations(testDb as any);
  const ulang = await testDb.getAllAsync<Record<string, unknown>>(
    `SELECT id, tipe, arah_transfer, nominal FROM kas_transaksi ORDER BY id`
  );
  expect(ulang).toEqual(snapshot);
});

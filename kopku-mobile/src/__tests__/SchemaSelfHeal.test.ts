import initSqlJs from 'sql.js';

jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { runMigrations } from '@/database/db';
import { CREATE_TABLES_SQL, SCHEMA_VERSION } from '@/database/schema';

/**
 * CRITICAL FIX — schema self-heal berbasis EXISTENCE OBJEK.
 *
 * Bug yang dilaporkan pengguna (Android): `schema_meta.version` bisa
 * SUDAH SAMA dengan SCHEMA_VERSION (mis. 47) sementara tabel
 * `pinjaman_akuntansi_jasa` secara FISIK tidak ada — `currentVersion <
 * SCHEMA_VERSION` selalu false untuk device begini, jadi TIDAK ADA
 * blok migrasi versi manapun (termasuk v42 yang seharusnya membuat
 * tabel ini) yang pernah tersentuh lagi. Akad Ulang lalu crash "no
 * such table: pinjaman_akuntansi_jasa".
 *
 * Pola harness SAMA PERSIS dengan MigrationV42.test.ts (wrapper sql.js
 * in-memory yang meniru interface expo-sqlite) — bedanya di sini
 * skenario yang disimulasikan BUKAN "device versi lama belum migrasi",
 * melainkan "device sudah di versi TERBARU tapi kehilangan tabel"
 * (§11 tiket: skenario ini yang harus diuji, bukan cuma v41→v42).
 */
async function createRawDb() {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  return {
    raw,
    async execAsync(sql: string) {
      raw.run(sql);
    },
    async runAsync(sql: string, ...params: any[]) {
      const stmt = raw.prepare(sql);
      stmt.bind(params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
      stmt.step();
      stmt.free();
    },
    async getFirstAsync(sql: string, ...params: any[]) {
      const stmt = raw.prepare(sql);
      stmt.bind(params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
      const has = stmt.step();
      const result = has ? stmt.getAsObject() : null;
      stmt.free();
      return result;
    },
    async getAllAsync(sql: string, ...params: any[]) {
      const stmt = raw.prepare(sql);
      stmt.bind(params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    async withTransactionAsync(fn: () => Promise<void>) {
      raw.run('BEGIN');
      try {
        await fn();
        raw.run('COMMIT');
      } catch (e) {
        raw.run('ROLLBACK');
        throw e;
      }
    },
  };
}

/** TEST 1 & fondasi: fresh database (schema_meta belum ada sama sekali). */
async function createFreshDb() {
  return createRawDb();
}

/**
 * TEST 2 fondasi: database SUDAH di SCHEMA_VERSION terbaru, tabel
 * pinjaman_akuntansi_jasa ADA & NORMAL — kondisi paling umum sehari-hari
 * (bukan kondisi bug).
 */
async function createCurrentDbTableIntact() {
  const db = await createRawDb();
  db.raw.run(CREATE_TABLES_SQL);
  db.raw.run(`CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  db.raw.run(`INSERT INTO schema_meta (id, version) VALUES (1, ${SCHEMA_VERSION})`);
  return db;
}

/**
 * TEST 3 (skenario bug §11 tiket): database SUDAH di SCHEMA_VERSION
 * terbaru TETAPI pinjaman_akuntansi_jasa hilang secara FISIK (disimulasikan
 * lewat DROP TABLE manual setelah full schema dibuat) — persis kondisi
 * yang dilaporkan di perangkat Android pengguna.
 */
async function createCurrentDbTableMissing() {
  const db = await createRawDb();
  db.raw.run(CREATE_TABLES_SQL);
  db.raw.run(`DROP TABLE pinjaman_akuntansi_jasa`);
  db.raw.run(`CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  db.raw.run(`INSERT INTO schema_meta (id, version) VALUES (1, ${SCHEMA_VERSION})`);
  return db;
}

async function seedPinjamanAktif(db: Awaited<ReturnType<typeof createRawDb>>) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('a1','A-001','Budi','2024-01-01','AKTIF',?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO pinjaman (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa, status, created_by, created_at, updated_at)
     VALUES ('p1','PJ-001','a1','2024-01-01',1000000,12,'BULAN','FLAT','AKTIF','u1',?,?)`,
    now,
    now
  );
}

describe('CRITICAL FIX — Schema Self-Heal (pinjaman_akuntansi_jasa hilang walau schema_meta sudah terbaru)', () => {
  test('TEST 1: fresh database → pinjaman_akuntansi_jasa ada dengan kolom Phase 7 lengkap', async () => {
    const db = await createFreshDb();
    await runMigrations(db as any);

    const cols = (await db.getAllAsync(`PRAGMA table_info(pinjaman_akuntansi_jasa)`)) as any[];
    const colNames = cols.map((c) => c.name);
    for (const wajib of [
      'id', 'pinjaman_id', 'jadwal_id', 'periode_akuntansi', 'tipe_pengakuan',
      'saldo_awal_carrying', 'pendapatan_akuntansi', 'kas_diterima', 'amortisasi_fee',
      'saldo_akhir_carrying', 'status', 'journal_id', 'idempotency_key', 'created_by',
      'created_at', 'updated_at', 'fee_lifecycle_status', 'writeoff_amount',
      'effective_interest_rate', 'remaining_term_bulan', 'principal_component',
    ]) {
      expect(colNames).toContain(wajib);
    }
  });

  test('TEST 2: database versi 47 dengan tabel INTACT → self-heal tidak mengubah apa pun (no-op)', async () => {
    const db = await createCurrentDbTableIntact();
    await seedPinjamanAktif(db);
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO pinjaman_akuntansi_jasa
        (id, pinjaman_id, periode_akuntansi, tipe_pengakuan, saldo_awal_carrying, pendapatan_akuntansi,
         kas_diterima, amortisasi_fee, saldo_akhir_carrying, status, idempotency_key, created_by, created_at, updated_at)
       VALUES ('paj1','p1','2024-01','JASA_AKRUAL',1000000,100000,0,0,1100000,'DIAKUI','p1:2024-01:JASA_AKRUAL','u1',?,?)`,
      now,
      now
    );

    await runMigrations(db as any);

    const row = (await db.getFirstAsync(`SELECT * FROM pinjaman_akuntansi_jasa WHERE id = 'paj1'`)) as any;
    expect(row?.pendapatan_akuntansi).toBe(100000);
    const allRows = (await db.getAllAsync(`SELECT id FROM pinjaman_akuntansi_jasa`)) as any[];
    expect(allRows.length).toBe(1);

    const version = (await db.getFirstAsync(`SELECT version FROM schema_meta WHERE id = 1`)) as any;
    expect(version?.version).toBe(SCHEMA_VERSION);
  });

  test('TEST 3 (skenario bug utama): database versi 47 dengan pinjaman_akuntansi_jasa HILANG → getDb()/runMigrations memulihkan tabel', async () => {
    const db = await createCurrentDbTableMissing();

    const before = await db.getFirstAsync(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='pinjaman_akuntansi_jasa'`
    );
    expect(before).toBeNull();

    await runMigrations(db as any);

    const after = (await db.getFirstAsync(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='pinjaman_akuntansi_jasa'`
    )) as any;
    expect(after?.name).toBe('pinjaman_akuntansi_jasa');

    // schema_meta.version TIDAK diturunkan/dinaikkan oleh self-heal.
    const version = (await db.getFirstAsync(`SELECT version FROM schema_meta WHERE id = 1`)) as any;
    expect(version?.version).toBe(SCHEMA_VERSION);
  });

  test('TEST 4: self-heal dijalankan dua kali berturut-turut → tidak error, tidak duplicate', async () => {
    const db = await createCurrentDbTableMissing();
    await runMigrations(db as any);
    await runMigrations(db as any);

    const tables = (await db.getAllAsync(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='pinjaman_akuntansi_jasa'`
    )) as any[];
    expect(tables.length).toBe(1);
  });

  test('TEST 5: data pinjaman/anggota existing yang tidak terkait tetap ada setelah self-heal', async () => {
    const db = await createCurrentDbTableMissing();
    await seedPinjamanAktif(db);

    await runMigrations(db as any);

    const pinjaman = (await db.getFirstAsync(`SELECT nomor_pinjaman, status FROM pinjaman WHERE id = 'p1'`)) as any;
    expect(pinjaman?.nomor_pinjaman).toBe('PJ-001');
    expect(pinjaman?.status).toBe('AKTIF');

    const anggota = (await db.getFirstAsync(`SELECT nama_lengkap FROM anggota WHERE id = 'a1'`)) as any;
    expect(anggota?.nama_lengkap).toBe('Budi');
  });

  test('TEST 6: query Akad Ulang (INSERT ke pinjaman_akuntansi_jasa) berhasil setelah self-heal — sebelumnya "no such table"', async () => {
    const db = await createCurrentDbTableMissing();
    await seedPinjamanAktif(db);

    await runMigrations(db as any);

    const now = new Date().toISOString();
    await expect(
      db.runAsync(
        `INSERT INTO pinjaman_akuntansi_jasa
          (id, pinjaman_id, periode_akuntansi, tipe_pengakuan, saldo_awal_carrying, pendapatan_akuntansi,
           kas_diterima, amortisasi_fee, saldo_akhir_carrying, status, idempotency_key, created_by, created_at, updated_at)
         VALUES ('paj1','p1','2024-01','EIR_MONTHLY',1000000,100000,0,0,1100000,'DIAKUI','p1:2024-01:EIR_MONTHLY','u1',?,?)`,
        now,
        now
      )
    ).resolves.not.toThrow();

    const row = (await db.getFirstAsync(`SELECT * FROM pinjaman_akuntansi_jasa WHERE id = 'paj1'`)) as any;
    expect(row?.tipe_pengakuan).toBe('EIR_MONTHLY');
  });

  test('TEST 7: kolom final Phase 7 (effective_interest_rate, remaining_term_bulan, principal_component, fee_lifecycle_status, writeoff_amount) tersedia setelah self-heal, bukan definisi v42 lama', async () => {
    const db = await createCurrentDbTableMissing();
    await runMigrations(db as any);

    const cols = (await db.getAllAsync(`PRAGMA table_info(pinjaman_akuntansi_jasa)`)) as any[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('effective_interest_rate');
    expect(colNames).toContain('remaining_term_bulan');
    expect(colNames).toContain('principal_component');
    expect(colNames).toContain('fee_lifecycle_status');
    expect(colNames).toContain('writeoff_amount');

    // CHECK constraint final (termasuk EIR_MONTHLY, ditambahkan Phase 7) —
    // dibuktikan tidak langsung, lewat berhasilnya INSERT tipe_pengakuan
    // 'EIR_MONTHLY' pada TEST 6 di atas (sql.js tidak expose CHECK lewat
    // PRAGMA table_info, jadi pembuktian lewat INSERT yang sesungguhnya).
  });

  test('kolom hilang parsial (tabel ADA tapi kolom Phase 7 belum ada) → ditambahkan tanpa menyentuh data existing', async () => {
    const db = await createRawDb();
    // Simulasikan tabel dari versi migrasi v42 LAMA (SEBELUM Phase 7),
    // sengaja tanpa fee_lifecycle_status/writeoff_amount/effective_interest_rate/
    // remaining_term_bulan/principal_component — kondisi §2 tiket ("bukan
    // hanya table ada, tapi struktur pentingnya juga benar").
    db.raw.run(CREATE_TABLES_SQL);
    db.raw.run(`DROP TABLE pinjaman_akuntansi_jasa`);
    db.raw.run(`
      CREATE TABLE pinjaman_akuntansi_jasa (
        id TEXT PRIMARY KEY,
        pinjaman_id TEXT NOT NULL REFERENCES pinjaman(id),
        jadwal_id TEXT REFERENCES angsuran_jadwal(id),
        periode_akuntansi TEXT NOT NULL,
        tipe_pengakuan TEXT NOT NULL DEFAULT 'JASA_AKRUAL',
        saldo_awal_carrying INTEGER NOT NULL DEFAULT 0,
        pendapatan_akuntansi INTEGER NOT NULL DEFAULT 0,
        kas_diterima INTEGER NOT NULL DEFAULT 0,
        amortisasi_fee INTEGER NOT NULL DEFAULT 0,
        saldo_akhir_carrying INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'DIAKUI',
        journal_id TEXT REFERENCES journal(id),
        idempotency_key TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(pinjaman_id, periode_akuntansi, tipe_pengakuan)
      );
    `);
    db.raw.run(`CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
    db.raw.run(`INSERT INTO schema_meta (id, version) VALUES (1, ${SCHEMA_VERSION})`);

    await seedPinjamanAktif(db);
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO pinjaman_akuntansi_jasa
        (id, pinjaman_id, periode_akuntansi, tipe_pengakuan, pendapatan_akuntansi, idempotency_key, created_by, created_at, updated_at)
       VALUES ('paj-old','p1','2024-01','JASA_AKRUAL',50000,'p1:2024-01:JASA_AKRUAL-old','u1',?,?)`,
      now,
      now
    );

    await runMigrations(db as any);

    const cols = (await db.getAllAsync(`PRAGMA table_info(pinjaman_akuntansi_jasa)`)) as any[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('fee_lifecycle_status');
    expect(colNames).toContain('effective_interest_rate');

    // Baris lama TIDAK hilang, TIDAK diubah nilainya.
    const oldRow = (await db.getFirstAsync(`SELECT pendapatan_akuntansi FROM pinjaman_akuntansi_jasa WHERE id = 'paj-old'`)) as any;
    expect(oldRow?.pendapatan_akuntansi).toBe(50000);
  });
});

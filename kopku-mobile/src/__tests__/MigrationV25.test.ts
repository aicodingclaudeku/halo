import initSqlJs from 'sql.js';

// Pola sama dengan MigrationV18/V24.test.ts — db.ts mengimpor modul native
// yang di-mock minimal supaya runMigrations() murni bisa diuji.
jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { runMigrations } from '@/database/db';
import { SCHEMA_VERSION } from '@/database/schema';

/**
 * Prioritas 8/J (Aset Tak Berwujud & Amortisasi) — migrasi v24 -> v25:
 *  - Kolom baru `jenis_aset` di tabel `aset_tetap` existing (REUSE
 *    tabel, bukan tabel baru) — DEFAULT 'TETAP' aman untuk seluruh
 *    baris lama.
 *  - Mapping ASET_TAK_BERWUJUD / AMORTISASI_ASET_TAK_BERWUJUD SUDAH
 *    ADA di defaultCOA.ts sebelumnya — diuji di sini bahwa instalasi
 *    LAMA (yang belum punya mapping ini sama sekali) ikut mendapatkan
 *    akun 1-1700/1-1710/5-1310 & mapping-nya lewat self-heal COA
 *    generik yang sudah ada (bukan logic migrasi baru).
 */

async function createLegacyDb() {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();

  const wrapper = {
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

  return wrapper;
}

const MINIMAL_SCHEMA_V24 = `
  CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
      -- RC-S60 section 3 -- tabel koperasi untuk fixture skema lama.
      -- Fixture ini membangun skema legacy secara manual dan MELEWATI
      -- CREATE_TABLES_SQL (schema.ts), tempat tabel koperasi sebenarnya
      -- dibuat pada setiap instalasi nyata. Akibatnya blok migrasi v56
      -- (db.ts, currentVersion < 56) yang membaca FROM koperasi gagal
      -- dengan "no such table: koperasi" dan seluruh suite berhenti
      -- sebelum menguji apa pun. Terdiagnosis RC-S59 section 1b.
      -- CATATAN: jangan pakai backtick di komentar ini -- isinya berada
      -- di dalam template literal TypeScript dan akan memutusnya.
      -- Kolom di bawah PERSIS yang di-SELECT oleh rebuild v56 — tidak
      -- lebih, tidak kurang. CHECK-nya masih mengizinkan SAK_EMKM karena
      -- itulah keadaan pra-v56; barisnya sengaja diisi 'SAK_EMKM' supaya
      -- normalisasi SAK_EMKM -> SAK_EP benar-benar dilalui, bukan dilewati.
      -- RC-S60 section 3 -- tabel rekonsiliasi_kas_bank untuk fixture skema lama.
      -- Dibuat oleh blok migrasi v10 (db.ts). Fixture yang mulai dari v17
      -- melewati blok itu, sehingga tabelnya tidak pernah ada -- padahal
      -- blok v28 membacanya (SELECT COUNT(*) ... WHERE account_id = ?)
      -- saat memutuskan apakah akun Persediaan aman dihapus. Instalasi
      -- nyata di v17 SELALU punya tabel ini. Bentuk kolom di bawah persis
      -- definisi v10, bukan bentuk terkini: kolom v62
      -- (status_penyelesaian, penyebab, perlakuan, ...) memang belum ada
      -- pada v17 dan justru ditambahkan oleh migrasi yang sedang diuji.
      CREATE TABLE rekonsiliasi_kas_bank (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES account(id),
        nama_rekening TEXT NOT NULL,
        tanggal TEXT NOT NULL,
        saldo_buku INTEGER NOT NULL,
        saldo_fisik INTEGER NOT NULL,
        selisih INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('COCOK', 'SELISIH')),
        keterangan TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE koperasi (
        id TEXT PRIMARY KEY,
        nama TEXT NOT NULL,
        nomor_badan_hukum TEXT,
        npwp TEXT,
        alamat TEXT,
        telepon TEXT,
        email TEXT,
        logo_uri TEXT,
        tanggal_berdiri TEXT,
        tahun_buku_aktif INTEGER NOT NULL,
        standar_akuntansi TEXT NOT NULL CHECK (standar_akuntansi IN ('SAK_EMKM', 'SAK_EP')),
        setup_selesai INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO koperasi (
        id, nama, nomor_badan_hukum, npwp, alamat, telepon, email, logo_uri,
        tanggal_berdiri, tahun_buku_aktif, standar_akuntansi, setup_selesai,
        created_at, updated_at
      ) VALUES (
        'kop-fixture', 'Koperasi Fixture', NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, 2020, 'SAK_EMKM', 1,
        '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'
      );
  INSERT INTO schema_meta (id, version) VALUES (1, 24);
  CREATE TABLE account (
    id TEXT PRIMARY KEY, kode TEXT NOT NULL UNIQUE, nama TEXT NOT NULL,
    kategori TEXT NOT NULL, normal_balance TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1, is_system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE account_mapping (
    id TEXT PRIMARY KEY, transaction_type TEXT NOT NULL, role TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES account(id)
  );
  CREATE TABLE aset_tetap (
    id TEXT PRIMARY KEY, nomor_aset TEXT NOT NULL UNIQUE, nama_aset TEXT NOT NULL,
    nilai_perolehan INTEGER NOT NULL, nilai_residu INTEGER NOT NULL DEFAULT 0,
    masa_manfaat_bulan INTEGER NOT NULL, tanggal_perolehan TEXT NOT NULL,
    metode_pembayaran TEXT NOT NULL, sumber TEXT NOT NULL, keterangan TEXT,
    journal_id TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
    kelompok_aset TEXT, sub_kelompok_aset TEXT, status TEXT NOT NULL DEFAULT 'AKTIF', updated_at TEXT
  );
  CREATE TABLE shu_konfigurasi (
    id TEXT PRIMARY KEY, tahun_buku INTEGER NOT NULL UNIQUE,
    persen_cadangan REAL NOT NULL DEFAULT 0, persen_jasa_modal REAL NOT NULL DEFAULT 0,
    persen_jasa_usaha REAL NOT NULL DEFAULT 0, persen_pendidikan REAL NOT NULL DEFAULT 0,
    persen_sosial REAL NOT NULL DEFAULT 0, persen_pengurus REAL NOT NULL DEFAULT 0,
    persen_pengawas REAL NOT NULL DEFAULT 0, persen_karyawan REAL NOT NULL DEFAULT 0,
    persen_pembangunan_daerah_kerja REAL NOT NULL DEFAULT 0, persen_lainnya REAL NOT NULL DEFAULT 0,
    total_shu INTEGER, status TEXT NOT NULL DEFAULT 'DRAFT', journal_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  -- Bug fix (test): tabel ini SEBELUMNYA tidak ada di skema sintetis
  -- "v24 lama" ini, padahal migrasi 'aset_klasifikasi' sudah dibuat
  -- sejak v15 (lihat db.ts, blok 'if (currentVersion < 15)') — instalasi
  -- v24 SUNGGUHAN pasti sudah melewati migrasi itu dan punya tabel ini.
  -- Tanpa baris ini, migrasi v25 yang membaca/menulis aset_klasifikasi
  -- gagal dengan "no such table", padahal itu murni skenario tidak
  -- realistis dari fixture test, bukan bug di db.ts.
  CREATE TABLE aset_klasifikasi (
    id TEXT PRIMARY KEY, kelompok TEXT NOT NULL, sub_kelompok TEXT NOT NULL,
    masa_manfaat_bulan_default INTEGER, aktif INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(kelompok, sub_kelompok)
  );
`;

describe('Migrasi v24 -> v25 — Aset Tak Berwujud & Amortisasi (Prioritas 8/J)', () => {
  test('kolom jenis_aset ditambahkan ke aset_tetap dengan DEFAULT "TETAP" — aset lama tetap terbaca sebagai TETAP', async () => {
    const db = await createLegacyDb();
    await db.execAsync(MINIMAL_SCHEMA_V24);
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO aset_tetap
        (id, nomor_aset, nama_aset, nilai_perolehan, nilai_residu, masa_manfaat_bulan, tanggal_perolehan,
         metode_pembayaran, sumber, created_by, created_at)
       VALUES ('aset-lama','AST-001','Mesin Lama',10000000,0,60,'2020-01-01','TUNAI','PEMBELIAN','user-1',?)`,
      now
    );

    await runMigrations(db as any);

    const meta = await db.getFirstAsync(`SELECT version FROM schema_meta WHERE id = 1`);
    // Bug fix (test): assertion basi — sama seperti MigrationV24.test.ts,
    // migrasi terus berlanjut sampai v39 sejak test ini ditulis.
    expect((meta as any).version).toBe(SCHEMA_VERSION);

    const row = (await db.getFirstAsync(`SELECT jenis_aset FROM aset_tetap WHERE id = 'aset-lama'`)) as any;
    expect(row.jenis_aset).toBe('TETAP');
  });

  test('instalasi lama TANPA akun 1-1700/1-1710/5-1310 sama sekali: migrasi tidak gagal, akun & mapping ikut ditambahkan lewat self-heal COA', async () => {
    const db = await createLegacyDb();
    await db.execAsync(MINIMAL_SCHEMA_V24);

    await runMigrations(db as any);

    const akunTakBerwujud = await db.getFirstAsync(`SELECT id FROM account WHERE kode = '1-1700'`);
    const akumulasiAmortisasi = await db.getFirstAsync(`SELECT id FROM account WHERE kode = '1-1710'`);
    const bebanAmortisasi = await db.getFirstAsync(`SELECT id FROM account WHERE kode = '5-1310'`);
    expect(akunTakBerwujud).not.toBeNull();
    expect(akumulasiAmortisasi).not.toBeNull();
    expect(bebanAmortisasi).not.toBeNull();

    const mapping = await db.getFirstAsync(
      `SELECT id FROM account_mapping WHERE transaction_type = 'ASET_TAK_BERWUJUD' AND role = 'DEBIT_ASET'`
    );
    expect(mapping).not.toBeNull();
  });

  test('migrasi idempoten: dijalankan dua kali berturut-turut tidak error & tidak menduplikasi kolom/mapping', async () => {
    const db = await createLegacyDb();
    await db.execAsync(MINIMAL_SCHEMA_V24);

    await runMigrations(db as any);
    await expect(runMigrations(db as any)).resolves.not.toThrow();

    const mappingCount = await db.getAllAsync(
      `SELECT id FROM account_mapping WHERE transaction_type = 'ASET_TAK_BERWUJUD' AND role = 'DEBIT_ASET'`
    );
    expect(mappingCount).toHaveLength(1);
  });
});

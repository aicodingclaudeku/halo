import initSqlJs from 'sql.js';

// Pola sama dengan MigrationV18.test.ts — db.ts mengimpor modul native
// yang di-mock minimal supaya runMigrations() murni bisa diuji.
jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { runMigrations } from '@/database/db';
import { SCHEMA_VERSION } from '@/database/schema';

/**
 * Update pasca-Phase 18/19 (permintaan pengguna §N/§O/§F/§H) — migrasi
 * v23 -> v24:
 *  - rename 3 akun existing (3-3000/5-1050/5-1900) HANYA kalau nama
 *    saat ini masih PERSIS nama lama — kalau admin sudah mengubah
 *    sendiri, TIDAK ditimpa.
 *  - akun baru "Beban Pajak Penghasilan" (5-2200) via self-heal COA.
 *  - tabel baru saldo_awal_lock (§H). Mode Penyusutan (§F) SENGAJA
 *    TIDAK dapat tabel baru — dipakaikan ke `app_config` yang sudah
 *    ada sejak awal (dipakai AccountingPolicyService), sesuai instruksi
 *    "gunakan struktur setting existing jika ternyata sudah ada".
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

const MINIMAL_SCHEMA_V23 = `
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
  INSERT INTO schema_meta (id, version) VALUES (1, 23);
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
  CREATE TABLE shu_konfigurasi (
    id TEXT PRIMARY KEY, tahun_buku INTEGER NOT NULL UNIQUE,
    persen_cadangan REAL NOT NULL DEFAULT 0, persen_jasa_modal REAL NOT NULL DEFAULT 0,
    persen_jasa_usaha REAL NOT NULL DEFAULT 0, persen_pendidikan REAL NOT NULL DEFAULT 0,
    persen_sosial REAL NOT NULL DEFAULT 0, persen_pengurus REAL NOT NULL DEFAULT 0,
    persen_pengawas REAL NOT NULL DEFAULT 0, persen_lainnya REAL NOT NULL DEFAULT 0,
    -- Bug fix (test): kolom-kolom di bawah ini SEBELUMNYA tidak ada di
    -- skema sintetis "v23 lama" ini — instalasi v23 SUNGGUHAN sudah
    -- melewati migrasi-migrasi yang menambahkannya (rat_id/status
    -- diperluas dari versi lebih lama, journal_id, dst), jadi migrasi
    -- selanjutnya (mis. rebuild tabel di v32) yang membaca kolom ini
    -- gagal dengan "no such column" kalau fixture-nya terlalu minimal.
    -- Kolom BARU yang MEMANG baru ditambahkan oleh migrasi v24 itu
    -- sendiri (persen_karyawan/persen_pembangunan_daerah_kerja)
    -- SENGAJA TIDAK dimasukkan di sini, supaya test yang memverifikasi
    -- migrasi v24 menambahkannya tetap valid.
    persen_cadangan_risiko REAL NOT NULL DEFAULT 0,
    shu_informasi_rat INTEGER,
    shu_diajukan_rat INTEGER,
    shu_disahkan_rat INTEGER,
    rat_id TEXT,
    catatan_keputusan_rat TEXT,
    journal_id TEXT,
    total_shu INTEGER, status TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  -- Bug fix (test): tabel ini SEBELUMNYA tidak ada di skema sintetis
  -- "v23 lama" ini, padahal migrasi 'aset_klasifikasi' sudah dibuat
  -- sejak v15 (lihat db.ts, blok 'if (currentVersion < 15)') — instalasi
  -- v23 SUNGGUHAN pasti sudah melewati migrasi itu dan punya tabel ini.
  -- Tanpa baris ini, migrasi v24+ yang membaca/menulis aset_klasifikasi
  -- gagal dengan "no such table", padahal itu murni skenario tidak
  -- realistis dari fixture test, bukan bug di db.ts.
  CREATE TABLE aset_klasifikasi (
    id TEXT PRIMARY KEY, kelompok TEXT NOT NULL, sub_kelompok TEXT NOT NULL,
    masa_manfaat_bulan_default INTEGER, aktif INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(kelompok, sub_kelompok)
  );
`;

describe('Update pasca-Phase 18/19 — migrasi v23 -> v24', () => {
  test('rename akun HANYA kalau nama masih persis nama lama (kode & histori TIDAK berubah)', async () => {
    const db = await createLegacyDb();
    await db.execAsync(MINIMAL_SCHEMA_V23);
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO shu_konfigurasi (id, tahun_buku, persen_cadangan, status, created_at, updated_at) VALUES ('shu-2025',2025,25,'DRAFT',?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-1','3-3000','Modal Lainnya','EKUITAS','KREDIT',1,0,?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-2','5-1050','Beban Tenaga Kerja','BEBAN','DEBIT',1,1,?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-3','5-1900','Beban RAT','BEBAN','DEBIT',1,1,?,?)`,
      now,
      now
    );

    await runMigrations(db as any);

    const meta = await db.getFirstAsync(`SELECT version FROM schema_meta WHERE id = 1`);
    // Bug fix (test): assertion basi — mengharapkan versi skema final
    // 28, padahal migrasi terus berlanjut sampai v39 sejak test ini
    // ditulis (lihat SCHEMA_VERSION di schema.ts). Perilaku rename akun
    // yang sebenarnya diuji test ini TETAP terverifikasi lewat baris
    // di bawah, tidak terpengaruh oleh angka versi akhir.
    expect((meta as any).version).toBe(SCHEMA_VERSION);

    expect((await db.getFirstAsync(`SELECT nama FROM account WHERE kode = '3-3000'`) as any).nama).toBe('Ekuitas Lainnya');
    expect((await db.getFirstAsync(`SELECT nama FROM account WHERE kode = '5-1050'`) as any).nama).toBe('Beban Imbalan Kerja');
    expect((await db.getFirstAsync(`SELECT nama FROM account WHERE kode = '5-1900'`) as any).nama).toBe('Beban Perkoperasian');

    // Kode akun (identitas jurnal) TIDAK berubah sama sekali.
    expect(await db.getFirstAsync(`SELECT id FROM account WHERE id = 'acc-1' AND kode = '3-3000'`)).not.toBeNull();
  });

  test('rename TIDAK MENIMPA kalau admin sudah mengubah nama akun sendiri sebelum migrasi', async () => {
    const db = await createLegacyDb();
    await db.execAsync(MINIMAL_SCHEMA_V23);
    const now = new Date().toISOString();
    // Admin sudah rename manual ke nama kustom sebelum update ini ada.
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-1','3-3000','Ekuitas Cadangan Khusus','EKUITAS','KREDIT',1,0,?,?)`,
      now,
      now
    );

    await runMigrations(db as any);

    // TIDAK ditimpa jadi "Ekuitas Lainnya" — nama kustom admin dihormati.
    expect((await db.getFirstAsync(`SELECT nama FROM account WHERE kode = '3-3000'`) as any).nama).toBe('Ekuitas Cadangan Khusus');
  });

  test('update pasca-Phase 18/19 §U: kolom persen_karyawan & persen_pembangunan_daerah_kerja ditambahkan ke shu_konfigurasi existing dengan DEFAULT 0 (aman untuk data lama)', async () => {
    const db = await createLegacyDb();
    await db.execAsync(MINIMAL_SCHEMA_V23);
    const now = new Date().toISOString();
    // Konfigurasi SHU lama (sebelum update ini ada) — total 8 kolom
    // persentase lama sudah 100% TANPA kolom baru sama sekali.
    await db.runAsync(
      `INSERT INTO shu_konfigurasi
        (id, tahun_buku, persen_cadangan, persen_jasa_modal, persen_jasa_usaha, persen_pendidikan,
         persen_sosial, persen_pengurus, persen_pengawas, persen_lainnya, status, created_at, updated_at)
       VALUES ('shu-2025',2025,25,20,20,10,10,5,5,5,'DRAFT',?,?)`,
      now,
      now
    );

    await runMigrations(db as any);

    const row = (await db.getFirstAsync(`SELECT * FROM shu_konfigurasi WHERE id = 'shu-2025'`)) as any;
    expect(row.persen_karyawan).toBe(0);
    expect(row.persen_pembangunan_daerah_kerja).toBe(0);
    // Kolom lama TIDAK berubah — total tetap 100% (0+0 dari kolom baru tidak merusak konfigurasi lama).
    const totalLama =
      row.persen_cadangan + row.persen_jasa_modal + row.persen_jasa_usaha + row.persen_pendidikan +
      row.persen_sosial + row.persen_pengurus + row.persen_pengawas + row.persen_karyawan +
      row.persen_pembangunan_daerah_kerja + row.persen_lainnya;
    expect(totalLama).toBe(100);
  });

  test('akun baru "Beban Pajak Penghasilan" (5-2200) otomatis tersedia untuk instalasi lama lewat self-heal COA', async () => {
    const db = await createLegacyDb();
    await db.execAsync(MINIMAL_SCHEMA_V23);

    await runMigrations(db as any);

    const akun = await db.getFirstAsync(`SELECT nama, kategori, normal_balance FROM account WHERE kode = '5-2200'`);
    expect(akun).not.toBeNull();
    expect((akun as any).nama).toBe('Beban Pajak Penghasilan');
    expect((akun as any).kategori).toBe('BEBAN');
    expect((akun as any).normal_balance).toBe('DEBIT');
  });

  test('app_config existing bisa langsung dipakai untuk setting Penyusutan Mode (tidak perlu tabel baru), saldo_awal_lock baru dibuat & langsung bisa dipakai', async () => {
    const db = await createLegacyDb();
    await db.execAsync(MINIMAL_SCHEMA_V23);
    // app_config harus SUDAH ADA di instalasi v23 manapun (tabel lama,
    // dipakai AccountingPolicyService sejak awal) — disimulasikan di
    // sini supaya fixture merepresentasikan instalasi lama sungguhan.
    await db.execAsync(`CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);`);

    await runMigrations(db as any);

    await db.runAsync(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('setting.penyusutan_mode','OTOMATIS',?)`,
      new Date().toISOString()
    );
    const setting = await db.getFirstAsync(`SELECT value FROM app_config WHERE key = 'setting.penyusutan_mode'`);
    expect((setting as any).value).toBe('OTOMATIS');

    await db.runAsync(
      `INSERT INTO saldo_awal_lock (id, locked_at, locked_by) VALUES (1, ?, 'user-1')`,
      new Date().toISOString()
    );
    const lock = await db.getFirstAsync(`SELECT locked_by FROM saldo_awal_lock WHERE id = 1`);
    expect((lock as any).locked_by).toBe('user-1');
  });

  test('runMigrations() idempotent: dipanggil dua kali tidak mengubah apa pun lagi & tidak error', async () => {
    const db = await createLegacyDb();
    await db.execAsync(MINIMAL_SCHEMA_V23);
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-1','3-3000','Modal Lainnya','EKUITAS','KREDIT',1,0,?,?)`,
      now,
      now
    );

    await runMigrations(db as any);
    const setelahPertama = await db.getAllAsync(`SELECT kode, nama FROM account`);

    await runMigrations(db as any);
    const setelahKedua = await db.getAllAsync(`SELECT kode, nama FROM account`);

    expect(setelahKedua).toEqual(setelahPertama);
  });
});

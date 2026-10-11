import initSqlJs from 'sql.js';

// Sama seperti FullMigration.test.ts: db.ts mengimpor modul native
// (expo-sqlite/expo-file-system) di level modul — di-mock minimal
// supaya runMigrations() murni bisa diuji tanpa native binding.
jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { runMigrations } from '@/database/db';

/**
 * Phase 18 (permintaan pengguna §1/§2/§4/§23/§24) — migrasi v18:
 *  - akun baru siap (Aset Tak Berwujud, Akumulasi Amortisasinya, Utang
 *    Imbalan Kerja, Beban Amortisasi) via self-heal, termasuk untuk
 *    instalasi LAMA.
 *  - Kas Kecil (1-1001) & Penyertaan pada Unit Usaha (1-1600)
 *    dinonaktifkan (is_active=0), BUKAN dihapus fisik — histori jurnal
 *    lama yang menunjuk akun ini harus tetap valid (FK utuh).
 *  - mapping KAS_KECIL & INVESTASI_UNIT_USAHA dihapus supaya transaksi
 *    BARU tidak bisa lagi memakainya.
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

describe('Phase 18 — migrasi database v17 -> v18 (COA baru + deaktivasi Kas Kecil & 1-1600)', () => {
  test('runMigrations() upgrade dari v17: akun baru tersedia, Kas Kecil & 1-1600 nonaktif (bukan terhapus), mapping lama dibersihkan, jurnal lama tetap utuh', async () => {
    const db = await createLegacyDb();

    await db.execAsync(`
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
      INSERT INTO schema_meta (id, version) VALUES (1, 17);

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
      CREATE TABLE journal (
        id TEXT PRIMARY KEY, nomor_jurnal TEXT, tanggal TEXT NOT NULL, period_id TEXT,
        sumber_transaksi TEXT, sumber_id TEXT, deskripsi TEXT, status TEXT, created_by TEXT,
        created_at TEXT, updated_at TEXT, posted_at TEXT
      );
      CREATE TABLE journal_entry (
        id TEXT PRIMARY KEY, journal_id TEXT NOT NULL REFERENCES journal(id),
        account_id TEXT NOT NULL REFERENCES account(id), debit INTEGER NOT NULL DEFAULT 0, kredit INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE data_referensi (
        id TEXT PRIMARY KEY, jenis TEXT NOT NULL, nama TEXT NOT NULL, keterangan TEXT,
        aktif INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE aset_klasifikasi (
        id TEXT PRIMARY KEY, kelompok TEXT NOT NULL, sub_kelompok TEXT NOT NULL,
        masa_manfaat_bulan_default INTEGER NOT NULL, aktif INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(kelompok, sub_kelompok)
      );
    `);

    const now = new Date().toISOString();

    // Instalasi lama: Kas Kecil (1-1001) & 1-1600 SUDAH punya histori jurnal.
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-kaskecil','1-1001','Kas Kecil','ASET','DEBIT',1,1,?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-1600','1-1600','Penyertaan pada Unit Usaha','ASET','DEBIT',1,1,?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-kaskecil','KAS_KECIL','DEFAULT','acc-kaskecil')`
    );
    await db.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-1600','INVESTASI_UNIT_USAHA','DEBIT_ASET','acc-1600')`
    );
    await db.runAsync(
      `INSERT INTO journal (id, tanggal, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
       VALUES ('j-lama','2025-01-05','KAS_KECIL','Setoran kas kecil lama','POSTED','user-1',?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-lama','j-lama','acc-kaskecil',500000,0)`
    );

    // JALANKAN MIGRASI SUNGGUHAN.
    await runMigrations(db as any);

    // 1. Versi naik ke skema terkini (>= 18 mencakup migrasi ini,
    // >= versi berikutnya kalau ada migrasi lanjutan seperti RAK di v19).
    const meta = await db.getFirstAsync(`SELECT version FROM schema_meta WHERE id = 1`);
    expect((meta as any).version).toBeGreaterThanOrEqual(18);

    // 2. Kas Kecil & 1-1600 dinonaktifkan, BUKAN dihapus (baris masih ada).
    const kasKecil = await db.getFirstAsync(`SELECT is_active FROM account WHERE kode = '1-1001'`);
    expect(kasKecil).not.toBeNull();
    expect((kasKecil as any).is_active).toBe(0);

    const akun1600 = await db.getFirstAsync(`SELECT is_active FROM account WHERE kode = '1-1600'`);
    expect(akun1600).not.toBeNull();
    expect((akun1600 as any).is_active).toBe(0);

    // 3. Mapping lama dihapus.
    const mapKasKecil = await db.getFirstAsync(`SELECT id FROM account_mapping WHERE transaction_type = 'KAS_KECIL'`);
    expect(mapKasKecil).toBeNull();
    const mapUnitUsaha = await db.getFirstAsync(`SELECT id FROM account_mapping WHERE transaction_type = 'INVESTASI_UNIT_USAHA'`);
    expect(mapUnitUsaha).toBeNull();

    // 4. Jurnal lama & journal_entry-nya TIDAK terhapus / tidak orphan (FK utuh).
    const jurnalLama = await db.getFirstAsync(`SELECT id FROM journal WHERE id = 'j-lama'`);
    expect(jurnalLama).not.toBeNull();
    const entriLama = await db.getFirstAsync(`SELECT account_id, debit FROM journal_entry WHERE id = 'je-lama'`);
    expect(entriLama).not.toBeNull();
    expect((entriLama as any).account_id).toBe('acc-kaskecil');
    expect((entriLama as any).debit).toBe(500000);

    // 5. Akun baru Phase 18 §1 otomatis tersedia lewat self-heal (aktif).
    for (const kode of ['1-1700', '1-1710', '2-1600', '5-1310']) {
      const row = await db.getFirstAsync(`SELECT is_active FROM account WHERE kode = ?`, kode);
      expect(row).not.toBeNull();
      expect((row as any).is_active).toBe(1);
    }

    // 6. Mapping baru untuk akun-akun tersebut ikut tersedia.
    for (const type of ['ASET_TAK_BERWUJUD', 'AMORTISASI_ASET_TAK_BERWUJUD', 'UTANG_IMBALAN_KERJA']) {
      const row = await db.getFirstAsync(`SELECT id FROM account_mapping WHERE transaction_type = ?`, type);
      expect(row).not.toBeNull();
    }

    // 7. Master Kelompok Aset default (Phase 18 §14-19) ikut ter-seed
    // untuk instalasi LAMA lewat migration v20.
    const kelompok4Bangunan = await db.getAllAsync(
      `SELECT sub_kelompok, masa_manfaat_bulan_default FROM aset_klasifikasi WHERE kelompok = 'Kelompok 4' ORDER BY sub_kelompok`
    );
    expect((kelompok4Bangunan as any[]).length).toBe(2);
    const bangunanPermanen = (kelompok4Bangunan as any[]).find((r) => r.sub_kelompok === 'Bangunan Permanen');
    expect(bangunanPermanen?.masa_manfaat_bulan_default).toBe(240);
    const bangunanTidakPermanen = (kelompok4Bangunan as any[]).find((r) => r.sub_kelompok === 'Bangunan Tidak Permanen');
    expect(bangunanTidakPermanen?.masa_manfaat_bulan_default).toBe(120);

    const kelompok1Count = await db.getFirstAsync(`SELECT COUNT(*) as cnt FROM aset_klasifikasi WHERE kelompok = 'Kelompok 1'`);
    expect((kelompok1Count as any).cnt).toBe(11);

    // 7b. Audit ulang (permintaan pengguna §17/§18/§29C): migration v29
    // — Kelompok 3 punya 3 sub-kelompok baru (bukan lagi placeholder),
    // Kelompok 5 "Lainnya" ter-seed dengan masa manfaat NULL, dan kolom
    // `masa_manfaat_bulan_default` yang tadinya NOT NULL (skema legacy
    // simulasi di atas) berhasil di-rebuild jadi nullable TANPA
    // kehilangan data Kelompok 1/4 yang sudah ada.
    const kelompok3 = await db.getAllAsync(
      `SELECT sub_kelompok, masa_manfaat_bulan_default FROM aset_klasifikasi WHERE kelompok = 'Kelompok 3' ORDER BY sub_kelompok`
    );
    expect((kelompok3 as any[]).length).toBe(3);
    expect((kelompok3 as any[]).every((r) => r.masa_manfaat_bulan_default === 192)).toBe(true);

    const kelompok5 = await db.getAllAsync(
      `SELECT sub_kelompok, masa_manfaat_bulan_default FROM aset_klasifikasi WHERE kelompok = 'Kelompok 5'`
    );
    expect((kelompok5 as any[]).length).toBe(1);
    expect((kelompok5 as any[])[0].sub_kelompok).toBe('Lainnya');
    expect((kelompok5 as any[])[0].masa_manfaat_bulan_default).toBeNull();

    const kolomInfo = await db.getAllAsync(`PRAGMA table_info(aset_klasifikasi)`);
    const kolomMasaManfaat = (kolomInfo as any[]).find((c) => c.name === 'masa_manfaat_bulan_default');
    expect(kolomMasaManfaat.notnull).toBe(0);

    // 8. Tabel `rat` (update pasca-Phase 18 §12/§13) ikut dibuat untuk
    // instalasi LAMA lewat migration v21, & benar-benar bisa dipakai
    // (insert + UNIQUE(tahun_buku) tertegakkan).
    await db.runAsync(
      `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at) VALUES ('rat-1',2026,'2026-05-01','user-1',?,?)`,
      now,
      now
    );
    const rat = await db.getFirstAsync(`SELECT tahun_buku FROM rat WHERE id = 'rat-1'`);
    expect((rat as any).tahun_buku).toBe(2026);
  });

  test('runMigrations() idempotent: dipanggil dua kali tidak mengubah apa pun lagi & tidak error', async () => {
    const db = await createLegacyDb();
    await db.execAsync(`
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
      INSERT INTO schema_meta (id, version) VALUES (1, 17);
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
      CREATE TABLE journal (
        id TEXT PRIMARY KEY, nomor_jurnal TEXT, tanggal TEXT NOT NULL, period_id TEXT,
        sumber_transaksi TEXT, sumber_id TEXT, deskripsi TEXT, status TEXT, created_by TEXT,
        created_at TEXT, updated_at TEXT, posted_at TEXT
      );
      CREATE TABLE journal_entry (
        id TEXT PRIMARY KEY, journal_id TEXT NOT NULL REFERENCES journal(id),
        account_id TEXT NOT NULL REFERENCES account(id), debit INTEGER NOT NULL DEFAULT 0, kredit INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE data_referensi (
        id TEXT PRIMARY KEY, jenis TEXT NOT NULL, nama TEXT NOT NULL, keterangan TEXT,
        aktif INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE aset_klasifikasi (
        id TEXT PRIMARY KEY, kelompok TEXT NOT NULL, sub_kelompok TEXT NOT NULL,
        masa_manfaat_bulan_default INTEGER NOT NULL, aktif INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(kelompok, sub_kelompok)
      );
    `);
    await runMigrations(db as any);
    const jumlahAkunSetelahPertama = await db.getAllAsync(`SELECT id FROM account`);

    await runMigrations(db as any);
    const jumlahAkunSetelahKedua = await db.getAllAsync(`SELECT id FROM account`);

    expect((jumlahAkunSetelahKedua as any[]).length).toBe((jumlahAkunSetelahPertama as any[]).length);
  });
});

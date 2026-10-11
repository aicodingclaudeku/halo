import initSqlJs from 'sql.js';

// db.ts mengimpor 'expo-sqlite' & 'expo-file-system/legacy' di level
// modul (dipakai getDb()/closeDb(), yang TIDAK kita panggil di test
// ini — cuma runMigrations() murni). Dua modul native itu tidak bisa
// di-load Jest (preset ts-jest, bukan jest-expo) — di-mock minimal
// supaya modul db.ts bisa di-import tanpa menjalankan kode native-nya.
jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { runMigrations } from '@/database/db';

/**
 * Phase 15 (Final Audit) — verifikasi migrasi SUNGGUHAN, bukan simulasi
 * terpisah. Test ini membuat database SQLite kosong dalam bentuk skema
 * VERSI LAMA (meniru instalasi yang sudah dipakai sejak sebelum
 * Phase 1 dimulai — sengaja pakai skema v3-era: sebelum kolom
 * idempotency_key, sebelum tabel penyusutan/dimuka/rekonsiliasi, dsb),
 * lalu memanggil `runMigrations()` yang PERSIS SAMA dipakai app
 * sungguhan lewat `getDb()`, dan memastikan hasil akhirnya benar &
 * TIDAK ADA data yang hilang.
 */

// Minimal wrapper supaya sql.js.Database cocok dengan interface yang
// dipakai db.ts (getFirstAsync/getAllAsync/runAsync/execAsync) — pola
// yang sama seperti testDb.ts, ditulis ulang di sini spesifik untuk
// test ini supaya independen (tidak bergantung skema CREATE_TABLES_SQL
// terkini dari testDb.ts, yang justru tidak cocok untuk skenario
// "database versi LAMA" yang mau disimulasikan).
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

describe('Phase 15 (Final Audit) — migrasi database end-to-end v3-era -> terkini', () => {
  test('runMigrations() sungguhan berhasil upgrade dari skema lama TANPA kehilangan data', async () => {
    const db = await createLegacyDb();

    // Bentuk skema v3-era MINIMAL yang relevan (bukan seluruh app,
    // cukup tabel yang disentuh migrasi v4+ supaya test ini fokus &
    // tidak jadi duplikat CREATE_TABLES_SQL penuh):
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
      INSERT INTO schema_meta (id, version) VALUES (1, 3);

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
      CREATE TABLE anggota (
        id TEXT PRIMARY KEY, nomor_anggota TEXT NOT NULL UNIQUE,
        nik TEXT NOT NULL UNIQUE, -- versi LAMA: NOT NULL (sebelum migrasi v4)
        nama_lengkap TEXT NOT NULL, tempat_lahir TEXT, tanggal_lahir TEXT,
        alamat TEXT, nomor_hp TEXT, pekerjaan TEXT, foto_uri TEXT, catatan TEXT,
        tanggal_bergabung TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'AKTIF', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE aset_tetap (
        id TEXT PRIMARY KEY, nomor_aset TEXT NOT NULL UNIQUE, nama_aset TEXT NOT NULL,
        nilai_perolehan INTEGER NOT NULL, masa_manfaat_bulan INTEGER NOT NULL,
        tanggal_perolehan TEXT NOT NULL, metode_pembayaran TEXT NOT NULL, sumber TEXT NOT NULL,
        keterangan TEXT, journal_id TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE accounting_period (
        id TEXT PRIMARY KEY, tahun_buku INTEGER NOT NULL, periode_mulai TEXT NOT NULL,
        periode_selesai TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN', closed_at TEXT, closed_by TEXT
      );
      CREATE TABLE journal (
        id TEXT PRIMARY KEY, nomor_jurnal TEXT, tanggal TEXT NOT NULL, period_id TEXT,
        sumber_transaksi TEXT, sumber_id TEXT, deskripsi TEXT, status TEXT, created_by TEXT,
        created_at TEXT, updated_at TEXT, posted_at TEXT
      );
      CREATE TABLE simpanan_transaksi (
        id TEXT PRIMARY KEY, anggota_id TEXT NOT NULL, jenis TEXT NOT NULL, tipe TEXT NOT NULL,
        tanggal TEXT NOT NULL, nominal INTEGER NOT NULL, sumber_dana TEXT NOT NULL,
        nomor_transaksi TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE angsuran_pembayaran (
        id TEXT PRIMARY KEY, pinjaman_id TEXT NOT NULL, tanggal TEXT NOT NULL,
        nominal INTEGER NOT NULL, porsi_pokok INTEGER NOT NULL, porsi_jasa INTEGER NOT NULL,
        porsi_denda INTEGER NOT NULL DEFAULT 0, sumber_dana TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE kas_transaksi (
        id TEXT PRIMARY KEY, jenis_kas TEXT NOT NULL, tipe TEXT NOT NULL, tanggal TEXT NOT NULL,
        nominal INTEGER NOT NULL, nomor_transaksi TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE bank_transaksi (
        id TEXT PRIMARY KEY, bank_account_id TEXT NOT NULL, tipe TEXT NOT NULL, tanggal TEXT NOT NULL,
        nominal INTEGER NOT NULL, nomor_transaksi TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE utang_pembayaran (
        id TEXT PRIMARY KEY, utang_id TEXT NOT NULL, tanggal TEXT NOT NULL,
        pokok INTEGER NOT NULL, bunga INTEGER NOT NULL, sumber_dana TEXT NOT NULL,
        nomor_transaksi TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);

    // Data SUNGGUHAN yang harus tetap utuh setelah migrasi (bukti "no
    // data loss" — bukan cuma "tidak error").
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('anggota-lama','A001','1234567890123456','Anggota Lama Sebelum Upgrade','2020-01-01','AKTIF',?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-lama','9-9999','Akun Kustom Milik Koperasi Ini','ASET','DEBIT',1,0,?,?)`,
      now,
      now
    );

    // JALANKAN MIGRASI SUNGGUHAN — fungsi asli yang dipakai getDb() di app.
    await runMigrations(db as any);

    // 1. Versi skema naik ke versi TERKINI.
    const meta = await db.getFirstAsync(`SELECT version FROM schema_meta WHERE id = 1`);
    expect((meta as any).version).toBeGreaterThanOrEqual(10);

    // 2. Data lama TIDAK HILANG.
    const anggota = await db.getFirstAsync(`SELECT * FROM anggota WHERE id = 'anggota-lama'`);
    expect((anggota as any).nama_lengkap).toBe('Anggota Lama Sebelum Upgrade');
    const akun = await db.getFirstAsync(`SELECT * FROM account WHERE id = 'acc-lama'`);
    expect((akun as any).nama).toBe('Akun Kustom Milik Koperasi Ini');

    // 3. Kolom baru dari migrasi v4 (nik nullable) — dibuktikan dengan
    //    insert anggota BARU tanpa NIK berhasil (dulu akan gagal
    //    NOT NULL constraint).
    await db.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('anggota-baru','A002',NULL,'Anggota Baru Tanpa NIK','2026-01-01','AKTIF',?,?)`,
      now,
      now
    );
    const anggotaBaru = await db.getFirstAsync(`SELECT * FROM anggota WHERE id = 'anggota-baru'`);
    expect(anggotaBaru).toBeTruthy();

    // 4. Kolom baru dari migrasi v6 (nilai_residu di aset_tetap) ada &
    //    berdefault 0.
    await db.runAsync(
      `INSERT INTO aset_tetap (id, nomor_aset, nama_aset, nilai_perolehan, masa_manfaat_bulan, tanggal_perolehan, metode_pembayaran, sumber, created_by, created_at)
       VALUES ('aset-1','AST-1','Test Aset',1000000,12,'2026-01-01','TUNAI','PEMBELIAN','user-1',?)`,
      now
    );
    const aset = await db.getFirstAsync(`SELECT nilai_residu FROM aset_tetap WHERE id = 'aset-1'`);
    expect((aset as any).nilai_residu).toBe(0);

    // 5. Tabel baru dari Phase 6/10/11 (v6, v9, v10) benar-benar ada.
    for (const tabel of [
      'aset_penyusutan',
      'pendapatan_diterima_dimuka',
      'pendapatan_dimuka_pengakuan',
      'biaya_dibayar_dimuka',
      'biaya_dimuka_pengakuan',
      'rekonsiliasi_kas_bank',
    ]) {
      const row = await db.getFirstAsync(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, tabel);
      expect(row).toBeTruthy();
    }

    // 6. Kolom idempotency_key (Phase 2) ada & UNIQUE INDEX-nya
    //    benar-benar mencegah duplikasi (bukan cuma kolom kosong tanpa
    //    constraint).
    await db.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, idempotency_key, created_by, created_at)
       VALUES ('trx-1','anggota-lama','POKOK','SETOR','2026-01-01',100000,'KAS','SP-1','idem-1','user-1',?)`,
      now
    );
    await expect(
      db.runAsync(
        `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, idempotency_key, created_by, created_at)
         VALUES ('trx-2','anggota-lama','POKOK','SETOR','2026-01-02',50000,'KAS','SP-2','idem-1','user-1',?)`,
        now
      )
    ).rejects.toThrow();

    // 7. Self-heal COA (akun & mapping baru dari Phase 1-8, mis. Utang
    //    Bank) sudah ter-seed otomatis TANPA menghapus akun kustom
    //    milik koperasi.
    const akunUtangBank = await db.getFirstAsync(`SELECT * FROM account WHERE kode = '2-1400'`);
    expect((akunUtangBank as any)?.nama).toBe('Utang Bank');
    const akunKustomMasihAda = await db.getFirstAsync(`SELECT * FROM account WHERE id = 'acc-lama'`);
    expect(akunKustomMasihAda).toBeTruthy();

    // 7b. Revisi LHU KOPKU (migrasi v33): akun Pendapatan/Beban default
    //     yang baru ter-seed lewat self-heal COA di atas SUDAH punya
    //     lhu_klasifikasi terisi benar (bukan NULL) — datang langsung
    //     dari DEFAULT_ACCOUNTS/defaultCOA.ts saat INSERT, bukan
    //     backfill terpisah. "Pendapatan Jasa Pinjaman" (4-1000) &
    //     "Beban Pajak Penghasilan" (5-2200) SENGAJA tetap NULL — baris
    //     tersendiri di LHU, bukan bagian klasifikasi manapun.
    const pendapatanUsahaLain = await db.getFirstAsync(`SELECT lhu_klasifikasi FROM account WHERE kode = '4-2000'`);
    expect((pendapatanUsahaLain as any)?.lhu_klasifikasi).toBe('PENDAPATAN_USAHA_LAIN');
    const pendapatanLainnya = await db.getFirstAsync(`SELECT lhu_klasifikasi FROM account WHERE kode = '4-3000'`);
    expect((pendapatanLainnya as any)?.lhu_klasifikasi).toBe('PENDAPATAN_LAIN');
    const bebanPenurunanInvestasi = await db.getFirstAsync(`SELECT lhu_klasifikasi FROM account WHERE kode = '5-2150'`);
    expect((bebanPenurunanInvestasi as any)?.lhu_klasifikasi).toBe('BEBAN_LAIN');
    const bebanGaji = await db.getFirstAsync(`SELECT lhu_klasifikasi FROM account WHERE kode = '5-1100'`);
    expect((bebanGaji as any)?.lhu_klasifikasi).toBe('BEBAN_USAHA');
    const pendapatanJasaPinjaman = await db.getFirstAsync(`SELECT lhu_klasifikasi FROM account WHERE kode = '4-1000'`);
    expect((pendapatanJasaPinjaman as any)?.lhu_klasifikasi).toBeFalsy();
    const bebanPajak = await db.getFirstAsync(`SELECT lhu_klasifikasi FROM account WHERE kode = '5-2200'`);
    expect((bebanPajak as any)?.lhu_klasifikasi).toBeFalsy();

    // 8. Jalankan migrasi KEDUA KALINYA (simulasi app dibuka ulang) —
    //    harus idempoten, tidak error, tidak menduplikasi apa pun.
    await runMigrations(db as any);
    const jumlahAkunUtangBank = await db.getAllAsync(`SELECT * FROM account WHERE kode = '2-1400'`);
    expect(jumlahAkunUtangBank).toHaveLength(1);
  });
});

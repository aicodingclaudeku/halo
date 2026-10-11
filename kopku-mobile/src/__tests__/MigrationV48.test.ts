import initSqlJs from 'sql.js';

jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { runMigrations } from '@/database/db';
import { CREATE_TABLES_SQL, SCHEMA_VERSION } from '@/database/schema';

/**
 * Migrasi v48 — FINAL FIX AKRUAL JASA (permintaan pengguna BUG 4/5/7):
 *  - kolom baru `angsuran_jadwal.jasa_dimuka` (INTEGER NOT NULL
 *    DEFAULT 0) — subledger porsi jasa yang KASNYA sudah diterima
 *    tapi periodenya BELUM jatuh tempo, jadi belum boleh diakui
 *    sebagai pendapatan.
 *  - AccountMapping baru (self-heal, pola SAMA PERSIS v42/v43):
 *    ANGSURAN_JASA/KREDIT_DIMUKA & AKRUAL_JASA_PINJAMAN/DEBIT_DIMUKA,
 *    KEDUANYA menunjuk akun 2-1300 "Pendapatan Diterima Dimuka" yang
 *    SUDAH ADA — TIDAK ada akun baru yang dibuat.
 *
 * Pola test SAMA PERSIS dengan MigrationV42.test.ts: simulasikan
 * instalasi lama lewat sql.js in-memory, jalankan runMigrations, lalu
 * verifikasi hasil, backward-compatibility data historis, dan
 * idempotensi (dijalankan dua kali tidak error & tidak berubah).
 */
async function createV47Db() {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  // Skema terbaru dipakai sebagai basis (sama seperti test migrasi
  // lain), lalu kolom v48 DIHAPUS supaya benar-benar meniru instalasi
  // lama yang belum punya kolom itu.
  raw.run(CREATE_TABLES_SQL);
  raw.run(`ALTER TABLE angsuran_jadwal DROP COLUMN jasa_dimuka`);
  raw.run(`CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  raw.run(`INSERT INTO schema_meta (id, version) VALUES (1, 47)`);

  return {
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

async function seedPinjamanDenganJadwalLama(db: any) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('anggota-lama','A001','Budi Lama','2020-01-01','AKTIF',?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO pinjaman (id, anggota_id, nomor_pinjaman, tanggal, jumlah_pinjaman, tenor, satuan_tenor,
      metode_jasa, persentase_jasa, status, created_by, created_at, updated_at)
     VALUES ('pinj-lama','anggota-lama','PJM-LAMA','2024-01-01',1200000,12,'BULAN','FLAT',1,'AKTIF','user-1',?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total,
      pokok_terbayar, jasa_terbayar, denda_terbayar, status)
     VALUES ('jdw-lama','pinj-lama',1,'2024-02-01',100000,12000,0,112000,100000,12000,0,'LUNAS')`
  );
}

describe('Migrasi v48 — angsuran_jadwal.jasa_dimuka & mapping Pendapatan Diterima Dimuka untuk jasa pinjaman', () => {
  test('kolom jasa_dimuka ditambahkan dengan DEFAULT 0 — baris historis TIDAK berubah nilainya', async () => {
    const db = await createV47Db();
    await seedPinjamanDenganJadwalLama(db);

    await runMigrations(db as any);

    const kolom = (await db.getAllAsync(`PRAGMA table_info(angsuran_jadwal)`)) as { name: string }[];
    expect(kolom.map((k) => k.name)).toContain('jasa_dimuka');

    const baris = (await db.getFirstAsync(
      `SELECT jasa, jasa_terbayar, jasa_dimuka, status FROM angsuran_jadwal WHERE id = 'jdw-lama'`
    )) as any;
    // Data historis apa adanya — TIDAK ADA backfill/reklasifikasi.
    expect(baris.jasa).toBe(12000);
    expect(baris.jasa_terbayar).toBe(12000);
    expect(baris.status).toBe('LUNAS');
    // Default 0 = "tidak ada porsi diterima dimuka", persis asumsi
    // implisit sebelum perbaikan ini.
    expect(baris.jasa_dimuka).toBe(0);
  });

  test('mapping ANGSURAN_JASA/KREDIT_DIMUKA & AKRUAL_JASA_PINJAMAN/DEBIT_DIMUKA menunjuk akun 2-1300 EXISTING (bukan akun baru)', async () => {
    const db = await createV47Db();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-2-1300','2-1300','Pendapatan Diterima Dimuka','LIABILITAS','KREDIT',1,1,?,?)`,
      now,
      now
    );

    await runMigrations(db as any);

    for (const [tipe, role] of [
      ['ANGSURAN_JASA', 'KREDIT_DIMUKA'],
      ['AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA'],
    ]) {
      const map = (await db.getFirstAsync(
        `SELECT am.account_id, a.kode FROM account_mapping am JOIN account a ON a.id = am.account_id
         WHERE am.transaction_type = ? AND am.role = ?`,
        tipe,
        role
      )) as any;
      expect(map).toBeTruthy();
      expect(map.kode).toBe('2-1300');
      // Akun 2-1300 yang SUDAH ADA dipakai ulang, bukan akun duplikat.
      expect(map.account_id).toBe('acc-2-1300');
    }

    const jumlah2130 = (await db.getFirstAsync(`SELECT COUNT(*) as cnt FROM account WHERE kode = '2-1300'`)) as any;
    expect(jumlah2130.cnt).toBe(1);
  });

  test('idempoten — runMigrations dua kali tidak error, tidak menduplikasi mapping, versi akhir = SCHEMA_VERSION', async () => {
    const db = await createV47Db();
    await seedPinjamanDenganJadwalLama(db);

    await runMigrations(db as any);
    await runMigrations(db as any);

    const versi = (await db.getFirstAsync(`SELECT version FROM schema_meta WHERE id = 1`)) as any;
    expect(versi.version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(48);

    const dup = (await db.getFirstAsync(
      `SELECT COUNT(*) as cnt FROM account_mapping WHERE transaction_type = 'AKRUAL_JASA_PINJAMAN' AND role = 'DEBIT_DIMUKA'`
    )) as any;
    expect(dup.cnt).toBe(1);

    const baris = (await db.getFirstAsync(`SELECT jasa_dimuka FROM angsuran_jadwal WHERE id = 'jdw-lama'`)) as any;
    expect(baris.jasa_dimuka).toBe(0);
  });

  test('fresh install (CREATE_TABLES_SQL) sudah punya kolom jasa_dimuka — sama dengan hasil migrasi instalasi lama', async () => {
    const SQL = await initSqlJs();
    const fresh = new SQL.Database();
    fresh.run(CREATE_TABLES_SQL);
    const stmt = fresh.prepare(`PRAGMA table_info(angsuran_jadwal)`);
    const kolomFresh: string[] = [];
    while (stmt.step()) kolomFresh.push((stmt.getAsObject() as any).name);
    stmt.free();
    expect(kolomFresh).toContain('jasa_dimuka');

    const db = await createV47Db();
    await runMigrations(db as any);
    const kolomMigrasi = ((await db.getAllAsync(`PRAGMA table_info(angsuran_jadwal)`)) as { name: string }[]).map((k) => k.name);
    expect([...kolomMigrasi].sort()).toEqual([...kolomFresh].sort());
  });
});

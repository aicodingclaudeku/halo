import initSqlJs from 'sql.js';

jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { runMigrations } from '@/database/db';
import { CREATE_TABLES_SQL } from '@/database/schema';

/**
 * Revisi KOPKU (Bagian 1) — migrasi v35 (kolom `bank_tujuan_id` di
 * `investasi`, nullable, tanpa CHECK constraint yang berubah). Fixture
 * dibangun dari CREATE_TABLES_SQL TERKINI MINUS kolom `bank_tujuan_id`
 * di tabel `investasi` — mensimulasikan instalasi PERSIS di v34 (satu
 * versi sebelum revisi ini), pola sama seperti
 * MigrationV33LhuKlasifikasi.test.ts.
 */
async function createV34Db() {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();

  const legacySql = CREATE_TABLES_SQL.replace(
    /\n\s*-- Revisi KOPKU \(Bagian 1\)[\s\S]*?bank_tujuan_id TEXT REFERENCES bank_account\(id\),\n/,
    '\n'
  );
  if (legacySql.includes('bank_tujuan_id')) {
    throw new Error('Gagal mensimulasikan skema v34 — kolom bank_tujuan_id masih ada di fixture.');
  }
  raw.run(legacySql);
  raw.run(`CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  raw.run(`INSERT INTO schema_meta (id, version) VALUES (1, 34)`);

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

describe('Migrasi v35 — Revisi KOPKU Bagian 1: kolom bank_tujuan_id di investasi', () => {
  test('instalasi lama (v34) TANPA kolom bank_tujuan_id: migrasi menambahkan kolom, data investasi lama tidak berubah', async () => {
    const db = await createV34Db();

    const now = new Date().toISOString();
    // Investasi lama, dibuat sebelum kolom bank_tujuan_id ada.
    await db.runAsync(
      `INSERT INTO investasi
        (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal, sumber_dana,
         keterangan, journal_id, created_by, created_at, status, reversal_of_id, updated_at)
       VALUES ('inv-lama','INV-LAMA','TABUNGAN_BANK_UMUM','Bank Mandiri (teks bebas lama)',5000000,'2025-01-01','KAS',NULL,NULL,'user-1',?,'AKTIF',NULL,?)`,
      now,
      now
    );

    await runMigrations(db as any);

    const kolomInfo = (await db.getAllAsync(`PRAGMA table_info(investasi)`)) as { name: string }[];
    expect(kolomInfo.some((c) => c.name === 'bank_tujuan_id')).toBe(true);

    // Data lama tetap utuh — nama_tujuan (teks bebas lama) tidak
    // disentuh, bank_tujuan_id NULL (histori sebelum fitur ini ada).
    const lama = (await db.getFirstAsync(
      `SELECT nama_tujuan, bank_tujuan_id FROM investasi WHERE id = 'inv-lama'`
    )) as { nama_tujuan: string; bank_tujuan_id: string | null } | null;
    expect(lama?.nama_tujuan).toBe('Bank Mandiri (teks bebas lama)');
    expect(lama?.bank_tujuan_id).toBeFalsy();
  });

  test('migrasi v35 idempoten: dijalankan dua kali tidak error (ALTER TABLE ADD COLUMN tidak diulang)', async () => {
    const db = await createV34Db();
    await runMigrations(db as any);
    await expect(runMigrations(db as any)).resolves.not.toThrow();

    const kolomInfo = (await db.getAllAsync(`PRAGMA table_info(investasi)`)) as { name: string }[];
    const jumlahKolomBankTujuan = kolomInfo.filter((c) => c.name === 'bank_tujuan_id').length;
    expect(jumlahKolomBankTujuan).toBe(1);
  });
});

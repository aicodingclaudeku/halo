import initSqlJs from 'sql.js';

jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { runMigrations } from '@/database/db';
import { CREATE_TABLES_SQL, SCHEMA_VERSION } from '@/database/schema';

/**
 * Migrasi v38 (permintaan pengguna §8): kolom `anggota.jenis_kelamin`
 * (ADD COLUMN, nullable, TIDAK ADA CHECK constraint di jalur migrasi —
 * lihat komentar `tambahKolomJikaBelumAda` di db.ts) — anggota lama
 * otomatis NULL ("belum diisi"), TIDAK ada data anggota yang hilang.
 *
 * Pola test SAMA PERSIS dengan MigrationV37.test.ts: simulasikan
 * instalasi lama (v37, sebelum migrasi ini) lewat sql.js in-memory,
 * jalankan `runMigrations`, lalu verifikasi hasil & idempotensi.
 */
async function createV37Db() {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.run(CREATE_TABLES_SQL);
  raw.run(`CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  raw.run(`INSERT INTO schema_meta (id, version) VALUES (1, 37)`);

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

describe('Migrasi v38 — anggota.jenis_kelamin (permintaan pengguna §8)', () => {
  test('anggota lama (sebelum migrasi) tetap terbaca apa adanya, jenis_kelamin NULL', async () => {
    const db = await createV37Db();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('a-lama','A00001','Anggota Lama','2020-01-01','AKTIF',?,?)`,
      now,
      now
    );

    await runMigrations(db as any);

    const lama = (await db.getFirstAsync(`SELECT nama_lengkap, jenis_kelamin FROM anggota WHERE id = 'a-lama'`)) as any;
    expect(lama?.nama_lengkap).toBe('Anggota Lama');
    expect(lama?.jenis_kelamin ?? null).toBeNull();
  });

  test('anggota baru pasca-migrasi bisa mengisi jenis_kelamin (LAKI_LAKI/PEREMPUAN)', async () => {
    const db = await createV37Db();
    await runMigrations(db as any);

    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, jenis_kelamin, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('a-baru','A00002','Anggota Baru','PEREMPUAN','2026-01-01','AKTIF',?,?)`,
      now,
      now
    );

    const baru = (await db.getFirstAsync(`SELECT jenis_kelamin FROM anggota WHERE id = 'a-baru'`)) as any;
    expect(baru?.jenis_kelamin).toBe('PEREMPUAN');
  });

  test('migrasi idempoten — dijalankan dua kali tidak error & tidak mengubah data anggota existing', async () => {
    const db = await createV37Db();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES ('a-lama','A00001','Anggota Lama','2020-01-01','AKTIF',?,?)`,
      now,
      now
    );

    await runMigrations(db as any);
    await runMigrations(db as any);

    const lama = (await db.getFirstAsync(`SELECT nama_lengkap FROM anggota WHERE id = 'a-lama'`)) as any;
    expect(lama?.nama_lengkap).toBe('Anggota Lama');

    const versi = (await db.getFirstAsync(`SELECT version FROM schema_meta WHERE id = 1`)) as any;
    // Bug fix (test): assertion ini basi — mengharapkan versi skema
    // final 38, padahal migrasi v39 (tabel `pinjaman_koperasi`, fitur
    // "Pemberian Pinjaman untuk Koperasi") sudah ditambahkan belakangan
    // (lihat SCHEMA_VERSION di schema.ts & blok `if (currentVersion <
    // 39)` di db.ts). Versi akhir yang benar SEKARANG 39 — perilaku
    // idempoten yang sebenarnya diuji test ini (dijalankan 2x tidak
    // error/berubah) TETAP terverifikasi lewat baris di atas.
    expect(versi?.version).toBe(SCHEMA_VERSION);
  });
});

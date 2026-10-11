import initSqlJs from 'sql.js';

jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { runMigrations } from '@/database/db';
import { CREATE_TABLES_SQL } from '@/database/schema';

/**
 * Revisi KOPKU (Bagian 3A/3B/4) — migrasi v34. Tidak ada perubahan
 * skema (kolom/tabel) di versi ini — hanya akun COA baru ("Pendapatan
 * Hasil Investasi" 4-1300, "Utang Pajak" 2-1900) yang ditambahkan ke
 * DEFAULT_ACCOUNTS dan otomatis di-self-heal ke instalasi lama. Test
 * ini membuktikan instalasi PERSIS di v33 (satu versi sebelum revisi
 * ini, skema sudah identik dengan skema terkini karena v34 tidak
 * mengubah DDL) mendapat kedua akun tersebut setelah upgrade, TANPA
 * menyentuh akun lain yang sudah ada — pola sama persis dengan
 * MigrationV33LhuKlasifikasi.test.ts / v27/v28/v30/v31.
 */
async function createV33Db() {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.run(CREATE_TABLES_SQL);
  raw.run(`CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  raw.run(`INSERT INTO schema_meta (id, version) VALUES (1, 33)`);

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

describe('Migrasi v34 — Revisi KOPKU: akun Pendapatan Hasil Investasi & Utang Pajak (self-heal COA)', () => {
  test('instalasi lama (v33) TANPA kedua akun sama sekali: self-heal menambahkannya, akun lain tidak disentuh', async () => {
    const db = await createV33Db();

    const now = new Date().toISOString();
    // Akun lama yang sudah ada (mewakili instalasi existing) — TIDAK
    // boleh terpengaruh sama sekali oleh migrasi ini.
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
       VALUES ('acc-5-2200','5-2200','Beban Pajak Penghasilan','BEBAN','DEBIT',1,0,NULL,?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
       VALUES ('acc-5-2000','5-2000','Beban Lainnya','BEBAN','DEBIT',1,0,'BEBAN_USAHA',?,?)`,
      now,
      now
    );

    await runMigrations(db as any);

    const hasilInvestasi = (await db.getFirstAsync(
      `SELECT nama, kategori, lhu_klasifikasi, is_system FROM account WHERE kode = '4-1300'`
    )) as { nama: string; kategori: string; lhu_klasifikasi: string | null; is_system: number } | null;
    expect(hasilInvestasi?.nama).toBe('Pendapatan Hasil Investasi');
    expect(hasilInvestasi?.kategori).toBe('PENDAPATAN');
    expect(hasilInvestasi?.lhu_klasifikasi).toBe('HASIL_INVESTASI');
    expect(hasilInvestasi?.is_system).toBe(1);

    const utangPajak = (await db.getFirstAsync(
      `SELECT nama, kategori, is_system FROM account WHERE kode = '2-1900'`
    )) as { nama: string; kategori: string; is_system: number } | null;
    expect(utangPajak?.nama).toBe('Utang Pajak');
    expect(utangPajak?.kategori).toBe('LIABILITAS');
    expect(utangPajak?.is_system).toBe(1);

    // Akun existing tidak disentuh/diduplikasi oleh self-heal.
    const bebanPajak = (await db.getFirstAsync(`SELECT kategori FROM account WHERE id = 'acc-5-2200'`)) as { kategori: string } | null;
    expect(bebanPajak?.kategori).toBe('BEBAN');
    const bebanLainnya = (await db.getFirstAsync(`SELECT nama FROM account WHERE id = 'acc-5-2000'`)) as { nama: string } | null;
    expect(bebanLainnya?.nama).toBe('Beban Lainnya');

    // "Beban Usaha Lainnya" TETAP tidak pernah dibuat — bukan akun baru.
    const bebanUsahaLainnya = await db.getFirstAsync(`SELECT id FROM account WHERE nama = 'Beban Usaha Lainnya'`);
    expect(bebanUsahaLainnya).toBeFalsy();
  });

  test('migrasi v34 idempoten: dijalankan dua kali tidak menduplikasi akun', async () => {
    const db = await createV33Db();
    await runMigrations(db as any);
    await runMigrations(db as any);

    const semuaHasilInvestasi = await db.getAllAsync(`SELECT id FROM account WHERE kode = '4-1300'`);
    expect(semuaHasilInvestasi.length).toBe(1);
    const semuaUtangPajak = await db.getAllAsync(`SELECT id FROM account WHERE kode = '2-1900'`);
    expect(semuaUtangPajak.length).toBe(1);
  });
});

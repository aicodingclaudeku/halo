import initSqlJs from 'sql.js';

jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { runMigrations } from '@/database/db';
import { CREATE_TABLES_SQL } from '@/database/schema';

/**
 * Revisi "Daftar Pendapatan" (audit menu Daftar Pendapatan) — migrasi
 * v36. Tidak ada perubahan skema (kolom/tabel) di versi ini — hanya 5
 * akun COA baru ("Pendapatan Unit Usaha" 4-1400, "Pendapatan Bunga"
 * 4-1500, "Pendapatan Sewa" 4-1600, "Pendapatan Bagi Hasil" 4-1700,
 * "Pendapatan Penjualan Aset" 4-1800) yang ditambahkan ke
 * DEFAULT_ACCOUNTS dan otomatis di-self-heal ke instalasi lama. Test
 * ini membuktikan instalasi PERSIS di v33 (skema sudah identik dengan
 * skema terkini karena v34/v35/v36 tidak mengubah DDL akun) mendapat
 * kelima akun tersebut setelah upgrade, TANPA menyentuh/mengganti kode
 * akun lama mana pun (Bagian 5/18) — pola sama persis dengan
 * MigrationV34.test.ts / v27/v28/v30/v31.
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

const AKUN_BARU_V36: { kode: string; nama: string; lhuKlasifikasi: string }[] = [
  { kode: '4-1400', nama: 'Pendapatan Unit Usaha', lhuKlasifikasi: 'PENDAPATAN_USAHA_LAIN' },
  // Poin 6 — klasifikasi LHU 4-1500 kini PENDAPATAN_USAHA_LAIN.
  { kode: '4-1500', nama: 'Pendapatan Bunga', lhuKlasifikasi: 'PENDAPATAN_USAHA_LAIN' },
  { kode: '4-1600', nama: 'Pendapatan Sewa', lhuKlasifikasi: 'HASIL_INVESTASI' },
  { kode: '4-1700', nama: 'Pendapatan Bagi Hasil', lhuKlasifikasi: 'HASIL_INVESTASI' },
  { kode: '4-1800', nama: 'Pendapatan Penjualan Aset', lhuKlasifikasi: 'PENDAPATAN_LAIN' },
];

describe('Migrasi v36 — Revisi "Daftar Pendapatan": 5 akun Pendapatan baru (self-heal COA)', () => {
  test('instalasi lama (v33) TANPA kelima akun sama sekali: self-heal menambahkannya, akun lama tidak disentuh', async () => {
    const db = await createV33Db();
    const now = new Date().toISOString();

    // Akun lama yang sudah ada (mewakili instalasi existing) — TIDAK
    // boleh terpengaruh sama sekali oleh migrasi ini.
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
       VALUES ('acc-4-1100','4-1100','Pendapatan Administrasi','PENDAPATAN','KREDIT',1,1,'PENDAPATAN_USAHA_LAIN',?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
       VALUES ('acc-4-2000','4-2000','Pendapatan Usaha Lain','PENDAPATAN','KREDIT',1,0,'PENDAPATAN_USAHA_LAIN',?,?)`,
      now,
      now
    );

    await runMigrations(db as any);

    for (const akun of AKUN_BARU_V36) {
      const row = (await db.getFirstAsync(
        `SELECT nama, kategori, lhu_klasifikasi, is_system, is_active FROM account WHERE kode = ?`,
        akun.kode
      )) as { nama: string; kategori: string; lhu_klasifikasi: string | null; is_system: number; is_active: number } | null;
      expect(row?.nama).toBe(akun.nama);
      expect(row?.kategori).toBe('PENDAPATAN');
      expect(row?.lhu_klasifikasi).toBe(akun.lhuKlasifikasi);
      expect(row?.is_system).toBe(0); // Bagian: bukan sistem, harus muncul di dropdown Tambah Transaksi Pendapatan existing
      expect(row?.is_active).toBe(1);
    }

    // Akun lama tidak disentuh/diduplikasi/diganti kodenya.
    const administrasi = (await db.getFirstAsync(`SELECT nama, kode FROM account WHERE id = 'acc-4-1100'`)) as
      | { nama: string; kode: string }
      | null;
    expect(administrasi?.nama).toBe('Pendapatan Administrasi');
    expect(administrasi?.kode).toBe('4-1100');
    const usahaLain = (await db.getFirstAsync(`SELECT nama, kode FROM account WHERE id = 'acc-4-2000'`)) as
      | { nama: string; kode: string }
      | null;
    expect(usahaLain?.nama).toBe('Pendapatan Usaha Lain');
    expect(usahaLain?.kode).toBe('4-2000');
  });

  test('migrasi v36 idempoten: dijalankan dua kali tidak menduplikasi akun', async () => {
    const db = await createV33Db();
    await runMigrations(db as any);
    await runMigrations(db as any);

    for (const akun of AKUN_BARU_V36) {
      const rows = await db.getAllAsync(`SELECT id FROM account WHERE kode = ?`, akun.kode);
      expect(rows.length).toBe(1);
    }
  });

  test('instalasi yang SUDAH punya salah satu akun (nama sudah diubah admin) TIDAK ditimpa self-heal', async () => {
    const db = await createV33Db();
    const now = new Date().toISOString();
    // Admin sudah membuat/mengganti nama akun 4-1400 sendiri sebelum upgrade.
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
       VALUES ('acc-custom-1400','4-1400','Pendapatan Unit Usaha Toko','PENDAPATAN','KREDIT',1,0,'PENDAPATAN_USAHA_LAIN',?,?)`,
      now,
      now
    );

    await runMigrations(db as any);

    const row = (await db.getFirstAsync(`SELECT nama FROM account WHERE kode = '4-1400'`)) as { nama: string } | null;
    expect(row?.nama).toBe('Pendapatan Unit Usaha Toko'); // TIDAK ditimpa
    const semua4_1400 = await db.getAllAsync(`SELECT id FROM account WHERE kode = '4-1400'`);
    expect(semua4_1400.length).toBe(1); // TIDAK terduplikasi
  });
});

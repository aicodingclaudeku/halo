import { createTestDb, TestDb } from './testDb';
import { CREATE_TABLES_SQL_V80 } from './schemaV80Fixture';
import { cadangkanSebelumMigrasi, migrasiV81, namaSalinanPraMigrasi, runMigrations } from '@/database/db';
import { SCHEMA_VERSION } from '@/database/schema';

/**
 * RC-S133.6.2 — MIGRASI v80 -> v81 di atas snapshot skema v80 (RC-S133.6.1)
 * yang sudah berisi data & riwayat import. Membuktikan: aditif, idempoten,
 * data lama utuh, struktur sama dengan instalasi baru, dan migrasi TIDAK
 * berjalan bila salinan pengaman sebelum migrasi gagal dibuat.
 */
let db: TestDb;
const now = new Date().toISOString();

async function isiV80(d: TestDb) {
  await d.execAsync(CREATE_TABLES_SQL_V80);
  await d.execAsync(`CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  await d.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 80)`);
  await d.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('u','A','a','ADMIN','x','x',0,1,?,?)`, now, now
  );
  await d.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('a1','A00001','Siti','2026-01-05','AKTIF',?,?)`, now, now
  );
  await d.runAsync(
    `INSERT INTO import_data_awal_riwayat (id, dijalankan_pada, dijalankan_oleh, nama_berkas, status, total_baris, total_berhasil, total_gagal, ringkasan_json, created_at)
     VALUES ('r1',?, 'u', 'lama.xlsx', 'BERHASIL', 1, 1, 0, '[]', ?)`, now, now
  );
  await d.runAsync(
    `INSERT INTO import_data_awal_log (id, riwayat_id, jenis_sheet, baris, keterangan, status, pesan, created_at)
     VALUES ('l1','r1','ANGGOTA',2,'A00001 — Siti','BERHASIL',NULL,?)`, now
  );
}

beforeEach(async () => {
  db = await createTestDb({ applySchema: false });
  await isiV80(db);
});

test('v80 -> v81 lewat runMigrations: tabel & kolom baru ada, data lama utuh, versi naik ke SCHEMA_VERSION', async () => {
  await runMigrations(db as any);
  expect((await db.getFirstAsync<any>(`SELECT version FROM schema_meta`)).version).toBe(SCHEMA_VERSION);
  const r = await db.getFirstAsync<any>(`SELECT * FROM import_data_awal_riwayat WHERE id = 'r1'`);
  expect(r).toMatchObject({ nama_berkas: 'lama.xlsx', total_berhasil: 1, sidik_berkas: null, total_dilewati: 0 });
  expect((await db.getFirstAsync<any>(`SELECT COUNT(*) n FROM import_data_awal_log`)).n).toBe(1);
  expect((await db.getFirstAsync<any>(`SELECT COUNT(*) n FROM import_data_awal_sidik`)).n).toBe(0);
  expect((await db.getFirstAsync<any>(`SELECT COUNT(*) n FROM koreksi_transaksi`)).n).toBe(0);
  const idx = await db.getAllAsync<any>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_import_sidik_berkas','idx_koreksi_trx_asal','idx_koreksi_trx_pengganti') ORDER BY name`
  );
  expect(idx.map((i: any) => i.name)).toEqual(['idx_import_sidik_berkas', 'idx_koreksi_trx_asal', 'idx_koreksi_trx_pengganti']);
  expect(await db.getAllAsync(`PRAGMA foreign_key_check`)).toEqual([]);
});

test('migrasiV81 idempoten: dijalankan dua kali tanpa galat dan tanpa perubahan data', async () => {
  const tambah = async (t: string, k: string, tipe: string) => {
    try {
      await db.execAsync(`ALTER TABLE ${t} ADD COLUMN ${k} ${tipe};`);
    } catch {
      /* sudah ada */
    }
  };
  await migrasiV81(db as any, tambah);
  await db.runAsync(
    `INSERT INTO import_data_awal_sidik (id, sidik, jenis_sheet, status, baris, created_by, created_at) VALUES ('s1','abc','ANGGOTA','BERHASIL',2,'u',?)`, now
  );
  const sebelum = JSON.stringify(await db.getAllAsync(`SELECT * FROM import_data_awal_sidik`));
  await migrasiV81(db as any, tambah);
  expect(JSON.stringify(await db.getAllAsync(`SELECT * FROM import_data_awal_sidik`))).toBe(sebelum);
  // Sidik unik ditegakkan.
  await expect(
    db.runAsync(`INSERT INTO import_data_awal_sidik (id, sidik, jenis_sheet, status, baris, created_by, created_at) VALUES ('s2','abc','ANGGOTA','BERHASIL',3,'u',?)`, now)
  ).rejects.toThrow(/UNIQUE/);
});

test('struktur hasil migrasi sama dengan instalasi baru', async () => {
  await runMigrations(db as any);
  const baru = await createTestDb();
  for (const t of ['import_data_awal_riwayat', 'import_data_awal_log', 'import_data_awal_sidik', 'koreksi_transaksi']) {
    const a = (await db.getAllAsync<any>(`PRAGMA table_info(${t})`)).map((c: any) => `${c.name}:${c.type}:${c.notnull}`).sort();
    const b = (await baru.getAllAsync<any>(`PRAGMA table_info(${t})`)).map((c: any) => `${c.name}:${c.type}:${c.notnull}`).sort();
    expect(a).toEqual(b);
  }
});

/** Bungkus TestDb: database seolah berbasis berkas; VACUUM INTO dicatat (atau digagalkan). */
function denganBerkas(d: TestDb, opsi: { gagal?: boolean; berkas?: string }) {
  const urutan: string[] = [];
  const w: any = {
    ...d,
    getFirstAsync: d.getFirstAsync.bind(d),
    getAllAsync: async (sql: string, ...p: any[]) => {
      if (/^PRAGMA database_list/i.test(sql.trim())) return [{ seq: 0, name: 'main', file: opsi.berkas ?? '/data/user/0/kopku/files/SQLite/koperasi.db' }];
      return d.getAllAsync(sql, ...p);
    },
    runAsync: d.runAsync.bind(d),
    withTransactionAsync: d.withTransactionAsync.bind(d),
    execAsync: async (sql: string) => {
      if (/^VACUUM INTO/i.test(sql.trim())) {
        urutan.push(sql.trim());
        if (opsi.gagal) throw new Error('disk I/O error');
        return;
      }
      if (/CREATE TABLE IF NOT EXISTS import_data_awal_sidik/.test(sql)) urutan.push('DDL v81');
      return d.execAsync(sql);
    },
  };
  return { w, urutan };
}

test('salinan pengaman dibuat SEBELUM DDL v81, di folder database, bernama pra-migrasi-v80-ke-v81-*', async () => {
  const { w, urutan } = denganBerkas(db, {});
  await runMigrations(w);
  expect(urutan[0]).toMatch(/^VACUUM INTO '\/data\/user\/0\/kopku\/files\/SQLite\/pra-migrasi-v80-ke-v81-\d{8}T\d{6}Z\.db'$/);
  expect(urutan.indexOf('DDL v81')).toBeGreaterThan(0);
});

test('salinan GAGAL -> migrasi dihentikan: versi tetap 80, tabel v81 tidak dibuat, pesan jelas', async () => {
  const { w } = denganBerkas(db, { gagal: true });
  await expect(runMigrations(w)).rejects.toThrow(/v80 ke v81 dihentikan: salinan pengaman .* Data tidak diubah/);
  expect((await db.getFirstAsync<any>(`SELECT version FROM schema_meta`)).version).toBe(80);
  expect(await db.getFirstAsync(`SELECT name FROM sqlite_master WHERE name = 'import_data_awal_sidik'`)).toBe(null);
  // Percobaan berikutnya (salinan berhasil) melanjutkan dari awal.
  const { w: w2 } = denganBerkas(db, {});
  await runMigrations(w2);
  expect((await db.getFirstAsync<any>(`SELECT version FROM schema_meta`)).version).toBe(SCHEMA_VERSION);
});

test('database di memori: tanpa salinan (tidak ada berkas)', async () => {
  expect(await cadangkanSebelumMigrasi(db as any, 80, 81)).toBe(null);
});

test('nama salinan untuk path Windows & POSIX', () => {
  const t = new Date('2026-10-10T08:09:10.123Z');
  expect(namaSalinanPraMigrasi('C:\\Users\\kop\\AppData\\Roaming\\KOPKU\\SQLite\\koperasi.db', 80, 81, t)).toBe(
    'C:\\Users\\kop\\AppData\\Roaming\\KOPKU\\SQLite\\pra-migrasi-v80-ke-v81-20261010T080910Z.db'
  );
  expect(namaSalinanPraMigrasi('/x/y/koperasi.db', 80, 81, t)).toBe('/x/y/pra-migrasi-v80-ke-v81-20261010T080910Z.db');
});

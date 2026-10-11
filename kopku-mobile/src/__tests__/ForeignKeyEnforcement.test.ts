jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import {
  runMigrations,
  configureDatabaseConnection,
  assertForeignKeysEnabled,
} from '@/database/db';
import { SCHEMA_VERSION } from '@/database/schema';
import { bukaKoneksi, ProdLikeDb } from './prodLikeDb';

/**
 * BUG-01 — FOREIGN KEY ENFORCEMENT.
 *
 * Root cause yang diuji di sini: `PRAGMA foreign_keys` adalah setting
 * PER-KONEKSI (default OFF) dan sebelumnya hanya ada di dalam
 * `CREATE_TABLES_SQL`, yang cuma dieksekusi pada jalur fresh install.
 * Artinya launch KEDUA dan seterusnya berjalan tanpa FK enforcement
 * sama sekali, sehingga orphan record bisa masuk ke database produksi.
 *
 * Test ini menutup semua jalur yang disyaratkan tiket: launch #1,
 * launch #2 (setelah close), penolakan orphan, restore, dan migrasi.
 */

async function bacaPragmaFk(db: ProdLikeDb): Promise<number> {
  const row = await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys');
  return Number(row?.foreign_keys ?? 0);
}

/** Meniru `getDb()` untuk satu siklus launch penuh. */
async function launch(bytes?: Uint8Array): Promise<ProdLikeDb> {
  const db = await bukaKoneksi(bytes);
  await configureDatabaseConnection(db as any);
  await runMigrations(db as any);
  await assertForeignKeysEnabled(db as any, 'test launch');
  return db;
}

describe('BUG-01 — foreign key enforcement pada seluruh siklus koneksi', () => {
  test('launch #1 (fresh install): FK ON', async () => {
    const db = await launch();
    expect(await bacaPragmaFk(db)).toBe(1);
    db.close();
  });

  test('launch #2 (setelah close & reopen file yang sama): FK tetap ON', async () => {
    const db1 = await launch();
    const bytes = db1.exportBytes();
    db1.close();

    const db2 = await launch(bytes);
    expect(await bacaPragmaFk(db2)).toBe(1);

    // Skema tidak dimigrasi ulang / tidak turun versi.
    const meta = await db2.getFirstAsync<{ version: number }>(
      'SELECT version FROM schema_meta WHERE id = 1'
    );
    expect(meta?.version).toBe(SCHEMA_VERSION);
    db2.close();
  });

  test('insert orphan ditolak pada launch #2 (bukan cuma launch #1)', async () => {
    const db1 = await launch();
    const bytes = db1.exportBytes();
    db1.close();

    const db2 = await launch(bytes);

    // angsuran_jadwal.pinjaman_id -> pinjaman(id). Referensi ke pinjaman
    // yang tidak ada WAJIB ditolak database, bukan diterima diam-diam.
    await expect(
      db2.runAsync(
        `INSERT INTO angsuran_jadwal
           (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
         VALUES ('aj-orphan','pinjaman-tidak-ada',1,'2026-01-31',100,10,0,110,'BELUM_BAYAR')`
      )
    ).rejects.toThrow(/FOREIGN KEY/i);

    db2.close();
  });

  test('setelah restore (buka file backup sebagai koneksi baru): FK ON', async () => {
    const db1 = await launch();
    const backup = db1.exportBytes(); // "file backup"
    db1.close();

    // Restore = menukar file lalu MEMBUKA KONEKSI BARU.
    const dbRestored = await launch(backup);
    expect(await bacaPragmaFk(dbRestored)).toBe(1);
    dbRestored.close();
  });

  test('setelah migrasi dari database legacy: FK ON dan tidak ada orphan', async () => {
    // Database legacy minimal ala skema v3-era: schema_meta versi lama
    // memaksa runMigrations() melewati SELURUH blok migrasi legacy
    // (termasuk rebuild tabel yang mematikan FK sementara).
    const db = await bukaKoneksi();
    await configureDatabaseConnection(db as any);
    await db.execAsync(`
      CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
      INSERT INTO schema_meta (id, version) VALUES (1, 3);
    `);
    // Struktur wajib dibuat lewat self-heal/CREATE IF NOT EXISTS di
    // runMigrations; yang penting versi < SCHEMA_VERSION.
    await db.execAsync(require('@/database/schema').CREATE_TABLES_SQL);
    await db.runAsync('UPDATE schema_meta SET version = 3');

    await runMigrations(db as any);

    expect(await bacaPragmaFk(db)).toBe(1);
    const pelanggaran = await db.getAllAsync('PRAGMA foreign_key_check');
    expect(pelanggaran).toEqual([]);
    db.close();
  });

  test('assertForeignKeysEnabled gagal keras (bukan diam-diam) saat FK OFF', async () => {
    const db = await bukaKoneksi();
    await db.execAsync('PRAGMA foreign_keys = OFF;');
    await expect(assertForeignKeysEnabled(db as any, 'unit')).rejects.toThrow(
      /foreign_keys tidak aktif/i
    );
    db.close();
  });
});

import initSqlJs, { Database } from 'sql.js';
import type { SQLiteDatabase } from 'expo-sqlite';
import { CREATE_TABLES_SQL } from '@/database/schema';

/**
 * Adapter minimal yang meniru subset API expo-sqlite.SQLiteDatabase
 * (getFirstAsync, getAllAsync, runAsync, execAsync, withTransactionAsync)
 * di atas sql.js (SQLite WASM murni, tanpa native binding) — supaya
 * modul reports/ dan accounting/ bisa diuji dengan SQLite SUNGGUHAN
 * (skema asli dari schema.ts, jurnal asli via AccountingEngine),
 * bukan mock/data dummy.
 */
export interface TestDb {
  getFirstAsync<T = any>(sql: string, ...params: any[]): Promise<T | null>;
  getAllAsync<T = any>(sql: string, ...params: any[]): Promise<T[]>;
  runAsync(sql: string, ...params: any[]): Promise<{ lastInsertRowId: number; changes: number }>;
  execAsync(sql: string): Promise<void>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
  /**
   * Tutup koneksi — dipakai `afterEach` untuk isolasi antar test.
   *
   * RC-S54 TAHAP 6 (harness): kontrak ini SUDAH ada di adapter
   * `.harness/testDb.ts` (node:sqlite) dan dipakai suite RC-S53/S54,
   * tetapi tidak pernah ditambahkan ke adapter resmi Jest ini. Akibatnya
   * suite tersebut gagal DIKOMPILASI ts-jest (TS2339) sebelum satu test
   * pun berjalan. Dipetakan ke `Database.close()` milik sql.js — koneksi
   * benar-benar ditutup, bukan no-op.
   */
  closeSync(): void;
}

/**
 * RC-S72 — opsi pembuatan DB uji. Kontrak ini SUDAH dimiliki adapter harness
 * (`.harness/testDb.ts`) dan dipakai `UpgradeV63KeV64RcS53`, yang membutuhkan
 * database KOSONG untuk membangun skema v63 sendiri sebelum menjalankan
 * migrasi. Default `applySchema = true` — seluruh pemanggil lama tidak berubah.
 */
export interface CreateTestDbOptions {
  readonly applySchema?: boolean;
}

export async function createTestDb(options: CreateTestDbOptions = {}): Promise<TestDb> {
  const SQL = await initSqlJs();
  const db: Database = new SQL.Database();
  if (options.applySchema !== false) {
    db.run(CREATE_TABLES_SQL);
  }

  function flattenParams(params: any[]): any[] {
    // Fungsi di src/ kadang memanggil db.getAllAsync(sql, ...arrayParams, limit, offset)
    // — params sudah flat dari caller, jadi tidak perlu perlakuan khusus di sini.
    return params;
  }

  return {
    async getFirstAsync<T>(sql: string, ...params: any[]): Promise<T | null> {
      const stmt = db.prepare(sql);
      stmt.bind(flattenParams(params));
      const has = stmt.step();
      const result = has ? (stmt.getAsObject() as unknown as T) : null;
      stmt.free();
      return result;
    },
    async getAllAsync<T>(sql: string, ...params: any[]): Promise<T[]> {
      const stmt = db.prepare(sql);
      stmt.bind(flattenParams(params));
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as unknown as T);
      }
      stmt.free();
      return rows;
    },
    async runAsync(sql: string, ...params: any[]) {
      db.run(sql, flattenParams(params));
      return { lastInsertRowId: 0, changes: db.getRowsModified() };
    },
    async execAsync(sql: string) {
      db.run(sql);
    },
    async withTransactionAsync(fn: () => Promise<void>) {
      db.run('BEGIN');
      try {
        await fn();
        db.run('COMMIT');
      } catch (e) {
        db.run('ROLLBACK');
        throw e;
      }
    },
    closeSync() {
      db.close();
    },
  };
}

/**
 * RC-S72 — ADAPTER BERTIPE `TestDb` -> `SQLiteDatabase` untuk service yang
 * menerima koneksi secara eksplisit (`...DenganDb(db, ...)`).
 *
 * JUSTIFIKASI TEKNIS (satu-satunya cast, sengaja dipusatkan di sini alih-alih
 * `as never`/`as any` tersebar di setiap test):
 * `SQLiteDatabase` milik expo-sqlite adalah kelas NATIVE (memegang
 * `nativeDatabase`, `databasePath`, ...) yang tidak dapat diinstansiasi di
 * Node. `TestDb` mengimplementasikan subset API yang benar-benar dipanggil
 * service (`getFirstAsync`, `getAllAsync`, `runAsync`, `execAsync`,
 * `withTransactionAsync`) di atas SQLite sungguhan (sql.js). Pemanggilan
 * anggota lain akan gagal keras saat runtime test — bukan lolos diam-diam.
 */
export function sebagaiSQLiteDatabase(db: TestDb): SQLiteDatabase {
  return db as unknown as SQLiteDatabase;
}

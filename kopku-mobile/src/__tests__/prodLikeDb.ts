import initSqlJs, { Database } from 'sql.js';

/**
 * Adapter SQLite "seperti produksi" untuk menguji SIKLUS HIDUP KONEKSI
 * (BUG-01), bukan cuma query.
 *
 * Bedanya dengan `testDb.ts`:
 *  - `testDb.ts` membuat database dari `CREATE_TABLES_SQL` langsung
 *    (skema terkini, sekali pakai) dan TIDAK pernah menutup/membuka
 *    ulang koneksi.
 *  - helper ini membiarkan isi database di-`export()` menjadi byte lalu
 *    dibuka ULANG sebagai koneksi BARU — persis seperti aplikasi yang
 *    ditutup lalu diluncurkan lagi. Inilah satu-satunya cara menguji
 *    bahwa `PRAGMA foreign_keys` (setting PER-KONEKSI) benar-benar
 *    diterapkan di setiap launch, bukan cuma yang pertama.
 */
export interface ProdLikeDb {
  getFirstAsync<T = any>(sql: string, ...params: any[]): Promise<T | null>;
  getAllAsync<T = any>(sql: string, ...params: any[]): Promise<T[]>;
  runAsync(sql: string, ...params: any[]): Promise<{ lastInsertRowId: number; changes: number }>;
  execAsync(sql: string): Promise<void>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
  /** Snapshot byte file database — dipakai untuk mensimulasikan relaunch. */
  exportBytes(): Uint8Array;
  /** Tutup koneksi (meniru closeDb()). */
  close(): void;
}

function bungkus(raw: Database): ProdLikeDb {
  return {
    async getFirstAsync<T>(sql: string, ...params: any[]): Promise<T | null> {
      const stmt = raw.prepare(sql);
      stmt.bind(params);
      const has = stmt.step();
      const result = has ? (stmt.getAsObject() as unknown as T) : null;
      stmt.free();
      return result;
    },
    async getAllAsync<T>(sql: string, ...params: any[]): Promise<T[]> {
      const stmt = raw.prepare(sql);
      stmt.bind(params);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T);
      stmt.free();
      return rows;
    },
    async runAsync(sql: string, ...params: any[]) {
      raw.run(sql, params);
      return { lastInsertRowId: 0, changes: raw.getRowsModified() };
    },
    async execAsync(sql: string) {
      raw.run(sql);
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
    exportBytes() {
      return raw.export();
    },
    close() {
      raw.close();
    },
  };
}

/** Buka koneksi baru. Tanpa `bytes` = database kosong (first launch). */
export async function bukaKoneksi(bytes?: Uint8Array): Promise<ProdLikeDb> {
  const SQL = await initSqlJs();
  const raw = bytes ? new SQL.Database(bytes) : new SQL.Database();
  return bungkus(raw);
}

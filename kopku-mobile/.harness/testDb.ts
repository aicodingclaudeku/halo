/**
 * TEST DATABASE HARNESS — `node:sqlite`
 * =========================================================================
 *
 * KENAPA BERKAS INI ADA.
 *
 * `src/__tests__/testDb.ts` berjalan di atas `sql.js` (SQLite WASM), dan
 * `sql.js` adalah devDependency. Di lingkungan tempat kode ini ditulis
 * `node_modules` tidak tersedia dan registry npm mengembalikan 403,
 * sehingga SELURUH integration test berbasis database tidak dapat
 * dieksekusi — hanya dapat dibaca. Akibatnya klaim seperti "idempotent"
 * atau "tidak double posting" tidak pernah bisa dibuktikan, padahal
 * justru itu yang paling mahal bila salah.
 *
 * Berkas ini menyediakan adapter yang SAMA PERSIS antarmukanya di atas
 * `node:sqlite` — SQLite sungguhan yang sudah menyatu dengan Node 22,
 * tanpa paket eksternal apa pun.
 *
 * BATAS YANG HARUS DIPEGANG:
 *   - Berkas ini TIDAK PERNAH ikut ter-bundle. Ia berada di `.harness/`,
 *     di luar `src/`, dan tidak ada satu pun modul produksi yang
 *     mengimpornya. `expo-sqlite` tetap satu-satunya engine produksi.
 *   - Ia BUKAN mock akuntansi. SQL-nya benar-benar dieksekusi oleh mesin
 *     SQLite, skemanya diambil dari `schema.ts` produksi, dan jurnalnya
 *     dibuat oleh AccountingEngine yang asli.
 *   - Hasilnya tetap berstatus HARNESS-VERIFIED, bukan JEST-VERIFIED.
 *
 * KOMPATIBILITAS PARAMETER. `node:sqlite` hanya menerima null, number,
 * bigint, string, dan Uint8Array. Kode produksi kadang mengirim
 * `undefined` (kolom opsional) dan `boolean` (flag is_active). Keduanya
 * dinormalisasi di satu tempat — lihat `normalisasiParam()` — supaya
 * kegagalan tipe tidak menyamar sebagai kegagalan logika bisnis.
 */

import { DatabaseSync } from 'node:sqlite';
import { CREATE_TABLES_SQL } from '@/database/schema';

export interface TestDb {
  getFirstAsync<T = any>(sql: string, ...params: any[]): Promise<T | null>;
  getAllAsync<T = any>(sql: string, ...params: any[]): Promise<T[]>;
  runAsync(sql: string, ...params: any[]): Promise<{ lastInsertRowId: number; changes: number }>;
  execAsync(sql: string): Promise<void>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
  /** Tutup koneksi — dipakai `afterEach` untuk isolasi antar test. */
  closeSync(): void;
}

/**
 * Normalisasi satu parameter ke tipe yang diterima `node:sqlite`.
 *
 * `undefined -> null` disengaja: di `expo-sqlite` keduanya sama-sama
 * menjadi NULL, jadi menolaknya di sini akan membuat harness lebih ketat
 * daripada produksi dan memunculkan kegagalan yang tidak akan pernah
 * terjadi di perangkat.
 */
function normalisasiParam(nilai: unknown): null | number | bigint | string | Uint8Array {
  if (nilai === undefined || nilai === null) return null;
  if (typeof nilai === 'boolean') return nilai ? 1 : 0;
  if (nilai instanceof Date) return nilai.toISOString();
  if (
    typeof nilai === 'number' ||
    typeof nilai === 'bigint' ||
    typeof nilai === 'string' ||
    nilai instanceof Uint8Array
  ) {
    return nilai;
  }
  // Objek/array yang tidak dikenali adalah KESALAHAN PEMANGGIL, bukan
  // sesuatu yang boleh diam-diam di-JSON-kan: melakukannya akan
  // menyimpan "[object Object]" ke kolom dan membuat test hijau di atas
  // data yang salah.
  throw new TypeError(
    `Parameter SQL bertipe ${typeof nilai} tidak didukung: ${String(nilai)}`
  );
}

function normalisasiParams(params: unknown[]): (null | number | bigint | string | Uint8Array)[] {
  return params.map(normalisasiParam);
}

/** `lastInsertRowid` bisa bigint; kode pemanggil mengharap number. */
function keNumber(nilai: number | bigint): number {
  return typeof nilai === 'bigint' ? Number(nilai) : nilai;
}

export interface CreateTestDbOptions {
  /**
   * Terapkan skema produksi. Default true. Dimatikan hanya oleh test
   * yang memang ingin membuktikan sesuatu tentang database KOSONG.
   */
  readonly applySchema?: boolean;
}

export async function createTestDb(options: CreateTestDbOptions = {}): Promise<TestDb> {
  const db = new DatabaseSync(':memory:');

  // Foreign key DIAKTIFKAN, sama seperti `db.ts` produksi. Tanpa ini
  // pelanggaran relasi lolos diam-diam di test dan baru meledak di
  // perangkat — kebalikan dari guna sebuah test.
  db.exec('PRAGMA foreign_keys = ON');

  if (options.applySchema !== false) {
    db.exec(CREATE_TABLES_SQL);
  }

  /**
   * Kedalaman transaksi. `withTransactionAsync` bisa bersarang ketika
   * satu service memanggil service lain yang juga membuka transaksi.
   * SQLite menolak BEGIN di dalam BEGIN, jadi hanya level terluar yang
   * benar-benar membuka/menutup transaksi — perilaku yang sama dengan
   * `withTransaction()` produksi.
   */
  let kedalaman = 0;

  const adapter: TestDb = {
    async getFirstAsync<T>(sql: string, ...params: any[]): Promise<T | null> {
      const stmt = db.prepare(sql);
      const row = stmt.get(...normalisasiParams(params));
      return (row as T | undefined) ?? null;
    },

    async getAllAsync<T>(sql: string, ...params: any[]): Promise<T[]> {
      const stmt = db.prepare(sql);
      return stmt.all(...normalisasiParams(params)) as T[];
    },

    async runAsync(sql: string, ...params: any[]) {
      const stmt = db.prepare(sql);
      const hasil = stmt.run(...normalisasiParams(params));
      return {
        lastInsertRowId: keNumber(hasil.lastInsertRowid),
        changes: keNumber(hasil.changes),
      };
    },

    async execAsync(sql: string) {
      db.exec(sql);
    },

    async withTransactionAsync(fn: () => Promise<void>) {
      if (kedalaman > 0) {
        // Transaksi bersarang: ikut transaksi terluar. Kegagalan tetap
        // naik ke pemanggil, sehingga ROLLBACK terluar tetap terjadi.
        kedalaman += 1;
        try {
          await fn();
        } finally {
          kedalaman -= 1;
        }
        return;
      }
      db.exec('BEGIN');
      kedalaman = 1;
      try {
        await fn();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        kedalaman = 0;
      }
    },

    closeSync() {
      db.close();
    },
  };

  return adapter;
}

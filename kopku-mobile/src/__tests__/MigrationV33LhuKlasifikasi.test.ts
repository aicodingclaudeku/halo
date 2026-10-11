import initSqlJs from 'sql.js';

jest.mock('expo-sqlite', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import { runMigrations } from '@/database/db';
import { CREATE_TABLES_SQL } from '@/database/schema';

/**
 * Revisi LHU KOPKU — migrasi v33 (kolom `lhu_klasifikasi` di `account`
 * + backfill klasifikasi default). Test ini FOKUS pada backfill akun
 * yang SUDAH ADA sebelum migrasi (skenario yang tidak tercakup
 * FullMigration.test.ts, yang legacy fixture-nya tidak pre-seed akun
 * Pendapatan/Beban default) — membuktikan dua hal:
 *  1. Akun lama tanpa kolom `lhu_klasifikasi` sama sekali mendapat
 *     klasifikasi default yang benar setelah migrasi.
 *  2. Klasifikasi yang SUDAH diatur admin sebelumnya (mis. lewat Input
 *     Akun) TIDAK ditimpa (Bagian H: "jangan meminta user memilih
 *     ulang").
 *
 * Fixture dibangun dari CREATE_TABLES_SQL TERKINI (semua tabel lain
 * sudah lengkap, konsisten dengan v32) MINUS kolom/CHECK
 * `lhu_klasifikasi` di tabel `account` — mensimulasikan instalasi PERSIS
 * di v32 (satu versi sebelum revisi ini), bukan v3-era penuh (yang
 * butuh fixture jauh lebih besar untuk migrasi v2-v32 lain yang di
 * luar cakupan test ini).
 */
async function createV32Db() {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();

  const legacySql = CREATE_TABLES_SQL.replace(
    /\s*-- Revisi LHU[\s\S]*?lhu_klasifikasi TEXT CHECK \([\s\S]*?\)\),\n/,
    '\n'
  );
  // Pastikan penghapusan di atas benar-benar berhasil (kalau komentar/
  // format schema.ts berubah, test ini harus GAGAL jelas, bukan diam-
  // diam menguji skenario yang salah).
  if (legacySql.includes('lhu_klasifikasi')) {
    throw new Error('Gagal mensimulasikan skema v32 — kolom lhu_klasifikasi masih ada di fixture.');
  }
  raw.run(legacySql);
  raw.run(`CREATE TABLE schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`);
  raw.run(`INSERT INTO schema_meta (id, version) VALUES (1, 32)`);

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

describe('Migrasi v33 — Revisi LHU KOPKU: kolom & backfill lhu_klasifikasi', () => {
  test('akun lama (skema v32, TANPA kolom lhu_klasifikasi) dibackfill benar & akun kustom tidak disentuh', async () => {
    const db = await createV32Db();

    const now = new Date().toISOString();
    // Akun default lama (belum punya kolom lhu_klasifikasi sama sekali).
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-4-1100','4-1100','Pendapatan Administrasi','PENDAPATAN','KREDIT',1,1,?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-5-1100','5-1100','Beban Gaji','BEBAN','DEBIT',1,0,?,?)`,
      now,
      now
    );
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-4-1000','4-1000','Pendapatan Jasa Pinjaman','PENDAPATAN','KREDIT',1,1,?,?)`,
      now,
      now
    );
    // Akun kustom admin (BUKAN salah satu kode default 4-1100/4-1200/
    // 4-2000/4-3000/5-2150) — backfill hanya menyentuh kode default
    // yang eksplisit disebut, jadi akun ini otomatis aman/tidak disentuh.
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-9-9999','9-9999','Pendapatan Kustom Koperasi','PENDAPATAN','KREDIT',1,0,?,?)`,
      now,
      now
    );

    await runMigrations(db as any);

    const admin = await db.getFirstAsync(`SELECT lhu_klasifikasi FROM account WHERE id = 'acc-4-1100'`);
    expect((admin as any).lhu_klasifikasi).toBe('PENDAPATAN_USAHA_LAIN');

    const gaji = await db.getFirstAsync(`SELECT lhu_klasifikasi FROM account WHERE id = 'acc-5-1100'`);
    expect((gaji as any).lhu_klasifikasi).toBe('BEBAN_USAHA');

    // 4-1000 (Pendapatan Jasa Pinjaman) SENGAJA tetap NULL — baris
    // tersendiri di LHU, bukan bagian klasifikasi manapun.
    const jasaPinjaman = await db.getFirstAsync(`SELECT lhu_klasifikasi FROM account WHERE id = 'acc-4-1000'`);
    expect((jasaPinjaman as any).lhu_klasifikasi).toBeFalsy();

    // Akun kustom yang bukan salah satu kode default (9-9999) tidak
    // pernah disentuh backfill sama sekali — tetap NULL sampai admin
    // mengaturnya sendiri lewat Input Akun (Bagian H).
    const kustom = await db.getFirstAsync(`SELECT lhu_klasifikasi FROM account WHERE id = 'acc-9-9999'`);
    expect((kustom as any).lhu_klasifikasi).toBeFalsy();
  });

  test('backfill TIDAK menimpa klasifikasi yang sudah diatur admin sebelumnya (idempoten & aman terhadap kustomisasi)', async () => {
    const db = await createV32Db();

    const now = new Date().toISOString();
    // Admin sudah mengubah "Pendapatan Usaha Lain" (4-2000) dari default
    // PENDAPATAN_USAHA_LAIN menjadi PENDAPATAN_LAIN secara manual —
    // disimulasikan dengan menjalankan migrasi SEKALI dulu lalu
    // mengubah nilainya secara manual, baru migrasi dijalankan lagi
    // (simulasi app dibuka ulang setelah admin mengubah klasifikasi).
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-4-2000','4-2000','Pendapatan Usaha Lain','PENDAPATAN','KREDIT',1,0,?,?)`,
      now,
      now
    );
    await runMigrations(db as any); // migrasi pertama -> otomatis PENDAPATAN_USAHA_LAIN
    let row = await db.getFirstAsync(`SELECT lhu_klasifikasi FROM account WHERE id = 'acc-4-2000'`);
    expect((row as any).lhu_klasifikasi).toBe('PENDAPATAN_USAHA_LAIN');

    // Admin mengubah manual jadi PENDAPATAN_LAIN.
    await db.runAsync(`UPDATE account SET lhu_klasifikasi = 'PENDAPATAN_LAIN' WHERE id = 'acc-4-2000'`);

    await runMigrations(db as any); // migrasi kedua (app dibuka ulang) -> TIDAK boleh menimpa balik
    row = await db.getFirstAsync(`SELECT lhu_klasifikasi FROM account WHERE id = 'acc-4-2000'`);
    expect((row as any).lhu_klasifikasi).toBe('PENDAPATAN_LAIN'); // TIDAK ditimpa balik ke default
  });
});

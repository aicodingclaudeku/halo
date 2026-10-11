/**
 * Mock Jest untuk `expo-sqlite` & `expo-file-system/legacy`.
 *
 * Ditemukan saat verifikasi Revisi LHU KOPKU: kedua paket ini di-ship
 * sebagai ESM murni (native module Expo, sama seperti `expo-crypto` —
 * lihat expoCryptoMock.ts) dan tidak melalui Metro/Babel saat dijalankan
 * lewat Jest (preset proyek ini `ts-jest`), sehingga Jest gagal
 * mem-parsingnya ("Unexpected token 'export'") begitu ada modul manapun
 * yang transitif meng-import `@/database/db.ts` (mis.
 * `FinancialReports.ts -> AccountingPolicyService.ts -> database/db.ts`).
 *
 * PENTING: mock ini SENGAJA hanya stub kosong. Tidak ada satupun test di
 * proyek ini yang benar-benar memanggil `getDb()`/runtime expo-sqlite
 * sungguhan — semua test yang butuh database SUNGGUHAN memakai
 * `testDb.ts` (SQLite via sql.js/WASM, skema asli dari schema.ts).
 * `db.ts` hanya diimpor secara TRANSITIF oleh service-service yang
 * dipanggil FinancialReports.ts untuk fungsi MURNI (mis. label
 * kebijakan) yang tidak pernah menyentuh `getDb()` di jalur yang dites.
 * Kalau ada test yang TIDAK SENGAJA memanggil fungsi yang benar-benar
 * butuh `getDb()` asli, mock ini akan gagal jelas (bukan diam-diam
 * mengembalikan data palsu) karena method-nya melempar error eksplisit.
 */

export class SQLiteDatabase {
  async getFirstAsync(): Promise<never> {
    throw new Error('expo-sqlite mock dipanggil di test — pakai testDb.ts (sql.js) untuk test yang butuh database sungguhan.');
  }
  async getAllAsync(): Promise<never> {
    throw new Error('expo-sqlite mock dipanggil di test — pakai testDb.ts (sql.js) untuk test yang butuh database sungguhan.');
  }
  async runAsync(): Promise<never> {
    throw new Error('expo-sqlite mock dipanggil di test — pakai testDb.ts (sql.js) untuk test yang butuh database sungguhan.');
  }
  async execAsync(): Promise<never> {
    throw new Error('expo-sqlite mock dipanggil di test — pakai testDb.ts (sql.js) untuk test yang butuh database sungguhan.');
  }
  async withTransactionAsync(): Promise<never> {
    throw new Error('expo-sqlite mock dipanggil di test — pakai testDb.ts (sql.js) untuk test yang butuh database sungguhan.');
  }
}

export async function openDatabaseAsync(): Promise<SQLiteDatabase> {
  throw new Error('expo-sqlite mock dipanggil di test — pakai testDb.ts (sql.js) untuk test yang butuh database sungguhan.');
}

export const documentDirectory = '/mock/';

export async function getInfoAsync(): Promise<{ exists: boolean }> {
  return { exists: false };
}

export default {};

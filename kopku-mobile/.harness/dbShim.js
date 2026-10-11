'use strict';
/**
 * PROXY `@/database/db` untuk harness.
 *
 * `jest.mock('@/database/db', factory)` di runner harness menaruh hasil
 * factory di `globalThis.__HARNESS_DB_IMPL__`. Modul produksi sudah
 * terlanjur memegang referensi ke objek exports ini, jadi delegasinya
 * harus dinamis — bukan disalin sekali saat require.
 *
 * Bila tidak ada implementasi terdaftar, jatuh ke modul db yang asli
 * (hasil emit), supaya suite yang memang menguji migrasi tetap berjalan.
 */
const asli = require('./build3/src/database/db.js');

module.exports = new Proxy(
  {},
  {
    get(_t, prop) {
      const impl = globalThis.__HARNESS_DB_IMPL__;
      if (impl && prop in impl) return impl[prop];
      return asli[prop];
    },
    has(_t, prop) {
      const impl = globalThis.__HARNESS_DB_IMPL__;
      return (impl && prop in impl) || prop in asli;
    },
    ownKeys() {
      const impl = globalThis.__HARNESS_DB_IMPL__ || {};
      return [...new Set([...Reflect.ownKeys(asli), ...Reflect.ownKeys(impl)])];
    },
    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true };
    },
  }
);

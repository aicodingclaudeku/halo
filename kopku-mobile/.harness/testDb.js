'use strict';
/** Adapter node:sqlite yang meniru subset API expo-sqlite, pengganti sql.js. */
const { DatabaseSync } = require('node:sqlite');
const { CREATE_TABLES_SQL } = require('./build3/src/database/schema.js');

function norm(p) {
  if (p === undefined || p === null) return null;
  if (typeof p === 'boolean') return p ? 1 : 0;
  if (typeof p === 'number') return Number.isInteger(p) ? p : p;
  return p;
}
async function createTestDb(opts) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  if (!opts || opts.applySchema !== false) db.exec(CREATE_TABLES_SQL);
  const flat = (params) => params.flat ? params.flat(2).map(norm) : params.map(norm);
  return {
    async getFirstAsync(sql, ...params) {
      const r = db.prepare(sql).all(...flat(params));
      return r.length ? r[0] : null;
    },
    async getAllAsync(sql, ...params) {
      return db.prepare(sql).all(...flat(params));
    },
    async runAsync(sql, ...params) {
      const r = db.prepare(sql).run(...flat(params));
      return { lastInsertRowId: Number(r.lastInsertRowid || 0), changes: Number(r.changes || 0) };
    },
    async execAsync(sql) { db.exec(sql); },
    async withTransactionAsync(fn) {
      db.exec('BEGIN');
      try { await fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    closeSync() { try { db.close(); } catch {} },
    __raw: db,
  };
}
module.exports = { createTestDb, default: { createTestDb } };

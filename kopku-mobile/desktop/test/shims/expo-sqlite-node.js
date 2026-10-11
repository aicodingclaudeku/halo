'use strict';
// Adaptor uji Node: permukaan expo-sqlite di atas SqliteHost (node:sqlite) yang
// sama persis dengan yang dipakai proses utama Electron.
const { SqliteHost } = require('../../electron/hosts/sqliteHost.js');
const path = require('node:path');
const host = new SqliteHost(process.env.KOPKU_TEST_DB_DIR || path.join(require('node:os').tmpdir(), 'kopku-test', 'SQLite'));
class SQLiteDatabase {
  constructor(name, id) { this.databaseName = name; this._id = id; }
  async execAsync(sql) { host.exec(this._id, sql); }
  async runAsync(sql, ...p) { return host.run(this._id, sql, p); }
  async getFirstAsync(sql, ...p) { return host.get(this._id, sql, p); }
  async getAllAsync(sql, ...p) { return host.all(this._id, sql, p); }
  async withTransactionAsync(task) {
    await this.execAsync('BEGIN');
    try { await task(); await this.execAsync('COMMIT'); } catch (e) { await this.execAsync('ROLLBACK'); throw e; }
  }
  async closeAsync() { host.close(this._id); }
}
async function openDatabaseAsync(name, _opts, dir) { const { id } = host.open(name, dir); return new SQLiteDatabase(name, id); }
module.exports = { openDatabaseAsync, SQLiteDatabase, __host: host };

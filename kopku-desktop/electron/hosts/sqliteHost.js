'use strict';
/**
 * KOPKU Desktop — HOST SQLITE (proses utama Electron).
 *
 * Menyediakan permukaan API yang sama dengan `expo-sqlite` yang dipakai
 * aplikasi Android (openDatabaseAsync / execAsync / runAsync /
 * getFirstAsync / getAllAsync / closeAsync), di atas `node:sqlite`
 * bawaan Node 24 yang ikut di Electron 44. Konsekuensinya:
 *
 *   - Berkas database adalah SQLite ASLI di disk (WAL, foreign key,
 *     JSON1) — format berkasnya identik dengan yang dibuat HP, sehingga
 *     backup HP dapat dipulihkan di desktop dan sebaliknya.
 *   - Tidak ada modul native yang harus dikompilasi silang untuk
 *     Windows/macOS (node:sqlite dikompilasi ke dalam Electron).
 *
 * Seluruh pemanggilan berjalan SINKRON di proses utama, berurutan per
 * kanal IPC — sama seperti antrian native expo-sqlite yang memproses
 * pemanggilan satu per satu. Transaksi (`withTransactionAsync`) diatur
 * di renderer persis seperti implementasi expo-sqlite (BEGIN → tugas →
 * COMMIT/ROLLBACK).
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const MAX_CACHED_STATEMENTS = 256;

class SqliteHost {
  /** @param {string} defaultDir folder default (padanan `documentDirectory/SQLite/`) */
  constructor(defaultDir) {
    this.defaultDir = defaultDir;
    this.handles = new Map();
    this.nextId = 1;
  }

  resolvePath(name, directory) {
    if (name === ':memory:') return name;
    const dir = directory || this.defaultDir;
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
  }

  open(name, directory) {
    const file = this.resolvePath(name, directory);
    const db = new DatabaseSync(file, { enableForeignKeyConstraints: false });
    const id = this.nextId++;
    this.handles.set(id, { db, file, stmts: new Map() });
    return { id, file };
  }

  _h(id) {
    const h = this.handles.get(id);
    if (!h) {
      const e = new Error('Database sudah ditutup (AccessClosedResourceException).');
      e.code = 'ERR_DB_CLOSED';
      throw e;
    }
    return h;
  }

  _stmt(h, sql) {
    let st = h.stmts.get(sql);
    if (st) {
      // LRU sederhana: pindahkan ke akhir.
      h.stmts.delete(sql);
      h.stmts.set(sql, st);
      return st;
    }
    st = h.db.prepare(sql);
    h.stmts.set(sql, st);
    if (h.stmts.size > MAX_CACHED_STATEMENTS) {
      const first = h.stmts.keys().next().value;
      h.stmts.delete(first);
    }
    return st;
  }

  exec(id, sql) {
    const h = this._h(id);
    h.db.exec(sql);
    // Pernyataan ter-cache bisa basi setelah DDL; SQLite menyiapkan ulang
    // otomatis, tetapi kita kosongkan cache agar memori tidak menahan
    // pernyataan atas tabel yang sudah di-drop.
    if (/\b(DROP|ALTER|CREATE)\b/i.test(sql)) h.stmts.clear();
  }

  run(id, sql, params) {
    const h = this._h(id);
    const st = this._stmt(h, sql);
    const r = bind(st, 'run', params);
    return { lastInsertRowId: Number(r.lastInsertRowid ?? 0), changes: Number(r.changes ?? 0) };
  }

  get(id, sql, params) {
    const h = this._h(id);
    const st = this._stmt(h, sql);
    const row = bind(st, 'get', params);
    return row === undefined ? null : plain(row);
  }

  all(id, sql, params) {
    const h = this._h(id);
    const st = this._stmt(h, sql);
    const rows = bind(st, 'all', params);
    return rows.map(plain);
  }

  close(id) {
    const h = this.handles.get(id);
    if (!h) return;
    h.stmts.clear();
    try {
      h.db.close();
    } finally {
      this.handles.delete(id);
    }
  }

  closeAll() {
    for (const id of [...this.handles.keys()]) this.close(id);
  }

  /** Salinan konsisten database aktif (dipakai sinkronisasi snapshot). */
  snapshotTo(id, targetFile) {
    const h = this._h(id);
    try { fs.unlinkSync(targetFile); } catch { /* tidak ada */ }
    h.db.exec(`VACUUM INTO '${targetFile.replace(/'/g, "''")}'`);
  }
}

function conv(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v;
}

/**
 * Normalisasi parameter persis seperti expo-sqlite:
 *   runAsync(sql, a, b)          -> anonim [a, b]
 *   runAsync(sql, [a, b])        -> anonim [a, b]
 *   runAsync(sql, { $x: 1 })     -> bernama
 */
function bind(st, method, params) {
  const list = Array.isArray(params) ? params : [];
  if (list.length === 1 && list[0] !== null && typeof list[0] === 'object' && !(list[0] instanceof Uint8Array) && !(list[0] instanceof Date)) {
    const p = list[0];
    if (Array.isArray(p)) return st[method](...p.map(conv));
    const named = {};
    for (const [k, v] of Object.entries(p)) named[k.replace(/^[$:@]/, '')] = conv(v);
    return st[method](named);
  }
  return st[method](...list.map(conv));
}

function plain(row) {
  const o = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    o[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return o;
}

module.exports = { SqliteHost };

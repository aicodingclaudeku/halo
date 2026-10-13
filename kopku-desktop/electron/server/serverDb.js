'use strict';
/**
 * KOPKU LAN SERVER — DATABASE OPERASIONAL SERVER (`kopku-server.db`).
 *
 * SENGAJA TERPISAH dari `koperasi.db`:
 *   - `koperasi.db` (schema v80) dimiliki migration system KOPKU yang
 *     ada di bundle renderer. Menambah tabel di sana mengubah versi
 *     schema, berkas backup, dan sinkron HP — itu di luar cakupan modul
 *     tambahan ini.
 *   - Berkas ini hanya berisi data OPERASIONAL server: akses LAN per user,
 *     sesi, percobaan login gagal, audit aktivitas LAN, kunci idempotensi,
 *     pengaturan & log WhatsApp Reminder. Tidak ada data akuntansi.
 *
 * Migration: berurutan, ADITIF, idempoten (CREATE ... IF NOT EXISTS),
 * dicatat di `server_meta.version`. Tidak pernah DROP/DELETE data.
 * Sebelum menaikkan versi, salinan berkas dibuat (`.bak-v<lama>`).
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SERVER_SCHEMA_VERSION = 1;

const MIGRASI = {
  1: `
    CREATE TABLE IF NOT EXISTS lan_akses (
      user_id     TEXT PRIMARY KEY,
      aktif       INTEGER NOT NULL DEFAULT 0 CHECK (aktif IN (0,1)),
      profil      TEXT NOT NULL DEFAULT 'IKUT_ROLE' CHECK (profil IN ('IKUT_ROLE','PENGAWAS')),
      diubah_oleh TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sesi (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      csrf         TEXT NOT NULL,
      ip           TEXT,
      user_agent   TEXT,
      created_at   TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      revoked_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sesi_user ON sesi(user_id);

    CREATE TABLE IF NOT EXISTS login_gagal (
      kunci        TEXT PRIMARY KEY,
      jumlah       INTEGER NOT NULL DEFAULT 0,
      pertama_at   TEXT NOT NULL,
      terakhir_at  TEXT NOT NULL,
      kunci_sampai TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_lan (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      waktu     TEXT NOT NULL,
      user_id   TEXT,
      username  TEXT,
      action    TEXT NOT NULL,
      entity    TEXT,
      entity_id TEXT,
      status    TEXT NOT NULL CHECK (status IN ('BERHASIL','GAGAL','DITOLAK')),
      ip        TEXT,
      metadata  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_lan_waktu ON audit_lan(waktu);

    CREATE TABLE IF NOT EXISTS idempotensi (
      kunci       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      rute        TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('PROSES','SELESAI')),
      http_status INTEGER,
      respons     TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pengaturan (
      kunci      TEXT PRIMARY KEY,
      nilai      TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS whatsapp_notifications (
      id                  TEXT PRIMARY KEY,
      anggota_id          TEXT,
      pinjaman_id         TEXT,
      jadwal_id           TEXT,
      nama_anggota        TEXT,
      nomor_pinjaman      TEXT,
      angsuran_ke         INTEGER,
      tanggal_jatuh_tempo TEXT,
      jenis_notifikasi    TEXT NOT NULL CHECK (jenis_notifikasi IN ('H_MIN_3','H_MIN_1','H','H_PLUS_1','H_PLUS_7','TEST')),
      tanggal_jadwal      TEXT NOT NULL,
      nomor_tujuan        TEXT,
      nomor_masked        TEXT,
      sisa_tagihan        INTEGER,
      status              TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','skipped')),
      percobaan           INTEGER NOT NULL DEFAULT 0,
      berikutnya_at       TEXT,
      provider_message_id TEXT,
      sent_at             TEXT,
      error_kode          TEXT,
      error_message       TEXT,
      dibuat_oleh         TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      UNIQUE (pinjaman_id, jenis_notifikasi, tanggal_jadwal)
    );
    CREATE INDEX IF NOT EXISTS idx_wa_status ON whatsapp_notifications(status, berikutnya_at);
    CREATE INDEX IF NOT EXISTS idx_wa_jadwal ON whatsapp_notifications(tanggal_jadwal);

    CREATE TABLE IF NOT EXISTS scheduler_lease (
      nama    TEXT PRIMARY KEY,
      pemilik TEXT NOT NULL,
      sampai  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduler_run (
      tanggal    TEXT PRIMARY KEY,
      mulai_at   TEXT NOT NULL,
      selesai_at TEXT,
      ringkasan  TEXT
    );
  `,
};

class ServerDb {
  /** @param {string} file path berkas, atau ':memory:' */
  constructor(file) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrasi();
  }

  versi() {
    this.db.exec('CREATE TABLE IF NOT EXISTS server_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);');
    const r = this.db.prepare('SELECT version FROM server_meta WHERE id = 1').get();
    return r ? Number(r.version) : 0;
  }

  migrasi() {
    const sekarang = this.versi();
    if (sekarang > SERVER_SCHEMA_VERSION) {
      throw new Error(`kopku-server.db berversi ${sekarang}, lebih baru dari aplikasi (${SERVER_SCHEMA_VERSION}). Gunakan versi KOPKU Desktop yang sama atau lebih baru.`);
    }
    if (sekarang > 0 && sekarang < SERVER_SCHEMA_VERSION && this.file !== ':memory:') {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        fs.copyFileSync(this.file, `${this.file}.bak-v${sekarang}`);
      } catch {
        /* backup gagal tidak menghentikan migrasi aditif */
      }
    }
    for (let v = sekarang + 1; v <= SERVER_SCHEMA_VERSION; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRASI[v]);
        this.db.prepare('INSERT INTO server_meta (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version').run(v);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    // Idempoten: jalankan ulang DDL versi terkini (semua IF NOT EXISTS).
    for (let v = 1; v <= SERVER_SCHEMA_VERSION; v++) this.db.exec(MIGRASI[v]);
  }

  run(sql, ...p) {
    return this.db.prepare(sql).run(...p.map(conv));
  }
  get(sql, ...p) {
    const r = this.db.prepare(sql).get(...p.map(conv));
    return r === undefined ? null : plain(r);
  }
  all(sql, ...p) {
    return this.db.prepare(sql).all(...p.map(conv)).map(plain);
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getPengaturan(kunci, bawaan = null) {
    const r = this.get('SELECT nilai FROM pengaturan WHERE kunci = ?', kunci);
    if (!r) return bawaan;
    try {
      return JSON.parse(r.nilai);
    } catch {
      return bawaan;
    }
  }
  setPengaturan(kunci, nilai, oleh) {
    this.run(
      'INSERT INTO pengaturan (kunci, nilai, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(kunci) DO UPDATE SET nilai = excluded.nilai, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      kunci,
      JSON.stringify(nilai),
      new Date().toISOString(),
      oleh || null
    );
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* sudah ditutup */
    }
  }
}

function conv(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
function plain(row) {
  const o = {};
  for (const k of Object.keys(row)) o[k] = typeof row[k] === 'bigint' ? Number(row[k]) : row[k];
  return o;
}

module.exports = { ServerDb, SERVER_SCHEMA_VERSION };

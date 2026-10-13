'use strict';
/**
 * KOPKU LAN SERVER — AUDIT LOG LAN & LOGGER AMAN.
 *
 * Audit aktivitas TRANSAKSI bisnis tetap ditulis oleh service KOPKU ke
 * `audit_log` di koperasi.db (dengan user_id yang login lewat LAN).
 * Tabel `audit_lan` (kopku-server.db) mencatat aktivitas KHAS multi-user:
 * login, logout, login gagal, akses ditolak, setiap permintaan ubah data
 * via LAN (berhasil/gagal), perubahan akses LAN & konfigurasi WhatsApp/server.
 *
 * Metadata selalu dibersihkan: kunci yang mirip password/token/secret/pin/
 * cookie/authorization dibuang, dan nilai yang mirip token Bearer/JWT/token
 * Meta (EAA...) disamarkan.
 */
const fs = require('node:fs');
const path = require('node:path');

const KUNCI_RAHASIA = /pass|token|secret|pin\b|pin_|cookie|authorization|csrf|kredensial|credential|salt|hash/i;
const POLA_RAHASIA = [/Bearer\s+[A-Za-z0-9._\-]+/gi, /\bEAA[A-Za-z0-9]{10,}/g, /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, /access_token=[^&\s"]+/gi];

function samarkanTeks(s, rahasiaTambahan = []) {
  let t = String(s);
  for (const r of rahasiaTambahan) if (r && String(r).length >= 6) t = t.split(String(r)).join('[DISAMARKAN]');
  for (const p of POLA_RAHASIA) t = t.replace(p, '[DISAMARKAN]');
  return t;
}

function bersihkan(nilai, kedalaman = 0) {
  if (nilai == null) return nilai;
  if (kedalaman > 4) return '[...]';
  if (typeof nilai === 'string') return samarkanTeks(nilai).slice(0, 500);
  if (typeof nilai !== 'object') return nilai;
  if (Array.isArray(nilai)) return nilai.slice(0, 20).map((v) => bersihkan(v, kedalaman + 1));
  const out = {};
  for (const [k, v] of Object.entries(nilai)) {
    if (KUNCI_RAHASIA.test(k)) continue;
    out[k] = bersihkan(v, kedalaman + 1);
  }
  return out;
}

class AuditLan {
  constructor(db, now = () => Date.now()) {
    this.db = db;
    this.now = now;
  }
  catat({ userId = null, username = null, action, entity = null, entityId = null, status = 'BERHASIL', ip = null, metadata = null }) {
    try {
      this.db.run(
        'INSERT INTO audit_lan (waktu, user_id, username, action, entity, entity_id, status, ip, metadata) VALUES (?,?,?,?,?,?,?,?,?)',
        new Date(this.now()).toISOString(),
        userId,
        username,
        String(action).slice(0, 60),
        entity,
        entityId == null ? null : String(entityId).slice(0, 80),
        status,
        ip,
        metadata == null ? null : JSON.stringify(bersihkan(metadata)).slice(0, 4000)
      );
    } catch {
      /* audit tidak boleh menjatuhkan request */
    }
  }
  daftar({ limit = 100, offset = 0, action = null, userId = null } = {}) {
    const w = [];
    const p = [];
    if (action) {
      w.push('action = ?');
      p.push(action);
    }
    if (userId) {
      w.push('user_id = ?');
      p.push(userId);
    }
    const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
    return this.db.all(`SELECT * FROM audit_lan ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...p, Math.min(500, limit), offset);
  }
}

/**
 * Logger berkas sederhana. `rahasia()` mengembalikan daftar nilai rahasia
 * aktif (mis. access token WhatsApp) yang dipastikan tidak pernah tertulis.
 */
class LoggerAman {
  constructor(file, rahasia = () => []) {
    this.file = file;
    this.rahasia = rahasia;
    this.memori = [];
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  _tulis(level, pesan, data) {
    let baris = `${new Date().toISOString()} [${level}] ${pesan}`;
    if (data !== undefined) {
      try {
        baris += ' ' + JSON.stringify(bersihkan(data));
      } catch {
        /* abaikan */
      }
    }
    baris = samarkanTeks(baris, this.rahasia());
    this.memori.push(baris);
    if (this.memori.length > 500) this.memori.shift();
    if (!this.file) return;
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > 5 * 1024 * 1024) fs.renameSync(this.file, this.file + '.1');
      fs.appendFileSync(this.file, baris + '\n');
    } catch {
      /* log gagal tidak menjatuhkan server */
    }
  }
  info(p, d) {
    this._tulis('INFO', p, d);
  }
  warn(p, d) {
    this._tulis('WARN', p, d);
  }
  error(p, d) {
    this._tulis('ERROR', p, d);
  }
}

module.exports = { AuditLan, LoggerAman, bersihkan, samarkanTeks };

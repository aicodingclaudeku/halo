'use strict';
/**
 * KOPKU LAN SERVER — SESI, CSRF, DAN PEMBATASAN LOGIN.
 *
 * - Kata sandi TIDAK diverifikasi di sini: verifikasi memakai fungsi KOPKU
 *   existing (`verifikasiPinAsync`, scrypt v2) lewat adapter renderer.
 * - Token sesi: 32 byte acak (base64url) dikirim sebagai cookie HttpOnly
 *   SameSite=Strict. Yang disimpan di database hanya SHA-256 dari token
 *   (token berentropi tinggi — SHA-256 di sini bukan hashing kata sandi).
 * - Setiap request yang mengubah data wajib membawa header X-KOPKU-CSRF
 *   yang cocok dengan token CSRF sesi (double submit, selain SameSite).
 * - Sesi berakhir karena idle (bawaan 30 menit), batas absolut (bawaan
 *   12 jam), logout, atau user dinonaktifkan/dihapus/diubah perannya.
 * - Login: penundaan progresif + kunci akun 15 menit setelah 5 kali gagal
 *   per username, dan 20 kali gagal per alamat IP. Tersimpan di database
 *   sehingga tetap berlaku setelah server restart.
 */
const crypto = require('node:crypto');

const NAMA_COOKIE = 'kopku_sid';
const BATAS_GAGAL_USER = 5;
const BATAS_GAGAL_IP = 20;
const JENDELA_GAGAL_MS = 15 * 60 * 1000;
const LAMA_KUNCI_MS = 15 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const acak = (n = 32) => crypto.randomBytes(n).toString('base64url');

class SesiStore {
  /**
   * @param {import('./serverDb').ServerDb} db
   * @param {{ idleMenit: number, maksJam: number }} batas
   * @param {() => number} now
   */
  constructor(db, batas, now = () => Date.now()) {
    this.db = db;
    this.batas = batas;
    this.now = now;
  }
  buat(userId, ip, userAgent) {
    const token = acak(32);
    const csrf = acak(24);
    const t = this.now();
    const exp = new Date(t + this.batas.maksJam * 3600 * 1000).toISOString();
    this.db.run(
      'INSERT INTO sesi (id, user_id, csrf, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
      sha256(token),
      userId,
      csrf,
      ip || null,
      String(userAgent || '').slice(0, 200),
      new Date(t).toISOString(),
      new Date(t).toISOString(),
      exp
    );
    return { token, csrf, expiresAt: exp };
  }
  /** @returns {null | {id:string,user_id:string,csrf:string}} */
  validasi(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const id = sha256(token);
    const r = this.db.get('SELECT * FROM sesi WHERE id = ?', id);
    if (!r || r.revoked_at) return null;
    const t = this.now();
    if (Date.parse(r.expires_at) <= t) return null;
    if (t - Date.parse(r.last_seen_at) > this.batas.idleMenit * 60 * 1000) return null;
    this.db.run('UPDATE sesi SET last_seen_at = ? WHERE id = ?', new Date(t).toISOString(), id);
    return r;
  }
  cabut(token) {
    if (typeof token !== 'string') return;
    this.db.run('UPDATE sesi SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', new Date(this.now()).toISOString(), sha256(token));
  }
  cabutUser(userId) {
    this.db.run('UPDATE sesi SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', new Date(this.now()).toISOString(), userId);
  }
  cabutId(id) {
    this.db.run('UPDATE sesi SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', new Date(this.now()).toISOString(), id);
  }
  bersihkan() {
    const batasIdle = new Date(this.now() - this.batas.idleMenit * 60 * 1000).toISOString();
    const t = new Date(this.now()).toISOString();
    const lama = new Date(this.now() - 7 * 24 * 3600 * 1000).toISOString();
    this.db.run('DELETE FROM sesi WHERE (revoked_at IS NOT NULL OR expires_at <= ? OR last_seen_at < ?) AND created_at < ?', t, batasIdle, lama);
  }
  aktif() {
    const t = this.now();
    return this.db
      .all('SELECT id, user_id, ip, user_agent, created_at, last_seen_at, expires_at FROM sesi WHERE revoked_at IS NULL ORDER BY last_seen_at DESC')
      .filter((r) => Date.parse(r.expires_at) > t && t - Date.parse(r.last_seen_at) <= this.batas.idleMenit * 60 * 1000);
  }
}

class PembatasLogin {
  constructor(db, now = () => Date.now()) {
    this.db = db;
    this.now = now;
  }
  _kunci(username, ip) {
    return [`u:${String(username || '').trim().toLowerCase()}`, `ip:${ip || '-'}`];
  }
  /** @returns {{ diizinkan: boolean, sisaDetik: number, jedaMs: number }} */
  cek(username, ip) {
    const t = this.now();
    let sisa = 0;
    let gagalUser = 0;
    for (const k of this._kunci(username, ip)) {
      const r = this.db.get('SELECT * FROM login_gagal WHERE kunci = ?', k);
      if (!r) continue;
      if (r.kunci_sampai && Date.parse(r.kunci_sampai) > t) sisa = Math.max(sisa, Math.ceil((Date.parse(r.kunci_sampai) - t) / 1000));
      if (k.startsWith('u:') && t - Date.parse(r.pertama_at) <= JENDELA_GAGAL_MS) gagalUser = r.jumlah;
    }
    const jedaMs = gagalUser > 0 ? Math.min(3000, 250 * 2 ** (gagalUser - 1)) : 0;
    return { diizinkan: sisa === 0, sisaDetik: sisa, jedaMs };
  }
  catatGagal(username, ip) {
    const t = this.now();
    const iso = new Date(t).toISOString();
    for (const k of this._kunci(username, ip)) {
      const batas = k.startsWith('u:') ? BATAS_GAGAL_USER : BATAS_GAGAL_IP;
      this.db.tx(() => {
        const r = this.db.get('SELECT * FROM login_gagal WHERE kunci = ?', k);
        let jumlah = 1;
        let pertama = iso;
        if (r && t - Date.parse(r.pertama_at) <= JENDELA_GAGAL_MS) {
          jumlah = r.jumlah + 1;
          pertama = r.pertama_at;
        }
        const kunciSampai = jumlah >= batas ? new Date(t + LAMA_KUNCI_MS).toISOString() : null;
        this.db.run(
          'INSERT INTO login_gagal (kunci, jumlah, pertama_at, terakhir_at, kunci_sampai) VALUES (?,?,?,?,?) ON CONFLICT(kunci) DO UPDATE SET jumlah = excluded.jumlah, pertama_at = excluded.pertama_at, terakhir_at = excluded.terakhir_at, kunci_sampai = excluded.kunci_sampai',
          k,
          jumlah,
          pertama,
          iso,
          kunciSampai
        );
      });
    }
  }
  berhasil(username) {
    this.db.run('DELETE FROM login_gagal WHERE kunci = ?', this._kunci(username, null)[0]);
  }
}

function parseCookie(header) {
  const out = {};
  for (const bagian of String(header || '').split(';')) {
    const i = bagian.indexOf('=');
    if (i <= 0) continue;
    const k = bagian.slice(0, i).trim();
    if (!(k in out)) out[k] = decodeURIComponent(bagian.slice(i + 1).trim());
  }
  return out;
}

function cookieSesi(token, { secure, maxAgeDetik }) {
  return [`${NAMA_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeDetik}`, ...(secure ? ['Secure'] : [])].join('; ');
}
function cookieHapus(secure) {
  return [`${NAMA_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ');
}

function samaAman(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

module.exports = { SesiStore, PembatasLogin, parseCookie, cookieSesi, cookieHapus, samaAman, sha256, NAMA_COOKIE, BATAS_GAGAL_USER, BATAS_GAGAL_IP, LAMA_KUNCI_MS };

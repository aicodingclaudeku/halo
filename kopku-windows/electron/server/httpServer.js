'use strict';
/**
 * KOPKU LAN SERVER — HTTP(S) SERVER.
 *
 * - Hanya melayani: halaman web KOPKU LAN (berkas statis yang di-whitelist)
 *   dan `/api/*`. Tidak ada directory listing, tidak ada akses berkas lain,
 *   database tidak pernah dapat diunduh.
 * - Bawaan: menolak koneksi dari alamat NON-privat (internet publik) di
 *   level socket, sekalipun port terekspos karena salah konfigurasi router.
 * - Proteksi DNS-rebinding: header Host harus berupa alamat IP, localhost,
 *   atau nama komputer ini.
 * - Header keamanan (CSP ketat, nosniff, frame deny, no-referrer).
 * - Batas ukuran badan 64 KB, JSON wajib untuk request ubah data.
 * - Pembatas laju umum per IP.
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BATAS_BADAN = 64 * 1024;
const WEB_DIR = path.join(__dirname, 'web');
const BERKAS_STATIS = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/logo.svg': { file: 'logo.svg', type: 'image/svg+xml' },
};

function alamatPrivat(ip) {
  let a = String(ip || '');
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a.startsWith('127.')) return true;
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^169\.254\./.test(a)) return true; // link-local (jaringan langsung tanpa DHCP)
  if (/^(fc|fd)[0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a)) return true;
  return false;
}

function hostSah(hostHeader) {
  if (!hostHeader) return false;
  let h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith('[')) h = h.slice(1, h.indexOf(']'));
  else h = h.replace(/:\d+$/, '');
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(':')) return true;
  const nama = os.hostname().toLowerCase();
  return h === 'localhost' || h === nama || h === `${nama}.local` || h === `${nama}.lan` || h === `${nama}.home`;
}

function headerKeamanan(isHttps) {
  return Object.assign(
    {
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    },
    isHttps ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}
  );
}

class LanHttpServer {
  /**
   * @param {{ api: import('./api').LanApi, logger?: any, hanyaPrivat?: boolean, https?: {certFile:string,keyFile:string}|null }} o
   */
  constructor(o) {
    this.api = o.api;
    this.logger = o.logger || null;
    this.hanyaPrivat = o.hanyaPrivat !== false;
    this.httpsOpsi = o.https || null;
    this.server = null;
    this.port = 0;
    this.host = null;
    this.hits = new Map();
    this.sockets = new Set();
  }

  get isHttps() {
    return !!this.httpsOpsi;
  }

  listen(port, host) {
    return new Promise((resolve, reject) => {
      const handler = (req, res) => this._handle(req, res).catch(() => this._kirim(res, 500, { ok: false, kode: 'INTERNAL', pesan: 'Terjadi kesalahan.' }));
      const s = this.httpsOpsi
        ? https.createServer({ cert: fs.readFileSync(this.httpsOpsi.certFile), key: fs.readFileSync(this.httpsOpsi.keyFile) }, handler)
        : http.createServer(handler);
      s.headersTimeout = 15000;
      s.requestTimeout = 120000;
      s.keepAliveTimeout = 5000;
      s.on('connection', (sock) => {
        if (this.hanyaPrivat && !alamatPrivat(sock.remoteAddress)) {
          sock.destroy();
          return;
        }
        this.sockets.add(sock);
        sock.on('close', () => this.sockets.delete(sock));
      });
      s.once('error', reject);
      s.listen(port, host, () => {
        s.removeListener('error', reject);
        this.server = s;
        this.port = s.address().port;
        this.host = host;
        resolve(this.port);
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      const s = this.server;
      this.server = null;
      for (const sock of this.sockets) sock.destroy();
      this.sockets.clear();
      s.close(() => resolve());
    });
  }

  _batasLaju(ip) {
    const t = Date.now();
    const h = (this.hits.get(ip) || []).filter((x) => t - x < 60000);
    h.push(t);
    this.hits.set(ip, h);
    if (this.hits.size > 5000) this.hits.clear();
    return h.length > 600;
  }

  _kirim(res, status, body, headers = {}) {
    if (res.headersSent) return res.end();
    const isi = Buffer.from(JSON.stringify(body));
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': isi.length }, headerKeamanan(this.isHttps), headers));
    res.end(isi);
  }

  async _bacaBadan(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > BATAS_BADAN) {
          reject(Object.assign(new Error('Badan permintaan terlalu besar.'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async _handle(req, res) {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (this.hanyaPrivat && !alamatPrivat(ip)) return req.socket.destroy();
    if (!hostSah(req.headers.host)) return this._kirim(res, 421, { ok: false, kode: 'HOST', pesan: 'Host tidak dikenali.' });
    if (this._batasLaju(ip)) return this._kirim(res, 429, { ok: false, kode: 'TERLALU_SERING', pesan: 'Terlalu banyak permintaan. Tunggu sebentar.' }, { 'Retry-After': '30' });
    let url;
    try {
      url = new URL(req.url, 'http://kopku.local');
    } catch {
      return this._kirim(res, 400, { ok: false, kode: 'URL', pesan: 'URL tidak sah.' });
    }
    const p = url.pathname;
    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return this._kirim(res, 405, { ok: false, kode: 'METODE', pesan: 'Metode tidak didukung.' });
      const st = BERKAS_STATIS[p];
      if (!st) return this._kirim(res, 404, { ok: false, kode: 'TIDAK_DITEMUKAN', pesan: 'Halaman tidak ditemukan.' });
      const isi = fs.readFileSync(path.join(WEB_DIR, st.file));
      res.writeHead(200, Object.assign({ 'Content-Type': st.type, 'Cache-Control': 'no-cache', 'Content-Length': isi.length }, headerKeamanan(this.isHttps)));
      return res.end(req.method === 'HEAD' ? undefined : isi);
    }
    if (!['GET', 'POST', 'PUT'].includes(req.method)) return this._kirim(res, 405, { ok: false, kode: 'METODE', pesan: 'Metode tidak didukung.' });
    let body = null;
    if (req.method !== 'GET') {
      const ct = String(req.headers['content-type'] || '');
      let teks;
      try {
        teks = await this._bacaBadan(req);
      } catch (e) {
        return this._kirim(res, e.status || 400, { ok: false, kode: 'BADAN', pesan: e.message });
      }
      if (teks.length) {
        if (!/^application\/json\b/i.test(ct)) return this._kirim(res, 415, { ok: false, kode: 'TIPE_KONTEN', pesan: 'Gunakan application/json.' });
        try {
          body = JSON.parse(teks);
        } catch {
          return this._kirim(res, 400, { ok: false, kode: 'JSON', pesan: 'JSON tidak sah.' });
        }
      } else body = {};
    }
    const query = {};
    for (const [k, v] of url.searchParams) if (!(k in query)) query[k] = v.slice(0, 200);
    const out = await this.api.tangani({ method: req.method, path: p, query, headers: req.headers, body, ip });
    return this._kirim(res, out.status, out.body, out.headers || {});
  }
}

module.exports = { LanHttpServer, alamatPrivat, hostSah, BERKAS_STATIS };

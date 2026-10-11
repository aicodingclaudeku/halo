'use strict';
/**
 * Server HTTP LAN untuk sinkron HP. Ia hanya PIPA: badan permintaan
 * diteruskan ke renderer (yang memegang kunci & database) dan jawabannya
 * dikembalikan. Isi selalu terenkripsi ujung-ke-ujung (lihat
 * src/sync/SyncKripto.ts); server ini tidak pernah melihat plaintext.
 */
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');

const PORT_AWAL = 47821;
const PORT_AKHIR = 47840;
const BATAS_BADAN = 6 * 1024 * 1024;

class LanServer {
  constructor(getWin) {
    this.getWin = getWin;
    this.server = null;
    this.port = 0;
    this.pending = new Map();
    this.hits = new Map();
  }
  addresses() {
    const out = [];
    for (const [nama, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        if (/^169\.254\./.test(a.address)) continue;
        if (/vEthernet|VirtualBox|VMware|docker|br-|veth/i.test(nama)) continue;
        out.push(a.address);
      }
    }
    // Urutkan: alamat privat umum dulu (192.168 / 10 / 172.16-31).
    return out.sort((x, y) => skor(y) - skor(x));
  }
  info() {
    return { port: this.port, addresses: this.addresses(), running: !!this.server };
  }
  async start() {
    if (this.server) return this.info();
    for (let p = PORT_AWAL; p <= PORT_AKHIR; p++) {
      try {
        await this._listen(p);
        this.port = p;
        return this.info();
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
      }
    }
    throw new Error('Port sinkron 47821–47840 sedang dipakai aplikasi lain.');
  }
  _listen(port) {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => this._handle(req, res));
      s.once('error', reject);
      s.listen(port, '0.0.0.0', () => {
        s.removeListener('error', reject);
        this.server = s;
        resolve();
      });
    });
  }
  stop() {
    if (this.server) this.server.close();
    this.server = null;
  }
  _limit(ip) {
    const now = Date.now();
    const h = (this.hits.get(ip) || []).filter((t) => now - t < 10000);
    h.push(now);
    this.hits.set(ip, h);
    return h.length > 300;
  }
  _handle(req, res) {
    const ip = req.socket.remoteAddress || '';
    if (req.method === 'GET' && (req.url === '/kopku/v1/ping' || req.url === '/')) {
      // Uji koneksi: dapat dibuka dari browser HP. Desktop ikut memberi
      // tahu pengguna bahwa sebuah perangkat berhasil menjangkaunya.
      const win = this.getWin();
      if (win) win.webContents.send('lan:ping', { ip: ip.replace(/^::ffff:/, ''), waktu: new Date().toISOString() });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ kopku: 1, pesan: 'KOPKU Desktop siap menerima sinkron. Jaringan HP dan komputer sudah tersambung.' }));
    }
    if (req.method !== 'POST' || !/^\/kopku\/v1\/(pasang|pesan)$/.test(req.url || '') || this._limit(ip)) {
      res.writeHead(404);
      return res.end();
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BATAS_BADAN) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      const win = this.getWin();
      if (!win) {
        res.writeHead(503);
        return res.end('{}');
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => this.resolve({ id, status: 504, body: '{"kode":"TIMEOUT"}' }), 180000);
      this.pending.set(id, { res, timer });
      win.webContents.send('lan:request', { id, path: req.url, body: Buffer.concat(chunks).toString('utf8') });
    });
  }
  resolve(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.res.writeHead(msg.status || 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    p.res.end(msg.body || '{}');
  }
}
function skor(a) {
  if (a.startsWith('192.168.')) return 3;
  if (a.startsWith('10.')) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return 1;
  return 0;
}
module.exports = { LanServer };

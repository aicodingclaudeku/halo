'use strict';
/**
 * KOPKU Desktop — Asisten AI · AKSES CHATGPT (MCP Streamable HTTP, 1.0.29).
 *
 *   ChatGPT (Settings › Apps & Connectors › Developer mode › konektor MCP)
 *     ──HTTPS──▶ alamat publik milik PENGGUNA (terowongan yang ia pasang & jalankan sendiri, mis. Cloudflare Tunnel)
 *       ──▶ http://127.0.0.1:<port tetap>/mcp/<kunci 256-bit>   (server di berkas ini)
 *         ──▶ McpHost.panggil(..., { sumber: 'chatgpt' }) — alat, izin, penyaring, dua langkah SAMA dengan Claude
 *
 * KOPKU TIDAK membuat, memasang, atau menjalankan terowongan internet. Server ini hanya mendengar di 127.0.0.1;
 * menjadikannya dapat dijangkau ChatGPT adalah keputusan & tindakan pengguna sendiri (layar menjelaskan risikonya).
 *
 * Pengaman:
 *   - Bawaan MATI; hanya Admin; Asisten AI harus menyala; tidak menyala otomatis saat KOPKU dibuka.
 *   - Server terpisah dari server lokal Claude; hanya `POST /mcp/<kunci>`; jalur/kunci salah → 404 tanpa keterangan.
 *     Kunci acak 256-bit (dibandingkan waktu-konstan) dapat diganti kapan saja.
 *   - Permintaan dari peramban (header Origin selain chatgpt.com/chat.openai.com) ditolak (anti DNS-rebinding/CSRF).
 *   - Izin ubah data ChatGPT TERPISAH (bawaan mati) di atas sakelar ubah data Asisten AI.
 *   - Batas 120 permintaan/menit, badan ≤ 256 KB, hanya JSON-RPC; tanpa CORS. Log bertanda [ChatGPT].
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { tangani } = require('./stdio');

const BATAS_BADAN = 256 * 1024;
const BATAS_PER_MENIT = 120;
const ORIGIN_BOLEH = new Set(['https://chatgpt.com', 'https://chat.openai.com']);

function galat(pesan, kode = 'VALIDASI') {
  return Object.assign(new Error(pesan), { kode, code: kode });
}

/** Alamat publik HTTPS dari pengguna (tanpa jalur). null = kosong. */
function rapikanAlamat(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  let u;
  try {
    u = new URL(t);
  } catch {
    throw galat('Alamat publik tidak sah. Contoh: https://nama-anda.trycloudflare.com');
  }
  if (u.protocol !== 'https:') throw galat('Alamat publik harus diawali https:// (ChatGPT hanya menerima HTTPS).');
  if (u.username || u.password || u.search || u.hash) throw galat('Alamat publik tidak boleh memuat nama pengguna, password, ?parameter, atau #.');
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(u.hostname)) throw galat('Alamat publik harus alamat internet (bukan alamat lokal).');
  return `${u.protocol}//${u.host}`;
}

class AksesChatGPT {
  /**
   * @param {{ host: import('./host').McpHost, dataDir: string, now?: () => number, portAcak?: () => number }} o
   */
  constructor(o) {
    this.o = o;
    this.host = o.host;
    this.berkas = path.join(o.dataDir, 'mcp', 'chatgpt.json');
    this.server = null;
    this.permintaan = [];
    this.statistik = { total: 0, ditolak: 0, terakhir: null };
    this.galat = null;
    this.host.chatgpt = this;
  }

  _now() {
    return (this.o.now || Date.now)();
  }

  baca() {
    try {
      const j = JSON.parse(fs.readFileSync(this.berkas, 'utf8'));
      return {
        bolehTulis: j.bolehTulis === true,
        kunci: typeof j.kunci === 'string' && /^[0-9a-f]{64}$/.test(j.kunci) ? j.kunci : null,
        port: Number.isInteger(j.port) && j.port >= 1024 && j.port <= 65535 ? j.port : null,
        alamatPublik: typeof j.alamatPublik === 'string' ? j.alamatPublik : null,
      };
    } catch {
      return { bolehTulis: false, kunci: null, port: null, alamatPublik: null };
    }
  }

  _simpan(p) {
    fs.mkdirSync(path.dirname(this.berkas), { recursive: true });
    const tmp = this.berkas + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(p), { mode: 0o600 });
    fs.renameSync(tmp, this.berkas);
  }

  /** Dipakai McpHost: apakah ChatGPT boleh mengubah data (di atas izin ubah data Asisten AI). */
  bolehTulis() {
    return this.baca().bolehTulis;
  }

  get berjalan() {
    return !!(this.server && this.server.listening);
  }

  status() {
    const p = this.baca();
    const lokal = p.port && p.kunci ? `http://127.0.0.1:${p.port}` : null;
    return {
      aktif: this.berjalan,
      bolehTulis: p.bolehTulis,
      port: p.port,
      alamatLokal: lokal,
      alamatPublik: p.alamatPublik,
      // URL yang ditempel di ChatGPT: alamat publik pengguna + jalur rahasia.
      urlChatGPT: p.alamatPublik && p.kunci ? `${p.alamatPublik}/mcp/${p.kunci}` : null,
      perintahTerowongan: lokal ? `cloudflared tunnel --url ${lokal}` : null,
      galat: this.galat,
      pemakaian: Object.assign({}, this.statistik),
    };
  }

  /**
   * @param {{ aktif?: boolean, bolehTulis?: boolean, gantiKunci?: boolean, alamatPublik?: string|null, penggunaId: string }} i
   */
  async atur(i) {
    const u = await this.host._cekPengubah(i.penggunaId);
    const p = this.baca();
    if (i.alamatPublik !== undefined) p.alamatPublik = rapikanAlamat(i.alamatPublik);
    if (i.bolehTulis !== undefined) p.bolehTulis = i.bolehTulis === true;
    if (i.gantiKunci || !p.kunci) p.kunci = crypto.randomBytes(32).toString('hex');
    if (!p.port) p.port = this._portBaru();
    this._simpan(p);
    const nyala = i.aktif === undefined ? this.berjalan : i.aktif === true;
    this.host._catat({ alat: '(pengaturan)', ok: true, ket: `[ChatGPT] ${nyala ? 'menyala' : 'mati'} · ubah data ChatGPT ${p.bolehTulis ? 'DIIZINKAN' : 'tidak diizinkan'}${i.gantiKunci ? ' · kunci URL diganti' : ''} · oleh ${u.username}` });
    if (i.aktif === true) await this.mulai();
    else if (i.aktif === false) await this.henti();
    return this.status();
  }

  _portBaru() {
    return this.o.portAcak ? this.o.portAcak() : 41000 + crypto.randomInt(0, 8000);
  }

  async mulai() {
    if (!this.host.baca().aktif) throw galat('Nyalakan Asisten AI lebih dulu (sakelar "Aktifkan Asisten AI").', 'MATI');
    this.galat = null;
    if (this.berjalan) return this.status();
    const p = this.baca();
    const server = http.createServer((req, res) => this._layani(req, res));
    server.requestTimeout = 180000;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p.port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (e) {
      // Port dipakai aplikasi lain → pilih port baru (perintah terowongan di layar ikut berubah).
      if (e && e.code === 'EADDRINUSE') {
        p.port = this._portBaru();
        this._simpan(p);
        this.galat = `Port sebelumnya dipakai aplikasi lain; KOPKU pindah ke port ${p.port}. Jalankan ulang terowongan Anda dengan perintah yang baru.`;
        return this.mulai();
      }
      throw galat('Server ChatGPT tidak dapat dinyalakan.', 'GAGAL');
    }
    this.server = server;
    return this.status();
  }

  async henti() {
    const s = this.server;
    this.server = null;
    if (s) {
      await new Promise((r) => {
        s.close(() => r());
        if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      });
    }
    return this.status();
  }

  // ------------------------------------------------------------------ HTTP (Streamable HTTP MCP, tanpa SSE)
  _balas(res, status, isi, headers = {}) {
    const badan = isi === undefined ? '' : JSON.stringify(isi);
    res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, badan ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(badan) } : {}, headers));
    res.end(badan);
  }

  _kunciCocok(req) {
    const kunci = this.baca().kunci;
    if (!kunci) return false;
    const m = /^\/mcp\/([0-9a-f]{64})\/?$/.exec(String(req.url || '').split('?')[0]);
    if (!m) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(kunci);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  _layani(req, res) {
    const kini = this._now();
    this.permintaan = this.permintaan.filter((t) => kini - t < 60000);
    if (this.permintaan.length >= BATAS_PER_MENIT) {
      this.statistik.ditolak++;
      return this._balas(res, 429, { pesan: 'Terlalu banyak permintaan.' }, { 'Retry-After': '30' });
    }
    this.permintaan.push(kini);
    const origin = req.headers.origin;
    if (!this._kunciCocok(req) || (origin && !ORIGIN_BOLEH.has(String(origin)))) {
      this.statistik.ditolak++;
      return this._balas(res, 404, { pesan: 'Tidak ditemukan.' });
    }
    if (req.method !== 'POST') return this._balas(res, 405, { pesan: 'Gunakan POST.' }, { Allow: 'POST' });
    const bagian = [];
    let ukuran = 0;
    req.on('data', (c) => {
      ukuran += c.length;
      if (ukuran > BATAS_BADAN) req.destroy();
      else bagian.push(c);
    });
    req.on('end', async () => {
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(bagian).toString('utf8'));
      } catch {
        return this._balas(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      this.statistik.total++;
      this.statistik.terakhir = new Date(kini).toISOString();
      const o = { dataDir: this.o.dataDir, host: (_d, metode, jalur, isi) => this._keHost(metode, jalur, isi) };
      try {
        if (Array.isArray(msg)) {
          const hasil = (await Promise.all(msg.map((m) => tangani(m, o)))).filter(Boolean);
          return hasil.length ? this._balas(res, 200, hasil) : this._balas(res, 202);
        }
        const h = await tangani(msg, o);
        return h ? this._balas(res, 200, h) : this._balas(res, 202);
      } catch {
        return this._balas(res, 200, { jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32603, message: 'Internal error' } });
      }
    });
    return undefined;
  }

  /** Pengganti panggilan HTTP host di stdio.tangani: langsung ke McpHost dengan sumber ChatGPT. */
  async _keHost(metode, jalur, isi) {
    if (!this.host.berjalan || !this.berjalan) return { tertutup: true };
    if (metode === 'GET' && jalur === '/alat') return { status: 200, json: { tools: await this.host.daftarAlat('chatgpt') } };
    if (metode === 'POST' && jalur === '/panggil') return { status: 200, json: await this.host.panggil(isi && isi.name, isi && isi.arguments, { sumber: 'chatgpt' }) };
    return { status: 404, json: null };
  }
}

module.exports = { AksesChatGPT, rapikanAlamat };

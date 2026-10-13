'use strict';
/**
 * KOPKU Desktop — Asisten AI · AKSES CHATGPT lewat OpenAI Secure MCP Tunnel (1.0.31).
 *
 *   ChatGPT (konektor "Connection: Tunnel") ⇄ OpenAI ⇄ tunnel-client-runtime (keluar HTTPS, tunnelOpenAI.js)
 *     ⇄ http://127.0.0.1:<port>/mcp  (server di berkas ini; Authorization: Bearer <kunci lokal 256-bit>)
 *       ⇄ McpHost.panggil(..., { sumber: 'chatgpt' }) — alat, izin, penyaring, dua langkah SAMA dengan Claude
 *
 * Menggantikan cara 1.0.29 (alamat publik + terowongan buatan pengguna): kini TIDAK ada URL publik,
 * port masuk, domain, atau Command Prompt. Pengguna cukup menempel Tunnel ID + Runtime API key dari
 * OpenAI Platform sekali, lalu klik "Hubungkan".
 *
 * Pengaman:
 *   - Bawaan MATI; hanya Admin; Asisten AI harus menyala.
 *   - Server hanya 127.0.0.1; setiap POST /mcp wajib `Authorization: Bearer <kunci lokal>` (dibandingkan
 *     waktu-konstan); Origin peramban ditolak; 120 permintaan/menit; badan ≤ 256 KB.
 *   - API key OpenAI disimpan terenkripsi (DPAPI Windows lewat safeStorage) di penyimpanan TERPISAH yang tidak
 *     dapat dibaca layar; tidak pernah dikembalikan ke layar (hanya 4 karakter terakhir).
 *   - Admin key (sk-admin-…) ditolak — cukup Runtime API key Restricted (Tunnels Read + Use).
 *   - Izin ubah data ChatGPT TERPISAH (bawaan mati) di atas sakelar ubah data Asisten AI. Log bertanda [ChatGPT].
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { tangani } = require('./stdio');
const { RuntimeTunnel, RE_TUNNEL_ID } = require('./tunnelOpenAI');

const BATAS_BADAN = 256 * 1024;
const BATAS_PER_MENIT = 120;
const KUNCI_RAHASIA = 'chatgpt.runtimeApiKey';

/** Tautan resmi yang boleh dibuka dari layar (whitelist). */
const TAUTAN = {
  tunnels: 'https://platform.openai.com/settings/organization/tunnels',
  apiKeys: 'https://platform.openai.com/settings/organization/api-keys',
  konektor: 'https://chatgpt.com/#settings/Connectors',
  panduan: 'https://github.com/openai/tunnel-client/blob/main/docs/end-user-guide.md',
};

function galat(pesan, kode = 'VALIDASI') {
  return Object.assign(new Error(pesan), { kode, code: kode });
}

function periksaTunnelId(s) {
  const t = String(s == null ? '' : s).trim();
  if (!RE_TUNNEL_ID.test(t)) throw galat('Tunnel ID tidak sah. Bentuknya tunnel_ diikuti 32 huruf/angka kecil — salin dari halaman Tunnels di OpenAI Platform.');
  return t;
}

function periksaApiKey(s) {
  const t = String(s == null ? '' : s).trim();
  if (/^sk-admin-/.test(t)) throw galat('Ini admin key. Demi keamanan gunakan Runtime API key: OpenAI Platform › API keys › Create › Restricted › Tunnels: Read + Use.');
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(t)) throw galat('API key tidak sah. Salin key yang diawali "sk-" dari OpenAI Platform › API keys.');
  return t;
}

class AksesChatGPT {
  /**
   * @param {{ host: import('./host').McpHost, dataDir: string,
   *           rahasia?: { get(k:string):string|null, set(k:string,v:string):void, remove(k:string):void },
   *           jalurRuntime?: () => string|null, runtime?: RuntimeTunnel, baseUrl?: string,
   *           now?: () => number }} o
   */
  constructor(o) {
    this.o = o;
    this.host = o.host;
    this.dir = path.join(o.dataDir, 'mcp');
    this.berkas = path.join(this.dir, 'chatgpt.json');
    this.rahasia = o.rahasia || this._rahasiaMemori();
    this.server = null;
    this.port = null;
    this.permintaan = [];
    this.statistik = { total: 0, ditolak: 0, terakhir: null };
    this.runtime = o.runtime || new RuntimeTunnel({ jalurRuntime: o.jalurRuntime || (() => null), dirLog: this.dir, baseUrl: o.baseUrl });
    this.host.chatgpt = this;
  }

  _rahasiaMemori() {
    const m = new Map();
    return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) };
  }

  _now() {
    return (this.o.now || Date.now)();
  }

  baca() {
    try {
      const j = JSON.parse(fs.readFileSync(this.berkas, 'utf8'));
      return {
        aktif: j.aktif === true,
        bolehTulis: j.bolehTulis === true,
        tunnelId: typeof j.tunnelId === 'string' && RE_TUNNEL_ID.test(j.tunnelId) ? j.tunnelId : null,
        kunci: typeof j.kunci === 'string' && /^[0-9a-f]{64}$/.test(j.kunci) ? j.kunci : null,
      };
    } catch {
      return { aktif: false, bolehTulis: false, tunnelId: null, kunci: null };
    }
  }

  _simpan(p) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.berkas + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(p), { mode: 0o600 });
    fs.renameSync(tmp, this.berkas);
  }

  _apiKey() {
    try {
      return this.rahasia.get(KUNCI_RAHASIA) || null;
    } catch {
      return null;
    }
  }

  /** Dipakai McpHost: apakah ChatGPT boleh mengubah data (di atas izin ubah data Asisten AI). */
  bolehTulis() {
    return this.baca().bolehTulis;
  }

  get berjalan() {
    return !!(this.server && this.server.listening);
  }

  /** Pemeriksaan prasyarat otomatis (untuk layar). */
  prasyarat() {
    const p = this.baca();
    let bin = null;
    try {
      bin = (this.o.jalurRuntime || (() => null))();
    } catch {
      bin = null;
    }
    return [
      { kode: 'ASISTEN', ok: !!this.host.baca().aktif, teks: 'Asisten AI menyala' },
      { kode: 'RUNTIME', ok: !!bin, teks: 'Penghubung resmi OpenAI (tunnel-client) terpasang bersama KOPKU' },
      { kode: 'TUNNEL', ok: !!p.tunnelId, teks: 'Tunnel ID OpenAI disimpan' },
      { kode: 'KUNCI', ok: !!this._apiKey(), teks: 'Runtime API key OpenAI disimpan (terenkripsi)' },
    ];
  }

  status() {
    const p = this.baca();
    const k = this._apiKey();
    const r = this.runtime.info();
    return {
      aktif: p.aktif,
      keadaan: p.aktif ? r.keadaan : 'MATI',
      kode: p.aktif ? r.kode : null,
      pesan: p.aktif ? r.pesan : 'ChatGPT belum dihubungkan.',
      terhubungPada: p.aktif ? r.terhubungPada : null,
      tunnelId: p.tunnelId,
      apiKey: k ? { ada: true, akhir: k.slice(-4) } : { ada: false },
      bolehTulis: p.bolehTulis,
      prasyarat: this.prasyarat(),
      pemakaian: Object.assign({}, this.statistik),
      tautan: TAUTAN,
    };
  }

  /**
   * Satu pintu dari layar.
   * @param {{ aksi:'simpan'|'hubungkan'|'putuskan'|'hapus'|'izin', tunnelId?:string, apiKey?:string, bolehTulis?:boolean, penggunaId:string }} i
   */
  async atur(i) {
    const u = await this.host._cekPengubah(i.penggunaId);
    const p = this.baca();
    const catat = (ket) => this.host._catat({ alat: '(pengaturan)', ok: true, ket: `[ChatGPT] ${ket} · oleh ${u.username}` });
    switch (i.aksi) {
      case 'simpan': {
        const tid = periksaTunnelId(i.tunnelId);
        const key = i.apiKey ? periksaApiKey(i.apiKey) : null;
        if (!key && !this._apiKey()) throw galat('Tempel Runtime API key OpenAI.');
        p.tunnelId = tid;
        if (key) this.rahasia.set(KUNCI_RAHASIA, key);
        this._simpan(p);
        catat('kredensial tunnel disimpan');
        if (p.aktif) await this._sambung();
        break;
      }
      case 'hubungkan':
        if (!this.host.baca().aktif) throw galat('Nyalakan "Aktifkan Asisten AI" lebih dulu.', 'MATI');
        if (!p.tunnelId || !this._apiKey()) throw galat('Simpan Tunnel ID dan Runtime API key OpenAI lebih dulu (langkah 1).', 'BELUM_SIAP');
        p.aktif = true;
        if (!p.kunci) p.kunci = crypto.randomBytes(32).toString('hex');
        this._simpan(p);
        catat('dihubungkan');
        await this._sambung();
        break;
      case 'putuskan':
        p.aktif = false;
        this._simpan(p);
        catat('diputus');
        await this.henti();
        break;
      case 'hapus':
        p.aktif = false;
        p.tunnelId = null;
        p.kunci = null;
        this._simpan(p);
        this.rahasia.remove(KUNCI_RAHASIA);
        catat('kredensial dihapus');
        await this.henti();
        break;
      case 'izin':
        p.bolehTulis = i.bolehTulis === true;
        this._simpan(p);
        catat(`ubah data ChatGPT ${p.bolehTulis ? 'DIIZINKAN' : 'tidak diizinkan'}`);
        break;
      default:
        throw galat('Aksi tidak dikenal.');
    }
    return this.status();
  }

  /** Dipanggil saat KOPKU dibuka: sambung ulang bila sebelumnya terhubung. */
  async mulaiBilaAktif() {
    const p = this.baca();
    if (p.aktif && p.tunnelId && this._apiKey() && this.host.baca().aktif) await this._sambung().catch(() => undefined);
    return this.status();
  }

  async _sambung() {
    await this._mulaiServer();
    await this.runtime.henti();
    const p = this.baca();
    this.runtime.mulai({ tunnelId: p.tunnelId, apiKey: this._apiKey(), mcpUrl: `http://127.0.0.1:${this.port}/mcp`, mcpAuth: `Bearer ${p.kunci}` });
  }

  async _mulaiServer() {
    if (this.berjalan) return;
    const server = http.createServer((req, res) => this._layani(req, res));
    server.requestTimeout = 180000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.port = server.address().port;
  }

  /** Hentikan runtime & server (pengaturan tetap; dipakai saat Asisten AI dimatikan / KOPKU ditutup). */
  async henti() {
    await this.runtime.henti();
    const s = this.server;
    this.server = null;
    this.port = null;
    if (s) {
      await new Promise((r) => {
        s.close(() => r());
        if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      });
    }
  }

  // ------------------------------------------------------------------ HTTP (MCP Streamable HTTP, JSON saja)
  _balas(res, status, isi, headers = {}) {
    const badan = isi === undefined ? '' : JSON.stringify(isi);
    res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, badan ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(badan) } : {}, headers));
    res.end(badan);
  }

  _otentik(req) {
    const kunci = this.baca().kunci;
    if (!kunci) return false;
    const m = /^Bearer ([0-9a-f]{64})$/.exec(String(req.headers.authorization || ''));
    if (!m) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(kunci);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  _layani(req, res) {
    const kini = this._now();
    const jalur = String(req.url || '').split('?')[0];
    // Penemuan OAuth oleh tunnel-client: KOPKU tidak memakai OAuth (otentikasi lewat tunnel + kunci lokal).
    if (req.method === 'GET' && jalur.startsWith('/.well-known/')) return this._balas(res, 404, { error: 'not_found' });
    this.permintaan = this.permintaan.filter((t) => kini - t < 60000);
    if (this.permintaan.length >= BATAS_PER_MENIT) {
      this.statistik.ditolak++;
      return this._balas(res, 429, { pesan: 'Terlalu banyak permintaan.' }, { 'Retry-After': '30' });
    }
    this.permintaan.push(kini);
    if (jalur !== '/mcp' || req.headers.origin || !this._otentik(req)) {
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
      const o = { dataDir: this.o.dataDir, host: (_d, metode, j, isi) => this._keHost(metode, j, isi) };
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
    if (!this.host.berjalan) return { tertutup: true };
    if (metode === 'GET' && jalur === '/alat') return { status: 200, json: { tools: await this.host.daftarAlat('chatgpt') } };
    if (metode === 'POST' && jalur === '/panggil') return { status: 200, json: await this.host.panggil(isi && isi.name, isi && isi.arguments, { sumber: 'chatgpt' }) };
    return { status: 404, json: null };
  }
}

module.exports = { AksesChatGPT, periksaTunnelId, periksaApiKey, TAUTAN, KUNCI_RAHASIA };

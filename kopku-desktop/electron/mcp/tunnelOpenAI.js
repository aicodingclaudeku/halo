'use strict';
/**
 * KOPKU Desktop — Asisten AI · OpenAI Secure MCP Tunnel (1.0.31).
 *
 * Metode koneksi RESMI OpenAI untuk server MCP lokal/pribadi (github.com/openai/tunnel-client,
 * Apache-2.0): proses `tunnel-client-runtime` di komputer pengguna membuka koneksi KELUAR (HTTPS)
 * ke control plane OpenAI, mengambil permintaan ChatGPT, meneruskannya ke server MCP KOPKU di
 * 127.0.0.1, lalu mengirim balik jawabannya. Tidak ada port masuk, tidak ada URL publik.
 *
 *   ChatGPT ⇄ OpenAI control plane ⇄ (keluar, HTTPS) tunnel-client-runtime ⇄ http://127.0.0.1:<port>/mcp (KOPKU)
 *
 * Status "TERHUBUNG" hanya bila health runtime melaporkan control plane `ok` (polling, 0 kegagalan
 * beruntun) DAN probe ke server MCP KOPKU berhasil. `/readyz` saja TIDAK cukup: diuji, `/readyz`
 * tetap 200 walau API key salah.
 *
 * Rahasia: API key OpenAI & kunci lokal hanya lewat variabel lingkungan proses anak (bukan argumen
 * baris perintah); keluaran runtime disaring sebelum ditulis ke log.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RE_TUNNEL_ID = /^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/;
const BATAS_LOG = 512 * 1024;

/** Pesan untuk pengguna awam dari health control plane. */
function artiGagalControlPlane(cp) {
  const d = (cp && cp.details) || {};
  const s = Number(d.http_status) || 0;
  if (s === 401) return { kode: 'KUNCI_SALAH', pesan: 'API key ditolak OpenAI (salah, sudah dicabut, atau milik organisasi lain). Buat Runtime API key baru (Restricted · Tunnels Read + Use) lalu simpan ulang.' };
  if (s === 403) return { kode: 'IZIN_KURANG', pesan: 'API key tidak punya izin Tunnels. Saat membuat key pilih Restricted dan centang Tunnels: Read + Use.' };
  if (s === 404) return { kode: 'TUNNEL_TIDAK_ADA', pesan: 'Tunnel ID tidak ditemukan di organisasi OpenAI pemilik API key. Periksa Tunnel ID di halaman Tunnels OpenAI.' };
  if (s === 429) return { kode: 'DIBATASI', pesan: 'OpenAI membatasi sementara (terlalu banyak permintaan). KOPKU mencoba lagi otomatis.' };
  if (s >= 500) return { kode: 'OPENAI_GANGGUAN', pesan: `Layanan OpenAI sedang gangguan (HTTP ${s}). KOPKU mencoba lagi otomatis.` };
  return { kode: 'JARINGAN', pesan: 'Tidak dapat menghubungi OpenAI. Periksa koneksi internet / proxy kantor. KOPKU mencoba lagi otomatis.' };
}

/**
 * Tafsir `/health?details=true` runtime → keadaan KOPKU.
 * @returns {{ keadaan:'MENYAMBUNG'|'TERHUBUNG'|'GAGAL', kode?:string, pesan:string }}
 */
function tafsirHealth(h) {
  const c = (h && h.components) || {};
  const cp = c['control-plane'];
  const probe = c.mcp && c.mcp.details && c.mcp.details.startup_probe;
  if (probe && probe.state === 'failed') return { keadaan: 'GAGAL', kode: 'MCP_LOKAL', pesan: 'Penghubung OpenAI tidak dapat menjangkau server MCP KOPKU di komputer ini. Coba "Hubungkan ulang".' };
  if (!cp || cp.state === 'not_observed') return { keadaan: 'MENYAMBUNG', pesan: 'Menghubungi OpenAI…' };
  const gagal = Number((cp.details && cp.details.consecutive_failures) || 0);
  if (cp.status === 'ok' && gagal === 0 && (!probe || probe.state === 'succeeded')) return { keadaan: 'TERHUBUNG', pesan: 'Terhubung ke OpenAI. ChatGPT dapat memakai KOPKU lewat tunnel ini.' };
  if (cp.status === 'ok') return { keadaan: 'MENYAMBUNG', pesan: 'Menghubungi OpenAI…' };
  const a = artiGagalControlPlane(cp);
  return { keadaan: 'GAGAL', kode: a.kode, pesan: a.pesan };
}

/** Sembunyikan rahasia dari teks log. */
function saringLog(teks, rahasia = []) {
  let t = String(teks);
  for (const r of rahasia) if (r && r.length >= 8) t = t.split(r).join('[disamarkan]');
  return t
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[disamarkan]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[disamarkan]')
    .replace(/(authorization["'=:\s]+)[^\s"',]+/gi, '$1[disamarkan]');
}

class RuntimeTunnel {
  /**
   * @param {{ jalurRuntime: () => string|null, dirLog: string, spawn?: typeof spawn, fetch?: typeof fetch,
   *           baseUrl?: string, intervalMs?: number, batasMenyambungMs?: number, now?: () => number }} o
   */
  constructor(o) {
    this.o = o;
    this.proses = null;
    this.keadaan = 'MATI';
    this.kode = null;
    this.pesan = 'Belum terhubung.';
    this.healthUrl = null;
    this.mulaiPada = 0;
    this.terhubungPada = null;
    this.ulang = 0;
    this.timerCek = null;
    this.timerUlang = null;
    this.rahasia = [];
    this.inginJalan = false;
    this.argsTerakhir = null;
    this.berkasLog = path.join(o.dirLog, 'chatgpt-tunnel.log');
    this.berkasUrl = path.join(o.dirLog, 'chatgpt-tunnel-health.url');
  }

  _now() {
    return (this.o.now || Date.now)();
  }

  info() {
    return { keadaan: this.keadaan, kode: this.kode, pesan: this.pesan, terhubungPada: this.terhubungPada, berjalan: !!this.proses };
  }

  _log(teks) {
    try {
      fs.mkdirSync(this.o.dirLog, { recursive: true });
      try {
        if (fs.statSync(this.berkasLog).size > BATAS_LOG) fs.renameSync(this.berkasLog, this.berkasLog + '.1');
      } catch {
        /* belum ada */
      }
      fs.appendFileSync(this.berkasLog, saringLog(teks, this.rahasia));
    } catch {
      /* log tidak boleh menggagalkan koneksi */
    }
  }

  /**
   * Jalankan runtime. Resolve segera; status dipantau lewat info().
   * @param {{ tunnelId:string, apiKey:string, mcpUrl:string, mcpAuth:string }} a
   */
  mulai(a) {
    this.inginJalan = true;
    this.argsTerakhir = a;
    this.ulang = 0;
    this._jalankan();
  }

  _jalankan() {
    clearTimeout(this.timerUlang);
    const a = this.argsTerakhir;
    const bin = this.o.jalurRuntime();
    if (!bin) {
      this._set('GAGAL', 'RUNTIME_TIDAK_ADA', 'Komponen penghubung resmi OpenAI (tunnel-client) tidak ditemukan di instalasi KOPKU. Pasang ulang KOPKU Desktop.');
      return;
    }
    this.rahasia = [a.apiKey, a.mcpAuth.replace(/^Bearer\s+/, '')];
    try {
      fs.mkdirSync(this.o.dirLog, { recursive: true });
      fs.rmSync(this.berkasUrl, { force: true });
    } catch {
      /* abaikan */
    }
    const args = [
      'run',
      '--control-plane.tunnel-id', a.tunnelId,
      '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
      '--mcp.server-url', a.mcpUrl,
      '--mcp.extra-headers', 'Authorization: env:KOPKU_MCP_AUTH',
      '--mcp.discovery-extra-headers', 'Authorization: env:KOPKU_MCP_AUTH',
      '--health.listen-addr', '127.0.0.1:0',
      '--health.url-file', this.berkasUrl,
      '--log.level', 'info',
    ];
    if (this.o.baseUrl) args.push('--control-plane.base-url', this.o.baseUrl); // hanya uji (tiruan control plane)
    // Lingkungan minimal: tidak mewarisi variabel lain (mis. OPENAI_API_KEY milik aplikasi lain).
    const env = { CONTROL_PLANE_API_KEY: a.apiKey, KOPKU_MCP_AUTH: a.mcpAuth };
    for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE']) {
      if (process.env[k]) env[k] = process.env[k];
    }
    this._set('MENYAMBUNG', null, 'Menjalankan penghubung resmi OpenAI…');
    this.mulaiPada = this._now();
    this.healthUrl = null;
    this._log(`\n=== ${new Date(this._now()).toISOString()} mulai tunnel ${a.tunnelId}\n`);
    let p;
    try {
      p = (this.o.spawn || spawn)(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      this._set('GAGAL', 'RUNTIME_GAGAL', 'Penghubung OpenAI tidak dapat dijalankan. Antivirus mungkin memblokir tunnel-client-runtime.exe.');
      return;
    }
    this.proses = p;
    p.stdout.on('data', (c) => this._log(c));
    p.stderr.on('data', (c) => this._log(c));
    p.on('error', () => {
      if (this.proses === p) this._set('GAGAL', 'RUNTIME_GAGAL', 'Penghubung OpenAI tidak dapat dijalankan. Antivirus mungkin memblokir tunnel-client-runtime.exe.');
    });
    p.on('exit', (kode) => {
      this._log(`=== runtime berhenti (kode ${kode})\n`);
      if (this.proses !== p) return;
      this.proses = null;
      clearInterval(this.timerCek);
      if (!this.inginJalan) return;
      // Berhenti tak terduga → coba lagi dengan jeda bertahap (5 s, 15 s, 60 s, lalu tiap 2 menit).
      const jeda = [5000, 15000, 60000][this.ulang] || 120000;
      this.ulang++;
      this._set('GAGAL', 'RUNTIME_BERHENTI', `Penghubung OpenAI berhenti. Mencoba lagi dalam ${Math.round(jeda / 1000)} detik…`);
      this.timerUlang = setTimeout(() => this.inginJalan && this._jalankan(), this.o.jedaUlangMs != null ? this.o.jedaUlangMs : jeda);
    });
    clearInterval(this.timerCek);
    this.timerCek = setInterval(() => this._cek().catch(() => undefined), this.o.intervalMs || 2000);
  }

  async _cek() {
    if (!this.proses) return;
    if (!this.healthUrl) {
      try {
        const u = fs.readFileSync(this.berkasUrl, 'utf8').trim();
        if (/^http:\/\/127\.0\.0\.1:\d+$/.test(u)) this.healthUrl = u;
      } catch {
        /* belum ditulis */
      }
    }
    if (!this.healthUrl) return;
    const r = await (this.o.fetch || fetch)(this.healthUrl + '/health?details=true', { signal: AbortSignal.timeout(3000) });
    const t = tafsirHealth(await r.json());
    // Gagal ditetapkan setelah beberapa percobaan (bukan pada kegagalan pertama yang mungkin sementara).
    if (t.keadaan === 'GAGAL' && this.keadaan !== 'TERHUBUNG' && this._now() - this.mulaiPada < (this.o.tenggangGagalMs != null ? this.o.tenggangGagalMs : 4000)) return;
    if (t.keadaan === 'TERHUBUNG' && this.keadaan !== 'TERHUBUNG') {
      this.terhubungPada = new Date(this._now()).toISOString();
      this.ulang = 0;
    }
    if (t.keadaan === 'MENYAMBUNG' && this.keadaan === 'MENYAMBUNG' && this._now() - this.mulaiPada > (this.o.batasMenyambungMs || 45000)) {
      this._set('GAGAL', 'JARINGAN', 'Belum berhasil menghubungi OpenAI setelah 45 detik. Periksa koneksi internet / proxy. KOPKU terus mencoba.');
      return;
    }
    this._set(t.keadaan, t.kode || null, t.pesan);
  }

  _set(keadaan, kode, pesan) {
    this.keadaan = keadaan;
    this.kode = kode;
    this.pesan = pesan;
  }

  async henti() {
    this.inginJalan = false;
    clearInterval(this.timerCek);
    clearTimeout(this.timerUlang);
    const p = this.proses;
    this.proses = null;
    this.healthUrl = null;
    this._set('MATI', null, 'Koneksi ChatGPT diputus.');
    this.terhubungPada = null;
    if (p) {
      await new Promise((r) => {
        const t = setTimeout(r, 4000);
        p.once('exit', () => {
          clearTimeout(t);
          r();
        });
        try {
          p.kill();
        } catch {
          r();
        }
      });
    }
  }
}

module.exports = { RuntimeTunnel, tafsirHealth, artiGagalControlPlane, saringLog, RE_TUNNEL_ID };

'use strict';
/**
 * Kit uji LAN: KOPKU asli (headless) + KopkuLanServer asli di 127.0.0.1 +
 * klien HTTP dengan cookie jar (meniru browser).
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { muatKopku, seed, PASSWORD, ROOT } = require('./kopkuHeadless');
const { pasangAdapter } = require(path.join(ROOT, 'electron/server/rendererAdapter'));
const { DirectServiceBridge } = require(path.join(ROOT, 'electron/server/serviceBridge'));
const { KopkuLanServer } = require(path.join(ROOT, 'electron/server'));

function portAcak() {
  return 40000 + Math.floor(Math.random() * 20000);
}

class Jam {
  constructor(ms) {
    this.t = ms == null ? Date.now() : ms;
    this.nyata = ms == null;
  }
  now() {
    return this.nyata ? Date.now() + (this.geser || 0) : this.t;
  }
  maju(ms) {
    if (this.nyata) this.geser = (this.geser || 0) + ms;
    else this.t += ms;
  }
}

async function siapkan(opsi = {}) {
  const k = muatKopku({ lisensiValid: true });
  const s = await seed(k, opsi.seed || {});
  const adapter = pasangAdapter(k.ids, { tanpaRegistrasi: true, txTungguMs: opsi.txTungguMs });
  const bridge = new DirectServiceBridge(adapter);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-lan-srv-'));
  const jam = opsi.jam || new Jam();
  const env = Object.assign({}, opsi.env || {});
  const secureMap = new Map();
  const secure = { get: async (x) => (secureMap.has(x) ? secureMap.get(x) : null), set: async (x, v) => void secureMap.set(x, v), remove: async (x) => void secureMap.delete(x) };
  const port = opsi.port || portAcak();
  fs.writeFileSync(path.join(dataDir, 'kopku-server.json'), JSON.stringify({ mode: 'LAN_SERVER', host: '127.0.0.1', port }));
  const buatServer = () =>
    new KopkuLanServer({ dataDir, rendererDir: path.join(ROOT, 'renderer'), bridge, secure, env, fetch: opsi.fetch, now: () => jam.now(), tidur: async () => undefined, logFile: undefined, tickMs: opsi.tickMs || 3600 * 1000 });
  const srv = buatServer();
  const st = await srv.mulai();
  if (st.server !== 'ONLINE') throw new Error('server gagal: ' + st.galat);
  return { R_db: () => k.R('db').getDb(), k, s, adapter, bridge, srv, buatServer, dataDir, jam, port, base: `http://127.0.0.1:${port}`, secureMap, env };
}

/** Klien seperti browser: cookie jar + token CSRF di memori. */
class Klien {
  constructor(base) {
    this.base = base;
    this.cookie = '';
    this.csrf = null;
  }
  async req(method, p, body, headers = {}) {
    const h = Object.assign({ Accept: 'application/json' }, headers);
    if (this.cookie) h.Cookie = this.cookie;
    if (method !== 'GET') {
      h['Content-Type'] = 'application/json';
      if (this.csrf && !('X-KOPKU-CSRF' in headers)) h['X-KOPKU-CSRF'] = this.csrf;
      if (!('Idempotency-Key' in headers)) h['Idempotency-Key'] = 'k' + Math.random().toString(36).slice(2) + Date.now();
      for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    }
    const res = await fetch(this.base + p, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) {
      const [kv] = c.split(';');
      const [nama, nilai] = kv.split('=');
      if (nama === 'kopku_sid') this.cookie = nilai ? `kopku_sid=${nilai}` : '';
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json, headers: res.headers, setCookie: sc };
  }
  async login(username, password) {
    const r = await this.req('POST', '/api/auth/login', { username, password });
    if (r.status === 200) this.csrf = r.body.data.csrf;
    return r;
  }
}

async function beriAkses(base, userId, profil = 'IKUT_ROLE', aktif = true) {
  const a = new Klien(base);
  const l = await a.login('admin', PASSWORD.admin);
  if (l.status !== 200) throw new Error('admin login gagal ' + JSON.stringify(l.body));
  const r = await a.req('PUT', `/api/admin/lan-akses/${userId}`, { aktif, profil });
  if (r.status !== 200) throw new Error('beri akses gagal ' + JSON.stringify(r.body));
  return r;
}

module.exports = { siapkan, Klien, Jam, beriAkses, PASSWORD, ROOT, portAcak };

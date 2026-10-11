'use strict';
/**
 * KOPKU LAN SERVER — KONFIGURASI.
 *
 * 1) `kopku-server.json` (folder data aplikasi): mode, host, port, HTTPS,
 *    batas sesi. TIDAK berisi rahasia.
 * 2) Kredensial WhatsApp: HANYA di backend, urutan prioritas
 *      a. environment variable proses (WHATSAPP_*),
 *      b. berkas `kopku-server.env` di folder data aplikasi (bukan di
 *         folder source / Git; contoh: `.env.example`),
 *      c. access token yang diisi Admin lewat UI, disimpan terenkripsi
 *         DPAPI/Keychain (secure store Electron) — bukan di database.
 *    Nilai rahasia tidak pernah dikirim ke browser/renderer atau ditulis
 *    ke log; yang keluar hanya status "tersedia" dan sumbernya.
 */
const fs = require('node:fs');
const path = require('node:path');

const MODE = { DESKTOP: 'DESKTOP', LAN_SERVER: 'LAN_SERVER' };
const PORT_BAWAAN = 47880;

const BAWAAN = Object.freeze({
  mode: MODE.DESKTOP,
  host: '0.0.0.0',
  port: PORT_BAWAAN,
  hanyaJaringanPrivat: true,
  https: { aktif: false, certFile: '', keyFile: '' },
  sesiIdleMenit: 30,
  sesiMaksJam: 12,
});

function validasiConfig(c) {
  const out = JSON.parse(JSON.stringify(BAWAAN));
  if (!c || typeof c !== 'object') return out;
  if (c.mode === MODE.LAN_SERVER || c.mode === MODE.DESKTOP) out.mode = c.mode;
  if (typeof c.host === 'string' && /^(0\.0\.0\.0|127\.0\.0\.1|(\d{1,3}\.){3}\d{1,3})$/.test(c.host.trim())) out.host = c.host.trim();
  const port = Number(c.port);
  if (Number.isInteger(port) && port >= 1024 && port <= 65535) out.port = port;
  if (typeof c.hanyaJaringanPrivat === 'boolean') out.hanyaJaringanPrivat = c.hanyaJaringanPrivat;
  if (c.https && typeof c.https === 'object') {
    out.https.aktif = !!c.https.aktif;
    out.https.certFile = typeof c.https.certFile === 'string' ? c.https.certFile : '';
    out.https.keyFile = typeof c.https.keyFile === 'string' ? c.https.keyFile : '';
  }
  const idle = Number(c.sesiIdleMenit);
  if (Number.isInteger(idle) && idle >= 5 && idle <= 480) out.sesiIdleMenit = idle;
  const maks = Number(c.sesiMaksJam);
  if (Number.isInteger(maks) && maks >= 1 && maks <= 24) out.sesiMaksJam = maks;
  return out;
}

class ServerConfig {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'kopku-server.json');
    this.envFile = path.join(dataDir, 'kopku-server.env');
  }
  baca() {
    try {
      return validasiConfig(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return validasiConfig(null);
    }
  }
  simpan(perubahan) {
    const baru = validasiConfig(Object.assign({}, this.baca(), perubahan || {}));
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(baru, null, 2));
    fs.renameSync(tmp, this.file);
    return baru;
  }
}

/** Parser `.env` sederhana: KEY=VALUE, komentar `#`, kutip opsional. */
function parseEnv(teks) {
  const out = {};
  for (const baris of String(teks || '').split(/\r?\n/)) {
    const t = baris.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (/^[A-Z0-9_]+$/.test(k)) out[k] = v;
  }
  return out;
}

const KUNCI_WA = ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_API_VERSION', 'WHATSAPP_TEMPLATE_NAME', 'WHATSAPP_TEMPLATE_LANG'];
const SECURE_TOKEN_KEY = 'kopku.server.whatsapp.accessToken';
/** Kunci yang boleh diisi dari layar desktop (tanpa access token). */
const KUNCI_WA_UI = ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_API_VERSION', 'WHATSAPP_TEMPLATE_NAME', 'WHATSAPP_TEMPLATE_LANG'];

/** Validasi nilai non-rahasia dari layar desktop. Kosong = hapus. */
function validasiKredensialUi(input) {
  const o = input && typeof input === 'object' ? input : {};
  const aturan = {
    WHATSAPP_PHONE_NUMBER_ID: [/^\d{5,30}$/, 'Phone Number ID harus berupa angka (5–30 digit).'],
    WHATSAPP_BUSINESS_ACCOUNT_ID: [/^\d{5,30}$/, 'WhatsApp Business Account ID harus berupa angka (5–30 digit).'],
    WHATSAPP_API_VERSION: [/^v\d+\.\d+$/, 'Versi API harus seperti v21.0.'],
    WHATSAPP_TEMPLATE_NAME: [/^[a-z0-9_]{1,512}$/, 'Nama template hanya huruf kecil, angka, dan garis bawah (contoh: kopku_pengingat_angsuran).'],
    WHATSAPP_TEMPLATE_LANG: [/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Kode bahasa template seperti id atau en_US.'],
  };
  const out = {};
  for (const [k, [re, pesan]] of Object.entries(aturan)) {
    if (!(k in o)) continue;
    const v = o[k] == null ? '' : String(o[k]).trim();
    if (v === '') out[k] = '';
    else if (!re.test(v)) throw Object.assign(new Error(pesan), { kode: 'VALIDASI' });
    else out[k] = v;
  }
  return out;
}

/**
 * Sumber kredensial WhatsApp. `ambil()` hanya dipakai WhatsAppService di
 * main process. `ringkasan()` aman dikirim ke UI (tanpa nilai rahasia).
 */
class WhatsAppKredensial {
  /**
   * @param {{ env?: object, envFile?: string, secure?: {get(k):any,set(k,v):any,remove(k):any} }} o
   */
  constructor(o = {}) {
    this.env = o.env || process.env;
    this.envFile = o.envFile || null;
    this.secure = o.secure || null;
    /** @type {() => object} nilai non-rahasia dari layar desktop (opsional) */
    this.ui = typeof o.ui === 'function' ? o.ui : () => ({});
  }
  _ui() {
    try {
      const u = this.ui() || {};
      const out = {};
      for (const k of KUNCI_WA_UI) if (typeof u[k] === 'string' && u[k]) out[k] = u[k];
      return out;
    } catch {
      return {};
    }
  }
  _berkas() {
    if (!this.envFile) return {};
    try {
      return parseEnv(fs.readFileSync(this.envFile, 'utf8'));
    } catch {
      return {};
    }
  }
  async ambil() {
    const f = this._berkas();
    const u = this._ui();
    const out = {};
    const sumber = {};
    for (const k of KUNCI_WA) {
      if (this.env[k]) {
        out[k] = String(this.env[k]);
        sumber[k] = 'ENV';
      } else if (f[k]) {
        out[k] = String(f[k]);
        sumber[k] = 'FILE';
      } else if (u[k] && k !== 'WHATSAPP_ACCESS_TOKEN') {
        out[k] = String(u[k]);
        sumber[k] = 'APLIKASI';
      }
    }
    if (!out.WHATSAPP_ACCESS_TOKEN && this.secure) {
      try {
        const t = await this.secure.get(SECURE_TOKEN_KEY);
        if (t) {
          out.WHATSAPP_ACCESS_TOKEN = String(t);
          sumber.WHATSAPP_ACCESS_TOKEN = 'SECURE_STORE';
        }
      } catch {
        /* secure store tidak tersedia */
      }
    }
    return {
      phoneNumberId: out.WHATSAPP_PHONE_NUMBER_ID || '',
      businessAccountId: out.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
      accessToken: out.WHATSAPP_ACCESS_TOKEN || '',
      apiVersion: /^v\d+\.\d+$/.test(out.WHATSAPP_API_VERSION || '') ? out.WHATSAPP_API_VERSION : 'v21.0',
      templateName: out.WHATSAPP_TEMPLATE_NAME || '',
      templateLang: out.WHATSAPP_TEMPLATE_LANG || 'id',
      sumber,
    };
  }
  async ringkasan() {
    const k = await this.ambil();
    return {
      phoneNumberIdTersedia: !!k.phoneNumberId,
      businessAccountIdTersedia: !!k.businessAccountId,
      accessTokenTersedia: !!k.accessToken,
      sumberAccessToken: k.sumber.WHATSAPP_ACCESS_TOKEN || null,
      apiVersion: k.apiVersion,
      templateName: k.templateName,
      templateLang: k.templateLang,
      lengkap: !!(k.phoneNumberId && k.accessToken && k.templateName),
      sumber: Object.fromEntries(Object.entries(k.sumber).filter(([x]) => x !== 'WHATSAPP_ACCESS_TOKEN')),
    };
  }
  async simpanTokenAman(token) {
    if (!this.secure) throw new Error('Penyimpanan aman tidak tersedia.');
    const t = String(token || '').trim();
    if (t.length < 20 || t.length > 1024 || /\s/.test(t)) throw new Error('Format access token tidak valid.');
    await this.secure.set(SECURE_TOKEN_KEY, t);
  }
  async hapusTokenAman() {
    if (this.secure) await this.secure.remove(SECURE_TOKEN_KEY);
  }
}

module.exports = { ServerConfig, validasiConfig, parseEnv, WhatsAppKredensial, validasiKredensialUi, KUNCI_WA_UI, MODE, PORT_BAWAAN, BAWAAN, SECURE_TOKEN_KEY };

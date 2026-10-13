'use strict';
/**
 * KOPKU LAN SERVER — JEMBATAN main process ⇄ adapter renderer.
 *
 * Main process mengirim `srv:call` {id, op, args, ctx} ke jendela KOPKU
 * Desktop; preload meneruskannya ke adapter dan membalas `srv:reply`.
 * `ctx.userId` SELALU diisi server dari sesi yang tervalidasi — tidak
 * pernah dari isi request klien.
 */
const crypto = require('node:crypto');
const { pasangAdapter } = require('./rendererAdapter');

class GalatLayanan extends Error {
  constructor(kode, pesan) {
    super(pesan);
    this.kode = kode;
  }
}

class IpcServiceBridge {
  /**
   * @param {() => (import('electron').WebContents|null)} getWebContents
   * @param {{ batasMs?: number }} opsi
   */
  constructor(getWebContents, opsi = {}) {
    this.getWebContents = getWebContents;
    this.batasMs = opsi.batasMs || 90000;
    this.pending = new Map();
    this.siap = false;
    this.galatPasang = null;
  }

  /** Suntikkan adapter ke renderer. Dipanggil saat server start & setiap halaman dimuat ulang. */
  async pasang(ids) {
    const wc = this.getWebContents();
    if (!wc) throw new GalatLayanan('RENDERER_TIDAK_ADA', 'Jendela KOPKU Desktop belum terbuka.');
    const kode = `(${pasangAdapter.toString()})(${JSON.stringify(ids)}, {}); true;`;
    // Bundle dimuat async: tunggu registry modul Metro tersedia.
    for (let i = 0; i < 120; i++) {
      const ada = await wc.executeJavaScript('typeof globalThis.__r === "function" && !!globalThis.kopkuDesktop', true).catch(() => false);
      if (ada) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    try {
      await wc.executeJavaScript(kode, true);
      this.siap = true;
      this.galatPasang = null;
    } catch (e) {
      this.siap = false;
      this.galatPasang = String((e && e.message) || e).slice(0, 300);
      throw new GalatLayanan('ADAPTER_GAGAL', this.galatPasang);
    }
  }

  panggil(op, args, ctx) {
    const wc = this.getWebContents();
    if (!wc || !this.siap) return Promise.reject(new GalatLayanan('LAYANAN_BELUM_SIAP', 'KOPKU Desktop di komputer server belum siap.'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GalatLayanan('TIMEOUT', 'Server KOPKU tidak menjawab tepat waktu.'));
      }, this.batasMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        wc.send('srv:call', { id, op, args: args || {}, ctx: ctx || {} });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new GalatLayanan('LAYANAN_BELUM_SIAP', 'Jendela KOPKU Desktop tidak dapat dihubungi.'));
      }
    }).then((r) => {
      if (r && r.ok) return r.value;
      const e = (r && r.error) || { kode: 'INTERNAL', pesan: 'Terjadi kesalahan.' };
      throw new GalatLayanan(e.kode, e.pesan);
    });
  }

  terima(msg) {
    if (!msg || typeof msg.id !== 'string') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg.hasil);
  }

  putus() {
    this.siap = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new GalatLayanan('LAYANAN_BELUM_SIAP', 'Jendela KOPKU Desktop dimuat ulang.'));
      this.pending.delete(id);
    }
  }
}

/** Jembatan langsung (uji otomatis / headless): memanggil adapter di proses yang sama. */
class DirectServiceBridge {
  constructor(adapter) {
    this.adapter = adapter;
    this.siap = true;
  }
  async panggil(op, args, ctx) {
    if (!this.siap) throw new GalatLayanan('LAYANAN_BELUM_SIAP', 'KOPKU Desktop di komputer server belum siap.');
    // Tiru serialisasi IPC (structured clone ≈ JSON untuk data ini).
    const r = await this.adapter.jalankan(op, JSON.parse(JSON.stringify(args || {})), JSON.parse(JSON.stringify(ctx || {})));
    if (r.ok) return r.value;
    throw new GalatLayanan(r.error.kode, r.error.pesan);
  }
}

module.exports = { IpcServiceBridge, DirectServiceBridge, GalatLayanan };

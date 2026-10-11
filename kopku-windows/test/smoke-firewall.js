'use strict';
// Uji asap: layar setup → "Sudah memakai KOPKU di HP?" → QR + kartu Koneksi & Firewall.
// Status firewall Windows DISIMULASIKAN "memblokir" (uji berjalan di Linux), lalu
// HP disimulasikan membuka alamat uji ping → desktop harus menampilkan "berhasil menjangkau".
const fs = require('node:fs'); const path = require('node:path'); const http = require('node:http');
const { FirewallHost } = require('../electron/hosts/firewallHost');
let diperbaiki = false;
FirewallHost.prototype.status = async () => (diperbaiki
  ? { didukung: true, aturanIzin: true, aturanBlokir: 0, profil: [{ nama: 'Wi-Fi', kategori: 'Public' }], perluPerbaikan: false }
  : { didukung: true, aturanIzin: false, aturanBlokir: 2, profil: [{ nama: 'Wi-Fi', kategori: 'Public' }], perluPerbaikan: true });
FirewallHost.prototype.perbaiki = async function () { diperbaiki = true; return { ok: true, status: await this.status() }; };
module.exports = (win, app) => {
  const out = process.env.KOPKU_SMOKE_OUT; fs.mkdirSync(out, { recursive: true });
  const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (n) => fs.writeFileSync(path.join(out, n + '.png'), (await win.webContents.capturePage()).toPNG());
  const js = (c) => win.webContents.executeJavaScript(c);
  const klik = (t) => js(`(() => { const el = [...document.querySelectorAll('div,span')].reverse().find(e => e.textContent.trim() === ${JSON.stringify(t)}); if (!el) return false; (el.closest('[role=button],[tabindex]') || el).click(); return true; })()`);
  const teks = () => js('document.body.innerText');
  win.webContents.once('did-finish-load', async () => {
    try {
      await tunggu(9000);
      await shot('10-tawaran-awal');
      console.log('klik kartu HP:', await klik('Sudah memakai KOPKU di HP?'));
      await tunggu(2500);
      const t0 = await teks();
      console.log('TAWARAN-FIREWALL:', /Izinkan sinkron di Windows Firewall\?/.test(t0));
      await klik('Nanti'); await tunggu(500);
      console.log('klik tampilkan QR:', await klik('Tampilkan QR'));
      await tunggu(2500);
      const t1 = await teks();
      console.log('BANNER-BLOKIR:', /Windows Firewall MEMBLOKIR KOPKU Desktop/.test(t1), 'URL-UJI:', (t1.match(/http:\/\/[\d.]+:\d+\/kopku\/v1\/ping/) || [''])[0]);
      await shot('11-qr-firewall-blokir');
      const lan = await js('window.kopkuDesktop.lan.info()');
      const body = await new Promise((res) => http.get(`http://127.0.0.1:${lan.port}/kopku/v1/ping`, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b)); }).on('error', (e) => res('ERR ' + e.message)));
      console.log('PING-DARI-"HP":', body);
      console.log('klik izinkan:', await klik('Izinkan di Firewall'));
      await tunggu(2500);
      const t2 = await teks();
      console.log('SETELAH-PERBAIKI:', /Windows Firewall mengizinkan sinkron HP/.test(t2), 'PING-TERDETEKSI:', /berhasil menjangkau desktop/.test(t2));
      await klik('OK'); await tunggu(600);
      await shot('12-firewall-ok-ping');
    } catch (e) { console.log('SMOKE-ERR', e); }
    app.exit(0);
  });
};

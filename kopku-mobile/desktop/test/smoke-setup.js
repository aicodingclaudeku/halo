'use strict';
// Uji asap: layar setup → "Sudah memakai KOPKU di HP?" → QR pemasangan tampil (server LAN + QR nyata).
const fs = require('node:fs'); const path = require('node:path');
module.exports = (win, app) => {
  const out = process.env.KOPKU_SMOKE_OUT; fs.mkdirSync(out, { recursive: true });
  const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (n) => fs.writeFileSync(path.join(out, n + '.png'), (await win.webContents.capturePage()).toPNG());
  const js = (c) => win.webContents.executeJavaScript(c);
  const klikTeks = (t) => js(`(() => { const el = [...document.querySelectorAll('div,span')].reverse().find(e => e.textContent.trim() === ${JSON.stringify(t)}); if (!el) return false; (el.closest('[role=button],[tabindex]') || el).click(); return true; })()`);
  win.webContents.once('did-finish-load', async () => {
    try {
      await tunggu(9000);
      console.log('klik kartu HP:', await klikTeks('Sudah memakai KOPKU di HP?'));
      await tunggu(1500);
      console.log('klik tampilkan QR:', await klikTeks('Tampilkan QR'));
      await tunggu(3000);
      await shot('02-qr');
      const t = await js('document.body.innerText');
      console.log('QR-ALAMAT:', (t.match(/alamat [^\n]*/) || [''])[0]);
      console.log('IMG-QR:', await js(`[...document.querySelectorAll('img')].some(i => i.src.startsWith('data:image/png'))`));
      const lan = await js('window.kopkuDesktop.lan.info()');
      console.log('LAN:', JSON.stringify(lan));
      const ping = await js(`fetch('http://127.0.0.1:' + ${'0'} ).catch(()=>null) && true`);
      console.log('done', ping);
    } catch (e) { console.log('SMOKE-ERR', e); }
    app.exit(0);
  });
};

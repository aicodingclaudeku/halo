'use strict';
// Uji asap: buka aplikasi, tangkap layar, laporkan teks yang tampil.
const fs = require('node:fs'); const path = require('node:path');
module.exports = (win, app) => {
  const out = process.env.KOPKU_SMOKE_OUT;
  fs.mkdirSync(out, { recursive: true });
  const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (nama) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(out, nama + '.png'), img.toPNG()); };
  const teks = () => win.webContents.executeJavaScript('document.body.innerText');
  win.webContents.once('did-finish-load', async () => {
    try {
      await tunggu(9000);
      await shot('01-awal');
      console.log('TEKS-01:', (await teks()).slice(0, 600).replace(/\n+/g, ' | '));
    } catch (e) { console.log('SMOKE-ERR', e); }
    app.exit(0);
  });
};

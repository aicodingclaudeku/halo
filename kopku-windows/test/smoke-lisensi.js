'use strict';
// Uji asap: desktop berisi data dari HP + terpasang, tanpa lisensi → layar aktivasi lisensi
// harus menampilkan info "Data … sudah ada", nama koperasi terisi, dan tombol Sinkron HP.
const fs = require('node:fs'); const path = require('node:path');
module.exports = (win, app) => {
  const out = process.env.KOPKU_SMOKE_OUT; fs.mkdirSync(out, { recursive: true });
  const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (n) => fs.writeFileSync(path.join(out, n + '.png'), (await win.webContents.capturePage()).toPNG());
  const js = (c) => win.webContents.executeJavaScript(c);
  win.webContents.once('did-finish-load', async () => {
    try {
      await tunggu(10000);
      const t = await js('document.body.innerText');
      console.log('LAYAR-LISENSI:', /Aktivasi Lisensi/.test(t), 'INFO-DATA:', /sudah ada di komputer ini/.test(t), 'PIL:', /Sinkron HP ·/.test(t));
      console.log('NAMA-TERISI:', await js(`[...document.querySelectorAll('input')].map(i => i.value).join(' | ')`));
      const lan = await js('window.kopkuDesktop.lan.info()'); console.log('SERVER-JALAN:', JSON.stringify(lan));
      await shot('20-lisensi');
      await js(`(() => { const el = [...document.querySelectorAll('div')].reverse().find(e => /^Sinkron HP ·/.test(e.textContent.trim())); (el.closest('[tabindex]')||el).click(); })()`);
      await tunggu(2500);
      await shot('21-panel-sinkron');
    } catch (e) { console.log('SMOKE-ERR', e); }
    app.exit(0);
  });
};

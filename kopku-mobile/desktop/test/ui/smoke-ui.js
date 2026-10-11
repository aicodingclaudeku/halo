'use strict';
// Penelusuran tampilan KOPKU Desktop: login (bila perlu) → dashboard → palet Ctrl+K →
// Data/Anggota → Transaksi/Penerimaan → form → laporan → Sinkron HP → menu akun → dialog
// → sidebar ringkas. Setiap langkah disimpan sebagai PNG di KOPKU_SMOKE_OUT.
const fs = require('node:fs'); const path = require('node:path');
module.exports = (win, app) => {
  const out = process.env.KOPKU_SMOKE_OUT; fs.mkdirSync(out, { recursive: true });
  const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (c) => win.webContents.executeJavaScript(c);
  const shot = async (n) => { await tunggu(500); fs.writeFileSync(path.join(out, n + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('UI-SHOT', n); };
  const teks = () => js('document.body.innerText');
  const klik = (t, dariAkhir = false) => js(`(() => { const semua = [...document.querySelectorAll('div,span')].filter(e => e.textContent.trim() === ${JSON.stringify(t)} && e.offsetParent !== null); const el = ${dariAkhir} ? semua[semua.length - 1] : semua[0]; if (!el) return false; (el.closest('[role=button],[role=tab],[tabindex]') || el).click(); return true; })()`);
  const ketik = (indeks, nilai) => js(`(() => { const i = [...document.querySelectorAll('input')].filter(x => x.offsetParent !== null)[${indeks}]; if (!i) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(nilai)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const tungguTeks = async (re, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const t = await teks().catch(() => ''); if (re.test(t)) return t; await tunggu(400); } return null; };
  const langkah = async (nama, fn) => { try { const r = await fn(); console.log('LANGKAH', nama, r === false ? 'GAGAL' : 'OK'); } catch (e) { console.log('GALAT', nama, e && e.message); } };

  win.webContents.once('did-finish-load', async () => {
    try {
      win.setSize(1440, 900); win.center();
      const awal = await tungguTeks(/Total Simpanan|Masuk|Password|Aktivasi Lisensi/, 45000);
      console.log('UI-AWAL', (awal || '').slice(0, 200).replace(/\n+/g, ' | '));
      if (awal && /Aktivasi Lisensi/.test(awal)) { for (let i = 0; i < 40 && /BY ALQIZANI/.test(await teks()); i++) await tunggu(500); await tunggu(1000); await shot('00-lisensi'); console.log('UI-LISENSI', (await teks()).replace(/\n+/g, ' | ')); app.exit(0); return; }
      if (awal && !/Total Simpanan/.test(awal)) {
        for (let i = 0; i < 40 && /BY ALQIZANI/.test(await teks()); i++) await tunggu(500);
        await shot('00-login');
        await ketik(0, 'admin'); await ketik(1, 'Admin12345');
        await klik('Masuk', true);
        await tungguTeks(/Total Simpanan/, 30000);
      }
      for (let i = 0; i < 40 && /BY ALQIZANI/.test(await teks()); i++) await tunggu(500);
      await tunggu(1200);
      await shot('01-dashboard');
      await langkah('palet', async () => { await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))`); await tunggu(700); await js(`(() => { const i = document.querySelector('input[aria-label="Cari menu"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'lap'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await shot('02-palet-cari'); await js(`(() => { const i = document.querySelector('input[aria-label="Cari menu"]'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`); await tunggu(400); await klik('Esc'); });
      await langkah('data', async () => { await klik('Data'); await tunggu(1500); await shot('03-data-hub'); });
      await langkah('anggota', async () => { await klik('Anggota'); await tunggu(2500); await shot('04-anggota'); });
      await langkah('detail', async () => { await klik('Budi Santoso', true); await tunggu(2500); await shot('05-anggota-detail'); });
      await langkah('transaksi', async () => { await klik('Transaksi'); await tunggu(1500); await shot('06-transaksi-hub'); });
      await langkah('penerimaan', async () => { await klik('Penerimaan'); await tunggu(1500); await shot('07-penerimaan'); });
      await langkah('form', async () => { await klik('Bayar Piutang Anggota'); await tunggu(2500); await shot('08-form-bayar'); });
      await langkah('simpanan', async () => { await klik('Simpanan'); await tunggu(2500); await shot('09-simpanan'); });
      await langkah('laporan', async () => { await klik('Laporan'); await tunggu(1500); await shot('10-laporan-menu'); });
      await langkah('posisi', async () => { await klik('Posisi Keuangan'); await tunggu(4000); await shot('11-posisi-keuangan'); });
      await langkah('sinkron', async () => { await klik('Pengaturan'); await tunggu(1200); await shot('12-pengaturan'); await klik('Sinkron HP'); await tunggu(3000); await shot('13-sinkron-hp'); });
      await langkah('akun', async () => { await js(`document.querySelector('[aria-label="Menu akun"]').click()`); await tunggu(800); await shot('14-menu-akun'); await klik('Keluar', true); await tunggu(900); await shot('15-dialog-keluar'); await klik('Batal', true); await tunggu(500); });
      await langkah('ringkas', async () => { await klik('Dashboard'); await tunggu(1500); await js(`document.querySelector('[aria-label^="Ciutkan sidebar"]').click()`); await tunggu(900); await shot('16-sidebar-ringkas'); });
      await langkah('keluar-login', async () => { await js(`document.querySelector('[aria-label="Menu akun"]').click()`); await tunggu(700); await klik('Keluar', true); await tunggu(800); await klik('Keluar', true); await tungguTeks(/Password|Masuk/, 20000); await tunggu(1500); await shot('17-login'); });
      const t = await teks();
      console.log('UI-TEKS-AKHIR', t.slice(0, 300).replace(/\n+/g, ' | '));
    } catch (e) { console.log('SMOKE-ERR', e); }
    app.exit(0);
  });
};

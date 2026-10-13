'use strict';
// Uji asap menu "Pengaturan › LAN & WhatsApp" di ELECTRON NYATA (main.js + preload.js + renderer terpasang):
//  1) Koperasi & admin dibuat lewat service asli; lisensi DIGANTI TIRUAN (khusus uji, aktivasi asli butuh server lisensi).
//  2) Masuk sebagai Admin lewat layar Login asli.
//  3) Menu muncul di: sidebar Pengaturan, layar "Semua Pengaturan", pencarian Ctrl+K; Berkas › LAN & WhatsApp… membuka layarnya.
//  4) Saklar Server LAN & WhatsApp Reminder ON/OFF berdiri sendiri (diklik di layar, dialog konfirmasi asli).
// Jalankan: KOPKU_USERDATA=<dir> KOPKU_SMOKE=$PWD/test/smoke-menu-lan-wa.js KOPKU_SMOKE_OUT=<dir> electron .
const fs = require('node:fs');
const path = require('node:path');
const { Menu } = require('electron');
const PORT = Number(process.env.KOPKU_SMOKE_PORT || 47882);

module.exports = (win, app) => {
  const out = process.env.KOPKU_SMOKE_OUT;
  fs.mkdirSync(out, { recursive: true });
  const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (c) => win.webContents.executeJavaScript(c);
  const teks = () => js('document.body.innerText');
  const shot = async (nama) => fs.writeFileSync(path.join(out, nama + '.png'), (await win.webContents.capturePage()).toPNG());
  const hasil = {};
  const cek = (nama, ok, info) => {
    hasil[nama] = !!ok;
    console.log(`MENU-SMOKE ${ok ? 'OK  ' : 'GAGAL'} ${nama}${info ? ' :: ' + info : ''}`);
  };
  /** Klik elemen yang teksnya persis `t` (elemen terdalam). */
  const klikTeks = (t, idx = 0) =>
    js(`(() => { const el = [...document.querySelectorAll('div,span,a,button')].filter((e) => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(t)});
      const x = el[${idx}]; if (!x) return false; x.click(); return true; })()`);
  const isiInput = (indeks, nilai) =>
    js(`(() => { const i = document.querySelectorAll('input')[${indeks}]; if (!i) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(nilai)});
      i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const klikTestId = (id) => js(`(() => { const e = document.querySelector('[data-testid="${id}"]'); if (!e) return false; (e.querySelector('input') || e).click(); return true; })()`);
  const status = () => js('kopkuDesktop.lanWa.status()');

  win.setSize(1440, 900);
  win.webContents.once('did-finish-load', async () => {
    try {
      await tunggu(8000);
      const { bangunIndeks } = require('../electron/server/bundleIndex');
      const ids = bangunIndeks(path.join(__dirname, '..', 'renderer')).modul;
      await js(`(async () => {
        const ids = ${JSON.stringify(ids)}; const R = (k) => __r(ids[k]);
        await R('koperasi').setupKoperasi({ nama: 'Koperasi Uji Menu LAN', tahunBuku: 2026, adminUsername: 'admin', adminPassword: 'Admin#Kopku2026' });
        const L = R('lisensi'); const asli = L.getLicenseStatus;
        L.getLicenseStatus = async (...a) => Object.assign({}, await asli(...a).catch(() => ({})), { allowAppAccess: true });
        L.hasValidLocalLicense = async () => true;
        return true; })()`);
      await js(`__r(${require('../scripts/pasang-menu-lan-wa').DEPENDENSI.usePermission}) && true`);
      // muat ulang: aplikasi membaca setup & lisensi (tiruan dipasang ulang segera setelah bundle siap)
      win.webContents.once('did-finish-load', async () => {
        try {
          await js(`(() => { const ids = ${JSON.stringify(ids)}; const L = __r(ids.lisensi); const asli = L.getLicenseStatus;
            L.getLicenseStatus = async (...a) => Object.assign({}, await asli(...a).catch(() => ({})), { allowAppAccess: true });
            L.hasValidLocalLicense = async () => true; return true; })()`).catch(() => undefined);
          await tunggu(7000);
          await shot('01-setelah-setup');
          let t = await teks();
          console.log('TEKS-01:', t.slice(0, 300).replace(/\n+/g, ' | '));
          if (/Masuk|Login|Username/i.test(t)) {
            await isiInput(0, 'admin');
            await isiInput(1, 'Admin#Kopku2026');
            await tunggu(300);
            await js(`(() => { const b = [...document.querySelectorAll('[role=button],button,div')].filter((e) => e.childElementCount <= 2 && /^\\s*Masuk\\s*$/.test(e.textContent)); const x = b[b.length - 1]; if (x) x.click(); return !!x; })()`);
            await tunggu(5000);
          }
          await shot('02-dashboard');
          t = await teks();
          console.log('TEKS-02:', t.slice(0, 300).replace(/\n+/g, ' | '));
          cek('masuk ke aplikasi', /Dashboard/.test(t) && /Pengaturan/.test(t));

          // ---- menu di sidebar
          await klikTeks('Pengaturan');
          await tunggu(1500);
          t = await teks();
          cek('sidebar Pengaturan memuat "LAN & WhatsApp"', t.includes('LAN & WhatsApp'));
          await shot('03-semua-pengaturan');
          cek('layar Semua Pengaturan memuat kartu "LAN & WhatsApp"', /LAN & WhatsApp\s*\n*\s*Server LAN multi-user/.test(t) || t.split('LAN & WhatsApp').length > 2, '');

          // ---- buka layar dari kartu Semua Pengaturan
          await klikTeks('LAN & WhatsApp', 1) || (await klikTeks('LAN & WhatsApp', 0));
          await tunggu(2500);
          t = await teks();
          await shot('04-layar-lan-wa');
          cek('layar LAN & WhatsApp terbuka', /Server LAN Multi-User/.test(t) && /WhatsApp Reminder/.test(t));
          cek('kedua saklar OFF bawaan', (t.match(/\bOFF\b/g) || []).length >= 2);

          // ---- saklar WhatsApp ON lewat klik + dialog konfirmasi asli (LAN tetap OFF)
          await klikTestId('saklar-whatsapp');
          await tunggu(800);
          await shot('05-konfirmasi-wa');
          cek('dialog konfirmasi WhatsApp muncul', /Nyalakan WhatsApp Reminder\?/.test(await teks()));
          await klikTeks('Nyalakan');
          await tunggu(3000);
          let st = await status();
          cek('WhatsApp ON, Server LAN tetap OFF', st.whatsapp.aktif && st.whatsapp.berjalan && st.server === 'NOT_CONFIGURED', JSON.stringify(st.whatsapp) + ' ' + st.server);
          await klikTeks('OK').catch(() => undefined);
          await tunggu(500);

          // ---- saklar LAN ON (port uji) — atur port dulu lewat pengaturan jaringan
          await js(`kopkuDesktop.lanWa.aturLan({ mode: 'DESKTOP', host: '127.0.0.1', port: ${PORT} })`);
          await tunggu(4500);
          await klikTestId('saklar-lan');
          await tunggu(800);
          cek('dialog konfirmasi Server LAN muncul', /Nyalakan Server LAN\?/.test(await teks()));
          await klikTeks('Nyalakan');
          await tunggu(3000);
          st = await status();
          cek('Server LAN ON + WhatsApp ON bersamaan', st.server === 'ONLINE' && st.whatsapp.berjalan, st.server);
          const h = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.status).catch((e) => String(e));
          cek('port LAN terbuka', h === 200, String(h));
          await klikTeks('OK').catch(() => undefined);
          await tunggu(4500);
          await shot('06-keduanya-on');

          // ---- WhatsApp OFF → LAN tetap ON
          await klikTestId('saklar-whatsapp');
          await tunggu(2500);
          st = await status();
          cek('WhatsApp OFF, Server LAN tetap ON', !st.whatsapp.aktif && !st.whatsapp.berjalan && st.server === 'ONLINE');
          await klikTeks('OK').catch(() => undefined);

          // ---- LAN OFF → port tertutup
          await klikTestId('saklar-lan');
          await tunggu(2500);
          st = await status();
          const h2 = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.status).catch(() => 'TERTUTUP');
          cek('Server LAN OFF → port tertutup', st.server === 'NOT_CONFIGURED' && h2 === 'TERTUTUP', String(h2));
          await klikTeks('OK').catch(() => undefined);
          await tunggu(4500);
          await shot('07-keduanya-off');
          await js(`(() => { const sv = [...document.querySelectorAll('div')].filter((d) => d.scrollHeight > d.clientHeight + 50 && getComputedStyle(d).overflowY !== 'visible' && d.innerText.includes('WhatsApp Reminder')); const x = sv[sv.length - 1]; if (x) x.scrollTop = x.scrollHeight; return !!x; })()`);
          await tunggu(800);
          await shot('07b-kredensial-riwayat');
          cek('form kredensial & riwayat tampil', /Simpan kredensial/.test(await teks()) && /Riwayat pengiriman/i.test(await teks()));

          // ---- Berkas › LAN & WhatsApp… dari Dashboard
          await klikTeks('Dashboard');
          await tunggu(1500);
          const item = Menu.getApplicationMenu().items.find((x) => x.label === 'Berkas').submenu.items.find((x) => /LAN & WhatsApp/.test(x.label));
          item.click();
          await tunggu(2000);
          cek('Berkas › LAN & WhatsApp… membuka layar', /Server LAN Multi-User/.test(await teks()));

          // ---- pencarian Ctrl+K
          win.webContents.send('menu', 'cari');
          await tunggu(800);
          await js(`(() => { const i = [...document.querySelectorAll('input')].pop(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'whatsapp'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
          await tunggu(800);
          await shot('08-cari-whatsapp');
          cek('Ctrl+K "whatsapp" menemukan LAN & WhatsApp', (await teks()).includes('LAN & WhatsApp'));
        } catch (e) {
          console.log('MENU-SMOKE-ERR', e && e.stack);
        }
        const gagal = Object.entries(hasil).filter(([, v]) => !v).map(([k]) => k);
        console.log(`MENU-SMOKE RINGKASAN ${Object.keys(hasil).length - gagal.length}/${Object.keys(hasil).length} lulus${gagal.length ? ' — gagal: ' + gagal.join('; ') : ''}`);
        fs.writeFileSync(path.join(out, 'hasil-menu-smoke.json'), JSON.stringify(hasil, null, 2));
        app.exit(0);
      });
      win.webContents.reload();
    } catch (e) {
      console.log('MENU-SMOKE-ERR', e && e.stack);
      app.exit(1);
    }
  });
};

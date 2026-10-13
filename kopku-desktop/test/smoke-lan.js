'use strict';
// Uji asap LAN Multi-User di ELECTRON NYATA (main.js + preload.js + renderer asli):
//  1) LAN Server Mode dari kopku-server.json → server ONLINE, adapter tersuntik, mutex terpasang.
//  2) Sebelum setup / tanpa lisensi: health NOT_CONFIGURED → LICENSE_REQUIRED, login 503 (fail-closed).
//  3) Data dibuat lewat service asli di renderer; status lisensi DIGANTI TIRUAN hanya di uji ini
//     (aktivasi lisensi butuh server lisensi) → login, baca pinjaman, bayar angsuran, konflik,
//     idempotensi — semuanya lewat IPC Electron sungguhan (main ⇄ preload ⇄ adapter).
//  4) Pengaturan › LAN & WhatsApp (jendela utama) berbicara lewat IPC lanmu:*; saklar WhatsApp berdiri sendiri.
// Jalankan: KOPKU_USERDATA=<dir> KOPKU_SMOKE=$PWD/test/smoke-lan.js KOPKU_SMOKE_OUT=<dir> electron .
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');
const PORT = Number(process.env.KOPKU_SMOKE_PORT || 47881);

module.exports = (win, app) => {
  const out = process.env.KOPKU_SMOKE_OUT;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(app.getPath('userData'), 'kopku-server.json'), JSON.stringify({ mode: 'LAN_SERVER', host: '127.0.0.1', port: PORT }));
  const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (c) => win.webContents.executeJavaScript(c);
  const base = `http://127.0.0.1:${PORT}`;
  const hasil = {};
  const cek = (nama, ok, info) => {
    hasil[nama] = !!ok;
    console.log(`LAN-SMOKE ${ok ? 'OK  ' : 'GAGAL'} ${nama}${info ? ' :: ' + info : ''}`);
  };
  let cookie = '';
  let csrf = '';
  const req = async (method, p, body, headers = {}) => {
    const h = Object.assign({ 'Content-Type': 'application/json' }, headers);
    if (cookie) h.Cookie = cookie;
    if (method !== 'GET') {
      if (csrf) h['X-KOPKU-CSRF'] = csrf;
      if (!h['Idempotency-Key']) h['Idempotency-Key'] = 'smoke' + Math.random().toString(36).slice(2) + Date.now();
    }
    const r = await fetch(base + p, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    for (const c of r.headers.getSetCookie()) if (c.startsWith('kopku_sid=')) cookie = c.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  win.webContents.once('did-finish-load', async () => {
    try {
      await tunggu(9000);
      const h0 = await req('GET', '/api/health');
      cek('server ONLINE dari konfigurasi', h0.status === 200 && h0.body.data.server === 'ONLINE');
      cek('health sebelum setup = NOT_CONFIGURED', h0.body.data.database === 'NOT_CONFIGURED', h0.body.data.database);
      cek('adapter tersuntik di renderer', await js('!!globalThis.__kopkuServerAdapter && globalThis.__kopkuServerAdapter.operasi.length > 10'));
      const ui = await fetch(base + '/');
      cek('web UI + CSP ketat', ui.status === 200 && /default-src 'self'/.test(ui.headers.get('content-security-policy')));

      // ---- data uji lewat service KOPKU asli di renderer
      const { bangunIndeks } = require('../electron/server/bundleIndex');
      const ids = bangunIndeks(path.join(__dirname, '..', 'renderer')).modul;
      const seed = await js(`(async () => {
        const ids = ${JSON.stringify(ids)}; const R = (k) => __r(ids[k]);
        await R('koperasi').setupKoperasi({ nama: 'Koperasi Smoke LAN', tahunBuku: 2026, adminUsername: 'admin', adminPassword: 'Admin#Kopku2026' });
        const d = await R('db').getDb(); const admin = (await d.getFirstAsync("SELECT id FROM app_user WHERE username='admin'")).id;
        const a = await R('anggota').createAnggota(admin, { namaLengkap: 'Anggota Smoke', tanggalBergabung: '2025-01-10', nomorHp: '081234567890', status: 'AKTIF' });
        for (const [jenis, nominal, periode] of [['POKOK',100000],['WAJIB',50000,'2026-01'],['SUKARELA',20000000]]) await R('simpanan').setorSimpanan({ anggotaId: a.id, jenis, tanggal: '2026-01-15', periode, nominal, sumberDana: 'KAS', createdBy: admin });
        const p = await R('pinjaman').ajukanPinjaman({ anggotaId: a.id, jumlahPinjaman: 6000000, tanggal: '2026-07-15', tenor: 6, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1.5, biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0, dendaAktif: false, createdBy: admin });
        await R('pinjaman').cairkanPinjaman({ pinjamanId: p.id, approvedBy: admin, tanggalPencairan: '2026-07-15', sumberDana: 'KAS' });
        return { pinjamanId: p.id };
      })()`);
      await tunggu(16000); // cache status server 15 dtk
      const h1 = await req('GET', '/api/health');
      cek('lisensi asli belum aktif → LICENSE_REQUIRED', h1.body.data.database === 'LICENSE_REQUIRED', h1.body.data.database);
      const l0 = await req('POST', '/api/auth/login', { username: 'admin', password: 'Admin#Kopku2026' });
      cek('login fail-closed tanpa lisensi (503)', l0.status === 503 && l0.body.kode === 'LISENSI', String(l0.status));

      // ---- TIRUAN lisensi (khusus uji ini)
      await js(`(() => { const ids = ${JSON.stringify(ids)}; const asli = globalThis.__r; const stub = { hasValidLocalLicense: async () => true };
        globalThis.__r = (id) => (id === ids.lisensi ? stub : asli(id)); return true; })()`);
      await tunggu(16000);
      const l1 = await req('POST', '/api/auth/login', { username: 'admin', password: 'Admin#Kopku2026' });
      csrf = l1.body && l1.body.data && l1.body.data.csrf;
      cek('login admin (scrypt existing via IPC nyata)', l1.status === 200 && !!csrf, String(l1.status));
      const lp = await req('POST', '/api/auth/login', { username: 'admin', password: 'salah' });
      cek('password salah ditolak', lp.status === 401);
      const pj = await req('GET', `/api/pinjaman/${seed.pinjamanId}`);
      cek('baca pinjaman + jadwal', pj.status === 200 && pj.body.data.jadwal.length === 6);
      const j = pj.body.data.jadwal[0];
      const body = { tanggal: '2026-08-15', nominal: 1090000, sumberDana: 'KAS', versiJadwal: j.versi };
      const kunci = { 'Idempotency-Key': 'smoke-bayar-0001' };
      const [b1, b2] = await Promise.all([req('POST', `/api/pinjaman/${seed.pinjamanId}/angsuran/${j.id}/bayar`, body, kunci), req('POST', `/api/pinjaman/${seed.pinjamanId}/angsuran/${j.id}/bayar`, body, kunci)]);
      cek('klik ganda → satu transaksi', [b1.status, b2.status].sort().join() === '200,409', `${b1.status},${b2.status}`);
      const b3 = await req('POST', `/api/pinjaman/${seed.pinjamanId}/angsuran/${j.id}/bayar`, body);
      cek('bayar ulang dengan data lama → KONFLIK', b3.status === 409 && b3.body.kode === 'KONFLIK');
      const n = await js(`(async () => { const d = await __r(${ids.db}).getDb(); return (await d.getFirstAsync('SELECT COUNT(*) n FROM angsuran_pembayaran')).n; })()`);
      cek('tepat 1 pembayaran di koperasi.db', n === 1, String(n));
      cek('mutex transaksi terpasang', await js(`!!__r(${ids.sqliteShim}).SQLiteDatabase.prototype.__kopkuMutexTerpasang`));
      const lap = await req('GET', '/api/laporan/posisi-keuangan?tanggal=2026-12-31');
      cek('laporan Posisi Keuangan seimbang', lap.status === 200 && lap.body.data.selisih === 0);
      const wa = await req('GET', '/api/whatsapp/pengaturan');
      cek('tidak ada pengaturan WhatsApp di web (1.0.21)', wa.status === 404);
      const waInfo = await js('kopkuDesktop.lanWa.waInfo()');
      cek('WhatsApp Reminder bawaan OFF (penjadwal tidak berjalan)', waInfo.scheduler.berjalan === false && waInfo.pengaturan.aktif === false);

      // ---- Pengaturan › LAN & WhatsApp lewat IPC nyata dari jendela utama
      const st = await js('kopkuDesktop.lanWa.status()');
      cek('status LAN & WhatsApp via IPC lanmu:*', st && st.server === 'ONLINE' && st.adapterSiap === true, st && st.server);
      cek('tidak ada jendela panel terpisah', BrowserWindow.getAllWindows().length === 1);
      const waOn = await js('kopkuDesktop.lanWa.aturWa(true)');
      const wa2 = await js('kopkuDesktop.lanWa.waInfo()');
      cek('saklar WhatsApp ON → penjadwal berjalan, LAN tetap online', waOn.whatsapp.berjalan === true && waOn.server === 'ONLINE' && wa2.scheduler.berjalan === true);
      const off = await js(`kopkuDesktop.lanWa.aturLan({ mode: 'DESKTOP' })`);
      cek('Server LAN OFF → server berhenti, WhatsApp tetap berjalan', off.server === 'NOT_CONFIGURED' && off.whatsapp.berjalan === true);
      const mati = await fetch(base + '/api/health').then(() => false, () => true);
      cek('port tertutup setelah Server LAN OFF', mati);
      const waOff = await js('kopkuDesktop.lanWa.aturWa(false)');
      cek('saklar WhatsApp OFF → semua berhenti', waOff.whatsapp.berjalan === false && waOff.server === 'NOT_CONFIGURED');
    } catch (e) {
      console.log('SMOKE-ERR', e && e.stack);
    }
    const gagal = Object.entries(hasil).filter(([, v]) => !v).length;
    console.log(`LAN-SMOKE RINGKAS ${Object.keys(hasil).length - gagal}/${Object.keys(hasil).length}`);
    app.exit(gagal ? 1 : 0);
  });
};

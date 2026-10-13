'use strict';
/**
 * main.js & preload.js ASLI (dimodifikasi) dimuat dengan tiruan Electron:
 *  - Desktop Mode (bawaan): semua kanal IPC lama tetap ada, webPreferences
 *    sama, menu lama utuh, TIDAK ada server/adapter/scheduler.
 *  - Pengaturan › LAN & WhatsApp (layar di jendela utama): dua saklar
 *    berdiri sendiri. Server LAN: main → preload → adapter → service KOPKU
 *    asli end-to-end lewat HTTP. WhatsApp Reminder dapat menyala tanpa
 *    Server LAN. IPC dari pengirim lain & balasan palsu ditolak.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buatMock, pasangMock } = require('./electronMock');
const { muatKopku, seed, PASSWORD, ROOT } = require('./kopkuHeadless');
const { Klien, portAcak } = require('./kit');

// Diambil dari electron/main.js KOPKU Desktop 1.0.5 ASLI (sebelum modul LAN).
const KANAL_HANDLE_ASLI = ['app:openData', 'auth:can', 'auth:prompt', 'dialog:open', 'dialog:save', 'firewall:perbaiki', 'firewall:status', 'fs:op', 'http:fetch', 'lan:info', 'lan:start', 'print:file', 'print:html', 'print:toPdf', 'qr:dataUrl', 'secure:get', 'secure:remove', 'secure:set', 'shell:openExternal', 'shell:openPath', 'shell:showItem', 'sqlite:all', 'sqlite:close', 'sqlite:exec', 'sqlite:get', 'sqlite:open', 'sqlite:run'];
const KANAL_ON_ASLI = ['app:title', 'fs:sync', 'lan:response', 'sys:info'];
const MENU_ASLI = { Berkas: ['Sinkron HP…', 'Backup & Restore…', 'Buka Folder Data', 'Keluar'], Tampilan: ['Dashboard', 'Data', 'Transaksi', 'Laporan', 'Pengaturan', 'Cari Menu…', 'Ciutkan / Lebarkan Sidebar'] };

let m;
let k;
let s;
let win;
let preloadApi;
const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  k = muatKopku({ lisensiValid: true });
  s = await seed(k);
  const headlessBridge = globalThis.kopkuDesktop;
  m = buatMock({
    // preload → main: srv:reply diteruskan ke listener ipcMain dengan pengirim = jendela utama
    onRendererSend: (ch, msg) => {
      for (const f of m.log.on.get(ch) || []) f({ sender: win.webContents }, msg);
    },
  });
  pasangMock(m.electron);
  require(path.join(ROOT, 'electron', 'preload.js'));
  preloadApi = m.log.exposed.kopkuDesktop;
  // Dunia utama renderer = bundle KOPKU (headless) + namespace server dari preload asli.
  globalThis.kopkuDesktop = Object.assign({}, headlessBridge, { server: preloadApi.server });
  require(path.join(ROOT, 'electron', 'main.js'));
  await tunggu(50);
  win = m.log.windows[0];
  // main → renderer: srv:call diteruskan ke listener preload asli
  win.webContents.hooks.send = (ch, req) => {
    if (ch === 'menu') (win.webContents.menuTerkirim = win.webContents.menuTerkirim || []).push(req);
    if (ch !== 'srv:call') return;
    if (win.webContents.palsukan) {
      // balasan palsu dari pengirim LAIN dengan id yang sama harus diabaikan main
      for (const f of m.log.on.get('srv:reply') || []) f({ sender: { bukan: 'jendela utama' } }, { id: req.id, hasil: { ok: true, value: { palsu: true } } });
    }
    for (const f of m.log.rendererOn.get('srv:call') || []) f({}, req);
  };
  win.webContents.hooks.executeJavaScript = async (code) => (0, eval)(code);
});
after(async () => {
  for (const f of m.log.appOn.get('will-quit') || []) f();
  await tunggu(50);
});

test('Desktop Mode: kanal IPC lama utuh, webPreferences aman tidak berubah, menu lama utuh', () => {
  for (const c of KANAL_HANDLE_ASLI) assert.ok(m.log.handle.has(c), c);
  for (const c of KANAL_ON_ASLI) assert.ok(m.log.on.has(c), c);
  const tambahan = [...m.log.handle.keys()].filter((c) => !KANAL_HANDLE_ASLI.includes(c)).sort();
  // DIPERBARUI 1.0.12: kanal konektor AI lokal 'mcp:*' ditambahkan.
  // DIPERBARUI 1.0.14: fitur Claude DIHAPUS (permintaan pengguna) → kanal 'mcp:*' tidak ada lagi.
  assert.deepEqual(tambahan, ['lanmu:akses', 'lanmu:aksesSimpan', 'lanmu:atur', 'lanmu:aturWa', 'lanmu:audit', 'lanmu:bukaAdmin', 'lanmu:firewall', 'lanmu:perintahFirewall', 'lanmu:qr', 'lanmu:sesi', 'lanmu:sesiCabut', 'lanmu:status', 'lanmu:waHapusToken', 'lanmu:waInfo', 'lanmu:waJalankan', 'lanmu:waKredensial', 'lanmu:waLog', 'lanmu:waSimpan', 'lanmu:waTestKoneksi', 'lanmu:waTestPesan', 'lanmu:waToken']);
  assert.ok(![...m.log.handle.keys()].some((c) => c.startsWith('mcp:')), 'tidak ada kanal konektor Claude');
  assert.deepEqual([...m.log.on.keys()].filter((c) => !KANAL_ON_ASLI.includes(c)), ['srv:reply']);
  const wp = win.opts.webPreferences;
  assert.equal(wp.contextIsolation, true);
  assert.equal(wp.nodeIntegration, false);
  assert.equal(wp.sandbox, true);
  assert.equal(win.url, 'app://kopku/');
  for (const [label, items] of Object.entries(MENU_ASLI)) {
    const sub = m.log.menu.find((x) => x.label === label).submenu.map((x) => x.label).filter(Boolean);
    for (const it of items) assert.ok(sub.includes(it), `${label} › ${it}`);
  }
  // preload: semua namespace lama tetap ada; tambahan hanya "server" & "lanWa".
  // DIPERBARUI 1.0.14: namespace "mcp" (konektor Claude, 1.0.12) DIHAPUS bersama fiturnya.
  assert.deepEqual(Object.keys(preloadApi).sort(), ['app', 'auth', 'dialog', 'firewall', 'fs', 'http', 'info', 'lan', 'lanWa', 'print', 'qr', 'secure', 'server', 'shell', 'sqlite']);
  assert.deepEqual(Object.keys(preloadApi.server), ['onCall']);
  // lanWa tidak punya fungsi yang mengembalikan token WhatsApp
  assert.ok(!Object.keys(preloadApi.lanWa).some((x) => /ambilToken|getToken|bacaToken/i.test(x)));
});

test('Desktop Mode: halaman dimuat → TIDAK ada server, adapter, atau injeksi kode', async () => {
  win.webContents.emit('did-navigate');
  win.webContents.emit('did-finish-load');
  await tunggu(100);
  assert.equal(m.log.executeJs.length, 0);
  assert.equal(globalThis.__kopkuServerAdapter, undefined);
  const Proto = k.R('sqliteShim').SQLiteDatabase.prototype;
  assert.equal(Proto.__kopkuMutexTerpasang, undefined, 'withTransactionAsync asli tidak dibungkus di Desktop Mode');
  const st = await m.log.handle.get('lanmu:status')({ sender: null });
  assert.equal(st.ok, false, 'IPC LAN & WhatsApp dari pengirim selain jendela utama ditolak');
  const st2 = await m.log.handle.get('lanmu:status')({ sender: win.webContents });
  assert.equal(st2.ok, true);
  assert.equal(st2.value.lanAktif, false);
  assert.equal(st2.value.whatsapp.aktif, false);
  assert.equal(st2.value.whatsapp.berjalan, false);
  assert.equal(m.log.executeJs.length, 0, 'membaca status tidak menyalakan apa pun');
  // 1.0.12 — konektor AI lokal (mcp:status) — DIHAPUS 1.0.14 bersama fitur Claude.
  assert.equal(m.log.handle.get('mcp:status'), undefined);
});

test('menu Berkas › LAN & WhatsApp… membuka layar Pengaturan (bukan jendela terpisah)', () => {
  const item = m.log.menu.find((x) => x.label === 'Berkas').submenu.find((x) => /LAN & WhatsApp/.test(x.label || ''));
  assert.ok(item, 'menu ada');
  const jumlahJendela = m.log.windows.length;
  item.click();
  assert.equal(m.log.windows.length, jumlahJendela, 'tidak membuka jendela baru');
  assert.deepEqual(win.webContents.menuTerkirim.slice(-1), ['lanwa']);
});

let port;
const ipc = (ch, ...a) => m.log.handle.get(ch)({ sender: win.webContents }, ...a);
test('saklar Server LAN ON: IPC hanya dari jendela utama; server online; WhatsApp tetap OFF', async () => {
  port = portAcak();
  const dariLain = await m.log.handle.get('lanmu:atur')({ sender: { bukan: 'jendela utama' } }, { mode: 'LAN_SERVER', host: '127.0.0.1', port });
  assert.equal(dariLain.ok, false, 'pengirim selain jendela utama tidak boleh mengatur server');
  const r = await ipc('lanmu:atur', { mode: 'LAN_SERVER', host: '127.0.0.1', port });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.server, 'ONLINE', JSON.stringify(r.value));
  assert.equal(r.value.lanAktif, true);
  assert.equal(r.value.adapterSiap, true);
  assert.equal(r.value.whatsapp.aktif, false);
  assert.equal(r.value.whatsapp.berjalan, false, 'WhatsApp Reminder tidak ikut menyala');
  assert.ok(m.log.executeJs.length >= 2, 'adapter disuntikkan ke renderer');
});

test('end-to-end: browser → HTTP → main → preload → adapter → service KOPKU asli', async () => {
  const c = new Klien(`http://127.0.0.1:${port}`);
  const l = await c.login('admin', PASSWORD.admin);
  assert.equal(l.status, 200, JSON.stringify(l.body));
  const p = await c.req('GET', `/api/pinjaman/${s.pinjaman[0]}`);
  assert.equal(p.status, 200);
  assert.equal(p.body.data.pinjaman.nomorPinjaman, 'PJ-2026-000001');
  const j = p.body.data.jadwal[0];
  const b = await c.req('POST', `/api/pinjaman/${s.pinjaman[0]}/angsuran/${j.id}/bayar`, { tanggal: '2026-08-15', nominal: 1090000, sumberDana: 'KAS', versiJadwal: j.versi });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.data.porsiPokok, 1000000);
  // balasan palsu dari pengirim selain jendela utama diabaikan
  win.webContents.palsukan = true;
  try {
    const d = await c.req('GET', '/api/dashboard');
    assert.equal(d.status, 200);
    assert.equal(d.body.data.palsu, undefined);
    assert.equal(d.body.data.anggotaAktif, 4);
  } finally {
    win.webContents.palsukan = false;
  }
  const st = await ipc('lanmu:status');
  assert.deepEqual(st.value.alamat, [], 'bind 127.0.0.1: tidak ada alamat LAN yang diiklankan');
});

test('navigasi dalam-halaman SPA (did-start-loading tanpa did-finish-load) TIDAK memutus layanan', async () => {
  // Urutan event nyata Electron 44 setelah KOPKU dimuat: did-start-loading → did-navigate-in-page → did-stop-loading
  win.webContents.emit('did-start-loading');
  win.webContents.emit('did-navigate-in-page');
  win.webContents.emit('did-stop-loading');
  const c = new Klien(`http://127.0.0.1:${port}`);
  assert.equal((await c.login('admin', PASSWORD.admin)).status, 200);
  assert.equal((await c.req('GET', '/api/dashboard')).status, 200);
});

test('muat ulang halaman: bridge diputus lalu adapter dipasang ulang otomatis', async () => {
  const sebelum = m.log.executeJs.length;
  win.webContents.emit('did-navigate');
  const c = new Klien(`http://127.0.0.1:${port}`);
  await c.login('admin', PASSWORD.admin).catch(() => undefined);
  win.webContents.emit('did-finish-load');
  await tunggu(200);
  assert.ok(m.log.executeJs.length > sebelum);
  const c2 = new Klien(`http://127.0.0.1:${port}`);
  assert.equal((await c2.login('admin', PASSWORD.admin)).status, 200);
});

test('saklar WhatsApp ON saat LAN ON → penjadwal berjalan; pengaturan & kredensial non-rahasia dari desktop', async () => {
  const on = await ipc('lanmu:aturWa', true);
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.equal(on.value.whatsapp.aktif, true);
  assert.equal(on.value.whatsapp.berjalan, true);
  assert.equal(on.value.server, 'ONLINE', 'Server LAN tidak tersentuh');
  const salah = await ipc('lanmu:waSimpan', { jamKirim: '25:00' });
  assert.equal(salah.ok, false);
  const ok = await ipc('lanmu:waSimpan', { jamKirim: '07:30', nomorTest: '0812-3456-7890', jenis: { H_PLUS_7: false }, aktif: false });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.value.pengaturan.jamKirim, '07:30');
  assert.equal(ok.value.pengaturan.jenis.H_PLUS_7, false);
  assert.equal(ok.value.pengaturan.aktif, true, 'waSimpan tidak mengubah saklar (hanya lewat aturWa)');
  const kr = await ipc('lanmu:waKredensial', { WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_TEMPLATE_NAME: 'kopku_pengingat_angsuran', WHATSAPP_ACCESS_TOKEN: 'EAAGharusDiabaikan1234567890' });
  assert.equal(kr.ok, true, JSON.stringify(kr));
  assert.equal(kr.value.kredensial.phoneNumberIdTersedia, true);
  assert.equal(kr.value.kredensial.sumber.WHATSAPP_PHONE_NUMBER_ID, 'APLIKASI');
  assert.equal(kr.value.kredensial.accessTokenTersedia, false, 'token tidak bisa diisi lewat kredensial non-rahasia');
  const krSalah = await ipc('lanmu:waKredensial', { WHATSAPP_TEMPLATE_NAME: 'Nama Salah!' });
  assert.equal(krSalah.ok, false);
  const tok = await ipc('lanmu:waToken', 'EAAGtokenDESKTOPuji1234567890abc');
  assert.equal(tok.ok, true, JSON.stringify(tok));
  assert.equal(tok.value.kredensial.sumberAccessToken, 'SECURE_STORE');
  assert.ok(!JSON.stringify(tok.value).includes('EAAGtokenDESKTOPuji'), 'token tidak dikembalikan ke layar');
  const log = await ipc('lanmu:waLog', { limit: 5 });
  assert.equal(log.ok, true);
});

test('saklar Server LAN OFF → port tertutup, WhatsApp Reminder TETAP berjalan', async () => {
  const r = await ipc('lanmu:atur', { mode: 'DESKTOP' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.server, 'NOT_CONFIGURED');
  assert.equal(r.value.whatsapp.berjalan, true);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
});

test('muat ulang halaman saat hanya WhatsApp ON: adapter dipasang ulang, penjadwal tetap berjalan', async () => {
  const sebelum = m.log.executeJs.length;
  win.webContents.emit('did-navigate');
  win.webContents.emit('did-finish-load');
  await tunggu(200);
  assert.ok(m.log.executeJs.length > sebelum);
  const st = await ipc('lanmu:status');
  assert.equal(st.value.whatsapp.berjalan, true);
  assert.equal(st.value.adapterSiap, true);
});

test('saklar WhatsApp OFF (LAN juga OFF) → semua berhenti; LAN bisa dinyalakan lagi tanpa WhatsApp', async () => {
  const off = await ipc('lanmu:aturWa', false);
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(off.value.whatsapp.aktif, false);
  assert.equal(off.value.whatsapp.berjalan, false);
  assert.equal(off.value.server, 'NOT_CONFIGURED');
  const jalan = await ipc('lanmu:waJalankan');
  assert.equal(jalan.ok, false, 'jalankan manual ditolak saat WhatsApp OFF');
  const lan = await ipc('lanmu:atur', { mode: 'LAN_SERVER', host: '127.0.0.1', port });
  assert.equal(lan.value.server, 'ONLINE');
  assert.equal(lan.value.whatsapp.berjalan, false);
  const h = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(h.status, 200);
});

test('kembali ke Desktop Mode: server berhenti (Server Offline)', async () => {
  const r = await ipc('lanmu:atur', { mode: 'DESKTOP' });
  assert.equal(r.value.server, 'NOT_CONFIGURED');
  assert.equal(r.value.whatsapp.berjalan, false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
});

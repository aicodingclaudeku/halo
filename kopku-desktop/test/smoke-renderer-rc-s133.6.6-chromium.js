'use strict';
// Uji asap RC-S133.6.6 (Desktop 1.0.21) — UI/UX popup desktop — pada BUNDLE RENDERER TERTAMBAL (Chromium + jembatan desktop tiruan).
//  - dialog notifikasi/konfirmasi bergaya kotak dialog desktop (urutan tombol Windows, fokus awal tombol utama, Enter/Esc tepat sekali);
//  - <Modal> non-transparan (pemilih) tampil sebagai jendela dialog di tengah, bukan layar penuh;
//  - layar Pengaturan › LAN & WhatsApp memuat Akses LAN Pengguna, Sesi aktif, Audit log (dulu di Panel Web).
// SQLite = SqliteHost asli; lisensi dibungkus HANYA di uji ini (route Playwright), bundle di disk tidak diubah.
// Pemakaian: (1) `node test/sajikan-renderer.js renderer 8828`  (2) `node test/smoke-renderer-rc-s133.6.6-chromium.js <folder paket> 8828 <folder-hasil>`
// Butuh paket `playwright` (Chromium) dan aset font ikon di renderer/assets (lihat scripts/lengkapi-aset-renderer.js).
const path = require('path'), fs = require('fs'), os = require('os');
const { chromium } = (() => { try { return require('playwright'); } catch { return require(process.env.PLAYWRIGHT_PATH || 'playwright-core'); } })();
const WIN = process.argv[2], PORT = +process.argv[3], OUT = process.argv[4];
const { SqliteHost } = require(path.join(WIN, 'electron/hosts/sqliteHost.js'));
const { bangunIndeks } = require(path.join(WIN, 'electron/server/bundleIndex.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-smoke-'));
const host = new SqliteHost(path.join(tmp, 'SQLite'));
const secure = new Map();
(async () => {
  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const logs = []; pg.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  await pg.exposeFunction('__kopkuCall', async (ch, args) => {
    try {
      const [a, c, d] = args;
      let v;
      if (ch === 'sqlite:open') v = host.open(a, undefined);
      else if (ch === 'sqlite:exec') v = host.exec(a, c);
      else if (ch === 'sqlite:run') v = host.run(a, c, d);
      else if (ch === 'sqlite:get') v = host.get(a, c, d);
      else if (ch === 'sqlite:all') v = host.all(a, c, d);
      else if (ch === 'sqlite:close') v = host.close(a);
      else if (ch === 'secure:get') v = secure.has(a) ? secure.get(a) : null;
      else if (ch === 'secure:set') { secure.set(a, c); v = null; }
      else if (ch === 'secure:remove') { secure.delete(a); v = null; }
      else v = null;
      return { ok: true, value: v === undefined ? null : v };
    } catch (e) { return { ok: false, error: { message: String(e && e.message || e), code: e && e.code } }; }
  });
  await pg.addInitScript(({ tmp }) => {
    const call = (ch, ...a) => window.__kopkuCall(ch, a).then((r) => { if (r.ok) return r.value; const e = new Error(r.error.message); e.code = r.error.code; throw e; });
    const tolak = () => { throw new Error('fs sinkron tidak diemulasi'); };
    const nol = async () => null;
    window.kopkuDesktop = {
      info: { platform: 'win32', platformLabel: 'Windows', hostname: 'uji', version: '1.0.21', documentUri: 'kopkufs://local' + tmp + '/doc/', cacheUri: 'kopkufs://local' + tmp + '/cache/', dataDir: tmp },
      sqlite: { open: (n, d) => call('sqlite:open', n, d), exec: (i, s) => call('sqlite:exec', i, s), run: (i, s, p) => call('sqlite:run', i, s, p), get: (i, s, p) => call('sqlite:get', i, s, p), all: (i, s, p) => call('sqlite:all', i, s, p), close: (i) => call('sqlite:close', i) },
      fs: { uriToPath: (u) => String(u).replace('kopkufs://local', ''), pathToUri: (p) => 'kopkufs://local' + p, info: async () => ({ exists: false, isDirectory: false }), readString: nol, writeString: nol, remove: nol, move: nol, copy: nol, mkdir: nol, readDir: async () => [], statSync: () => ({ exists: false }), createSync: tolak, removeSync: tolak, openSync: tolak, readSync: tolak, writeSync: tolak, closeSync: tolak },
      secure: { get: (k) => call('secure:get', k), set: (k, v) => call('secure:set', k, v), remove: (k) => call('secure:remove', k) },
      print: { toPdf: nol, printHtml: nol, printFile: nol }, dialog: { openFiles: async () => [], saveFile: nol },
      shell: { openPath: nol, showItem: nol, openExternal: nol }, http: { fetch: async () => { throw new Error('offline'); } },
      auth: { canBiometric: async () => false, promptBiometric: async () => false },
      lan: { start: nol, info: nol, onRequest() {}, onPing() { return () => {}; } }, firewall: { status: nol, perbaiki: nol }, qr: { toDataUrl: nol },
      server: { onCall() {} }, lanWa: {
        status: async () => ({ mode: 'LAN_SERVER', lanAktif: true, server: 'ONLINE', adapterSiap: true, host: '0.0.0.0', port: 47880, protokol: 'http', alamat: [{ antarmuka: 'Wi-Fi', alamat: '192.168.1.10', url: 'http://192.168.1.10:47880' }], urlLokal: 'http://127.0.0.1:47880', hanyaJaringanPrivat: true, https: false, galat: null, whatsapp: { aktif: false, berjalan: false, galat: null } }),
        waInfo: async () => ({ pengaturan: { aktif: false, jamKirim: '08:00', jenis: { H_MIN_3: true, H_MIN_1: true, H: true, H_PLUS_1: true, H_PLUS_7: false }, nomorTest: '' }, jenisDaftar: [{ kunci: 'H_MIN_3', label: 'H-3', keterangan: '3 hari sebelum' }, { kunci: 'H', label: 'H', keterangan: 'hari jatuh tempo' }], kredensial: { lengkap: false, phoneNumberIdTersedia: false, accessTokenTersedia: false, sumber: {}, templateLang: 'id', apiVersion: 'v21.0' }, nilaiAplikasi: {}, scheduler: { berjalan: false }, ringkasan: {}, berjalan: false, galat: null }),
        waLog: async () => ({ baris: [], ringkasan: {} }),
        qr: async () => 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
        akses: async (users) => (window.__aksesDiterima = users, users.map((u, i) => Object.assign({}, u, { labelPeran: { ADMIN: 'Admin', BENDAHARA: 'Bendahara', PETUGAS: 'Operator (Petugas)', PENGURUS: 'Pengurus' }[u.role] || u.role, aksesLan: u.role === 'ADMIN' || i === 1, profil: i === 2 ? 'PENGAWAS' : 'IKUT_ROLE', dapatDiubah: u.role !== 'ANGGOTA' }))),
        aksesSimpan: async (o) => (window.__aksesSimpan = o, { userId: o.pengguna.id, aktif: o.aktif, profil: o.profil }),
        sesi: async () => [{ id: 'a1b2c3d4e5f60718', userId: 'x', ip: '192.168.1.23', perangkat: 'Mozilla/5.0 (Linux; Android 14) Chrome/128 Mobile', mulai: new Date().toISOString(), terakhir: new Date().toISOString() }],
        sesiCabut: async () => ({ dicabut: true }),
        audit: async () => ({ halaman: 1, limit: 15, baris: [{ id: 3, waktu: new Date().toISOString(), username: 'bendahara', action: 'LOGIN', status: 'BERHASIL', ip: '192.168.1.23' }, { id: 2, waktu: new Date().toISOString(), username: 'admin', action: 'LAN_AKSES_UBAH', entity: 'lan_akses', status: 'BERHASIL' }, { id: 1, waktu: new Date().toISOString(), username: 'tamu', action: 'LOGIN_GAGAL', status: 'GAGAL', ip: '192.168.1.40' }] }),
        aturLan: nol, aturWa: nol, firewall: nol, perintahFirewall: nol, bukaAdmin: nol, waSimpan: nol, waKredensial: nol, waToken: nol, waHapusToken: nol, waTestKoneksi: nol, waTestPesan: nol, waJalankan: nol,
      }, app: { openDataFolder: nol, onMenu() { return () => {}; }, setTitle() {} },
    };
  }, { tmp });
  // Lisensi asli butuh aktivasi ke server → HANYA di uji ini modul lisensi dibungkus (bundle di disk tidak diubah).
  {
    const { cariBerkasBundle } = require(path.join(WIN, 'electron/server/bundleIndex.js'));
    const { segmenModul } = require(path.join(WIN, 'scripts/peta-modul-bundle.js'));
    const berkas = cariBerkasBundle(path.join(WIN, 'renderer'));
    const idLis = bangunIndeks(path.join(WIN, 'renderer')).modul.lisensi;
    await pg.route('**/entry-*.js', async (route) => {
      const t = fs.readFileSync(berkas, 'utf8');
      const sg = segmenModul(t).get(idLis);
      const badan = t.slice(sg.mulai, sg.akhir);
      const mh = /^__d\(function\(([^)]*)\)\{/.exec(badan);
      const ps = mh[1].split(','); const ex = ps[5]; ps[5] = ex + '__asli';
      const mt = /\},(\d+),\[([0-9,]*)\]\);?$/.exec(badan);
      const isi = badan.slice(mh[0].length, mt.index);
      const ganti = `__d(function(${ps.join(',')}){var ${ex}={};(function(){${isi}\n})();var __ov={hasValidLocalLicense:async function(){return true},getLicenseStatus:async function(){return {state:'ACTIVE',allowAppAccess:true,licenseType:'FULL',cooperativeName:'Koperasi Uji Desktop',activatedAt:null,expiresAt:null,lastVerifiedAtMs:Date.now(),graceRemainingMs:null,clockRollbackDetected:false,serverVerificationDue:false,deviceId:'uji',hasStoredLicense:true}}};Object.getOwnPropertyNames(${ex}).forEach(function(k){Object.defineProperty(${ex}__asli,k,{enumerable:true,get:function(){return k in __ov?__ov[k]:${ex}[k]}})});},${mt[1]},[${mt[2]}]);`;
      await route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Cross-Origin-Resource-Policy': 'same-origin' }, body: t.slice(0, sg.mulai) + ganti + t.slice(sg.akhir) });
    });
  }
  await pg.goto('http://localhost:' + PORT + '/');
  await pg.waitForTimeout(9000);
  const idx = bangunIndeks(path.join(WIN, 'renderer')).modul;
  const cek = {}; const ok = (n, v, info) => { cek[n] = { ok: !!v, info }; console.log(v ? 'OK  ' : 'GAGAL', n, info || ''); };
  const s1 = await pg.evaluate(async ({ idx }) => {
    const R = (k) => __r(idx[k]);
    await R('koperasi').setupKoperasi({ nama: 'Koperasi Uji Desktop', tahunBuku: 2026, tanggalBerdiri: '2020-01-01', adminNama: 'Administrator', adminUsername: 'admin', adminPassword: 'Admin#Kopku2026' });
    const db = await R('db').getDb();
    const admin = (await db.getFirstAsync("SELECT id FROM app_user WHERE username = 'admin'")).id;
    const UA = R('userAdmin');
    await UA.createUser(admin, { nama: 'Siti Bendahara', username: 'bendahara', role: 'BENDAHARA', password: 'Bendahara#Kopku2026' });
    await UA.createUser(admin, { nama: 'Budi Pengawas', username: 'pengawas', role: 'PENGURUS', password: 'Pengawas#Kopku2026' });
    const g = globalThis.__kopkuModalDesktop;
    return { modal: !!g && __r(idx.sqliteShim) !== undefined };
  }, { idx });
  await pg.reload(); await pg.waitForTimeout(8000);
  await pg.screenshot({ path: OUT + '/01-awal.png' });
  // login
  if (await pg.locator('input[type=password]').count()) {
    await pg.locator('input').first().fill('admin'); await pg.locator('input[type=password]').first().fill('Admin#Kopku2026');
    await pg.keyboard.press('Enter'); await pg.waitForTimeout(6000);
  }
  await pg.screenshot({ path: OUT + '/02-masuk.png' });
  const st = await pg.evaluate(() => {
    const w = globalThis.__kopkuModalDesktop;
    return { pasang: !!w, alih: !!w && Object.values(globalThis).length > 0 };
  });
  ok('pembungkus Modal desktop terpasang', st.pasang);
  // notify: konfirmasi & sukses
  const NOTIFY = 765;
  await pg.evaluate((id) => __r(id).notify('Hapus rekening bank?', 'Rekening "BRI Operasional" akan dinonaktifkan. Riwayat transaksi tetap tersimpan dan dapat dilihat di laporan.', [{ text: 'Batal', style: 'cancel' }, { text: 'Hapus', style: 'destructive' }], 'warning'), NOTIFY);
  await pg.waitForTimeout(700);
  await pg.screenshot({ path: OUT + '/03-konfirmasi.png' });
  const latar0 = await pg.evaluate(() => [...document.querySelectorAll('div')].filter((x) => /rgba\(15, 23, 32/.test(getComputedStyle(x).backgroundColor)).map((x) => getComputedStyle(x).backgroundColor + ' ' + Math.round(x.getBoundingClientRect().width) + 'x' + Math.round(x.getBoundingClientRect().height) + ' op=' + getComputedStyle(x).opacity));
  console.log('LATAR', JSON.stringify(latar0));
  const teksDialog = await pg.evaluate(() => document.body.innerText);
  const urutan = await pg.evaluate(() => { const b = [...document.querySelectorAll('[role=button]')].map((x) => x.innerText.trim()).filter((t) => t === 'Batal' || t === 'Hapus'); return b.join(','); });
  ok('dialog konfirmasi: Batal paling kanan (gaya Windows)', urutan === 'Hapus,Batal', urutan);
  await pg.keyboard.press('Escape'); await pg.waitForTimeout(500);
  ok('Esc menutup dialog', !(await pg.evaluate(() => document.body.innerText.includes('BRI Operasional'))));
  await pg.evaluate((id) => __r(id).notify('Hapus data?', 'Uji Enter.', [{ text: 'Batal', style: 'cancel', onPress: () => (window.__pilih = (window.__pilih || '') + 'B') }, { text: 'Hapus', style: 'destructive', onPress: () => (window.__pilih = (window.__pilih || '') + 'H') }], 'warning'), NOTIFY);
  await pg.waitForTimeout(600);
  const fokus = await pg.evaluate(() => (document.activeElement && document.activeElement.innerText || '').trim());
  await pg.keyboard.press('Enter'); await pg.waitForTimeout(500);
  ok('fokus awal di tombol utama; Enter = tombol utama tepat sekali', fokus === 'Hapus' && (await pg.evaluate(() => window.__pilih)) === 'H', fokus + ' / ' + (await pg.evaluate(() => window.__pilih)));
  await pg.evaluate((id) => __r(id).notify('Hapus data?', 'Uji Esc.', [{ text: 'Batal', style: 'cancel', onPress: () => (window.__pilih2 = (window.__pilih2 || '') + 'B') }, { text: 'Hapus', style: 'destructive', onPress: () => (window.__pilih2 = (window.__pilih2 || '') + 'H') }], 'warning'), NOTIFY);
  await pg.waitForTimeout(600);
  await pg.keyboard.press('Escape'); await pg.waitForTimeout(500);
  ok('Esc = Batal tepat sekali', (await pg.evaluate(() => window.__pilih2)) === 'B', await pg.evaluate(() => window.__pilih2));
  await pg.evaluate((id) => __r(id).notify('Berhasil', 'Data anggota tersimpan.', undefined, 'success'), NOTIFY);
  await pg.waitForTimeout(700);
  await pg.screenshot({ path: OUT + '/04-sukses.png' });
  await pg.keyboard.press('Enter'); await pg.waitForTimeout(500);
  ok('Enter menutup notifikasi', !(await pg.evaluate(() => document.body.innerText.includes('Data anggota tersimpan.'))));
  // Layar LAN & WhatsApp
  await pg.evaluate(() => { location.hash = ''; });
  const nav = await pg.evaluate(() => { const a = [...document.querySelectorAll('a,[role=link],[role=button]')].find((x) => /LAN & WhatsApp/.test(x.innerText || '')); if (a) { a.click(); return true; } return false; });
  if (!nav) { await pg.keyboard.press('Control+k'); await pg.waitForTimeout(500); await pg.keyboard.type('LAN'); await pg.waitForTimeout(500); await pg.keyboard.press('Enter'); }
  await pg.waitForTimeout(3000);
  await pg.screenshot({ path: OUT + '/05-lan.png', fullPage: true });
  const teksLan = await pg.evaluate(() => document.body.innerText);
  for (const [i, y] of [[1, 640], [2, 1250]]) {
    await pg.evaluate((y) => { const el = document.querySelector('[data-testid=layar-lan-whatsapp]'); if (el) el.scrollTop = y; }, y);
    await pg.waitForTimeout(400);
    await pg.screenshot({ path: OUT + '/05-lan-' + i + '.png' });
  }
  ok('layar LAN: bagian Akses LAN Pengguna', teksLan.includes('Akses LAN Pengguna'));
  ok('layar LAN: sesi aktif & audit log', /sesi aktif di browser/i.test(teksLan) && /audit log lan/i.test(teksLan) && teksLan.includes('Ubah akses LAN'));
  ok('layar LAN: tidak menyebut Panel Web', !/Panel Web/.test(teksLan));
  ok('daftar pengguna dari User Management dikirim', (await pg.evaluate(() => (window.__aksesDiterima || []).length)) === 3);
  // ubah profil bendahara → Pengawas
  const klik = await pg.evaluate(() => { const b = [...document.querySelectorAll('[role=button],div[tabindex]')].filter((x) => (x.innerText || '').trim() === 'Pengawas (baca saja)'); if (b[1]) { b[1].click(); return true; } return false; });
  await pg.waitForTimeout(800);
  const simpan = await pg.evaluate(() => window.__aksesSimpan);
  ok('ubah profil → lanmu:aksesSimpan', klik && simpan && simpan.profil === 'PENGAWAS' && simpan.oleh && simpan.oleh.username === 'admin', JSON.stringify(simpan));
  // akhiri sesi → konfirmasi bergaya desktop
  await pg.evaluate(() => { const b = [...document.querySelectorAll('[role=button]')].find((x) => /Akhiri$/.test((x.innerText || '').trim())); b && b.click(); });
  await pg.waitForTimeout(700);
  await pg.screenshot({ path: OUT + '/06-akhiri-sesi.png' });
  const latar = await pg.evaluate(() => { const d = [...document.querySelectorAll('div')].find((x) => getComputedStyle(x).backgroundColor === 'rgba(15, 23, 32, 0.32)'); return d ? d.getBoundingClientRect().width : 0; });
  ok('latar dialog meredupkan layar', latar > 1000, String(latar));
  await pg.keyboard.press('Escape'); await pg.waitForTimeout(400);
  // pemilih (Modal non-transparan) → jendela dialog di tengah, bukan layar penuh
  await pg.evaluate(() => { location.hash = ''; });
  await pg.keyboard.press('Control+k'); await pg.waitForTimeout(400); await pg.keyboard.type('Buku Besar'); await pg.waitForTimeout(400); await pg.keyboard.press('Enter');
  await pg.waitForTimeout(2500);
  const bukaPicker = await pg.evaluate(() => { const b = [...document.querySelectorAll('[role=button],div[tabindex]')].find((x) => /Pilih akun/i.test(x.innerText || '')); if (b) { b.click(); return true; } return false; });
  await pg.waitForTimeout(900);
  await pg.screenshot({ path: OUT + '/07-pemilih-akun.png' });
  const kotak = await pg.evaluate(() => { const t = [...document.querySelectorAll('div')].find((x) => (x.innerText || '').startsWith('Pilih Akun') && x.getBoundingClientRect().width < 900 && x.getBoundingClientRect().width > 300); return t ? t.getBoundingClientRect().width : 0; });
  ok('pemilih akun tampil sebagai jendela dialog (bukan layar penuh)', bukaPicker && kotak > 0 && kotak <= 762, String(kotak));
  await pg.keyboard.press('Escape'); await pg.waitForTimeout(500);
  ok('tanpa galat halaman', logs.length === 0, logs.slice(0, 3).join(' | '));
  fs.writeFileSync(OUT + '/hasil.json', JSON.stringify(cek, null, 1));
  await b.close();
  process.exit(Object.values(cek).every((x) => x.ok) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

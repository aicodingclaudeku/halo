'use strict';
// Uji asap KOPKU Desktop 1.0.34 (RC-S133.6.11) — layar Laporan › Kolektibilitas Piutang pada BUNDLE RENDERER TERTAMBAL
// (Chromium + jembatan desktop tiruan, SQLite = SqliteHost asli di folder sementara; tidak menyentuh data pengguna).
//  - "Target hasil penggolongan" = target jurnal SEMUA anggota (getTotalPenyisihanTarget), bukan total lingkup AKTIF;
//  - catatan lingkup tampil bila anggota nonaktif punya pinjaman bermasalah;
//  - rincian per pinjaman memuat angsuran jatuh tempo belum lunas & jasa belum jatuh tempo.
// Pemakaian: (1) `node test/sajikan-renderer.js renderer 8829`  (2) `node test/smoke-kolektibilitas-chromium.js <folder paket> 8829 <folder-hasil>`
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
      info: { platform: 'win32', platformLabel: 'Windows', hostname: 'uji', version: '1.0.34', documentUri: 'kopkufs://local' + tmp + '/doc/', cacheUri: 'kopkufs://local' + tmp + '/cache/', dataDir: tmp },
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
  const data = await pg.evaluate(async ({ idx }) => {
    const R = (k) => __r(idx[k]);
    await R('koperasi').setupKoperasi({ nama: 'Koperasi Uji Desktop', tahunBuku: 2026, tanggalBerdiri: '2020-01-01', adminNama: 'Administrator', adminUsername: 'admin', adminPassword: 'Admin#Kopku2026' });
    const db = await R('db').getDb();
    const admin = (await db.getFirstAsync("SELECT id FROM app_user WHERE username = 'admin'")).id;
    const buat = async (nama, cair) => {
      const a = (await R('anggota').createAnggota(admin, { namaLengkap: nama, tanggalBergabung: '2025-01-10', status: 'AKTIF' })).id;
      await R('simpanan').setorSimpanan({ anggotaId: a, jenis: 'POKOK', tanggal: '2026-01-15', nominal: 100000, sumberDana: 'KAS', createdBy: admin });
      await R('simpanan').setorSimpanan({ anggotaId: a, jenis: 'WAJIB', tanggal: '2026-01-15', periode: '2026-01', nominal: 50000, sumberDana: 'KAS', createdBy: admin });
      await R('simpanan').setorSimpanan({ anggotaId: a, jenis: 'SUKARELA', tanggal: '2026-01-15', nominal: 20000000, sumberDana: 'KAS', createdBy: admin });
      const p = await R('pinjaman').ajukanPinjaman({ anggotaId: a, jumlahPinjaman: 6000000, tanggal: cair, tenor: 6, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1.5, biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0, dendaAktif: false, createdBy: admin });
      await R('pinjaman').cairkanPinjaman({ pinjamanId: p.id, approvedBy: admin, tanggalPencairan: cair, sumberDana: 'KAS' });
      return { a, p: p.id };
    };
    const kl = await buat('Ani Kurang Lancar', '2026-06-05');
    await buat('Budi Lancar', '2026-06-20');
    const non = await buat('Citra Nonaktif', '2026-06-05');
    await db.runAsync("UPDATE anggota SET status = 'TIDAK_AKTIF' WHERE id = ?", non.a);
    const K = R('kolektibilitas');
    const tgl = ['2026-10-14', '2026-12-31'];
    const out = {};
    for (const t of tgl) {
      const aktif = await K.getKlasifikasiPinjamanAktif(db, { tanggalLaporan: t, statusAnggota: 'AKTIF' });
      out[t] = { target: await K.getTotalPenyisihanTarget(db, t), aktif: aktif.reduce((s, x) => s + x.nilaiCadangan, 0) };
    }
    const nomor = (await db.getFirstAsync('SELECT nomor_pinjaman n FROM pinjaman WHERE id = ?', kl.p)).n;
    return { out, nomor };
  }, { idx });
  console.log('DATA', JSON.stringify(data));
  await pg.reload(); await pg.waitForTimeout(8000);
  if (await pg.locator('input[type=password]').count()) {
    await pg.locator('input').first().fill('admin'); await pg.locator('input[type=password]').first().fill('Admin#Kopku2026');
    await pg.keyboard.press('Enter'); await pg.waitForTimeout(6000);
  }
  await pg.keyboard.press('Control+k'); await pg.waitForTimeout(500); await pg.keyboard.type('Kolektibilitas Piutang'); await pg.waitForTimeout(600); await pg.keyboard.press('Enter');
  await pg.waitForTimeout(5000);
  await pg.screenshot({ path: OUT + '/01-kolektibilitas.png', fullPage: true });
  await pg.evaluate(() => { const el = [...document.querySelectorAll('div')].reverse().find((x) => (x.innerText || '').trim() === 'Taksiran Piutang Tak Tertagih'); el && el.scrollIntoView({ block: 'start' }); });
  await pg.waitForTimeout(600);
  await pg.screenshot({ path: OUT + '/01b-target-penyisihan.png' });
  const teks = await pg.evaluate(() => document.body.innerText);
  const rp = (n) => 'Rp' + n.toLocaleString('id-ID');
  const m = /Target hasil penggolongan\s*\n?\s*(Rp[\d.]+)/.exec(teks);
  const tampil = m ? m[1] : null;
  const cocok = Object.entries(data.out).find(([, v]) => rp(v.target) === tampil);
  ok('layar Kolektibilitas Piutang terbuka', /Taksiran Piutang Tak Tertagih/.test(teks));
  ok('Target hasil penggolongan = target jurnal SEMUA anggota (bukan total lingkup AKTIF)', !!cocok && cocok[1].target !== cocok[1].aktif, `${tampil} per ${cocok ? cocok[0] : '?'} ${JSON.stringify(data.out)}`);
  ok('catatan lingkup: target mencakup semua anggota', /Target di atas mencakup semua anggota/.test(teks) && (!cocok || teks.includes(rp(cocok[1].aktif))));
  // buka rincian pinjaman Kurang Lancar
  const buka = await pg.evaluate((n) => { const el = [...document.querySelectorAll('[role=button],div[tabindex]')].reverse().find((x) => (x.innerText || '').includes(n)); if (el) { el.click(); return true; } return false; }, data.nomor);
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: OUT + '/02-rincian.png', fullPage: true });
  const teks2 = await pg.evaluate(() => document.body.innerText);
  ok('rincian per pinjaman: angsuran jatuh tempo belum lunas & jasa belum jatuh tempo', buka && /Angsuran jatuh tempo belum lunas/.test(teks2) && /Jasa belum jatuh tempo/.test(teks2), data.nomor);
  ok('tanpa galat halaman', logs.length === 0, logs.slice(0, 3).join(' | '));
  fs.writeFileSync(OUT + '/hasil.json', JSON.stringify(cek, null, 1));
  await b.close();
  process.exit(Object.values(cek).every((x) => x.ok) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

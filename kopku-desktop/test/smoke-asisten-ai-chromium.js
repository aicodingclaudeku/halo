'use strict';
// Uji asap Pengaturan › Asisten AI (Desktop 1.0.25) pada BUNDLE RENDERER TERTAMBAL di Chromium:
//  - menu tampil di sidebar Pengaturan, layar "Semua Pengaturan", dan pencarian Ctrl+K;
//  - layar asli (renderer-patch/AsistenAiScreen.js) memakai kanal IPC ASLI (electron/mcp/ipc.js) + McpHost ASLI;
//  - menyalakan → konfirmasi → host 127.0.0.1 menyala & entri "kopku" ditulis ke claude_desktop_config.json TIRUAN
//    (server MCP lain tidak disentuh);
//  - klien MCP stdio SUNGGUHAN (node electron/mcp/stdio.js, seperti Claude Desktop) membaca data koperasi
//    lewat adapter → service KOPKU asli di halaman ini → SQLite; aktivitas tampil di layar;
//  - "Buat & buka ekstensi" menghasilkan paket .mcpb (ZIP sah) dan melepas entri konfigurasi (tidak ganda).
// SQLite = SqliteHost asli; lisensi dibungkus HANYA di uji ini (route Playwright), bundle di disk tidak diubah.
// Pemakaian: node test/smoke-asisten-ai-chromium.js <folder-hasil>
// Butuh paket `playwright` (Chromium). Set PLAYWRIGHT_PATH bila tidak terpasang lokal.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(process.env.PLAYWRIGHT_PATH || 'playwright-core');
  }
})();

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-asisten-ui-')));
fs.mkdirSync(OUT, { recursive: true });
const { SqliteHost } = require(path.join(ROOT, 'electron/hosts/sqliteHost.js'));
const { bangunIndeks, cariBerkasBundle } = require(path.join(ROOT, 'electron/server/bundleIndex.js'));
const { pasangAdapter } = require(path.join(ROOT, 'electron/server/rendererAdapter.js'));
const { McpHost } = require(path.join(ROOT, 'electron/mcp/host.js'));
const { daftarkanIpcAsistenAi } = require(path.join(ROOT, 'electron/mcp/ipc.js'));
const { pasangAdapterTulis, indeksTulis } = require(path.join(ROOT, 'electron/mcp/adapterTulis.js'));

const RENDERER = path.join(ROOT, 'renderer');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-asisten-'));
const dataDir = path.join(tmp, 'userData');
const rumahClaude = path.join(tmp, 'rumah');
const folderClaude = path.join(rumahClaude, 'Roaming', 'Claude');
fs.mkdirSync(folderClaude, { recursive: true });
fs.mkdirSync(path.join(rumahClaude, 'Local'), { recursive: true });
const BLENDER = { command: 'uvx', args: ['blender-mcp'] };
fs.writeFileSync(path.join(folderClaude, 'claude_desktop_config.json'), JSON.stringify({ preferences: { tema: 'gelap' }, mcpServers: { Blender: BLENDER } }, null, 2));
const host = new SqliteHost(path.join(tmp, 'SQLite'));
const secure = new Map();

function sajikan() {
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    let f = path.join(RENDERER, p);
    if (!f.startsWith(RENDERER) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(RENDERER, 'index.html');
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

/** Isi berkas ZIP (nama berkas) — pembaca direktori pusat minimal. */
function isiZip(buf) {
  const akhir = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(akhir + 10);
  let o = buf.readUInt32LE(akhir + 16);
  const out = {};
  for (let i = 0; i < n; i++) {
    const panjangNama = buf.readUInt16LE(o + 28);
    const nama = buf.slice(o + 46, o + 46 + panjangNama).toString('utf8');
    const lokal = buf.readUInt32LE(o + 42);
    const ukuranKempa = buf.readUInt32LE(o + 20);
    const awalData = lokal + 30 + buf.readUInt16LE(lokal + 26) + buf.readUInt16LE(lokal + 28);
    out[nama] = zlib.inflateRawSync(buf.slice(awalData, awalData + ukuranKempa));
    o += 46 + panjangNama + buf.readUInt16LE(o + 30) + buf.readUInt16LE(o + 32);
  }
  return out;
}

/** Klien MCP stdio seperti Claude Desktop. */
function klienStdio(perintah, args) {
  const p = spawn(perintah, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const tunggu = new Map();
  p.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const f = tunggu.get(m.id);
      if (f) f(m);
    }
  });
  let id = 0;
  const kirim = (method, params) =>
    new Promise((r) => {
      const n = ++id;
      tunggu.set(n, r);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
  return { kirim, tutup: () => p.stdin.end(), proses: p };
}

(async () => {
  const srv = await sajikan();
  const PORT = srv.address().port;
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const logs = [];
  pg.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  const cek = {};
  const ok = (n, v, info) => {
    cek[n] = { ok: !!v, info };
    console.log(v ? 'OK   ' : 'GAGAL', n, info || '');
  };

  // ---- "main process": McpHost ASLI + kanal IPC ASLI; jembatan adapter = halaman ini.
  const idx = bangunIndeks(RENDERER).modul;
  let adapterSiap = false;
  const bridge = {
    get siap() {
      return adapterSiap;
    },
    panggil: async (op, args, ctx) => {
      const r = await pg.evaluate(([op, args, ctx]) => globalThis.__kopkuServerAdapter.jalankan(op, args, ctx), [op, args || {}, ctx || {}]);
      if (r.ok) return r.value;
      throw Object.assign(new Error(r.error.pesan), { kode: r.error.kode });
    },
  };
  const mcp = new McpHost({
    dataDir,
    bridge,
    versi: '1.0.25',
    pastikanAdapter: async () => {
      if (adapterSiap) return;
      await pg.evaluate(`(${pasangAdapter.toString()})(${JSON.stringify(idx)}, { tanpaRegistrasi: true }); true;`);
      adapterSiap = true;
    },
    // 1.0.27 — adapter tulis ASLI disuntikkan ke halaman (seperti main.js: executeJavaScript).
    tulis: {
      jalankan: async (op, args, ctx) => {
        // Jembatan berkas uji ini tiruan (fs.* kosong) sehingga BackupService tidak dapat menulis berkas;
        // backup sungguhan diuji di test/mcp/asisten-ai-tulis.test.js (FsHost asli). Tanpa backup, perubahan DIBATALKAN.
        if (op === 'backup.buat') return { ok: true, value: { berkas: 'uji-chromium.kdb' } };
        const ids = indeksTulis(RENDERER);
        await pg.evaluate(`(${pasangAdapterTulis.toString()})(${JSON.stringify(ids)}); true;`);
        return pg.evaluate(([op, args, ctx]) => globalThis.__kopkuAiTulis.jalankan(op, args, ctx), [op, args || {}, ctx || {}]);
      },
    },
    salinKeCache: (p) => p,
  });
  const handler = new Map();
  const dibuka = [];
  const disalin = [];
  const judulDialog = [];
  daftarkanIpcAsistenAi({
    h: (ch, fn) => handler.set(ch, fn),
    host: mcp,
    dataDir,
    execPath: 'C:\\Users\\Uji\\AppData\\Local\\Programs\\KOPKU Desktop\\KOPKU Desktop.exe',
    appPath: null,
    versi: '1.0.25',
    ikon: path.join(ROOT, 'build', 'icon.png'),
    shell: { openPath: async (p) => (dibuka.push(p), ''), showItemInFolder() {}, openExternal: async (u) => dibuka.push(u) },
    clipboard: { writeText: (t) => disalin.push(t) },
    lingkungan: { platform: 'win32', env: { APPDATA: path.join(rumahClaude, 'Roaming'), LOCALAPPDATA: path.join(rumahClaude, 'Local') }, home: rumahClaude },
    // 1.0.28 — dialog "Simpan sebagai" tiruan: pengguna menekan Simpan di lokasi yang diusulkan.
    dialog: { showSaveDialog: async (_induk, o) => (judulDialog.push(o.title), { canceled: false, filePath: o.defaultPath }) },
  });
  await pg.exposeFunction('__asistenAi', async (ch, args) => {
    try {
      return { ok: true, value: await handler.get(ch)(...args) };
    } catch (e) {
      return { ok: false, error: { message: String((e && e.message) || e) } };
    }
  });
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
      else if (ch === 'secure:set') {
        secure.set(a, c);
        v = null;
      } else if (ch === 'secure:remove') {
        secure.delete(a);
        v = null;
      } else v = null;
      return { ok: true, value: v === undefined ? null : v };
    } catch (e) {
      return { ok: false, error: { message: String((e && e.message) || e), code: e && e.code } };
    }
  });
  await pg.addInitScript(({ tmp }) => {
    const call = (ch, ...a) => window.__kopkuCall(ch, a).then((r) => { if (r.ok) return r.value; const e = new Error(r.error.message); e.code = r.error.code; throw e; });
    const ai = (ch, ...a) => window.__asistenAi(ch, a).then((r) => { if (r.ok) return r.value; throw new Error(r.error.message); });
    const tolak = () => { throw new Error('fs sinkron tidak diemulasi'); };
    const nol = async () => null;
    window.kopkuDesktop = {
      info: { platform: 'win32', platformLabel: 'Windows', hostname: 'uji', version: '1.0.25', documentUri: 'kopkufs://local' + tmp + '/doc/', cacheUri: 'kopkufs://local' + tmp + '/cache/', dataDir: tmp },
      sqlite: { open: (n, d) => call('sqlite:open', n, d), exec: (i, s) => call('sqlite:exec', i, s), run: (i, s, p) => call('sqlite:run', i, s, p), get: (i, s, p) => call('sqlite:get', i, s, p), all: (i, s, p) => call('sqlite:all', i, s, p), close: (i) => call('sqlite:close', i) },
      fs: { uriToPath: (u) => String(u).replace('kopkufs://local', ''), pathToUri: (p) => 'kopkufs://local' + p, info: async () => ({ exists: false, isDirectory: false }), readString: nol, writeString: nol, remove: nol, move: nol, copy: nol, mkdir: nol, readDir: async () => [], statSync: () => ({ exists: false }), createSync: tolak, removeSync: tolak, openSync: tolak, readSync: tolak, writeSync: tolak, closeSync: tolak },
      secure: { get: (k) => call('secure:get', k), set: (k, v) => call('secure:set', k, v), remove: (k) => call('secure:remove', k) },
      print: { toPdf: nol, printHtml: nol, printFile: nol }, dialog: { openFiles: async () => [], saveFile: nol },
      shell: { openPath: nol, showItem: nol, openExternal: nol }, http: { fetch: async () => { throw new Error('offline'); } },
      auth: { canBiometric: async () => false, promptBiometric: async () => false },
      lan: { start: nol, info: nol, onRequest() {}, onPing() { return () => {}; } }, firewall: { status: nol, perbaiki: nol }, qr: { toDataUrl: nol },
      server: { onCall() {} },
      lanWa: { status: nol, waInfo: nol, waLog: nol },
      asistenAi: {
        status: () => ai('asistenAi:status'),
        atur: (o) => ai('asistenAi:atur', o),
        pasangClaude: (p) => ai('asistenAi:pasangClaude', p),
        lepasClaude: (p) => ai('asistenAi:lepasClaude', p),
        buatEkstensi: (p) => ai('asistenAi:buatEkstensi', p),
        salin: (t) => ai('asistenAi:salin', t),
        bukaFolder: () => ai('asistenAi:bukaFolder'),
        unduhClaude: () => ai('asistenAi:unduhClaude'),
        bukaFolderEkstensi: () => ai('asistenAi:bukaFolderEkstensi'),
      },
      app: { openDataFolder: nol, onMenu() { return () => {}; }, setTitle() {} },
    };
  }, { tmp });

  // Lisensi asli butuh aktivasi ke server → HANYA di uji ini modul lisensi dibungkus (bundle di disk tidak diubah).
  {
    const berkas = cariBerkasBundle(RENDERER);
    const idLis = idx.lisensi;
    await pg.route('**/entry-*.js', async (route) => {
      const t = fs.readFileSync(berkas, 'utf8');
      const mt0 = new RegExp(`\\},${idLis},\\[([0-9,]*)\\]\\);`).exec(t);
      const mulai = t.lastIndexOf('__d(function(', mt0.index);
      const akhir = mt0.index + mt0[0].length;
      const badan = t.slice(mulai, akhir);
      const mh = /^__d\(function\(([^)]*)\)\{/.exec(badan);
      const ps = mh[1].split(',');
      const ex = ps[5];
      ps[5] = ex + '__asli';
      const mt = /\},(\d+),\[([0-9,]*)\]\);?$/.exec(badan);
      const isi = badan.slice(mh[0].length, mt.index);
      const ganti = `__d(function(${ps.join(',')}){var ${ex}={};(function(){${isi}\n})();var __ov={hasValidLocalLicense:async function(){return true},getLicenseStatus:async function(){return {state:'ACTIVE',allowAppAccess:true,licenseType:'FULL',cooperativeName:'Koperasi Uji Desktop',activatedAt:null,expiresAt:null,lastVerifiedAtMs:Date.now(),graceRemainingMs:null,clockRollbackDetected:false,serverVerificationDue:false,deviceId:'uji',hasStoredLicense:true}}};Object.getOwnPropertyNames(${ex}).forEach(function(k){Object.defineProperty(${ex}__asli,k,{enumerable:true,get:function(){return k in __ov?__ov[k]:${ex}[k]}})});},${mt[1]},[${mt[2]}]);`;
      await route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Cross-Origin-Resource-Policy': 'same-origin' }, body: t.slice(0, mulai) + ganti + t.slice(akhir) });
    });
  }

  await pg.goto('http://127.0.0.1:' + PORT + '/');
  await pg.waitForTimeout(9000);
  // Data koperasi uji lewat SERVICE ASLI di halaman.
  await pg.evaluate(async ({ idx }) => {
    const R = (k) => __r(idx[k]);
    await R('koperasi').setupKoperasi({ nama: 'Koperasi Sejahtera Uji', tahunBuku: 2026, tanggalBerdiri: '2020-01-01', adminNama: 'Administrator', adminUsername: 'admin', adminPassword: 'Admin#Kopku2026' });
    const db = await R('db').getDb();
    const admin = (await db.getFirstAsync("SELECT id FROM app_user WHERE username = 'admin'")).id;
    const ang = R('anggota');
    const simp = R('simpanan');
    const pj = R('pinjaman');
    const nama = ['Siti Aminah', 'Budi Santoso', 'Rina Wulandari', 'Ahmad Fauzi'];
    for (let i = 0; i < nama.length; i++) {
      const a = (await ang.createAnggota(admin, { namaLengkap: nama[i], nik: '320101' + (1000000000 + i), alamat: 'Jl. Rahasia No. ' + i, tanggalBergabung: '2025-01-10', nomorHp: '0812999900' + i, status: 'AKTIF' })).id;
      await simp.setorSimpanan({ anggotaId: a, jenis: 'POKOK', tanggal: '2026-01-15', nominal: 100000, sumberDana: 'KAS', createdBy: admin });
      await simp.setorSimpanan({ anggotaId: a, jenis: 'WAJIB', tanggal: '2026-01-15', periode: '2026-01', nominal: 50000, sumberDana: 'KAS', createdBy: admin });
      await simp.setorSimpanan({ anggotaId: a, jenis: 'SUKARELA', tanggal: '2026-01-15', nominal: 15000000, sumberDana: 'KAS', createdBy: admin });
      const p = await pj.ajukanPinjaman({ anggotaId: a, jumlahPinjaman: 5000000, tanggal: '2026-06-15', tenor: 10, satuanTenor: 'BULAN', metodeJasa: 'FLAT', persentaseJasa: 1.5, biayaAdminTipe: 'TIDAK_ADA', biayaAdminNilai: 0, dendaAktif: false, createdBy: admin });
      await pj.cairkanPinjaman({ pinjamanId: p.id, approvedBy: admin, tanggalPencairan: '2026-06-15', sumberDana: 'KAS' });
    }
  }, { idx });
  await pg.reload();
  await pg.waitForTimeout(8000);
  if (await pg.locator('input[type=password]').count()) {
    await pg.locator('input').first().fill('admin');
    await pg.locator('input[type=password]').first().fill('Admin#Kopku2026');
    await pg.keyboard.press('Enter');
    await pg.waitForTimeout(6000);
  }
  adapterSiap = false; // halaman dimuat ulang → adapter dipasang ulang saat dipakai

  // ---- menu: sidebar & Ctrl+K
  await pg.keyboard.press('Control+k');
  await pg.waitForTimeout(500);
  await pg.keyboard.type('claude');
  await pg.waitForTimeout(600);
  await pg.screenshot({ path: path.join(OUT, '40-ctrl-k-claude.png') });
  const palet = await pg.evaluate(() => document.body.innerText);
  ok('Ctrl+K "claude" menemukan Asisten AI', /Asisten AI/.test(palet) && /Hubungkan ke Claude/.test(palet));
  await pg.keyboard.press('Enter');
  await pg.waitForTimeout(3000);
  await pg.screenshot({ path: path.join(OUT, '41-asisten-mati.png'), fullPage: true });
  let teks = await pg.evaluate(() => document.body.innerText);
  ok('layar Asisten AI terbuka (bawaan mati)', /Hubungkan ke Claude/.test(teks) && /\bOFF\b/.test(teks) && /Belum terpasang/.test(teks), teks.slice(0, 120).replace(/\n/g, ' | '));
  ok('Claude Desktop terdeteksi dari folder konfigurasi', /Claude Desktop terdeteksi/.test(teks));
  ok('menu "Asisten AI" ada di sidebar Pengaturan (setelah LAN & WhatsApp)', /LAN & WhatsApp\s*\n\s*Asisten AI/.test(teks));

  // ---- 1.0.28: panduan animasi slide
  await pg.locator('[data-testid=tombol-panduan]').click();
  await pg.waitForTimeout(1200);
  const judulSlide = [];
  const slideTeks = async () => pg.evaluate(() => { const el = document.querySelector('[data-testid=panduan-asisten-ai]'); return el ? el.innerText : ''; });
  for (let i = 1; i <= 10; i++) {
    const t = await slideTeks();
    judulSlide.push(t.split('\n').find((l) => /^\d+\. /.test(l.trim())) || t.slice(0, 40));
    await pg.screenshot({ path: path.join(OUT, `39-panduan-${String(i).padStart(2, '0')}.png`) });
    if (i < 10) {
      if (i % 2) await pg.locator('[data-testid=panduan-maju]').click();
      else await pg.keyboard.press('ArrowRight');
      await pg.waitForTimeout(1300);
    }
  }
  const akhirTeks = await slideTeks();
  ok('panduan slide: 10 slide berbeda, dapat dimaju (tombol & panah)', new Set(judulSlide).size === 10 && /10\s*\/\s*10/.test(akhirTeks), judulSlide.join(' | '));
  const animasi = await pg.evaluate(() => [...document.querySelectorAll('[data-testid=panduan-asisten-ai] *')].filter((el) => getComputedStyle(el).animationName !== 'none').length);
  ok('panduan slide memakai animasi CSS', animasi > 0, `elemen beranimasi: ${animasi}`);
  await pg.keyboard.press('ArrowLeft');
  await pg.waitForTimeout(800);
  ok('panah kiri kembali ke slide sebelumnya', /9\s*\/\s*10/.test(await slideTeks()));
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(600);
  ok('Esc menutup panduan', (await slideTeks()) === '');

  // ---- nyalakan → konfirmasi
  await pg.locator('[data-testid=saklar-asisten-ai]').click();
  await pg.waitForTimeout(700);
  await pg.screenshot({ path: path.join(OUT, '42-konfirmasi-hubungkan.png') });
  teks = await pg.evaluate(() => document.body.innerText);
  ok('dialog konfirmasi menjelaskan data yang dikirim', /Hubungkan KOPKU ke Claude\?/.test(teks) && /tidak pernah dikirim/.test(teks));
  await pg.evaluate(() => { const b = [...document.querySelectorAll('[role=button]')].find((x) => (x.innerText || '').trim() === 'Hubungkan'); b && b.click(); });
  await pg.waitForTimeout(3500);
  await pg.screenshot({ path: path.join(OUT, '42b-berhasil-hubungkan.png') });
  await pg.keyboard.press('Enter'); // tutup notifikasi "Berhasil"
  await pg.waitForTimeout(500);
  const conf1 = JSON.parse(fs.readFileSync(path.join(folderClaude, 'claude_desktop_config.json'), 'utf8'));
  ok('entri "kopku" ditulis ke claude_desktop_config.json (Node.js + server lokal)', conf1.mcpServers.kopku && /mcp[\\/]server[\\/]stdio\.js$/.test(conf1.mcpServers.kopku.args[0]) && conf1.mcpServers.kopku.args.includes(dataDir), JSON.stringify(conf1.mcpServers.kopku));
  ok('server MCP lain & preferensi Claude tidak disentuh', JSON.stringify(conf1.mcpServers.Blender) === JSON.stringify(BLENDER) && conf1.preferences.tema === 'gelap');
  ok('cadangan konfigurasi Claude dibuat', fs.readdirSync(folderClaude).some((f) => /kopku-cadangan-\d+\.json$/.test(f)));
  ok('host MCP menyala di 127.0.0.1 (endpoint.json)', mcp.berjalan && fs.existsSync(path.join(dataDir, 'mcp', 'endpoint.json')));
  await pg.locator('[data-testid=saklar-asisten-per-anggota]').click();
  await pg.waitForTimeout(600);
  await pg.evaluate(() => { const b = [...document.querySelectorAll('[role=button]')].find((x) => (x.innerText || '').trim() === 'Izinkan'); b && b.click(); });
  await pg.waitForTimeout(2500);
  await pg.keyboard.press('Enter');
  await pg.waitForTimeout(500);
  ok('data per anggota diizinkan', mcp.baca().perAnggota === true);

  // ---- klien MCP stdio sungguhan (seperti Claude Desktop)
  const k = klienStdio(conf1.mcpServers.kopku.command, conf1.mcpServers.kopku.args); // persis seperti Claude Desktop
  const init = await k.kirim('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1' } });
  ok('initialize MCP', init.result && init.result.serverInfo.name === 'kopku');
  const daftar = await k.kirim('tools/list', {});
  ok('tools/list: 14 alat (per anggota ON)', daftar.result.tools.length === 14, String(daftar.result.tools.length));
  const r1 = await k.kirim('tools/call', { name: 'ringkasan_koperasi', arguments: {} });
  const j1 = JSON.parse(r1.result.content[0].text);
  ok('ringkasan_koperasi: angka dari service KOPKU', j1.koperasi === 'Koperasi Sejahtera Uji' && j1.anggotaAktif === 4 && j1.totalSimpanan.total === 4 * 15150000 && j1.pinjaman.jumlahPinjamanAktif === 4, r1.result.content[0].text.slice(0, 200));
  const r2 = await k.kirim('tools/call', { name: 'detail_anggota', arguments: { anggota: 'Siti Aminah' } });
  const t2 = r2.result.content[0].text;
  ok('detail_anggota tanpa NIK/alamat/nomor HP', /Siti Aminah/.test(t2) && !/32010|Rahasia|0812999/.test(t2), t2.slice(0, 160));
  const r3 = await k.kirim('tools/call', { name: 'laporan_keuangan', arguments: { jenis: 'posisi_keuangan' } });
  ok('laporan posisi keuangan seimbang', JSON.parse(r3.result.content[0].text).data.isBalanced === true);
  await pg.waitForTimeout(6000); // layar memuat ulang status tiap 5 detik
  await pg.screenshot({ path: path.join(OUT, '43-asisten-menyala.png'), fullPage: true });
  for (const [i, y] of [[1, 760], [2, 1500], [3, 2400]]) {
    await pg.evaluate((y) => { const el = document.querySelector('[data-testid=layar-asisten-ai]'); if (el) el.scrollTop = y; }, y);
    await pg.waitForTimeout(400);
    await pg.screenshot({ path: path.join(OUT, `43-asisten-menyala-${i}.png`) });
  }
  await pg.evaluate(() => { const el = document.querySelector('[data-testid=layar-asisten-ai]'); if (el) el.scrollTop = 0; });
  teks = await pg.evaluate(() => document.body.innerText);
  ok('layar: siap dipakai Claude + aktivitas tercatat', /Siap dipakai Claude/.test(teks) && /Ringkasan koperasi/.test(teks) && /Detail anggota/.test(teks), teks.match(/Sesi ini: [^\n]*/) && teks.match(/Sesi ini: [^\n]*/)[0]);

  // ---- salin contoh pertanyaan & konfigurasi manual
  await pg.evaluate(() => { const b = [...document.querySelectorAll('[role=button]')].find((x) => /Tampilkan konfigurasi/.test(x.innerText || '')); b && b.click(); });
  await pg.waitForTimeout(500);
  teks = await pg.evaluate(() => document.body.innerText);
  ok('pasang manual menampilkan potongan JSON', /"mcpServers"/.test(teks) && /stdio\.js/.test(teks) && /Node\.js v\d+/.test(teks));
  await pg.screenshot({ path: path.join(OUT, '44-pasang-manual.png'), fullPage: true });
  await pg.evaluate(() => { const b = [...document.querySelectorAll('[role=button]')].filter((x) => /Salin$/.test((x.innerText || '').trim())); b[1] && b[1].click(); });
  await pg.waitForTimeout(800);
  await pg.keyboard.press('Enter');
  ok('tombol Salin memakai clipboard sistem', disalin.length >= 1, disalin[0] && disalin[0].slice(0, 60));

  // ---- 1.0.27: izinkan Claude mengubah data → dialog peringatan → Claude mencatat setoran (pratinjau + konfirmasi)
  await pg.evaluate(() => { const el = document.querySelector('[data-testid=layar-asisten-ai]'); if (el) el.scrollTop = 0; });
  await pg.locator('[data-testid=saklar-asisten-ubah-data]').click();
  await pg.waitForTimeout(700);
  await pg.screenshot({ path: path.join(OUT, '48-konfirmasi-ubah-data.png') });
  teks = await pg.evaluate(() => document.body.innerText);
  ok('dialog "Izinkan Claude MENGUBAH data" menjelaskan pengaman', /MENGUBAH data koperasi\?/.test(teks) && /pratinjau/.test(teks) && /backup otomatis/.test(teks));
  await pg.evaluate(() => { const b = [...document.querySelectorAll('[role=button]')].find((x) => /Izinkan mengubah data$/.test((x.innerText || '').trim())); b && b.click(); });
  await pg.waitForTimeout(2500);
  await pg.keyboard.press('Enter');
  ok('ubah data ON (per anggota ikut ON)', mcp.baca().bolehTulis === true && mcp.baca().perAnggota === true);
  const pr = await k.kirim('tools/call', { name: 'simpanan_setor', arguments: { anggota: 'Siti Aminah', jenis: 'WAJIB', nominal: 50000, tanggal: '2026-10-01', periode: '2026-10' } });
  const prj = JSON.parse(pr.result.content[0].text);
  ok('Claude: pratinjau setoran (belum disimpan) + kode konfirmasi', prj.status === 'MENUNGGU_KONFIRMASI' && /^K-/.test(prj.konfirmasi), pr.result.content[0].text.slice(0, 160));
  const sm = await k.kirim('tools/call', { name: 'simpanan_setor', arguments: { anggota: 'Siti Aminah', jenis: 'WAJIB', nominal: 50000, tanggal: '2026-10-01', periode: '2026-10', konfirmasi: prj.konfirmasi } });
  const smj = JSON.parse(sm.result.content[0].text);
  ok('Claude: setoran tersimpan setelah konfirmasi (service KOPKU di halaman)', smj.status === 'BERHASIL' && /^SP-WAJIB-/.test(smj.hasil.nomorTransaksi), sm.result.content[0].text.slice(0, 160));
  await pg.waitForTimeout(5500);
  for (const [i, y] of [[1, 0], [2, 1700], [3, 99999]]) {
    await pg.evaluate((y) => { const el = document.querySelector('[data-testid=layar-asisten-ai]'); if (el) el.scrollTop = y; }, y);
    await pg.waitForTimeout(400);
    await pg.screenshot({ path: path.join(OUT, `49-ubah-data-${i}.png`) });
  }
  teks = await pg.evaluate(() => document.body.innerText);
  ok('layar: sakelar ubah data ON, alat ubah data aktif, aktivitas "Diubah"', /Ubah data aktif/.test(teks) && /Alat ubah data \(16\)/i.test(teks) && /Diubah/.test(teks) && /UBAH: Setor simpanan wajib/.test(teks));
  await pg.evaluate(() => { const el = document.querySelector('[data-testid=layar-asisten-ai]'); if (el) el.scrollTop = 0; });

  // ---- cara 2: ekstensi .mcpb
  await pg.locator('[data-testid=tombol-ekstensi-claude]').click();
  await pg.waitForTimeout(2500);
  await pg.screenshot({ path: path.join(OUT, '45-ekstensi.png') });
  await pg.keyboard.press('Enter');
  const berkasMcpb = path.join(dataDir, 'mcp', 'KOPKU-Asisten-AI.mcpb');
  let zipOk = false;
  let info = '';
  try {
    const z = isiZip(fs.readFileSync(berkasMcpb));
    const man = JSON.parse(z['manifest.json'].toString('utf8'));
    zipOk = man.server.type === 'node' && man.server.mcp_config.args.includes(dataDir) && !!z['server/stdio.js'] && !!z['server/katalog.js'] && !!z['icon.png'] && man.tools.length === 14;
    info = Object.keys(z).join(', ');
    // server di dalam paket benar-benar berjalan (Node, seperti Node bawaan Claude Desktop)
    const ext = path.join(tmp, 'ekstensi');
    for (const [n, isi] of Object.entries(z)) {
      fs.mkdirSync(path.dirname(path.join(ext, n)), { recursive: true });
      fs.writeFileSync(path.join(ext, n), isi);
    }
    const k2 = klienStdio(process.execPath, man.server.mcp_config.args.map((a) => a.replace('${__dirname}', ext)));
    const rr = await k2.kirim('tools/call', { name: 'saldo_kas_bank', arguments: {} });
    zipOk = zipOk && /Kas/.test(rr.result.content[0].text) && !rr.result.isError;
    k2.tutup();
  } catch (e) {
    info = String(e && e.message);
  }
  ok('paket .mcpb sah (manifest, server, ikon) & servernya menjawab', zipOk, info);
  ok('paket dibuka dengan Claude Desktop (shell.openPath)', dibuka.includes(berkasMcpb));
  ok('pengguna memilih lokasi simpan .mcpb (dialog "Simpan sebagai")', judulDialog.includes('Simpan ekstensi Claude (KOPKU Asisten AI)'));
  teks = await pg.evaluate(() => document.body.innerText);
  ok('layar menampilkan folder ekstensi + tombol "Buka folder ekstensi"', teks.includes(path.join(dataDir, 'mcp')) && /Buka folder ekstensi/i.test(teks));
  const conf2 = JSON.parse(fs.readFileSync(path.join(folderClaude, 'claude_desktop_config.json'), 'utf8'));
  ok('cara ekstensi: entri konfigurasi dilepas (tidak ganda), Blender tetap', !conf2.mcpServers.kopku && !!conf2.mcpServers.Blender);

  // ---- kembali ke cara 1
  await pg.locator('[data-testid=tombol-pasang-claude]').click();
  await pg.waitForTimeout(2000);
  await pg.keyboard.press('Enter');
  const conf3 = JSON.parse(fs.readFileSync(path.join(folderClaude, 'claude_desktop_config.json'), 'utf8'));
  ok('Pasang ke Claude Desktop memasang ulang entri', !!conf3.mcpServers.kopku && mcp.baca().cara === 'config');

  // ---- matikan → alat menolak
  await pg.waitForTimeout(500);
  await pg.locator('[data-testid=saklar-asisten-ai]').click();
  await pg.waitForTimeout(2000);
  await pg.keyboard.press('Enter');
  const r4 = await k.kirim('tools/call', { name: 'ringkasan_koperasi', arguments: {} });
  ok('dimatikan: Claude mendapat pesan "belum dinyalakan", port ditutup', r4.result.isError && /belum dinyalakan/.test(r4.result.content[0].text) && !mcp.berjalan);
  await pg.waitForTimeout(5500);
  await pg.screenshot({ path: path.join(OUT, '46-asisten-dimatikan.png'), fullPage: true });
  k.tutup();

  // ---- Semua Pengaturan: kartu Asisten AI
  await pg.keyboard.press('Control+k');
  await pg.waitForTimeout(400);
  await pg.keyboard.type('Semua Pengaturan');
  await pg.waitForTimeout(400);
  await pg.keyboard.press('Enter');
  await pg.waitForTimeout(2500);
  teks = await pg.evaluate(() => document.body.innerText);
  ok('kartu "Asisten AI" di layar Semua Pengaturan', /Asisten AI/.test(teks) && /Hubungkan ke Claude Desktop \(MCP\)/.test(teks));
  await pg.screenshot({ path: path.join(OUT, '47-semua-pengaturan.png'), fullPage: true });

  ok('tanpa galat halaman', logs.length === 0, logs.slice(0, 3).join(' | '));
  fs.writeFileSync(path.join(OUT, 'hasil.json'), JSON.stringify(cek, null, 1));
  await mcp.henti();
  await b.close();
  srv.close();
  const lulus = Object.values(cek).filter((x) => x.ok).length;
  console.log(`\n${lulus}/${Object.keys(cek).length} lulus · tangkapan layar: ${OUT}`);
  process.exit(Object.values(cek).every((x) => x.ok) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

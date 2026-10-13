'use strict';
/**
 * KOPKU Desktop 1.0.13 — uji pengamanan anti-bypass.
 * main.js / entry.js ASLI dimuat dengan tiruan Electron (lihat test/lan/electronMock.js).
 * Lapisan biner (Electron Fuses, integritas asar) tidak dapat dijalankan di sini:
 * yang diuji adalah konfigurasinya (package.json) dan pembaca fuse (verifikasi-fuse.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buatMock, pasangMock } = require('../lan/electronMock');
const ROOT = path.join(__dirname, '..', '..');
const MAIN = path.join(ROOT, 'electron', 'main.js');
const keamanan = require(path.join(ROOT, 'electron', 'keamanan.js'));
// DIPERBARUI 1.0.14: konektor Claude dihapus — modul mcp/claudeConfig tidak ada lagi.
// DIPERBARUI 1.0.25: konektor Claude kembali sebagai Pengaturan › Asisten AI (permintaan pengguna) —
// electron/bersihkanClaude.js dihapus (tidak boleh lagi melepas entri "kopku" setiap start).
const claudeConfig = require(path.join(ROOT, 'electron', 'mcp', 'claudeConfig.js'));
const { periksa, PENANDA } = require(path.join(ROOT, 'scripts', 'verifikasi-fuse.js'));
const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));

/** Muat main.js ASLI dengan tiruan Electron baru. */
async function muatMain({ packaged, argv = [], env = {} }) {
  const m = buatMock();
  const app = m.electron.app;
  app.isPackaged = packaged;
  const setPath = [];
  app.setPath = (n, p) => setPath.push([n, p]);
  const exit = [];
  app.exit = (c) => exit.push(c);
  app.commandLine = { hasSwitch: (s) => argv.some((a) => a === `--${s}` || a.startsWith(`--${s}=`)) };
  m.electron.dialog.showErrorBox = () => undefined;
  pasangMock(m.electron);
  const argvAsli = process.argv;
  const envAsli = {};
  for (const [k, v] of Object.entries(env)) {
    envAsli[k] = process.env[k];
    process.env[k] = v;
  }
  process.argv = [process.argv[0], MAIN, ...argv];
  delete require.cache[MAIN];
  try {
    require(MAIN);
    await tunggu(80);
  } finally {
    process.argv = argvAsli;
    for (const [k, v] of Object.entries(envAsli)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const henti = async () => {
    for (const f of m.log.appOn.get('will-quit') || []) f();
    await tunggu(20);
  };
  return { m, setPath, exit, win: m.log.windows[0], henti };
}

test('aplikasi TERPASANG mengabaikan KOPKU_SMOKE, KOPKU_DEVTOOLS, KOPKU_USERDATA', async () => {
  const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-probe-')), 'probe.js');
  fs.writeFileSync(probe, "globalThis.__kopkuProbeJalan = true; module.exports = () => { globalThis.__kopkuProbeJalan = true; };");
  globalThis.__kopkuProbeJalan = false;
  const r = await muatMain({ packaged: true, env: { KOPKU_SMOKE: probe, KOPKU_DEVTOOLS: '1', KOPKU_USERDATA: '/tmp/data-lain' } });
  assert.equal(globalThis.__kopkuProbeJalan, false, 'skrip KOPKU_SMOKE tidak boleh dimuat di aplikasi terpasang');
  assert.equal(r.win.opts.webPreferences.devTools, false);
  assert.deepEqual(r.setPath.filter(([n]) => n === 'userData'), []);
  assert.deepEqual(r.exit, []);
  await r.henti();
});

test('mode uji (electron .) tetap dapat memakai variabel uji', async () => {
  const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-probe-')), 'probe.js');
  fs.writeFileSync(probe, 'module.exports = () => { globalThis.__kopkuProbeJalan = true; };');
  globalThis.__kopkuProbeJalan = false;
  const r = await muatMain({ packaged: false, env: { KOPKU_SMOKE: probe, KOPKU_DEVTOOLS: '1' } });
  assert.equal(globalThis.__kopkuProbeJalan, true);
  assert.equal(r.win.opts.webPreferences.devTools, true);
  await r.henti();
});

test('aplikasi terpasang menolak saklar debug', async () => {
  for (const s of ['--remote-debugging-port=9222', '--inspect', '--inspect-brk=9229', '--remote-debugging-pipe', '--js-flags=--expose-gc']) {
    const r = await muatMain({ packaged: true, argv: [s] });
    assert.deepEqual(r.exit, [1], s);
    await r.henti();
  }
  const ok = await muatMain({ packaged: true, argv: ['--lang=id'] });
  assert.deepEqual(ok.exit, []);
  await ok.henti();
  const uji = await muatMain({ packaged: false, argv: ['--inspect'] });
  assert.deepEqual(uji.exit, [], 'mode uji tidak dibatasi');
  await uji.henti();
});

test('saklarDebug: argv & command line Chromium', () => {
  assert.deepEqual(keamanan.saklarDebug(['app.exe', '--remote-debugging-port=1'], null), ['remote-debugging-port']);
  assert.deepEqual(keamanan.saklarDebug(['app.exe'], { hasSwitch: (s) => s === 'remote-debugging-pipe' }), ['remote-debugging-pipe']);
  assert.deepEqual(keamanan.saklarDebug(['app.exe', '--kopku-mcp-stdio', '--data', 'x'], null), []);
});

test('penjaga semua webContents: DevTools ditutup, webview & navigasi keluar ditolak', async () => {
  const r = await muatMain({ packaged: true });
  const h = r.m.log.appOn.get('web-contents-created');
  assert.ok(h && h.length >= 1);
  const ev = new Map();
  let ditutup = 0;
  let handlerJendela = null;
  const wc = {
    on: (n, f) => ev.set(n, f),
    closeDevTools: () => ditutup++,
    setWindowOpenHandler: (f) => (handlerJendela = f),
  };
  for (const f of h) f({}, wc);
  ev.get('devtools-opened')();
  assert.equal(ditutup, 1);
  let dicegah = false;
  ev.get('will-attach-webview')({ preventDefault: () => (dicegah = true) });
  assert.equal(dicegah, true);
  dicegah = false;
  ev.get('will-navigate')({ preventDefault: () => (dicegah = true) }, 'https://jahat.example/');
  assert.equal(dicegah, true);
  dicegah = false;
  ev.get('will-navigate')({ preventDefault: () => (dicegah = true) }, 'app://kopku/dashboard');
  assert.equal(dicegah, false);
  assert.deepEqual(handlerJendela({ url: 'https://contoh.com' }), { action: 'deny' });
  await r.henti();
});

test('tidak ada variabel KOPKU_* di main.js yang lolos tanpa penjaga mode uji', () => {
  const src = fs.readFileSync(MAIN, 'utf8');
  const baris = src.split('\n').filter((l) => /process\.env\.KOPKU_/.test(l) && !/^\s*\/\//.test(l));
  for (const l of baris) assert.match(l, /MODE_UJI|!app\.isPackaged/, l.trim());
});

test('package.json: Electron Fuses anti-bypass & titik masuk', () => {
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(p.main, 'electron/entry.js');
  assert.deepEqual(p.build.electronFuses, {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  });
  assert.equal(p.build.asar, true);
  assert.equal(p.build.asarUnpack, undefined, 'tidak ada kode proses utama di luar app.asar');
  // DIPERBARUI 1.0.14: extraResources kopku-mcp (cadangan konektor Claude) DIHAPUS.
  // 1.0.25: tetap tidak perlu — Asisten AI memakai exe (--kopku-mcp-stdio, di dalam app.asar) atau paket .mcpb.
  assert.equal(p.build.extraResources, undefined);
  assert.match(p.scripts['postdist:win'], /verifikasi-fuse\.js/);
});

test('verifikasi-fuse membaca fuse wire', () => {
  const mk = (s) => Buffer.concat([Buffer.from('MZ....'), Buffer.from(PENANDA), Buffer.from([1, s.length]), Buffer.from(s)]);
  assert.deepEqual(periksa(mk('010011001')).salah, []);
  assert.equal(periksa(mk('110011001')).salah.length, 1);
  assert.equal(periksa(mk('010111001')).salah.length, 1);
  assert.equal(periksa(mk('010000001')).salah.length, 2);
  assert.equal(periksa(Buffer.from('tanpa penanda')).terbaca, false);
});

// DIPERBARUI 1.0.14 — fitur Claude DIHAPUS; dua test 1.0.13 diganti dengan uji pembersihan.
// DIPERBARUI 1.0.25 — fitur kembali sebagai Pengaturan › Asisten AI (permintaan pengguna): uji pembersihan
// diganti dengan uji pemasang konfigurasi Claude Desktop & mode stdio di dalam exe (tanpa RunAsNode).
test('1.0.25: entri "kopku" dipasang/dilepas aman — server lain, berkas rusak, & entri milik program lain tidak disentuh', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-claude-'));
  const appData = path.join(home, 'Roaming');
  const lokal = path.join(home, 'Local');
  const lingkungan = { platform: 'win32', env: { APPDATA: appData, LOCALAPPDATA: lokal }, home };
  const biasa = path.join(appData, 'Claude');
  const store = path.join(lokal, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
  const rusak = path.join(lokal, 'Packages', 'Claude_rusak', 'LocalCache', 'Roaming', 'Claude');
  for (const d of [biasa, store, rusak]) fs.mkdirSync(d, { recursive: true });
  const blender = { command: 'uvx', args: ['blender-mcp'] };
  // entri lama 1.0.12 (ELECTRON_RUN_AS_NODE) di Claude biasa; berkas Store belum ada; satu berkas rusak.
  fs.writeFileSync(path.join(biasa, 'claude_desktop_config.json'), JSON.stringify({ preferences: { a: 1 }, mcpServers: { Blender: blender, kopku: { command: 'C:\\Lama\\KOPKU Desktop.exe', args: ['D:\\x\\electron\\mcp\\stdio.js'], env: { ELECTRON_RUN_AS_NODE: '1' } } } }));
  fs.writeFileSync(path.join(rusak, 'claude_desktop_config.json'), '{ rusak');
  const entri = claudeConfig.entriKopku({ execPath: 'C:\\K\\KOPKU Desktop.exe', dataDir: 'C:\\Users\\U\\AppData\\Roaming\\KOPKU Desktop' });
  assert.deepEqual(entri, { command: 'C:\\K\\KOPKU Desktop.exe', args: ['--kopku-mcp-stdio', '--data', 'C:\\Users\\U\\AppData\\Roaming\\KOPKU Desktop'] });
  assert.equal(entri.env, undefined, 'tanpa ELECTRON_RUN_AS_NODE (fuse RunAsNode tetap OFF)');

  const h = claudeConfig.pasangKeClaude({ entri, lingkungan, now: 1 });
  assert.equal(h.diubah.length, 2);
  assert.equal(h.dilewati.length, 1, 'berkas rusak dilewati');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(biasa, 'claude_desktop_config.json'), 'utf8')), { preferences: { a: 1 }, mcpServers: { Blender: blender, kopku: entri } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, 'claude_desktop_config.json'), 'utf8')), { mcpServers: { kopku: entri } });
  assert.equal(fs.readFileSync(path.join(rusak, 'claude_desktop_config.json'), 'utf8'), '{ rusak');
  assert.ok(fs.existsSync(path.join(biasa, 'claude_desktop_config.kopku-cadangan-1.json')), 'cadangan dibuat');
  const st = claudeConfig.statusClaude({ entri, lingkungan });
  assert.equal(st.claudeTerdeteksi && st.terpasang && st.cocok, true);
  assert.deepEqual(st.lokasi.find((l) => l.folder === biasa).serverLain, ['Blender']);
  // idempoten
  assert.deepEqual(claudeConfig.pasangKeClaude({ entri, lingkungan, now: 2 }).diubah, []);
  // KOPKU dipindah → hanya entri milik KOPKU yang diperbarui
  const baru = claudeConfig.entriKopku({ execPath: 'D:\\Baru\\KOPKU Desktop.exe', dataDir: 'X' });
  assert.equal(claudeConfig.perbaruiBilaBerubah({ entri: baru, lingkungan, now: 3 }).diubah.length, 2);
  // lepas: hanya "kopku", Blender & preferensi tetap
  assert.equal(claudeConfig.lepasDariClaude({ lingkungan, now: 4 }).diubah.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(biasa, 'claude_desktop_config.json'), 'utf8')), { preferences: { a: 1 }, mcpServers: { Blender: blender } });
  // "kopku" milik program lain: tidak ditimpa & tidak dilepas
  const lain = { command: 'python', args: ['kopku_server.py'] };
  fs.writeFileSync(path.join(store, 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { kopku: lain } }));
  const h2 = claudeConfig.pasangKeClaude({ entri, lingkungan, now: 5 });
  assert.ok(h2.dilewati.some((x) => /milik program lain/.test(x.alasan)));
  claudeConfig.lepasDariClaude({ lingkungan, now: 6 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, 'claude_desktop_config.json'), 'utf8')), { mcpServers: { kopku: lain } });
  assert.equal(claudeConfig.entriMilikKopku(lain), false);
  assert.equal(claudeConfig.entriMilikKopku({ command: 'K.exe', args: ['--kopku-mcp-stdio'] }), true);
  // belum ada folder Claude sama sekali → dibuat di lokasi standar
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-claude-'));
  const l2 = { platform: 'win32', env: { APPDATA: path.join(home2, 'Roaming'), LOCALAPPDATA: path.join(home2, 'Local') }, home: home2 };
  claudeConfig.pasangKeClaude({ entri, lingkungan: l2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home2, 'Roaming', 'Claude', 'claude_desktop_config.json'), 'utf8')), { mcpServers: { kopku: entri } });
});

function jalankanStdioExe(args, masukan) {
  const p = spawn(process.execPath, ['-r', path.join(__dirname, 'electron-stub.js'), path.join(ROOT, 'electron', 'entry.js'), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (c) => (out += c));
  p.stderr.on('data', (c) => (err += c));
  for (const m of masukan) p.stdin.write(JSON.stringify(m) + '\n');
  p.stdin.end();
  return new Promise((r) => p.on('exit', (kode) => r({ kode, out, err })));
}

test('1.0.25: entry.js --kopku-mcp-stdio menjawab MCP tanpa jendela, IPC, maupun database', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-stdio-'));
  const r = await jalankanStdioExe(['--kopku-mcp-stdio', '--data', data], [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'uji', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ringkasan_koperasi', arguments: {} } },
  ]);
  assert.equal(r.kode, 0, r.err);
  const baris = r.out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(baris.map((b) => b.id), [1, 2, 3], 'notifikasi tidak dijawab; stdout hanya berisi pesan protokol');
  assert.equal(baris[0].result.serverInfo.name, 'kopku');
  assert.equal(baris[0].result.protocolVersion, '2025-06-18');
  assert.equal(baris[1].result.tools.length, 14);
  assert.ok(baris[1].result.tools.every((t) => t.annotations.readOnlyHint === true));
  // KOPKU Desktop tidak terbuka → jawaban jelas, bukan galat protokol
  assert.equal(baris[2].result.isError, true);
  assert.match(baris[2].result.content[0].text, /KOPKU Desktop belum terbuka/);
  assert.match(r.err, /\[stub\] exit 0 jendela=0 handler=0/, r.err);
  assert.deepEqual(fs.readdirSync(data), [], 'folder data tidak disentuh');
});

test('1.0.25: mode stdio aplikasi terpasang tetap menolak saklar debug', async () => {
  const r = await jalankanStdioExe(['--kopku-mcp-stdio', '--inspect', '--data', os.tmpdir()], [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
  assert.equal(r.kode, 1);
  assert.equal(r.out, '');
});

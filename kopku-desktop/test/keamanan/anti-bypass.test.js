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
const { bersihkanSisaClaude, entriMilikKopku } = require(path.join(ROOT, 'electron', 'bersihkanClaude.js'));
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

// DIPERBARUI 1.0.14 — fitur Claude DIHAPUS. Dua test 1.0.13 berikut diganti:
//  - "konektor Claude: entri baru tanpa ELECTRON_RUN_AS_NODE" → pembersihan entri lama;
//  - "entry.js --kopku-mcp-stdio menjawab MCP" → mode itu kini langsung keluar.
test('1.0.14: entri "kopku" milik KOPKU dilepas dari Claude Desktop, server lain & berkas rusak tidak disentuh', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-claude-'));
  const appData = path.join(home, 'Roaming');
  const lokal = path.join(home, 'Local');
  const biasa = path.join(appData, 'Claude');
  const store = path.join(lokal, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
  const rusak = path.join(lokal, 'Packages', 'Claude_rusak', 'LocalCache', 'Roaming', 'Claude');
  for (const d of [biasa, store, rusak]) fs.mkdirSync(d, { recursive: true });
  const blender = { command: 'uvx', args: ['blender-mcp'] };
  fs.writeFileSync(path.join(biasa, 'claude_desktop_config.json'), JSON.stringify({ preferences: { a: 1 }, mcpServers: { Blender: blender, kopku: { command: 'C:\\K\\KOPKU Desktop.exe', args: ['--kopku-mcp-stdio', '--data', 'D'] } } }));
  fs.writeFileSync(path.join(store, 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { kopku: { command: 'node', args: ['D:\\kopku\\KOPKU Desktop\\resources\\kopku-mcp\\stdio.js', '--data', 'D'] } } }));
  fs.writeFileSync(path.join(rusak, 'claude_desktop_config.json'), '{ rusak');
  const dataDir = path.join(home, 'data');
  fs.mkdirSync(path.join(dataDir, 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'mcp', 'endpoint.json'), '{"token":"x"}');
  const kunci = { 'kopku.claude.apikey': 'enc:x', 'kopku.claude.pengaturan': 'raw:x', lain: 'raw:y' };
  const secure = { _load: () => kunci, remove: (k) => delete kunci[k], get: (k) => kunci[k] ?? null };
  const h = bersihkanSisaClaude({ dataDir, secure, execPath: 'C:\\K\\KOPKU Desktop.exe', lingkungan: { platform: 'win32', env: { APPDATA: appData, LOCALAPPDATA: lokal }, home } });
  assert.equal(h.config.length, 2);
  const j1 = JSON.parse(fs.readFileSync(path.join(biasa, 'claude_desktop_config.json'), 'utf8'));
  assert.deepEqual(j1, { preferences: { a: 1 }, mcpServers: { Blender: blender } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, 'claude_desktop_config.json'), 'utf8')), { mcpServers: {} });
  assert.equal(fs.readFileSync(path.join(rusak, 'claude_desktop_config.json'), 'utf8'), '{ rusak');
  assert.ok(fs.readdirSync(biasa).some((f) => /kopku-dilepas-\d+\.json$/.test(f)), 'cadangan dibuat');
  assert.equal(fs.existsSync(path.join(dataDir, 'mcp')), false);
  assert.deepEqual(Object.keys(kunci), ['lain']);
  // idempoten
  assert.deepEqual(bersihkanSisaClaude({ dataDir, secure, execPath: 'x', lingkungan: { platform: 'win32', env: { APPDATA: appData, LOCALAPPDATA: lokal }, home } }).config, []);
  // entri "kopku" milik pihak lain tidak dianggap milik KOPKU
  assert.equal(entriMilikKopku({ command: 'python', args: ['kopku_server.py'] }, 'K.exe'), false);
  assert.equal(entriMilikKopku({ command: 'K.exe', args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }, 'k.EXE'), true);
});

test('1.0.14: entry.js --kopku-mcp-stdio langsung keluar (tanpa jendela, tanpa IPC, tanpa data)', async () => {
  const p = spawn(process.execPath, ['-r', path.join(__dirname, 'electron-stub.js'), path.join(ROOT, 'electron', 'entry.js'), '--kopku-mcp-stdio', '--data', os.tmpdir()], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (c) => (out += c));
  p.stderr.on('data', (c) => (err += c));
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  const kode = await new Promise((r) => p.on('exit', r));
  assert.equal(kode, 0);
  assert.equal(out, '', 'tidak menjawab MCP');
  assert.match(err, /\[stub\] exit 0 jendela=0 handler=0/, err);
  assert.equal(fs.existsSync(path.join(ROOT, 'electron', 'mcp')), false, 'kode konektor sudah dihapus');
});

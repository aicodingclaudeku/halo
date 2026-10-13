'use strict';
/**
 * KOPKU Desktop 1.0.29 — uji akses ChatGPT (server MCP Streamable HTTP di 127.0.0.1).
 *
 * KOPKU ASLI headless (service & SQLite asli) + adapter tulis ASLI + McpHost ASLI + AksesChatGPT ASLI,
 * diakses lewat HTTP sungguhan seperti ChatGPT (terowongan pengguna meneruskan apa adanya ke 127.0.0.1).
 *
 * Yang dibuktikan:
 *   - bawaan MATI; hanya Admin; butuh Asisten AI menyala; hanya mendengar di 127.0.0.1;
 *   - jalur/kunci salah, metode lain, Origin peramban asing → ditolak tanpa keterangan; batas laju 429;
 *   - alamat publik wajib HTTPS internet; URL konektor = alamat publik + /mcp/<kunci 256-bit>; ganti kunci → URL lama mati;
 *   - alat & penyaring SAMA dengan Claude; ubah data ChatGPT butuh izin TERPISAH; pratinjau + konfirmasi berjalan;
 *   - log bertanda [ChatGPT]; mematikan Asisten AI ikut mematikan server ChatGPT; kanal IPC layar.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { muatKopku, seed, ROOT } = require('../lan/kopkuHeadless');
const { pasangAdapter } = require(path.join(ROOT, 'electron/server/rendererAdapter'));
const { DirectServiceBridge } = require(path.join(ROOT, 'electron/server/serviceBridge'));
const { McpHost } = require(path.join(ROOT, 'electron/mcp/host'));
const { pasangAdapterTulis, indeksTulis } = require(path.join(ROOT, 'electron/mcp/adapterTulis'));
const { FsHost } = require(path.join(ROOT, 'electron/hosts/fsHost'));
const { AksesChatGPT, rapikanAlamat } = require(path.join(ROOT, 'electron/mcp/chatgpt'));
const { daftarkanIpcAsistenAi } = require(path.join(ROOT, 'electron/mcp/ipc'));
const katalog = require(path.join(ROOT, 'electron/mcp/katalog'));

const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

let k;
let s;
let host;
let gpt;
let dataDir;

function portBebas() {
  return new Promise((r) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => r(p));
    });
  });
}

/** Permintaan HTTP mentah ke server ChatGPT. */
function kirim({ jalur, metode = 'POST', isi, headers = {} }) {
  const st = gpt.status();
  return new Promise((resolve, reject) => {
    const badan = isi === undefined ? '' : JSON.stringify(isi);
    const req = http.request({ host: '127.0.0.1', port: st.port, path: jalur, method: metode, headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(badan) }, headers) }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json, teks: t });
      });
    });
    req.on('error', reject);
    req.end(badan);
  });
}
const jalurMcp = () => `/mcp/${gpt.baca().kunci}`;
let idRpc = 0;
const rpc = (method, params, headers) => kirim({ jalur: jalurMcp(), isi: { jsonrpc: '2.0', id: ++idRpc, method, params }, headers });
async function alat(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  const t = r.json.result.content[0].text;
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = t;
  }
  return { isError: r.json.result.isError, j, t };
}

before(async () => {
  k = muatKopku({ lisensiValid: true });
  s = await seed(k);
  const bridge = new DirectServiceBridge(pasangAdapter(k.ids, { tanpaRegistrasi: true }));
  const tulis = pasangAdapterTulis(indeksTulis(path.join(ROOT, 'renderer')));
  const fsh = new FsHost({ data: k.dataDir, documents: path.join(k.dataDir, 'documents'), cache: path.join(k.dataDir, 'cache') });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-mcp-gpt-'));
  host = new McpHost({ dataDir, bridge, versi: '1.0.29', pastikanAdapter: async () => undefined, tulis, salinKeCache: (p) => fsh.copyIntoCache(p) });
  const port = await portBebas();
  gpt = new AksesChatGPT({ host, dataDir, portAcak: () => port });
});
after(async () => {
  await host.henti();
});

test('bawaan MATI; hanya Admin; butuh Asisten AI menyala', async () => {
  const st = gpt.status();
  assert.equal(st.aktif, false);
  assert.equal(st.urlChatGPT, null);
  assert.equal(st.bolehTulis, false);
  await assert.rejects(gpt.atur({ aktif: true, penggunaId: s.users.operator }), /izin|Admin|Pengaturan/i);
  await assert.rejects(gpt.atur({ aktif: true, penggunaId: s.users.admin }), /Nyalakan Asisten AI/);
  assert.equal(gpt.berjalan, false);
});

test('menyala: hanya 127.0.0.1, port tetap, kunci 256-bit, URL konektor setelah alamat publik diisi', async () => {
  await host.atur({ aktif: true, perAnggota: true, penggunaId: s.users.admin });
  const st = await gpt.atur({ aktif: true, penggunaId: s.users.admin });
  assert.equal(st.aktif, true);
  assert.equal(gpt.server.address().address, '127.0.0.1');
  assert.match(gpt.baca().kunci, /^[0-9a-f]{64}$/);
  assert.equal(st.alamatLokal, `http://127.0.0.1:${st.port}`);
  assert.equal(st.perintahTerowongan, `cloudflared tunnel --url http://127.0.0.1:${st.port}`);
  assert.equal(st.urlChatGPT, null, 'tanpa alamat publik belum ada URL');
  const st2 = await gpt.atur({ alamatPublik: ' https://kopku-uji.trycloudflare.com/ ', penggunaId: s.users.admin });
  assert.equal(st2.urlChatGPT, `https://kopku-uji.trycloudflare.com/mcp/${gpt.baca().kunci}`);
  const mode = fs.statSync(path.join(dataDir, 'mcp', 'chatgpt.json')).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o600, 'berkas kunci hanya untuk pemilik');
});

test('alamat publik wajib HTTPS internet tanpa kredensial/parameter', () => {
  assert.equal(rapikanAlamat('https://a.example.com/apa/saja'), 'https://a.example.com');
  assert.equal(rapikanAlamat(''), null);
  for (const salah of ['http://a.example.com', 'https://localhost:8080', 'https://127.0.0.1', 'https://192.168.1.5', 'https://u:p@a.example.com', 'https://a.example.com/?x=1', 'bukan url']) {
    assert.throws(() => rapikanAlamat(salah), undefined, salah);
  }
});

test('penolakan: kunci/jalur salah, metode lain, Origin peramban asing → tanpa keterangan', async () => {
  const kunci = gpt.baca().kunci;
  const salah = kunci.slice(0, -1) + (kunci.endsWith('0') ? '1' : '0');
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
  for (const jalur of [`/mcp/${salah}`, '/mcp', '/', '/alat', '/panggil', `/mcp/${kunci}/lain`]) {
    const r = await kirim({ jalur, isi: init });
    assert.equal(r.status, 404, jalur);
    assert.doesNotMatch(r.teks, /kunci|token|KOPKU|alat/i, 'tanpa keterangan');
  }
  assert.equal((await kirim({ jalur: jalurMcp(), metode: 'GET' })).status, 405);
  assert.equal((await kirim({ jalur: jalurMcp(), isi: init, headers: { Origin: 'https://situs-jahat.example' } })).status, 404);
  assert.equal((await kirim({ jalur: jalurMcp(), isi: init, headers: { Origin: 'https://chatgpt.com' } })).status, 200);
  assert.equal((await kirim({ jalur: jalurMcp(), isi: undefined })).status, 400);
});

test('MCP: initialize + kebijakan, alat baca sama dengan Claude, keluaran tersaring', async () => {
  const i = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(i.status, 200);
  assert.equal(i.json.result.serverInfo.name, 'kopku');
  assert.ok(i.json.result.instructions.includes(katalog.KEBIJAKAN));
  assert.equal((await kirim({ jalur: jalurMcp(), isi: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202, 'notifikasi tanpa balasan');
  const daftar = (await rpc('tools/list', {})).json.result.tools.map((t) => t.name).sort();
  assert.deepEqual(daftar, katalog.ALAT.map((a) => a.name).sort());
  const r = await alat('ringkasan_koperasi', {});
  assert.equal(r.isError, false);
  assert.equal(r.j.anggotaAktif, 4);
  const ag = await alat('cari_anggota', {});
  assert.doesNotMatch(ag.t, RE_UUID);
  assert.doesNotMatch(ag.t, /nik|alamat|nomorHp/i);
});

test('ubah data: izin ChatGPT TERPISAH dari izin Claude; pratinjau + konfirmasi; log [ChatGPT]', async () => {
  await host.atur({ bolehTulis: true, penggunaId: s.users.admin });
  // Claude boleh, ChatGPT belum
  assert.ok((await host.daftarAlat('claude')).some((t) => t.name === 'kas_masuk'));
  const daftar = (await rpc('tools/list', {})).json.result.tools.map((t) => t.name);
  assert.ok(!daftar.includes('kas_masuk'), 'alat ubah data tidak ditawarkan ke ChatGPT');
  const args = { akun_pendapatan: '4-1500', nominal: 12345, tanggal: '2026-10-07', keterangan: 'uji chatgpt' };
  const tolak = await alat('kas_masuk', args);
  assert.equal(tolak.isError, true);
  assert.match(tolak.t, /ChatGPT TIDAK diizinkan.*Izinkan ChatGPT mengubah data/);
  // izinkan ChatGPT
  await gpt.atur({ bolehTulis: true, penggunaId: s.users.admin });
  const daftar2 = (await rpc('tools/list', {})).json.result.tools.map((t) => t.name);
  assert.ok(daftar2.includes('kas_masuk') && daftar2.includes('koreksi_transaksi'));
  const p = await alat('kas_masuk', args);
  assert.equal(p.j.status, 'MENUNGGU_KONFIRMASI', p.t);
  const h = await alat('kas_masuk', Object.assign({}, args, { konfirmasi: p.j.konfirmasi }));
  assert.equal(h.j.status, 'BERHASIL', h.t);
  const log = fs.readFileSync(path.join(dataDir, 'mcp', 'pemakaian.log'), 'utf8');
  assert.match(log, /kas_masuk\tBERHASIL\t\d+ms\t\[ChatGPT\] UBAH: /);
  // mematikan ubah data Asisten AI juga menutup ChatGPT
  await host.atur({ bolehTulis: false, penggunaId: s.users.admin });
  assert.ok(!(await rpc('tools/list', {})).json.result.tools.some((t) => t.name === 'kas_masuk'));
});

test('ganti kunci: URL lama langsung mati, URL baru berfungsi', async () => {
  const lama = gpt.baca().kunci;
  const st = await gpt.atur({ gantiKunci: true, penggunaId: s.users.admin });
  const baru = gpt.baca().kunci;
  assert.notEqual(baru, lama);
  assert.ok(st.urlChatGPT.endsWith(baru));
  assert.equal((await kirim({ jalur: `/mcp/${lama}`, isi: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 404);
  assert.equal((await rpc('ping', {})).status, 200);
});

test('batas laju: lebih dari 120 permintaan/menit → 429', async () => {
  const kini = Date.now();
  gpt.permintaan = Array.from({ length: 120 }, () => kini);
  const r = await rpc('ping', {});
  assert.equal(r.status, 429);
  gpt.permintaan = [];
  assert.equal((await rpc('ping', {})).status, 200);
});

test('kanal IPC layar: status memuat ChatGPT; aturChatGPT memeriksa izin; Asisten AI mati → ChatGPT mati', async () => {
  const handler = new Map();
  daftarkanIpcAsistenAi({
    h: (ch, fn) => handler.set(ch, fn),
    host,
    chatgpt: gpt,
    dataDir,
    execPath: 'C:\\K\\KOPKU Desktop.exe',
    appPath: null,
    versi: '1.0.29',
    ikon: null,
    shell: { openPath: async () => '', showItemInFolder() {}, openExternal: async () => undefined },
    clipboard: { writeText() {} },
    lingkungan: { platform: 'win32', env: { APPDATA: path.join(dataDir, 'R'), LOCALAPPDATA: path.join(dataDir, 'L') }, home: dataDir },
    platform: 'win32',
    cariNode: () => null,
  });
  const st = await handler.get('asistenAi:status')();
  assert.equal(st.chatgpt.aktif, true);
  assert.ok(st.chatgpt.urlChatGPT);
  await assert.rejects(handler.get('asistenAi:aturChatGPT')({ aktif: false, penggunaId: s.users.operator }));
  const st2 = await handler.get('asistenAi:aturChatGPT')({ alamatPublik: '', penggunaId: s.users.admin });
  assert.equal(st2.chatgpt.urlChatGPT, null);
  await handler.get('asistenAi:atur')({ aktif: false, penggunaId: s.users.admin });
  assert.equal(gpt.berjalan, false, 'server ChatGPT ikut mati');
  await assert.rejects(rpc('ping', {}), /ECONNREFUSED|ECONNRESET|socket hang up/);
});

'use strict';
/**
 * KOPKU Desktop 1.0.31 — uji ChatGPT lewat OpenAI Secure MCP Tunnel.
 *
 * Rantai yang diuji SUNGGUHAN: tiruan control plane OpenAI (protokol resmi) ⇄ tunnel-client-runtime ASLI
 * (dibangun dari github.com/openai/tunnel-client, lihat scripts/siapkan-tunnel-openai.sh) ⇄ server MCP KOPKU
 * di 127.0.0.1 ⇄ McpHost ASLI ⇄ service & SQLite KOPKU ASLI (headless). Yang TIDAK diuji di sini: server
 * OpenAI & ChatGPT yang sebenarnya (butuh akun/API key pengguna).
 *
 * Yang dibuktikan:
 *   - bawaan MATI; hanya Admin; validasi Tunnel ID & Runtime API key (admin key ditolak); prasyarat otomatis;
 *   - API key tidak pernah dikembalikan ke layar, tidak di chatgpt.json, tidak di log runtime;
 *   - "Terhubung" hanya bila control plane benar-benar menerima (bukan sekadar /readyz);
 *   - alat baca lewat tunnel, keluaran tersaring; ubah data ChatGPT butuh izin TERPISAH + pratinjau/konfirmasi;
 *   - kunci salah / tunnel tidak ada → pesan jelas; runtime mati mendadak → sambung ulang otomatis;
 *   - putuskan, sambung ulang, restart aplikasi (sambung otomatis hanya bila sebelumnya terhubung);
 *   - server lokal menolak tanpa Bearer / Origin peramban / kunci salah; batas laju; kanal IPC & tautan resmi.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { muatKopku, seed, ROOT } = require('../lan/kopkuHeadless');
const { pasangAdapter } = require(path.join(ROOT, 'electron/server/rendererAdapter'));
const { DirectServiceBridge } = require(path.join(ROOT, 'electron/server/serviceBridge'));
const { McpHost } = require(path.join(ROOT, 'electron/mcp/host'));
const { pasangAdapterTulis, indeksTulis } = require(path.join(ROOT, 'electron/mcp/adapterTulis'));
const { FsHost } = require(path.join(ROOT, 'electron/hosts/fsHost'));
const { AksesChatGPT, KUNCI_RAHASIA, TAUTAN } = require(path.join(ROOT, 'electron/mcp/chatgpt'));
const { RuntimeTunnel, tafsirHealth, saringLog } = require(path.join(ROOT, 'electron/mcp/tunnelOpenAI'));
const { daftarkanIpcAsistenAi } = require(path.join(ROOT, 'electron/mcp/ipc'));
const katalog = require(path.join(ROOT, 'electron/mcp/katalog'));
const { buatTiruanOpenAI } = require('./tiruanOpenAI');

const BIN = path.join(ROOT, 'vendor', 'openai-tunnel', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'tunnel-client-runtime.exe' : 'tunnel-client-runtime');
const ADA_BIN = fs.existsSync(BIN);
const lewati = ADA_BIN ? false : 'tunnel-client-runtime belum disiapkan (jalankan scripts/siapkan-tunnel-openai.sh)';

const TID = 'tunnel_0123456789abcdef0123456789abcdef';
const TID_LAIN = 'tunnel_ffffffffffffffffffffffffffffffff';
const KEY = 'sk-proj-ujiKOPKU0123456789abcdefABCDEF';
const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

let k;
let s;
let host;
let gpt;
let dataDir;
let openai;
let baseUrl;
const rahasia = new Map();
const penyimpan = { get: (x) => (rahasia.has(x) ? rahasia.get(x) : null), set: (x, v) => rahasia.set(x, v), remove: (x) => rahasia.delete(x) };

function buatAkses() {
  const runtime = new RuntimeTunnel({ jalurRuntime: () => (ADA_BIN ? BIN : null), dirLog: path.join(dataDir, 'mcp'), baseUrl, intervalMs: 300, tenggangGagalMs: 1500, jedaUlangMs: 500 });
  return new AksesChatGPT({ host, dataDir, rahasia: penyimpan, jalurRuntime: () => (ADA_BIN ? BIN : null), runtime });
}

async function tungguKeadaan(target, ms = 20000) {
  const akhir = Date.now() + ms;
  let st;
  while (Date.now() < akhir) {
    st = gpt.status();
    if ((Array.isArray(target) ? target : [target]).includes(st.keadaan)) return st;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`keadaan tidak menjadi ${target} (terakhir ${st && st.keadaan}: ${st && st.pesan})`);
}

let idRpc = 0;
async function lewatTunnel(method, params) {
  const j = await openai.kirim({ jsonrpc: '2.0', id: ++idRpc, method, params });
  return j.resp_json;
}
async function alat(name, args) {
  const r = await lewatTunnel('tools/call', { name, arguments: args });
  const t = r.result.content[0].text;
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = t;
  }
  return { isError: r.result.isError, j, t };
}
function lokal({ headers = {}, metode = 'POST', isi, jalur = '/mcp' }) {
  return new Promise((resolve, reject) => {
    const badan = isi === undefined ? '' : JSON.stringify(isi);
    const req = http.request({ host: '127.0.0.1', port: gpt.port, path: jalur, method: metode, agent: false, headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(badan) }, headers) }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode, teks: t }));
    });
    req.on('error', reject);
    req.end(badan);
  });
}

before(async () => {
  k = muatKopku({ lisensiValid: true });
  s = await seed(k);
  const bridge = new DirectServiceBridge(pasangAdapter(k.ids, { tanpaRegistrasi: true }));
  const tulis = pasangAdapterTulis(indeksTulis(path.join(ROOT, 'renderer')));
  const fsh = new FsHost({ data: k.dataDir, documents: path.join(k.dataDir, 'documents'), cache: path.join(k.dataDir, 'cache') });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-mcp-gpt-'));
  host = new McpHost({ dataDir, bridge, versi: '1.0.31', pastikanAdapter: async () => undefined, tulis, salinKeCache: (p) => fsh.copyIntoCache(p), batasUbah: [{ ms: 60000, maks: 1000, label: 'uji' }] });
  openai = buatTiruanOpenAI({ apiKey: KEY, tunnelId: TID });
  baseUrl = await openai.mulai();
  gpt = buatAkses();
});
after(async () => {
  await gpt.henti();
  await host.henti();
  await openai.tutup();
});

test('bawaan MATI; validasi Tunnel ID & API key; admin key ditolak; hanya Admin; prasyarat otomatis', async () => {
  const st = gpt.status();
  assert.equal(st.keadaan, 'MATI');
  assert.equal(st.aktif, false);
  assert.equal(st.bolehTulis, false);
  assert.deepEqual(st.prasyarat.map((x) => [x.kode, x.ok]), [['ASISTEN', false], ['RUNTIME', ADA_BIN], ['TUNNEL', false], ['KUNCI', false]]);
  await assert.rejects(gpt.atur({ aksi: 'simpan', tunnelId: 'tunnel_salah', apiKey: KEY, penggunaId: s.users.admin }), /Tunnel ID tidak sah/);
  await assert.rejects(gpt.atur({ aksi: 'simpan', tunnelId: TID, apiKey: 'sk-admin-0123456789abcdefghijklmnop', penggunaId: s.users.admin }), /admin key/);
  await assert.rejects(gpt.atur({ aksi: 'simpan', tunnelId: TID, apiKey: 'bukan-kunci', penggunaId: s.users.admin }), /API key tidak sah/);
  await assert.rejects(gpt.atur({ aksi: 'simpan', tunnelId: TID, apiKey: KEY, penggunaId: s.users.operator }));
  await assert.rejects(gpt.atur({ aksi: 'hubungkan', penggunaId: s.users.admin }), /Asisten AI/);
  await host.atur({ aktif: true, perAnggota: true, penggunaId: s.users.admin });
  await assert.rejects(gpt.atur({ aksi: 'hubungkan', penggunaId: s.users.admin }), /Simpan Tunnel ID/);
});

test('kredensial: API key terenkripsi terpisah, tidak pernah kembali ke layar / chatgpt.json', async () => {
  const st = await gpt.atur({ aksi: 'simpan', tunnelId: ` ${TID} `, apiKey: ` ${KEY} `, penggunaId: s.users.admin });
  assert.equal(st.tunnelId, TID);
  assert.deepEqual(st.apiKey, { ada: true, akhir: KEY.slice(-4) });
  assert.equal(rahasia.get(KUNCI_RAHASIA), KEY);
  assert.ok(!JSON.stringify(st).includes(KEY), 'status tanpa API key');
  assert.ok(!fs.readFileSync(path.join(dataDir, 'mcp', 'chatgpt.json'), 'utf8').includes('sk-'), 'chatgpt.json tanpa API key');
  assert.ok(st.prasyarat.every((x) => x.ok || (x.kode === 'RUNTIME' && !ADA_BIN)));
  // simpan ulang tanpa API key = key lama dipakai
  await gpt.atur({ aksi: 'simpan', tunnelId: TID, penggunaId: s.users.admin });
  assert.equal(rahasia.get(KUNCI_RAHASIA), KEY);
});

test('Hubungkan → runtime resmi ⇄ OpenAI (tiruan) ⇄ KOPKU: TERHUBUNG, alat baca lewat tunnel, keluaran tersaring', { skip: lewati }, async () => {
  const st0 = await gpt.atur({ aksi: 'hubungkan', penggunaId: s.users.admin });
  assert.ok(['MENYAMBUNG', 'TERHUBUNG'].includes(st0.keadaan));
  const st = await tungguKeadaan('TERHUBUNG');
  assert.ok(st.terhubungPada);
  assert.ok(openai.catatan.auth.every((a) => a === `Bearer ${KEY}`), 'runtime memakai API key dari KOPKU');
  const init = await lewatTunnel('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(init.result.serverInfo.name, 'kopku');
  assert.ok(init.result.instructions.includes(katalog.KEBIJAKAN));
  const daftar = (await lewatTunnel('tools/list', {})).result.tools.map((t) => t.name).sort();
  assert.deepEqual(daftar, katalog.ALAT.map((a) => a.name).sort(), 'hanya alat baca (bawaan read-only)');
  const r = await alat('ringkasan_koperasi', {});
  assert.equal(r.isError, false);
  assert.equal(r.j.anggotaAktif, 4);
  const ag = await alat('cari_anggota', {});
  assert.doesNotMatch(ag.t, RE_UUID);
  assert.doesNotMatch(ag.t, /nik|alamat|nomorHp/i);
  const lap = await alat('laporan_keuangan', { jenis: 'posisi_keuangan' });
  assert.equal(lap.isError, false);
  assert.ok(openai.catatan.shardOk, 'shard token dikembalikan sesuai protokol');
  assert.ok(gpt.status().pemakaian.total >= 5);
  const log = fs.readFileSync(path.join(dataDir, 'mcp', 'chatgpt-tunnel.log'), 'utf8');
  assert.ok(log.length > 0);
  assert.ok(!log.includes(KEY), 'API key tidak ada di log runtime');
  assert.ok(!log.includes(gpt.baca().kunci), 'kunci lokal tidak ada di log runtime');
});

test('ubah data: izin ChatGPT TERPISAH; pratinjau + konfirmasi lewat tunnel; log [ChatGPT]', { skip: lewati }, async () => {
  await host.atur({ bolehTulis: true, penggunaId: s.users.admin });
  assert.ok(!(await lewatTunnel('tools/list', {})).result.tools.some((t) => t.name === 'kas_masuk'), 'Claude boleh, ChatGPT belum');
  const args = { akun_pendapatan: '4-1500', nominal: 12345, tanggal: '2026-10-07', keterangan: 'uji chatgpt tunnel' };
  const tolak = await alat('kas_masuk', args);
  assert.equal(tolak.isError, true);
  assert.match(tolak.t, /ChatGPT TIDAK diizinkan.*Izinkan ChatGPT mengubah data/);
  await gpt.atur({ aksi: 'izin', bolehTulis: true, penggunaId: s.users.admin });
  assert.ok((await lewatTunnel('tools/list', {})).result.tools.some((t) => t.name === 'kas_masuk'));
  const p = await alat('kas_masuk', args);
  assert.equal(p.j.status, 'MENUNGGU_KONFIRMASI', p.t);
  const h = await alat('kas_masuk', Object.assign({}, args, { konfirmasi: p.j.konfirmasi }));
  assert.equal(h.j.status, 'BERHASIL', h.t);
  assert.match(fs.readFileSync(path.join(dataDir, 'mcp', 'pemakaian.log'), 'utf8'), /kas_masuk\tBERHASIL\t\d+ms\t\[ChatGPT\] UBAH: /);
  await gpt.atur({ aksi: 'izin', bolehTulis: false, penggunaId: s.users.admin });
  await host.atur({ bolehTulis: false, penggunaId: s.users.admin });
  assert.ok(!(await lewatTunnel('tools/list', {})).result.tools.some((t) => t.name === 'kas_masuk'));
});

test('server lokal: tanpa Bearer / kunci salah / Origin peramban / jalur lain → 404; OAuth discovery 404; batas laju', { skip: lewati }, async () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
  const kunci = gpt.baca().kunci;
  assert.equal((await lokal({ isi: init })).status, 404);
  assert.equal((await lokal({ isi: init, headers: { Authorization: 'Bearer ' + '0'.repeat(64) } })).status, 404);
  assert.equal((await lokal({ isi: init, headers: { Authorization: 'Bearer ' + kunci, Origin: 'https://situs-jahat.example' } })).status, 404);
  assert.equal((await lokal({ isi: init, jalur: '/mcp/' + kunci })).status, 404);
  assert.equal((await lokal({ metode: 'GET', jalur: '/.well-known/oauth-protected-resource' })).status, 404);
  assert.equal((await lokal({ isi: init, headers: { Authorization: 'Bearer ' + kunci } })).status, 200);
  assert.equal((await lokal({ headers: { Authorization: 'Bearer ' + kunci } })).status, 400, 'badan kosong (probe) tidak membuat galat');
  gpt.permintaan = Array.from({ length: 120 }, () => Date.now());
  assert.equal((await lokal({ isi: init, headers: { Authorization: 'Bearer ' + kunci } })).status, 429);
  gpt.permintaan = [];
});

test('kegagalan: API key ditolak / tunnel tidak ada → GAGAL dengan pesan jelas (bukan "Terhubung")', { skip: lewati }, async () => {
  openai.srv.apiKey = 'sk-proj-kunciLainDiOpenAI000000000000';
  await gpt.atur({ aksi: 'hubungkan', penggunaId: s.users.admin });
  let st = await tungguKeadaan('GAGAL');
  assert.equal(st.kode, 'KUNCI_SALAH');
  assert.match(st.pesan, /API key ditolak OpenAI/);
  openai.srv.apiKey = KEY;
  await gpt.atur({ aksi: 'simpan', tunnelId: TID_LAIN, penggunaId: s.users.admin });
  st = await tungguKeadaan('GAGAL');
  assert.equal(st.kode, 'TUNNEL_TIDAK_ADA');
  await gpt.atur({ aksi: 'simpan', tunnelId: TID, penggunaId: s.users.admin });
  await tungguKeadaan('TERHUBUNG');
});

test('runtime berhenti mendadak → GAGAL lalu tersambung ulang otomatis', { skip: lewati }, async () => {
  gpt.runtime.proses.kill('SIGKILL');
  const st = await tungguKeadaan(['GAGAL', 'MENYAMBUNG']);
  assert.ok(st.kode === 'RUNTIME_BERHENTI' || st.keadaan === 'MENYAMBUNG');
  await tungguKeadaan('TERHUBUNG');
  assert.equal((await alat('status_kopku', {})).isError, false);
});

test('putuskan → MATI & tunnel tidak dilayani; restart aplikasi: sambung otomatis hanya bila sebelumnya terhubung', { skip: lewati }, async () => {
  // restart saat terhubung → instance baru menyambung sendiri
  await gpt.henti();
  gpt = buatAkses();
  await gpt.mulaiBilaAktif();
  await tungguKeadaan('TERHUBUNG');
  assert.equal((await alat('status_kopku', {})).isError, false);
  // putuskan
  const st = await gpt.atur({ aksi: 'putuskan', penggunaId: s.users.admin });
  assert.equal(st.keadaan, 'MATI');
  assert.equal(gpt.berjalan, false);
  await assert.rejects(openai.kirim({ jsonrpc: '2.0', id: 99, method: 'ping' }, 2500), /tidak ada jawaban/);
  // restart setelah diputus → tetap MATI
  gpt = buatAkses();
  await gpt.mulaiBilaAktif();
  assert.equal(gpt.status().keadaan, 'MATI');
  // sambung ulang manual
  await gpt.atur({ aksi: 'hubungkan', penggunaId: s.users.admin });
  await tungguKeadaan('TERHUBUNG');
  assert.equal((await alat('status_kopku', {})).isError, false);
});

test('Asisten AI dimatikan → ChatGPT ikut berhenti; kanal IPC & tautan resmi; hapus kredensial', { skip: lewati }, async () => {
  const handler = new Map();
  const dibuka = [];
  daftarkanIpcAsistenAi({
    h: (ch, fn) => handler.set(ch, fn),
    host,
    chatgpt: gpt,
    dataDir,
    execPath: 'C:\\K\\KOPKU Desktop.exe',
    appPath: null,
    versi: '1.0.31',
    ikon: null,
    shell: { openPath: async () => '', showItemInFolder() {}, openExternal: async (u) => dibuka.push(u) },
    clipboard: { writeText() {} },
    lingkungan: { platform: 'win32', env: { APPDATA: path.join(dataDir, 'R'), LOCALAPPDATA: path.join(dataDir, 'L') }, home: dataDir },
    platform: 'win32',
    cariNode: () => null,
  });
  const st = await handler.get('asistenAi:status')();
  assert.equal(st.chatgpt.keadaan, 'TERHUBUNG');
  assert.ok(!JSON.stringify(st).includes(KEY));
  await handler.get('asistenAi:bukaTautanChatGPT')('tunnels');
  await handler.get('asistenAi:bukaTautanChatGPT')('konektor');
  assert.deepEqual(dibuka, [TAUTAN.tunnels, TAUTAN.konektor]);
  await assert.rejects(handler.get('asistenAi:bukaTautanChatGPT')('https://situs-lain.example'), /Tautan tidak dikenal/);
  await assert.rejects(handler.get('asistenAi:aturChatGPT')({ aksi: 'putuskan', penggunaId: s.users.operator }));
  // Asisten AI dimatikan → runtime & server ChatGPT berhenti
  await handler.get('asistenAi:atur')({ aktif: false, penggunaId: s.users.admin });
  assert.equal(gpt.berjalan, false);
  assert.equal(gpt.runtime.info().berjalan, false);
  // dinyalakan lagi → ChatGPT tersambung lagi (sebelumnya terhubung)
  await handler.get('asistenAi:atur')({ aktif: true, penggunaId: s.users.admin });
  await tungguKeadaan('TERHUBUNG');
  // hapus kredensial
  const st2 = await handler.get('asistenAi:aturChatGPT')({ aksi: 'hapus', penggunaId: s.users.admin });
  assert.equal(st2.chatgpt.keadaan, 'MATI');
  assert.equal(st2.chatgpt.tunnelId, null);
  assert.equal(st2.chatgpt.apiKey.ada, false);
  assert.equal(rahasia.has(KUNCI_RAHASIA), false);
});

test('tafsir health & penyaring log (unit)', () => {
  assert.equal(tafsirHealth({ components: { 'control-plane': { status: 'ok', details: { consecutive_failures: 0 } }, mcp: { details: { startup_probe: { state: 'succeeded' } } } } }).keadaan, 'TERHUBUNG');
  assert.equal(tafsirHealth({ components: { 'control-plane': { status: 'degraded', details: { http_status: 401 } } } }).kode, 'KUNCI_SALAH');
  assert.equal(tafsirHealth({ components: { 'control-plane': { status: 'degraded', details: { http_status: 403 } } } }).kode, 'IZIN_KURANG');
  assert.equal(tafsirHealth({ components: { 'control-plane': { status: 'degraded', details: { http_status: 404 } } } }).kode, 'TUNNEL_TIDAK_ADA');
  assert.equal(tafsirHealth({ components: { 'control-plane': { status: 'degraded', details: { failure_category: 'network' } } } }).kode, 'JARINGAN');
  assert.equal(tafsirHealth({ components: { 'control-plane': { status: 'ok', details: { consecutive_failures: 0 } }, mcp: { details: { startup_probe: { state: 'failed' } } } } }).kode, 'MCP_LOKAL');
  assert.equal(tafsirHealth({ live: true, ready: true }).keadaan, 'MENYAMBUNG', '/readyz saja tidak cukup');
  const t = saringLog('key=sk-proj-abcdefghijklmnop Authorization: Bearer 0123456789abcdef0123 rahasia-lokal-xyz', ['rahasia-lokal-xyz']);
  assert.doesNotMatch(t, /sk-proj-abc|0123456789abcdef0123|rahasia-lokal-xyz/);
});

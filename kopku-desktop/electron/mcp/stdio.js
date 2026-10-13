'use strict';
/**
 * KOPKU Desktop — Asisten AI (MCP) · SERVER STDIO untuk Claude Desktop.
 *
 * Claude Desktop menjalankan proses ini dan berbicara MCP (JSON-RPC 2.0,
 * satu pesan per baris) lewat stdin/stdout. Proses ini TIDAK membuka
 * database dan tidak memuat kode KOPKU lain: setiap pemanggilan alat
 * diteruskan ke host di proses utama KOPKU Desktop yang sedang terbuka
 * (HTTP 127.0.0.1 + token acak, lihat electron/mcp/host.js).
 *
 * Dijalankan dengan salah satu cara:
 *   - `KOPKU Desktop.exe --kopku-mcp-stdio --data <folder>` (electron/entry.js) — tanpa Node.js;
 *   - ekstensi Claude `.mcpb` (Node.js bawaan Claude Desktop) — `node stdio.js --data <folder>`;
 *   - manual: `node stdio.js --data <folder>`.
 *
 * Hanya bergantung pada modul bawaan Node + ./katalog.js.
 * stdout HANYA berisi pesan protokol; catatan diagnostik ke stderr.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const katalog = require('./katalog');

const VERSI = '1.0';
const BATAS_BARIS = 4 * 1024 * 1024;

/** Folder data bawaan KOPKU Desktop (sama dengan app.getPath('userData')). */
function folderDataBawaan({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'KOPKU Desktop');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'KOPKU Desktop');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'KOPKU Desktop');
}

function argData(argv) {
  const i = argv.indexOf('--data');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function bacaEndpoint(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp', 'endpoint.json'), 'utf8'));
    if (j && Number.isInteger(j.port) && typeof j.token === 'string' && j.token.length >= 32) return j;
  } catch {
    /* KOPKU Desktop belum menyalakan Asisten AI */
  }
  return null;
}

const PESAN_TERTUTUP =
  'KOPKU Desktop belum terbuka atau Asisten AI belum dinyalakan. Buka aplikasi KOPKU Desktop di komputer ini, masuk, lalu nyalakan Pengaturan › Asisten AI › "Hubungkan ke Claude". Setelah itu ulangi pertanyaan.';

/** Panggil host KOPKU Desktop. Galat koneksi → { tertutup: true }. */
function keHost(dataDir, metode, jalur, isi, batasMs = 120000) {
  const ep = bacaEndpoint(dataDir);
  if (!ep) return Promise.resolve({ tertutup: true });
  const badan = isi === undefined ? null : Buffer.from(JSON.stringify(isi), 'utf8');
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: ep.port,
        path: jalur,
        method: metode,
        headers: Object.assign({ Authorization: `Bearer ${ep.token}`, Accept: 'application/json' }, badan ? { 'Content-Type': 'application/json', 'Content-Length': badan.length } : {}),
        timeout: batasMs,
      },
      (res) => {
        const bagian = [];
        res.on('data', (c) => bagian.push(c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(bagian).toString('utf8'));
          } catch {
            json = null;
          }
          if (res.statusCode === 401 || res.statusCode === 403) return resolve({ tertutup: true });
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve(/timeout/.test(String(e && e.message)) ? { galat: 'KOPKU Desktop tidak menjawab tepat waktu. Coba lagi.' } : { tertutup: true }));
    if (badan) req.write(badan);
    req.end();
  });
}

const namaAlat = (tools) => tools.map((t) => t.name).sort().join(',');

/**
 * Daftar alat di KOPKU dapat berubah (sakelar per anggota / ubah data, izin pengguna) saat Claude
 * sudah terhubung → kirim `notifications/tools/list_changed` agar Claude memuat ulang daftar alat.
 */
async function alatBerubah(o) {
  if (o.daftarAlat === undefined) return false;
  const r = await (o.host || keHost)(o.dataDir, 'GET', '/alat', undefined, 3000);
  if (!(r.status === 200 && r.json && Array.isArray(r.json.tools))) return false;
  const baru = namaAlat(r.json.tools);
  if (baru === o.daftarAlat) return false;
  o.daftarAlat = baru;
  return true;
}

function hasilTeks(teks, isError = false) {
  return { content: [{ type: 'text', text: teks }], isError };
}

function pilihVersi(diminta) {
  return katalog.VERSI_PROTOKOL.includes(diminta) ? diminta : katalog.VERSI_PROTOKOL[0];
}

/**
 * Tangani satu pesan JSON-RPC. Mengembalikan objek balasan, atau null untuk notifikasi.
 * @param {any} msg
 * @param {{ dataDir:string, host?:typeof keHost }} o
 */
async function tangani(msg, o) {
  const host = o.host || keHost;
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) return null; // balasan dari klien
    return { jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const notifikasi = !('id' in msg);
  const ok = (result) => (notifikasi ? null : { jsonrpc: '2.0', id: msg.id, result });
  const gagal = (code, message) => (notifikasi ? null : { jsonrpc: '2.0', id: msg.id, error: { code, message } });
  const p = msg.params && typeof msg.params === 'object' ? msg.params : {};

  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: pilihVersi(p.protocolVersion),
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
        serverInfo: { name: katalog.NAMA_SERVER, title: 'KOPKU — Asisten AI Koperasi', version: VERSI },
        instructions: katalog.PETUNJUK,
      });
    case 'ping':
      return ok({});
    case 'tools/list': {
      const r = await host(o.dataDir, 'GET', '/alat', undefined, 5000);
      const tools = r.status === 200 && r.json && Array.isArray(r.json.tools) ? r.json.tools : katalog.untukMcp(); // KOPKU tertutup: alat baca tetap dikenal
      o.daftarAlat = namaAlat(tools);
      return ok({ tools });
    }
    case 'tools/call': {
      const nama = typeof p.name === 'string' ? p.name : '';
      if (!katalog.ALAT.some((a) => a.name === nama) && !katalog.ALAT_TULIS.some((a) => a.name === nama)) return gagal(-32602, `Alat tidak dikenal: ${nama}`);
      const r = await host(o.dataDir, 'POST', '/panggil', { name: nama, arguments: p.arguments && typeof p.arguments === 'object' ? p.arguments : {} });
      if (r.tertutup) return ok(hasilTeks(PESAN_TERTUTUP, true));
      if (r.galat) return ok(hasilTeks(r.galat, true));
      if (r.status === 200 && r.json && Array.isArray(r.json.content)) return ok(r.json);
      return ok(hasilTeks((r.json && r.json.pesan) || 'KOPKU Desktop mengembalikan galat yang tidak dikenal.', true));
    }
    case 'resources/list':
      return ok({ resources: [] });
    case 'resources/templates/list':
      return ok({ resourceTemplates: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    case 'logging/setLevel':
      return ok({});
    default:
      if (notifikasi) return null; // notifications/initialized, notifications/cancelled, dst.
      return gagal(-32601, `Method not found: ${msg.method}`);
  }
}

/**
 * Jalankan loop stdio. Resolve saat stdin ditutup (Claude Desktop menghentikan server).
 * @param {{ dataDir?:string, stdin?:NodeJS.ReadableStream, stdout?:NodeJS.WritableStream, stderr?:NodeJS.WritableStream, host?:Function }} opsi
 */
function jalankanStdio(opsi = {}) {
  const stdin = opsi.stdin || process.stdin;
  const stdout = opsi.stdout || process.stdout;
  const stderr = opsi.stderr || process.stderr;
  const o = { dataDir: opsi.dataDir || argData(process.argv) || folderDataBawaan(), host: opsi.host };
  let sisa = '';
  let antre = Promise.resolve();
  let jumlahPesan = 0;
  let ditutup = false;
  const tulis = (obj) => {
    if (obj) stdout.write(JSON.stringify(obj) + '\n');
  };
  const proses = (baris) => {
    if (!baris.trim()) return;
    jumlahPesan++;
    let msg;
    try {
      msg = JSON.parse(baris);
    } catch {
      tulis({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    // Pesan dijawab berurutan; pemanggilan alat dilayani satu per satu oleh host.
    antre = antre.then(async () => {
      try {
        if (Array.isArray(msg)) {
          const hasil = (await Promise.all(msg.map((m) => tangani(m, o)))).filter(Boolean);
          if (hasil.length) tulis(hasil);
        } else {
          tulis(await tangani(msg, o));
          if (msg && msg.method === 'tools/call' && (await alatBerubah(o).catch(() => false))) tulis({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        }
      } catch (e) {
        stderr.write(`[kopku-mcp] galat: ${(e && e.message) || e}\n`);
        if (msg && msg.id !== undefined) tulis({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
      }
    });
  };
  stderr.write(`[kopku-mcp] siap · data: ${o.dataDir}\n`);
  // Periksa perubahan daftar alat tiap 20 detik (sakelar diubah di KOPKU saat Claude sudah terhubung).
  const pantau = setInterval(() => {
    antre = antre.then(async () => {
      if (await alatBerubah(o).catch(() => false)) tulis({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    });
  }, opsi.intervalPantauMs || 20000);
  if (typeof pantau.unref === 'function') pantau.unref();
  return new Promise((resolve) => {
    if (typeof stdin.setEncoding === 'function') stdin.setEncoding('utf8');
    stdin.on('data', (c) => {
      sisa += c;
      if (sisa.length > BATAS_BARIS && sisa.indexOf('\n') < 0) {
        sisa = '';
        tulis({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Pesan terlalu besar' } });
        return;
      }
      let i;
      while ((i = sisa.indexOf('\n')) >= 0) {
        const baris = sisa.slice(0, i).replace(/\r$/, '');
        sisa = sisa.slice(i + 1);
        proses(baris);
      }
    });
    const selesai = () => {
      if (ditutup) return;
      ditutup = true;
      clearInterval(pantau);
      if (sisa.trim()) proses(sisa);
      sisa = '';
      stderr.write(`[kopku-mcp] stdin ditutup setelah ${jumlahPesan} pesan\n`);
      if (jumlahPesan === 0 && process.versions.electron) {
        stderr.write('[kopku-mcp] stdin proses KOPKU Desktop.exe tidak dapat dibaca (Windows). Buka KOPKU › Pengaturan › Asisten AI › "Pasang ulang ke Claude Desktop" (memakai Node.js) atau "Buat & buka ekstensi".\n');
      }
      antre.then(resolve, resolve);
    };
    stdin.on('end', selesai);
    stdin.on('close', selesai);
    if (typeof stdin.resume === 'function') stdin.resume();
  });
}

module.exports = { jalankanStdio, tangani, folderDataBawaan, bacaEndpoint, PESAN_TERTUTUP };

if (require.main === module) {
  jalankanStdio().then(() => process.exit(0));
}

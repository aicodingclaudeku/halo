'use strict';
/**
 * KOPKU Desktop — Asisten AI (MCP) · SERVER LOKAL untuk Claude Desktop (1.0.26).
 *
 * Temuan di Windows (log Claude Desktop pengguna, 13 Okt 2026): `KOPKU Desktop.exe --kopku-mcp-stdio`
 * mencetak "[kopku-mcp] siap" lalu keluar ±0,3 detik kemudian — stdin proses Electron (aplikasi GUI)
 * di Windows langsung tertutup, sehingga Claude melapor "Server disconnected". Versi 1.0.13 gagal
 * dengan pola yang sama. Karena itu cara utama kini memakai Node.js:
 *
 *   1. Node.js terpasang di komputer → `node.exe <userData>/mcp/server/stdio.js --data <userData>`
 *      (salinan stdio.js + katalog.js ditulis ke folder data; Node tidak dapat membaca app.asar).
 *   2. Tidak ada Node.js → paket ekstensi `.mcpb` (dijalankan Node.js BAWAAN Claude Desktop).
 *   3. `KOPKU Desktop.exe --kopku-mcp-stdio` hanya cadangan terakhir (berfungsi di macOS/Linux).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BERKAS_SERVER = ['stdio.js', 'katalog.js'];

/**
 * 1.0.28 — versi berkas yang DIKIRIM ke luar aplikasi (folder data pengguna & paket .mcpb): tanpa komentar,
 * sehingga tidak memuat keterangan struktur internal KOPKU (nama berkas, alur, mekanisme keamanan).
 * Hasil diperiksa dapat dikompilasi; bila tidak, pemasangan gagal (bukan mengirim versi berkomentar).
 */
function untukDikirim(sumber) {
  const teks = String(sumber)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''))
    .join('\n');
  new (require('node:vm').Script)(`(function (exports, require, module, __filename, __dirname) {${teks}\n})`);
  return Buffer.from("'use strict';\n" + teks.replace(/^\s*'use strict';\s*/, ''), 'utf8');
}

/** Salin server stdio ke <dataDir>/mcp/server (hanya bila isinya berbeda). @returns jalur stdio.js */
function siapkanServerLokal(dataDir, sumberDir = __dirname) {
  const tujuan = path.join(dataDir, 'mcp', 'server');
  fs.mkdirSync(tujuan, { recursive: true });
  for (const n of BERKAS_SERVER) {
    const isi = untukDikirim(fs.readFileSync(path.join(sumberDir, n), 'utf8'));
    const f = path.join(tujuan, n);
    let lama = null;
    try {
      lama = fs.readFileSync(f);
    } catch {
      lama = null;
    }
    if (!lama || !lama.equals(isi)) {
      fs.writeFileSync(f + '.tmp', isi);
      fs.renameSync(f + '.tmp', f);
    }
  }
  return path.join(tujuan, 'stdio.js');
}

/** Kandidat lokasi node(.exe): PATH lalu lokasi pemasangan umum. */
function kandidatNode({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const exe = platform === 'win32' ? 'node.exe' : 'node';
  const pisah = platform === 'win32' ? ';' : ':';
  const daftar = [];
  for (const d of String(env.PATH || env.Path || '').split(pisah)) if (d.trim()) daftar.push(path.join(d.trim().replace(/^"|"$/g, ''), exe));
  if (platform === 'win32') {
    for (const pf of [env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
      if (pf) daftar.push(path.join(pf, 'nodejs', exe));
    }
    if (env.NVM_SYMLINK) daftar.push(path.join(env.NVM_SYMLINK, exe));
    if (env.APPDATA) daftar.push(path.join(env.APPDATA, 'nvm', 'nodejs', exe));
  } else {
    daftar.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', path.join(home, '.volta', 'bin', 'node'));
  }
  return [...new Set(daftar)];
}

/**
 * Cari Node.js ≥ 18 yang benar-benar dapat dijalankan.
 * @returns {{ path:string, versi:string } | null}
 */
function cariNode(o = {}) {
  const jalankan = o.jalankan || ((f) => execFileSync(f, ['-v'], { timeout: 5000, windowsHide: true, encoding: 'utf8' }));
  for (const f of kandidatNode(o)) {
    try {
      if (!fs.statSync(f).isFile()) continue;
      const v = String(jalankan(f)).trim();
      const m = /^v(\d+)\./.exec(v);
      if (m && Number(m[1]) >= 18) return { path: f, versi: v };
    } catch {
      /* bukan node yang dapat dijalankan */
    }
  }
  return null;
}

module.exports = { siapkanServerLokal, cariNode, kandidatNode, untukDikirim, BERKAS_SERVER };

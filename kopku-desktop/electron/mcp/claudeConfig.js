'use strict';
/**
 * KOPKU Desktop — Asisten AI (MCP) · PEMASANG KONFIGURASI CLAUDE DESKTOP.
 *
 * Menulis/melepas entri `mcpServers.kopku` di `claude_desktop_config.json`:
 *   Windows : %APPDATA%\Claude\  dan versi Microsoft Store
 *             %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\
 *   macOS   : ~/Library/Application Support/Claude/
 *
 * Aturan aman:
 *   - Server MCP lain & pengaturan lain di berkas itu TIDAK disentuh.
 *   - Cadangan `claude_desktop_config.kopku-cadangan-<waktu>.json` dibuat sebelum berkas diubah.
 *   - Berkas yang JSON-nya rusak TIDAK ditimpa (pengguna diberi tahu).
 *   - Entri `kopku` milik program lain (bukan KOPKU Desktop) tidak ditimpa/dilepas.
 *   - Penulisan atomik (berkas sementara lalu rename).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NAMA_ENTRI = 'kopku';
const SAKLAR = '--kopku-mcp-stdio';

/** Folder konfigurasi Claude Desktop yang mungkin ada di komputer ini. */
function folderClaude({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const daftar = [];
  if (platform === 'win32') {
    daftar.push(path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude'));
    const paket = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Packages');
    try {
      for (const n of fs.readdirSync(paket)) {
        if (/^(Claude|AnthropicPBC\.Claude)_/i.test(n)) daftar.push(path.join(paket, n, 'LocalCache', 'Roaming', 'Claude'));
      }
    } catch {
      /* tidak ada folder Packages */
    }
  } else if (platform === 'darwin') {
    daftar.push(path.join(home, 'Library', 'Application Support', 'Claude'));
  } else {
    daftar.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude'));
  }
  return daftar;
}

/**
 * Entri MCP yang menjalankan KOPKU Desktop dalam mode stdio (tanpa Node.js terpasang).
 * @param {{ execPath:string, dataDir:string, appPath?:string|null }} o appPath diisi saat dijalankan dari source (`electron .`).
 */
function entriKopku({ execPath, dataDir, appPath = null }) {
  return { command: execPath, args: [...(appPath ? [appPath] : []), SAKLAR, '--data', dataDir] };
}

/** Apakah entri MCP ini dibuat oleh KOPKU Desktop (versi mana pun). */
function entriMilikKopku(e) {
  if (!e || typeof e !== 'object') return false;
  const args = Array.isArray(e.args) ? e.args.map(String) : [];
  if (args.includes(SAKLAR)) return true;
  if (args.some((a) => /kopku-mcp[\\/]+stdio\.js$/i.test(a) || /[\\/]electron[\\/]+mcp[\\/]+stdio\.js$/i.test(a))) return true;
  const cmd = String(e.command || '');
  return /KOPKU Desktop(\.exe)?$/i.test(cmd) && !!(e.env && e.env.ELECTRON_RUN_AS_NODE);
}

function samaEntri(a, b) {
  return !!a && !!b && a.command === b.command && JSON.stringify(a.args || []) === JSON.stringify(b.args || []) && !a.env;
}

function bacaConfig(berkas) {
  if (!fs.existsSync(berkas)) return { ada: false, json: {} };
  const teks = fs.readFileSync(berkas, 'utf8');
  if (!teks.trim()) return { ada: true, json: {} };
  try {
    const json = JSON.parse(teks.replace(/^﻿/, ''));
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { ada: true, rusak: true };
    return { ada: true, json };
  } catch {
    return { ada: true, rusak: true };
  }
}

function tulisConfig(berkas, json, adaSebelumnya, now) {
  fs.mkdirSync(path.dirname(berkas), { recursive: true });
  if (adaSebelumnya) fs.copyFileSync(berkas, path.join(path.dirname(berkas), `claude_desktop_config.kopku-cadangan-${now}.json`));
  const tmp = `${berkas}.kopku.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n');
  fs.renameSync(tmp, berkas);
}

/**
 * Status pemasangan di setiap lokasi.
 * @param {{ entri:object, lingkungan?:object }} o
 */
function statusClaude({ entri, lingkungan } = {}) {
  const lokasi = folderClaude(lingkungan).map((dir) => {
    const berkas = path.join(dir, 'claude_desktop_config.json');
    const folderAda = fs.existsSync(dir);
    let c = { ada: false, json: {} };
    try {
      c = bacaConfig(berkas);
    } catch {
      c = { ada: true, rusak: true };
    }
    const e = !c.rusak && c.json.mcpServers ? c.json.mcpServers[NAMA_ENTRI] : undefined;
    return {
      folder: dir,
      berkas,
      folderAda,
      berkasAda: c.ada,
      rusak: !!c.rusak,
      terpasang: !!e && entriMilikKopku(e),
      cocok: !!e && samaEntri(e, entri),
      entriLain: !!e && !entriMilikKopku(e),
      serverLain: !c.rusak && c.json.mcpServers ? Object.keys(c.json.mcpServers).filter((n) => n !== NAMA_ENTRI) : [],
    };
  });
  return {
    claudeTerdeteksi: lokasi.some((l) => l.folderAda),
    terpasang: lokasi.some((l) => l.terpasang),
    cocok: lokasi.some((l) => l.cocok),
    lokasi,
  };
}

/**
 * Pasang/perbarui entri `kopku` di semua lokasi Claude Desktop yang ada
 * (bila belum ada satu pun, dibuat di lokasi standar).
 * @returns {{ diubah:string[], tetap:string[], dilewati:{berkas:string,alasan:string}[] }}
 */
function pasangKeClaude({ entri, lingkungan, now = Date.now() } = {}) {
  const semua = folderClaude(lingkungan);
  let target = semua.filter((d) => fs.existsSync(d));
  if (!target.length) target = [semua[0]];
  const hasil = { diubah: [], tetap: [], dilewati: [] };
  for (const dir of target) {
    const berkas = path.join(dir, 'claude_desktop_config.json');
    const c = bacaConfig(berkas);
    if (c.rusak) {
      hasil.dilewati.push({ berkas, alasan: 'Isi berkas bukan JSON yang sah — tidak diubah. Perbaiki atau pakai "Pasang manual".' });
      continue;
    }
    const json = c.json;
    if (!json.mcpServers || typeof json.mcpServers !== 'object' || Array.isArray(json.mcpServers)) json.mcpServers = {};
    const lama = json.mcpServers[NAMA_ENTRI];
    if (lama && !entriMilikKopku(lama)) {
      hasil.dilewati.push({ berkas, alasan: 'Sudah ada server bernama "kopku" milik program lain — tidak ditimpa.' });
      continue;
    }
    if (samaEntri(lama, entri)) {
      hasil.tetap.push(berkas);
      continue;
    }
    json.mcpServers[NAMA_ENTRI] = entri;
    tulisConfig(berkas, json, c.ada, now);
    hasil.diubah.push(berkas);
  }
  if (!hasil.diubah.length && !hasil.tetap.length) {
    throw Object.assign(new Error(hasil.dilewati.map((x) => `${x.berkas}: ${x.alasan}`).join(' ') || 'Konfigurasi Claude Desktop tidak dapat diubah.'), { kode: 'VALIDASI' });
  }
  return hasil;
}

/** Lepas entri `kopku` milik KOPKU dari semua lokasi. */
function lepasDariClaude({ lingkungan, now = Date.now() } = {}) {
  const diubah = [];
  for (const dir of folderClaude(lingkungan)) {
    const berkas = path.join(dir, 'claude_desktop_config.json');
    let c;
    try {
      c = bacaConfig(berkas);
    } catch {
      continue;
    }
    if (!c.ada || c.rusak || !c.json.mcpServers || !entriMilikKopku(c.json.mcpServers[NAMA_ENTRI])) continue;
    delete c.json.mcpServers[NAMA_ENTRI];
    tulisConfig(berkas, c.json, true, now);
    diubah.push(berkas);
  }
  return { diubah };
}

/**
 * Bila KOPKU Desktop dipindah/diperbarui ke folder lain, entri lama menunjuk exe yang salah.
 * Perbarui HANYA entri milik KOPKU yang sudah terpasang (tidak memasang baru).
 */
function perbaruiBilaBerubah({ entri, lingkungan, now = Date.now() } = {}) {
  const diubah = [];
  for (const dir of folderClaude(lingkungan)) {
    const berkas = path.join(dir, 'claude_desktop_config.json');
    let c;
    try {
      c = bacaConfig(berkas);
    } catch {
      continue;
    }
    if (!c.ada || c.rusak || !c.json.mcpServers) continue;
    const lama = c.json.mcpServers[NAMA_ENTRI];
    if (!entriMilikKopku(lama) || samaEntri(lama, entri)) continue;
    c.json.mcpServers[NAMA_ENTRI] = entri;
    tulisConfig(berkas, c.json, true, now);
    diubah.push(berkas);
  }
  return { diubah };
}

/** Potongan JSON untuk pemasangan manual (ditampilkan & dapat disalin). */
function potonganManual(entri) {
  return JSON.stringify({ mcpServers: { [NAMA_ENTRI]: entri } }, null, 2);
}

module.exports = { folderClaude, entriKopku, entriMilikKopku, statusClaude, pasangKeClaude, lepasDariClaude, perbaruiBilaBerubah, potonganManual, NAMA_ENTRI, SAKLAR };

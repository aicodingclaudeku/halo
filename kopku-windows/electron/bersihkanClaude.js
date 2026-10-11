'use strict';
/**
 * KOPKU Desktop 1.0.14 — fitur Claude DIHAPUS (permintaan pengguna 9 Okt 2026).
 *
 * Membersihkan sisa versi 1.0.11–1.0.13 sekali saat aplikasi dibuka (idempoten):
 *  1. Entri `mcpServers.kopku` di claude_desktop_config.json (Claude Desktop
 *     biasa & versi Microsoft Store) — HANYA bila entri itu memang milik KOPKU
 *     (`--kopku-mcp-stdio`, `kopku-mcp/stdio.js`, atau ELECTRON_RUN_AS_NODE ke
 *     exe ini). Server lain di berkas itu tidak disentuh; cadangan dibuat; berkas
 *     yang JSON-nya rusak dibiarkan.
 *  2. Folder `<userData>/mcp` (token konektor, pengaturan, log pemakaian).
 *  3. Kunci secure-store Asisten Claude (`kopku.claude.apikey`, `kopku.claude.pengaturan`).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KUNCI_SECURE = ['kopku.claude.apikey', 'kopku.claude.pengaturan'];

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

/** Apakah entri MCP ini dibuat oleh KOPKU Desktop 1.0.12/1.0.13. */
function entriMilikKopku(e, execPath) {
  if (!e || typeof e !== 'object') return false;
  const args = Array.isArray(e.args) ? e.args.map(String) : [];
  if (args.includes('--kopku-mcp-stdio')) return true;
  if (args.some((a) => /kopku-mcp[\\/]+stdio\.js$/i.test(a) || /[\\/]electron[\\/]+mcp[\\/]+stdio\.js$/i.test(a))) return true;
  const cmd = String(e.command || '');
  if (execPath && cmd && cmd.toLowerCase() === String(execPath).toLowerCase() && e.env && e.env.ELECTRON_RUN_AS_NODE) return true;
  return false;
}

/** Lepas entri `kopku` milik KOPKU dari konfigurasi Claude Desktop. @returns berkas yang diubah */
function lepasEntriClaudeDesktop({ execPath = process.execPath, lingkungan } = {}) {
  const diubah = [];
  for (const dir of folderClaude(lingkungan)) {
    const berkas = path.join(dir, 'claude_desktop_config.json');
    if (!fs.existsSync(berkas)) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(berkas, 'utf8'));
    } catch {
      continue; // JSON rusak: jangan ditimpa
    }
    if (!j || !j.mcpServers || !entriMilikKopku(j.mcpServers.kopku, execPath)) continue;
    fs.copyFileSync(berkas, path.join(dir, `claude_desktop_config.kopku-dilepas-${Date.now()}.json`));
    delete j.mcpServers.kopku;
    const tmp = berkas + '.kopku.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2));
    fs.renameSync(tmp, berkas);
    diubah.push(berkas);
  }
  return diubah;
}

/** Bersihkan seluruh sisa fitur Claude. Tidak pernah melempar. */
function bersihkanSisaClaude({ dataDir, secure, execPath = process.execPath, lingkungan } = {}) {
  const hasil = { config: [], folderMcp: false, kunci: [] };
  try {
    hasil.config = lepasEntriClaudeDesktop({ execPath, lingkungan });
  } catch {
    /* abaikan */
  }
  try {
    const dir = dataDir && path.join(dataDir, 'mcp');
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      hasil.folderMcp = true;
    }
  } catch {
    /* abaikan */
  }
  for (const k of KUNCI_SECURE) {
    try {
      const ada = secure && (typeof secure._load === 'function' ? k in secure._load() : secure.get(k) != null);
      if (ada) {
        secure.remove(k);
        hasil.kunci.push(k);
      }
    } catch {
      /* abaikan */
    }
  }
  return hasil;
}

module.exports = { bersihkanSisaClaude, lepasEntriClaudeDesktop, entriMilikKopku, folderClaude, KUNCI_SECURE };

'use strict';
/**
 * KOPKU Desktop — Asisten AI (MCP) · MODE STDIO di dalam `KOPKU Desktop.exe`.
 *
 * Claude Desktop menjalankan `KOPKU Desktop.exe --kopku-mcp-stdio --data <folder>`
 * (lihat electron/mcp/claudeConfig.js). Proses ini:
 *   - TIDAK membuat jendela, TIDAK membuka database, TIDAK mendaftarkan IPC,
 *     TIDAK mengambil kunci instance tunggal (KOPKU Desktop tetap bisa dibuka);
 *   - memakai profil Chromium sementara terpisah, sehingga folder data KOPKU tidak disentuh;
 *   - hanya menjalankan electron/mcp/stdio.js lalu keluar saat Claude menutup stdin.
 * Tidak memerlukan Node.js terpasang dan tidak memerlukan fuse RunAsNode (tetap OFF).
 */
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const keamanan = require('../keamanan');
const { jalankanStdio, folderDataBawaan } = require('./stdio');

// Aplikasi terpasang tetap menolak saklar debug (tanpa dialog: proses ini tidak berjendela).
if (app.isPackaged && keamanan.saklarDebug(process.argv, app.commandLine).length) {
  process.stderr.write('[kopku-mcp] opsi debug ditolak\n');
  app.exit(1);
} else {
  // Profil Chromium sementara, unik per proses (Claude dapat menjalankan beberapa proses sekaligus),
  // dihapus saat keluar. Folder data KOPKU tidak pernah dipakai sebagai profil di mode ini.
  const profil = path.join(os.tmpdir(), `kopku-mcp-stdio-${process.pid}`);
  try {
    app.setPath('userData', profil);
  } catch {
    /* abaikan */
  }
  process.on('exit', () => {
    try {
      require('node:fs').rmSync(profil, { recursive: true, force: true });
    } catch {
      /* abaikan */
    }
  });
  if (typeof app.disableHardwareAcceleration === 'function') app.disableHardwareAcceleration();
  if (process.platform === 'darwin' && app.dock && typeof app.dock.hide === 'function') app.dock.hide();
  // Tidak ada jendela → jangan keluar karena 'window-all-closed'; keluar hanya saat stdin ditutup.
  app.on('window-all-closed', () => undefined);
  const i = process.argv.indexOf('--data');
  const dataDir = i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : folderDataBawaan();
  jalankanStdio({ dataDir }).then(
    () => app.exit(0),
    () => app.exit(1)
  );
}

'use strict';
/**
 * Windows Firewall untuk port KOPKU LAN Multi-User.
 *
 * TIDAK pernah dijalankan otomatis. Hanya bila Admin menekan tombol
 * "Izinkan di Windows Firewall" di Pengaturan › LAN & WhatsApp; Windows lalu menampilkan dialog
 * UAC yang harus disetujui. Aturan yang dibuat: TCP masuk, port server
 * saja, HANYA dari subnet lokal (remoteip=localsubnet).
 * Aturan sinkron HP yang lama ("KOPKU Desktop Sinkron") tidak disentuh.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NAMA_ATURAN_LAN = 'KOPKU Desktop LAN Multi-User';

function perintahManual(port) {
  return `netsh advfirewall firewall add rule name="${NAMA_ATURAN_LAN}" dir=in action=allow protocol=TCP localport=${Number(port)} remoteip=localsubnet profile=private,domain`;
}

function izinkanPort(port) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: true, dilewati: true, pesan: 'Bukan Windows — atur firewall sistem secara manual bila perlu.' });
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) return resolve({ ok: false, pesan: 'Port tidak sah.' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-lan-fw-'));
    const cmd = path.join(dir, 'izinkan-kopku-lan.cmd');
    fs.writeFileSync(
      cmd,
      ['@echo off', `netsh advfirewall firewall delete rule name="${NAMA_ATURAN_LAN}" >nul 2>&1`, perintahManual(p), 'if errorlevel 1 exit /b 2', 'exit /b 0', ''].join('\r\n'),
      'utf8'
    );
    const skrip = `try { $p = Start-Process -FilePath '${cmd.replace(/'/g, "''")}' -Verb RunAs -Wait -WindowStyle Hidden -PassThru; exit $p.ExitCode } catch { exit 1223 }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', skrip], { windowsHide: true, timeout: 120000 }, (err) => {
      fs.rmSync(dir, { recursive: true, force: true });
      const kode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      if (kode === 1223) resolve({ ok: false, dibatalkan: true, pesan: 'Persetujuan Administrator dibatalkan. Firewall tidak diubah.' });
      else if (kode !== 0) resolve({ ok: false, pesan: `netsh gagal (kode ${kode}).` });
      else resolve({ ok: true, pesan: `Port ${p} diizinkan untuk jaringan lokal (profil Private/Domain).` });
    });
  });
}

module.exports = { izinkanPort, perintahManual, NAMA_ATURAN_LAN };

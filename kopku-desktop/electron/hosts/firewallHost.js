'use strict';
/**
 * WINDOWS FIREWALL — supaya HP dapat menghubungi server sinkron di LAN.
 *
 * Masalah nyata di lapangan: saat KOPKU Desktop pertama kali membuka
 * port, Windows menampilkan dialog izin firewall. Bila dialog itu ditutup
 * atau dibatalkan, Windows membuat aturan BLOKIR masuk untuk program ini.
 * Aturan blokir MENGALAHKAN aturan izin, sehingga HP mendapat "Aborted"
 * (permintaan tidak pernah dijawab). Jaringan Wi-Fi yang ditandai Publik
 * menimbulkan gejala yang sama.
 *
 * `status()` hanya MEMBACA (tanpa hak Administrator). `perbaiki()`
 * menjalankan skrip netsh dengan hak Administrator (muncul dialog UAC
 * yang harus disetujui pengguna):
 *   1. hapus aturan masuk lama milik program ini (termasuk aturan blokir);
 *   2. izinkan TCP 47821–47840 dan program ini, HANYA dari subnet lokal
 *      (remoteip=localsubnet), di semua profil jaringan.
 * Seluruh isi sinkron tetap terenkripsi ujung-ke-ujung; aturan ini hanya
 * membuka jalur jaringan lokal.
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NAMA_ATURAN = 'KOPKU Desktop Sinkron';
const PORT = '47821-47840';

function jalankan(file, args, batasMs = 20000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: batasMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ kode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), galat: err });
    });
  });
}

function psLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

class FirewallHost {
  constructor(exePath) {
    this.exe = exePath;
  }

  async status() {
    if (process.platform !== 'win32') return { didukung: false };
    const skrip = [
      '$ErrorActionPreference = "SilentlyContinue"',
      `$exe = ${psLit(this.exe)}`,
      `$izin = @(Get-NetFirewallRule -DisplayName ${psLit(NAMA_ATURAN)} | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' }).Count`,
      "$blokir = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -ieq $exe } | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' }).Count",
      "$profil = @(Get-NetConnectionProfile | ForEach-Object { \"$($_.InterfaceAlias)=$($_.NetworkCategory)\" }) -join ';'",
      '[pscustomobject]@{ izin = $izin; blokir = $blokir; profil = $profil } | ConvertTo-Json -Compress',
    ].join('; ');
    const r = await jalankan('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', skrip]);
    try {
      const o = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
      const profil = String(o.profil || '')
        .split(';')
        .filter(Boolean)
        .map((x) => {
          const [nama, kategori] = x.split('=');
          return { nama, kategori };
        });
      const izin = Number(o.izin || 0);
      const blokir = Number(o.blokir || 0);
      return { didukung: true, aturanIzin: izin > 0, aturanBlokir: blokir, profil, perluPerbaikan: izin === 0 || blokir > 0 };
    } catch {
      // PowerShell/NetSecurity tidak tersedia: tidak bisa dipastikan.
      return { didukung: true, tidakDiketahui: true, perluPerbaikan: true, pesan: (r.stderr || r.stdout).slice(0, 300) };
    }
  }

  async perbaiki() {
    if (process.platform !== 'win32') return { ok: true, dilewati: true };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-fw-'));
    const cmd = path.join(dir, 'izinkan-sinkron-kopku.cmd');
    const exe = this.exe.replace(/"/g, '');
    const isi = [
      '@echo off',
      'chcp 65001 >nul',
      `netsh advfirewall firewall delete rule name=all dir=in program="${exe}" >nul 2>&1`,
      `netsh advfirewall firewall delete rule name="${NAMA_ATURAN}" >nul 2>&1`,
      `netsh advfirewall firewall add rule name="${NAMA_ATURAN}" dir=in action=allow protocol=TCP localport=${PORT} remoteip=localsubnet profile=any`,
      'if errorlevel 1 exit /b 2',
      `netsh advfirewall firewall add rule name="${NAMA_ATURAN}" dir=in action=allow program="${exe}" protocol=TCP remoteip=localsubnet profile=any`,
      'exit /b 0',
      '',
    ].join('\r\n');
    fs.writeFileSync(cmd, isi, 'utf8');
    const skrip =
      `try { $p = Start-Process -FilePath ${psLit(cmd)} -Verb RunAs -Wait -WindowStyle Hidden -PassThru; exit $p.ExitCode } ` +
      'catch { Write-Output $_.Exception.Message; exit 1223 }';
    const r = await jalankan('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', skrip], 120000);
    fs.rmSync(dir, { recursive: true, force: true });
    if (r.kode === 1223 || /cancel|dibatalkan|batal/i.test(r.stdout)) {
      return { ok: false, dibatalkan: true, pesan: 'Persetujuan Administrator dibatalkan. Firewall belum diubah.' };
    }
    if (r.kode !== 0) return { ok: false, pesan: `netsh gagal (kode ${r.kode}). ${r.stdout || r.stderr}`.trim() };
    return { ok: true, status: await this.status() };
  }
}

module.exports = { FirewallHost, NAMA_ATURAN };

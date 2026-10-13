'use strict';
/**
 * KOPKU Desktop — Asisten AI (MCP) · KANAL IPC `asistenAi:*` (layar Pengaturan › Asisten AI).
 *
 * Dipisah dari main.js agar kanal yang SAMA dapat diuji (test/mcp/*, uji asap Chromium).
 * `h(kanal, fn)` = pembungkus main.js yang hanya menerima pengirim = jendela utama.
 * Setiap perubahan diperiksa ulang: pengguna aktif + izin Pengaturan › Ubah (McpHost._cekPengubah).
 */
const fs = require('node:fs');
const path = require('node:path');
const claudeConfig = require('./claudeConfig');
const { buatMcpb } = require('./mcpb');

/**
 * @param {object} o
 * @param {(ch:string, fn:Function) => void} o.h
 * @param {import('./host').McpHost} o.host
 * @param {string} o.dataDir
 * @param {string} o.execPath exe KOPKU Desktop (process.execPath)
 * @param {string|null} o.appPath folder aplikasi bila dijalankan dari source (`electron .`), selain itu null
 * @param {string} o.versi
 * @param {string|null} o.ikon build/icon.png untuk paket .mcpb
 * @param {{ openPath:Function, showItemInFolder:Function, openExternal:Function }} o.shell
 * @param {{ writeText:Function }} o.clipboard
 * @param {object} [o.lingkungan] lokasi Claude Desktop tiruan (uji)
 */
function daftarkanIpcAsistenAi(o) {
  const { h, host, dataDir, lingkungan } = o;
  const entri = () => claudeConfig.entriKopku({ execPath: o.execPath, dataDir, appPath: o.appPath || null });
  const statusLengkap = () =>
    Object.assign(host.status(), {
      claude: claudeConfig.statusClaude({ entri: entri(), lingkungan }),
      riwayat: host.riwayat(15),
      potonganManual: claudeConfig.potonganManual(entri()),
    });

  h('asistenAi:status', () => statusLengkap());
  h('asistenAi:atur', async (input) => {
    const i = input && typeof input === 'object' ? input : {};
    const st = await host.atur({
      aktif: i.aktif === undefined ? undefined : i.aktif === true,
      perAnggota: i.perAnggota === undefined ? undefined : i.perAnggota === true,
      penggunaId: i.penggunaId,
    });
    // Dinyalakan dengan cara bawaan (konfigurasi Claude Desktop) → pastikan entri "kopku" terpasang.
    if (i.aktif === true && st.cara === 'config') {
      try {
        claudeConfig.pasangKeClaude({ entri: entri(), lingkungan });
      } catch {
        /* ditampilkan di layar sebagai "belum terpasang" */
      }
    }
    return statusLengkap();
  });
  h('asistenAi:pasangClaude', async (penggunaId) => {
    await host._cekPengubah(penggunaId);
    const hasil = claudeConfig.pasangKeClaude({ entri: entri(), lingkungan });
    await host.atur({ cara: 'config', penggunaId });
    return Object.assign(statusLengkap(), { hasilPasang: hasil });
  });
  h('asistenAi:lepasClaude', async (penggunaId) => {
    await host._cekPengubah(penggunaId);
    const hasil = claudeConfig.lepasDariClaude({ lingkungan });
    return Object.assign(statusLengkap(), { hasilLepas: hasil });
  });
  h('asistenAi:buatEkstensi', async (penggunaId) => {
    await host._cekPengubah(penggunaId);
    const tujuan = path.join(dataDir, 'mcp', 'KOPKU-Asisten-AI.mcpb');
    buatMcpb({ tujuan, versi: o.versi, dataDir, ikon: o.ikon });
    // Satu cara saja: entri konfigurasi dilepas agar "kopku" tidak muncul dua kali di Claude Desktop.
    claudeConfig.lepasDariClaude({ lingkungan });
    await host.atur({ cara: 'ekstensi', penggunaId });
    // Dibuka dengan aplikasi yang terdaftar untuk .mcpb (Claude Desktop) → dialog "Install".
    const galatBuka = await o.shell.openPath(tujuan);
    if (galatBuka) o.shell.showItemInFolder(tujuan);
    return { berkas: tujuan, dibuka: !galatBuka };
  });
  h('asistenAi:salin', async (teks) => {
    o.clipboard.writeText(String(teks || '').slice(0, 20000));
    return true;
  });
  h('asistenAi:bukaFolder', async () => {
    fs.mkdirSync(path.join(dataDir, 'mcp'), { recursive: true });
    const m = await o.shell.openPath(path.join(dataDir, 'mcp'));
    if (m) throw new Error(m);
    return true;
  });
  h('asistenAi:unduhClaude', async () => {
    await o.shell.openExternal('https://claude.ai/download');
    return true;
  });

  // KOPKU dipindah/diperbarui ke folder lain → entri "kopku" lama diarahkan ke exe ini.
  try {
    const p = host.baca();
    if (p.aktif && p.cara === 'config') claudeConfig.perbaruiBilaBerubah({ entri: entri(), lingkungan });
  } catch {
    /* abaikan */
  }
}

module.exports = { daftarkanIpcAsistenAi };

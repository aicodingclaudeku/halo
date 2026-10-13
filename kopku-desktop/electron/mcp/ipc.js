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
const { siapkanServerLokal, cariNode } = require('./serverLokal');

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
 * @param {string} [o.platform] process.platform (uji)
 * @param {Function} [o.cariNode] pencari Node.js (uji)
 */
function daftarkanIpcAsistenAi(o) {
  const { h, host, dataDir, lingkungan } = o;
  const platform = o.platform || process.platform;
  // 1.0.26 — Node.js terpasang dipakai lebih dulu: stdin `KOPKU Desktop.exe` (aplikasi GUI Electron)
  // tertutup seketika di Windows sehingga Claude melapor "Server disconnected" (lihat serverLokal.js).
  let node;
  const deteksiNode = (ulang) => {
    if (ulang || node === undefined) {
      try {
        node = (o.cariNode || cariNode)();
      } catch {
        node = null;
      }
    }
    return node;
  };
  const entri = () => {
    const n = deteksiNode();
    if (n) return claudeConfig.entriNode({ nodePath: n.path, serverPath: siapkanServerLokal(dataDir), dataDir });
    return claudeConfig.entriKopku({ execPath: o.execPath, dataDir, appPath: o.appPath || null });
  };
  /** Tanpa Node.js di Windows, exe tidak dapat dipakai Claude → ekstensi .mcpb (Node.js bawaan Claude). */
  const perluEkstensi = () => !deteksiNode() && platform === 'win32';
  const runtime = () => {
    const n = deteksiNode();
    return n ? { jenis: 'node', path: n.path, versi: n.versi } : { jenis: 'exe', path: o.execPath, perluEkstensi: platform === 'win32' };
  };
  const statusLengkap = () =>
    Object.assign(host.status(), {
      claude: claudeConfig.statusClaude({ entri: entri(), lingkungan }),
      runtime: runtime(),
      riwayat: host.riwayat(15),
      potonganManual: claudeConfig.potonganManual(entri()),
    });
  const buatEkstensi = async (penggunaId) => {
    const tujuan = path.join(dataDir, 'mcp', 'KOPKU-Asisten-AI.mcpb');
    buatMcpb({ tujuan, versi: o.versi, dataDir, ikon: o.ikon });
    // Satu cara saja: entri konfigurasi dilepas agar "kopku" tidak muncul dua kali di Claude Desktop.
    claudeConfig.lepasDariClaude({ lingkungan });
    await host.atur({ cara: 'ekstensi', penggunaId });
    // Dibuka dengan aplikasi yang terdaftar untuk .mcpb (Claude Desktop) → dialog "Install".
    const galatBuka = await o.shell.openPath(tujuan);
    if (galatBuka) o.shell.showItemInFolder(tujuan);
    return { berkas: tujuan, dibuka: !galatBuka };
  };

  h('asistenAi:status', () => statusLengkap());
  h('asistenAi:atur', async (input) => {
    const i = input && typeof input === 'object' ? input : {};
    const st = await host.atur({
      aktif: i.aktif === undefined ? undefined : i.aktif === true,
      perAnggota: i.perAnggota === undefined ? undefined : i.perAnggota === true,
      bolehTulis: i.bolehTulis === undefined ? undefined : i.bolehTulis === true,
      penggunaId: i.penggunaId,
    });
    // Dinyalakan dengan cara bawaan (konfigurasi Claude Desktop) → pastikan entri "kopku" terpasang.
    let ekstensi = null;
    if (i.aktif === true && st.cara === 'config') {
      try {
        deteksiNode(true);
        if (perluEkstensi()) ekstensi = await buatEkstensi(i.penggunaId);
        else claudeConfig.pasangKeClaude({ entri: entri(), lingkungan });
      } catch {
        /* ditampilkan di layar sebagai "belum terpasang" */
      }
    }
    return Object.assign(statusLengkap(), ekstensi ? { ekstensi } : {});
  });
  h('asistenAi:pasangClaude', async (penggunaId) => {
    await host._cekPengubah(penggunaId);
    deteksiNode(true);
    if (perluEkstensi()) return Object.assign({}, statusLengkap(), { ekstensi: await buatEkstensi(penggunaId) }, { cara: 'ekstensi' });
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
    return buatEkstensi(penggunaId);
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

  // KOPKU dipindah/diperbarui, atau entri lama 1.0.25 (`KOPKU Desktop.exe --kopku-mcp-stdio`, gagal di
  // Windows) → entri "kopku" milik KOPKU diperbarui ke cara yang berfungsi (Node.js) saat KOPKU dibuka.
  try {
    const p = host.baca();
    if (p.aktif && p.cara === 'config') claudeConfig.perbaruiBilaBerubah({ entri: entri(), lingkungan });
  } catch {
    /* abaikan */
  }
}

module.exports = { daftarkanIpcAsistenAi };

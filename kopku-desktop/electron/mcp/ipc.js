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
const { AksesChatGPT } = require('./chatgpt');

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
 * @param {{ showSaveDialog: Function }} [o.dialog] dialog Electron (pilih folder simpan .mcpb)
 * @param {() => any} [o.jendela] jendela induk dialog
 * @param {string} [o.folderDokumen] folder Dokumen pengguna (lokasi bawaan .mcpb)
 * @param {import('./chatgpt').AksesChatGPT} [o.chatgpt] akses ChatGPT (1.0.29; bawaan dibuat di sini)
 */
function daftarkanIpcAsistenAi(o) {
  const { h, host, dataDir, lingkungan } = o;
  // 1.0.29 — ChatGPT: server MCP HTTP terpisah di 127.0.0.1 (terowongan internet disediakan pengguna sendiri).
  const chatgpt = o.chatgpt || new AksesChatGPT({ host, dataDir });
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
  // 1.0.28 — lokasi simpan .mcpb dipilih pengguna (dialog "Simpan sebagai"); folder terakhir diingat.
  const berkasLokasi = path.join(dataDir, 'mcp', 'lokasi-ekstensi.json');
  const folderEkstensi = () => {
    try {
      const f = JSON.parse(fs.readFileSync(berkasLokasi, 'utf8')).folder;
      if (typeof f === 'string' && fs.existsSync(f)) return f;
    } catch {
      /* belum pernah dipilih */
    }
    return o.folderDokumen ? path.join(o.folderDokumen, 'KOPKU Desktop') : path.join(dataDir, 'mcp');
  };
  // 1.0.30 — ekstensi .mcpb yang dibuat versi lama (≤ 1.0.29) tidak menyala di Node.js bawaan Claude Desktop
  // ("Request timed out") → layar meminta pengguna membuat ulang ekstensi.
  const versiEkstensi = () => {
    try {
      return JSON.parse(fs.readFileSync(berkasLokasi, 'utf8')).versi || null;
    } catch {
      return null;
    }
  };
  const statusLengkap = () =>
    Object.assign(host.status(), {
      claude: claudeConfig.statusClaude({ entri: entri(), lingkungan }),
      folderEkstensi: folderEkstensi(),
      ekstensiUsang: host.baca().cara === 'ekstensi' && versiEkstensi() !== o.versi,
      chatgpt: chatgpt.status(),
      runtime: runtime(),
      riwayat: host.riwayat(15),
      potonganManual: claudeConfig.potonganManual(entri()),
    });
  const buatEkstensi = async (penggunaId) => {
    let tujuan = path.join(folderEkstensi(), 'KOPKU-Asisten-AI.mcpb');
    if (o.dialog) {
      fs.mkdirSync(path.dirname(tujuan), { recursive: true });
      const r = await o.dialog.showSaveDialog(o.jendela ? o.jendela() : undefined, {
        title: 'Simpan ekstensi Claude (KOPKU Asisten AI)',
        defaultPath: tujuan,
        buttonLabel: 'Simpan',
        filters: [{ name: 'Ekstensi Claude (.mcpb)', extensions: ['mcpb'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (!r || r.canceled || !r.filePath) return { dibatalkan: true };
      tujuan = /\.mcpb$/i.test(r.filePath) ? r.filePath : r.filePath + '.mcpb';
    }
    fs.mkdirSync(path.dirname(tujuan), { recursive: true });
    try {
      fs.writeFileSync(berkasLokasi, JSON.stringify({ folder: path.dirname(tujuan), versi: o.versi }));
    } catch {
      /* abaikan */
    }
    buatMcpb({ tujuan, versi: o.versi, dataDir, ikon: o.ikon });
    // Satu cara saja: entri konfigurasi dilepas agar "kopku" tidak muncul dua kali di Claude Desktop.
    claudeConfig.lepasDariClaude({ lingkungan });
    await host.atur({ cara: 'ekstensi', penggunaId });
    // Dibuka dengan aplikasi yang terdaftar untuk .mcpb (Claude Desktop) → dialog "Install".
    const galatBuka = await o.shell.openPath(tujuan);
    if (galatBuka) o.shell.showItemInFolder(tujuan);
    return { berkas: tujuan, folder: path.dirname(tujuan), dibuka: !galatBuka };
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
  h('asistenAi:aturChatGPT', async (input) => {
    const i = input && typeof input === 'object' ? input : {};
    await chatgpt.atur({
      aktif: i.aktif === undefined ? undefined : i.aktif === true,
      bolehTulis: i.bolehTulis === undefined ? undefined : i.bolehTulis === true,
      gantiKunci: i.gantiKunci === true,
      alamatPublik: i.alamatPublik === undefined ? undefined : i.alamatPublik === null ? null : String(i.alamatPublik).slice(0, 300),
      penggunaId: i.penggunaId,
    });
    return statusLengkap();
  });
  h('asistenAi:bukaFolderEkstensi', async () => {
    const f = folderEkstensi();
    fs.mkdirSync(f, { recursive: true });
    const m = await o.shell.openPath(f);
    if (m) throw new Error(m);
    return true;
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

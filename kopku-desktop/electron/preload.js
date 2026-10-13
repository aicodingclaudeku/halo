'use strict';
/**
 * Jembatan aman renderer <-> proses utama (contextIsolation + sandbox).
 * Kontrak tipenya ada di src/desktop/bridge.ts.
 */
const { contextBridge, ipcRenderer } = require('electron');

function unwrap(r) {
  if (r && r.ok) return r.value;
  const e = new Error((r && r.error && r.error.message) || 'Galat desktop');
  if (r && r.error && r.error.code) e.code = r.error.code;
  throw e;
}
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a).then(unwrap);
const fsSync = (op, ...a) => unwrap(ipcRenderer.sendSync('fs:sync', op, ...a));

// Salinan logika desktop/electron/uri.js (preload sandbox tidak dapat require berkas lokal).
function toPath(u) {
  let s = String(u);
  if (s.startsWith('kopkufs://local')) s = s.slice('kopkufs://local'.length);
  else if (s.startsWith('file://')) s = s.slice('file://'.length);
  else return s;
  s = decodeURI(s);
  if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
  return s;
}
function pathToUri(p) {
  let s = String(p).replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  return 'kopkufs://local' + encodeURI(s);
}

const info = ipcRenderer.sendSync('sys:info');
let lanHandler = null;
ipcRenderer.on('lan:request', async (_e, req) => {
  let out = { status: 503, body: JSON.stringify({ kode: 'BELUM_SIAP', pesan: 'KOPKU Desktop sedang memuat. Coba lagi beberapa detik lagi.' }) };
  try {
    if (lanHandler) out = await lanHandler({ path: req.path, body: req.body });
  } catch (e) {
    out = { status: 500, body: JSON.stringify({ kode: 'GALAT', pesan: String((e && e.message) || e) }) };
  }
  ipcRenderer.send('lan:response', { id: req.id, status: out.status, body: out.body });
});
const pingHandlers = new Set();
ipcRenderer.on('lan:ping', (_e, info) => pingHandlers.forEach((cb) => { try { cb(info); } catch { /* abaikan */ } }));
const menuHandlers = new Set();
ipcRenderer.on('menu', (_e, cmd) => menuHandlers.forEach((cb) => { try { cb(cmd); } catch { /* abaikan */ } }));

// KOPKU LAN Multi-User (opsional): main process meneruskan operasi API yang
// SUDAH divalidasi & diotorisasi server ke adapter service di renderer.
// Hanya SATU handler (yang pertama) yang diterima. Tidak ada kanal lain.
let srvHandler = null;
ipcRenderer.on('srv:call', async (_e, req) => {
  let hasil = { ok: false, error: { kode: 'LAYANAN_BELUM_SIAP', pesan: 'Adapter server belum terpasang.' } };
  try {
    if (srvHandler) hasil = await srvHandler(String(req.op), req.args || {}, req.ctx || {});
  } catch {
    hasil = { ok: false, error: { kode: 'INTERNAL', pesan: 'Terjadi kesalahan internal.' } };
  }
  ipcRenderer.send('srv:reply', { id: req.id, hasil: { ok: !!hasil.ok, value: hasil.value, error: hasil.error } });
});

contextBridge.exposeInMainWorld('kopkuDesktop', {
  info,
  sqlite: {
    open: (name, dir) => call('sqlite:open', name, dir),
    exec: (id, sql) => call('sqlite:exec', id, sql),
    run: (id, sql, p) => call('sqlite:run', id, sql, p),
    get: (id, sql, p) => call('sqlite:get', id, sql, p),
    all: (id, sql, p) => call('sqlite:all', id, sql, p),
    close: (id) => call('sqlite:close', id),
  },
  fs: {
    uriToPath: toPath,
    pathToUri,
    info: (u) => call('fs:op', 'info', u),
    readString: (u, enc) => call('fs:op', 'readString', u, enc),
    writeString: (u, d, enc, append) => call('fs:op', 'writeString', u, d, enc, append),
    remove: (u) => call('fs:op', 'remove', u),
    move: (a, b) => call('fs:op', 'move', a, b),
    copy: (a, b) => call('fs:op', 'copy', a, b),
    mkdir: (u) => call('fs:op', 'mkdir', u),
    readDir: (u) => call('fs:op', 'readDir', u),
    statSync: (u) => fsSync('stat', u),
    createSync: (u, o) => fsSync('create', u, o),
    removeSync: (u) => fsSync('remove', u),
    openSync: (u) => fsSync('open', u),
    readSync: (h, off, len) => fsSync('read', h, off, len),
    writeSync: (h, off, data) => fsSync('write', h, off, data),
    closeSync: (h) => fsSync('close', h),
  },
  secure: {
    get: (k) => call('secure:get', k),
    set: (k, v) => call('secure:set', k, v),
    remove: (k) => call('secure:remove', k),
  },
  print: {
    toPdf: (html, opts) => call('print:toPdf', html, opts),
    printHtml: (html) => call('print:html', html),
    printFile: (u) => call('print:file', u),
  },
  dialog: {
    openFiles: (opts) => call('dialog:open', opts),
    saveFile: (src, name) => call('dialog:save', src, name),
  },
  shell: {
    openPath: (u) => call('shell:openPath', u),
    showItem: (u) => call('shell:showItem', u),
    openExternal: (url) => call('shell:openExternal', url),
  },
  http: { fetch: (url, init) => call('http:fetch', url, init) },
  auth: {
    canBiometric: () => call('auth:can'),
    promptBiometric: (reason) => call('auth:prompt', reason),
  },
  lan: {
    start: () => call('lan:start'),
    info: () => call('lan:info'),
    onRequest: (h) => { lanHandler = h; },
    onPing: (cb) => { pingHandlers.add(cb); return () => pingHandlers.delete(cb); },
  },
  firewall: {
    status: () => call('firewall:status'),
    perbaiki: () => call('firewall:perbaiki'),
  },
  qr: { toDataUrl: (t) => call('qr:dataUrl', t) },
  server: {
    onCall: (h) => {
      if (srvHandler) throw new Error('Handler server sudah terdaftar.');
      if (typeof h !== 'function') throw new Error('Handler tidak sah.');
      srvHandler = h;
    },
  },
  // Pengaturan › LAN & WhatsApp (hanya jendela utama; main process menolak pengirim lain).
  // Token WhatsApp hanya bisa DIKIRIM (write-only); tidak ada kanal yang mengembalikannya.
  lanWa: {
    status: () => call('lanmu:status'),
    aturLan: (o) => call('lanmu:atur', o),
    aturWa: (aktif) => call('lanmu:aturWa', aktif === true),
    firewall: () => call('lanmu:firewall'),
    perintahFirewall: () => call('lanmu:perintahFirewall'),
    bukaAdmin: () => call('lanmu:bukaAdmin'),
    qr: (url) => call('lanmu:qr', url),
    waInfo: () => call('lanmu:waInfo'),
    waSimpan: (o) => call('lanmu:waSimpan', o),
    waKredensial: (o) => call('lanmu:waKredensial', o),
    waToken: (t) => call('lanmu:waToken', t),
    waHapusToken: () => call('lanmu:waHapusToken'),
    waTestKoneksi: () => call('lanmu:waTestKoneksi'),
    waTestPesan: () => call('lanmu:waTestPesan'),
    waLog: (o) => call('lanmu:waLog', o),
    waJalankan: () => call('lanmu:waJalankan'),
    akses: (pengguna) => call('lanmu:akses', pengguna),
    aksesSimpan: (o) => call('lanmu:aksesSimpan', o),
    sesi: () => call('lanmu:sesi'),
    sesiCabut: (o) => call('lanmu:sesiCabut', o),
    audit: (o) => call('lanmu:audit', o),
  },
  // Pengaturan › Asisten AI (1.0.25) — konektor MCP lokal untuk Claude Desktop (baca saja).
  // Hanya jendela utama; setiap perubahan diperiksa ulang di main process (izin Pengaturan › Ubah).
  asistenAi: {
    status: () => call('asistenAi:status'),
    atur: (o) => call('asistenAi:atur', o),
    pasangClaude: (penggunaId) => call('asistenAi:pasangClaude', penggunaId),
    lepasClaude: (penggunaId) => call('asistenAi:lepasClaude', penggunaId),
    buatEkstensi: (penggunaId) => call('asistenAi:buatEkstensi', penggunaId),
    salin: (teks) => call('asistenAi:salin', teks),
    bukaFolder: () => call('asistenAi:bukaFolder'),
    unduhClaude: () => call('asistenAi:unduhClaude'),
    bukaFolderEkstensi: () => call('asistenAi:bukaFolderEkstensi'),
  },

  app: {
    openDataFolder: () => call('app:openData'),
    onMenu: (cb) => { menuHandlers.add(cb); return () => { menuHandlers.delete(cb); }; },
    setTitle: (t) => ipcRenderer.send('app:title', t),
  },
});

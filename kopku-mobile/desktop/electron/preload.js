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
  app: {
    openDataFolder: () => call('app:openData'),
    onMenu: (cb) => { menuHandlers.add(cb); return () => { menuHandlers.delete(cb); }; },
    setTitle: (t) => ipcRenderer.send('app:title', t),
  },
});

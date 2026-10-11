'use strict';
/**
 * KOPKU Desktop — proses utama Electron (Windows & macOS).
 *
 * Tanggung jawab proses ini SENGAJA tipis: jendela, menu, dan "host"
 * kemampuan sistem (SQLite, berkas, secure storage, cetak/PDF, dialog,
 * HTTP lisensi, server LAN sinkron, QR). SELURUH logika bisnis berjalan
 * di renderer dengan kode yang sama persis dengan aplikasi Android.
 */
const { app, BrowserWindow, protocol, net, ipcMain, Menu, shell, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { SqliteHost } = require('./hosts/sqliteHost');
const { FsHost } = require('./hosts/fsHost');
const { SecureHost } = require('./hosts/secureHost');
const { PrintHost } = require('./hosts/printHost');
const { LanServer } = require('./hosts/lanServer');
const { FirewallHost } = require('./hosts/firewallHost');
const uri = require('./uri');

app.setName('KOPKU Desktop');
// Uji otomatis (desktop/test/smoke.js) memakai folder data terpisah.
// 1.0.13 — variabel lingkungan UJI hanya berlaku saat dijalankan dari source (`electron .`).
const keamanan = require('./keamanan');
const MODE_UJI = !app.isPackaged;
keamanan.tolakSaklarDebug({ app, dialog });
if (MODE_UJI && process.env.KOPKU_USERDATA) app.setPath('userData', process.env.KOPKU_USERDATA);
if (process.platform === 'win32') app.setAppUserModelId('id.koperasi.finance.desktop');

// KOPKU_RENDERER_DIR: hanya untuk uji tampilan dari source (tidak berlaku di aplikasi terpasang).
const RENDERER_DIR = (!app.isPackaged && process.env.KOPKU_RENDERER_DIR) || path.join(__dirname, '..', 'renderer');
const IS_DEV = !app.isPackaged && process.env.KOPKU_DEV === '1';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'kopkufs', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) {
  // Dua jendela KOPKU yang menulis ke database yang sama = risiko korupsi.
  app.quit();
}

let win = null;
let hosts = null;

function dirs() {
  const data = app.getPath('userData');
  const documents = path.join(data, 'documents');
  const cache = path.join(data, 'cache');
  fs.mkdirSync(path.join(documents, 'SQLite'), { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  return { data, documents, cache };
}

function ok(fn) {
  return async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: { message: e && e.message ? e.message : String(e), code: e && e.code } };
    }
  };
}

function registerIpc(d) {
  const sqlite = new SqliteHost(path.join(d.documents, 'SQLite'));
  const fsh = new FsHost(d);
  const secure = new SecureHost(path.join(d.data, 'secure-store.json'));
  const printer = new PrintHost(d.cache);
  const lan = new LanServer(() => win);
  hosts = { sqlite, fsh, secure, printer, lan };

  ipcMain.on('sys:info', (e) => {
    e.returnValue = {
      platform: process.platform,
      platformLabel: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
      hostname: require('node:os').hostname(),
      version: app.getVersion(),
      documentUri: uri.dirToUri(d.documents),
      cacheUri: uri.dirToUri(d.cache),
      dataDir: d.data,
    };
  });

  ipcMain.handle('sqlite:open', ok((name, dir) => sqlite.open(name, dir ? uri.toPath(dir) : undefined)));
  ipcMain.handle('sqlite:exec', ok((id, sql) => sqlite.exec(id, sql)));
  ipcMain.handle('sqlite:run', ok((id, sql, p) => sqlite.run(id, sql, p)));
  ipcMain.handle('sqlite:get', ok((id, sql, p) => sqlite.get(id, sql, p)));
  ipcMain.handle('sqlite:all', ok((id, sql, p) => sqlite.all(id, sql, p)));
  ipcMain.handle('sqlite:close', ok((id) => sqlite.close(id)));

  ipcMain.handle('fs:op', ok((op, ...a) => fsh.async(op, ...a)));
  ipcMain.on('fs:sync', (e, op, ...a) => {
    try {
      e.returnValue = { ok: true, value: fsh.sync(op, ...a) };
    } catch (err) {
      e.returnValue = { ok: false, error: { message: err.message } };
    }
  });

  ipcMain.handle('secure:get', ok((k) => secure.get(k)));
  ipcMain.handle('secure:set', ok((k, v) => secure.set(k, v)));
  ipcMain.handle('secure:remove', ok((k) => secure.remove(k)));

  ipcMain.handle('print:toPdf', ok((html, opts) => printer.toPdf(html, opts)));
  ipcMain.handle('print:html', ok((html) => printer.printHtml(html, win)));
  ipcMain.handle('print:file', ok((u) => printer.printFile(uri.toPath(u), win)));

  ipcMain.handle(
    'dialog:open',
    ok(async (opts) => {
      const r = await dialog.showOpenDialog(win, {
        title: opts && opts.title,
        filters: opts && opts.filters,
        properties: ['openFile', ...(opts && opts.multiple ? ['multiSelections'] : [])],
      });
      if (r.canceled || r.filePaths.length === 0) return null;
      return r.filePaths.map((p) => fsh.copyIntoCache(p));
    })
  );
  ipcMain.handle(
    'dialog:save',
    ok(async (src, defaultName) => {
      const r = await dialog.showSaveDialog(win, {
        defaultPath: path.join(app.getPath('documents'), defaultName || path.basename(uri.toPath(src))),
      });
      if (r.canceled || !r.filePath) return null;
      fs.copyFileSync(uri.toPath(src), r.filePath);
      return r.filePath;
    })
  );

  ipcMain.handle('shell:openPath', ok(async (u) => { const m = await shell.openPath(uri.toPath(u)); if (m) throw new Error(m); }));
  ipcMain.handle('shell:showItem', ok((u) => shell.showItemInFolder(uri.toPath(u))));
  ipcMain.handle(
    'shell:openExternal',
    ok((url) => {
      if (!/^(https?:|mailto:|tel:|whatsapp:)/i.test(url)) throw new Error('Tautan tidak diizinkan.');
      return shell.openExternal(url);
    })
  );

  // Proksi HTTP untuk server lisensi: renderer berasal dari app:// sehingga
  // fetch langsung akan terkena CORS. Hanya HTTPS yang diteruskan.
  ipcMain.handle(
    'http:fetch',
    ok(async (url, init) => {
      if (!/^https:\/\//i.test(url)) throw new Error('Hanya HTTPS yang diizinkan.');
      const res = await net.fetch(url, { method: init.method || 'GET', headers: init.headers || {}, body: init.body ?? undefined });
      const buf = Buffer.from(await res.arrayBuffer());
      const headers = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      return { status: res.status, statusText: res.statusText, headers, bodyB64: buf.toString('base64') };
    })
  );

  ipcMain.handle(
    'auth:can',
    ok(() => {
      const { systemPreferences } = require('electron');
      return process.platform === 'darwin' && typeof systemPreferences.canPromptTouchID === 'function' && systemPreferences.canPromptTouchID();
    })
  );
  ipcMain.handle(
    'auth:prompt',
    ok(async (reason) => {
      const { systemPreferences } = require('electron');
      try {
        await systemPreferences.promptTouchID(reason || 'Buka KOPKU');
        return true;
      } catch {
        return false;
      }
    })
  );

  const firewall = new FirewallHost(process.execPath);
  ipcMain.handle('firewall:status', ok(() => firewall.status()));
  ipcMain.handle('firewall:perbaiki', ok(() => firewall.perbaiki()));

  ipcMain.handle('lan:start', ok(() => lan.start()));
  ipcMain.handle('lan:info', ok(() => lan.info()));
  ipcMain.on('lan:response', (_e, msg) => lan.resolve(msg));

  ipcMain.handle('qr:dataUrl', ok((text) => require('qrcode').toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 420, color: { dark: '#12401A', light: '#FFFFFF' } })));

  ipcMain.handle('app:openData', ok(() => shell.openPath(d.data)));
  ipcMain.on('app:title', (_e, t) => win && win.setTitle(String(t || 'KOPKU Desktop')));
}

function registerProtocols(d) {
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    let file = path.normalize(path.join(RENDERER_DIR, rel));
    if (!file.startsWith(RENDERER_DIR)) return new Response('Forbidden', { status: 403 });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(RENDERER_DIR, 'index.html'); // SPA
    return net.fetch(pathToFileURL(file).toString());
  });
  // Berkas data aplikasi (logo koperasi, PDF ekspor) — hanya di bawah folder data.
  protocol.handle('kopkufs', (req) => {
    const file = uri.toPath(req.url);
    if (!path.resolve(file).startsWith(path.resolve(d.data))) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function buildMenu() {
  const kirim = (cmd) => () => win && win.webContents.send('menu', cmd);
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: 'KOPKU Desktop', submenu: [{ role: 'about', label: 'Tentang KOPKU' }, { type: 'separator' }, { role: 'hide', label: 'Sembunyikan' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: 'Keluar KOPKU' }] }] : []),
    {
      label: 'Berkas',
      submenu: [
        { label: 'Sinkron HP…', accelerator: 'CmdOrCtrl+Shift+S', click: kirim('sinkron') },
        { label: 'Backup & Restore…', accelerator: 'CmdOrCtrl+B', click: kirim('backup') },
        { type: 'separator' },
        { label: 'Buka Folder Data', click: () => hosts && shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Tutup Jendela' } : { role: 'quit', label: 'Keluar' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo', label: 'Urungkan' }, { role: 'redo', label: 'Ulangi' }, { type: 'separator' }, { role: 'cut', label: 'Potong' }, { role: 'copy', label: 'Salin' }, { role: 'paste', label: 'Tempel' }, { role: 'selectAll', label: 'Pilih Semua' }] },
    {
      label: 'Tampilan',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: kirim('tab:Dashboard') },
        { label: 'Data', accelerator: 'CmdOrCtrl+2', click: kirim('tab:Anggota') },
        { label: 'Transaksi', accelerator: 'CmdOrCtrl+3', click: kirim('tab:Transaksi') },
        { label: 'Laporan', accelerator: 'CmdOrCtrl+4', click: kirim('tab:Laporan') },
        { label: 'Pengaturan', accelerator: 'CmdOrCtrl+5', click: kirim('tab:Pengaturan') },
        { type: 'separator' },
        { label: 'Cari Menu…', accelerator: 'CmdOrCtrl+K', click: kirim('cari') },
        { label: 'Ciutkan / Lebarkan Sidebar', accelerator: 'CmdOrCtrl+\\', click: kirim('sidebar') },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Ukuran Normal' },
        { role: 'zoomIn', label: 'Perbesar' },
        { role: 'zoomOut', label: 'Perkecil' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Layar Penuh' },
        ...(IS_DEV ? [{ role: 'reload' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    { label: 'Bantuan', submenu: [{ label: 'Situs KOPKU', click: () => shell.openExternal('https://koperasikufinanace.my.id') }, { label: `Versi ${app.getVersion()}`, enabled: false }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    title: 'KOPKU Desktop',
    backgroundColor: '#F1F3F6',
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: IS_DEV || (MODE_UJI && process.env.KOPKU_DEVTOOLS === '1'),
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (MODE_UJI && process.env.KOPKU_SMOKE) console.log(`[renderer:${level}] ${message}`);
  });
  win.loadURL('app://kopku/');
  if (MODE_UJI && process.env.KOPKU_SMOKE) require(process.env.KOPKU_SMOKE)(win, app);
  win.on('closed', () => (win = null));
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

keamanan.pasangPenjagaWebContents({ app, shell, isPackaged: app.isPackaged });

app.whenReady().then(() => {
  const d = dirs();
  // Kebijakan izin: kamera/mikrofon/notifikasi tidak dibutuhkan desktop.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  registerProtocols(d);
  registerIpc(d);
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  try {
    hosts && hosts.lan.stop();
    hosts && hosts.sqlite.closeAll();
  } catch {
    /* abaikan */
  }
});

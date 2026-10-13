'use strict';
/**
 * Tiruan modul `electron` (main + renderer API yang dipakai main.js &
 * preload.js) agar berkas ASLI dapat dimuat di Node. Bukan Electron
 * sungguhan: perilaku jendela/Chromium tidak diuji di sini.
 */
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function buatMock(opsi = {}) {
  const userData = opsi.userData || fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-el-'));
  const log = { handle: new Map(), on: new Map(), windows: [], menu: null, exposed: {}, rendererOn: new Map(), rendererSent: [], executeJs: [], openExternal: [], protocols: new Map(), appOn: new Map() };
  class WebContents {
    constructor(win) {
      this.win = win;
      this.listeners = new Map();
      this.sent = [];
      this.hooks = { send: null, executeJavaScript: null };
    }
    on(ev, fn) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, []);
      this.listeners.get(ev).push(fn);
    }
    emit(ev, ...a) {
      for (const f of this.listeners.get(ev) || []) f(...a);
    }
    send(ch, ...a) {
      this.sent.push([ch, ...a]);
      if (this.hooks.send) this.hooks.send(ch, ...a);
    }
    async executeJavaScript(code) {
      log.executeJs.push(code.slice(0, 80));
      if (this.hooks.executeJavaScript) return this.hooks.executeJavaScript(code);
      return false;
    }
    setWindowOpenHandler() {}
    isDestroyed() {
      return false;
    }
  }
  class BrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.webContents = new WebContents(this);
      this.ev = new Map();
      this.url = null;
      log.windows.push(this);
    }
    once(ev, fn) {
      this.on(ev, fn);
    }
    on(ev, fn) {
      if (!this.ev.has(ev)) this.ev.set(ev, []);
      this.ev.get(ev).push(fn);
    }
    loadURL(u) {
      this.url = u;
    }
    loadFile(f) {
      this.url = 'file://' + f;
    }
    show() {}
    focus() {}
    setMenu() {}
    setTitle() {}
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    restore() {}
    static getAllWindows() {
      return log.windows;
    }
  }
  const electron = {
    app: {
      isPackaged: false,
      setName() {},
      setPath() {},
      setAppUserModelId() {},
      getPath: (n) => (n === 'userData' ? userData : path.join(userData, n)),
      getVersion: () => '1.0.10',
      requestSingleInstanceLock: () => true,
      quit() {},
      on: (ev, fn) => {
        if (!log.appOn.has(ev)) log.appOn.set(ev, []);
        log.appOn.get(ev).push(fn);
      },
      whenReady: () => Promise.resolve(),
    },
    protocol: { registerSchemesAsPrivileged() {}, handle: (s, f) => log.protocols.set(s, f) },
    net: { fetch: (...a) => fetch(...a) },
    ipcMain: {
      handle: (ch, fn) => {
        if (log.handle.has(ch)) throw new Error('handler ganda ' + ch);
        log.handle.set(ch, fn);
      },
      on: (ch, fn) => {
        if (!log.on.has(ch)) log.on.set(ch, []);
        log.on.get(ch).push(fn);
      },
    },
    Menu: { buildFromTemplate: (t) => t, setApplicationMenu: (m) => (log.menu = m) },
    shell: { openExternal: async (u) => void log.openExternal.push(u), openPath: async () => '', showItemInFolder() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
    session: { defaultSession: { setPermissionRequestHandler() {} } },
    BrowserWindow,
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    systemPreferences: {},
    // ---- renderer (preload)
    contextBridge: { exposeInMainWorld: (n, api) => (log.exposed[n] = api) },
    ipcRenderer: {
      invoke: async () => ({ ok: true, value: null }),
      sendSync: (ch) => (ch === 'sys:info' ? { platform: 'linux', documentUri: 'kopkufs://local/tmp/', cacheUri: 'kopkufs://local/tmp/' } : { ok: true, value: null }),
      send: (ch, ...a) => {
        log.rendererSent.push([ch, ...a]);
        if (opsi.onRendererSend) opsi.onRendererSend(ch, ...a);
      },
      on: (ch, fn) => {
        if (!log.rendererOn.has(ch)) log.rendererOn.set(ch, []);
        log.rendererOn.get(ch).push(fn);
      },
    },
  };
  return { electron, log, userData, BrowserWindow };
}

function pasangMock(electron) {
  const asli = Module._resolveFilename;
  Module._resolveFilename = function (req, ...a) {
    if (req === 'electron') return 'electron-mock';
    return asli.call(this, req, ...a);
  };
  require.cache['electron-mock'] = { id: 'electron-mock', filename: 'electron-mock', loaded: true, exports: electron };
  return () => {
    Module._resolveFilename = asli;
    delete require.cache['electron-mock'];
  };
}

module.exports = { buatMock, pasangMock };

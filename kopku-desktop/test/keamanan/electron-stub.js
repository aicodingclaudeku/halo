'use strict';
// Dipakai test anti-bypass: `node -r test/keamanan/electron-stub.js electron/entry.js --kopku-mcp-stdio --data <folder>`
// (1.0.14–1.0.24: langsung keluar; 1.0.25: server MCP stdio Asisten AI tanpa jendela/IPC/database).
// Meniru Electron TERPASANG (app.isPackaged = true) tanpa Chromium.
const { buatMock, pasangMock } = require('../lan/electronMock');
const m = buatMock();
m.electron.app.isPackaged = true;
m.electron.app.disableHardwareAcceleration = () => undefined;
m.electron.app.exit = (c) => {
  process.stderr.write(`[stub] exit ${c} jendela=${m.log.windows.length} handler=${m.log.handle.size}\n`);
  process.exit(c);
};
pasangMock(m.electron);

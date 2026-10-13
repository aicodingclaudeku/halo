'use strict';
/**
 * KOPKU Desktop 1.0.13 — PENGAMANAN ANTI-BYPASS PROSES UTAMA.
 *
 * Pintu yang ditutup pada aplikasi TERPASANG (app.isPackaged):
 *   1. Saklar debug/inspeksi pada baris perintah (Chromium DevTools Protocol,
 *      inspector Node, js-flags) → aplikasi menolak berjalan.
 *   2. DevTools di jendela mana pun → langsung ditutup bila sempat terbuka.
 *   3. <webview>, jendela baru, dan navigasi keluar dari app:// di SEMUA
 *      webContents (bukan hanya jendela utama).
 * Variabel lingkungan uji (KOPKU_SMOKE, KOPKU_USERDATA, KOPKU_DEVTOOLS) diabaikan
 * aplikasi terpasang — lihat main.js.
 *
 * Lapisan biner (tidak dapat dilakukan dari JavaScript) ada di package.json
 * `build.electronFuses`: RunAsNode, NODE_OPTIONS, --inspect dimatikan; integritas
 * app.asar divalidasi; aplikasi hanya dimuat dari app.asar.
 */

/** Saklar yang memberi akses debug ke proses KOPKU. */
const SAKLAR_DEBUG = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'remote-allow-origins',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-publish-uid',
  'debug',
  'debug-brk',
  'js-flags',
  'auto-open-devtools-for-tabs',
];

/**
 * Daftar saklar debug yang ada di argv / command line Chromium.
 * @param {string[]} argv
 * @param {{ hasSwitch?: (n: string) => boolean } | undefined} commandLine
 */
function saklarDebug(argv, commandLine) {
  const ada = new Set();
  for (const a of argv || []) {
    const m = /^--?([a-z0-9-]+)(?:=.*)?$/i.exec(String(a));
    if (m && SAKLAR_DEBUG.includes(m[1].toLowerCase())) ada.add(m[1].toLowerCase());
  }
  if (commandLine && typeof commandLine.hasSwitch === 'function') {
    for (const s of SAKLAR_DEBUG) {
      try {
        if (commandLine.hasSwitch(s)) ada.add(s);
      } catch {
        /* abaikan */
      }
    }
  }
  return [...ada];
}

/**
 * Tolak berjalan bila aplikasi terpasang dibuka dengan saklar debug.
 * @returns {boolean} true bila aplikasi dihentikan
 */
function tolakSaklarDebug({ app, dialog, argv = process.argv }) {
  if (!app.isPackaged) return false;
  const ada = saklarDebug(argv, app.commandLine);
  if (!ada.length) return false;
  try {
    if (dialog && typeof dialog.showErrorBox === 'function') {
      dialog.showErrorBox('KOPKU Desktop', `KOPKU Desktop tidak dapat dibuka dengan opsi debug (${ada.map((x) => '--' + x).join(', ')}). Buka KOPKU dari ikon aplikasinya.`);
    }
  } catch {
    /* abaikan */
  }
  if (typeof app.exit === 'function') app.exit(1);
  else process.exit(1);
  return true;
}

/**
 * Penjaga untuk SETIAP webContents yang dibuat (jendela utama dan apa pun yang
 * mungkin muncul kemudian).
 */
function pasangPenjagaWebContents({ app, shell, isPackaged }) {
  app.on('web-contents-created', (_e, wc) => {
    if (typeof wc.on !== 'function') return;
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
    if (typeof wc.setWindowOpenHandler === 'function') {
      wc.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
      });
    }
    wc.on('will-navigate', (ev, url) => {
      if (!String(url).startsWith('app://')) ev.preventDefault();
    });
    if (isPackaged) {
      wc.on('devtools-opened', () => {
        try {
          wc.closeDevTools();
        } catch {
          /* abaikan */
        }
      });
    }
  });
}

module.exports = { SAKLAR_DEBUG, saklarDebug, tolakSaklarDebug, pasangPenjagaWebContents };

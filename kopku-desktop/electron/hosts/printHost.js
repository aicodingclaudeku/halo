'use strict';
/**
 * Padanan expo-print: HTML -> PDF (printToPDF Chromium) dan dialog cetak
 * sistem. Setiap PDF disertai "sidecar" `<pdf>.print.html` berisi HTML
 * sumbernya, sehingga "Cetak" di desktop mencetak dokumen asli dengan
 * kualitas penuh (bukan mencetak ulang PDF).
 */
const { BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToUri } = require('../uri');
const { pathToFileURL } = require('node:url');

class PrintHost {
  constructor(cacheDir) {
    this.dir = path.join(cacheDir, 'Print');
    fs.mkdirSync(this.dir, { recursive: true });
  }
  async _window(html) {
    const file = path.join(this.dir, `src-${crypto.randomUUID()}.html`);
    fs.writeFileSync(file, html, 'utf8');
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
    await w.loadURL(pathToFileURL(file).toString());
    return { w, file };
  }
  async toPdf(html, opts = {}) {
    const { w, file } = await this._window(html);
    try {
      const width = Number(opts.width) || 595;
      const height = Number(opts.height) || 842;
      const pdf = await w.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: width / 72, height: height / 72 },
        margins: { marginType: 'default' },
        preferCSSPageSize: true,
      });
      const out = path.join(this.dir, `${crypto.randomUUID()}.pdf`);
      fs.writeFileSync(out, pdf);
      fs.writeFileSync(out + '.print.html', html, 'utf8');
      const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length || 1;
      return { uri: pathToUri(out), numberOfPages: pages };
    } finally {
      w.destroy();
      fs.rmSync(file, { force: true });
    }
  }
  async printHtml(html) {
    const { w, file } = await this._window(html);
    try {
      return await new Promise((resolve) => w.webContents.print({ silent: false, printBackground: true }, (success) => resolve(success)));
    } finally {
      w.destroy();
      fs.rmSync(file, { force: true });
    }
  }
  async printFile(p) {
    if (fs.existsSync(p + '.print.html')) return this.printHtml(fs.readFileSync(p + '.print.html', 'utf8'));
    if (/\.html?$/i.test(p)) return this.printHtml(fs.readFileSync(p, 'utf8'));
    const { shell } = require('electron');
    const m = await shell.openPath(p); // PDF tanpa sumber: buka di penampil PDF sistem untuk dicetak
    if (m) throw new Error(m);
    return true;
  }
}
module.exports = { PrintHost };

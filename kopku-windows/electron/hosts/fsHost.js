'use strict';
/** Host berkas: padanan expo-file-system (API legacy async + API File sinkron). */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { toPath, pathToUri } = require('../uri');

class FsHost {
  constructor(d) {
    this.d = d;
    this.handles = new Map();
    this.next = 1;
  }

  copyIntoCache(src) {
    const dir = path.join(this.d.cache, 'DocumentPicker', crypto.randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, path.basename(src).replace(/[^\w.\- ()]/g, '_'));
    fs.copyFileSync(src, dest);
    return pathToUri(dest);
  }

  stat(u) {
    try {
      const s = fs.statSync(toPath(u));
      return { exists: true, isDirectory: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, modificationTime: s.mtimeMs / 1000 };
    } catch {
      return { exists: false, isDirectory: false, size: 0, modificationTime: 0 };
    }
  }

  async async(op, ...a) {
    switch (op) {
      case 'info':
        return this.stat(a[0]);
      case 'readString':
        return fs.readFileSync(toPath(a[0])).toString(a[1] === 'base64' ? 'base64' : 'utf8');
      case 'writeString': {
        const p = toPath(a[0]);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const buf = Buffer.from(a[1], a[2] === 'base64' ? 'base64' : 'utf8');
        if (a[3]) fs.appendFileSync(p, buf);
        else fs.writeFileSync(p, buf);
        return;
      }
      case 'remove':
        fs.rmSync(toPath(a[0]), { recursive: true, force: true });
        return;
      case 'move': {
        const from = toPath(a[0]);
        const to = toPath(a[1]);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        try {
          fs.renameSync(from, to);
        } catch (e) {
          if (e.code !== 'EXDEV') throw e;
          fs.cpSync(from, to, { recursive: true });
          fs.rmSync(from, { recursive: true, force: true });
        }
        // Sidecar HTML cetak ikut dipindah (lihat printHost).
        if (fs.existsSync(from + '.print.html')) fs.renameSync(from + '.print.html', to + '.print.html');
        return;
      }
      case 'copy': {
        const from = toPath(a[0]);
        const to = toPath(a[1]);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.cpSync(from, to, { recursive: true });
        if (fs.existsSync(from + '.print.html')) fs.copyFileSync(from + '.print.html', to + '.print.html');
        return;
      }
      case 'mkdir':
        fs.mkdirSync(toPath(a[0]), { recursive: true });
        return;
      case 'readDir':
        return fs.readdirSync(toPath(a[0])).filter((n) => !n.endsWith('.print.html'));
      default:
        throw new Error(`Operasi berkas tidak dikenal: ${op}`);
    }
  }

  sync(op, ...a) {
    switch (op) {
      case 'stat':
        return this.stat(a[0]);
      case 'create': {
        const p = toPath(a[0]);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (!a[1] && fs.existsSync(p)) throw new Error('Berkas sudah ada.');
        fs.writeFileSync(p, Buffer.alloc(0));
        return;
      }
      case 'remove':
        fs.rmSync(toPath(a[0]), { force: true });
        return;
      case 'open': {
        const p = toPath(a[0]);
        const fd = fs.openSync(p, fs.existsSync(p) ? 'r+' : 'w+');
        const h = this.next++;
        this.handles.set(h, fd);
        return h;
      }
      case 'read': {
        const fd = this.handles.get(a[0]);
        const b = Buffer.alloc(a[2]);
        const n = fs.readSync(fd, b, 0, a[2], a[1]);
        return new Uint8Array(b.buffer, b.byteOffset, n);
      }
      case 'write': {
        const fd = this.handles.get(a[0]);
        const data = Buffer.from(a[2]);
        return fs.writeSync(fd, data, 0, data.length, a[1]);
      }
      case 'close': {
        const fd = this.handles.get(a[0]);
        if (fd !== undefined) fs.closeSync(fd);
        this.handles.delete(a[0]);
        return;
      }
      default:
        throw new Error(`Operasi berkas tidak dikenal: ${op}`);
    }
  }
}
module.exports = { FsHost };

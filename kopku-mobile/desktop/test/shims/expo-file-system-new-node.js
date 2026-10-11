'use strict';
// Shim Node untuk API `File` (expo-file-system SDK 54) — dipakai uji e2e.
const fs = require('node:fs');
function toPath(u) { const g = globalThis.kopkuDesktop; if (g && /^kopkufs:/.test(u)) return g.fs.uriToPath(u); return decodeURI(String(u).replace(/^file:\/\//, '')); }
class FileHandle {
  constructor(p) { this.fd = fs.openSync(p, fs.existsSync(p) ? 'r+' : 'w+'); this.offset = 0; }
  get size() { return fs.fstatSync(this.fd).size; }
  readBytes(n) { const b = Buffer.alloc(n); const r = fs.readSync(this.fd, b, 0, n, this.offset); this.offset += r; return new Uint8Array(b.buffer, b.byteOffset, r); }
  writeBytes(bytes) { const w = fs.writeSync(this.fd, bytes, 0, bytes.length, this.offset); this.offset += w; }
  close() { fs.closeSync(this.fd); }
}
class File {
  constructor(...parts) { this.uri = parts.join(''); }
  get _p() { return toPath(this.uri); }
  get exists() { try { return fs.statSync(this._p).isFile(); } catch { return false; } }
  get size() { try { return fs.statSync(this._p).size; } catch { return null; } }
  create() { fs.writeFileSync(this._p, Buffer.alloc(0)); }
  delete() { fs.rmSync(this._p, { force: true }); }
  open() { return new FileHandle(this._p); }
}
module.exports = { File };

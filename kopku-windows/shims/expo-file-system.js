/** Shim desktop `expo-file-system` (API `File` sinkron SDK 54 — dipakai backup terenkripsi & sinkron). */
import { b } from './_bridge';
export * from './expo-file-system-legacy';

class FileHandle {
  constructor(uri) { this._h = b().fs.openSync(uri); this.offset = 0; this._uri = uri; }
  get size() { return b().fs.statSync(this._uri).size; }
  readBytes(length) { const out = b().fs.readSync(this._h, this.offset, length); this.offset += out.length; return out; }
  writeBytes(bytes) { const n = b().fs.writeSync(this._h, this.offset, bytes); this.offset += n; }
  close() { b().fs.closeSync(this._h); }
}

export class File {
  constructor(...uris) {
    this.uri = uris.map((u) => (typeof u === 'string' ? u : u.uri)).join('/').replace(/([^:])\/\/+/g, '$1/');
  }
  get exists() { const s = b().fs.statSync(this.uri); return s.exists && !s.isDirectory; }
  get size() { const s = b().fs.statSync(this.uri); return s.exists ? s.size : null; }
  get name() { return decodeURI(this.uri.split('/').pop() || ''); }
  create(options) { b().fs.createSync(this.uri, !!(options && options.overwrite)); }
  delete() { b().fs.removeSync(this.uri); }
  open() { return new FileHandle(this.uri); }
}

export class Directory {
  constructor(...uris) { this.uri = uris.map((u) => (typeof u === 'string' ? u : u.uri)).join('/'); }
  get exists() { const s = b().fs.statSync(this.uri); return s.exists && s.isDirectory; }
}

export const Paths = {
  get document() { return new Directory(b().info.documentUri); },
  get cache() { return new Directory(b().info.cacheUri); },
};

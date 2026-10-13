'use strict';
/**
 * Padanan expo-secure-store di desktop. Nilai dienkripsi dengan
 * `safeStorage` Electron: DPAPI (Windows) atau Keychain (macOS). Berkas
 * disimpan atomik (tulis sementara lalu rename).
 */
const fs = require('node:fs');
const { safeStorage } = require('electron');

class SecureHost {
  constructor(file) {
    this.file = file;
    this.map = null;
  }
  _load() {
    if (this.map) return this.map;
    try {
      this.map = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.map = {};
    }
    return this.map;
  }
  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.map));
    fs.renameSync(tmp, this.file);
  }
  get(k) {
    const v = this._load()[k];
    if (v == null) return null;
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('raw:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
    return null;
  }
  set(k, value) {
    const m = this._load();
    m[k] = safeStorage.isEncryptionAvailable()
      ? 'enc:' + safeStorage.encryptString(String(value)).toString('base64')
      : 'raw:' + Buffer.from(String(value), 'utf8').toString('base64');
    this._save();
  }
  remove(k) {
    const m = this._load();
    delete m[k];
    this._save();
  }
}
module.exports = { SecureHost };

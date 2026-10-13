#!/usr/bin/env node
'use strict';
/**
 * KOPKU Desktop 1.0.13 — pengaman biner untuk build TANPA npm/electron-builder.
 *
 * Setara yang dilakukan electron-builder 26 pada `npm run dist:win`:
 *   1. pak  : folder resources/app → resources/app.asar, setiap berkas diberi
 *             `integrity` (SHA256 + blok 4 MiB) seperti @electron/asar.
 *   2. fuse : membalik byte "fuse wire" di exe Electron sesuai build.electronFuses
 *             (package.json).
 *   3. json : mencetak daftar integritas untuk resource exe INTEGRITY/ELECTRONASAR
 *             ([{file:"resources\\app.asar", alg:"SHA256", value:<sha256 header>}])
 *             — dipasang oleh scripts/pe_ikon_versi.py (argumen ke-5).
 *
 * Format diambil dari sumber Electron v44.5.1 (shell/common/asar/archive.cc,
 * archive_win.cc) dan electron-builder (asar/integrity.ts, electron/win/electronWin.ts).
 *
 * Pemakaian:
 *   node scripts/rakit-asar-fuse.js pak  <folder-app> <keluaran.asar>   → cetak JSON integritas
 *   node scripts/rakit-asar-fuse.js fuse <exe> [package.json]
 *   node scripts/rakit-asar-fuse.js baca <berkas.asar>                   → cetak header (uji)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PENANDA, NAMA } = require('./verifikasi-fuse');

const BLOK = 4 * 1024 * 1024;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Integritas per berkas, sama dengan @electron/asar getFileIntegrity (blok terakhir selalu di-hash). */
function integritasBerkas(buf) {
  const blocks = [];
  let i = 0;
  for (; i + BLOK <= buf.length; i += BLOK) blocks.push(sha(buf.subarray(i, i + BLOK)));
  blocks.push(sha(buf.subarray(i)));
  return { algorithm: 'SHA256', hash: sha(buf), blockSize: BLOK, blocks };
}

/** Pickle Chromium: [u32 panjang payload][payload] dengan string = [u32 len][bytes][pad 4]. */
function pickleString(s) {
  const str = Buffer.from(s, 'utf8');
  const pad = (4 - (str.length % 4)) % 4;
  const payload = Buffer.alloc(4 + str.length + pad);
  payload.writeUInt32LE(str.length, 0);
  str.copy(payload, 4);
  const out = Buffer.alloc(4 + payload.length);
  out.writeUInt32LE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}
function pickleUInt32(n) {
  const out = Buffer.alloc(8);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(n, 4);
  return out;
}

/** Bungkus folder menjadi asar. Mengembalikan { headerString, headerHash, jumlah }. */
function pak(srcDir, outFile) {
  const isi = [];
  let offset = 0;
  function jalan(dir) {
    const node = { files: {} };
    const nama = fs.readdirSync(dir).sort();
    for (const n of nama) {
      const p = path.join(dir, n);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`symlink tidak didukung: ${p}`);
      if (st.isDirectory()) {
        node.files[n] = jalan(p);
      } else if (st.isFile()) {
        const buf = fs.readFileSync(p);
        const ent = { size: buf.length, offset: String(offset), integrity: integritasBerkas(buf) };
        if (process.platform !== 'win32' && st.mode & 0o100) ent.executable = true;
        node.files[n] = ent;
        isi.push(buf);
        offset += buf.length;
      }
    }
    return node;
  }
  const header = jalan(srcDir);
  const headerString = JSON.stringify(header);
  const headerBuf = pickleString(headerString);
  const sizeBuf = pickleUInt32(headerBuf.length);
  const fd = fs.openSync(outFile, 'w');
  try {
    fs.writeSync(fd, sizeBuf);
    fs.writeSync(fd, headerBuf);
    for (const b of isi) fs.writeSync(fd, b);
  } finally {
    fs.closeSync(fd);
  }
  return { headerString, headerHash: sha(Buffer.from(headerString, 'utf8')), jumlah: isi.length };
}

/** Baca header asar (sama dengan Archive::Init Electron). */
function bacaHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const a = Buffer.alloc(8);
    fs.readSync(fd, a, 0, 8, 0);
    const size = a.readUInt32LE(4);
    const b = Buffer.alloc(size);
    fs.readSync(fd, b, 0, size, 8);
    const len = b.readUInt32LE(4);
    const headerString = b.subarray(8, 8 + len).toString('utf8');
    return { headerString, header: JSON.parse(headerString), headerSize: 8 + size };
  } finally {
    fs.closeSync(fd);
  }
}

const KUNCI_FUSE = {
  runAsNode: 'RunAsNode',
  enableCookieEncryption: 'EnableCookieEncryption',
  enableNodeOptionsEnvironmentVariable: 'EnableNodeOptionsEnvironmentVariable',
  enableNodeCliInspectArguments: 'EnableNodeCliInspectArguments',
  enableEmbeddedAsarIntegrityValidation: 'EnableEmbeddedAsarIntegrityValidation',
  onlyLoadAppFromAsar: 'OnlyLoadAppFromAsar',
  loadBrowserProcessSpecificV8Snapshot: 'LoadBrowserProcessSpecificV8Snapshot',
  grantFileProtocolExtraPrivileges: 'GrantFileProtocolExtraPrivileges',
};

/** Balik fuse di exe sesuai objek `electronFuses` (kunci gaya electron-builder). */
function pasangFuse(exe, fuses) {
  const buf = fs.readFileSync(exe);
  const tanda = Buffer.from(PENANDA, 'ascii');
  const i = buf.indexOf(tanda);
  if (i < 0) throw new Error('fuse wire tidak ditemukan di ' + exe);
  if (buf.indexOf(tanda, i + 1) >= 0) throw new Error('fuse wire ganda — berhenti demi keamanan');
  const awal = i + tanda.length;
  if (buf[awal] !== 1) throw new Error('versi fuse wire tidak dikenal: ' + buf[awal]);
  const panjang = buf[awal + 1];
  const diubah = [];
  for (const [k, v] of Object.entries(fuses)) {
    const nama = KUNCI_FUSE[k];
    if (!nama) throw new Error('fuse tidak dikenal: ' + k);
    const idx = NAMA.indexOf(nama);
    if (idx < 0 || idx >= panjang) throw new Error('fuse tidak ada di exe ini: ' + nama);
    const pos = awal + 2 + idx;
    const lama = String.fromCharCode(buf[pos]);
    if (lama === 'r') throw new Error('fuse sudah dihapus Electron: ' + nama);
    const baru = v ? '1' : '0';
    if (lama !== baru) {
      buf[pos] = baru.charCodeAt(0);
      diubah.push(`${nama}: ${lama === '1' ? 'ON' : 'OFF'} → ${v ? 'ON' : 'OFF'}`);
    }
  }
  fs.writeFileSync(exe, buf);
  return diubah;
}

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'pak') {
    const r = pak(a, b);
    const daftar = [{ file: 'resources\\app.asar', alg: 'SHA256', value: r.headerHash }];
    process.stderr.write(`rakit-asar: ${r.jumlah} berkas → ${b}; header sha256 ${r.headerHash}\n`);
    process.stdout.write(JSON.stringify(daftar));
  } else if (cmd === 'fuse') {
    const pkg = JSON.parse(fs.readFileSync(b || path.join(__dirname, '..', 'package.json'), 'utf8'));
    const f = { ...pkg.build.electronFuses };
    delete f.resetAdHocDarwinSignature;
    const d = pasangFuse(a, f);
    console.log('rakit-fuse: ' + (d.length ? d.join('; ') : 'tidak ada perubahan'));
  } else if (cmd === 'baca') {
    const h = bacaHeader(a);
    console.log(JSON.stringify({ headerSize: h.headerSize, headerSha256: sha(Buffer.from(h.headerString, 'utf8')) }));
  } else {
    console.error('pemakaian: rakit-asar-fuse.js pak <folder> <out.asar> | fuse <exe> [package.json] | baca <asar>');
    process.exit(2);
  }
}

module.exports = { pak, bacaHeader, pasangFuse, integritasBerkas, KUNCI_FUSE };

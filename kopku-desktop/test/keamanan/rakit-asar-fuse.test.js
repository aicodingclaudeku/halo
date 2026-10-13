'use strict';
/**
 * 1.0.13 — pengaman biner build tanpa npm (scripts/rakit-asar-fuse.js).
 * Uji format asar (pickle + header + integritas per berkas) dan pembalikan fuse.
 * Verifikasi dengan pembaca asar Electron sungguhan dilakukan saat build (lihat docs §F).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pak, bacaHeader, pasangFuse } = require('../../scripts/rakit-asar-fuse');
const { PENANDA, periksa } = require('../../scripts/verifikasi-fuse');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('pak: header + isi + integritas dapat dibaca ulang persis', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-'));
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"main":"a/b/m.js"}');
  fs.writeFileSync(path.join(dir, 'a', 'b', 'm.js'), 'console.log("halo")');
  fs.writeFileSync(path.join(dir, 'a', 'kosong.txt'), '');
  const besar = crypto.randomBytes(4 * 1024 * 1024 + 10);
  fs.writeFileSync(path.join(dir, 'a', 'besar.bin'), besar);
  const out = path.join(dir, '..', path.basename(dir) + '.asar');
  const r = pak(dir, out);
  const h = bacaHeader(out);
  assert.strictEqual(h.headerString, r.headerString);
  assert.strictEqual(sha(Buffer.from(h.headerString)), r.headerHash);
  const buf = fs.readFileSync(out);
  const ambil = (e) => buf.subarray(h.headerSize + Number(e.offset), h.headerSize + Number(e.offset) + e.size);
  const m = h.header.files.a.files.b.files['m.js'];
  assert.strictEqual(ambil(m).toString(), 'console.log("halo")');
  assert.strictEqual(m.integrity.hash, sha(Buffer.from('console.log("halo")')));
  const b = h.header.files.a.files['besar.bin'];
  assert.ok(ambil(b).equals(besar));
  assert.strictEqual(b.integrity.blockSize, 4 * 1024 * 1024);
  assert.strictEqual(b.integrity.blocks.length, 2);
  assert.strictEqual(b.integrity.blocks[0], sha(besar.subarray(0, 4 * 1024 * 1024)));
  const k = h.header.files.a.files['kosong.txt'];
  assert.strictEqual(k.size, 0);
  assert.deepStrictEqual(k.integrity.blocks, [sha(Buffer.alloc(0))]);
  // ukuran pickle: [4][n] lalu [payload][len][str][pad]
  assert.strictEqual(buf.readUInt32LE(0), 4);
  assert.strictEqual(buf.readUInt32LE(4) % 4, 0);
});

test('fuse: dibalik sesuai package.json lalu lolos verifikasi-fuse', () => {
  const tmp = path.join(os.tmpdir(), `fuse-${process.pid}.bin`);
  fs.writeFileSync(tmp, Buffer.concat([crypto.randomBytes(64), Buffer.from(PENANDA + '\x01\x09' + '101100011'), crypto.randomBytes(64)]));
  const pkg = require('../../package.json');
  const diubah = pasangFuse(tmp, pkg.build.electronFuses);
  assert.ok(diubah.length >= 5);
  const r = periksa(fs.readFileSync(tmp));
  assert.deepStrictEqual(r.salah, []);
  assert.strictEqual(r.nilai.RunAsNode, '0');
  assert.strictEqual(r.nilai.OnlyLoadAppFromAsar, '1');
  assert.strictEqual(r.nilai.EnableEmbeddedAsarIntegrityValidation, '1');
  assert.strictEqual(r.nilai.GrantFileProtocolExtraPrivileges, '1', 'fuse lain tidak disentuh');
  fs.unlinkSync(tmp);
});

test('fuse: penanda ganda / tidak ada → berhenti', () => {
  const tmp = path.join(os.tmpdir(), `fuse2-${process.pid}.bin`);
  const w = Buffer.from(PENANDA + '\x01\x09' + '101100011');
  fs.writeFileSync(tmp, Buffer.concat([w, w]));
  assert.throws(() => pasangFuse(tmp, { runAsNode: false }), /ganda/);
  fs.writeFileSync(tmp, Buffer.from('tanpa penanda'));
  assert.throws(() => pasangFuse(tmp, { runAsNode: false }), /tidak ditemukan/);
  fs.unlinkSync(tmp);
});

test('rakit-win-tanpa-npm.sh memasang asar, fuse, dan resource integritas', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'rakit-win-tanpa-npm.sh'), 'utf8');
  assert.match(s, /rakit-asar-fuse\.js pak/);
  assert.match(s, /rakit-asar-fuse\.js fuse/);
  assert.match(s, /pe_ikon_versi\.py[\s\S]*integritas-asar\.json/);
  assert.match(s, /verifikasi-fuse\.js/);
  assert.doesNotMatch(s, /cp -r electron renderer "\$OUT\/resources\/app/);
});

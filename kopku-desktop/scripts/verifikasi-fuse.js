#!/usr/bin/env node
'use strict';
/**
 * KOPKU Desktop 1.0.13 — periksa Electron Fuses pada exe hasil build.
 *
 * Dijalankan otomatis setelah `npm run dist:win` (postdist:win). Membaca "fuse wire"
 * di biner Electron (penanda + versi + panjang + satu byte per fuse: '0' mati, '1' nyala)
 * dan memastikan pengaman anti-bypass benar-benar terpasang:
 *   RunAsNode OFF · NODE_OPTIONS OFF · --inspect OFF · integritas asar ON · hanya dari asar ON.
 *
 * Pemakaian: node scripts/verifikasi-fuse.js "dist/win-unpacked/KOPKU Desktop.exe"
 * Keluar 1 bila fuse terbaca dan ada yang salah. Bila penanda tidak ditemukan
 * (format biner berubah) hanya memberi peringatan.
 */
const fs = require('node:fs');

const PENANDA = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
// Urutan FuseV1Options (@electron/fuses).
const NAMA = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
];
const HARUS = {
  RunAsNode: '0',
  EnableNodeOptionsEnvironmentVariable: '0',
  EnableNodeCliInspectArguments: '0',
  EnableEmbeddedAsarIntegrityValidation: '1',
  OnlyLoadAppFromAsar: '1',
};

function bacaFuse(buf) {
  const i = buf.indexOf(Buffer.from(PENANDA, 'ascii'));
  if (i < 0) return null;
  const awal = i + PENANDA.length;
  const versi = buf[awal];
  const panjang = buf[awal + 1];
  const nilai = {};
  for (let k = 0; k < panjang; k++) {
    const c = String.fromCharCode(buf[awal + 2 + k]);
    nilai[NAMA[k] || `Fuse${k}`] = c;
  }
  return { versi, nilai };
}

function periksa(buf) {
  const f = bacaFuse(buf);
  if (!f) return { terbaca: false, salah: [] };
  const salah = Object.entries(HARUS)
    .filter(([n, v]) => f.nilai[n] !== undefined && f.nilai[n] !== v)
    .map(([n, v]) => `${n}: ${f.nilai[n] === '1' ? 'ON' : 'OFF'} (harus ${v === '1' ? 'ON' : 'OFF'})`);
  return { terbaca: true, versi: f.versi, nilai: f.nilai, salah };
}

if (require.main === module) {
  const exe = process.argv[2];
  if (!exe || !fs.existsSync(exe)) {
    console.error(`verifikasi-fuse: berkas tidak ditemukan: ${exe}`);
    process.exit(1);
  }
  const r = periksa(fs.readFileSync(exe));
  if (!r.terbaca) {
    console.warn('verifikasi-fuse: PERINGATAN — fuse wire tidak ditemukan; pengaman fuse TIDAK dapat diverifikasi pada exe ini.');
    process.exit(0);
  }
  for (const [n, v] of Object.entries(r.nilai)) console.log(`  ${n.padEnd(40)} ${v === '1' ? 'ON' : v === '0' ? 'OFF' : v}`);
  if (r.salah.length) {
    console.error('verifikasi-fuse: GAGAL — ' + r.salah.join('; '));
    process.exit(1);
  }
  console.log('verifikasi-fuse: OK — pengaman anti-bypass terpasang.');
}

module.exports = { bacaFuse, periksa, PENANDA, NAMA, HARUS };

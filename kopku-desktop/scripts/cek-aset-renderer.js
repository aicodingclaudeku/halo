#!/usr/bin/env node
'use strict';
/**
 * 1.0.20 (audit T-15) — GERBANG ASET RENDERER SEBELUM BUILD.
 *
 * ZIP sumber sengaja tidak memuat `renderer/assets/node_modules/**` (37 font
 * ikon & gambar navigasi; lihat scripts/lengkapi-aset-renderer.js). Dulu tidak
 * ada pemeriksaan: build tetap jalan dan aplikasi terpasang tanpa ikon, dan
 * di uji asap muncul "PAGEERROR A network error occurred." (FontFace gagal
 * memuat font yang tidak ada). Skrip ini menghentikan `npm run dist:*` bila ada
 * aset yang hilang/berbeda dari test/lan/baseline-manifest.json, dengan petunjuk.
 *
 * Pemakaian: node scripts/cek-aset-renderer.js   (keluar 0 = lengkap)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'lan', 'baseline-manifest.json'), 'utf8')).berkas;
const hilang = [];
const beda = [];
for (const [p, h] of Object.entries(m)) {
  if (!p.startsWith('renderer/assets/node_modules/')) continue;
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f)) hilang.push(p);
  else if (crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') !== h) beda.push(p);
}
if (hilang.length || beda.length) {
  console.error(
    `cek-aset-renderer: ${hilang.length} aset hilang, ${beda.length} aset berbeda dari manifest.\n` +
      'Jalankan `npm run lengkapi:aset` (mencari & menyalin aset yang SHA-256-nya cocok), lalu ulangi build.\n' +
      [...hilang.map((p) => `  hilang : ${p}`), ...beda.map((p) => `  berbeda: ${p}`)].slice(0, 10).join('\n')
  );
  process.exit(1);
}
console.log('cek-aset-renderer: OK — seluruh aset renderer lengkap.');

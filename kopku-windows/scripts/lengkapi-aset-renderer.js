#!/usr/bin/env node
'use strict';
/**
 * Melengkapi `renderer/assets/node_modules/**` (font ikon & gambar navigasi) yang
 * tidak ikut ZIP sumber. Berkas dicari di komputer ini dan HANYA disalin bila
 * SHA-256-nya sama persis dengan test/lan/baseline-manifest.json — jadi berkas yang
 * salah versi tidak pernah dipakai.
 *
 * Sumber yang cocok biasanya: folder renderer KOPKU Desktop versi lama, atau
 * node_modules proyek Expo KOPKU (@expo/vector-icons, @react-navigation/elements, expo-router).
 *
 * Pemakaian: node scripts/lengkapi-aset-renderer.js [folder-cari ...]
 *   tanpa argumen: Documents, Downloads, Desktop, OneDrive*, dan folder lain di profil pengguna.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const LEWATI = new Set(['.git', 'AppData', '$Recycle.Bin', 'Windows', 'Program Files', 'Program Files (x86)', '.cache', '.npm', '.gradle', '.android', 'Library']);
const KEDALAMAN = 14;

function butuh() {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'lan', 'baseline-manifest.json'), 'utf8')).berkas;
  const out = new Map(); // sha256 -> [tujuan...]
  for (const [p, h] of Object.entries(m)) {
    if (!p.startsWith('renderer/assets/node_modules/')) continue;
    const tujuan = path.join(ROOT, p);
    if (fs.existsSync(tujuan) && sha(tujuan) === h) continue;
    if (!out.has(h)) out.set(h, []);
    out.get(h).push(tujuan);
  }
  return out;
}
function sha(f) {
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}
/** Nama dasar yang dicari, mis. "Ionicons" dari "Ionicons.b4eb…ttf", "clear-icon" dari "clear-icon.c94f…@2x.png". */
function namaDasar(perlu) {
  const s = new Set();
  for (const daftar of perlu.values()) for (const t of daftar) s.add(path.basename(t).split('.')[0].toLowerCase());
  return s;
}

function cari(akar, perlu) {
  const dasar = namaDasar(perlu);
  let diperiksa = 0;
  const tumpuk = akar.filter((a) => fs.existsSync(a)).map((a) => [a, 0]);
  while (tumpuk.length && perlu.size) {
    const [dir, d] = tumpuk.pop();
    let isi;
    try {
      isi = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of isi) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (d < KEDALAMAN && !LEWATI.has(e.name) && !e.isSymbolicLink()) tumpuk.push([p, d + 1]);
        continue;
      }
      if (!/\.(ttf|png)$/i.test(e.name)) continue;
      if (!dasar.has(e.name.split('.')[0].replace(/@\dx$/i, '').toLowerCase())) continue;
      if (p.startsWith(path.join(ROOT, 'renderer'))) continue;
      diperiksa++;
      let h;
      try {
        h = sha(p);
      } catch {
        continue;
      }
      const tujuan = perlu.get(h);
      if (!tujuan) continue;
      for (const t of tujuan) {
        fs.mkdirSync(path.dirname(t), { recursive: true });
        fs.copyFileSync(p, t);
        console.log(`  + ${path.relative(ROOT, t)}  ← ${p}`);
      }
      perlu.delete(h);
    }
  }
  return diperiksa;
}

function folderBawaan() {
  const home = os.homedir();
  const daftar = ['Documents', 'Downloads', 'Desktop'].map((x) => path.join(home, x));
  try {
    for (const n of fs.readdirSync(home)) {
      const p = path.join(home, n);
      if (!daftar.includes(p) && !n.startsWith('.') && !LEWATI.has(n) && fs.statSync(p).isDirectory()) daftar.push(p);
    }
  } catch {
    /* abaikan */
  }
  return daftar;
}

if (require.main === module) {
  const perlu = butuh();
  const total = [...perlu.values()].reduce((t, x) => t + x.length, 0);
  if (!total) {
    console.log('lengkapi-aset: semua aset renderer sudah lengkap.');
    process.exit(0);
  }
  console.log(`lengkapi-aset: mencari ${total} berkas aset (font ikon & gambar)…`);
  const akar = process.argv.slice(2).length ? process.argv.slice(2) : folderBawaan();
  const n = cari(akar, perlu);
  const sisa = [...perlu.values()].reduce((t, x) => t + x.length, 0);
  console.log(`lengkapi-aset: ${n} kandidat diperiksa; ${total - sisa} disalin; ${sisa} belum ditemukan.`);
  if (sisa) {
    for (const t of [...perlu.values()].flat()) console.log('  - ' + path.relative(ROOT, t));
    console.log('lengkapi-aset: PERINGATAN — sebagian ikon/gambar mungkin tidak tampil. Salin folder renderer/assets/node_modules dari KOPKU Desktop versi lama.');
  }
}

module.exports = { butuh, cari, sha };

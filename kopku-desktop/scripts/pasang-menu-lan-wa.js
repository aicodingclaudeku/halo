#!/usr/bin/env node
'use strict';
/**
 * Memasang menu "Pengaturan › LAN & WhatsApp" ke bundle renderer KOPKU
 * Desktop (hasil `expo export`; source TS tidak ada di paket desktop).
 *
 * Yang dipasang (semua idempoten, gagal keras bila jangkar tidak ditemukan):
 *   1. Modul layar baru (renderer-patch/LanWhatsAppScreen.js) → id MODUL_ID.
 *   2. Rute `LanWhatsApp` di stack Pengaturan.
 *   3. Izin rute: lihat = pengaturan.view (ubah dicek di layar: pengaturan.edit).
 *   4. Katalog menu desktop: sidebar Pengaturan + pencarian Ctrl+K.
 *   5. Kartu di layar "Semua Pengaturan".
 *   6. Perintah menu Electron `lanwa` (Berkas › LAN & WhatsApp…).
 *
 * Bila renderer dibangun ulang dari source aplikasi, tambahkan layar ini di
 * source (app/ & src/) — skrip ini hanya untuk bundle yang ada di paket ini.
 *
 * Pemakaian: node scripts/pasang-menu-lan-wa.js [folder-renderer]
 */
const fs = require('node:fs');
const path = require('node:path');

const MODUL_ID = 9001;
// Urutan HARUS sama dengan d[0..16] di LanWhatsAppScreen.js.
const DEPENDENSI = {
  react: 11,
  View: 81,
  Text: 232,
  TouchableOpacity: 477,
  ScrollView: 287,
  StyleSheet: 19,
  ActivityIndicator: 475,
  Switch: 493,
  TextInput: 392,
  Image: 331,
  Ionicons: 678,
  usePermission: 856,
  tema: 772,
  uiDesktop: 1289,
  notify: 765,
  // 1.0.21 — Akses LAN Pengguna dipindah dari Panel Web ke layar ini.
  useAppStore: 794,
  userAdmin: 1510,
};

// Pasangan [jangkar, sisipan] — sisipan diletakkan tepat SETELAH jangkar.
const SISIPAN = [
  ['IZIN_RUTE', "SinkronPerangkat:n('backup'),", "LanWhatsApp:n('pengaturan'),"],
  [
    'KATALOG',
    // 1.0.14 — teks Sinkron HP diperbarui (sinkron manual: hubungkan lalu kirim data).
    "e('Pengaturan','Pengaturan','SinkronPerangkat','Sinkron HP','sync-outline',{ket:'Hubungkan HP lewat QR, kirim data HP \\u21c4 PC',sidebar:!0,kata:'pairing qr wifi kirim data'}),",
    "e('Pengaturan','Pengaturan','LanWhatsApp','LAN & WhatsApp','wifi-outline',{ket:'Server LAN multi-user & WhatsApp Reminder (ON/OFF)',sidebar:!0,kata:'lan server multi user jaringan browser whatsapp wa reminder pengingat angsuran'}),",
  ],
  [
    'PengaturanMenu',
    "{route:'SinkronPerangkat',icon:'sync-outline',title:'Sinkron HP',sub:'Hubungkan lewat QR, lalu kirim data HP \\u21c4 komputer',resource:'backup'},",
    "{route:'LanWhatsApp',icon:'wifi-outline',title:'LAN & WhatsApp',sub:'Server LAN multi-user & WhatsApp Reminder \\u2014 nyalakan/matikan',resource:'pengaturan'},",
  ],
  ['onMenu', "'backup'===e&&h.navigate('Pengaturan',{screen:'BackupRestore',initial:!1}),", "'lanwa'===e&&h.navigate('Pengaturan',{screen:'LanWhatsApp',initial:!1}),"],
];

function ganti(teks, cari, ganti, nama) {
  const n = teks.split(cari).length - 1;
  if (n !== 1) throw new Error(`Jangkar "${nama}" ditemukan ${n}× (harus tepat 1×). Bundle berbeda dari yang diharapkan.`);
  return teks.replace(cari, () => ganti);
}

function modulAda(teks, id) {
  return new RegExp(`\\},${id},\\[[0-9,]*\\]\\);`).test(teks);
}

/** Pastikan modul dependensi memang yang dimaksud (cegah salah id bila bundle berubah). */
function cekDependensi(teks) {
  const cek = {
    TouchableOpacity: "displayName='TouchableOpacity'",
    Switch: "displayName='Switch'",
    TextInput: "displayName='TextInput'",
    Image: "displayName='Image'",
    ScrollView: "displayName='ScrollView'",
  };
  const badan = (id) => {
    const m = new RegExp(`\\},${id},\\[[0-9,]*\\]\\);`).exec(teks);
    if (!m) throw new Error(`Modul ${id} tidak ada di bundle.`);
    const awal = teks.lastIndexOf('__d(function', m.index);
    return teks.slice(awal, m.index + m[0].length);
  };
  for (const [nama, penanda] of Object.entries(cek)) {
    const b = badan(DEPENDENSI[nama]);
    if (!b.replace(/"/g, "'").includes(penanda)) throw new Error(`Modul ${DEPENDENSI[nama]} bukan ${nama}.`);
  }
  if (!/defineProperty\(e,"colors"/.test(badan(DEPENDENSI.tema))) throw new Error('Modul tema tidak cocok.');
  if (!/e\.usePermission=/.test(badan(DEPENDENSI.usePermission))) throw new Error('Modul usePermission tidak cocok.');
  if (!/e\.notify=/.test(badan(DEPENDENSI.notify))) throw new Error('Modul notify tidak cocok.');
  if (!/"menuIconSize"/.test(badan(DEPENDENSI.uiDesktop))) throw new Error('Modul ui desktop tidak cocok.');
  if (!/defineProperty\(e,"useAppStore"|\.useAppStore=/.test(badan(DEPENDENSI.useAppStore))) throw new Error('Modul useAppStore tidak cocok.');
  if (!/\.listUsers=/.test(badan(DEPENDENSI.userAdmin)) || !/\.createUser=/.test(badan(DEPENDENSI.userAdmin))) throw new Error('Modul User Management tidak cocok.');
  if (!/defineProperty\(_e,"Ionicons"|\.Ionicons=|"Ionicons"/.test(badan(DEPENDENSI.Ionicons))) throw new Error('Modul Ionicons tidak cocok.');
}

function pasang(teks, sumberLayar) {
  if (teks.includes('name:"LanWhatsApp"')) return { teks, sudah: true };
  if (modulAda(teks, MODUL_ID)) throw new Error(`Id modul ${MODUL_ID} sudah dipakai.`);
  cekDependensi(teks);

  // 1) modul layar — sebelum pemanggilan __r(...) penutup bundle
  // Semua pemanggilan __r(...) penutup (3 baris bawaan Metro, +1 modal desktop sejak 1.0.21).
  const ekor = /(\n__r\(\d+\);){3,}\s*$/.exec(teks);
  if (!ekor) throw new Error('Ekor bundle (__r) tidak dikenali.');
  const modul = `__d(function(g,r,i,a,m,_e,d){${sumberLayar}\n},${MODUL_ID},[${Object.values(DEPENDENSI).join(',')}]);`;
  teks = teks.slice(0, ekor.index) + '\n' + modul + teks.slice(ekor.index);

  // 2) rute di stack Pengaturan (nama variabel require diambil dari kepala modulnya)
  const jangkarStack = /\(0,(\w+)\.jsx\)\((\w+)\.Screen,\{name:"SinkronPerangkat",component:\w+\.default,options:\{title:[^}]*\}\}\)/;
  const ms = jangkarStack.exec(teks);
  if (!ms) throw new Error('Jangkar stack Pengaturan tidak ditemukan.');
  const awalModul = teks.lastIndexOf('__d(function(', ms.index);
  const param = /^__d\(function\(([^)]*)\)/.exec(teks.slice(awalModul, awalModul + 80))[1].split(',');
  const req = param[1];
  const layarBaru = `,(0,${ms[1]}.jsx)(${ms[2]}.Screen,{name:"LanWhatsApp",component:${req}(${MODUL_ID}).default,options:{title:'LAN & WhatsApp'}})`;
  teks = teks.slice(0, ms.index + ms[0].length) + layarBaru + teks.slice(ms.index + ms[0].length);

  // 3) izin rute · 4) katalog sidebar & Ctrl+K · 5) kartu "Semua Pengaturan" · 6) perintah menu Electron
  for (const [nama, jangkar, sisip] of SISIPAN) teks = ganti(teks, jangkar, jangkar + sisip, nama);
  return { teks, sudah: false };
}

/**
 * Kebalikan `pasang` (untuk uji regresi): mengembalikan teks bundle ASLI
 * sehingga dapat dibuktikan bahwa selain menu ini tidak ada yang berubah.
 */
function lepas(teks) {
  if (!teks.includes('name:"LanWhatsApp"')) return teks;
  const akhir = new RegExp(`\\},${MODUL_ID},\\[[0-9,]*\\]\\);`).exec(teks);
  if (!akhir) throw new Error('Modul layar tidak ditemukan.');
  const awal = teks.lastIndexOf('\n__d(function(g,r,i,a,m,_e,d){', akhir.index);
  teks = teks.slice(0, awal) + teks.slice(akhir.index + akhir[0].length);
  teks = teks.replace(new RegExp(`,\\(0,\\w+\\.jsx\\)\\(\\w+\\.Screen,\\{name:"LanWhatsApp",component:\\w+\\(${MODUL_ID}\\)\\.default,options:\\{title:'LAN & WhatsApp'\\}\\}\\)`), '');
  for (const [nama, jangkar, sisip] of SISIPAN) teks = ganti(teks, jangkar + sisip, jangkar, nama);
  return teks;
}

function main() {
  const root = path.join(__dirname, '..');
  const rendererDir = path.resolve(process.argv[2] || path.join(root, 'renderer'));
  const dir = path.join(rendererDir, '_expo', 'static', 'js', 'web');
  const berkas = fs.readdirSync(dir).filter((f) => /^entry-.*\.js$/.test(f));
  if (berkas.length !== 1) throw new Error(`Bundle tidak ditemukan/ganda di ${dir}`);
  const file = path.join(dir, berkas[0]);
  const sumber = fs.readFileSync(path.join(root, 'renderer-patch', 'LanWhatsAppScreen.js'), 'utf8');
  let asli = fs.readFileSync(file, 'utf8');
  // Versi layar lama sudah terpasang → lepas dulu lalu pasang versi terbaru (idempoten).
  const lama = asli.includes('name:"LanWhatsApp"');
  if (lama) asli = lepas(asli);
  const { teks } = pasang(asli, sumber);
  if (lama && teks === fs.readFileSync(file, 'utf8')) {
    console.log('Menu LAN & WhatsApp sudah versi terbaru:', berkas[0]);
    return;
  }
  fs.writeFileSync(file + '.tmp', teks);
  fs.renameSync(file + '.tmp', file);
  console.log('Menu LAN & WhatsApp terpasang:', berkas[0]);
}

if (require.main === module) main();
module.exports = { pasang, lepas, MODUL_ID, DEPENDENSI };

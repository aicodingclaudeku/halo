#!/usr/bin/env node
'use strict';
/**
 * Memasang menu "Pengaturan › Asisten AI" (1.0.25) ke bundle renderer KOPKU
 * Desktop (hasil `expo export`; source TS tidak ada di paket desktop).
 *
 * Yang dipasang (semua idempoten, gagal keras bila jangkar tidak ditemukan):
 *   1. Modul layar baru (renderer-patch/AsistenAiScreen.js) → id MODUL_ID.
 *   2. Rute `AsistenAi` di stack Pengaturan.
 *   3. Izin rute: lihat = pengaturan.view (ubah dicek di layar & main process: pengaturan.edit).
 *   4. Katalog menu desktop: sidebar Pengaturan + pencarian Ctrl+K.
 *   5. Kartu di layar "Semua Pengaturan".
 *   6. Perintah menu Electron `asistenai` (Berkas › Asisten AI…).
 *
 * Seluruh sisipan diletakkan TEPAT SETELAH sisipan menu "LAN & WhatsApp"
 * (scripts/pasang-menu-lan-wa.js), sehingga kedua menu dapat dipasang/dilepas
 * bergantian tanpa saling merusak. Jalankan setelah pasang-menu-lan-wa.js.
 *
 * Bila renderer dibangun ulang dari source aplikasi, tambahkan layar ini di
 * source (app/ & src/) — skrip ini hanya untuk bundle yang ada di paket ini.
 *
 * Pemakaian: node scripts/pasang-menu-asisten-ai.js [folder-renderer]
 */
const fs = require('node:fs');
const path = require('node:path');
const lanWa = require('./pasang-menu-lan-wa');

const MODUL_ID = 9201;
// Urutan HARUS sama dengan d[0..13] di AsistenAiScreen.js. Id modul sama dengan menu LAN & WhatsApp
// (diperiksa ulang oleh cekDependensi di pasang-menu-lan-wa.js sebelum menu itu dipasang).
const D = lanWa.DEPENDENSI;
const DEPENDENSI = {
  react: D.react,
  View: D.View,
  Text: D.Text,
  TouchableOpacity: D.TouchableOpacity,
  ScrollView: D.ScrollView,
  StyleSheet: D.StyleSheet,
  ActivityIndicator: D.ActivityIndicator,
  Switch: D.Switch,
  Ionicons: D.Ionicons,
  usePermission: D.usePermission,
  tema: D.tema,
  uiDesktop: D.uiDesktop,
  notify: D.notify,
  useAppStore: D.useAppStore,
  TextInput: D.TextInput, // 1.0.29 — alamat publik ChatGPT
};

// Pasangan [nama, jangkar, sisipan] — jangkar = sisipan menu LAN & WhatsApp; sisipan diletakkan tepat SETELAH-nya.
const SISIPAN = [
  ['IZIN_RUTE', "LanWhatsApp:n('pengaturan'),", "AsistenAi:n('pengaturan'),"],
  [
    'KATALOG',
    "e('Pengaturan','Pengaturan','LanWhatsApp','LAN & WhatsApp','wifi-outline',{ket:'Server LAN multi-user & WhatsApp Reminder (ON/OFF)',sidebar:!0,kata:'lan server multi user jaringan browser whatsapp wa reminder pengingat angsuran'}),",
    "e('Pengaturan','Pengaturan','AsistenAi','Asisten AI','sparkles-outline',{ket:'Claude & ChatGPT (MCP) \\u2014 tanya & kelola data koperasi',sidebar:!0,kata:'ai asisten claude anthropic chatgpt gpt openai mcp chatbot tanya kecerdasan buatan konektor'}),",
  ],
  [
    'PengaturanMenu',
    "{route:'LanWhatsApp',icon:'wifi-outline',title:'LAN & WhatsApp',sub:'Server LAN multi-user & WhatsApp Reminder \\u2014 nyalakan/matikan',resource:'pengaturan'},",
    "{route:'AsistenAi',icon:'sparkles-outline',title:'Asisten AI',sub:'Claude & ChatGPT (MCP) \\u2014 tanya & kelola data koperasi',resource:'pengaturan'},",
  ],
  ['onMenu', "'lanwa'===e&&h.navigate('Pengaturan',{screen:'LanWhatsApp',initial:!1}),", "'asistenai'===e&&h.navigate('Pengaturan',{screen:'AsistenAi',initial:!1}),"],
];

// Teks sisipan versi lama (1.0.25–1.0.28) — dikenali saat melepas agar bundle lama dapat ditingkatkan.
const SISIPAN_LAMA = {
  KATALOG: ["e('Pengaturan','Pengaturan','AsistenAi','Asisten AI','sparkles-outline',{ket:'Hubungkan ke Claude (MCP) \\u2014 tanya data koperasi, baca saja',sidebar:!0,kata:'ai asisten claude anthropic mcp chatbot tanya kecerdasan buatan konektor'}),"],
  PengaturanMenu: ["{route:'AsistenAi',icon:'sparkles-outline',title:'Asisten AI',sub:'Hubungkan ke Claude Desktop (MCP) \\u2014 tanya data koperasi, baca saja',resource:'pengaturan'},"],
};

const PENANDA = 'name:"AsistenAi"';

function ganti(teks, cari, baru, nama) {
  const n = teks.split(cari).length - 1;
  if (n !== 1) throw new Error(`Jangkar "${nama}" ditemukan ${n}× (harus tepat 1×). Bundle berbeda dari yang diharapkan.`);
  return teks.replace(cari, () => baru);
}

function modulAda(teks, id) {
  return new RegExp(`\\},${id},\\[[0-9,]*\\]\\);`).test(teks);
}

function pasang(teks, sumberLayar) {
  if (teks.includes(PENANDA)) return { teks, sudah: true };
  if (!teks.includes('name:"LanWhatsApp"')) throw new Error('Menu LAN & WhatsApp belum terpasang — jalankan scripts/pasang-menu-lan-wa.js lebih dulu.');
  if (modulAda(teks, MODUL_ID)) throw new Error(`Id modul ${MODUL_ID} sudah dipakai.`);

  // 1) modul layar — tepat SEBELUM modul layar LAN & WhatsApp, sehingga pemasangan ulang menu itu
  //    (lepas → pasang di depan __r penutup) tidak menggeser urutan dan tidak menulis ulang bundle.
  const akhirLan = new RegExp(`\\},${lanWa.MODUL_ID},\\[[0-9,]*\\]\\);`).exec(teks);
  if (!akhirLan) throw new Error('Modul layar LAN & WhatsApp tidak ditemukan.');
  const awalLan = teks.lastIndexOf('\n__d(function(g,r,i,a,m,_e,d){', akhirLan.index);
  if (awalLan < 0) throw new Error('Awal modul layar LAN & WhatsApp tidak dikenali.');
  const modul = `\n__d(function(g,r,i,a,m,_e,d){${sumberLayar}\n},${MODUL_ID},[${Object.values(DEPENDENSI).join(',')}]);`;
  teks = teks.slice(0, awalLan) + modul + teks.slice(awalLan);

  // 2) rute di stack Pengaturan, tepat setelah layar LAN & WhatsApp (nama variabel diambil dari sisipan itu)
  const jangkarStack = new RegExp(`\\(0,(\\w+)\\.jsx\\)\\((\\w+)\\.Screen,\\{name:"LanWhatsApp",component:(\\w+)\\(${lanWa.MODUL_ID}\\)\\.default,options:\\{title:'LAN & WhatsApp'\\}\\}\\)`);
  const ms = jangkarStack.exec(teks);
  if (!ms) throw new Error('Jangkar stack Pengaturan (LAN & WhatsApp) tidak ditemukan.');
  const layarBaru = `,(0,${ms[1]}.jsx)(${ms[2]}.Screen,{name:"AsistenAi",component:${ms[3]}(${MODUL_ID}).default,options:{title:'Asisten AI'}})`;
  teks = teks.slice(0, ms.index + ms[0].length) + layarBaru + teks.slice(ms.index + ms[0].length);

  // 3) izin rute · 4) katalog sidebar & Ctrl+K · 5) kartu "Semua Pengaturan" · 6) perintah menu Electron
  for (const [nama, jangkar, sisip] of SISIPAN) teks = ganti(teks, jangkar, jangkar + sisip, nama);
  return { teks, sudah: false };
}

/** Kebalikan `pasang` (untuk uji regresi & pemasangan ulang). */
function lepas(teks) {
  if (!teks.includes(PENANDA)) return teks;
  const akhir = new RegExp(`\\},${MODUL_ID},\\[[0-9,]*\\]\\);`).exec(teks);
  if (!akhir) throw new Error('Modul layar Asisten AI tidak ditemukan.');
  const awal = teks.lastIndexOf('\n__d(function(g,r,i,a,m,_e,d){', akhir.index);
  teks = teks.slice(0, awal) + teks.slice(akhir.index + akhir[0].length);
  teks = teks.replace(new RegExp(`,\\(0,\\w+\\.jsx\\)\\(\\w+\\.Screen,\\{name:"AsistenAi",component:\\w+\\(${MODUL_ID}\\)\\.default,options:\\{title:'Asisten AI'\\}\\}\\)`), '');
  for (const [nama, jangkar, sisip] of SISIPAN) {
    const lama = (SISIPAN_LAMA[nama] || []).find((x) => !teks.includes(jangkar + sisip) && teks.includes(jangkar + x));
    teks = ganti(teks, jangkar + (lama || sisip), jangkar, nama);
  }
  return teks;
}

function main() {
  const root = path.join(__dirname, '..');
  const rendererDir = path.resolve(process.argv[2] || path.join(root, 'renderer'));
  const dir = path.join(rendererDir, '_expo', 'static', 'js', 'web');
  const berkas = fs.readdirSync(dir).filter((f) => /^entry-.*\.js$/.test(f));
  if (berkas.length !== 1) throw new Error(`Bundle tidak ditemukan/ganda di ${dir}`);
  const file = path.join(dir, berkas[0]);
  const sumber = fs.readFileSync(path.join(root, 'renderer-patch', 'AsistenAiScreen.js'), 'utf8');
  const sekarang = fs.readFileSync(file, 'utf8');
  // Versi layar lama sudah terpasang → lepas dulu lalu pasang versi terbaru (idempoten).
  const { teks } = pasang(lepas(sekarang), sumber);
  if (teks === sekarang) {
    console.log('Menu Asisten AI sudah versi terbaru:', berkas[0]);
    return;
  }
  fs.writeFileSync(file + '.tmp', teks);
  fs.renameSync(file + '.tmp', file);
  console.log('Menu Asisten AI terpasang:', berkas[0]);
}

if (require.main === module) main();
module.exports = { pasang, lepas, MODUL_ID, DEPENDENSI };

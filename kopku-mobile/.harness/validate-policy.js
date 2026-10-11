#!/usr/bin/env node
'use strict';

/**
 * VALIDATOR KEBIJAKAN RC-S53
 * =========================================================================
 *
 * Menurunkan POLICY VALIDATION MATRIX langsung dari dua dokumen resmi:
 *
 *   POLICY_REGISTER_RC-S53.md   — keadaan & dampak tiap item
 *   POLICY_DECISION_RC-S53.md   — tempat keputusan ditulis
 *
 * KENAPA INI ADA. Selama ini status tiap policy dibaca manual lalu
 * ditulis ulang ke laporan. Itu menyisakan satu celah: laporan bisa
 * menyatakan sebuah policy "lengkap" padahal dokumennya masih kosong,
 * dan implementasi berikutnya akan mengunci kebijakan yang tidak pernah
 * diputuskan siapa pun. Validator ini membaca dokumennya sendiri,
 * sehingga status yang dilaporkan tidak dapat menyimpang dari isinya.
 *
 * Berkas ini ADALAH PERKAKAS, bukan kode produksi. Ia tidak menyentuh
 * database, tidak menyentuh `src/`, dan tidak memutuskan apa pun.
 *
 * Pakai:  node .harness/validate-policy.js
 * Keluar: 0 bila seluruh policy COMPLETE, 1 bila ada yang belum.
 */

const fs = require('fs');
const path = require('path');

const AKAR = path.join(__dirname, '..');
const REGISTER = fs.readFileSync(path.join(AKAR, 'POLICY_REGISTER_RC-S53.md'), 'utf8');
const FORMULIR = fs.readFileSync(path.join(AKAR, 'POLICY_DECISION_RC-S53.md'), 'utf8');

/**
 * Nilai yang DITOLAK validator (§10).
 *
 * Daftar ini sengaja ketat. Sebuah keputusan yang ditulis "TBD" atau
 * "AUTO" bukan keputusan — ia hanya menunda, dan bila lolos ke tahap
 * implementasi ia akan berubah menjadi tebakan seseorang.
 */
const DITOLAK = ['TBD', 'TODO', 'UNKNOWN', 'AUTO', 'N/A', 'NA', '-', '?', 'PENDING'];

function kosong(nilai) {
  let v = String(nilai).trim();
  // Buang pembungkus backtick markdown.
  v = v.replace(/^`+|`+$/g, '').trim();
  if (v === '') return true;
  if (v === '[VALUE]') return true;
  if (/_{3,}/.test(v)) return true;
  if (/^\[.*\]$/.test(v)) return true; // placeholder bertanda kurung siku
  if (DITOLAK.includes(v.toUpperCase())) return true;
  // Pilihan ganda yang belum dipersempit: "YA / TIDAK",
  // "MODEL BIAYA / MODEL NILAI WAJAR", "USE EXISTING / CREATE NEW".
  if (/\s\/\s/.test(v)) return true;
  return false;
}

/**
 * Slot keputusan yang WAJIB terisi per policy.
 * Nama slot mengikuti label di formulir apa adanya.
 */
const SLOT = {
  '01': ['KEPUTUSAN 01-A', 'KEPUTUSAN 01-B'],
  '02': ['KEPUTUSAN 02'],
  '03': ['KEPUTUSAN 03', 'FAIR VALUE POSTING'],
  '04': ['KEPUTUSAN 04-A', 'KEPUTUSAN 04-B'],
  '05': ['EVENT HAK', 'DOCUMENT EVIDENCE'],
  '06': ['ADA HAK KONTRAKTUAL', 'KEPUTUSAN 06'],
  '07': ['KEPUTUSAN 07-A', 'KEPUTUSAN 07-B'],
};

const JUDUL = {
  '01': 'Kode COA baru',
  '02': 'Struktur Properti Investasi',
  '03': 'Model nilai wajar',
  '04': 'Klasifikasi hasil investasi',
  '05': 'Dasar pengakuan bagian SHU',
  '06': 'Imbal hasil tetap',
  '07': 'Jenis transaksi RAKU',
};

/**
 * Ambil nilai satu slot dari formulir.
 *
 * Format §9: judul `### NAMA` diikuti baris nilai. Nilai adalah baris
 * TIDAK KOSONG pertama setelah judul.
 */
function bacaSlot(nama) {
  const re = new RegExp(`^### ${nama.replace(/[-/]/g, '\\$&')}\\s*$`, 'm');
  const m = FORMULIR.match(re);
  if (!m) return null;
  const sisa = FORMULIR.slice((m.index ?? 0) + m[0].length);
  for (const baris of sisa.split('\n')) {
    const b = baris.trim();
    if (b === '') continue;
    if (b.startsWith('#')) return ''; // judul berikutnya -> nilai kosong
    return b;
  }
  return '';
}

const hasil = [];
for (const [no, slot] of Object.entries(SLOT)) {
  const detail = slot.map((s) => ({ slot: s, nilai: bacaSlot(s) }));
  const hilang = detail.filter((d) => d.nilai === null).map((d) => d.slot);
  const belum = detail.filter((d) => d.nilai !== null && kosong(d.nilai)).map((d) => d.slot);

  let status;
  if (hilang.length > 0) status = 'CONFLICT';
  else if (belum.length > 0) status = 'INCOMPLETE';
  else status = 'COMPLETE';

  hasil.push({ no, judul: JUDUL[no], status, belum: [...hilang, ...belum], total: slot.length });
}

// Register harus konsisten dengan formulir: selama formulir belum
// terisi, kolom KEPUTUSAN di register wajib tetap "belum diberikan".
const registerKosong = (REGISTER.match(/^> \*\*KEPUTUSAN:\*\* _\(belum diberikan\)_$/gm) ?? []).length;
const registerTotal = (REGISTER.match(/^> \*\*KEPUTUSAN:\*\*/gm) ?? []).length;
const adaCompleteDiFormulir = hasil.some((h) => h.status === 'COMPLETE');
const registerMenyimpang = registerKosong !== registerTotal && !adaCompleteDiFormulir;

const blanko = (FORMULIR.match(/`\[VALUE\]`/g) ?? []).length;

console.log('POLICY VALIDATION MATRIX — RC-S53');
console.log('='.repeat(78));
console.log(
  'No'.padEnd(4) + 'Item'.padEnd(34) + 'Status'.padEnd(14) + 'Slot terisi'.padEnd(13) + 'Implementasi'
);
console.log('-'.repeat(78));
for (const h of hasil) {
  const terisi = `${h.total - h.belum.length}/${h.total}`;
  const boleh = h.status === 'COMPLETE' ? 'READY' : 'SKIP';
  console.log(
    h.no.padEnd(4) + h.judul.padEnd(34) + h.status.padEnd(14) + terisi.padEnd(13) + boleh
  );
}
console.log('-'.repeat(78));

const siap = hasil.filter((h) => h.status === 'COMPLETE');
console.log(`Policy COMPLETE        : ${siap.length}/7`);
console.log(`Parameter masih blanko : ${blanko}`);
console.log(`Register konsisten     : ${registerMenyimpang ? 'TIDAK' : 'YA'}`);
console.log('');

/**
 * PEMERIKSAAN SILANG (§11).
 *
 * Hanya berjalan untuk policy yang SUDAH COMPLETE — memeriksa
 * ketergantungan pada policy yang masih kosong tidak menghasilkan
 * informasi apa pun, hanya kebisingan.
 */
const KETERGANTUNGAN = [
  { dari: '03', ke: '01', alasan: 'gain/loss account harus berasal dari keputusan COA' },
  { dari: '04', ke: '01', alasan: 'receivable & income account harus berasal dari keputusan COA' },
  { dari: '04', ke: '05', alasan: 'recognition rule bagian SHU harus mengikuti event hak' },
  { dari: '04', ke: '06', alasan: 'imbal hasil tetap hanya berlaku bila hak kontraktual ADA' },
  { dari: '07', ke: '01', alasan: 'debit/credit account penguatan harus berasal dari keputusan COA' },
];
const statusPer = Object.fromEntries(hasil.map((h) => [h.no, h.status]));
const konflik = [];
for (const d of KETERGANTUNGAN) {
  if (statusPer[d.dari] === 'COMPLETE' && statusPer[d.ke] !== 'COMPLETE') {
    konflik.push(`POLICY ${d.dari} COMPLETE tetapi POLICY ${d.ke} belum — ${d.alasan}`);
  }
}
console.log('Pemeriksaan silang (§11):');
if (siapAwal().length === 0) {
  console.log('  belum dapat diperiksa — tidak ada policy yang COMPLETE.');
} else if (konflik.length === 0) {
  console.log('  tidak ada ketergantungan yang dilanggar.');
} else {
  for (const k of konflik) console.log(`  CONFLICT: ${k}`);
}
console.log('');

function siapAwal() {
  return hasil.filter((h) => h.status === 'COMPLETE');
}
if (konflik.length > 0) {
  console.log('RC-S53 POLICY CONFLICT');
  process.exitCode = 2;
}

if (siap.length === 0) {
  console.log('TIDAK ADA policy yang READY_FOR_IMPLEMENTATION.');
  console.log('Slot yang masih kosong:');
  for (const h of hasil) {
    for (const s of h.belum) console.log(`  POLICY ${h.no} -> ${s}`);
  }
  console.log('');
  console.log('RC-S53 TECHNICALLY COMPLETE — POLICY ITEMS OUTSTANDING');
  process.exitCode = 1;
} else {
  console.log('READY_FOR_IMPLEMENTATION:');
  for (const h of siap) console.log(`  POLICY ${h.no} — ${h.judul}`);
  if (siap.length < 7) {
    console.log('');
    console.log('Sisanya SKIP sampai keputusannya diberikan.');
    process.exitCode = 1;
  }
}

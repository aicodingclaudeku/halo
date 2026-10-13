'use strict';
/**
 * Menambal bundle renderer KOPKU Desktop 1.0.9 (Metro) dengan modul source
 * RC-S133.4.7 (UI/UX Import Data Awal + panduan slide), TANPA `expo export`
 * (registry npm tidak dapat diakses di lingkungan pengerjaan).
 *
 * Cara kerjanya sama dengan `tambal-renderer-rc-s133.4.6.js`:
 *   - setiap berkas .ts/.tsx yang berubah di-transpile (TypeScript
 *     transpileModule, CommonJS) lalu dibungkus menjadi faktori Metro
 *     `__d(function(...){...}, ID, [deps])` dengan ID yang SAMA dengan modul
 *     lamanya; modul baru diberi ID baru;
 *   - `require('@/...')` dipetakan lewat nama ekspor (indeks bundle),
 *     `require('./x')` lewat path relatif ke modul baru/berubah;
 *   - paket pihak ketiga dipetakan lewat TABEL yang DIBACA dari bundle itu
 *     sendiri (switch modul Import Data Awal hasil tambalan 1.0.9 dan
 *     dependensi modul PanduanSlide), bukan nomor yang diketik tangan.
 *
 * Pemakaian (sudah dijalankan untuk 1.0.10 — TIDAK perlu dijalankan lagi):
 *   node scripts/tambal-renderer-rc-s133.4.7.js renderer <src RC-S133.4.7> <src RC-S133.4.6> laporan.json
 * Bundle masukan harus bundle 1.0.9 (renderer hasil tambalan RC-S133.4.6).
 * Cara resmi tetap: `npm run build:renderer` di folder desktop/ source utama.
 */
const fs = require('fs');
const path = require('path');
let ts;
try { ts = require('typescript'); } catch { ts = require(process.env.TYPESCRIPT_PATH || 'typescript'); }
const { indeksEkspor, cariBerkasBundle } = require(path.join(__dirname, '..', 'electron', 'server', 'bundleIndex'));

const [rendererDir, srcBaru, srcAsli, laporanOut] = process.argv.slice(2);
if (!rendererDir || !srcBaru || !srcAsli || !laporanOut) {
  console.error('pakai: node scripts/tambal-renderer-rc-s133.4.7.js <renderer> <src baru> <src asli> <laporan.json>');
  process.exit(2);
}
const BERUBAH = [
  { rel: 'import/PanduanImportData.ts', baru: true },
  { rel: 'components/panduan/IlustrasiImport.tsx', baru: true },
  { rel: 'components/panduan/PanduanImportSlide.tsx', baru: true },
  { rel: 'import/TemplateDataAwal.ts' },
  { rel: 'import/TemplateWorkbook.ts' },
  { rel: 'services/ImportDataAwalService.ts' },
  { rel: 'screens/Pengaturan/ImportDataAwalScreen.tsx', penanda: 'Pinjaman yang perlu dicek' },
  { rel: 'screens/Pengaturan/StrukturTemplateScreen.tsx', penanda: 'Geser ke samping untuk melihat seluruh kolom' },
];

const berkasBundle = cariBerkasBundle(rendererDir);
let teks = fs.readFileSync(berkasBundle, 'utf8');
const peta = indeksEkspor(teks);

function segmenModul(t) {
  const awal = [];
  const re = /__d\(function\(/g;
  let m;
  while ((m = re.exec(t))) awal.push(m.index);
  const seg = new Map();
  for (let k = 0; k < awal.length; k++) {
    const batas = k + 1 < awal.length ? awal[k + 1] : t.length;
    const potong = t.slice(awal[k], batas);
    const mm = /\},(\d+),\[([0-9,]*)\]\);?/g;
    let last = null, x;
    while ((x = mm.exec(potong))) last = x;
    if (!last) continue;
    seg.set(Number(last[1]), { mulai: awal[k], akhir: awal[k] + last.index + last[0].length, deps: last[2].split(',').filter(Boolean).map(Number) });
  }
  return seg;
}
let SEG = segmenModul(teks);
function idDariPenanda(penanda) {
  const i = teks.indexOf(penanda);
  if (i < 0) throw new Error('penanda tidak ditemukan: ' + penanda);
  for (const [id, s] of SEG) if (i >= s.mulai && i < s.akhir) return id;
  throw new Error('penanda di luar modul: ' + penanda);
}
function sumberModul(id) { const s = SEG.get(id); return teks.slice(s.mulai, s.akhir); }

// ---------------------------------------------------------------------------
// TABEL PAKET PIHAK KETIGA — dibaca dari bundle
// ---------------------------------------------------------------------------
const idImportLama = idDariPenanda('Pinjaman yang perlu dicek');
const switchImport = sumberModul(idImportLama);
const PAKET = {}; // nama -> ekspresi
const RN = {}; // komponen react-native -> id
const AT = {}; // '@/path' -> id, seperti dipetakan tambalan 1.0.9 (dipakai bila nama ekspor mendua)
for (const m of switchImport.matchAll(/case "([^"]+)":return ([^;]+);/g)) {
  if (m[1] === 'react-native') {
    for (const k of m[2].matchAll(/(\w+):_\$r\((\d+)\)\.default/g)) RN[k[1]] = Number(k[2]);
  } else if (!m[1].startsWith('@/')) PAKET[m[1]] = m[2];
  else AT[m[1].slice(2)] = Number(/\d+/.exec(m[2])[0]);
}
// Paket lain (xlsx-js-style, expo-sharing, expo-document-picker, ...) dari
// switch SEMUA modul hasil tambalan 1.0.9.
for (const blok of teks.matchAll(/var require=function\(n\)\{switch\(n\)\{(.*?)\}throw new Error\("KOPKU patch/g)) {
  for (const m of blok[1].matchAll(/case "([^"]+)":return ([^;]+);/g)) {
    if (m[1] === 'react-native' || m[1].startsWith('@/') || m[1].startsWith('.')) continue;
    if (PAKET[m[1]] !== undefined && PAKET[m[1]] !== m[2]) throw new Error(`pemetaan paket ${m[1]} tidak konsisten: ${PAKET[m[1]]} vs ${m[2]}`);
    PAKET[m[1]] = m[2];
  }
}
// PanduanSlide: import { Animated, Modal, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
// lalu react-native-safe-area-context, @expo/vector-icons, @/theme/colors, ./IlustrasiUi, react/jsx-runtime.
const idPanduan = idDariPenanda('Lewati panduan');
const dp = SEG.get(idPanduan).deps;
const urutanPanduan = ['react', 'Animated', 'Modal', 'StyleSheet', 'Text', 'TouchableOpacity', 'View', 'useWindowDimensions', 'react-native-safe-area-context'];
urutanPanduan.forEach((n, i) => {
  if (n === 'react' || n === 'react-native-safe-area-context') {
    if (n === 'react-native-safe-area-context') PAKET[n] = `_$r(${dp[i]})`;
    return;
  }
  if (RN[n] !== undefined && RN[n] !== dp[i]) throw new Error(`tabel RN tidak konsisten untuk ${n}: ${RN[n]} vs ${dp[i]}`);
  RN[n] = dp[i];
});
// Pemeriksaan kewarasan: urutan dependensi PanduanSlide = urutan impor di
// source-nya. Kebenaran urutan itu sudah DIUJI SILANG di atas: StyleSheet,
// Text, TouchableOpacity, dan View dari PanduanSlide harus sama dengan
// tabel modul Import Data Awal (galat bila berbeda). Modul RN-web yang
// tersisa (Animated, Modal, useWindowDimensions) berupa modul ekspor-ulang
// yang terminifikasi, sehingga tidak diperiksa dari isinya.
for (const n of ['StyleSheet', 'Text', 'TouchableOpacity', 'View', 'Animated', 'Modal', 'useWindowDimensions']) {
  if (RN[n] === undefined) throw new Error('komponen react-native tidak terbaca: ' + n);
}
for (const n of ['react', 'react/jsx-runtime', '@react-navigation/native', '@expo/vector-icons']) {
  if (!PAKET[n]) throw new Error('paket tidak terbaca dari bundle: ' + n);
}
if (!/useRoute/.test(sumberModul(Number(/\d+/.exec(PAKET['@react-navigation/native'])[0])))) {
  // useRoute diekspor paket yang sama; bila tidak tampak di modul indeks, pastikan ada di bundle.
  if (!teks.includes('useRoute')) throw new Error('useRoute tidak ada di bundle');
}

function eksporSource(file) {
  const src = fs.readFileSync(file, 'utf8');
  const nama = new Set();
  for (const m of src.matchAll(/^export (?:async )?(?:function\*? |class |const |let )([A-Za-z_$][\w$]*)/gm)) nama.add(m[1]);
  return [...nama];
}
function kandidatNama(nama) {
  let k = null;
  for (const n of nama) {
    const ids = new Set(peta.get(n) || []);
    k = k === null ? ids : new Set([...k].filter((x) => ids.has(x)));
  }
  return [...(k || [])];
}
function cariFileSource(root, rel) {
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const f = path.join(root, rel + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const laporan = [];
const idBaru = new Map();
let maxId = Math.max(...SEG.keys());
for (const b of BERUBAH) if (b.baru) idBaru.set(b.rel.replace(/\.tsx?$/, ''), ++maxId);

function idModulLama(b) {
  if (b.baru) return idBaru.get(b.rel.replace(/\.tsx?$/, ''));
  if (b.penanda) return idDariPenanda(b.penanda);
  const k = kandidatNama(eksporSource(path.join(srcAsli, b.rel)));
  if (k.length === 0) throw new Error(`modul lama ${b.rel}: 0 kandidat`);
  return k;
}
for (const b of BERUBAH) { const r = idModulLama(b); b.id = Array.isArray(r) ? (r.length === 1 ? r[0] : r) : r; }
for (const b of BERUBAH) if (Array.isArray(b.id)) {
  const dipakai = new Set(BERUBAH.filter((x) => !Array.isArray(x.id)).map((x) => x.id));
  const sisa = b.id.filter((x) => !dipakai.has(x));
  if (sisa.length !== 1) throw new Error(`modul lama ${b.rel}: ${sisa.length} kandidat`);
  b.id = sisa[0];
}

function resolveRel(rel, b) {
  if (idBaru.has(rel)) return idBaru.get(rel);
  const ubah = BERUBAH.find((x) => x.rel.replace(/\.tsx?$/, '') === rel);
  if (ubah) return ubah.id;
  if (AT[rel] !== undefined) return AT[rel];
  const f = cariFileSource(srcAsli, rel) || cariFileSource(srcBaru, rel);
  if (!f) throw new Error('source tidak ada: ' + rel);
  const nm = eksporSource(f);
  if (nm.length === 0) throw new Error(`${b.rel}: ${rel} tanpa ekspor bernama`);
  const k = kandidatNama(nm);
  if (k.length === 1) return k[0];
  const depsLama = b.baru ? [] : SEG.get(b.id).deps;
  const i = k.filter((x) => depsLama.includes(x));
  if (i.length === 1) return i[0];
  throw new Error(`${b.rel}: require("${rel}") — ${k.length} kandidat`);
}

const tambahan = [];
for (const b of BERUBAH) {
  const src = fs.readFileSync(path.join(srcBaru, b.rel), 'utf8');
  // Komponen react-native yang diimpor berkas ini.
  const namaRn = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'react-native'/g)) {
    for (const p of m[1].split(',')) {
      const n = p.trim();
      if (!n || n.startsWith('type ')) continue;
      namaRn.push(n.split(/\s+as\s+/)[0].trim());
    }
  }
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: b.rel,
  }).outputText
    .replace(/\bexports\.([A-Za-z_$][\w$]*) = /g, 'exports.$1=')
    .replace(/Object\.defineProperty\(exports, "/g, 'Object.defineProperty(exports,"');
  const nama = [...new Set([...out.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))];
  const kasus = [];
  const deps = [];
  for (const n of nama) {
    if (n === 'react-native') {
      const isi = namaRn.map((k) => {
        if (RN[k] === undefined) throw new Error(`${b.rel}: komponen react-native ${k} tidak ada di tabel`);
        return `${k}:_$r(${RN[k]}).default`;
      });
      kasus.push(`case "react-native":return {${isi.join(',')},__esModule:true};`);
      continue;
    }
    if (PAKET[n]) {
      kasus.push(`case ${JSON.stringify(n)}:return ${PAKET[n]};`);
      continue;
    }
    let rel;
    if (n.startsWith('@/')) rel = n.slice(2);
    else if (n.startsWith('./') || n.startsWith('../')) rel = path.posix.normalize(path.posix.join(path.posix.dirname(b.rel), n));
    else throw new Error(`${b.rel}: paket tidak dikenal ${n}`);
    const id = resolveRel(rel, b);
    deps.push(id);
    kasus.push(`case ${JSON.stringify(n)}:return _$r(${id});`);
  }
  const fac =
    `__d(function(global,_$r,_$i,_$a,module,exports,_$d){var require=function(n){switch(n){${kasus.join('')}}throw new Error("KOPKU patch: modul tidak dipetakan "+n)};\n` +
    out.replace(/\/\/# sourceMappingURL.*$/m, '') +
    `\n},${b.id},[${deps.join(',')}]);`;
  laporan.push({ berkas: b.rel, id: b.id, baru: !!b.baru, require: nama.length, deps, reactNative: namaRn });
  if (b.baru) tambahan.push(fac);
  else {
    const s = SEG.get(b.id);
    teks = teks.slice(0, s.mulai) + fac + teks.slice(s.akhir);
    SEG = segmenModul(teks);
  }
}
const ekor = /(\n__r\(\d+\);)+\s*$/.exec(teks);
const pos = ekor ? ekor.index : teks.length;
teks = teks.slice(0, pos) + '\n' + tambahan.join('\n') + teks.slice(pos);
fs.writeFileSync(berkasBundle, teks);
fs.writeFileSync(laporanOut, JSON.stringify({ tabelReactNative: RN, paket: PAKET, modul: laporan }, null, 1));
console.log(JSON.stringify(laporan.map((l) => [l.berkas, l.id, l.deps.length])));

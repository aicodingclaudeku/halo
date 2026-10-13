'use strict';
/**
 * Menambal bundle renderer KOPKU Desktop (Metro) dengan modul source yang berubah,
 * TANPA `expo export` (registry npm tidak dapat diakses di lingkungan ini).
 *
 * Setiap berkas .ts/.tsx yang berubah di-transpile (TypeScript transpileModule,
 * CommonJS) lalu dibungkus menjadi faktori Metro `__d(function(...){...}, ID, [deps])`
 * dengan ID yang SAMA dengan modul lamanya, sehingga seluruh modul lain yang
 * memakainya otomatis memakai versi baru. Modul baru diberi ID baru.
 *
 * Pemetaan `require("...")` -> ID modul Metro:
 *   - '@/path'  : modul yang mengekspor SELURUH nama ekspor berkas source aslinya;
 *                 bila lebih dari satu kandidat, dipersempit ke daftar dependensi
 *                 modul lama (Metro menyimpan dependensi per modul).
 *   - paket luar: tabel nama ekspor penanda, dipersempit ke dependensi modul lama.
 *   - override eksplisit (mis. 'react-native' yang di bundle web dipecah per komponen).
 *
 * Pemakaian (sudah dijalankan untuk 1.0.9 — TIDAK perlu dijalankan lagi):
 *   node scripts/tambal-renderer-rc-s133.4.6.js renderer <src RC-S133.4.6> <src RC-S133.4.5> laporan.json
 * Bundle yang ditambal harus bundle `expo export` RC-S133.4.5 (1.0.8). Cara resmi tetap:
 * `npm run build:renderer` di folder desktop/ source utama, lalu salin renderer/.
 */
const fs = require('fs');
const path = require('path');
let ts;
try { ts = require('typescript'); } catch { ts = require(process.env.TYPESCRIPT_PATH || 'typescript'); }
const { indeksEkspor, cariBerkasBundle } = require(path.join(__dirname, '..', 'electron', 'server', 'bundleIndex'));

const [rendererDir, srcBaru, srcAsli, laporanOut] = process.argv.slice(2);
const BERUBAH = [
  { rel: 'import/EksekusiMigrasiBerjangka.ts', baru: true },
  { rel: 'import/EksekusiImportDataAwal.ts' },
  { rel: 'services/SimpananBerjangkaLifecycleService.ts' },
  { rel: 'accounting/SaldoAwalRealisasiKas.ts' },
  { rel: 'import/ExcelDataAwalParser.ts' },
  { rel: 'import/TemplateDataAwal.ts' },
  { rel: 'import/TemplateWorkbook.ts' },
  { rel: 'import/SaldoAwalOtomatisPlan.ts' },
  { rel: 'services/ImportDataAwalService.ts' },
  { rel: 'screens/Pengaturan/ImportDataAwalScreen.tsx', penanda: 'Pinjaman yang perlu dicek' },
];
const PAKET = {
  react: ['useState', 'useMemo', 'createElement', 'Children'],
  'react/jsx-runtime': ['jsx', 'jsxs'],
  '@react-navigation/native': ['useNavigation'],
  '@expo/vector-icons': ['Ionicons'],
  'expo-sharing': ['shareAsync', 'isAvailableAsync'],
  'expo-document-picker': ['getDocumentAsync'],
  'expo-file-system/legacy': ['documentDirectory', 'getInfoAsync'],
};

const berkasBundle = cariBerkasBundle(rendererDir);
let teks = fs.readFileSync(berkasBundle, 'utf8');
const peta = indeksEkspor(teks);

// ---- segmen modul: id -> {mulai, akhir, deps}
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
const idBaru = new Map(); // rel tanpa ekstensi -> id
let maxId = Math.max(...SEG.keys());
for (const b of BERUBAH) if (b.baru) idBaru.set(b.rel.replace(/\.tsx?$/, ''), ++maxId);

// ID modul lama setiap berkas yang berubah
function idModulLama(b) {
  if (b.baru) return idBaru.get(b.rel.replace(/\.tsx?$/, ''));
  if (b.penanda) {
    const i = teks.indexOf(b.penanda);
    for (const [id, s] of SEG) if (i >= s.mulai && i < s.akhir) return id;
    throw new Error('penanda tidak ditemukan ' + b.penanda);
  }
  const k = kandidatNama(eksporSource(path.join(srcAsli, b.rel)));
  if (k.length === 0) throw new Error(`modul lama ${b.rel}: 0 kandidat`);
  return k;
}
// dua tahap: kandidat tunggal dulu, lalu yang mendua dipersempit dengan membuang ID yang sudah dipakai
// (mis. bangunWorkbookTemplate juga diekspor ulang oleh ImportDataAwalService)
for (const b of BERUBAH) { const r = idModulLama(b); b.id = Array.isArray(r) ? (r.length === 1 ? r[0] : r) : r; }
for (const b of BERUBAH) if (Array.isArray(b.id)) {
  const dipakai = new Set(BERUBAH.filter((x) => !Array.isArray(x.id)).map((x) => x.id));
  const sisa = b.id.filter((x) => !dipakai.has(x));
  if (sisa.length !== 1) throw new Error(`modul lama ${b.rel}: ${sisa.length} kandidat`);
  b.id = sisa[0];
}

function resolveRequire(nama, b) {
  const depsLama = b.baru ? [] : SEG.get(b.id).deps;
  const persempit = (k, label) => {
    if (k.length === 1) return k[0];
    const i = k.filter((x) => depsLama.includes(x));
    if (i.length === 1) return i[0];
    throw new Error(`${b.rel}: require("${nama}") ${label} — ${k.length} kandidat, ${i.length} di dependensi lama`);
  };
  if (nama.startsWith('@/')) {
    const rel = nama.slice(2);
    if (idBaru.has(rel)) return { id: idBaru.get(rel) };
    const ubah = BERUBAH.find((x) => x.rel.replace(/\.tsx?$/, '') === rel);
    if (ubah) return { id: ubah.id };
    const f = cariFileSource(srcAsli, rel) || cariFileSource(srcBaru, rel);
    if (!f) throw new Error('source tidak ada: ' + rel);
    const nm = eksporSource(f);
    if (nm.length === 0) throw new Error(`${rel}: tidak ada ekspor bernama (pakai override)`);
    return { id: persempit(kandidatNama(nm), rel) };
  }
  if (nama === 'xlsx-js-style') {
    const i = teks.indexOf('e.style_version="1.2.0"');
    for (const [id, s] of SEG) if (i >= s.mulai && i < s.akhir) return { id };
  }
  if (PAKET[nama]) return { id: persempit(kandidatNama(PAKET[nama]), nama) };
  throw new Error(`${b.rel}: paket tidak dikenal ${nama}`);
}

// override khusus layar: react-native di bundle web dipecah per komponen (urutan = dependensi modul lama)
const OVERRIDE = {
  'screens/Pengaturan/ImportDataAwalScreen.tsx': (depsLama) => ({
    'react-native': `{View:_$r(${depsLama[2]}).default,Text:_$r(${depsLama[3]}).default,ScrollView:_$r(${depsLama[4]}).default,TouchableOpacity:_$r(${depsLama[5]}).default,StyleSheet:_$r(${depsLama[6]}).default,ActivityIndicator:_$r(${depsLama[7]}).default,__esModule:true}`,
    '@/components/DatePicker': `_$r(${depsLama[9]})`,
    react: `_$r(${depsLama[0]})`,
    '@react-navigation/native': `_$r(${depsLama[1]})`,
    '@expo/vector-icons': `_$r(${depsLama[8]})`,
    'react/jsx-runtime': `_$r(${depsLama[depsLama.length - 1]})`,
  }),
};

const tambahan = [];
for (const b of BERUBAH) {
  const src = fs.readFileSync(path.join(srcBaru, b.rel), 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: b.rel,
  }).outputText
    // gaya penulisan ekspor yang dikenali indeks modul Server LAN (electron/server/bundleIndex.js):
    // `exports.nama=` dan `defineProperty(exports,"nama"` tanpa spasi.
    .replace(/\bexports\.([A-Za-z_$][\w$]*) = /g, 'exports.$1=')
    .replace(/Object\.defineProperty\(exports, "/g, 'Object.defineProperty(exports,"');
  const nama = [...new Set([...out.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))];
  const depsLama = b.baru ? [] : SEG.get(b.id).deps;
  const ov = OVERRIDE[b.rel] ? OVERRIDE[b.rel](depsLama) : {};
  const kasus = [];
  const deps = [];
  for (const n of nama) {
    if (ov[n]) {
      kasus.push(`case ${JSON.stringify(n)}:return ${ov[n]};`);
      continue;
    }
    const { id } = resolveRequire(n, b);
    deps.push(id);
    kasus.push(`case ${JSON.stringify(n)}:return _$r(${id});`);
  }
  const fac =
    `__d(function(global,_$r,_$i,_$a,module,exports,_$d){var require=function(n){switch(n){${kasus.join('')}}throw new Error("KOPKU patch: modul tidak dipetakan "+n)};\n` +
    out.replace(/\/\/# sourceMappingURL.*$/m, '') +
    `\n},${b.id},[${deps.join(',')}]);`;
  laporan.push({ berkas: b.rel, id: b.id, baru: !!b.baru, require: nama.length, deps });
  if (b.baru) tambahan.push(fac);
  else {
    const s = SEG.get(b.id);
    teks = teks.slice(0, s.mulai) + fac + teks.slice(s.akhir);
    SEG = segmenModul(teks);
  }
}
// modul baru disisipkan sebelum pemanggilan entry (__r(...) di akhir bundle)
const ekor = /(\n__r\(\d+\);)+\s*$/.exec(teks);
const pos = ekor ? ekor.index : teks.length;
teks = teks.slice(0, pos) + '\n' + tambahan.join('\n') + teks.slice(pos);
fs.writeFileSync(berkasBundle, teks);
fs.writeFileSync(laporanOut, JSON.stringify(laporan, null, 1));
console.log(JSON.stringify(laporan.map((l) => [l.berkas, l.id, l.deps.length])));

'use strict';
/**
 * Menambal bundle renderer KOPKU Desktop 1.0.14 menjadi 1.0.15 dengan source
 * RC-S133.6 (tindak lanjut audit rekonsiliasi), TANPA `expo export` (registry
 * npm tidak dapat diakses di lingkungan pengerjaan). Cara resmi tetap:
 * `npm run build:renderer` di folder desktop/ source utama.
 *
 * Hanya MENGGANTI modul yang berubah di RC-S133.6 (TypeScript transpileModule
 * → faktori Metro). Setiap `require` dipetakan lewat scripts/peta-modul-bundle.js
 * (bukti dari bundle, bukan tebakan) — gagal keras bila ada yang tidak
 * terpetakan. Tidak ada rute/menu/izin yang disisipkan.
 *
 * Pemakaian:
 *   node scripts/tambal-renderer-rc-s133.6.js <renderer> <src RC-S133.6> <laporan.json> <src lama> [src lama 2 ...]
 * <src lama> = source yang cocok dengan bundle masukan (RC-S133.5).
 */
const fs = require('fs');
const path = require('path');
let ts;
try {
  ts = require('typescript');
} catch {
  ts = require(process.env.TYPESCRIPT_PATH || '/opt/node22/lib/node_modules/typescript');
}
const { cariBerkasBundle } = require(path.join(__dirname, '..', 'electron', 'server', 'bundleIndex'));
const { bangunPeta, segmenModul, kunciSpesifier } = require('./peta-modul-bundle');

const [rendererDir, srcBaru, laporanOut, ...srcLama] = process.argv.slice(2);
if (!rendererDir || !srcBaru || !laporanOut || srcLama.length === 0) {
  console.error('pakai: node scripts/tambal-renderer-rc-s133.6.js <renderer> <src baru> <laporan.json> <src lama> [src lama ...]');
  process.exit(2);
}

// Penanda unik dari source RC-S133.6 (FinancialReports) — tambalan idempoten.
const PENANDA = 'saldoAwalHasilUsaha';
const berkasBundle = cariBerkasBundle(rendererDir);
let teks = fs.readFileSync(berkasBundle, 'utf8');
if (teks.includes(PENANDA)) {
  console.log('Bundle sudah berisi tambalan RC-S133.6:', path.basename(berkasBundle));
  process.exit(0);
}
if (!/testID:\s*"portal-anggota"/.test(teks)) throw new Error('Bundle masukan harus 1.0.14 (berisi tambalan RC-S133.5).');

const laporan = { bundle: path.basename(berkasBundle), modul: [] };
let SEG = segmenModul(teks);

const PENANDA_DEFAULT = {
  'app/index': ['PIN_DISABLED', 'PIN_LOCKED', "'LOGIN'"],
  'navigation/RootNavigator': ['name:"SinkronPerangkat"', 'name:"UserForm"'],
  'desktop/BingkaiAplikasi': ['Keuangan koperasi yang tertib dan transparan.', 'sidebarAktif'],
  // Layar hanya ber-ekspor default → dikenali dari teks uniknya.
  'screens/Laporan/PerubahanEkuitasScreen': ['Tidak ada mutasi ekuitas pada periode ini.', 'Rekonsiliasi Periode Komparatif ke Posisi Keuangan'],
};
const P = bangunPeta(teks, srcLama, PENANDA_DEFAULT);
if (P.konflik.length) throw new Error('Peta modul bertentangan:\n' + P.konflik.join('\n'));

// Modul yang berubah di RC-S133.6 (lihat RC-S133.6_TINDAK_LANJUT_AUDIT_REKONSILIASI.md).
const BERUBAH = [
  { rel: 'accounting/InstallmentDate' },         // F-5
  { rel: 'import/ExcelDataAwalParser' },         // B-2, B-3
  { rel: 'import/EksekusiImportDataAwal' },      // F-1, F-1b
  { rel: 'services/ImportDataAwalService' },     // B-2
  { rel: 'reports/FinancialReports' },           // F-2, F-3, F-4
  { rel: 'export/ReportTableBuilders' },         // F-4
  { rel: 'export/JuklatPdf' },                   // F-4
  { rel: 'screens/Laporan/PerubahanEkuitasScreen' }, // F-4
];
function fileBaru(b) {
  const dasar = path.join(srcBaru, 'src', b.rel);
  for (const e of ['.web.tsx', '.web.ts', '.tsx', '.ts']) if (fs.existsSync(dasar + e)) return dasar + e;
  throw new Error('source baru tidak ada: ' + b.rel);
}
for (const b of BERUBAH) {
  b.id = P.peta.get('@/' + b.rel);
  if (b.id === undefined || !SEG.has(b.id)) throw new Error(`modul lama ${b.rel} tidak terpetakan`);
}

for (const b of BERUBAH) {
  const file = fileBaru(b);
  const src = fs.readFileSync(file, 'utf8');
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
    fileName: path.basename(file),
  })
    .outputText.replace(/\bexports\.([A-Za-z_$][\w$]*) = /g, 'exports.$1=')
    .replace(/Object\.defineProperty\(exports, "/g, 'Object.defineProperty(exports,"');
  const spes = [...new Set([...out.matchAll(/require\((["'])([^"']+)\1\)/g)].map((m) => m[2]))];
  const kasus = [];
  const deps = [];
  for (const n of spes) {
    if (n === 'react-native') {
      const isi = namaRn
        .filter((k) => new RegExp(`react_native_\\d*\\.${k}\\b`).test(out))
        .map((k) => {
          const id = P.peta.get('rn:' + k);
          if (id === undefined) throw new Error(`${b.rel}: komponen react-native ${k} tidak terpetakan`);
          deps.push(id);
          return `${k}:_$r(${id}).default`;
        });
      kasus.push(`case "react-native":return {${isi.join(',')},__esModule:true};`);
      continue;
    }
    const kunci = kunciSpesifier(n, b.rel);
    const id = P.peta.get(kunci);
    if (id === undefined) throw new Error(`${b.rel}: require("${n}") [${kunci}] tidak terpetakan`);
    deps.push(id);
    kasus.push(`case ${JSON.stringify(n)}:return _$r(${id});`);
  }
  const fac =
    `__d(function(global,_$r,_$i,_$a,module,exports,_$d){var require=function(n){switch(n){${kasus.join('')}}throw new Error("KOPKU patch: modul tidak dipetakan "+n)};\n` +
    out.replace(/\/\/# sourceMappingURL.*$/m, '') +
    `\n},${b.id},[${[...new Set(deps)].join(',')}]);`;
  laporan.modul.push({ berkas: path.relative(srcBaru, file), id: b.id, require: spes.length, reactNative: namaRn });
  const s = SEG.get(b.id);
  teks = teks.slice(0, s.mulai) + fac + teks.slice(s.akhir);
  SEG = segmenModul(teks);
}

// ---------------------------------------------------------------------------
// PEMERIKSAAN AKHIR
// ---------------------------------------------------------------------------
for (const b of BERUBAH) if (!new RegExp(`\\},${b.id},\\[[0-9,]*\\]\\);`).test(teks)) throw new Error(`modul ${b.rel} (#${b.id}) hilang`);
for (const wajib of [PENANDA, 'normalkanSelPersen', 'parseBilanganHitungan', 'bankUntukImport', 'rincian-mutasi-shu']) {
  if (!teks.includes(wajib)) throw new Error(`penanda RC-S133.6 tidak ada di bundle: ${wajib}`);
}
for (const larang of ['AsistenClaude', 'api.anthropic.com', 'kopku.claude']) {
  if (teks.includes(larang)) throw new Error(`sisa Claude di bundle: ${larang}`);
}
try {
  new Function(teks.replace(/^#!.*\n/, ''));
} catch (e) {
  throw new Error('bundle hasil tidak valid secara sintaks: ' + e.message);
}

fs.writeFileSync(berkasBundle + '.tmp', teks);
fs.renameSync(berkasBundle + '.tmp', berkasBundle);
fs.writeFileSync(laporanOut, JSON.stringify(laporan, null, 1));
console.log(JSON.stringify({ modul: laporan.modul.map((l) => [l.berkas, l.id, l.require]) }));

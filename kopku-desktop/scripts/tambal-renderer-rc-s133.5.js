'use strict';
/**
 * Menambal bundle renderer KOPKU Desktop 1.0.13 menjadi 1.0.14 dengan source
 * RC-S133.5, TANPA `expo export` (registry npm tidak dapat diakses di
 * lingkungan pengerjaan). Cara resmi tetap: `npm run build:renderer` di folder
 * desktop/ source utama.
 *
 *  A. Fitur Claude DIHAPUS: rute/izin/menu/katalog sisipan RC-S133.4.8 dicabut,
 *     modul Claude (layar, service, konektor, ringkasan) dikosongkan.
 *  B. Modul source diganti/ditambah (TypeScript transpileModule → faktori Metro);
 *     setiap `require` dipetakan lewat scripts/peta-modul-bundle.js (bukti dari
 *     bundle, bukan tebakan) — gagal keras bila ada yang tidak terpetakan.
 *  C. Sisipan berjangkar: rute & izin "AkunAnggotaMassal", teks menu sinkron.
 *
 * Pemakaian:
 *   node scripts/tambal-renderer-rc-s133.5.js <renderer> <src RC-S133.5> <laporan.json> <src lama> [src lama 2 ...]
 * <src lama> = source yang cocok dengan bundle masukan (mis. RC-S133.4.10, RC-S133.4.7).
 */
const fs = require('fs');
const path = require('path');
let ts;
try {
  ts = require('typescript');
} catch {
  ts = require(process.env.TYPESCRIPT_PATH || '/opt/node22/lib/node_modules/typescript');
}
const { indeksEkspor, cariBerkasBundle } = require(path.join(__dirname, '..', 'electron', 'server', 'bundleIndex'));
const { bangunPeta, segmenModul, kunciSpesifier } = require('./peta-modul-bundle');

const [rendererDir, srcBaru, laporanOut, ...srcLama] = process.argv.slice(2);
if (!rendererDir || !srcBaru || !laporanOut || srcLama.length === 0) {
  console.error('pakai: node scripts/tambal-renderer-rc-s133.5.js <renderer> <src baru> <laporan.json> <src lama> [src lama ...]');
  process.exit(2);
}

const PENANDA_DESKTOP = 'portal-anggota';
const berkasBundle = cariBerkasBundle(rendererDir);
let teks = fs.readFileSync(berkasBundle, 'utf8');
if (teks.includes(`testID:"${PENANDA_DESKTOP}"`)) {
  console.log('Bundle sudah berisi tambalan RC-S133.5:', path.basename(berkasBundle));
  process.exit(0);
}
if (!teks.includes('name:"AsistenClaude"')) throw new Error('Bundle masukan harus 1.0.13 (berisi tambalan RC-S133.4.8/4.9).');

const laporan = { bundle: path.basename(berkasBundle), dicabut: [], dikosongkan: [], modul: [], sisipan: [] };
let SEG = segmenModul(teks);
const isiModul = (id) => teks.slice(SEG.get(id).mulai, SEG.get(id).akhir);
function idDenganPenanda(penanda) {
  const ids = [];
  for (const [id] of SEG) if (penanda.every((p) => isiModul(id).includes(p))) ids.push(id);
  if (ids.length !== 1) throw new Error(`penanda ${JSON.stringify(penanda)}: ${ids.length} modul (${ids.join(',')})`);
  return ids[0];
}
function ganti(cari, jadi, nama) {
  const n = teks.split(cari).length - 1;
  if (n !== 1) throw new Error(`Jangkar "${nama}" ditemukan ${n}× (harus tepat 1×).`);
  teks = teks.replace(cari, () => jadi);
  SEG = segmenModul(teks);
}

// ---------------------------------------------------------------------------
// PETA MODUL (dari bundle masukan + source lama yang cocok)
// ---------------------------------------------------------------------------
const PENANDA_DEFAULT = {
  'app/index': ['PIN_DISABLED', 'PIN_LOCKED', "'LOGIN'"],
  'navigation/RootNavigator': ['name:"SinkronPerangkat"', 'name:"UserForm"'],
  'desktop/BingkaiAplikasi': ['Keuangan koperasi yang tertib dan transparan.', 'sidebarAktif'],
};
const P = bangunPeta(teks, srcLama, PENANDA_DEFAULT);
if (P.konflik.length) throw new Error('Peta modul bertentangan:\n' + P.konflik.join('\n'));

// ---------------------------------------------------------------------------
// A. CABUT CLAUDE
// ---------------------------------------------------------------------------
{
  const reStack = /,\(0,\w+\.jsx\)\(\w+\.Screen,\{name:"AsistenClaude",component:\w+\(\d+\)\.default,options:\{title:'Asisten Claude'\}\}\)/g;
  const n = (teks.match(reStack) || []).length;
  if (n !== 1) throw new Error(`rute AsistenClaude: ${n}× (harus 1×)`);
  teks = teks.replace(reStack, '');
  laporan.dicabut.push('rute AsistenClaude (stack Pengaturan)');
  for (const [nama, s] of [
    ['IZIN_RUTE', "AsistenClaude:n('pengaturan'),"],
    ['KATALOG', "e('Pengaturan','Pengaturan','AsistenClaude','Asisten Claude','sparkles-outline',{ket:'Hubungkan ke Claude (AI) \\u2014 tanya jawab data koperasi',sidebar:!0,kata:'ai claude anthropic asisten chat tanya api key'}),"],
    ['PengaturanMenu', "{route:'AsistenClaude',icon:'sparkles-outline',title:'Asisten Claude',sub:'Hubungkan ke Claude (AI) & tanya jawab data koperasi',resource:'pengaturan'},"],
  ]) {
    ganti(s, '', `cabut ${nama}`);
    laporan.dicabut.push(nama);
  }
  SEG = segmenModul(teks);
  const indeks = indeksEkspor(teks);
  const ringkasan = indeks.get('muatRingkasanDashboard') || [];
  if (ringkasan.length !== 1) throw new Error(`RingkasanDashboardService: ${ringkasan.length} modul`);
  const kosongkan = [
    ['screens/Pengaturan/AsistenClaudeScreen', idDenganPenanda(['claude-api-key'])],
    ['services/ClaudeService', idDenganPenanda(['api.anthropic.com', 'kopku.claude.apikey'])],
    ['components/asisten/KonektorClaudeDesktop', idDenganPenanda(['konektor-claude-desktop'])],
    ['services/RingkasanDashboardService', ringkasan[0]],
  ];
  for (const [rel, id] of kosongkan) {
    const s = SEG.get(id);
    teks = teks.slice(0, s.mulai) + `__d(function(g,r,i,a,m,e,d){"use strict";Object.defineProperty(e,'__esModule',{value:!0})},${id},[]);` + teks.slice(s.akhir);
    SEG = segmenModul(teks);
    laporan.dikosongkan.push({ berkas: rel, id });
  }
}

// ---------------------------------------------------------------------------
// B. MODUL SOURCE BARU / DIGANTI
// ---------------------------------------------------------------------------
const BERUBAH = [
  { rel: 'app/index', akar: true },
  { rel: 'services/AuthService' },
  { rel: 'services/UserManagementService' },
  { rel: 'services/PermissionService' },
  { rel: 'screens/Pengaturan/PermissionMatrixScreen' },
  { rel: 'screens/Pengaturan/UserManagementScreen' },
  { rel: 'sync/SyncKlien' },
  { rel: 'sync/SyncServer' },
  { rel: 'sync/SyncSchema' },
  { rel: 'sync/SyncModeBacaSaja' },
  { rel: 'components/sinkron/UiSinkron' },
  { rel: 'components/sinkron/PanelSinkronDesktop' },
  { rel: 'desktop/TombolHubungkanHpSetup' },
  { rel: 'desktop/shell/infoSinkron' },
  { rel: 'sync/SyncStore' },
  { rel: 'desktop/BingkaiAplikasi' },
  { rel: 'services/PortalAnggotaService', baru: true },
  { rel: 'screens/PortalAnggota/PortalAnggotaScreen', baru: true },
  { rel: 'screens/Setup/GantiPasswordScreen', baru: true },
  { rel: 'screens/Pengaturan/AkunAnggotaMassalScreen', baru: true },
  { rel: 'components/sinkron/KartuKirimData', baru: true },
];
function fileBaru(b) {
  const dasar = b.akar ? path.join(srcBaru, b.rel) : path.join(srcBaru, 'src', b.rel);
  for (const e of ['.web.tsx', '.web.ts', '.tsx', '.ts']) if (fs.existsSync(dasar + e)) return dasar + e;
  throw new Error('source baru tidak ada: ' + b.rel);
}
let maxId = Math.max(...SEG.keys());
for (const b of BERUBAH) {
  const k = '@/' + b.rel;
  if (b.baru) {
    if (P.peta.has(k)) throw new Error(`${b.rel} ditandai baru tetapi sudah ada di bundle (#${P.peta.get(k)})`);
    b.id = ++maxId;
    P.peta.set(k, b.id);
  } else {
    b.id = P.peta.get(k);
    if (b.id === undefined || !SEG.has(b.id)) throw new Error(`modul lama ${b.rel} tidak terpetakan`);
  }
}

const tambahan = [];
for (const b of BERUBAH) {
  const file = fileBaru(b);
  const relSumber = b.rel; // kunciSpesifier relatif terhadap path ini
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
  // Termasuk require('...') ber-kutip tunggal di badan kode (mis. aset gambar) — TS tidak menormalkannya.
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
    const kunci = kunciSpesifier(n, b.akar ? b.rel : b.rel);
    const id = P.peta.get(kunci);
    if (id === undefined) throw new Error(`${b.rel}: require("${n}") [${kunci}] tidak terpetakan`);
    deps.push(id);
    kasus.push(`case ${JSON.stringify(n)}:return _$r(${id});`);
  }
  const fac =
    `__d(function(global,_$r,_$i,_$a,module,exports,_$d){var require=function(n){switch(n){${kasus.join('')}}throw new Error("KOPKU patch: modul tidak dipetakan "+n)};\n` +
    out.replace(/\/\/# sourceMappingURL.*$/m, '') +
    `\n},${b.id},[${[...new Set(deps)].join(',')}]);`;
  laporan.modul.push({ berkas: path.relative(srcBaru, file), id: b.id, baru: !!b.baru, require: spes.length, reactNative: namaRn });
  if (b.baru) tambahan.push(fac);
  else {
    const s = SEG.get(b.id);
    teks = teks.slice(0, s.mulai) + fac + teks.slice(s.akhir);
    SEG = segmenModul(teks);
  }
  void relSumber;
}
{
  const ekor = /(\n__r\(\d+\);)+\s*$/.exec(teks);
  const pos = ekor ? ekor.index : teks.length;
  teks = teks.slice(0, pos) + '\n' + tambahan.join('\n') + teks.slice(pos);
  SEG = segmenModul(teks);
}

// ---------------------------------------------------------------------------
// C. SISIPAN BERJANGKAR
// ---------------------------------------------------------------------------
const idAkunMassal = BERUBAH.find((b) => b.rel === 'screens/Pengaturan/AkunAnggotaMassalScreen').id;
{
  const re = /\(0,(\w+)\.jsx\)\((\w+)\.Screen,\{name:"PermissionMatrix",component:\w+\.default,options:\{title:'Permission Matrix'\}\}\)/g;
  const semua = [...teks.matchAll(re)];
  if (semua.length !== 1) throw new Error(`jangkar rute PermissionMatrix: ${semua.length}×`);
  const ms = semua[0];
  const awalModul = teks.lastIndexOf('__d(function(', ms.index);
  const req = /^__d\(function\(([^)]*)\)/.exec(teks.slice(awalModul, awalModul + 80))[1].split(',')[1];
  const sisip = `(0,${ms[1]}.jsx)(${ms[2]}.Screen,{name:"AkunAnggotaMassal",component:${req}(${idAkunMassal}).default,options:{title:'Akun Semua Anggota'}}),`;
  teks = teks.slice(0, ms.index) + sisip + teks.slice(ms.index);
  SEG = segmenModul(teks);
  laporan.sisipan.push('rute AkunAnggotaMassal (stack Pengaturan)');
}
{
  const mIzin = /UserForm:(\w+)\('user_management'\),/.exec(teks);
  if (!mIzin) throw new Error('jangkar izin UserForm tidak ditemukan');
  const awal = teks.lastIndexOf('__d(function(', mIzin.index);
  const modul = teks.slice(awal, teks.indexOf('__d(function(', mIzin.index));
  const mc = /(?:const |,|;)\s*(\w+)=(\w+)=>\(\{resource:\2,aksi:'create'\}\)/.exec(modul);
  if (!mc) throw new Error("fungsi izin 'create' di izinRute tidak ditemukan");
  ganti(mIzin[0], `${mIzin[0]}AkunAnggotaMassal:${mc[1]}('user_management'),`, 'izin AkunAnggotaMassal');
  laporan.sisipan.push(`izin AkunAnggotaMassal = ${mc[1]}('user_management') (create)`);
}
// Teks menu sinkron (jangkar pasang-menu-lan-wa.js ikut diperbarui).
ganti(
  "{route:'SinkronPerangkat',icon:'sync-outline',title:'Sinkron HP',sub:'Pasangkan lewat QR, sinkron otomatis via Wi-Fi lokal',resource:'backup'},",
  "{route:'SinkronPerangkat',icon:'sync-outline',title:'Sinkron HP',sub:'Hubungkan lewat QR, lalu kirim data HP \\u21c4 komputer',resource:'backup'},",
  'menu Sinkron HP'
);
ganti(
  "e('Pengaturan','Pengaturan','SinkronPerangkat','Sinkron HP','sync-outline',{ket:'Pasangkan HP lewat QR',sidebar:!0,kata:'pairing qr wifi'}),",
  "e('Pengaturan','Pengaturan','SinkronPerangkat','Sinkron HP','sync-outline',{ket:'Hubungkan HP lewat QR, kirim data HP \\u21c4 PC',sidebar:!0,kata:'pairing qr wifi kirim data'}),",
  'katalog Sinkron HP'
);
ganti('Desktop adalah buku induk; HP menyimpan cadangan.', 'Hubungkan HP lalu kirim data HP \\u21c4 PC kapan saja.', 'dashboard sinkron 1');
ganti(`'Pasangkan HP lewat QR. Desktop menjadi buku induk, HP menjadi penyimpanan cadangan.'`, `'Hubungkan HP lewat QR, lalu kirim data HP \\u21c4 PC sesuai kebutuhan.'`, 'dashboard sinkron 2');
ganti('`Sinkron terakhir ${', '`Kirim data terakhir ${', 'dashboard sinkron 3');
// Teks fitur bingkai: modul desktop/BingkaiAplikasi kini diganti utuh dari source (lihat BERUBAH).
laporan.sisipan.push('teks menu/katalog/dashboard/bingkai sinkron (manual)');

// ---------------------------------------------------------------------------
// PEMERIKSAAN AKHIR
// ---------------------------------------------------------------------------
for (const larang of ['AsistenClaude', 'api.anthropic.com', 'kopku.claude', 'konektor-claude', 'muatRingkasanDashboard']) {
  if (teks.includes(larang)) throw new Error(`sisa Claude di bundle: ${larang}`);
}
for (const b of BERUBAH) if (!new RegExp(`\\},${b.id},\\[[0-9,]*\\]\\);`).test(teks)) throw new Error(`modul ${b.rel} (#${b.id}) hilang`);
try {
  new Function(teks.replace(/^#!.*\n/, ''));
} catch (e) {
  throw new Error('bundle hasil tidak valid secara sintaks: ' + e.message);
}

fs.writeFileSync(berkasBundle + '.tmp', teks);
fs.renameSync(berkasBundle + '.tmp', berkasBundle);
fs.writeFileSync(laporanOut, JSON.stringify(laporan, null, 1));
console.log(JSON.stringify({ modul: laporan.modul.map((l) => [l.berkas, l.id]), dikosongkan: laporan.dikosongkan, sisipan: laporan.sisipan }));

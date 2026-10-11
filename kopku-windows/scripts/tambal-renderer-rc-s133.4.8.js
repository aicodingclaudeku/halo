'use strict';
/**
 * CATATAN 1.0.14 (RC-S133.5): bagian Asisten Claude dari tambalan ini DICABUT
 * oleh scripts/tambal-renderer-rc-s133.5.js (modul Claude dikosongkan, rute &
 * menu dihapus). Skrip ini disimpan sebagai riwayat; jangan dijalankan lagi
 * pada renderer 1.0.14.
 *
 * Menambal bundle renderer KOPKU Desktop 1.0.10 menjadi 1.0.11 dengan source
 * RC-S133.4.8, TANPA `expo export` (registry npm tidak dapat diakses di
 * lingkungan pengerjaan). Cara resmi tetap: `npm run build:renderer` di folder
 * desktop/ source utama.
 *
 * Isi tambalan:
 *   A. Modul source yang di-transpile (TypeScript transpileModule → faktori
 *      Metro `__d(...)`, mekanisme sama dengan tambal-renderer-rc-s133.4.7.js):
 *        - import/ExcelDataAwalParser.ts   (kolom "Satuan Jasa")
 *        - import/PanduanImportData.ts     (peringatan jasa > pokok + ringkasan)
 *        - import/TemplateDataAwal.ts      (kolom template "Satuan Jasa")
 *        - services/RingkasanDashboardService.ts   (BARU)
 *        - services/ClaudeService.ts                (BARU)
 *        - screens/Pengaturan/AsistenClaudeScreen.tsx (BARU)
 *   B. Sisipan berjangkar (gagal keras bila jangkar tidak tepat 1×):
 *        - rute `AsistenClaude` di stack Pengaturan;
 *        - izin rute (pengaturan.view);
 *        - kartu "Asisten Claude" di layar Semua Pengaturan;
 *        - katalog sidebar & Ctrl+K desktop.
 *   C. Dashboard desktop (modul hasil Metro, diubah setara source
 *      DashboardScreen.web.tsx RC-S133.4.8): "Piutang Berjalan" = sisa pokok.
 *
 * Pemakaian:
 *   node scripts/tambal-renderer-rc-s133.4.8.js <renderer> <src RC-S133.4.8> <src RC-S133.4.7> <laporan.json>
 * Bundle masukan harus bundle 1.0.10. Skrip menolak berjalan dua kali.
 */
const fs = require('fs');
const path = require('path');
let ts;
try { ts = require('typescript'); } catch { ts = require(process.env.TYPESCRIPT_PATH || 'typescript'); }
const { indeksEkspor, cariBerkasBundle } = require(path.join(__dirname, '..', 'electron', 'server', 'bundleIndex'));

const [rendererDir, srcBaru, srcAsli, laporanOut] = process.argv.slice(2);
if (!rendererDir || !srcBaru || !srcAsli || !laporanOut) {
  console.error('pakai: node scripts/tambal-renderer-rc-s133.4.8.js <renderer> <src baru> <src asli> <laporan.json>');
  process.exit(2);
}

const BERUBAH = [
  { rel: 'services/RingkasanDashboardService.ts', baru: true },
  { rel: 'services/ClaudeService.ts', baru: true },
  { rel: 'screens/Pengaturan/AsistenClaudeScreen.tsx', baru: true },
  { rel: 'import/ExcelDataAwalParser.ts' },
  { rel: 'import/PanduanImportData.ts' },
  { rel: 'import/TemplateDataAwal.ts' },
];

const berkasBundle = cariBerkasBundle(rendererDir);
let teks = fs.readFileSync(berkasBundle, 'utf8');
if (teks.includes('name:"AsistenClaude"')) {
  console.log('Bundle sudah berisi tambalan RC-S133.4.8:', path.basename(berkasBundle));
  process.exit(0);
}
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
const sumberModul = (id) => { const s = SEG.get(id); return teks.slice(s.mulai, s.akhir); };
/** Id modul yang memuat SEMUA penanda; harus tepat satu. */
function idDenganPenanda(penanda, kecuali = () => false) {
  const ids = [];
  for (const [id, s] of SEG) {
    const isi = teks.slice(s.mulai, s.akhir);
    if (penanda.every((p) => isi.includes(p)) && !kecuali(isi)) ids.push(id);
  }
  if (ids.length !== 1) throw new Error(`penanda ${JSON.stringify(penanda)}: ${ids.length} modul (${ids.join(',')})`);
  return ids[0];
}

// ---------------------------------------------------------------------------
// TABEL react-native & PAKET — dibaca dari modul hasil tambalan sebelumnya
// ---------------------------------------------------------------------------
const RN = {};
const PAKET = {};
/** '@/path' -> id, sebagaimana dipetakan tambalan sebelumnya (dipakai bila nama ekspor mendua, mis. theme/colors). */
const AT = {};
for (const blok of teks.matchAll(/var require=function\(n\)\{switch\(n\)\{(.*?)\}throw new Error\("KOPKU patch/g)) {
  for (const m of blok[1].matchAll(/case "([^"]+)":return ([^;]+);/g)) {
    if (m[1] === 'react-native') {
      for (const k of m[2].matchAll(/(\w+):_\$r\((\d+)\)\.default/g)) {
        if (RN[k[1]] !== undefined && RN[k[1]] !== Number(k[2])) throw new Error(`tabel RN tidak konsisten: ${k[1]}`);
        RN[k[1]] = Number(k[2]);
      }
    } else if (m[1].startsWith('@/')) {
      const id = Number(/\d+/.exec(m[2])[0]);
      if (AT[m[1].slice(2)] !== undefined && AT[m[1].slice(2)] !== id) throw new Error(`pemetaan ${m[1]} tidak konsisten`);
      AT[m[1].slice(2)] = id;
    } else if (!m[1].startsWith('.')) {
      if (PAKET[m[1]] !== undefined && PAKET[m[1]] !== m[2]) throw new Error(`pemetaan paket ${m[1]} tidak konsisten`);
      PAKET[m[1]] = m[2];
    }
  }
}
// Switch: modul RN-web yang sama dengan yang dipakai menu LAN & WhatsApp (diverifikasi displayName).
{
  const { DEPENDENSI } = require('./pasang-menu-lan-wa.js');
  const id = DEPENDENSI.Switch;
  if (!sumberModul(id).replace(/"/g, "'").includes("displayName='Switch'")) throw new Error(`Modul ${id} bukan Switch`);
  RN.Switch = id;
}
for (const n of ['View', 'Text', 'ScrollView', 'TouchableOpacity', 'StyleSheet', 'ActivityIndicator', 'Switch']) {
  if (RN[n] === undefined) throw new Error('komponen react-native tidak terbaca: ' + n);
}
for (const n of ['react', 'react/jsx-runtime', '@expo/vector-icons']) if (!PAKET[n]) throw new Error('paket tidak terbaca: ' + n);

function kandidatNama(nama) {
  let k = null;
  for (const n of nama) {
    const ids = new Set(peta.get(n) || []);
    k = k === null ? ids : new Set([...k].filter((x) => ids.has(x)));
  }
  return [...(k || [])];
}
// expo-secure-store (shim desktop: DPAPI/Keychain lewat jembatan Electron)
{
  const k = kandidatNama(['getItemAsync', 'setItemAsync', 'deleteItemAsync', 'canUseBiometricAuthentication']);
  if (k.length !== 1) throw new Error(`expo-secure-store: ${k.length} kandidat`);
  if (!/secure\.(get|set)\(/.test(sumberModul(k[0]))) throw new Error('modul expo-secure-store bukan shim desktop');
  PAKET['expo-secure-store'] = `_$r(${k[0]})`;
}

// Modul ber-ekspor default saja (tidak terindeks nama) — dikenali lewat isinya.
const MODUL_DEFAULT = {
  // AppTextInput: memakai formUi & ikon multiline; modul theme/form (yang MENGEKSPOR formUi) dikecualikan.
  'components/AppTextInput': idDenganPenanda(['inputIconMultiline', 'formUi', 'onFocus'], (isi) => /defineProperty\(\w+,"formUi"/.test(isi)),
};

function eksporSource(file) {
  const src = fs.readFileSync(file, 'utf8');
  const nama = new Set();
  for (const m of src.matchAll(/^export (?:async )?(?:function\*? |class |const |let )([A-Za-z_$][\w$]*)/gm)) nama.add(m[1]);
  return [...nama];
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

for (const b of BERUBAH) {
  if (b.baru) { b.id = idBaru.get(b.rel.replace(/\.tsx?$/, '')); continue; }
  const k = kandidatNama(eksporSource(path.join(srcAsli, b.rel)));
  if (k.length !== 1) throw new Error(`modul lama ${b.rel}: ${k.length} kandidat`);
  b.id = k[0];
}

function resolveRel(rel, b) {
  if (idBaru.has(rel)) return idBaru.get(rel);
  const ubah = BERUBAH.find((x) => x.rel.replace(/\.tsx?$/, '') === rel);
  if (ubah) return ubah.id;
  if (MODUL_DEFAULT[rel] !== undefined) return MODUL_DEFAULT[rel];
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
    // Bentuk `exports.x=` / `defineProperty(exports,"x"` supaya modul terindeks
    // `indeksEkspor` (server LAN & uji headless), sama seperti tambalan 4.7.
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
  laporan.push({ berkas: b.rel, id: b.id, baru: !!b.baru, require: nama, deps, reactNative: namaRn });
  if (b.baru) tambahan.push(fac);
  else {
    const s = SEG.get(b.id);
    teks = teks.slice(0, s.mulai) + fac + teks.slice(s.akhir);
    SEG = segmenModul(teks);
  }
}
{
  const ekor = /(\n__r\(\d+\);)+\s*$/.exec(teks);
  const pos = ekor ? ekor.index : teks.length;
  teks = teks.slice(0, pos) + '\n' + tambahan.join('\n') + teks.slice(pos);
  SEG = segmenModul(teks);
}

// ---------------------------------------------------------------------------
// B. RUTE, IZIN, MENU, KATALOG
// ---------------------------------------------------------------------------
function ganti(cari, ganti, nama) {
  const n = teks.split(cari).length - 1;
  if (n !== 1) throw new Error(`Jangkar "${nama}" ditemukan ${n}× (harus tepat 1×).`);
  teks = teks.replace(cari, () => ganti);
}
const ID_LAYAR = idBaru.get('screens/Pengaturan/AsistenClaudeScreen');
{
  const jangkarStack = /\(0,(\w+)\.jsx\)\((\w+)\.Screen,\{name:"SinkronPerangkat",component:\w+\.default,options:\{title:[^}]*\}\}\)/;
  const lanStack = /,\(0,\w+\.jsx\)\(\w+\.Screen,\{name:"LanWhatsApp",component:\w+\(\d+\)\.default,options:\{title:'LAN & WhatsApp'\}\}\)/;
  let ms = jangkarStack.exec(teks);
  if (ms) {
    const sesudah = teks.slice(ms.index + ms[0].length);
    const ml = lanStack.exec(sesudah);
    if (ml && ml.index === 0) ms = Object.assign([ms[0] + ml[0], ms[1], ms[2]], { index: ms.index });
  }
  if (!ms) throw new Error('Jangkar stack Pengaturan tidak ditemukan.');
  if (teks.slice(ms.index + 1).search(jangkarStack) >= 0) throw new Error('Jangkar stack Pengaturan ganda.');
  const awalModul = teks.lastIndexOf('__d(function(', ms.index);
  const req = /^__d\(function\(([^)]*)\)/.exec(teks.slice(awalModul, awalModul + 80))[1].split(',')[1];
  const sisip = `,(0,${ms[1]}.jsx)(${ms[2]}.Screen,{name:"AsistenClaude",component:${req}(${ID_LAYAR}).default,options:{title:'Asisten Claude'}})`;
  teks = teks.slice(0, ms.index + ms[0].length) + sisip + teks.slice(ms.index + ms[0].length);
}
const SISIPAN = [
  ['IZIN_RUTE', "SinkronPerangkat:n('backup'),", "AsistenClaude:n('pengaturan'),"],
  [
    'KATALOG',
    "e('Pengaturan','Pengaturan','SinkronPerangkat','Sinkron HP','sync-outline',{ket:'Pasangkan HP lewat QR',sidebar:!0,kata:'pairing qr wifi'}),",
    "e('Pengaturan','Pengaturan','AsistenClaude','Asisten Claude','sparkles-outline',{ket:'Hubungkan ke Claude (AI) \\u2014 tanya jawab data koperasi',sidebar:!0,kata:'ai claude anthropic asisten chat tanya api key'}),",
  ],
  [
    'PengaturanMenu',
    "{route:'SinkronPerangkat',icon:'sync-outline',title:'Sinkron HP',sub:'Pasangkan lewat QR, sinkron otomatis via Wi-Fi lokal',resource:'backup'},",
    "{route:'AsistenClaude',icon:'sparkles-outline',title:'Asisten Claude',sub:'Hubungkan ke Claude (AI) & tanya jawab data koperasi',resource:'pengaturan'},",
  ],
];
// Bila menu LAN & WhatsApp (scripts/pasang-menu-lan-wa.js) sudah terpasang, sisipan
// diletakkan SETELAH sisipan LAN — `lepas()` milik skrip itu (uji regresi test:lan)
// mensyaratkan sisipannya tetap menempel pada jangkarnya.
const SISIPAN_LAN = (() => {
  const s = fs.readFileSync(path.join(__dirname, 'pasang-menu-lan-wa.js'), 'utf8');
  const m = /const SISIPAN = (\[[\s\S]*?\n\]);/.exec(s);
  if (!m) throw new Error('SISIPAN menu LAN tidak terbaca');
  return Object.fromEntries(Function(`return ${m[1]}`)().map(([n, j, x]) => [n, j + x]));
})();
for (const [nama, jangkar, sisip] of SISIPAN) {
  const denganLan = SISIPAN_LAN[nama];
  if (denganLan && teks.includes(denganLan)) ganti(denganLan, denganLan + sisip, nama);
  else ganti(jangkar, jangkar + sisip, nama);
}

// ---------------------------------------------------------------------------
// C. DASHBOARD DESKTOP — Piutang Berjalan = sisa pokok
// ---------------------------------------------------------------------------
const idDash = idDenganPenanda(['Sisa angsuran pinjaman aktif', 'Tunggakan dari Piutang Berjalan']);
{
  const s = SEG.get(idDash);
  let m = teks.slice(s.mulai, s.akhir);
  const ubah = (cari, jadi, nama) => {
    const n = m.split(cari).length - 1;
    if (n !== 1) throw new Error(`Dashboard: jangkar "${nama}" ${n}×`);
    m = m.replace(cari, () => jadi);
  };
  // 1) kueri sisa pokok & sisa jasa (sama dengan source), disisipkan setelah kueri piutang
  const reKueri = /(\w)=await (\w)\.getFirstAsync\(`SELECT COALESCE\(SUM\(aj\.total - aj\.pokok_terbayar - aj\.jasa_terbayar\),0\) as total\\n {9}FROM angsuran_jadwal aj JOIN pinjaman p ON p\.id = aj\.pinjaman_id\\n {9}WHERE p\.status = 'AKTIF' AND \$\{\(0,(\w+)\.sqlJadwalBukanObsolete\)\('aj'\)\}`\),/;
  const mk = reKueri.exec(m);
  if (!mk) throw new Error('Dashboard: kueri piutang tidak ditemukan');
  const [utuh, varPiutang, varDb, varSched] = mk;
  m = m.replace(
    utuh,
    utuh +
      `__kpSisa=await ${varDb}.getFirstAsync(\`SELECT COALESCE(SUM(aj.pokok - aj.pokok_terbayar),0) as pokok, COALESCE(SUM(aj.jasa - aj.jasa_terbayar),0) as jasa\\n         FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id\\n         WHERE p.status = 'AKTIF' AND \${(0,${varSched}.sqlJadwalBukanObsolete)('aj')}\`),`
  );
  ubah(`piutang:${varPiutang}?.total??0,`, `piutang:${varPiutang}?.total??0,piutangPokok:__kpSisa?.pokok??0,sisaJasa:__kpSisa?.jasa??0,`, 'setData');
  // 2) kartu KPI
  const reKpi = /value:\(0,(\w+)\.formatRupiah\)\((\w+)\.piutang\),sub:"Sisa angsuran pinjaman aktif"/;
  const mp = reKpi.exec(m);
  if (!mp) throw new Error('Dashboard: kartu Piutang Berjalan tidak ditemukan');
  const [, vM, vD] = mp;
  m = m.replace(
    mp[0],
    `value:(0,${vM}.formatRupiah)(${vD}.piutangPokok),sub:${vD}.sisaJasa>0?\`Sisa pokok \\u00b7 + jasa terjadwal \${(0,${vM}.formatRupiah)(${vD}.sisaJasa)}\`:'Sisa pokok pinjaman aktif'`
  );
  // 3) statistik kesehatan pinjaman
  ubah('Tunggakan dari Piutang Berjalan', 'Tunggakan dari Sisa Angsuran', 'label statistik');
  const reCat = /\(0,(\w+)\.formatRupiah\)\((\w+)\.piutang\)," piutang berjalan"/;
  const mc = reCat.exec(m);
  if (!mc) throw new Error('Dashboard: catatan statistik tidak ditemukan');
  m = m.replace(mc[0], `(0,${mc[1]}.formatRupiah)(${mc[2]}.piutangPokok)," sisa pokok \\u00b7 ",(0,${mc[1]}.formatRupiah)(${mc[2]}.piutang)," sisa angsuran"`);
  teks = teks.slice(0, s.mulai) + m + teks.slice(s.akhir);
  SEG = segmenModul(teks);
  laporan.push({ berkas: 'screens/Dashboard/DashboardScreen.web.tsx (tambalan berjangkar)', id: idDash, baru: false });
}

fs.writeFileSync(berkasBundle + '.tmp', teks);
fs.renameSync(berkasBundle + '.tmp', berkasBundle);
fs.writeFileSync(
  laporanOut,
  JSON.stringify({ bundle: path.basename(berkasBundle), tabelReactNative: RN, paket: PAKET, modulDefault: MODUL_DEFAULT, idLayarAsistenClaude: ID_LAYAR, modul: laporan }, null, 1)
);
console.log(JSON.stringify(laporan.map((l) => [l.berkas, l.id])));

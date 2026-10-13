'use strict';
/**
 * Menambal bundle renderer KOPKU Desktop 1.0.20 (RC-S133.6.5) menjadi 1.0.21
 * (RC-S133.6.6 — UI/UX popup desktop), TANPA `expo export`; id modul Metro
 * yang dipakai `pasang-menu-lan-wa.js` tetap. Cara resmi tetap
 * `npm run build:renderer` di folder desktop/ source utama.
 *
 * Isi tambalan:
 *  1. MENGGANTI modul `components/AppNotificationHost` (varian .web.tsx) —
 *     dialog notifikasi/konfirmasi bergaya kotak dialog desktop (bilah
 *     judul, isi rata kiri, bilah tombol abu-abu, tombol utama hijau brand,
 *     Batal paling kanan), bukan kartu ala Android.
 *  2. MENYISIPKAN modul `desktop/shims/modal-desktop.js` (id baru) dan
 *     mengalihkan ekspor `default` modul react-native-web `Modal` ke
 *     pembungkusnya: pemilih layar penuh → jendela dialog di tengah, sheet
 *     bawah → dipusatkan, animasi slide → fade. Di build Metro hal yang sama
 *     dilakukan `desktop/shims/react-native.js` (metro.config.js).
 *
 * Pemakaian:
 *   node scripts/tambal-renderer-rc-s133.6.6.js <renderer> <src RC-S133.6.6> <laporan.json> <src lama RC-S133.6.5>
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
  console.error('pakai: node scripts/tambal-renderer-rc-s133.6.6.js <renderer> <src baru> <laporan.json> <src lama> [src lama ...]');
  process.exit(2);
}

// Penanda unik dari source RC-S133.6.6 — tambalan idempoten.
const PENANDA = 'urutkanTombolDesktop';
const berkasBundle = cariBerkasBundle(rendererDir);
let teks = fs.readFileSync(berkasBundle, 'utf8');
if (teks.includes(PENANDA) && teks.includes('__kopkuModalDesktop')) {
  console.log('Bundle sudah berisi tambalan RC-S133.6.6:', path.basename(berkasBundle));
  process.exit(0);
}
if (!teks.includes('tidak boleh sebelum tanggal pengajuan')) throw new Error('Bundle masukan harus 1.0.20 (berisi tambalan RC-S133.6.5).');

const laporan = { bundle: path.basename(berkasBundle), modul: [] };
let SEG = segmenModul(teks);

const PENANDA_DEFAULT = {
  'app/index': ['PIN_DISABLED', 'PIN_LOCKED', "'LOGIN'"],
  'navigation/RootNavigator': ['name:"SinkronPerangkat"', 'name:"UserForm"'],
  'desktop/BingkaiAplikasi': ['Keuangan koperasi yang tertib dan transparan.', 'sidebarAktif'],
  // Layar hanya ber-ekspor default → dikenali dari teks uniknya.
  'screens/Laporan/PerubahanEkuitasScreen': ['Tidak ada mutasi ekuitas pada periode ini.', 'Rekonsiliasi Periode Komparatif ke Posisi Keuangan'],
  'screens/Pengaturan/ImportDataAwalScreen': ['Tombol Import aktif setelah seluruh kesalahan', 'nilai-cut-off'],
  // varian web (.web.tsx) dari dialog notifikasi global
  'components/AppNotificationHost': ['rgba(15,23,32,0.42)', 'Escape'],
  'screens/Pengaturan/RiwayatImportScreen': ['Nama berkas tidak tercatat', 'Log Per Baris'],
  'screens/Laporan/PosisiKeuanganScreen': ['Laporan Posisi Keuangan', 'opsi-saldo-awal-draf'],
  'screens/Laporan/HistoryTransaksiDetailScreen': ['Transaksi tidak ditemukan. Data mungkin sudah dihapus', 'Rincian Jurnal'],
  // 1.0.19: penanda lama ('Batasan Fiskal…') kini juga ada di ReportTableBuilders; pakai teks khas layar.
  'screens/Laporan/KolektibilitasPiutangScreen': ['Juklat SOM No. 3/2025 angka 15', 'Cadangan risiko: Lancar'],
  'screens/Pinjaman/PinjamanDetailScreen': ['Pinjaman tidak ditemukan. Data mungkin sudah dihapus atau ID tidak valid.', 'Batalkan Pinjaman'],
  'screens/Pinjaman/PinjamanFormScreen': ['Tanggal Pengajuan *', 'Tujuan Pinjaman'],
  // 1.0.20 / RC-S133.6.5 — layar ber-ekspor default yang ikut berubah.
  'screens/Laporan/BukuBesarScreen': ['Tidak ada mutasi pada akun & rentang tanggal ini.'],
  'screens/Anggota/AnggotaFormScreen': ['Nomor anggota akan dibuat otomatis saat data disimpan.'],
  'screens/Shu/ShuFormScreen': ['Total persentase harus 100%'],
  'screens/Simpanan/SimpananFormScreen': ['Bukti penempatan dapat dicetak dari detail kontrak.'],
  'screens/Transaksi/BayarAngsuranFormScreen': ['Pembayaran piutang anggota berhasil dicatat.'],
  'screens/Transaksi/TarikSimpananFormScreen': ['Penarikan simpanan sukarela berhasil disimpan.'],
};
const P = bangunPeta(teks, srcLama, PENANDA_DEFAULT);
if (P.konflik.length) throw new Error('Peta modul bertentangan:\n' + P.konflik.join('\n'));

// Modul yang berubah di RC-S133.6.6 (lihat RC-S133.6.6_UI_UX_POPUP_DESKTOP.md).
const BERUBAH = [
  { rel: 'components/AppNotificationHost' }, // varian .web.tsx — dialog notifikasi bergaya desktop
];
function fileBaru(b) {
  const dasar = path.join(srcBaru, 'src', b.rel);
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
  laporan.modul.push({ berkas: path.relative(srcBaru, file), id: b.id, baru: !!b.baru, require: spes.length, reactNative: namaRn });
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
// MODAL DESKTOP — modul baru + pengalihan ekspor react-native-web Modal
// ---------------------------------------------------------------------------
const idModalRnw = P.peta.get('rn:Modal');
const idPerlu = { react: P.peta.get('pkg:react'), View: P.peta.get('rn:View'), Pressable: P.peta.get('rn:Pressable'), StyleSheet: P.peta.get('rn:StyleSheet') };
for (const [k, v] of Object.entries(Object.assign({ Modal: idModalRnw }, idPerlu))) if (v === undefined || !SEG.has(v)) throw new Error(`modul ${k} tidak terpetakan`);
{
  // Pastikan modul rn:Modal memang Modal react-native-web (prop khas + ekspor default lewat getter).
  const s = SEG.get(idModalRnw);
  const badan = teks.slice(s.mulai, s.akhir);
  if (!badan.includes('"animationType","children","onDismiss","onRequestClose","onShow","transparent","visible"')) throw new Error(`modul #${idModalRnw} bukan Modal react-native-web`);
  const re = /Object\.defineProperty\((\w+),"default",\{enumerable:!0,get:function\(\)\{return (\w+)\}\}\)/;
  const m = re.exec(badan);
  if (!m) throw new Error('ekspor default Modal react-native-web tidak dikenali');
  const baru = `Object.defineProperty(${m[1]},"default",{enumerable:!0,get:function(){var w=globalThis.__kopkuModalDesktop;return w&&w.asli===${m[2]}?w.komponen:${m[2]}}})`;
  teks = teks.slice(0, s.mulai) + badan.replace(m[0], baru) + teks.slice(s.akhir);
  SEG = segmenModul(teks);
}
// Id baru di atas id tertinggi (dan bukan 9001 milik layar LAN & WhatsApp).
const ID_MODAL_DESKTOP = Math.max(Math.max(...SEG.keys()) + 1, 9101);
{
  const fileModal = path.join(srcBaru, 'desktop', 'shims', 'modal-desktop.js');
  const sumber = fs.readFileSync(fileModal, 'utf8');
  const deps = [idModalRnw, idPerlu.react, idPerlu.View, idPerlu.Pressable, idPerlu.StyleSheet];
  const fac =
    `__d(function(global,_$r,_$i,_$a,module,exports,_$d){"use strict";` +
    `var buat=(function(){var module={exports:{}};(function(module,exports){\n${sumber}\n})(module,module.exports);return module.exports})();` +
    `var asli=_$r(_$d[0]).default;` +
    `var komponen=buat({React:_$r(_$d[1]),Modal:asli,View:_$r(_$d[2]).default,Pressable:_$r(_$d[3]).default,StyleSheet:_$r(_$d[4]).default});` +
    `globalThis.__kopkuModalDesktop={asli:asli,komponen:komponen};exports.ModalDesktop=komponen;` +
    `\n},${ID_MODAL_DESKTOP},[${deps.join(',')}]);`;
  const ekor = /(\n__r\(\d+\);)+\s*$/.exec(teks);
  if (!ekor) throw new Error('Ekor bundle (__r) tidak dikenali.');
  // Modul dipasang & DIJALANKAN sebelum entry aplikasi (sebelum layar pertama dirender).
  const awalEkor = ekor.index;
  const panggil = /\n__r\((\d+)\);\s*$/.exec(teks);
  teks = teks.slice(0, awalEkor) + '\n' + fac + teks.slice(awalEkor, panggil.index) + `\n__r(${ID_MODAL_DESKTOP});` + teks.slice(panggil.index);
  SEG = segmenModul(teks);
  laporan.modul.push({ berkas: 'desktop/shims/modal-desktop.js', id: ID_MODAL_DESKTOP, baru: true, require: deps.length, reactNative: ['Modal', 'View', 'Pressable', 'StyleSheet'] });
  laporan.modalRnw = idModalRnw;
}

// ---------------------------------------------------------------------------
// PEMERIKSAAN AKHIR
// ---------------------------------------------------------------------------
for (const b of BERUBAH) if (!new RegExp(`\\},${b.id},\\[[0-9,]*\\]\\);`).test(teks)) throw new Error(`modul ${b.rel} (#${b.id}) hilang`);
for (const wajib of [PENANDA, '__kopkuModalDesktop', 'ModalDesktop', 'tidak boleh sebelum tanggal pengajuan', 'getSaldoAwalLedger', 'Catat Penyelesaian']) {
  if (!teks.includes(wajib)) throw new Error(`penanda RC-S133.6.6 tidak ada di bundle: ${wajib}`);
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

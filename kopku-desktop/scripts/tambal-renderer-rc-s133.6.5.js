'use strict';
/**
 * Menambal bundle renderer KOPKU Desktop 1.0.19 menjadi 1.0.20 dengan source
 * RC-S133.6.5 (perbaikan temuan audit KOPKU-AUDIT-TEST-DAMY T-01…T-16, skema
 * TETAP v82 — tanpa migrasi), TANPA `expo export`: menambal di tempat
 * menjaga id modul Metro yang dipakai `pasang-menu-lan-wa.js`. Cara resmi
 * tetap: `npm run build:renderer` di folder desktop/ source utama (lalu
 * pasang ulang menu LAN & WhatsApp).
 *
 * MENGGANTI modul yang berubah di RC-S133.6.5 dan MENYISIPKAN modul baru
 * (pola tambal-renderer-rc-s133.5.js) (TypeScript transpileModule
 * → faktori Metro). Setiap `require` dipetakan lewat scripts/peta-modul-bundle.js
 * (bukti dari bundle, bukan tebakan) — gagal keras bila ada yang tidak
 * terpetakan. Tidak ada rute/menu/izin yang disisipkan.
 *
 * Pemakaian:
 *   node scripts/tambal-renderer-rc-s133.6.5.js <renderer> <src RC-S133.6.5> <laporan.json> <src lama> [src lama 2 ...]
 * <src lama> = source yang cocok dengan bundle masukan (RC-S133.6.4).
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
  console.error('pakai: node scripts/tambal-renderer-rc-s133.6.5.js <renderer> <src baru> <laporan.json> <src lama> [src lama ...]');
  process.exit(2);
}

// Penanda unik dari source RC-S133.6.5 — tambalan idempoten.
const PENANDA = 'tidak boleh sebelum tanggal pengajuan';
const berkasBundle = cariBerkasBundle(rendererDir);
let teks = fs.readFileSync(berkasBundle, 'utf8');
if (teks.includes(PENANDA)) {
  console.log('Bundle sudah berisi tambalan RC-S133.6.5:', path.basename(berkasBundle));
  process.exit(0);
}
if (!teks.includes('Catat Penyelesaian')) throw new Error('Bundle masukan harus 1.0.19 (berisi tambalan RC-S133.6.4).');

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

// Modul yang berubah / baru di RC-S133.6.5 (lihat RC-S133.6.5_PERBAIKAN_TEMUAN_AUDIT_DAMY.md).
// Urutan: modul BARU lebih dulu supaya pemetaan require modul lain menemukannya.
const BERUBAH = [
  { rel: 'utils/tanggalKalender', baru: true },           // T-08/T-10 validator tanggal kalender (murni)
  { rel: 'utils/persen', baru: true },                    // T-02/T-07 parsePersenInput + batas jasa
  { rel: 'hooks/useKirimSekali', baru: true },            // T-11 penjaga kirim-ganda sinkron
  { rel: 'utils/tanggal' },                               // ekspor ulang validator tanggal
  { rel: 'accounting/AccountingEngine' },                 // T-10 createJournal menolak tanggal fiktif
  { rel: 'accounting/Ledger' },                           // T-01 saldo awal Buku Besar
  { rel: 'reports/FinancialReports' },                    // T-01 getSaldoAwalLedger
  { rel: 'export/ReportTableBuilders' },                  // T-01 ekspor Buku Besar + Saldo Awal
  { rel: 'screens/Laporan/BukuBesarScreen' },             // T-01
  { rel: 'accounting/PinjamanCalculator' },               // T-08/T-10 jadwal CUSTOM
  { rel: 'services/PinjamanService' },                    // T-03/T-05/T-07/T-10
  { rel: 'services/SimpananService' },                    // T-03/T-10
  { rel: 'services/UserManagementService' },              // T-09
  { rel: 'repositories/AnggotaRepository' },              // T-10/T-12
  { rel: 'screens/Anggota/AnggotaFormScreen' },           // T-12
  { rel: 'screens/Pinjaman/PinjamanFormScreen' },         // T-02/T-03/T-07
  { rel: 'screens/Shu/ShuFormScreen' },                   // T-02
  { rel: 'screens/Simpanan/SimpananFormScreen' },         // T-03/T-11
  { rel: 'screens/Transaksi/BayarAngsuranFormScreen' },   // T-11
  { rel: 'screens/Transaksi/TarikSimpananFormScreen' },   // T-03/T-11
  { rel: 'import/ExcelDataAwalParser' },                  // T-07/T-13/T-16
  { rel: 'import/TemplateDataAwal' },                     // T-16 kolom Denda per Hari
  { rel: 'import/PanduanImportData' },                    // T-04/T-13 pemeriksaan kewajaran
  { rel: 'import/MigrasiPinjamanPlan' },                  // T-16
  { rel: 'import/EksekusiMigrasiPinjaman' },              // T-16
  { rel: 'import/EksekusiImportDataAwal' },               // T-04/T-16
  { rel: 'database/db' },                                 // T-14 salinan pra-migrasi, migrasiV78
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
// PEMERIKSAAN AKHIR
// ---------------------------------------------------------------------------
for (const b of BERUBAH) if (!new RegExp(`\\},${b.id},\\[[0-9,]*\\]\\);`).test(teks)) throw new Error(`modul ${b.rel} (#${b.id}) hilang`);
for (const wajib of [PENANDA, 'getSaldoAwalLedger', 'parsePersenInput', 'periksaKewajaranImport', 'Denda per Hari', 'cariAnggotaMirip', 'migrasiV82', 'Catat Penyelesaian', 'hitungSidikBerkas']) {
  if (!teks.includes(wajib)) throw new Error(`penanda RC-S133.6.5 tidak ada di bundle: ${wajib}`);
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

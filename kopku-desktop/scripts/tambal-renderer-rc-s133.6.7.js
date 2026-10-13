'use strict';
/**
 * Menambal bundle renderer KOPKU Desktop 1.0.21-perbaikan-audit menjadi 1.0.22 (RC-S133.6.7):
 * perbaikan temuan TERBUKA audit DAMY (F2, F6, F16b, F22, F23, F29) dan temuan audit ulang N1.
 * Hanya modul yang berubah di source RC-S133.6.7 yang diganti (daftar BERUBAH); satu modul baru
 * (utils/tanggalMasaDepan). Cara resmi tetap build renderer dari source RC-S133.6.7.
 *
 * Pemakaian:
 *   node scripts/tambal-renderer-rc-s133.6.7.js <renderer> <src RC-S133.6.7> <laporan.json> <src RC-S133.6.6-DIPERBAIKI>
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
  console.error('pakai: node scripts/tambal-renderer-rc-s133.6.7.js <renderer> <src baru> <laporan.json> <src lama> [src lama ...]');
  process.exit(2);
}

// Penanda unik dari source RC-S133.6.7 — tambalan idempoten.
const PENANDA = 'Lunasi pinjaman terlebih dahulu lewat menu Bayar Piutang Anggota';
const berkasBundle = cariBerkasBundle(rendererDir);
let teks = fs.readFileSync(berkasBundle, 'utf8');
if (teks.includes(PENANDA)) {
  console.log('Bundle sudah berisi tambalan RC-S133.6.7:', path.basename(berkasBundle));
  process.exit(0);
}
if (!teks.includes('belum punya jadwal angsuran, sehingga belum dapat dicairkan')) throw new Error('Bundle masukan harus 1.0.21 yang sudah memuat perbaikan audit DAMY (RC-S133.6.6-DIPERBAIKI).');

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
  'components/AppNotificationHost': ['urutkanTombolDesktop', 'Escape'],
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
  // 1.0.21 + perbaikan audit
  'screens/Laporan/BuktiTransaksiDetailScreen': ['Data bukti tidak ditemukan.', 'Porsi Pokok'],
  // RC-S133.6.7
  'screens/Transaksi/KeluarAnggotaFormScreen': ['Ajukan Keluar Anggota', 'Ringkasan Pengurang'],
};
const P = bangunPeta(teks, srcLama, PENANDA_DEFAULT);
if (P.konflik.length) throw new Error('Peta modul bertentangan:\n' + P.konflik.join('\n'));

// Modul yang berubah pada perbaikan audit (lihat CATATAN-PERBAIKAN-AUDIT.md).
const BERUBAH = [
  { rel: 'utils/tanggalMasaDepan', baru: true },
  { rel: 'accounting/Ledger' },
  { rel: 'import/EksekusiImportDataAwal' },
  { rel: 'reports/FinancialReports' },
  { rel: 'reports/LpeaRepository' },
  { rel: 'services/AccountingPolicyService' },
  { rel: 'services/KeluarAnggotaService' },
  { rel: 'services/KoreksiTransaksiService' },
  { rel: 'services/SaldoAwalAkunService' },
  { rel: 'services/SimpananService' },
  { rel: 'screens/Transaksi/KeluarAnggotaFormScreen' },
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

// (Modul modal-desktop sudah ada di bundle 1.0.21; tidak disentuh.)

// ---------------------------------------------------------------------------
// PEMERIKSAAN AKHIR
// ---------------------------------------------------------------------------
for (const b of BERUBAH) if (!new RegExp(`\\},${b.id},\\[[0-9,]*\\]\\);`).test(teks)) throw new Error(`modul ${b.rel} (#${b.id}) hilang`);
for (const wajib of [PENANDA, '__kopkuModalDesktop', 'belum punya jadwal angsuran, sehingga belum dapat dicairkan', 'tidak boleh setelah hari ini', 'dianggap kiriman ganda', 'Tanggal Neraca Saldo', 'dibukukan otomatis oleh aplikasi', 'jr.tanggal <= ?']) {
  if (!teks.includes(wajib)) throw new Error(`penanda RC-S133.6.7 tidak ada di bundle: ${wajib}`);
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

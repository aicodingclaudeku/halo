'use strict';
/**
 * KOPKU Desktop 1.0.34 — AUDIT MENYELURUH KOLEKTIBILITAS (padanan source RC-S133.6.11).
 *
 * TEMUAN F1 (bug): layar Kolektibilitas Piutang memfilter daftar per status anggota (default AKTIF), lalu
 * memakai TOTAL DAFTAR ITU untuk "Target hasil penggolongan", selisih terhadap buku besar, kalimat konfirmasi
 * "akan disesuaikan ... menjadi Rp X", dan baris ekspor "Penyesuaian penyisihan yang diperlukan". Padahal
 * `sesuaikanPenyisihanPiutang` membukukan target SEMUA anggota (`getTotalPenyisihanTarget`). Bila ada anggota
 * nonaktif dengan pinjaman bermasalah, angka yang dijanjikan ≠ jurnal yang dibuat, dan selisih tidak pernah nol.
 * PERBAIKAN: layar membaca `getTotalPenyisihanTarget` (sumber yang sama dengan jurnal) dan memakainya untuk
 * target/selisih/konfirmasi; ekspor menerima `targetPenyisihanBukuBesar`. Jurnal & rumus TIDAK berubah.
 *
 * TEMUAN F2 (transparansi): `saldoPiutang`/`saldoJasa` mencakup jasa jadwal yang BELUM jatuh tempo, dan item
 * tidak menyebut jumlah angsuran tertunggak. Ditambahkan field TAMBAHAN (tanpa mengubah field lama, penggolongan,
 * atau cadangan): angsuranTertunggak, pokokTertunggak, jasaTertunggak, jasaBelumJatuhTempo — tampil di rincian
 * per pinjaman dan ringkasan ekspor.
 *
 * Tidak mengubah ambang, persentase, skema database, data, atau jurnal yang sudah ada.
 * Prasyarat: tambalan 1.0.33 sudah terpasang. Idempoten. Setiap jangkar wajib cocok TEPAT satu kali.
 * Pemakaian: node scripts/tambal-kolektibilitas-1.0.34.js [folder-renderer]
 */
const fs = require('node:fs');
const path = require('node:path');

const PENANDA = 'KOPKU 1.0.34 kolektibilitas audit';
const PRASYARAT = 'KOPKU 1.0.33 kolektibilitas kalender';

const GANTI = [
  // ---------------------------------------------------------------- LoanImpairmentService (F2)
  [
    'SQL rincian tunggakan',
    'THEN julianday(?) - julianday(aj.tanggal_jatuh_tempo) ELSE 0 END) as hari_max,\n',
    `THEN julianday(?) - julianday(aj.tanggal_jatuh_tempo) ELSE 0 END) as hari_max,
            -- ${PENANDA}: rincian tunggakan (tampilan/audit saja; tidak dipakai penggolongan).
            COUNT(CASE WHEN \${jadwalCurrentJatuhTempo}
                        AND (aj.pokok - aj.pokok_terbayar) + (aj.jasa - aj.jasa_terbayar) > 0 THEN 1 END) as angsuran_tertunggak,
            COALESCE(SUM(CASE WHEN \${jadwalCurrentJatuhTempo} THEN aj.pokok - aj.pokok_terbayar ELSE 0 END), 0) as pokok_tertunggak,
            COALESCE(SUM(CASE WHEN \${jadwalCurrentJatuhTempo} THEN aj.jasa - aj.jasa_terbayar ELSE 0 END), 0) as jasa_tertunggak,
`,
  ],
  [
    'parameter SQL rincian tunggakan',
    'tanggalLaporan, tanggalLaporan, tanggalLaporan, tanggalLaporan, tanggalLaporan, ...paramsAnggota);',
    'tanggalLaporan, tanggalLaporan, tanggalLaporan, tanggalLaporan, tanggalLaporan, tanggalLaporan, tanggalLaporan, tanggalLaporan, ...paramsAnggota);',
  ],
  [
    'field rincian tunggakan',
    'tanggalJatuhTempoTertunggak: r.jatuh_tempo_tertua ?? null,\n',
    `tanggalJatuhTempoTertunggak: r.jatuh_tempo_tertua ?? null,
            angsuranTertunggak: Math.max(0, r.angsuran_tertunggak ?? 0),
            pokokTertunggak: Math.max(0, r.pokok_tertunggak ?? 0),
            jasaTertunggak: Math.max(0, r.jasa_tertunggak ?? 0),
            jasaBelumJatuhTempo: Math.max(0, saldoJasa - Math.max(0, r.jasa_tertunggak ?? 0)),
`,
  ],
  // ---------------------------------------------------------------- ReportTableBuilders (F1 + F2)
  [
    'ekspor: target buku besar & rincian tunggakan',
    `        { label: 'Penyisihan menurut SOM (buku)', nilai: (0, money_1.formatRupiah)(totalCadangan) },
    ];
    if (opsi.penyisihanTercatat !== undefined && opsi.penyisihanTercatat !== null) {
        seksiRingkasan.push({ label: 'Penyisihan tercatat di buku besar', nilai: (0, money_1.formatRupiah)(opsi.penyisihanTercatat) });
        const sel = totalCadangan - opsi.penyisihanTercatat;`,
    `        { label: 'Penyisihan menurut SOM (buku)', nilai: (0, money_1.formatRupiah)(totalCadangan) },
    ];
    // ${PENANDA}: rincian tunggakan (hanya bila item membawanya) & target SEMUA anggota (dasar jurnal).
    if (daftar.length > 0 && daftar.every((d) => typeof d.angsuranTertunggak === 'number')) {
        seksiRingkasan.push({ label: 'Pokok jatuh tempo belum dibayar', nilai: (0, money_1.formatRupiah)(jumlah(daftar, (d) => d.pokokTertunggak ?? 0)) }, { label: 'Jasa jatuh tempo belum dibayar', nilai: (0, money_1.formatRupiah)(jumlah(daftar, (d) => d.jasaTertunggak ?? 0)) }, { label: 'Jasa belum jatuh tempo (dalam saldo piutang)', nilai: (0, money_1.formatRupiah)(jumlah(daftar, (d) => d.jasaBelumJatuhTempo ?? 0)) });
    }
    const targetBukuBesar = opsi.targetPenyisihanBukuBesar !== undefined && opsi.targetPenyisihanBukuBesar !== null ? opsi.targetPenyisihanBukuBesar : totalCadangan;
    if (targetBukuBesar !== totalCadangan) {
        seksiRingkasan.push({ label: 'Target penyisihan buku besar (semua anggota)', nilai: (0, money_1.formatRupiah)(targetBukuBesar) });
    }
    if (opsi.penyisihanTercatat !== undefined && opsi.penyisihanTercatat !== null) {
        seksiRingkasan.push({ label: 'Penyisihan tercatat di buku besar', nilai: (0, money_1.formatRupiah)(opsi.penyisihanTercatat) });
        const sel = targetBukuBesar - opsi.penyisihanTercatat;`,
  ],
  // ---------------------------------------------------------------- KolektibilitasPiutangScreen (F1 + F2)
  [
    'layar: state target buku besar',
    '    const [saldoTercatat, setSaldoTercatat] = (0, react_1.useState)(null);\n',
    `    const [saldoTercatat, setSaldoTercatat] = (0, react_1.useState)(null);
    // ${PENANDA}: target yang AKAN dibukukan sesuaikanPenyisihanPiutang (selalu SEMUA anggota).
    const [targetBukuBesar, setTargetBukuBesar] = (0, react_1.useState)(null);
`,
  ],
  [
    'layar: baca target buku besar',
    `            const saldo = await (0, AccountingEngine_1.getAccountBalance)(db, penyisihanAccountId, tanggalLaporan);
            if (!permintaan.masihTerbaru(token))
                return;
            setSaldoTercatat(saldo);`,
    `            const saldo = await (0, AccountingEngine_1.getAccountBalance)(db, penyisihanAccountId, tanggalLaporan);
            const target = await (0, LoanImpairmentService_1.getTotalPenyisihanTarget)(db, tanggalLaporan);
            if (!permintaan.masihTerbaru(token))
                return;
            setSaldoTercatat(saldo);
            setTargetBukuBesar(target);`,
  ],
  [
    'layar: selisih terhadap target buku besar',
    '    const selisihPenyisihan = saldoTercatat !== null ? ringkasan.totalCadangan - saldoTercatat : 0;',
    `    const targetPenyisihan = targetBukuBesar ?? ringkasan.totalCadangan;
    const selisihPenyisihan = saldoTercatat !== null ? targetPenyisihan - saldoTercatat : 0;
    const lingkupBerbeda = targetBukuBesar !== null && targetBukuBesar !== ringkasan.totalCadangan;`,
  ],
  [
    'layar: kalimat konfirmasi',
    'menjadi ${(0, money_1.formatRupiah)(ringkasan.totalCadangan)} (selisih ${(0, money_1.formatRupiah)(selisihPenyisihan)}) lewat satu jurnal penyesuaian.',
    'menjadi ${(0, money_1.formatRupiah)(targetPenyisihan)} (selisih ${(0, money_1.formatRupiah)(selisihPenyisihan)}) lewat satu jurnal penyesuaian.',
  ],
  [
    'layar: kartu target',
    'children: "Target hasil penggolongan" }), (0, jsx_runtime_1.jsx)(react_native_1.Text, { style: styles.statValue, children: (0, money_1.formatRupiah)(ringkasan.totalCadangan) })] }), (0, jsx_runtime_1.jsx)(react_native_1.View, { style: styles.statDivider }), (0, jsx_runtime_1.jsxs)(react_native_1.View, { style: styles.statCell, children: [(0, jsx_runtime_1.jsx)(react_native_1.Text, { style: styles.statLabel, children: "Tercatat di buku besar" }), (0, jsx_runtime_1.jsx)(react_native_1.Text, { style: styles.statValue, children: saldoTercatat !== null ? (0, money_1.formatRupiah)(saldoTercatat) : \'—\' })] })] }), ',
    'children: "Target hasil penggolongan" }), (0, jsx_runtime_1.jsx)(react_native_1.Text, { style: styles.statValue, children: (0, money_1.formatRupiah)(targetPenyisihan) })] }), (0, jsx_runtime_1.jsx)(react_native_1.View, { style: styles.statDivider }), (0, jsx_runtime_1.jsxs)(react_native_1.View, { style: styles.statCell, children: [(0, jsx_runtime_1.jsx)(react_native_1.Text, { style: styles.statLabel, children: "Tercatat di buku besar" }), (0, jsx_runtime_1.jsx)(react_native_1.Text, { style: styles.statValue, children: saldoTercatat !== null ? (0, money_1.formatRupiah)(saldoTercatat) : \'—\' })] })] }), lingkupBerbeda && ((0, jsx_runtime_1.jsxs)(react_native_1.Text, { style: styles.cardSubtitle, children: ["Target di atas mencakup semua anggota (dasar jurnal penyesuaian). Pinjaman yang tampil pada lingkup ini: ", (0, money_1.formatRupiah)(ringkasan.totalCadangan), "."] })), ',
  ],
  [
    'layar: ekspor membawa target buku besar',
    '                                    penyisihanTercatat: saldoTercatat,\n',
    `                                    penyisihanTercatat: saldoTercatat,
                                    targetPenyisihanBukuBesar: targetBukuBesar,
`,
  ],
  [
    'layar: rincian tunggakan per pinjaman',
    '(0, jsx_runtime_1.jsx)(DetailBaris, { label: "Saldo piutang (pokok + jasa)", nilai: (0, money_1.formatRupiah)(item.saldoPiutang) }), ',
    '(0, jsx_runtime_1.jsx)(DetailBaris, { label: "Saldo piutang (pokok + jasa)", nilai: (0, money_1.formatRupiah)(item.saldoPiutang) }), item.angsuranTertunggak !== undefined && ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(DetailBaris, { label: "Angsuran jatuh tempo belum lunas", nilai: `${item.angsuranTertunggak} angsuran — pokok ${(0, money_1.formatRupiah)(item.pokokTertunggak ?? 0)}, jasa ${(0, money_1.formatRupiah)(item.jasaTertunggak ?? 0)}` }), (0, jsx_runtime_1.jsx)(DetailBaris, { label: "Jasa belum jatuh tempo (termasuk dalam saldo piutang di atas)", nilai: (0, money_1.formatRupiah)(item.jasaBelumJatuhTempo ?? 0) })] })), ',
  ],
];

function tambal(teks) {
  if (teks.includes(PENANDA)) return { teks, sudah: true, diganti: [] };
  if (!teks.includes(PRASYARAT)) throw new Error('Tambalan 1.0.33 (kolektibilitas kalender) belum terpasang — jalankan tambal-kolektibilitas-1.0.33.js dulu.');
  const diganti = [];
  for (const [nama, cari, baru] of GANTI) {
    const n = teks.split(cari).length - 1;
    if (n !== 1) throw new Error(`Jangkar "${nama}" ditemukan ${n}× (harus tepat 1×). Bundle berbeda dari yang diharapkan — tidak ada yang diubah.`);
    teks = teks.replace(cari, () => baru);
    diganti.push(nama);
  }
  return { teks, sudah: false, diganti };
}

function main() {
  const root = path.join(__dirname, '..');
  const dir = path.join(path.resolve(process.argv[2] || path.join(root, 'renderer')), '_expo', 'static', 'js', 'web');
  const berkas = fs.readdirSync(dir).filter((f) => /^entry-.*\.js$/.test(f));
  if (berkas.length !== 1) throw new Error(`Bundle tidak ditemukan/ganda di ${dir}`);
  const file = path.join(dir, berkas[0]);
  const asli = fs.readFileSync(file, 'utf8');
  const { teks, sudah, diganti } = tambal(asli);
  if (sudah) {
    console.log('Perbaikan kolektibilitas 1.0.34 sudah terpasang:', berkas[0]);
    return;
  }
  new (require('node:vm').Script)(teks, { filename: berkas[0] });
  fs.writeFileSync(file + '.tmp', teks);
  fs.renameSync(file + '.tmp', file);
  console.log(`Perbaikan kolektibilitas 1.0.34 terpasang (${diganti.length} penggantian): ${berkas[0]}`);
}

if (require.main === module) main();
module.exports = { tambal, PENANDA, GANTI };

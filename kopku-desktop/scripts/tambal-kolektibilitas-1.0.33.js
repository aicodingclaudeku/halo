'use strict';
/**
 * KOPKU Desktop 1.0.33 — PERBAIKAN KOLEKTIBILITAS: batas "melampaui N bulan" (Juklak Deputi Bidang
 * Pengawasan Koperasi No. 3/2025 / SOM angka 12.1) dihitung dengan TANGGAL KALENDER, bukan bulan penuh
 * yang dibulatkan ke bawah.
 *
 * AKAR MASALAH (modul KolektibilitasSomService + LoanImpairmentService di bundle renderer):
 *   - `getKlasifikasiPinjamanAktif` menghitung usia tunggakan dengan `bulanPenuhAntara()` = bulan PENUH
 *     (dibulatkan ke bawah): jatuh tempo 5 Jul → 14 Okt (101 hari) = 3.
 *   - `klasifikasikanSom` lalu menguji `bulan <= 3` → "belum melampaui 3 bulan" → LANCAR.
 *   Padahal 14 Okt sudah MELAMPAUI 3 bulan sejak 5 Jul (batasnya 5 Okt). Akibatnya pinjaman bulanan dengan
 *   tunggakan 3 bulan + 1..30 hari (±92–121 hari) tetap Lancar, penyisihan SOM 0%, cadangan fiskal 0,5%.
 *   Kesalahan yang sama berlaku pada batas atas ("belum melampaui 6/12 bulan") dan pinjaman tanpa angsuran.
 *
 * PERBAIKAN (tidak mengubah ambang, persentase, skema database, atau data):
 *   - `bulanTunggakanTepat(dari, ke)`: usia dalam bulan KALENDER dengan pecahan; tepat N bulan → N,
 *     lewat sehari → N + pecahan. Maka "melampaui N bulan" ⇔ nilai > N dan "belum melampaui N" ⇔ nilai ≤ N.
 *   - `klasifikasikanSom` membandingkan nilai TEPAT itu; pembulatan ke bawah hanya untuk teks & hitungan
 *     21 bulan Diragukan → Macet.
 *   - Kolom tampilan `bulanTunggakanPokok/Jasa` tetap bilangan bulat (layar & export tidak berubah bentuk).
 *
 * Idempoten: dijalankan ulang → "sudah terpasang". Setiap penggantian wajib cocok TEPAT satu kali.
 * Pemakaian: node scripts/tambal-kolektibilitas-1.0.33.js [folder-renderer]
 */
const fs = require('node:fs');
const path = require('node:path');

const PENANDA = 'KOPKU 1.0.33 kolektibilitas kalender';

const GANTI = [
  // ---------------------------------------------------------------- modul KolektibilitasSomService
  [
    'ekspor bulanTunggakanTepat',
    'exports.bulanPenuhAntara=bulanPenuhAntara;\n',
    'exports.bulanPenuhAntara=bulanPenuhAntara;\nexports.bulanTunggakanTepat=bulanTunggakanTepat;\n',
  ],
  [
    'fungsi bulanTunggakanTepat',
    '    return Math.max(0, bulan);\n}\nfunction tingkatTunggakan(bulan, lewatBulan, batasAtasBulan) {',
    `    return Math.max(0, bulan);
}
/**
 * ${PENANDA} — usia tunggakan dalam BULAN KALENDER, dengan pecahan.
 * Tepat N bulan (tanggal sama, atau akhir bulan bila tanggalnya tidak ada) → N; lewat 1 hari → N + pecahan.
 * Dengan demikian "melampaui N bulan" ⇔ hasil > N, dan "belum melampaui N bulan" ⇔ hasil ≤ N — bacaan harfiah
 * Juklak SOM 3/2025 angka 12.1. Contoh: jatuh tempo 5 Jul, tanggal laporan 14 Okt → 3,29 (melampaui 3 bulan
 * sejak 5 Okt); jatuh tempo 14 Jul → tepat 3 (belum melampaui).
 */
function tambahBulanKalender(y, m, d, n) {
    const t = new Date(y, m + n, 1);
    const akhir = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    return new Date(t.getFullYear(), t.getMonth(), Math.min(d, akhir));
}
function bulanTunggakanTepat(dariIso, keIso) {
    const dari = new Date(\`\${dariIso}T00:00:00\`);
    const ke = new Date(\`\${keIso}T00:00:00\`);
    if (Number.isNaN(dari.getTime()) || Number.isNaN(ke.getTime()))
        return 0;
    if (ke <= dari)
        return 0;
    const y = dari.getFullYear(), m = dari.getMonth(), d = dari.getDate();
    let n = Math.max(0, (ke.getFullYear() - y) * 12 + (ke.getMonth() - m) - 1);
    while (tambahBulanKalender(y, m, d, n + 1) <= ke)
        n += 1;
    const batas = tambahBulanKalender(y, m, d, n);
    if (ke.getTime() === batas.getTime())
        return n;
    const berikut = tambahBulanKalender(y, m, d, n + 1);
    const pecahan = (ke.getTime() - batas.getTime()) / (berikut.getTime() - batas.getTime());
    return n + Math.min(0.999, Math.max(0.001, pecahan));
}
function teksBulanTunggakan(b) {
    const bulat = Math.floor(b);
    return b > bulat ? \`\${bulat} bulan lebih\` : \`\${bulat} bulan\`;
}
function tingkatTunggakan(bulan, lewatBulan, batasAtasBulan) {`,
  ],
  [
    'tanpa angsuran — sudah jatuh tempo',
    `            const bulan = Math.max(0, Math.floor(input.bulanSejakJatuhTempo));
            batasAtasBulan = exports.AMBANG_SOM_TANPA_ANGSURAN.setelahJatuhTempoBatasAtasBulan;
            // "telah jatuh tempo dan belum dibayar tetapi belum melampaui 3
            // bulan" — jatuh tempo yang baru terlewati (0 bulan) sudah masuk
            // Kurang Lancar, karena pinjamannya memang sudah harus lunas.
            tingkat = bulan <= batasAtasBulan ? 1 : 2;
            uraianTunggakan = \`pinjaman tanpa angsuran sudah jatuh tempo \${bulan} bulan dan belum dibayar\`;`,
    `            const bulan = Math.max(0, input.bulanSejakJatuhTempo);
            batasAtasBulan = exports.AMBANG_SOM_TANPA_ANGSURAN.setelahJatuhTempoBatasAtasBulan;
            // "telah jatuh tempo dan belum dibayar tetapi belum melampaui 3
            // bulan" — jatuh tempo yang baru terlewati (0 bulan) sudah masuk
            // Kurang Lancar, karena pinjamannya memang sudah harus lunas.
            // 1.0.33: dibandingkan dengan usia TEPAT (kalender), bukan bulan penuh dibulatkan.
            tingkat = bulan <= batasAtasBulan ? 1 : 2;
            uraianTunggakan = \`pinjaman tanpa angsuran sudah jatuh tempo \${teksBulanTunggakan(bulan)} dan belum dibayar\`;`,
  ],
  [
    'tanpa angsuran — belum jatuh tempo',
    `            const bulan = Math.max(0, Math.floor(input.bulanTunggakanJasa));
            batasAtasBulan = exports.AMBANG_SOM_TANPA_ANGSURAN.jasaBatasAtasBulan;
            tingkat = tingkatTunggakan(bulan, exports.AMBANG_SOM_TANPA_ANGSURAN.jasaLewatBulan, batasAtasBulan);
            uraianTunggakan = \`pinjaman tanpa angsuran belum jatuh tempo, tunggakan bunga \${bulan} bulan\`;`,
    `            const bulan = Math.max(0, input.bulanTunggakanJasa);
            batasAtasBulan = exports.AMBANG_SOM_TANPA_ANGSURAN.jasaBatasAtasBulan;
            tingkat = tingkatTunggakan(bulan, exports.AMBANG_SOM_TANPA_ANGSURAN.jasaLewatBulan, batasAtasBulan);
            uraianTunggakan = \`pinjaman tanpa angsuran belum jatuh tempo, tunggakan bunga \${teksBulanTunggakan(bulan)}\`;`,
  ],
  [
    'dengan angsuran — pokok & jasa',
    `        const bulanPokok = Math.max(0, Math.floor(input.bulanTunggakanPokok));
        const bulanJasa = Math.max(0, Math.floor(input.bulanTunggakanJasa));`,
    `        // 1.0.33: usia TEPAT (kalender) — tidak dibulatkan sebelum dibandingkan dengan ambang.
        const bulanPokok = Math.max(0, input.bulanTunggakanPokok);
        const bulanJasa = Math.max(0, input.bulanTunggakanJasa);`,
  ],
  ['teks tunggakan bunga', '            uraianTunggakan = `tunggakan bunga ${bulanJasa} bulan`;', '            uraianTunggakan = `tunggakan bunga ${teksBulanTunggakan(bulanJasa)}`;'],
  ['teks tunggakan pokok', '            uraianTunggakan = `tunggakan pokok ${bulanPokok} bulan`;', '            uraianTunggakan = `tunggakan pokok ${teksBulanTunggakan(bulanPokok)}`;'],
  [
    'lama digolongkan Diragukan',
    `    const usiaTunggakan = input.polaPengembalian === 'TANPA_ANGSURAN' && input.sudahJatuhTempo
        ? Math.max(0, Math.floor(input.bulanSejakJatuhTempo))
        : Math.max(Math.floor(Math.max(0, input.bulanTunggakanPokok)), Math.floor(Math.max(0, input.bulanTunggakanJasa)));
    const bulanSejakDiragukan = Math.max(0, usiaTunggakan - batasAtasBulan);`,
    `    const usiaTunggakan = input.polaPengembalian === 'TANPA_ANGSURAN' && input.sudahJatuhTempo
        ? Math.max(0, input.bulanSejakJatuhTempo)
        : Math.max(Math.max(0, input.bulanTunggakanPokok), Math.max(0, input.bulanTunggakanJasa));
    // Bulan PENUH sejak melewati batas atas Kurang Lancar (dasar kriteria Macet 21 bulan).
    const bulanSejakDiragukan = Math.max(0, Math.floor(usiaTunggakan - batasAtasBulan));`,
  ],
  // ---------------------------------------------------------------- modul LoanImpairmentService (pemanggil)
  [
    'pemanggil — usia tepat',
    `        const bulanSejakJatuhTempo = jatuhTempoPinjaman && sudahJatuhTempo ? (0, KolektibilitasSomService_1.bulanPenuhAntara)(jatuhTempoPinjaman, tanggalLaporan) : 0;`,
    `        const bulanSejakJatuhTempo = jatuhTempoPinjaman && sudahJatuhTempo ? (0, KolektibilitasSomService_1.bulanPenuhAntara)(jatuhTempoPinjaman, tanggalLaporan) : 0;
        // 1.0.33 — usia TEPAT (bulan kalender + pecahan) untuk penggolongan; kolom bulan di atas tetap bulat untuk tampilan.
        const usiaTepat = (tgl) => (tgl ? (0, KolektibilitasSomService_1.bulanTunggakanTepat)(String(tgl), tanggalLaporan) : 0);`,
  ],
  [
    'pemanggil — masukan klasifikasi',
    `            bulanTunggakanPokok,
            bulanTunggakanJasa,
            sudahJatuhTempo,
            bulanSejakJatuhTempo,`,
    `            bulanTunggakanPokok: usiaTepat(r.jatuh_tempo_pokok_tertua),
            bulanTunggakanJasa: usiaTepat(r.jatuh_tempo_jasa_tertua),
            sudahJatuhTempo,
            bulanSejakJatuhTempo: sudahJatuhTempo ? usiaTepat(jatuhTempoPinjaman) : 0,`,
  ],
];

function tambal(teks) {
  if (teks.includes(PENANDA)) return { teks, sudah: true, diganti: [] };
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
    console.log('Perbaikan kolektibilitas 1.0.33 sudah terpasang:', berkas[0]);
    return;
  }
  // Pemeriksaan sintaks sebelum menulis.
  new (require('node:vm').Script)(teks, { filename: berkas[0] });
  fs.writeFileSync(file + '.tmp', teks);
  fs.renameSync(file + '.tmp', file);
  console.log(`Perbaikan kolektibilitas 1.0.33 terpasang (${diganti.length} penggantian): ${berkas[0]}`);
}

if (require.main === module) main();
module.exports = { tambal, PENANDA, GANTI };

import { CSS_IDENTITAS_CETAK, htmlIdentitasCetak } from './IdentitasCetak';
import { DataLaporanExport } from './ExportTypes';
import { formatRupiah } from '@/utils/money';
import { buildDokumenSeksiHtml } from './DokumenSeksiHtml';
import { getWaktuSekarang } from '@/services/DevClockService';
import { teksPdf } from './TeksPdf';
import { angkaJuklat, type TampilanJuklat } from './JuklatPdf';
import { formatTanggalIndonesia } from '@/utils/reportPeriod';
import { toTanggalLokal } from '@/utils/tanggal';

/**
 * Builder HTML laporan MURNI (string in, string out) — dipakai
 * expo-print (Print.printToFileAsync) untuk menghasilkan PDF (fase 6:
 * "header laporan profesional", "informasi koperasi", "periode
 * laporan", "format angka Rupiah").
 */

function escapeHtml(value: string | number): string {
  // Poin 2 — teks PDF: tanpa label standar akuntansi, tanggal ISO -> "4 Oktober 2026".
  return teksPdf(String(value))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSel(value: string | number, kolomAngka: number[], idx: number): string {
  if (kolomAngka.includes(idx) && typeof value === 'number') {
    return formatRupiah(value);
  }
  return escapeHtml(value);
}

/**
 * Poin 13/14 — blok tanda tangan Pengurus (Ketua, Sekretaris, Bendahara).
 * Nama diisi `ExportService` dari data Pengurus; bila belum ada, dicetak
 * garis titik-titik untuk diisi tangan — TIDAK pernah nama karangan.
 * Satu blok `break-inside: avoid` supaya tidak terpotong page break.
 */
const JABATAN_TTD_DEFAULT = ['Ketua', 'Sekretaris', 'Bendahara'];

function blokTandaTangan(data: DataLaporanExport): string {
  const lk = data.laporanKeuangan;
  if (!lk) return '';
  const penanda =
    lk.penandaTangan && lk.penandaTangan.length > 0
      ? lk.penandaTangan
      : JABATAN_TTD_DEFAULT.map((jabatan) => ({ jabatan, nama: null }));
  const kolom = penanda
    .map(
      (p) => `<td>
          <div class="ttd-jabatan">${escapeHtml(p.jabatan)}</div>
          <div class="ttd-ruang"></div>
          <div class="ttd-nama">${p.nama && p.nama.trim() ? escapeHtml(p.nama) : '(.................................)'}</div>
          <div class="ttd-garis"></div>
          <div class="ttd-sub">${escapeHtml(p.jabatan)}</div>
        </td>`
    )
    .join('');
  return `<div class="ttd-blok">
      <div class="ttd-pengantar">Disahkan oleh Pengurus ${escapeHtml(data.namaKoperasi)}</div>
      <table class="ttd"><tr>${kolom}</tr></table>
    </div>`;
}

/**
 * LAPORAN KEUANGAN — FORMAT LAMPIRAN JUKLAT SOM 2025.
 * Kop (nama koperasi, judul, periode) di dalam tabel bergaris, kolom
 * tahun lama → baru, angka tanpa "Rp" dengan kurung untuk pengurang.
 * Kop + judul kolom berada di <thead> sehingga ikut berulang bila tabel
 * berlanjut ke halaman berikutnya; baris tidak pernah terpotong.
 */
function buildLaporanJuklatHtml(data: DataLaporanExport, t: TampilanJuklat, tanggalCetak: string): string {
  const jumlahKolom = 1 + Math.max(t.kolom.length, 1);
  const naratif = t.kolom.length === 0;
  const kelasTingkat: Record<string, string> = {
    JUDUL: 'sub-header',
    RINCIAN: 'rincian',
    KONTRA: 'rincian kontra',
    SUBTOTAL: 'subtotal',
    TOTAL: 'total',
    PARAGRAF: 'paragraf',
  };
  const kop = `<tr class="kop"><td colspan="${jumlahKolom}">
      ${data.logoDataUri ? `<img class="kop-logo-juklat" src="${data.logoDataUri}" alt="Logo koperasi" />` : ''}
      <div class="kop-nama">${escapeHtml(data.namaKoperasi)}</div>
      <div class="kop-judul">${escapeHtml(t.judul)}</div>
      <div class="kop-periode">${escapeHtml(t.periode)}</div>
    </td></tr>`;
  const kepala = naratif
    ? ''
    : `<tr class="kepala"><th></th>${t.kolom.map((k) => `<th class="num">${escapeHtml(k)}</th>`).join('')}</tr>`;
  const isi = t.baris
    .map((b) => {
      const kelas = kelasTingkat[b.tingkat] ?? '';
      if (b.tingkat === 'PARAGRAF') {
        return `<tr class="${kelas}"><td colspan="${jumlahKolom}">${escapeHtml(b.teks ?? '')}</td></tr>`;
      }
      if (naratif) return `<tr class="${kelas}"><td colspan="${jumlahKolom}">${escapeHtml(b.label)}</td></tr>`;
      const sel = t.kolom
        .map((_, i) => {
          const teks = b.nilaiTeks?.[i];
          return `<td class="num">${teks ? escapeHtml(teks) : angkaJuklat(b.nilai[i] ?? null)}</td>`;
        })
        .join('');
      return `<tr class="${kelas}"><td>${escapeHtml(b.label)}</td>${sel}</tr>`;
    })
    .join('');
  const keterangan = (t.keterangan ?? [])
    .map(
      (k) => `<div class="ket-blok">${k.judul ? `<div class="ket-judul">${escapeHtml(k.judul)}</div>` : ''}${k.baris
        .map((x) => `<div class="ket-baris">${escapeHtml(x)}</div>`)
        .join('')}</div>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body.lk { font-family: 'Bookman Old Style', 'Bookman', 'URW Bookman L', 'URW Bookman', Georgia, 'Times New Roman', serif;
    color: #000; padding: 32px 36px; font-size: 10.5pt; }
  table.juklat { width: 100%; border-collapse: collapse; }
  table.juklat td, table.juklat th { border: 1px solid #000; padding: 2px 6px; vertical-align: top; line-height: 1.35; }
  table.juklat thead { display: table-header-group; }
  table.juklat tr { break-inside: avoid; page-break-inside: avoid; }
  tr.kop td { padding: 5px 6px 6px 6px; }
  .kop-nama { font-weight: 700; text-transform: uppercase; }
  .kop-judul { font-weight: 700; }
  .kop-periode { font-weight: 400; }
  .kop-logo-juklat { float: right; width: 42px; height: 42px; object-fit: contain; margin-left: 8px; }
  tr.kepala th { font-weight: 700; text-align: center; }
  th.num, td.num { width: 21%; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  tr.kepala th.num { text-align: center; }
  tr.sub-header td { font-weight: 700; }
  tr.rincian td:first-child { padding-left: 6px; }
  tr.rincian.kontra td:first-child { padding-left: 14px; }
  tr.subtotal td { font-weight: 700; }
  tr.subtotal td:first-child { padding-left: 20px; }
  tr.total td { font-weight: 700; }
  tr.paragraf td { text-align: justify; white-space: pre-line; padding: 4px 6px 8px 6px; }
  .ket-blok { margin-top: 14px; break-inside: avoid; page-break-inside: avoid; }
  .ket-judul { font-weight: 400; }
  .ket-baris { padding-left: 18px; }
  .ttd-blok { margin-top: 32px; break-inside: avoid; page-break-inside: avoid; }
  .ttd-pengantar { font-size: 10.5pt; margin-bottom: 6px; text-align: center; }
  table.ttd { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.ttd td { width: 33.33%; text-align: center; vertical-align: top; padding: 0 10px; border: none; }
  .ttd-jabatan { font-weight: 700; }
  .ttd-ruang { height: 70px; }
  .ttd-nama { font-weight: 700; min-height: 14px; overflow-wrap: anywhere; }
  .ttd-garis { border-bottom: 1px solid #000; margin: 2px 14px 3px 14px; }
  .ttd-sub { font-size: 9.5pt; color: #333; }
${CSS_IDENTITAS_CETAK}
</style>
</head>
<body class="lk">
  <table class="juklat">
    <thead>${kop}${kepala}</thead>
    <tbody>${isi || `<tr><td colspan="${jumlahKolom}" style="text-align:center;padding:12px;">Tidak ada data</td></tr>`}</tbody>
  </table>
  ${keterangan}
  ${blokTandaTangan(data)}
  ${htmlIdentitasCetak(tanggalCetak)}
</body>
</html>`;
}

export function buildReportHtml(data: DataLaporanExport): string {
  // RC-S95 — "Dicetak pada" mengikuti jam aplikasi, konsisten dengan tanggal
  // laporan & dokumen akad saat Mode Pengujian Waktu aktif.
  // Poin 2 — format Indonesia eksplisit ("4 Oktober 2026 pukul 09.30"),
  // tidak bergantung pada dukungan Intl/locale mesin JS perangkat.
  const sekarang = getWaktuSekarang();
  const jamMenit = `${String(sekarang.getHours()).padStart(2, '0')}.${String(sekarang.getMinutes()).padStart(2, '0')}`;
  const tanggalCetak = `${formatTanggalIndonesia(toTanggalLokal(sekarang))} pukul ${jamMenit}`;

  // RC-S83 — dokumen berseksi (mis. Detail Anggota) memakai template
  // dokumen A4 tersendiri. Laporan tanpa `seksi` tidak terpengaruh.
  if (data.seksi && data.seksi.length > 0) {
    return buildDokumenSeksiHtml(data, tanggalCetak);
  }
  // Laporan keuangan pokok: tampilan STANDAR (bawaan). Format contoh
  // laporan Juklat SOM 2025 hanya bila pengguna memilihnya di lembar Export.
  if (data.laporanKeuangan?.juklat && data.laporanKeuangan.gayaPdf === 'JUKLAT') {
    return buildLaporanJuklatHtml(data, data.laporanKeuangan.juklat, tanggalCetak);
  }

  const headerKolom = data.kolom
    .map((k, idx) => `<th class="${data.kolomAngka.includes(idx) ? 'num' : ''}">${escapeHtml(k)}</th>`)
    .join('');

  const barisTabel = data.baris
    .map((row, rowIdx) => {
      // RC-S98 — kalau builder mengisi `tingkatBaris`, hierarki dibaca dari
      // sana; kalau tidak, tebakan lama (kolom kedua kosong = band judul)
      // dipakai APA ADANYA supaya laporan lain tidak berubah tampilannya.
      const tingkat = data.tingkatBaris?.[rowIdx];
      const isSubHeader = tingkat ? tingkat === 'JUDUL' : row.length >= 1 && row[1] === '' && typeof row[0] === 'string';
      const kelas = [
        isSubHeader ? 'sub-header' : '',
        tingkat === 'RINCIAN' ? 'rincian' : '',
        tingkat === 'SUBTOTAL' ? 'subtotal' : '',
        tingkat === 'TOTAL' ? 'total' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const cells = row
        .map((cell, idx) => `<td class="${data.kolomAngka.includes(idx) ? 'num' : ''}">${formatSel(cell, data.kolomAngka, idx)}</td>`)
        .join('');
      return `<tr class="${kelas}">${cells}</tr>`;
    })
    .join('');

  // RC-S104 — catatan kaki bernomor, dicetak di bawah ringkasan.
  const catatanHtml = data.catatanKaki?.length
    ? `<div class="catatan-kaki">
        <div class="catatan-judul">Catatan Penyajian</div>
        <ol>${data.catatanKaki.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ol>
       </div>`
    : '';
  const ringkasanHtml = data.ringkasan?.length
    ? `<table class="ringkasan">
        ${data.ringkasan.map((r) => `<tr><td class="label">${escapeHtml(r.label)}</td><td class="nilai">${escapeHtml(r.nilai)}</td></tr>`).join('')}
       </table>`
    : '';

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #222; padding: 24px; font-size: 12px; }
  .header { border-bottom: 2px solid #1B5E20; padding-bottom: 12px; margin-bottom: 16px; }
  /* RC-S100 — logo di kiri, identitas di kanannya. Tanpa logo, blok
     identitas tetap di posisi yang sama seperti sebelumnya. */
  .header .header-atas { display: flex; align-items: center; gap: 12px; }
  .header .logo { width: 56px; height: 56px; object-fit: contain; flex: 0 0 auto; }
  .header .identitas { flex: 1 1 auto; min-width: 0; }
  .header .nama-koperasi { font-size: 18px; font-weight: 700; color: #1B5E20; }
  .header .alamat { font-size: 11px; color: #666; margin-top: 2px; }
  .header .judul { font-size: 15px; font-weight: 700; margin-top: 12px; }
  .header .periode { font-size: 12px; color: #444; margin-top: 2px; }
  table.data { width: 100%; border-collapse: collapse; margin-top: 8px; }
  table.data th { background: #1B5E20; color: #fff; text-align: left; padding: 6px 8px; font-size: 11px; }
  table.data td { border-bottom: 1px solid #EEE; padding: 6px 8px; font-size: 11px; }
  table.data th.num, table.data td.num { text-align: right; }
  tr.sub-header td { font-weight: 700; background: #F0F0F0; }
  /* RC-S98 — hierarki baris laporan berlapis (lihat TingkatBarisLaporan). */
  tr.rincian td:first-child { padding-left: 22px; }
  tr.subtotal td { font-weight: 700; border-top: 1px solid #BBB; }
  tr.total td { font-weight: 700; font-size: 12px; background: #EDF4ED; border-top: 2px solid #1B5E20; border-bottom: 2px solid #1B5E20; }
  div.catatan-kaki { margin-top: 14px; border-top: 1px solid #CCC; padding-top: 8px; }
  div.catatan-kaki .catatan-judul { font-weight: 700; font-size: 11px; margin-bottom: 4px; }
  div.catatan-kaki ol { margin: 0; padding-left: 16px; }
  div.catatan-kaki li { font-size: 10px; line-height: 1.5; color: #444; margin-bottom: 3px; }
  table.ringkasan { margin-top: 16px; border-top: 2px solid #1B5E20; padding-top: 8px; }
  table.ringkasan td.label { font-weight: 700; padding: 3px 8px 3px 0; font-size: 12px; }
  table.ringkasan td.nilai { padding: 3px 0; font-size: 12px; text-align: right; }
${CSS_IDENTITAS_CETAK}
  /* Poin 13 — baris tabel tidak dipecah; header tabel berulang tiap halaman. */
  table.data thead { display: table-header-group; }
  table.data tr { break-inside: avoid; page-break-inside: avoid; }
  table.data td.num, table.data th.num { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .ttd-blok { margin-top: 32px; break-inside: avoid; page-break-inside: avoid; }
  .ttd-pengantar { font-size: 11px; color: #333; margin-bottom: 6px; text-align: center; }
  table.ttd { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.ttd td { width: 33.33%; text-align: center; vertical-align: top; padding: 0 10px; }
  .ttd-jabatan { font-size: 11px; font-weight: 700; letter-spacing: 0.4px; }
  .ttd-ruang { height: 70px; }
  .ttd-nama { font-size: 11px; font-weight: 700; min-height: 14px; overflow-wrap: anywhere; }
  .ttd-garis { border-bottom: 1px solid #222; margin: 2px 14px 3px 14px; }
  .ttd-sub { font-size: 10px; color: #555; }

  /* Poin 15 — gaya formal laporan keuangan (LPK, LPHU, LPE, LAK, CALK,
     termasuk komparatif): kop di tengah, garis tipis, tanpa band/kotak berat. */
  body.lk { padding: 28px 30px; font-size: 11px; color: #1f2328; }
  body.lk .header { border-bottom: 1.5px solid #1f2328; padding-bottom: 10px; margin-bottom: 14px; text-align: center; }
  body.lk .header .header-atas { justify-content: center; }
  body.lk .header .identitas { flex: 0 1 auto; }
  body.lk .header .nama-koperasi { font-size: 16px; color: #1f2328; letter-spacing: 0.3px; text-transform: uppercase; }
  body.lk .header .judul { font-size: 14px; margin-top: 10px; text-transform: uppercase; letter-spacing: 0.8px; }
  body.lk .header .periode { font-size: 11px; color: #4a545e; margin-top: 3px; }
  body.lk table.data { margin-top: 4px; }
  body.lk table.data th { background: transparent; color: #1f2328; font-size: 11px; padding: 6px 8px; border-top: 1.5px solid #1f2328; border-bottom: 1px solid #1f2328; }
  body.lk table.data td { border-bottom: none; padding: 4px 8px; font-size: 11px; }
  body.lk table.data th.num, body.lk table.data td.num { width: 22%; }
  body.lk tr.sub-header td { background: transparent; text-transform: uppercase; letter-spacing: 0.4px; padding-top: 10px; color: #1B5E20; }
  body.lk tr.rincian td:first-child { padding-left: 20px; }
  body.lk tr.subtotal td { border-top: 1px solid #8a949e; }
  body.lk tr.subtotal td:first-child { border-top: none; padding-left: 8px; }
  body.lk tr.total td { background: transparent; font-size: 11.5px; border-top: 1px solid #1f2328; border-bottom: 3px double #1f2328; }
  body.lk table.ringkasan { border-top: 1px solid #cfd6dd; margin-top: 14px; }
  body.lk table.ringkasan td.label { font-size: 11px; font-weight: 600; color: #333; }
  body.lk table.ringkasan td.nilai { font-size: 11px; padding-left: 16px; font-variant-numeric: tabular-nums; }
</style>
</head>
<body${data.laporanKeuangan ? ' class="lk"' : ''}>
  <div class="header">
    <div class="header-atas">
      ${
        // RC-S100 — logo hanya dirender bila benar-benar ada. `data:` URI
        // tidak di-escape sebagai teks HTML karena ia atribut src; nilainya
        // berasal dari berkas milik aplikasi sendiri (dibaca
        // LogoKoperasiService), bukan dari input pengguna.
        data.logoDataUri ? `<img class="logo" src="${data.logoDataUri}" alt="Logo koperasi" />` : ''
      }
      <div class="identitas">
        <div class="nama-koperasi">${escapeHtml(data.namaKoperasi)}</div>
        ${data.alamatKoperasi ? `<div class="alamat">${escapeHtml(data.alamatKoperasi)}</div>` : ''}
      </div>
    </div>
    <div class="judul">${escapeHtml(data.judulLaporan)}</div>
    <div class="periode">${escapeHtml(data.periodeLabel)}</div>
  </div>

  <table class="data">
    <thead><tr>${headerKolom}</tr></thead>
    <tbody>${barisTabel || `<tr><td colspan="${data.kolom.length}" style="text-align:center;color:#999;padding:16px;">Tidak ada data</td></tr>`}</tbody>
  </table>

  ${ringkasanHtml}
  ${catatanHtml}
  ${blokTandaTangan(data)}

  ${htmlIdentitasCetak(tanggalCetak)}
</body>
</html>`;
}

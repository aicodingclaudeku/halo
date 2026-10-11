import { CSS_IDENTITAS_CETAK, htmlIdentitasCetak } from './IdentitasCetak';
import { DataLaporanExport, SeksiKv, SeksiLaporan, SeksiTabel } from './ExportTypes';
import { formatRupiah } from '@/utils/money';
import { teksPdf } from './TeksPdf';

/**
 * RC-S83 — RENDERER HTML DOKUMEN BERSEKSI (MURNI, string in -> string out).
 * ============================================================
 * Dipakai `buildReportHtml()` HANYA bila `data.seksi` terisi. Laporan
 * tabel lain (tanpa `seksi`) tetap memakai template lama, tidak berubah.
 *
 * Tata letak mengikuti gaya dokumen kontrak (DokumenKontrakHtml.ts)
 * supaya seluruh dokumen cetak KOPKU seragam:
 *  - `@page` A4 portrait; kotak margin menampilkan kode dokumen dan
 *    "Halaman X dari Y" di setiap halaman (mesin yang belum mendukung
 *    kotak margin cukup mengabaikannya — tidak ada `position: fixed`).
 *  - Kop koperasi bergaris ganda, judul di tengah.
 *  - Tiap seksi bernomor. Seksi label/nilai dirender dua kolom; nilai
 *    panjang (mis. alamat) memakai satu baris penuh.
 *  - Tabel: header berulang tiap halaman, baris tidak dipecah, nominal
 *    rata kanan dengan angka tabular, baris total di kaki tabel.
 *  - Semua teks bebas di-escape.
 */

function esc(value: string | number | null | undefined): string {
  // Poin 2 — tanpa label standar akuntansi; tanggal ISO dicetak "4 Oktober 2026".
  return teksPdf(String(value ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cssString(s: string): string {
  return `"${s.replace(/["\\\n\r]/g, ' ')}"`;
}

/** Nilai di atas panjang ini memakan satu baris penuh pada seksi label/nilai. */
const BATAS_NILAI_PENDEK = 34;

function renderKv(seksi: SeksiKv): string {
  const tebal = new Set(seksi.labelTebal ?? []);
  const sel = (label: string, nilai: string, span = false) =>
    `<td class="kv-label">${esc(label)}</td><td class="kv-nilai${tebal.has(label) ? ' tebal' : ''}"${span ? ' colspan="3"' : ''}>${esc(nilai)}</td>`;

  const barisHtml: string[] = [];
  let antre: { label: string; nilai: string } | null = null;
  for (const b of seksi.baris) {
    const panjang = b.nilai.length > BATAS_NILAI_PENDEK;
    if (panjang) {
      if (antre) {
        barisHtml.push(`<tr>${sel(antre.label, antre.nilai, true)}</tr>`);
        antre = null;
      }
      barisHtml.push(`<tr>${sel(b.label, b.nilai, true)}</tr>`);
    } else if (antre) {
      barisHtml.push(`<tr>${sel(antre.label, antre.nilai)}${sel(b.label, b.nilai)}</tr>`);
      antre = null;
    } else {
      antre = b;
    }
  }
  if (antre) barisHtml.push(`<tr>${sel(antre.label, antre.nilai)}<td class="kv-label"></td><td class="kv-nilai"></td></tr>`);

  return `<table class="kv"><colgroup><col class="c-label"/><col class="c-nilai"/><col class="c-label"/><col class="c-nilai"/></colgroup><tbody>${barisHtml.join('')}</tbody></table>`;
}

function selTabel(value: string | number, isAngka: boolean): string {
  if (isAngka && typeof value === 'number') return formatRupiah(value);
  return esc(value);
}

function renderTabel(seksi: SeksiTabel): string {
  const angka = new Set(seksi.kolomAngka);
  const head = seksi.kolom.map((k, i) => `<th class="${angka.has(i) ? 'num' : ''}">${esc(k)}</th>`).join('');
  const body =
    seksi.baris.length === 0
      ? `<tr><td class="kosong" colspan="${seksi.kolom.length}">${esc(seksi.teksKosong ?? 'Tidak ada data.')}</td></tr>`
      : seksi.baris
          .map((row) => `<tr>${row.map((c, i) => `<td class="${angka.has(i) ? 'num' : ''}">${selTabel(c, angka.has(i))}</td>`).join('')}</tr>`)
          .join('');
  const foot =
    seksi.barisTotal && seksi.baris.length > 0
      ? `<tfoot><tr>${seksi.barisTotal.map((c, i) => `<td class="${angka.has(i) ? 'num' : ''}">${selTabel(c, angka.has(i))}</td>`).join('')}</tr></tfoot>`
      : '';
  return `<table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`;
}

function renderSeksi(seksi: SeksiLaporan, nomor: number): string {
  const isi = seksi.jenis === 'KV' ? renderKv(seksi) : renderTabel(seksi);
  const catatan = seksi.catatan ? `<div class="catatan">${esc(seksi.catatan)}</div>` : '';
  // Seksi label/nilai kecil dijaga utuh satu halaman; tabel boleh
  // berlanjut ke halaman berikutnya (header tabel berulang).
  const kelas = seksi.jenis === 'KV' ? 'seksi utuh' : 'seksi';
  return `<section class="${kelas}"><h2><span class="no">${nomor}</span>${esc(seksi.judul)}</h2>${isi}${catatan}</section>`;
}

export function buildDokumenSeksiHtml(data: DataLaporanExport, dicetakPada: string): string {
  const seksi = data.seksi ?? [];
  const kodeDokumen = data.nomorDokumen ?? data.judulLaporan;

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8" />
<title>${esc(data.judulLaporan)}</title>
<style>
  @page {
    size: A4 portrait;
    margin: 16mm 14mm 18mm 14mm;
    @bottom-left { content: ${cssString(kodeDokumen)}; font-family: Helvetica, Arial, sans-serif; font-size: 7.5pt; color: #7a848e; }
    @bottom-right { content: "Halaman " counter(page) " dari " counter(pages); font-family: Helvetica, Arial, sans-serif; font-size: 7.5pt; color: #7a848e; }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Helvetica, Arial, sans-serif;
    color: #1f2328;
    font-size: 9.5pt;
    line-height: 1.4;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  table { border-collapse: collapse; width: 100%; }

  .kop { border-bottom: 2.5px solid #1B5E20; padding-bottom: 7px; }
  /* RC-S100 — logo pada kop dokumen A4. */
  .kop .kop-atas { display: flex; align-items: center; gap: 9px; }
  .kop .kop-logo { width: 46px; height: 46px; object-fit: contain; flex: 0 0 auto; }
  .kop .kop-identitas { flex: 1 1 auto; min-width: 0; }
  .kop .nama { font-size: 15pt; font-weight: 700; color: #1B5E20; letter-spacing: 0.2px; overflow-wrap: anywhere; }
  .kop .alamat { font-size: 8.5pt; color: #4a545e; margin-top: 2px; overflow-wrap: anywhere; }
  .kop-garis2 { border-bottom: 0.75px solid #1B5E20; margin-top: 2px; margin-bottom: 14px; }

  h1 { text-align: center; font-size: 13pt; letter-spacing: 1.5px; text-transform: uppercase; margin: 0 0 3px 0; }
  .subjudul { text-align: center; font-size: 9pt; color: #4a545e; margin-bottom: 14px; }

  .seksi { margin-bottom: 14px; }
  .seksi.utuh { break-inside: avoid; page-break-inside: avoid; }
  h2 {
    font-size: 10.5pt; color: #1B5E20; margin: 0 0 6px 0; padding-bottom: 3px;
    border-bottom: 1px solid #cfd6dd; break-after: avoid; page-break-after: avoid;
  }
  h2 .no {
    display: inline-block; min-width: 18px; height: 18px; line-height: 18px; margin-right: 7px;
    border-radius: 3px; background: #1B5E20; color: #fff; text-align: center; font-size: 8.5pt;
  }

  table.kv { border: 1px solid #dde3e8; border-radius: 4px; background: #f7f9fa; table-layout: fixed; }
  table.kv col.c-label { width: 20%; }
  table.kv col.c-nilai { width: 30%; }
  table.kv td { padding: 4px 8px; vertical-align: top; border-bottom: 1px solid #e9edf0; overflow-wrap: anywhere; }
  table.kv tr:last-child td { border-bottom: none; }
  table.kv td.kv-label { color: #5b6670; font-size: 8.5pt; }
  table.kv td.kv-nilai { font-weight: 600; color: #1f2328; }
  table.kv td.kv-nilai.tebal { font-weight: 700; color: #1B5E20; }

  table.data { font-size: 8.5pt; }
  table.data thead { display: table-header-group; }
  table.data tfoot { display: table-row-group; }
  table.data tr { break-inside: avoid; page-break-inside: avoid; }
  table.data th {
    background: #1B5E20; color: #fff; text-align: left; font-weight: 700;
    padding: 5px 6px; font-size: 8pt; border: 1px solid #1B5E20;
  }
  table.data td { padding: 4px 6px; border-bottom: 1px solid #e3e7eb; vertical-align: top; overflow-wrap: anywhere; }
  table.data tbody tr:nth-child(even) td { background: #f6f8f7; }
  table.data td:not(:last-child) { white-space: nowrap; }
  table.data .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.data tfoot td { font-weight: 700; background: #e8f1e9; border-top: 1.5px solid #1B5E20; border-bottom: 1.5px solid #1B5E20; }
  table.data td.kosong { text-align: center; color: #7a848e; font-style: italic; padding: 12px; background: #fff; }

  .catatan { font-size: 7.8pt; color: #6b757f; font-style: italic; margin-top: 4px; }

${CSS_IDENTITAS_CETAK}
</style>
</head>
<body>
  <div class="kop">
    <div class="kop-atas">
      ${/* RC-S100 — lihat catatan yang sama di HtmlReportBuilder. */ ''}
      ${data.logoDataUri ? `<img class="kop-logo" src="${data.logoDataUri}" alt="Logo koperasi" />` : ''}
      <div class="kop-identitas">
        <div class="nama">${esc(data.namaKoperasi)}</div>
        ${data.alamatKoperasi ? `<div class="alamat">${esc(data.alamatKoperasi)}</div>` : ''}
      </div>
    </div>
  </div>
  <div class="kop-garis2"></div>

  <h1>${esc(data.judulLaporan.split(' - ')[0])}</h1>
  <div class="subjudul">${esc(data.judulLaporan.includes(' - ') ? data.judulLaporan.split(' - ').slice(1).join(' - ') + ' · ' : '')}${esc(data.periodeLabel)}</div>

  ${seksi.map((s, i) => renderSeksi(s, i + 1)).join('\n')}

  ${htmlIdentitasCetak(dicetakPada, 'Saldo sesuai pencatatan pada tanggal cetak.')}
</body>
</html>`;
}

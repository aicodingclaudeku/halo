import { formatRupiah, Rupiah } from '@/utils/money';
import type { SusunanPengurusInti } from '@/services/PengurusInti';
import { LABEL_METERAI } from './DasarHukumAkad';
import { KETERANGAN_APLIKASI_CETAK, NAMA_APLIKASI_CETAK } from './IdentitasCetak';

/**
 * RC-S82 — TEMPLATE BERSAMA DOKUMEN KONTRAK PINJAMAN (MURNI).
 * ============================================================
 * Dipakai "Dokumen Akad Awal Pinjaman" DAN "Dokumen Akad Ulang
 * Pinjaman" supaya keduanya identik secara visual: kop, judul bernomor,
 * identitas dokumen, bab bernomor romawi, tabel jadwal, pengesahan, dan
 * footer. TIDAK dipakai laporan tabel generik (`buildReportHtml`).
 *
 * Keputusan tata letak (diverifikasi render Chromium 131, mesin Android WebView):
 *  - `@page` A4 portrait. Kotak margin `@bottom-left/@bottom-right`
 *    menampilkan nomor dokumen + "Halaman X dari Y" di SETIAP halaman.
 *    Mesin yang belum mendukung kotak margin mengabaikannya — tidak ada
 *    tumpang-tindih (tidak memakai `position: fixed`).
 *  - Tabel jadwal adalah tabel level-atas: header berulang tiap halaman,
 *    baris tidak dipecah.
 *  - Blok kecil tidak dipecah lintas halaman; pengesahan + footer satu blok.
 *  - Semua teks bebas di-escape; teks panjang dibungkus paksa.
 */

export function escapeHtmlDokumen(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** String aman untuk nilai `content: "..."` CSS. */
function cssString(s: string): string {
  return `"${s.replace(/["\\\n\r]/g, ' ')}"`;
}

export interface BarisKv {
  label: string;
  nilai: string;
}

export function cssDokumenKontrak(nomorDokumen: string): string {
  return `
  @page {
    size: A4 portrait;
    margin: 18mm 16mm 18mm 18mm;
    @bottom-left { content: ${cssString(nomorDokumen)}; font-family: Helvetica, Arial, sans-serif; font-size: 7.5pt; color: #7a848e; }
    @bottom-right { content: "Halaman " counter(page) " dari " counter(pages); font-family: Helvetica, Arial, sans-serif; font-size: 7.5pt; color: #7a848e; }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Helvetica, Arial, sans-serif;
    color: #1f2328;
    font-size: 10.5pt;
    line-height: 1.45;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  table { border-collapse: collapse; }

  .kop { border-bottom: 2.5px solid #1B5E20; padding-bottom: 8px; }
  .kop .nama { font-size: 15pt; font-weight: 700; color: #1B5E20; letter-spacing: 0.2px; overflow-wrap: anywhere; }
  .kop .alamat { font-size: 9pt; color: #4a545e; margin-top: 2px; overflow-wrap: anywhere; }
  .kop-garis2 { border-bottom: 0.75px solid #1B5E20; margin-top: 2px; margin-bottom: 18px; }

  h1 { text-align: center; font-size: 14pt; letter-spacing: 1.2px; margin: 0 0 4px 0; }
  .subjudul { text-align: center; font-size: 9.5pt; color: #4a545e; margin-bottom: 16px; }

  .draf { border: 1.5px solid #b26a00; background: #fff7e8; color: #7a4a00; border-radius: 4px; padding: 8px 12px; margin-bottom: 14px; font-size: 9.5pt; text-align: center; font-weight: 700; letter-spacing: 0.3px; }
  /* Poin 1 — teks biasa: tanpa border/kotak/latar, rata kiri dengan margin halaman. */
  .info { padding: 0; margin: 0 0 14px 0; font-size: 9.5pt; color: #2f4f36; text-align: justify; }

  .identitas-dokumen { padding: 0; margin-bottom: 18px; }

  h2 {
    font-size: 11pt;
    margin: 20px 0 8px 0;
    padding-bottom: 3px;
    border-bottom: 1px solid #cfd6dd;
    color: #1B5E20;
    break-after: avoid;
    page-break-after: avoid;
  }
  .blok { break-inside: avoid; page-break-inside: avoid; }

  table.kv { width: 100%; }
  table.kv td { padding: 3px 0; vertical-align: top; }
  table.kv td.kv-label { width: 34%; color: #4a545e; }
  table.kv td.kv-sep { width: 14px; color: #4a545e; }
  table.kv td.kv-nilai { font-weight: 600; overflow-wrap: anywhere; word-break: break-word; }

  table.grid { width: 100%; border: 1px solid #cfd6dd; }
  table.grid th {
    background: #1B5E20; color: #fff; font-size: 9.5pt; font-weight: 700;
    padding: 7px 10px; text-align: left; border: 1px solid #1B5E20;
  }
  table.grid td { padding: 7px 10px; border: 1px solid #dfe4e8; vertical-align: top; overflow-wrap: anywhere; }
  table.grid tbody tr:nth-child(even) td { background: #fafbfc; }
  table.grid tr, table.grid td { break-inside: avoid; page-break-inside: avoid; }
  table.grid thead { display: table-header-group; }
  table.grid td.komponen { font-weight: 600; width: 28%; }
  .num { text-align: right !important; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .ctr { text-align: center !important; white-space: nowrap; }
  table.grid tr.total td { font-weight: 700; background: #eef3ef !important; border-top: 1.5px solid #1B5E20; }
  .internal { display: block; font-size: 7.5pt; color: #8a949e; font-weight: 400; }

  .nilai-utama { padding: 0; }
  .nilai-utama .label { font-size: 9.5pt; color: #2f4f36; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; }
  .nilai-utama .angka { font-size: 20pt; font-weight: 800; color: #1B5E20; margin-top: 2px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.nilai-info { width: 100%; margin-top: 8px; }
  table.nilai-info td { padding: 3px 0; }
  table.nilai-info td.label { color: #4a545e; }
  table.nilai-info td.angka { font-weight: 700; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .catatan { font-size: 8.5pt; color: #5b6670; font-style: italic; margin-top: 6px; }

  .keterangan { padding: 0; overflow-wrap: anywhere; word-break: break-word; }
  .kosong { color: #8a949e; font-style: italic; }

  .pengesahan-intro { margin-bottom: 10px; }
  .tempat-tanggal { margin-bottom: 14px; color: #4a545e; }
  table.ttd { width: 100%; margin-top: 8px; }
  table.ttd td { width: 50%; text-align: center; vertical-align: top; padding: 0 12px; }
  .ttd-peran { font-weight: 700; letter-spacing: 0.6px; }
  .ttd-ruang { height: 78px; }
  .ttd-garis { border-bottom: 1px solid #1f2328; margin: 0 18px 4px 18px; }
  .ttd-nama { font-weight: 600; overflow-wrap: anywhere; }
  .ttd-sub { font-size: 8.5pt; color: #5b6670; }

  /* --- Perjanjian (pasal, pembukaan, para pihak) --- */
  .pembukaan { text-align: justify; margin: 0 0 10px 0; }
  table.pihak { width: 100%; margin: 4px 0 8px 0; }
  table.pihak td { vertical-align: top; padding: 2px 0; }
  table.pihak td.no { width: 18px; font-weight: 700; }
  table.pihak td.kv-label { width: 30%; color: #4a545e; }
  table.pihak td.kv-sep { width: 12px; color: #4a545e; }
  table.pihak td.kv-nilai { font-weight: 600; overflow-wrap: anywhere; }
  .pihak-peran { text-align: justify; margin: 2px 0 10px 18px; }
  ol.dasar { margin: 4px 0 10px 0; padding-left: 18px; text-align: justify; }
  ol.dasar li { margin-bottom: 2px; }
  .pasal { break-inside: avoid; page-break-inside: avoid; margin-top: 14px; }
  .pasal .nomor { text-align: center; font-weight: 700; letter-spacing: 0.4px; }
  .pasal .judul { text-align: center; font-weight: 700; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.3px; }
  .pasal p { text-align: justify; margin: 0 0 6px 0; }
  .pasal ol { margin: 0 0 6px 0; padding-left: 18px; text-align: justify; }
  .pasal ol li { margin-bottom: 4px; }
  .tebal { font-weight: 700; }
  .lampiran-judul { page-break-before: always; break-before: page; text-align: center; font-weight: 700; font-size: 12pt; letter-spacing: 0.6px; margin-bottom: 2px; }
  .lampiran-sub { text-align: center; font-size: 9.5pt; color: #4a545e; margin-bottom: 14px; }
  /* Penanda tempat meterai: TEKS saja (tanpa kotak), di sisi kiri ruang
     tanda tangan supaya tanda tangan anggota dapat menimpa meterai. */
  .ttd-ruang-meterai { height: 78px; display: flex; align-items: center; justify-content: flex-start; padding-left: 18px; }
  .meterai { color: #6b7681; font-size: 8pt; font-style: italic; letter-spacing: 0.2px; white-space: nowrap; }
  .ttd-jabatan { font-size: 9pt; color: #4a545e; }

  .footer {
    border-top: 1px solid #b8c2cc;
    margin-top: 22px;
    padding-top: 6px;
    font-size: 8pt;
    color: #5b6670;
  }
  .footer table { width: 100%; }
  .footer td { vertical-align: top; padding: 0; }
  .footer td.kiri { overflow-wrap: anywhere; }
  .footer td.kanan { text-align: right; white-space: nowrap; padding-left: 12px; }
  .footer .identitas { margin-top: 4px; padding-top: 4px; border-top: 0.5px solid #dde3e8; font-family: Helvetica, Arial, sans-serif; font-size: 7.5pt; }
  .footer .identitas b { color: #1B5E20; }
`;
}

export function htmlKv(baris: BarisKv[]): string {
  return `<table class="kv">${baris
    .map(
      (b) =>
        `<tr><td class="kv-label">${escapeHtmlDokumen(b.label)}</td><td class="kv-sep">:</td><td class="kv-nilai">${escapeHtmlDokumen(b.nilai)}</td></tr>`
    )
    .join('')}</table>`;
}

/** Teks multi-baris — escape dulu, baru ganti newline. */
export function htmlTeksBebas(s: string): string {
  return escapeHtmlDokumen(s).replace(/\r?\n/g, '<br />');
}

export function htmlKop(koperasi: { nama: string; alamat: string | null }): string {
  return `<div class="kop">
        <div class="nama">${escapeHtmlDokumen(koperasi.nama)}</div>
        ${koperasi.alamat ? `<div class="alamat">${escapeHtmlDokumen(koperasi.alamat)}</div>` : ''}
      </div>
      <div class="kop-garis2"></div>`;
}

export interface BarisJadwalHtml {
  periode: string;
  /** Baris kecil di bawah periode (mis. nomor internal). */
  sub?: string | null;
  jatuhTempo: string;
  pokok: Rupiah;
  jasa: Rupiah;
  total: Rupiah;
}

export function htmlJadwal(baris: BarisJadwalHtml[], total: { pokok: Rupiah; jasa: Rupiah; total: Rupiah }, kosong: string): string {
  const rows = baris.length
    ? baris
        .map(
          (j) =>
            `<tr>
              <td class="ctr">${escapeHtmlDokumen(j.periode)}${j.sub ? `<span class="internal">${escapeHtmlDokumen(j.sub)}</span>` : ''}</td>
              <td>${escapeHtmlDokumen(j.jatuhTempo)}</td>
              <td class="num">${escapeHtmlDokumen(formatRupiah(j.pokok))}</td>
              <td class="num">${escapeHtmlDokumen(formatRupiah(j.jasa))}</td>
              <td class="num">${escapeHtmlDokumen(formatRupiah(j.total))}</td>
            </tr>`
        )
        .join('')
    : `<tr><td colspan="5" class="kosong ctr">${escapeHtmlDokumen(kosong)}</td></tr>`;
  return `<table class="grid jadwal">
        <thead>
          <tr>
            <th class="ctr" style="width:15%">Periode</th>
            <th style="width:25%">Jatuh Tempo</th>
            <th class="num" style="width:20%">Pokok</th>
            <th class="num" style="width:20%">Jasa</th>
            <th class="num" style="width:20%">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          <tr class="total">
            <td colspan="2">Total</td>
            <td class="num">${escapeHtmlDokumen(formatRupiah(total.pokok))}</td>
            <td class="num">${escapeHtmlDokumen(formatRupiah(total.jasa))}</td>
            <td class="num">${escapeHtmlDokumen(formatRupiah(total.total))}</td>
          </tr>
        </tbody>
      </table>`;
}

export interface FooterDokumen {
  nomorPinjaman: string;
  /** "No. Akad" / "No. Akad Ulang". */
  labelNomorDokumen: string;
  nomorDokumen: string;
  tanggalCetak: string;
  catatan: string;
}

const GARIS_NAMA_KOSONG = '(.............................................)';

function namaAtauGaris(nama: string | null | undefined): string {
  return nama && nama.trim() ? escapeHtmlDokumen(nama) : GARIS_NAMA_KOSONG;
}

function kolomTtd(opts: { peran: string; sub?: string | null; meterai?: boolean; nama: string | null; jabatan?: string | null }): string {
  return `<td>
              <div class="ttd-peran">${escapeHtmlDokumen(opts.peran)}</div>
              ${opts.sub ? `<div class="ttd-sub">${escapeHtmlDokumen(opts.sub)}</div>` : ''}
              ${opts.meterai ? `<div class="ttd-ruang-meterai"><span class="meterai">${escapeHtmlDokumen(LABEL_METERAI)}</span></div>` : '<div class="ttd-ruang"></div>'}
              <div class="ttd-garis"></div>
              <div class="ttd-nama">${namaAtauGaris(opts.nama)}</div>
              ${opts.jabatan ? `<div class="ttd-jabatan">${escapeHtmlDokumen(opts.jabatan)}</div>` : ''}
            </td>`;
}

/**
 * Blok tanda tangan + footer dalam SATU blok (footer tidak pernah
 * tertinggal sendirian di halaman terakhir).
 *
 *   [Anggota / PIHAK KEDUA — di atas meterai]   [Koperasi / PIHAK PERTAMA — Ketua]
 *
 * Hanya Ketua yang menandatangani atas nama koperasi (UU 25/1992 Pasal 30
 * ayat (2) huruf a). Sekretaris & Bendahara TIDAK dicetak di dokumen
 * (keputusan pengguna); keduanya tetap dikelola di menu Pengurus. Nama
 * Ketua diambil dari menu Pengurus pada tanggal akad; bila belum
 * ditetapkan, dicetak garis titik-titik untuk diisi tangan — TIDAK pernah
 * nama karangan. Tidak ada tanda tangan digital/otomatis.
 */
export function htmlPengesahanDanFooter(opts: {
  nomorBab: string | null;
  judulBab?: string;
  pernyataan: string | null;
  anggota: { peran: string; nama: string };
  koperasi: { peran: string; namaKoperasi: string; pengurus: SusunanPengurusInti };
  footer: FooterDokumen;
}): string {
  const f = opts.footer;
  const p = opts.koperasi.pengurus;
  const judul = opts.judulBab ?? 'PENGESAHAN';
  return `<div class="blok">
        ${opts.nomorBab ? `<h2>${escapeHtmlDokumen(opts.nomorBab)}. ${escapeHtmlDokumen(judul)}</h2>` : ''}
        ${opts.pernyataan ? `<div class="pengesahan-intro">${escapeHtmlDokumen(opts.pernyataan)}</div>` : ''}
        <div class="tempat-tanggal">Ditandatangani di ................................................, tanggal ................................................</div>
        <table class="ttd">
          <tr>
            ${kolomTtd({ peran: opts.anggota.peran, sub: 'Anggota / Peminjam', meterai: true, nama: opts.anggota.nama })}
            ${kolomTtd({ peran: opts.koperasi.peran, sub: opts.koperasi.namaKoperasi, nama: p.KETUA?.nama ?? null, jabatan: 'Ketua' })}
          </tr>
        </table>

      <div class="footer">
        <table><tr>
          <td class="kiri">
            No. Pinjaman ${escapeHtmlDokumen(f.nomorPinjaman)} · ${escapeHtmlDokumen(f.labelNomorDokumen)} ${escapeHtmlDokumen(f.nomorDokumen)}<br />
            ${escapeHtmlDokumen(f.catatan)}
          </td>
          <td class="kanan">Dicetak ${escapeHtmlDokumen(f.tanggalCetak)}</td>
        </tr></table>
        <div class="identitas">Dicetak dengan <b>${escapeHtmlDokumen(NAMA_APLIKASI_CETAK)}</b> · ${escapeHtmlDokumen(KETERANGAN_APLIKASI_CETAK)}</div>
      </div>
      </div>`;
}

export function htmlDokumenKontrak(opts: { judulTab: string; nomorDokumen: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtmlDokumen(opts.judulTab)}</title>
<style>${cssDokumenKontrak(opts.nomorDokumen)}</style>
</head>
<body>
${opts.body}
</body>
</html>`;
}

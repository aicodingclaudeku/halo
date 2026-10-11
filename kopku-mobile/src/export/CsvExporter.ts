import { DataLaporanExport } from './ExportTypes';
import { formatRupiah } from '@/utils/money';

/**
 * Builder CSV MURNI (string in, string out — tanpa I/O file). Menyertakan
 * beberapa baris metadata (nama koperasi, judul laporan, periode) di atas
 * tabel data, supaya file CSV tetap informatif tanpa header/footer (PRD
 * fase 6: "informasi koperasi pada laporan", "periode laporan").
 */

function escapeCsvField(value: string | number): string {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatSel(value: string | number, kolomAngka: number[], idx: number): string | number {
  if (kolomAngka.includes(idx) && typeof value === 'number') {
    return formatRupiah(value);
  }
  return value;
}

export function buildCsv(data: DataLaporanExport): string {
  const baris: string[] = [];

  baris.push(escapeCsvField(data.namaKoperasi));
  if (data.alamatKoperasi) baris.push(escapeCsvField(data.alamatKoperasi));
  baris.push(escapeCsvField(data.judulLaporan));
  baris.push(escapeCsvField(data.periodeLabel));
  baris.push(''); // baris kosong pemisah metadata vs tabel

  // RC-S83 — dokumen berseksi: tiap seksi ditulis berurutan dengan
  // judulnya sendiri. Laporan tanpa `seksi` tidak terpengaruh.
  if (data.seksi && data.seksi.length > 0) {
    data.seksi.forEach((s, i) => {
      if (i > 0) baris.push('');
      baris.push(escapeCsvField(s.judul.toUpperCase()));
      if (s.jenis === 'KV') {
        for (const r of s.baris) baris.push(`${escapeCsvField(r.label)},${escapeCsvField(r.nilai)}`);
      } else {
        baris.push(s.kolom.map(escapeCsvField).join(','));
        if (s.baris.length === 0 && s.teksKosong) baris.push(escapeCsvField(s.teksKosong));
        for (const row of s.baris) {
          baris.push(row.map((cell, idx) => escapeCsvField(formatSel(cell, s.kolomAngka, idx))).join(','));
        }
        if (s.barisTotal && s.baris.length > 0) {
          baris.push(s.barisTotal.map((cell, idx) => escapeCsvField(formatSel(cell, s.kolomAngka, idx))).join(','));
        }
      }
      if (s.catatan) baris.push(escapeCsvField(`Catatan: ${s.catatan}`));
    });
    return baris.join('\r\n');
  }

  baris.push(data.kolom.map(escapeCsvField).join(','));
  data.baris.forEach((row, rowIdx) => {
    // RC-S98 — CSV tidak punya gaya huruf, jadi hierarki baris laporan
    // berlapis dipertahankan lewat INDENTASI label (konvensi lazim pada
    // laporan keuangan berbentuk teks). Hanya baris yang builder-nya
    // menandai 'RINCIAN' yang diindentasi; laporan tanpa `tingkatBaris`
    // menghasilkan file yang identik dengan sebelumnya.
    const indent = data.tingkatBaris?.[rowIdx] === 'RINCIAN' ? '  ' : '';
    baris.push(
      row
        .map((cell, idx) => {
          const nilai = formatSel(cell, data.kolomAngka, idx);
          return escapeCsvField(idx === 0 && indent && typeof nilai === 'string' ? indent + nilai : nilai);
        })
        .join(',')
    );
  });

  if (data.ringkasan && data.ringkasan.length > 0) {
    baris.push('');
    for (const r of data.ringkasan) {
      baris.push(`${escapeCsvField(r.label)},${escapeCsvField(r.nilai)}`);
    }
  }

  return baris.join('\r\n');
}

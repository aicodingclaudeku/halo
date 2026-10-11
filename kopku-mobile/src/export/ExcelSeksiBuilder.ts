import { DataLaporanExport } from './ExportTypes';

/**
 * RC-S83 — susunan sheet Excel untuk dokumen berseksi (MURNI, tanpa I/O).
 *
 * Nominal Rupiah ditulis sebagai ANGKA (bukan teks "Rp...") dengan
 * format tampilan Rupiah, supaya file Excel bisa langsung dijumlah /
 * difilter. Posisi sel nominal dikembalikan di `selRupiah` agar
 * ExportService memberi format angkanya.
 */
export const FORMAT_RUPIAH_EXCEL = '"Rp"#,##0;-"Rp"#,##0';

/** Peran tiap baris `aoa` — dipakai ExportService untuk memberi gaya sel. */
export type PeranBarisSeksi = 'NAMA' | 'META' | 'JUDUL' | 'KOSONG' | 'SEKSI' | 'KV' | 'KEPALA' | 'DATA' | 'TOTAL' | 'CATATAN';

export interface SheetSeksi {
  aoa: (string | number)[][];
  /** [baris, kolom] 0-based sel yang berisi nominal Rupiah. */
  selRupiah: [number, number][];
  /** Lebar kolom (karakter) — dihitung dari isi terpanjang, dibatasi. */
  lebarKolom: number[];
  /** Sejajar indeks dengan `aoa` (aditif). */
  peran: PeranBarisSeksi[];
}

export function buildSheetSeksi(data: DataLaporanExport): SheetSeksi {
  const aoa: (string | number)[][] = [];
  const selRupiah: [number, number][] = [];
  const peran: PeranBarisSeksi[] = [];
  const dorong = (row: (string | number)[], p: PeranBarisSeksi) => {
    aoa.push(row);
    peran.push(p);
  };

  dorong([data.namaKoperasi], 'NAMA');
  if (data.alamatKoperasi) dorong([data.alamatKoperasi], 'META');
  dorong([data.judulLaporan], 'JUDUL');
  dorong([data.periodeLabel], 'META');

  for (const s of data.seksi ?? []) {
    dorong([], 'KOSONG');
    dorong([s.judul.toUpperCase()], 'SEKSI');
    if (s.jenis === 'KV') {
      for (const r of s.baris) dorong([r.label, r.nilai], 'KV');
    } else {
      dorong([...s.kolom], 'KEPALA');
      if (s.baris.length === 0 && s.teksKosong) dorong([s.teksKosong], 'CATATAN');
      const tulis = (row: (string | number)[], p: PeranBarisSeksi) => {
        const r = aoa.length;
        row.forEach((cell, c) => {
          if (s.kolomAngka.includes(c) && typeof cell === 'number') selRupiah.push([r, c]);
        });
        dorong([...row], p);
      };
      s.baris.forEach((row) => tulis(row, 'DATA'));
      if (s.barisTotal && s.baris.length > 0) tulis(s.barisTotal, 'TOTAL');
    }
    if (s.catatan) dorong([`Catatan: ${s.catatan}`], 'CATATAN');
  }

  // Lebar kolom: judul/metadata (baris 1 kolom) tidak ikut dihitung
  // supaya satu judul panjang tidak melebarkan kolom A.
  // RC-S133.6.3: nilai baris KV digabung B..akhir (gayaiSheetSeksi) bila
  // lembar punya tabel > 2 kolom — tidak ikut melebarkan kolom B (dulu
  // "Rp10.962.479 (100%) — 2 pinjaman" membuat kolom B 45 karakter dan
  // seluruh tabel melebar).
  const nKolom = Math.max(2, ...aoa.map((r) => r.length));
  const lebarKolom: number[] = [];
  aoa.forEach((row, r) => {
    if (row.length < 2) return;
    const kvGabung = peran[r] === 'KV' && nKolom > 2;
    row.forEach((cell, c) => {
      if (kvGabung && c > 0) return;
      const len = typeof cell === 'number' ? String(cell).length + 6 : String(cell).length;
      lebarKolom[c] = Math.min(Math.max(lebarKolom[c] ?? 10, len + 2), 45);
    });
  });

  return { aoa, selRupiah, lebarKolom, peran };
}

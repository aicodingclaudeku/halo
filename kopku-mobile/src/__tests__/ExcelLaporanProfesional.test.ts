import { readFileSync } from 'fs';
import { join } from 'path';
import { alamatSel, bangunSheetLaporan, gayaiSheetSeksi, namaSheetAman } from '@/export/ExcelLaporanBuilder';
import { FORMAT_RUPIAH, WARNA } from '@/export/GayaExcel';
import type { DataLaporanExport } from '@/export/ExportTypes';
import type { SheetSeksi } from '@/export/ExcelSeksiBuilder';

/**
 * TAMPILAN EXCEL LAPORAN — rapi & profesional (bukan sheet polos).
 * Isi/angka tidak berubah; yang dikunci adalah bentuk & gaya selnya.
 */

const daftar: DataLaporanExport = {
  judulLaporan: 'Daftar Simpanan Anggota',
  namaFileDasar: 'x',
  namaKoperasi: 'KSP Kenanga',
  alamatKoperasi: 'Jl. Melati 5',
  periodeLabel: 'Per 31 Desember 2026',
  kolom: ['No. Anggota', 'Nama', 'Simpanan Pokok', 'Total'],
  kolomAngka: [2, 3],
  baris: [
    ['A-1', 'Andi', 100_000, 1_000_000],
    ['A-2', 'Budi', 100_000, -50_000],
    ['A-3', 'Citra', 100_000, 2_000_000],
  ],
  ringkasan: [{ label: 'Jumlah anggota', nilai: '3' }],
  catatanKaki: ['Catatan uji.'],
};

const lk: DataLaporanExport = {
  judulLaporan: 'Laporan Perhitungan Hasil Usaha',
  namaFileDasar: 'lhu',
  namaKoperasi: 'KSP Kenanga',
  periodeLabel: 'Tahun 2026',
  kolom: ['Uraian', 'Jumlah'],
  kolomAngka: [1],
  baris: [
    ['PARTISIPASI ANGGOTA', ''],
    ['Pendapatan bunga', 1_000],
    ['Jumlah partisipasi anggota', 1_000],
    ['SISA HASIL USAHA', 900],
  ],
  tingkatBaris: ['JUDUL', 'RINCIAN', 'SUBTOTAL', 'TOTAL'],
  laporanKeuangan: { tanggalAcuan: '2026-12-31' },
};

const cariBaris = (s: ReturnType<typeof bangunSheetLaporan>, label: string) =>
  s.sel.findIndex((r) => r && r[0] && r[0].v === label);

describe('kop & judul kolom', () => {
  const s = bangunSheetLaporan(daftar, '4 Oktober 2026 pukul 10.00');

  it('kop: nama koperasi besar hijau, digabung selebar tabel', () => {
    expect(s.sel[0][0]).toMatchObject({ v: 'KSP Kenanga' });
    expect(s.sel[0][0]?.s?.font).toMatchObject({ bold: true, color: { rgb: WARNA.primer } });
    expect(s.merges).toContainEqual({ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } });
    expect(s.sel.some((r) => r?.[0]?.v === 'Nilai dalam Rupiah')).toBe(true);
  });

  it('bar judul kolom hijau, teks putih tebal; nominal rata kanan', () => {
    const r = cariBaris(s, 'No. Anggota');
    expect(r).toBeGreaterThan(0);
    const kepala = s.sel[r];
    expect(kepala[0]?.s?.fill?.fgColor.rgb).toBe(WARNA.primer);
    expect(kepala[0]?.s?.font).toMatchObject({ bold: true, color: { rgb: WARNA.putih } });
    expect(kepala[2]?.s?.alignment?.horizontal).toBe('right');
    expect(kepala[1]?.s?.alignment?.horizontal).toBe('left');
  });
});

describe('isi tabel', () => {
  const s = bangunSheetLaporan(daftar);

  it('nominal ditulis sebagai ANGKA berformat ribuan (bukan teks "Rp…")', () => {
    const r = cariBaris(s, 'A-2');
    expect(s.sel[r][3]).toMatchObject({ v: -50_000, z: FORMAT_RUPIAH });
    expect(s.sel[r][3]?.s?.numFmt).toBe(FORMAT_RUPIAH);
    expect(s.sel[r][3]?.s?.alignment?.horizontal).toBe('right');
  });

  it('baris belang lembut & filter otomatis pada laporan daftar', () => {
    const r1 = cariBaris(s, 'A-1');
    const r2 = cariBaris(s, 'A-2');
    expect(s.sel[r1][0]?.s?.fill).toBeUndefined();
    expect(s.sel[r2][0]?.s?.fill).toBeDefined();
    const kepala = cariBaris(s, 'No. Anggota');
    expect(s.autofilter).toBe(`${alamatSel(kepala, 0)}:${alamatSel(cariBaris(s, 'A-3'), 3)}`);
  });

  it('ringkasan & catatan penyajian dalam blok bergaya', () => {
    expect(s.sel.some((r) => r?.[0]?.v === 'RINGKASAN')).toBe(true);
    const cat = s.sel.find((r) => r?.[0]?.v === '1. Catatan uji.');
    expect(cat?.[0]?.s?.alignment?.wrapText).toBe(true);
  });

  it('lebar kolom wajar: label lebar, nominal cukup', () => {
    expect(s.lebarKolom[0]).toBeGreaterThanOrEqual(28);
    expect(s.lebarKolom[2]).toBeGreaterThanOrEqual(16);
  });
});

describe('hierarki laporan keuangan', () => {
  const s = bangunSheetLaporan(lk);

  it('band hijau muda, rincian menjorok, subtotal bergaris atas, total bergaris ganda', () => {
    const band = s.sel[cariBaris(s, 'PARTISIPASI ANGGOTA')][0]?.s;
    expect(band?.fill?.fgColor.rgb).toBe(WARNA.primerMuda);
    expect(s.sel[cariBaris(s, 'Pendapatan bunga')][0]?.s?.alignment?.indent).toBe(2);
    expect(s.sel[cariBaris(s, 'Jumlah partisipasi anggota')][1]?.s?.border?.top).toBeDefined();
    expect(s.sel[cariBaris(s, 'SISA HASIL USAHA')][1]?.s?.border?.bottom?.style).toBe('double');
  });

  it('tanpa filter otomatis pada laporan keuangan', () => {
    expect(s.autofilter).toBeUndefined();
  });
});

describe('dokumen berseksi & utilitas', () => {
  it('seksi berlatar hijau muda, judul tabel hijau, nominal berformat', () => {
    const sheet: SheetSeksi = {
      aoa: [['KSP'], ['Detail Anggota'], ['Per 2026'], [], ['IDENTITAS'], ['Nama', 'Andi'], [], ['SIMPANAN'], ['Jenis', 'Saldo'], ['Pokok', 100_000], ['Total', 100_000]],
      selRupiah: [
        [9, 1],
        [10, 1],
      ],
      lebarKolom: [20, 15],
      peran: ['NAMA', 'JUDUL', 'META', 'KOSONG', 'SEKSI', 'KV', 'KOSONG', 'SEKSI', 'KEPALA', 'DATA', 'TOTAL'],
    };
    const s = gayaiSheetSeksi(sheet, 'Detail Anggota');
    expect(s.sel[4][0]?.s?.fill?.fgColor.rgb).toBe(WARNA.primerMuda);
    expect(s.sel[8][0]?.s?.fill?.fgColor.rgb).toBe(WARNA.primer);
    expect(s.sel[9][1]).toMatchObject({ v: 100_000, z: FORMAT_RUPIAH });
    expect(s.sel[10][1]?.s?.border?.bottom?.style).toBe('double');
  });

  it('alamat sel & nama sheet aman', () => {
    expect(alamatSel(0, 0)).toBe('A1');
    expect(alamatSel(9, 27)).toBe('AB10');
    expect(namaSheetAman('Laporan: Arus/Kas [2026]')).toBe('Laporan Arus Kas 2026');
    expect(namaSheetAman('x'.repeat(40))).toHaveLength(31);
  });

  it('ExportService menulis gaya, sel gabung, lebar, tinggi, dan filter dari tata letak', () => {
    const svc = readFileSync(join(__dirname, '..', 'services', 'ExportService.ts'), 'utf8');
    expect(svc).toMatch(/if \(c\.s\) sel\.s = c\.s;/);
    expect(svc).toMatch(/ws\['!merges'\] = spek\.merges;/);
    expect(svc).toMatch(/ws\['!rows'\]/);
    expect(svc).toMatch(/ws\['!autofilter'\] = \{ ref: spek\.autofilter \}/);
    expect(svc).toContain("import * as XLSX from 'xlsx-js-style';");
  });
});

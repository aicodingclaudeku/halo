import { readFileSync } from 'fs';
import { join } from 'path';
import { buildReportHtml } from '@/export/HtmlReportBuilder';
import { buildCsv } from '@/export/CsvExporter';
import { buildSheetSeksi } from '@/export/ExcelSeksiBuilder';
import { bangunSheetLaporan, gayaiSheetSeksi } from '@/export/ExcelLaporanBuilder';
import { htmlPengesahanDanFooter } from '@/export/DokumenKontrakHtml';
import { TEKS_IDENTITAS_CETAK } from '@/export/IdentitasCetak';
import { buildAnggotaDetailExport, buildDaftarAnggotaExport } from '@/export/ReportTableBuilders';
import type { DataLaporanExport } from '@/export/ExportTypes';

/**
 * Template PDF laporan keuangan (Standar = bawaan; "Contoh Laporan Juklat
 * SOM 2025" bila dipilih, hanya 5 laporan pokok) dan baris identitas cetak
 * "Dicetak dengan KOPKU Finance · Aplikasi Akuntansi KSP/USP berdasarkan SAK EP"
 * di bagian bawah SEMUA PDF & Excel.
 */
const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const INFO = { namaKoperasi: 'KSP Kenanga', standarAkuntansi: 'SAK_EP' };

const LAPORAN_KEUANGAN: DataLaporanExport = {
  judulLaporan: 'Laporan Posisi Keuangan',
  namaFileDasar: 'lpk',
  namaKoperasi: 'KSP Kenanga',
  periodeLabel: 'Per 31 Desember 2026',
  kolom: ['Uraian', 'Jumlah'],
  baris: [['Kas', 1_000_000]],
  kolomAngka: [1],
  laporanKeuangan: {
    tanggalAcuan: '2026-12-31',
    juklat: {
      judul: 'Laporan Posisi Keuangan',
      periode: 'Tanggal 31 Desember 2026',
      kolom: ['2026'],
      baris: [{ label: 'Kas', nilai: [1_000_000], tingkat: 'RINCIAN' }],
    } as never,
  },
};
const sel = (s: ReturnType<typeof bangunSheetLaporan>) => s.sel.flat().map((x) => (x ? String(x.v) : ''));

describe('template PDF laporan keuangan', () => {
  it('bawaan = Standar; contoh Juklat hanya bila dipilih', () => {
    expect(buildReportHtml(LAPORAN_KEUANGAN)).toContain('<table class="data">');
    const juklat = buildReportHtml({ ...LAPORAN_KEUANGAN, laporanKeuangan: { ...LAPORAN_KEUANGAN.laporanKeuangan!, gayaPdf: 'JUKLAT' } });
    expect(juklat).toContain('<table class="juklat">');
    expect(baca('src/services/PreferensiCetakService.ts')).toContain("GAYA_PDF_BAWAAN: GayaPdfLaporanKeuangan = 'STANDAR'");
  });

  it('lembar Export: Standar (Bawaan) lebih dulu, nama baru, overview miniatur tiap template', () => {
    const tombol = baca('src/components/ExportButton.tsx');
    expect(tombol.indexOf("gaya: 'STANDAR'")).toBeLessThan(tombol.indexOf("gaya: 'JUKLAT'"));
    expect(tombol).toContain("label: 'Contoh Laporan Juklat SOM 2025'");
    expect(tombol).toContain("lencana: 'Bawaan'");
    expect(tombol).toContain('<PratinjauGayaPdf gaya={o.gaya} />');
    expect(baca('src/components/PratinjauGayaPdf.tsx')).toMatch(/gaya === 'JUKLAT' \? <Juklat \/> : <Standar \/>/);
  });

  it('pilihan template hanya untuk 5 laporan pokok: LPEA tidak lagi membawa tampilan Juklat', () => {
    const b = baca('src/export/ReportTableBuilders.ts');
    const lpea = b.slice(b.indexOf('export function buildLpeaExport'), b.indexOf('export function buildLHUKomparatifExport'));
    expect(lpea).not.toContain('juklat:');
    expect(lpea).toContain('laporanKeuangan: { tanggalAcuan: data.tanggalSelesai }');
    // 5 laporan pokok (termasuk komparatif) tetap punya tampilan Juklat.
    for (const fn of ['buildPosisiKeuanganExport', 'buildLHUExport', 'buildPerubahanEkuitasExport', 'buildArusKasExport', 'buildCalkExport']) {
      const awal = b.indexOf(`export function ${fn}(`);
      const isi = b.slice(awal, b.indexOf('\nexport function', awal + 10));
      expect([fn, isi.includes('juklat:')]).toEqual([fn, true]);
    }
  });
});

describe('identitas cetak di bagian bawah semua PDF & Excel', () => {
  it('teks identitas', () => {
    expect(TEKS_IDENTITAS_CETAK).toBe('Dicetak dengan KOPKU Finance · Aplikasi Akuntansi KSP/USP berdasarkan SAK EP');
  });

  it('PDF laporan Standar, contoh Juklat, dan laporan non-keuangan: identitas di akhir dokumen', () => {
    const daftar = buildDaftarAnggotaExport(INFO as never, [], '2026-10-05' as never);
    for (const html of [
      buildReportHtml(LAPORAN_KEUANGAN),
      buildReportHtml({ ...LAPORAN_KEUANGAN, laporanKeuangan: { ...LAPORAN_KEUANGAN.laporanKeuangan!, gayaPdf: 'JUKLAT' } }),
      buildReportHtml(daftar),
    ]) {
      expect(html).toContain('<div class="identitas-cetak">');
      expect(html).toContain('<span class="ic-nama">KOPKU Finance</span> · Aplikasi Akuntansi KSP/USP berdasarkan SAK EP');
      expect(html).toMatch(/Dicetak pada \d{1,2} \w+ \d{4} pukul \d{2}\.\d{2}/);
      expect(html.lastIndexOf('identitas-cetak')).toBeGreaterThan(html.lastIndexOf('</table>') - 2000);
      expect(html).not.toContain('— Koperasi Finance');
    }
  });

  it('PDF dokumen berseksi (Detail Anggota) dan dokumen akad', () => {
    const detail = buildAnggotaDetailExport(
      INFO as never,
      { id: 'a', nomorAnggota: 'A1', nik: '1', namaLengkap: 'Andi', tanggalBergabung: '2020-01-01', status: 'AKTIF' } as never,
      { simpananPokok: 0, simpananWajib: 0, simpananSukarela: 0, totalPinjaman: 0, totalAngsuran: 0, sisaPinjaman: 0, sisaPinjamanPokok: 0, sisaJasaPinjaman: 0 },
      [],
      '2026-10-05'
    );
    const seksi = buildReportHtml(detail);
    expect(seksi).toContain('<div class="identitas-cetak">');
    expect(seksi).toContain('Saldo sesuai pencatatan pada tanggal cetak.');

    const akad = htmlPengesahanDanFooter({
      nomorBab: null,
      pernyataan: null,
      anggota: { peran: 'PIHAK KEDUA', nama: 'Andi' },
      koperasi: { peran: 'PIHAK PERTAMA', namaKoperasi: 'KSP', pengurus: {} as never },
      footer: { nomorPinjaman: 'PJ-1', labelNomorDokumen: 'No.', nomorDokumen: 'AK/1', tanggalCetak: 'X', catatan: 'c' },
    });
    expect(akad).toMatch(/class="footer"[\s\S]*Dicetak X[\s\S]*Dicetak dengan <b>KOPKU Finance<\/b> · Aplikasi Akuntansi KSP\/USP berdasarkan SAK EP/);
  });

  it('Excel laporan tabel & dokumen berseksi: baris identitas setelah "Dicetak pada"', () => {
    const lap = sel(bangunSheetLaporan(LAPORAN_KEUANGAN, '5 Oktober 2026 pukul 09.30'));
    expect(lap.indexOf(TEKS_IDENTITAS_CETAK)).toBe(lap.indexOf('Dicetak pada 5 Oktober 2026 pukul 09.30') + 2);
    const detail = buildAnggotaDetailExport(
      INFO as never,
      { id: 'a', nomorAnggota: 'A1', nik: '1', namaLengkap: 'Andi', tanggalBergabung: '2020-01-01', status: 'AKTIF' } as never,
      { simpananPokok: 0, simpananWajib: 0, simpananSukarela: 0, totalPinjaman: 0, totalAngsuran: 0, sisaPinjaman: 0, sisaPinjamanPokok: 0, sisaJasaPinjaman: 0 },
      [],
      '2026-10-05'
    );
    const seksi = gayaiSheetSeksi(buildSheetSeksi(detail), detail.judulLaporan, '5 Oktober 2026 pukul 09.30');
    const isi = seksi.sel.map((r) => (r[0] ? String(r[0].v) : ''));
    expect(isi[isi.length - 1]).toBe(TEKS_IDENTITAS_CETAK);
    expect(isi[isi.length - 2]).toBe('Dicetak pada 5 Oktober 2026 pukul 09.30');
  });

  it('CSV tetap data mentah (tanpa baris identitas)', () => {
    expect(buildCsv(LAPORAN_KEUANGAN)).not.toContain('KOPKU Finance');
  });
});

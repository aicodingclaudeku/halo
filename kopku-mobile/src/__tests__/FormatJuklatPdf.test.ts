import { readFileSync } from 'fs';
import { join } from 'path';
import { buildReportHtml } from '@/export/HtmlReportBuilder';
import {
  buildArusKasKomparatifExport,
  buildLHUExport,
  buildLHUKomparatifExport,
  buildPosisiKeuanganKomparatifExport,
} from '@/export/ReportTableBuilders';
import {
  angkaJuklat,
  kolomJuklat,
  periodeJuklat,
  tampilanLhuJuklat,
  tanggalPosisiJuklat,
} from '@/export/JuklatPdf';
import { URUTAN_PENYAJIAN_ASET, URUTAN_PENYAJIAN_EKUITAS } from '@/reports/UrutanPenyajianPosisiKeuangan';
import type { LhuResult, PosisiKeuanganResult, ArusKasResult } from '@/reports/FinancialReports';

/**
 * FORMAT PDF LAPORAN KEUANGAN = LAMPIRAN JUKLAT SOM 2025.
 * Angka uji diambil dari contoh naskah: KSP "Kenanga", 2021 dan 2022.
 */

const info = { namaKoperasi: 'Koperasi Simpan Pinjam “Kenanga”', standarAkuntansi: 'SAK_EP' };
const r = (kode: string, nama: string, jumlah: number) => ({ kode, nama, jumlah });

function lhu(tahun: number, v: number[]): LhuResult {
  const bebanUsaha = [
    r('5-1', 'Beban bunga', v[2]),
    r('5-2', 'Beban penyisihan', v[3]),
    r('5-3', 'Beban kepegawaian', v[4]),
    r('5-4', 'Beban administrasi dan umum', v[5]),
    r('5-5', 'Beban penyusutan dan amortisasi', v[6]),
    r('5-6', 'Beban usaha lain', v[7]),
  ];
  const jumlahBebanUsaha = bebanUsaha.reduce((t, x) => t + x.jumlah, 0);
  return {
    tanggalMulai: `${tahun}-01-01`,
    tanggalSelesai: `${tahun}-12-31`,
    pendapatanJasaPinjaman: v[0],
    pendapatanUsahaLain: [r('4-1500', 'Pendapatan usaha lain', v[1])],
    totalPendapatanUsahaLain: v[1],
    jumlahPartisipasiAnggota: v[0] + v[1],
    bebanUsaha,
    jumlahBebanUsaha,
    shuBruto: v[0] + v[1] - jumlahBebanUsaha,
    hasilInvestasi: [r('4-1300', 'Hasil investasi', v[8])],
    totalHasilInvestasi: v[8],
    bebanPerkoperasian: [r('5-1900', 'Beban perkoperasian', v[9])],
    totalBebanPerkoperasian: v[9],
    pendapatanLain: [r('4-9', 'Pendapatan lain', v[10])],
    bebanLain: [r('5-9', 'Beban lain', v[11])],
    pendapatanBebanLainNeto: v[10] - v[11],
    shuSebelumPajak: v[12],
    bebanPajakPenghasilan: v[13],
    shuNeto: v[12] - v[13],
    ociTidakDireklasifikasi: [],
    ociDireklasifikasi: [],
    totalOci: v[14],
    totalPenghasilanKomprehensif: v[12] - v[13] + v[14],
  } as unknown as LhuResult;
}

const L2021 = lhu(2021, [85_375_000, 3_000_000, 4_700_000, 1_300_000, 2_200_000, 2_400_000, 1_400_000, 1_600_000, 12_500_000, 5_000_000, 4_000_000, 550_000, 85_725_000, 4_300_000, 175_000]);
const L2022 = lhu(2022, [92_300_000, 6_700_000, 5_200_000, 1_500_000, 2_500_000, 2_000_000, 1_600_000, 2_000_000, 15_000_000, 7_500_000, 5_000_000, 750_000, 95_950_000, 4_800_000, 250_000]);

describe('format angka & periode naskah', () => {
  it('angka tanpa Rp, titik ribuan, pengurang dalam kurung, nol tetap 0', () => {
    expect(angkaJuklat(85_375_000)).toBe('85.375.000');
    expect(angkaJuklat(-13_600_000)).toBe('(13.600.000)');
    expect(angkaJuklat(0)).toBe('0');
    expect(angkaJuklat(null)).toBe('');
  });

  it('periode: "Tahun yang berakhir 31 Desember 2021 dan 2022" (lama → baru)', () => {
    expect(
      periodeJuklat([
        { mulai: '2021-01-01', selesai: '2021-12-31' },
        { mulai: '2022-01-01', selesai: '2022-12-31' },
      ])
    ).toBe('Tahun yang berakhir 31 Desember 2021 dan 2022');
    expect(periodeJuklat([{ mulai: '2026-01-01', selesai: '2026-12-31' }])).toBe('Tahun yang berakhir 31 Desember 2026');
    expect(periodeJuklat([{ mulai: '2026-01-01', selesai: '2026-06-30' }])).toBe('Periode 1 Januari 2026 s.d. 30 Juni 2026');
  });

  it('posisi: "Tanggal 31 Desember 2021 dan 2022 (Dalam Rupiah)"', () => {
    expect(tanggalPosisiJuklat(['2021-12-31', '2022-12-31'])).toBe('Tanggal 31 Desember 2021 dan 2022 (Dalam Rupiah)');
    expect(tanggalPosisiJuklat(['2026-12-31'])).toBe('Tanggal 31 Desember 2026 (Dalam Rupiah)');
  });

  it('kolom = tahun; tanggal lengkap bila tahunnya sama', () => {
    expect(kolomJuklat(['2021-12-31', '2022-12-31'])).toEqual(['2021', '2022']);
    expect(kolomJuklat(['2026-01-31', '2026-02-28'])).toEqual(['31 Januari 2026', '28 Februari 2026']);
  });
});

describe('Laporan Perhitungan Hasil Usaha = Lampiran contoh KSP', () => {
  const t = tampilanLhuJuklat('Laporan Perhitungan Hasil Usaha', [L2021, L2022]);
  const cari = (label: string) => t.baris.find((b) => b.label === label);

  it('urutan band & baris kunci persis naskah', () => {
    const label = t.baris.map((b) => b.label);
    const naskah = [
      'PARTISIPASI ANGGOTA',
      'Pendapatan bunga',
      'Jumlah partisipasi anggota',
      'BEBAN USAHA',
      'Jumlah beban usaha',
      'SISA HASIL USAHA BRUTO',
      'PENDAPATAN & BEBAN LAIN',
      'Sisa hasil usaha sebelum pajak',
      'Beban pajak penghasilan',
      'SISA HASIL USAHA',
      'Penghasilan komprehensif lain',
      'PENGHASILAN KOMPREHENSIF',
    ];
    const idx = naskah.map((x) => label.indexOf(x));
    expect(idx).not.toContain(-1);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('angka naskah 2021 & 2022 direproduksi (kolom lama → baru)', () => {
    expect(t.kolom).toEqual(['2021', '2022']);
    expect(t.periode).toBe('Tahun yang berakhir 31 Desember 2021 dan 2022');
    expect(cari('Jumlah partisipasi anggota')?.nilai).toEqual([88_375_000, 99_000_000]);
    expect(cari('Jumlah beban usaha')?.nilai).toEqual([-13_600_000, -14_800_000]);
    expect(cari('Sisa hasil usaha sebelum pajak')?.nilai).toEqual([85_725_000, 95_950_000]);
    expect(cari('SISA HASIL USAHA')?.nilai).toEqual([81_425_000, 91_150_000]);
    expect(cari('PENGHASILAN KOMPREHENSIF')?.nilai).toEqual([81_600_000, 91_400_000]);
    // SHU bruto adalah band tanpa angka, seperti naskah.
    expect(cari('SISA HASIL USAHA BRUTO')?.nilai).toEqual([null, null]);
  });

  it('komposisi pendapatan di bawah tabel: 87,6% / 12,4% (2021) dan 86,8% / 13,2% (2022)', () => {
    const teks = (t.keterangan ?? []).flatMap((k) => [k.judul, ...k.baris]).join('\n');
    expect(teks).toContain('TAHUN 2021');
    expect(teks).toContain('= 87,6%');
    expect(teks).toContain('= 12,4%');
    expect(teks).toContain('= 86,8%');
    expect(teks).toContain('= 13,2%');
  });

  it('PDF: kop di dalam tabel bergaris, angka berkurung, tanpa "Rp" di tabel', () => {
    const d = buildLHUKomparatifExport(info, { sekarang: L2022, pembanding: L2021 } as never, 'Laporan Perhitungan Hasil Usaha');
    const html = buildReportHtml({ ...d, laporanKeuangan: { ...d.laporanKeuangan!, gayaPdf: 'JUKLAT' } });
    expect(html).toContain('<table class="juklat">');
    expect(html).toMatch(/<thead><tr class="kop">/);
    expect(html).toContain('<div class="kop-judul">Laporan Perhitungan Hasil Usaha</div>');
    expect(html).toContain('Tahun yang berakhir 31 Desember 2021 dan 2022');
    expect(html).toContain('<td class="num">(13.600.000)</td><td class="num">(14.800.000)</td>');
    const tabel = html.slice(html.indexOf('<table class="juklat">'), html.indexOf('</table>'));
    expect(tabel).not.toContain('Rp');
    // Urutan kolom naskah: 2021 di kiri, 2022 di kanan.
    expect(tabel.indexOf('>2021<')).toBeLessThan(tabel.indexOf('>2022<'));
    expect(html).toMatch(/table\.juklat td, table\.juklat th \{ border: 1px solid #000/);
  });

  it('Excel/CSV tidak berubah: baris builder tetap lengkap (kolom berjalan dulu)', () => {
    const d = buildLHUExport(info, L2022, 'Laporan Perhitungan Hasil Usaha');
    expect(d.kolom).toEqual(['Uraian', 'Jumlah']);
    expect(d.baris.some((b) => b[0] === 'Jumlah Partisipasi Anggota')).toBe(true);
  });
});

describe('Laporan Posisi Keuangan = Lampiran contoh neraca', () => {
  const row = (kode: string, nama: string, saldo: number) => ({ kode, nama, saldo });
  const posisi = (asOf: string, aset: ReturnType<typeof row>[], laba: number) =>
    ({
      asOfDate: asOf,
      aset,
      liabilitas: [row('2-1000', 'Simpanan anggota', 100)],
      ekuitas: [row('3-2100', 'Cadangan Risiko', 10), row('3-1000', 'Simpanan Pokok', 20)],
      labaBerjalan: laba,
      labaBerjalanLabel: 'Sisa hasil usaha',
      totalAset: aset.reduce((t, x) => t + x.saldo, 0),
      totalLiabilitas: 100,
      totalEkuitas: 30 + laba,
      isBalanced: true,
      selisih: 0,
      termasukSaldoAwalDraft: false,
    }) as unknown as PosisiKeuanganResult;
  const aset = [
    row('1-1800', 'RAKU', 5),
    row('1-1210', 'Penyisihan Piutang', -10),
    row('1-1205', 'Piutang Jasa Pinjaman', 7),
    row('1-1200', 'Piutang Pinjaman Anggota', 200),
    row('1-1000', 'Kas', 30),
  ];
  const d = buildPosisiKeuanganKomparatifExport(info, {
    sekarang: posisi('2022-12-31', aset, 50),
    pembanding: posisi('2021-12-31', aset, 40),
    perubahanTotalAset: 0,
    perubahanTotalLiabilitas: 0,
    perubahanTotalEkuitas: 0,
    peringatanPeriode: null,
  });
  const t = d.laporanKeuangan!.juklat!;

  it('akun pengurang tepat di bawah akun yang dikuranginya dan menjorok', () => {
    const label = t.baris.map((b) => b.label);
    expect(label.indexOf('Penyisihan Piutang')).toBe(label.indexOf('Piutang Pinjaman Anggota') + 1);
    expect(t.baris.find((b) => b.label === 'Penyisihan Piutang')?.tingkat).toBe('KONTRA');
    // Poin 11 tetap: RAKU tepat di bawah Piutang Jasa Pinjaman.
    expect(label.indexOf('RAKU')).toBe(label.indexOf('Piutang Jasa Pinjaman') + 1);
    // Poin 9 tetap: SHU tepat di bawah Cadangan Risiko.
    expect(label.indexOf('Sisa hasil usaha')).toBe(label.indexOf('Cadangan Risiko') + 1);
  });

  it('total naskah: Total aset / Total liabilitas / Total ekuitas / Total liabilitas dan ekuitas; kolom 2021 → 2022', () => {
    const label = t.baris.map((b) => b.label);
    for (const x of ['ASET', 'Total aset', 'LIABILITAS', 'Total liabilitas', 'EKUITAS', 'Total ekuitas', 'Total liabilitas dan ekuitas']) {
      expect(label).toContain(x);
    }
    expect(t.kolom).toEqual(['2021', '2022']);
    expect(t.periode).toBe('Tanggal 31 Desember 2021 dan 2022 (Dalam Rupiah)');
    expect(t.baris.find((b) => b.label === 'Total liabilitas dan ekuitas')?.nilai).toEqual([170, 180]);
  });

  it('urutan penyajian bersama: penyisihan langsung di bawah pinjaman (layar & PDF sama)', () => {
    expect(URUTAN_PENYAJIAN_ASET.indexOf('1-1210')).toBe(URUTAN_PENYAJIAN_ASET.indexOf('1-1200') + 1);
    expect(URUTAN_PENYAJIAN_ASET.indexOf('1-1800')).toBe(URUTAN_PENYAJIAN_ASET.indexOf('1-1205') + 1);
    expect(URUTAN_PENYAJIAN_ASET.indexOf('1-1900')).toBe(URUTAN_PENYAJIAN_ASET.indexOf('1-1620') + 1);
    expect(URUTAN_PENYAJIAN_EKUITAS.length).toBeGreaterThan(0);
  });
});

describe('Laporan Arus Kas = Lampiran contoh arus kas', () => {
  const m = (aktivitas: string, sumberTransaksi: string, jumlah: number) => ({ aktivitas, sumberTransaksi, deskripsi: '', jumlah });
  const ak = (tahun: number, rincian: ReturnType<typeof m>[], awal: number) => {
    const naik = rincian.reduce((t, x) => t + x.jumlah, 0);
    return {
      tanggalMulai: `${tahun}-01-01`,
      tanggalSelesai: `${tahun}-12-31`,
      operasi: 0,
      investasi: 0,
      pendanaan: 0,
      kasAwal: awal,
      perubahanKas: naik,
      kasAkhirDihitung: awal + naik,
      kasAkhirAktual: awal + naik,
      terekonsiliasi: true,
      selisihRekonsiliasi: 0,
      rincian,
    } as unknown as ArusKasResult;
  };
  const a = ak(2021, [m('OPERASI', 'SIMPANAN_SUKARELA', 84_150_000), m('PENDANAAN', 'SHU_DISTRIBUSI', -68_000_000)], 13_400_000);
  const b = ak(2022, [m('OPERASI', 'SIMPANAN_SUKARELA', 40_600_000), m('INVESTASI', 'ASET_TETAP', -50_000_000)], a.kasAkhirDihitung);
  const t = buildArusKasKomparatifExport(info, { sekarang: b, pembanding: a, perubahanKasAkhir: 0, peringatanPeriode: null }).laporanKeuangan!.juklat!;

  it('komparatif kini memuat RINCIAN pos per kegiatan (bukan hanya total), band & penutup naskah', () => {
    const label = t.baris.map((x) => x.label);
    for (const x of ['KEGIATAN OPERASI', 'Jumlah arus kas operasi', 'KEGIATAN INVESTASI', 'Jumlah arus kas investasi', 'KEGIATAN PENDANAAN', 'Jumlah arus kas pendanaan', 'SALDO AWAL', 'SALDO AKHIR']) {
      expect(label).toContain(x);
    }
    expect(t.baris.find((x) => x.label === 'Penerimaan simpanan anggota')?.nilai).toEqual([84_150_000, 40_600_000]);
    expect(t.baris.find((x) => x.label === 'SALDO AKHIR')?.nilai).toEqual([a.kasAkhirDihitung, b.kasAkhirDihitung]);
  });

  it('label RAKU juga dipakai di arus kas', () => {
    const src = readFileSync(join(__dirname, '..', 'reports', 'ArusKasJuklat.ts'), 'utf8');
    expect(src).toContain("RAK: { label: 'Rekening antar kantor/unit (RAKU)'");
  });
});

describe('dua template PDF: Standar (bawaan) dan Contoh Laporan Juklat SOM 2025', () => {
  const dasar = buildLHUExport(info, L2022, 'Laporan Perhitungan Hasil Usaha');

  it('JUKLAT (dipilih) -> format contoh Lampiran Juklat', () => {
    const html = buildReportHtml({ ...dasar, laporanKeuangan: { ...dasar.laporanKeuangan!, gayaPdf: 'JUKLAT' as const } });
    expect(html).toContain('<table class="juklat">');
    expect(html).toContain('Tahun yang berakhir 31 Desember 2022');
  });

  it('tanpa pilihan / STANDAR -> tampilan Standar (tabel data, angka Rp, ringkasan) dengan tanda tangan', () => {
    for (const d of [dasar, { ...dasar, laporanKeuangan: { ...dasar.laporanKeuangan!, gayaPdf: 'STANDAR' as const } }]) {
      const html = buildReportHtml(d);
      expect(html).not.toContain('<table class="juklat">');
      expect(html).toContain('<table class="data">');
      expect(html).toContain('<body class="lk">');
      expect(html).toContain('Rp');
      expect(html).toContain('class="ringkasan"');
      expect(html).toContain('<div class="ttd-jabatan">Ketua</div>');
    }
  });

  it('lembar Export menampilkan pilihan hanya untuk laporan keuangan, dan meneruskannya ke data PDF', () => {
    const tombol = readFileSync(join(__dirname, '..', 'components', 'ExportButton.tsx'), 'utf8');
    expect(tombol).toContain("label: 'Contoh Laporan Juklat SOM 2025'");
    expect(tombol).toContain("label: 'Standar'");
    expect(tombol).toMatch(/const adaPilihanGaya = !!dataLaporan\?\.laporanKeuangan\?\.juklat;/);
    expect(tombol).toMatch(/format === 'PDF' && dataLaporan\.laporanKeuangan[\s\S]{0,120}gayaPdf/);
  });

  it('pilihan terakhir diingat di app_config (tanpa tabel baru), bawaan Standar', () => {
    const svc = readFileSync(join(__dirname, '..', 'services', 'PreferensiCetakService.ts'), 'utf8');
    expect(svc).toContain("export const GAYA_PDF_BAWAAN: GayaPdfLaporanKeuangan = 'STANDAR';");
    expect(svc).toMatch(/INSERT INTO app_config/);
  });
});

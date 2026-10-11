/**
 * RC-S83 — Export Detail Anggota: Simpanan Berjangka ikut ter-export &
 * dokumen tersusun per seksi (PDF/Excel/CSV).
 */
import { buildAnggotaDetailExport, InfoKoperasiExport, RingkasanAnggotaExport } from '@/export/ReportTableBuilders';
import { buildReportHtml } from '@/export/HtmlReportBuilder';
import { buildCsv } from '@/export/CsvExporter';
import { buildSheetSeksi } from '@/export/ExcelSeksiBuilder';
import type { Anggota, HistoriTransaksiRow } from '@/repositories/AnggotaRepository';
import type { SimpananBerjangkaRow } from '@/services/SimpananBerjangkaService';
import type { DataLaporanExport, SeksiTabel } from '@/export/ExportTypes';

const INFO: InfoKoperasiExport = { namaKoperasi: 'Koperasi Sejahtera', alamatKoperasi: 'Jl. Merdeka 1', standarAkuntansi: 'SAK_EP' };

const ANGGOTA: Anggota = {
  id: 'a1',
  nomorAnggota: 'A001',
  nik: '1234567890123456',
  namaLengkap: 'Budi <Santoso>',
  tanggalBergabung: '2020-01-15',
  status: 'AKTIF',
  alamat: 'Jl. Panjang Sekali Nomor 123, Kelurahan Contoh, Kecamatan Contoh, Makassar',
};

const RINGKASAN: RingkasanAnggotaExport = {
  simpananPokok: 500_000,
  simpananWajib: 1_000_000,
  simpananSukarela: 2_000_000,
  totalPinjaman: 10_000_000,
  totalAngsuran: 3_000_000,
  sisaPinjaman: 7_500_000,
  sisaPinjamanPokok: 6_000_000,
  sisaJasaPinjaman: 1_500_000,
};

const HISTORI: HistoriTransaksiRow[] = [
  { id: 'h2', tanggal: '2026-03-01', jenis: 'Simpanan WAJIB', tipe: 'SETOR', nominal: 100_000, nomorReferensi: 'SW-002' },
  { id: 'h1', tanggal: '2026-01-01', jenis: 'Simpanan POKOK', tipe: 'SETOR', nominal: 500_000, nomorReferensi: 'SP-001' },
];

function kontrak(p: Partial<SimpananBerjangkaRow>): SimpananBerjangkaRow {
  return {
    id: 'k',
    anggotaId: 'a1',
    nomorTransaksi: 'SB-001',
    tanggalMulai: '2026-01-10',
    tanggalJatuhTempo: '2026-07-10',
    nominal: 5_000_000,
    tenorBulan: 6,
    sukuBungaPerTahun: 6,
    status: 'AKTIF',
    sumberDana: 'KAS',
    bankAccountId: null,
    keterangan: null,
    journalId: null,
    createdAt: '2026-01-10',
    bungaTerakru: 25_000,
    bungaDibayar: 0,
    tanggalPencairan: null,
    journalPencairanId: null,
    ...p,
  };
}

const BERJANGKA = {
  ringkasan: {
    saldoPokok: 5_000_000,
    jumlahKontrakAktif: 1,
    jatuhTempoTerdekat: '2026-07-10',
    bungaTerakru: 25_000,
    rentangSukuBunga: '6%',
  },
  kontrak: [
    kontrak({ id: 'k1' }),
    kontrak({ id: 'k0', nomorTransaksi: 'SB-000', tanggalMulai: '2025-01-05', status: 'DICAIRKAN', nominal: 2_000_000, bungaTerakru: 0, bungaDibayar: 60_000, tanggalPencairan: '2025-07-05' }),
  ],
  periodeBunga: [
    { kontrakId: 'k1', nomorKontrak: 'SB-001', nomorPeriode: 1, tanggalAkhirPeriode: '2026-02-10', bunga: 25_000, status: 'SUDAH_DIPINDAHKAN' as const, journalTransferId: 'j1' },
    { kontrakId: 'k1', nomorKontrak: 'SB-001', nomorPeriode: 2, tanggalAkhirPeriode: '2026-03-10', bunga: 25_000, status: 'BELUM_JATUH_TEMPO' as const, journalTransferId: null },
  ],
};

function build(withBerjangka = true): DataLaporanExport {
  return buildAnggotaDetailExport(INFO, ANGGOTA, RINGKASAN, HISTORI, '2026-09-24', withBerjangka ? BERJANGKA : undefined);
}

function seksi(data: DataLaporanExport, judul: string) {
  return data.seksi?.find((s) => s.judul === judul);
}

describe('RC-S83 buildAnggotaDetailExport — Simpanan Berjangka', () => {
  test('ringkasan memuat Simpanan Berjangka dan TIDAK mengubah Total Simpanan (domain terpisah)', () => {
    const d = build();
    const nilai = (l: string) => d.ringkasan?.find((r) => r.label === l)?.nilai;
    expect(nilai('Simpanan Berjangka (Pokok)')).toBe('Rp5.000.000');
    expect(nilai('Bunga Simpanan Berjangka Terakru')).toBe('Rp25.000');
    expect(nilai('Total Simpanan')).toBe('Rp3.500.000');
  });

  test('rincian kontrak memuat SELURUH kontrak (termasuk dicairkan), urut tanggal mulai', () => {
    const t = seksi(build(), 'Rincian Kontrak Simpanan Berjangka') as SeksiTabel;
    expect(t.baris.map((r) => r[0])).toEqual(['SB-000', 'SB-001']);
    expect(t.baris[0][8]).toBe('Dicairkan (5 Jul 2025)');
    expect(t.baris[0][7]).toBe(60_000);
  });

  test('jadwal bunga per periode ikut, dengan total', () => {
    const t = seksi(build(), 'Jadwal Bunga Simpanan Berjangka per Periode') as SeksiTabel;
    expect(t.baris).toHaveLength(2);
    expect(t.barisTotal?.[3]).toBe(50_000);
    expect(t.baris[0][4]).toBe('Sudah Dipindahkan');
  });

  test('tanpa data berjangka: tidak ada baris/seksi berjangka, label lama tetap', () => {
    const d = build(false);
    expect(d.ringkasan?.some((r) => r.label.includes('Berjangka'))).toBe(false);
    expect(d.seksi?.some((s) => s.judul.includes('Berjangka'))).toBe(false);
    expect(d.ringkasan?.find((r) => r.label === 'Sisa Pinjaman')?.nilai).toBe('Rp7.500.000');
  });

  test('histori di seksi disusun kronologis dan diberi nomor', () => {
    const t = seksi(build(), 'Histori Transaksi') as SeksiTabel;
    expect(t.baris.map((r) => r[4])).toEqual(['SP-001', 'SW-002']);
    expect(t.baris[0][0]).toBe('1');
    expect(t.baris[0][2]).toBe('Simpanan Pokok');
    expect(t.baris[0][3]).toBe('Setor');
  });
});

describe('RC-S83 renderer dokumen berseksi', () => {
  test('PDF (HTML): A4, seksi berjangka tampil, teks di-escape', () => {
    const html = buildReportHtml(build());
    expect(html).toContain('size: A4 portrait');
    expect(html).toContain('Rincian Kontrak Simpanan Berjangka');
    expect(html).toContain('SB-000');
    expect(html).toContain('Rp5.000.000');
    expect(html).toContain('Budi &lt;Santoso&gt;');
    expect(html).not.toContain('Budi <Santoso>');
  });

  test('laporan TANPA seksi tetap memakai template lama', () => {
    const d = build();
    const lama = buildReportHtml({ ...d, seksi: undefined });
    expect(lama).not.toContain('size: A4 portrait');
    expect(lama).toContain('table class="data"');
  });

  test('CSV: judul seksi & kontrak berjangka ikut', () => {
    const csv = buildCsv(build());
    expect(csv).toContain('SIMPANAN BERJANGKA');
    expect(csv).toContain('SB-001');
    expect(csv).toContain('Total Simpanan,Rp3.500.000');
  });

  test('Excel: nominal ditulis sebagai angka & ditandai format Rupiah', () => {
    const sheet = buildSheetSeksi(build());
    expect(sheet.selRupiah.length).toBeGreaterThan(0);
    for (const [r, c] of sheet.selRupiah) expect(typeof sheet.aoa[r][c]).toBe('number');
    expect(sheet.aoa.some((row) => row[0] === 'SB-000')).toBe(true);
  });
});

describe('RC-S83.1 — bagian yang tidak dimiliki anggota tidak ditampilkan', () => {
  const TANPA_PINJAMAN: RingkasanAnggotaExport = {
    ...RINGKASAN,
    totalPinjaman: 0,
    totalAngsuran: 0,
    sisaPinjaman: 0,
    sisaPinjamanPokok: 0,
    sisaJasaPinjaman: 0,
    kolektibilitas: undefined,
  };
  const BERJANGKA_KOSONG = {
    ringkasan: { saldoPokok: 0, jumlahKontrakAktif: 0, jatuhTempoTerdekat: null, bungaTerakru: 0, rentangSukuBunga: null },
    kontrak: [],
    periodeBunga: [],
  };
  const judul = (d: DataLaporanExport) => (d.seksi ?? []).map((s) => s.judul);

  test('tanpa pinjaman: seksi Pinjaman tidak ada di PDF/Excel/CSV', () => {
    const d = buildAnggotaDetailExport(INFO, ANGGOTA, TANPA_PINJAMAN, HISTORI, '2026-09-24', BERJANGKA);
    expect(judul(d)).not.toContain('Pinjaman');
    expect(buildReportHtml(d)).not.toContain('Sisa Pinjaman');
    expect(buildCsv(d)).not.toContain('PINJAMAN\r\n');
  });

  test('pinjaman sudah lunas (sisa 0) tetap ditampilkan', () => {
    const d = buildAnggotaDetailExport(
      INFO, ANGGOTA, { ...TANPA_PINJAMAN, totalPinjaman: 5_000_000, totalAngsuran: 5_500_000 }, HISTORI, '2026-09-24'
    );
    expect(judul(d)).toContain('Pinjaman');
  });

  test('berjangka tanpa kontrak sama sekali: tidak ada seksi & baris ringkasan berjangka', () => {
    const d = buildAnggotaDetailExport(INFO, ANGGOTA, RINGKASAN, HISTORI, '2026-09-24', BERJANGKA_KOSONG);
    expect(judul(d).some((j) => j.includes('Berjangka'))).toBe(false);
    expect(d.ringkasan?.some((r) => r.label.includes('Berjangka'))).toBe(false);
    const histori = d.seksi?.find((s) => s.judul === 'Histori Transaksi');
    expect(histori?.catatan).not.toContain('berjangka');
  });

  test('hanya kontrak yang sudah dicairkan: ringkasan berjalan disembunyikan, rincian kontrak tetap ada', () => {
    const d = buildAnggotaDetailExport(INFO, ANGGOTA, RINGKASAN, HISTORI, '2026-09-24', {
      ...BERJANGKA_KOSONG,
      kontrak: [kontrak({ status: 'DICAIRKAN', tanggalPencairan: '2026-07-10', bungaTerakru: 0 })],
    });
    expect(judul(d)).not.toContain('Simpanan Berjangka');
    expect(judul(d)).toContain('Rincian Kontrak Simpanan Berjangka');
  });

  test('jenis simpanan bersaldo 0 tidak dicantumkan; semua 0 -> seksi Simpanan hilang', () => {
    const sebagian = buildAnggotaDetailExport(INFO, ANGGOTA, { ...RINGKASAN, simpananSukarela: 0 }, HISTORI, '2026-09-24');
    const t = sebagian.seksi?.find((s) => s.judul === 'Simpanan') as SeksiTabel;
    expect(t.baris.map((r) => r[0])).toEqual(['Simpanan Pokok', 'Simpanan Wajib']);
    expect(t.barisTotal?.[1]).toBe(1_500_000);

    const kosong = buildAnggotaDetailExport(
      INFO, ANGGOTA, { ...TANPA_PINJAMAN, simpananPokok: 0, simpananWajib: 0, simpananSukarela: 0 }, [], '2026-09-24'
    );
    expect(judul(kosong)).toEqual(['Data Anggota', 'Histori Transaksi']);
  });
});

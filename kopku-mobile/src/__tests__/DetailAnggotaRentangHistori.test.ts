import { readFileSync } from 'fs';
import { join } from 'path';
import { buildAnggotaDetailExport, InfoKoperasiExport, RingkasanAnggotaExport } from '@/export/ReportTableBuilders';
import { buildReportHtml } from '@/export/HtmlReportBuilder';
import { buildCsv } from '@/export/CsvExporter';
import type { Anggota, HistoriTransaksiRow } from '@/repositories/AnggotaRepository';
import type { SeksiTabel } from '@/export/ExportTypes';
import {
  OPSI_RENTANG_HISTORI,
  periodeRentangHistori,
  saringHistoriPerRentang,
  tanggalMulaiRentang,
} from '@/utils/rentangHistori';

/** Export Detail Anggota: histori transaksi dapat dipilih 3 / 6 / 12 bulan terakhir atau semua. */
const INFO: InfoKoperasiExport = { namaKoperasi: 'Koperasi Sejahtera', standarAkuntansi: 'SAK_EP' };
const ANGGOTA: Anggota = {
  id: 'a1',
  nomorAnggota: 'A001',
  nik: '1234567890123456',
  namaLengkap: 'Budi Santoso',
  tanggalBergabung: '2020-01-15',
  status: 'AKTIF',
};
const RINGKASAN: RingkasanAnggotaExport = {
  simpananPokok: 500_000,
  simpananWajib: 1_000_000,
  simpananSukarela: 2_000_000,
  totalPinjaman: 0,
  totalAngsuran: 0,
  sisaPinjaman: 0,
  sisaPinjamanPokok: 0,
  sisaJasaPinjaman: 0,
};
const CETAK = '2026-10-05';
const h = (id: string, tanggal: string): HistoriTransaksiRow => ({
  id, tanggal, jenis: 'Simpanan WAJIB', tipe: 'SETOR', nominal: 100_000, nomorReferensi: `SW-${id}`,
});
const HISTORI = [
  h('a', '2026-10-05'), // hari cetak
  h('b', '2026-07-05'), // tepat 3 bulan
  h('c', '2026-07-04'), // sehari sebelum batas 3 bulan
  h('d', '2026-04-05'), // tepat 6 bulan
  h('e', '2025-10-05'), // tepat 12 bulan
  h('f', '2025-10-04'),
  h('g', '2023-01-01'),
];

const tabelHistori = (d: ReturnType<typeof buildAnggotaDetailExport>) =>
  d.seksi!.find((s) => s.judul.startsWith('Histori Transaksi')) as SeksiTabel;

describe('rentang histori (murni)', () => {
  it('opsi: 3, 6, 12 bulan, semua', () => {
    expect(OPSI_RENTANG_HISTORI.map((o) => o.kunci)).toEqual(['3_BULAN', '6_BULAN', '12_BULAN', 'SEMUA']);
  });

  it('tanggal mulai mundur N bulan dari tanggal cetak, termasuk lintas tahun & akhir bulan', () => {
    expect(tanggalMulaiRentang('3_BULAN', CETAK)).toBe('2026-07-05');
    expect(tanggalMulaiRentang('6_BULAN', CETAK)).toBe('2026-04-05');
    expect(tanggalMulaiRentang('12_BULAN', CETAK)).toBe('2025-10-05');
    expect(tanggalMulaiRentang('3_BULAN', '2026-02-15')).toBe('2025-11-15');
    expect(tanggalMulaiRentang('3_BULAN', '2026-05-31')).toBe('2026-02-28');
    expect(tanggalMulaiRentang('3_BULAN', '2024-05-31')).toBe('2024-02-29');
    expect(tanggalMulaiRentang('SEMUA', CETAK)).toBeNull();
  });

  it('penyaringan inklusif di kedua ujung', () => {
    const id = (r: string) => saringHistoriPerRentang(HISTORI, r as never, CETAK).map((x) => x.id);
    expect(id('3_BULAN')).toEqual(['a', 'b']);
    expect(id('6_BULAN')).toEqual(['a', 'b', 'c', 'd']);
    expect(id('12_BULAN')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(id('SEMUA')).toEqual(HISTORI.map((x) => x.id));
    expect(periodeRentangHistori('3_BULAN', CETAK)).toBe('5 Juli 2026 s.d. 5 Oktober 2026');
  });
});

describe('buildAnggotaDetailExport dengan rentang histori', () => {
  it('default (tanpa argumen) = semua, judul & nama file tidak berubah', () => {
    const d = buildAnggotaDetailExport(INFO, ANGGOTA, RINGKASAN, HISTORI, CETAK);
    expect(tabelHistori(d).judul).toBe('Histori Transaksi');
    expect(tabelHistori(d).baris).toHaveLength(7);
    expect(d.namaFileDasar).toBe('detail-anggota-A001');
  });

  it('3 bulan: hanya transaksi periode itu di PDF/CSV, dengan judul, periode, dan nama file yang jelas', () => {
    const d = buildAnggotaDetailExport(INFO, ANGGOTA, RINGKASAN, HISTORI, CETAK, undefined, '3_BULAN');
    const t = tabelHistori(d);
    expect(t.judul).toBe('Histori Transaksi — 3 Bulan Terakhir');
    expect(t.baris).toHaveLength(2);
    expect(t.catatan).toContain('Periode 5 Juli 2026 s.d. 5 Oktober 2026: 2 dari 7 transaksi.');
    expect(d.baris).toHaveLength(2);
    expect(d.namaFileDasar).toBe('detail-anggota-A001-histori-3-bulan');
    expect(buildReportHtml(d)).not.toContain('SW-g');
    expect(buildCsv(d)).not.toContain('SW-c');
  });

  it('12 bulan & saldo tetap posisi per tanggal cetak', () => {
    const d = buildAnggotaDetailExport(INFO, ANGGOTA, RINGKASAN, HISTORI, CETAK, undefined, '12_BULAN');
    expect(tabelHistori(d).baris).toHaveLength(5);
    const simpanan = d.seksi!.find((s) => s.judul === 'Simpanan') as SeksiTabel;
    expect(simpanan.barisTotal).toEqual(['Total Simpanan', 3_500_000]);
  });

  it('periode tanpa transaksi menampilkan keterangan kosong yang jelas', () => {
    const d = buildAnggotaDetailExport(INFO, ANGGOTA, RINGKASAN, [h('x', '2020-01-01')], CETAK, undefined, '6_BULAN');
    expect(tabelHistori(d).baris).toHaveLength(0);
    expect(tabelHistori(d).teksKosong).toBe('Tidak ada transaksi pada periode 5 April 2026 s.d. 5 Oktober 2026.');
  });
});

describe('layar Detail Anggota', () => {
  const layar = readFileSync(join(__dirname, '..', 'screens', 'Anggota', 'AnggotaDetailScreen.tsx'), 'utf8');
  it('pilihan rentang ada di modal export dan diteruskan ke builder', () => {
    expect(layar).toContain('opsi: OPSI_RENTANG_HISTORI');
    expect(layar).toMatch(/rentangHistori\s*\)\s*:\s*null/);
  });
});

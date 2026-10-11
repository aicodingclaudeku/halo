import { buildKolektibilitasExport } from '@/export/ReportTableBuilders';
import { buildCsv } from '@/export/CsvExporter';
import { buildSheetSeksi } from '@/export/ExcelSeksiBuilder';
import { buildReportHtml } from '@/export/HtmlReportBuilder';
import { gayaiSheetSeksi } from '@/export/ExcelLaporanBuilder';
import { PERSENTASE_PENYISIHAN_SOM } from '@/services/KolektibilitasSomService';

/**
 * RC-S133.6.3 — export Kolektibilitas Piutang (temuan audit P1/P2):
 *  - indeks kolom Rupiah dulu [3, 4, 7, 9, 15] -> "Tunggakan Jasa (bulan)" tercetak
 *    Rp, sedangkan Angsuran Terbayar, Nilai Agunan, Nilai Penyisihan tidak;
 *  - angka fiskal PMK 74 yang tampil di layar tidak ikut berkas;
 *  - PDF A4 memotong tabel 19 kolom.
 */
const INFO = { namaKoperasi: 'KSP Uji' };

function item(o: Record<string, unknown>) {
  return {
    pinjamanId: 'p', nomorPinjaman: 'PJ-1', anggotaId: 'a', nomorAnggota: 'A001', namaAnggota: 'Budi',
    statusAnggota: 'AKTIF', saldoPiutang: 0, saldoPokok: 0, saldoJasa: 0, tanggalJatuhTempoTertunggak: null,
    hariTunggakan: 0, polaPengembalian: 'ANGSURAN' as const, masaAngsuranBulan: 1, bulanTunggakanPokok: 0,
    bulanTunggakanJasa: 0, nilaiAgunan: 0, angsuranTerbayar: 0, kewajibanKontraktual: 0, rasioAngsuranPersen: 0,
    rasioAgunanPersen: 0, bulanSejakDiragukan: 0, kolektibilitas: 'LANCAR' as const, dasarPenggolongan: 'Lancar — uji.',
    bermasalah: false, persentaseCadangan: 0, nilaiCadangan: 0,
    ...o,
  } as any;
}

const DAFTAR = [
  item({
    pinjamanId: 'p1', nomorPinjaman: 'PJ-1', nomorAnggota: 'A001', namaAnggota: 'Budi', saldoPiutang: 12_000_000,
    saldoPokok: 10_000_000, saldoJasa: 2_000_000, hariTunggakan: 200, bulanTunggakanPokok: 6, bulanTunggakanJasa: 7,
    angsuranTerbayar: 1_234_567, kewajibanKontraktual: 13_000_000, rasioAngsuranPersen: 9.5, nilaiAgunan: 2_000_000,
    rasioAgunanPersen: 16.7, kolektibilitas: 'MACET', bermasalah: true, persentaseCadangan: PERSENTASE_PENYISIHAN_SOM.MACET,
    nilaiCadangan: 10_000_000,
    dasarPenggolongan: 'Macet — tunggakan pokok 6 bulan (melewati ambang Kurang Lancar); angsuran terbayar baru 9.5% dari kewajiban (minimal 75%) dan agunan hanya 16.7% dari sisa utang (minimal 100%) — tidak memenuhi kriteria Diragukan.',
    kolektibilitasFiskal: 'MACET', dasarPencadanganFiskal: 8_000_000, persentaseCadanganFiskal: 100, cadanganFiskal: 8_000_000,
  }),
  item({
    pinjamanId: 'p2', nomorPinjaman: 'PJ-2', nomorAnggota: 'A002', namaAnggota: 'Sari', saldoPiutang: 4_500_000,
    saldoPokok: 4_000_000, saldoJasa: 500_000, angsuranTerbayar: 1_500_000, kewajibanKontraktual: 6_000_000,
    rasioAngsuranPersen: 25, nilaiAgunan: 5_000_000, rasioAgunanPersen: 111.1,
    kolektibilitasFiskal: 'LANCAR', dasarPencadanganFiskal: 4_000_000, persentaseCadanganFiskal: 0.5, cadanganFiskal: 20_000,
  }),
];

describe('RC-S133.6.3 — indeks kolom Rupiah', () => {
  test('kolom Rupiah = Saldo Piutang, Saldo Pokok, Angsuran Terbayar, Nilai Agunan, Nilai Penyisihan (+ dua kolom fiskal)', () => {
    const tanpaFiskal = buildKolektibilitasExport(INFO, 'P', DAFTAR.map(({ kolektibilitasFiskal, cadanganFiskal, ...d }: any) => d));
    expect(tanpaFiskal.kolomAngka.map((i) => tanpaFiskal.kolom[i])).toEqual([
      'Saldo Piutang (Pokok+Jasa)', 'Saldo Pokok (Outstanding)', 'Angsuran Terbayar', 'Nilai Agunan', 'Nilai Penyisihan',
    ]);
    expect(tanpaFiskal.kolomAngka).toEqual([3, 4, 10, 12, 17]);
    expect(tanpaFiskal.kolom.indexOf('Tunggakan Jasa (bulan)')).toBe(9);
    expect(tanpaFiskal.kolomAngka).not.toContain(9);

    const denganFiskal = buildKolektibilitasExport(INFO, 'P', DAFTAR);
    expect(denganFiskal.kolomAngka.map((i) => denganFiskal.kolom[i])).toEqual([
      'Saldo Piutang (Pokok+Jasa)', 'Saldo Pokok (Outstanding)', 'Angsuran Terbayar', 'Nilai Agunan', 'Nilai Penyisihan',
      'Dasar Pencadangan Fiskal', 'Cadangan Fiskal',
    ]);
    // setiap kolom yang ditandai Rupiah memang berisi angka nominal
    for (const i of denganFiskal.kolomAngka) expect(typeof denganFiskal.baris[0][i]).toBe('number');
  });

  test('CSV/HTML: bulan tunggakan jasa TIDAK tercetak Rupiah; angsuran terbayar tercetak Rupiah', () => {
    const d = buildKolektibilitasExport(INFO, 'P', DAFTAR);
    const csv = buildCsv(d);
    const html = buildReportHtml(d);
    for (const teks of [csv, html]) {
      expect(teks).toContain('Rp1.234.567');
      expect(teks).not.toContain('Rp7 ');
    }
  });
});

describe('RC-S133.6.3 — dokumen berseksi', () => {
  const d = buildKolektibilitasExport(INFO, '31 Maret 2026', DAFTAR, { lingkupAnggota: 'Anggota aktif', penyisihanTercatat: 9_000_000 });
  const seksi = d.seksi!;

  test('urutan seksi & lebar tabel muat A4 (≤ 9 kolom)', () => {
    expect(seksi.map((s) => s.judul)).toEqual([
      'Ringkasan',
      'Rekap per Kolektibilitas (SOM)',
      'Rincian per Pinjaman',
      'Dasar Penggolongan per Pinjaman',
      'Batasan Fiskal Cadangan Piutang (PMK 74/2024)',
      'Rincian Fiskal per Pinjaman',
      'Dasar & Catatan',
    ]);
    for (const s of seksi) if (s.jenis === 'TABEL') expect(s.kolom.length < 10).toBe(true);
  });

  test('ringkasan memuat angka yang tampil di layar: buku, tercatat, fiskal & arah koreksi', () => {
    const r = seksi[0];
    if (r.jenis !== 'KV') throw new Error('KV');
    const nilai = Object.fromEntries(r.baris.map((b) => [b.label, b.nilai]));
    expect(nilai['Lingkup anggota']).toBe('Anggota aktif');
    expect(nilai['Outstanding (saldo pokok)']).toBe('Rp14.000.000');
    expect(nilai['Pinjaman bermasalah']).toBe('Rp10.000.000 (71,43%) — 1 pinjaman');
    expect(nilai['Penyisihan menurut SOM (buku)']).toBe('Rp10.000.000');
    expect(nilai['Penyisihan tercatat di buku besar']).toBe('Rp9.000.000');
    expect(nilai['Penyesuaian penyisihan yang diperlukan']).toBe('Tambah Rp1.000.000');
    expect(nilai['Cadangan diakui fiskal (PMK 74/2024)']).toBe('Rp8.020.000');
    expect(nilai['Selisih buku − fiskal']).toBe('Rp1.980.000 — calon koreksi fiskal POSITIF SPT Badan');
  });

  test('rekap SOM & fiskal: total = jumlah rincian; persen bergaya Indonesia', () => {
    const rekap = seksi[1];
    if (rekap.jenis !== 'TABEL') throw new Error('TABEL');
    expect(rekap.baris[0]).toEqual(['Lancar', 1, 4_000_000, '28,6%', '0%', 0]);
    expect(rekap.baris[3]).toEqual(['Macet', 1, 10_000_000, '71,4%', '100%', 10_000_000]);
    // kategori tanpa pinjaman tetap menampilkan tarif SOM angka 15
    expect(rekap.baris[1]).toEqual(['Kurang Lancar', 0, 0, '0%', '50%', 0]);
    expect(rekap.baris[2]).toEqual(['Diragukan', 0, 0, '0%', '75%', 0]);
    expect(rekap.barisTotal).toEqual(['Jumlah', 2, 14_000_000, '100%', '', 10_000_000]);
    const fiskal = seksi[4];
    if (fiskal.jenis !== 'TABEL') throw new Error('TABEL');
    expect(fiskal.baris[0]).toEqual(['Lancar', 1, 4_000_000, '0,5%', 20_000, 0, -20_000]);
    expect(fiskal.barisTotal).toEqual(['Jumlah', 2, 12_000_000, '', 8_020_000, 10_000_000, 1_980_000]);
  });

  test('rincian diurutkan dari risiko tertinggi; dasar penggolongan memuat rasio & agunan', () => {
    const rinci = seksi[2];
    if (rinci.jenis !== 'TABEL') throw new Error('TABEL');
    expect(rinci.baris.map((b) => b[1])).toEqual(['PJ-1', 'PJ-2']);
    expect(rinci.baris[0]).toEqual(['A001 — Budi', 'PJ-1', 10_000_000, 12_000_000, '6 / 7', 200, 'Macet', '100%', 10_000_000]);
    const dasar = seksi[3];
    if (dasar.jenis !== 'TABEL') throw new Error('TABEL');
    expect(dasar.baris[1]).toEqual(['PJ-2', '1 bulan', 1_500_000, '25%', 5_000_000, '111,1%', 'Lancar — uji.']);
  });

  test('catatan menyebut penafsiran masa angsuran & kriteria Macet pengadilan/asuransi yang belum diterapkan', () => {
    const c = seksi[6];
    if (c.jenis !== 'KV') throw new Error('KV');
    const teks = c.baris.map((b) => `${b.label}: ${b.nilai}`).join(' ');
    expect(teks).toMatch(/tepat 1 bulan dan 4–5 bulan/);
    expect(teks).toMatch(/Pengadilan Negeri \/ klaim asuransi kredit belum tercatat/);
  });

  test('Excel berseksi: sel Rupiah hanya pada kolom nominal', () => {
    const sheet = buildSheetSeksi(d);
    for (const [r, c] of sheet.selRupiah) expect(typeof sheet.aoa[r][c]).toBe('number');
    const barisPj1 = sheet.aoa.findIndex((row) => row[1] === 'PJ-1' && row[4] === '6 / 7');
    expect(sheet.selRupiah.filter(([r]) => r === barisPj1).map(([, c]) => c)).toEqual([2, 3, 8]);
  });

  test('teks dasar penggolongan bergaya Indonesia; Excel membungkus teks panjang (tidak terpotong)', () => {
    const dasar = seksi[3];
    if (dasar.jenis !== 'TABEL') throw new Error('TABEL');
    expect(dasar.baris[0][6]).toMatch(/baru 9,5% dari kewajiban .* hanya 16,7% dari sisa utang/);
    const lembar = gayaiSheetSeksi(buildSheetSeksi(d), d.judulLaporan);
    const r = buildSheetSeksi(d).aoa.findIndex((row) => row[0] === 'PJ-1' && row[1] === '1 bulan');
    expect(lembar.sel[r][6]?.s?.alignment?.wrapText).toBe(true);
    expect((lembar.tinggiBaris[r]?.hpt ?? 0)).toBeGreaterThan(16);
  });

  test('tarif fiskal dari layar: kategori fiskal tanpa pinjaman tetap menampilkan % (bukan "-")', () => {
    // Nilai tarif di sini hanya MASUKAN UJI (sama dengan yang dikirim layar dari
    // KolektibilitasFiskalService.PERSENTASE_CADANGAN_FISKAL) — bukan sumber kebijakan.
    const tarif = { LANCAR: 0.5, KURANG_LANCAR: 10, DIRAGUKAN: 50, MACET: 100 };
    const t = buildKolektibilitasExport(INFO, 'P', DAFTAR, { tarifFiskal: tarif }).seksi![4];
    if (t.jenis !== 'TABEL') throw new Error('TABEL');
    expect(t.baris.map((b) => b[3])).toEqual(['0,5%', '10%', '50%', '100%']);
    // tanpa tarif: perilaku lama (dari item; kategori kosong "-")
    const tanpa = seksi[4];
    if (tanpa.jenis !== 'TABEL') throw new Error('TABEL');
    expect(tanpa.baris.map((b) => b[3])).toEqual(['0,5%', '-', '-', '100%']);
  });

  test('Excel berseksi: nilai ringkasan (digabung B..akhir) tidak melebarkan kolom B', () => {
    const lembar = buildSheetSeksi(d);
    // kolom B berisi No Pinjaman / Jumlah — bukan kalimat ringkasan terpanjang
    expect(lembar.lebarKolom[1] < 30).toBe(true);
    const r = lembar.aoa.findIndex((row) => row[0] === 'Pinjaman bermasalah');
    const g = gayaiSheetSeksi(lembar, d.judulLaporan);
    expect(g.merges.some((m) => m.s.r === r && m.s.c === 1 && m.e.c === g.lebarKolom.length - 1)).toBe(true);
  });

  test('Excel berseksi: judul kolom rata mengikuti isi TABELNYA sendiri; kode pendek tidak dibungkus', () => {
    const lembar = buildSheetSeksi(d);
    const g = gayaiSheetSeksi(lembar, d.judulLaporan);
    const kepala = lembar.aoa.findIndex((row, i) => lembar.peran[i] === 'KEPALA' && row[0] === 'Anggota');
    // "No Pinjaman" (teks) kiri walau tabel fiskal di bawahnya punya Rupiah di kolom B
    expect(g.sel[kepala][1]?.s?.alignment?.horizontal).toBe('left');
    expect(g.sel[kepala][2]?.s?.alignment?.horizontal).toBe('right'); // Outstanding
    const rekap = lembar.aoa.findIndex((row, i) => lembar.peran[i] === 'KEPALA' && row[0] === 'Kolektibilitas');
    expect(g.sel[rekap][1]?.s?.alignment?.horizontal).toBe('right'); // Jumlah (bilangan)
    expect(g.sel[rekap + 1][1]?.s?.alignment?.horizontal).toBe('right');
    const pj = lembar.aoa.findIndex((row) => row[1] === 'PJ-1' && row[4] === '6 / 7');
    // baris tidak ditinggikan & tidak rata atas hanya karena kode pendek
    expect(g.sel[pj][1]?.s?.alignment?.vertical).not.toBe('top');
    expect(g.tinggiBaris[pj]?.hpt).toBe(16);
  });
});

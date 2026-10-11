import { TestDb } from './testDb';

let testDb: TestDb;

jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import { buatFixtureHistoris, ACC, USER_ID } from './historicalFixture';
import { createJournal } from '@/accounting/AccountingEngine';
import { getLabaRugi, getPerubahanEkuitas, getPerubahanEkuitasKomparatif, getPosisiKeuangan } from '@/reports/FinancialReports';
import { buildPerubahanEkuitasExport } from '@/export/ReportTableBuilders';
import { tampilanEkuitasJuklat } from '@/export/JuklatPdf';

/**
 * RC-S133.6.1 — PENYAJIAN PERUBAHAN EKUITAS (keputusan pengguna setelah audit
 * manual-vs-impor; closing entry TIDAK ditambahkan).
 *
 * Bukti UI (metode A, per 31-03-2026): baris tunggal "SHU/Laba Tahun Berjalan
 * (belum dihitung, belum dibagikan)" bersaldo awal Rp3.887.083 (= SHU 2025 yang
 * justru SUDAH dibagikan 20-03-2026) dengan mutasi bersih −Rp4.399.941; hasil
 * usaha periode (−Rp512.858 = LHU) hanya ada di catatan kaki, dan alokasi
 * distribusi (Cadangan vs dana/simpanan) tidak terlihat.
 *
 * Aturan yang dikunci di sini:
 *   - saldo awal = ekuitas akhir tahun sebelumnya (tetap, F-4);
 *   - rincian HU_PERIODE = getLabaRugi periode yang sama (dihitung langsung);
 *   - rincian SHU_LALU = SHU tahun lalu belum dibagikan − distribusi (tidak dihitung dua kali);
 *   - jumlah rincian = baris SHU/hasil usaha; total = Posisi Keuangan;
 *   - distribusi dipisah: ke ekuitas (Cadangan) vs keluar ekuitas.
 */

const now = () => new Date().toISOString();
const ACC_SHU = 'acc-shu-berjalan';
const ACC_CADANGAN = 'acc-cadangan';
const ACC_DANA = 'acc-dana-pendidikan';

async function tambahAkun(db: TestDb, id: string, kode: string, nama: string, kategori: string, normal: 'DEBIT' | 'KREDIT') {
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, normal, now(), now()
  );
}

async function jurnal(tanggal: string, sumber: string, lines: [string, number, number][], sumberId?: string) {
  return createJournal(testDb as never, {
    tanggal, sumberTransaksi: sumber, sumberId, deskripsi: sumber, createdBy: USER_ID,
    lines: lines.map(([accountId, debit, kredit]) => ({ accountId, debit, kredit })),
  });
}

async function bagikan(tanggal: string) {
  await testDb.runAsync(
    `INSERT INTO shu_konfigurasi (id, tahun_buku, persen_cadangan, persen_jasa_modal, persen_jasa_usaha, persen_pendidikan,
       persen_sosial, persen_pengurus, persen_pengawas, persen_karyawan, persen_pembangunan_daerah_kerja,
       total_shu, status, created_at, updated_at)
     VALUES ('shu-2026',2026,25,35,35,5,0,0,0,0,0,8000000,'DIBAGIKAN',?,?)`,
    now(), now()
  );
  return jurnal(tanggal, 'SHU_DISTRIBUSI', [
    [ACC_SHU, 8_000_000, 0],
    [ACC_CADANGAN, 0, 2_000_000],
    [ACC_DANA, 0, 400_000],
    [ACC.simpananSukarela, 0, 5_600_000],
  ], 'shu-2026');
}

describe('RC-S133.6.1 — rincian baris SHU/hasil usaha di Perubahan Ekuitas', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
    await tambahAkun(testDb, ACC_SHU, '3-4000', 'SHU Tahun Berjalan', 'EKUITAS', 'KREDIT');
    await tambahAkun(testDb, ACC_CADANGAN, '3-2000', 'Cadangan', 'EKUITAS', 'KREDIT');
    await tambahAkun(testDb, ACC_DANA, '2-1800', 'Dana Pendidikan', 'LIABILITAS', 'KREDIT');
    // 2026: SHU 8 jt. 2027: rugi 500 rb sampai Maret (mirip bukti UI: periode berjalan negatif).
    await jurnal('2026-06-01', 'PENDAPATAN_LAIN', [[ACC.kas, 10_000_000, 0], [ACC.pendapatanLain, 0, 10_000_000]]);
    await jurnal('2026-07-01', 'BEBAN_LAIN', [[ACC.bebanLain, 2_000_000, 0], [ACC.kas, 0, 2_000_000]]);
    await jurnal('2027-02-01', 'BEBAN_LAIN', [[ACC.bebanLain, 500_000, 0], [ACC.kas, 0, 500_000]]);
  });

  test('sesudah distribusi: SHU_LALU 8 jt − 8 jt = 0; HU_PERIODE = LHU (−500 rb); jumlah rincian = baris SHU; total = Posisi', async () => {
    await bagikan('2027-03-20');
    const e = await getPerubahanEkuitas(testDb as never, '2027-01-01', '2027-03-31');
    const lr = await getLabaRugi(testDb as never, '2027-01-01', '2027-03-31');
    const p26 = await getPosisiKeuangan(testDb as never, '2026-12-31');
    const p = await getPosisiKeuangan(testDb as never, '2027-03-31');

    expect(e.totalSaldoAwal).toBe(p26.totalEkuitas);
    expect(e.lhuPeriode).toBe(lr.hasilUsaha);
    expect(e.lhuPeriode).toBe(-500_000);
    expect(e.rincianHasilUsaha).toEqual([
      { kunci: 'SHU_LALU', nama: expect.stringMatching(/dikurangi SHU yang dibagikan/), saldoAwal: 8_000_000, mutasi: -8_000_000, saldoAkhir: 0 },
      { kunci: 'HU_PERIODE', nama: expect.stringMatching(/Laporan Hasil Usaha/), saldoAwal: 0, mutasi: -500_000, saldoAkhir: -500_000 },
    ]);
    const r = e.rincianHasilUsaha!;
    expect(r.reduce((t, x) => t + x.saldoAwal, 0)).toBe(e.saldoAwalHasilUsaha);
    expect(r.reduce((t, x) => t + x.saldoAkhir, 0)).toBe(e.hasilUsahaPeriode);
    expect(e.hasilUsahaPeriode).toBe(p.labaBerjalan);
    expect(e.totalSaldoAkhir).toBe(p.totalEkuitas);
    // SHU 2026 hanya ada sekali: di saldo awal SHU_LALU (bukan juga di HU_PERIODE).
    expect(r.find((x) => x.kunci === 'HU_PERIODE')!.mutasi).not.toBe(8_000_000 - 500_000);
  });

  test('distribusi dipisah: 2 jt ke Cadangan (mutasi baris Cadangan ditandai), 6 jt keluar dari ekuitas', async () => {
    await bagikan('2027-03-20');
    const e = await getPerubahanEkuitas(testDb as never, '2027-01-01', '2027-03-31');
    expect(e.distribusiShuKeEkuitas).toBe(2_000_000);
    expect(e.distribusiShuKeLuarEkuitas).toBe(6_000_000);
    expect(e.shuDibagikanPeriode).toBe(e.distribusiShuKeEkuitas! + e.distribusiShuKeLuarEkuitas!);
    const cad = e.rows.find((x) => x.kode === '3-2000')!;
    expect(cad.mutasi).toBe(2_000_000);
    expect(cad.mutasiDistribusiShu).toBe(2_000_000);
    expect(e.rows.find((x) => x.kode !== '3-2000' && x.mutasiDistribusiShu)).toBeUndefined();
  });

  test('sebelum distribusi (per 28-02-2027): SHU_LALU tetap 8 jt, tidak ikut masuk HU_PERIODE', async () => {
    const e = await getPerubahanEkuitas(testDb as never, '2027-01-01', '2027-02-28');
    expect(e.rincianHasilUsaha).toEqual([
      { kunci: 'SHU_LALU', nama: 'SHU tahun buku sebelumnya (belum dibagikan)', saldoAwal: 8_000_000, mutasi: 0, saldoAkhir: 8_000_000 },
      { kunci: 'HU_PERIODE', nama: 'Hasil usaha periode berjalan (Laporan Hasil Usaha)', saldoAwal: 0, mutasi: -500_000, saldoAkhir: -500_000 },
    ]);
    expect(e.hasilUsahaPeriode).toBe(7_500_000);
    expect((await getPosisiKeuangan(testDb as never, '2027-02-28')).labaBerjalan).toBe(7_500_000);
  });

  test('tahun pertama: tanpa rincian (perilaku lama)', async () => {
    const e = await getPerubahanEkuitas(testDb as never, '2026-01-02', '2026-12-31');
    expect(e.rincianHasilUsaha).toEqual([]);
    expect(e.lhuPeriode).toBe(8_000_000);
  });

  test('distribusi yang dibatalkan (jurnal pembalik) → bersih nol, rincian tetap menjumlah', async () => {
    await bagikan('2027-03-20');
    // Pembalik berbentuk jurnal ber-sumber SHU_DISTRIBUSI dengan sisi terbalik
    // (reverseJournal() menyalin sumber_transaksi; tanggalnya = hari ini, di luar periode uji).
    await jurnal('2027-03-25', 'SHU_DISTRIBUSI', [
      [ACC_SHU, 0, 8_000_000],
      [ACC_CADANGAN, 2_000_000, 0],
      [ACC_DANA, 400_000, 0],
      [ACC.simpananSukarela, 5_600_000, 0],
    ], 'shu-2026');
    const e = await getPerubahanEkuitas(testDb as never, '2027-01-01', '2027-03-31');
    expect(e.shuDibagikanPeriode).toBe(0);
    expect(e.distribusiShuKeEkuitas).toBe(0);
    expect(e.distribusiShuKeLuarEkuitas).toBe(0);
    const r = e.rincianHasilUsaha!;
    expect(r.reduce((t, x) => t + x.saldoAkhir, 0)).toBe(e.hasilUsahaPeriode);
    expect(e.totalSaldoAkhir).toBe((await getPosisiKeuangan(testDb as never, '2027-03-31')).totalEkuitas);
  });

  test('mutasi akun kliring SHU di luar distribusi → baris SELISIH tampil (tidak disembunyikan)', async () => {
    await jurnal('2027-03-01', 'JURNAL_UMUM', [[ACC_SHU, 100_000, 0], [ACC.kas, 0, 100_000]]);
    const e = await getPerubahanEkuitas(testDb as never, '2027-01-01', '2027-03-31');
    const r = e.rincianHasilUsaha!;
    expect(r.map((x) => x.kunci)).toContain('SELISIH');
    expect(r.reduce((t, x) => t + x.saldoAkhir, 0)).toBe(e.hasilUsahaPeriode);
    expect(r.find((x) => x.kunci === 'HU_PERIODE')!.mutasi).toBe(-500_000);
    expect(r.find((x) => x.kunci === 'SHU_LALU')!.mutasi).toBe(0); // bukan distribusi
    expect(r.find((x) => x.kunci === 'SELISIH')!.mutasi).toBe(-100_000);
  });

  test('ekspor tabel: baris SHU lama tetap ada + rincian berindentasi; PDF Juklat: keterangan memuat rincian & alokasi distribusi', async () => {
    await bagikan('2027-03-20');
    const e = await getPerubahanEkuitas(testDb as never, '2027-01-01', '2027-03-31');
    const ex = buildPerubahanEkuitasExport({ namaKoperasi: 'Uji', standarAkuntansi: 'SAK EP' } as never, e);
    const iShu = ex.baris.findIndex((b) => b[0] === e.hasilUsahaPeriodeLabel);
    expect(ex.baris[iShu]).toEqual([e.hasilUsahaPeriodeLabel, 8_000_000, -8_500_000, -500_000]);
    expect(ex.baris.slice(iShu + 1).map((b) => b.slice(1))).toEqual([
      [8_000_000, -8_000_000, 0],
      [0, -500_000, -500_000],
    ]);
    expect(ex.tingkatBaris?.slice(iShu + 1)).toEqual(['RINCIAN', 'RINCIAN']);
    expect(ex.tingkatBaris?.slice(0, iShu + 1).every((t) => t === undefined)).toBe(true);
    expect(ex.ringkasan?.find((r) => /keluar dari ekuitas/.test(r.label))?.nilai).toBe('Rp6.000.000');
    const pdf = tampilanEkuitasJuklat([e]);
    const ket = pdf.keterangan?.[0].baris.join(' | ') ?? '';
    expect(ket).toMatch(/Hasil usaha periode berjalan \(Laporan Hasil Usaha\).*-?500/);
    expect(ket).toMatch(/Distribusi SHU ke Cadangan\/akun ekuitas: Rp 2\.000\.000/);
  });

  test('komparatif: kedua periode membawa rincian sendiri', async () => {
    await bagikan('2027-03-20');
    const k = await getPerubahanEkuitasKomparatif(testDb as never, { mulai: '2027-01-01', selesai: '2027-03-31' }, { mulai: '2026-01-01', selesai: '2026-03-31' });
    expect(k.sekarang.rincianHasilUsaha?.map((x) => x.kunci)).toEqual(['SHU_LALU', 'HU_PERIODE']);
    expect(k.pembanding.rincianHasilUsaha).toEqual([]);
  });
});

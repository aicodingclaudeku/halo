import { readFileSync } from 'fs';
import { join } from 'path';
import type { TestDb } from './testDb';
import { buatDbCoaLengkap, seedJurnal, accId, USER, FAKE_TIMERS_DATE_ONLY } from './rcs54Tahap16Fixture';

let testDb: TestDb;

jest.mock('@/database/db', () => ({
  ...jest.requireActual<typeof import('@/database/db')>('@/database/db'),
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import { migrasiV73 } from '@/database/db';
import { beliAset, hapusAset, updateAset, listAsetDenganNilaiBuku, KoreksiAsetTetapDitolakError } from '@/services/AsetService';
import { prosesPenyusutanAset, getStatusPenyusutanPeriode } from '@/services/PenyusutanService';
import {
  simpanKonfigurasiPenyusutanProperti,
  prosesPenyusutanPropertiInvestasi,
  getPeriodePenyusutanPropertiTertunggak,
} from '@/services/PenyusutanPropertiInvestasiService';
import {
  simpanDraftNilaiWajar,
  postingNilaiWajar,
  previewPenilaian,
  listObjekNilaiWajarEligible,
  getRingkasanNilaiWajar,
  bagiSelisihRevaluasi,
  KODE_NILAI_WAJAR,
  SUMBER_TRANSAKSI_REVALUASI_ASET_TETAP,
  KEBIJAKAN_PENGUKURAN_ASET_TETAP,
} from '@/services/PenyesuaianNilaiWajarService';
import { lepaskanAsetTetap } from '@/services/PelepasanAsetTetapService';
import { lepaskanInvestasi } from '@/services/PelepasanInvestasiService';
import { getLHU, getLabaRugi, getPosisiKeuangan, getPerubahanEkuitas, getMutasiOci } from '@/reports/FinancialReports';
import { buildLHUExport } from '@/export/ReportTableBuilders';
import { SUMBER_JURNAL_REVALUASI_ASET_TETAP, SUMBER_JURNAL_OCI, KODE_AKUN_SURPLUS_REVALUASI } from '@/config/ociPolicy';
import { DEFAULT_ACCOUNTS, DEFAULT_ACCOUNT_MAPPING } from '@/config/defaultCOA';
import { CASH_FLOW_CLASSIFICATION } from '@/accounting/CashFlowClassification';

/**
 * RC-S88 — PENYESUAIAN NILAI WAJAR SESUAI SAK EP & OCI DI LAPORAN HASIL USAHA.
 *
 *  - Aset tetap (model revaluasi, Bab 17): kenaikan -> OCI (3-6000), penurunan
 *    -> surplus aset yang sama dulu lalu laba rugi (5-5100), kenaikan berikutnya
 *    memulihkan rugi lalu (4-2200) sebelum OCI.
 *  - Penyusutan prospektif dari nilai revaluasi atas sisa masa manfaat.
 *  - Properti investasi (model nilai wajar, Bab 16): berhenti disusutkan.
 *  - LHU: pos OCI + Total Penghasilan Komprehensif; SHU Neto tidak berubah.
 *  - Pelepasan membersihkan akun penyesuai (1-1520 / 1-1665).
 */

const BUKTI = { dasarPenilaian: 'Laporan KJPP', referensiBukti: 'KJPP-2026-088', penilai: 'KJPP Uji' };
const saldoAkun = (rows: { kode: string; saldo: number }[], kode: string) => rows.find((r) => r.kode === kode)?.saldo ?? 0;

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-09-17T03:00:00Z'), ...FAKE_TIMERS_DATE_ONLY } as never);
  testDb = await buatDbCoaLengkap();
});
afterEach(() => {
  testDb.closeSync();
  jest.useRealTimers();
});

async function aset(opsi: { nilai?: number; masa?: number; tanggal?: string; jenis?: 'TETAP' | 'TAK_BERWUJUD' } = {}): Promise<string> {
  const tanggal = opsi.tanggal ?? '2026-01-05';
  const r = await beliAset({
    namaAset: 'Gedung Kantor', nilaiPerolehan: opsi.nilai ?? 120_000_000, nilaiResidu: 0, masaManfaatBulan: opsi.masa ?? 12,
    tanggal, tanggalPerolehan: tanggal, metodePembayaran: 'TUNAI', sumberDana: 'KAS', createdBy: USER, jenisAset: opsi.jenis ?? 'TETAP',
  } as never);
  return (r as { id: string }).id;
}
const susut = async (id: string, periode: string[]) => {
  for (const p of periode) await prosesPenyusutanAset({ asetId: id, periode: p, createdBy: USER });
};
async function revaluasi(asetId: string, tanggal: string, nilaiWajar: number) {
  const d = await simpanDraftNilaiWajar({ objek: 'ASET_TETAP', asetTetapId: asetId, tanggal, nilaiWajar, ...BUKTI, createdBy: USER });
  return postingNilaiWajar(d.id, { userId: USER });
}
async function entri(journalId: string | null) {
  return testDb.getAllAsync<{ kode: string; debit: number; kredit: number }>(
    `SELECT a.kode, je.debit, je.kredit FROM journal_entry je JOIN account a ON a.id = je.account_id WHERE je.journal_id = ? ORDER BY je.urutan, je.rowid`,
    journalId
  );
}

// ===========================================================================
// COA & kebijakan
// ===========================================================================

describe('RC-S88 — COA, mapping, kebijakan', () => {
  it('akun baru & mapping resmi tersedia; arus kas NON_KAS; sumber OCI konsisten', () => {
    const akun = (k: string) => DEFAULT_ACCOUNTS.find((a) => a.kode === k);
    expect(akun('1-1520')).toMatchObject({ kategori: 'ASET', normalBalance: 'DEBIT' });
    expect(akun('1-1665')).toMatchObject({ kategori: 'ASET', normalBalance: 'DEBIT' });
    expect(akun('3-6000')).toMatchObject({ nama: 'Surplus Revaluasi Aset Tetap', kategori: 'EKUITAS', normalBalance: 'KREDIT' });
    expect(akun('4-2200')).toMatchObject({ kategori: 'PENDAPATAN', lhuKlasifikasi: 'PENDAPATAN_LAIN' });
    expect(akun('5-5100')).toMatchObject({ kategori: 'BEBAN', lhuKlasifikasi: 'BEBAN_LAIN' });
    const m = (t: string) => DEFAULT_ACCOUNT_MAPPING.filter((x) => x.transactionType === t).map((x) => `${x.role}:${x.accountKode}`).sort();
    expect(m('REVALUASI_ASET_TETAP')).toEqual(['DEBIT_KERUGIAN:5-5100', 'KREDIT_PEMULIHAN:4-2200', 'PENYESUAIAN_ASET:1-1520', 'SURPLUS_OCI:3-6000']);
    expect(m('NILAI_WAJAR_PROPERTI_INVESTASI')).toEqual(['DEBIT_KERUGIAN:5-5000', 'KREDIT_KEUNTUNGAN:4-2100', 'PENYESUAIAN_ASET:1-1665']);
    expect(CASH_FLOW_CLASSIFICATION.PENYESUAIAN_NILAI_WAJAR).toBe('NON_KAS');
    expect(CASH_FLOW_CLASSIFICATION.REVALUASI_ASET_TETAP).toBe('NON_KAS');
    expect(SUMBER_TRANSAKSI_REVALUASI_ASET_TETAP).toBe(SUMBER_JURNAL_REVALUASI_ASET_TETAP);
    expect(SUMBER_JURNAL_OCI).toEqual(['REVALUASI_ASET_TETAP']);
    expect(KODE_AKUN_SURPLUS_REVALUASI).toBe('3-6000');
    expect(KEBIJAKAN_PENGUKURAN_ASET_TETAP).toBe('MODEL_REVALUASI');
  });

  it('pembagian selisih revaluasi (murni) sesuai SAK EP 17', () => {
    expect(bagiSelisihRevaluasi(30, 0, 0)).toEqual({ labaRugi: 0, oci: 30 });
    expect(bagiSelisihRevaluasi(-45, 30, 0)).toEqual({ labaRugi: -15, oci: -30 });
    expect(bagiSelisihRevaluasi(16, 0, 15)).toEqual({ labaRugi: 15, oci: 1 });
    expect(bagiSelisihRevaluasi(-10, 50, 0)).toEqual({ labaRugi: 0, oci: -10 });
    expect(bagiSelisihRevaluasi(0, 10, 10)).toEqual({ labaRugi: 0, oci: 0 });
  });
});

// ===========================================================================
// Revaluasi aset tetap -> OCI
// ===========================================================================

describe('RC-S88 — revaluasi aset tetap (OCI) end-to-end', () => {
  it('kenaikan -> OCI; penurunan -> surplus lalu laba rugi; kenaikan berikutnya memulihkan rugi lalu; penyusutan prospektif', async () => {
    const id = await aset();
    await susut(id, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']); // 6 x 10jt

    // 1) Pratinjau = eksekusi (penyusun yang sama).
    const pratinjau = await previewPenilaian({ objek: 'ASET_TETAP', objekId: id, nilaiWajar: 90_000_000, tanggal: '2026-06-30' });
    expect(pratinjau.nilaiTercatatSebelum).toBe(60_000_000);
    expect(pratinjau.selisih).toBe(30_000_000);
    expect(pratinjau.jumlahOci).toBe(30_000_000);
    expect(pratinjau.jumlahLabaRugi).toBe(0);
    expect(pratinjau.hambatan).toEqual([]);
    expect(pratinjau.baris.map((b) => [b.kode, b.debit, b.kredit])).toEqual([
      ['1-1520', 30_000_000, 0],
      ['3-6000', 0, 30_000_000],
    ]);

    const r1 = await revaluasi(id, '2026-06-30', 90_000_000);
    expect(r1.row.status).toBe('DIPOSTING');
    expect(await entri(r1.journalId)).toEqual([
      { kode: '1-1520', debit: 30_000_000, kredit: 0 },
      { kode: '3-6000', debit: 0, kredit: 30_000_000 },
    ]);
    const j1 = await testDb.getFirstAsync<{ sumber_transaksi: string }>(`SELECT sumber_transaksi FROM journal WHERE id = ?`, r1.journalId);
    expect(j1?.sumber_transaksi).toBe('REVALUASI_ASET_TETAP');

    // 2) Penyusutan prospektif: 90jt / sisa 6 bulan = 15jt.
    const status = await getStatusPenyusutanPeriode('2026-07', '2026-09-17');
    expect(status.find((s) => s.asetId === id)?.nilaiPenyusutanBulanan).toBe(15_000_000);
    await susut(id, ['2026-07']);
    const daftar = (await listAsetDenganNilaiBuku()).find((a) => a.id === id)!;
    expect(daftar.selisihRevaluasi).toBe(30_000_000);
    expect(daftar.akumulasiPenyusutan).toBe(75_000_000);
    expect(daftar.nilaiBuku).toBe(75_000_000); // 120 + 30 − 75
    expect(daftar.penyusutanPerBulan).toBe(15_000_000);

    // 3) Penurunan 45jt: 30jt dari surplus (OCI), 15jt ke laba rugi (5-5100).
    const r2 = await revaluasi(id, '2026-07-31', 30_000_000);
    expect(r2.row.jumlahOci).toBe(-30_000_000);
    expect(r2.row.jumlahLabaRugi).toBe(-15_000_000);
    expect(await entri(r2.journalId)).toEqual([
      { kode: '3-6000', debit: 30_000_000, kredit: 0 },
      { kode: '5-5100', debit: 15_000_000, kredit: 0 },
      { kode: '1-1520', debit: 0, kredit: 45_000_000 },
    ]);

    // Revaluasi tepat akhir bulan -> Agustus sudah memakai dasar baru: 30jt / 5 = 6jt.
    await susut(id, ['2026-08']);
    const agustus = await testDb.getFirstAsync<{ nilai_penyusutan: number }>(
      `SELECT nilai_penyusutan FROM aset_penyusutan WHERE aset_id = ? AND periode = '2026-08'`, id
    );
    expect(agustus?.nilai_penyusutan).toBe(6_000_000);

    // 4) Kenaikan 16jt: 15jt memulihkan rugi lalu (4-2200), 1jt ke OCI.
    const r3 = await revaluasi(id, '2026-08-31', 40_000_000);
    expect(r3.row.nilaiTercatatSebelum).toBe(24_000_000);
    expect(await entri(r3.journalId)).toEqual([
      { kode: '1-1520', debit: 16_000_000, kredit: 0 },
      { kode: '4-2200', debit: 0, kredit: 15_000_000 },
      { kode: '3-6000', debit: 0, kredit: 1_000_000 },
    ]);

    // 5) Laporan: OCI periode = 30 − 30 + 1 = 1jt; SHU Neto TIDAK memuat OCI.
    const lr = await getLabaRugi(testDb as never, '2026-01-01', '2026-12-31');
    expect(lr.penghasilanKomprehensifLain).toBe(1_000_000);
    expect(lr.penghasilanKomprehensifLainRows).toEqual([
      { kode: '3-6000', nama: 'Surplus revaluasi aset tetap', kelompok: 'TIDAK_DIREKLASIFIKASI', jumlah: 1_000_000 },
    ]);
    const lhu = await getLHU(testDb as never, '2026-01-01', '2026-12-31');
    expect(lhu.shuNeto).toBe(lr.hasilUsaha);
    expect(lhu.totalOci).toBe(1_000_000);
    expect(lhu.ociTidakDireklasifikasi).toEqual([{ kode: '3-6000', nama: 'Surplus revaluasi aset tetap', jumlah: 1_000_000 }]);
    expect(lhu.ociDireklasifikasi).toEqual([]);
    expect(lhu.totalPenghasilanKomprehensif).toBe(lhu.shuNeto + 1_000_000);
    // Rugi & pemulihan revaluasi ada di laba rugi (Pendapatan & Beban Lain), bukan OCI.
    expect(lhu.bebanLain.find((r) => r.kode === '5-5100')?.jumlah).toBe(15_000_000);
    expect(lhu.pendapatanLain.find((r) => r.kode === '4-2200')?.jumlah).toBe(15_000_000);

    // Export LHU memuat seksi OCI & total penghasilan komprehensif.
    const ekspor = buildLHUExport({ namaKoperasi: 'Kop', standarAkuntansi: 'SAK_EP' } as never, lhu, 'Laporan Hasil Usaha');
    // RC-S98 — indentasi rincian TIDAK LAGI ditempel ke dalam label ("   Nama").
    // Hierarki baris sekarang dinyatakan lewat `tingkatBaris` (lihat
    // ExportTypes.TingkatBarisLaporan), sehingga tiap renderer bisa
    // menampilkannya dengan cara yang pantas: indentasi CSS di PDF, spasi
    // di CSV/Excel. Labelnya sendiri kini bersih — itulah sebabnya
    // ekspektasi lama yang memuat tiga spasi diperbarui di sini.
    const indeksSurplus = ekspor.baris.findIndex((b) => b[0] === 'Surplus revaluasi aset tetap');
    expect(ekspor.baris[indeksSurplus]).toEqual(['Surplus revaluasi aset tetap', 1_000_000]);
    expect(ekspor.tingkatBaris?.[indeksSurplus]).toBe('RINCIAN');
    expect(ekspor.baris).toContainEqual(['TOTAL PENGHASILAN KOMPREHENSIF', lhu.totalPenghasilanKomprehensif]);

    // Posisi keuangan seimbang; surplus di ekuitas; perubahan ekuitas konsisten.
    const posisi = await getPosisiKeuangan(testDb as never, '2026-12-31');
    expect(posisi.isBalanced).toBe(true);
    expect(saldoAkun(posisi.aset, '1-1520')).toBe(1_000_000);
    expect(saldoAkun(posisi.ekuitas, '3-6000')).toBe(1_000_000);
    const pe = await getPerubahanEkuitas(testDb as never, '2026-01-01', '2026-12-31');
    expect(pe.rows.find((r) => r.kode === '3-6000')?.mutasi).toBe(1_000_000);
    expect(pe.totalSaldoAkhir).toBe(posisi.totalEkuitas);

    const ringkasan = await getRingkasanNilaiWajar();
    expect(ringkasan).toEqual({ jumlahDraft: 0, jumlahDiposting: 3, totalLabaRugi: 0, totalOci: 1_000_000 });

    // 6) Pelepasan membersihkan 1-1520; NBV memuat selisih revaluasi.
    const lepas = await lepaskanAsetTetap({ asetId: id, tanggalPelepasan: '2026-09-15', hasilPelepasan: 45_000_000, sumberDana: 'KAS', createdBy: USER });
    expect(lepas.pratinjau.selisihRevaluasi).toBe(1_000_000);
    expect(lepas.pratinjau.nilaiBuku).toBe(40_000_000); // 120 + 1 − 81
    expect(lepas.pratinjau.selisih).toBe(5_000_000);
    expect(await entri(lepas.journalId)).toEqual(
      expect.arrayContaining([
        { kode: '1-1520', debit: 0, kredit: 1_000_000 },
        { kode: '1-1500', debit: 0, kredit: 120_000_000 },
        { kode: '1-1510', debit: 81_000_000, kredit: 0 },
      ])
    );
    const posisi2 = await getPosisiKeuangan(testDb as never, '2026-12-31');
    expect(saldoAkun(posisi2.aset, '1-1520')).toBe(0);
    expect(posisi2.isBalanced).toBe(true);
  });

  it('gerbang: penyusutan belum lengkap, transaksi sesudah tanggal, urutan, aset tak berwujud', async () => {
    const id = await aset();
    // Belum ada penyusutan Jan–Mar -> nilai tercatat belum benar.
    const d1 = await simpanDraftNilaiWajar({ objek: 'ASET_TETAP', asetTetapId: id, tanggal: '2026-03-31', nilaiWajar: 100_000_000, ...BUKTI, createdBy: USER });
    await expect(postingNilaiWajar(d1.id, { userId: USER })).rejects.toThrow(KODE_NILAI_WAJAR.DEPRECIATION_INCOMPLETE);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = 'REVALUASI_ASET_TETAP'`))?.n).toBe(0);

    await susut(id, ['2026-01', '2026-02', '2026-03', '2026-04']);
    // Penyusutan April sudah diposting -> penilaian per Maret ditolak.
    await expect(postingNilaiWajar(d1.id, { userId: USER })).rejects.toThrow(KODE_NILAI_WAJAR.LATER_TRANSACTIONS);

    await revaluasi(id, '2026-04-30', 100_000_000);
    const lama = await simpanDraftNilaiWajar({ objek: 'ASET_TETAP', asetTetapId: id, tanggal: '2026-04-15', nilaiWajar: 1, ...BUKTI, createdBy: USER });
    await expect(postingNilaiWajar(lama.id, { userId: USER })).rejects.toThrow(KODE_NILAI_WAJAR.OUT_OF_ORDER);

    const atb = await aset({ jenis: 'TAK_BERWUJUD' });
    await expect(
      simpanDraftNilaiWajar({ objek: 'ASET_TETAP', asetTetapId: atb, tanggal: '2026-06-30', nilaiWajar: 1, ...BUKTI, createdBy: USER })
    ).rejects.toThrow(KODE_NILAI_WAJAR.ASSET_NOT_ELIGIBLE);
    expect((await listObjekNilaiWajarEligible('ASET_TETAP')).map((o) => o.id)).toEqual([id]);
  });

  it('aset yang sudah direvaluasi terkunci: tidak dapat dihapus sebagai koreksi, nilai struktural tidak dapat diubah', async () => {
    const id = await aset({ tanggal: '2026-09-02' });
    await revaluasi(id, '2026-09-10', 130_000_000); // belum ada periode penyusutan jatuh tempo
    await expect(hapusAset({ id, alasan: 'salah input', actingUserId: USER })).rejects.toBeInstanceOf(KoreksiAsetTetapDitolakError);
    await expect(updateAset({ id, namaAset: 'Gedung', nilaiPerolehan: 1_000, alasanKoreksi: 'x', actingUserId: USER } as never)).rejects.toThrow(
      /tidak dapat diubah/
    );
  });
});

// ===========================================================================
// OCI hanya dari jurnal OCI
// ===========================================================================

describe('RC-S88 — mesin OCI', () => {
  it('saldo awal / jurnal non-OCI ke 3-6000 bukan OCI periode; reversal menetralkan', async () => {
    await seedJurnal(testDb, 'j-sa', '2026-02-01', 'SALDO_AWAL_AKUN', [['1-1500', 5_000_000, 0], ['3-6000', 0, 5_000_000]]);
    expect(await getMutasiOci(testDb as never, '2026-01-01', '2026-12-31')).toEqual([]);
    await seedJurnal(testDb, 'j-rv', '2026-03-01', 'REVALUASI_ASET_TETAP', [['1-1520', 7_000_000, 0], ['3-6000', 0, 7_000_000]], { status: 'REVERSED' });
    await seedJurnal(testDb, 'j-rv-balik', '2026-03-02', 'REVALUASI_ASET_TETAP', [['3-6000', 7_000_000, 0], ['1-1520', 0, 7_000_000]]);
    expect(await getMutasiOci(testDb as never, '2026-01-01', '2026-12-31')).toEqual([]);
    await seedJurnal(testDb, 'j-rv2', '2026-04-01', 'REVALUASI_ASET_TETAP', [['1-1520', 2_000_000, 0], ['3-6000', 0, 2_000_000]]);
    expect((await getMutasiOci(testDb as never, '2026-01-01', '2026-12-31')).map((r) => r.jumlah)).toEqual([2_000_000]);
    expect(await getMutasiOci(testDb as never, '2026-05-01', '2026-12-31')).toEqual([]);
    expect(accId('3-6000')).toBe('acc-3-6000');
  });

  it('tanpa transaksi OCI: LHU tetap menampilkan struktur OCI bernilai 0 (bukan angka fiktif)', async () => {
    const lhu = await getLHU(testDb as never, '2026-01-01', '2026-12-31');
    expect(lhu.totalOci).toBe(0);
    expect(lhu.ociTidakDireklasifikasi).toEqual([]);
    expect(lhu.totalPenghasilanKomprehensif).toBe(lhu.shuNeto);
  });
});

// ===========================================================================
// Properti investasi — model nilai wajar
// ===========================================================================

describe('RC-S88 — properti investasi model nilai wajar', () => {
  const INV = 'inv-pi';
  async function seedProperti() {
    const now = new Date().toISOString();
    await seedJurnal(testDb, 'j-pi', '2026-01-05', 'INVESTASI_PROPERTI_INVESTASI', [['1-1660', 500_000_000, 0], ['1-1000', 0, 500_000_000]]);
    await testDb.runAsync(
      `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal, sumber_dana, journal_id, status, created_by, created_at, updated_at)
       VALUES (?, 'INV-PI', 'PROPERTI_INVESTASI', 'Ruko Disewakan', 500000000, '2026-01-05', 'KAS', 'j-pi', 'AKTIF', ?, ?, ?)`,
      INV, USER, now, now
    );
    await simpanKonfigurasiPenyusutanProperti({
      investasiId: INV, jenisObjek: 'BANGUNAN', nilaiDapatDisusutkan: 240_000_000, nilaiResidu: 0,
      masaManfaatBulan: 240, tanggalMulaiPenyusutan: '2026-01-01', createdBy: USER,
    });
  }
  const susutPi = async (periode: string[]) => {
    for (const p of periode) await prosesPenyusutanPropertiInvestasi({ investasiId: INV, periode: p, createdBy: USER, tanggalLaporan: '2026-09-17' });
  };

  it('penyusutan wajib lengkap sebelum posting; sesudah posting penyusutan berhenti; pelepasan membersihkan 1-1665', async () => {
    await seedProperti();
    await susutPi(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']); // 5 x 1jt
    const d = await simpanDraftNilaiWajar({ investasiId: INV, tanggal: '2026-06-30', nilaiWajar: 520_000_000, ...BUKTI, createdBy: USER });
    await expect(postingNilaiWajar(d.id, { userId: USER })).rejects.toThrow(KODE_NILAI_WAJAR.DEPRECIATION_INCOMPLETE);

    await susutPi(['2026-06']);
    const hasil = await postingNilaiWajar(d.id, { userId: USER });
    expect(hasil.row.nilaiTercatatSebelum).toBe(494_000_000);
    expect(hasil.row.jumlahLabaRugi).toBe(26_000_000);
    expect(hasil.row.jumlahOci).toBe(0);

    // Model nilai wajar: tidak ada penyusutan lagi.
    await expect(susutPi(['2026-07'])).rejects.toThrow(/model nilai wajar/);
    expect(await getPeriodePenyusutanPropertiTertunggak(INV, '2026-09-17')).toEqual([]);

    // LHU: keuntungan nilai wajar di laba rugi, bukan OCI.
    const lhu = await getLHU(testDb as never, '2026-01-01', '2026-12-31');
    expect(lhu.pendapatanLain.find((r) => r.kode === '4-2100')?.jumlah).toBe(26_000_000);
    expect(lhu.totalOci).toBe(0);

    // Pelepasan: C 500 − A 6 + F 26 = 520; hasil 530 -> laba 10.
    const lepas = await lepaskanInvestasi({ investasiId: INV, tanggalPelepasan: '2026-09-01', hasilPelepasan: 530_000_000, sumberDana: 'KAS', createdBy: USER });
    expect(lepas.pratinjau.akumulasiPenyesuaianNilaiWajar).toBe(26_000_000);
    expect(lepas.pratinjau.nilaiTercatat).toBe(520_000_000);
    expect(lepas.pratinjau.selisih).toBe(10_000_000);
    expect(await entri(lepas.journalId)).toEqual(
      expect.arrayContaining([
        { kode: '1-1665', debit: 0, kredit: 26_000_000 },
        { kode: '1-1670', debit: 6_000_000, kredit: 0 },
        { kode: '1-1660', debit: 0, kredit: 500_000_000 },
      ])
    );
    const posisi = await getPosisiKeuangan(testDb as never, '2026-12-31');
    expect(saldoAkun(posisi.aset, '1-1665')).toBe(0);
    expect(posisi.isBalanced).toBe(true);
  });
});

// ===========================================================================
// Migrasi v73
// ===========================================================================

describe('RC-S88 — migrasi v73 (rebuild penyesuaian_nilai_wajar)', () => {
  it('baris lama tersalin utuh sebagai PROPERTI_INVESTASI; idempoten', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal, sumber_dana, status, created_by, created_at, updated_at)
       VALUES ('inv-lama','INV-L','PROPERTI_INVESTASI','Lama',100,'2026-01-01','KAS','AKTIF',?,?,?)`,
      USER, now, now
    );
    await testDb.execAsync(`
      DROP TABLE penyesuaian_nilai_wajar;
      CREATE TABLE penyesuaian_nilai_wajar (
        id TEXT PRIMARY KEY,
        investasi_id TEXT NOT NULL REFERENCES investasi(id),
        tanggal TEXT NOT NULL,
        nilai_tercatat_sebelum INTEGER NOT NULL,
        nilai_wajar INTEGER NOT NULL,
        selisih INTEGER NOT NULL,
        arah_perubahan TEXT NOT NULL CHECK (arah_perubahan IN ('KENAIKAN','PENURUNAN','TIDAK_BERUBAH')),
        dasar_penilaian TEXT,
        referensi_bukti TEXT,
        catatan TEXT,
        status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','DIBATALKAN')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    await testDb.runAsync(
      `INSERT INTO penyesuaian_nilai_wajar VALUES ('nw-1','inv-lama','2026-06-30',100,120,20,'KENAIKAN','KJPP','REF-1','catatan','DIBATALKAN',?,?,?)`,
      USER, now, now
    );
    await migrasiV73(testDb as never);
    await migrasiV73(testDb as never); // idempoten
    const row = await testDb.getFirstAsync<Record<string, unknown>>(`SELECT * FROM penyesuaian_nilai_wajar WHERE id = 'nw-1'`);
    expect(row).toMatchObject({
      objek: 'PROPERTI_INVESTASI', investasi_id: 'inv-lama', aset_tetap_id: null, status: 'DIBATALKAN',
      nilai_wajar: 120, selisih: 20, jumlah_laba_rugi: 0, jumlah_oci: 0, journal_id: null, catatan: 'catatan',
    });
    await expect(
      testDb.runAsync(`UPDATE penyesuaian_nilai_wajar SET status = 'DIPOSTING' WHERE id = 'nw-1'`)
    ).resolves.toBeDefined();
    await expect(
      testDb.runAsync(`UPDATE penyesuaian_nilai_wajar SET objek = 'ASET_TETAP' WHERE id = 'nw-1'`)
    ).rejects.toThrow(); // CHECK: objek ASET_TETAP wajib aset_tetap_id
  });
});

// ===========================================================================
// Layar (statis)
// ===========================================================================

describe('RC-S88 — layar LHU & nilai wajar (statis)', () => {
  const baca = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
  it('LHU menampilkan seksi OCI & Total Penghasilan Komprehensif (tunggal & komparatif)', () => {
    const layar = baca('src/screens/Laporan/LabaRugiScreen.tsx');
    expect(layar).toMatch(/<OciSection data=\{data\} \/>/);
    expect(layar).toMatch(/<OciKomparatif data=\{dataKomparatif\} \/>/);
    expect(layar).toContain('label="Total Penghasilan Komprehensif"');
    expect(layar).toContain('LABEL_KELOMPOK_OCI.TIDAK_DIREKLASIFIKASI');
  });
  it('layar nilai wajar menawarkan dua objek & kebijakan SAK EP', () => {
    const layar = baca('src/screens/Transaksi/PenyesuaianNilaiWajarScreen.tsx');
    expect(layar).toMatch(/\['PROPERTI_INVESTASI', 'ASET_TETAP'\] as ObjekNilaiWajar\[\]/);
    expect(layar).toContain('PERLAKUAN_NILAI_WAJAR[objek]');
    expect(layar).toContain('Jurnal yang akan terbentuk');
  });
});

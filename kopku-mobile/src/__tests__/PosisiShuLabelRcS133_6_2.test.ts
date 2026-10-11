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
import { getLabaRugi, getPosisiKeuangan, LABEL_SHU_GABUNGAN, LABEL_SHU_TAHUN_SEBELUMNYA } from '@/reports/FinancialReports';

/**
 * RC-S133.6.2 — LABEL BARIS SHU DI LAPORAN POSISI KEUANGAN (temuan T-07).
 * Keputusan pengguna: PERBAIKI LABEL SAJA — angka & rumus tetap, tanpa jurnal
 * penutup; label "SHU Tahun Sebelumnya yang Belum Dibagikan dan SHU Tahun
 * Berjalan" hanya bila memang dua komponen itu yang digabung; baris dapat
 * diketuk untuk melihat rinciannya (rincianLabaBerjalan).
 */
async function pendapatan(tanggal: string, n: number) {
  await createJournal(testDb as never, {
    tanggal,
    sumberTransaksi: 'KAS_PENERIMAAN_LAIN',
    deskripsi: 'Pendapatan uji',
    createdBy: USER_ID,
    lines: [
      { accountId: ACC.kas, debit: n, kredit: 0 },
      { accountId: ACC.pendapatanLain, debit: 0, kredit: n },
    ],
  } as never);
}

beforeEach(async () => {
  testDb = await buatFixtureHistoris();
});

test('SHU 2025 belum dibagikan + hasil 2026: label gabungan, angka TIDAK berubah, rincian = LHU 2026 + sisa 2025', async () => {
  await pendapatan('2025-06-01', 3_000_000);
  await pendapatan('2026-02-01', 500_000);
  const p = await getPosisiKeuangan(testDb as never, '2026-03-31');
  expect(p.labaBerjalanLabel).toBe(LABEL_SHU_GABUNGAN);
  expect(p.labaBerjalanLabel).toBe('SHU Tahun Sebelumnya yang Belum Dibagikan dan SHU Tahun Berjalan');
  expect(p.labaBerjalan).toBe(3_500_000);
  const lhu = await getLabaRugi(testDb as never, '2026-01-01', '2026-03-31');
  expect(p.rincianLabaBerjalan).toEqual({ tahunBuku: 2026, shuTahunBerjalan: lhu.hasilUsaha, shuTahunSebelumnya: 3_000_000 });
  expect(p.rincianLabaBerjalan!.shuTahunBerjalan + p.rincianLabaBerjalan!.shuTahunSebelumnya).toBe(p.labaBerjalan);
  expect(p.isBalanced).toBe(true);
});

test('hanya hasil tahun berjalan: label lama tetap', async () => {
  await pendapatan('2026-02-01', 500_000);
  const p = await getPosisiKeuangan(testDb as never, '2026-03-31');
  expect(p.labaBerjalanLabel).toBe('SHU/Laba Tahun Berjalan (belum dihitung, belum dibagikan)');
  expect(p.rincianLabaBerjalan).toMatchObject({ shuTahunSebelumnya: 0 });
});

test('hanya SHU tahun sebelumnya (tahun berjalan belum ada hasil): label tahun sebelumnya saja', async () => {
  await pendapatan('2025-06-01', 3_000_000);
  const p = await getPosisiKeuangan(testDb as never, '2026-01-31');
  expect(p.labaBerjalanLabel).toBe(LABEL_SHU_TAHUN_SEBELUMNYA);
  expect(p.labaBerjalan).toBe(3_000_000);
});

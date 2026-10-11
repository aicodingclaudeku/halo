import { readFileSync } from 'fs';
import { join } from 'path';
import type { TestDb } from './testDb';
import { buatDbCoaLengkap, seedJurnal, snapshotTabel, accId, USER, FAKE_TIMERS_DATE_ONLY } from './rcs54Tahap16Fixture';

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

import { CASH_FLOW_CLASSIFICATION, classifyTransaction, classifyTransactionSource, NonCashSourceOnCashLineError } from '@/accounting/CashFlowClassification';
import { DEFAULT_ACCOUNT_MAPPING } from '@/config/defaultCOA';
import { getArusKas, generateCALK } from '@/reports/FinancialReports';
import { catatInvestasi } from '@/services/InvestasiService';
import { catatBagianShuInvestasi, catatPenerimaanBagianShu } from '@/services/BagianShuService';
import { tambahTransaksiPendapatan } from '@/services/PendapatanLainnyaService';
import { diagnosaCashFlowBagianShu, SUMBER_BAGIAN_SHU } from '@/services/CashFlowBagianShuDiagnostic';

/**
 * RC-S54 TAHAP 16 — ITEM #21: KLASIFIKASI ARUS KAS BAGIAN SHU.
 *  - BAGIAN_SHU_INVESTASI  -> NON_KAS  (Dr 1-1220 / Cr 4-1300, tanpa kas)
 *  - BAGIAN_SHU_PENERIMAAN -> OPERASI  (konsisten dengan penerimaan hasil investasi lewat Pendapatan Lainnya)
 */

const baca = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-09-17T03:00:00Z'), ...FAKE_TIMERS_DATE_ONLY } as never);
  testDb = await buatDbCoaLengkap();
});
afterEach(() => {
  testDb.closeSync();
  jest.useRealTimers();
});

async function alurBagianShu(): Promise<{ investasiId: string; bagianShuId: string }> {
  const inv = await catatInvestasi({ jenisInvestasi: 'KOPERASI_LAIN', namaTujuan: 'KSP Sekunder', jumlah: 50_000_000, tanggal: '2026-01-10', sumberDana: 'KAS', createdBy: USER });
  const hak = await catatBagianShuInvestasi({
    investasiId: inv.id, tanggalHak: '2026-03-20', jumlah: 4_250_000, jenisDokumen: 'Berita Acara RAT',
    nomorDokumen: 'BA-01/2026', tanggalDokumen: '2026-03-20', createdBy: USER,
  });
  await catatPenerimaanBagianShu({ bagianShuId: hak.id, tanggal: '2026-04-15', jumlah: 3_000_000, sumberDana: 'KAS', nomorReferensi: 'TRF-1', createdBy: USER });
  await catatPenerimaanBagianShu({ bagianShuId: hak.id, tanggal: '2026-05-15', jumlah: 1_250_000, sumberDana: 'KAS', nomorReferensi: 'TRF-2', createdBy: USER });
  return { investasiId: inv.id, bagianShuId: hak.id };
}

describe('RC-S54 T16 #21 — klasifikasi terpusat', () => {
  it('kedua sumber bagian SHU terdaftar satu kali di CASH_FLOW_CLASSIFICATION', () => {
    expect(classifyTransactionSource('BAGIAN_SHU_INVESTASI')).toBe('NON_KAS');
    expect(classifyTransactionSource('BAGIAN_SHU_PENERIMAAN')).toBe('OPERASI');
    expect(() => classifyTransaction('BAGIAN_SHU_INVESTASI')).toThrow(NonCashSourceOnCashLineError);
    expect(classifyTransaction('BAGIAN_SHU_PENERIMAAN')).toBe('OPERASI');
    const src = baca('src/accounting/CashFlowClassification.ts');
    for (const s of SUMBER_BAGIAN_SHU) expect(src.match(new RegExp(`^\\s*${s}:`, 'gm'))).toHaveLength(1);
  });

  it('dasar keputusan: penerimaan hasil investasi via Pendapatan Lainnya sudah OPERASI; mapping pengakuan tanpa kas', () => {
    expect(CASH_FLOW_CLASSIFICATION.KAS_PENERIMAAN_LAIN).toBe('OPERASI');
    expect(CASH_FLOW_CLASSIFICATION.BANK_PENERIMAAN_LAIN).toBe('OPERASI');
    const roles = DEFAULT_ACCOUNT_MAPPING.filter((m) => m.transactionType === 'BAGIAN_SHU_INVESTASI').map((m) => m.accountKode).sort();
    expect(roles).toEqual(['1-1220', '4-1300']);
    // Pokok investasi tetap INVESTASI.
    expect(CASH_FLOW_CLASSIFICATION.INVESTASI_KOPERASI_LAIN).toBe('INVESTASI');
  });
});

describe('RC-S54 T16 #21 — laporan', () => {
  it('Arus Kas dibuat tanpa UnknownCashFlowClassificationError; penerimaan di OPERASI, penempatan di INVESTASI; terekonsiliasi', async () => {
    await alurBagianShu();
    const ak = await getArusKas(testDb as never, '2026-01-01', '2026-12-31');
    expect(ak.investasi).toBe(-50_000_000);
    expect(ak.operasi).toBe(4_250_000);
    expect(ak.pendanaan).toBe(0);
    expect(ak.terekonsiliasi).toBe(true);
    expect(ak.rincian.filter((r) => r.aktivitas === 'OPERASI').reduce((t, r) => t + r.jumlah, 0)).toBe(4_250_000);
  });

  it('konsistensi antar jalur: penerimaan hasil investasi langsung (Pendapatan Lainnya) dan lewat bagian SHU masuk kolom yang sama', async () => {
    await alurBagianShu();
    await tambahTransaksiPendapatan({ tanggal: '2026-06-01', accountId: accId('4-1500'), nominal: 700_000, jenis: 'KAS', createdBy: USER });
    const ak = await getArusKas(testDb as never, '2026-01-01', '2026-12-31');
    expect(ak.operasi).toBe(4_250_000 + 700_000);
    expect(ak.investasi).toBe(-50_000_000);
  });

  it('CALK dapat dibuat setelah penerimaan bagian SHU (sebelumnya melempar)', async () => {
    await alurBagianShu();
    const calk = await generateCALK(testDb as never, '2026-01-01', '2026-12-31');
    expect(calk.sections.find((s) => s.sectionKey === 'arus_kas')).toBeDefined();
  });
});

describe('RC-S54 T16 #21 — diagnosaCashFlowBagianShu (read-only)', () => {
  const TABEL = ['journal', 'journal_entry', 'investasi_bagian_shu', 'investasi_bagian_shu_penerimaan', 'audit_log'];

  it('data sehat: klasifikasi terisi, jumlah jurnal & arus kas bersih benar, tanpa temuan, DB tidak berubah', async () => {
    await alurBagianShu();
    const awal = await snapshotTabel(testDb, TABEL);
    const d = await diagnosaCashFlowBagianShu(testDb as never);
    expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
    expect(d).toMatchObject({
      klasifikasi: { BAGIAN_SHU_INVESTASI: 'NON_KAS', BAGIAN_SHU_PENERIMAAN: 'OPERASI' },
      jumlahJurnal: { BAGIAN_SHU_INVESTASI: 1, BAGIAN_SHU_PENERIMAAN: 2 },
      arusKasBersih: { BAGIAN_SHU_INVESTASI: 0, BAGIAN_SHU_PENERIMAAN: 4_250_000 },
      temuan: [],
    });
  });

  it('mendeteksi klasifikasi belum terdaftar (keadaan sebelum T16)', async () => {
    await alurBagianShu();
    const simpan = CASH_FLOW_CLASSIFICATION.BAGIAN_SHU_PENERIMAAN;
    delete (CASH_FLOW_CLASSIFICATION as Record<string, string>).BAGIAN_SHU_PENERIMAAN;
    try {
      const d = await diagnosaCashFlowBagianShu(testDb as never);
      expect(d.temuan).toEqual([expect.objectContaining({ kode: 'KLASIFIKASI_BELUM_TERDAFTAR', sumber: 'BAGIAN_SHU_PENERIMAAN', nilaiKas: 4_250_000 })]);
      await expect(getArusKas(testDb as never, '2026-01-01', '2026-12-31')).rejects.toThrow(/BAGIAN_SHU_PENERIMAAN/);
    } finally {
      (CASH_FLOW_CLASSIFICATION as Record<string, string>).BAGIAN_SHU_PENERIMAAN = simpan;
    }
  });

  it('mendeteksi pengakuan yang menyentuh kas, penerimaan tanpa kas, dan penerimaan tidak sesuai register', async () => {
    const { bagianShuId } = await alurBagianShu();
    await seedJurnal(testDb, 'j-salah-1', '2026-06-01', 'BAGIAN_SHU_INVESTASI', [['1-1000', 100, 0], ['4-1300', 0, 100]]);
    await seedJurnal(testDb, 'j-salah-2', '2026-06-02', 'BAGIAN_SHU_PENERIMAAN', [['1-1240', 200, 0], ['1-1220', 0, 200]]);
    const reg = await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM investasi_bagian_shu_penerimaan WHERE bagian_shu_id = ? AND nomor_referensi = 'TRF-2'`, bagianShuId);
    await testDb.runAsync(`UPDATE investasi_bagian_shu_penerimaan SET jumlah = 1250001 WHERE id = ?`, reg!.id);
    const d = await diagnosaCashFlowBagianShu(testDb as never);
    const ringkas = d.temuan.map((t) => `${t.kode}:${t.nilaiKas}`).sort();
    expect(ringkas).toEqual(['PENERIMAAN_TANPA_KAS:0', 'PENERIMAAN_TIDAK_SESUAI_REGISTER:1250000', 'PENGAKUAN_MENYENTUH_KAS:100']);
    expect(d.temuan.find((t) => t.kode === 'PENGAKUAN_MENYENTUH_KAS')!.journalId).toBe('j-salah-1');
    expect(d.temuan.find((t) => t.kode === 'PENERIMAAN_TANPA_KAS')!.journalId).toBe('j-salah-2');
  });

  it('STATIC: diagnostik tanpa tulis DB', () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(strip(baca('src/services/CashFlowBagianShuDiagnostic.ts'))).not.toMatch(/INSERT INTO|UPDATE \w+ SET|DELETE FROM|createJournal|runAsync|withTransaction/);
  });
});

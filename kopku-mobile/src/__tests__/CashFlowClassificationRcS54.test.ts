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

const baca = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
const SEMUA_TABEL = ['account', 'account_mapping', 'journal', 'journal_entry', 'investasi', 'investasi_penyusutan', 'investasi_impairment', 'aset_tetap', 'aset_penyusutan', 'utang', 'utang_pembayaran', 'rak_transaksi', 'audit_log', 'accounting_period'];

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-09-17T03:00:00Z'), ...FAKE_TIMERS_DATE_ONLY } as never);
  testDb = await buatDbCoaLengkap();
});
afterEach(() => {
  testDb.closeSync();
  jest.useRealTimers();
});

import { CASH_FLOW_CLASSIFICATION, classifyTransactionSource, classifyTransaction, NonCashSourceOnCashLineError } from '@/accounting/CashFlowClassification';
import { getArusKas } from '@/reports/FinancialReports';
import { catatInvestasi, batalkanInvestasi } from '@/services/InvestasiService';
import { reverseJournal } from '@/accounting/AccountingEngine';
import { readdirSync, statSync } from 'fs';

/** RC-S54 TAHAP 16 — GAP 4 (klasifikasi arus kas 4 sumber) & GAP 5 (dokumentasi reverseJournal). */

function sumberProduksi(): string[] {
  const hasil = new Set<string>();
  const jelajah = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) { if (n !== '__tests__') jelajah(p); continue; }
      if (!/\.(ts|tsx)$/.test(n)) continue;
      for (const m of readFileSync(p, 'utf8').matchAll(/sumberTransaksi:\s*'([A-Z_]+)'/g)) hasil.add(m[1]);
    }
  };
  jelajah(join(__dirname, '..'));
  return [...hasil].sort();
}

describe('RC-S54 T16 GAP 4 — klasifikasi terpusat', () => {
  it('empat sumber: klasifikasi sesuai jurnal service-nya', () => {
    expect(classifyTransactionSource('PENYUSUTAN_PROPERTI_INVESTASI')).toBe('NON_KAS');
    expect(classifyTransactionSource('SIMPANAN_BERJANGKA_BUNGA_TRANSFER')).toBe('NON_KAS');
    expect(classifyTransactionSource('UTANG_IMBALAN_KERJA_BAYAR')).toBe('OPERASI');
    expect(classifyTransactionSource('REKONSILIASI_KAS_BANK')).toBe('OPERASI');
    expect(() => classifyTransaction('PENYUSUTAN_PROPERTI_INVESTASI')).toThrow(NonCashSourceOnCashLineError);
    expect(() => classifyTransaction('SIMPANAN_BERJANGKA_BUNGA_TRANSFER')).toThrow(NonCashSourceOnCashLineError);
  });

  it('bukti semantik dari source service (bukan nama)', () => {
    const susut = strip(baca('src/services/PenyusutanPropertiInvestasiService.ts'));
    expect(susut).toMatch(/PENYUSUTAN_PROPERTI_INVESTASI', 'KREDIT_AKUMULASI'/);
    expect(susut).not.toMatch(/resolveKasBankAccountId/);
    const transfer = strip(baca('src/services/SimpananBerjangkaLifecycleService.ts'));
    // RC-S86 — diperbarui: kredit ke Sukarela sekarang `netto` (bunga
    // bruto dikurangi PPh Ps.4(2) bila ada), bukan lagi `p.bunga` mentah;
    // baris debit ke Utang Bunga tetap bruto penuh (tidak berubah).
    expect(transfer).toMatch(/\{ accountId: utangBungaAccountId, debit: p\.bunga, kredit: 0 \}/);
    expect(transfer).toMatch(/lines\.push\(\{ accountId: sukarelaAccountId, debit: 0, kredit: netto \}\)/);
    const imbalan = strip(baca('src/services/ImbalanKerjaService.ts'));
    expect(imbalan).toMatch(/\{ accountId: kasBankAccountId, debit: 0, kredit: row\.nilai_imbalan \}/);
    const rekon = strip(baca('src/services/CashReconciliationService.ts'));
    expect(rekon).toMatch(/accountId: detail\.accountId/);
    expect(rekon).toMatch(/akunLawanId/);
    expect(CASH_FLOW_CLASSIFICATION.KAS_PENGELUARAN_LAIN).toBe('OPERASI');
  });

  it('exhaustive: setiap sumber produksi terklasifikasi tepat satu kali; tidak ada Unknown', () => {
    const src = baca('src/accounting/CashFlowClassification.ts');
    const tanpa = sumberProduksi().filter((s) => !(s in CASH_FLOW_CLASSIFICATION));
    expect(tanpa).toEqual([]);
    for (const s of ['PENYUSUTAN_PROPERTI_INVESTASI', 'SIMPANAN_BERJANGKA_BUNGA_TRANSFER', 'UTANG_IMBALAN_KERJA_BAYAR', 'REKONSILIASI_KAS_BANK']) {
      expect(src.match(new RegExp(`^\\s*${s}:`, 'gm'))).toHaveLength(1);
    }
  });

  it('DB: jurnal rekonsiliasi & pembayaran imbalan masuk OPERASI; penyusutan PI tidak menyentuh arus kas', async () => {
    await seedJurnal(testDb, 'j-rek', '2026-03-31', 'REKONSILIASI_KAS_BANK', [['5-2000', 15_000, 0], ['1-1000', 0, 15_000]]);
    await seedJurnal(testDb, 'j-imb', '2026-04-30', 'UTANG_IMBALAN_KERJA_BAYAR', [['2-1000', 500_000, 0], ['1-1000', 0, 500_000]]);
    await seedJurnal(testDb, 'j-susut', '2026-04-30', 'PENYUSUTAN_PROPERTI_INVESTASI', [['5-1300', 2_000_000, 0], ['1-1670', 0, 2_000_000]]);
    const ak = await getArusKas(testDb as never, '2026-01-01', '2026-12-31');
    expect(ak.operasi).toBe(-515_000);
    expect(ak.investasi).toBe(0);
  });
});

describe('RC-S54 T16 GAP 5 — dokumentasi = implementasi (reverseJournal & periode CLOSED)', () => {
  it('komentar lama yang menyatakan reverseJournal menolak periode asal CLOSED sudah tidak ada', () => {
    for (const f of ['src/services/InvestasiService.ts', 'src/services/PinjamanService.ts']) {
      expect(baca(f)).not.toMatch(/reverseJournal\(\) sendiri (sudah )?menolak/);
    }
    expect(baca('src/services/InvestasiService.ts')).toMatch(/reverseJournal\(\) TIDAK\s*\n\s*\/\/ memeriksa periode jurnal ASLI/);
    expect(strip(baca('src/accounting/AccountingEngine.ts'))).toMatch(/tanggal: getTanggalLokalHariIni\(\)/);
  });

  it('perilaku yang didokumentasikan: periode asal CLOSED boleh (pembalik periode berjalan); periode hari ini CLOSED ditolak', async () => {
    const a = await catatInvestasi({ jenisInvestasi: 'KOPERASI_LAIN', namaTujuan: 'A', jumlah: 1_000_000, tanggal: '2025-05-01', sumberDana: 'KAS', createdBy: USER });
    const b = await catatInvestasi({ jenisInvestasi: 'KOPERASI_LAIN', namaTujuan: 'B', jumlah: 1_000_000, tanggal: '2026-05-01', sumberDana: 'KAS', createdBy: USER });
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2025'`);
    await batalkanInvestasi(a.id, USER, 'salah input');
    const pembalik = await testDb.getFirstAsync<{ tanggal: string }>(`SELECT tanggal FROM journal WHERE reversal_of_id = ?`, a.journalId);
    expect(pembalik!.tanggal).toBe('2026-09-17');
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    await expect(testDb.withTransactionAsync(async () => { await reverseJournal(testDb as never, b.journalId, USER, 'x'); })).rejects.toThrow();
  });
});

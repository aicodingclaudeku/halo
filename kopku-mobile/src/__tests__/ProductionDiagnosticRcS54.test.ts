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


import { reverseJournal } from '@/accounting/AccountingEngine';
import { catatInvestasi } from '@/services/InvestasiService';
import { simpanKonfigurasiPenyusutanProperti, prosesPenyusutanPropertiInvestasi } from '@/services/PenyusutanPropertiInvestasiService';
import { catatBagianShuInvestasi } from '@/services/BagianShuService';
import { beliAset } from '@/services/AsetService';
import { prosesPenyusutanAset } from '@/services/PenyusutanService';
import { diagnosaRcS54Produksi, eksporDiagnostikRcS54Json } from '@/services/DiagnostikRcS54ProduksiService';
import {
  previewKoreksiHistori,
  approveKoreksiHistori,
  applyKoreksiHistori,
  KoreksiHistoriDitolakError,
} from '@/services/HistoricalCorrectionService';

/** RC-S54 TAHAP 16 — GAP 2: diagnostik data produksi (read-only). */

async function dataBermasalah() {
  // (a) disposal warisan: properti disusutkan lalu penempatan dibalik langsung.
  const p = await catatInvestasi({ jenisInvestasi: 'PROPERTI_INVESTASI', namaTujuan: 'Ruko', jumlah: 300_000_000, tanggal: '2026-01-05', sumberDana: 'KAS', createdBy: USER });
  await simpanKonfigurasiPenyusutanProperti({ investasiId: p.id, jenisObjek: 'BANGUNAN', nilaiDapatDisusutkan: 300_000_000, nilaiResidu: 0, masaManfaatBulan: 120, tanggalMulaiPenyusutan: '2026-01-05', createdBy: USER });
  await prosesPenyusutanPropertiInvestasi({ investasiId: p.id, periode: '2026-01', createdBy: USER });
  await testDb.withTransactionAsync(async () => { await reverseJournal(testDb as never, p.journalId, USER, 'pra-#20'); });
  await testDb.runAsync(`UPDATE investasi SET status = 'DIBATALKAN' WHERE id = ?`, p.id);
  // (b) status tidak sinkron (deterministik): penempatan dibalik, status tetap AKTIF, tanpa lifecycle.
  const k = await catatInvestasi({ jenisInvestasi: 'KOPERASI_LAIN', namaTujuan: 'KSP', jumlah: 5_000_000, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: USER });
  await testDb.withTransactionAsync(async () => { await reverseJournal(testDb as never, k.journalId, USER, 'batal manual'); });
  // (c) aset tetap disusutkan lalu DIHAPUS.
  const a = await beliAset({ namaAset: 'Motor', nilaiPerolehan: 24_000_000, masaManfaatBulan: 24, tanggal: '2026-01-05', tanggalPerolehan: '2026-01-05', metodePembayaran: 'TUNAI', sumberDana: 'KAS', createdBy: USER } as never);
  const asetId = (a as { id: string }).id;
  await prosesPenyusutanAset({ asetId, periode: '2026-01', createdBy: USER });
  // Jalur pra-GAP 6 (hapusAset atas aset berpenyusutan hanya mengubah status) ditiru langsung — kini ditolak service.
  await testDb.runAsync(`UPDATE aset_tetap SET status = 'DIHAPUS', updated_at = ? WHERE id = ?`, new Date().toISOString(), asetId);
  // (d) 2-1300 bersaldo debit.
  await seedJurnal(testDb, 'j-eir', '2026-05-31', 'EIR_FEE_AMORTIZATION', [['2-1300', 900_000, 0], ['4-1000', 0, 900_000]]);
  return { properti: p, koperasi: k, asetId };
}

describe('RC-S54 T16 GAP 2 — diagnosaRcS54Produksi', () => {
  it('menggabungkan seluruh diagnostik ke satu bentuk temuan; ringkasan; JSON; database identik', async () => {
    const { properti, asetId } = await dataBermasalah();
    const awal = await snapshotTabel(testDb, SEMUA_TABEL);
    const h = await diagnosaRcS54Produksi(testDb as never, { tanggal: '2026-12-31' });
    expect(await snapshotTabel(testDb, SEMUA_TABEL)).toEqual(awal);
    expect(h.versi).toBe('RC-S54-T16');
    expect(h.temuan.filter((t) => t.kode === 'DIAGNOSTIK_GAGAL')).toEqual([]);
    const kode = new Set(h.temuan.map((t) => `${t.area}:${t.kode}`));
    for (const k of ['INVESTASI:ASET_DILEPAS_AKUMULASI_PENYUSUTAN_TERSISA', 'INVESTASI:GAIN_LOSS_MISMATCH', 'INVESTASI:JOURNAL_MISMATCH', 'ASET_TETAP:ASET_DIHAPUS_BELUM_DIDERECOGNISI', 'COA:SALDO_DEBIT_2_1300', 'COA:PENYUSUTAN_PROPERTI_INVESTASI_BERSALDO']) {
      expect(kode.has(k)).toBe(true);
    }
    const inv = h.temuan.find((t) => t.kode === 'ASET_DILEPAS_AKUMULASI_PENYUSUTAN_TERSISA')!;
    expect(inv).toMatchObject({ transaksiId: properti.id, nomorTransaksi: expect.stringMatching(/^INV-/), saldo: 2_500_000, severity: 'TINGGI', koreksiDeterministik: false, tindakanKoreksi: 'MANUAL_REVIEW' });
    // DIPERBARUI RC-S54 T16 GAP 6: periode temuan aset kini dari jurnal pelepasan (warisan: tidak ada -> null).
    expect(h.temuan.find((t) => t.area === 'ASET_TETAP')).toMatchObject({ kode: 'ASET_DIHAPUS_BELUM_DIDERECOGNISI', transaksiId: asetId, saldo: 23_000_000, periode: null });
    expect(h.temuan.find((t) => t.kode === 'SALDO_DEBIT_2_1300')).toMatchObject({ tindakanKoreksi: 'PRESENTASI_OTOMATIS', koreksiDeterministik: true, saldo: -900_000, periode: '2026-05' });
    expect(h.ringkasan.jumlahTemuan).toBe(h.temuan.length);
    expect(Object.values(h.ringkasan.perArea).reduce((a, b) => a + b, 0)).toBe(h.temuan.length);
    expect(h.ringkasan.periodeTerdampak).toContain('2026-05');
    const json = eksporDiagnostikRcS54Json(h);
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(h)));
    expect(json).not.toMatch(/pin_hash|pin_salt/);
  });

  it('database bersih: nol temuan; kegagalan satu diagnostik tercatat sebagai DIAGNOSTIK_GAGAL, tidak disembunyikan', async () => {
    const h = await diagnosaRcS54Produksi(testDb as never, { tanggal: '2026-12-31' });
    expect(h.temuan).toEqual([]);
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type = 'IMPAIRMENT_INVESTASI'`);
    const g = await diagnosaRcS54Produksi(testDb as never, { tanggal: '2026-12-31' });
    expect(g.temuan).toEqual([expect.objectContaining({ area: 'INVESTASI', kode: 'DIAGNOSTIK_GAGAL', severity: 'TINGGI' })]);
  });

  it('STATIC: agregator tanpa tulis DB', () => {
    expect(strip(baca('src/services/DiagnostikRcS54ProduksiService.ts'))).not.toMatch(/INSERT INTO|UPDATE \w+ SET|DELETE FROM|createJournal|reverseJournal|runAsync|withTransaction|execAsync/);
  });
});


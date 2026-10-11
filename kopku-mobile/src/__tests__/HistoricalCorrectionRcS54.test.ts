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

/** RC-S54 TAHAP 16 — GAP 3: koreksi histori terkontrol (preview → approve → apply). */

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

describe('RC-S54 T16 GAP 3 — HistoricalCorrectionService', () => {
  it('preview read-only: satu temuan DAPAT_DITERAPKAN (status vs pembalik); disposal warisan, aset tetap = MANUAL_REVIEW; COA = TANPA_JURNAL', async () => {
    const { koperasi, properti } = await dataBermasalah();
    const awal = await snapshotTabel(testDb, SEMUA_TABEL);
    const pv = await previewKoreksiHistori({ tanggal: '2026-12-31' });
    expect(await snapshotTabel(testDb, SEMUA_TABEL)).toEqual(awal);
    const dapat = pv.filter((i) => i.tindakan === 'DAPAT_DITERAPKAN');
    expect(dapat).toEqual([expect.objectContaining({ transaksiId: koperasi.id, deterministik: true, nilaiSebelum: { status: 'AKTIF', updated_at: expect.any(String) }, nilaiSesudah: { status: 'DIBATALKAN', updated_at: expect.any(String) } })]);
    expect(pv.filter((i) => i.transaksiId === properti.id).every((i) => i.tindakan === 'MANUAL_REVIEW' && !i.deterministik && i.nilaiSesudah === null)).toBe(true);
    expect(pv.filter((i) => i.sumber === 'ASET_TETAP').every((i) => i.tindakan === 'MANUAL_REVIEW')).toBe(true);
    expect(pv.filter((i) => i.sumber === 'COA').every((i) => i.tindakan === 'TANPA_JURNAL')).toBe(true);
  });

  it('apply tanpa approval ditolak; approve menuntut konfirmasi, alasan, snapshot cocok; MANUAL_REVIEW tidak dapat disetujui', async () => {
    const { properti } = await dataBermasalah();
    const pv = await previewKoreksiHistori();
    const item = pv.find((i) => i.tindakan === 'DAPAT_DITERAPKAN')!;
    const manual = pv.find((i) => i.transaksiId === properti.id)!;
    const awal = await snapshotTabel(testDb, SEMUA_TABEL);
    await expect(applyKoreksiHistori({ correctionId: 'tidak-ada', userId: USER })).rejects.toMatchObject({ kode: 'BELUM_DISETUJUI' });
    const dasar = { userId: USER, alasan: 'selaraskan register', findingIds: [item.findingId], snapshotSebelum: { [item.findingId]: item.nilaiSebelum as Record<string, unknown> }, konfirmasi: true };
    await expect(approveKoreksiHistori({ ...dasar, konfirmasi: false })).rejects.toMatchObject({ kode: 'KONFIRMASI_WAJIB' });
    await expect(approveKoreksiHistori({ ...dasar, alasan: ' ' })).rejects.toMatchObject({ kode: 'ALASAN_WAJIB' });
    await expect(approveKoreksiHistori({ ...dasar, snapshotSebelum: { [item.findingId]: { status: 'X' } } })).rejects.toMatchObject({ kode: 'SNAPSHOT_TIDAK_COCOK' });
    await expect(approveKoreksiHistori({ ...dasar, findingIds: [manual.findingId], snapshotSebelum: {} })).rejects.toBeInstanceOf(KoreksiHistoriDitolakError);
    expect(await snapshotTabel(testDb, SEMUA_TABEL)).toEqual(awal);
  });

  it('approve -> apply: hanya register diselaraskan, jurnal tidak disentuh, audit lengkap; apply kedua ditolak; snapshot approval tercatat', async () => {
    const { koperasi } = await dataBermasalah();
    const pv = await previewKoreksiHistori();
    const item = pv.find((i) => i.tindakan === 'DAPAT_DITERAPKAN')!;
    const jurnalAwal = JSON.stringify(await snapshotTabel(testDb, ['journal', 'journal_entry']));
    const { correctionId } = await approveKoreksiHistori({ userId: USER, alasan: 'selaraskan register', findingIds: [item.findingId], snapshotSebelum: { [item.findingId]: item.nilaiSebelum as Record<string, unknown> }, konfirmasi: true });
    const inv0 = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM investasi WHERE id = ?`, koperasi.id);
    expect(inv0!.status).toBe('AKTIF');
    expect(await applyKoreksiHistori({ correctionId, userId: USER })).toEqual({ diterapkan: 1 });
    const inv = await testDb.getFirstAsync<{ status: string; updated_at: string }>(`SELECT status, updated_at FROM investasi WHERE id = ?`, koperasi.id);
    expect(inv).toEqual({ status: 'DIBATALKAN', updated_at: (item.nilaiSesudah as { updated_at: string }).updated_at });
    expect(JSON.stringify(await snapshotTabel(testDb, ['journal', 'journal_entry']))).toBe(jurnalAwal);
    const audit = await testDb.getFirstAsync<{ data_sebelum: string; data_sesudah: string; user_id: string }>(`SELECT data_sebelum, data_sesudah, user_id FROM audit_log WHERE action = 'HIST_CORRECTION_APPLY'`);
    expect(JSON.parse(audit!.data_sesudah)).toEqual({
      correctionId, userId: USER, tanggal: '2026-09-17', alasan: 'selaraskan register', findingId: item.findingId, sumberTemuan: `INVESTASI:${item.kode}`,
      transaksiId: koperasi.id, nilaiSebelum: item.nilaiSebelum, nilaiSesudah: item.nilaiSesudah, journalTerkait: item.journalTerkait,
    });
    await expect(applyKoreksiHistori({ correctionId, userId: USER })).rejects.toMatchObject({ kode: 'SUDAH_DITERAPKAN' });
    expect((await previewKoreksiHistori()).filter((i) => i.tindakan === 'DAPAT_DITERAPKAN')).toEqual([]);
  });

  it('snapshot berubah antara approve dan apply -> ditolak atomik', async () => {
    const { koperasi } = await dataBermasalah();
    const item = (await previewKoreksiHistori()).find((i) => i.tindakan === 'DAPAT_DITERAPKAN')!;
    const { correctionId } = await approveKoreksiHistori({ userId: USER, alasan: 'x', findingIds: [item.findingId], snapshotSebelum: { [item.findingId]: item.nilaiSebelum as Record<string, unknown> }, konfirmasi: true });
    await testDb.runAsync(`UPDATE investasi SET updated_at = '2026-09-01T00:00:00Z' WHERE id = ?`, koperasi.id);
    const awal = await snapshotTabel(testDb, SEMUA_TABEL);
    await expect(applyKoreksiHistori({ correctionId, userId: USER })).rejects.toMatchObject({ kode: 'SNAPSHOT_BERUBAH' });
    expect(await snapshotTabel(testDb, SEMUA_TABEL)).toEqual(awal);
  });

  it('STATIC: preview tidak menulis; tidak ada DELETE jurnal; tidak ada createJournal', () => {
    const src = strip(baca('src/services/HistoricalCorrectionService.ts'));
    expect(src).not.toMatch(/DELETE FROM|createJournal|reverseJournal|UPDATE journal/);
    const preview = src.slice(src.indexOf('async function previewDenganDb'), src.indexOf('export async function previewKoreksiHistori'));
    expect(preview).not.toMatch(/runAsync|INSERT|UPDATE/);
    expect(accId('1-1000')).toBe('acc-1-1000');
  });
});

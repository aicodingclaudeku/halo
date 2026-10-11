import { readFileSync } from 'fs';
import { join } from 'path';
import type { TestDb } from './testDb';
import { buatDbCoaLengkap, snapshotTabel, accId, USER, FAKE_TIMERS_DATE_ONLY } from './rcs54Tahap16Fixture';

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

import { reverseJournal } from '@/accounting/AccountingEngine';
import { CASH_FLOW_CLASSIFICATION } from '@/accounting/CashFlowClassification';
import { DEFAULT_ACCOUNTS, DEFAULT_ACCOUNT_MAPPING } from '@/config/defaultCOA';
import { cariKonflikKodeAkun } from '@/config/coaPolicyRegistry';
import { SCHEMA_VERSION } from '@/database/schema';
import { runMigrations } from '@/database/db';
import { getLHU } from '@/reports/FinancialReports';
import { getPosisiKeuangan, getArusKas, generateCALK } from '@/reports/FinancialReports';
import {
  catatInvestasi,
  batalkanInvestasi,
  editInvestasi,
  listInvestasi,
  KoreksiInvestasiDitolakError,
  KODE_KOREKSI_DITOLAK_LIFECYCLE,
} from '@/services/InvestasiService';
import { simpanKonfigurasiPenyusutanProperti, prosesPenyusutanPropertiInvestasi } from '@/services/PenyusutanPropertiInvestasiService';
import { catatImpairmentInvestasi, getNilaiTercatatInvestasi } from '@/services/InvestasiImpairmentService';
import { diagnosaHistoriPelepasanPropertiInvestasi } from '@/services/PelepasanInvestasiDiagnostic';
import {
  lepaskanInvestasi,
  pratinjauPelepasanInvestasi,
  PelepasanInvestasiDitolakError,
  PelepasanInvestasiInput,
} from '@/services/PelepasanInvestasiService';
import { listHistoryTransaksi, operasiInvestasiDariJurnal } from '@/services/HistoryTransaksiService';

/**
 * RC-S54 TAHAP 16 — ITEM #20: PELEPASAN (DERECOGNITION) INVESTASI — CLOSURE.
 *
 *  - PELEPASAN_INVESTASI (lepaskanInvestasi): hasil diinput, nilai tercatat = C − A − I,
 *    laba/rugi = H − nilai tercatat, jurnal membersihkan aset + 1-1670 + 1-1900 per investasi.
 *  - KOREKSI_SALAH_INPUT (batalkanInvestasi/edit): terpisah; ditolak bila ada lifecycle.
 *  - Rugi pelepasan ditolak atomik (COA DECISION REQUIRED — tidak ada akun rugi yang sah).
 */

const TABEL = ['investasi', 'journal', 'journal_entry', 'investasi_penyusutan', 'investasi_impairment', 'audit_log', 'accounting_period'];
const saldo = (rows: { kode: string; saldo: number }[], kode: string) => rows.find((r) => r.kode === kode)?.saldo ?? 0;

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date('2026-09-17T03:00:00Z'), ...FAKE_TIMERS_DATE_ONLY } as never);
  testDb = await buatDbCoaLengkap();
});
afterEach(() => {
  testDb.closeSync();
  jest.useRealTimers();
});

type Objek = 'TANAH' | 'BANGUNAN' | 'TANAH_DAN_BANGUNAN' | null;

async function properti(jenis: Objek, tanggal = '2026-01-05', jumlah = 300_000_000): Promise<string> {
  const inv = await catatInvestasi({ jenisInvestasi: 'PROPERTI_INVESTASI', namaTujuan: `Properti ${jenis}`, jumlah, tanggal, sumberDana: 'KAS', createdBy: USER });
  if (jenis) {
    await simpanKonfigurasiPenyusutanProperti(
      jenis === 'TANAH'
        ? { investasiId: inv.id, jenisObjek: 'TANAH', createdBy: USER }
        : { investasiId: inv.id, jenisObjek: jenis, nilaiDapatDisusutkan: jenis === 'BANGUNAN' ? jumlah : 240_000_000, nilaiResidu: 0, masaManfaatBulan: 120, tanggalMulaiPenyusutan: tanggal, createdBy: USER }
    );
  }
  return inv.id;
}
const susutkan = async (id: string, periode: string[]) => {
  for (const p of periode) await prosesPenyusutanPropertiInvestasi({ investasiId: id, periode: p, createdBy: USER });
};
const impair = (id: string, nilai: number, tanggal = '2026-04-10') =>
  catatImpairmentInvestasi({ investasiId: id, tanggal, indikasiTerpilih: ['Kerusakan fisik'], dasarPenilaian: 'Laporan kondisi', nilaiImpairment: nilai, alasan: 'uji', createdBy: USER });

async function bankAccount(): Promise<string> {
  await testDb.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at) VALUES ('bank-1','Bank Uji','123','Koperasi',0,?,1,?)`,
    accId('1-1100'), new Date().toISOString()
  );
  return 'bank-1';
}

const input = (investasiId: string, hasil: number, extra: Partial<PelepasanInvestasiInput> = {}): PelepasanInvestasiInput => ({
  investasiId, tanggalPelepasan: '2026-08-31', hasilPelepasan: hasil, sumberDana: hasil > 0 ? 'KAS' : undefined, createdBy: USER, ...extra,
});

async function entri(journalId: string) {
  return testDb.getAllAsync<{ kode: string; debit: number; kredit: number }>(
    `SELECT a.kode, je.debit, je.kredit FROM journal_entry je JOIN account a ON a.id = je.account_id WHERE je.journal_id = ? ORDER BY je.rowid`, journalId
  );
}

async function harusDitolakPelepasan(inp: PelepasanInvestasiInput, kode: string) {
  const awal = await snapshotTabel(testDb, TABEL);
  const err = await lepaskanInvestasi(inp).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PelepasanInvestasiDitolakError);
  expect((err as PelepasanInvestasiDitolakError).kode).toBe(kode);
  expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
}

async function harusDitolakKoreksi(fn: () => Promise<unknown>, penyusutan: number, impairment: number) {
  const awal = await snapshotTabel(testDb, TABEL);
  const err = await fn().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(KoreksiInvestasiDitolakError);
  expect((err as KoreksiInvestasiDitolakError).kode).toBe(KODE_KOREKSI_DITOLAK_LIFECYCLE);
  expect((err as Error).message).toMatch(/Pelepasan Investasi/);
  expect((err as KoreksiInvestasiDitolakError).akumulasiPenyusutan).toBe(penyusutan);
  expect((err as KoreksiInvestasiDitolakError).akumulasiImpairment).toBe(impairment);
  expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
}

async function posisiInvestasi(tanggal = '2026-12-31') {
  const p = await getPosisiKeuangan(testDb as never, tanggal);
  return { aset: saldo(p.aset, '1-1660'), akm: saldo(p.aset, '1-1670'), imp: saldo(p.aset, '1-1900'), kop: saldo(p.aset, '1-1610') };
}

// ===========================================================================
describe('RC-S54 T16 #20 — COA & mapping pelepasan', () => {
  it('schema v66 (tanpa DDL): perangkat v65 tanpa akun 5-2160 & mapping pelepasan mendapatkannya lewat self-heal; idempoten; histori utuh', async () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(66); // DIPERBARUI RC-S54 T16 GAP 6: versi kini 67; test ini membuktikan penyaluran v65 -> terkini
    const id = await properti('TANAH');
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type = 'PELEPASAN_INVESTASI'`);
    await testDb.runAsync(`DELETE FROM account WHERE kode = '5-2160'`);
    await testDb.execAsync(`CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`);
    await testDb.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 65)`);
    // Pengguna pernah mengubah mapping lain: tidak boleh ditimpa.
    await testDb.runAsync(`UPDATE account_mapping SET account_id = ? WHERE transaction_type = 'IMPAIRMENT_INVESTASI' AND role = 'DEBIT_BEBAN'`, accId('5-2000'));
    const histori = async () => JSON.stringify({
      j: await testDb.getAllAsync(`SELECT * FROM journal ORDER BY id`), e: await testDb.getAllAsync(`SELECT * FROM journal_entry ORDER BY id`),
      inv: await testDb.getAllAsync(`SELECT * FROM investasi ORDER BY id`),
    });
    const awal = await histori();
    const tanpaMapping = await lepaskanInvestasi(input(id, 310_000_000)).catch((e: unknown) => e);
    expect(String(tanpaMapping)).toMatch(/PELEPASAN_INVESTASI/);
    expect(await histori()).toBe(awal);

    for (let i = 0; i < 2; i++) await runMigrations(testDb as never);
    const akun = await testDb.getAllAsync<{ kode: string; nama: string; kategori: string; lhu_klasifikasi: string }>(`SELECT kode, nama, kategori, lhu_klasifikasi FROM account WHERE kode = '5-2160'`);
    expect(akun).toEqual([{ kode: '5-2160', nama: 'Kerugian Pelepasan Investasi', kategori: 'BEBAN', lhu_klasifikasi: 'BEBAN_LAIN' }]);
    const map = await testDb.getAllAsync<{ role: string; kode: string }>(
      `SELECT m.role, a.kode FROM account_mapping m JOIN account a ON a.id = m.account_id WHERE m.transaction_type = 'PELEPASAN_INVESTASI' ORDER BY m.role`
    );
    expect(map).toEqual([{ role: 'DEBIT_RUGI', kode: '5-2160' }, { role: 'KREDIT_LABA', kode: '4-1800' }]);
    const kustom = await testDb.getFirstAsync<{ kode: string }>(
      `SELECT a.kode FROM account_mapping m JOIN account a ON a.id = m.account_id WHERE m.transaction_type = 'IMPAIRMENT_INVESTASI' AND m.role = 'DEBIT_BEBAN'`
    );
    expect(kustom!.kode).toBe('5-2000');
    expect((await testDb.getFirstAsync<{ version: number }>(`SELECT version FROM schema_meta`))!.version).toBe(SCHEMA_VERSION); // DIPERBARUI RC-S54 T16 GAP 6
    expect(await histori()).toBe(awal);
    await expect(lepaskanInvestasi(input(id, 310_000_000))).resolves.toBeDefined();
  });

  it('laba ke akun existing 4-1800; rugi ke akun baru 5-2160 (BEBAN_LAIN); hasil pelepasan diklasifikasi INVESTASI', () => {
    const m = DEFAULT_ACCOUNT_MAPPING.filter((x) => x.transactionType === 'PELEPASAN_INVESTASI').map((x) => `${x.role}:${x.accountKode}`).sort();
    expect(m).toEqual(['DEBIT_RUGI:5-2160', 'KREDIT_LABA:4-1800']);
    expect(DEFAULT_ACCOUNTS.find((a) => a.kode === '5-2160')).toEqual({
      kode: '5-2160', nama: 'Kerugian Pelepasan Investasi', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false, lhuKlasifikasi: 'BEBAN_LAIN',
    });
    expect(DEFAULT_ACCOUNTS.filter((a) => a.kode === '5-2160')).toHaveLength(1);
    expect(cariKonflikKodeAkun('5-2160')).toBeNull();
    expect(CASH_FLOW_CLASSIFICATION.PELEPASAN_INVESTASI).toBe('INVESTASI');
  });
});

// ===========================================================================
describe('RC-S54 T16 #20 — pelepasan: jurnal, laba/rugi, clearing', () => {
  it('1/6/10/12/15 TANAH tanpa penyusutan, hasil > nilai tercatat, Kas: laba ke 4-1800, 1-1660 keluar, seimbang', async () => {
    const id = await properti('TANAH');
    const { journalId, pratinjau } = await lepaskanInvestasi(input(id, 320_000_000));
    expect(pratinjau).toMatchObject({ nilaiTercatat: 300_000_000, selisih: 20_000_000, jenisSelisih: 'LABA' });
    expect(await entri(journalId)).toEqual([
      { kode: '1-1000', debit: 320_000_000, kredit: 0 },
      { kode: '1-1660', debit: 0, kredit: 300_000_000 },
      { kode: '4-1800', debit: 0, kredit: 20_000_000 },
    ]);
    expect(await posisiInvestasi()).toMatchObject({ aset: 0, akm: 0, imp: 0 });
    const inv = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM investasi WHERE id = ?`, id);
    expect(inv!.status).toBe('DILEPAS');
    const ak = await getArusKas(testDb as never, '2026-01-01', '2026-12-31');
    expect(ak.investasi).toBe(-300_000_000 + 320_000_000);
  });

  it('2/7/11 BANGUNAN tanpa penyusutan (dikonfigurasi), hasil = nilai tercatat, Bank: impas tanpa baris laba', async () => {
    const id = await properti('BANGUNAN');
    const bank = await bankAccount();
    const { journalId, pratinjau } = await lepaskanInvestasi(input(id, 300_000_000, { sumberDana: 'BANK', bankAccountId: bank }));
    expect(pratinjau.jenisSelisih).toBe('IMPAS');
    expect(await entri(journalId)).toEqual([
      { kode: '1-1100', debit: 300_000_000, kredit: 0 },
      { kode: '1-1660', debit: 0, kredit: 300_000_000 },
    ]);
  });

  it('3/13/16 BANGUNAN dengan penyusutan: 1-1670 dibersihkan per investasi; nilai tercatat investasi menjadi 0 di ledger', async () => {
    const id = await properti('BANGUNAN');
    await susutkan(id, ['2026-01', '2026-02', '2026-03']);
    const lain = await properti('BANGUNAN', '2026-01-06', 120_000_000);
    await susutkan(lain, ['2026-01']);
    const { journalId, pratinjau } = await lepaskanInvestasi(input(id, 295_000_000));
    expect(pratinjau).toMatchObject({ biayaPerolehan: 300_000_000, akumulasiPenyusutan: 7_500_000, akumulasiImpairment: 0, nilaiTercatat: 292_500_000, selisih: 2_500_000 });
    expect(await entri(journalId)).toEqual([
      { kode: '1-1000', debit: 295_000_000, kredit: 0 },
      { kode: '1-1670', debit: 7_500_000, kredit: 0 },
      { kode: '1-1660', debit: 0, kredit: 300_000_000 },
      { kode: '4-1800', debit: 0, kredit: 2_500_000 },
    ]);
    // Hanya milik investasi yang dilepas: investasi lain tetap 120 jt / −1 jt.
    expect(await posisiInvestasi()).toMatchObject({ aset: 120_000_000, akm: -1_000_000, imp: 0 });
    const d = await diagnosaHistoriPelepasanPropertiInvestasi(testDb as never);
    expect(d.baris.find((b) => b.investasiId === id)).toMatchObject({ status: 'DILEPAS', nilaiTercatatLedger: 0, nilaiTercatatSeharusnya: 0, temuan: [], tindakanKoreksi: null });
    expect(d.jumlahKandidat).toBe(0);
  });

  it('4/14 BANGUNAN + impairment: 1-1900 dibersihkan; tidak ada impairment tersisa', async () => {
    const id = await properti('BANGUNAN');
    await susutkan(id, ['2026-01', '2026-02']);
    await impair(id, 10_000_000);
    const { journalId, pratinjau } = await lepaskanInvestasi(input(id, 290_000_000));
    expect(pratinjau).toMatchObject({ nilaiTercatat: 285_000_000, selisih: 5_000_000 });
    expect(await entri(journalId)).toEqual([
      { kode: '1-1000', debit: 290_000_000, kredit: 0 },
      { kode: '1-1670', debit: 5_000_000, kredit: 0 },
      { kode: '1-1900', debit: 10_000_000, kredit: 0 },
      { kode: '1-1660', debit: 0, kredit: 300_000_000 },
      { kode: '4-1800', debit: 0, kredit: 5_000_000 },
    ]);
    expect(await posisiInvestasi()).toMatchObject({ aset: 0, akm: 0, imp: 0 });
    // Setelah dilepas: tidak dapat disusutkan / diturunkan nilainya lagi.
    await expect(susutkan(id, ['2026-09'])).rejects.toThrow();
    await expect(impair(id, 1_000_000, '2026-09-01')).rejects.toThrow();
  });

  it('5/7 TANAH_DAN_BANGUNAN: penyusutan hanya porsi bangunan; hasil = nilai tercatat -> impas', async () => {
    const id = await properti('TANAH_DAN_BANGUNAN');
    await susutkan(id, ['2026-01', '2026-02', '2026-03']);
    const { journalId, pratinjau } = await lepaskanInvestasi(input(id, 294_000_000));
    expect(pratinjau).toMatchObject({ akumulasiPenyusutan: 6_000_000, nilaiTercatat: 294_000_000, selisih: 0, jenisSelisih: 'IMPAS' });
    const e = await entri(journalId);
    expect(e.reduce((t, x) => t + x.debit, 0)).toBe(e.reduce((t, x) => t + x.kredit, 0));
    expect(e.some((x) => x.kode === '4-1800')).toBe(false);
  });

  it('8 hasil < nilai tercatat -> rugi: Dr 5-2160; seimbang; clearing lengkap; LHU beban lain; pratinjau = eksekusi', async () => {
    const id = await properti('BANGUNAN');
    await susutkan(id, ['2026-01']);
    await impair(id, 7_500_000);
    const pr = await pratinjauPelepasanInvestasi(input(id, 250_000_000));
    const { journalId, pratinjau } = await lepaskanInvestasi(input(id, 250_000_000));
    expect(pratinjau).toEqual(pr);
    expect(pratinjau).toMatchObject({ akumulasiPenyusutan: 2_500_000, akumulasiImpairment: 7_500_000, nilaiTercatat: 290_000_000, selisih: -40_000_000, jenisSelisih: 'RUGI' });
    expect(await entri(journalId)).toEqual([
      { kode: '1-1000', debit: 250_000_000, kredit: 0 },
      { kode: '1-1670', debit: 2_500_000, kredit: 0 },
      { kode: '1-1900', debit: 7_500_000, kredit: 0 },
      { kode: '5-2160', debit: 40_000_000, kredit: 0 },
      { kode: '1-1660', debit: 0, kredit: 300_000_000 },
    ]);
    expect(await posisiInvestasi()).toMatchObject({ aset: 0, akm: 0, imp: 0 });
    const lhu = await getLHU(testDb as never, '2026-01-01', '2026-12-31');
    expect(JSON.stringify(lhu)).toContain('Kerugian Pelepasan Investasi');
    const d = await diagnosaHistoriPelepasanPropertiInvestasi(testDb as never);
    expect(d.baris.find((b) => b.investasiId === id)!.temuan).toEqual([]);
  });

  it('9 hasil = 0 pada investasi bernilai tercatat 0 (impairment penuh): tanpa baris kas, tanpa rekening, impas; 1-1900 & 1-1610 bersih', async () => {
    const inv = await catatInvestasi({ jenisInvestasi: 'KOPERASI_LAIN', namaTujuan: 'KSP Pailit', jumlah: 5_000_000, tanggal: '2026-01-10', sumberDana: 'KAS', createdBy: USER });
    await impair(inv.id, 5_000_000);
    const { journalId, pratinjau } = await lepaskanInvestasi(input(inv.id, 0));
    expect(pratinjau).toMatchObject({ hasilPelepasan: 0, nilaiTercatat: 0, jenisSelisih: 'IMPAS', rekeningAccountId: null });
    expect(await entri(journalId)).toEqual([
      { kode: '1-1900', debit: 5_000_000, kredit: 0 },
      { kode: '1-1610', debit: 0, kredit: 5_000_000 },
    ]);
    expect(await posisiInvestasi()).toMatchObject({ kop: 0, imp: 0 });
  });

  it('validasi hasil & rekening: negatif / pecahan / bukan angka ditolak; hasil > 0 tanpa rekening ditolak; hasil tidak pernah diambil dari biaya', async () => {
    const id = await properti('TANAH');
    await harusDitolakPelepasan(input(id, -1), 'HASIL_TIDAK_VALID');
    await harusDitolakPelepasan(input(id, 10.5), 'HASIL_TIDAK_VALID');
    await harusDitolakPelepasan({ ...input(id, 0), hasilPelepasan: undefined as never }, 'HASIL_TIDAK_VALID');
    await harusDitolakPelepasan(input(id, 300_000_000, { sumberDana: undefined }), 'REKENING_WAJIB');
    // hasil 0 atas nilai tercatat 300 jt = rugi penuh tanpa baris kas, bukan "hasil = biaya".
    const { journalId, pratinjau } = await lepaskanInvestasi(input(id, 0));
    expect(pratinjau).toMatchObject({ hasilPelepasan: 0, selisih: -300_000_000, jenisSelisih: 'RUGI', rekeningAccountId: null });
    expect(await entri(journalId)).toEqual([
      { kode: '5-2160', debit: 300_000_000, kredit: 0 },
      { kode: '1-1660', debit: 0, kredit: 300_000_000 },
    ]);
  });
});

// ===========================================================================
describe('RC-S54 T16 #20 — status, tanggal, periode', () => {
  it('17 double disposal ditolak (status & jurnal pelepasan existing)', async () => {
    const id = await properti('TANAH');
    await lepaskanInvestasi(input(id, 300_000_000));
    await harusDitolakPelepasan(input(id, 300_000_000), 'SUDAH_DILEPAS');
    // Walau status dipaksa kembali AKTIF, jurnal pelepasan POSTED yang ada tetap mencegah event kedua.
    await testDb.runAsync(`UPDATE investasi SET status = 'AKTIF' WHERE id = ?`, id);
    await harusDitolakPelepasan(input(id, 300_000_000), 'SUDAH_DILEPAS');
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'PELEPASAN_INVESTASI' AND sumber_id = ?`, id);
    expect(n!.n).toBe(1);
  });

  it('18 periode tanggal pelepasan CLOSED ditolak atomik', async () => {
    const id = await properti('TANAH', '2025-03-01');
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    await harusDitolakPelepasan(input(id, 300_000_000), 'PERIODE_CLOSED');
  });

  it('19 perolehan 2025 CLOSED + pelepasan 2026 OPEN: berhasil; jurnal hanya di 2026; 2025 & laporannya identik; tidak dibuka ulang', async () => {
    const id = await properti('BANGUNAN', '2025-03-01');
    await susutkan(id, ['2025-03', '2025-04']);
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2025'`);
    const jurnal2025 = async () => JSON.stringify(await testDb.getAllAsync(`SELECT je.* FROM journal_entry je JOIN journal j ON j.id = je.journal_id WHERE j.tanggal < '2026-01-01' ORDER BY je.id`));
    const awal = await jurnal2025();
    const posisi2025 = JSON.stringify(await getPosisiKeuangan(testDb as never, '2025-12-31'));
    const { journalId } = await lepaskanInvestasi(input(id, 296_000_000));
    expect(await jurnal2025()).toBe(awal);
    expect(JSON.stringify(await getPosisiKeuangan(testDb as never, '2025-12-31'))).toBe(posisi2025);
    const j = await testDb.getFirstAsync<{ tanggal: string; period_id: string }>(`SELECT tanggal, period_id FROM journal WHERE id = ?`, journalId);
    expect(j).toEqual({ tanggal: '2026-08-31', period_id: 'p2026' });
    expect((await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM accounting_period WHERE id = 'p2025'`))!.status).toBe('CLOSED');
    // Per 31-12-2025 masih aktif; per 31-12-2026 sudah keluar.
    expect((await listInvestasi('2025-12-31')).map((i) => i.id)).toContain(id);
    expect((await listInvestasi('2026-12-31')).map((i) => i.id)).not.toContain(id);
    expect((await listInvestasi('2026-08-30')).map((i) => i.id)).toContain(id);
  });

  it('20 tanggal masa depan, sebelum perolehan, format salah, dan sebelum penyusutan terakhir ditolak', async () => {
    const id = await properti('BANGUNAN');
    await susutkan(id, ['2026-01', '2026-02', '2026-03']);
    await harusDitolakPelepasan(input(id, 300_000_000, { tanggalPelepasan: '2026-09-18' }), 'TANGGAL_MASA_DEPAN');
    await harusDitolakPelepasan(input(id, 300_000_000, { tanggalPelepasan: '2025-12-31' }), 'TANGGAL_SEBELUM_PEROLEHAN');
    await harusDitolakPelepasan(input(id, 300_000_000, { tanggalPelepasan: '31-08-2026' }), 'TANGGAL_TIDAK_VALID');
    await harusDitolakPelepasan(input(id, 300_000_000, { tanggalPelepasan: '2026-02-15' }), 'ADA_TRANSAKSI_SETELAH_TANGGAL_PELEPASAN');
    // Hari ini sendiri diterima.
    await expect(lepaskanInvestasi(input(id, 300_000_000, { tanggalPelepasan: '2026-09-17' }))).resolves.toBeDefined();
  });
});

// ===========================================================================
describe('RC-S54 T16 #20 — atomik', () => {
  it('21 rollback total bila pembuatan jurnal gagal (akun laba nonaktif)', async () => {
    const id = await properti('BANGUNAN');
    await susutkan(id, ['2026-01']);
    await testDb.runAsync(`UPDATE account SET is_active = 0 WHERE kode = '4-1800'`);
    const awal = await snapshotTabel(testDb, TABEL);
    await expect(lepaskanInvestasi(input(id, 310_000_000))).rejects.toThrow();
    expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
  });

  it('22 rollback total bila langkah setelah jurnal gagal (status/clearing, lalu audit)', async () => {
    const id = await properti('BANGUNAN');
    await susutkan(id, ['2026-01']);
    await impair(id, 1_000_000);
    await testDb.execAsync(`CREATE TRIGGER uji_gagal_status BEFORE UPDATE ON investasi WHEN NEW.status = 'DILEPAS' BEGIN SELECT RAISE(ABORT, 'uji gagal status'); END;`);
    let awal = await snapshotTabel(testDb, TABEL);
    await expect(lepaskanInvestasi(input(id, 300_000_000))).rejects.toThrow(/uji gagal status/);
    expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
    await testDb.execAsync(`DROP TRIGGER uji_gagal_status; CREATE TRIGGER uji_gagal_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'DISPOSE' BEGIN SELECT RAISE(ABORT, 'uji gagal audit'); END;`);
    awal = await snapshotTabel(testDb, TABEL);
    await expect(lepaskanInvestasi(input(id, 300_000_000))).rejects.toThrow(/uji gagal audit/);
    expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
  });
});

// ===========================================================================
describe('RC-S54 T16 #20 — koreksi salah input ≠ pelepasan (KOREKSI_SALAH_INPUT)', () => {
  it('23a koreksi TANAH tanpa lifecycle tetap berjalan: DIBATALKAN, tanpa jurnal pelepasan / laba; 1-1660 kembali 0', async () => {
    const id = await properti('TANAH');
    await batalkanInvestasi(id, USER, 'salah input nilai');
    expect(await posisiInvestasi()).toMatchObject({ aset: 0, akm: 0, imp: 0 });
    const inv = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM investasi WHERE id = ?`, id);
    expect(inv!.status).toBe('DIBATALKAN');
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'PELEPASAN_INVESTASI'`);
    expect(n!.n).toBe(0);
    expect((await diagnosaHistoriPelepasanPropertiInvestasi(testDb as never)).baris.flatMap((b) => b.temuan)).toEqual([]);
    // Investasi yang sudah dikoreksi bukan objek pelepasan.
    await harusDitolakPelepasan(input(id, 300_000_000), 'STATUS_TIDAK_AKTIF');
  });

  it('23b koreksi atas BANGUNAN yang sudah disusutkan DITOLAK dengan arahan ke Pelepasan Investasi', async () => {
    const id = await properti('BANGUNAN');
    await susutkan(id, ['2026-01', '2026-02', '2026-03']);
    await harusDitolakKoreksi(() => batalkanInvestasi(id, USER, 'salah input'), 7_500_000, 0);
  });

  it('23c koreksi atas investasi yang sudah di-impair (tanpa penyusutan) DITOLAK', async () => {
    const inv = await catatInvestasi({ jenisInvestasi: 'KOPERASI_LAIN', namaTujuan: 'KSP Sekunder', jumlah: 50_000_000, tanggal: '2026-01-10', sumberDana: 'KAS', createdBy: USER });
    await impair(inv.id, 5_000_000);
    await harusDitolakKoreksi(() => batalkanInvestasi(inv.id, USER, 'salah input'), 0, 5_000_000);
  });

  it('23d edit (memakai jalur koreksi) atas investasi berlifecycle DITOLAK; koreksi atas investasi DILEPAS DITOLAK', async () => {
    const id = await properti('TANAH_DAN_BANGUNAN');
    await susutkan(id, ['2026-01', '2026-02']);
    await impair(id, 1_000_000);
    await harusDitolakKoreksi(
      () => editInvestasi(id, USER, { namaTujuan: 'Ruko', jumlah: 310_000_000, tanggal: '2026-01-05', sumberDana: 'KAS' } as never, 'koreksi nilai'),
      4_000_000,
      1_000_000
    );
    await lepaskanInvestasi(input(id, 300_000_000));
    await expect(batalkanInvestasi(id, USER, 'batal')).rejects.toThrow(/sudah dilepas/);
  });

  it('periode asal CLOSED tanpa lifecycle: koreksi existing tetap — pembalik di periode berjalan, jurnal 2025 utuh', async () => {
    const id = await properti(null, '2025-03-01');
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2025'`);
    const jurnal2025 = async () => JSON.stringify(await testDb.getAllAsync(`SELECT je.* FROM journal_entry je JOIN journal j ON j.id = je.journal_id WHERE j.tanggal < '2026-01-01' ORDER BY je.id`));
    const awal = await jurnal2025();
    await batalkanInvestasi(id, USER, 'salah input');
    expect(await jurnal2025()).toBe(awal);
  });
});

// ===========================================================================
describe('RC-S54 T16 #20 — pratinjau, audit, history', () => {
  it('24 pratinjau = eksekusi (nilai & baris jurnal identik); pratinjau read-only', async () => {
    const id = await properti('BANGUNAN');
    await susutkan(id, ['2026-01', '2026-02']);
    await impair(id, 3_000_000);
    const bank = await bankAccount();
    const inp = input(id, 301_000_000, { sumberDana: 'BANK', bankAccountId: bank });
    const awal = await snapshotTabel(testDb, TABEL);
    const pr = await pratinjauPelepasanInvestasi(inp);
    expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
    const { journalId, pratinjau } = await lepaskanInvestasi(inp);
    expect(pratinjau).toEqual(pr);
    expect(await entri(journalId)).toEqual(pr.baris.map((b) => ({ kode: b.kode, debit: b.debit, kredit: b.kredit })));
    expect(pr).toMatchObject({ nilaiTercatat: 292_000_000, selisih: 9_000_000, hasilPelepasan: 301_000_000 });
  });

  it('25 audit pelepasan lengkap', async () => {
    const id = await properti('BANGUNAN');
    await susutkan(id, ['2026-01']);
    const { journalId } = await lepaskanInvestasi(input(id, 300_000_000, { keterangan: 'dijual ke pihak ketiga' }));
    const a = await testDb.getFirstAsync<{ user_id: string; action: string; entity: string; entity_id: string; data_sebelum: string; data_sesudah: string }>(
      `SELECT user_id, action, entity, entity_id, data_sebelum, data_sesudah FROM audit_log WHERE action = 'DISPOSE'`
    );
    expect(a).toMatchObject({ user_id: USER, entity: 'investasi', entity_id: id });
    expect(JSON.parse(a!.data_sebelum)).toEqual({ status: 'AKTIF' });
    expect(JSON.parse(a!.data_sesudah)).toEqual({
      jenisOperasi: 'PELEPASAN_INVESTASI', investasiId: id, tanggalPelepasan: '2026-08-31', hasilPelepasan: 300_000_000,
      biayaPerolehan: 300_000_000, akumulasiPenyusutan: 2_500_000, akumulasiImpairment: 0, nilaiTercatat: 297_500_000, labaRugi: 2_500_000,
      journalId, rekeningAccountId: accId('1-1000'), sumberDana: 'KAS', bankAccountId: null, statusSebelum: 'AKTIF', statusSesudah: 'DILEPAS',
      userId: USER, keterangan: 'dijual ke pihak ketiga',
    });
    // Keterangan jurnal penempatan lama tidak ditimpa.
    const inv = await testDb.getFirstAsync<{ keterangan: string | null }>(`SELECT keterangan FROM investasi WHERE id = ?`, id);
    expect(inv!.keterangan).toBeNull();
  });

  it('26 History membedakan PELEPASAN_INVESTASI dan KOREKSI_SALAH_INPUT', async () => {
    const a = await properti('TANAH');
    const b = await properti('TANAH', '2026-01-06', 100_000_000);
    await lepaskanInvestasi(input(a, 300_000_000));
    await batalkanInvestasi(b, USER, 'salah input');
    const rows = await listHistoryTransaksi({});
    const ops = rows.filter((r) => r.operasiInvestasi).map((r) => r.operasiInvestasi).sort();
    expect(ops).toEqual(['KOREKSI_SALAH_INPUT', 'PELEPASAN_INVESTASI']);
    expect(rows.find((r) => r.operasiInvestasi === 'PELEPASAN_INVESTASI')!.jenisLabel).toBe('Pelepasan Investasi');
    // Penempatan asli (bukan pembalik) tidak diberi label operasi.
    expect(rows.filter((r) => r.jenisTransaksi === 'INVESTASI_PROPERTI_INVESTASI' && !r.operasiInvestasi)).toHaveLength(2);
    expect(operasiInvestasiDariJurnal('INVESTASI_PROPERTI_INVESTASI', null)).toBeNull();
    expect(operasiInvestasiDariJurnal('KAS_PENERIMAAN_LAIN', 'x')).toBeNull();
  });

  it('28 regresi: investasi tanpa penyusutan/impairment; CALK tidak lagi mengurangkan impairment investasi yang sudah dilepas', async () => {
    const aktif = await catatInvestasi({ jenisInvestasi: 'KOPERASI_LAIN', namaTujuan: 'KSP A', jumlah: 20_000_000, tanggal: '2026-01-10', sumberDana: 'KAS', createdBy: USER });
    const lepas = await catatInvestasi({ jenisInvestasi: 'KOPERASI_LAIN', namaTujuan: 'KSP B', jumlah: 10_000_000, tanggal: '2026-01-10', sumberDana: 'KAS', createdBy: USER });
    await impair(lepas.id, 4_000_000);
    await lepaskanInvestasi(input(lepas.id, 6_000_000));
    const sebelas = (await generateCALK(testDb as never, '2026-01-01', '2026-12-31')).sections.find((s) => s.sectionKey === 'investasi')!.konten;
    expect(sebelas).toContain('Total investasi aktif (nilai tercatat sebelum penurunan nilai): Rp20.000.000 (1 penempatan). Tidak ada penurunan nilai investasi yang tercatat pada periode ini. ');
    // Per tanggal sebelum pelepasan: masih aktif dan impairment tetap diungkap.
    const sebelasApril = (await generateCALK(testDb as never, '2026-01-01', '2026-04-30')).sections.find((s) => s.sectionKey === 'investasi')!.konten;
    expect(sebelasApril).toContain('Penurunan nilai investasi: Rp4.000.000.');
    expect((await getNilaiTercatatInvestasi(testDb as never, aktif.id)).nilaiTercatat).toBe(20_000_000);
    expect(await posisiInvestasi()).toMatchObject({ kop: 20_000_000, imp: 0 });
  });
});

// ===========================================================================
describe('RC-S54 T16 #20 — diagnosaHistoriPelepasanPropertiInvestasi (27, read-only)', () => {
  /** Meniru jalur pra-#20: perolehan dibalik langsung, status diubah, penyusutan & impairment tertinggal. */
  async function pelepasanLama(id: string) {
    const inv = await testDb.getFirstAsync<{ journal_id: string }>(`SELECT journal_id FROM investasi WHERE id = ?`, id);
    await testDb.withTransactionAsync(async () => {
      await reverseJournal(testDb as never, inv!.journal_id, USER, 'jual kembali (pra-#20)');
    });
    await testDb.runAsync(`UPDATE investasi SET status = 'DIBATALKAN' WHERE id = ?`, id);
  }

  it('data warisan: akumulasi & impairment tersisa, carrying mismatch, laba/rugi tidak tercatat -> MANUAL_REVIEW; tanpa tebakan; read-only', async () => {
    const id = await properti('TANAH_DAN_BANGUNAN');
    await susutkan(id, ['2026-01', '2026-02', '2026-03']);
    await impair(id, 10_000_000);
    await pelepasanLama(id);
    expect(await posisiInvestasi()).toMatchObject({ aset: 0, akm: -6_000_000, imp: -10_000_000 });
    const awal = await snapshotTabel(testDb, TABEL);
    const d = await diagnosaHistoriPelepasanPropertiInvestasi(testDb as never);
    expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
    const b = d.baris.find((x) => x.investasiId === id)!;
    expect(b).toMatchObject({
      nomorInvestasi: expect.any(String), status: 'DIBATALKAN', biayaPerolehan: 300_000_000, akumulasiPenyusutan: 6_000_000, akumulasiImpairment: 10_000_000,
      nilaiTercatatSeharusnya: 0, nilaiTercatatLedger: -16_000_000, estimasiSelisih: -16_000_000, journalPelepasanId: null,
      tindakanKoreksi: 'MANUAL_REVIEW', koreksiDeterministik: false,
    });
    expect(b.temuan.map((t) => `${t.kode}:${t.nilai}`)).toEqual([
      'ASET_DILEPAS_AKUMULASI_PENYUSUTAN_TERSISA:6000000',
      'ASET_DILEPAS_IMPAIRMENT_TERSISA:10000000',
      'CARRYING_AMOUNT_MISMATCH:-16000000',
      'GAIN_LOSS_MISMATCH:16000000',
    ]);
    expect(d.jumlahKandidat).toBe(1);
  });

  it('kontrol sehat: properti aktif disusutkan & di-impair -> nilai tercatat ledger = seharusnya, tanpa temuan', async () => {
    const id = await properti('TANAH_DAN_BANGUNAN');
    await susutkan(id, ['2026-01', '2026-02']);
    await impair(id, 3_000_000);
    const b = (await diagnosaHistoriPelepasanPropertiInvestasi(testDb as never)).baris.find((x) => x.investasiId === id)!;
    expect(b).toMatchObject({ nilaiTercatatSeharusnya: 293_000_000, nilaiTercatatLedger: 293_000_000, temuan: [], tindakanKoreksi: null });
  });

  it('JOURNAL_MISMATCH: status AKTIF tetapi jurnal penempatan REVERSED; jurnal register tidak POSTED', async () => {
    const id = await properti('BANGUNAN');
    await susutkan(id, ['2026-01']);
    const inv = await testDb.getFirstAsync<{ journal_id: string }>(`SELECT journal_id FROM investasi WHERE id = ?`, id);
    await testDb.withTransactionAsync(async () => {
      await reverseJournal(testDb as never, inv!.journal_id, USER, 'dibalik tanpa ubah status');
    });
    const reg = await testDb.getFirstAsync<{ journal_id: string }>(`SELECT journal_id FROM investasi_penyusutan WHERE investasi_id = ?`, id);
    await testDb.runAsync(`UPDATE journal SET status = 'VOID' WHERE id = ?`, reg!.journal_id);
    const b = (await diagnosaHistoriPelepasanPropertiInvestasi(testDb as never)).baris.find((x) => x.investasiId === id)!;
    expect(b.temuan.filter((t) => t.kode === 'JOURNAL_MISMATCH')).toHaveLength(2);
  });

  it('jurnal pelepasan dirusak: tidak seimbang, tidak cocok register, laba/rugi salah, status tidak cocok', async () => {
    const id = await properti('BANGUNAN');
    await susutkan(id, ['2026-01', '2026-02']);
    const { journalId } = await lepaskanInvestasi(input(id, 300_000_000));
    await testDb.runAsync(
      `UPDATE journal_entry SET debit = debit - 1000 WHERE journal_id = ? AND account_id = ?`, journalId, accId('1-1670')
    );
    await testDb.runAsync(`UPDATE investasi SET status = 'AKTIF' WHERE id = ?`, id);
    const b = (await diagnosaHistoriPelepasanPropertiInvestasi(testDb as never)).baris.find((x) => x.investasiId === id)!;
    expect(b.temuan.map((t) => t.kode).sort()).toEqual(
      ['CARRYING_AMOUNT_MISMATCH', 'JOURNAL_MISMATCH', 'JURNAL_PELEPASAN_TIDAK_COCOK_REGISTER', 'JURNAL_PELEPASAN_TIDAK_SEIMBANG'].sort()
    );
    expect(b.tindakanKoreksi).toBe('MANUAL_REVIEW');

    // Investasi kedua: baris laba dirusak -> laba/rugi tercatat ≠ hasil − nilai tercatat.
    const id2 = await properti('TANAH', '2026-01-06', 100_000_000);
    const r2 = await lepaskanInvestasi(input(id2, 110_000_000));
    await testDb.runAsync(`UPDATE journal_entry SET kredit = kredit + 500 WHERE journal_id = ? AND account_id = ?`, r2.journalId, accId('4-1800'));
    const b2 = (await diagnosaHistoriPelepasanPropertiInvestasi(testDb as never)).baris.find((x) => x.investasiId === id2)!;
    expect(b2.temuan.map((t) => `${t.kode}:${t.nilai}`).sort()).toEqual(['GAIN_LOSS_MISMATCH:500', 'JURNAL_PELEPASAN_TIDAK_SEIMBANG:-500'].sort());
  });

  it('STATIC: diagnostik & pratinjau tanpa tulis DB; koreksi tidak memanggil pelepasan; UI memanggil lepaskanInvestasi untuk Jual Kembali/Cairkan', () => {
    const baca = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(strip(baca('src/services/PelepasanInvestasiDiagnostic.ts'))).not.toMatch(/INSERT INTO|UPDATE \w+ SET|DELETE FROM|createJournal|reverseJournal|runAsync|withTransaction/);
    const svc = strip(baca('src/services/PelepasanInvestasiService.ts'));
    expect(svc).not.toMatch(/reverseJournal|jumlah\s*\|\||\?\?\s*inv\.jumlah|hasilPelepasan\s*=\s*C/);
    const inv = strip(baca('src/services/InvestasiService.ts'));
    expect(inv.match(/throw new KoreksiInvestasiDitolakError/g)).toHaveLength(1);
    expect(inv).not.toMatch(/lepaskanInvestasi|pratinjauPelepasanInvestasi/);
    const ui = strip(baca('src/screens/Akuntansi/DaftarInvestasiScreen.tsx'));
    expect(ui).toMatch(/await lepaskanInvestasi\(input\)/);
    expect(ui).toMatch(/await pratinjauPelepasanInvestasi\(input\)/);
    expect(ui).toMatch(/onPress=\{\(\) => bukaPelepasan\(item\)\}/);
    for (const label of ['Hasil Pelepasan', 'Nilai Tercatat', 'Laba/Rugi Pelepasan', 'Nilai Perolehan', 'Akumulasi Penyusutan', 'Penurunan Nilai', 'Tanggal Pelepasan', 'Konfirmasi Pelepasan']) {
      expect(ui).toContain(label);
    }
    expect(ui).toMatch(/setLepasHasil\(''\)/);
    expect(ui).not.toMatch(/setLepasHasil\(String\(|setLepasHasil\(.*jumlah/);
  });
});

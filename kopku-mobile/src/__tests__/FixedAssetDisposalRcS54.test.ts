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


import { DEFAULT_ACCOUNTS, DEFAULT_ACCOUNT_MAPPING } from '@/config/defaultCOA';
import { SCHEMA_VERSION } from '@/database/schema';
import { runMigrations } from '@/database/db';
import { CASH_FLOW_CLASSIFICATION } from '@/accounting/CashFlowClassification';
import { cariKonflikKodeAkun } from '@/config/coaPolicyRegistry';
import { beliAset, hapusAset, listAset, listAsetDenganNilaiBuku, KoreksiAsetTetapDitolakError } from '@/services/AsetService';
import { prosesPenyusutanAset } from '@/services/PenyusutanService';
import { catatImpairmentInvestasi } from '@/services/InvestasiImpairmentService';
import { getPosisiKeuangan, getArusKas, getLHU } from '@/reports/FinancialReports';
import { listHistoryTransaksi } from '@/services/HistoryTransaksiService';
import {
  pratinjauPelepasanAsetTetap,
  lepaskanAsetTetap,
  diagnosaHistoriPelepasanAsetTetap,
  PelepasanAsetTetapDitolakError,
  PelepasanAsetTetapInput,
} from '@/services/PelepasanAsetTetapService';

/**
 * RC-S54 TAHAP 16 — GAP 6: PELEPASAN ASET TETAP (closure penuh).
 * Laba 4-1800, rugi 5-2170 (BEBAN_LAIN), schema v67 self-heal, jurnal per aset,
 * koreksi salah input ≠ pelepasan, diagnostik read-only.
 */

const TABEL = ['aset_tetap', 'aset_penyusutan', 'journal', 'journal_entry', 'audit_log', 'accounting_period', 'account', 'account_mapping'];
const saldo = (rows: { kode: string; saldo: number }[], kode: string) => rows.find((r) => r.kode === kode)?.saldo ?? 0;

async function aset(opsi: { nilai?: number; masa?: number; tanggal?: string; jenis?: 'TETAP' | 'TAK_BERWUJUD'; nama?: string } = {}): Promise<string> {
  const tanggal = opsi.tanggal ?? '2026-01-05';
  const r = await beliAset({
    namaAset: opsi.nama ?? 'Mobil Operasional', nilaiPerolehan: opsi.nilai ?? 120_000_000, nilaiResidu: 0, masaManfaatBulan: opsi.masa ?? 12,
    tanggal, tanggalPerolehan: tanggal, metodePembayaran: 'TUNAI', sumberDana: 'KAS', createdBy: USER, jenisAset: opsi.jenis ?? 'TETAP',
  } as never);
  return (r as { id: string }).id;
}
const susut = async (id: string, periode: string[]) => { for (const p of periode) await prosesPenyusutanAset({ asetId: id, periode: p, createdBy: USER }); };
const input = (asetId: string, hasil: number, extra: Partial<PelepasanAsetTetapInput> = {}): PelepasanAsetTetapInput => ({
  asetId, tanggalPelepasan: '2026-08-31', hasilPelepasan: hasil, sumberDana: hasil > 0 ? 'KAS' : undefined, createdBy: USER, ...extra,
});
async function entri(journalId: string) {
  return testDb.getAllAsync<{ kode: string; debit: number; kredit: number }>(
    `SELECT a.kode, je.debit, je.kredit FROM journal_entry je JOIN account a ON a.id = je.account_id WHERE je.journal_id = ? ORDER BY je.rowid`, journalId
  );
}
async function bankAccount(): Promise<string> {
  await testDb.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at) VALUES ('bank-1','Bank Uji','123','Koperasi',0,?,1,?)`,
    accId('1-1100'), new Date().toISOString()
  );
  return 'bank-1';
}
async function harusDitolak(inp: PelepasanAsetTetapInput, kode: string) {
  const awal = await snapshotTabel(testDb, TABEL);
  const err = await lepaskanAsetTetap(inp).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PelepasanAsetTetapDitolakError);
  expect((err as PelepasanAsetTetapDitolakError).kode).toBe(kode);
  expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
}
async function posisi(t = '2026-12-31') {
  const p = await getPosisiKeuangan(testDb as never, t);
  return { aset: saldo(p.aset, '1-1500'), akm: saldo(p.aset, '1-1510'), atb: saldo(p.aset, '1-1700') };
}

describe('RC-S54 T16 GAP 6 — COA, mapping, schema v67', () => {
  it('COA: 5-2170 BEBAN/DEBIT/BEBAN_LAIN unik tanpa konflik; mapping laba 4-1800 & rugi 5-2170; arus kas INVESTASI; investasi tidak berubah', () => {
    expect(DEFAULT_ACCOUNTS.filter((a) => a.kode === '5-2170')).toEqual([
      { kode: '5-2170', nama: 'Kerugian Pelepasan Aset Tetap', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false, lhuKlasifikasi: 'BEBAN_LAIN' },
    ]);
    expect(DEFAULT_ACCOUNTS.filter((a) => /kerugian pelepasan aset tetap/i.test(a.nama))).toHaveLength(1);
    expect(cariKonflikKodeAkun('5-2170')).toBeNull();
    const m = (t: string) => DEFAULT_ACCOUNT_MAPPING.filter((x) => x.transactionType === t).map((x) => `${x.role}:${x.accountKode}`).sort();
    expect(m('PELEPASAN_ASET_TETAP')).toEqual(['DEBIT_RUGI:5-2170', 'KREDIT_LABA:4-1800']);
    expect(m('PELEPASAN_INVESTASI')).toEqual(['DEBIT_RUGI:5-2160', 'KREDIT_LABA:4-1800']);
    expect(CASH_FLOW_CLASSIFICATION.PELEPASAN_ASET_TETAP).toBe('INVESTASI');
    expect(SCHEMA_VERSION).toBe(81); // DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
  });

  it('30/31/32 migrasi v66 -> v67: tepat satu akun & dua mapping; dua kali identik; mapping kustom tidak ditimpa; jurnal & saldo utuh', async () => {
    const id = await aset();
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type = 'PELEPASAN_ASET_TETAP'`);
    await testDb.runAsync(`DELETE FROM account WHERE kode = '5-2170'`);
    await testDb.execAsync(`CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`);
    await testDb.runAsync(`INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, 66)`);
    // mapping kustom pengguna pada transaksi yang sama (laba) + mapping lain
    await testDb.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-kustom','PELEPASAN_ASET_TETAP','KREDIT_LABA',?)`, accId('4-1500'));
    const histori = async () => JSON.stringify(await snapshotTabel(testDb, ['journal', 'journal_entry', 'aset_tetap', 'aset_penyusutan']));
    const awal = await histori();
    await runMigrations(testDb as never);
    const setelahSatu = JSON.stringify(await snapshotTabel(testDb, ['account', 'account_mapping', 'journal', 'journal_entry', 'aset_tetap']));
    await runMigrations(testDb as never);
    expect(JSON.stringify(await snapshotTabel(testDb, ['account', 'account_mapping', 'journal', 'journal_entry', 'aset_tetap']))).toBe(setelahSatu);
    expect(await testDb.getAllAsync(`SELECT kode, nama, kategori, normal_balance, lhu_klasifikasi FROM account WHERE kode = '5-2170'`)).toEqual([
      { kode: '5-2170', nama: 'Kerugian Pelepasan Aset Tetap', kategori: 'BEBAN', normal_balance: 'DEBIT', lhu_klasifikasi: 'BEBAN_LAIN' },
    ]);
    expect(await testDb.getAllAsync(`SELECT m.role, a.kode FROM account_mapping m JOIN account a ON a.id = m.account_id WHERE m.transaction_type = 'PELEPASAN_ASET_TETAP' ORDER BY m.role`)).toEqual([
      { role: 'DEBIT_RUGI', kode: '5-2170' }, { role: 'KREDIT_LABA', kode: '4-1500' },
    ]);
    expect((await testDb.getFirstAsync<{ version: number }>(`SELECT version FROM schema_meta`))!.version).toBe(SCHEMA_VERSION); // DIPERBARUI RC-S54 POST-CLOSURE #14: versi terkini kini 68
    expect(await histori()).toBe(awal);
    expect(id).toBeTruthy();
  });
});

describe('RC-S54 T16 GAP 6 — jurnal pelepasan', () => {
  it('1/5/8/10/13 belum disusutkan, hasil = NBV, Kas: impas; Dr Kas / Cr 1-1500; seimbang; biaya keluar', async () => {
    const id = await aset();
    const { journalId, pratinjau } = await lepaskanAsetTetap(input(id, 120_000_000));
    expect(pratinjau).toMatchObject({ statusPenyusutan: 'BELUM_DISUSUTKAN', nilaiBuku: 120_000_000, jenisSelisih: 'IMPAS' });
    expect(await entri(journalId)).toEqual([{ kode: '1-1000', debit: 120_000_000, kredit: 0 }, { kode: '1-1500', debit: 0, kredit: 120_000_000 }]);
    expect(await posisi()).toMatchObject({ aset: 0, akm: 0 });
  });

  it('2/4/9/11/12/14/34 sebagian disusutkan, hasil > NBV, Bank: laba 4-1800; akumulasi milik aset ini saja; NBV ledger 0; arus kas INVESTASI', async () => {
    const id = await aset();
    await susut(id, ['2026-01', '2026-02', '2026-03']);
    const lain = await aset({ nilai: 24_000_000, masa: 24, nama: 'Motor' });
    await susut(lain, ['2026-01']);
    const bank = await bankAccount();
    const { journalId, pratinjau } = await lepaskanAsetTetap(input(id, 100_000_000, { sumberDana: 'BANK', bankAccountId: bank }));
    expect(pratinjau).toMatchObject({ statusPenyusutan: 'SEBAGIAN', akumulasiPenyusutan: 30_000_000, nilaiBuku: 90_000_000, selisih: 10_000_000, jenisSelisih: 'LABA' });
    expect(await entri(journalId)).toEqual([
      { kode: '1-1100', debit: 100_000_000, kredit: 0 },
      { kode: '1-1510', debit: 30_000_000, kredit: 0 },
      { kode: '1-1500', debit: 0, kredit: 120_000_000 },
      { kode: '4-1800', debit: 0, kredit: 10_000_000 },
    ]);
    expect(await posisi()).toMatchObject({ aset: 24_000_000, akm: -1_000_000 });
    const d = (await diagnosaHistoriPelepasanAsetTetap(testDb as never)).find((b) => b.asetId === id)!;
    expect(d).toMatchObject({ status: 'DIHAPUS', nilaiBukuLedger: 0, nilaiBukuSeharusnya: 0, temuan: [], tindakanKoreksi: null });
    const ak = await getArusKas(testDb as never, '2026-01-01', '2026-12-31');
    expect(ak.investasi).toBe(-120_000_000 - 24_000_000 + 100_000_000);
  });

  it('3/6 disusutkan penuh; hasil < NBV -> rugi 5-2170 (LHU beban lain)', async () => {
    const id = await aset({ nilai: 12_000_000, masa: 3 });
    await susut(id, ['2026-01', '2026-02']);
    const { journalId, pratinjau } = await lepaskanAsetTetap(input(id, 1_000_000));
    expect(pratinjau).toMatchObject({ akumulasiPenyusutan: 8_000_000, nilaiBuku: 4_000_000, selisih: -3_000_000, jenisSelisih: 'RUGI' });
    expect(await entri(journalId)).toEqual([
      { kode: '1-1000', debit: 1_000_000, kredit: 0 },
      { kode: '1-1510', debit: 8_000_000, kredit: 0 },
      { kode: '5-2170', debit: 3_000_000, kredit: 0 },
      { kode: '1-1500', debit: 0, kredit: 12_000_000 },
    ]);
    expect(JSON.stringify(await getLHU(testDb as never, '2026-01-01', '2026-12-31'))).toContain('Kerugian Pelepasan Aset Tetap');
    const full = await aset({ nilai: 3_000_000, masa: 3, nama: 'Laptop' });
    await susut(full, ['2026-01', '2026-02', '2026-03']);
    const r = await lepaskanAsetTetap(input(full, 0));
    expect(r.pratinjau).toMatchObject({ statusPenyusutan: 'PENUH', nilaiBuku: 0, jenisSelisih: 'IMPAS' });
    expect(await entri(r.journalId)).toEqual([{ kode: '1-1510', debit: 3_000_000, kredit: 0 }, { kode: '1-1500', debit: 0, kredit: 3_000_000 }]);
  });

  it('7/25 hasil 0 atas NBV > 0: rugi penuh tanpa baris kas & rekening; hasil tidak pernah = biaya', async () => {
    const id = await aset();
    await susut(id, ['2026-01']);
    const { journalId, pratinjau } = await lepaskanAsetTetap(input(id, 0));
    expect(pratinjau).toMatchObject({ hasilPelepasan: 0, rekeningAccountId: null, selisih: -110_000_000 });
    expect(await entri(journalId)).toEqual([
      { kode: '1-1510', debit: 10_000_000, kredit: 0 },
      { kode: '5-2170', debit: 110_000_000, kredit: 0 },
      { kode: '1-1500', debit: 0, kredit: 120_000_000 },
    ]);
    const other = await aset({ nama: 'X' });
    await harusDitolak({ ...input(other, 0), hasilPelepasan: undefined as never }, 'HASIL_TIDAK_VALID');
    await harusDitolak(input(other, -5), 'HASIL_TIDAK_VALID');
    await harusDitolak(input(other, 10.5), 'HASIL_TIDAK_VALID');
    await harusDitolak(input(other, 5_000, { sumberDana: undefined }), 'REKENING_WAJIB');
  });

  it('33 akun aset & akumulasi diambil dari jurnal aset itu sendiri (aset tak berwujud 1-1700), bukan akun global', async () => {
    const id = await aset({ jenis: 'TAK_BERWUJUD', nilai: 36_000_000, masa: 36, nama: 'Lisensi' });
    await susut(id, ['2026-01']);
    const akmKode = (await testDb.getFirstAsync<{ kode: string }>(
      `SELECT a.kode FROM aset_penyusutan p JOIN journal_entry je ON je.journal_id = p.journal_id AND je.kredit > 0 JOIN account a ON a.id = je.account_id WHERE p.aset_id = ?`, id
    ))!.kode;
    const { journalId } = await lepaskanAsetTetap(input(id, 35_000_000));
    expect(await entri(journalId)).toEqual([
      { kode: '1-1000', debit: 35_000_000, kredit: 0 },
      { kode: akmKode, debit: 1_000_000, kredit: 0 },
      { kode: '1-1700', debit: 0, kredit: 36_000_000 },
    ]);
    expect(await posisi()).toMatchObject({ atb: 0 });
  });
});

describe('RC-S54 T16 GAP 6 — validasi, status, periode', () => {
  it('15/35 pelepasan kedua ditolak; dua panggilan bersamaan -> satu sukses, tepat satu jurnal', async () => {
    const id = await aset();
    const hasil = await Promise.allSettled([lepaskanAsetTetap(input(id, 120_000_000)), lepaskanAsetTetap(input(id, 120_000_000))]);
    expect(hasil.filter((h) => h.status === 'fulfilled')).toHaveLength(1);
    expect(hasil.filter((h) => h.status === 'rejected')).toHaveLength(1);
    const n = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM journal WHERE sumber_transaksi = 'PELEPASAN_ASET_TETAP' AND sumber_id = ?`, id);
    expect(n!.n).toBe(1);
    await harusDitolak(input(id, 120_000_000), 'SUDAH_DILEPAS');
    await testDb.runAsync(`UPDATE aset_tetap SET status = 'AKTIF' WHERE id = ?`, id);
    await harusDitolak(input(id, 120_000_000), 'SUDAH_DILEPAS');
  });

  it('16 periode pelepasan CLOSED ditolak atomik', async () => {
    const id = await aset({ tanggal: '2025-03-01' });
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    await harusDitolak(input(id, 1), 'PERIODE_CLOSED');
  });

  it('17 perolehan 2025 CLOSED + pelepasan 2026 OPEN berhasil; jurnal & Posisi Keuangan 2025 identik; 2025 tetap CLOSED; daftar per tanggal', async () => {
    const id = await aset({ tanggal: '2025-03-01', nilai: 60_000_000, masa: 60 });
    await susut(id, ['2025-03', '2025-04']);
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2025'`);
    const j2025 = async () => JSON.stringify(await testDb.getAllAsync(`SELECT je.* FROM journal_entry je JOIN journal j ON j.id = je.journal_id WHERE j.tanggal < '2026-01-01' ORDER BY je.id`));
    const awal = await j2025();
    const pk2025 = JSON.stringify(await getPosisiKeuangan(testDb as never, '2025-12-31'));
    const { journalId } = await lepaskanAsetTetap(input(id, 58_000_000));
    expect(await j2025()).toBe(awal);
    expect(JSON.stringify(await getPosisiKeuangan(testDb as never, '2025-12-31'))).toBe(pk2025);
    expect(await testDb.getFirstAsync(`SELECT tanggal, period_id FROM journal WHERE id = ?`, journalId)).toEqual({ tanggal: '2026-08-31', period_id: 'p2026' });
    expect((await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM accounting_period WHERE id = 'p2025'`))!.status).toBe('CLOSED');
    expect((await listAsetDenganNilaiBuku('2026-08-30')).map((a) => a.id)).toContain(id);
    expect((await listAsetDenganNilaiBuku('2026-08-31')).map((a) => a.id)).not.toContain(id);
    expect((await listAset({ termasukDihapus: true })).find((a) => a.id === id)!.jenisPenutupan).toBe('PELEPASAN_ASET_TETAP');
  });

  it('18/19/20 tanggal masa depan, sebelum perolehan, sebelum penyusutan terakhir, format salah ditolak; hari ini diterima', async () => {
    const id = await aset();
    await susut(id, ['2026-01', '2026-02', '2026-03']);
    await harusDitolak(input(id, 1, { tanggalPelepasan: '2026-09-18' }), 'TANGGAL_MASA_DEPAN');
    await harusDitolak(input(id, 1, { tanggalPelepasan: '2026-01-04' }), 'TANGGAL_SEBELUM_PEROLEHAN');
    await harusDitolak(input(id, 1, { tanggalPelepasan: '2026-02-15' }), 'ADA_PENYUSUTAN_SETELAH_TANGGAL_PELEPASAN');
    await harusDitolak(input(id, 1, { tanggalPelepasan: '31-08-2026' }), 'TANGGAL_TIDAK_VALID');
    await expect(lepaskanAsetTetap(input(id, 90_000_000, { tanggalPelepasan: '2026-09-17' }))).resolves.toBeDefined();
  });

  it('36/37 aset yang dilepas tidak dapat disusutkan, diedit/dikoreksi, maupun diturunkan nilainya (tidak ada impairment aset tetap)', async () => {
    const id = await aset();
    await susut(id, ['2026-01']);
    await lepaskanAsetTetap(input(id, 110_000_000));
    await expect(susut(id, ['2026-09'])).rejects.toThrow();
    await expect(hapusAset({ id, alasan: 'x', actingUserId: USER })).rejects.toThrow(/sudah dihapus/);
    await expect(catatImpairmentInvestasi({ investasiId: id, tanggal: '2026-09-01', indikasiTerpilih: ['x'], dasarPenilaian: 'x', nilaiImpairment: 1, alasan: 'x', createdBy: USER })).rejects.toThrow();
    const layanan = baca('src/services/PenyusutanService.ts') + baca('src/services/AsetService.ts');
    expect(layanan).not.toMatch(/impairment/i);
  });
});

describe('RC-S54 T16 GAP 6 — atomik & pratinjau', () => {
  it('21 rollback bila createJournal gagal (akun laba nonaktif)', async () => {
    const id = await aset();
    await testDb.runAsync(`UPDATE account SET is_active = 0 WHERE kode = '4-1800'`);
    const awal = await snapshotTabel(testDb, TABEL);
    await expect(lepaskanAsetTetap(input(id, 130_000_000))).rejects.toThrow();
    expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
  });

  it('22/23 rollback bila UPDATE status gagal, lalu bila audit gagal', async () => {
    const id = await aset();
    await susut(id, ['2026-01']);
    await testDb.execAsync(`CREATE TRIGGER uji_status BEFORE UPDATE ON aset_tetap WHEN NEW.status = 'DIHAPUS' BEGIN SELECT RAISE(ABORT, 'uji gagal status'); END;`);
    let awal = await snapshotTabel(testDb, TABEL);
    await expect(lepaskanAsetTetap(input(id, 100_000_000))).rejects.toThrow(/uji gagal status/);
    expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
    await testDb.execAsync(`DROP TRIGGER uji_status; CREATE TRIGGER uji_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'DISPOSE' BEGIN SELECT RAISE(ABORT, 'uji gagal audit'); END;`);
    awal = await snapshotTabel(testDb, TABEL);
    await expect(lepaskanAsetTetap(input(id, 100_000_000))).rejects.toThrow(/uji gagal audit/);
    expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
  });

  it('24 pratinjau = eksekusi; pratinjau read-only; audit lengkap; keterangan asal tidak ditimpa', async () => {
    const id = await aset();
    await susut(id, ['2026-01', '2026-02']);
    const inp = input(id, 95_000_000, { keterangan: 'dijual' });
    const awal = await snapshotTabel(testDb, TABEL);
    const pr = await pratinjauPelepasanAsetTetap(inp);
    expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
    const ketAwal = (await testDb.getFirstAsync<{ keterangan: string | null }>(`SELECT keterangan FROM aset_tetap WHERE id = ?`, id))!.keterangan;
    const { journalId, pratinjau } = await lepaskanAsetTetap(inp);
    expect(pratinjau).toEqual(pr);
    expect(await entri(journalId)).toEqual(pr.baris.map((b) => ({ kode: b.kode, debit: b.debit, kredit: b.kredit })));
    expect((await testDb.getFirstAsync<{ keterangan: string | null }>(`SELECT keterangan FROM aset_tetap WHERE id = ?`, id))!.keterangan).toBe(ketAwal);
    const a = await testDb.getFirstAsync<{ data_sesudah: string; entity: string; user_id: string }>(`SELECT data_sesudah, entity, user_id FROM audit_log WHERE action = 'DISPOSE' AND entity_id = ?`, id);
    expect(a).toMatchObject({ entity: 'aset_tetap', user_id: USER });
    expect(JSON.parse(a!.data_sesudah)).toMatchObject({
      jenisOperasi: 'PELEPASAN_ASET_TETAP', asetId: id, hasilPelepasan: 95_000_000, biayaPerolehan: 120_000_000, akumulasiPenyusutan: 20_000_000,
      nilaiBuku: 100_000_000, labaRugi: -5_000_000, journalId, statusSebelum: 'AKTIF', statusSesudah: 'DIHAPUS', userId: USER, keterangan: 'dijual',
    });
  });
});

describe('RC-S54 T16 GAP 6 — koreksi salah input & History', () => {
  it('koreksi atas aset berpenyusutan ditolak (arahkan ke Pelepasan); koreksi aset belum disusutkan tetap reversal', async () => {
    const a = await aset();
    await susut(a, ['2026-01']);
    const err = await hapusAset({ id: a, alasan: 'salah', actingUserId: USER }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KoreksiAsetTetapDitolakError);
    expect((err as Error).message).toMatch(/Pelepasan Aset Tetap/);
    const b = await aset({ nama: 'Salah' });
    expect(await hapusAset({ id: b, alasan: 'salah input', actingUserId: USER })).toEqual({ direversal: true });
    expect((await listAset({ termasukDihapus: true })).find((x) => x.id === b)!.jenisPenutupan).toBe('KOREKSI_SALAH_INPUT');
    await harusDitolak(input(b, 1), 'STATUS_TIDAK_AKTIF');
  });

  it('26/27 History: Pelepasan Aset Tetap (sumberId, nomor) vs Koreksi Salah Input', async () => {
    const a = await aset();
    const b = await aset({ nama: 'Salah' });
    const { journalId } = await lepaskanAsetTetap(input(a, 120_000_000));
    await hapusAset({ id: b, alasan: 'salah input', actingUserId: USER });
    const rows = await listHistoryTransaksi({});
    const lepas = rows.find((r) => r.operasiAsetTetap === 'PELEPASAN_ASET_TETAP')!;
    expect(lepas).toMatchObject({ journalId, jenisLabel: 'Pelepasan Aset Tetap', sumberId: a });
    expect(lepas.nomorTransaksi).toBeTruthy();
    const koreksi = rows.find((r) => r.operasiAsetTetap === 'KOREKSI_SALAH_INPUT')!;
    expect(koreksi.jenisLabel).toMatch(/^Koreksi Salah Input — /);
  });
});

describe('RC-S54 T16 GAP 6 — diagnostik histori (28/29, read-only)', () => {
  it('warisan (dihapus tanpa pelepasan), jurnal pelepasan dirusak, double disposal -> MANUAL_REVIEW; database identik', async () => {
    const lama = await aset({ nama: 'Warisan' });
    await susut(lama, ['2026-01', '2026-02']);
    await testDb.runAsync(`UPDATE aset_tetap SET status = 'DIHAPUS', updated_at = ? WHERE id = ?`, new Date().toISOString(), lama); // jalur pra-GAP 6
    const rusak = await aset({ nama: 'Rusak' });
    await susut(rusak, ['2026-01']);
    const r = await lepaskanAsetTetap(input(rusak, 115_000_000));
    await testDb.runAsync(`UPDATE journal_entry SET kredit = kredit + 700 WHERE journal_id = ? AND account_id = ?`, r.journalId, accId('4-1800'));
    const ganda = await aset({ nama: 'Ganda' });
    await lepaskanAsetTetap(input(ganda, 120_000_000));
    await seedJurnal(testDb, 'j-ganda', '2026-08-31', 'PELEPASAN_ASET_TETAP', [['1-1000', 5, 0], ['4-1800', 0, 5]], { sumberId: ganda });

    const awal = await snapshotTabel(testDb, TABEL);
    const d = await diagnosaHistoriPelepasanAsetTetap(testDb as never);
    expect(await snapshotTabel(testDb, TABEL)).toEqual(awal);
    const kode = (id: string) => d.find((b) => b.asetId === id)!.temuan.map((t) => t.kode).sort();
    expect(kode(lama)).toEqual(['AKUMULASI_PENYUSUTAN_TERSISA', 'ASET_DIHAPUS_BELUM_DIDERECOGNISI', 'CARRYING_AMOUNT_MISMATCH'].sort());
    expect(d.find((b) => b.asetId === lama)).toMatchObject({ biayaPerolehan: 120_000_000, akumulasiPenyusutan: 20_000_000, nilaiBukuSeharusnya: 0, nilaiBukuLedger: 100_000_000, journalPelepasanId: null, tindakanKoreksi: 'MANUAL_REVIEW', koreksiDeterministik: false });
    expect(kode(rusak)).toEqual(['GAIN_LOSS_MISMATCH', 'JOURNAL_MISMATCH'].sort());
    expect(kode(ganda)).toContain('DOUBLE_DISPOSAL');
    expect(strip(baca('src/services/PelepasanAsetTetapService.ts')).slice(strip(baca('src/services/PelepasanAsetTetapService.ts')).indexOf('export async function diagnosaHistoriPelepasanAsetTetap'))).not.toMatch(/runAsync|INSERT|UPDATE|DELETE|createJournal|withTransaction/);
  });
});

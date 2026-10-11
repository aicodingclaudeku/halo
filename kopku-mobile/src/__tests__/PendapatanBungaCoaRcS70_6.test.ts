import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S70.6 — FINAL COA MAPPING: PENDAPATAN BUNGA USAHA LAIN & DEPOSITO.
 *
 *   BUNGA_USAHA_LAIN -> 4-1520 Pendapatan Bunga Investasi
 *   BUNGA_DEPOSITO   -> 4-1510 Pendapatan Bunga Deposito
 *   4-1500 bukan target transaksi baru untuk kedua kategori.
 *
 * DATABASE memakai SQLite sungguhan (skema produksi) + AccountingEngine asli.
 */

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

import {
  getInfoPendapatanInvestasi,
  tambahPendapatanInvestasi,
  listRiwayatPendapatanInvestasi,
  tambahTransaksiPendapatan,
  koreksiTransaksiPendapatan,
  PendapatanInvestasiDitolakError,
} from '@/services/PendapatanLainnyaService';
import {
  KEBIJAKAN_PENDAPATAN_INVESTASI,
  AKUN_WAJIB_PENDAPATAN_BUNGA,
  periksaAkunKategoriPendapatanInvestasi,
} from '@/config/pendapatanKoperasiPolicy';
import { KODE_COA_DIMINTA_ITEM_14, cariKonflikKodeAkun } from '@/config/coaPolicyRegistry';
import { DEFAULT_ACCOUNTS, DEFAULT_ACCOUNT_MAPPING } from '@/config/defaultCOA';
import { SCHEMA_VERSION } from '@/database/schema';
import { getLabaRugi, getLHU } from '@/reports/FinancialReports';
import { getLedger, getTrialBalance } from '@/accounting/Ledger';
import { getPendapatanByClassification } from '@/services/PendapatanLainnyaService';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const ACC = {
  kas: 'acc-kas',
  bankBca: 'acc-bank-bca',
  bunga: 'acc-4-1500',
  deposito: 'acc-4-1510',
  investasi: 'acc-4-1520',
  sewa: 'acc-4-1600',
};

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, nb: 'DEBIT' | 'KREDIT', opts: { isSystem?: boolean; isActive?: boolean; lhu?: string | null } = {}) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, kode, nama, kategori, nb, opts.isActive === false ? 0 : 1, opts.isSystem ? 1 : 0, opts.lhu ?? null, now, now
  );
}

async function seedInvestasi(db: TestDb, id: string, nomor: string, jenis: string, nama: string) {
  await db.runAsync(
    `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal, sumber_dana, created_by, created_at, status)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, nomor, jenis, nama, 50_000_000, '2026-01-02', 'KAS', 'user-1', new Date().toISOString(), 'AKTIF'
  );
}

async function setupFixture(opts: { tanpa1520?: boolean; tanpa1510?: boolean } = {}): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT', { isSystem: true });
  await seedAccount(db, ACC.bankBca, '1-1100', 'Bank BCA', 'ASET', 'DEBIT', { isSystem: true });
  // 4-1500 SENGAJA ada & aktif: membuktikan tidak ada fallback diam-diam ke sana.
  await seedAccount(db, ACC.bunga, '4-1500', 'Pendapatan Bunga', 'PENDAPATAN', 'KREDIT', { lhu: 'HASIL_INVESTASI' });
  if (!opts.tanpa1510) await seedAccount(db, ACC.deposito, '4-1510', 'Pendapatan Bunga Deposito', 'PENDAPATAN', 'KREDIT', { lhu: 'HASIL_INVESTASI' });
  if (!opts.tanpa1520) await seedAccount(db, ACC.investasi, '4-1520', 'Pendapatan Bunga Investasi', 'PENDAPATAN', 'KREDIT', { lhu: 'HASIL_INVESTASI' });
  await seedAccount(db, ACC.sewa, '4-1600', 'Pendapatan Sewa', 'PENDAPATAN', 'KREDIT', { lhu: 'HASIL_INVESTASI' });
  await db.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-kas','KAS_UMUM','DEFAULT',?)`, ACC.kas);
  await db.runAsync(`INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p-2026',2026,'2026-01-01','2026-12-31','OPEN')`);
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at)
     VALUES ('bank-1','BCA','123','Koperasi',0,?,1,?)`,
    ACC.bankBca, now
  );
  await seedInvestasi(db, 'inv-dep', 'INV-2026-000001', 'DEPOSITO_BANK_UMUM', 'Deposito Bank Contoh');
  await seedInvestasi(db, 'inv-ul', 'INV-2026-000002', 'USAHA_LAIN', 'CV Mitra Usaha');
  return db;
}

async function hitung(sql: string, ...p: unknown[]): Promise<number> {
  const r = await testDb.getFirstAsync<{ n: number }>(sql, ...(p as any[]));
  return r?.n ?? 0;
}

async function barisJurnal(journalId: string) {
  return testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
    `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`,
    journalId
  );
}

const dasarUL = { kategori: 'BUNGA_USAHA_LAIN' as const, investasiId: 'inv-ul', tanggal: '2026-02-10', nominal: 350_000, jenis: 'KAS' as const, createdBy: 'user-1' };
const dasarDep = { kategori: 'BUNGA_DEPOSITO' as const, investasiId: 'inv-dep', tanggal: '2026-02-10', nominal: 125_000, jenis: 'KAS' as const, createdBy: 'user-1' };

// ===========================================================================
// TEST 1–3 — mapping kebijakan
// ===========================================================================

describe('RC-S70.6 — mapping kebijakan', () => {
  it('TEST 1 — BUNGA_USAHA_LAIN -> 4-1520 Pendapatan Bunga Investasi', () => {
    const k = KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_USAHA_LAIN;
    expect(k.akunKode).toBe('4-1520');
    expect(k.label).toBe('Pendapatan Bunga Investasi');
    expect(k.jenisInvestasi).toBe('USAHA_LAIN');
    expect(AKUN_WAJIB_PENDAPATAN_BUNGA.BUNGA_USAHA_LAIN).toEqual({ kode: '4-1520', nama: 'Pendapatan Bunga Investasi' });
    expect(DEFAULT_ACCOUNTS.find((a) => a.kode === '4-1520')).toMatchObject({
      nama: 'Pendapatan Bunga Investasi', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', lhuKlasifikasi: 'HASIL_INVESTASI',
    });
  });

  it('TEST 2 — BUNGA_DEPOSITO -> 4-1510 Pendapatan Bunga Deposito', () => {
    const k = KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_DEPOSITO;
    expect(k.akunKode).toBe('4-1510');
    expect(k.label).toBe('Pendapatan Bunga Deposito');
    expect(k.jenisInvestasi).toBe('DEPOSITO_BANK_UMUM');
    expect(AKUN_WAJIB_PENDAPATAN_BUNGA.BUNGA_DEPOSITO).toEqual({ kode: '4-1510', nama: 'Pendapatan Bunga Deposito' });
    expect(DEFAULT_ACCOUNTS.find((a) => a.kode === '4-1510')).toMatchObject({
      nama: 'Pendapatan Bunga Deposito', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', lhuKlasifikasi: 'HASIL_INVESTASI',
    });
  });

  it('TEST 3 — kedua kategori bukan 4-1500', () => {
    expect(KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_USAHA_LAIN.akunKode).not.toBe('4-1500');
    expect(KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_DEPOSITO.akunKode).not.toBe('4-1500');
    expect(AKUN_WAJIB_PENDAPATAN_BUNGA.BUNGA_USAHA_LAIN.kode).not.toBe('4-1500');
    expect(AKUN_WAJIB_PENDAPATAN_BUNGA.BUNGA_DEPOSITO.kode).not.toBe('4-1500');
  });

  it('kategori lain tidak berubah: Imbal Hasil Tetap 4-1700, Sewa 4-1600', () => {
    expect(KEBIJAKAN_PENDAPATAN_INVESTASI.IMBAL_HASIL_TETAP.akunKode).toBe('4-1700');
    expect(KEBIJAKAN_PENDAPATAN_INVESTASI.SEWA_PROPERTI.akunKode).toBe('4-1600');
  });

  it('COA master tidak berubah: 4-1500/4-1510/4-1520 masing-masing tepat satu, nama tetap, tanpa mapping baru', () => {
    for (const [kode, nama] of [['4-1500', 'Pendapatan Bunga'], ['4-1510', 'Pendapatan Bunga Deposito'], ['4-1520', 'Pendapatan Bunga Investasi']]) {
      const a = DEFAULT_ACCOUNTS.filter((x) => x.kode === kode);
      expect(a).toHaveLength(1);
      expect(a[0].nama).toBe(nama);
    }
    const kodeMapping = DEFAULT_ACCOUNT_MAPPING.map((m) => m.accountKode);
    expect(kodeMapping).not.toContain('4-1510');
    expect(kodeMapping).not.toContain('4-1520');
  });

  it('schema tidak berubah (tanpa migrasi)', () => {
    expect(SCHEMA_VERSION).toBe(81); // DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah). DIPERBARUI v80 (RC-S132: kolom app_user.anggota_id untuk akun Anggota, aditif; migrasi milik RC-S132). DIPERBARUI v79 (RC-S128: kebijakan produk simpanan berjangka + bunga pasca jatuh tempo; tabel expect(SCHEMA_VERSION).toBe(78); // DIPERBARUI v78 kolom baru, aditif). DIPERBARUI v78 (bunga harian sukarela: tabel baru + kolom snapshot SHU, aditif). DIPERBARUI v77 (Poin 5/6): kolom unit_usaha_id kas/bank + klasifikasi LHU 4-1500, aditif tanpa rebuild — invarian test ini TIDAK berubah. · DIPERBARUI RC-S88: v73 = rebuild penyesuaian_nilai_wajar (posting nilai wajar & revaluasi aset tetap/OCI). Migrasi itu MILIK RC-S88, bukan tahap ini — invarian yang dijaga TIDAK berubah. // DIPERBARUI v72 = penarikan dana investasi + jatuh tempo deposito · // · DIPERBARUI RESTRUKTURISASI DATA: v70 = asal personel (koperasi_personel.sumber_data + anggota_id, aditif). Migrasi itu MILIK restrukturisasi Data/Personel, BUKAN tahap ini — invarian yang dijaga test ini (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S78: v71 = dua penyebab selisih rekonsiliasi baru (TRANSAKSI_BELUM_TERCATAT, KESALAHAN_BANK). Migrasi itu MILIK RC-S78, bukan tahap ini — invarian yang dijaga (tahap ini tidak menambah migrasi sendiri) TIDAK berubah. · DIPERBARUI RC-S100: v74 = dua tabel BARU riwayat import data awal (import_data_awal_riwayat, import_data_awal_log), aditif murni tanpa DDL pada tabel lama. Migrasi itu MILIK RC-S100, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S114: v75 = kolom app_user.pin_hash_versi (penanda algoritma hash PIN; 1 = SHA-256 satu putaran warisan, 2 = scrypt), aditif murni lewat ADD COLUMN tanpa DDL pada tabel lain. Migrasi itu MILIK RC-S114 (audit keamanan backup & hash PIN), bukan tahap ini — invarian yang dijaga test ini TIDAK berubah. · DIPERBARUI RC-S117: v76 = kolom app_user.password_hash/password_salt/password_hash_versi (PASSWORD untuk masuk, dipisah dari PIN yang kini hanya membuka kunci aplikasi), aditif lewat ADD COLUMN plus penyalinan nilai PIN lama sebagai password awal supaya tidak ada pengurus yang terkunci. Migrasi itu MILIK RC-S117, bukan tahap ini — invarian yang dijaga test ini TIDAK berubah.
  });

  it('coaPolicyRegistry: 4-1510/4-1520 tidak lagi dialiaskan ke 4-1500, tetap bukan konflik', () => {
    for (const kode of ['4-1510', '4-1520']) {
      const e = KODE_COA_DIMINTA_ITEM_14.find((x) => x.kode === kode)!;
      expect(e.akunExisting).toEqual([kode]);
      expect(e.akunExisting).not.toContain('4-1500');
      expect(e.policy).toMatch(/KEPUTUSAN 01-B DIREVISI RC-S70\.6/);
      expect(cariKonflikKodeAkun(kode)).toBeNull();
    }
  });
});

// ===========================================================================
// TEST 6 — validasi kombinasi akun (pure)
// ===========================================================================

describe('RC-S70.6 — TEST 6: kombinasi akun salah ditolak', () => {
  it.each([
    ['BUNGA_USAHA_LAIN', '4-1510'],
    ['BUNGA_USAHA_LAIN', '4-1500'],
    ['BUNGA_DEPOSITO', '4-1520'],
    ['BUNGA_DEPOSITO', '4-1500'],
  ])('%s + %s -> ditolak', (kategori, kode) => {
    const pesan = periksaAkunKategoriPendapatanInvestasi(kategori as any, kode as string);
    expect(pesan).not.toBeNull();
    expect(pesan).toContain(kode as string);
  });

  it('kombinasi benar lolos', () => {
    expect(periksaAkunKategoriPendapatanInvestasi('BUNGA_USAHA_LAIN', '4-1520')).toBeNull();
    expect(periksaAkunKategoriPendapatanInvestasi('BUNGA_DEPOSITO', '4-1510')).toBeNull();
    expect(periksaAkunKategoriPendapatanInvestasi('IMBAL_HASIL_TETAP', '4-1700')).toBeNull();
    expect(periksaAkunKategoriPendapatanInvestasi('SEWA_PROPERTI', '4-1600')).toBeNull();
  });

  it('kode kosong ditolak', () => {
    expect(periksaAkunKategoriPendapatanInvestasi('BUNGA_DEPOSITO', '')).not.toBeNull();
  });
});

// ===========================================================================
// TEST 4–5 — jurnal
// ===========================================================================

describe('RC-S70.6 — jurnal (DATABASE)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  it('TEST 4 — Usaha Lain: Dr Kas / Cr 4-1520, nominal sama dengan input', async () => {
    const r = await tambahPendapatanInvestasi(dasarUL);
    expect(r.akunKode).toBe('4-1520');
    const b = await barisJurnal(r.journalId);
    expect(b).toHaveLength(2);
    expect(b[0]).toEqual({ account_id: ACC.kas, debit: 350_000, kredit: 0 });
    expect(b[1]).toEqual({ account_id: ACC.investasi, debit: 0, kredit: 350_000 });
    const row = await testDb.getFirstAsync<{ kategori: string; akun_lawan_id: string; nominal: number }>(
      `SELECT kategori, akun_lawan_id, nominal FROM kas_transaksi WHERE id = ?`, r.id
    );
    expect(row).toEqual({ kategori: 'Pendapatan Bunga Investasi', akun_lawan_id: ACC.investasi, nominal: 350_000 });
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal_entry WHERE account_id = ?`, ACC.bunga)).toBe(0);
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(1);
  });

  it('TEST 5 — Deposito via Bank: Dr Bank / Cr 4-1510, nominal sama dengan input', async () => {
    const r = await tambahPendapatanInvestasi({ ...dasarDep, jenis: 'BANK', bankAccountId: 'bank-1' });
    expect(r.akunKode).toBe('4-1510');
    const b = await barisJurnal(r.journalId);
    expect(b).toHaveLength(2);
    expect(b[0]).toEqual({ account_id: ACC.bankBca, debit: 125_000, kredit: 0 });
    expect(b[1]).toEqual({ account_id: ACC.deposito, debit: 0, kredit: 125_000 });
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal_entry WHERE account_id = ?`, ACC.bunga)).toBe(0);
  });

  it('info leaf menampilkan akun spesifik (dipakai UI read-only)', async () => {
    const ul = await getInfoPendapatanInvestasi('BUNGA_USAHA_LAIN');
    expect(ul.masalah).toBeNull();
    expect(ul.akun).toMatchObject({ kode: '4-1520', nama: 'Pendapatan Bunga Investasi', klasifikasiLhu: 'HASIL_INVESTASI' });
    const dep = await getInfoPendapatanInvestasi('BUNGA_DEPOSITO');
    expect(dep.masalah).toBeNull();
    expect(dep.akun).toMatchObject({ kode: '4-1510', nama: 'Pendapatan Bunga Deposito', klasifikasiLhu: 'HASIL_INVESTASI' });
  });

  it('reversal tetap mekanisme existing: jurnal 4-1520 dibalik, saldo kembali 0', async () => {
    const r = await tambahPendapatanInvestasi(dasarUL);
    await koreksiTransaksiPendapatan('KAS', r.id, 'user-1', 'Salah input');
    const j = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM journal WHERE id = ?`, r.journalId);
    expect(j?.status).toBe('REVERSED');
    const saldo = await testDb.getFirstAsync<{ s: number }>(
      `SELECT COALESCE(SUM(kredit),0) - COALESCE(SUM(debit),0) AS s FROM journal_entry WHERE account_id = ?`, ACC.investasi
    );
    expect(saldo?.s).toBe(0);
  });

  it('idempotensi tidak berubah: kunci submit sama -> satu jurnal', async () => {
    const a = await tambahPendapatanInvestasi({ ...dasarDep, idempotencyKey: 'k-1' });
    const b = await tambahPendapatanInvestasi({ ...dasarDep, idempotencyKey: 'k-1' });
    expect(b.journalId).toBe(a.journalId);
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(1);
  });
});

// ===========================================================================
// FAIL CLOSED — tanpa fallback ke 4-1500
// ===========================================================================

describe('RC-S70.6 — fail closed (DATABASE)', () => {
  const tanpaTulisan = async () => {
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(0);
    expect(await hitung(`SELECT COUNT(*) AS n FROM kas_transaksi`)).toBe(0);
    expect(await hitung(`SELECT COUNT(*) AS n FROM bank_transaksi`)).toBe(0);
  };

  it('4-1520 tidak ada -> COA_MISSING; tidak fallback ke 4-1500 yang aktif; akun tidak dibuat', async () => {
    testDb = await setupFixture({ tanpa1520: true });
    let err: any;
    try {
      await tambahPendapatanInvestasi(dasarUL);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PendapatanInvestasiDitolakError);
    expect(err.kode).toBe('COA_MISSING');
    expect(err.message).toBe('COA 4-1520 Pendapatan Bunga Investasi tidak ditemukan. Transaksi tidak dapat diposting.');
    expect(await hitung(`SELECT COUNT(*) AS n FROM account WHERE kode = '4-1520'`)).toBe(0);
    await tanpaTulisan();
  });

  it('4-1510 tidak ada -> COA_MISSING; tidak fallback ke 4-1500', async () => {
    testDb = await setupFixture({ tanpa1510: true });
    let err: any;
    try {
      await tambahPendapatanInvestasi(dasarDep);
    } catch (e) {
      err = e;
    }
    expect(err.kode).toBe('COA_MISSING');
    expect(err.message).toBe('COA 4-1510 Pendapatan Bunga Deposito tidak ditemukan. Transaksi tidak dapat diposting.');
    await tanpaTulisan();
  });

  it.each([
    ['BUNGA_USAHA_LAIN', '4-1500'],
    ['BUNGA_USAHA_LAIN', '4-1510'],
    ['BUNGA_DEPOSITO', '4-1500'],
    ['BUNGA_DEPOSITO', '4-1520'],
  ])('kebijakan terkorupsi %s -> %s ditolak AKUN_TIDAK_SESUAI tanpa tulisan', async (kategori, kodeSalah) => {
    testDb = await setupFixture();
    const k = KEBIJAKAN_PENDAPATAN_INVESTASI[kategori as 'BUNGA_USAHA_LAIN' | 'BUNGA_DEPOSITO'] as any;
    const asli = k.akunKode;
    k.akunKode = kodeSalah;
    try {
      const info = await getInfoPendapatanInvestasi(kategori as any);
      expect(info.akun).toBeNull();
      expect(info.masalah).toContain(kodeSalah as string);
      let err: any;
      try {
        await tambahPendapatanInvestasi(kategori === 'BUNGA_USAHA_LAIN' ? dasarUL : dasarDep);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PendapatanInvestasiDitolakError);
      expect(err.kode).toBe('AKUN_TIDAK_SESUAI');
      await tanpaTulisan();
    } finally {
      k.akunKode = asli;
    }
  });
});

// ===========================================================================
// DATA HISTORIS — tidak dimodifikasi, tetap terbaca
// ===========================================================================

describe('RC-S70.6 — transaksi historis 4-1500 dipertahankan', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  it('jurnal lama tetap di 4-1500; riwayat leaf menampilkan lama + baru; generik tidak ikut', async () => {
    // Persis seperti tulisan leaf SEBELUM RC-S70.6 (label lama + akun 4-1500).
    const lamaUL = await tambahTransaksiPendapatan({ tanggal: '2026-01-20', accountId: ACC.bunga, nominal: 50_000, jenis: 'KAS', createdBy: 'user-1', kategori: 'Pendapatan Bunga Usaha Lain', keterangan: 'lama UL' });
    const lamaDep = await tambahTransaksiPendapatan({ tanggal: '2026-01-21', accountId: ACC.bunga, nominal: 60_000, jenis: 'KAS', createdBy: 'user-1', kategori: 'Pendapatan Bunga Deposito', keterangan: 'lama DEP' });
    const generik = await tambahTransaksiPendapatan({ tanggal: '2026-01-22', accountId: ACC.bunga, nominal: 7_000, jenis: 'KAS', createdBy: 'user-1' });
    const snapshot = await testDb.getAllAsync(`SELECT id, journal_id, account_id, debit, kredit FROM journal_entry ORDER BY id`);
    const snapshotKas = await testDb.getAllAsync(`SELECT id, akun_lawan_id, kategori, nominal FROM kas_transaksi ORDER BY id`);

    const baruUL = await tambahPendapatanInvestasi(dasarUL);
    const baruDep = await tambahPendapatanInvestasi(dasarDep);

    // Baris lama tidak disentuh.
    const idLama = new Set((snapshot as any[]).map((r) => r.id));
    const sesudah = (await testDb.getAllAsync(`SELECT id, journal_id, account_id, debit, kredit FROM journal_entry ORDER BY id`)).filter((r: any) => idLama.has(r.id));
    expect(sesudah).toEqual(snapshot);
    const idKasLama = new Set((snapshotKas as any[]).map((r) => r.id));
    const kasSesudah = (await testDb.getAllAsync(`SELECT id, akun_lawan_id, kategori, nominal FROM kas_transaksi ORDER BY id`)).filter((r: any) => idKasLama.has(r.id));
    expect(kasSesudah).toEqual(snapshotKas);

    const ul = await listRiwayatPendapatanInvestasi('BUNGA_USAHA_LAIN');
    expect(ul.map((r) => [r.id, r.akunKode]).sort()).toEqual([[baruUL.id, '4-1520'], [lamaUL.id, '4-1500']].sort());
    const dep = await listRiwayatPendapatanInvestasi('BUNGA_DEPOSITO');
    expect(dep.map((r) => [r.id, r.akunKode]).sort()).toEqual([[baruDep.id, '4-1510'], [lamaDep.id, '4-1500']].sort());
    expect([...ul, ...dep].some((r) => r.id === generik.id)).toBe(false);
  });

  it('transaksi lama 4-1500 tetap dapat dikoreksi lewat reversal existing', async () => {
    const lama = await tambahTransaksiPendapatan({ tanggal: '2026-01-20', accountId: ACC.bunga, nominal: 50_000, jenis: 'KAS', createdBy: 'user-1', kategori: 'Pendapatan Bunga Deposito' });
    await koreksiTransaksiPendapatan('KAS', lama.id, 'user-1', 'Koreksi historis eksplisit');
    const saldo = await testDb.getFirstAsync<{ s: number }>(
      `SELECT COALESCE(SUM(kredit),0) - COALESCE(SUM(debit),0) AS s FROM journal_entry WHERE account_id = ?`, ACC.bunga
    );
    expect(saldo?.s).toBe(0);
    const dep = await listRiwayatPendapatanInvestasi('BUNGA_DEPOSITO');
    expect(dep).toHaveLength(1);
    expect(dep[0].status).toBe('DIKOREKSI');
  });
});

// ===========================================================================
// STRUKTURAL — tidak ada jalur tersembunyi ke 4-1500
// ===========================================================================

describe('RC-S70.6 — audit struktural', () => {
  const config = tanpaKomentar(baca('src/config/pendapatanKoperasiPolicy.ts'));
  const svc = baca('src/services/PendapatanLainnyaService.ts');
  const blok = tanpaKomentar(svc.slice(svc.indexOf('RC-S67 — PENDAPATAN INVESTASI BERSUMBER')));
  const menu = tanpaKomentar(baca('src/screens/Transaksi/PendapatanLainnyaMenuScreen.tsx'));

  it("config: '4-1500' hanya muncul sebagai pasangan riwayatHistoris (baca-saja)", () => {
    const baris = config.split('\n').filter((l) => l.includes("'4-1500'"));
    expect(baris.length).toBe(2);
    for (const l of baris) expect(l).toMatch(/riwayatHistoris: \[\{ label: '[^']+', akunKode: '4-1500' \}\]/);
  });

  it('service: tanpa kode akun literal, tanpa fallback `??` pada akunKode, memakai periksaAkunKategoriPendapatanInvestasi', () => {
    expect(blok).not.toMatch(/'[1-5]-\d{3,4}'/);
    expect(blok).not.toMatch(/akunKode\s*\?\?/);
    expect(blok).toContain('periksaAkunKategoriPendapatanInvestasi(');
    expect(blok).toContain("'AKUN_TIDAK_SESUAI'");
  });

  it('menu: judul & akun leaf Usaha Lain / Deposito diturunkan dari kebijakan', () => {
    expect(menu).toContain('title: KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_USAHA_LAIN.label');
    expect(menu).toContain('title: KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_DEPOSITO.label');
    expect(menu).toContain('Kr ${KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_USAHA_LAIN.akunKode} ${KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_USAHA_LAIN.label}');
    expect(menu).toContain('Kr ${KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_DEPOSITO.akunKode} ${KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_DEPOSITO.label}');
    expect(menu).not.toContain('4-1500');
  });

  it('tidak ada migrasi penulisan ulang 4-1500 -> 4-1510/4-1520', () => {
    const db = baca('src/database/db.ts');
    expect(db).not.toMatch(/UPDATE[^;`]*4-15[12]0/);
    expect(db).not.toMatch(/4-1500[^\n]*->[^\n]*4-15[12]0/);
  });

  it('dokumen kebijakan: slot 01-B memuat revisi, teks lama ditandai DEPRECATED, addendum ada', () => {
    const pol = baca('POLICY_DECISION_RC-S53.md');
    expect(pol).toMatch(/### KEPUTUSAN 01-B\s+`USE EXISTING untuk 4-1530 dan 4-1540; AKUN SPESIFIK untuk 4-1510 dan 4-1520 \(revisi RC-S70\.6\)`/);
    expect(pol).toContain('DEPRECATED untuk baris 4-1510 dan 4-1520');
    const add = baca('POLICY_ADDENDUM_RC-S70.6.md');
    expect(add).toContain('KEPUTUSAN 01-B (REVISI RC-S70.6)');
    expect(add).toContain('4-1520');
    expect(add).toContain('4-1510');
  });
});

// ===========================================================================
// REPORT REGRESSION — akun spesifik tercermin di laporan existing (tanpa akun baru)
// ===========================================================================

describe('RC-S70.6 — laporan (DATABASE)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
    // Transaksi historis generik di 4-1500 tetap tampil sebagai "Pendapatan Bunga".
    await tambahTransaksiPendapatan({ tanggal: '2026-01-20', accountId: ACC.bunga, nominal: 40_000, jenis: 'KAS', createdBy: 'user-1' });
    await tambahPendapatanInvestasi(dasarUL); // 350.000 -> 4-1520
    await tambahPendapatanInvestasi(dasarDep); // 125.000 -> 4-1510
  });

  it('Jurnal Umum & Buku Besar: 4-1520 dan 4-1510 masing-masing satu baris kredit sebesar input', async () => {
    const l20 = await getLedger(testDb as any, ACC.investasi, {});
    const l10 = await getLedger(testDb as any, ACC.deposito, {});
    expect(l20.map((x) => [x.debit, x.kredit, x.saldoBerjalan])).toEqual([[0, 350_000, 350_000]]);
    expect(l10.map((x) => [x.debit, x.kredit, x.saldoBerjalan])).toEqual([[0, 125_000, 125_000]]);
    const l00 = await getLedger(testDb as any, ACC.bunga, {});
    expect(l00.map((x) => x.kredit)).toEqual([40_000]);
  });

  it('Neraca Saldo: seimbang; baris 4-1510/4-1520 dengan nama COA', async () => {
    const tb = await getTrialBalance(testDb as any, '2026-12-31');
    expect(tb.isBalanced).toBe(true);
    const row = (k: string) => tb.rows.find((r) => r.kode === k);
    expect(row('4-1520')).toMatchObject({ nama: 'Pendapatan Bunga Investasi', kredit: 350_000 });
    expect(row('4-1510')).toMatchObject({ nama: 'Pendapatan Bunga Deposito', kredit: 125_000 });
    expect(row('4-1500')).toMatchObject({ nama: 'Pendapatan Bunga', kredit: 40_000 });
  });

  it('Laba Rugi & LHU: masing-masing di baris sendiri dalam HASIL INVESTASI; total tidak berubah', async () => {
    const lr = await getLabaRugi(testDb as any, '2026-01-01', '2026-12-31');
    expect(lr.pendapatan.find((r) => r.kode === '4-1520')).toEqual({ kode: '4-1520', nama: 'Pendapatan Bunga Investasi', jumlah: 350_000 });
    expect(lr.pendapatan.find((r) => r.kode === '4-1510')).toEqual({ kode: '4-1510', nama: 'Pendapatan Bunga Deposito', jumlah: 125_000 });
    expect(lr.totalPendapatan).toBe(515_000);
    const lhu = await getLHU(testDb as any, '2026-01-01', '2026-12-31');
    const hi = lhu.hasilInvestasi.map((r) => [r.kode, r.nama, r.jumlah]);
    expect(hi).toContainEqual(['4-1520', 'Pendapatan Bunga Investasi', 350_000]);
    expect(hi).toContainEqual(['4-1510', 'Pendapatan Bunga Deposito', 125_000]);
    expect(hi).toContainEqual(['4-1500', 'Pendapatan Bunga', 40_000]);
    expect(lhu.totalHasilInvestasi).toBe(515_000);
  });

  it('Laporan Pendapatan (per klasifikasi): 4-1510/4-1520 di Hasil Investasi', async () => {
    const r = await getPendapatanByClassification('2026-01-01', '2026-12-31');
    const hi = r.hasilInvestasi.map((x) => [x.kode, x.nama, x.nominal]);
    expect(hi).toContainEqual(['4-1520', 'Pendapatan Bunga Investasi', 350_000]);
    expect(hi).toContainEqual(['4-1510', 'Pendapatan Bunga Deposito', 125_000]);
  });
});

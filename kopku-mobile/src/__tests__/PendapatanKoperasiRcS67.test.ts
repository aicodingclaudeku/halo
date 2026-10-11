import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * RC-S67 — PENDAPATAN KOPERASI (menu canonical + leaf pendapatan investasi).
 *
 * Bagian DATABASE memakai SQLite sungguhan (skema produksi) dan
 * AccountingEngine asli. Bagian STRUKTURAL membaca source untuk mengunci
 * sifat yang tidak dapat dibuktikan lewat pemanggilan fungsi (hierarki
 * menu, rute, tidak ada jalur akuntansi kedua).
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
  listTransaksiPendapatan,
  PendapatanInvestasiDitolakError,
} from '@/services/PendapatanLainnyaService';
import { KEBIJAKAN_PENDAPATAN_INVESTASI, SEMUA_KATEGORI_PENDAPATAN_INVESTASI } from '@/config/pendapatanKoperasiPolicy';
import { DEFAULT_ACCOUNTS } from '@/config/defaultCOA';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const ACC = {
  kas: 'acc-kas',
  bankBca: 'acc-bank-bca',
  bunga: 'acc-4-1500',
  // RC-S70.6 — akun spesifik kategori bunga.
  bungaDeposito: 'acc-4-1510',
  bungaInvestasi: 'acc-4-1520',
  sewa: 'acc-4-1600',
  lain: 'acc-4-2000',
};

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  nb: 'DEBIT' | 'KREDIT',
  opts: { isSystem?: boolean; isActive?: boolean; lhu?: string | null } = {}
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, kode, nama, kategori, nb, opts.isActive === false ? 0 : 1, opts.isSystem ? 1 : 0, opts.lhu ?? null, now, now
  );
}

async function seedInvestasi(
  db: TestDb,
  id: string,
  nomor: string,
  jenis: string,
  nama: string,
  opts: { tanggal?: string; status?: string } = {}
) {
  await db.runAsync(
    `INSERT INTO investasi (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal, sumber_dana, created_by, created_at, status)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, nomor, jenis, nama, 50_000_000, opts.tanggal ?? '2026-01-02', 'KAS', 'user-1', new Date().toISOString(), opts.status ?? 'AKTIF'
  );
}

async function setupFixture(opts: { tanpaSewa?: boolean; bungaNonaktif?: boolean } = {}): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT', { isSystem: true });
  await seedAccount(db, ACC.bankBca, '1-1100', 'Bank BCA', 'ASET', 'DEBIT', { isSystem: true });
  // RC-S70.6 — 4-1500 tetap ada (akun historis/generik) tetapi bukan target
  // kategori bunga. `bungaNonaktif` kini menonaktifkan akun Deposito 4-1510.
  await seedAccount(db, ACC.bunga, '4-1500', 'Pendapatan Bunga', 'PENDAPATAN', 'KREDIT', { lhu: 'HASIL_INVESTASI' });
  await seedAccount(db, ACC.bungaDeposito, '4-1510', 'Pendapatan Bunga Deposito', 'PENDAPATAN', 'KREDIT', {
    lhu: 'HASIL_INVESTASI',
    isActive: !opts.bungaNonaktif,
  });
  await seedAccount(db, ACC.bungaInvestasi, '4-1520', 'Pendapatan Bunga Investasi', 'PENDAPATAN', 'KREDIT', { lhu: 'HASIL_INVESTASI' });
  if (!opts.tanpaSewa) {
    await seedAccount(db, ACC.sewa, '4-1600', 'Pendapatan Sewa', 'PENDAPATAN', 'KREDIT', { lhu: 'HASIL_INVESTASI' });
  }
  await seedAccount(db, ACC.lain, '4-2000', 'Pendapatan Usaha Lain', 'PENDAPATAN', 'KREDIT', { lhu: 'PENDAPATAN_USAHA_LAIN' });
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-kas','KAS_UMUM','DEFAULT',?)`,
    ACC.kas
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p-2025',2025,'2025-01-01','2025-12-31','CLOSED')`
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p-2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
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
  await seedInvestasi(db, 'inv-prop', 'INV-2026-000003', 'PROPERTI_INVESTASI', 'Ruko Jl. Contoh');
  await seedInvestasi(db, 'inv-kl', 'INV-2026-000004', 'KOPERASI_LAIN', 'Koperasi Mitra');
  await seedInvestasi(db, 'inv-batal', 'INV-2026-000005', 'DEPOSITO_BANK_UMUM', 'Deposito Dibatalkan', { status: 'DIBATALKAN' });
  await seedInvestasi(db, 'inv-baru', 'INV-2026-000006', 'DEPOSITO_BANK_UMUM', 'Deposito Baru', { tanggal: '2026-03-01' });
  return db;
}

async function hitung(sql: string, ...p: unknown[]): Promise<number> {
  const r = await testDb.getFirstAsync<{ n: number }>(sql, ...(p as any[]));
  return r?.n ?? 0;
}

async function jurnalSeimbang(journalId: string) {
  const r = await testDb.getFirstAsync<{ d: number; k: number; baris: number }>(
    `SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(kredit),0) AS k, COUNT(*) AS baris FROM journal_entry WHERE journal_id = ?`,
    journalId
  );
  return r!;
}

const dasar = {
  kategori: 'BUNGA_DEPOSITO' as const,
  investasiId: 'inv-dep',
  tanggal: '2026-02-10',
  nominal: 125_000,
  jenis: 'KAS' as const,
  createdBy: 'user-1',
};

describe('RC-S67 — kebijakan akun (config) sesuai keputusan terkunci', () => {
  // DIPERBARUI RC-S70.6 (instruksi eksplisit pengguna): semula keduanya 4-1500
  // (KEPUTUSAN 01-B asli). Kini akun spesifik.
  it('bunga Usaha Lain -> 4-1520, bunga Deposito -> 4-1510, sewa -> 4-1600', () => {
    expect(KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_USAHA_LAIN.akunKode).toBe('4-1520');
    expect(KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_DEPOSITO.akunKode).toBe('4-1510');
    expect(KEBIJAKAN_PENDAPATAN_INVESTASI.SEWA_PROPERTI.akunKode).toBe('4-1600');
  });

  it('keputusan yang dikutip memang tertulis di POLICY_DECISION_RC-S53.md', () => {
    const pol = baca('POLICY_DECISION_RC-S53.md');
    // DIPERBARUI RC-S70.6: slot 01-B memuat revisi akun spesifik; teks asli
    // RC-S53 tetap tersimpan tetapi ditandai DEPRECATED.
    expect(pol).toMatch(/### KEPUTUSAN 01-B\s+`USE EXISTING untuk 4-1530 dan 4-1540; AKUN SPESIFIK untuk 4-1510 dan 4-1520 \(revisi RC-S70\.6\)`/);
    expect(pol).toContain('DEPRECATED untuk baris 4-1510 dan 4-1520');
    expect(pol).toContain('`1-1250` berpasangan dengan `4-1600` Pendapatan Sewa');
    // RC-S67.6.1: slot 04-B diperbarui menjadi CASH-BASIS AKTIF (rincian di
    // POLICY_ADDENDUM_RC-S67.6.md); KEPUTUSAN 06 (akrual nonaktif) TETAP.
    expect(pol).toMatch(/### KEPUTUSAN 04-B\s+`CASH-BASIS AKTIF`/);
    expect(pol).not.toMatch(/### KEPUTUSAN 04-B\s+`DISABLED`/);
    expect(pol).toMatch(/### KEPUTUSAN 06\s+`ACCRUAL = DISABLED`/);
    const add = baca('POLICY_ADDENDUM_RC-S67.6.md');
    expect(add).toContain('KEPUTUSAN 04-B (REVISI RC-S67.6)');
    expect(add).toContain('`CASH-BASIS AKTIF`');
    expect(add).toContain('KEPUTUSAN 06 TIDAK BERUBAH');
  });

  it('akun kebijakan ada di DEFAULT_ACCOUNTS: PENDAPATAN, KREDIT, non-sistem, HASIL_INVESTASI', () => {
    for (const k of SEMUA_KATEGORI_PENDAPATAN_INVESTASI) {
      const kode = KEBIJAKAN_PENDAPATAN_INVESTASI[k].akunKode;
      const a = DEFAULT_ACCOUNTS.find((x) => x.kode === kode);
      expect(a).toBeDefined();
      expect(a!.kategori).toBe('PENDAPATAN');
      expect(a!.normalBalance).toBe('KREDIT');
      expect(a!.isSystem).toBe(false);
      expect(a!.lhuKlasifikasi).toBe('HASIL_INVESTASI');
    }
  });

  it('jenis investasi sumber per kategori', () => {
    expect(KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_USAHA_LAIN.jenisInvestasi).toBe('USAHA_LAIN');
    expect(KEBIJAKAN_PENDAPATAN_INVESTASI.BUNGA_DEPOSITO.jenisInvestasi).toBe('DEPOSITO_BANK_UMUM');
    expect(KEBIJAKAN_PENDAPATAN_INVESTASI.SEWA_PROPERTI.jenisInvestasi).toBe('PROPERTI_INVESTASI');
  });
});

describe('RC-S67 — tambahPendapatanInvestasi (DATABASE)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  // DIPERBARUI RC-S70.6: Cr 4-1510 (semula 4-1500).
  it('deposito via Kas: Dr Kas / Cr 4-1510, balance, satu jurnal POSTED, referensi sumber dari master', async () => {
    const r = await tambahPendapatanInvestasi({ ...dasar, keterangan: 'Bukti BK-01' });
    expect(r.akunKode).toBe('4-1510');
    const s = await jurnalSeimbang(r.journalId);
    expect(s.d).toBe(125_000);
    expect(s.k).toBe(125_000);
    expect(s.baris).toBe(2);
    const dr = await testDb.getFirstAsync<{ account_id: string }>(`SELECT account_id FROM journal_entry WHERE journal_id = ? AND debit > 0`, r.journalId);
    const cr = await testDb.getFirstAsync<{ account_id: string }>(`SELECT account_id FROM journal_entry WHERE journal_id = ? AND kredit > 0`, r.journalId);
    expect(dr?.account_id).toBe(ACC.kas);
    expect(cr?.account_id).toBe(ACC.bungaDeposito);
    const j = await testDb.getFirstAsync<{ status: string; sumber_transaksi: string; deskripsi: string }>(
      `SELECT status, sumber_transaksi, deskripsi FROM journal WHERE id = ?`, r.journalId
    );
    expect(j?.status).toBe('POSTED');
    expect(j?.sumber_transaksi).toBe('KAS_PENERIMAAN_LAIN');
    expect(j?.deskripsi).toContain('INV-2026-000001');
    expect(j?.deskripsi).toContain('Deposito Bank Contoh');
    expect(j?.deskripsi).toContain('Bukti BK-01');
    const row = await testDb.getFirstAsync<{ kategori: string; akun_lawan_id: string; tipe: string }>(
      `SELECT kategori, akun_lawan_id, tipe FROM kas_transaksi WHERE id = ?`, r.id
    );
    expect(row?.kategori).toBe('Pendapatan Bunga Deposito');
    expect(row?.akun_lawan_id).toBe(ACC.bungaDeposito);
    expect(row?.tipe).toBe('PENERIMAAN');
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(1);
  });

  // DIPERBARUI RC-S70.6: usaha lain Cr 4-1520 (semula 4-1500).
  it('usaha lain -> 4-1520; sewa properti via Bank -> Dr Bank / Cr 4-1600', async () => {
    const a = await tambahPendapatanInvestasi({ ...dasar, kategori: 'BUNGA_USAHA_LAIN', investasiId: 'inv-ul' });
    expect(a.akunKode).toBe('4-1520');
    const b = await tambahPendapatanInvestasi({
      ...dasar, kategori: 'SEWA_PROPERTI', investasiId: 'inv-prop', jenis: 'BANK', bankAccountId: 'bank-1', nominal: 3_000_000,
    });
    expect(b.akunKode).toBe('4-1600');
    const dr = await testDb.getFirstAsync<{ account_id: string; debit: number }>(`SELECT account_id, debit FROM journal_entry WHERE journal_id = ? AND debit > 0`, b.journalId);
    const cr = await testDb.getFirstAsync<{ account_id: string; kredit: number }>(`SELECT account_id, kredit FROM journal_entry WHERE journal_id = ? AND kredit > 0`, b.journalId);
    expect(dr?.account_id).toBe(ACC.bankBca);
    expect(cr?.account_id).toBe(ACC.sewa);
    expect(dr?.debit).toBe(cr?.kredit);
    expect(await hitung(`SELECT COUNT(*) AS n FROM bank_transaksi WHERE id = ?`, b.id)).toBe(1);
  });

  it('SUM(debit) = SUM(kredit) untuk SELURUH jurnal setelah beberapa transaksi', async () => {
    await tambahPendapatanInvestasi(dasar);
    await tambahPendapatanInvestasi({ ...dasar, kategori: 'SEWA_PROPERTI', investasiId: 'inv-prop', nominal: 777_777 });
    await tambahPendapatanInvestasi({ ...dasar, kategori: 'BUNGA_USAHA_LAIN', investasiId: 'inv-ul', nominal: 1 });
    const r = await testDb.getFirstAsync<{ d: number; k: number }>(`SELECT SUM(debit) AS d, SUM(kredit) AS k FROM journal_entry`);
    expect(r?.d).toBe(r?.k);
    expect(r?.d).toBe(125_000 + 777_777 + 1);
  });

  const tolak = async (patch: Record<string, unknown>, kode: string) => {
    let err: unknown;
    try {
      await tambahPendapatanInvestasi({ ...dasar, ...patch } as any);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PendapatanInvestasiDitolakError);
    expect((err as PendapatanInvestasiDitolakError).kode).toBe(kode);
    // Penolakan TIDAK meninggalkan tulisan apa pun.
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(0);
    expect(await hitung(`SELECT COUNT(*) AS n FROM kas_transaksi`)).toBe(0);
    expect(await hitung(`SELECT COUNT(*) AS n FROM bank_transaksi`)).toBe(0);
  };

  // RC-S67.6: IMBAL_HASIL_TETAP kini kategori sah; uji kategori yang memang tidak ada.
  it('kategori tidak dikenal ditolak', () => tolak({ kategori: 'KATEGORI_KARANGAN' }, 'KATEGORI_TIDAK_DIKENAL'));
  it('nominal 0 ditolak', () => tolak({ nominal: 0 }, 'NOMINAL_TIDAK_VALID'));
  it('nominal negatif ditolak', () => tolak({ nominal: -5 }, 'NOMINAL_TIDAK_VALID'));
  it('nominal pecahan ditolak', () => tolak({ nominal: 10.5 }, 'NOMINAL_TIDAK_VALID'));
  it('tanggal salah format ditolak', () => tolak({ tanggal: '10/02/2026' }, 'TANGGAL_TIDAK_VALID'));
  it('tanggal tidak ada di kalender ditolak', () => tolak({ tanggal: '2026-02-30' }, 'TANGGAL_TIDAK_VALID'));
  it('tanggal masa depan ditolak', () => tolak({ tanggal: '2999-01-01' }, 'TANGGAL_MASA_DEPAN'));
  it('investasi kosong ditolak', () => tolak({ investasiId: '' }, 'INVESTASI_WAJIB'));
  it('investasi tidak ada ditolak', () => tolak({ investasiId: 'tidak-ada' }, 'INVESTASI_TIDAK_DITEMUKAN'));
  it('jenis investasi tidak cocok (properti untuk bunga deposito) ditolak', () =>
    tolak({ investasiId: 'inv-prop' }, 'JENIS_INVESTASI_TIDAK_SESUAI'));
  it('penyertaan koperasi lain tidak dapat dipakai untuk sewa', () =>
    tolak({ kategori: 'SEWA_PROPERTI', investasiId: 'inv-kl' }, 'JENIS_INVESTASI_TIDAK_SESUAI'));
  it('investasi DIBATALKAN ditolak', () => tolak({ investasiId: 'inv-batal' }, 'INVESTASI_TIDAK_AKTIF'));
  it('tanggal sebelum tanggal investasi ditolak', () => tolak({ investasiId: 'inv-baru', tanggal: '2026-02-01' }, 'TANGGAL_SEBELUM_INVESTASI'));
  it('BANK tanpa rekening ditolak', () => tolak({ jenis: 'BANK' }, 'REKENING_WAJIB'));

  it('idempotensi: submit ulang dengan kunci sama -> SATU jurnal, SATU baris, hasil identik', async () => {
    const a = await tambahPendapatanInvestasi({ ...dasar, idempotencyKey: 'submit-abc' });
    const b = await tambahPendapatanInvestasi({ ...dasar, idempotencyKey: 'submit-abc' });
    expect(b.id).toBe(a.id);
    expect(b.journalId).toBe(a.journalId);
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(1);
    expect(await hitung(`SELECT COUNT(*) AS n FROM kas_transaksi`)).toBe(1);
  });

  it('dua submit SAH dengan kunci berbeda tetap dua transaksi (tidak ada deduplikasi berbasis isi)', async () => {
    await tambahPendapatanInvestasi({ ...dasar, idempotencyKey: 'k1' });
    await tambahPendapatanInvestasi({ ...dasar, idempotencyKey: 'k2' });
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(2);
  });

  it('periode CLOSED ditolak (ClosedPeriodError) tanpa tulisan parsial', async () => {
    await testDb.runAsync(`UPDATE investasi SET tanggal = '2025-01-01' WHERE id = 'inv-dep'`);
    let err: any;
    try {
      await tambahPendapatanInvestasi({ ...dasar, tanggal: '2025-06-30' });
    } catch (e) {
      err = e;
    }
    expect(err?.name).toBe('ClosedPeriodError');
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(0);
    expect(await hitung(`SELECT COUNT(*) AS n FROM kas_transaksi`)).toBe(0);
  });

  it('audit trail: createJournal menulis audit untuk jurnal baru', async () => {
    const r = await tambahPendapatanInvestasi(dasar);
    expect(await hitung(`SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'journal' AND entity_id = ?`, r.journalId)).toBeGreaterThan(0);
  });

  // DIPERBARUI RC-S70.6: akun deposito kini 4-1510 (semula 4-1500).
  it('reversal existing: jurnal dibalik (tidak dihapus), saldo 4-1510 kembali 0, riwayat DIKOREKSI, audit REVERSE', async () => {
    const r = await tambahPendapatanInvestasi(dasar);
    await koreksiTransaksiPendapatan('KAS', r.id, 'user-1', 'Salah input');
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal WHERE id = ?`, r.journalId)).toBe(1);
    const j = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM journal WHERE id = ?`, r.journalId);
    expect(j?.status).toBe('REVERSED');
    const saldo = await testDb.getFirstAsync<{ s: number }>(
      `SELECT COALESCE(SUM(kredit),0) - COALESCE(SUM(debit),0) AS s FROM journal_entry WHERE account_id = ?`, ACC.bungaDeposito
    );
    expect(saldo?.s).toBe(0);
    const riw = await listRiwayatPendapatanInvestasi('BUNGA_DEPOSITO');
    expect(riw).toHaveLength(1);
    expect(riw[0].status).toBe('DIKOREKSI');
    expect(await hitung(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'REVERSE' AND entity_id = ?`, r.id)).toBe(1);
    const semua = await testDb.getFirstAsync<{ d: number; k: number }>(`SELECT SUM(debit) AS d, SUM(kredit) AS k FROM journal_entry`);
    expect(semua?.d).toBe(semua?.k);
  });

  // DIPERBARUI RC-S70.6: judul (akun kini berbeda: 4-1510 / 4-1520); generik tetap di 4-1500.
  it('riwayat per leaf: deposito (4-1510), usaha lain (4-1520) dan transaksi generik 4-1500 saling terpisah', async () => {
    await tambahPendapatanInvestasi(dasar);
    await tambahPendapatanInvestasi({ ...dasar, kategori: 'BUNGA_USAHA_LAIN', investasiId: 'inv-ul' });
    await tambahTransaksiPendapatan({ tanggal: '2026-02-11', accountId: ACC.bunga, nominal: 9_000, jenis: 'KAS', createdBy: 'user-1' });
    const dep = await listRiwayatPendapatanInvestasi('BUNGA_DEPOSITO');
    const ul = await listRiwayatPendapatanInvestasi('BUNGA_USAHA_LAIN');
    expect(dep).toHaveLength(1);
    expect(ul).toHaveLength(1);
    expect(dep[0].keterangan).toContain('INV-2026-000001');
    expect(ul[0].keterangan).toContain('INV-2026-000002');
    // Transaksi generik tetap terlihat di riwayat umum, kategori NULL.
    const umum = await listTransaksiPendapatan();
    expect(umum).toHaveLength(3);
    expect(umum.filter((x) => x.kategori === null)).toHaveLength(1);
  });

  it('tidak mengubah data investasi sumber', async () => {
    const sebelum = await testDb.getFirstAsync(`SELECT * FROM investasi WHERE id = 'inv-dep'`);
    await tambahPendapatanInvestasi(dasar);
    const sesudah = await testDb.getFirstAsync(`SELECT * FROM investasi WHERE id = 'inv-dep'`);
    expect(sesudah).toEqual(sebelum);
  });

  it('jalur generik lama tidak berubah: tanpa kategori/idempotencyKey -> kategori NULL, key NULL', async () => {
    const r = await tambahTransaksiPendapatan({ tanggal: '2026-02-11', accountId: ACC.lain, nominal: 5_000, jenis: 'KAS', createdBy: 'user-1' });
    const row = await testDb.getFirstAsync<{ kategori: string | null; idempotency_key: string | null }>(
      `SELECT kategori, idempotency_key FROM kas_transaksi WHERE id = ?`, r.id
    );
    expect(row?.kategori).toBeNull();
    expect(row?.idempotency_key).toBeNull();
  });
});

describe('RC-S67 — COA MISSING / akun tidak dapat dipakai', () => {
  it('akun 4-1600 tidak ada -> info.masalah, penerimaan sewa ditolak COA_MISSING, akun TIDAK dibuat otomatis', async () => {
    testDb = await setupFixture({ tanpaSewa: true });
    const info = await getInfoPendapatanInvestasi('SEWA_PROPERTI');
    expect(info.akun).toBeNull();
    expect(info.masalah).toContain('4-1600');
    let err: any;
    try {
      await tambahPendapatanInvestasi({ ...dasar, kategori: 'SEWA_PROPERTI', investasiId: 'inv-prop' });
    } catch (e) {
      err = e;
    }
    expect(err?.kode).toBe('COA_MISSING');
    expect(await hitung(`SELECT COUNT(*) AS n FROM account WHERE kode = '4-1600'`)).toBe(0);
    expect(await hitung(`SELECT COUNT(*) AS n FROM journal`)).toBe(0);
  });

  // DIPERBARUI RC-S70.6: akun Deposito kini 4-1510 (semula 4-1500).
  it('akun 4-1510 nonaktif -> ditolak COA_MISSING', async () => {
    testDb = await setupFixture({ bungaNonaktif: true });
    const info = await getInfoPendapatanInvestasi('BUNGA_DEPOSITO');
    expect(info.akun).toBeNull();
    expect(info.masalah).toContain('dinonaktifkan');
    let err: any;
    try {
      await tambahPendapatanInvestasi(dasar);
    } catch (e) {
      err = e;
    }
    expect(err?.kode).toBe('COA_MISSING');
  });

  it('akun tersedia -> info.akun terisi dengan klasifikasi LHU', async () => {
    testDb = await setupFixture();
    const info = await getInfoPendapatanInvestasi('BUNGA_DEPOSITO');
    expect(info.masalah).toBeNull();
    expect(info.akun?.kode).toBe('4-1510');
    expect(info.akun?.klasifikasiLhu).toBe('HASIL_INVESTASI');
  });
});

describe('RC-S67 — satu jalur akuntansi canonical (struktural)', () => {
  const svc = baca('src/services/PendapatanLainnyaService.ts');
  const blok = tanpaKomentar(svc.slice(svc.indexOf('RC-S67 — PENDAPATAN INVESTASI BERSUMBER')));

  it('blok RC-S67 tidak membuat jurnal/INSERT sendiri — mendelegasikan ke tambahTransaksiPendapatan', () => {
    expect(blok).not.toMatch(/createJournal|INSERT|UPDATE |DELETE /);
    expect(blok).toContain('await tambahTransaksiPendapatan(');
  });

  it('blok RC-S67 tidak menyentuh RAK / unit usaha / tabel investasi (hanya SELECT)', () => {
    expect(blok).not.toMatch(/rak_transaksi|unit_usaha|RAKService/);
    expect(blok).toMatch(/SELECT id, nomor_investasi, nama_tujuan, jenis_investasi, status, tanggal FROM investasi WHERE id = \?/);
  });

  it('service tidak menulis kode akun literal — kode dari config kebijakan', () => {
    expect(blok).not.toMatch(/'[1-5]-\d{3,4}'/);
  });
});

describe('RC-S67 — menu canonical Pendapatan Koperasi (struktural)', () => {
  const menu = tanpaKomentar(baca('src/screens/Transaksi/PendapatanLainnyaMenuScreen.tsx'));
  const nav = baca('src/navigation/RootNavigator.tsx');
  const hub = tanpaKomentar(baca('src/screens/Transaksi/TransaksiPenerimaanScreen.tsx'));

  it('hierarki A–D urut sesuai target', () => {
    const urut = ["judul: 'Pendapatan Investasi'", "judul: 'Penyertaan pada Koperasi Lain'", "title: 'Bagian SHU'", "title: 'Imbal Hasil Tetap'",
      "judul: 'Usaha Lain'", "judul: 'Deposito Berjangka'", "judul: 'Properti Investasi'", "title: 'Pendapatan Sewa'",
      // RC-S70.3: bagian B semula "Pendapatan RAKU" (pengembalian RAK, Cr 1-1800 —
      // salah nomenklatur). Kini bagian B = Pendapatan Unit Usaha sungguhan (Cr 4-1400).
      "judul: 'Pendapatan Unit Usaha'", "title: 'Pendapatan Unit Usaha'", "judul: 'Penjualan / Pelepasan Aset'", "judul: 'Pendapatan Lainnya'"];
    let pos = -1;
    for (const u of urut) {
      const i = menu.indexOf(u, pos + 1);
      expect(i).toBeGreaterThan(pos);
      pos = i;
    }
  });

  it('leaf aktif menunjuk rute terdaftar; tiga kategori investasi masing-masing tepat sekali', () => {
    expect(menu).toContain("aksi: { route: 'BagianShuForm' }");
    for (const k of ['IMBAL_HASIL_TETAP', 'BUNGA_USAHA_LAIN', 'BUNGA_DEPOSITO', 'SEWA_PROPERTI']) {
      const re = new RegExp(`aksi: \\{ route: 'PendapatanInvestasiForm', params: \\{ kategori: '${k}' \\} \\}`, 'g');
      expect((menu.match(re) ?? []).length).toBe(1);
    }
    // RC-S67.7: leaf C membuka FORM TRANSAKSI pelepasan, bukan master Daftar Aset.
    expect(menu).toContain("aksi: { route: 'PelepasanAsetForm' }");
    expect(menu).not.toContain("screen: 'DaftarAsetTetap'");
    expect(menu).toContain("aksi: { route: 'PendapatanLainnyaForm' }");
    expect(nav).toMatch(/<LaporanStack\.Screen name="DaftarAsetTetap"/);
  });

  // RC-S67.6: Imbal Hasil Tetap AKTIF (cash-basis, instruksi eksplisit
  // pengguna RC-S67.6); tidak ada lagi leaf nonaktif di menu.
  it('Imbal Hasil Tetap AKTIF — menuju PendapatanInvestasiForm, tanpa nonaktif', () => {
    const i = menu.indexOf("title: 'Imbal Hasil Tetap'");
    const blokLeaf = menu.slice(i, menu.indexOf('},', menu.indexOf('aksi:', i)) + 2);
    expect(blokLeaf).toContain("aksi: { route: 'PendapatanInvestasiForm', params: { kategori: 'IMBAL_HASIL_TETAP' } }");
    expect(menu).not.toMatch(/nonaktif: \{ badge/);
  });

  // RC-S70.3 — ekspektasi RC-S67.4.2 ("Pendapatan Unit Usaha" -> PengembalianRAKForm)
  // DIGANTI atas instruksi eksplisit pengguna: itulah salah nomenklatur yang
  // diperbaiki. Pengembalian RAKU bukan pendapatan; kini di Penerimaan > RAKU.
  it('Pendapatan Unit Usaha menuju PendapatanUnitUsahaForm, BUKAN PengembalianRAKForm (RC-S70.3)', () => {
    const i = menu.indexOf("title: 'Pendapatan Unit Usaha'");
    const blokLeaf = menu.slice(i, menu.indexOf('},', menu.indexOf('aksi:', i)) + 1);
    expect(blokLeaf).toContain("aksi: { route: 'PendapatanUnitUsahaForm' }");
    expect(blokLeaf).not.toContain('PengembalianRAKForm');
    expect(blokLeaf).not.toContain('nonaktif:');
    expect(menu).not.toContain('PengembalianRAKForm');
    expect(menu).not.toContain("judul: 'Pendapatan RAKU'");
  });

  it('rute PendapatanInvestasiForm terdaftar tepat sekali, di TransaksiStack', () => {
    expect((nav.match(/name="PendapatanInvestasiForm"/g) ?? []).length).toBe(1);
    expect(nav).toMatch(/<TransaksiStack\.Screen name="PendapatanInvestasiForm" component=\{PendapatanInvestasiFormScreen\}/);
  });

  it('hanya SATU titik masuk bernama "Pendapatan Koperasi"', () => {
    expect((hub.match(/title: 'Pendapatan Koperasi'/g) ?? []).length).toBe(1);
    expect(hub).toMatch(/nav\.navigate\('PendapatanLainnyaMenu'\)/);
    expect((nav.match(/title: 'Pendapatan Koperasi'/g) ?? []).length).toBe(1);
  });

  it('Bagian SHU tidak diduplikasi: satu screen, satu registrasi rute', () => {
    expect((nav.match(/name="BagianShuForm"/g) ?? []).length).toBe(1);
  });
});

describe('RC-S67 — layar PendapatanInvestasiForm (struktural)', () => {
  const src = tanpaKomentar(baca('src/screens/Transaksi/PendapatanInvestasiFormScreen.tsx'));

  it('tidak menulis database langsung; memakai service', () => {
    expect(src).not.toMatch(/INSERT|UPDATE |DELETE |getDb|runAsync/);
    expect(src).toContain('tambahPendapatanInvestasi(');
  });

  it('kunci submit sinkron + idempotencyKey per submit', () => {
    expect(src).toContain('sedangMengirim = useRef(false)');
    expect(src).toMatch(/if \(sedangMengirim\.current\) return;/);
    expect(src).toContain('idempotencyKey: kunciSubmit.current');
  });

  it('sumber dipilih lewat InvestasiPicker yang difilter jenis; tidak ada pilihan akun bebas', () => {
    expect(src).toContain('<InvestasiPicker');
    expect(src).toContain('onlyJenisInvestasi=');
    expect(src).not.toMatch(/AccountPicker|AkunPendapatanSelect|listAkunPendapatanLainnya/);
  });

  it('keadaan loading, error, empty tersedia; galat teknis tidak diteruskan ke operator', () => {
    expect(src).toContain('<ActivityIndicator');
    expect(src).toContain('Data belum dapat dimuat');
    expect(src).toContain('Belum ada transaksi pendapatan.');
    expect(src).toMatch(/sqlite\|constraint\|typeerror\|undefined/);
  });
});

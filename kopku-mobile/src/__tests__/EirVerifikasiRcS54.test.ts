import { createTestDb, TestDb } from './testDb';

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

import { ajukanPinjaman, cairkanPinjaman, bayarAngsuran, getJadwalAngsuran } from '@/services/PinjamanService';
import { getEirTersimpan, prosesEirBulanan } from '@/services/EirAccountingService';
import { hitungInvarianFeeEir } from '@/accounting/EirFeeInvariant';
import { getDb } from '@/database/db';
import {
  solveEffectiveInterestRate,
  faktorPeriodeDariRateTahunan,
  EirSolverError,
  EirCashFlow,
} from '@/accounting/EffectiveInterestRateService';

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, normalBalance: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    now,
    now
  );
}
async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `map-${transactionType}-${role}`, transactionType, role, accountId);
}

const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanDenda: 'acc-pendapatan-denda',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  // FIXTURE FIX: akun Pendapatan Administrasi (4-1100) memang ADA di COA
  // produksi & dipakai cairkanPinjaman untuk fee SEPARATE_SERVICE —
  // fixture ini yang belum menyeed-nya, bukan produksi yang salah.
  pendapatanAdmin: 'acc-pendapatan-admin',
  modal: 'acc-modal',
};
const ANGGOTA_ID = 'anggota-1';

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(db, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(db, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(db, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(db, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(db, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(db, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(db, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(db, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  // FINAL FIX AKRUAL (BUG 4/5/7): jasa yang kasnya diterima SEBELUM jatuh tempo
  // -> Pendapatan Diterima Dimuka (2-1300 existing), dilepas saat periode jatuh tempo.
  await seedMapping(db, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID,
    'A001',
    '1234567890123456',
    'Budi',
    '2020-01-01',
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal','POSTED','user-1',?,?,?)`,
    now,
    now,
    now
  );
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-modal-debit', 'journal-modal-awal', ACC.kas, 50_000_000);
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-modal-kredit', 'journal-modal-awal', ACC.modal, 50_000_000);
  await db.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sp-fixture',?,'POKOK','SETOR','2020-01-01',100000,'KAS','SP-FIXTURE','user-1',?)`,
    ANGGOTA_ID,
    now
  );
  await db.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sw-fixture',?,'WAJIB','SETOR','2020-01-01',50000,'KAS','SW-FIXTURE','user-1',?)`,
    ANGGOTA_ID,
    now
  );
  return db;
}

/**
 * RC-S54 TAHAP 8 — ITEM #12 — VERIFIKASI EIR PINJAMAN
 * =========================================================================
 *
 * Seluruh assertion di berkas ini adalah INVARIAN yang tetap berlaku
 * apa pun keputusan kebijakan basis amortisasi (lihat RC-S54_TAHAP_8.md):
 * NPV(EIR) = 0, satuan rate, day count, jurnal seimbang, idempotensi,
 * Σ amortisasi = fee, invarian fee, derecognition.
 *
 * Nilai ekspektasi solver TIDAK diambil dari implementasi: akarnya
 * DIKONSTRUKSI lebih dulu (rate dipilih, arus kas diturunkan secara
 * analitik), lalu NPV diverifikasi ulang dengan `Math.pow` independen —
 * bukan dengan fungsi `npv()` milik service.
 */

const TOL_NPV = 0.5; // sama dengan toleransi solver: setengah rupiah

/** NPV independen, Actual/365, dihitung ulang di test. */
function npvIndependen(rate: number, cfs: readonly EirCashFlow[]): number {
  return cfs.reduce((t, cf) => t + cf.jumlah / Math.pow(1 + rate, cf.hari / 365), 0);
}

function hariAntara(a: string, b: string): number {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) -
    Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000);
}

// ===========================================================================
// SOLVER — known examples (akar dikonstruksi, bukan dibaca dari service)
// ===========================================================================

describe('SOLVER — contoh yang dapat dihitung manual', () => {
  it('satu pelunasan 365 hari: 1.000.000 -> 1.100.000 => EIR tepat 10%/tahun', () => {
    const cfs: EirCashFlow[] = [{ hari: 0, jumlah: -1_000_000 }, { hari: 365, jumlah: 1_100_000 }];
    const h = solveEffectiveInterestRate(cfs);
    expect(Math.abs(h.rateTahunan - 0.1)).toBeLessThan(1e-6);
    expect(Math.abs(npvIndependen(h.rateTahunan, cfs))).toBeLessThan(TOL_NPV);
  });

  it('tanggal TIDAK seragam, akar 18% dikonstruksi analitik', () => {
    const r = 0.18;
    const masuk = [
      { hari: 31, jumlah: 300_000 },
      { hari: 90, jumlah: 300_000 },
      { hari: 200, jumlah: 300_000 },
      { hari: 366, jumlah: 300_000 },
    ];
    const pv = masuk.reduce((t, c) => t + c.jumlah / Math.pow(1 + r, c.hari / 365), 0);
    const cfs: EirCashFlow[] = [{ hari: 0, jumlah: -pv }, ...masuk];
    const h = solveEffectiveInterestRate(cfs);
    expect(Math.abs(h.rateTahunan - r)).toBeLessThan(1e-6);
    expect(Math.abs(npvIndependen(h.rateTahunan, cfs))).toBeLessThan(TOL_NPV);
  });

  it('tenor sangat pendek (10 hari) konvergen ke akar eksak (1,08434)^(36,5) - 1', () => {
    const cfs: EirCashFlow[] = [{ hari: 0, jumlah: -1_000_000 }, { hari: 10, jumlah: 1_084_340 }];
    const eksak = Math.pow(1.08434, 36.5) - 1;
    const h = solveEffectiveInterestRate(cfs);
    expect(Math.abs(h.rateTahunan - eksak) / eksak).toBeLessThan(1e-6);
    expect(Math.abs(npvIndependen(h.rateTahunan, cfs))).toBeLessThan(TOL_NPV);
  });

  it('tenor panjang (120 angsuran bulanan) konvergen dan finite', () => {
    const cfs: EirCashFlow[] = [{ hari: 0, jumlah: -100_000_000 }];
    for (let k = 1; k <= 120; k++) cfs.push({ hari: Math.round((k * 365) / 12), jumlah: 1_450_000 });
    const h = solveEffectiveInterestRate(cfs);
    expect(Number.isFinite(h.rateTahunan)).toBe(true);
    expect(Math.abs(npvIndependen(h.rateTahunan, cfs))).toBeLessThan(TOL_NPV);
  });

  it('deterministik: pemanggilan berulang menghasilkan rate identik', () => {
    const cfs: EirCashFlow[] = [{ hari: 0, jumlah: -5_000_000 }, { hari: 180, jumlah: 2_700_000 }, { hari: 365, jumlah: 2_700_000 }];
    const a = solveEffectiveInterestRate(cfs).rateTahunan;
    for (let i = 0; i < 5; i++) expect(solveEffectiveInterestRate(cfs).rateTahunan).toBe(a);
  });
});

describe('RATE UNIT & ANNUALIZATION & DAY COUNT (Actual/365, majemuk)', () => {
  it('rate berupa DESIMAL tahunan: 10% dikembalikan sebagai 0.1, bukan 10 dan bukan 0.001', () => {
    const h = solveEffectiveInterestRate([{ hari: 0, jumlah: -1_000_000 }, { hari: 365, jumlah: 1_100_000 }]);
    expect(h.rateTahunan).toBeGreaterThan(0.09);
    expect(h.rateTahunan).toBeLessThan(0.11);
  });

  it('faktor periode: 365 hari = 1 + r; 730 hari MAJEMUK (1,44), bukan sederhana (1,40)', () => {
    expect(faktorPeriodeDariRateTahunan(0.12, 365)).toBeCloseTo(1.12, 12);
    expect(faktorPeriodeDariRateTahunan(0.2, 730)).toBeCloseTo(1.44, 12);
    expect(faktorPeriodeDariRateTahunan(0.2, 730)).not.toBeCloseTo(1.4, 3);
    // setengah tahun = akar kuadrat, bukan r/2
    expect(faktorPeriodeDariRateTahunan(0.21, 182.5)).toBeCloseTo(1.1, 12);
  });

  it('Actual/365 (bukan 360): 366 hari tahun kabisat memberi faktor 1,1^(366/365)', () => {
    expect(faktorPeriodeDariRateTahunan(0.1, 366)).toBeCloseTo(Math.pow(1.1, 366 / 365), 12);
    const h = solveEffectiveInterestRate([{ hari: 0, jumlah: -1_000_000 }, { hari: 366, jumlah: 1_100_000 }]);
    expect(Math.abs(h.rateTahunan - (Math.pow(1.1, 365 / 366) - 1))).toBeLessThan(1e-6);
    // basis 360 akan memberi 1,1^(360/366) - 1 — harus BERBEDA
    expect(Math.abs(h.rateTahunan - (Math.pow(1.1, 360 / 366) - 1))).toBeGreaterThan(1e-4);
  });
});

describe('SOLVER — kegagalan dilaporkan eksplisit, TIDAK ada fallback rate', () => {
  it('no-root: akar berada di bawah domain (-99%) -> EIR_NO_ROOT_IN_SEARCH_DOMAIN', () => {
    let tertangkap: unknown = null;
    try {
      solveEffectiveInterestRate([{ hari: 0, jumlah: -1_000_000 }, { hari: 30, jumlah: 5_000 }]);
    } catch (e) {
      tertangkap = e;
    }
    expect(tertangkap).toBeInstanceOf(EirSolverError);
    expect((tertangkap as EirSolverError).code).toBe('EIR_NO_ROOT_IN_SEARCH_DOMAIN');
  });

  it('nominal non-finite -> EIR_NUMERIC_FAILURE, bukan rate', () => {
    let tertangkap: unknown = null;
    try {
      solveEffectiveInterestRate([{ hari: 0, jumlah: -1_000_000 }, { hari: 30, jumlah: Number.NaN }, { hari: 60, jumlah: 1_100_000 }]);
    } catch (e) {
      tertangkap = e;
    }
    expect(tertangkap).toBeInstanceOf(EirSolverError);
    expect((tertangkap as EirSolverError).code).toBe('EIR_NUMERIC_FAILURE');
  });

  it.each([
    ['kurang dari 2 arus kas', [{ hari: 0, jumlah: -1 }]],
    ['arus kas pertama bukan hari 0', [{ hari: 1, jumlah: -100 }, { hari: 30, jumlah: 110 }]],
    ['tanggal tidak terurut', [{ hari: 0, jumlah: -100 }, { hari: 60, jumlah: 50 }, { hari: 30, jumlah: 60 }]],
    ['seluruhnya arus masuk', [{ hari: 0, jumlah: 100 }, { hari: 30, jumlah: 110 }]],
    ['seluruhnya arus keluar', [{ hari: 0, jumlah: -100 }, { hari: 30, jumlah: -110 }]],
  ] as const)('input tidak valid (%s) ditolak', (_n, cfs) => {
    expect(() => solveEffectiveInterestRate([...cfs])).toThrow();
  });

  it('arus kas dua perubahan tanda (dua akar 10% & 20%): akar yang dikembalikan tetap NPV=0 dan deterministik', () => {
    // -100, +230, -132 memiliki akar tepat 0,1 dan 0,2. Pola ini TIDAK
    // dapat dihasilkan builder pinjaman (lihat test DB: satu perubahan tanda).
    const cfs: EirCashFlow[] = [{ hari: 0, jumlah: -100_000_000 }, { hari: 365, jumlah: 230_000_000 }, { hari: 730, jumlah: -132_000_000 }];
    const h = solveEffectiveInterestRate(cfs);
    expect([0.1, 0.2].some((a) => Math.abs(h.rateTahunan - a) < 1e-6)).toBe(true);
    expect(Math.abs(npvIndependen(h.rateTahunan, cfs))).toBeLessThan(TOL_NPV);
    expect(solveEffectiveInterestRate(cfs).rateTahunan).toBe(h.rateTahunan);
  });
});

// ===========================================================================
// DATABASE — cashflow nyata dari cairkanPinjaman()
// ===========================================================================

async function siapkanPeriode2027(): Promise<void> {
  await testDb.runAsync(
    `INSERT OR IGNORE INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('period-2027',2027,'2027-01-01','2027-12-31','OPEN')`
  );
}

async function pinjamanIntegral(fee: number, metode: 'EFEKTIF' | 'FLAT' | 'MENURUN' = 'EFEKTIF'): Promise<string> {
  await siapkanPeriode2027();
  const { id } = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: '2026-01-15',
    jumlahPinjaman: 12_000_000,
    tenor: 12,
    satuanTenor: 'BULAN',
    metodeJasa: metode,
    persentaseJasa: 1.5,
    biayaAdminTipe: fee > 0 ? 'NOMINAL' : 'TIDAK_ADA',
    biayaAdminNilai: fee,
    dendaAktif: false,
    createdBy: 'user-1',
  });
  await testDb.runAsync(`UPDATE pinjaman SET biaya_admin_klasifikasi = 'INTEGRAL_FINANCIAL_INSTRUMENT' WHERE id = ?`, id);
  await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-15' });
  return id;
}

/** Arus kas dibaca ULANG dari database dengan day count independen. */
async function arusKasDariDb(pinjamanId: string, fee: number): Promise<EirCashFlow[]> {
  const p = await testDb.getFirstAsync<{ tanggal: string; jumlah_pinjaman: number }>(
    `SELECT tanggal, jumlah_pinjaman FROM pinjaman WHERE id = ?`, pinjamanId
  );
  const rows = await testDb.getAllAsync<{ tanggal_jatuh_tempo: string; total: number; pokok: number; jasa: number }>(
    `SELECT tanggal_jatuh_tempo, total, pokok, jasa FROM angsuran_jadwal WHERE pinjaman_id = ? ORDER BY nomor_angsuran`, pinjamanId
  );
  return [
    { hari: 0, jumlah: -(p!.jumlah_pinjaman - fee) },
    ...rows.map((r) => ({ hari: hariAntara(p!.tanggal, r.tanggal_jatuh_tempo), jumlah: r.total })),
  ];
}

describe('CASHFLOW & RECOGNITION — rate tersimpan memenuhi NPV = 0 terhadap arus kas nyata', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  it('fee nol -> NOT_APPLICABLE, tidak ada rate yang dipaksakan', async () => {
    const id = await pinjamanIntegral(0);
    const st = await testDb.getFirstAsync<{ s: string }>(`SELECT eir_measurement_status s FROM pinjaman WHERE id = ?`, id);
    expect(st?.s).toBe('NOT_APPLICABLE');
    expect(await getEirTersimpan(await getDb(), id)).toBeNull();
  });

  it.each([
    ['kecil', 12_000],
    ['besar', 1_200_000],
  ])('fee %s (%i): NPV(EIR) = 0; PV arus masa depan = kas bersih; satu perubahan tanda', async (_n, fee) => {
    const id = await pinjamanIntegral(fee);
    const eir = await getEirTersimpan(await getDb(), id);
    expect(eir).not.toBeNull();
    const cfs = await arusKasDariDb(id, fee);

    // Perspektif lender: CF0 negatif (kas bersih diserahkan), sisanya positif.
    expect(cfs[0].jumlah).toBe(-(12_000_000 - fee));
    expect(cfs.slice(1).every((c) => c.jumlah > 0)).toBe(true);
    // Angsuran = pokok + jasa (denda/penalti tidak masuk arus kas EIR).
    const rows = await testDb.getAllAsync<{ total: number; pokok: number; jasa: number; denda: number }>(
      `SELECT total, pokok, jasa, denda FROM angsuran_jadwal WHERE pinjaman_id = ?`, id
    );
    for (const r of rows) expect(r.total).toBe(r.pokok + r.jasa);

    expect(Math.abs(npvIndependen(eir!.rate, cfs))).toBeLessThan(TOL_NPV);
    const pvMasaDepan = cfs.slice(1).reduce((t, c) => t + c.jumlah / Math.pow(1 + eir!.rate, c.hari / 365), 0);
    expect(Math.abs(pvMasaDepan - (12_000_000 - fee))).toBeLessThan(TOL_NPV);
  });

  it('fee lebih besar -> EIR lebih tinggi (fee memang bagian arus kas EIR)', async () => {
    const kecil = await pinjamanIntegral(12_000);
    const besar = await pinjamanIntegral(1_200_000);
    const rKecil = (await getEirTersimpan(await getDb(), kecil))!.rate;
    const rBesar = (await getEirTersimpan(await getDb(), besar))!.rate;
    expect(rBesar).toBeGreaterThan(rKecil);
  });
});

// ===========================================================================
// ACCOUNTING — siklus penuh di database
// ===========================================================================

describe('ACCOUNTING — amortisasi fee: jurnal nyata, idempotensi, residual akhir, derecognition', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  it.each(['EFEKTIF', 'MENURUN'] as const)('%s: 12 periode + pembayaran normal', async (metode) => {
    const FEE = 240_000;
    const id = await pinjamanIntegral(FEE, metode);
    const jadwal = await getJadwalAngsuran(id);
    const rate = (await getEirTersimpan(await getDb(), id))!.rate;
    let totalDiakui = 0;

    for (let k = 0; k < jadwal.length; k++) {
      const due = jadwal[k].tanggalJatuhTempo;
      const periode = due.slice(0, 7);
      const h = await prosesEirBulanan({ pinjamanId: id, periode, createdBy: 'user-1', tanggalLaporan: due });
      expect(h.dibuat).toBe(true);
      const row = h.row!;
      expect(row.effectiveInterestRate).toBe(rate);
      expect(row.feeAmortizationIncome).toBeGreaterThan(0);
      expect(row.closingUnamortizedFee).toBe(row.openingUnamortizedFee - row.feeAmortizationIncome);
      expect(row.closingUnamortizedFee).toBeGreaterThanOrEqual(0);

      // Jurnal diambil dari database.
      const j = await testDb.getFirstAsync<{ tanggal: string; sumber_transaksi: string; sumber_id: string; status: string }>(
        `SELECT tanggal, sumber_transaksi, sumber_id, status FROM journal WHERE id = ?`, row.journalId
      );
      expect(j).toEqual({ tanggal: due, sumber_transaksi: 'EIR_FEE_AMORTIZATION', sumber_id: id, status: 'POSTED' });
      const e = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
        `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY debit DESC`, row.journalId
      );
      expect(e).toEqual([
        { account_id: ACC.pendapatanDimuka, debit: row.feeAmortizationIncome, kredit: 0 },
        { account_id: ACC.pendapatanJasa, debit: 0, kredit: row.feeAmortizationIncome },
      ]);

      // Idempotensi: loan + periode yang sama tidak menambah apa pun.
      const jumlahJurnal = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = 'EIR_FEE_AMORTIZATION'`);
      const ulang = await prosesEirBulanan({ pinjamanId: id, periode, createdBy: 'user-1', tanggalLaporan: due });
      expect(ulang.dibuat).toBe(false);
      expect(ulang.row?.id).toBe(row.id);
      expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = 'EIR_FEE_AMORTIZATION'`))?.n).toBe(jumlahJurnal?.n);

      totalDiakui += row.feeAmortizationIncome;
      await bayarAngsuran({ pinjamanId: id, jadwalId: jadwal[k].id, tanggal: due, nominal: jadwal[k].total, sumberDana: 'KAS', createdBy: 'user-1' });
    }

    // Residual akhir: Σ amortisasi = fee, tidak lebih, tidak kurang.
    expect(totalDiakui).toBe(FEE);
    const inv = await hitungInvarianFeeEir(await getDb(), id);
    expect(inv).toMatchObject({ feeAwal: FEE, amortisasi: FEE, derecognition: 0, sisaFee: 0, variance: 0, seimbang: true });

    // Komponen fee di 2-1300 untuk pinjaman ini habis.
    const dimuka = await testDb.getFirstAsync<{ s: number }>(
      `SELECT COALESCE(SUM(je.kredit - je.debit),0) s FROM journal_entry je JOIN journal j ON j.id = je.journal_id
        WHERE j.sumber_id = ? AND je.account_id = ? AND j.sumber_transaksi IN ('PENCAIRAN_PINJAMAN','EIR_FEE_AMORTIZATION') AND j.status = 'POSTED'`,
      id, ACC.pendapatanDimuka
    );
    expect(dimuka?.s).toBe(0);

    // Lunas normal -> fee lifecycle ditutup; derecognition tidak mengakui ulang (0).
    const st = await testDb.getFirstAsync<{ s: string }>(`SELECT eir_measurement_status s FROM pinjaman WHERE id = ?`, id);
    expect(st?.s).toBe('DERECOGNIZED');
  });

  it('pelunasan sebelum amortisasi selesai: sisa fee diselesaikan sekali oleh derecognition, total tetap = fee', async () => {
    const FEE = 240_000;
    const id = await pinjamanIntegral(FEE);
    const jadwal = await getJadwalAngsuran(id);
    const due1 = jadwal[0].tanggalJatuhTempo;
    const bulan1 = await prosesEirBulanan({ pinjamanId: id, periode: due1.slice(0, 7), createdBy: 'user-1', tanggalLaporan: due1 });
    // bayar seluruh angsuran berurutan tanpa amortisasi berikutnya
    for (const a of jadwal) {
      await bayarAngsuran({ pinjamanId: id, jadwalId: a.id, tanggal: a.tanggalJatuhTempo, nominal: a.total, sumberDana: 'KAS', createdBy: 'user-1' });
    }
    const inv = await hitungInvarianFeeEir(await getDb(), id);
    expect(inv?.amortisasi).toBe(bulan1.row!.feeAmortizationIncome);
    expect(inv?.derecognition).toBe(FEE - bulan1.row!.feeAmortizationIncome);
    expect(inv?.seimbang).toBe(true);
    // derecognition tidak bisa diulang: prosesEirBulanan setelah lunas tidak memposting apa pun
    const setelah = await prosesEirBulanan({ pinjamanId: id, periode: jadwal[1].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: jadwal[1].tanggalJatuhTempo });
    expect(setelah.dibuat).toBe(false);
  });
});

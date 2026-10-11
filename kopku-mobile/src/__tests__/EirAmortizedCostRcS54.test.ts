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

import { ajukanPinjaman, cairkanPinjaman, bayarAngsuran, getJadwalAngsuran, lunasiPinjaman, hapusPiutangPinjaman } from '@/services/PinjamanService';
import {
  getEirTersimpan,
  prosesEirBulanan,
  jalankanEirOtomatisJikaPerlu,
  bangunJadwalAmortizedCost,
  hariKalender,
  EirModelError,
  CONFIG_KEY_EIR_OTOMATIS_MULAI_PERIODE,
} from '@/services/EirAccountingService';
import { hitungInvarianFeeEir } from '@/accounting/EirFeeInvariant';
import { rekonsiliasiDeferredIncome } from '@/accounting/DeferredIncomeReconciliation';
import { solveEffectiveInterestRate, faktorPeriodeDariRateTahunan } from '@/accounting/EffectiveInterestRateService';
import { jalankanTugasStartup, _resetTugasStartupUntukTest } from '@/services/StartupTasks';
import { getDb } from '@/database/db';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

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
  pendapatanAdmin: 'acc-pendapatan-admin',
  penyisihan: 'acc-penyisihan',
  bebanPenyisihan: 'acc-beban-penyisihan',
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
  await seedAccount(db, ACC.penyisihan, '1-1210', 'Penyisihan Piutang Tak Tertagih', 'ASET', 'KREDIT');
  await seedAccount(db, ACC.bebanPenyisihan, '5-2100', 'Beban Penyisihan Pinjaman', 'BEBAN', 'DEBIT');
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
  // FIXTURE FIX: lunasiPinjaman() memakai mapping ini untuk jasa
  // kontraktual yang BELUM jatuh tempo saat pelunasan dipercepat
  // (Pendapatan Diterima Dimuka 2-1300 existing) — mapping produksi
  // sudah benar, fixture-nya yang belum menyeed.
  await seedMapping(db, 'PELUNASAN_JASA_FUTURE', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'PELUNASAN_PENALTI', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(db, 'PELUNASAN_ADMINISTRASI', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  // FINAL FIX AKRUAL (BUG 4/5/7): jasa yang kasnya diterima SEBELUM jatuh tempo
  // -> Pendapatan Diterima Dimuka (2-1300 existing), dilepas saat periode jatuh tempo.
  await seedMapping(db, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(db, 'PENYISIHAN_PIUTANG', 'DEBIT_BEBAN', ACC.bebanPenyisihan);
  await seedMapping(db, 'PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN', ACC.penyisihan);

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
    `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at) VALUES ('rat-2026',2026,'2026-05-01','user-1',?,?)`,
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


/** Nilai EKSPEKTASI dihitung skrip Python independen (bisection XIRR + replay AC), bukan dari service. */
const EXPECTED_PYTHON: Record<'EFEKTIF' | 'MENURUN' | 'FLAT', { rate: number; rows: { periode: string; fee: number; eir: number; jasa: number; pokok: number }[] }> = {"EFEKTIF": {"rate": 0.24363984944567496, "rows": [{"periode": "2026-02", "fee": 39809, "eir": 39809, "jasa": 180000, "pokok": 920160}, {"periode": "2026-03", "fee": 17311, "eir": 17311, "jasa": 166198, "pokok": 933962}, {"periode": "2026-04", "fee": 34032, "eir": 34032, "jasa": 152188, "pokok": 947972}, {"periode": "2026-05", "fee": 25664, "eir": 25664, "jasa": 137969, "pokok": 962191}, {"periode": "2026-06", "fee": 28097, "eir": 28097, "jasa": 123536, "pokok": 976624}, {"periode": "2026-07", "fee": 20660, "eir": 20660, "jasa": 108886, "pokok": 991274}, {"periode": "2026-08", "fee": 21745, "eir": 21745, "jasa": 94017, "pokok": 1006143}, {"periode": "2026-09", "fee": 18437, "eir": 18437, "jasa": 78925, "pokok": 1021235}, {"periode": "2026-10", "fee": 12453, "eir": 12453, "jasa": 63607, "pokok": 1036553}, {"periode": "2026-11", "fee": 11419, "eir": 11419, "jasa": 48058, "pokok": 1052102}, {"periode": "2026-12", "fee": 6446, "eir": 6446, "jasa": 32277, "pokok": 1067883}, {"periode": "2027-01", "fee": 3927, "eir": 3927, "jasa": 16259, "pokok": 1083901}]}, "MENURUN": {"rate": 0.24495819637641147, "rows": [{"periode": "2026-02", "fee": 40887, "eir": 40887, "jasa": 180000, "pokok": 1000000}, {"periode": "2026-03", "fee": 18073, "eir": 18073, "jasa": 165000, "pokok": 1000000}, {"periode": "2026-04", "fee": 34429, "eir": 34429, "jasa": 150000, "pokok": 1000000}, {"periode": "2026-05", "fee": 25879, "eir": 25879, "jasa": 135000, "pokok": 1000000}, {"periode": "2026-06", "fee": 27995, "eir": 27995, "jasa": 120000, "pokok": 1000000}, {"periode": "2026-07", "fee": 20516, "eir": 20516, "jasa": 105000, "pokok": 1000000}, {"periode": "2026-08", "fee": 21340, "eir": 21340, "jasa": 90000, "pokok": 1000000}, {"periode": "2026-09", "fee": 17959, "eir": 17959, "jasa": 75000, "pokok": 1000000}, {"periode": "2026-10", "fee": 12088, "eir": 12088, "jasa": 60000, "pokok": 1000000}, {"periode": "2026-11", "fee": 10957, "eir": 10957, "jasa": 45000, "pokok": 1000000}, {"periode": "2026-12", "fee": 6164, "eir": 6164, "jasa": 30000, "pokok": 1000000}, {"periode": "2027-01", "fee": 3713, "eir": 3713, "jasa": 15000, "pokok": 1000000}]}, "FLAT": {"rate": 0.42457909042675757, "rows": [{"periode": "2026-02", "fee": 178815, "eir": 178815, "jasa": 180000, "pokok": 1000000}, {"periode": "2026-03", "fee": 61185, "eir": 121020, "jasa": 180000, "pokok": 1000000}, {"periode": "2026-04", "fee": 0, "eir": 126940, "jasa": 180000, "pokok": 1000000}, {"periode": "2026-05", "fee": 0, "eir": 91128, "jasa": 180000, "pokok": 1000000}, {"periode": "2026-06", "fee": 0, "eir": 72571, "jasa": 180000, "pokok": 1000000}, {"periode": "2026-07", "fee": 0, "eir": 36934, "jasa": 180000, "pokok": 1000000}, {"periode": "2026-08", "fee": 0, "eir": 14889, "jasa": 180000, "pokok": 1000000}, {"periode": "2026-09", "fee": 0, "eir": -15168, "jasa": 180000, "pokok": 1000000}, {"periode": "2026-10", "fee": 0, "eir": -50523, "jasa": 180000, "pokok": 1000000}, {"periode": "2026-11", "fee": 0, "eir": -78196, "jasa": 180000, "pokok": 1000000}, {"periode": "2026-12", "fee": 0, "eir": -113348, "jasa": 180000, "pokok": 1000000}, {"periode": "2027-01", "fee": 0, "eir": -145062, "jasa": 180000, "pokok": 1000000}]}};

/**
 * RC-S54 TAHAP 9 — EIR AMORTIZED COST + TRIGGER PRODUKSI
 * =========================================================================
 * Model: RC-S54_TAHAP_9.md §B. Seluruh posting lewat service produksi di
 * SQLite nyata; jurnal dibaca dari `journal_entry`.
 *
 * Ekspektasi per periode berasal dari DUA sumber independen:
 *   (1) `EXPECTED_PYTHON` — skrip Python terpisah (XIRR bisection sendiri);
 *       rate-nya bisa beda di digit ke-9 dari solver, jadi dibandingkan
 *       dengan toleransi 1 rupiah per periode, total tetap eksak;
 *   (2) replay `Math.pow` di test ini memakai rate TERSIMPAN — eksak.
 */

type Metode = 'EFEKTIF' | 'MENURUN' | 'FLAT';
const POKOK = 12_000_000;
const FEE = 240_000;
const CAIR = '2026-01-15';

async function tambahPeriode(): Promise<void> {
  for (const th of [2027, 2028]) {
    await testDb.runAsync(
      `INSERT OR IGNORE INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `period-${th}`, th, `${th}-01-01`, `${th}-12-31`
    );
  }
}

let urutPinjaman = 0;
async function pinjaman(metode: Metode, fee = FEE, opsi: { anggotaId?: string; pokok?: number } = {}): Promise<string> {
  await tambahPeriode();
  const { id } = await ajukanPinjaman({
    anggotaId: opsi.anggotaId ?? ANGGOTA_ID,
    tanggal: CAIR,
    jumlahPinjaman: opsi.pokok ?? POKOK,
    tenor: 12,
    satuanTenor: 'BULAN',
    metodeJasa: metode,
    persentaseJasa: 1.5,
    biayaAdminTipe: fee > 0 ? 'NOMINAL' : 'TIDAK_ADA',
    biayaAdminNilai: fee,
    dendaAktif: false,
    createdBy: 'user-1',
  });
  urutPinjaman++;
  await testDb.runAsync(`UPDATE pinjaman SET biaya_admin_klasifikasi = 'INTEGRAL_FINANCIAL_INSTRUMENT' WHERE id = ?`, id);
  await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: CAIR });
  return id;
}

async function barisJurnal(journalId: string) {
  return testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
    `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY account_id`, journalId
  );
}

async function jumlahJurnalEir(): Promise<number> {
  return (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = 'EIR_FEE_AMORTIZATION'`))?.n ?? 0;
}

async function saldo2_1300(): Promise<number> {
  return (await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.kredit - je.debit),0) s FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`, ACC.pendapatanDimuka
  ))?.s ?? 0;
}

/** Replay independen memakai rate tersimpan — tidak memanggil fungsi service. */
async function replayIndependen(pinjamanId: string, fee: number) {
  const rate = (await getEirTersimpan(await getDb(), pinjamanId))!.rate;
  const rows = await testDb.getAllAsync<{ tanggal_jatuh_tempo: string; pokok: number; jasa: number; total: number }>(
    `SELECT tanggal_jatuh_tempo, pokok, jasa, total FROM angsuran_jadwal WHERE pinjaman_id = ? ORDER BY nomor_angsuran`, pinjamanId
  );
  let ac = POKOK - fee;
  let prev = CAIR;
  let a = 0;
  let aMax = 0;
  let pA = 0;
  let pF = 0;
  return rows.map((r, i) => {
    const hari = Math.round((Date.parse(r.tanggal_jatuh_tempo) - Date.parse(prev)) / 86_400_000);
    const opening = ac;
    const ei = opening * (Math.pow(1 + rate, hari / 365) - 1);
    ac = opening + ei - r.total;
    a += ei - r.jasa;
    aMax = Math.max(aMax, a);
    let kA = Math.round(a);
    let kF = Math.min(fee, Math.max(0, Math.round(aMax)));
    if (i === rows.length - 1) {
      kA = fee;
      kF = fee;
    }
    const out = { periode: r.tanggal_jatuh_tempo.slice(0, 7), due: r.tanggal_jatuh_tempo, opening, ei, closing: ac, total: r.total, jasa: r.jasa, dFee: kF - pF, dEir: kA - pA, kumAkrual: kA - kF };
    pA = kA;
    pF = kF;
    prev = r.tanggal_jatuh_tempo;
    return out;
  });
}

beforeEach(async () => {
  testDb = await setupFixture();
  _resetTugasStartupUntukTest();
});

// ===========================================================================
// AMORTIZED COST — EFEKTIF / MENURUN / FLAT (flow nyata: cair -> EIR -> bayar)
// ===========================================================================

describe.each(['EFEKTIF', 'MENURUN', 'FLAT'] as const)('AMORTIZED COST — %s 12 jt / 12 bln / fee 240.000', (metode) => {
  it('tiap periode: EI dari opening AC; AC tertutup; fee tidak negatif/burst/melebihi; jurnal = ΔA; 2-1300 = komponen EIR', async () => {
    const id = await pinjaman(metode);
    const jadwal = await getJadwalAngsuran(id);
    const replay = await replayIndependen(id, FEE);
    const py = EXPECTED_PYTHON[metode].rows;
    let totalFee = 0;

    for (let k = 0; k < jadwal.length; k++) {
      const due = jadwal[k].tanggalJatuhTempo;
      const h = await prosesEirBulanan({ pinjamanId: id, periode: due.slice(0, 7), createdBy: 'user-1', tanggalLaporan: due });
      const exp = replay[k];
      expect(h.dibuat).toBe(true);
      const row = h.row!;
      const m = row.pengukuran!;

      // Effective interest berbasis opening carrying amount (bukan sisa fee).
      expect(m.openingCarryingAmount).toBeCloseTo(exp.opening, 4);
      expect(m.effectiveInterest).toBeCloseTo(exp.opening * (faktorPeriodeDariRateTahunan(row.effectiveInterestRate, hariKalender(k === 0 ? CAIR : jadwal[k - 1].tanggalJatuhTempo, due)) - 1), 6);
      // Opening AC + EI - arus kas = closing AC.
      // Periode terakhir: residual pembulatan float (< Rp1) ditutup ke 0 oleh engine.
      if (k === jadwal.length - 1) {
        expect(m.closingCarryingAmount).toBe(0);
        expect(Math.abs(m.openingCarryingAmount + m.effectiveInterest - m.arusKas)).toBeLessThan(1);
      } else {
        expect(m.openingCarryingAmount + m.effectiveInterest - m.arusKas).toBeCloseTo(m.closingCarryingAmount, 4);
      }
      expect(m.jasaKontraktual).toBe(exp.jasa);

      // Alokasi: eksak vs replay, ±1 vs Python independen.
      expect(row.feeAmortizationIncome).toBe(exp.dFee);
      expect(m.penyesuaianEir).toBe(exp.dEir);
      expect(Math.abs(row.feeAmortizationIncome - py[k].fee)).toBeLessThanOrEqual(1);
      expect(Math.abs(m.penyesuaianEir - py[k].eir)).toBeLessThanOrEqual(1);
      expect(m.penyesuaianAkrual).toBe(m.penyesuaianEir - row.feeAmortizationIncome);

      expect(row.feeAmortizationIncome).toBeGreaterThanOrEqual(0);
      expect(row.closingUnamortizedFee).toBe(row.openingUnamortizedFee - row.feeAmortizationIncome);
      expect(row.closingUnamortizedFee).toBeGreaterThanOrEqual(0);
      totalFee += row.feeAmortizationIncome;
      expect(totalFee).toBeLessThanOrEqual(FEE);

      // Jurnal aktual: satu jurnal, arah sesuai tanda ΔA, seimbang.
      if (m.penyesuaianEir !== 0) {
        const e = await barisJurnal(row.journalId!);
        const d = e.reduce((t, x) => t + x.debit, 0);
        expect(d).toBe(e.reduce((t, x) => t + x.kredit, 0));
        const nilai = Math.abs(m.penyesuaianEir);
        const dimuka = e.find((x) => x.account_id === ACC.pendapatanDimuka)!;
        const jasa = e.find((x) => x.account_id === ACC.pendapatanJasa)!;
        if (m.penyesuaianEir > 0) {
          expect([dimuka.debit, jasa.kredit]).toEqual([nilai, nilai]);
        } else {
          expect([jasa.debit, dimuka.kredit]).toEqual([nilai, nilai]);
        }
      } else {
        expect(row.journalId).toBeNull();
      }

      // Subledger komponen EIR = saldo EIR di GL 2-1300 (sebelum pembayaran; tanpa jasa dimuka).
      const inv = (await hitungInvarianFeeEir(await getDb(), id))!;
      expect(inv.seimbang).toBe(true);
      expect(inv.penyesuaianAkrual).toBe(exp.kumAkrual);
      expect(await saldo2_1300()).toBe(inv.saldoKomponenEir);

      // Idempotensi per pinjaman + periode.
      const n = await jumlahJurnalEir();
      const ulang = await prosesEirBulanan({ pinjamanId: id, periode: due.slice(0, 7), createdBy: 'user-1', tanggalLaporan: due });
      expect(ulang.dibuat).toBe(false);
      expect(await jumlahJurnalEir()).toBe(n);

      await bayarAngsuran({ pinjamanId: id, jadwalId: jadwal[k].id, tanggal: due, nominal: jadwal[k].total, sumberDana: 'KAS', createdBy: 'user-1' });
      // Rekonsiliasi existing 2-1300 (kontraktual + komponen EIR) tetap seimbang setelah pembayaran nyata.
      const rek = await rekonsiliasiDeferredIncome(await getDb());
      expect(rek.variance).toBe(0);
    }

    expect(totalFee).toBe(FEE);
    expect(replay[replay.length - 1].closing).toBeCloseTo(0, 0);
    const akhir = (await hitungInvarianFeeEir(await getDb(), id))!;
    expect(akhir).toMatchObject({ amortisasi: FEE, sisaFee: 0, penyesuaianAkrual: 0, saldoKomponenEir: 0, seimbang: true });
    expect(await saldo2_1300()).toBe(0);
    // Tidak ada burst: periode terakhir hanya membawa porsi periodenya.
    expect(replay[replay.length - 1].dFee).toBeLessThan(FEE / 4);
  });
});

describe('FLAT — model amortized cost, bukan overlay', () => {
  it('fee ter-unwind di bulan 1–2; bunga efektif akrual X naik lalu kembali 0; penyesuaian negatif dijurnal Dr 4-1000 / Cr 2-1300', async () => {
    const id = await pinjaman('FLAT');
    const replay = await replayIndependen(id, FEE);
    expect(replay.map((r) => r.dFee)).toEqual([178_815, 61_185, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Math.max(...replay.map((r) => r.kumAkrual))).toBeGreaterThan(0);
    expect(replay[replay.length - 1].kumAkrual).toBe(0);
    expect(replay.slice(7).every((r) => r.dEir < 0)).toBe(true);
    expect(replay.reduce((t, r) => t + r.dEir, 0)).toBe(FEE); // total pendapatan EIR di atas jasa = fee
    // Total pendapatan pinjaman = Σ jasa kontraktual + Σ penyesuaian EIR = Σ EI.
    const totalEi = replay.reduce((t, r) => t + r.ei, 0);
    const totalJasa = replay.reduce((t, r) => t + r.jasa, 0);
    expect(totalJasa + FEE).toBeCloseTo(totalEi, 0);
  });
});

// ===========================================================================
// NO FEE / SMALL / LARGE / IRREGULAR
// ===========================================================================

describe('FEE & CASHFLOW', () => {
  it('tanpa fee: NOT_APPLICABLE, orkestrator tidak membuat jurnal EIR', async () => {
    const id = await pinjaman('EFEKTIF', 0);
    expect((await testDb.getFirstAsync<{ s: string }>(`SELECT eir_measurement_status s FROM pinjaman WHERE id = ?`, id))?.s).toBe('NOT_APPLICABLE');
    const h = await jalankanEirOtomatisJikaPerlu('user-1', new Date('2026-12-20T10:00:00'));
    expect(h.diproses).toEqual([]);
    expect(h.gagal).toEqual([]);
    expect(await jumlahJurnalEir()).toBe(0);
  });

  it.each([[12_000], [1_200_000]])('fee %i: Σ fee = fee, AC akhir 0, PV arus kas @EIR = AC_0', async (fee) => {
    const id = await pinjaman('EFEKTIF', fee);
    const replay = await replayIndependen(id, fee);
    const rate = (await getEirTersimpan(await getDb(), id))!.rate;
    const pv = replay.reduce((t, r) => t + r.total / Math.pow(1 + rate, hariKalender(CAIR, r.due) / 365), 0);
    expect(Math.abs(pv - (POKOK - fee))).toBeLessThan(0.5);
    expect(replay.reduce((t, r) => t + r.dFee, 0)).toBe(fee);
    expect(replay.every((r) => r.dFee >= 0)).toBe(true);
    expect(Math.abs(replay[replay.length - 1].closing)).toBeLessThan(1);
  });

  it('tanggal tidak seragam (Actual/365): PV(cashflow @EIR) = AC_0 dan jadwal AC menutup tepat', () => {
    const jadwal = [
      { tanggalJatuhTempo: '2026-02-03', pokok: 300_000, jasa: 20_000, total: 320_000 },
      { tanggalJatuhTempo: '2026-04-29', pokok: 300_000, jasa: 15_000, total: 315_000 },
      { tanggalJatuhTempo: '2026-05-10', pokok: 200_000, jasa: 9_000, total: 209_000 },
      { tanggalJatuhTempo: '2027-01-15', pokok: 200_000, jasa: 30_000, total: 230_000 },
    ];
    const fee = 25_000;
    const cf = [{ hari: 0, jumlah: -(1_000_000 - fee) }, ...jadwal.map((r) => ({ hari: hariKalender('2026-01-15', r.tanggalJatuhTempo), jumlah: r.total }))];
    const rate = solveEffectiveInterestRate(cf).rateTahunan;
    const pv = cf.slice(1).reduce((t, c) => t + c.jumlah / Math.pow(1 + rate, c.hari / 365), 0);
    expect(Math.abs(pv - (1_000_000 - fee))).toBeLessThan(0.5);
    const ac = bangunJadwalAmortizedCost({ jumlahPinjaman: 1_000_000, feeIntegral: fee, tanggalPencairan: '2026-01-15', effectiveInterestRate: rate, jadwal });
    expect(ac.map((b) => b.hari)).toEqual([19, 85, 11, 250]);
    expect(ac[ac.length - 1].closingCarryingAmount).toBe(0);
    expect(ac[ac.length - 1].kumulatifAmortisasiFee).toBe(fee);
    for (const b of ac) expect(b.openingCarryingAmount + b.effectiveInterest - b.arusKas).toBeCloseTo(b === ac[ac.length - 1] ? 0 : b.closingCarryingAmount, 0);
  });

  it('jadwal yang tidak konsisten dengan cashflow EIR ditolak eksplisit (bukan dipaksa menutup)', () => {
    expect(() =>
      bangunJadwalAmortizedCost({
        jumlahPinjaman: 1_000_000, feeIntegral: 10_000, tanggalPencairan: '2026-01-01', effectiveInterestRate: 0.2,
        jadwal: [{ tanggalJatuhTempo: '2026-07-01', pokok: 900_000, jasa: 50_000, total: 950_000 }],
      })
    ).toThrow(EirModelError);
  });
});

// ===========================================================================
// SETTLEMENT / WRITE-OFF
// ===========================================================================

describe('SETTLEMENT & WRITE-OFF', () => {
  it('pelunasan dipercepat FLAT saat X > 0: X dibalik sekali, fee tidak ganda, komponen EIR 0, tanpa residual negatif', async () => {
    const id = await pinjaman('FLAT');
    const jadwal = await getJadwalAngsuran(id);
    for (let k = 0; k < 3; k++) {
      const due = jadwal[k].tanggalJatuhTempo;
      await prosesEirBulanan({ pinjamanId: id, periode: due.slice(0, 7), createdBy: 'user-1', tanggalLaporan: due });
      await bayarAngsuran({ pinjamanId: id, jadwalId: jadwal[k].id, tanggal: due, nominal: jadwal[k].total, sumberDana: 'KAS', createdBy: 'user-1' });
    }
    const sebelum = (await hitungInvarianFeeEir(await getDb(), id))!;
    expect(sebelum.sisaFee).toBe(0);
    expect(sebelum.penyesuaianAkrual).toBeGreaterThan(0);
    const jurnalSebelum = await jumlahJurnalEir();

    const hasil = await lunasiPinjaman({ pinjamanId: id, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1', metodeJasaPelunasan: 'JASA_TERUTANG' });
    expect(hasil.eirFeeDiselesaikan).toBe(0);
    expect(await jumlahJurnalEir()).toBe(jurnalSebelum + 1);

    const der = await testDb.getFirstAsync<{ journal_id: string; amortisasi_fee: number; pendapatan_akuntansi: number }>(
      `SELECT journal_id, amortisasi_fee, pendapatan_akuntansi FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'EIR_DERECOGNITION'`, id
    );
    expect(der?.amortisasi_fee).toBe(0);
    expect(der?.pendapatan_akuntansi).toBe(-sebelum.penyesuaianAkrual);
    const e = await barisJurnal(der!.journal_id);
    expect(e.find((x) => x.account_id === ACC.pendapatanJasa)?.debit).toBe(sebelum.penyesuaianAkrual);
    expect(e.find((x) => x.account_id === ACC.pendapatanDimuka)?.kredit).toBe(sebelum.penyesuaianAkrual);

    const sesudah = (await hitungInvarianFeeEir(await getDb(), id))!;
    expect(sesudah).toMatchObject({ totalDiakui: FEE, sisaFee: 0, penyesuaianAkrual: 0, saldoKomponenEir: 0, seimbang: true });
    // Tidak bisa diulang; orkestrator tidak memproses pinjaman LUNAS.
    const h = await jalankanEirOtomatisJikaPerlu('user-1', new Date('2026-12-20T10:00:00'));
    expect(h.diproses.filter((x) => x.pinjamanId === id)).toEqual([]);
    expect(await jumlahJurnalEir()).toBe(jurnalSebelum + 1);
  });

  it('pelunasan dipercepat EFEKTIF: sisa fee diselesaikan sekali, Σ = fee', async () => {
    const id = await pinjaman('EFEKTIF');
    const due = (await getJadwalAngsuran(id))[0].tanggalJatuhTempo;
    const b1 = await prosesEirBulanan({ pinjamanId: id, periode: due.slice(0, 7), createdBy: 'user-1', tanggalLaporan: due });
    const hasil = await lunasiPinjaman({ pinjamanId: id, tanggal: '2026-02-20', sumberDana: 'KAS', createdBy: 'user-1', metodeJasaPelunasan: 'JASA_TERUTANG' });
    expect(b1.row!.feeAmortizationIncome + hasil.eirFeeDiselesaikan).toBe(FEE);
    expect((await hitungInvarianFeeEir(await getDb(), id))).toMatchObject({ sisaFee: 0, penyesuaianAkrual: 0, seimbang: true });
  });

  it('write-off: komponen EIR diselesaikan dalam transaksi write-off, tidak ada posting EIR kedua sesudahnya', async () => {
    const id = await pinjaman('FLAT');
    const jadwal = await getJadwalAngsuran(id);
    for (let k = 0; k < 2; k++) {
      const due = jadwal[k].tanggalJatuhTempo;
      await prosesEirBulanan({ pinjamanId: id, periode: due.slice(0, 7), createdBy: 'user-1', tanggalLaporan: due });
    }
    await hapusPiutangPinjaman({ pinjamanId: id, tanggal: '2026-11-01', alasan: 'uji', createdBy: 'user-1', topUpPenyisihanJikaKurang: true });
    const inv = (await hitungInvarianFeeEir(await getDb(), id))!;
    expect(inv).toMatchObject({ totalDiakui: FEE, sisaFee: 0, penyesuaianAkrual: 0, saldoKomponenEir: 0, seimbang: true });
    const n = await jumlahJurnalEir();
    const lagi = await prosesEirBulanan({ pinjamanId: id, periode: jadwal[2].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-12-01' });
    expect(lagi.dibuat).toBe(false);
    expect(await jumlahJurnalEir()).toBe(n);
  });
});

// ===========================================================================
// TRIGGER PRODUKSI
// ===========================================================================

async function jalankanStartupPada(isoLokal: string): Promise<void> {
  jest.useFakeTimers({
    now: new Date(isoLokal),
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
  });
  try {
    await jalankanTugasStartup('user-1');
  } finally {
    jest.useRealTimers();
  }
}

async function periodeEirTerposting(id: string): Promise<string[]> {
  return (await testDb.getAllAsync<{ p: string }>(
    `SELECT periode_akuntansi p FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'EIR_MONTHLY' ORDER BY p`, id
  )).map((r) => r.p);
}

describe('TRIGGER — StartupTasks -> jalankanEirOtomatisJikaPerlu -> prosesEirBulanan', () => {
  async function tetapkanBatas(periode: string) {
    await testDb.runAsync(`INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)`, CONFIG_KEY_EIR_OTOMATIS_MULAI_PERIODE, periode, 'x');
  }

  it('startup: periode jatuh tempo diposting satu kali', async () => {
    const id = await pinjaman('EFEKTIF');
    await tetapkanBatas('2026-01');
    await jalankanStartupPada('2026-02-16T09:00:00');
    expect(await periodeEirTerposting(id)).toEqual(['2026-02']);
    expect(await jumlahJurnalEir()).toBe(1);
  });

  it('restart (startup dua kali, juga dua startup bersamaan): tetap satu posting', async () => {
    const id = await pinjaman('EFEKTIF');
    await tetapkanBatas('2026-01');
    await jalankanStartupPada('2026-02-16T09:00:00');
    await jalankanStartupPada('2026-02-16T18:00:00');
    jest.useFakeTimers({ now: new Date('2026-02-17T09:00:00'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    try {
      await Promise.all([jalankanTugasStartup('user-1'), jalankanTugasStartup('user-1')]);
    } finally {
      jest.useRealTimers();
    }
    expect(await periodeEirTerposting(id)).toEqual(['2026-02']);
    expect(await jumlahJurnalEir()).toBe(1);
  });

  it('catch-up: app tidak dibuka beberapa periode -> semua periode jatuh tempo diproses sekali, jatuh tempo masa depan tidak', async () => {
    const id = await pinjaman('EFEKTIF');
    const jadwal = await getJadwalAngsuran(id);
    await tetapkanBatas('2026-01');
    // 2026-05-14: angsuran 2026-05-15 BELUM jatuh tempo walau periodenya berjalan.
    const hasil = await jalankanEirOtomatisJikaPerlu('user-1', new Date('2026-05-14T09:00:00'));
    expect(hasil.gagal).toEqual([]);
    expect(hasil.diproses.map((x) => x.periode)).toEqual(['2026-02', '2026-03', '2026-04']);
    expect(await periodeEirTerposting(id)).toEqual(['2026-02', '2026-03', '2026-04']);
    const replay = await replayIndependen(id, FEE);
    const inv = (await hitungInvarianFeeEir(await getDb(), id))!;
    expect(inv.amortisasi).toBe(replay.slice(0, 3).reduce((t, r) => t + r.dFee, 0));
    // Tidak ada jurnal bertanggal setelah tanggal laporan.
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = 'EIR_FEE_AMORTIZATION' AND tanggal > '2026-05-14'`))?.n).toBe(0);
    // Ulang pada hari yang sama -> tidak ada tambahan.
    const ulang = await jalankanEirOtomatisJikaPerlu('user-1', new Date('2026-05-14T20:00:00'));
    expect(ulang.diproses).toEqual([]);
    expect(await jumlahJurnalEir()).toBe(3);
    expect(jadwal.length).toBe(12);
  });

  it('periode tertutup: gagal eksplisit per pinjaman (tanpa jurnal ke periode lain); pinjaman lain tetap diproses', async () => {
    await tetapkanBatas('2026-01');
    const lama = await pinjaman('EFEKTIF');
    // pinjaman kedua cair 2027 -> periode 2027 terbuka
    await tambahPeriode();
    const { id: baru } = await ajukanPinjaman({ anggotaId: ANGGOTA_ID, tanggal: '2027-01-15', jumlahPinjaman: 6_000_000, tenor: 6, satuanTenor: 'BULAN', metodeJasa: 'EFEKTIF', persentaseJasa: 1.5, biayaAdminTipe: 'NOMINAL', biayaAdminNilai: 60_000, dendaAktif: false, createdBy: 'user-1' });
    await testDb.runAsync(`UPDATE pinjaman SET biaya_admin_klasifikasi = 'INTEGRAL_FINANCIAL_INSTRUMENT' WHERE id = ?`, baru);
    await cairkanPinjaman({ pinjamanId: baru, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2027-01-15' });
    // bayar lancar pinjaman lama supaya bukan non-accrual
    const jl = await getJadwalAngsuran(lama);
    for (const a of jl.slice(0, 11)) await bayarAngsuran({ pinjamanId: lama, jadwalId: a.id, tanggal: a.tanggalJatuhTempo, nominal: a.total, sumberDana: 'KAS', createdBy: 'user-1' });
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE tahun_buku = 2026`);

    const h = await jalankanEirOtomatisJikaPerlu('user-1', new Date('2027-02-20T09:00:00'));
    const gagalLama = h.gagal.filter((g) => g.pinjamanId === lama);
    expect(gagalLama).toHaveLength(1);
    expect(gagalLama[0].periode).toBe('2026-02');
    expect(gagalLama[0].alasan).toMatch(/ClosedPeriodError/);
    expect(await periodeEirTerposting(lama)).toEqual([]);
    expect(await periodeEirTerposting(baru)).toEqual(['2027-02']);
  });

  it('EIR_HISTORICAL_GAP: periode jatuh tempo sebelum batas otomatis tidak diposting, hanya dilaporkan', async () => {
    const id = await pinjaman('EFEKTIF');
    const jadwal = await getJadwalAngsuran(id);
    for (const a of jadwal.slice(0, 5)) await bayarAngsuran({ pinjamanId: id, jadwalId: a.id, tanggal: a.tanggalJatuhTempo, nominal: a.total, sumberDana: 'KAS', createdBy: 'user-1' });
    await tetapkanBatas('2026-06');
    const h = await jalankanEirOtomatisJikaPerlu('user-1', new Date('2026-06-20T09:00:00'));
    expect(h.diproses).toEqual([]);
    expect(h.historicalGap).toHaveLength(1);
    const gap = h.historicalGap[0];
    const replay = await replayIndependen(id, FEE);
    const expected = replay.slice(0, 4).reduce((t, r) => t + r.dEir, 0);
    expect(gap).toMatchObject({ kode: 'EIR_HISTORICAL_GAP', pinjamanId: id, periode: ['2026-02', '2026-03', '2026-04', '2026-05'], expected, actual: 0, potensiDampakJurnal: expected });
    expect(await jumlahJurnalEir()).toBe(0);
  });

  it('batas otomatis ditulis sekali pada run pertama dan tidak berubah', async () => {
    await jalankanEirOtomatisJikaPerlu('user-1', new Date('2026-03-10T09:00:00'));
    await jalankanEirOtomatisJikaPerlu('user-1', new Date('2026-09-10T09:00:00'));
    const v = await testDb.getFirstAsync<{ value: string }>(`SELECT value FROM app_config WHERE key = ?`, CONFIG_KEY_EIR_OTOMATIS_MULAI_PERIODE);
    expect(v?.value).toBe('2026-03');
  });

  it('screen + startup: tidak ada layar/route yang memanggil proses EIR; satu-satunya pemicu StartupTasks', () => {
    const root = join(__dirname, '..', '..');
    const berkas: string[] = [];
    const telusur = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) telusur(p);
        else if (/\.(ts|tsx)$/.test(f)) berkas.push(p);
      }
    };
    telusur(join(root, 'src'));
    telusur(join(root, 'app'));
    const pemanggil = berkas
      .filter((p) => !p.includes('__tests__'))
      .filter((p) => {
        const tanpaKomentar = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        return /\b(prosesEirBulanan|jalankanEirOtomatisJikaPerlu)\s*\(/.test(tanpaKomentar);
      })
      .map((p) => p.slice(root.length + 1))
      .sort();
    expect(pemanggil).toEqual(['src/services/EirAccountingService.ts', 'src/services/StartupTasks.ts']);
  });
});

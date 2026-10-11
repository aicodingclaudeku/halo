import * as SQLite from 'expo-sqlite';
import { sqlJadwalBukanObsolete } from '@/accounting/ScheduleLifecycle';
import { isNonAccrual, alasanNonAccrual } from '@/accounting/NonAccrualPolicy';
import { getDb, withTransaction } from '@/database/db';
import { createJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { requirePermission, requirePermissionAtauSystemTrigger } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { toPeriode, isValidPeriode } from '@/accounting/PeriodeUtil';
import { solveEffectiveInterestRate, faktorPeriodeDariRateTahunan, EirCashFlow } from '@/accounting/EffectiveInterestRateService';
import { getTanggalLokalHariIni, toTanggalLokal } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * PHASE 7 (permintaan pengguna) — EIR ACCOUNTING, lapisan 2 & 3 dari
 * §B (Accounting Carrying Amount -> General Ledger). Lapisan 1
 * (Contractual Loan Schedule, PinjamanCalculator/angsuran_jadwal)
 * SAMA SEKALI TIDAK disentuh.
 *
 * RUANG LINGKUP YANG SENGAJA DIPILIH (didokumentasikan eksplisit,
 * bukan disembunyikan): modul ini mengamortisasi KHUSUS saldo FEE
 * INTEGRAL (yang sejak Phase 2 sudah dibukukan sebagai liabilitas
 * "Pendapatan Diterima Dimuka", status DEFERRED_PENDING_EIR) — BUKAN
 * membangun ulang seluruh carrying-amount pinjaman (pokok+jasa) dari
 * nol. Piutang Pokok & Piutang Jasa TETAP dikelola PERSIS seperti
 * Phase 2-4 (JASA_AKRUAL, PEMBAYARAN_JASA_PINJAMAN, dst — TIDAK
 * disentuh). Alasannya: instruksi eksplisit "jangan sentuh Phase 1
 * COA/Phase 2 accrual/Phase 3 write-off-restructuring/Phase 4
 * settlement" (§AG) berarti mekanisme Piutang Pokok/Jasa yang SUDAH
 * teruji itu tidak boleh dirombak. Yang BELUM ada accounting yang
 * benar sejak Phase 2 HANYALAH nasib saldo fee integral (dulu
 * "DEFERRED_PENDING_EIR selamanya" tanpa amortisasi) — itulah yang
 * diselesaikan modul ini, dengan EIR SUNGGUHAN (bukan rate kontrak),
 * dihitung dari SELURUH arus kas kontraktual (pokok+jasa) terhadap
 * initial carrying amount (kas bersih yang diserahkan setelah
 * dipotong fee) — PERSIS metodologi §C/§H. Total pendapatan efektif
 * gabungan (jasa kontraktual existing + amortisasi fee EIR baru)
 * secara ekonomi MENDEKATI hasil EIR penuh, tanpa perlu membongkar
 * subledger Piutang yang sudah stabil.
 */

export interface EirScheduleRow {
  id: string;
  pinjamanId: string;
  periode: string;
  openingUnamortizedFee: Rupiah;
  feeAmortizationIncome: Rupiah;
  closingUnamortizedFee: Rupiah;
  effectiveInterestRate: number;
  remainingTermBulan: number;
  /** null bila ΔA periode ini 0 (unwind fee tepat diimbangi X) — tidak ada jurnal bernilai nol. */
  journalId: string | null;
  /**
   * RC-S54 TAHAP 9 — komponen pengukuran amortized cost periode ini
   * (lihat `bangunJadwalAmortizedCost`). Opsional hanya supaya baris
   * lama yang dibaca ulang (idempotent return) tetap bertipe sama.
   */
  pengukuran?: {
    openingCarryingAmount: number;
    effectiveInterest: number;
    jasaKontraktual: Rupiah;
    arusKas: Rupiah;
    closingCarryingAmount: number;
    /** ΔA = total penyesuaian EIR yang dijurnal (bertanda). */
    penyesuaianEir: Rupiah;
    /** ΔX = penyesuaian bunga efektif akrual (bertanda). */
    penyesuaianAkrual: Rupiah;
  };
}

export const PESAN_TANPA_PENYESUAIAN_EIR = 'Tidak ada penyesuaian EIR untuk periode ini.';

// ============================================================================
// RC-S54 TAHAP 9 — PENGUKURAN AMORTIZED COST (satu sumber kebenaran)
// ============================================================================

/** Selisih hari kalender Actual (date-only string -> UTC midnight). Dipakai builder cashflow DAN jadwal AC. */
export function hariKalender(dari: string, sampai: string): number {
  return Math.round((new Date(sampai).getTime() - new Date(dari).getTime()) / 86400000);
}

export type EirModelErrorCode = 'EIR_JADWAL_TIDAK_KONSISTEN';

export class EirModelError extends Error {
  readonly code: EirModelErrorCode;
  constructor(code: EirModelErrorCode, message: string) {
    super(message);
    this.name = 'EirModelError';
    this.code = code;
  }
}

export interface BarisJadwalKontraktual {
  tanggalJatuhTempo: string;
  pokok: Rupiah;
  jasa: Rupiah;
  total: Rupiah;
}

export interface BarisAmortizedCost {
  tanggalJatuhTempo: string;
  periode: string;
  hari: number;
  openingCarryingAmount: number;
  effectiveInterest: number;
  jasaKontraktual: Rupiah;
  pokok: Rupiah;
  arusKas: Rupiah;
  closingCarryingAmount: number;
  /** Target KUMULATIF (rupiah) sampai baris ini. */
  kumulatifPenyesuaianEir: Rupiah; // A
  kumulatifAmortisasiFee: Rupiah; // F
  kumulatifAkrual: Rupiah; // X = A - F
}

/**
 * Jadwal amortized cost penuh sebuah pinjaman ber-fee integral.
 *
 *   AC_0 = pokok - fee
 *   EI_i = AC_{i-1} × (faktorPeriodeDariRateTahunan(EIR, hari_i) - 1)
 *   AC_i = AC_{i-1} + EI_i - total_i
 *   A_i  = Σ (EI_k - jasa_k)                       penyesuaian EIR kumulatif
 *   F_i  = min(fee, max(0, max_{k<=i} A_k))        unwind fee integral
 *   X_i  = A_i - F_i                               bunga efektif akrual
 *
 * Presisi penuh di dalam; pembulatan rupiah pada target KUMULATIF. Baris
 * terakhir harus memenuhi |A_n - fee| < 1 dan |AC_n| < 1 (identitas
 * aljabar bila Σ pokok = pokok pinjaman) — kalau tidak, jadwal tidak
 * konsisten dengan cashflow solver dan fungsi ini MELEMPAR, tidak memaksa.
 *
 * Fungsi murni: dipakai `prosesEirBulanan`, diagnostik historical gap, dan
 * test — tidak ada salinan rumus di tempat lain.
 */
export function bangunJadwalAmortizedCost(input: {
  jumlahPinjaman: Rupiah;
  feeIntegral: Rupiah;
  tanggalPencairan: string;
  effectiveInterestRate: number;
  jadwal: readonly BarisJadwalKontraktual[];
}): BarisAmortizedCost[] {
  const { feeIntegral: fee } = input;
  if (input.jadwal.length === 0) {
    throw new EirModelError('EIR_JADWAL_TIDAK_KONSISTEN', 'Jadwal kontraktual kosong — amortized cost tidak dapat diukur.');
  }
  let ac = input.jumlahPinjaman - fee;
  let tanggalSebelum = input.tanggalPencairan;
  let a = 0;
  let aMaks = 0;
  const hasil: BarisAmortizedCost[] = [];
  for (let i = 0; i < input.jadwal.length; i++) {
    const r = input.jadwal[i];
    const hari = hariKalender(tanggalSebelum, r.tanggalJatuhTempo);
    if (hari < 0) {
      throw new EirModelError('EIR_JADWAL_TIDAK_KONSISTEN', `Jadwal tidak terurut pada ${r.tanggalJatuhTempo}.`);
    }
    const opening = ac;
    const ei = opening * (faktorPeriodeDariRateTahunan(input.effectiveInterestRate, hari) - 1);
    ac = opening + ei - r.total;
    a += ei - r.jasa;
    aMaks = Math.max(aMaks, a);
    let kumA = Math.round(a);
    let kumF = Math.min(fee, Math.max(0, Math.round(aMaks)));
    if (i === input.jadwal.length - 1) {
      if (Math.abs(a - fee) >= 1 || Math.abs(ac) >= 1) {
        throw new EirModelError(
          'EIR_JADWAL_TIDAK_KONSISTEN',
          `Akhir tenor tidak menutup: penyesuaian kumulatif ${a.toFixed(4)} vs fee ${fee}, carrying amount akhir ${ac.toFixed(4)}. ` +
            'Jadwal kontraktual tidak konsisten dengan cashflow EIR — tidak diposting.'
        );
      }
      kumA = fee;
      kumF = fee;
      ac = 0;
    }
    hasil.push({
      tanggalJatuhTempo: r.tanggalJatuhTempo,
      periode: r.tanggalJatuhTempo.slice(0, 7),
      hari,
      openingCarryingAmount: opening,
      effectiveInterest: ei,
      jasaKontraktual: r.jasa,
      pokok: r.pokok,
      arusKas: r.total,
      closingCarryingAmount: ac,
      kumulatifPenyesuaianEir: kumA,
      kumulatifAmortisasiFee: kumF,
      kumulatifAkrual: kumA - kumF,
    });
    tanggalSebelum = r.tanggalJatuhTempo;
  }
  return hasil;
}

/** Baca input jadwal AC dari database (baris non-obsolete, urut). */
async function bacaJadwalAmortizedCost(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string,
  effectiveInterestRate: number,
  feeIntegral: Rupiah
): Promise<BarisAmortizedCost[]> {
  // Tanggal referensi = tanggal JURNAL PENCAIRAN, sumber yang sama yang
  // dikirim `cairkanPinjaman` ke solver (`tanggalPencairan`). BUKAN
  // `pinjaman.tanggal` (tanggal akad) — keduanya boleh berbeda, dan
  // memakai tanggal akad membuat AC_0 tidak cocok dengan CF0 solver.
  const p = await db.getFirstAsync<{ tanggal: string | null; jumlah_pinjaman: number }>(
    `SELECT j.tanggal AS tanggal, p.jumlah_pinjaman FROM pinjaman p
     LEFT JOIN journal j ON j.id = p.pencairan_journal_id WHERE p.id = ?`,
    pinjamanId
  );
  if (!p) throw new Error('Pinjaman tidak ditemukan.');
  if (!p.tanggal) {
    throw new EirModelError('EIR_JADWAL_TIDAK_KONSISTEN', 'Jurnal pencairan pinjaman tidak ditemukan — tanggal referensi EIR tidak diketahui.');
  }
  const rows = await db.getAllAsync<{ tanggal_jatuh_tempo: string; pokok: number; jasa: number; total: number }>(
    `SELECT aj.tanggal_jatuh_tempo, aj.pokok, aj.jasa, aj.total FROM angsuran_jadwal aj
     WHERE aj.pinjaman_id = ? AND ${sqlJadwalBukanObsolete('aj')}
     ORDER BY aj.nomor_angsuran ASC`,
    pinjamanId
  );
  return bangunJadwalAmortizedCost({
    jumlahPinjaman: p.jumlah_pinjaman,
    feeIntegral,
    tanggalPencairan: p.tanggal,
    effectiveInterestRate,
    jadwal: rows.map((r) => ({ tanggalJatuhTempo: r.tanggal_jatuh_tempo, pokok: r.pokok, jasa: r.jasa, total: r.total })),
  });
}

/** Total yang SUDAH diposting baris EIR_MONTHLY (fee & penyesuaian EIR). */
async function totalEirBulananTerposting(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string
): Promise<{ fee: Rupiah; penyesuaian: Rupiah; periodeTerakhir: string | null }> {
  const row = await db.getFirstAsync<{ fee: number; penyesuaian: number; periode: string | null }>(
    `SELECT COALESCE(SUM(amortisasi_fee),0) fee, COALESCE(SUM(pendapatan_akuntansi),0) penyesuaian,
            MAX(periode_akuntansi) periode
     FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'EIR_MONTHLY' AND status = 'DIAKUI'`,
    pinjamanId
  );
  return { fee: row?.fee ?? 0, penyesuaian: row?.penyesuaian ?? 0, periodeTerakhir: row?.periode ?? null };
}

/**
 * §C/§H: bangun cashflow EIR dari data yang SUDAH ADA — TIDAK
 * menghitung ulang jadwal kontraktual (PinjamanCalculator TIDAK
 * disentuh), murni MEMBACA `angsuran_jadwal` yang sudah tersimpan
 * sejak `cairkanPinjaman()`. hari_i dihitung date-aware (selisih hari
 * kalender SUNGGUHAN dari tanggal pencairan, BUKAN asumsi interval
 * seragam — §H eksplisit).
 */
async function bangunCashFlowKontraktual(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string,
  tanggalPencairan: string,
  initialCarryingAmount: Rupiah
): Promise<EirCashFlow[]> {
  const rows = await db.getAllAsync<{ tanggal_jatuh_tempo: string; total: number }>(
    `SELECT aj.tanggal_jatuh_tempo, aj.total FROM angsuran_jadwal aj
     WHERE aj.pinjaman_id = ? AND ${sqlJadwalBukanObsolete('aj')}
     ORDER BY aj.nomor_angsuran ASC`,
    pinjamanId
  );
  if (rows.length === 0) {
    throw new Error('Tidak ada jadwal angsuran kontraktual untuk pinjaman ini — EIR tidak dapat dihitung.');
  }
  const cashflows: EirCashFlow[] = [{ hari: 0, jumlah: -initialCarryingAmount }];
  for (const r of rows) {
    cashflows.push({ hari: hariKalender(tanggalPencairan, r.tanggal_jatuh_tempo), jumlah: r.total });
  }
  return cashflows;
}

/**
 * §C/§G: INITIAL RECOGNITION — dipanggil SEKALI per pinjaman, idealnya
 * dari `cairkanPinjaman()` saat `biaya_admin_klasifikasi ===
 * 'INTEGRAL_FINANCIAL_INSTRUMENT'` DAN fee > 0 (kalau fee integral =
 * 0, tidak ada apa pun untuk diamortisasi — lihat AA test #1 "zero
 * integral fee": dilewati, `eir_measurement_status` tetap
 * 'NOT_APPLICABLE', BUKAN error). Menghitung EIR SUNGGUHAN via
 * `solveEffectiveInterestRate` (§AC: TIDAK ADA fallback kalau gagal
 * konvergen — error dilempar apa adanya, transaksi pemanggil harus
 * rollback), lalu MENYIMPAN rate tsb (§AD: cache/persist, bukan
 * dihitung ulang tiap kali) di baris FEE_INTEGRAL_AMORTISASI yang
 * SUDAH dibuat `catatFeeIntegralPendingEir` (Phase 2) — TIDAK membuat
 * baris/tabel baru untuk menyimpan rate itu sendiri, extend yang
 * sudah ada (§Z).
 */
export async function inisiasiEirPinjaman(
  db: SQLite.SQLiteDatabase,
  params: { pinjamanId: string; tanggalPencairan: string; jumlahPinjaman: Rupiah; feeIntegral: Rupiah }
): Promise<{ diaktifkan: boolean; effectiveInterestRate?: number }> {
  if (params.feeIntegral <= 0) {
    await db.runAsync(`UPDATE pinjaman SET eir_measurement_status = 'NOT_APPLICABLE' WHERE id = ?`, params.pinjamanId);
    return { diaktifkan: false };
  }

  const initialCarryingAmount = params.jumlahPinjaman - params.feeIntegral;
  const cashflows = await bangunCashFlowKontraktual(db, params.pinjamanId, params.tanggalPencairan, initialCarryingAmount);

  // §AC/§I: TIDAK ADA try/catch yang menelan error di sini — kalau
  // solver gagal konvergen, error dilempar APA ADANYA ke pemanggil
  // (cairkanPinjaman, di dalam withTransaction yang sama) supaya
  // SELURUH transaksi pencairan rollback (§I: "FAIL transaksi").
  const hasil = solveEffectiveInterestRate(cashflows);

  await db.runAsync(
    `UPDATE pinjaman_akuntansi_jasa
     SET effective_interest_rate = ?, remaining_term_bulan = ?
     WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
    hasil.rateTahunan,
    cashflows.length - 1,
    params.pinjamanId
  );
  await db.runAsync(`UPDATE pinjaman SET eir_measurement_status = 'MEASURED' WHERE id = ?`, params.pinjamanId);

  return { diaktifkan: true, effectiveInterestRate: hasil.rateTahunan };
}

/**
 * Ambil EIR yang SUDAH tersimpan (§AD — TIDAK menghitung ulang).
 * Return `null` kalau pinjaman ini tidak/tidak lagi di bawah
 * pengukuran EIR (NOT_APPLICABLE/EIR_NOT_MIGRATED/DERECOGNIZED).
 */
export async function getEirTersimpan(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string
): Promise<{ rate: number; sisaFeeBelumDiamortisasi: Rupiah; penyesuaianAkrual: Rupiah } | null> {
  const pinjaman = await db.getFirstAsync<{ eir_measurement_status: string }>(`SELECT eir_measurement_status FROM pinjaman WHERE id = ?`, pinjamanId);
  if (!pinjaman || (pinjaman.eir_measurement_status !== 'MEASURED' && pinjaman.eir_measurement_status !== 'PENDING_RESTRUCTURING_EIR_REVIEW')) {
    return null;
  }
  const row = await db.getFirstAsync<{ effective_interest_rate: number | null; saldo_akhir_carrying: number }>(
    `SELECT effective_interest_rate, saldo_akhir_carrying
     FROM pinjaman_akuntansi_jasa
     WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
    pinjamanId
  );
  if (!row || row.effective_interest_rate === null) return null;

  // RC-S54 TAHAP 9: fee yang ter-unwind dibaca dari `amortisasi_fee`
  // (komponen fee), BUKAN `pendapatan_akuntansi` (total penyesuaian EIR,
  // yang juga memuat bunga efektif akrual X). Baris lama menulis kedua
  // kolom dengan nilai sama, jadi pembacaan ini kompatibel mundur.
  const terposting = await totalEirBulananTerposting(db, pinjamanId);
  const sisaFee = Math.max(0, row.saldo_akhir_carrying - terposting.fee);
  return {
    rate: row.effective_interest_rate,
    sisaFeeBelumDiamortisasi: sisaFee,
    penyesuaianAkrual: terposting.penyesuaian - terposting.fee,
  };
}

/**
 * RC-S54 TAHAP 9 — PENGAKUAN PERIODIK BERBASIS AMORTIZED COST.
 *
 * Satu periode (YYYY-MM) = seluruh baris jadwal non-obsolete yang jatuh
 * tempo di bulan itu. Posting = selisih target KUMULATIF
 * (`bangunJadwalAmortizedCost`) sampai baris terakhir periode itu dikurangi
 * yang sudah diposting. Karena kumulatif:
 *   - periode yang terlewat (non-accrual sementara, app tidak dibuka) ikut
 *     tertutup pada posting berikutnya tanpa double count;
 *   - pembulatan tidak menumpuk;
 *   - periode terakhir hanya membawa residual pembulatan, bukan sisa fee.
 *
 * Idempoten: existence check (loan + periode + EIR_MONTHLY) lalu UNIQUE
 * `idempotency_key` sebagai lapis kedua. Periode yang lebih awal dari
 * periode terakhir yang sudah diposting DITOLAK (sudah tercakup).
 *
 * Periode baru boleh diproses bila SELURUH jatuh temponya ≤ tanggalLaporan
 * — jurnal tidak pernah bertanggal masa depan. Periode tertutup ditolak
 * `createJournal` (ClosedPeriodError) dan error dilempar apa adanya.
 */
export async function prosesEirBulanan(params: {
  pinjamanId: string;
  periode: string;
  createdBy: string;
  tanggalLaporan?: string;
  /** Hanya untuk orkestrator internal `jalankanEirOtomatisJikaPerlu` (pola sama dengan akrual jasa/penyusutan). */
  systemTrigger?: boolean;
}): Promise<{ dibuat: boolean; row: EirScheduleRow | null; dilewati?: string }> {
  if (!isValidPeriode(params.periode)) throw new Error('Format periode tidak valid (harus YYYY-MM).');

  return withTransaction(async (db) => {
    await requirePermissionAtauSystemTrigger(db, params.createdBy, 'pinjaman', 'edit', params.systemTrigger ?? false);

    // Lapis 1: existence check.
    const existing = await db.getFirstAsync<any>(
      `SELECT paj.*, j.nomor_jurnal FROM pinjaman_akuntansi_jasa paj
       LEFT JOIN journal j ON j.id = paj.journal_id
       WHERE paj.pinjaman_id = ? AND paj.periode_akuntansi = ? AND paj.tipe_pengakuan = 'EIR_MONTHLY'`,
      params.pinjamanId,
      params.periode
    );
    if (existing) {
      return {
        dibuat: false,
        row: {
          id: existing.id,
          pinjamanId: existing.pinjaman_id,
          periode: existing.periode_akuntansi,
          openingUnamortizedFee: existing.saldo_awal_carrying,
          feeAmortizationIncome: existing.amortisasi_fee,
          closingUnamortizedFee: existing.saldo_akhir_carrying,
          effectiveInterestRate: existing.effective_interest_rate,
          remainingTermBulan: existing.remaining_term_bulan,
          journalId: existing.journal_id,
        },
      };
    }

    const pinjaman = await db.getFirstAsync<any>(`SELECT * FROM pinjaman WHERE id = ?`, params.pinjamanId);
    if (!pinjaman) throw new Error('Pinjaman tidak ditemukan.');
    if (pinjaman.status !== 'AKTIF') {
      return { dibuat: false, row: null, dilewati: `Pinjaman berstatus "${pinjaman.status}", tidak diamortisasi.` };
    }
    if (pinjaman.eir_measurement_status !== 'MEASURED') {
      return { dibuat: false, row: null, dilewati: `Pinjaman tidak di bawah pengukuran EIR (status: ${pinjaman.eir_measurement_status}).` };
    }

    // §U: non-accrual — REUSE policy Phase 2, TIDAK membuat threshold baru.
    const { getKlasifikasiPinjamanAktif } = await import('@/services/LoanImpairmentService');
    const { getNonAccrualMinHariTunggakan } = await import('@/services/AccountingPolicyService');
    const tanggalLaporan = params.tanggalLaporan ?? getTanggalLokalHariIni();
    const klasifikasi = await getKlasifikasiPinjamanAktif(db, { tanggalLaporan, statusAnggota: 'SEMUA' });
    const info = klasifikasi.find((k) => k.pinjamanId === params.pinjamanId);
    const hariTunggakan = info?.hariTunggakan ?? 0;
    const ambangHariNonAccrual = await getNonAccrualMinHariTunggakan();
    if (isNonAccrual(hariTunggakan, ambangHariNonAccrual)) {
      return {
        dibuat: false,
        row: null,
        dilewati:
          alasanNonAccrual(hariTunggakan, ambangHariNonAccrual) +
          ' Amortisasi fee EIR ikut dihentikan — konsisten dengan kebijakan non-accrual terpusat.',
      };
    }

    const periodeSaatIni = toPeriode(tanggalLaporan);
    if (params.periode > periodeSaatIni) {
      return { dibuat: false, row: null, dilewati: `Periode ${params.periode} belum berjalan.` };
    }

    const feeRow = await db.getFirstAsync<any>(
      `SELECT * FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
      params.pinjamanId
    );
    if (!feeRow || feeRow.effective_interest_rate === null) {
      return { dibuat: false, row: null, dilewati: 'EIR belum diinisiasi untuk pinjaman ini.' };
    }
    const feeAwal: Rupiah = feeRow.saldo_akhir_carrying;
    const rate: number = feeRow.effective_interest_rate;

    const terposting = await totalEirBulananTerposting(db, params.pinjamanId);
    if (terposting.periodeTerakhir !== null && terposting.periodeTerakhir > params.periode) {
      return {
        dibuat: false,
        row: null,
        dilewati: `Periode ${params.periode} sudah tercakup posting kumulatif periode ${terposting.periodeTerakhir}.`,
      };
    }

    const jadwalAc = await bacaJadwalAmortizedCost(db, params.pinjamanId, rate, feeAwal);
    const barisPeriode = jadwalAc.filter((b) => b.periode === params.periode);
    if (barisPeriode.length === 0) {
      return { dibuat: false, row: null, dilewati: 'Tidak ada jadwal kontraktual jatuh tempo pada periode ini.' };
    }
    const barisAkhir = barisPeriode[barisPeriode.length - 1];
    if (barisAkhir.tanggalJatuhTempo > tanggalLaporan) {
      return {
        dibuat: false,
        row: null,
        dilewati: `Jatuh tempo periode ${params.periode} (${barisAkhir.tanggalJatuhTempo}) belum tercapai per ${tanggalLaporan}.`,
      };
    }

    const deltaFee = barisAkhir.kumulatifAmortisasiFee - terposting.fee;
    const deltaPenyesuaian = barisAkhir.kumulatifPenyesuaianEir - terposting.penyesuaian;
    if (deltaFee < 0) {
      // Mustahil bila F monoton & jadwal tidak berubah; kalau terjadi,
      // data diposting dari jadwal lain — tolak, jangan paksa.
      throw new EirModelError(
        'EIR_JADWAL_TIDAK_KONSISTEN',
        `Fee terposting (${terposting.fee}) melebihi target kumulatif (${barisAkhir.kumulatifAmortisasiFee}) pada periode ${params.periode}.`
      );
    }
    if (deltaFee === 0 && deltaPenyesuaian === 0) {
      return { dibuat: false, row: null, dilewati: PESAN_TANPA_PENYESUAIAN_EIR };
    }

    const openingUnamortizedFee = feeAwal - terposting.fee;
    const closingUnamortizedFee = openingUnamortizedFee - deltaFee;
    const tanggalJurnal = barisAkhir.tanggalJatuhTempo;
    const year = new Date(tanggalJurnal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'EIR', year);

    let journalId: string | null = null;
    if (deltaPenyesuaian !== 0) {
      // Mapping existing EIR_FEE_AMORTIZATION (2-1300 & 4-1000). Arah
      // dibalik untuk penyesuaian negatif — pola existing (akun ditentukan
      // role, arah ditentukan tanda), tidak ada akun/tipe transaksi baru.
      const dimukaAccountId = await resolveAccountId(db, 'EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA');
      const pendapatanAccountId = await resolveAccountId(db, 'EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN');
      const nilai = Math.abs(deltaPenyesuaian);
      const positif = deltaPenyesuaian > 0;
      const hasilJurnal = await createJournal(db, {
        tanggal: tanggalJurnal,
        sumberTransaksi: 'EIR_FEE_AMORTIZATION',
        sumberId: pinjaman.id,
        nomorReferensi: nomorTransaksi,
        deskripsi:
          `Penyesuaian EIR (amortized cost) pinjaman ${pinjaman.nomor_pinjaman} periode ${params.periode} - ${nomorTransaksi}` +
          ` [fee ${deltaFee}, akrual ${deltaPenyesuaian - deltaFee}]`,
        createdBy: params.createdBy,
        lines: [
          { accountId: dimukaAccountId, debit: positif ? nilai : 0, kredit: positif ? 0 : nilai },
          { accountId: pendapatanAccountId, debit: positif ? 0 : nilai, kredit: positif ? nilai : 0 },
        ],
      });
      journalId = hasilJurnal.journalId;
    }

    const id = newId();
    const now = new Date().toISOString();
    const idempotencyKey = `${params.pinjamanId}:${params.periode}:EIR_MONTHLY`;
    const remainingTermBulan = Math.max(0, (feeRow.remaining_term_bulan ?? 0) - (await hitungPeriodeEirSudahBerjalan(db, params.pinjamanId)) - 1);

    await db.runAsync(
      `INSERT INTO pinjaman_akuntansi_jasa
        (id, pinjaman_id, jadwal_id, periode_akuntansi, tipe_pengakuan, saldo_awal_carrying,
         pendapatan_akuntansi, kas_diterima, amortisasi_fee, saldo_akhir_carrying, status,
         journal_id, idempotency_key, created_by, created_at, updated_at,
         effective_interest_rate, remaining_term_bulan, principal_component)
       VALUES (?,?,?,?, 'EIR_MONTHLY', ?,?,0,?,?,'DIAKUI',?,?,?,?,?, ?,?,0)`,
      id,
      params.pinjamanId,
      null,
      params.periode,
      openingUnamortizedFee,
      deltaPenyesuaian,
      deltaFee,
      closingUnamortizedFee,
      journalId,
      idempotencyKey,
      params.createdBy,
      now,
      now,
      rate,
      remainingTermBulan
    );

    if (closingUnamortizedFee === 0) {
      await db.runAsync(
        `UPDATE pinjaman_akuntansi_jasa SET fee_lifecycle_status = 'AMORTIZED' WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
        params.pinjamanId
      );
    }

    return {
      dibuat: true,
      row: {
        id,
        pinjamanId: params.pinjamanId,
        periode: params.periode,
        openingUnamortizedFee,
        feeAmortizationIncome: deltaFee,
        closingUnamortizedFee,
        effectiveInterestRate: rate,
        remainingTermBulan,
        journalId,
        pengukuran: {
          openingCarryingAmount: barisPeriode[0].openingCarryingAmount,
          effectiveInterest: barisPeriode.reduce((t, b) => t + b.effectiveInterest, 0),
          jasaKontraktual: barisPeriode.reduce((t, b) => t + b.jasaKontraktual, 0),
          arusKas: barisPeriode.reduce((t, b) => t + b.arusKas, 0),
          closingCarryingAmount: barisAkhir.closingCarryingAmount,
          penyesuaianEir: deltaPenyesuaian,
          penyesuaianAkrual: deltaPenyesuaian - deltaFee,
        },
      },
    };
  });
}

async function hitungPeriodeEirSudahBerjalan(db: SQLite.SQLiteDatabase, pinjamanId: string): Promise<number> {
  const row = await db.getFirstAsync<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'EIR_MONTHLY' AND status = 'DIAKUI'`,
    pinjamanId
  );
  return row?.cnt ?? 0;
}

/**
 * §R/§T: DERECOGNITION — dipanggil saat pinjaman ber-EIR dilunasi
 * dipercepat ATAU dihapusbukukan. Menyelesaikan SISA fee yang belum
 * teramortisasi SEKALIGUS (bukan dibiarkan DEFERRED_PENDING_EIR
 * selamanya, §R eksplisit) via journal derecognition TUNGGAL —
 * SELURUH sisa diakui sebagai pendapatan pada tanggal derecognition
 * (§R: "instrumen dihentikan" -> tidak ada lagi periode masa depan
 * untuk mengamortisasi bertahap, jadi wajar diakui sekaligus saat
 * itu, BUKAN gain/loss yang dikarang ke akun baru — tetap akun
 * Pendapatan Jasa Pinjaman yang SAMA, §K).
 *
 * FUNGSI INI BERDIRI SENDIRI, TERUJI, TAPI SENGAJA BELUM DIPANGGIL
 * OTOMATIS dari `lunasiPinjaman()`/`hapusPiutangPinjaman()` (Phase
 * 3/4) — KETERBATASAN YANG DIDOKUMENTASIKAN EKSPLISIT di laporan
 * akhir Phase 7, BUKAN disembunyikan: mengintegrasikannya otomatis
 * berarti mengubah fungsi Phase 3/4 yang sudah stabil & teruji, yang
 * secara eksplisit dilarang instruksi (§AG, "jangan merusak Phase
 * 3 write-off/restructuring, Phase 4 settlement"). Operator dapat
 * memanggil fungsi ini secara eksplisit segera setelah pelunasan/
 * write-off pinjaman ber-EIR untuk menyelesaikan saldo fee-nya.
 */
/**
 * PHASE 7 FINAL FIX (permintaan pengguna §1/§2) — versi INTI yang bisa
 * dipanggil DI DALAM transaction yang SUDAH BERJALAN (menerima `db`
 * langsung, TIDAK membuka `withTransaction` sendiri) — dipakai
 * `lunasiPinjaman()`/`hapusPiutangPinjaman()` (Phase 4/3) supaya
 * derecognition fee EIR menjadi BAGIAN ATOMIC dari satu transaksi
 * settlement/write-off yang sama (§1/§2: "flow harus menjadi atomic...
 * kalau salah satu gagal, ROLLBACK semuanya" — tidak mungkin tercapai
 * kalau derecognition membuka transaction-nya sendiri secara terpisah).
 * Fungsi publik `deselesaikanFeeEirSaatDerecognition` di bawah HANYA
 * pembungkus tipis (`withTransaction`) di atas fungsi ini, untuk
 * pemanggilan MANUAL/standalone yang masih didukung (mis. dari test).
 *
 * §3: idempotent — kalau pinjaman TIDAK/tidak lagi 'MEASURED' (sudah
 * pernah di-derecognize sebelumnya, atau memang tidak pernah EIR),
 * TIDAK melakukan apa pun & TIDAK melempar error (no-op aman untuk
 * dipanggil dari flow settlement/write-off manapun tanpa perlu
 * pengecekan tambahan di pemanggil).
 */
export async function deselesaikanFeeEirDiDalamTransaksi(
  db: SQLite.SQLiteDatabase,
  params: { pinjamanId: string; tanggal: string; /**
   * BUG-03: 'PELUNASAN_ANGSURAN_TERAKHIR' ditambahkan untuk jalur
   * pelunasan NORMAL (angsuran terakhir dibayar biasa lewat
   * `bayarAngsuran`). Sebelumnya jalur itu tidak pernah men-derecognize
   * sisa fee, sehingga fee tersangkut permanen di 2-1300 karena
   * `prosesEirBulanan` menolak pinjaman non-AKTIF.
   *
   * Alasan ikut masuk ke `idempotency_key`, jadi menambah nilai baru
   * TIDAK melonggarkan proteksi duplikasi yang sudah ada.
   */
  alasan: 'PELUNASAN_DIPERCEPAT' | 'PELUNASAN_ANGSURAN_TERAKHIR' | 'WRITE_OFF'; createdBy: string }
): Promise<HasilDerecognitionEir> {
  const pinjaman = await db.getFirstAsync<any>(`SELECT * FROM pinjaman WHERE id = ?`, params.pinjamanId);
  if (!pinjaman) throw new Error('Pinjaman tidak ditemukan.');
  if (pinjaman.eir_measurement_status !== 'MEASURED') {
    // §8/§9: no-op aman — bukan pinjaman ber-EIR (NOT_APPLICABLE/
    // EIR_NOT_MIGRATED), atau SUDAH di-derecognize sebelumnya
    // (DERECOGNIZED), atau sedang PENDING_RESTRUCTURING_EIR_REVIEW
    // (§7: JANGAN melakukan fake recalculation di sini — biarkan
    // review restrukturisasi yang menentukan, derecognition normal
    // tidak berlaku untuk status ini).
    return { diselesaikan: false, jumlahDiakui: 0, journalId: null, penyesuaianAkrualDibalik: 0, pendapatanBersih: 0 };
  }

  const eir = await getEirTersimpan(db, params.pinjamanId);
  if (!eir || (eir.sisaFeeBelumDiamortisasi <= 0 && eir.penyesuaianAkrual === 0)) {
    await db.runAsync(`UPDATE pinjaman SET eir_measurement_status = 'DERECOGNIZED' WHERE id = ?`, params.pinjamanId);
    await db.runAsync(
      `UPDATE pinjaman_akuntansi_jasa SET fee_lifecycle_status = 'DERECOGNIZED' WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
      params.pinjamanId
    );
    return { diselesaikan: true, jumlahDiakui: 0, journalId: null, penyesuaianAkrualDibalik: 0, pendapatanBersih: 0 };
  }

  // RC-S54 TAHAP 9: yang dilepas adalah SELURUH saldo komponen EIR di
  // 2-1300 untuk pinjaman ini, D = sisaFee - X (bertanda). sisaFee dan X
  // dicatat terpisah di subledger (amortisasi_fee vs pendapatan_akuntansi).
  const jumlahDiakui = eir.sisaFeeBelumDiamortisasi;
  const penyesuaianAkrualDibalik = eir.penyesuaianAkrual;
  const pendapatanBersih = jumlahDiakui - penyesuaianAkrualDibalik;
  const dimukaAccountId = await resolveAccountId(db, 'EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA');
  const pendapatanAccountId = await resolveAccountId(db, 'EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN');
  const year = new Date(params.tanggal).getFullYear();
  const nomorTransaksi = await nextSequence(db, 'EIRD', year);

  // §4/§14: HANYA sisa fee integral yang benar-benar belum
  // teramortisasi yang diselesaikan di sini — TIDAK PERNAH future
  // contractual jasa (angsuran_jadwal SAMA SEKALI tidak dibaca/
  // disentuh fungsi ini).
  let journalId: string | null = null;
  if (pendapatanBersih !== 0) {
    const nilai = Math.abs(pendapatanBersih);
    const positif = pendapatanBersih > 0;
    const hasilJurnal = await createJournal(db, {
      tanggal: params.tanggal,
      sumberTransaksi: 'EIR_FEE_AMORTIZATION',
      sumberId: pinjaman.id,
      nomorReferensi: nomorTransaksi,
      deskripsi:
        `Derecognition sisa fee integral pinjaman ${pinjaman.nomor_pinjaman} (${params.alasan}) - ${nomorTransaksi}` +
        (penyesuaianAkrualDibalik !== 0 ? ` [fee ${jumlahDiakui}, akrual dibalik ${penyesuaianAkrualDibalik}]` : ''),
      createdBy: params.createdBy,
      lines: [
        { accountId: dimukaAccountId, debit: positif ? nilai : 0, kredit: positif ? 0 : nilai },
        { accountId: pendapatanAccountId, debit: positif ? 0 : nilai, kredit: positif ? nilai : 0 },
      ],
    });
    journalId = hasilJurnal.journalId;
  }

  const now = new Date().toISOString();
  const periode = toPeriode(params.tanggal);
  // §AB FIX (permintaan pengguna): baris ini memakai tipe_pengakuan
  // 'EIR_DERECOGNITION', BUKAN 'EIR_MONTHLY'. Alasannya: derecognition
  // sisa fee saat pelunasan dipercepat/write-off adalah PERISTIWA
  // AKUNTANSI YANG BERBEDA dari amortisasi bulanan, dan memakai tipe
  // yang sama membuatnya menabrak UNIQUE(pinjaman_id,
  // periode_akuntansi, tipe_pengakuan) setiap kali amortisasi bulanan
  // untuk periode yang SAMA sudah pernah diakui (mis. prosesEirBulanan
  // periode 2026-04 lalu settlement 2026-04-20) — transaksi settlement
  // ikut rollback padahal tidak ada yang salah secara akuntansi.
  // UNIQUE constraint TIDAK dihapus: sekarang justru melindungi kedua
  // peristiwa secara terpisah (maksimal satu amortisasi bulanan DAN
  // maksimal satu derecognition per pinjaman per periode).
  //
  // §8/§9: idempotency lapis kedua — idempotency_key GLOBAL UNIQUE
  // menyertakan `alasan` supaya SATU pinjaman tidak bisa
  // di-derecognize dua kali dengan alasan yang sama (kalau baris ini
  // sudah ada, INSERT gagal & transaksi PEMANGGIL — lunasiPinjaman/
  // hapusPiutangPinjaman — rollback total, bukan cuma bagian ini).
  await db.runAsync(
    `INSERT INTO pinjaman_akuntansi_jasa
      (id, pinjaman_id, jadwal_id, periode_akuntansi, tipe_pengakuan, saldo_awal_carrying,
       pendapatan_akuntansi, kas_diterima, amortisasi_fee, saldo_akhir_carrying, status,
       journal_id, idempotency_key, created_by, created_at, updated_at, effective_interest_rate, remaining_term_bulan, principal_component)
     VALUES (?,?,?,?, 'EIR_DERECOGNITION', ?,?,0,?,0,'DIAKUI',?,?,?,?,?, ?,0,0)`,
    newId(),
    params.pinjamanId,
    null,
    periode,
    jumlahDiakui,
    pendapatanBersih,
    jumlahDiakui,
    journalId,
    `${params.pinjamanId}:${periode}:EIR_DERECOGNITION:${params.alasan}`,
    params.createdBy,
    now,
    now,
    eir.rate
  );

  // §5/§11: liabilitas Pendapatan Diterima Dimuka & carrying amount
  // fee DITUTUP — TIDAK ADA DEFERRED_PENDING_EIR yang tersisa untuk
  // pinjaman yang sudah LUNAS/write-off.
  await db.runAsync(`UPDATE pinjaman SET eir_measurement_status = 'DERECOGNIZED' WHERE id = ?`, params.pinjamanId);
  await db.runAsync(
    `UPDATE pinjaman_akuntansi_jasa SET fee_lifecycle_status = 'DERECOGNIZED' WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
    params.pinjamanId
  );

  return { diselesaikan: true, jumlahDiakui, journalId, penyesuaianAkrualDibalik, pendapatanBersih };
}

export interface HasilDerecognitionEir {
  diselesaikan: boolean;
  /** Sisa FEE integral yang diselesaikan (komponen fee). */
  jumlahDiakui: Rupiah;
  journalId: string | null;
  /** RC-S54 TAHAP 9: penyesuaian bunga efektif akrual (X) yang dibalik. */
  penyesuaianAkrualDibalik: Rupiah;
  /** Dampak bersih ke 4-1000 = jumlahDiakui - penyesuaianAkrualDibalik. */
  pendapatanBersih: Rupiah;
}

/**
 * §R/§T Phase 7 (versi standalone/manual — tetap didukung untuk
 * pemanggilan eksplisit/test): pembungkus tipis `withTransaction` di
 * atas `deselesaikanFeeEirDiDalamTransaksi`. SEJAK FINAL FIX ini,
 * pemanggilan manual TIDAK LAGI diperlukan pada flow normal —
 * `lunasiPinjaman()`/`hapusPiutangPinjaman()` sudah memanggil versi
 * inti secara otomatis di dalam transaksi masing-masing (§1: "JANGAN
 * meminta caller/UI memanggil helper secara manual").
 */
export async function deselesaikanFeeEirSaatDerecognition(params: {
  pinjamanId: string;
  tanggal: string;
  /**
   * BUG-03: 'PELUNASAN_ANGSURAN_TERAKHIR' ditambahkan untuk jalur
   * pelunasan NORMAL (angsuran terakhir dibayar biasa lewat
   * `bayarAngsuran`). Sebelumnya jalur itu tidak pernah men-derecognize
   * sisa fee, sehingga fee tersangkut permanen di 2-1300 karena
   * `prosesEirBulanan` menolak pinjaman non-AKTIF.
   *
   * Alasan ikut masuk ke `idempotency_key`, jadi menambah nilai baru
   * TIDAK melonggarkan proteksi duplikasi yang sudah ada.
   */
  alasan: 'PELUNASAN_DIPERCEPAT' | 'PELUNASAN_ANGSURAN_TERAKHIR' | 'WRITE_OFF';
  createdBy: string;
}): Promise<HasilDerecognitionEir> {
  return withTransaction(async (db) => {
    await requirePermission(db, params.createdBy, 'pinjaman', 'edit');
    return deselesaikanFeeEirDiDalamTransaksi(db, params);
  });
}

/**
 * §S: RESTRUKTURISASI — ditandai `PENDING_RESTRUCTURING_EIR_REVIEW`
 * (BUKAN dihitung ulang otomatis — modification accounting
 * memerlukan keputusan kebijakan tambahan yang tidak dibuat sepihak
 * di sini, persis anjuran instruksi). Dipanggil dari
 * `akadUlangPinjaman()` (Phase 3) HANYA untuk pinjaman yang
 * eir_measurement_status='MEASURED' — perubahan MINIMAL, satu UPDATE
 * status, TIDAK mengubah logic akad ulang itu sendiri.
 */
export async function tandaiEirPendingRestrukturisasi(db: SQLite.SQLiteDatabase, pinjamanId: string): Promise<void> {
  const pinjaman = await db.getFirstAsync<{ eir_measurement_status: string }>(`SELECT eir_measurement_status FROM pinjaman WHERE id = ?`, pinjamanId);
  if (pinjaman?.eir_measurement_status === 'MEASURED') {
    await db.runAsync(`UPDATE pinjaman SET eir_measurement_status = 'PENDING_RESTRUCTURING_EIR_REVIEW' WHERE id = ?`, pinjamanId);
    await db.runAsync(
      `UPDATE pinjaman_akuntansi_jasa SET fee_lifecycle_status = 'PENDING_RESTRUCTURING_EIR_REVIEW' WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
      pinjamanId
    );
  }
}

// ============================================================================
// RC-S54 TAHAP 9 — ORKESTRASI PRODUKSI (keputusan D)
// ============================================================================

/**
 * Batas awal pemrosesan otomatis. Ditulis SEKALI (INSERT OR IGNORE) saat
 * orkestrator pertama kali berjalan pada suatu instalasi. Periode jatuh
 * tempo SEBELUM batas ini yang belum pernah diposting adalah celah historis
 * — tidak diposting otomatis (Bagian I), hanya dilaporkan.
 */
export const CONFIG_KEY_EIR_OTOMATIS_MULAI_PERIODE = 'EIR_OTOMATIS_MULAI_PERIODE';

export interface EirHistoricalGap {
  kode: 'EIR_HISTORICAL_GAP';
  pinjamanId: string;
  nomorPinjaman: string;
  /** Periode jatuh tempo < batas otomatis yang belum pernah diposting. */
  periode: readonly string[];
  /** Target kumulatif penyesuaian EIR sampai periode celah terakhir (rupiah). */
  expected: Rupiah;
  /** Penyesuaian EIR yang sudah diposting (baris EIR_MONTHLY). */
  actual: Rupiah;
  /** Dampak jurnal bila dikoreksi: expected - actual (Dr 2-1300 / Cr 4-1000 bila positif). */
  potensiDampakJurnal: Rupiah;
}

export interface HasilEirOtomatis {
  dijalankan: boolean;
  tanggalLaporan: string;
  batasOtomatis: string | null;
  diproses: { pinjamanId: string; periode: string; journalId: string | null }[];
  dilewati: { pinjamanId: string; periode: string; alasan: string }[];
  gagal: { pinjamanId: string; periode: string | null; alasan: string }[];
  historicalGap: EirHistoricalGap[];
}

let hasilEirOtomatisTerakhir: HasilEirOtomatis | null = null;

/** Hasil orkestrasi terakhir di sesi aplikasi ini — untuk diagnostik (bukan untuk mengulang posting). */
export function getHasilEirOtomatisTerakhir(): HasilEirOtomatis | null {
  return hasilEirOtomatisTerakhir;
}

async function ambilAtauTetapkanBatasOtomatis(db: SQLite.SQLiteDatabase, periodeSekarang: string): Promise<string> {
  await db.runAsync(
    `INSERT OR IGNORE INTO app_config (key, value, updated_at) VALUES (?,?,?)`,
    CONFIG_KEY_EIR_OTOMATIS_MULAI_PERIODE,
    periodeSekarang,
    new Date().toISOString()
  );
  const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM app_config WHERE key = ?`, CONFIG_KEY_EIR_OTOMATIS_MULAI_PERIODE);
  if (!row || !isValidPeriode(row.value)) {
    throw new Error(`Konfigurasi ${CONFIG_KEY_EIR_OTOMATIS_MULAI_PERIODE} tidak valid.`);
  }
  return row.value;
}

/**
 * SATU-SATUNYA pintu pemrosesan EIR otomatis. Dipanggil `StartupTasks`
 * (berurutan, dirantai — tidak pernah paralel). Tidak ada layar yang
 * memanggil `prosesEirBulanan` sendiri.
 *
 * Per pinjaman AKTIF + MEASURED:
 *   - kandidat = periode jatuh tempo (≤ tanggalLaporan) yang lebih baru
 *     dari periode EIR_MONTHLY terakhir;
 *   - ada kandidat < batas otomatis → EIR_HISTORICAL_GAP, pinjaman dilewati;
 *   - selain itu diproses urut; berhenti pada dilewati/gagal pertama
 *     pinjaman itu (posting kumulatif harus berurutan), lanjut ke pinjaman
 *     lain.
 * Kegagalan dilaporkan (pinjaman, periode, alasan) — tidak ditelan.
 */
export async function jalankanEirOtomatisJikaPerlu(
  createdBy: string,
  // RC-S94 — default = JAM APLIKASI (`getWaktuSekarang`), BUKAN `new Date()`.
  // Dengan `new Date()`, fungsi ini — yang dipanggil StartupTasks TANPA
  // argumen — mengabaikan Mode Pengujian Waktu: setelah developer
  // melompatkan "hari ini", periode yang sudah jatuh tempo menurut jam
  // simulasi tidak pernah diproses (mis. jasa diterima di muka tidak
  // pernah pindah ke Laporan Hasil Usaha). Saat mode pengujian MATI,
  // `getWaktuSekarang()` PERSIS `new Date()`, jadi perilaku produksi tidak
  // berubah. Tanggal eksplisit dari pemanggil (test) tetap dihormati.
  tanggalSekarang: Date = getWaktuSekarang()
): Promise<HasilEirOtomatis> {
  const tanggalLaporan = toTanggalLokal(tanggalSekarang);
  const hasil: HasilEirOtomatis = {
    dijalankan: false,
    tanggalLaporan,
    batasOtomatis: null,
    diproses: [],
    dilewati: [],
    gagal: [],
    historicalGap: [],
  };
  try {
    const db = await getDb();
    const batas = await ambilAtauTetapkanBatasOtomatis(db, toPeriode(tanggalLaporan));
    hasil.batasOtomatis = batas;
    hasil.dijalankan = true;

    const pinjamanRows = await db.getAllAsync<{ id: string; nomor_pinjaman: string }>(
      `SELECT id, nomor_pinjaman FROM pinjaman
       WHERE status = 'AKTIF' AND eir_measurement_status = 'MEASURED'
       ORDER BY id ASC`
    );

    for (const p of pinjamanRows) {
      let periodeBerjalan: string | null = null;
      try {
        const terposting = await totalEirBulananTerposting(db, p.id);
        const kandidat = (
          await db.getAllAsync<{ periode: string }>(
            `SELECT DISTINCT substr(aj.tanggal_jatuh_tempo,1,7) AS periode FROM angsuran_jadwal aj
             WHERE aj.pinjaman_id = ? AND aj.tanggal_jatuh_tempo <= ? AND ${sqlJadwalBukanObsolete('aj')}
             ORDER BY periode ASC`,
            p.id,
            tanggalLaporan
          )
        )
          .map((r) => r.periode)
          .filter((per) => terposting.periodeTerakhir === null || per > terposting.periodeTerakhir);

        const celah = kandidat.filter((per) => per < batas);
        if (celah.length > 0) {
          hasil.historicalGap.push(await diagnosaCelahHistoris(db, p.id, p.nomor_pinjaman, celah, terposting.penyesuaian));
          continue;
        }

        for (const periode of kandidat) {
          periodeBerjalan = periode;
          const r = await prosesEirBulanan({ pinjamanId: p.id, periode, createdBy, tanggalLaporan, systemTrigger: true });
          if (r.dibuat) {
            hasil.diproses.push({ pinjamanId: p.id, periode, journalId: r.row?.journalId ?? null });
          } else {
            hasil.dilewati.push({ pinjamanId: p.id, periode, alasan: r.dilewati ?? 'Sudah diposting.' });
            // Periode dengan penyesuaian nol aman dilanjutkan; alasan lain
            // (non-accrual, status) menghentikan pinjaman ini.
            if (r.dilewati !== PESAN_TANPA_PENYESUAIAN_EIR) break;
          }
        }
      } catch (e) {
        hasil.gagal.push({
          pinjamanId: p.id,
          periode: periodeBerjalan,
          alasan: e instanceof Error ? `${e.name}: ${e.message}` : 'Kesalahan tidak dikenali.',
        });
      }
    }
  } catch (e) {
    hasil.gagal.push({ pinjamanId: '*', periode: null, alasan: e instanceof Error ? `${e.name}: ${e.message}` : 'Kesalahan tidak dikenali.' });
  }
  hasilEirOtomatisTerakhir = hasil;
  return hasil;
}

async function diagnosaCelahHistoris(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string,
  nomorPinjaman: string,
  periodeCelah: string[],
  actual: Rupiah
): Promise<EirHistoricalGap> {
  const feeRow = await db.getFirstAsync<{ effective_interest_rate: number | null; saldo_akhir_carrying: number }>(
    `SELECT effective_interest_rate, saldo_akhir_carrying FROM pinjaman_akuntansi_jasa
     WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
    pinjamanId
  );
  let expected = actual;
  if (feeRow && feeRow.effective_interest_rate !== null) {
    const jadwal = await bacaJadwalAmortizedCost(db, pinjamanId, feeRow.effective_interest_rate, feeRow.saldo_akhir_carrying);
    const terakhir = periodeCelah[periodeCelah.length - 1];
    const baris = jadwal.filter((b) => b.periode <= terakhir);
    expected = baris.length > 0 ? baris[baris.length - 1].kumulatifPenyesuaianEir : 0;
  }
  return {
    kode: 'EIR_HISTORICAL_GAP',
    pinjamanId,
    nomorPinjaman,
    periode: periodeCelah,
    expected,
    actual,
    potensiDampakJurnal: expected - actual,
  };
}

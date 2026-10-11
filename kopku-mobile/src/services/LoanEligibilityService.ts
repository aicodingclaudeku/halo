import * as SQLite from 'expo-sqlite';
import { sqlJadwalBukanObsolete, sqlJadwalCurrent } from '@/accounting/ScheduleLifecycle';
import { getSaldoSimpanan } from '@/services/SimpananService';
import { getPolicyValue } from '@/services/AccountingPolicyService';
import {
  checkAnggotaAktif,
  checkKepemilikanSimpananPokokWajib,
  checkSaldoSimpananMinimum,
  checkLimitPinjaman,
  checkLimitOutstanding,
  checkBatasTunggakan,
  validateAll,
  RuleResult,
} from '@/validators/BusinessRuleEngine';
import { Rupiah } from '@/utils/money';

/**
 * LoanEligibilityService — Phase 6 (AUDIT_INTERNAL.md §5:
 * "LoanEligibilityService: MISSING", §3.2: "ajukanPinjaman() validasi
 * HANYA requirePermission()"). Sama seperti LiquidityService: I/O di
 * sini, logika murninya di validators/BusinessRuleEngine.ts (Phase 3).
 */

/** Total saldo simpanan anggota (pokok+wajib+sukarela) — dasar syarat minimum pengajuan. */
export async function getTotalSaldoSimpanan(db: SQLite.SQLiteDatabase, anggotaId: string): Promise<Rupiah> {
  const [pokok, wajib, sukarela] = await Promise.all([
    getSaldoSimpanan(db, anggotaId, 'POKOK'),
    getSaldoSimpanan(db, anggotaId, 'WAJIB'),
    getSaldoSimpanan(db, anggotaId, 'SUKARELA'),
  ]);
  return pokok + wajib + sukarela;
}

/** Total sisa pinjaman berjalan (outstanding) anggota — semua pinjaman berstatus AKTIF. */
export async function getTotalOutstanding(db: SQLite.SQLiteDatabase, anggotaId: string): Promise<Rupiah> {
  const row = await db.getFirstAsync<{ total: number }>(
    // BUG-08/BUG-12: WAJIB mengecualikan jadwal obsolete. Tanpa ini,
    // jadwal lama hasil akad ulang (DIRESTRUKTURISASI) & jadwal yang
    // sudah dihapusbukukan (DIHAPUSBUKU) ikut dijumlahkan bersama
    // jadwal penggantinya sehingga outstanding anggota berlipat.
    `SELECT COALESCE(SUM(aj.total - aj.pokok_terbayar - aj.jasa_terbayar), 0) as total
     FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id
     WHERE p.anggota_id = ? AND p.status = 'AKTIF' AND ${sqlJadwalBukanObsolete('aj')}`,
    anggotaId
  );
  return row?.total ?? 0;
}

export interface TunggakanAnggota {
  jumlahTunggakanAktif: number;
  hariTerlambatMaksimum: number;
}

/** Ringkasan tunggakan anggota — jumlah baris angsuran terlambat + hari keterlambatan paling lama. */
export async function getTunggakanAnggota(db: SQLite.SQLiteDatabase, anggotaId: string): Promise<TunggakanAnggota> {
  const row = await db.getFirstAsync<{ jumlah: number; hari_max: number | null }>(
    `SELECT COUNT(*) as jumlah, MAX(julianday('now') - julianday(aj.tanggal_jatuh_tempo)) as hari_max
     FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id
     WHERE p.anggota_id = ? AND p.status = 'AKTIF' AND ${sqlJadwalCurrent('aj')}
       AND aj.tanggal_jatuh_tempo < date('now')`,
    anggotaId
  );
  return {
    jumlahTunggakanAktif: row?.jumlah ?? 0,
    hariTerlambatMaksimum: row?.hari_max ? Math.floor(row.hari_max) : 0,
  };
}

/**
 * Cek kelayakan pengajuan pinjaman — gabungan SEMUA rule domain Loan
 * (member active, saving balance, loan limit, outstanding limit,
 * overdue limit). Dipanggil dari `ajukanPinjaman()`. Semua limit
 * default 0 (tidak membatasi) lewat AccountingPolicyService — admin
 * yang mengaktifkan lewat Pengaturan, bukan angka yang dikarang di sini.
 */
export async function checkEligibilitasPinjaman(
  db: SQLite.SQLiteDatabase,
  params: { anggotaId: string; jumlahDiajukan: Rupiah }
): Promise<RuleResult> {
  const anggota = await db.getFirstAsync<{ status: string }>(
    `SELECT status FROM anggota WHERE id = ?`,
    params.anggotaId
  );
  if (!anggota) return { valid: false, reason: 'Anggota tidak ditemukan.' };

  const [saldoPokok, saldoWajib, saldoSimpanan, outstanding, tunggakan, saldoMinimum, limitPinjaman, limitOutstanding, limitJumlahTunggakan, limitHariTerlambat] =
    await Promise.all([
      getSaldoSimpanan(db, params.anggotaId, 'POKOK'),
      getSaldoSimpanan(db, params.anggotaId, 'WAJIB'),
      getTotalSaldoSimpanan(db, params.anggotaId),
      getTotalOutstanding(db, params.anggotaId),
      getTunggakanAnggota(db, params.anggotaId),
      getPolicyValue('MINIMUM_SALDO_SIMPANAN_PINJAMAN'),
      getPolicyValue('MAX_PINJAMAN_PER_ANGGOTA'),
      getPolicyValue('MAX_OUTSTANDING_PER_ANGGOTA'),
      getPolicyValue('MAX_TUNGGAKAN_AKTIF'),
      getPolicyValue('OVERDUE_LIMIT_HARI'),
    ]);

  return validateAll(
    checkAnggotaAktif(anggota.status),
    // Bagian D (permintaan pengguna): syarat WAJIB (bukan kebijakan
    // configurable seperti checkSaldoSimpananMinimum di bawah) —
    // anggota harus sudah punya Simpanan Pokok DAN Simpanan Wajib,
    // apa pun pengaturan MINIMUM_SALDO_SIMPANAN_PINJAMAN. checkAnggotaAktif
    // tetap jadi rule PERTAMA (status anggota bukan status baru yang
    // dikarang, tetap satu-satunya sumber "anggota aktif").
    checkKepemilikanSimpananPokokWajib(saldoPokok, saldoWajib),
    checkSaldoSimpananMinimum(saldoSimpanan, saldoMinimum),
    checkLimitPinjaman(params.jumlahDiajukan, limitPinjaman),
    checkLimitOutstanding(outstanding, params.jumlahDiajukan, limitOutstanding),
    checkBatasTunggakan({
      jumlahTunggakanAktif: tunggakan.jumlahTunggakanAktif,
      hariTerlambatMaksimum: tunggakan.hariTerlambatMaksimum,
      limitJumlahTunggakan,
      limitHariTerlambat,
    })
  );
}

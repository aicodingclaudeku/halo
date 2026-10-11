import * as SQLite from 'expo-sqlite';
import { sqlJadwalBukanObsolete, sqlJadwalCurrent } from '@/accounting/ScheduleLifecycle';
import { getSaldoSimpanan } from '@/services/SimpananService';
import { getPolicyValue } from '@/services/AccountingPolicyService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import {
  checkAnggotaAktif,
  checkKepemilikanSimpananPokokWajib,
  checkSaldoSimpananMinimum,
  checkLimitPinjaman,
  checkLimitOutstanding,
  checkBatasTunggakan,
  collectFailures,
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
export async function getTotalSaldoSimpanan(
  db: SQLite.SQLiteDatabase,
  anggotaId: string,
  /** RC-S133.6.4 — saldo PER TANGGAL ini; tidak diisi = saldo seluruh transaksi (perilaku lama). */
  sampaiTanggal?: string
): Promise<Rupiah> {
  const [pokok, wajib, sukarela] = await Promise.all([
    getSaldoSimpanan(db, anggotaId, 'POKOK', sampaiTanggal),
    getSaldoSimpanan(db, anggotaId, 'WAJIB', sampaiTanggal),
    getSaldoSimpanan(db, anggotaId, 'SUKARELA', sampaiTanggal),
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

/** Pembayaran angsuran yang masih berlaku (bukan yang dikoreksi/dibalik) — definisi sama dengan KoreksiTransaksiService. */
const PEMBAYARAN_BERLAKU = (alias: string) =>
  `${alias}.reversal_of_id IS NULL AND ${alias}.id NOT IN (SELECT reversal_of_id FROM angsuran_pembayaran WHERE reversal_of_id IS NOT NULL)`;

/**
 * RC-S133.6.4 — sisa pinjaman berjalan anggota PER TANGGAL tertentu.
 *
 * Direkonstruksi dari data yang ada, bukan disimpan: pinjaman anggota yang
 * tanggalnya <= `tanggal` (status AKTIF atau LUNAS sekarang), sisa = total
 * jadwal berlaku dikurangi pembayaran bertanggal <= `tanggal`. Pinjaman yang
 * baru dibuat SESUDAH tanggal itu tidak ikut (belum ada saat itu).
 *
 * Keterbatasan (diungkapkan di dokumen rilis): tidak ada riwayat status per
 * tanggal, sehingga jadwal yang kemudian digantikan akad ulang / dihapusbukukan
 * dinilai dengan jadwal yang berlaku sekarang; sisa tidak pernah negatif.
 */
export async function getTotalOutstandingPerTanggal(
  db: SQLite.SQLiteDatabase,
  anggotaId: string,
  tanggal: string
): Promise<Rupiah> {
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(CASE
              -- Pinjaman yang sudah LUNAS dan pembayaran terakhirnya jatuh
              -- pada/sebelum tanggal ini: lunas saat itu, walau pelunasan
              -- dipercepat dengan rabat jasa membuat jumlah bayar < kontrak.
              WHEN x.status = 'LUNAS' AND x.bayar_terakhir IS NOT NULL AND x.bayar_terakhir <= ? THEN 0
              WHEN x.kontrak - x.bayar > 0 THEN x.kontrak - x.bayar
              ELSE 0 END), 0) as total
     FROM (
       SELECT p.status as status,
              (SELECT COALESCE(SUM(aj.total), 0) FROM angsuran_jadwal aj
                WHERE aj.pinjaman_id = p.id AND ${sqlJadwalBukanObsolete('aj')}) as kontrak,
              (SELECT COALESCE(SUM(ap.porsi_pokok + ap.porsi_jasa), 0) FROM angsuran_pembayaran ap
                WHERE ap.pinjaman_id = p.id AND ap.tanggal <= ? AND ${PEMBAYARAN_BERLAKU('ap')}) as bayar,
              (SELECT MAX(ap.tanggal) FROM angsuran_pembayaran ap
                WHERE ap.pinjaman_id = p.id AND ${PEMBAYARAN_BERLAKU('ap')}) as bayar_terakhir
       FROM pinjaman p
       WHERE p.anggota_id = ? AND p.tanggal <= ? AND p.status IN ('AKTIF','LUNAS')
     ) x`,
    tanggal,
    tanggal,
    anggotaId,
    tanggal
  );
  return row?.total ?? 0;
}

/**
 * RC-S133.6.4 — tunggakan anggota PER TANGGAL tertentu: baris jadwal yang
 * jatuh temponya SEBELUM `tanggal` dan belum terbayar penuh oleh pembayaran
 * bertanggal <= `tanggal`. Pinjaman yang sudah dilunasi (pelunasan dipercepat)
 * pada/sebelum tanggal itu tidak dihitung. Keterbatasan sama dengan
 * `getTotalOutstandingPerTanggal`.
 */
export async function getTunggakanAnggotaPerTanggal(
  db: SQLite.SQLiteDatabase,
  anggotaId: string,
  tanggal: string
): Promise<TunggakanAnggota> {
  const row = await db.getFirstAsync<{ jumlah: number; hari_max: number | null }>(
    `SELECT COUNT(*) as jumlah, MAX(julianday(?) - julianday(aj.tanggal_jatuh_tempo)) as hari_max
     FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id
     WHERE p.anggota_id = ? AND p.tanggal <= ? AND p.status IN ('AKTIF','LUNAS')
       AND ${sqlJadwalBukanObsolete('aj')}
       AND aj.tanggal_jatuh_tempo < ?
       AND (aj.pokok + aj.jasa) > (
         SELECT COALESCE(SUM(ap.porsi_pokok + ap.porsi_jasa), 0) FROM angsuran_pembayaran ap
          WHERE ap.jadwal_id = aj.id AND ap.tanggal <= ? AND ${PEMBAYARAN_BERLAKU('ap')})
       AND NOT EXISTS (
         SELECT 1 FROM angsuran_pembayaran ap2
          WHERE ap2.pinjaman_id = p.id AND ap2.jadwal_id IS NULL AND ap2.tanggal <= ? AND ${PEMBAYARAN_BERLAKU('ap2')})`,
    tanggal,
    anggotaId,
    tanggal,
    tanggal,
    tanggal,
    tanggal
  );
  return {
    jumlahTunggakanAktif: row?.jumlah ?? 0,
    hariTerlambatMaksimum: row?.hari_max ? Math.floor(row.hari_max) : 0,
  };
}

export interface HasilEvaluasiEligibilitas {
  /** true bila SEMUA syarat terpenuhi. */
  valid: boolean;
  /** Seluruh alasan yang tidak terpenuhi (kosong bila valid). */
  alasan: string[];
  /** Tanggal yang dipakai menilai (tanggal pengajuan, atau hari ini). */
  tanggalPenilaian: string;
  /** true bila tanggal pengajuan lampau sehingga syarat dinilai per tanggal itu, bukan keadaan hari ini. */
  perTanggalLampau: boolean;
}

/**
 * Evaluasi kelayakan pengajuan pinjaman — mengembalikan SEMUA syarat yang
 * tidak terpenuhi dan tanggal yang dipakai menilai.
 *
 * RC-S133.6.4 — SYARAT DINILAI PADA TANGGAL PENGAJUAN, bukan hari ini:
 *  - `tanggal` hari ini / masa depan / tidak diisi -> dinilai dengan keadaan
 *    sekarang, dengan kueri yang SAMA dengan sebelumnya (hasil tidak berubah);
 *  - `tanggal` lampau -> saldo simpanan, sisa pinjaman berjalan, dan
 *    tunggakan direkonstruksi PER TANGGAL itu. Yang tidak punya riwayat
 *    tanggal (status keanggotaan sekarang, kebijakan/limit yang berlaku
 *    sekarang) tetap memakai keadaan sekarang.
 */
export async function evaluasiEligibilitasPinjaman(
  db: SQLite.SQLiteDatabase,
  params: { anggotaId: string; jumlahDiajukan: Rupiah; tanggal?: string; tanggalHariIni?: string }
): Promise<HasilEvaluasiEligibilitas> {
  const hariIni = params.tanggalHariIni ?? getTanggalLokalHariIni();
  const perTanggalLampau = !!params.tanggal && params.tanggal < hariIni;
  const sampai = perTanggalLampau ? (params.tanggal as string) : undefined;
  const tanggalPenilaian = sampai ?? hariIni;

  const anggota = await db.getFirstAsync<{ status: string }>(
    `SELECT status FROM anggota WHERE id = ?`,
    params.anggotaId
  );
  if (!anggota) {
    return { valid: false, alasan: ['Anggota tidak ditemukan.'], tanggalPenilaian, perTanggalLampau };
  }

  const [saldoPokok, saldoWajib, saldoSimpanan, outstanding, tunggakan, saldoMinimum, limitPinjaman, limitOutstanding, limitJumlahTunggakan, limitHariTerlambat] =
    await Promise.all([
      getSaldoSimpanan(db, params.anggotaId, 'POKOK', sampai),
      getSaldoSimpanan(db, params.anggotaId, 'WAJIB', sampai),
      getTotalSaldoSimpanan(db, params.anggotaId, sampai),
      sampai ? getTotalOutstandingPerTanggal(db, params.anggotaId, sampai) : getTotalOutstanding(db, params.anggotaId),
      sampai ? getTunggakanAnggotaPerTanggal(db, params.anggotaId, sampai) : getTunggakanAnggota(db, params.anggotaId),
      getPolicyValue('MINIMUM_SALDO_SIMPANAN_PINJAMAN'),
      getPolicyValue('MAX_PINJAMAN_PER_ANGGOTA'),
      getPolicyValue('MAX_OUTSTANDING_PER_ANGGOTA'),
      getPolicyValue('MAX_TUNGGAKAN_AKTIF'),
      getPolicyValue('OVERDUE_LIMIT_HARI'),
    ]);

  // Urutan SAMA dengan sebelumnya: alasan pertama = alasan yang dulu dilempar.
  const alasan = collectFailures(
    checkAnggotaAktif(anggota.status),
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
  return { valid: alasan.length === 0, alasan, tanggalPenilaian, perTanggalLampau };
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
  params: {
    anggotaId: string;
    jumlahDiajukan: Rupiah;
    /** RC-S133.6.4 — tanggal pengajuan; syarat dinilai pada tanggal ini (lihat `evaluasiEligibilitasPinjaman`). */
    tanggal?: string;
  }
): Promise<RuleResult> {
  const hasil = await evaluasiEligibilitasPinjaman(db, params);
  return hasil.valid ? { valid: true } : { valid: false, reason: hasil.alasan[0] };
}

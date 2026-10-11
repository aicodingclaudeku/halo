import * as SQLite from 'expo-sqlite';
import { getAccountBalance } from '@/accounting/AccountingEngine';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { getPolicyValue } from '@/services/AccountingPolicyService';
import {
  checkSaldoCukup,
  checkLiquiditySufficient,
  LiquidityCheckResult,
  RuleResult,
} from '@/validators/BusinessRuleEngine';
import { Rupiah } from '@/utils/money';

/**
 * LiquidityService — Phase 4 (AUDIT_INTERNAL.md §5: "LiquidityService:
 * MISSING"). Mengambil kas/bank/kebijakan SUNGGUHAN dari database lalu
 * memanggil fungsi murni di `validators/BusinessRuleEngine.ts` — tidak
 * ada logika validasi baru di sini, cuma I/O + pemetaan ke rule yang
 * sudah dites terpisah di Phase 3.
 */

/** Total saldo SEMUA akun kas (Kas Umum + Kas Kecil) — dipakai sebagai komponen "cash" di rumus availableLiquidity. */
export async function getTotalSaldoKas(db: SQLite.SQLiteDatabase): Promise<Rupiah> {
  let total = 0;
  for (const mapping of [
    { type: 'KAS_UMUM', role: 'DEFAULT' },
    { type: 'KAS_KECIL', role: 'DEFAULT' },
  ]) {
    try {
      const accountId = await resolveAccountId(db, mapping.type, mapping.role);
      total += await getAccountBalance(db, accountId);
    } catch {
      // Mapping/akun belum ada atau nonaktif — dianggap 0, bukan error
      // (supaya cek liquidity tidak gagal total hanya karena satu jenis
      // kas belum dikonfigurasi, mis. koperasi yang tidak pakai Kas Kecil).
    }
  }
  return total;
}

/** Total saldo SEMUA rekening bank AKTIF — komponen "bank" di rumus availableLiquidity. */
export async function getTotalSaldoBank(db: SQLite.SQLiteDatabase): Promise<Rupiah> {
  const rows = await db.getAllAsync<{ account_id: string }>(
    `SELECT account_id FROM bank_account WHERE aktif = 1`
  );
  let total = 0;
  for (const row of rows) {
    total += await getAccountBalance(db, row.account_id);
  }
  return total;
}

/**
 * Total pinjaman yang sudah DISETUJUI tapi belum dicairkan (status
 * DISETUJUI, bukan DIAJUKAN — pengajuan mentah belum tentu disetujui
 * jadi tidak dihitung sebagai komitmen kas). `excludePinjamanId`
 * dipakai saat mengecek pencairan pinjaman ITU SENDIRI, supaya tidak
 * dihitung dobel terhadap dirinya sendiri.
 */
export async function getPendingDisbursement(
  db: SQLite.SQLiteDatabase,
  excludePinjamanId?: string
): Promise<Rupiah> {
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(jumlah_pinjaman), 0) as total FROM pinjaman WHERE status = 'DISETUJUI' AND id != ?`,
    excludePinjamanId ?? ''
  );
  return row?.total ?? 0;
}

/**
 * Cek liquidity sebelum pencairan pinjaman — rumus PERSIS spesifikasi:
 *   availableLiquidity = kas + bank - reservedLiquidity - minimumCashReserve - pendingDisbursement
 *   valid jika jumlahDiajukan <= availableLiquidity
 */
export async function checkLiquiditasPencairan(
  db: SQLite.SQLiteDatabase,
  params: { jumlahDiajukan: Rupiah; excludePinjamanId?: string }
): Promise<LiquidityCheckResult> {
  const [kas, bank, reservedLiquidity, minimumCashReserve, pendingDisbursement] = await Promise.all([
    getTotalSaldoKas(db),
    getTotalSaldoBank(db),
    getPolicyValue('RESERVED_LIQUIDITY'),
    getPolicyValue('MINIMUM_CASH_RESERVE'),
    getPendingDisbursement(db, params.excludePinjamanId),
  ]);

  return checkLiquiditySufficient({
    kas,
    bank,
    reservedLiquidity,
    minimumCashReserve,
    pendingDisbursement,
    jumlahDiajukan: params.jumlahDiajukan,
  });
}

/**
 * Cek saldo SATU akun kas/bank spesifik cukup untuk nominal yang akan
 * keluar — dipakai di titik transaksi yang menentukan SATU rekening
 * sumber dana (pengeluaran kas/bank, pembayaran angsuran/utang, dst),
 * BEDA dari checkLiquiditasPencairan yang mengecek total agregat.
 * Keduanya dipakai bersamaan untuk pencairan pinjaman (lihat
 * PinjamanService.cairkanPinjaman): agregat cukup TAPI rekening yang
 * dipilih user tetap harus cukup individual juga.
 */
export async function checkSaldoAkunCukup(
  db: SQLite.SQLiteDatabase,
  params: { accountId: string; namaRekening: string; nominalKeluar: Rupiah }
): Promise<RuleResult> {
  const saldoTersedia = await getAccountBalance(db, params.accountId);
  return checkSaldoCukup({
    saldoTersedia,
    nominalKeluar: params.nominalKeluar,
    namaRekening: params.namaRekening,
  });
}

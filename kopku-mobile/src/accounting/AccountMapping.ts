import * as SQLite from 'expo-sqlite';

/**
 * Semua jenis transaksi otomatis (PRD §21) harus mengambil account_id
 * lewat resolver ini, BUKAN dengan menuliskan kode/nama akun langsung
 * di service. Ini yang membuat COA benar-benar configurable (§18).
 *
 * Contoh transaction_type yang dipakai di seluruh app:
 *   SIMPANAN_POKOK, SIMPANAN_WAJIB, SIMPANAN_SUKARELA_SETOR, SIMPANAN_SUKARELA_TARIK,
 *   PENCAIRAN_PINJAMAN, ANGSURAN_POKOK, ANGSURAN_JASA, ANGSURAN_DENDA,
 *   BIAYA_ADMIN_PINJAMAN, KAS_PENERIMAAN_LAIN, KAS_PENGELUARAN_LAIN, TRANSFER_BANK
 *
 * PHASE 1 (fondasi akrual jasa/bunga pinjaman): mapping berikut sudah
 * disiapkan di defaultCOA.ts tapi BELUM dipakai oleh service mana pun
 * (menunggu PHASE 2) — PIUTANG_JASA_PINJAMAN, PELUNASAN_PENALTI,
 * PELUNASAN_ADMINISTRASI.
 */

export class MissingAccountMappingError extends Error {
  constructor(transactionType: string, role: string) {
    super(
      `Account mapping belum dikonfigurasi untuk transaksi "${transactionType}" (role: ${role}). ` +
        `Buka Pengaturan > Chart of Accounts > Mapping Transaksi untuk mengatur ini.`
    );
    this.name = 'MissingAccountMappingError';
  }
}

export class InactiveAccountError extends Error {
  constructor(nama: string) {
    super(`Akun "${nama}" sudah dinonaktifkan dan tidak bisa dipakai untuk transaksi baru.`);
    this.name = 'InactiveAccountError';
  }
}

export class InactiveBankAccountError extends Error {
  constructor(nama: string) {
    super(`Rekening bank "${nama}" sudah dinonaktifkan dan tidak bisa dipakai untuk transaksi baru.`);
    this.name = 'InactiveBankAccountError';
  }
}

/**
 * Resolusi account_id lewat mapping transaction_type+role (§18/§21) —
 * DITAMBAH pengecekan akun masih aktif (Phase 2, AUDIT_INTERNAL.md
 * §4: "account active" sebelumnya cuma ada kolomnya, tidak pernah
 * benar-benar dicek). Kalau akun yang dituju mapping ternyata sudah
 * dinonaktifkan lewat Pengaturan > Chart of Accounts, transaksi baru
 * ditolak dengan pesan jelas — bukan diam-diam tetap jalan.
 */
export async function resolveAccountId(
  db: SQLite.SQLiteDatabase,
  transactionType: string,
  role: string
): Promise<string> {
  const row = await db.getFirstAsync<{ account_id: string; nama: string; is_active: number }>(
    `SELECT am.account_id, a.nama, a.is_active
     FROM account_mapping am JOIN account a ON a.id = am.account_id
     WHERE am.transaction_type = ? AND am.role = ?`,
    transactionType,
    role
  );
  if (!row) throw new MissingAccountMappingError(transactionType, role);
  if (!row.is_active) throw new InactiveAccountError(row.nama);
  return row.account_id;
}

/** Resolusi akun kas/bank spesifik berdasarkan pilihan user di form transaksi. */
export async function resolveKasBankAccountId(
  db: SQLite.SQLiteDatabase,
  sumberDana: 'KAS' | 'KAS_KECIL' | 'BANK',
  bankAccountId?: string
): Promise<string> {
  if (sumberDana === 'KAS') {
    return resolveAccountId(db, 'KAS_UMUM', 'DEFAULT');
  }
  if (sumberDana === 'KAS_KECIL') {
    return resolveAccountId(db, 'KAS_KECIL', 'DEFAULT');
  }
  if (!bankAccountId) {
    throw new Error('bankAccountId wajib diisi jika sumber dana = BANK.');
  }
  const row = await db.getFirstAsync<{ account_id: string; nama_bank: string; aktif: number }>(
    `SELECT account_id, nama_bank, aktif FROM bank_account WHERE id = ?`,
    bankAccountId
  );
  if (!row) throw new Error('Rekening bank tidak ditemukan.');
  if (!row.aktif) throw new InactiveBankAccountError(row.nama_bank);
  return row.account_id;
}

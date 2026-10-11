import * as SQLite from 'expo-sqlite';
import { resolveAccountId, MissingAccountMappingError } from '@/accounting/AccountMapping';
import { sqlJadwalBukanObsolete } from '@/accounting/ScheduleLifecycle';
import { totalKomponenEirDi2_1300 } from '@/accounting/EirFeeInvariant';

type Rupiah = number;

/**
 * REKONSILIASI PENDAPATAN DITERIMA DIMUKA (2-1300).
 * ============================================================
 *
 * TEMUAN §10 — SATU AKUN, DUA OBJEK AKUNTANSI YANG BERBEDA.
 *
 * Akun 2-1300 menampung DUA hal yang secara ekonomi berbeda dan punya
 * subledger serta mesin pelepasan masing-masing:
 *
 *  A. JASA KONTRAKTUAL MASA DEPAN (contractual future service income)
 *     - masuk lewat : ANGSURAN_JASA/KREDIT_DIMUKA (bayar sebelum jatuh
 *                     tempo) dan PELUNASAN_JASA_FUTURE/KREDIT_DIMUKA
 *                     (pelunasan dipercepat)
 *     - subledger   : angsuran_jadwal.jasa_dimuka
 *     - dilepas oleh: AkrualJasaPinjamanService (per periode jatuh tempo)
 *
 *  B. FEE INTEGRAL PEMBIAYAAN (integral financing fee / EIR)
 *     - masuk lewat : BIAYA_ADMIN_PINJAMAN/KREDIT_DIMUKA
 *     - subledger   : pinjaman_akuntansi_jasa (FEE_INTEGRAL_AMORTISASI
 *                     dikurangi seluruh EIR_MONTHLY yang sudah diakui)
 *     - dilepas oleh: EirAccountingService (amortisasi EIR)
 *
 * Keduanya TIDAK saling menggandakan — jalur masuk, subledger, dan
 * mesin pelepasannya terpisah penuh. Tetapi karena saldo GL-nya
 * MENYATU di satu akun, rekonsiliasi yang hanya membandingkan
 * `SUM(jasa_dimuka)` terhadap saldo 2-1300 akan SELALU melaporkan
 * selisih pada koperasi yang memakai fee integral — dan orang akan
 * menyimpulkan ada bug padahal tidak ada.
 *
 * WHY fungsi ini ada: menyatakan kedua komponen secara eksplisit,
 * sehingga variance nol berarti benar-benar nol, dan selisih yang
 * muncul benar-benar menandakan masalah.
 */
export interface RekonsiliasiDeferredIncome {
  /** Saldo GL akun 2-1300 (liabilitas, normal balance KREDIT). */
  glDeferredIncome: Rupiah;
  /** Subledger A — jasa kontraktual masa depan yang kasnya sudah diterima. */
  subledgerJasaKontraktual: Rupiah;
  /** Subledger B — fee integral yang belum diamortisasi (EIR). */
  subledgerFeeIntegral: Rupiah;
  /** A + B. */
  totalSubledger: Rupiah;
  /** glDeferredIncome - totalSubledger. Harus 0. */
  variance: Rupiah;
  seimbang: boolean;
  accountId: string;
}

/**
 * Hitung rekonsiliasi 2-1300.
 *
 * Gagal KERAS bila mapping COA-nya tidak ada (BUG-14): rekonsiliasi
 * yang mengembalikan 0 karena tidak tahu akunnya justru menyembunyikan
 * persis masalah yang ingin dideteksi.
 */
export async function rekonsiliasiDeferredIncome(
  db: SQLite.SQLiteDatabase,
  asOfDate?: string
): Promise<RekonsiliasiDeferredIncome> {
  let accountId: string;
  try {
    // Role ini adalah SISI DEBIT saat pelepasan — akun yang sama dengan
    // sisi kredit saat penerimaan. Dipakai sebagai titik resolusi
    // tunggal supaya tidak ada dua "akun 2-1300" yang berbeda.
    accountId = await resolveAccountId(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA');
  } catch (err) {
    if (err instanceof MissingAccountMappingError) {
      throw new Error(
        'Rekonsiliasi pendapatan diterima dimuka gagal: akun Pendapatan Diterima Dimuka belum ' +
          'memiliki mapping COA "AKRUAL_JASA_PINJAMAN" (role: DEBIT_DIMUKA). ' +
          'Atur mapping tersebut di Pengaturan > Chart of Accounts, lalu jalankan rekonsiliasi ulang.'
      );
    }
    throw err;
  }

  const filterTanggal = asOfDate ? 'AND j.tanggal <= ?' : '';
  const paramsGl: SQLite.SQLiteBindValue[] = asOfDate ? [accountId, asOfDate] : [accountId];
  const glRow = await db.getFirstAsync<{ saldo: number }>(
    `SELECT COALESCE(SUM(je.kredit - je.debit), 0) as saldo
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED') ${filterTanggal}`,
    ...paramsGl
  );

  // Subledger A. Jadwal obsolete dikecualikan (BUG-08/BUG-12) — baris
  // yang sudah digantikan akad ulang tidak lagi menyimpan kewajiban.
  const kontraktualRow = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(aj.jasa_dimuka), 0) as total
     FROM angsuran_jadwal aj
     WHERE ${sqlJadwalBukanObsolete('aj')}`
  );

  // Subledger B. Sisa fee integral yang belum diakui, dihitung lewat
  // modul invarian terpusat (BUG-03). PENTING: perhitungannya ikut
  // mengurangkan baris EIR_DERECOGNITION — versi sebelumnya hanya
  // mengurangkan EIR_MONTHLY, sehingga pinjaman yang fee-nya sudah
  // diselesaikan saat pelunasan dipercepat / hapus buku tetap terhitung
  // punya sisa, padahal jurnalnya sudah mendebit 2-1300 sampai nol.
  // Itu menghasilkan selisih rekonsiliasi palsu.
  // RC-S54 TAHAP 9: komponen EIR = sisa fee - penyesuaian bunga efektif
  // akrual (bertanda). Sama dengan sisa fee bila X = 0 (EFEKTIF/MENURUN).
  const subledgerFeeIntegral = await totalKomponenEirDi2_1300(db);

  const glDeferredIncome = glRow?.saldo ?? 0;
  const subledgerJasaKontraktual = kontraktualRow?.total ?? 0;
  const totalSubledger = subledgerJasaKontraktual + subledgerFeeIntegral;

  return {
    glDeferredIncome,
    subledgerJasaKontraktual,
    subledgerFeeIntegral,
    totalSubledger,
    variance: glDeferredIncome - totalSubledger,
    seimbang: glDeferredIncome - totalSubledger === 0,
    accountId,
  };
}

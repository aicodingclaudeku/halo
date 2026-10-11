import * as SQLite from 'expo-sqlite';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { getAccountBalance } from '@/accounting/AccountingEngine';

type Rupiah = number;

/**
 * RC-S54 TAHAP 16 — GAP 7: READ MODEL KOMPONEN EIR & AMORTIZED COST PER TANGGAL.
 *
 * `EirFeeInvariant.totalKomponenEirDi2_1300` / `hitungInvarianFeeEir` membaca keadaan
 * TERKINI (tanpa tanggal) — benar untuk rekonsiliasi, salah untuk laporan historis (0
 * setelah lunas walau tanggal laporan sebelum pelunasan). Modul ini TIDAK menggantikan
 * atau mengubah pengukuran: ia memproyeksikan rumus invarian yang sama
 *
 *     D = feeAwal − (amortisasi + derecognition) − akrual  =  feeAwal − Σ pendapatan_akuntansi
 *
 * hanya atas baris subledger yang jurnalnya POSTED/REVERSED bertanggal <= tanggal laporan,
 * dan membatalkan kontribusi baris yang jurnalnya sudah dibalik pada/sebelum tanggal itu.
 * D bertanda: > 0 kredit (fee belum diamortisasi), < 0 debit (bunga efektif akrual > sisa fee).
 *
 * Pembanding GL: Σ (kredit − debit) akun Pendapatan Diterima Dimuka pada jurnal yang sama
 * (plus jurnal pembaliknya) sampai tanggal itu. Tidak ada INSERT/UPDATE/DELETE, tidak
 * menyentuh EirAccountingService, solver, EirFeeInvariant, atau posting jurnal.
 */

export interface KomponenEirPerTanggal {
  readonly pinjamanId: string;
  readonly tanggal: string;
  readonly feeAwal: Rupiah;
  readonly totalPendapatanEir: Rupiah;
  /** D per tanggal (kredit positif). */
  readonly komponenEir: Rupiah;
  /** Komponen yang sama menurut GL akun Pendapatan Diterima Dimuka pada jurnal EIR/fee pinjaman ini. */
  readonly komponenEirGl: Rupiah;
  readonly selisihGl: Rupiah;
}

export interface PenyajianAmortizedCostPerTanggal {
  readonly tanggal: string;
  /** Saldo GL piutang pinjaman (kontraktual) per tanggal. */
  readonly piutangKontraktual: Rupiah;
  /** Σ D seluruh pinjaman ber-EIR per tanggal. */
  readonly komponenEir: Rupiah;
  /** piutangKontraktual − komponenEir. */
  readonly amortizedCost: Rupiah;
  /** Saldo GL Pendapatan Diterima Dimuka per tanggal (kredit positif). */
  readonly saldoPendapatanDiterimaDimuka: Rupiah;
  readonly posisiPendapatanDiterimaDimuka: 'DEBIT' | 'KREDIT' | 'NOL';
  /** Bagian saldo yang bukan komponen EIR (jasa dibayar dimuka kontraktual, dll.). */
  readonly deferredIncomeNonEir: Rupiah;
  readonly perPinjaman: readonly KomponenEirPerTanggal[];
}

interface Kueri {
  getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]>;
}
const kueri = (db: SQLite.SQLiteDatabase) => db as unknown as Kueri;

const TIPE_EIR = `('FEE_INTEGRAL_AMORTISASI','EIR_MONTHLY','EIR_DERECOGNITION')`;

export async function getKomponenEirPerTanggal(
  db: SQLite.SQLiteDatabase,
  pinjamanId: string,
  tanggal: string
): Promise<KomponenEirPerTanggal | null> {
  const q = kueri(db);
  const baris = await q.getAllAsync<{
    tipe: string; status: string; pendapatan: number; fee: number; journal_id: string; tgl_balik: string | null; id_balik: string | null;
  }>(
    `SELECT paj.tipe_pengakuan AS tipe, paj.status AS status, paj.pendapatan_akuntansi AS pendapatan,
            paj.saldo_akhir_carrying AS fee, paj.journal_id AS journal_id,
            (SELECT MIN(substr(r.tanggal,1,10)) FROM journal r WHERE r.reversal_of_id = j.id AND r.status IN ('POSTED','REVERSED')) AS tgl_balik,
            (SELECT r.id FROM journal r WHERE r.reversal_of_id = j.id AND r.status IN ('POSTED','REVERSED') ORDER BY r.tanggal LIMIT 1) AS id_balik
       FROM pinjaman_akuntansi_jasa paj
       JOIN journal j ON j.id = paj.journal_id
      WHERE paj.pinjaman_id = ?
        AND paj.tipe_pengakuan IN ${TIPE_EIR}
        AND j.status IN ('POSTED','REVERSED')
        AND substr(j.tanggal,1,10) <= ?`,
    pinjamanId,
    tanggal
  );
  const adaFee = await q.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
    pinjamanId
  );
  if (!adaFee || adaFee.n === 0) return null;

  let feeAwal = 0;
  let totalPendapatanEir = 0;
  const jurnalGl = new Set<string>();
  for (const b of baris) {
    const dibalikPerTanggal = b.tgl_balik !== null && b.tgl_balik <= tanggal;
    const berlaku = b.status === 'DIAKUI' ? !dibalikPerTanggal : b.tgl_balik !== null && !dibalikPerTanggal;
    if (berlaku) {
      if (b.tipe === 'FEE_INTEGRAL_AMORTISASI') feeAwal += b.fee;
      else totalPendapatanEir += b.pendapatan;
    }
    jurnalGl.add(b.journal_id);
    if (b.id_balik && dibalikPerTanggal) jurnalGl.add(b.id_balik);
  }

  let komponenEirGl = 0;
  const akunDimuka = await resolveAccountId(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA');
  for (const jid of jurnalGl) {
    const e = await q.getFirstAsync<{ d: number; k: number }>(
      `SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(kredit),0) AS k FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
      jid, akunDimuka
    );
    komponenEirGl += (e?.k ?? 0) - (e?.d ?? 0);
  }
  const komponenEir = feeAwal - totalPendapatanEir;
  return { pinjamanId, tanggal, feeAwal, totalPendapatanEir, komponenEir, komponenEirGl, selisihGl: komponenEirGl - komponenEir };
}

export async function getPenyajianAmortizedCostPerTanggal(
  db: SQLite.SQLiteDatabase,
  tanggal: string
): Promise<PenyajianAmortizedCostPerTanggal> {
  const q = kueri(db);
  const ids = await q.getAllAsync<{ pinjaman_id: string }>(
    `SELECT DISTINCT pinjaman_id FROM pinjaman_akuntansi_jasa WHERE tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI' ORDER BY pinjaman_id`
  );
  const perPinjaman: KomponenEirPerTanggal[] = [];
  for (const { pinjaman_id } of ids) {
    const k = await getKomponenEirPerTanggal(db, pinjaman_id, tanggal);
    if (k) perPinjaman.push(k);
  }
  const komponenEir = perPinjaman.reduce((t, k) => t + k.komponenEir, 0);
  const piutangKontraktual = await getAccountBalance(db, await resolveAccountId(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG'), tanggal);
  const saldoDimuka = await getAccountBalance(db, await resolveAccountId(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA'), tanggal);
  return {
    tanggal,
    piutangKontraktual,
    komponenEir,
    amortizedCost: piutangKontraktual - komponenEir,
    saldoPendapatanDiterimaDimuka: saldoDimuka,
    posisiPendapatanDiterimaDimuka: saldoDimuka < 0 ? 'DEBIT' : saldoDimuka > 0 ? 'KREDIT' : 'NOL',
    deferredIncomeNonEir: saldoDimuka - komponenEir,
    perPinjaman,
  };
}

import * as SQLite from 'expo-sqlite';
import { CASH_FLOW_CLASSIFICATION } from '@/accounting/CashFlowClassification';
import { getAkunKasBankUntukLaporan } from '@/reports/FinancialReports';

/**
 * RC-S54 TAHAP 16 — ITEM #21: DIAGNOSTIK ARUS KAS BAGIAN SHU. READ-ONLY.
 *
 * Memeriksa histori jurnal bagian SHU terhadap klasifikasi arus kas:
 *  - KLASIFIKASI_BELUM_TERDAFTAR  : sumber bagian SHU tanpa entri di CASH_FLOW_CLASSIFICATION
 *    (sebelum T16 -> Arus Kas & CALK melempar UnknownCashFlowClassificationError);
 *  - PENGAKUAN_MENYENTUH_KAS       : jurnal BAGIAN_SHU_INVESTASI (NON_KAS) yang punya baris Kas/Bank
 *    (akan melempar NonCashSourceOnCashLineError);
 *  - PENERIMAAN_TANPA_KAS         : jurnal BAGIAN_SHU_PENERIMAAN tanpa baris Kas/Bank;
 *  - PENERIMAAN_TIDAK_SESUAI_REGISTER : nilai kas jurnal ≠ investasi_bagian_shu_penerimaan.jumlah.
 * Tidak ada INSERT/UPDATE/DELETE; tidak ada koreksi otomatis.
 */

export const SUMBER_BAGIAN_SHU = ['BAGIAN_SHU_INVESTASI', 'BAGIAN_SHU_PENERIMAAN'] as const;

export type KodeTemuanCashFlowBagianShu =
  | 'KLASIFIKASI_BELUM_TERDAFTAR'
  | 'PENGAKUAN_MENYENTUH_KAS'
  | 'PENERIMAAN_TANPA_KAS'
  | 'PENERIMAAN_TIDAK_SESUAI_REGISTER';

export interface TemuanCashFlowBagianShu {
  readonly kode: KodeTemuanCashFlowBagianShu;
  readonly sumber: string;
  readonly journalId: string | null;
  readonly tanggal: string | null;
  readonly nilaiKas: number;
}

export interface DiagnostikCashFlowBagianShu {
  readonly klasifikasi: Readonly<Record<string, string | null>>;
  readonly jumlahJurnal: Readonly<Record<string, number>>;
  /** Σ (debit − kredit) baris Kas/Bank per sumber. */
  readonly arusKasBersih: Readonly<Record<string, number>>;
  readonly temuan: readonly TemuanCashFlowBagianShu[];
}

export async function diagnosaCashFlowBagianShu(db: SQLite.SQLiteDatabase): Promise<DiagnostikCashFlowBagianShu> {
  const kasBank = new Set((await getAkunKasBankUntukLaporan(db)).map((a) => a.id));
  const temuan: TemuanCashFlowBagianShu[] = [];
  const klasifikasi: Record<string, string | null> = {};
  const jumlahJurnal: Record<string, number> = {};
  const arusKasBersih: Record<string, number> = {};

  for (const sumber of SUMBER_BAGIAN_SHU) {
    klasifikasi[sumber] = CASH_FLOW_CLASSIFICATION[sumber] ?? null;
    const baris = await db.getAllAsync<{ journal_id: string; tanggal: string; account_id: string; debit: number; kredit: number }>(
      `SELECT j.id AS journal_id, j.tanggal AS tanggal, je.account_id AS account_id, je.debit AS debit, je.kredit AS kredit
         FROM journal j JOIN journal_entry je ON je.journal_id = j.id
        WHERE j.sumber_transaksi = ? AND j.status IN ('POSTED','REVERSED')
        ORDER BY j.tanggal, j.id`,
      sumber
    );
    const perJurnal = new Map<string, { tanggal: string; kas: number; adaKas: boolean }>();
    for (const b of baris) {
      const e = perJurnal.get(b.journal_id) ?? { tanggal: b.tanggal, kas: 0, adaKas: false };
      if (kasBank.has(b.account_id)) {
        e.kas += b.debit - b.kredit;
        e.adaKas = true;
      }
      perJurnal.set(b.journal_id, e);
    }
    jumlahJurnal[sumber] = perJurnal.size;
    arusKasBersih[sumber] = [...perJurnal.values()].reduce((t, e) => t + e.kas, 0);
    if (perJurnal.size > 0 && klasifikasi[sumber] === null) {
      temuan.push({ kode: 'KLASIFIKASI_BELUM_TERDAFTAR', sumber, journalId: null, tanggal: null, nilaiKas: arusKasBersih[sumber] });
    }
    for (const [journalId, e] of perJurnal) {
      if (sumber === 'BAGIAN_SHU_INVESTASI' && e.adaKas) {
        temuan.push({ kode: 'PENGAKUAN_MENYENTUH_KAS', sumber, journalId, tanggal: e.tanggal, nilaiKas: e.kas });
      }
      if (sumber === 'BAGIAN_SHU_PENERIMAAN' && !e.adaKas) {
        temuan.push({ kode: 'PENERIMAAN_TANPA_KAS', sumber, journalId, tanggal: e.tanggal, nilaiKas: 0 });
      }
    }
    if (sumber === 'BAGIAN_SHU_PENERIMAAN') {
      const register = await db.getAllAsync<{ journal_id: string; jumlah: number }>(
        `SELECT journal_id, jumlah FROM investasi_bagian_shu_penerimaan`
      );
      for (const r of register) {
        const e = perJurnal.get(r.journal_id);
        if (e && e.adaKas && e.kas !== r.jumlah) {
          temuan.push({ kode: 'PENERIMAAN_TIDAK_SESUAI_REGISTER', sumber, journalId: r.journal_id, tanggal: e.tanggal, nilaiKas: e.kas });
        }
      }
    }
  }
  return { klasifikasi, jumlahJurnal, arusKasBersih, temuan };
}

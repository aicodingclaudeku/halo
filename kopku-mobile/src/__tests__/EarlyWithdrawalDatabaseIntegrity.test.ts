jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  siapkanDb, pasangKebijakan,
  KEBIJAKAN_ENAM_KOMPONEN, USER_ID, TANGGAL_TARIK,
} from './earlyWithdrawalHarness';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import { prosesAkrualBungaKontrak } from '@/services/SimpananBerjangkaLifecycleService';
import { cairkanSimpananBerjangkaDini } from '@/services/SimpananBerjangkaEarlyWithdrawalService';

/** EW-25 §AN — INTEGRITAS DATABASE setelah penarikan dini. */

let db: TestDb;

beforeEach(async () => {
  db = await siapkanDb();
  await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
  const id = await buatKontrakUji();
  await prosesAkrualBungaKontrak(id, TANGGAL_TARIK, USER_ID);
  await cairkanSimpananBerjangkaDini({
    kontrakId: id, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
  });
});

describe('EW-25 §AN — PRAGMA', () => {
  it('integrity_check bersih', async () => {
    const r = await db.getAllAsync<Record<string, string>>(`PRAGMA integrity_check`);
    expect(Object.values(r[0])[0]).toBe('ok');
  });

  it('foreign_key_check tidak menemukan pelanggaran', async () => {
    const r = await db.getAllAsync<Record<string, unknown>>(`PRAGMA foreign_key_check`);
    expect(r).toEqual([]);
  });
});

describe('EW-25 §AN — pemindaian anomali', () => {
  const nol = async (sql: string) => {
    const r = await db.getFirstAsync<{ n: number }>(sql);
    return r!.n;
  };

  it('tidak ada settlement dini yatim (kontraknya hilang)', async () => {
    expect(
      await nol(`SELECT COUNT(*) n FROM simpanan_berjangka_pencairan_dini d
                 LEFT JOIN simpanan_berjangka k ON k.id = d.simpanan_berjangka_id
                 WHERE k.id IS NULL`)
    ).toBe(0);
  });

  it('tidak ada settlement dini tanpa jurnal', async () => {
    expect(
      await nol(`SELECT COUNT(*) n FROM simpanan_berjangka_pencairan_dini d
                 LEFT JOIN journal j ON j.id = d.journal_id
                 WHERE j.id IS NULL`)
    ).toBe(0);
  });

  it('tidak ada akrual bunga yatim', async () => {
    expect(
      await nol(`SELECT COUNT(*) n FROM simpanan_berjangka_bunga b
                 LEFT JOIN simpanan_berjangka k ON k.id = b.simpanan_berjangka_id
                 WHERE k.id IS NULL`)
    ).toBe(0);
  });

  it('tidak ada duplicate settlement per kontrak', async () => {
    expect(
      await nol(`SELECT COUNT(*) n FROM (
                   SELECT simpanan_berjangka_id FROM simpanan_berjangka_pencairan_dini
                   GROUP BY simpanan_berjangka_id HAVING COUNT(*) > 1)`)
    ).toBe(0);
  });

  it('tidak ada duplicate accrual per periode', async () => {
    expect(
      await nol(`SELECT COUNT(*) n FROM (
                   SELECT simpanan_berjangka_id, nomor_periode FROM simpanan_berjangka_bunga
                   GROUP BY 1,2 HAVING COUNT(*) > 1)`)
    ).toBe(0);
  });

  it('tidak ada nilai negatif pada pokok/bunga/komponen settlement', async () => {
    expect(await nol(`SELECT COUNT(*) n FROM simpanan_berjangka WHERE nominal < 0 OR bunga_terakru < 0 OR bunga_dibayar < 0`)).toBe(0);
    expect(
      await nol(`SELECT COUNT(*) n FROM simpanan_berjangka_pencairan_dini
                 WHERE pokok_bruto < 0 OR bunga_bruto < 0 OR bunga_hangus < 0
                    OR penalti < 0 OR biaya_admin < 0 OR pokok_dibayar < 0
                    OR bunga_dibayar < 0 OR total_payout < 0`)
    ).toBe(0);
  });

  it('tidak ada phantom payable: kontrak CLOSED tanpa sisa utang bunga', async () => {
    expect(
      await nol(`SELECT COUNT(*) n FROM simpanan_berjangka
                 WHERE status = 'DICAIRKAN' AND bunga_terakru - bunga_dibayar <> 0
                   AND id NOT IN (SELECT simpanan_berjangka_id FROM simpanan_berjangka_pencairan_dini)`)
    ).toBe(0);
  });

  it('hanya SATU kebijakan berstatus AKTIF', async () => {
    expect(
      await nol(`SELECT COUNT(*) n FROM simpanan_berjangka_kebijakan_dini WHERE status = 'AKTIF'`)
    ).toBe(1);
  });

  it('setiap jurnal pencairan dini seimbang', async () => {
    const r = await db.getAllAsync<{ d: number; k: number }>(
      `SELECT SUM(je.debit) d, SUM(je.kredit) k FROM journal_entry je
       JOIN journal j ON j.id = je.journal_id
       WHERE j.sumber_transaksi = 'SIMPANAN_BERJANGKA_PENCAIRAN_DINI'
       GROUP BY j.id`
    );
    expect(r.length).toBeGreaterThan(0);
    for (const b of r) expect(b.d).toBe(b.k);
  });

  it('seluruh nominal jurnal berupa Rupiah bulat', async () => {
    expect(
      await nol(`SELECT COUNT(*) n FROM journal_entry
                 WHERE debit <> CAST(debit AS INTEGER) OR kredit <> CAST(kredit AS INTEGER)`)
    ).toBe(0);
  });
});

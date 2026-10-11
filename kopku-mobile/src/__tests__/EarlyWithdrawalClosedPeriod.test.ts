jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  siapkanDb, pasangKebijakan, snapshotBuku,
  KEBIJAKAN_ENAM_KOMPONEN, USER_ID, TANGGAL_TARIK,
} from './earlyWithdrawalHarness';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import { prosesAkrualBungaKontrak } from '@/services/SimpananBerjangkaLifecycleService';
import { cairkanSimpananBerjangkaDini } from '@/services/SimpananBerjangkaEarlyWithdrawalService';

/** EW-16 §AC — CLOSED PERIOD. */

let db: TestDb;
let kontrakId: string;

beforeEach(async () => {
  db = await siapkanDb();
  await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
  kontrakId = await buatKontrakUji();
});

describe('EW-16 §AC — pencairan dini historis di periode CLOSED ditolak total', () => {
  it('snapshot sebelum & sesudah identik pada seluruh objek', async () => {
    await prosesAkrualBungaKontrak(kontrakId, TANGGAL_TARIK, USER_ID);
    await db.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);

    const sebelum = await snapshotBuku(db);

    await expect(
      cairkanSimpananBerjangkaDini({
        kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
      })
    ).rejects.toThrow();

    const sesudah = await snapshotBuku(db);
    // contract, interest, cash, journal, journal_entry, GL, subledger, period
    expect(sesudah).toEqual(sebelum);
  });

  it('tidak ada baris settlement yang tertinggal', async () => {
    await prosesAkrualBungaKontrak(kontrakId, TANGGAL_TARIK, USER_ID);
    await db.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    await expect(
      cairkanSimpananBerjangkaDini({
        kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
      })
    ).rejects.toThrow();
    const n = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM simpanan_berjangka_pencairan_dini`
    );
    expect(n!.n).toBe(0);
  });

  it('status kontrak tetap AKTIF — tidak berubah separuh jalan', async () => {
    await prosesAkrualBungaKontrak(kontrakId, TANGGAL_TARIK, USER_ID);
    await db.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    await expect(
      cairkanSimpananBerjangkaDini({
        kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
      })
    ).rejects.toThrow();
    const k = await db.getFirstAsync<{ status: string }>(
      `SELECT status FROM simpanan_berjangka WHERE id = ?`, kontrakId
    );
    expect(k!.status).toBe('AKTIF');
  });

  it('akrual yang belum selesai pun tidak menembus periode tertutup', async () => {
    // Akrual sengaja BELUM dijalankan: alur pencairan akan mencoba
    // mengakru di dalam transaksinya, dan itu juga harus ditolak.
    await db.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    const sebelum = await snapshotBuku(db);
    await expect(
      cairkanSimpananBerjangkaDini({
        kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
      })
    ).rejects.toThrow();
    expect(await snapshotBuku(db)).toEqual(sebelum);
  });

  it('setelah periode dibuka kembali, pencairan yang sama berhasil', async () => {
    await prosesAkrualBungaKontrak(kontrakId, TANGGAL_TARIK, USER_ID);
    await db.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'p2026'`);
    await expect(
      cairkanSimpananBerjangkaDini({
        kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
      })
    ).rejects.toThrow();

    await db.runAsync(`UPDATE accounting_period SET status = 'OPEN' WHERE id = 'p2026'`);
    const hasil = await cairkanSimpananBerjangkaDini({
      kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
    });
    expect(hasil.settlement!.totalPayout).toBe(23_560_000);
  });
});

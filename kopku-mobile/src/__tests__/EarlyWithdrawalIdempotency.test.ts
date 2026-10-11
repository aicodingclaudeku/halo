jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  siapkanDb, pasangKebijakan, snapshotBuku,
  KEBIJAKAN_ENAM_KOMPONEN, USER_ID, TANGGAL_TARIK,
} from './earlyWithdrawalHarness';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import { prosesAkrualBungaKontrak } from '@/services/SimpananBerjangkaLifecycleService';
import { cairkanSimpananBerjangkaDini } from '@/services/SimpananBerjangkaEarlyWithdrawalService';

/** EW-14 §AA — IDEMPOTENSI. */

let db: TestDb;
let kontrakId: string;

beforeEach(async () => {
  db = await siapkanDb();
  await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
  kontrakId = await buatKontrakUji();
  await prosesAkrualBungaKontrak(kontrakId, TANGGAL_TARIK, USER_ID);
});

describe('EW-14 §AA — retry dengan kunci yang sama', () => {
  it('dua kali eksekusi -> satu payout, satu jurnal, satu settlement', async () => {
    const kunci = 'idem-dini-1';
    const pertama = await cairkanSimpananBerjangkaDini({
      kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS',
      idempotencyKey: kunci, createdBy: USER_ID,
    });
    const setelahSatu = await snapshotBuku(db);

    const kedua = await cairkanSimpananBerjangkaDini({
      kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS',
      idempotencyKey: kunci, createdBy: USER_ID,
    });

    expect(kedua.duplikat).toBe(true);
    expect(kedua.journalId).toBe(pertama.journalId);
    expect(kedua.settlementId).toBe(pertama.settlementId);

    // Tidak ada bunga, penalti, fee, kas, atau jurnal kedua.
    expect(await snapshotBuku(db)).toEqual(setelahSatu);
  });

  it('lima kali retry beruntun tetap satu efek', async () => {
    const kunci = 'idem-dini-5x';
    await cairkanSimpananBerjangkaDini({
      kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS',
      idempotencyKey: kunci, createdBy: USER_ID,
    });
    const acuan = await snapshotBuku(db);
    for (let i = 0; i < 5; i++) {
      await cairkanSimpananBerjangkaDini({
        kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS',
        idempotencyKey: kunci, createdBy: USER_ID,
      });
    }
    expect(await snapshotBuku(db)).toEqual(acuan);
    const n = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM simpanan_berjangka_pencairan_dini`
    );
    expect(n!.n).toBe(1);
  });
});

describe('EW-14 §AA — perlindungan struktural, bukan hanya pemeriksaan aplikasi', () => {
  it('tanpa kunci idempotensi pun, pencairan kedua tetap ditolak (status CLOSED)', async () => {
    await cairkanSimpananBerjangkaDini({
      kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
    });
    const acuan = await snapshotBuku(db);

    await expect(
      cairkanSimpananBerjangkaDini({
        kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
      })
    ).rejects.toThrow(/sudah dicairkan/i);

    expect(await snapshotBuku(db)).toEqual(acuan);
  });

  it('UNIQUE(simpanan_berjangka_id) membuat settlement ganda mustahil di level database', async () => {
    await cairkanSimpananBerjangkaDini({
      kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
    });
    await expect(
      db.runAsync(
        `INSERT INTO simpanan_berjangka_pencairan_dini
          (id, simpanan_berjangka_id, tanggal_pencairan, policy_versi, pokok_bruto,
           bunga_akrual_kontrak, bunga_bruto, pokok_dibayar, bunga_dibayar, total_payout,
           rate_kontrak, rate_efektif, created_by, created_at)
         VALUES ('dup','${kontrakId}','2026-09-15','X',1,0,0,1,0,1,6,6,'u','t')`
      )
    ).rejects.toThrow();
  });

  it('kunci idempotensi berbeda pada kontrak yang sama tetap ditolak — bukan payout kedua', async () => {
    await cairkanSimpananBerjangkaDini({
      kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS',
      idempotencyKey: 'kunci-a', createdBy: USER_ID,
    });
    const acuan = await snapshotBuku(db);
    await expect(
      cairkanSimpananBerjangkaDini({
        kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS',
        idempotencyKey: 'kunci-b', createdBy: USER_ID,
      })
    ).rejects.toThrow(/sudah dicairkan/i);
    expect(await snapshotBuku(db)).toEqual(acuan);
  });
});

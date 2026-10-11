jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  siapkanDb, pasangKebijakan, saldoGl,
  KEBIJAKAN_NETRAL, KEBIJAKAN_ENAM_KOMPONEN, ACC, USER_ID,
  POKOK, TANGGAL_TARIK, BUNGA_EARNED_3_PERIODE,
} from './earlyWithdrawalHarness';
import { MODAL_AWAL_KAS, MODAL_AWAL_BANK, BANK_ID } from './historicalFixture';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import { prosesAkrualBungaKontrak } from '@/services/SimpananBerjangkaLifecycleService';
import { cairkanSimpananBerjangkaDini } from '@/services/SimpananBerjangkaEarlyWithdrawalService';

/** EW-11 §N — CASH / BANK. */

let db: TestDb;

beforeEach(async () => {
  db = await siapkanDb();
});

describe('EW-11 §N — kas berkurang tepat sebesar net payout, sekali saja', () => {
  it('kas: saldo sebelum - total payout = saldo sesudah', async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    const id = await buatKontrakUji();
    await prosesAkrualBungaKontrak(id, TANGGAL_TARIK, USER_ID);

    const sebelum = await saldoGl(db, ACC.kas);
    // Penempatan simpanan berjangka MENAMBAH kas (Dr Kas / Cr 2-1210):
    // koperasi menerima dana anggota. Pencairan dini-lah yang
    // mengeluarkannya kembali.
    expect(sebelum).toBe(MODAL_AWAL_KAS + POKOK);

    const hasil = await cairkanSimpananBerjangkaDini({
      kontrakId: id, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
    });

    const sesudah = await saldoGl(db, ACC.kas);
    expect(sesudah).toBe(sebelum - hasil.settlement!.totalPayout);
    expect(sesudah).toBe(MODAL_AWAL_KAS + POKOK - 23_560_000);
  });

  it('penalti & biaya admin TIDAK membuat kas keluar dua kali', async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    const id = await buatKontrakUji();
    await prosesAkrualBungaKontrak(id, TANGGAL_TARIK, USER_ID);
    const sebelum = await saldoGl(db, ACC.kas);
    await cairkanSimpananBerjangkaDini({
      kontrakId: id, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
    });
    const keluar = sebelum - (await saldoGl(db, ACC.kas));

    // Kas keluar = pokok dibayar + bunga dibayar. Penalti (480.000) &
    // fee (50.000) diselesaikan sebagai potongan, bukan arus kas.
    expect(keluar).toBe(23_470_000 + 90_000);
    expect(keluar).not.toBe(23_560_000 + 480_000 + 50_000);
  });

  it('hanya SATU baris kas pada jurnal pencairan dini', async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    const id = await buatKontrakUji();
    await prosesAkrualBungaKontrak(id, TANGGAL_TARIK, USER_ID);
    await cairkanSimpananBerjangkaDini({
      kontrakId: id, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
    });
    const n = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM journal_entry je JOIN journal j ON j.id = je.journal_id
       WHERE j.sumber_transaksi = 'SIMPANAN_BERJANGKA_PENCAIRAN_DINI' AND je.account_id = ?`,
      ACC.kas
    );
    expect(n!.n).toBe(1);
  });
});

describe('EW-11 §N — cash movement = journal effect', () => {
  it('pembayaran lewat BANK memengaruhi rekening bank, bukan kas', async () => {
    await pasangKebijakan(db, KEBIJAKAN_NETRAL);
    const id = await buatKontrakUji();
    await prosesAkrualBungaKontrak(id, TANGGAL_TARIK, USER_ID);
    const kasSebelum = await saldoGl(db, ACC.kas);

    await cairkanSimpananBerjangkaDini({
      kontrakId: id, tanggal: TANGGAL_TARIK, sumberDana: 'BANK',
      bankAccountId: BANK_ID, createdBy: USER_ID,
    });

    expect(await saldoGl(db, ACC.kas)).toBe(kasSebelum); // kas tidak bergerak
    // Dana ditempatkan dari KAS tetapi dibayarkan lewat BANK, jadi
    // bank berkurang sebesar payout penuh.
    expect(await saldoGl(db, ACC.bank)).toBe(
      MODAL_AWAL_BANK - POKOK - BUNGA_EARNED_3_PERIODE
    );
  });

  it('sumber dana BANK tanpa rekening -> ditolak, kas tidak menjadi fallback', async () => {
    await pasangKebijakan(db, KEBIJAKAN_NETRAL);
    const id = await buatKontrakUji();
    await prosesAkrualBungaKontrak(id, TANGGAL_TARIK, USER_ID);
    const kasSebelum = await saldoGl(db, ACC.kas);

    await expect(
      cairkanSimpananBerjangkaDini({
        kontrakId: id, tanggal: TANGGAL_TARIK, sumberDana: 'BANK', createdBy: USER_ID,
      })
    ).rejects.toThrow(/bankAccountId wajib/);

    expect(await saldoGl(db, ACC.kas)).toBe(kasSebelum);
  });
});

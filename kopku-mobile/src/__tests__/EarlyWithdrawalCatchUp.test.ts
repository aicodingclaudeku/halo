jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  siapkanDb, pasangKebijakan, saldoGl, snapshotBuku,
  KEBIJAKAN_NETRAL, KEBIJAKAN_ENAM_KOMPONEN, ACC, USER_ID, TANGGAL_TARIK,
} from './earlyWithdrawalHarness';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import {
  prosesAkrualBungaKontrak,
  prosesAkrualBungaSemuaKontrak,
} from '@/services/SimpananBerjangkaLifecycleService';
import { cairkanSimpananBerjangkaDini } from '@/services/SimpananBerjangkaEarlyWithdrawalService';

/** EW-13 §Y — PENARIKAN DINI + CATCH-UP AKRUAL. */

let db: TestDb;
let kontrakId: string;

beforeEach(async () => {
  db = await siapkanDb();
  kontrakId = await buatKontrakUji();
});

async function jumlahPeriodeAkrual(): Promise<number> {
  const r = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) n FROM simpanan_berjangka_bunga WHERE simpanan_berjangka_id = ?`, kontrakId
  );
  return r!.n;
}

describe('EW-13 §Y — catch-up sebelum pencairan dini', () => {
  it('akrual yang tertinggal diselesaikan di dalam transaksi pencairan', async () => {
    await pasangKebijakan(db, KEBIJAKAN_NETRAL);
    // Hanya satu periode diakru lebih dulu; dua sisanya tertinggal.
    await prosesAkrualBungaKontrak(kontrakId, '2026-07-12', USER_ID);
    expect(await jumlahPeriodeAkrual()).toBe(1);

    const hasil = await cairkanSimpananBerjangkaDini({
      kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
    });

    expect(await jumlahPeriodeAkrual()).toBe(3); // catch-up terjadi
    expect(hasil.settlement!.bungaAkrualKontrak).toBe(360_000);
    expect(await saldoGl(db, ACC.utangBungaBerjangka)).toBe(0);
  });

  it('tanpa akrual sama sekali pun hasilnya sama — catch-up tidak mengubah angka', async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    const hasil = await cairkanSimpananBerjangkaDini({
      kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
    });
    expect(hasil.settlement!.bungaAkrualKontrak).toBe(360_000);
    expect(hasil.settlement!.totalPayout).toBe(23_560_000);
  });

  it('catch-up TIDAK mengakru melebihi tanggal pencairan', async () => {
    await pasangKebijakan(db, KEBIJAKAN_NETRAL);
    await cairkanSimpananBerjangkaDini({
      kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
    });
    // Periode 4/5/6 (Okt/Nov/Des) belum earned pada 15 Sep.
    const periode = await db.getAllAsync<{ nomor_periode: number }>(
      `SELECT nomor_periode FROM simpanan_berjangka_bunga WHERE simpanan_berjangka_id = ? ORDER BY nomor_periode`,
      kontrakId
    );
    expect(periode.map((p) => p.nomor_periode)).toEqual([1, 2, 3]);
  });
});

describe('EW-13 §Y — catch-up SETELAH settlement tidak boleh berjalan lagi', () => {
  beforeEach(async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    await cairkanSimpananBerjangkaDini({
      kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
    });
  });

  it('akrual per kontrak pada kontrak DICAIRKAN tidak menambah apa pun', async () => {
    const sebelum = await snapshotBuku(db);
    const hasil = await prosesAkrualBungaKontrak(kontrakId, '2026-12-31', USER_ID);
    expect(hasil.periodeDiakui).toEqual([]);
    expect(await snapshotBuku(db)).toEqual(sebelum);
  });

  it('akrual massal melewati kontrak yang sudah CLOSED', async () => {
    const sebelum = await snapshotBuku(db);
    const hasil = await prosesAkrualBungaSemuaKontrak('2026-12-31', USER_ID);
    expect(hasil.diproses).toEqual([]);
    expect(hasil.gagal).toEqual([]);
    expect(await snapshotBuku(db)).toEqual(sebelum);
  });

  it('tidak ada double accrue: total bunga event tetap 3 periode', async () => {
    await prosesAkrualBungaKontrak(kontrakId, '2026-12-31', USER_ID);
    await prosesAkrualBungaSemuaKontrak('2027-06-30', USER_ID);
    expect(await jumlahPeriodeAkrual()).toBe(3);
    expect(await saldoGl(db, ACC.utangBungaBerjangka)).toBe(0);
  });

  it('kontrak yang sudah CLOSED tidak berubah statusnya oleh proses akrual', async () => {
    await prosesAkrualBungaSemuaKontrak('2027-06-30', USER_ID);
    const k = await db.getFirstAsync<{ status: string; bunga_dibayar: number }>(
      `SELECT status, bunga_dibayar FROM simpanan_berjangka WHERE id = ?`, kontrakId
    );
    expect(k!.status).toBe('DICAIRKAN');
    expect(k!.bunga_dibayar).toBe(90_000);
  });
});

jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  siapkanDb, pasangKebijakan, saldoGl,
  KEBIJAKAN_ENAM_KOMPONEN, ACC, USER_ID, POKOK, TANGGAL_TARIK, JATUH_TEMPO,
} from './earlyWithdrawalHarness';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import { prosesAkrualBungaKontrak, getTotalUtangBungaBerjangkaPadaDb } from '@/services/SimpananBerjangkaLifecycleService';
import { getTotalPokokSimpananBerjangkaPadaDb } from '@/services/SimpananBerjangkaService';
import {
  cairkanSimpananBerjangkaDini,
  getPencairanDiniKontrak,
} from '@/services/SimpananBerjangkaEarlyWithdrawalService';

/** EW-10 §M — SUBLEDGER setelah penarikan dini. */

let db: TestDb;
let kontrakId: string;

beforeEach(async () => {
  db = await siapkanDb();
  await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
  kontrakId = await buatKontrakUji();
  await prosesAkrualBungaKontrak(kontrakId, TANGGAL_TARIK, USER_ID);
  await cairkanSimpananBerjangkaDini({
    kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS',
    alasan: 'biaya pengobatan', createdBy: USER_ID,
  });
});

describe('EW-10 §M — status & saldo kontrak', () => {
  it('status berubah ke DICAIRKAN (enum yang sudah ada, bukan status baru)', async () => {
    const k = await db.getFirstAsync<{ status: string; tanggal_pencairan: string }>(
      `SELECT status, tanggal_pencairan FROM simpanan_berjangka WHERE id = ?`, kontrakId
    );
    expect(k!.status).toBe('DICAIRKAN');
    expect(k!.tanggal_pencairan).toBe(TANGGAL_TARIK);
  });

  it('saldo pokok subledger = 0 dan cocok dengan GL 2-1210', async () => {
    expect(await getTotalPokokSimpananBerjangkaPadaDb(db as any)).toBe(0);
    expect(await saldoGl(db, ACC.berjangka)).toBe(0);
  });

  it('saldo bunga payable subledger = 0 dan cocok dengan GL 2-1710', async () => {
    expect(await getTotalUtangBungaBerjangkaPadaDb(db as any)).toBe(0);
    expect(await saldoGl(db, ACC.utangBungaBerjangka)).toBe(0);
  });

  it('bunga_dibayar pada kontrak = bunga yang benar-benar dibayarkan, bukan bunga bruto', async () => {
    const k = await db.getFirstAsync<{ bunga_terakru: number; bunga_dibayar: number }>(
      `SELECT bunga_terakru, bunga_dibayar FROM simpanan_berjangka WHERE id = ?`, kontrakId
    );
    expect(k!.bunga_terakru).toBe(360_000);
    expect(k!.bunga_dibayar).toBe(90_000);
  });

  it('pokok kontrak TIDAK diubah — nominal tetap pokok asli', async () => {
    const k = await db.getFirstAsync<{ nominal: number }>(
      `SELECT nominal FROM simpanan_berjangka WHERE id = ?`, kontrakId
    );
    expect(k!.nominal).toBe(POKOK);
  });
});

describe('EW-10 §M/§AJ — informasi audit tersimpan lengkap', () => {
  it('baris settlement memuat seluruh komponen perhitungan', async () => {
    const d = await getPencairanDiniKontrak(kontrakId);
    expect(d).not.toBeNull();
    expect(d).toMatchObject({
      tanggalPencairan: TANGGAL_TARIK,
      policyVersi: 'EW-UJI-ENAM',
      pokokBruto: 24_000_000,
      bungaAkrualKontrak: 360_000,
      penyesuaianRate: -180_000,
      bungaBruto: 180_000,
      bungaHangus: 90_000,
      penalti: 480_000,
      biayaAdmin: 50_000,
      penyesuaianPokok: 530_000,
      penyesuaianBunga: 0,
      pokokDibayar: 23_470_000,
      bungaDibayar: 90_000,
      totalPayout: 23_560_000,
      rateKontrak: 6,
      rateEfektif: 3,
      alasan: 'biaya pengobatan',
      createdBy: USER_ID,
    });
  });

  it('settlement tertaut ke jurnalnya — jejak audit dapat ditelusuri dua arah', async () => {
    const d = await getPencairanDiniKontrak(kontrakId);
    const j = await db.getFirstAsync<{ sumber_id: string; created_by: string }>(
      `SELECT sumber_id, created_by FROM journal WHERE id = ?`, d!.journalId!
    );
    expect(j!.sumber_id).toBe(kontrakId);
    expect(j!.created_by).toBe(USER_ID);
  });

  it('§M — tidak ada kolom baru pada simpanan_berjangka', async () => {
    const kolom = (
      await db.getAllAsync<{ name: string }>(`PRAGMA table_info(simpanan_berjangka)`)
    ).map((c) => c.name);
    expect(kolom.some((k) => /penalti|forfeit|admin|fee|hangus/i.test(k))).toBe(false);
  });

  it('kontrak yang sudah CLOSED tidak bisa dicairkan dini lagi', async () => {
    await expect(
      cairkanSimpananBerjangkaDini({
        kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
      })
    ).rejects.toThrow(/sudah dicairkan/i);
  });

  it('kontrak CLOSED tidak lagi muncul sebagai kewajiban jatuh tempo', async () => {
    const k = await db.getFirstAsync<{ status: string }>(
      `SELECT status FROM simpanan_berjangka WHERE id = ? AND tanggal_jatuh_tempo = ?`,
      kontrakId, JATUH_TEMPO
    );
    expect(k!.status).toBe('DICAIRKAN');
  });
});

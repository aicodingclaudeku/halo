jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  siapkanDb, pasangKebijakan,
  KEBIJAKAN_ENAM_KOMPONEN, USER_ID, ANGGOTA_ID, TANGGAL_TARIK,
} from './earlyWithdrawalHarness';
import { ANGGOTA_2_ID } from './historicalFixture';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import { prosesAkrualBungaKontrak } from '@/services/SimpananBerjangkaLifecycleService';
import {
  cairkanSimpananBerjangkaDini,
  listPencairanDini,
} from '@/services/SimpananBerjangkaEarlyWithdrawalService';
import { listSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import { listHistoryTransaksi, labelJenisTransaksi } from '@/services/HistoryTransaksiService';

/** EW-19 §AG — RIWAYAT ANGGOTA. */

let db: TestDb;
let kontrakId: string;

beforeEach(async () => {
  db = await siapkanDb();
  await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
  kontrakId = await buatKontrakUji();
  await prosesAkrualBungaKontrak(kontrakId, TANGGAL_TARIK, USER_ID);
  await cairkanSimpananBerjangkaDini({
    kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS',
    alasan: 'renovasi rumah', createdBy: USER_ID,
  });
});

describe('EW-19 §AG — seluruh tahap siklus hidup terlihat', () => {
  it('penempatan, akrual, dan pencairan dini masing-masing punya jurnalnya', async () => {
    const rows = await db.getAllAsync<{ sumber_transaksi: string; n: number }>(
      `SELECT sumber_transaksi, COUNT(*) n FROM journal
       WHERE sumber_transaksi LIKE 'SIMPANAN_BERJANGKA%' GROUP BY sumber_transaksi ORDER BY sumber_transaksi`
    );
    expect(rows).toEqual([
      { sumber_transaksi: 'SIMPANAN_BERJANGKA', n: 1 },
      { sumber_transaksi: 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL', n: 3 },
      { sumber_transaksi: 'SIMPANAN_BERJANGKA_PENCAIRAN_DINI', n: 1 },
    ]);
  });

  it('history transaksi memberi label yang membedakan pencairan dini', async () => {
    expect(labelJenisTransaksi('SIMPANAN_BERJANGKA_PENCAIRAN_DINI')).toBe(
      'Pencairan Dini Simpanan Berjangka'
    );
    expect(labelJenisTransaksi('SIMPANAN_BERJANGKA_PENCAIRAN')).toBe(
      'Pencairan Simpanan Berjangka'
    );
    const h = await listHistoryTransaksi({});
    const dini = h.find((x) => x.jenisTransaksi === 'SIMPANAN_BERJANGKA_PENCAIRAN_DINI');
    expect(dini).toBeDefined();
    expect(dini!.jenisLabel).toBe('Pencairan Dini Simpanan Berjangka');
    expect(dini!.tanggal).toBe(TANGGAL_TARIK);
  });
});

describe('EW-19 §AG — breakdown, bukan hanya total', () => {
  it('riwayat pencairan dini memuat setiap komponen', async () => {
    const [d] = await listPencairanDini(ANGGOTA_ID);
    expect(d).toMatchObject({
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
      alasan: 'renovasi rumah',
    });
  });

  it('riwayat menyebut nomor kontrak & anggota pemiliknya', async () => {
    const [d] = await listPencairanDini(ANGGOTA_ID);
    expect(d.anggotaId).toBe(ANGGOTA_ID);
    expect(d.nomorTransaksi).toMatch(/^SPB-/);
    expect(d.kontrakId).toBe(kontrakId);
  });

  it('riwayat anggota lain tidak tercampur', async () => {
    expect(await listPencairanDini(ANGGOTA_2_ID)).toEqual([]);
    expect((await listPencairanDini(ANGGOTA_ID)).length).toBe(1);
    expect((await listPencairanDini()).length).toBe(1);
  });

  it('kontrak pada daftar simpanan berjangka menunjukkan status & bunga dibayar', async () => {
    const [k] = await listSimpananBerjangka(ANGGOTA_ID);
    expect(k.status).toBe('DICAIRKAN');
    expect(k.tanggalPencairan).toBe(TANGGAL_TARIK);
    expect(k.bungaDibayar).toBe(90_000);
    // Total naif "pokok + bunga dibayar" TIDAK sama dengan yang
    // diterima anggota — itulah sebabnya layar riwayat wajib memakai
    // baris settlement, bukan menghitung sendiri.
    expect(k.nominal + k.bungaDibayar).not.toBe(23_560_000);
  });
});

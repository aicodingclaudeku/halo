jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  harness, siapkanDb, pasangKebijakan, saldoGl, snapshotBuku,
  KEBIJAKAN_ENAM_KOMPONEN, ACC, USER_ID, ANGGOTA_ID, POKOK, PLACEMENT,
} from './earlyWithdrawalHarness';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import { prosesAkrualBungaKontrak } from '@/services/SimpananBerjangkaLifecycleService';
import {
  cairkanSimpananBerjangkaDini,
  getPencairanDiniKontrak,
} from '@/services/SimpananBerjangkaEarlyWithdrawalService';
import { catatPemasukan } from '@/services/KasBankService';

/**
 * EW-12 §X/§Z — TRANSAKSI HISTORIS & INPUT BACKDATED.
 *
 * Yang dijaga: tanggal BISNIS (2026-08-15) yang menentukan bunga,
 * jurnal, periode, dan laporan — bukan kapan operator mengetiknya.
 */

const TANGGAL_BISNIS = '2026-08-15'; // 2 periode bunga sudah earned

let db: TestDb;

beforeEach(async () => {
  db = await siapkanDb();
  await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
});

describe('EW-12 §X — tanggal bisnis, bukan tanggal input', () => {
  it('bunga dihitung sampai tanggal bisnis, bukan sampai hari ini', async () => {
    const id = await buatKontrakUji();
    await prosesAkrualBungaKontrak(id, TANGGAL_BISNIS, USER_ID);
    const hasil = await cairkanSimpananBerjangkaDini({
      kontrakId: id, tanggal: TANGGAL_BISNIS, sumberDana: 'KAS', createdBy: USER_ID,
    });
    // 12 Jul & 12 Agu = 2 periode x 120.000 pada rate kontrak.
    expect(hasil.settlement!.periodeBerjalan).toBe(2);
    expect(hasil.settlement!.bungaAkrualKontrak).toBe(240_000);
    // Rate dini 3% sejak penempatan: 2 x 60.000.
    expect(hasil.settlement!.bungaBruto).toBe(120_000);
  });

  it('tanggal transaksi, tanggal kas, tanggal jurnal, dan tanggal periode konsisten', async () => {
    const id = await buatKontrakUji();
    await prosesAkrualBungaKontrak(id, TANGGAL_BISNIS, USER_ID);
    await cairkanSimpananBerjangkaDini({
      kontrakId: id, tanggal: TANGGAL_BISNIS, sumberDana: 'KAS', createdBy: USER_ID,
    });

    const d = await getPencairanDiniKontrak(id);
    expect(d!.tanggalPencairan).toBe(TANGGAL_BISNIS);

    const j = await db.getFirstAsync<{ tanggal: string; period_id: string }>(
      `SELECT tanggal, period_id FROM journal WHERE id = ?`, d!.journalId!
    );
    expect(j!.tanggal).toBe(TANGGAL_BISNIS); // jurnal & kas satu baris yang sama
    expect(j!.period_id).toBe('p2026'); // masuk periode laporan yang benar

    const k = await db.getFirstAsync<{ tanggal_pencairan: string }>(
      `SELECT tanggal_pencairan FROM simpanan_berjangka WHERE id = ?`, id
    );
    expect(k!.tanggal_pencairan).toBe(TANGGAL_BISNIS);
  });

  it('created_at (waktu input) berbeda dari tanggal bisnis — keduanya disimpan terpisah', async () => {
    const id = await buatKontrakUji();
    await prosesAkrualBungaKontrak(id, TANGGAL_BISNIS, USER_ID);
    await cairkanSimpananBerjangkaDini({
      kontrakId: id, tanggal: TANGGAL_BISNIS, sumberDana: 'KAS', createdBy: USER_ID,
    });
    const d = await getPencairanDiniKontrak(id);
    expect(d!.tanggalPencairan).toBe(TANGGAL_BISNIS);
    expect(d!.createdAt.slice(0, 10)).not.toBe(TANGGAL_BISNIS);
  });
});

describe('EW-12 §Z — urutan input tidak mengubah hasil akuntansi', () => {
  /**
   * Database A: kronologis (pencairan dini dulu, lalu transaksi kas
   * bulan berikutnya). Database B: acak (transaksi masa depan lebih
   * dulu, pencairan dini historis dimasukkan belakangan).
   */
  async function bangun(urutan: 'kronologis' | 'acak') {
    const database = await siapkanDb();
    await pasangKebijakan(database, KEBIJAKAN_ENAM_KOMPONEN);
    const id = await buatKontrakUji();

    const masaDepan = async () => {
      await catatPemasukan({
        jenis: 'KAS',
        tanggal: '2026-10-20',
        nominal: 5_000_000,
        akunLawanId: ACC.pendapatanLain,
        keterangan: 'penerimaan lain setelah pencairan',
        createdBy: USER_ID,
      });
    };
    const pencairanHistoris = async () => {
      await prosesAkrualBungaKontrak(id, TANGGAL_BISNIS, USER_ID);
      await cairkanSimpananBerjangkaDini({
        kontrakId: id, tanggal: TANGGAL_BISNIS, sumberDana: 'KAS', createdBy: USER_ID,
      });
    };

    if (urutan === 'kronologis') {
      await pencairanHistoris();
      await masaDepan();
    } else {
      await masaDepan();
      await pencairanHistoris();
    }
    return { database, id };
  }

  it('saldo GL & settlement identik pada kedua urutan', async () => {
    const a = await bangun('kronologis');
    const glA = {
      kas: await saldoGl(a.database, ACC.kas),
      berjangka: await saldoGl(a.database, ACC.berjangka),
      utangBunga: await saldoGl(a.database, ACC.utangBungaBerjangka),
      beban: await saldoGl(a.database, ACC.bebanBungaBerjangka),
      denda: await saldoGl(a.database, ACC.pendapatanDenda),
      admin: await saldoGl(a.database, ACC.pendapatanAdmin),
    };
    const settlementA = await db.getAllAsync<Record<string, unknown>>(
      `SELECT policy_versi, pokok_bruto, bunga_akrual_kontrak, penyesuaian_rate, bunga_bruto,
              bunga_hangus, penalti, biaya_admin, pokok_dibayar, bunga_dibayar, total_payout
       FROM simpanan_berjangka_pencairan_dini`
    );

    const b = await bangun('acak');
    const glB = {
      kas: await saldoGl(b.database, ACC.kas),
      berjangka: await saldoGl(b.database, ACC.berjangka),
      utangBunga: await saldoGl(b.database, ACC.utangBungaBerjangka),
      beban: await saldoGl(b.database, ACC.bebanBungaBerjangka),
      denda: await saldoGl(b.database, ACC.pendapatanDenda),
      admin: await saldoGl(b.database, ACC.pendapatanAdmin),
    };
    const settlementB = await db.getAllAsync<Record<string, unknown>>(
      `SELECT policy_versi, pokok_bruto, bunga_akrual_kontrak, penyesuaian_rate, bunga_bruto,
              bunga_hangus, penalti, biaya_admin, pokok_dibayar, bunga_dibayar, total_payout
       FROM simpanan_berjangka_pencairan_dini`
    );

    expect(glB).toEqual(glA);
    expect(settlementB).toEqual(settlementA);
  });
});

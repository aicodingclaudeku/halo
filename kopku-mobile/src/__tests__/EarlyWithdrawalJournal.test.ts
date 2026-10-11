jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  harness, siapkanDb, pasangKebijakan, saldoGl, totalDebitKredit,
  KEBIJAKAN_NETRAL, KEBIJAKAN_ENAM_KOMPONEN, ACC, USER_ID,
  POKOK, TANGGAL_TARIK, BUNGA_EARNED_3_PERIODE,
} from './earlyWithdrawalHarness';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import { prosesAkrualBungaKontrak } from '@/services/SimpananBerjangkaLifecycleService';
import {
  cairkanSimpananBerjangkaDini,
  TRANSAKSI_PENCAIRAN_DINI,
} from '@/services/SimpananBerjangkaEarlyWithdrawalService';

/**
 * EW-09 §L — JURNAL PENARIKAN DINI.
 *
 * Pola debit/kredit di sini TIDAK ditebak: ia dibentuk dari pola payout
 * normal yang sudah ada (Dr 2-1210 pokok, Dr 2-1710 bunga, Cr Kas),
 * lalu ditambah komponen kebijakan. Sisi debit tetap POKOK PENUH +
 * BUNGA TERAKRU PENUH karena itulah kewajiban yang tercatat di buku;
 * penalti & biaya admin diselesaikan sebagai offset pembayaran.
 */

let db: TestDb;

async function barisJurnalDini() {
  return db.getAllAsync<{ kode: string; debit: number; kredit: number }>(
    `SELECT a.kode, je.debit, je.kredit
     FROM journal_entry je
     JOIN journal j ON j.id = je.journal_id
     JOIN account a ON a.id = je.account_id
     WHERE j.sumber_transaksi = ?
     ORDER BY a.kode`,
    TRANSAKSI_PENCAIRAN_DINI
  );
}

beforeEach(async () => {
  db = await siapkanDb();
});

describe('EW-09 §P — no-adjustment: jurnal minimal, tanpa baris phantom', () => {
  it('hanya tiga baris: pokok, utang bunga, kas', async () => {
    await pasangKebijakan(db, KEBIJAKAN_NETRAL);
    const id = await buatKontrakUji();
    await prosesAkrualBungaKontrak(id, TANGGAL_TARIK, USER_ID);

    await cairkanSimpananBerjangkaDini({
      kontrakId: id, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
    });

    expect(await barisJurnalDini()).toEqual([
      { kode: '1-1000', debit: 0, kredit: POKOK + BUNGA_EARNED_3_PERIODE },
      { kode: '2-1210', debit: POKOK, kredit: 0 },
      { kode: '2-1710', debit: BUNGA_EARNED_3_PERIODE, kredit: 0 },
    ]);
  });
});

describe('EW-09 §AQ — jurnal enam komponen, setiap baris dapat ditelusuri', () => {
  beforeEach(async () => {
    await pasangKebijakan(db, KEBIJAKAN_ENAM_KOMPONEN);
    const id = await buatKontrakUji();
    await prosesAkrualBungaKontrak(id, TANGGAL_TARIK, USER_ID);
    await cairkanSimpananBerjangkaDini({
      kontrakId: id, tanggal: TANGGAL_TARIK, sumberDana: 'KAS',
      alasan: 'kebutuhan mendesak anggota', createdBy: USER_ID,
    });
  });

  it('setiap komponen punya barisnya sendiri', async () => {
    expect(await barisJurnalDini()).toEqual([
      { kode: '1-1000', debit: 0, kredit: 23_560_000 }, // kas keluar = net payout
      { kode: '2-1210', debit: 24_000_000, kredit: 0 }, // pelunasan pokok PENUH
      { kode: '2-1710', debit: 360_000, kredit: 0 }, // penyelesaian bunga PENUH
      { kode: '4-1100', debit: 0, kredit: 50_000 }, // biaya administrasi
      { kode: '4-1200', debit: 0, kredit: 480_000 }, // penalti
      { kode: '5-1955', debit: 0, kredit: 270_000 }, // pembalikan beban bunga
    ]);
  });

  it('debit = kredit pada jurnal ini dan pada seluruh buku', async () => {
    const baris = await barisJurnalDini();
    const d = baris.reduce((a, b) => a + b.debit, 0);
    const k = baris.reduce((a, b) => a + b.kredit, 0);
    expect(d).toBe(k);
    expect(d).toBe(24_360_000);

    const total = await totalDebitKredit(db);
    expect(total.debit).toBe(total.kredit);
  });

  it('liabilitas pokok & bunga NOL setelah pencairan — tidak ada phantom balance', async () => {
    expect(await saldoGl(db, ACC.berjangka)).toBe(0);
    expect(await saldoGl(db, ACC.utangBungaBerjangka)).toBe(0);
  });

  it('beban bunga tersisa = bunga yang benar-benar dibayar anggota', async () => {
    // Akrual 360.000 didebit; 270.000 dibalik (90.000 hangus +
    // 180.000 pengurangan rate) -> sisa 90.000 = bunga dibayar.
    expect(await saldoGl(db, ACC.bebanBungaBerjangka)).toBe(90_000);
  });

  it('bunga yang dibatalkan TIDAK menjadi pendapatan palsu (§AE)', async () => {
    // Pendapatan hanya penalti & biaya admin — tidak ada pendapatan
    // sebesar bunga hangus di akun mana pun.
    expect(await saldoGl(db, ACC.pendapatanDenda)).toBe(480_000);
    expect(await saldoGl(db, ACC.pendapatanAdmin)).toBe(50_000);
    expect(await saldoGl(db, ACC.pendapatanLain)).toBe(0);
    expect(await saldoGl(db, ACC.pendapatanJasa)).toBe(0);
  });

  it('jurnal memakai sumber transaksi khusus penarikan dini', async () => {
    const j = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = ?`,
      TRANSAKSI_PENCAIRAN_DINI
    );
    expect(j!.n).toBe(1);
  });

  it('setiap baris jurnal punya keterangan komponennya', async () => {
    const baris = await db.getAllAsync<{ keterangan: string | null }>(
      `SELECT je.keterangan FROM journal_entry je
       JOIN journal j ON j.id = je.journal_id
       WHERE j.sumber_transaksi = ?`,
      TRANSAKSI_PENCAIRAN_DINI
    );
    expect(baris.every((b) => !!b.keterangan)).toBe(true);
  });
});

describe('EW-09 — rate dini LEBIH TINGGI: beban bertambah, jurnal tetap balance', () => {
  it('pembalikan beban berbalik arah menjadi debit', async () => {
    await pasangKebijakan(db, {
      ...KEBIJAKAN_NETRAL,
      versi: 'EW-UJI-RATE-NAIK',
      jenisPenyesuaianRate: 'RATE_DINI',
      rateDini: 12,
      cakupanPenyesuaianRate: 'SEJAK_PENEMPATAN',
    });
    const id = await buatKontrakUji();
    await prosesAkrualBungaKontrak(id, TANGGAL_TARIK, USER_ID);
    await cairkanSimpananBerjangkaDini({
      kontrakId: id, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID,
    });

    expect(await barisJurnalDini()).toEqual([
      { kode: '1-1000', debit: 0, kredit: POKOK + 720_000 },
      { kode: '2-1210', debit: POKOK, kredit: 0 },
      { kode: '2-1710', debit: 360_000, kredit: 0 },
      { kode: '5-1955', debit: 360_000, kredit: 0 }, // tambahan beban
    ]);
    expect(await saldoGl(db, ACC.utangBungaBerjangka)).toBe(0);
    const total = await totalDebitKredit(db);
    expect(total.debit).toBe(total.kredit);
  });
});

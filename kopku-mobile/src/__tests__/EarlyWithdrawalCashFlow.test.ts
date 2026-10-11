jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  siapkanDb, pasangKebijakan,
  KEBIJAKAN_ENAM_KOMPONEN, ACC, USER_ID, POKOK, TANGGAL_TARIK,
} from './earlyWithdrawalHarness';
import { MODAL_AWAL_KAS, MODAL_AWAL_BANK } from './historicalFixture';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import { prosesAkrualBungaKontrak } from '@/services/SimpananBerjangkaLifecycleService';
import {
  cairkanSimpananBerjangkaDini,
  TRANSAKSI_PENCAIRAN_DINI,
} from '@/services/SimpananBerjangkaEarlyWithdrawalService';
import {
  CASH_FLOW_CLASSIFICATION,
  classifyTransactionSource,
} from '@/accounting/CashFlowClassification';
import { getArusKas, getLabaRugi, getPosisiKeuangan } from '@/reports/FinancialReports';

/** EW-18 §AE/§AF — ARUS KAS & LAPORAN KEUANGAN. */

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

describe('EW-18 §AF — klasifikasi arus kas', () => {
  /**
   * DIPERBARUI RC-S104 — pencairan dini tetap mengikuti pencairan
   * normal, tetapi KEDUANYA kini OPERASI, bukan PENDANAAN. Sebabnya
   * bukan di fitur Early Withdrawal ini: simpanan berjangka secara
   * keseluruhan dipindah ke Kegiatan Operasi mengikuti definisi butir
   * 5.7(4)(d) dan contoh resmi Juklat SOM No. 3/2025. Yang penting
   * dijaga test ini TIDAK berubah: pencairan dini sekelompok dengan
   * pencairan normal, tidak berdiri sendiri.
   */
  it('pencairan dini terklasifikasi sama dengan pencairan normal (OPERASI)', () => {
    expect(classifyTransactionSource(TRANSAKSI_PENCAIRAN_DINI)).toBe('OPERASI');
    expect(CASH_FLOW_CLASSIFICATION[TRANSAKSI_PENCAIRAN_DINI]).toBe(
      CASH_FLOW_CLASSIFICATION.SIMPANAN_BERJANGKA_PENCAIRAN
    );
  });

  it('hanya SATU sumber transaksi baru diperkenalkan (§AF)', () => {
    const sumberBerjangka = Object.keys(CASH_FLOW_CLASSIFICATION).filter((s) =>
      s.startsWith('SIMPANAN_BERJANGKA')
    );
    // DIPERBARUI RC-S54 T16 GAP 4: SIMPANAN_BERJANGKA_BUNGA_TRANSFER BUKAN diperkenalkan §AF —
    // sumber produksi lama SimpananBerjangkaLifecycleService (Dr utang bunga / Cr simpanan sukarela)
    // yang sebelumnya belum terklasifikasi (kegagalan baseline pemindai), kini NON_KAS. Sumber baru
    // dari §AF tetap hanya SIMPANAN_BERJANGKA_PENCAIRAN_DINI; perilaku Early Withdrawal tidak berubah.
    expect(sumberBerjangka.sort()).toEqual([
      'SIMPANAN_BERJANGKA',
      'SIMPANAN_BERJANGKA_BUNGA_AKRUAL',
      'SIMPANAN_BERJANGKA_BUNGA_TRANSFER',
      'SIMPANAN_BERJANGKA_PENCAIRAN',
      'SIMPANAN_BERJANGKA_PENCAIRAN_DINI',
    ]);
  });

  it('arus kas tetap terekonsiliasi: awal + perubahan = akhir aktual', async () => {
    const ak = await getArusKas(db as any, '2026-01-01', '2026-12-31');
    expect(ak.terekonsiliasi).toBe(true);
    expect(ak.selisihRekonsiliasi).toBe(0);
    expect(ak.kasAwal + ak.perubahanKas).toBe(ak.kasAkhirDihitung);
    expect(ak.kasAkhirDihitung).toBe(ak.kasAkhirAktual);
  });

  it('kas akhir = modal awal + setoran berjangka - net payout', async () => {
    const ak = await getArusKas(db as any, '2026-01-01', '2026-12-31');
    expect(ak.kasAkhirAktual).toBe(MODAL_AWAL_KAS + MODAL_AWAL_BANK + POKOK - 23_560_000);
  });

  // DIPERBARUI RC-S104 — kolomnya berpindah ke OPERASI (lihat di atas).
  // Nilainya TIDAK berubah sepeser pun, dan itulah yang dikunci di sini.
  it('efek pencairan dini masuk aktivitas OPERASI dengan nilai yang sama', async () => {
    const ak = await getArusKas(db as any, '2026-09-01', '2026-09-30');
    // Satu-satunya pergerakan kas pada September adalah pencairan dini.
    expect(ak.operasi).toBe(-23_560_000);
    expect(ak.pendanaan).toBe(0);
    expect(ak.investasi).toBe(0);
    // Penjaga inti: reklasifikasi hanya memindah kolom.
    expect(ak.operasi + ak.investasi + ak.pendanaan).toBe(ak.perubahanKas);
  });
});

describe('EW-18 §AE — laporan keuangan', () => {
  it('pelunasan pokok BUKAN beban — tidak muncul di Laba Rugi', async () => {
    const lr = await getLabaRugi(db as any, '2026-01-01', '2026-12-31');
    expect(lr.beban.some((b) => b.jumlah >= POKOK)).toBe(false);
    // Beban satu-satunya dari domain ini: bunga yang benar-benar dibayar.
    const bebanBunga = lr.beban.find((b) => b.kode === '5-1955');
    expect(bebanBunga?.jumlah).toBe(90_000);
  });

  it('penalti & biaya admin diakui sebagai pendapatan sesuai kebijakan', async () => {
    const lr = await getLabaRugi(db as any, '2026-01-01', '2026-12-31');
    expect(lr.pendapatan.find((p) => p.kode === '4-1200')?.jumlah).toBe(480_000);
    expect(lr.pendapatan.find((p) => p.kode === '4-1100')?.jumlah).toBe(50_000);
  });

  it('bunga yang dibatalkan TIDAK menjadi pendapatan', async () => {
    const lr = await getLabaRugi(db as any, '2026-01-01', '2026-12-31');
    expect(lr.totalPendapatan).toBe(530_000); // hanya penalti + admin
  });

  it('liabilitas simpanan berjangka & utang bunga tidak tertinggal di Posisi Keuangan', async () => {
    const pk = await getPosisiKeuangan(db as any, '2026-12-31');
    const cari = (kode: string) => pk.liabilitas.find((l) => l.kode === kode)?.saldo ?? 0;
    expect(cari('2-1210')).toBe(0);
    expect(cari('2-1710')).toBe(0);
    expect(pk.isBalanced).toBe(true);
  });

  it('hasil usaha = pendapatan penalti + admin - beban bunga dibayar', async () => {
    const lr = await getLabaRugi(db as any, '2026-01-01', '2026-12-31');
    expect(lr.hasilUsaha).toBe(530_000 - 90_000);
  });
});

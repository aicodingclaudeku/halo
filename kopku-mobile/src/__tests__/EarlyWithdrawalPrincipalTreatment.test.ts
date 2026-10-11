import { calculateEarlyWithdrawalSettlement } from '@/accounting/EarlyWithdrawalCalculation';
import {
  KEBIJAKAN_NETRAL, ACC, POKOK, RATE_KONTRAK, TENOR,
  PLACEMENT, JATUH_TEMPO, TANGGAL_TARIK, BUNGA_EARNED_3_PERIODE,
} from './earlyWithdrawalHarness';
import { KebijakanEarlyWithdrawal, PerlakuanPokok } from '@/accounting/EarlyWithdrawalPolicy';

/** EW-06 §H/§U — PERLAKUAN POKOK KHUSUS. */

const PENALTI = 200_000;
const FEE = 50_000;

const hitung = (perlakuan: PerlakuanPokok) =>
  calculateEarlyWithdrawalSettlement({
    pokok: POKOK,
    tanggalMulai: PLACEMENT,
    tanggalJatuhTempo: JATUH_TEMPO,
    tanggalPencairan: TANGGAL_TARIK,
    tenorBulan: TENOR,
    rateKontrak: RATE_KONTRAK,
    bungaAkrual: BUNGA_EARNED_3_PERIODE,
    kebijakan: {
      ...KEBIJAKAN_NETRAL,
      jenisPenalti: 'NOMINAL_TETAP',
      nilaiPenalti: PENALTI,
      akunPenaltiId: ACC.pendapatanDenda,
      jenisBiayaAdmin: 'NOMINAL_TETAP',
      nilaiBiayaAdmin: FEE,
      akunBiayaAdminId: ACC.pendapatanAdmin,
      perlakuanPokok: perlakuan,
    } as KebijakanEarlyWithdrawal,
  });

describe('EW-06 §U — setiap perlakuan pokok diuji: before, adjustment, paid, remaining', () => {
  const kasus: [PerlakuanPokok, number][] = [
    ['PENUH', 0],
    ['DIKURANGI_PENALTI', PENALTI],
    ['DIKURANGI_BIAYA_ADMIN', FEE],
    ['DIKURANGI_PENALTI_DAN_BIAYA', PENALTI + FEE],
  ];

  for (const [perlakuan, adjustment] of kasus) {
    it(`${perlakuan}: pokok ${POKOK} - ${adjustment} = ${POKOK - adjustment}`, () => {
      const h = hitung(perlakuan);
      expect(h.pokokBruto).toBe(POKOK); // principalBefore
      expect(h.penyesuaianPokok).toBe(adjustment); // principalAdjustment
      expect(h.pokokDibayar).toBe(POKOK - adjustment); // principalPaid
      // principalAfter: kontrak ditutup, jadi sisa kewajiban pokok = 0.
      // Yang tidak dibayar tunai diselesaikan lewat pendapatan penalti/
      // biaya admin — bukan tertinggal sebagai saldo.
      expect(h.pokokBruto - h.penyesuaianPokok - h.pokokDibayar).toBe(0);
      // Komponen yang TIDAK dibebankan ke pokok pindah ke bunga —
      // totalnya selalu utuh, tidak pernah hilang atau ganda.
      expect(h.penyesuaianPokok + h.penyesuaianBunga).toBe(PENALTI + FEE);
    });
  }
});

describe('EW-06 §H — pokok tidak dipotong tanpa kebijakan', () => {
  it('PENUH: pokok dibayar utuh walaupun ada penalti & fee', () => {
    const h = hitung('PENUH');
    expect(h.pokokDibayar).toBe(POKOK);
    expect(h.bungaDibayar).toBe(BUNGA_EARNED_3_PERIODE - PENALTI - FEE);
  });

  it('total payout identik apa pun arah potongannya — arah hanya mengubah komposisi', () => {
    const total = new Set(
      (['PENUH', 'DIKURANGI_PENALTI', 'DIKURANGI_BIAYA_ADMIN', 'DIKURANGI_PENALTI_DAN_BIAYA'] as const)
        .map((p) => hitung(p).totalPayout)
    );
    expect(total.size).toBe(1);
    expect([...total][0]).toBe(POKOK + BUNGA_EARNED_3_PERIODE - PENALTI - FEE);
  });
});

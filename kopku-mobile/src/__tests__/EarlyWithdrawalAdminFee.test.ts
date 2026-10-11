import { calculateEarlyWithdrawalSettlement } from '@/accounting/EarlyWithdrawalCalculation';
import {
  KEBIJAKAN_NETRAL, ACC, POKOK, RATE_KONTRAK, TENOR,
  PLACEMENT, JATUH_TEMPO, TANGGAL_TARIK, BUNGA_EARNED_3_PERIODE,
} from './earlyWithdrawalHarness';
import { KebijakanEarlyWithdrawal } from '@/accounting/EarlyWithdrawalPolicy';

/** EW-04 §F/§S — BIAYA ADMINISTRASI. */

const hitung = (k: Partial<KebijakanEarlyWithdrawal>) =>
  calculateEarlyWithdrawalSettlement({
    pokok: POKOK,
    tanggalMulai: PLACEMENT,
    tanggalJatuhTempo: JATUH_TEMPO,
    tanggalPencairan: TANGGAL_TARIK,
    tenorBulan: TENOR,
    rateKontrak: RATE_KONTRAK,
    bungaAkrual: BUNGA_EARNED_3_PERIODE,
    kebijakan: { ...KEBIJAKAN_NETRAL, ...k } as KebijakanEarlyWithdrawal,
  });

const denganFee = (k: Partial<KebijakanEarlyWithdrawal>) =>
  hitung({ akunBiayaAdminId: ACC.pendapatanAdmin, ...k });

describe('EW-04 §F — bentuk biaya administrasi yang didukung', () => {
  it('fixed fee', () => {
    expect(denganFee({ jenisBiayaAdmin: 'NOMINAL_TETAP', nilaiBiayaAdmin: 50_000 }).biayaAdmin).toBe(
      50_000
    );
  });

  it('percentage fee dari POKOK', () => {
    expect(
      denganFee({
        jenisBiayaAdmin: 'PERSENTASE', nilaiBiayaAdmin: 0.5, basisBiayaAdmin: 'POKOK',
        perlakuanPokok: 'DIKURANGI_BIAYA_ADMIN',
      }).biayaAdmin
    ).toBe(120_000);
  });

  it('percentage fee dari BUNGA BRUTO', () => {
    expect(
      denganFee({
        jenisBiayaAdmin: 'PERSENTASE', nilaiBiayaAdmin: 10, basisBiayaAdmin: 'BUNGA_BRUTO',
      }).biayaAdmin
    ).toBe(36_000);
  });
});

describe('EW-04 §S — fee hanya SEKALI dan tidak masuk bunga', () => {
  it('fee tidak mengubah bunga bruto maupun bunga hangus', () => {
    const tanpa = hitung({});
    const dengan = denganFee({ jenisBiayaAdmin: 'NOMINAL_TETAP', nilaiBiayaAdmin: 50_000 });
    expect(dengan.bungaBruto).toBe(tanpa.bungaBruto);
    expect(dengan.bungaHangus).toBe(tanpa.bungaHangus);
  });

  it('efek kas persis satu kali: payout berkurang tepat sebesar fee', () => {
    const tanpa = hitung({});
    const dengan = denganFee({ jenisBiayaAdmin: 'NOMINAL_TETAP', nilaiBiayaAdmin: 50_000 });
    expect(tanpa.totalPayout - dengan.totalPayout).toBe(50_000);
  });

  it('fee tidak masuk pokok bila kebijakan tidak menyatakannya (§F)', () => {
    const h = denganFee({
      jenisBiayaAdmin: 'NOMINAL_TETAP', nilaiBiayaAdmin: 50_000, perlakuanPokok: 'PENUH',
    });
    expect(h.pokokDibayar).toBe(POKOK);
    expect(h.penyesuaianPokok).toBe(0);
    expect(h.penyesuaianBunga).toBe(50_000);
  });

  it('fee dibebankan ke pokok bila kebijakan memang menyatakannya', () => {
    const h = denganFee({
      jenisBiayaAdmin: 'NOMINAL_TETAP', nilaiBiayaAdmin: 50_000,
      perlakuanPokok: 'DIKURANGI_BIAYA_ADMIN',
    });
    expect(h.penyesuaianPokok).toBe(50_000);
    expect(h.penyesuaianBunga).toBe(0);
    expect(h.bungaDibayar).toBe(BUNGA_EARNED_3_PERIODE);
  });

  it('penalti dan fee berdampingan: masing-masing tepat sekali', () => {
    const h = hitung({
      akunPenaltiId: ACC.pendapatanDenda,
      akunBiayaAdminId: ACC.pendapatanAdmin,
      jenisPenalti: 'NOMINAL_TETAP', nilaiPenalti: 200_000,
      jenisBiayaAdmin: 'NOMINAL_TETAP', nilaiBiayaAdmin: 50_000,
      perlakuanPokok: 'DIKURANGI_PENALTI_DAN_BIAYA',
    });
    expect(h.penalti).toBe(200_000);
    expect(h.biayaAdmin).toBe(50_000);
    expect(h.penyesuaianPokok).toBe(250_000);
    expect(h.penyesuaianBunga).toBe(0);
    expect(h.totalPayout).toBe(POKOK + BUNGA_EARNED_3_PERIODE - 250_000);
  });
});

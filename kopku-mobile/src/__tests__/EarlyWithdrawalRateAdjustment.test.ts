import { calculateEarlyWithdrawalSettlement } from '@/accounting/EarlyWithdrawalCalculation';
import {
  KEBIJAKAN_NETRAL, POKOK, RATE_KONTRAK, TENOR,
  PLACEMENT, JATUH_TEMPO, TANGGAL_TARIK, BUNGA_EARNED_3_PERIODE,
} from './earlyWithdrawalHarness';
import { KebijakanEarlyWithdrawal } from '@/accounting/EarlyWithdrawalPolicy';

/** EW-05 §G/§T — PERUBAHAN RATE. */

const hitung = (k: Partial<KebijakanEarlyWithdrawal>, tanggal = TANGGAL_TARIK) =>
  calculateEarlyWithdrawalSettlement({
    pokok: POKOK,
    tanggalMulai: PLACEMENT,
    tanggalJatuhTempo: JATUH_TEMPO,
    tanggalPencairan: tanggal,
    tenorBulan: TENOR,
    rateKontrak: RATE_KONTRAK,
    bungaAkrual: BUNGA_EARNED_3_PERIODE,
    kebijakan: { ...KEBIJAKAN_NETRAL, ...k } as KebijakanEarlyWithdrawal,
  });

describe('EW-05 §G — empat rate dibedakan tegas', () => {
  it('tanpa kebijakan rate: bunga kontrak dipakai apa adanya, penyesuaian 0', () => {
    const h = hitung({});
    expect(h.rateKontrak).toBe(6);
    expect(h.bungaAkrualKontrak).toBe(360_000);
    expect(h.bungaBruto).toBe(360_000);
    expect(h.penyesuaianRate).toBe(0);
    expect(h.rateEfektif).toBe(6);
  });

  it('rate dini SEJAK PENEMPATAN: seluruh periode berjalan dihitung ulang', () => {
    const h = hitung({
      jenisPenyesuaianRate: 'RATE_DINI', rateDini: 3,
      cakupanPenyesuaianRate: 'SEJAK_PENEMPATAN',
    });
    expect(h.bungaAkrualKontrak).toBe(360_000); // rate kontrak: 3 x 120.000
    expect(h.bungaBruto).toBe(180_000); // rate dini: 3 x 60.000
    expect(h.penyesuaianRate).toBe(-180_000);
    expect(h.rateEfektif).toBe(3);
  });

  it('rate dini PERIODE BERJALAN SAJA: bunga historis TIDAK dihitung ulang', () => {
    const h = hitung({
      jenisPenyesuaianRate: 'RATE_DINI', rateDini: 3,
      cakupanPenyesuaianRate: 'PERIODE_BERJALAN_SAJA',
    });
    // Dua periode pertama tetap 120.000; hanya periode ketiga jadi 60.000.
    expect(h.bungaBruto).toBe(300_000);
    expect(h.penyesuaianRate).toBe(-60_000);
  });

  it('dua cakupan menghasilkan angka BERBEDA — cakupan benar-benar dipakai', () => {
    const sejak = hitung({
      jenisPenyesuaianRate: 'RATE_DINI', rateDini: 3,
      cakupanPenyesuaianRate: 'SEJAK_PENEMPATAN',
    });
    const berjalan = hitung({
      jenisPenyesuaianRate: 'RATE_DINI', rateDini: 3,
      cakupanPenyesuaianRate: 'PERIODE_BERJALAN_SAJA',
    });
    expect(sejak.bungaBruto).not.toBe(berjalan.bungaBruto);
  });

  it('rate dini 0%: seluruh bunga berjalan hilang lewat penyesuaian rate, bukan lewat forfeiture', () => {
    const h = hitung({
      jenisPenyesuaianRate: 'RATE_DINI', rateDini: 0,
      cakupanPenyesuaianRate: 'SEJAK_PENEMPATAN',
    });
    expect(h.bungaBruto).toBe(0);
    expect(h.penyesuaianRate).toBe(-360_000);
    expect(h.bungaHangus).toBe(0); // dibedakan dari forfeiture
    expect(h.totalPayout).toBe(POKOK);
  });

  it('rate dini LEBIH TINGGI dari kontrak: penyesuaian positif, tetap terhitung benar', () => {
    const h = hitung({
      jenisPenyesuaianRate: 'RATE_DINI', rateDini: 12,
      cakupanPenyesuaianRate: 'SEJAK_PENEMPATAN',
    });
    expect(h.bungaBruto).toBe(720_000); // 12%: 3 x 240.000
    expect(h.penyesuaianRate).toBe(360_000);
    expect(h.totalPayout).toBe(POKOK + 720_000);
  });
});

describe('EW-05 §T — rate adjustment hanya terjadi sesuai kebijakan', () => {
  it('kebijakan TIDAK_ADA tidak pernah menyentuh bunga meski rateDini terisi', () => {
    const h = hitung({ jenisPenyesuaianRate: 'TIDAK_ADA', rateDini: 1 });
    expect(h.bungaBruto).toBe(360_000);
    expect(h.penyesuaianRate).toBe(0);
  });

  it('forfeiture dihitung ATAS bunga setelah penyesuaian rate, bukan atas bunga kontrak', () => {
    const h = hitung({
      jenisPenyesuaianRate: 'RATE_DINI', rateDini: 3,
      cakupanPenyesuaianRate: 'SEJAK_PENEMPATAN',
      jenisForfeiture: 'PERSENTASE_BUNGA', nilaiForfeiture: 50,
    });
    expect(h.bungaBruto).toBe(180_000);
    expect(h.bungaHangus).toBe(90_000); // 50% x 180.000, BUKAN 50% x 360.000
    expect(h.bungaDibayar).toBe(90_000);
  });
});

import { calculateEarlyWithdrawalSettlement } from '@/accounting/EarlyWithdrawalCalculation';
import {
  KEBIJAKAN_NETRAL, POKOK, RATE_KONTRAK, TENOR,
  PLACEMENT, JATUH_TEMPO, BUNGA_PER_PERIODE,
} from './earlyWithdrawalHarness';
import { KebijakanEarlyWithdrawal } from '@/accounting/EarlyWithdrawalPolicy';

/** EW-07 §I/§V — PERLAKUAN BUNGA KHUSUS. */

const hitung = (k: Partial<KebijakanEarlyWithdrawal>, tanggal: string, akrual: number) =>
  calculateEarlyWithdrawalSettlement({
    pokok: POKOK,
    tanggalMulai: PLACEMENT,
    tanggalJatuhTempo: JATUH_TEMPO,
    tanggalPencairan: tanggal,
    tenorBulan: TENOR,
    rateKontrak: RATE_KONTRAK,
    bungaAkrual: akrual,
    kebijakan: { ...KEBIJAKAN_NETRAL, ...k } as KebijakanEarlyWithdrawal,
  });

describe('EW-07 §V — keadaan bunga yang dibedakan', () => {
  it('accrued BELUM ada (sebelum periode pertama berakhir): semua komponen bunga nol', () => {
    const h = hitung({}, '2026-07-01', 0);
    expect(h.periodeBerjalan).toBe(0);
    expect(h.bungaAkrualKontrak).toBe(0);
    expect(h.bungaBruto).toBe(0);
    expect(h.bungaHangus).toBe(0);
    expect(h.bungaDibayar).toBe(0);
    expect(h.totalPayout).toBe(POKOK);
  });

  it('accrued payable seluruhnya dibayar', () => {
    const h = hitung({}, '2026-09-15', 3 * BUNGA_PER_PERIODE);
    expect(h.bungaDibayar).toBe(360_000);
    expect(h.bungaHangus).toBe(0);
  });

  it('sebagian forfeited', () => {
    const h = hitung(
      { jenisForfeiture: 'PERSENTASE_BUNGA', nilaiForfeiture: 40 },
      '2026-09-15',
      360_000
    );
    expect(h.bungaHangus).toBe(144_000);
    expect(h.bungaDibayar).toBe(216_000);
  });

  it('seluruhnya forfeited: tidak ada bunga dibayar, tetapi bruto tetap tercatat', () => {
    const h = hitung(
      { jenisForfeiture: 'SELURUH_BUNGA', perlakuanBunga: 'TIDAK_DIBAYAR' },
      '2026-09-15',
      360_000
    );
    expect(h.bungaBruto).toBe(360_000);
    expect(h.bungaHangus).toBe(360_000);
    expect(h.bungaDibayar).toBe(0);
  });

  it('bunga adjusted (rate) DAN forfeited dibedakan sebagai dua angka', () => {
    const h = hitung(
      {
        jenisPenyesuaianRate: 'RATE_DINI', rateDini: 3,
        cakupanPenyesuaianRate: 'SEJAK_PENEMPATAN',
        jenisForfeiture: 'PERSENTASE_BUNGA', nilaiForfeiture: 50,
      },
      '2026-09-15',
      360_000
    );
    expect(h.penyesuaianRate).toBe(-180_000); // akibat rate
    expect(h.bungaHangus).toBe(90_000); // akibat forfeiture
    expect(h.penyesuaianRate).not.toBe(-h.bungaHangus); // bukan angka yang sama
  });
});

describe('EW-07 §I — tidak ada liabilitas bunga tersisa tanpa dasar', () => {
  it('bunga bruto selalu terurai habis menjadi hangus + dibayar + potongan', () => {
    const h = hitung(
      {
        jenisForfeiture: 'PERSENTASE_BUNGA', nilaiForfeiture: 25,
        jenisPenalti: 'NOMINAL_TETAP', nilaiPenalti: 100_000,
        akunPenaltiId: 'acc-pendapatan-denda',
        perlakuanPokok: 'PENUH',
      },
      '2026-09-15',
      360_000
    );
    expect(h.bungaHangus + h.bungaDibayar + h.penyesuaianBunga).toBe(h.bungaBruto);
  });

  it('setiap periode akrual bertambah, seluruh komponen tetap konsisten', () => {
    for (const [tanggal, periode] of [
      ['2026-07-12', 1], ['2026-08-12', 2], ['2026-09-12', 3],
      ['2026-10-12', 4], ['2026-11-12', 5],
    ] as const) {
      const akrual = periode * BUNGA_PER_PERIODE;
      const h = hitung({ jenisForfeiture: 'PERSENTASE_BUNGA', nilaiForfeiture: 50 }, tanggal, akrual);
      expect(h.periodeBerjalan).toBe(periode);
      expect(h.bungaAkrualKontrak).toBe(akrual);
      expect(h.bungaHangus + h.bungaSetelahForfeiture).toBe(akrual);
      expect(h.totalPayout).toBe(POKOK + h.bungaDibayar);
    }
  });
});

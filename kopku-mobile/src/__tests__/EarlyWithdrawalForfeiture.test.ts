import { calculateEarlyWithdrawalSettlement } from '@/accounting/EarlyWithdrawalCalculation';
import {
  KEBIJAKAN_NETRAL, POKOK, RATE_KONTRAK, TENOR,
  PLACEMENT, JATUH_TEMPO, TANGGAL_TARIK, BUNGA_EARNED_3_PERIODE,
} from './earlyWithdrawalHarness';
import { KebijakanEarlyWithdrawal } from '@/accounting/EarlyWithdrawalPolicy';

/** EW-03 §E/§Q — FORFEITURE BUNGA. */

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

describe('EW-03 §Q — tidak boleh ada selisih bunga', () => {
  const kasus: [string, Partial<KebijakanEarlyWithdrawal>, number][] = [
    ['tanpa forfeiture', {}, 0],
    ['persentase 25%', { jenisForfeiture: 'PERSENTASE_BUNGA', nilaiForfeiture: 25 }, 90_000],
    ['persentase 50%', { jenisForfeiture: 'PERSENTASE_BUNGA', nilaiForfeiture: 50 }, 180_000],
    ['persentase 100%', { jenisForfeiture: 'PERSENTASE_BUNGA', nilaiForfeiture: 100 }, 360_000],
    ['nominal tetap', { jenisForfeiture: 'NOMINAL_TETAP', nilaiForfeiture: 123_456 }, 123_456],
    [
      'seluruh bunga',
      { jenisForfeiture: 'SELURUH_BUNGA', perlakuanBunga: 'TIDAK_DIBAYAR' as const },
      360_000,
    ],
  ];

  for (const [nama, kebijakan, hangus] of kasus) {
    it(`${nama}: hangus + dibayar = bruto, persis`, () => {
      const h = hitung(kebijakan);
      expect(h.bungaHangus).toBe(hangus);
      expect(h.bungaSetelahForfeiture).toBe(BUNGA_EARNED_3_PERIODE - hangus);
      expect(h.bungaHangus + h.bungaSetelahForfeiture).toBe(h.bungaBruto);
      expect(h.bungaBruto).toBe(BUNGA_EARNED_3_PERIODE);
      expect(h.bungaHangus).toBeGreaterThanOrEqual(0);
      expect(h.bungaSetelahForfeiture).toBeGreaterThanOrEqual(0);
    });
  }
});

describe('EW-03 §E — bunga tidak boleh diam-diam menjadi pokok', () => {
  it('forfeiture tidak menambah maupun mengurangi pokok', () => {
    for (const persen of [0, 25, 50, 100]) {
      const h = hitung(
        persen === 0
          ? {}
          : { jenisForfeiture: 'PERSENTASE_BUNGA', nilaiForfeiture: persen }
      );
      expect(h.pokokBruto).toBe(POKOK);
      expect(h.pokokDibayar).toBe(POKOK);
    }
  });

  it('seluruh bunga hangus -> anggota hanya menerima pokok', () => {
    const h = hitung({ jenisForfeiture: 'SELURUH_BUNGA', perlakuanBunga: 'TIDAK_DIBAYAR' });
    expect(h.bungaDibayar).toBe(0);
    expect(h.totalPayout).toBe(POKOK);
  });

  it('bunga bruto tetap terlihat utuh walau seluruhnya hangus — bukan dihapus dari catatan', () => {
    const h = hitung({ jenisForfeiture: 'SELURUH_BUNGA', perlakuanBunga: 'TIDAK_DIBAYAR' });
    expect(h.bungaAkrualKontrak).toBe(BUNGA_EARNED_3_PERIODE);
    expect(h.bungaBruto).toBe(BUNGA_EARNED_3_PERIODE);
  });
});

describe('EW-03 — kontrak tanpa bunga', () => {
  it('rate 0: bunga bruto 0, forfeiture 0, tidak ada pembagian nol', () => {
    const h = calculateEarlyWithdrawalSettlement({
      pokok: POKOK,
      tanggalMulai: PLACEMENT,
      tanggalJatuhTempo: JATUH_TEMPO,
      tanggalPencairan: TANGGAL_TARIK,
      tenorBulan: TENOR,
      rateKontrak: 0,
      bungaAkrual: 0,
      kebijakan: { ...KEBIJAKAN_NETRAL, jenisForfeiture: 'PERSENTASE_BUNGA', nilaiForfeiture: 50 },
    });
    expect(h.bungaBruto).toBe(0);
    expect(h.bungaHangus).toBe(0);
    expect(h.totalPayout).toBe(POKOK);
    expect(h.rateEfektif).toBe(0);
  });
});

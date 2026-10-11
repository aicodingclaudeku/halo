import {
  calculateEarlyWithdrawalSettlement,
  breakdownSettlement,
  SettlementDiniTidakDapatDihitungError,
  InputSettlementDini,
} from '@/accounting/EarlyWithdrawalCalculation';
import { KebijakanEarlyWithdrawalError } from '@/accounting/EarlyWithdrawalPolicy';
import {
  KEBIJAKAN_NETRAL,
  KEBIJAKAN_ENAM_KOMPONEN,
  POKOK,
  RATE_KONTRAK,
  TENOR,
  PLACEMENT,
  JATUH_TEMPO,
  TANGGAL_TARIK,
  BUNGA_EARNED_3_PERIODE,
} from './earlyWithdrawalHarness';

/**
 * EW-08 — CALCULATION ENGINE (§J) + EW-02..EW-07 invariannya.
 *
 * Suite ini murni aritmetika: tidak ada database, tidak ada jurnal.
 * Yang diuji adalah bahwa satu fungsi menghasilkan SELURUH komponen,
 * bahwa invariannya tidak pernah bocor, dan bahwa kebijakan yang tidak
 * dapat diterapkan DITOLAK alih-alih dipangkas diam-diam.
 */

const dasar = (
  k = KEBIJAKAN_NETRAL,
  bunga = BUNGA_EARNED_3_PERIODE,
  tanggal = TANGGAL_TARIK
): InputSettlementDini => ({
  pokok: POKOK,
  tanggalMulai: PLACEMENT,
  tanggalJatuhTempo: JATUH_TEMPO,
  tanggalPencairan: tanggal,
  tenorBulan: TENOR,
  rateKontrak: RATE_KONTRAK,
  bungaAkrual: bunga,
  kebijakan: k,
});

function periksaInvarian(h: ReturnType<typeof calculateEarlyWithdrawalSettlement>) {
  expect(h.bungaHangus + h.bungaSetelahForfeiture).toBe(h.bungaBruto);
  expect(h.bungaAkrualKontrak + h.penyesuaianRate).toBe(h.bungaBruto);
  expect(h.penyesuaianPokok + h.penyesuaianBunga).toBe(h.penalti + h.biayaAdmin);
  expect(h.pokokDibayar + h.bungaDibayar).toBe(h.totalPayout);
  expect(h.pokokDibayar).toBeGreaterThanOrEqual(0);
  expect(h.bungaDibayar).toBeGreaterThanOrEqual(0);
  for (const v of [
    h.pokokBruto, h.bungaAkrualKontrak, h.bungaBruto, h.bungaHangus,
    h.penalti, h.biayaAdmin, h.penyesuaianPokok, h.penyesuaianBunga,
    h.pokokDibayar, h.bungaDibayar, h.totalPayout, h.penyesuaianRate,
  ]) {
    expect(Number.isInteger(v)).toBe(true);
  }
}

describe('EW-08 §P — NO-ADJUSTMENT CASE: seluruh komponen tidak berlaku', () => {
  it('hasil = pokok penuh + bunga terakru penuh, tanpa komponen phantom', () => {
    const h = calculateEarlyWithdrawalSettlement(dasar());
    expect(h.pokokBruto).toBe(POKOK);
    expect(h.bungaAkrualKontrak).toBe(BUNGA_EARNED_3_PERIODE);
    expect(h.penyesuaianRate).toBe(0);
    expect(h.bungaBruto).toBe(BUNGA_EARNED_3_PERIODE);
    expect(h.bungaHangus).toBe(0);
    expect(h.penalti).toBe(0);
    expect(h.biayaAdmin).toBe(0);
    expect(h.penyesuaianPokok).toBe(0);
    expect(h.penyesuaianBunga).toBe(0);
    expect(h.pokokDibayar).toBe(POKOK);
    expect(h.bungaDibayar).toBe(BUNGA_EARNED_3_PERIODE);
    expect(h.totalPayout).toBe(POKOK + BUNGA_EARNED_3_PERIODE);
    expect(h.rateEfektif).toBe(RATE_KONTRAK);
    periksaInvarian(h);
  });

  it('rate efektif = rate kontrak ketika tidak ada penyesuaian', () => {
    expect(calculateEarlyWithdrawalSettlement(dasar()).rateEfektif).toBe(6);
  });
});

describe('EW-08 §AQ — contoh konkret enam komponen', () => {
  const h = calculateEarlyWithdrawalSettlement(dasar(KEBIJAKAN_ENAM_KOMPONEN));

  it('angka per komponen dapat ditelusuri satu per satu', () => {
    expect(h.pokokBruto).toBe(24_000_000);
    expect(h.bungaAkrualKontrak).toBe(360_000); // 6%: 3 x 120.000
    expect(h.bungaBruto).toBe(180_000); // 3%: 3 x 60.000
    expect(h.penyesuaianRate).toBe(-180_000);
    expect(h.bungaHangus).toBe(90_000); // 50% x 180.000
    expect(h.bungaSetelahForfeiture).toBe(90_000);
    expect(h.penalti).toBe(480_000); // 2% x 24.000.000
    expect(h.biayaAdmin).toBe(50_000);
    expect(h.penyesuaianPokok).toBe(530_000);
    expect(h.penyesuaianBunga).toBe(0);
    expect(h.pokokDibayar).toBe(23_470_000);
    expect(h.bungaDibayar).toBe(90_000);
    expect(h.totalPayout).toBe(23_560_000);
    expect(h.rateEfektif).toBe(3);
    expect(h.periodeBerjalan).toBe(3);
    expect(h.policyVersi).toBe('EW-UJI-ENAM');
  });

  it('seluruh invarian terpenuhi', () => periksaInvarian(h));

  it('breakdown berisi setiap komponen — bukan satu total tunggal (§I)', () => {
    const label = breakdownSettlement(h).map((b) => b.label);
    expect(label).toEqual(
      expect.arrayContaining([
        'Pokok bruto',
        'Bunga terakru (rate kontrak)',
        'Penyesuaian rate',
        'Bunga bruto',
        'Bunga hangus',
        'Penalti',
        'Biaya administrasi',
        'Pokok dibayar',
        'Bunga dibayar',
        'Total diterima anggota',
      ])
    );
  });
});

describe('EW-08 — penolakan, bukan pemangkasan diam-diam', () => {
  it('kebijakan belum lengkap -> KebijakanEarlyWithdrawalError', () => {
    expect(() =>
      calculateEarlyWithdrawalSettlement(
        dasar({ ...KEBIJAKAN_NETRAL, jenisPenalti: 'PERSENTASE' })
      )
    ).toThrow(KebijakanEarlyWithdrawalError);
  });

  it('kebijakan melarang -> ditolak dengan status DILARANG', () => {
    try {
      calculateEarlyWithdrawalSettlement(dasar({ ...KEBIJAKAN_NETRAL, diizinkan: false }));
      throw new Error('seharusnya melempar');
    } catch (e) {
      expect(e).toBeInstanceOf(KebijakanEarlyWithdrawalError);
      expect((e as KebijakanEarlyWithdrawalError).status).toBe('DILARANG');
    }
  });

  it('bunga terakru tidak sama dengan yang seharusnya earned -> DITOLAK', () => {
    expect(() => calculateEarlyWithdrawalSettlement(dasar(KEBIJAKAN_NETRAL, 240_000))).toThrow(
      SettlementDiniTidakDapatDihitungError
    );
  });

  it('forfeiture nominal melebihi bunga bruto -> DITOLAK, tidak dipangkas', () => {
    expect(() =>
      calculateEarlyWithdrawalSettlement(
        dasar({
          ...KEBIJAKAN_NETRAL,
          jenisForfeiture: 'NOMINAL_TETAP',
          nilaiForfeiture: 999_999_999,
        })
      )
    ).toThrow(/melebihi bunga bruto/);
  });

  it('potongan pokok melebihi pokok -> DITOLAK', () => {
    expect(() =>
      calculateEarlyWithdrawalSettlement(
        dasar({
          ...KEBIJAKAN_NETRAL,
          jenisPenalti: 'NOMINAL_TETAP',
          nilaiPenalti: 30_000_000,
          akunPenaltiId: 'acc-pendapatan-denda',
          perlakuanPokok: 'DIKURANGI_PENALTI',
        })
      )
    ).toThrow(/melebihi pokok kontrak/);
  });

  it('potongan bunga melebihi bunga tersedia -> DITOLAK (tidak jadi nol diam-diam)', () => {
    expect(() =>
      calculateEarlyWithdrawalSettlement(
        dasar({
          ...KEBIJAKAN_NETRAL,
          jenisPenalti: 'NOMINAL_TETAP',
          nilaiPenalti: 1_000_000,
          akunPenaltiId: 'acc-pendapatan-denda',
          perlakuanPokok: 'PENUH',
        })
      )
    ).toThrow(/melebihi bunga yang tersedia/);
  });

  it('pokok bukan bilangan bulat positif -> DITOLAK', () => {
    expect(() =>
      calculateEarlyWithdrawalSettlement({ ...dasar(), pokok: 0 })
    ).toThrow(SettlementDiniTidakDapatDihitungError);
  });

  it('tanggal pencairan mendahului penempatan -> DITOLAK', () => {
    expect(() =>
      calculateEarlyWithdrawalSettlement(dasar(KEBIJAKAN_NETRAL, 0, '2026-06-01'))
    ).toThrow(/mendahului tanggal penempatan/);
  });
});

describe('EW-08 — determinisme: input sama -> hasil identik', () => {
  it('sepuluh pemanggilan menghasilkan objek yang sama persis', () => {
    const acuan = calculateEarlyWithdrawalSettlement(dasar(KEBIJAKAN_ENAM_KOMPONEN));
    for (let i = 0; i < 10; i++) {
      expect(calculateEarlyWithdrawalSettlement(dasar(KEBIJAKAN_ENAM_KOMPONEN))).toEqual(acuan);
    }
  });
});

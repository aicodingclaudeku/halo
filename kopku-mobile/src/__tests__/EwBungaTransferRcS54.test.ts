import {
  calculateEarlyWithdrawalSettlement,
  SettlementDiniTidakDapatDihitungError,
  InputSettlementDini,
} from '@/accounting/EarlyWithdrawalCalculation';
import {
  KEBIJAKAN_NETRAL,
  POKOK,
  RATE_KONTRAK,
  TENOR,
  PLACEMENT,
  JATUH_TEMPO,
  TANGGAL_TARIK,
  BUNGA_EARNED_3_PERIODE,
} from './earlyWithdrawalHarness';

/**
 * POLICY EW-BUNGA-01 — bunga yang sudah dipindahkan ke Simpanan
 * Sukarela adalah hak yang SUDAH direalisasikan.
 *
 * Yang dijaga suite ini: bunga itu tidak pernah dihitung ulang sebagai
 * utang bunga, tidak pernah dihanguskan lagi, dan tidak pernah dibayar
 * tunai kedua kalinya. Aturan penarikan dini hanya berlaku atas sisa
 * yang MASIH terutang.
 *
 * JENIS TEST: REAL BEHAVIOR (fungsi kalkulator produksi, aritmetika
 * penuh — tanpa database, karena di sinilah keputusannya diambil).
 */

const dasar = (
  kebijakan = KEBIJAKAN_NETRAL,
  bungaSudahDitransfer = 0
): InputSettlementDini => ({
  pokok: POKOK,
  tanggalMulai: PLACEMENT,
  tanggalJatuhTempo: JATUH_TEMPO,
  tanggalPencairan: TANGGAL_TARIK,
  tenorBulan: TENOR,
  rateKontrak: RATE_KONTRAK,
  bungaAkrual: BUNGA_EARNED_3_PERIODE,
  bungaSudahDitransfer,
  kebijakan,
});

// RC-S54 TAHAP 6 — fixture diperbaiki. Versi Tahap 4 memakai
// `perlakuanBunga: 'DIBAYAR'`, nilai yang TIDAK ADA di `PerlakuanBunga`
// (TS2345 di ts-jest) dan secara runtime melompati validasi kebijakan.
// Kombinasi SAH untuk "seluruh bunga hangus" menurut
// `evaluasiKebijakanEarlyWithdrawal()` adalah TIDAK_DIBAYAR + SELURUH_BUNGA.
// Nilai ekspektasi test tidak diubah.
const HANGUS_SELURUH = {
  ...KEBIJAKAN_NETRAL,
  perlakuanBunga: 'TIDAK_DIBAYAR' as const,
  jenisForfeiture: 'SELURUH_BUNGA' as const,
};

describe('POLICY EW-BUNGA-01 — pemisahan komponen bunga', () => {
  it('tanpa transfer: seluruh bunga earned masih terutang (perilaku lama utuh)', () => {
    const h = calculateEarlyWithdrawalSettlement(dasar());
    expect(h.totalBungaEarned).toBe(BUNGA_EARNED_3_PERIODE);
    expect(h.bungaSudahDitransfer).toBe(0);
    expect(h.bungaMasihTerutang).toBe(BUNGA_EARNED_3_PERIODE);
    expect(h.bungaAkrualKontrak).toBe(BUNGA_EARNED_3_PERIODE);
  });

  it('sebagian ditransfer: outstanding = earned - ditransfer', () => {
    const transfer = Math.floor(BUNGA_EARNED_3_PERIODE / 3);
    const h = calculateEarlyWithdrawalSettlement(dasar(KEBIJAKAN_NETRAL, transfer));
    expect(h.totalBungaEarned).toBe(BUNGA_EARNED_3_PERIODE);
    expect(h.bungaSudahDitransfer).toBe(transfer);
    expect(h.bungaMasihTerutang).toBe(BUNGA_EARNED_3_PERIODE - transfer);
    // Batas atas debit 2-1710 adalah outstanding, bukan earned.
    expect(h.bungaAkrualKontrak).toBe(h.bungaMasihTerutang);
    expect(h.bungaAkrualKontrak).toBeLessThan(h.totalBungaEarned);
  });

  it('SKENARIO 1 — hangus seluruhnya hanya menghanguskan yang OUTSTANDING', () => {
    const transfer = Math.floor(BUNGA_EARNED_3_PERIODE / 3);
    const outstanding = BUNGA_EARNED_3_PERIODE - transfer;
    const h = calculateEarlyWithdrawalSettlement(dasar(HANGUS_SELURUH, transfer));
    expect(h.bungaHangus).toBe(outstanding);
    // BUKAN seluruh earned — bunga di Sukarela tidak dihanguskan ulang.
    expect(h.bungaHangus).toBeLessThan(BUNGA_EARNED_3_PERIODE);
    expect(h.bungaDibayar).toBe(0);
  });

  it('SKENARIO 2 — seluruh bunga sudah ditransfer: outstanding 0, debit 2-1710 = 0', () => {
    const h = calculateEarlyWithdrawalSettlement(
      dasar(HANGUS_SELURUH, BUNGA_EARNED_3_PERIODE)
    );
    expect(h.bungaMasihTerutang).toBe(0);
    expect(h.bungaAkrualKontrak).toBe(0);
    expect(h.bungaBruto).toBe(0);
    expect(h.bungaHangus).toBe(0);
    expect(h.bungaDibayar).toBe(0);
  });

  it('SKENARIO 3 — sebagian outstanding dibayar; hanya sebesar itu yang menyelesaikan 2-1710', () => {
    const transfer = Math.floor(BUNGA_EARNED_3_PERIODE / 3);
    const outstanding = BUNGA_EARNED_3_PERIODE - transfer;
    const separuh = {
      ...KEBIJAKAN_NETRAL,
      perlakuanBunga: 'BAYAR_SETELAH_FORFEITURE' as const,
      jenisForfeiture: 'PERSENTASE_BUNGA' as const,
      nilaiForfeiture: 40,
    };
    const h = calculateEarlyWithdrawalSettlement(dasar(separuh, transfer));
    expect(h.bungaAkrualKontrak).toBe(outstanding);
    expect(h.bungaHangus + h.bungaSetelahForfeiture).toBe(outstanding);
    expect(h.bungaHangus).toBeLessThanOrEqual(outstanding);
  });

  it('INVARIAN — debit 2-1710 tidak pernah melebihi outstanding, dan tidak pernah negatif', () => {
    for (const bagian of [0, 1, 2, 3]) {
      const transfer = Math.floor((BUNGA_EARNED_3_PERIODE * bagian) / 3);
      const h = calculateEarlyWithdrawalSettlement(dasar(HANGUS_SELURUH, transfer));
      expect(h.bungaAkrualKontrak).toBeGreaterThanOrEqual(0);
      expect(h.bungaAkrualKontrak).toBeLessThanOrEqual(h.bungaMasihTerutang);
      expect(h.bungaHangus).toBeLessThanOrEqual(h.bungaMasihTerutang);
      // Komponen tetap konsisten satu sama lain.
      expect(h.totalBungaEarned - h.bungaSudahDitransfer).toBe(h.bungaMasihTerutang);
      expect(h.bungaAkrualKontrak + h.penyesuaianRate).toBe(h.bungaBruto);
      expect(h.bungaHangus + h.bungaSetelahForfeiture).toBe(h.bungaBruto);
    }
  });

  it('transfer melebihi earned DITOLAK — tidak dipangkas diam-diam', () => {
    expect(() =>
      calculateEarlyWithdrawalSettlement(dasar(KEBIJAKAN_NETRAL, BUNGA_EARNED_3_PERIODE + 1))
    ).toThrow(SettlementDiniTidakDapatDihitungError);
  });

  it('transfer negatif DITOLAK', () => {
    expect(() => calculateEarlyWithdrawalSettlement(dasar(KEBIJAKAN_NETRAL, -1))).toThrow(
      SettlementDiniTidakDapatDihitungError
    );
  });

  it('pemanggil lama tanpa field baru berperilaku persis seperti sebelumnya', () => {
    const tanpaField = { ...dasar() };
    delete (tanpaField as { bungaSudahDitransfer?: number }).bungaSudahDitransfer;
    const h = calculateEarlyWithdrawalSettlement(tanpaField);
    expect(h.bungaSudahDitransfer).toBe(0);
    expect(h.bungaAkrualKontrak).toBe(BUNGA_EARNED_3_PERIODE);
  });

  it('POKOK tidak terpengaruh sama sekali oleh bunga yang sudah ditransfer', () => {
    const tanpa = calculateEarlyWithdrawalSettlement(dasar(HANGUS_SELURUH, 0));
    const dengan = calculateEarlyWithdrawalSettlement(
      dasar(HANGUS_SELURUH, BUNGA_EARNED_3_PERIODE)
    );
    expect(dengan.pokokBruto).toBe(tanpa.pokokBruto);
    expect(dengan.pokokDibayar).toBe(tanpa.pokokDibayar);
  });
});

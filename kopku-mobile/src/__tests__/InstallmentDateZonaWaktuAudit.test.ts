import { calculateInstallmentDate, calculateInstallmentDates } from '@/accounting/InstallmentDate';

/**
 * AUDIT F-5 — tanggal kalender murni tidak boleh bergantung pada zona
 * waktu perangkat. Jalankan juga dengan TZ=America/Los_Angeles.
 */
describe('calculateInstallmentDate — bebas zona waktu', () => {
  test('bulanan dari 2025-01-31 (clamp akhir bulan)', () => {
    expect(calculateInstallmentDates('2025-01-31', 4, 'BULAN')).toEqual(['2025-02-28', '2025-03-31', '2025-04-30', '2025-05-31']);
  });
  test('akad 2025-03-05 + 1 bulan = 2025-04-05', () => {
    expect(calculateInstallmentDate('2025-03-05', 1, 'BULAN')).toBe('2025-04-05');
  });
  test('mingguan dan harian', () => {
    expect(calculateInstallmentDate('2025-03-05', 2, 'MINGGU')).toBe('2025-03-19');
    expect(calculateInstallmentDate('2025-12-30', 3, 'HARI')).toBe('2026-01-02');
  });
  test('bulan/hari di luar rentang ditolak seperti sebelumnya', () => {
    expect(() => calculateInstallmentDate('2025-13-01', 1, 'BULAN')).toThrow();
    expect(() => calculateInstallmentDate('2025-01-32', 1, 'BULAN')).toThrow();
  });
});

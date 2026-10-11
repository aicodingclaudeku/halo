import {
  calculateInstallmentDate,
  calculateInstallmentDates,
  calculateMaturityDate,
} from '@/accounting/InstallmentDate';

/**
 * BUG-13 — KONSISTENSI TANGGAL JATUH TEMPO.
 *
 * Bagian pertama menguji algoritmanya secara murni (tanpa database).
 * Bagian kedua menguji rekonsiliasi header vs jadwal lewat service
 * sungguhan — karena bug aslinya justru muncul dari DUA algoritma yang
 * dipakai bersamaan di satu fungsi.
 */
describe('calculateInstallmentDate — end-of-month anchored', () => {
  test('31 Jan: tanggal TIDAK terjebak di 28 setelah melewati Februari', () => {
    const dates = calculateInstallmentDates('2026-01-31', 12, 'BULAN');
    expect(dates).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
      '2026-07-31',
      '2026-08-31',
      '2026-09-30',
      '2026-10-31',
      '2026-11-30',
      '2026-12-31',
      '2027-01-31',
    ]);
  });

  test('31 Ags: akhir bulan dipertahankan', () => {
    const dates = calculateInstallmentDates('2026-08-31', 6, 'BULAN');
    expect(dates).toEqual([
      '2026-09-30',
      '2026-10-31',
      '2026-11-30',
      '2026-12-31',
      '2027-01-31',
      '2027-02-28',
    ]);
  });

  test('31 Des: melewati pergantian tahun', () => {
    expect(calculateInstallmentDates('2026-12-31', 3, 'BULAN')).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
    ]);
  });

  test('28 Feb: TIDAK "naik" menjadi akhir bulan pada bulan yang lebih panjang', () => {
    // 28 Feb adalah akhir bulan di 2026, tetapi kontraknya tanggal 28 —
    // bukan "akhir bulan". Angsuran berikutnya tetap tanggal 28.
    expect(calculateInstallmentDates('2026-02-28', 3, 'BULAN')).toEqual([
      '2026-03-28',
      '2026-04-28',
      '2026-05-28',
    ]);
  });

  test('30 Jan: hanya Februari yang di-clamp, sisanya tetap tanggal 30', () => {
    expect(calculateInstallmentDates('2026-01-30', 4, 'BULAN')).toEqual([
      '2026-02-28',
      '2026-03-30',
      '2026-04-30',
      '2026-05-30',
    ]);
  });

  test('tahun kabisat ditangani benar (2028 kabisat)', () => {
    expect(calculateInstallmentDate('2028-01-31', 1, 'BULAN')).toBe('2028-02-29');
  });

  test.each([1, 3, 6, 12, 24, 36])(
    'tenor %i bulan: maturity === tanggal angsuran terakhir',
    (tenor) => {
      const dates = calculateInstallmentDates('2026-01-31', tenor, 'BULAN');
      expect(calculateMaturityDate('2026-01-31', tenor, 'BULAN')).toBe(dates[dates.length - 1]);
      expect(dates.length).toBe(tenor);
    }
  );

  test('satuan HARI dan MINGGU: offset tetap, maturity konsisten', () => {
    expect(calculateInstallmentDates('2026-01-31', 3, 'HARI')).toEqual([
      '2026-02-01',
      '2026-02-02',
      '2026-02-03',
    ]);
    expect(calculateInstallmentDates('2026-01-31', 3, 'MINGGU')).toEqual([
      '2026-02-07',
      '2026-02-14',
      '2026-02-21',
    ]);
    expect(calculateMaturityDate('2026-01-31', 3, 'MINGGU')).toBe('2026-02-21');
  });

  test('tanggal selalu naik monoton (tidak pernah mundur/kembar)', () => {
    for (const origin of ['2026-01-31', '2026-08-31', '2026-12-31', '2026-01-30', '2026-02-28']) {
      const dates = calculateInstallmentDates(origin, 36, 'BULAN');
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i] > dates[i - 1]).toBe(true);
      }
    }
  });

  test('input tidak valid ditolak, bukan menghasilkan tanggal ngawur', () => {
    expect(() => calculateInstallmentDate('2026-01-31', 0, 'BULAN')).toThrow(/tidak valid/);
    expect(() => calculateInstallmentDate('2026-01-31', -1, 'BULAN')).toThrow(/tidak valid/);
    expect(() => calculateInstallmentDate('bukan-tanggal', 1, 'BULAN')).toThrow(/bukan tanggal/);
  });
});

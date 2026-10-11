import { roundToRupiah, percentageOf, sum, isBalanced, formatRupiah } from '@/utils/money';

describe('money utils (PRD §40 - integer Rupiah, no floating point)', () => {
  test('roundToRupiah membulatkan ke integer terdekat (half up)', () => {
    expect(roundToRupiah(1000.4)).toBe(1000);
    expect(roundToRupiah(1000.5)).toBe(1001);
    expect(roundToRupiah(1000.49999)).toBe(1000);
  });

  test('percentageOf menghitung persentase dan membulatkan ke integer', () => {
    expect(percentageOf(1000000, 2)).toBe(20000);
    expect(percentageOf(333333, 1.5)).toBe(5000); // 4999.995 -> 5000
  });

  test('sum menjumlahkan array integer Rupiah', () => {
    expect(sum([1000, 2000, 3000])).toBe(6000);
    expect(sum([])).toBe(0);
  });

  test('isBalanced — aturan wajib PRD §19: TOTAL DEBIT = TOTAL KREDIT', () => {
    expect(isBalanced(500000, 500000)).toBe(true);
    expect(isBalanced(500000, 499999)).toBe(false);
    expect(isBalanced(0, 0)).toBe(true);
  });

  test('formatRupiah menghasilkan format Rp dengan pemisah ribuan Indonesia', () => {
    expect(formatRupiah(1000000)).toBe('Rp1.000.000');
  });
});

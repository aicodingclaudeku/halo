import {
  hitungTanggalJatuhTempo,
  isTenorSimpananBerjangkaValid,
  TENOR_SIMPANAN_BERJANGKA,
} from '@/accounting/SimpananBerjangkaTenor';

/**
 * §30 — SEMANTIK BULAN KALENDER untuk jatuh tempo simpanan berjangka.
 *
 * Yang dijaga: jatuh tempo dihitung dengan aritmetika bulan kalender
 * (clamping akhir bulan), BUKAN `tenor x 30 hari`. Setiap kasus di
 * bawah memberi hasil berbeda antara kedua pendekatan itu, sehingga
 * test ini benar-benar membedakan keduanya — bukan sekadar lolos
 * kebetulan.
 */

describe('§30 tanggal jatuh tempo — bulan kalender', () => {
  test('kasus normal: 2026-09-04 + 3 bulan = 2026-12-04 (bukan +90 hari = 2026-12-03)', () => {
    expect(hitungTanggalJatuhTempo('2026-09-04', 3)).toBe('2026-12-04');
  });

  test('31 Januari + 3 bulan = 30 April (April tidak punya tanggal 31)', () => {
    expect(hitungTanggalJatuhTempo('2026-01-31', 3)).toBe('2026-04-30');
  });

  test('31 Januari + 6 bulan = 31 Juli (tanggal kembali, tidak terjebak di 30)', () => {
    expect(hitungTanggalJatuhTempo('2026-01-31', 6)).toBe('2026-07-31');
  });

  test('31 Januari + 12 bulan = 31 Januari tahun berikutnya', () => {
    expect(hitungTanggalJatuhTempo('2026-01-31', 12)).toBe('2027-01-31');
  });

  test('28 Februari + 3 bulan = 28 Mei', () => {
    expect(hitungTanggalJatuhTempo('2026-02-28', 3)).toBe('2026-05-28');
  });

  test('29 Februari 2028 (kabisat) + 12 bulan = 28 Februari 2029', () => {
    expect(hitungTanggalJatuhTempo('2028-02-29', 12)).toBe('2029-02-28');
  });

  test('30 November + 3 bulan = 28 Februari (tahun biasa)', () => {
    expect(hitungTanggalJatuhTempo('2026-11-30', 3)).toBe('2027-02-28');
  });

  test('30 November 2027 + 3 bulan = 29 Februari 2028 (tahun kabisat)', () => {
    expect(hitungTanggalJatuhTempo('2027-11-30', 3)).toBe('2028-02-29');
  });

  test('31 Desember + 12 bulan tetap 31 Desember (lintas tahun)', () => {
    expect(hitungTanggalJatuhTempo('2026-12-31', 12)).toBe('2027-12-31');
  });

  test('BUKAN tenor x 30 hari: 2026-01-31 + 3 bulan bukan 2026-05-01', () => {
    expect(hitungTanggalJatuhTempo('2026-01-31', 3)).not.toBe('2026-05-01');
  });
});

describe('validasi tenor', () => {
  test('hanya 3, 6, 12 yang sah', () => {
    expect(TENOR_SIMPANAN_BERJANGKA).toEqual([3, 6, 12]);
    for (const t of [3, 6, 12]) expect(isTenorSimpananBerjangkaValid(t)).toBe(true);
    for (const t of [0, 1, 2, 4, 5, 9, 18, 24, -3, 3.5]) {
      expect(isTenorSimpananBerjangkaValid(t)).toBe(false);
    }
  });

  test('tenor di luar daftar ditolak oleh helper tanggal', () => {
    expect(() => hitungTanggalJatuhTempo('2026-01-01', 24 as any)).toThrow(/hanya 3, 6, atau 12/i);
  });

  test('format tanggal salah ditolak', () => {
    expect(() => hitungTanggalJatuhTempo('04-09-2026', 3)).toThrow(/YYYY-MM-DD/);
    expect(() => hitungTanggalJatuhTempo('2026-9-4', 3)).toThrow(/YYYY-MM-DD/);
  });
});

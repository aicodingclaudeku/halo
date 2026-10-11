import { resolveReportPeriodFromDate, formatTanggalIndonesia, lastDayOfMonth, geserPeriodeSetahunKeBelakang } from '@/utils/reportPeriod';

const PERIODE_2026 = { tahunBuku: 2026, periodeMulai: '2026-01-01', periodeSelesai: '2026-12-31' };
const PERIODE_2025 = { tahunBuku: 2025, periodeMulai: '2025-01-01', periodeSelesai: '2025-12-31' };

describe('resolveReportPeriodFromDate (update pasca-Phase 18/19 §J/§S — ReportPeriodPicker satu tanggal)', () => {
  test('mulai = awal tahun buku yang memuat tanggal terpilih, selesai = tanggal itu sendiri', () => {
    const r = resolveReportPeriodFromDate('2026-08-17', [PERIODE_2026]);
    expect(r).toEqual({ mulai: '2026-01-01', selesai: '2026-08-17', label: '17 Agustus 2026' });
  });

  test('memilih accounting_period yang BENAR ketika ada lebih dari satu tahun buku', () => {
    const r = resolveReportPeriodFromDate('2025-06-15', [PERIODE_2026, PERIODE_2025]);
    expect(r.mulai).toBe('2025-01-01');
    expect(r.label).toBe('15 Juni 2025');
  });

  test('tanggal 1 Januari: mulai = selesai = tanggal itu sendiri (bukan Desember tahun sebelumnya)', () => {
    const r = resolveReportPeriodFromDate('2026-01-01', [PERIODE_2026]);
    expect(r.mulai).toBe('2026-01-01');
    expect(r.selesai).toBe('2026-01-01');
  });

  test('tanggal 31 Desember: mulai tetap 1 Januari tahun yang sama (laporan setahun penuh)', () => {
    const r = resolveReportPeriodFromDate('2026-12-31', [PERIODE_2026]);
    expect(r.mulai).toBe('2026-01-01');
    expect(r.selesai).toBe('2026-12-31');
  });

  test('fallback ke 1 Januari tahun kalender kalau TIDAK ADA accounting_period yang cocok (instalasi baru)', () => {
    const r = resolveReportPeriodFromDate('2026-08-17', []);
    expect(r.mulai).toBe('2026-01-01');
    expect(r.selesai).toBe('2026-08-17');
  });

  test('label selalu format tanggal Indonesia dari tanggal (selesai), bukan label tahun buku generik', () => {
    expect(resolveReportPeriodFromDate('2026-03-05', [PERIODE_2026]).label).toBe('5 Maret 2026');
  });
});

describe('formatTanggalIndonesia', () => {
  test('memformat tanggal ISO ke "D NamaBulan YYYY"', () => {
    expect(formatTanggalIndonesia('2026-08-17')).toBe('17 Agustus 2026');
    expect(formatTanggalIndonesia('2026-01-01')).toBe('1 Januari 2026');
  });
});

describe('lastDayOfMonth (dipakai perhitungan periode lain, mis. status penyusutan bulanan — tidak dihapus)', () => {
  test('menghitung hari terakhir bulan dengan benar termasuk kabisat', () => {
    expect(lastDayOfMonth(2026, 2)).toBe(28);
    expect(lastDayOfMonth(2028, 2)).toBe(29);
    expect(lastDayOfMonth(2026, 12)).toBe(31);
  });
});

describe('geserPeriodeSetahunKeBelakang (Phase 17 §5 — default periode pembanding komparatif)', () => {
  test('YTD (bukan full year) digeser persis setahun, BUKAN dijadikan full year tahun lalu', () => {
    const hasil = geserPeriodeSetahunKeBelakang({ mulai: '2026-01-01', selesai: '2026-06-30' });
    expect(hasil).toEqual({ mulai: '2025-01-01', selesai: '2025-06-30' });
  });

  test('full year digeser jadi full year tahun sebelumnya', () => {
    const hasil = geserPeriodeSetahunKeBelakang({ mulai: '2026-01-01', selesai: '2026-12-31' });
    expect(hasil).toEqual({ mulai: '2025-01-01', selesai: '2025-12-31' });
  });

  test('29 Februari (kabisat) digeser ke 28 Februari kalau tahun pembanding bukan kabisat', () => {
    const hasil = geserPeriodeSetahunKeBelakang({ mulai: '2028-01-01', selesai: '2028-02-29' });
    expect(hasil.selesai).toBe('2027-02-28');
  });
});

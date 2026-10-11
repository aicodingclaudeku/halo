import { solveEffectiveInterestRate, faktorPeriodeDariRateTahunan, EirCashFlow } from '@/accounting/EffectiveInterestRateService';

/**
 * PHASE 7 §AA (permintaan pengguna) — test SOLVER murni (tanpa DB),
 * memverifikasi matematika EIR sungguhan: konvergensi, NPV≈0, no fake
 * fallback saat gagal konvergen, date-aware (interval tidak seragam).
 */
describe('EffectiveInterestRateService — solver murni', () => {
  test('AA10: contoh wajib §L — pokok 1.200.000, fee 12.000, initial carrying amount 1.188.000, FLAT 1%/bulan 12x112.000 -> EIR jauh di atas rate kontraktual, NPV pada EIR ≈ 0', () => {
    const cashflows: EirCashFlow[] = [{ hari: 0, jumlah: -1_188_000 }];
    for (let i = 1; i <= 12; i++) cashflows.push({ hari: 30 * i, jumlah: 112_000 });

    const hasil = solveEffectiveInterestRate(cashflows);
    expect(Math.abs(hasil.npvPadaRate)).toBeLessThan(1); // NPV ≈ 0 (toleransi < Rp1)
    // EIR harus signifikan lebih tinggi dari rate kontraktual nominal
    // (properti FLAT: pokok menurun tapi jasa tetap konstan, sehingga
    // rate efektif jauh di atas 1%/bulan — verifikasi independen tanpa
    // fee saja sudah ≈24%/tahun, dengan fee integral tambahan pasti
    // lebih tinggi lagi karena kas yang diserahkan lebih kecil untuk
    // arus masuk kontraktual yang SAMA).
    expect(hasil.rateTahunan).toBeGreaterThan(0.20);
    expect(hasil.rateTahunan).not.toBeCloseTo(0.12, 2); // BUKAN sekadar 12x1%
  });

  test('AA1: zero integral fee -> initial carrying amount = pokok penuh -> EIR TETAP jauh lebih tinggi dari rate FLAT nominal (properti EKONOMI FLAT: pokok direpotkan turun tapi jasa flat konstan, sehingga rate efektif atas saldo yang menurun jauh lebih tinggi dari 1%/bulan nominal — BUKAN sekadar (1+1%)^12)', () => {
    const cashflows: EirCashFlow[] = [{ hari: 0, jumlah: -1_200_000 }];
    for (let i = 1; i <= 12; i++) cashflows.push({ hari: 30 * i, jumlah: 112_000 });

    const hasil = solveEffectiveInterestRate(cashflows);
    expect(Math.abs(hasil.npvPadaRate)).toBeLessThan(1);
    // KOREKSI (ditemukan lewat verifikasi independen di Python sebelum
    // finalisasi): dugaan awal "EIR ≈ (1.01^12 - 1) ≈ 12,68%" SALAH —
    // itu rumus untuk instrumen interest-only/bullet, BUKAN pinjaman
    // FLAT yang mengamortisasi pokok tiap bulan sementara jasa tetap
    // konstan atas pokok AWAL. Karena porsi jasa TIDAK ikut menurun
    // seiring pokok yang direpotkan, EIR sesungguhnya jauh lebih
    // tinggi dari rate nominal — verifikasi independen (replikasi
    // algoritma yang sama di Python) menghasilkan ≈24,06%/tahun.
    expect(hasil.rateTahunan).toBeGreaterThan(0.20);
    expect(hasil.rateTahunan).toBeLessThan(0.30);
    expect(hasil.rateTahunan).toBeCloseTo(0.2406, 3); // hasil verifikasi independen
  });

  test('AA8/AA10: EIR convergence — solver konvergen dalam batas iterasi wajar (Newton-Raphson, tanpa perlu fallback bisection untuk kasus normal)', () => {
    const cashflows: EirCashFlow[] = [{ hari: 0, jumlah: -1_188_000 }];
    for (let i = 1; i <= 12; i++) cashflows.push({ hari: 30 * i, jumlah: 112_000 });
    const hasil = solveEffectiveInterestRate(cashflows);
    expect(hasil.metode).toBe('NEWTON_RAPHSON');
    expect(hasil.iterasi).toBeLessThan(20);
  });

  test('AA9: EIR non-convergence — cashflow yang TIDAK mungkin punya NPV=0 pada domain manapun (semua arus kas positif) HARUS throw, TIDAK mengembalikan rate palsu', () => {
    const cashflows: EirCashFlow[] = [
      { hari: 0, jumlah: 100_000 }, // seharusnya negatif (initial outflow) — sengaja salah untuk uji penolakan
      { hari: 30, jumlah: 50_000 },
    ];
    expect(() => solveEffectiveInterestRate(cashflows)).toThrow(/arus keluar|arus masuk/);
  });

  test('AA9: cashflow kosong/tidak cukup -> throw eksplisit, bukan fallback', () => {
    expect(() => solveEffectiveInterestRate([{ hari: 0, jumlah: -100 }])).toThrow(/minimal 2 arus kas/);
  });

  test('§H: date-aware — interval TIDAK seragam (bukan asumsi 30 hari rata) tetap menghasilkan NPV ≈ 0 pada EIR yang ditemukan', () => {
    // Interval sengaja tidak seragam: 28, 31, 30, 31 hari (bulan kalender sungguhan).
    const cashflows: EirCashFlow[] = [
      { hari: 0, jumlah: -1_000_000 },
      { hari: 28, jumlah: 260_000 },
      { hari: 59, jumlah: 260_000 },
      { hari: 89, jumlah: 260_000 },
      { hari: 120, jumlah: 260_000 },
    ];
    const hasil = solveEffectiveInterestRate(cashflows);
    expect(Math.abs(hasil.npvPadaRate)).toBeLessThan(1);
  });

  test('§J: EIR boleh mendekati 0 kalau memang mathematically valid (total cash in ≈ total cash out, tidak ada margin)', () => {
    const cashflows: EirCashFlow[] = [
      { hari: 0, jumlah: -1_200_000 },
      { hari: 365, jumlah: 1_200_000 }, // no interest, no fee -> EIR ~ 0
    ];
    const hasil = solveEffectiveInterestRate(cashflows);
    expect(hasil.rateTahunan).toBeCloseTo(0, 2);
  });

  test('§J: EIR boleh negatif kalau secara matematis memang terjadi (total cash in < total cash out — instrumen merugi)', () => {
    const cashflows: EirCashFlow[] = [
      { hari: 0, jumlah: -1_200_000 },
      { hari: 365, jumlah: 1_000_000 }, // rugi 200rb -> EIR negatif
    ];
    const hasil = solveEffectiveInterestRate(cashflows);
    expect(hasil.rateTahunan).toBeLessThan(0);
    expect(Number.isFinite(hasil.rateTahunan)).toBe(true);
  });

  test('faktorPeriodeDariRateTahunan: faktor pertumbuhan Actual/365 konsisten dengan basis solver (bukan rate/12 flat)', () => {
    const rate = 0.12;
    const faktor30hari = faktorPeriodeDariRateTahunan(rate, 30);
    const faktorSetahun = faktorPeriodeDariRateTahunan(rate, 365);
    expect(faktorSetahun).toBeCloseTo(1.12, 5); // setahun penuh = rate itu sendiri
    expect(faktor30hari).toBeLessThan(faktorSetahun); // proporsional terhadap hari
    expect(faktor30hari).toBeGreaterThan(1);
  });
});

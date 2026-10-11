import {
  solveEffectiveInterestRate,
  EirSolverError,
  EirCashFlow,
} from '@/accounting/EffectiveInterestRateService';

/**
 * BUG FIX — EIR SOLVER PADA PINJAMAN TENOR PENDEK.
 *
 * GEJALA: pencairan pinjaman Rp1.000.000 tenor 10 HARI ditolak dengan
 * "tidak ditemukan rate pada domain [-0.99, 10]".
 *
 * ROOT CAUSE: bracket bisection statis [rateMin, rateMax=10]. Akar yang
 * SAH untuk kasus itu adalah
 *   r = (1.084.340 / 1.000.000)^(365/10) − 1 = 18,2106  (1821%/tahun)
 * yaitu DI LUAR bracket. Karena itu NPV(-0,99) dan NPV(10) sama-sama
 * POSITIF dan solver menyimpulkan "tidak ada akar" — padahal akarnya
 * ada, hanya di luar jendela pencarian. Newton pun ikut terkunci karena
 * langkahnya dianggap "keluar domain" begitu melewati 10.
 *
 * PRINSIP YANG DIUJI: rate tinggi BUKAN rate invalid. Annualized EIR
 * yang sangat besar adalah konsekuensi matematis wajar dari tenor
 * sangat pendek (Actual/365), dan harus dapat direpresentasikan selama
 * akarnya finite dan NPV-nya nol.
 *
 * Yang TIDAK boleh terjadi dan ikut diuji di sini: tidak ada fallback
 * ke rate kontraktual/FLAT/0%/nilai sebelumnya. Kalau memang tidak ada
 * akar, solver WAJIB melempar error.
 */

/** Akar eksak untuk pembayaran tunggal — pembanding independen dari solver. */
function akarAnalitik(pokok: number, pelunasan: number, hari: number): number {
  return Math.pow(pelunasan / pokok, 365 / hari) - 1;
}

function npvManual(rate: number, cashflows: EirCashFlow[]): number {
  return cashflows.reduce((a, cf) => a + cf.jumlah / Math.pow(1 + rate, cf.hari / 365), 0);
}

const POKOK = 1_000_000;
const PELUNASAN = 1_084_340;
const TOLERANSI_DEFAULT = 0.5;

describe('EIR tenor pendek — CASE A s.d. G', () => {
  const kasus: { nama: string; hari: number }[] = [
    { nama: 'CASE A — 10 hari (kasus bug yang dilaporkan)', hari: 10 },
    { nama: 'CASE B — 1 hari', hari: 1 },
    { nama: 'CASE C — 7 hari', hari: 7 },
    { nama: 'CASE D — 10 hari', hari: 10 },
    { nama: 'CASE E — 30 hari', hari: 30 },
    { nama: 'CASE F — 365 hari', hari: 365 },
  ];

  for (const { nama, hari } of kasus) {
    test(`${nama}: akar ditemukan, finite, NPV dalam toleransi`, () => {
      const cashflows: EirCashFlow[] = [
        { hari: 0, jumlah: -POKOK },
        { hari, jumlah: PELUNASAN },
      ];

      const hasil = solveEffectiveInterestRate(cashflows);

      expect(Number.isFinite(hasil.rateTahunan)).toBe(true);
      expect(Number.isNaN(hasil.rateTahunan)).toBe(false);
      // Domain rate valid: 1 + r > 0 tetap dijaga.
      expect(hasil.rateTahunan).toBeGreaterThan(-1);
      // NPV pada akar benar-benar mendekati nol.
      expect(Math.abs(hasil.npvPadaRate)).toBeLessThan(TOLERANSI_DEFAULT);
      // Diverifikasi ULANG dengan NPV yang dihitung mandiri (bukan nilai
      // yang dilaporkan solver sendiri).
      expect(Math.abs(npvManual(hasil.rateTahunan, cashflows))).toBeLessThan(TOLERANSI_DEFAULT);
      // Metode boleh Newton maupun bisection — yang penting akarnya benar.
      expect(['NEWTON_RAPHSON', 'BISECTION']).toContain(hasil.metode);
    });

    test(`${nama}: akar cocok dengan penyelesaian analitik`, () => {
      const cashflows: EirCashFlow[] = [
        { hari: 0, jumlah: -POKOK },
        { hari, jumlah: PELUNASAN },
      ];
      const hasil = solveEffectiveInterestRate(cashflows);
      const eksak = akarAnalitik(POKOK, PELUNASAN, hari);
      // Perbandingan RELATIF: pada rate raksasa (tenor 1 hari mencapai
      // orde 1e12), toleransi NPV absolut Rp0,5 wajar memberi selisih
      // rate relatif kecil — yang mengikat adalah NPV, bukan digit rate.
      expect(Math.abs(hasil.rateTahunan - eksak) / Math.abs(eksak)).toBeLessThan(1e-4);
    });
  }

  test('CASE A: akar berada DI LUAR bracket lama [-0.99, 10] — inilah bug-nya', () => {
    const cashflows: EirCashFlow[] = [
      { hari: 0, jumlah: -POKOK },
      { hari: 10, jumlah: PELUNASAN },
    ];
    // Bukti akar memang di luar bracket lama.
    expect(akarAnalitik(POKOK, PELUNASAN, 10)).toBeGreaterThan(10);
    // Bukti kedua ujung bracket lama bertanda SAMA (positif) sehingga
    // bisection statis mustahil menemukan akar.
    expect(npvManual(-0.99, cashflows)).toBeGreaterThan(0);
    expect(npvManual(10, cashflows)).toBeGreaterThan(0);
    // Dan sekarang solver tetap berhasil.
    expect(solveEffectiveInterestRate(cashflows).rateTahunan).toBeGreaterThan(10);
  });

  test('CASE G: multi-installment pembayaran HARIAN', () => {
    const cashflows: EirCashFlow[] = [
      { hari: 0, jumlah: -POKOK },
      ...Array.from({ length: 10 }, (_, i) => ({ hari: i + 1, jumlah: 108_434 })),
    ];
    const hasil = solveEffectiveInterestRate(cashflows);

    expect(Number.isFinite(hasil.rateTahunan)).toBe(true);
    expect(hasil.rateTahunan).toBeGreaterThan(10); // annualized tinggi, dan itu SAH
    expect(Math.abs(npvManual(hasil.rateTahunan, cashflows))).toBeLessThan(TOLERANSI_DEFAULT);
  });

  test('DETERMINISTIK: pemanggilan berulang menghasilkan rate yang identik bit-per-bit', () => {
    const cashflows: EirCashFlow[] = [
      { hari: 0, jumlah: -POKOK },
      { hari: 10, jumlah: PELUNASAN },
    ];
    const a = solveEffectiveInterestRate(cashflows).rateTahunan;
    const b = solveEffectiveInterestRate(cashflows).rateTahunan;
    const c = solveEffectiveInterestRate(cashflows).rateTahunan;
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('EIR — dynamic bracketing', () => {
  const cashflows: EirCashFlow[] = [
    { hari: 0, jumlah: -POKOK },
    { hari: 10, jumlah: PELUNASAN },
  ];

  test('bisection murni (Newton dimatikan) tetap menemukan akar lewat bracket yang diperluas', () => {
    // maxIterasiNewton: 0 memaksa jalur fallback — membuktikan bracket
    // dinamis benar-benar bekerja, bukan tertolong Newton.
    const hasil = solveEffectiveInterestRate(cashflows, { maxIterasiNewton: 0 });
    expect(hasil.metode).toBe('BISECTION');
    expect(Math.abs(hasil.npvPadaRate)).toBeLessThan(TOLERANSI_DEFAULT);
    expect(Math.abs(hasil.rateTahunan - akarAnalitik(POKOK, PELUNASAN, 10))).toBeLessThan(1e-3);
    // Domain yang dilaporkan HARUS mencerminkan hasil perluasan (>10),
    // bukan bracket awal.
    expect(hasil.domainPencarian.hi).toBeGreaterThan(10);
  });

  test('rateMin TIDAK berubah — batas -0.99 tetap dijaga (1 + r > 0)', () => {
    const hasil = solveEffectiveInterestRate(cashflows, { maxIterasiNewton: 0 });
    expect(hasil.domainPencarian.lo).toBe(-0.99);
  });

  test('perluasan berhenti pada maxRateSearch — tidak ada infinite loop', () => {
    // Akar 10-hari ada di 18,21; dengan maxRateSearch 5 akar itu di luar
    // domain, jadi solver HARUS berhenti & melapor, bukan menggantung.
    let err: unknown;
    try {
      solveEffectiveInterestRate(cashflows, { maxIterasiNewton: 0, maxRateSearch: 5 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EirSolverError);
    expect((err as EirSolverError).code).toBe('EIR_NO_ROOT_IN_SEARCH_DOMAIN');
  });

  test('pesan error menyebut domain YANG BENAR-BENAR ditelusuri, bukan "[-0.99, 10]" lagi', () => {
    let pesan = '';
    try {
      solveEffectiveInterestRate(cashflows, { maxIterasiNewton: 0, maxRateSearch: 5 });
    } catch (e) {
      pesan = e instanceof Error ? e.message : String(e);
    }
    expect(pesan).toContain('[-0.99, 5]');
    expect(pesan).not.toContain('[-0.99, 10]');
    // Larangan fallback tetap dinyatakan eksplisit.
    expect(pesan).toMatch(/TIDAK menggunakan rate kontraktual/i);
  });

  test('bracket berbeda tanda dijamin sebelum bisection (tidak membisect interval tanpa akar)', () => {
    const hasil = solveEffectiveInterestRate(cashflows, { maxIterasiNewton: 0 });
    const npvLo = npvManual(hasil.domainPencarian.lo, cashflows);
    const npvHi = npvManual(hasil.domainPencarian.hi, cashflows);
    expect(Math.sign(npvLo)).not.toBe(Math.sign(npvHi));
  });
});

describe('EIR — error terstruktur & keamanan numerik', () => {
  test('EIR_NO_ROOT_IN_SEARCH_DOMAIN untuk cashflow yang benar-benar tanpa akar di domain', () => {
    // Pelunasan LEBIH KECIL dari pokok tapi tetap positif -> rate negatif
    // dalam; masih ada akar. Untuk memaksa tidak-ada-akar, batasi domain.
    let err: unknown;
    try {
      solveEffectiveInterestRate(
        [
          { hari: 0, jumlah: -POKOK },
          { hari: 3650, jumlah: 1 },
        ],
        { maxIterasiNewton: 0, rateMin: 0, maxRateSearch: 1 }
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EirSolverError);
    expect((err as EirSolverError).code).toBe('EIR_NO_ROOT_IN_SEARCH_DOMAIN');
  });

  test('NPV non-finite TIDAK PERNAH dianggap akar — dilaporkan EIR_NUMERIC_FAILURE', () => {
    // Tenor 100 tahun + rate raksasa membuat exp(t·log1p(r)) overflow.
    // Solver harus MELAPOR, bukan diam-diam mengembalikan angka.
    let hasilAtauError: unknown;
    try {
      hasilAtauError = solveEffectiveInterestRate(
        [
          { hari: 0, jumlah: -POKOK },
          { hari: 36_500, jumlah: PELUNASAN },
        ],
        { maxIterasiNewton: 0, rateMin: 1e10, maxRateSearch: 1e13 }
      );
    } catch (e) {
      hasilAtauError = e;
    }
    if (hasilAtauError instanceof EirSolverError) {
      expect(['EIR_NUMERIC_FAILURE', 'EIR_NO_ROOT_IN_SEARCH_DOMAIN']).toContain(hasilAtauError.code);
    } else {
      // Kalau justru berhasil, hasilnya WAJIB finite & NPV dalam toleransi.
      const r = hasilAtauError as { rateTahunan: number; npvPadaRate: number };
      expect(Number.isFinite(r.rateTahunan)).toBe(true);
      expect(Math.abs(r.npvPadaRate)).toBeLessThan(TOLERANSI_DEFAULT);
    }
  });

  test('validasi cashflow TIDAK dilemahkan oleh perbaikan ini', () => {
    expect(() => solveEffectiveInterestRate([{ hari: 0, jumlah: -100 }])).toThrow(/minimal 2 arus kas/);
    expect(() =>
      solveEffectiveInterestRate([
        { hari: 0, jumlah: -100 },
        { hari: 10, jumlah: -50 },
      ])
    ).toThrow(/arus keluar|arus masuk/);
    expect(() =>
      solveEffectiveInterestRate([
        { hari: 5, jumlah: -100 },
        { hari: 10, jumlah: 150 },
      ])
    ).toThrow(/hari ke-0/);
    expect(() =>
      solveEffectiveInterestRate([
        { hari: 0, jumlah: -100 },
        { hari: 10, jumlah: 60 },
        { hari: 3, jumlah: 60 },
      ])
    ).toThrow(/terurut menaik/);
  });

  test('TIDAK ADA fallback: kegagalan solver melempar error, bukan mengembalikan rate apa pun', () => {
    let hasil: unknown = 'TIDAK_DILEMPAR';
    try {
      hasil = solveEffectiveInterestRate(
        [
          { hari: 0, jumlah: -POKOK },
          { hari: 10, jumlah: PELUNASAN },
        ],
        { maxIterasiNewton: 0, maxRateSearch: 5 }
      );
    } catch (e) {
      hasil = e;
    }
    expect(hasil).toBeInstanceOf(EirSolverError);
    // Pastikan tidak ada angka rate yang dikembalikan diam-diam.
    expect((hasil as { rateTahunan?: number }).rateTahunan).toBeUndefined();
  });
});

describe('EIR — regresi tenor normal (perilaku lama tidak berubah)', () => {
  test('pinjaman 12 bulan tetap menghasilkan rate wajar lewat Newton', () => {
    const cashflows: EirCashFlow[] = [
      { hari: 0, jumlah: -1_000_000 },
      ...Array.from({ length: 12 }, (_, i) => ({ hari: (i + 1) * 30, jumlah: 93_000 })),
    ];
    const hasil = solveEffectiveInterestRate(cashflows);
    expect(hasil.rateTahunan).toBeGreaterThan(0);
    expect(hasil.rateTahunan).toBeLessThan(1); // < 100%/tahun, wajar
    expect(Math.abs(npvManual(hasil.rateTahunan, cashflows))).toBeLessThan(TOLERANSI_DEFAULT);
  });

  test('rate negatif (pelunasan lebih kecil dari pokok) tetap dapat ditemukan', () => {
    const cashflows: EirCashFlow[] = [
      { hari: 0, jumlah: -1_000_000 },
      { hari: 365, jumlah: 900_000 },
    ];
    const hasil = solveEffectiveInterestRate(cashflows);
    expect(hasil.rateTahunan).toBeLessThan(0);
    expect(hasil.rateTahunan).toBeGreaterThan(-1);
    expect(Math.abs(npvManual(hasil.rateTahunan, cashflows))).toBeLessThan(TOLERANSI_DEFAULT);
  });
});

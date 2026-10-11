/**
 * PHASE 7 (permintaan pengguna) — EIR SOLVER NYATA.
 *
 * Menghitung Effective Interest Rate (EIR) dari sekumpulan arus kas
 * kontraktual aktual (initial carrying amount SEBAGAI ARUS KELUAR di
 * tanggal disbursement, diikuti seluruh penerimaan kontraktual
 * SEBAGAI ARUS MASUK pada tanggal jatuh temponya masing-masing) —
 * metode XIRR (Actual/365, date-aware, TIDAK mengasumsikan interval
 * seragam kalau tanggal kontrak memang tidak seragam, sesuai §H).
 *
 * "EIR" di sini adalah rate TAHUNAN r yang membuat:
 *   NPV(r) = Σ CF_i / (1+r)^(hari_i/365) ≈ 0
 * dengan hari_i = selisih hari kalender dari tanggal cashflow PERTAMA
 * (disbursement, hari_0 = 0).
 *
 * SOLVER: Newton-Raphson (konvergensi cepat untuk pola cashflow
 * pinjaman yang wajar — satu arus keluar di awal, arus masuk
 * sesudahnya, jadi NPV(r) monoton turun terhadap r) dengan FALLBACK
 * bisection kalau Newton-Raphson gagal konvergen/divergen keluar
 * domain — BUKAN dua metode yang saling bertentangan, bisection murni
 * jaring pengaman numerik. TIDAK PERNAH mengembalikan rate kalau
 * TIDAK konvergen dalam batas iterasi & toleransi eksplisit — throw
 * error, TIDAK ADA fallback contractual rate/FLAT rate/0%/nilai
 * sebelumnya (§AC, larangan eksplisit).
 */

export interface EirCashFlow {
  /** Hari kalender sejak cashflow pertama (disbursement = 0). Boleh TIDAK seragam antar baris (tanggal kontrak tidak harus berjarak sama). */
  hari: number;
  /** Nominal — NEGATIF untuk arus keluar (initial carrying amount di disbursement), POSITIF untuk arus masuk (penerimaan kontraktual). */
  jumlah: number;
}

export interface EirSolverOptions {
  /** Toleransi NPV absolut (dalam satuan Rupiah) untuk dianggap konvergen. Default 0.5 (setengah rupiah — nominal aplikasi ini integer, jadi ini sangat ketat). */
  toleransi?: number;
  /** Batas maksimum iterasi Newton-Raphson sebelum beralih ke bisection. */
  maxIterasiNewton?: number;
  /** Batas maksimum iterasi bisection (fallback). */
  maxIterasiBisection?: number;
  /** Batas bawah domain rate tahunan untuk bisection (default -0.99 = -99%, mencegah (1+r) <= 0). TIDAK BOLEH dinaikkan mendekati/melewati -1. */
  rateMin?: number;
  /**
   * Batas atas AWAL bracket (default 10 = 1000%). Ini BUKAN lagi batas
   * keras domain pencarian: kalau tanda NPV di [rateMin, rateMax] sama,
   * batas atas DIPERLUAS otomatis (lihat cariBracket) sampai
   * `maxRateSearch`.
   */
  rateMax?: number;
  /**
   * BUG FIX TENOR PENDEK — batas KERAS perluasan bracket (default 1e6 =
   * 100.000.000%/tahun).
   *
   * Alasan nilainya sebesar ini: EIR di sini adalah rate TAHUNAN dari
   * arus kas Actual/365. Pinjaman bertenor sangat pendek menghasilkan
   * annualized rate yang secara matematis memang sangat besar walau
   * fee-nya kecil. Contoh nyata yang memicu bug ini: pokok 1.000.000,
   * tenor 10 HARI, pelunasan 1.084.340 -> akar eksaknya
   *   r = (1.084340/1.000.000)^(365/10) - 1 = 18,21 (=1821%/tahun).
   * Akar itu SAH: NPV(18,21) = 0, arus kasnya valid, tenornya nyata.
   * Dengan batas atas lama (10) akar tersebut berada DI LUAR domain,
   * sehingga NPV(rateMin) dan NPV(rateMax) SAMA-SAMA POSITIF dan solver
   * menyimpulkan "tidak ada akar" — padahal akarnya ada, hanya di luar
   * jendela pencarian. Rate tinggi TIDAK sama dengan rate invalid.
   *
   * NILAI DEFAULT 1e13 DIPILIH LEWAT AUDIT OVERFLOW, bukan dikarang:
   * faktor diskonto dievaluasi sebagai exp(t · log1p(r)) dan double
   * presisi ganda overflow saat eksponennya melewati ~709. Dengan
   * r = 1e13, log1p(r) = 29,93 sehingga NPV tetap finite untuk tenor
   * sampai 709/29,93 = 23,7 TAHUN — jauh di atas tenor pinjaman
   * koperasi mana pun. Sementara itu 1e13 cukup menampung kasus tenor
   * paling ekstrem yang mungkin: pinjaman 1 HARI dengan fee 8,4%
   * memberi akar 6,85e12.
   * Nilai yang lebih besar (mis. 1e15) justru MEMPERSEMPIT tenor aman
   * menjadi 20,5 tahun tanpa manfaat tambahan.
   *
   * Batas tetap FINITE & ter-audit terhadap overflow: lihat
   * `diskonto()` — evaluasi NPV yang menghasilkan nilai non-finite
   * TIDAK PERNAH dianggap akar, melainkan dilaporkan sebagai
   * EIR_NUMERIC_FAILURE.
   */
  maxRateSearch?: number;
}

/** Kode error terstruktur supaya pemanggil dapat membedakan dua kegagalan yang berbeda sifatnya. */
export type EirSolverErrorCode = 'EIR_NO_ROOT_IN_SEARCH_DOMAIN' | 'EIR_NUMERIC_FAILURE';

export class EirSolverError extends Error {
  readonly code: EirSolverErrorCode;
  /** Domain yang BENAR-BENAR ditelusuri (setelah perluasan), bukan domain awal. */
  readonly domainPencarian: { lo: number; hi: number };
  constructor(code: EirSolverErrorCode, message: string, domainPencarian: { lo: number; hi: number }) {
    super(message);
    this.name = 'EirSolverError';
    this.code = code;
    this.domainPencarian = domainPencarian;
  }
}

export interface EirSolverResult {
  /** Rate EFEKTIF TAHUNAN (mis. 0.18 = 18%/tahun) — BUKAN rate per periode, BUKAN contractual rate. */
  rateTahunan: number;
  npvPadaRate: number;
  iterasi: number;
  metode: 'NEWTON_RAPHSON' | 'BISECTION';
  /** Domain yang benar-benar ditelusuri setelah perluasan bracket — untuk audit/diagnostik. */
  domainPencarian: { lo: number; hi: number };
}

const DEFAULT_OPTIONS: Required<EirSolverOptions> = {
  toleransi: 0.5,
  maxIterasiNewton: 60,
  maxIterasiBisection: 200,
  rateMin: -0.99,
  rateMax: 10,
  // Lihat penjelasan pemilihan nilai di EirSolverOptions.maxRateSearch.
  maxRateSearch: 1e13,
};

/**
 * Faktor diskonto (1+r)^t dihitung sebagai exp(t * log1p(r)).
 *
 * FORMULA EKONOMINYA TIDAK BERUBAH — ini identik secara matematis
 * dengan Math.pow(1+r, t). Yang berubah hanya cara evaluasinya:
 *  - `Math.log1p(r)` jauh lebih akurat daripada `Math.log(1+r)` saat r
 *    sangat kecil (kasus rate mendekati 0), sehingga NPV di sekitar
 *    akar tidak kehilangan presisi;
 *  - bentuk exp/log membuat overflow terdeteksi sebagai Infinity yang
 *    rapi alih-alih hasil pow yang bisa menyesatkan.
 * Mengembalikan NaN kalau 1+r <= 0 (domain terlarang, dijaga rateMin).
 */
function diskonto(rateTahunan: number, t: number): number {
  const satuPlusR = 1 + rateTahunan;
  if (!(satuPlusR > 0)) return NaN;
  if (t === 0) return 1;
  return Math.exp(t * Math.log1p(rateTahunan));
}

function npv(rateTahunan: number, cashflows: EirCashFlow[]): number {
  let total = 0;
  for (const cf of cashflows) {
    const df = diskonto(rateTahunan, cf.hari / 365);
    if (!Number.isFinite(df)) return NaN;
    // df bisa membesar sangat cepat pada rate ekstrem; pembagian oleh
    // Infinity menghasilkan 0 (benar secara limit), tapi df = 0
    // (underflow) akan menghasilkan Infinity -> ditandai non-finite.
    total += cf.jumlah / df;
  }
  return Number.isFinite(total) ? total : NaN;
}

function npvTurunan(rateTahunan: number, cashflows: EirCashFlow[]): number {
  let total = 0;
  for (const cf of cashflows) {
    const t = cf.hari / 365;
    if (t === 0) continue; // turunan terhadap r dari CF hari-0 selalu 0 (tidak didiskon)
    const df = diskonto(rateTahunan, t + 1);
    if (!Number.isFinite(df) || df === 0) return NaN;
    total += (-t * cf.jumlah) / df;
  }
  return Number.isFinite(total) ? total : NaN;
}

/**
 * §I: validasi bentuk cashflow SEBELUM solving — harus ada minimal
 * satu arus keluar (negatif) dan satu arus masuk (positif), diurutkan
 * menaik berdasarkan `hari`, hari pertama = 0. Kalau tidak, solver
 * TIDAK BISA menghasilkan rate yang bermakna secara keuangan — lebih
 * baik gagal jelas daripada menghasilkan angka yang secara matematis
 * "konvergen" tapi tidak masuk akal (mis. NPV konstan kalau semua
 * cashflow sama tanda).
 */
function validasiCashFlows(cashflows: EirCashFlow[]): void {
  if (cashflows.length < 2) {
    throw new Error('EIR memerlukan minimal 2 arus kas (initial carrying amount + minimal satu penerimaan kontraktual).');
  }
  if (cashflows[0].hari !== 0) {
    throw new Error('Arus kas pertama (disbursement) harus berada di hari ke-0.');
  }
  for (let i = 1; i < cashflows.length; i++) {
    if (cashflows[i].hari < cashflows[i - 1].hari) {
      throw new Error('Arus kas harus terurut menaik berdasarkan tanggal (hari).');
    }
  }
  const adaArusKeluar = cashflows.some((cf) => cf.jumlah < 0);
  const adaArusMasuk = cashflows.some((cf) => cf.jumlah > 0);
  if (!adaArusKeluar || !adaArusMasuk) {
    throw new Error('EIR memerlukan minimal satu arus keluar (initial carrying amount) dan satu arus masuk (penerimaan kontraktual) — tidak bisa dihitung dari cashflow yang seluruhnya searah.');
  }
}

/**
 * BUG FIX TENOR PENDEK — DYNAMIC BRACKETING.
 *
 * Mencari pasangan [lo, hi] yang BENAR-BENAR MEMBUNGKUS akar, yaitu
 * sign(NPV(lo)) !== sign(NPV(hi)). Sebelumnya bracket-nya statis
 * [rateMin, rateMax=10]; kalau akarnya di atas 10 (lazim untuk tenor
 * sangat pendek) solver salah menyimpulkan "tidak ada akar".
 *
 * Algoritma:
 *   1. lo = rateMin (batas bawah TETAP -0.99 — menjaga 1+r > 0).
 *   2. hi = rateMax (batas atas AWAL, default 10).
 *   3. Selama sign(NPV(lo)) === sign(NPV(hi)): naikkan hi ×10
 *      (10 -> 100 -> 1.000 -> ... ) dan geser lo ke hi SEBELUMNYA —
 *      aman karena hi lama terbukti bertanda sama dengan lo, dan
 *      menghasilkan bracket yang lebih rapat untuk bisection.
 *   4. Berhenti saat tanda berbeda (bracket ketemu), atau saat hi sudah
 *      mencapai maxRateSearch (berhenti PASTI — tidak ada infinite loop
 *      karena hi naik eksponensial menuju batas finite).
 *
 * NPV non-finite di titik mana pun TIDAK PERNAH dianggap akar maupun
 * dianggap "beda tanda" — dilaporkan sebagai EIR_NUMERIC_FAILURE.
 */
function cariBracket(
  cashflows: EirCashFlow[],
  rateMin: number,
  rateMaxAwal: number,
  maxRateSearch: number
): { lo: number; hi: number; npvLo: number; npvHi: number; akarTepat: number | null } {
  const npvLoAwal = npv(rateMin, cashflows);
  if (!Number.isFinite(npvLoAwal)) {
    throw new EirSolverError(
      'EIR_NUMERIC_FAILURE',
      `Evaluasi NPV pada batas bawah domain (${rateMin}) menghasilkan nilai non-finite (NaN/Infinity). ` +
        `Arus kas kemungkinan mengandung nominal atau jangka waktu ekstrem. Transaksi DIBATALKAN — TIDAK menggunakan rate kontraktual/fallback.`,
      { lo: rateMin, hi: rateMaxAwal }
    );
  }
  if (npvLoAwal === 0) return { lo: rateMin, hi: rateMin, npvLo: 0, npvHi: 0, akarTepat: rateMin };

  let lo = rateMin;
  let npvLo = npvLoAwal;
  let hi = Math.min(rateMaxAwal, maxRateSearch);

  // Naik ×10 sampai tanda berbeda atau menyentuh batas keras.
  for (;;) {
    const npvHi = npv(hi, cashflows);
    if (!Number.isFinite(npvHi)) {
      throw new EirSolverError(
        'EIR_NUMERIC_FAILURE',
        `Evaluasi NPV pada rate ${hi} menghasilkan nilai non-finite (overflow/underflow numerik) — TIDAK dianggap sebagai akar. ` +
          `Transaksi DIBATALKAN — TIDAK menggunakan rate kontraktual/fallback.`,
        { lo, hi }
      );
    }
    if (npvHi === 0) return { lo, hi, npvLo, npvHi, akarTepat: hi };
    if (Math.sign(npvHi) !== Math.sign(npvLo)) {
      return { lo, hi, npvLo, npvHi, akarTepat: null };
    }
    if (hi >= maxRateSearch) {
      throw new EirSolverError(
        'EIR_NO_ROOT_IN_SEARCH_DOMAIN',
        `Tidak ditemukan akar EIR pada domain pencarian [${rateMin}, ${maxRateSearch}]: NPV bertanda sama di kedua ujung ` +
          `(NPV(${rateMin}) = ${npvLoAwal.toFixed(2)}, NPV(${maxRateSearch}) = ${npvHi.toFixed(2)}), ` +
          `sehingga tidak ada rate di domain tersebut yang membuat NPV = 0. ` +
          `Transaksi DIBATALKAN — TIDAK menggunakan rate kontraktual/FLAT/0%/nilai sebelumnya sebagai fallback.`,
        { lo: rateMin, hi: maxRateSearch }
      );
    }
    // hi lama bertanda sama dengan lo -> aman dijadikan lo baru (bracket lebih rapat).
    lo = hi;
    npvLo = npvHi;
    hi = Math.min(hi * 10, maxRateSearch);
  }
}

/**
 * §H/§I/§AC: solve EIR dari cashflow aktual. Newton-Raphson dulu
 * (cepat, presisi tinggi untuk pola cashflow pinjaman wajar); kalau
 * TIDAK konvergen dalam `maxIterasiNewton` ATAU keluar domain rate
 * yang masuk akal (rate < rateMin, mis. hasil iterasi liar), beralih
 * ke bisection pada domain [rateMin, rateMax] (butuh NPV(rateMin) dan
 * NPV(rateMax) berlawanan tanda — kalau tidak, berarti TIDAK ADA rate
 * di domain itu yang membuat NPV=0, throw error EKSPLISIT, BUKAN
 * paksa suatu nilai). Kalau bisection JUGA tidak mencapai toleransi
 * dalam `maxIterasiBisection`: throw — TIDAK PERNAH mengembalikan
 * rate yang tidak terbukti konvergen (§AC).
 */
export function solveEffectiveInterestRate(cashflows: EirCashFlow[], opts: EirSolverOptions = {}): EirSolverResult {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  validasiCashFlows(cashflows);

  // --- Newton-Raphson (fast path) ---
  // Domain gerak Newton sekarang (rateMin, maxRateSearch), BUKAN lagi
  // (rateMin, rateMax=10). Itu bagian dari bug: pada tenor pendek akar
  // yang sah berada di atas 10, sehingga Newton yang bergerak MENUJU
  // akar justru dihentikan karena dianggap "keluar domain".
  let rate = 0.1; // titik awal deterministic tetap (10%/tahun) — bukan tebakan acak, sama untuk setiap pemanggilan dengan cashflow yang sama -> hasil deterministic.
  let iterasi = 0;
  let konvergenNewton = false;
  for (; iterasi < o.maxIterasiNewton; iterasi++) {
    const nilaiNpv = npv(rate, cashflows);
    if (!Number.isFinite(nilaiNpv)) break; // evaluasi tidak sehat -> serahkan ke bisection
    if (Math.abs(nilaiNpv) < o.toleransi) {
      konvergenNewton = true;
      break;
    }
    const turunan = npvTurunan(rate, cashflows);
    // Turunan ~0 membuat langkah Newton meledak — bukan berarti akar
    // tidak ada, hanya berarti Newton bukan alat yang tepat di titik ini.
    if (turunan === 0 || !Number.isFinite(turunan)) break;
    const rateBaru = rate - nilaiNpv / turunan;
    if (!Number.isFinite(rateBaru) || rateBaru <= o.rateMin || rateBaru >= o.maxRateSearch) break;
    rate = rateBaru;
  }

  if (konvergenNewton && Number.isFinite(rate)) {
    const npvAkhir = npv(rate, cashflows);
    if (!Number.isFinite(npvAkhir)) {
      throw new EirSolverError(
        'EIR_NUMERIC_FAILURE',
        'EIR solver menghasilkan NPV non-finite pada rate hasil Newton-Raphson — ditolak, tidak digunakan.',
        { lo: o.rateMin, hi: o.maxRateSearch }
      );
    }
    return {
      rateTahunan: rate,
      npvPadaRate: npvAkhir,
      iterasi: iterasi + 1,
      metode: 'NEWTON_RAPHSON',
      domainPencarian: { lo: o.rateMin, hi: o.maxRateSearch },
    };
  }

  // --- Fallback: dynamic-bracket bisection ---
  // Kegagalan Newton TIDAK PERNAH disimpulkan sebagai "EIR tidak ada".
  // Bracket dicari dulu secara dinamis; bisection HANYA dijalankan pada
  // interval yang TERBUKTI membungkus akar (tanda NPV berbeda).
  const bracket = cariBracket(cashflows, o.rateMin, o.rateMax, o.maxRateSearch);
  const domainPencarian = { lo: o.rateMin, hi: bracket.hi };

  if (bracket.akarTepat !== null) {
    // NPV tepat 0 di titik evaluasi — akar eksak, tidak perlu bisection.
    return {
      rateTahunan: bracket.akarTepat,
      npvPadaRate: 0,
      iterasi: iterasi + 1,
      metode: 'BISECTION',
      domainPencarian,
    };
  }

  let lo = bracket.lo;
  let hi = bracket.hi;
  const npvLo = bracket.npvLo;

  // Prasyarat bisection ditegaskan ulang (defensif): tanda HARUS berbeda.
  if (Math.sign(npvLo) === Math.sign(bracket.npvHi)) {
    throw new EirSolverError(
      'EIR_NUMERIC_FAILURE',
      'Bracket yang dihasilkan tidak membungkus akar (tanda NPV sama di kedua ujung) — bisection dibatalkan alih-alih menghasilkan rate yang tidak sah.',
      domainPencarian
    );
  }

  let mid = 0;
  let npvMid = 0;
  let bisIterasi = 0;
  for (; bisIterasi < o.maxIterasiBisection; bisIterasi++) {
    mid = (lo + hi) / 2;
    npvMid = npv(mid, cashflows);
    if (!Number.isFinite(npvMid)) {
      throw new EirSolverError(
        'EIR_NUMERIC_FAILURE',
        `Evaluasi NPV pada rate ${mid} di dalam bisection menghasilkan nilai non-finite — TIDAK dianggap akar.`,
        domainPencarian
      );
    }
    if (Math.abs(npvMid) < o.toleransi) break;
    if (Math.sign(npvMid) === Math.sign(npvLo)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  if (Math.abs(npvMid) >= o.toleransi || !Number.isFinite(mid)) {
    throw new EirSolverError(
      'EIR_NUMERIC_FAILURE',
      `EIR solver TIDAK KONVERGEN setelah ${o.maxIterasiNewton} iterasi Newton-Raphson + ${o.maxIterasiBisection} iterasi bisection ` +
        `pada domain [${domainPencarian.lo}, ${domainPencarian.hi}] (toleransi NPV: Rp${o.toleransi}). ` +
        `Transaksi DIBATALKAN — TIDAK menggunakan rate kontraktual/FLAT/0%/nilai sebelumnya sebagai fallback (§AC).`,
      domainPencarian
    );
  }

  return { rateTahunan: mid, npvPadaRate: npvMid, iterasi: bisIterasi + 1, metode: 'BISECTION', domainPencarian };
}

/**
 * §K: konversi rate tahunan -> faktor pertumbuhan untuk satu periode
 * sepanjang `hariPeriode` hari (Actual/365) — dipakai untuk menghitung
 * effective interest income = opening carrying amount × (faktor - 1)
 * pada satu periode akrual, KONSISTEN dengan basis Actual/365 yang
 * dipakai solver di atas (bukan asumsi 30/360 atau rate/12 flat).
 */
export function faktorPeriodeDariRateTahunan(rateTahunan: number, hariPeriode: number): number {
  return Math.pow(1 + rateTahunan, hariPeriode / 365);
}

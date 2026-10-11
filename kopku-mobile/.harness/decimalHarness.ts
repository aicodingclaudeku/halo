/**
 * IMPLEMENTASI `decimal.js` UNTUK HARNESS — BERBASIS BigInt
 * =========================================================================
 *
 * MASALAH YANG DIPECAHKAN.
 *
 * `src/test-utils/decimalShim.ts` adalah shim TIPE SAJA: setiap
 * `toNumber()` mengembalikan 0, dan berkasnya sendiri menyatakan ia
 * "tidak pernah dipakai di runtime". Ketika harness memetakan
 * `decimal.js` ke sana, seluruh aritmetika uang menjadi nol — dan test
 * seperti "10.000.000 @ 12% tenor 3 = 300.000" gagal dengan "got 0".
 * Kegagalan itu TIDAK menunjukkan bug produksi; ia menunjukkan harness
 * yang berbohong.
 *
 * KENAPA BigInt, BUKAN `number`.
 *
 * Seluruh alasan `decimal.js` dipakai di kode ini adalah aritmetika uang
 * yang EKSAK. Shim berbasis float akan benar di hampir semua kasus lalu
 * meleset satu rupiah di kasus pembulatan — persis kelas kesalahan yang
 * paling mahal, karena test tetap hijau sementara buku tidak seimbang.
 * Karena itu nilai disimpan sebagai BigInt terskala:
 *
 *     nilai sebenarnya = unit / 10^SKALA
 *
 * SKALA 20 desimal cukup jauh di atas kebutuhan (rupiah bulat, suku
 * bunga, faktor EIR) sehingga pembagian berulang tidak kehilangan digit
 * yang bermakna.
 *
 * CAKUPAN. Hanya permukaan yang benar-benar dipakai kode produksi.
 * Metode yang tidak diimplementasikan MELEMPAR, tidak mengembalikan
 * nilai karangan.
 *
 * Berkas ini berada di `.harness/` dan TIDAK PERNAH ikut ter-bundle.
 */

const SKALA = 20n;
const FAKTOR = 10n ** SKALA;

type Masukan = number | string | Decimal;

function keUnit(nilai: Masukan): bigint {
  if (nilai instanceof Decimal) return nilai.unit;
  const teks = typeof nilai === 'string' ? nilai.trim() : String(nilai);

  if (teks === '' || teks === 'NaN') {
    throw new Error(`harness Decimal: nilai tidak valid (${teks})`);
  }
  // Notasi eksponen (mis. 1e-7) muncul dari String(number) untuk angka
  // sangat kecil — dipakai solver EIR.
  const eksponen = teks.match(/^([+-]?[\d.]+)[eE]([+-]?\d+)$/);
  if (eksponen) {
    const dasar = keUnit(eksponen[1]);
    const pangkat = BigInt(eksponen[2]);
    return pangkat >= 0n ? dasar * 10n ** pangkat : dasar / 10n ** -pangkat;
  }

  const cocok = teks.match(/^([+-]?)(\d*)(?:\.(\d*))?$/);
  if (!cocok) throw new Error(`harness Decimal: nilai tidak valid (${teks})`);
  const tanda = cocok[1] === '-' ? -1n : 1n;
  const bulat = cocok[2] === '' ? 0n : BigInt(cocok[2]);
  const pecahanTeks = (cocok[3] ?? '').slice(0, Number(SKALA)).padEnd(Number(SKALA), '0');
  const pecahan = pecahanTeks === '' ? 0n : BigInt(pecahanTeks);
  return tanda * (bulat * FAKTOR + pecahan);
}

/** Pembulatan setengah ke atas menjauhi nol, pada bilangan bulat BigInt. */
function bagiBulatHalfUp(pembilang: bigint, penyebut: bigint): bigint {
  if (penyebut === 0n) throw new Error('harness Decimal: pembagian dengan nol');
  const negatif = pembilang < 0n !== penyebut < 0n;
  const a = pembilang < 0n ? -pembilang : pembilang;
  const b = penyebut < 0n ? -penyebut : penyebut;
  const hasil = a / b;
  const sisa = a % b;
  const dibulatkan = sisa * 2n >= b ? hasil + 1n : hasil;
  return negatif ? -dibulatkan : dibulatkan;
}

export default class Decimal {
  readonly unit: bigint;

  static readonly ROUND_HALF_UP = 4;
  static readonly ROUND_DOWN = 1;
  static readonly ROUND_UP = 0;

  constructor(nilai: Masukan) {
    this.unit = keUnit(nilai);
  }

  private static dariUnit(unit: bigint): Decimal {
    const d = Object.create(Decimal.prototype) as { unit: bigint };
    d.unit = unit;
    return d as Decimal;
  }

  plus(v: Masukan): Decimal {
    return Decimal.dariUnit(this.unit + keUnit(v));
  }
  minus(v: Masukan): Decimal {
    return Decimal.dariUnit(this.unit - keUnit(v));
  }
  times(v: Masukan): Decimal {
    return Decimal.dariUnit((this.unit * keUnit(v)) / FAKTOR);
  }
  mul(v: Masukan): Decimal {
    return this.times(v);
  }
  div(v: Masukan): Decimal {
    const pembagi = keUnit(v);
    if (pembagi === 0n) throw new Error('harness Decimal: pembagian dengan nol');
    return Decimal.dariUnit((this.unit * FAKTOR) / pembagi);
  }
  negated(): Decimal {
    return Decimal.dariUnit(-this.unit);
  }
  abs(): Decimal {
    return Decimal.dariUnit(this.unit < 0n ? -this.unit : this.unit);
  }

  /** Pangkat bilangan bulat — dipakai faktor diskonto EIR. */
  pow(eksponen: number): Decimal {
    if (!Number.isInteger(eksponen)) {
      throw new Error('harness Decimal: pow hanya mendukung eksponen bilangan bulat');
    }
    if (eksponen === 0) return new Decimal(1);
    const negatif = eksponen < 0;
    let sisa = Math.abs(eksponen);
    let basis: Decimal = this;
    let hasil = new Decimal(1);
    while (sisa > 0) {
      if (sisa % 2 === 1) hasil = hasil.times(basis);
      basis = basis.times(basis);
      sisa = Math.floor(sisa / 2);
    }
    return negatif ? new Decimal(1).div(hasil) : hasil;
  }

  toDecimalPlaces(dp = 0, _mode?: number): Decimal {
    const sisaSkala = SKALA - BigInt(dp);
    if (sisaSkala <= 0n) return Decimal.dariUnit(this.unit);
    const penyebut = 10n ** sisaSkala;
    return Decimal.dariUnit(bagiBulatHalfUp(this.unit, penyebut) * penyebut);
  }
  round(): Decimal {
    return this.toDecimalPlaces(0);
  }

  comparedTo(v: Masukan): number {
    const lain = keUnit(v);
    return this.unit === lain ? 0 : this.unit > lain ? 1 : -1;
  }
  cmp(v: Masukan): number {
    return this.comparedTo(v);
  }
  equals(v: Masukan): boolean {
    return this.unit === keUnit(v);
  }
  eq(v: Masukan): boolean {
    return this.equals(v);
  }
  greaterThan(v: Masukan): boolean {
    return this.unit > keUnit(v);
  }
  gt(v: Masukan): boolean {
    return this.greaterThan(v);
  }
  greaterThanOrEqualTo(v: Masukan): boolean {
    return this.unit >= keUnit(v);
  }
  gte(v: Masukan): boolean {
    return this.greaterThanOrEqualTo(v);
  }
  lessThan(v: Masukan): boolean {
    return this.unit < keUnit(v);
  }
  lt(v: Masukan): boolean {
    return this.lessThan(v);
  }
  lessThanOrEqualTo(v: Masukan): boolean {
    return this.unit <= keUnit(v);
  }
  lte(v: Masukan): boolean {
    return this.lessThanOrEqualTo(v);
  }
  isZero(): boolean {
    return this.unit === 0n;
  }
  isNegative(): boolean {
    return this.unit < 0n;
  }
  isPositive(): boolean {
    return this.unit > 0n;
  }

  toNumber(): number {
    return Number(this.toString());
  }

  toFixed(dp = 0): string {
    const dibulatkan = this.toDecimalPlaces(dp);
    const negatif = dibulatkan.unit < 0n;
    const abs = negatif ? -dibulatkan.unit : dibulatkan.unit;
    const bulat = abs / FAKTOR;
    const pecahan = (abs % FAKTOR).toString().padStart(Number(SKALA), '0').slice(0, dp);
    const teks = dp > 0 ? `${bulat}.${pecahan}` : `${bulat}`;
    return negatif && abs !== 0n ? `-${teks}` : teks;
  }

  toString(): string {
    const negatif = this.unit < 0n;
    const abs = negatif ? -this.unit : this.unit;
    const bulat = abs / FAKTOR;
    const pecahan = (abs % FAKTOR).toString().padStart(Number(SKALA), '0').replace(/0+$/, '');
    const teks = pecahan === '' ? `${bulat}` : `${bulat}.${pecahan}`;
    return negatif && abs !== 0n ? `-${teks}` : teks;
  }
}

export { Decimal };

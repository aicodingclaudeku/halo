/**
 * Shim tipe `decimal.js` untuk typecheck ter-scope.
 *
 * `node_modules` tidak tersedia di lingkungan pengembangan ini, jadi
 * `EarlyWithdrawalPolicy.ts` -> `utils/money.ts` -> `decimal.js` tidak
 * dapat di-resolve. Shim ini HANYA memenuhi permukaan tipe yang dipakai
 * berkas-berkas itu — ia BUKAN implementasi presisi dan tidak pernah
 * dipakai di runtime produksi maupun harness.
 */
export default class Decimal {
  constructor(_v: number | string | Decimal) {}
  plus(_v: number | string | Decimal): Decimal { return this; }
  minus(_v: number | string | Decimal): Decimal { return this; }
  times(_v: number | string | Decimal): Decimal { return this; }
  div(_v: number | string | Decimal): Decimal { return this; }
  toNumber(): number { return 0; }
  toFixed(_d?: number): string { return '0'; }
  mul(_v: number | string | Decimal): Decimal { return this; }
  toDecimalPlaces(_dp?: number, _rm?: number): Decimal { return this; }
  round(): Decimal { return this; }
  static readonly ROUND_HALF_UP = 4;
  static readonly ROUND_DOWN = 1;
  abs(): Decimal { return this; }
  isZero(): boolean { return true; }
  lessThan(_v: number | string | Decimal): boolean { return false; }
  greaterThan(_v: number | string | Decimal): boolean { return false; }
}

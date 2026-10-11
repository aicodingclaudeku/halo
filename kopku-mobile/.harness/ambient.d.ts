/**
 * DEKLARASI AMBIENT MINIMAL UNTUK HARNESS OFFLINE.
 *
 * `node_modules` tidak tersedia dan registry npm terblokir, sehingga
 * `@types/node` dan `@types/jest` TIDAK dapat dipasang. Berkas ini
 * menyediakan permukaan tipe seperlunya supaya `tsc` bisa memeriksa
 * SEMANTIK berkas lisensi secara offline.
 *
 * BATAS YANG HARUS DIAKUI DENGAN JELAS:
 * lulusnya typecheck di sini BUKAN pengganti `npm run typecheck` di
 * lingkungan asli. Tipe-tipe di bawah adalah pendekatan kasar; tipe
 * asli dari @types/node & @types/jest lebih ketat. Status resmi
 * `npm run typecheck` tetap NOT VERIFIED sampai dijalankan di mesin
 * yang punya node_modules lengkap.
 */

declare var process: {
  env: Record<string, string | undefined>;
  version: string;
};

declare var __dirname: string;
declare var globalThis: Record<string, unknown> & { fetch?: unknown };

declare class Buffer extends Uint8Array {
  static from(input: string, encoding?: string): Buffer;
  static from(input: ArrayBuffer, byteOffset?: number, length?: number): Buffer;
  static from(input: Uint8Array): Buffer;
  static concat(list: readonly Uint8Array[]): Buffer;
  static alloc(size: number): Buffer;
  toString(encoding?: string): string;
  subarray(start?: number, end?: number): Buffer;
}

declare module 'crypto' {
  export interface KeyObject {
    export(options: { format: string; type: string }): Buffer;
  }
  export function generateKeyPairSync(
    type: 'ed25519'
  ): { publicKey: KeyObject; privateKey: KeyObject };
  export function sign(
    algorithm: null,
    data: Uint8Array,
    key: KeyObject
  ): Buffer;
  export function verify(
    algorithm: null,
    data: Uint8Array,
    key: KeyObject,
    signature: Uint8Array
  ): boolean;
  export function createPublicKey(input: {
    key: Uint8Array;
    format: string;
    type: string;
  }): KeyObject;
  export function createHash(algorithm: string): {
    update(data: Uint8Array | string): {
      digest(): Buffer;
      digest(encoding: string): string;
    };
  };
  export function randomUUID(): string;
  export function randomBytes(size: number): Buffer;
}

declare module 'fs' {
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: string): string;
  export function statSync(path: string): { isDirectory(): boolean };
}

declare module 'path' {
  export function join(...parts: string[]): string;
}

// --- permukaan Jest seperlunya --------------------------------------------

declare function describe(name: string, fn: () => void): void;
declare function beforeAll(fn: () => void | Promise<void>): void;
declare function afterAll(fn: () => void | Promise<void>): void;
declare function beforeEach(fn: () => void | Promise<void>): void;
declare function afterEach(fn: () => void | Promise<void>): void;

interface JestEach {
  (cases: readonly unknown[][]): (name: string, fn: (...args: never[]) => void | Promise<void>) => void;
}

interface JestIt {
  (name: string, fn: () => void | Promise<void>): void;
  each: JestEach;
}

declare const it: JestIt;

interface JestMatchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeGreaterThan(expected: number): void;
  toBeLessThan(expected: number): void;
  toThrow(expected?: RegExp | string): void;
  toHaveLength(expected: number): void;
  toContain(expected: unknown): void;
  toMatch(expected: RegExp | string): void;
  toHaveBeenCalled(): void;
  toHaveBeenCalledTimes(count: number): void;
  readonly not: JestMatchers;
}

declare function expect(actual: unknown): JestMatchers;

declare namespace jest {
  interface Mock {
    (...args: never[]): unknown;
    mockResolvedValueOnce(value: unknown): Mock;
    mockImplementationOnce(fn: (...args: never[]) => unknown): Mock;
    mockImplementation(fn: (...args: never[]) => unknown): Mock;
    mockReturnValue(value: unknown): Mock;
    mockClear(): void;
    readonly mock: { calls: unknown[][] };
  }
  interface SpyInstance<TReturn = unknown, TArgs extends unknown[] = []> {
    mockReturnValue(value: TReturn): SpyInstance<TReturn, TArgs>;
    mockRestore(): void;
  }
}

declare const jest: {
  fn(): jest.Mock;
  /**
   * RC-S57 §9 — dua overload API Jest standar yang sebelumnya tidak
   * dideklarasikan shim ini, sehingga setiap suite ber-`jest.mock` (24 suite
   * di baseline, termasuk RC-S55/RC-S56) mendapat error palsu TS2339/TS2554
   * di tsconfig.rcs53. Hanya tipe; tidak ada perilaku runtime yang berubah.
   */
  fn(implementation: (...args: never[]) => unknown): jest.Mock;
  mock(moduleName: string, factory?: () => unknown): void;
  spyOn<T extends object, K extends keyof T>(
    object: T,
    method: K
  ): jest.SpyInstance<number, []>;
};


/**
 * Modul Expo yang TIDAK dipakai jalur kode yang diuji di sini.
 * Dideklarasikan longgar semata agar `db.ts` dapat di-typecheck; jangan
 * dijadikan acuan bentuk API-nya.
 */
declare module 'expo-file-system/legacy' {
  export const documentDirectory: string | null;
  export function deleteAsync(uri: string, options?: unknown): Promise<void>;
  export function getInfoAsync(uri: string, options?: unknown): Promise<{ exists: boolean }>;
  export function copyAsync(options: { from: string; to: string }): Promise<void>;
  export function makeDirectoryAsync(uri: string, options?: unknown): Promise<void>;
  export function writeAsStringAsync(uri: string, contents: string, options?: unknown): Promise<void>;
  export function readAsStringAsync(uri: string, options?: unknown): Promise<string>;
}


declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
  }
}

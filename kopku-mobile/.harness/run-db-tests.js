'use strict';
/**
 * Driver harness: menyediakan global Jest-compatible secukupnya untuk
 * MENJALANKAN berkas test lisensi tanpa node_modules.
 *
 * Ini BUKAN Jest. Hasilnya dilaporkan sebagai HARNESS-VERIFIED.
 */
require('./resolver-db');

const suites = [];

/**
 * POHON SUITE — hook BER-SCOPE per describe.
 *
 * Versi sebelumnya menyimpan beforeEach/afterEach dalam SATU array
 * per-berkas, sehingga hook milik `describe` A ikut berjalan untuk test
 * di `describe` B. Akibatnya fixture saling menimpa (hitungan menumpuk:
 * "expected 1, got 2") dan hook yang bergantung pada fixture milik
 * describe lain meledak dengan "Cannot read properties of undefined".
 * Itu KEGAGALAN RUNNER, bukan kegagalan kode yang diuji.
 *
 * Sekarang setiap describe punya simpul sendiri; sebuah test menjalankan
 * beforeEach seluruh leluhurnya dari LUAR ke DALAM, dan afterEach dari
 * DALAM ke LUAR — urutan yang sama dengan Jest.
 */
const akar = { nama: null, induk: null, beforeAll: [], afterAll: [], beforeEach: [], afterEach: [], sudahBeforeAll: false };
let simpulAktif = akar;

function rantai(simpul) {
  const hasil = [];
  for (let s = simpul; s; s = s.induk) hasil.unshift(s);
  return hasil;
}

global.describe = (nama, fn) => {
  const simpul = {
    nama,
    induk: simpulAktif,
    beforeAll: [],
    afterAll: [],
    beforeEach: [],
    afterEach: [],
    sudahBeforeAll: false,
  };
  const sebelumnya = simpulAktif;
  simpulAktif = simpul;
  fn();
  simpulAktif = sebelumnya;
};

const registerIt = (nama, fn) => {
  const simpul = simpulAktif;
  const label = rantai(simpul)
    .map((s) => s.nama)
    .filter(Boolean)
    .concat(nama)
    .join(' > ');
  suites.push({ name: label, fn, simpul });
};
global.it = registerIt;
global.test = registerIt;
global.it.each = (rows) => (nama, fn) => {
  for (const row of rows) {
    const args = Array.isArray(row) ? row : [row];
    registerIt(`${nama} [${args.join(', ')}]`, () => fn(...args));
  }
};
global.test.each = global.it.each;
global.beforeAll = (fn) => simpulAktif.beforeAll.push(fn);
global.afterAll = (fn) => simpulAktif.afterAll.push(fn);
global.beforeEach = (fn) => simpulAktif.beforeEach.push(fn);
global.afterEach = (fn) => simpulAktif.afterEach.push(fn);

// --- jest.fn / jest.spyOn -------------------------------------------------
function makeFn(implAwal) {
  const queue = [];
  let impl = typeof implAwal === 'function' ? implAwal : null;
  const fn = (...args) => {
    fn.mock.calls.push(args);
    if (queue.length > 0) {
      const next = queue.shift();
      return next.kind === 'resolve' ? Promise.resolve(next.value) : next.value();
    }
    if (impl) return impl(...args);
    return undefined;
  };
  fn.mock = { calls: [] };
  fn._isMock = true;
  fn.mockResolvedValueOnce = (v) => (queue.push({ kind: 'resolve', value: v }), fn);
  fn.mockImplementationOnce = (f) => (queue.push({ kind: 'impl', value: f }), fn);
  fn.mockImplementation = (f) => ((impl = f), fn);
  fn.mockReturnValue = (v) => ((impl = () => v), fn);
  fn.mockClear = () => ((fn.mock.calls = []), fn);
  fn.mockRestore = () => fn;
  return fn;
}

global.jest = {
  fn: (impl) => makeFn(impl),
  /**
   * harness: jest.mock TANPA hoisting.
   *
   * Babel milik Jest memindahkan jest.mock() ke ATAS require. Di sini
   * tidak ada Babel, jadi modul target sudah terlanjur di-require saat
   * factory dipanggil. Karena itu `@/database/db` versi harness adalah
   * PROXY yang mendelegasikan ke `globalThis.__HARNESS_DB_IMPL__` —
   * pendaftaran yang terlambat tetap terbaca oleh modul yang sudah
   * memegang referensinya.
   */
  mock(path, factory) {
    if (typeof factory !== 'function') return;
    if (/database\/db$/.test(path)) {
      globalThis.__HARNESS_DB_IMPL__ = factory();
      return;
    }
    /**
     * Mock modul lain DENGAN MUTASI IN-PLACE.
     *
     * Tanpa Babel, `jest.mock()` berjalan SETELAH modul target
     * di-require. Tetapi `tsc` meng-emit pemanggilan sebagai akses
     * properti pada objek namespace (`Mod_1.fungsi(...)`), bukan
     * binding yang disalin. Jadi mengganti ISI objek `exports` yang
     * SUDAH dipegang pemanggil sudah cukup — referensinya tetap sama,
     * isinya yang berubah.
     */
    const Module = require('module');
    let resolved;
    try {
      resolved = Module._resolveFilename(path, module, false);
    } catch {
      return; // modul tidak ada di graf harness — abaikan
    }
    const target = require(resolved);
    const pengganti = factory();
    for (const kunci of Object.keys(target)) {
      if (!(kunci in pengganti)) delete target[kunci];
    }
    Object.assign(target, pengganti);
  },
  /**
   * harness (RC-S67): jest.requireActual — modul ASLI. Untuk
   * `@/database/db` dikembalikan hasil emit asli (bukan proxy) supaya
   * factory yang men-spread modul aslinya tidak rekursif.
   */
  requireActual(path) {
    if (/database\/db$/.test(path)) return require('./build3/src/database/db.js');
    const Module = require('module');
    return require(Module._resolveFilename(path, module, false));
  },
  /**
   * harness (RC-S67): subset jam palsu Jest — HANYA tanggal sistem
   * (`new Date()` tanpa argumen & `Date.now()`), bukan antrean timer.
   */
  useFakeTimers() {
    if (!globalThis.__HARNESS_REAL_DATE__) globalThis.__HARNESS_REAL_DATE__ = Date;
    return global.jest;
  },
  setSystemTime(waktu) {
    const Asli = globalThis.__HARNESS_REAL_DATE__ || Date;
    globalThis.__HARNESS_REAL_DATE__ = Asli;
    const tetap = new Asli(waktu instanceof Asli ? waktu.getTime() : waktu).getTime();
    class DatePalsu extends Asli {
      constructor(...args) { if (args.length === 0) super(tetap); else super(...args); }
      static now() { return tetap; }
    }
    global.Date = DatePalsu;
  },
  useRealTimers() {
    if (globalThis.__HARNESS_REAL_DATE__) global.Date = globalThis.__HARNESS_REAL_DATE__;
    return global.jest;
  },
  setTimeout() {
    // Jest memakai ini untuk batas waktu per-test. Runner harness tidak
    // memberlakukan batas waktu, jadi panggilannya diterima tanpa efek —
    // bukan diabaikan diam-diam, melainkan memang tidak berlaku di sini.
  },
  spyOn(object, key) {
    const original = object[key];
    const spy = makeFn();
    spy.mockRestore = () => {
      object[key] = original;
      return spy;
    };
    object[key] = spy;
    return spy;
  },
};

// --- expect ---------------------------------------------------------------
/**
 * Cocokkan error dengan ekspektasi ala Jest.
 *
 * Yang sebelumnya HILANG: `toThrow(KelasError)`. Jest memeriksa
 * `instanceof`; versi lama menstringkan kelasnya lalu mencari teks itu
 * di dalam pesan — yang tidak pernah cocok. Akibatnya setiap test
 * `rejects.toThrow(MissingAccountMappingError)` dan
 * `rejects.toThrow(ClosedPeriodError)` dilaporkan GAGAL padahal
 * produksi melempar error yang PERSIS BENAR.
 */
function periksaError(error, expected) {
  if (expected === undefined) return;
  const pesan = String((error && error.message) ?? error);
  if (typeof expected === 'function') {
    if (error instanceof expected) return;
    // Fallback: kelas yang sama tetapi berbeda realm/instance modul.
    if (error && error.constructor && error.constructor.name === expected.name) return;
    throw new Error(`error bukan ${expected.name}: ${pesan}`);
  }
  const cocok = expected instanceof RegExp ? expected.test(pesan) : pesan.includes(String(expected));
  if (!cocok) throw new Error(`pesan error tidak cocok: ${pesan}`);
}

function cocokSebagian(actual, expected) {
  if (expected && typeof expected === 'object' && typeof expected.__asym === 'string') return asymCocok(expected, actual);
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((v, i) => cocokSebagian(actual[i], v));
  }
  return Object.keys(expected).every((k) => cocokSebagian(actual[k], expected[k]));
}

function fmt(v) {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}


/* RC-S69 — matcher tambahan (infrastruktur harness). */
function isAsym(v){ return v && typeof v === 'object' && typeof v.__asym === 'string'; }
function asymCocok(m, actual){
  switch(m.__asym){
    case 'any': {
      const c = m.arg;
      if (c === String) return typeof actual === 'string';
      if (c === Number) return typeof actual === 'number';
      if (c === Boolean) return typeof actual === 'boolean';
      if (c === Object) return actual !== null && typeof actual === 'object';
      if (c === Array) return Array.isArray(actual);
      if (c === Function) return typeof actual === 'function';
      return actual instanceof c;
    }
    case 'anything': return actual !== null && actual !== undefined;
    case 'stringContaining': return typeof actual === 'string' && actual.includes(m.arg);
    case 'stringMatching': return typeof actual === 'string' && (typeof m.arg === 'string' ? actual.includes(m.arg) : m.arg.test(actual));
    case 'objectContaining': return cocokDalam(actual, m.arg);
    case 'arrayContaining': return Array.isArray(actual) && m.arg.every(function(e){ return actual.some(function(a){ return setaraDalam(a, e); }); });
    default: return false;
  }
}
function setaraDalam(actual, expected){
  if (isAsym(expected)) return asymCocok(expected, actual);
  if (expected && typeof expected === 'object'){
    if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every(function(e,i){ return setaraDalam(actual[i], e); });
    if (actual === null || typeof actual !== 'object') return false;
    return cocokDalam(actual, expected) && Object.keys(actual).length === Object.keys(expected).length;
  }
  return Object.is(actual, expected);
}
function cocokDalam(actual, expected){
  if (actual === null || typeof actual !== 'object') return false;
  return Object.keys(expected).every(function(k){ return setaraDalam(actual[k], expected[k]); });
}

global.expect = function expectFn(actual) {
  const base = {
    toBe(expected) {
      if (!Object.is(actual, expected)) throw new Error(`expected ${fmt(expected)}, got ${fmt(actual)}`);
    },
    toEqual(expected) {
      if (!setaraDalam(actual, expected) && JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`expected ${fmt(expected)}, got ${fmt(actual)}`);
      }
    },
    toBeDefined() {
      if (actual === undefined) throw new Error('expected defined');
    },
    toBeUndefined() {
      if (actual !== undefined) throw new Error(`expected undefined, got ${fmt(actual)}`);
    },
    toBeNull() {
      if (actual !== null) throw new Error(`expected null, got ${fmt(actual)}`);
    },
    toBeGreaterThan(n) {
      if (!(actual > n)) throw new Error(`expected > ${n}, got ${fmt(actual)}`);
    },
    toMatch(re) {
      const r = re instanceof RegExp ? re : new RegExp(re);
      if (!r.test(String(actual))) throw new Error(`expected to match ${r}`);
    },
    toContain(sub) {
      if (Array.isArray(actual)) {
        if (!actual.some((a) => setaraDalam(a, sub))) throw new Error(`expected array to contain ${fmt(sub)}`);
        return;
      }
      if (!String(actual).includes(sub)) throw new Error(`expected to contain ${fmt(sub)}`);
    },
    toHaveBeenCalled() {
      if (actual.mock.calls.length === 0) throw new Error('expected mock to have been called');
    },
    toHaveProperty(jalur, nilai) {
      const bagian = String(jalur).split('.');
      let kursor = actual;
      for (const b of bagian) {
        if (kursor == null || !(b in kursor)) throw new Error(`properti '${jalur}' tidak ada`);
        kursor = kursor[b];
      }
      if (nilai !== undefined && !Object.is(kursor, nilai)) {
        throw new Error(`properti '${jalur}': expected ${fmt(nilai)}, got ${fmt(kursor)}`);
      }
    },
    toHaveBeenCalledTimes(n) {
      if (actual.mock.calls.length !== n) {
        throw new Error(`expected ${n} call(s), got ${actual.mock.calls.length}`);
      }
    },
    toHaveLength(n) {
      if (actual == null || actual.length !== n) {
        throw new Error(`expected length ${n}, got ${actual && actual.length}`);
      }
    },
    toBeTruthy() {
      if (!actual) throw new Error(`expected truthy, got ${fmt(actual)}`);
    },
    toBeFalsy() {
      if (actual) throw new Error(`expected falsy, got ${fmt(actual)}`);
    },
    toBeLessThan(n) {
      if (!(actual < n)) throw new Error(`expected < ${n}, got ${fmt(actual)}`);
    },
    toBeGreaterThanOrEqual(n) {
      if (!(actual >= n)) throw new Error(`expected >= ${n}, got ${fmt(actual)}`);
    },
    toBeLessThanOrEqual(n) {
      if (!(actual <= n)) throw new Error(`expected <= ${n}, got ${fmt(actual)}`);
    },
    toBeInstanceOf(kelas) {
      if (!(actual instanceof kelas)) {
        const nama = actual && actual.constructor ? actual.constructor.name : typeof actual;
        // Fallback realm/instance modul, sama seperti periksaError().
        if (nama === kelas.name) return;
        throw new Error(`expected instance of ${kelas.name}, got ${nama}`);
      }
    },
    toBeNaN() {
      if (!Number.isNaN(actual)) throw new Error(`expected NaN, got ${fmt(actual)}`);
    },
    rejects: {
      async toThrow(expected) {
        try {
          await (typeof actual === 'function' ? actual() : actual);
        } catch (error) {
          periksaError(error, expected);
          return;
        }
        throw new Error('expected promise to reject, but it resolved');
      },
    },
    resolves: {
      async toBe(expected) {
        const nilai = await (typeof actual === 'function' ? actual() : actual);
        if (!Object.is(nilai, expected)) throw new Error(`expected ${fmt(expected)}, got ${fmt(nilai)}`);
      },
      async toHaveProperty(jalur, nilai) {
        const hasil = await (typeof actual === 'function' ? actual() : actual);
        return expectFn(hasil).toHaveProperty(jalur, nilai);
      },
      async toEqual(expected) {
        const hasil = await (typeof actual === 'function' ? actual() : actual);
        return expectFn(hasil).toEqual(expected);
      },
      async toBeDefined() {
        const hasil = await (typeof actual === 'function' ? actual() : actual);
        return expectFn(hasil).toBeDefined();
      },
      async toMatchObject(expected) {
        const hasil = await (typeof actual === 'function' ? actual() : actual);
        return expectFn(hasil).toMatchObject(expected);
      },
    },
    toThrow(expected) {
      try {
        actual();
      } catch (error) {
        periksaError(error, expected);
        return;
      }
      throw new Error('expected to throw, but did not');
    },
    toMatchObject(expected) {
      if (!cocokSebagian(actual, expected)) {
        throw new Error(`objek tidak cocok: ${fmt(actual)}`);
      }
    },
    toBeCloseTo(expected, digits = 2) {
      if (Math.abs(actual - expected) >= Math.pow(10, -digits) / 2) {
        throw new Error(`expected ~${expected}, got ${fmt(actual)}`);
      }
    },
    not: {
      toThrow() {
        actual();
      },
      toBe(expected) {
        if (Object.is(actual, expected)) throw new Error(`expected NOT ${fmt(expected)}`);
      },
      toMatch(re) {
        const r = re instanceof RegExp ? re : new RegExp(re);
        if (r.test(String(actual))) throw new Error(`expected NOT to match ${r}`);
      },
      toContain(sub) {
        if (String(actual).includes(sub)) throw new Error(`expected NOT to contain ${fmt(sub)}`);
      },
      toBeUndefined() {
        if (actual === undefined) throw new Error('expected NOT undefined');
      },
      toHaveLength(n) {
        if (actual != null && actual.length === n) throw new Error(`expected NOT length ${n}`);
      },
      toEqual(expected) {
        if (JSON.stringify(actual) === JSON.stringify(expected)) {
          throw new Error(`expected NOT ${fmt(expected)}`);
        }
      },
      toBeNull() {
        if (actual === null) throw new Error('expected NOT null');
      },
      toBeInstanceOf(kelas) {
        if (actual instanceof kelas) throw new Error(`expected NOT instance of ${kelas.name}`);
      },
      toBeNaN() {
        if (Number.isNaN(actual)) throw new Error('expected NOT NaN');
      },
      toBeCloseTo(expected, digits = 2) {
        if (Math.abs(actual - expected) < Math.pow(10, -digits) / 2) {
          throw new Error(`expected NOT ~${expected}, got ${fmt(actual)}`);
        }
      },
      toMatchObject(expected) {
        if (cocokSebagian(actual, expected)) throw new Error('objek TIDAK boleh cocok');
      },
      toHaveBeenCalled() {
        if (actual.mock.calls.length > 0) {
          throw new Error(`expected NOT called, got ${actual.mock.calls.length} call(s)`);
        }
      },
    },
  };
  base.toContainEqual = function (expected) {
    if (!Array.isArray(actual) || !actual.some(function (a) { return setaraDalam(a, expected); })) {
      throw new Error('expected array to contain equal ' + fmt(expected));
    }
  };
  base.resolves.toBeUndefined = async function () {
    const h = await (typeof actual === 'function' ? actual() : actual);
    if (h !== undefined) throw new Error('expected undefined, got ' + fmt(h));
  };
  base.resolves.toBeNull = async function () {
    const h = await (typeof actual === 'function' ? actual() : actual);
    if (h !== null) throw new Error('expected null, got ' + fmt(h));
  };
  base.resolves.toBeTruthy = async function () {
    const h = await (typeof actual === 'function' ? actual() : actual);
    if (!h) throw new Error('expected truthy');
  };
  base.rejects.toMatchObject = async function (expected) {
    try { await (typeof actual === 'function' ? actual() : actual); }
    catch (e) { return expectFn(e).toMatchObject(expected); }
    throw new Error('expected promise to reject, but it resolved');
  };
  base.rejects.toBeInstanceOf = async function (kelas) {
    try { await (typeof actual === 'function' ? actual() : actual); }
    catch (e) { if (!(e instanceof kelas)) throw new Error('expected instance of ' + kelas.name + ', got ' + (e && e.constructor && e.constructor.name)); return; }
    throw new Error('expected promise to reject, but it resolved');
  };
  base.resolves.not = {
    async toThrow() { await (typeof actual === 'function' ? actual() : actual); },
    async toBe(expected) { const h = await (typeof actual === 'function' ? actual() : actual); if (Object.is(h, expected)) throw new Error('expected not ' + fmt(expected)); },
  };
  return base;
};
global.expect.any = function (c) { return { __asym: 'any', arg: c }; };
global.expect.anything = function () { return { __asym: 'anything' }; };
global.expect.stringContaining = function (x) { return { __asym: 'stringContaining', arg: x }; };
global.expect.stringMatching = function (x) { return { __asym: 'stringMatching', arg: x }; };
global.expect.objectContaining = function (x) { return { __asym: 'objectContaining', arg: x }; };
global.expect.arrayContaining = function (x) { return { __asym: 'arrayContaining', arg: x }; };


async function main() {
  const target = process.argv[2];
  require(target);

  let pass = 0;
  const failures = [];
  const selesaiBeforeAll = new Set();

  for (const t of suites) {
    const leluhur = rantai(t.simpul);
    try {
      for (const s of leluhur) {
        if (!selesaiBeforeAll.has(s)) {
          selesaiBeforeAll.add(s);
          for (const fn of s.beforeAll) await fn();
        }
      }
      for (const s of leluhur) for (const fn of s.beforeEach) await fn();
      await t.fn();
      for (const s of [...leluhur].reverse()) for (const fn of s.afterEach) await fn();
      pass += 1;
      console.log(`  PASS  ${t.name}`);
    } catch (error) {
      for (const s of [...leluhur].reverse()) {
        for (const fn of s.afterEach) {
          try {
            await fn();
          } catch {
            /* abaikan */
          }
        }
      }
      failures.push(t.name);
      console.log(`  FAIL  ${t.name}\n        ${error && error.message}`);
    }
  }

  for (const s of selesaiBeforeAll) for (const fn of s.afterAll) await fn();

  console.log(`\n${pass}/${suites.length} lolos`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

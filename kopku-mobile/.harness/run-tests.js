#!/usr/bin/env node
/**
 * MINI-RUNNER KOMPATIBEL JEST — HANYA UNTUK VERIFIKASI OFFLINE.
 * ===========================================================================
 *
 * `node_modules` tidak ada di arsip dan registry npm terblokir, jadi
 * `npm test` (Jest asli) TIDAK dapat dijalankan di lingkungan ini.
 * Runner ini menyediakan permukaan API Jest seperlunya agar berkas test
 * lisensi bisa dieksekusi apa adanya — TANPA mengubah satu baris pun di
 * berkas test-nya.
 *
 * PERBEDAAN YANG HARUS DIINGAT (jangan diklaim setara dengan Jest):
 *   - hasilnya adalah HARNESS-VERIFIED, bukan JEST-VERIFIED;
 *   - `jest.mock()` tidak diimplementasikan (test lisensi tidak
 *     memakainya — pemetaan modul dilakukan lewat `paths` tsconfig,
 *     sama seperti `moduleNameMapper` di jest.config.js);
 *   - matcher hanya yang benar-benar dipakai;
 *   - tiap berkas dijalankan di PROSES TERPISAH, supaya state modul
 *     (cache device ID, SecureStore tiruan) tidak bocor antar-suite.
 *
 * Cara pakai:
 *   node .harness/run-tests.js            # semua suite
 *   node .harness/run-tests.js <berkas>   # satu suite (mode anak)
 */

const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const OUT_SRC = path.join(__dirname, 'out', 'src');
const OUT_DIR = path.join(OUT_SRC, '__tests__');

/**
 * Padanan `moduleNameMapper` milik Jest.
 *
 * `tsc` menyalin specifier `@/...` apa adanya ke dalam JS hasil emit —
 * ia memetakan tipe, bukan runtime. Tanpa hook ini setiap suite mati
 * saat import dengan MODULE_NOT_FOUND, dan itu terlihat seperti "test
 * gagal" padahal tidak ada satu pun assertion yang sempat berjalan.
 *
 * Pemetaannya HARUS mencerminkan `moduleNameMapper` di jest.config.js;
 * kalau keduanya berbeda, harness dan Jest akan menguji dua hal yang
 * tidak sama.
 */
const MODULE_MAP = {
  'expo-crypto': path.join(OUT_SRC, 'test-utils', 'expoCryptoMock.js'),
  'expo-secure-store': path.join(OUT_SRC, 'test-utils', 'expoSecureStoreMock.js'),
  '@noble/ed25519': path.join(OUT_SRC, 'test-utils', 'nobleEd25519Mock.js'),
  '@noble/hashes/sha512': path.join(OUT_SRC, 'test-utils', 'nobleSha512Mock.js'),
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function patchedResolve(request, ...rest) {
  if (MODULE_MAP[request]) {
    return originalResolve.call(this, MODULE_MAP[request], ...rest);
  }
  if (request.startsWith('@/')) {
    return originalResolve.call(this, path.join(OUT_SRC, request.slice(2)), ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};
const SUITES = [
  'KebijakanDiniLifecycle.test.js',
  'KebijakanDiniNull.test.js',
  'KebijakanDiniUi.test.js',
  'EarlyWithdrawalUi.test.js',
  'HistoriBerjangkaUtuh.test.js',
  'SetorBerjangka.test.js',
  'RuteTerjangkau.test.js',
  'SafeAreaHeader.test.js',
  'SourceSanity.test.js',
  'SimpananUiRcS41.test.js',
  'IdentitasCompletion.test.js',
  'AkuntansiSakEp.test.js',
  'SetupLicenseFlow.test.js',
  'ServerTokenCompat.test.js',
  'LicenseBuildConfig.test.js',
  'LicenseCrypto.test.js',
  'LicenseToken.test.js',
  'LicenseClock.test.js',
  'LicenseService.test.js',
  'LicenseRenewalRcS52.test.js',
  'LicenseRouteProtection.test.js',
];

// ===========================================================================
// Implementasi matcher
// ===========================================================================

function stringify(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  // `undefined` eksplisit diperlakukan sama dengan tidak ada, meniru
  // perilaku toEqual milik Jest.
  const meaningful = (obj, keys) => keys.filter((k) => obj[k] !== undefined);
  const ka = meaningful(a, keysA).sort();
  const kb = meaningful(b, keysB).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return false;
    if (!deepEqual(a[ka[i]], b[kb[i]])) return false;
  }
  return true;
}

function fail(message) {
  throw new Error(message);
}

function buildMatchers(actual, negated) {
  const check = (pass, message) => {
    if (negated ? pass : !pass) {
      fail(negated ? `TIDAK diharapkan: ${message}` : message);
    }
  };

  const matchers = {
    toBe(expected) {
      check(Object.is(actual, expected), `diharapkan ${stringify(expected)}, dapat ${stringify(actual)}`);
    },
    toEqual(expected) {
      check(deepEqual(actual, expected), `diharapkan ${stringify(expected)}, dapat ${stringify(actual)}`);
    },
    toBeNull() {
      check(actual === null, `diharapkan null, dapat ${stringify(actual)}`);
    },
    toBeUndefined() {
      check(actual === undefined, `diharapkan undefined, dapat ${stringify(actual)}`);
    },
    toBeDefined() {
      check(actual !== undefined, `diharapkan terdefinisi, dapat undefined`);
    },
    toBeGreaterThan(expected) {
      check(actual > expected, `diharapkan > ${expected}, dapat ${stringify(actual)}`);
    },
    toBeLessThan(expected) {
      check(actual < expected, `diharapkan < ${expected}, dapat ${stringify(actual)}`);
    },
    toThrow(expected) {
      let melempar = false;
      let pesan = '';
      try { actual(); } catch (e) { melempar = true; pesan = e && e.message ? e.message : String(e); }
      if (expected) {
        const rx = expected instanceof RegExp ? expected : new RegExp(expected);
        check(melempar && rx.test(pesan), `diharapkan melempar cocok ${rx}, dapat ${melempar ? pesan : 'tidak melempar'}`);
      } else {
        check(melempar, 'diharapkan melempar, tetapi tidak');
      }
    },
    toHaveLength(expected) {
      const length = actual == null ? undefined : actual.length;
      check(length === expected, `diharapkan panjang ${expected}, dapat ${stringify(length)}`);
    },
    toContain(expected) {
      const pass = actual != null && typeof actual.includes === 'function' && actual.includes(expected);
      check(pass, `diharapkan memuat ${stringify(expected)} di ${stringify(actual)}`);
    },
    toMatch(expected) {
      const regex = expected instanceof RegExp ? expected : new RegExp(expected);
      check(regex.test(String(actual)), `diharapkan cocok ${regex}, dapat ${stringify(actual)}`);
    },
    toHaveBeenCalled() {
      check(actual.mock.calls.length > 0, 'diharapkan mock dipanggil');
    },
    toHaveBeenCalledTimes(count) {
      check(
        actual.mock.calls.length === count,
        `diharapkan dipanggil ${count}x, dapat ${actual.mock.calls.length}x`
      );
    },
  };

  if (!negated) {
    Object.defineProperty(matchers, 'not', { get: () => buildMatchers(actual, true) });
  }
  return matchers;
}

// ===========================================================================
// Mock & spy
// ===========================================================================

function createMockFn() {
  const queue = [];
  let persistent = null;
  const fn = (...args) => {
    fn.mock.calls.push(args);
    const next = queue.shift();
    if (next) return next(...args);
    if (persistent) return persistent(...args);
    return undefined;
  };
  fn.mock = { calls: [] };
  fn.mockResolvedValueOnce = (value) => {
    queue.push(() => Promise.resolve(value));
    return fn;
  };
  fn.mockImplementationOnce = (impl) => {
    queue.push(impl);
    return fn;
  };
  fn.mockImplementation = (impl) => {
    persistent = impl;
    return fn;
  };
  fn.mockReturnValue = (value) => {
    persistent = () => value;
    return fn;
  };
  fn.mockClear = () => {
    fn.mock.calls.length = 0;
  };
  return fn;
}

function createSpy(object, method) {
  const original = object[method];
  let impl = original;
  const spy = (...args) => impl.apply(object, args);
  spy.mockReturnValue = (value) => {
    impl = () => value;
    return spy;
  };
  spy.mockRestore = () => {
    object[method] = original;
  };
  object[method] = spy;
  return spy;
}

// ===========================================================================
// Eksekusi satu berkas suite
// ===========================================================================

async function runSuiteFile(file) {
  const rootHooks = { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] };
  const stack = [{ name: '', hooks: rootHooks }];
  const tests = [];

  global.describe = (name, body) => {
    const parent = stack[stack.length - 1];
    const node = {
      name: parent.name ? `${parent.name} > ${name}` : name,
      hooks: { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] },
      parent,
    };
    stack.push(node);
    body();
    stack.pop();
  };

  const register = (name, body) => {
    const parent = stack[stack.length - 1];
    tests.push({ name: parent.name ? `${parent.name} > ${name}` : name, body, node: parent });
  };

  global.it = register;
  global.test = register;
  global.it.each = (cases) => (name, body) => {
    for (const args of cases) {
      const list = Array.isArray(args) ? args : [args];
      let index = 0;
      const rendered = name.replace(/%[sdifj]/g, () => String(list[index++]));
      register(rendered, () => body(...list));
    }
  };

  for (const hook of ['beforeAll', 'afterAll', 'beforeEach', 'afterEach']) {
    global[hook] = (fn) => stack[stack.length - 1].hooks[hook].push(fn);
  }

  global.expect = (actual) => buildMatchers(actual, false);
  global.jest = { fn: createMockFn, spyOn: createSpy };

  require(path.join(OUT_DIR, file));

  const chainOf = (node) => {
    const chain = [];
    for (let current = node; current; current = current.parent) chain.unshift(current);
    return chain;
  };

  const allNodes = new Set();
  for (const test of tests) for (const node of chainOf(test.node)) allNodes.add(node);
  for (const node of allNodes) for (const fn of node.hooks.beforeAll) await fn();

  let passed = 0;
  const failures = [];

  for (const test of tests) {
    const chain = chainOf(test.node);
    try {
      for (const node of chain) for (const fn of node.hooks.beforeEach) await fn();
      await test.body();
      for (const node of [...chain].reverse()) for (const fn of node.hooks.afterEach) await fn();
      passed += 1;
    } catch (error) {
      failures.push({ name: test.name, message: error && error.message ? error.message : String(error) });
      try {
        for (const node of [...chain].reverse()) for (const fn of node.hooks.afterEach) await fn();
      } catch {
        // Kegagalan afterEach setelah test yang sudah gagal tidak
        // menambah informasi; jangan sampai ia menutupi error aslinya.
      }
    }
  }

  for (const node of allNodes) for (const fn of node.hooks.afterAll) await fn();

  return { total: tests.length, passed, failures };
}

// ===========================================================================
// Entry point
// ===========================================================================

async function main() {
  const target = process.argv[2];

  if (target) {
    const result = await runSuiteFile(target);
    process.stdout.write(`__RESULT__${JSON.stringify(result)}\n`);
    process.exit(result.failures.length > 0 ? 1 : 0);
  }

  let totalTests = 0;
  let totalPassed = 0;
  const allFailures = [];

  for (const suite of SUITES) {
    // Proses terpisah per berkas: state modul (cache device ID,
    // SecureStore tiruan, env public key) TIDAK boleh bocor antar-suite.
    const child = spawnSync(process.execPath, [__filename, suite], { encoding: 'utf8' });
    const line = (child.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));

    if (!line) {
      console.log(`\n\u2716 ${suite} — GAGAL DIMUAT`);
      console.log((child.stderr || child.stdout || '(tanpa output)').trim().split('\n').slice(0, 20).join('\n'));
      allFailures.push({ name: `${suite} (gagal dimuat)`, message: 'suite tidak dapat dijalankan' });
      continue;
    }

    const result = JSON.parse(line.slice('__RESULT__'.length));
    totalTests += result.total;
    totalPassed += result.passed;
    const mark = result.failures.length === 0 ? '\u2713' : '\u2716';
    console.log(`${mark} ${suite}  ${result.passed}/${result.total}`);
    for (const failure of result.failures) {
      console.log(`    \u2716 ${failure.name}`);
      console.log(`      ${failure.message}`);
      allFailures.push(failure);
    }
  }

  console.log('\n' + '='.repeat(64));
  console.log(`Suite : ${SUITES.length}`);
  console.log(`Test  : ${totalPassed}/${totalTests} lulus`);
  console.log(`Gagal : ${allFailures.length}`);
  console.log('='.repeat(64));
  process.exit(allFailures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

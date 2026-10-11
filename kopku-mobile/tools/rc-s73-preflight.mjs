#!/usr/bin/env node
// RC-S73.1.3 §5 — AUTOMATED PRE-DEVICE CHECK (bukti OTOMATIS & STATIS saja).
//
//   node tools/rc-s73-preflight.mjs                 # semua langkah
//   node tools/rc-s73-preflight.mjs --step <nama>   # satu langkah
//   node tools/rc-s73-preflight.mjs --step jest --shard 3/8
//   node tools/rc-s73-preflight.mjs --step jest-aggregate --shards 8
//   node tools/rc-s73-preflight.mjs --summary
//
// Langkah: install, tooling, typescript, jest, rc-s71, bundle, package-config, schema,
//          no-migration, no-accrual-menu, one-writer
// Tanpa sesi aktif, pre-flight MEMBUAT sesi baru. Lingkungan (adb/SDK/EAS/perangkat)
// dinyatakan TERPISAH: ENVIRONMENT BLOCKED bukan kegagalan pre-flight software.
// Timeout langkah verifikasi = FAIL (verifikasi tidak selesai). Executable
// tidak ada = BLOCKED. PRE-FLIGHT SOFTWARE = PASS hanya bila SEMUA langkah PASS.
// STATIC/AUTOMATED PASS ≠ RUNTIME/DEVICE PASS.
// Exit: 0 PASS · 1 ada FAIL · 2 belum lengkap / BLOCKED.
import { existsSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  S, EXIT, TIMEOUT, ROOT, OUT_DIR, PACKAGE_ID, EXPECTED_SCHEMA, EXPECTED_SUITES, EXPECTED_TESTS, EXPECTED_RC_S71,
  run, classify, readComponent, writeComponent, outPath, stripComments, line, readRun, newRun,
} from './rc-s73-lib.mjs';

const STEPS = ['install', 'tooling', 'typescript', 'jest', 'rc-s71', 'bundle', 'package-config', 'schema', 'no-migration', 'no-accrual-menu', 'one-writer'];
const LABEL = {
  install: 'npm install', tooling: 'tooling self-test (framework)', typescript: 'TypeScript', jest: 'Jest', 'rc-s71': 'RC-S71 gate', bundle: 'Expo bundle',
  'package-config': 'package configuration', schema: `schema version ${EXPECTED_SCHEMA}`, 'no-migration': 'no migration added',
  'no-accrual-menu': 'no accrual menu', 'one-writer': 'one accrual writer',
};
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const baca = (p) => readFileSync(join(ROOT, p), 'utf8');
const ringkasGagal = (r) => `${r.state}${r.code != null ? ' exit ' + r.code : ''}: ${(r.stderr || String(r.stdout)).split('\n').filter(Boolean).slice(-3).join(' | ')}`;

function srcFiles(dirs) {
  const out = [];
  const walk = (d) => { if (!existsSync(d)) return; for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (!['__tests__', 'test-utils', 'node_modules'].includes(n)) walk(p); } else if (/\.(ts|tsx)$/.test(n)) out.push(p); } };
  dirs.forEach((d) => walk(join(ROOT, d)));
  return out;
}
function jestJson(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  let rcS71 = null;
  for (const r of j.testResults) if (r.name.endsWith('ReleaseGateAkrualBungaUtangRcS71_1.test.ts')) rcS71 = { passed: r.assertionResults.filter((a) => a.status === 'passed').length, total: r.assertionResults.length };
  return { suites: j.numTotalTestSuites, suitesFailed: j.numFailedTestSuites, tests: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests, skipped: j.numPendingTests + (j.numTodoTests ?? 0), rcS71 };
}
function focusCounts() {
  let only = 0, skip = 0;
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p); } else if (/\.(ts|tsx|js)$/.test(n)) { const s = stripComments(readFileSync(p, 'utf8')); only += (s.match(/\b(it|test|describe)\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(/g) ?? []).length; skip += (s.match(/\b(it|test|describe)\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\bxtest\s*\(/g) ?? []).length; } } };
  walk(join(ROOT, 'src'));
  return { only, skip };
}
function nilaiJest(a) {
  const f = focusCounts();
  const ok = a.suites === EXPECTED_SUITES && a.suitesFailed === 0 && a.tests === EXPECTED_TESTS && a.failed === 0 && a.skipped === 0 && f.only === 0 && f.skip === 0;
  return { status: ok ? S.PASS : S.FAIL, detail: `suites ${a.suites - a.suitesFailed}/${a.suites} · tests ${a.passed}/${a.tests} · failed ${a.failed} · skipped ${a.skipped} · .only ${f.only} · .skip ${f.skip} (harapan ${EXPECTED_SUITES}/${EXPECTED_TESTS})` };
}

const LANGKAH = {
  async install() { const r = await run('npm', ['ci', '--no-audit', '--no-fund'], { timeout: TIMEOUT.npmCi }); return { status: classify(r, { timeoutAs: S.FAIL }), detail: r.state === 'OK' ? 'npm ci sukses' : ringkasGagal(r) }; },
  async tooling() {
    // Self-test default = framework saja (tanpa lingkungan nyata); hasil dicatat ke sesi.
    const r = await run(process.execPath, [join(ROOT, 'tools', 'rc-s73-selftest.mjs'), '--record'], { timeout: TIMEOUT.selftest });
    const m = String(r.stdout).match(/SELF-TEST STATUS = (PASS|FAIL)\s+\((\d+)\/(\d+)\)/);
    return { status: classify(r, { timeoutAs: S.FAIL }), detail: m ? `${m[1]} ${m[2]}/${m[3]}` : `${r.state}${r.code != null ? ' exit ' + r.code : ''}` };
  },
  async typescript() {
    const r = await run('npx', ['tsc', '--noEmit'], { timeout: TIMEOUT.tsc });
    const n = (String(r.stdout).match(/error TS/g) ?? []).length;
    return { status: classify(r, { timeoutAs: S.FAIL }), detail: r.state === 'OK' ? 'EXIT 0' : `${r.state}${r.code != null ? ' EXIT ' + r.code : ''}${n ? ` · ${n} error` : ''}` };
  },
  async jest() {
    const shard = arg('--shard');
    if (shard) {
      const [i, n] = shard.split('/').map(Number);
      const file = outPath(`jest-shard-${i}-of-${n}.json`);
      rmSync(file, { force: true });
      const r = await run('npx', ['jest', '--runInBand', `--shard=${i}/${n}`, '--json', `--outputFile=${file}`], { timeout: TIMEOUT.jestShard });
      if (!existsSync(file)) return { partial: true, status: classify(r, { timeoutAs: S.FAIL }) === S.BLOCKED ? S.BLOCKED : S.FAIL, detail: `shard ${i}/${n} tanpa JSON (${r.state})` };
      const a = jestJson(file);
      return { partial: true, status: a.failed === 0 && a.suitesFailed === 0 ? S.PASS : S.FAIL, detail: `shard ${i}/${n}: ${a.passed}/${a.tests}` };
    }
    const file = outPath('jest-full.json');
    rmSync(file, { force: true });
    const r = await run('npx', ['jest', '--runInBand', '--json', `--outputFile=${file}`], { timeout: TIMEOUT.jestFull });
    if (!existsSync(file)) return { status: classify(r, { timeoutAs: S.FAIL }) === S.BLOCKED ? S.BLOCKED : S.FAIL, detail: `jest tanpa JSON (${r.state})` };
    return nilaiJest(jestJson(file));
  },
  async 'jest-aggregate'() {
    const n = Number(arg('--shards'));
    if (!n) throw new Error('--shards N wajib');
    const agg = { suites: 0, suitesFailed: 0, tests: 0, passed: 0, failed: 0, skipped: 0 };
    for (let i = 1; i <= n; i++) {
      const f = join(OUT_DIR(), `jest-shard-${i}-of-${n}.json`);
      if (!existsSync(f)) return { as: 'jest', status: S.NOT_RUN, detail: `shard ${i}/${n} belum dijalankan dalam sesi ini` };
      const a = jestJson(f);
      for (const k of Object.keys(agg)) agg[k] += a[k];
    }
    return { as: 'jest', ...nilaiJest(agg) };
  },
  async 'rc-s71'() {
    const file = outPath('jest-rc-s71.json');
    rmSync(file, { force: true });
    const r = await run('npx', ['jest', '--runInBand', 'ReleaseGateAkrualBungaUtangRcS71_1', '--json', `--outputFile=${file}`], { timeout: TIMEOUT.jestGate });
    if (!existsSync(file)) return { status: classify(r, { timeoutAs: S.FAIL }) === S.BLOCKED ? S.BLOCKED : S.FAIL, detail: `tanpa JSON (${r.state})` };
    const g = jestJson(file).rcS71 ?? { passed: 0, total: 0 };
    return { status: g.passed === EXPECTED_RC_S71 && g.total === EXPECTED_RC_S71 ? S.PASS : S.FAIL, detail: `${g.passed}/${g.total} (harapan ${EXPECTED_RC_S71}/${EXPECTED_RC_S71})` };
  },
  async bundle() {
    const dir = outPath('expo-export');
    rmSync(dir, { recursive: true, force: true });
    const r = await run('npx', ['expo', 'export', '--platform', 'android', '--output-dir', dir], { timeout: TIMEOUT.expoExport, env: { EXPO_OFFLINE: '1', NODE_ENV: 'production' } });
    const hbc = existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.hbc')).map((f) => join(dir, f)) : [];
    if (r.state !== 'OK' || !hbc.length) return { status: r.state === 'MISSING' ? S.BLOCKED : S.FAIL, detail: `expo export ${r.state}; .hbc ${hbc.length}` };
    const magic = readFileSync(hbc[0]).subarray(0, 4).toString('hex');
    const errs = `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => /Unable to resolve|SyntaxError|Error:/.test(l));
    return { status: magic === 'c61fbc03' && !errs.length ? S.PASS : S.FAIL, detail: `Hermes ${magic === 'c61fbc03' ? 'OK' : 'magic ' + magic} · ${(statSync(hbc[0]).size / 1e6).toFixed(1)} MB · error ${errs.length}` };
  },
  async 'package-config'() {
    const eas = JSON.parse(baca('eas.json')); const app = JSON.parse(baca('app.json')).expo;
    const cek = [['preview = APK', eas.build?.preview?.android?.buildType === 'apk'], ['production = AAB', eas.build?.production?.android?.buildType === 'app-bundle'], [`package ${PACKAGE_ID}`, app?.android?.package === PACKAGE_ID]];
    const gagal = cek.filter(([, ok]) => !ok).map(([n]) => n);
    return { status: gagal.length ? S.FAIL : S.PASS, detail: gagal.length ? 'gagal: ' + gagal.join(', ') : cek.map(([n]) => n).join(' · ') };
  },
  async schema() { const m = baca('src/database/schema.ts').match(/export const SCHEMA_VERSION = (\d+);/); const v = m ? Number(m[1]) : null; return { status: v === EXPECTED_SCHEMA ? S.PASS : S.FAIL, detail: `SCHEMA_VERSION = ${v}` }; },
  async 'no-migration'() { const maks = Math.max(...[...baca('src/database/db.ts').matchAll(/currentVersion < (\d+)/g)].map((x) => Number(x[1]))); return { status: maks === EXPECTED_SCHEMA ? S.PASS : S.FAIL, detail: `blok migrasi tertinggi: currentVersion < ${maks}` }; },
  async 'no-accrual-menu'() {
    const ui = srcFiles(['src/navigation', 'src/screens', 'src/components', 'app']);
    const re = /AkruiBungaUtangForm|Akrual Bunga Utang|Akrual & Kontrol Bunga Utang|Kontrol Bunga Utang|Proses Akrual/;
    const hit = [...ui.filter((f) => re.test(stripComments(readFileSync(f, 'utf8')))), ...srcFiles(['src', 'app']).filter((f) => /AkruiBungaUtangFormScreen/.test(f))].map((f) => relative(ROOT, f));
    return { status: hit.length ? S.FAIL : S.PASS, detail: hit.length ? hit.join(', ') : `statis: 0 rute/label/layar akrual di ${ui.length} berkas UI` };
  },
  async 'one-writer'() {
    const prod = srcFiles(['src', 'app']);
    const writer = prod.filter((f) => /INSERT INTO utang_bunga_akrual/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
    const pemicu = prod.filter((f) => /\bjalankanAkrualBungaUtangJikaPerlu\s*\(/.test(stripComments(readFileSync(f, 'utf8')))).map((f) => relative(ROOT, f)).sort();
    const sah = ['src/services/PeriodCloseService.ts', 'src/services/StartupTasks.ts', 'src/services/UtangBungaAccrualService.ts'];
    const ok = writer.length === 1 && writer[0] === 'src/services/UtangBungaAccrualService.ts' && pemicu.every((p) => sah.includes(p));
    return { status: ok ? S.PASS : S.FAIL, detail: `writer: ${writer.join(', ') || '-'} · pemicu: ${pemicu.join(', ')}` };
  },
};

function simpan(nama, r) {
  const prev = readComponent('preflight.json');
  const steps = prev?.steps ?? {};
  steps[r.as ?? nama] = { status: r.status, detail: r.detail, partial: !!r.partial, at: new Date().toISOString() };
  const lengkap = STEPS.every((s) => steps[s] && !steps[s].partial);
  const status = STEPS.some((s) => steps[s] && !steps[s].partial && steps[s].status === S.FAIL) ? S.FAIL
    : lengkap && STEPS.every((s) => steps[s].status === S.PASS) ? S.PASS : S.NOT_RUN;
  return writeComponent('preflight.json', { status, steps });
}
function ringkas(pf) {
  console.log('RC-S73.1.3 PRE-FLIGHT (bukti otomatis & statis — bukan bukti perangkat)\n');
  for (const s of STEPS) { const r = pf.steps?.[s]; console.log(line(r && !r.partial ? r.status : S.NOT_RUN, LABEL[s], r ? r.detail : 'belum dijalankan')); }
  console.log(`\nPRE-FLIGHT SOFTWARE = ${pf.status ?? S.NOT_RUN}`);
  const env = readComponent('environment.json');
  console.log(`ENVIRONMENT         = ${env?.status ?? S.NOT_RUN} (dinilai terpisah oleh environment-check; bukan bagian pre-flight software)`);
}
const exitDari = (pf) => (pf.status === S.PASS ? EXIT.OK : pf.status === S.FAIL ? EXIT.FAIL : EXIT.BLOCKED);

if (!readRun()) { const r = newRun(); console.log(`Tidak ada sesi aktif — sesi baru dibuat: ${r.runId}\n`); }
const step = arg('--step');
if (argv.includes('--summary')) {
  const pf = readComponent('preflight.json') ?? { steps: {}, status: S.NOT_RUN };
  ringkas(pf); process.exitCode = exitDari(pf);
} else if (step) {
  if (!LANGKAH[step]) { console.error(`langkah tidak dikenal: ${step}`); process.exit(EXIT.FAIL); }
  const r = await LANGKAH[step]();
  console.log(line(r.partial ? S.NOT_RUN : r.status, LABEL[r.as ?? step] ?? step, r.detail));
  const pf = simpan(step, r);
  if (!r.partial) console.log(`PRE-FLIGHT SOFTWARE (sementara) = ${pf.status}`);
  process.exitCode = r.status === S.PASS ? EXIT.OK : r.status === S.FAIL ? EXIT.FAIL : EXIT.BLOCKED;
} else {
  let pf;
  for (const s of STEPS) pf = simpan(s, await LANGKAH[s]());
  ringkas(pf); process.exitCode = exitDari(pf);
}

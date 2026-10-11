#!/usr/bin/env node
// RC-S73.1.3 §23–§27 — EVIDENCE COLLECTOR (satu-satunya penulis evidence.json).
//
//   node tools/rc-s73-evidence.mjs
//
// Menggabungkan komponen sesi aktif menjadi rc-s73-out/evidence.json:
//   environment · build · automated (+static) · device · database · gates · finalDecision
// Setiap komponen divalidasi (runId, timestamp, sourceVersion, versi tooling);
// komponen stale TIDAK dipakai (dianggap NOT RUN) dan gate "Evidence consistency"
// menjadi BLOCKED. Keputusan final dihitung SEKALI di sini oleh decide().
// Exit: 0 keputusan PASS · 1 ada FAIL · 2 NOT READY tanpa FAIL.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  S, EXIT, EVIDENCE_SCHEMA, OUT_DIR, readRun, readComponent, writeComponent, staleReason, sourceVersion, testRunnerVersion,
  parseForm, decide, layerSummary, requireRun, line, splitSqlChecks, ROOT,
} from './rc-s73-lib.mjs';

/**
 * §18 — hasil DB wajib LENGKAP terhadap tools/rc-s73-device-checks.sql.
 * Cek yang hilang = NOT RUN; hasil PASS yang tidak lengkap TIDAK boleh PASS.
 */
function databaseDari(dbc) {
  if (!dbc || dbc.status === S.NOT_RUN) return { status: S.NOT_RUN, source: 'DB perangkat belum diekstrak', checks: {}, missing: [] };
  const harap = splitSqlChecks(readFileSync(join(ROOT, 'tools', 'rc-s73-device-checks.sql'), 'utf8')).map((c) => c.id);
  const ada = Object.fromEntries((dbc.checks ?? []).map((c) => [c.id, { status: c.status, label: c.label, note: c.note }]));
  const missing = harap.filter((id) => !ada[id]);
  for (const id of missing) ada[id] = { status: S.NOT_RUN, label: id, note: 'hasil cek tidak ada di bukti' };
  const status = missing.length && dbc.status === S.PASS ? S.NOT_RUN : dbc.status;
  return { status, source: dbc.source, checks: Object.fromEntries(harap.map((id) => [id, ada[id]]).concat(Object.entries(ada).filter(([k]) => !harap.includes(k)))), missing };
}

export function collect() {
  const run0 = readRun();
  // kind: 'mixed' = bukti dari sesi/build lain (pelanggaran integritas -> FAIL);
  //       'stale' = source/tooling/timestamp tidak lagi cocok (perlu diulang -> BLOCKED).
  const issues = [];
  const tambah = (kind, message) => issues.push({ kind, message });
  const now = Date.now();
  const cur = { sourceVersion: sourceVersion(), testRunnerVersion: testRunnerVersion() };
  if (run0 && run0.sourceVersion !== cur.sourceVersion) tambah('stale', 'source berubah sejak sesi dimulai');
  if (run0 && run0.testRunnerVersion !== cur.testRunnerVersion) tambah('stale', 'tooling berubah sejak sesi dimulai');

  const ambil = (name) => {
    const c = readComponent(name);
    if (!c) return null;
    const why = staleReason(c._stamp, run0, now, cur);
    if (why) { tambah(/^runId berbeda/.test(why) ? 'mixed' : 'stale', `${name}: ${why}`); return null; }
    return c;
  };
  const env = ambil('environment.json');
  const pf = ambil('preflight.json');
  const build = ambil('build.json');
  const install = ambil('install.json');
  const logcat = ambil('logcat.json');
  const dbc = ambil('db-checks.json');
  const selftest = ambil('selftest.json');

  let form = null;
  const formPath = join(OUT_DIR(), 'RC-S73.1_DEVICE_RESULT.md');
  if (existsSync(formPath)) {
    const f = parseForm(readFileSync(formPath, 'utf8'));
    if (!run0 || f.meta['Run ID'] !== run0.runId) tambah('mixed', `formulir: Run ID ${f.meta['Run ID'] || '(kosong)'} bukan sesi aktif`);
    else form = f;
    if (form && f.meta['Build ID'] && build?.buildId && f.meta['Build ID'] !== build.buildId) { tambah('mixed', `formulir: Build ID ${f.meta['Build ID']} ≠ build.json ${build.buildId}`); form = null; }
  }

  const step = (k) => { const s = pf?.steps?.[k]; return s && !s.partial ? { status: s.status, detail: s.detail } : { status: S.NOT_RUN, detail: 'belum dijalankan dalam sesi ini' }; };
  const ev = {
    schema: EVIDENCE_SCHEMA,
    runId: run0?.runId ?? null,
    timestamp: new Date().toISOString(),
    sourceVersion: cur.sourceVersion,
    testRunnerVersion: cur.testRunnerVersion,
    buildId: build?.buildId ?? null,
    evidenceConsistency: {
      status: !run0 ? S.BLOCKED : issues.some((i) => i.kind === 'mixed') ? S.FAIL : issues.length ? S.BLOCKED : S.PASS,
      issues: run0 ? issues : [{ kind: 'stale', message: 'tidak ada sesi aktif' }, ...issues],
    },
    environment: env ? { status: env.status, checks: env.checks } : { status: S.NOT_RUN, checks: [] },
    build: build ? { status: build.status, reason: build.reason ?? '', buildId: build.buildId ?? null, buildUrl: build.buildUrl ?? null, profile: build.profile ?? null, package: build.package ?? null, artifact: build.artifact ?? null, artifactUrl: build.artifactUrl ?? null, apkFile: build.apkFile ?? null, appVersion: build.appVersion ?? null, recordedAt: build._stamp?.generatedAt ?? null } : { status: S.NOT_RUN, reason: 'build belum dijalankan/dicatat' },
    automated: {
      preflight: pf?.status ?? S.NOT_RUN,
      typescript: step('typescript'), jest: step('jest'), rcS71: step('rc-s71'), install: step('install'), bundle: step('bundle'),
      static: { schema: step('schema'), noMigration: step('no-migration'), noAccrualMenu: step('no-accrual-menu'), oneWriter: step('one-writer'), packageConfig: step('package-config') },
      selftest: selftest ? { status: selftest.status, detail: `${selftest.passed}/${selftest.total} uji framework` } : { status: S.NOT_RUN, detail: 'self-test --record belum dijalankan dalam sesi ini' },
      sqlFixture: selftest ? { status: selftest.dbFixture, detail: 'self-test: SQL diuji pada DB fixture sehat & rusak' } : { status: S.NOT_RUN, detail: 'self-test --record belum dijalankan dalam sesi ini' },
    },
    device: {
      precondition: env?.devicePrecondition ?? S.NOT_RUN,
      info: env?.device ?? null,
      install: install ? { status: install.status, detail: install.uninstall ?? install.reason ?? '' } : { status: S.NOT_RUN },
      logcat: logcat ? { status: logcat.status, critical: logcat.critical, note: logcat.note ?? '', sample: logcat.sample ?? [] } : { status: S.NOT_RUN, critical: null, note: 'belum direkam/dinilai' },
      form: form ? { items: form.items, details: form.details, meta: form.meta, errors: form.errors } : null,
    },
    database: databaseDari(dbc),
  };
  const { gates, finalDecision } = decide(ev);
  return { ...ev, gates, finalDecision, layers: layerSummary(ev, gates) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requireRun();
  const ev = writeComponent('evidence.json', collect());
  const c = ev.finalDecision.counts;
  console.log(`${ev.finalDecision.status === S.PASS ? 'RC-S73.1.3 = PASS' : 'RC-S73.1.3 = NOT READY'} · RELEASE = ${ev.finalDecision.release}`);
  console.log(`Gate: ${c.total} · PASS ${c.PASS} · FAIL ${c.FAIL} · BLOCKED ${c.BLOCKED} · NOT RUN ${c['NOT RUN']}`);
  if (ev.finalDecision.primaryReason) console.log(`Primary reason: ${ev.finalDecision.primaryReason}`);
  ev.evidenceConsistency.issues.forEach((i) => console.log(line(ev.evidenceConsistency.status, 'Evidence', `${i.kind}: ${i.message}`)));
  process.exitCode = ev.finalDecision.status === S.PASS ? EXIT.OK : c.FAIL ? EXIT.FAIL : EXIT.BLOCKED;
}

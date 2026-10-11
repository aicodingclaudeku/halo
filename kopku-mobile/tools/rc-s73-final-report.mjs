#!/usr/bin/env node
// RC-S73.1.3 §11–§26 — FINAL RELEASE REPORT (HANYA MEMBACA evidence.json).
//
//   node tools/rc-s73-final-report.mjs [--out FILE]
//
// - Tidak menulis/mengubah bukti apa pun (§24). Laporan lama dihapus dulu.
// - Validasi anti-stale (§26): sesi, sourceVersion, versi tooling, timestamp,
//   dan KEPUTUSAN DIHITUNG ULANG dari masukan evidence; tidak cocok = REPORT BLOCKED.
// - Setiap kalimat status diturunkan dari evidence (tanpa prosa hardcoded).
// - SELF-TEST PASS ≠ DEVICE PASS · AUTOMATED PASS ≠ DEVICE PASS · STATIC PASS ≠ RUNTIME PASS.
// Exit: 0 RELEASE CLEAR · 1 ada FAIL · 2 NOT READY / REPORT BLOCKED.
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  S, EXIT, TOOL_LABEL, EVIDENCE_SCHEMA, PACKAGE_ID, OUT_DIR, DEFAULT_REPORT, D_ITEMS, readRun, staleReason, decide, layerSummary,
  ACCOUNTING_ROWS, evidenceStatus, composite,
} from './rc-s73-lib.mjs';

const argv = process.argv.slice(2);
const outFile = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : DEFAULT_REPORT(); })();
if (existsSync(outFile)) rmSync(outFile); // §27: laporan lama tidak pernah dipakai ulang

const evPath = join(OUT_DIR(), 'evidence.json');
const ev = existsSync(evPath) ? JSON.parse(readFileSync(evPath, 'utf8')) : null;
const run0 = readRun();

// ---- validasi (§26) --------------------------------------------------------
const masalah = [];
if (!ev) masalah.push('evidence.json tidak ada — jalankan: node tools/rc-s73-evidence.mjs');
else {
  if (ev.schema !== EVIDENCE_SCHEMA) masalah.push(`skema evidence ${ev.schema} ≠ ${EVIDENCE_SCHEMA}`);
  const why = staleReason(ev._stamp, run0);
  if (why) masalah.push(`evidence stale: ${why}`);
  if (ev.runId !== run0?.runId) masalah.push('runId evidence ≠ sesi aktif');
  const { gates, finalDecision, layers, _stamp, timestamp, ...masukan } = ev;
  const ulang = decide(masukan);
  if (JSON.stringify(ulang.gates) !== JSON.stringify(gates) || JSON.stringify(ulang.finalDecision) !== JSON.stringify(finalDecision)) masalah.push('keputusan tersimpan tidak cocok dengan perhitungan ulang dari bukti (evidence dimodifikasi?)');
  if (JSON.stringify(layerSummary(masukan, ulang.gates)) !== JSON.stringify(layers)) masalah.push('ringkasan lapisan tidak cocok dengan bukti');
  if (ev.build?.buildId && ev.device?.form?.meta?.['Build ID'] && ev.build.buildId !== ev.device.form.meta['Build ID']) masalah.push('Build ID formulir ≠ Build ID build');
}
const reportBlocked = masalah.length > 0;

// ---- helper render ---------------------------------------------------------
const v = (x) => (x == null || x === '' ? '—' : String(x).replace(/\|/g, '\\|'));
const md = [];
const push = (...l) => md.push(...l);
const table = (head, rows) => { push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(v).join(' | ')} |`), ''); };

push(`# ${TOOL_LABEL} — FINAL RELEASE REPORT`, '');
push('> Dihasilkan oleh `tools/rc-s73-final-report.mjs` dari `rc-s73-out/evidence.json` (satu-satunya sumber).',
  '> Status per butir: PASS | FAIL | BLOCKED | NOT RUN. Keputusan rilis: PASS | NOT READY.',
  '> SELF-TEST PASS ≠ DEVICE PASS · AUTOMATED PASS ≠ DEVICE PASS · STATIC PASS ≠ RUNTIME PASS.', '');

if (reportBlocked) {
  push('```text', `${TOOL_LABEL} = NOT READY`, 'RELEASE = NOT CLEAR', '', 'REPORT = BLOCKED', 'Primary reason:', 'EVIDENCE_STALE', '```', '');
  push('## FINAL DECISION', '', 'Laporan tidak dapat diterbitkan dari bukti yang ada:', '', ...masalah.map((m) => `- ${m}`), '',
    'Mulai sesi baru (`node tools/rc-s73-session.mjs new`) dan kumpulkan ulang bukti.', '');
  writeFileSync(outFile, md.join('\n'));
  console.log(`${TOOL_LABEL} = NOT READY\nRELEASE = NOT CLEAR\nREPORT = BLOCKED (${masalah.length} masalah bukti)\nLaporan: ${outFile}`);
  process.exit(EXIT.BLOCKED);
}

const G = (id) => ev.gates.find((x) => x.id === id);
const fd = ev.finalDecision;
const L = ev.layers;
const c = fd.counts;

// ---- EXECUTIVE SUMMARY (§37) ----------------------------------------------
push('```text', fd.status === S.PASS ? `${TOOL_LABEL} = PASS` : `${TOOL_LABEL} = NOT READY`, `RELEASE = ${fd.release}`, '',
  `Tooling             = ${L.tooling}`, `Automated           = ${L.automated}`, `Environment         = ${L.environment}`,
  `Build               = ${L.build}`, `Device              = ${L.device}`, `Database Device     = ${L.database}`, '',
  ...(fd.primaryReason ? ['Primary reason:', fd.primaryReason, ''] : []),
  `Mandatory gates = ${c.total}`, `PASS = ${c.PASS}`, `FAIL = ${c.FAIL}`, `BLOCKED = ${c.BLOCKED}`, `NOT RUN = ${c['NOT RUN']}`, '```', '');

// ---- SOURCE BASELINE -------------------------------------------------------
push('## SOURCE BASELINE', '');
table(['Item', 'Nilai'], [
  ['Run ID', ev.runId], ['Evidence timestamp', ev.timestamp], ['Source version (sha256/16)', ev.sourceVersion],
  ['Test runner version', ev.testRunnerVersion], ['Basis akuntansi', 'koperasi-finance_v108.2-RC-S72 (terkunci)'],
  ['Evidence consistency', `${G('EVIDENCE').status}${G('EVIDENCE').reason ? ' — ' + G('EVIDENCE').reason : ''}`],
]);

// ---- ENVIRONMENT ------------------------------------------------------------
push('## ENVIRONMENT', '');
if (ev.environment.checks.length) table(['Pemeriksaan', 'Status', 'Keterangan'], ev.environment.checks.map((x) => [x.label + (x.required ? '' : ' (pelengkap, tidak memengaruhi gate)'), x.status, x.detail]));
push(`Environment gate: **${G('ENV').status}**`, '');

// ---- BUILD -------------------------------------------------------------------
push('## BUILD VERIFICATION', '');
table(['Item', 'Status / Nilai'], [
  ['Build gate (APK preview)', `${G('BUILD').status}${ev.build.reason ? ' — ' + ev.build.reason : ''}`],
  ['Profile', ev.build.profile], ['Package', ev.build.package], ['Artifact', ev.build.artifact],
  ['APK Build ID', ev.build.buildId], ['APK URL / file', ev.build.artifactUrl ?? ev.build.apkFile], ['Build page', ev.build.buildUrl],
  ['App version', ev.build.appVersion], ['Dicatat', ev.build.recordedAt],
  ['Expo bundle (otomatis, bukan artifact terpasang)', ev.automated.bundle.status],
]);

// ---- AUTOMATED VERIFICATION ------------------------------------------------
push('## AUTOMATED VERIFICATION', '', 'Bukti otomatis & statis. Tidak menggantikan bukti perangkat.', '');
table(['Item', 'Status', 'Detail'], [
  ['Pre-flight', ev.automated.preflight, ''],
  ['npm install', ev.automated.install.status, ev.automated.install.detail],
  ['TypeScript', ev.automated.typescript.status, ev.automated.typescript.detail],
  ['Full Jest', ev.automated.jest.status, ev.automated.jest.detail],
  ['RC-S71 regression', ev.automated.rcS71.status, ev.automated.rcS71.detail],
  ['Expo bundle', ev.automated.bundle.status, ev.automated.bundle.detail],
  ['Static: schema', ev.automated.static.schema.status, ev.automated.static.schema.detail],
  ['Static: no migration', ev.automated.static.noMigration.status, ev.automated.static.noMigration.detail],
  ['Static: no accrual menu', ev.automated.static.noAccrualMenu.status, ev.automated.static.noAccrualMenu.detail],
  ['Static: one accrual writer', ev.automated.static.oneWriter.status, ev.automated.static.oneWriter.detail],
  ['Static: package configuration', ev.automated.static.packageConfig.status, ev.automated.static.packageConfig.detail],
]);
push('### Accounting regression (dual evidence)', '');
// Baris dari ACCOUNTING_ROWS (lib) — satu sumber dengan audit diagnostic.
const baris = [
  ...['TS', 'JEST', 'RCS71'].map((id) => [G(id).name, G(id).status, 'N/A', 'N/A', G(id).status]),
  ...ACCOUNTING_ROWS.map((r) => {
    const auto = evidenceStatus(ev, r.auto);
    const dev = G(r.gate).status;
    const dbs = r.db.map((c) => evidenceStatus(ev, `db:${c}`));
    return [r.name, auto, dev, r.db.length ? r.db.map((c, i) => `${c}=${dbs[i]}`).join(' ') : 'N/A', composite(auto, dev, ...dbs)];
  }),
];
table(['Item', 'Automated', 'Device', 'DB', 'Final'], baris);

// ---- DEVICE VERIFICATION ---------------------------------------------------
push('## DEVICE VERIFICATION', '');
const info = ev.device.info ?? {};
table(['Item', 'Status / Nilai'], [
  ['Device precondition (perangkat fisik terverifikasi)', ev.device.precondition],
  ['Device model', info.model], ['Android version', info.androidVersion], ['API level', info.apiLevel], ['Device ID (anonim)', info.deviceId],
  ['Test date', ev.device.form?.meta?.['Test Date']],
  ['Install (bukti mesin D1)', ev.device.install.status],
  ['Logcat', `${G('LOGCAT').status}${ev.device.logcat.critical != null ? ` · ${ev.device.logcat.critical} baris kritis` : ''}${ev.device.logcat.note ? ' · ' + ev.device.logcat.note : ''}`],
  ['Formulir hasil', `${G('FORM').status}${G('FORM').reason ? ' — ' + G('FORM').reason : ''}`],
  ['Device verification (lapisan)', L.device],
]);
if (ev.device.logcat.sample?.length) push('```text', ...ev.device.logcat.sample.slice(0, 15), '```', '');

// ---- DATABASE VERIFICATION -------------------------------------------------
push('## DATABASE VERIFICATION', '');
table(['Lapisan', 'Status'], [
  ['Automated SQL validation (fixture self-test)', ev.automated.sqlFixture.status],
  ['Device extracted DB', ev.database.status],
  ...D_ITEMS.filter((d) => d.machine === 'database').map((d) => [d.id, G(d.id).status]),
]);
const cids = Object.keys(ev.database.checks ?? {});
if (cids.length) table(['Cek', 'Status', 'Catatan'], cids.map((k) => [`${k} ${ev.database.checks[k].label}`, ev.database.checks[k].status, ev.database.checks[k].note]));
else push(`Sumber: ${v(ev.database.source)}`, '');

// ---- D1-D19 ------------------------------------------------------------------
push('## D1-D19', '', 'Bukti pelengkap ditampilkan untuk transparansi dan TIDAK PERNAH mengubah status final.', '');
const lbl = (k) => `${k.replace(/^auto:/, 'auto ').replace(/^static:/, 'static ').replace(/^db:/, 'DB ')}=${evidenceStatus(ev, k)}`;
table(['Gate', 'Form Status', 'Machine Evidence (wajib)', 'Supplementary', 'Final Status', 'Alasan'], D_ITEMS.map((d) => {
  const g = G(d.id);
  const det = ev.device.form?.details?.[d.id] ?? {};
  return [g.name, g.form, d.machine ? `${d.machine}=${g.machine}` : 'N/A', (d.support ?? []).map(lbl).join(', ') || '—', g.status,
    [g.reason, det.reason && `alasan penguji: ${det.reason}`, det.Severity && `severity ${det.Severity}`].filter(Boolean).join(' · ')];
}));

// ---- ARTIFACTS (§47) — berkas yang belum ada dicatat, TIDAK dibuat dummy ----
push('## ARTIFACTS', '');
{
  const ada = (f) => existsSync(join(OUT_DIR(), f));
  const st = (f, gateStatus) => (ada(f) ? 'tersedia' : gateStatus === S.PASS ? 'HILANG' : gateStatus);
  table(['Berkas', 'Status'], [
    ['rc-s73-out/evidence.json', ada('evidence.json') ? 'tersedia' : S.NOT_RUN],
    ['rc-s73-out/audit-diagnostic.json', ada('audit-diagnostic.json') ? 'tersedia' : `${S.NOT_RUN} (jalankan audit-diagnostic)`],
    ['rc-s73-out/rc-s73-logcat.txt', st('rc-s73-logcat.txt', G('LOGCAT').status === S.NOT_RUN && ev.device.precondition !== S.PASS ? S.BLOCKED : G('LOGCAT').status)],
    ['rc-s73-out/rc-s73-db-checks.txt', st('rc-s73-db-checks.txt', ev.device.precondition !== S.PASS ? S.BLOCKED : ev.database.status)],
  ]);
}

// ---- FINDINGS / FIXES / OUT OF SCOPE --------------------------------------
push('## FINDINGS', '');
const fails = ev.gates.filter((x) => x.status === S.FAIL);
if (!fails.length) push('Tidak ada gate berstatus FAIL dalam bukti sesi ini.', '');
for (const g of fails) {
  const det = ev.device.form?.details?.[g.id] ?? {};
  push(`### ${g.name} — ${v(det.Severity)}`, '', ...['Reproduction', 'Expected', 'Actual', 'Screenshot', 'Logcat'].map((k) => `- **${k}:** ${v(det[k])}`), g.reason ? `- **Alasan gate:** ${g.reason}` : '', '');
}
push('## FIXES', '', 'Tidak ada perubahan source produksi yang tercatat dalam sesi ini (sourceVersion di atas).', '');
push('## OUT OF SCOPE', '',
  '- `LoanImpairmentService` → KEEP / OUT OF SCOPE',
  '- `tsconfig.screen-check.json` → baseline issue / OUT OF SCOPE',
  '- `@noble/hashes` WARN → third-party internal resolution / NOT A DEFECT', '');

// ---- FINAL DECISION --------------------------------------------------------
push('## FINAL DECISION', '');
table(['Gate', 'Status', 'Alasan'], ev.gates.map((g) => [g.name, g.status, g.reason]));
push('```text', fd.status === S.PASS ? `${TOOL_LABEL} = PASS` : `${TOOL_LABEL} = NOT READY`, `RELEASE = ${fd.release}`,
  ...(fd.primaryReason ? ['', 'PRIMARY REASON:', fd.primaryReason, '', 'ALL REASONS:', ...fd.reasons, '', 'BLOCKING GATES:', ...fd.blocking] : []), '```', '');
push('### Tooling status vs application release', '');
table(['Status', 'Nilai', 'Arti'], [
  ['TOOLING (self-test framework)', G('TOOLING').status, `${ev.automated.selftest.detail} — framework verifikasi; BUKAN bukti perangkat`],
  ['APPLICATION RELEASE', fd.status, fd.status === S.PASS ? 'seluruh gate wajib PASS dengan bukti sesi ini' : `belum ada bukti lengkap: ${fd.primaryReason}`],
]);
push(`Paket: \`${PACKAGE_ID}\` · Laporan dibuat: ${new Date().toISOString()}`, '');

writeFileSync(outFile, md.join('\n'));
console.log(`${fd.status === S.PASS ? `${TOOL_LABEL} = PASS` : `${TOOL_LABEL} = NOT READY`}\nRELEASE = ${fd.release}`);
if (fd.primaryReason) console.log(`Primary reason: ${fd.primaryReason}`);
console.log(`Gate: ${c.total} · PASS ${c.PASS} · FAIL ${c.FAIL} · BLOCKED ${c.BLOCKED} · NOT RUN ${c['NOT RUN']}\nLaporan: ${outFile}`);
process.exitCode = fd.status === S.PASS ? EXIT.OK : c.FAIL ? EXIT.FAIL : EXIT.BLOCKED;

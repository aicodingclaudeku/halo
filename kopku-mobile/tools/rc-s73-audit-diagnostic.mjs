#!/usr/bin/env node
// RC-S73.1.3 — RELEASE GATE AUDIT DIAGNOSTIC (read-only).
//
//   node tools/rc-s73-audit-diagnostic.mjs [--out FILE]
//
// READ evidence.json → VALIDATE → DIAGNOSE setiap gate → MISSING EVIDENCE →
// BLOCKER → keputusan (dari decide() di lib, TIDAK ada engine kedua) → LAPORAN.
//
// - Tidak mengubah evidence.json, tidak membuat bukti, tidak memaksa keputusan.
// - Setiap penjelasan dibangun dari graf dependensi D_ITEMS / GATE_ACTIONS /
//   ACCOUNTING_ROWS di lib — tidak ada status atau ID gate yang ditulis mati di sini.
// - Cross-check: evidence.json ↔ perhitungan ulang ↔ RC-S73.1_FINAL_RELEASE_REPORT.md.
// Exit: 0 audit berjalan & aplikasi PASS · 1 defect audit/tooling (termasuk laporan
//       tidak konsisten) · 2 bukti menunjukkan NOT READY / BLOCKED.
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  S, EXIT, EVIDENCE_SCHEMA, ROOT, OUT_DIR, DEFAULT_REPORT, D_ITEMS, GATE_ACTIONS, ACCOUNTING_ROWS, REASON,
  readRun, staleReason, decide, layerSummary, evidenceStatus, aggregate, composite, writeComponent,
} from './rc-s73-lib.mjs';

export const AUDIT_LABEL = 'RC-S73.1.3';

const ARTI = {
  auto: { [S.PASS]: 'regresi otomatis lulus', [S.FAIL]: 'regresi otomatis GAGAL', [S.BLOCKED]: 'tidak dapat dijalankan', [S.NOT_RUN]: 'belum dijalankan dalam sesi ini' },
  device: { [S.PASS]: 'terverifikasi di perangkat fisik', [S.FAIL]: 'GAGAL saat diobservasi di perangkat', [S.BLOCKED]: 'tidak dapat dieksekusi', [S.NOT_RUN]: 'belum dieksekusi di aplikasi pada perangkat fisik' },
  db: { [S.PASS]: 'lulus pada DB perangkat', [S.FAIL]: 'GAGAL pada DB perangkat', [S.BLOCKED]: 'DB perangkat tidak dapat diambil', [S.NOT_RUN]: 'DB perangkat belum diekstrak/diperiksa' },
};
const namaKunci = (k) => k.replace(/^auto:/, 'otomatis ').replace(/^static:/, 'statis ').replace(/^db:/, '');

/** Diagnosis satu gate perangkat (D-item) dari graf dependensi. */
function diagD(d, g, ev) {
  const pre = ev.device?.precondition ?? S.NOT_RUN;
  const autoKeys = (d.support ?? []).filter((k) => /^(auto|static):/.test(k));
  const dbKeys = (d.support ?? []).filter((k) => k.startsWith('db:'));
  const autoSt = autoKeys.map((k) => [k, evidenceStatus(ev, k)]);
  const dbSt = dbKeys.map((k) => [k, evidenceStatus(ev, k)]);
  const automated = aggregate(autoSt.map(([, s]) => s));
  const device = g.status;
  const database = d.machine === 'database' ? ev.database?.status ?? S.NOT_RUN : aggregate(dbSt.map(([, s]) => s));
  const final = composite(automated, device, database);

  const missing = [], failed = [], explanation = [];
  for (const [k, s] of autoSt) {
    explanation.push(`bukti ${namaKunci(k)} = ${s} (${ARTI.auto[s] ?? 'status tidak dikenal'})`);
    if (s === S.FAIL) failed.push(k); else if (s !== S.PASS) missing.push(k);
  }
  const alasanDev = device === S.BLOCKED ? (pre !== S.PASS ? 'perangkat fisik tidak tersedia/terverifikasi' : g.reason || 'bukti mesin tidak tersedia') : ARTI.device[device];
  explanation.push(`observasi perangkat — ${d.device} = ${device} (${alasanDev})`);
  if (device === S.FAIL) failed.push(d.id); else if (device !== S.PASS) missing.push(d.id);
  if (d.machine === 'install') {
    const ms = ev.device?.install?.status ?? S.NOT_RUN;
    explanation.push(`bukti mesin install = ${ms}`);
    if (ms === S.FAIL) failed.push('install'); else if (ms !== S.PASS) missing.push('install');
  }
  if (d.machine === 'database') {
    explanation.push(`DB perangkat (diekstrak) = ${database} (${ARTI.db[database] ?? 'status tidak dikenal'})`);
    if (database === S.FAIL) failed.push('device-db'); else if (database !== S.PASS) missing.push('device-db');
    for (const c of ev.database?.missing ?? []) missing.push(c);
  }
  for (const [k, s] of dbSt) {
    explanation.push(`DB ${namaKunci(k)} = ${s} (${ARTI.db[s] ?? 'status tidak dikenal'})`);
    if (s === S.FAIL) failed.push(namaKunci(k)); else if (s !== S.PASS) missing.push(namaKunci(k));
  }
  explanation.push(failed.length
    ? `Ada bukti FAIL: ${failed.join(', ')}.`
    : final === S.PASS ? 'Seluruh bukti PASS.' : 'Tidak ada bukti FAIL; gate belum PASS karena bukti belum lengkap (bukan kegagalan).');

  const blockers = [];
  if (pre !== S.PASS) blockers.push(REASON.DEVICE_VERIFICATION_BLOCKED);
  if (device === S.NOT_RUN) blockers.push(REASON.DEVICE_GATE_NOT_RUN);
  if (device === S.FAIL) blockers.push(d.machine === 'database' ? REASON.DB_INTEGRITY_FAILED : REASON.DEVICE_GATE_FAILED);
  if (d.machine === 'database' && database === S.FAIL && !blockers.includes(REASON.DB_INTEGRITY_FAILED)) blockers.push(REASON.DB_INTEGRITY_FAILED);
  if (autoSt.some(([, s]) => s === S.FAIL)) blockers.push(REASON.AUTOMATED_REGRESSION_FAILED);

  const why = final === S.PASS ? 'semua bukti (otomatis, perangkat, DB) PASS'
    : failed.length ? `bukti FAIL: ${failed.join(', ')}`
    : `otomatis ${automated} · perangkat ${device} · DB ${database} — ${pre !== S.PASS ? 'perangkat fisik belum tersedia' : 'bukti perangkat belum lengkap'}`;
  const remediation = final === S.PASS ? '—' : [pre !== S.PASS ? GATE_ACTIONS.ENV : null, d.action].filter(Boolean).join(' Lalu: ');
  return { gate: d.id, name: g.name, severity: 'MANDATORY GATE', status: g.status, final, evidence: { automated, device, database }, missingEvidence: missing, failedEvidence: failed, blockers, explanation, why, remediation };
}

/** Diagnosis gate non-D (skema, konsistensi, lingkungan, build, otomatis, logcat, formulir). */
function diagOther(g, ev) {
  const pre = ev.device?.precondition ?? S.NOT_RUN;
  const layer = { SCHEMA: 'evidence', TOOLING: 'automated', EVIDENCE: 'evidence', ENV: 'environment', BUILD: 'build', TS: 'automated', JEST: 'automated', RCS71: 'automated', LOGCAT: 'device', FORM: 'device' }[g.id] ?? g.category;
  const evidence = { automated: 'N/A', device: 'N/A', database: 'N/A', [layer]: g.status };
  const missing = [], failed = [];
  if (g.id === 'ENV') for (const c of (ev.environment?.checks ?? []).filter((x) => x.required && x.status !== S.PASS)) (c.status === S.FAIL ? failed : missing).push(`environment.${c.id}`);
  else if (g.status === S.FAIL) failed.push(g.id.toLowerCase());
  else if (g.status !== S.PASS) missing.push(g.id.toLowerCase());
  const blockers = [];
  if (g.status !== S.PASS) {
    if (g.id === 'SCHEMA') blockers.push(REASON.EVIDENCE_SCHEMA_INVALID);
    else if (g.id === 'TOOLING') blockers.push(REASON.TOOLING_NOT_VERIFIED);
    else if (g.id === 'EVIDENCE') blockers.push(REASON.EVIDENCE_STALE);
    else if (g.id === 'ENV') blockers.push(pre !== S.PASS ? REASON.DEVICE_VERIFICATION_BLOCKED : REASON.ENVIRONMENT_BLOCKED);
    else if (g.id === 'BUILD') blockers.push(g.status === S.FAIL ? REASON.DEVICE_GATE_FAILED : REASON.BUILD_BLOCKED);
    else if (g.category === 'automated') blockers.push(g.status === S.FAIL ? REASON.AUTOMATED_REGRESSION_FAILED : REASON.DEVICE_GATE_NOT_RUN);
    else blockers.push(g.status === S.FAIL ? REASON.DEVICE_GATE_FAILED : pre !== S.PASS ? REASON.DEVICE_VERIFICATION_BLOCKED : REASON.DEVICE_GATE_NOT_RUN);
  }
  const arti = layer === 'automated' ? ARTI.auto : ARTI.device;
  const explanation = [`${g.name} = ${g.status}${g.reason ? ` — ${g.reason}` : ''}`, ...missing.map((m) => `bukti belum ada: ${m}`), ...failed.map((f) => `bukti FAIL: ${f}`)];
  const final = g.status === S.PASS ? S.PASS : g.status === S.FAIL ? S.FAIL : 'NOT READY';
  const why = g.status === S.PASS ? 'bukti tersedia dan PASS'
    : g.reason || (missing.length ? `bukti belum ada: ${missing.join(', ')}` : failed.length ? `bukti FAIL: ${failed.join(', ')}` : `${layer}: ${arti[g.status] ?? g.status}`);
  return { gate: g.id, name: g.name, severity: 'MANDATORY GATE', status: g.status, final, evidence, missingEvidence: missing, failedEvidence: failed, blockers, explanation, why, remediation: g.status === S.PASS ? '—' : GATE_ACTIONS[g.id] ?? '—' };
}

/**
 * Fungsi murni. `ev` = isi evidence.json. Keputusan HANYA dari decide() (lib).
 * @returns diagnosis lengkap (tanpa efek samping).
 */
export function diagnose(ev, { evidenceIssues = [], toolingSelftest = null } = {}) {
  const { gates: _g, finalDecision: _f, layers: _l, _stamp, timestamp: _t, ...inputs } = ev;
  const { gates, finalDecision } = decide(inputs);
  const storedMatches = JSON.stringify(gates) === JSON.stringify(_g) && JSON.stringify(finalDecision) === JSON.stringify(_f);
  const issues = [...evidenceIssues];
  if (!storedMatches) issues.push('keputusan tersimpan di evidence.json ≠ perhitungan ulang dari bukti (evidence dimodifikasi?)');
  const trusted = issues.length === 0;

  const perGate = gates.map((g) => {
    const d = D_ITEMS.find((x) => x.id === g.id);
    return d ? diagD(d, g, inputs) : diagOther(g, inputs);
  });
  const uniq = (xs) => [...new Set(xs)];
  const accounting = ACCOUNTING_ROWS.map((r) => {
    const auto = evidenceStatus(inputs, r.auto), dev = gates.find((g) => g.id === r.gate).status, dbs = r.db.map((c) => evidenceStatus(inputs, `db:${c}`));
    return { name: r.name, gate: r.gate, automated: auto, device: dev, database: r.db.length ? aggregate(dbs) : 'N/A', final: composite(auto, dev, ...dbs) };
  });
  const app = trusted ? finalDecision.status : 'NOT READY';
  const primary = trusted ? finalDecision.primaryReason : REASON.EVIDENCE_STALE;
  const tg = gates.find((g) => g.id === 'TOOLING').status;
  const toolingSt = !trusted ? S.BLOCKED : tg;
  return {
    label: AUDIT_LABEL,
    runId: ev.runId ?? null,
    sourceVersion: ev.sourceVersion ?? null,
    evidenceTimestamp: ev.timestamp ?? null,
    evidenceTrusted: trusted,
    evidenceIssues: issues,
    tooling: { status: toolingSt, selftest: toolingSelftest ?? S.NOT_RUN },
    application: { status: app, release: app === S.PASS ? 'CLEAR' : 'NOT CLEAR', primaryReason: primary, reasons: trusted ? finalDecision.reasons : uniq([REASON.EVIDENCE_STALE, ...finalDecision.reasons]) },
    layers: layerSummary(inputs, gates),
    counts: finalDecision.counts,
    gates: perGate,
    accounting,
    missingEvidence: uniq(perGate.flatMap((g) => g.missingEvidence)),
    failedEvidence: uniq(perGate.flatMap((g) => g.failedEvidence)),
    notRunGates: gates.filter((g) => g.status === S.NOT_RUN).map((g) => g.name),
    blockedGates: gates.filter((g) => g.status === S.BLOCKED).map((g) => g.name),
    failedGates: gates.filter((g) => g.status === S.FAIL).map((g) => g.name),
    blockingGates: finalDecision.blocking,
    // Urutan tindakan unik: remediasi per gate dipecah per langkah lalu dideduplikasi.
    nextActions: uniq(perGate.filter((g) => g.final !== S.PASS).flatMap((g) => g.remediation.split(' Lalu: ')).filter((x) => x && x !== '—')),
  };
}

/** Cross-check laporan final terhadap diagnosis (§32). */
export function crossCheckReport(md, diag) {
  if (md == null) return { present: false, consistent: null, issues: ['laporan final belum dibuat'] };
  const issues = [];
  const blocked = md.includes('REPORT = BLOCKED');
  if (blocked && diag.evidenceTrusted) issues.push('laporan menyatakan REPORT = BLOCKED padahal bukti valid (laporan usang)');
  if (!blocked) {
    const m = md.match(/= (PASS|NOT READY)\nRELEASE = (CLEAR|NOT CLEAR)/);
    if (!m) issues.push('baris keputusan tidak ditemukan di laporan');
    else if (m[1] !== diag.application.status) issues.push(`keputusan laporan ${m[1]} ≠ audit ${diag.application.status}`);
    const blok = md.slice(md.indexOf('## FINAL DECISION'));
    for (const g of diag.gates) {
      // Status di tabel FINAL DECISION ditulis polos (tanpa bold); bold diterima juga.
      const r = blok.match(new RegExp(`^\\| ${g.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\| (?:\\*\\*)?(PASS|FAIL|BLOCKED|NOT RUN)(?:\\*\\*)? \\|`, 'm'));
      if (!r) issues.push(`gate ${g.name} tidak ada di laporan`);
      else if (r[1] !== g.status) issues.push(`gate ${g.name}: laporan ${r[1]} ≠ audit ${g.status}`);
    }
  } else if (!diag.evidenceTrusted && diag.application.status === S.PASS) issues.push('audit PASS padahal laporan BLOCKED');
  return { present: true, consistent: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Laporan manusia
// ---------------------------------------------------------------------------

export function renderAudit(diag, cross) {
  const v = (x) => (x == null || x === '' ? '—' : String(x).replace(/\|/g, '\\|'));
  const L = [];
  const p = (...x) => L.push(...x);
  const t = (head, rows) => p(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(v).join(' | ')} |`), '');
  p(`# ${AUDIT_LABEL} — AUDIT DIAGNOSTIC REPORT`, '',
    '> Dihasilkan `tools/rc-s73-audit-diagnostic.mjs` secara read-only dari `rc-s73-out/evidence.json`. Keputusan dihitung oleh `decide()` yang sama dengan laporan final.', '');
  p('## EXECUTIVE SUMMARY', '', '```text', 'Tooling:', diag.tooling.status, '', 'Application:', diag.application.status, `Release: ${diag.application.release}`, '',
    `Tooling                       ${diag.layers.tooling}`, `Environment                   ${diag.layers.environment}`,
    `Automated verification        ${diag.layers.automated}`, `Device verification           ${diag.layers.device}`,
    `Database device verification  ${diag.layers.database}`, `Build verification            ${diag.layers.build}`, '',
    `Mandatory gates = ${diag.counts.total} · PASS ${diag.counts.PASS} · FAIL ${diag.counts.FAIL} · BLOCKED ${diag.counts.BLOCKED} · NOT RUN ${diag.counts['NOT RUN']}`, '```', '');
  p('## ROOT CAUSE', '', '```text', diag.application.primaryReason ?? 'NONE (semua gate PASS)', '```', '');
  if (diag.application.reasons.length) p('Semua reason code:', '', ...diag.application.reasons.map((r) => `- ${r}`), '');
  if (!diag.evidenceTrusted) p('**Bukti tidak dapat dipercaya:**', '', ...diag.evidenceIssues.map((i) => `- ${i}`), '');
  p(`Evidence: run \`${v(diag.runId)}\` · source \`${v(diag.sourceVersion)}\` · timestamp ${v(diag.evidenceTimestamp)}`, '');

  const byLayer = (layer) => diag.gates.filter((g) => g.evidence[layer] !== 'N/A');
  p('## AUTOMATED EVIDENCE', '');
  t(['Gate', 'Automated', 'Arti'], byLayer('automated').map((g) => [g.name, g.evidence.automated, g.evidence.automated === S.PASS ? 'regresi otomatis lulus — BUKAN bukti perangkat' : g.why]));
  p('## DEVICE EVIDENCE', '');
  t(['Gate', 'Device', 'Arti'], byLayer('device').map((g) => [g.name, g.evidence.device, g.why]));
  p('## DATABASE EVIDENCE', '');
  t(['Gate', 'DB', 'Arti'], byLayer('database').map((g) => [g.name, g.evidence.database, g.evidence.database === S.PASS ? 'lulus pada DB perangkat' : 'DB perangkat belum/tidak lulus']));
  p('### Akuntansi (dual evidence)', '');
  t(['Item', 'Automated', 'Device', 'DB', 'Final'], diag.accounting.map((a) => [a.name, a.automated, a.device, a.database, a.final]));

  p('## GATE-BY-GATE DIAGNOSTIC', '');
  t(['Gate', 'Automated', 'Device', 'DB', 'Final', 'Why', 'Missing Evidence'], diag.gates.map((g) => [g.name, g.evidence.automated, g.evidence.device, g.evidence.database, g.final, g.why, g.missingEvidence.join(', ') || '—']));
  for (const g of diag.gates.filter((x) => x.final !== S.PASS)) {
    p(`### ${g.name}`, '', '```text', `Status:`, g.status, '', `Severity:`, g.severity, '', 'Reason:', ...g.explanation.map((e) => `- ${e}`), '',
      'Missing:', ...(g.missingEvidence.length ? g.missingEvidence : ['—']), '', ...(g.failedEvidence.length ? ['Failed:', ...g.failedEvidence, ''] : []),
      'Blockers:', ...(g.blockers.length ? g.blockers : ['—']), '', 'Next action:', g.remediation, '```', '');
  }
  p('## MISSING EVIDENCE', '', ...(diag.missingEvidence.length ? diag.missingEvidence.map((m) => `- ${m}`) : ['Tidak ada.']), '');
  if (diag.failedEvidence.length) p('### FAILED EVIDENCE', '', ...diag.failedEvidence.map((m) => `- ${m}`), '');
  p('## BLOCKING GATES', '', `NOT RUN (${diag.notRunGates.length}):`, '', ...diag.notRunGates.map((n) => `- ${n}`), '',
    `BLOCKED (${diag.blockedGates.length}):`, '', ...diag.blockedGates.map((n) => `- ${n}`), '', `FAIL (${diag.failedGates.length}):`, '', ...diag.failedGates.map((n) => `- ${n}`), '');
  p('## NEXT REQUIRED ACTION', '', ...(diag.nextActions.length ? diag.nextActions.map((a, i) => `${i + 1}. ${a}`) : ['Tidak ada — semua gate PASS.']), '');
  p('## FINAL DECISION', '');
  t(['Pemeriksaan', 'Hasil'], [
    ['Cross-check evidence.json ↔ perhitungan ulang', diag.evidenceTrusted ? 'KONSISTEN' : 'TIDAK KONSISTEN'],
    ['Cross-check laporan final', cross.present ? (cross.consistent ? 'KONSISTEN' : `TIDAK KONSISTEN: ${cross.issues.join('; ')}`) : 'laporan final belum dibuat'],
  ]);
  p('```text', `${AUDIT_LABEL} TOOLING = ${diag.tooling.status}`, '', `APPLICATION RELEASE = ${diag.application.status}`, `PRIMARY REASON      = ${diag.application.primaryReason ?? 'NONE'}`, '```', '',
    'SELF-TEST PASS ≠ DEVICE PASS · AUTOMATED PASS ≠ DEVICE PASS · STATIC PASS ≠ RUNTIME PASS.', '');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// main (read-only terhadap bukti)
// ---------------------------------------------------------------------------

async function main() {
  const out = (() => { const i = process.argv.indexOf('--out'); return i >= 0 ? resolve(process.argv[i + 1]) : process.env.RC_S73_AUDIT_REPORT ? resolve(process.env.RC_S73_AUDIT_REPORT) : join(ROOT, 'RC-S73.1.2_AUDIT_DIAGNOSTIC_REPORT.md'); })();
  if (existsSync(out)) rmSync(out);
  const evPath = join(OUT_DIR(), 'evidence.json');
  const run0 = readRun();
  if (!existsSync(evPath) || !run0) {
    const msg = !run0 ? 'tidak ada sesi aktif' : 'evidence.json tidak ada — jalankan rc-s73-evidence.mjs';
    writeFileSync(out, `# ${AUDIT_LABEL} — AUDIT DIAGNOSTIC REPORT\n\n\`\`\`text\nTooling:\nBLOCKED\n\nApplication:\nNOT READY\n\nPRIMARY REASON = ${REASON.EVIDENCE_STALE}\n\`\`\`\n\n- ${msg}\n`);
    console.log(`AUDIT ENGINE = PASS\nAPPLICATION = NOT READY (${msg})`);
    return EXIT.BLOCKED;
  }
  const raw = readFileSync(evPath, 'utf8');
  const ev = JSON.parse(raw);
  const issues = [];
  if (ev.schema !== EVIDENCE_SCHEMA) issues.push(`skema evidence ${ev.schema} ≠ ${EVIDENCE_SCHEMA}`);
  const why = staleReason(ev._stamp, run0);
  if (why) issues.push(`evidence stale: ${why}`);
  if (ev.runId !== run0.runId) issues.push('runId evidence ≠ sesi aktif');
  const diag = diagnose(ev, { evidenceIssues: issues, toolingSelftest: ev.automated?.selftest?.status ?? null });
  const reportPath = DEFAULT_REPORT();
  const cross = crossCheckReport(existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null, diag);
  if (readFileSync(evPath, 'utf8') !== raw) throw new Error('evidence.json berubah selama audit');
  writeComponent('audit-diagnostic.json', { ...diag, reportCrossCheck: cross });
  writeFileSync(out, renderAudit(diag, cross));

  const engineOk = cross.present ? cross.consistent : true;
  console.log(`AUDIT ENGINE = ${engineOk ? 'PASS' : 'FAIL (laporan final tidak konsisten dengan bukti)'}`);
  console.log(`TOOLING      = ${diag.tooling.status}`);
  console.log(`APPLICATION  = ${diag.application.status}${diag.application.primaryReason ? ` (${diag.application.primaryReason})` : ''}`);
  console.log(`Gate: ${diag.counts.total} · PASS ${diag.counts.PASS} · FAIL ${diag.counts.FAIL} · BLOCKED ${diag.counts.BLOCKED} · NOT RUN ${diag.counts['NOT RUN']}`);
  console.log(`Laporan: ${out}`);
  if (!engineOk) { cross.issues.forEach((i) => console.log(`  - ${i}`)); return EXIT.FAIL; }
  return diag.application.status === S.PASS ? EXIT.OK : EXIT.BLOCKED;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(`AUDIT ENGINE = FAIL — ${e.message}`); process.exitCode = EXIT.FAIL; });
}

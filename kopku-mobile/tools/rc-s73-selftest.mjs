#!/usr/bin/env node
// RC-S73.1.3 §3–§10, §25, §28, §33 — SELF-TEST FRAMEWORK VERIFIKASI.
//
//   node tools/rc-s73-selftest.mjs              # uji FRAMEWORK saja (default; tanpa lingkungan nyata)
//   node tools/rc-s73-selftest.mjs --record     # + catat hasil ke sesi aktif (bukti TOOLING, bukan bukti perangkat)
//   node tools/rc-s73-selftest.mjs --real-env   # + diagnostik lingkungan nyata (adb/SDK/EAS), terbatas waktu
//
// SELF-TEST PASS berarti framework verifikasi bekerja. SELF-TEST PASS ≠ DEVICE PASS.
// Default TIDAK PERNAH menyentuh adb/EAS/SDK/jaringan nyata: seluruh uji lingkungan
// memakai biner palsu di PATH steril. Lingkungan nyata tidak tersedia BUKAN defect
// framework dan tidak pernah membuat exit 1. Watchdog global hanya pengaman
// terakhir dan dibersihkan begitu uji framework selesai.
// Semua fixture sementara (direktori tmp) dan dihapus di akhir.
// Exit: 0 framework PASS · 1 framework defect.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const WATCHDOG_MS = 240_000;
const ORIG_OUT = process.env.RC_S73_OUT;
const RECORD = process.argv.includes('--record');
const REAL_ENV = process.argv.includes('--real-env');
// Salinan self-test yang dijalankan oleh self-test (uji no-hang/exit) tidak menjalankan salinan lagi.
const CHILD = process.env.RC_S73_SELFTEST_CHILD === '1';
// Hanya untuk uji kontrak exit: menyuntikkan satu kegagalan framework sintetis.
const INJECT_FAIL = process.env.RC_S73_SELFTEST_INJECT_FAIL === '1';
const TMP = mkdtempSync(join(tmpdir(), 'rcs73-selftest-'));
// Lindungi keluaran & laporan asli: seluruh self-test bekerja di direktori sementara.
process.env.RC_S73_OUT = join(TMP, 'out-default');
process.env.RC_S73_REPORT = join(TMP, 'report-default.md');

const lib = await import('./rc-s73-lib.mjs');
const { S, ROOT, D_ITEMS, run, classify, decide, finalItem, parseForm, formTemplate, setFormItem, runDbChecks, splitSqlChecks,
  scanLogcat, LOGCAT_START, LOGCAT_END, newRun, readRun, writeComponent, sourceVersion, testRunnerVersion, REASON } = lib;
const { collect } = await import('./rc-s73-evidence.mjs');
const { diagnose } = await import('./rc-s73-audit-diagnostic.mjs');

const watchdog = setTimeout(() => {
  console.log(`\nSELF-TEST STATUS = FAIL (watchdog ${WATCHDOG_MS / 1000}s terlampaui — framework tidak deterministik)`);
  process.exit(1);
}, WATCHDOG_MS);

const KAT = ['self-test lifecycle', 'audit diagnostic', 'tooling discovery', 'configuration parser', 'report schema', 'decision engine', 'timeout handling', 'blocked-state handling', 'no-fake-pass rule', 'stale-evidence protection', 'database checks'];
const hasil = Object.fromEntries(KAT.map((k) => [k, []]));
let fixtureDbStatus = S.NOT_RUN;
async function uji(kat, nama, fn) {
  try { await fn(); hasil[kat].push({ nama, ok: true }); }
  catch (e) { hasil[kat].push({ nama, ok: false, err: e.message }); }
}
/** Grafik eksekusi: setiap tool yang dijalankan self-test (untuk SELFTEST_NO_REAL_ENV). */
const GRAFIK = [];
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} diharapkan ${JSON.stringify(b)}, didapat ${JSON.stringify(a)}`); };
const ok = (c, m) => { if (!c) throw new Error(m); };
const NODE = process.execPath;
// Path absolut `sleep`: PATH fixture sengaja hanya berisi bin palsu.
const SLEEP = ['/bin/sleep', '/usr/bin/sleep'].find((p) => existsSync(p)) ?? '/bin/sleep';
const tool = (f) => join(ROOT, 'tools', f);
const sh = (dir, f, body) => { const p = join(dir, f); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };

// ===========================================================================
// tooling discovery
// ===========================================================================
await uji('tooling discovery', 'semua berkas tooling ada', () => {
  for (const f of ['rc-s73-lib.mjs', 'rc-s73-audit-diagnostic.mjs', 'rc-s73-session.mjs', 'rc-s73-environment-check.mjs', 'rc-s73-preflight.mjs', 'rc-s73-device-runner.mjs', 'rc-s73-evidence.mjs', 'rc-s73-final-report.mjs', 'rc-s73-device-checks.sql']) ok(existsSync(tool(f)), f);
});
await uji('tooling discovery', 'sourceVersion & testRunnerVersion deterministik', () => {
  eq(sourceVersion(), sourceVersion()); eq(testRunnerVersion(), testRunnerVersion()); ok(/^RC-S73\.1\.3\+[0-9a-f]{16}$/.test(testRunnerVersion()), testRunnerVersion());
});
await uji('tooling discovery', 'version consistency: label runtime = RC-S73.1.3, skema rc-s73.1.3', () => {
  eq(lib.TOOL_LABEL, 'RC-S73.1.3'); eq(lib.EVIDENCE_SCHEMA, 'rc-s73.1.3/evidence@1');
  // Semua tool kecuali self-test (yang sengaja memuat versi lama sebagai fixture evidence usang).
  for (const f of ['rc-s73-lib.mjs', 'rc-s73-session.mjs', 'rc-s73-environment-check.mjs', 'rc-s73-preflight.mjs', 'rc-s73-device-runner.mjs', 'rc-s73-evidence.mjs', 'rc-s73-final-report.mjs', 'rc-s73-audit-diagnostic.mjs']) {
    const kode = lib.stripComments(readFileSync(tool(f), 'utf8'));
    const basi = [...kode.matchAll(/(RC-S73\.1\.[12]|rc-s73\.1\.[12])(?!_AUDIT_DIAGNOSTIC_REPORT)/g)].map((m) => m[0]);
    eq(basi, [], `${f} memuat label runtime basi`);
  }
});
await uji('tooling discovery', 'setiap run() di tooling memakai timeout', () => {
  for (const f of ['rc-s73-environment-check.mjs', 'rc-s73-preflight.mjs', 'rc-s73-device-runner.mjs']) {
    const src = readFileSync(tool(f), 'utf8');
    // Ambil argumen setiap `run(...)` dengan pencocokan kurung seimbang (bukan regex naif).
    const panggil = [];
    for (const m of src.matchAll(/(?<![\w.])run\(/g)) {
      let d = 0, j = m.index + 3;
      for (; j < src.length; j++) { if (src[j] === '(') d++; else if (src[j] === ')' && --d === 0) break; }
      panggil.push(src.slice(m.index, j + 1));
    }
    ok(panggil.length > 0, `${f}: run() tidak ditemukan`);
    for (const p of panggil) ok(/timeout:/.test(p), `${f}: run tanpa timeout: ${p.slice(0, 80)}`);
    ok(!/spawnSync|execSync|execFileSync/.test(src), `${f}: memakai API sinkron tanpa kontrak timeout`);
  }
});

// ===========================================================================
// timeout handling (Case A–D)
// ===========================================================================
await uji('timeout handling', 'Case A: executable tersedia & sukses -> PASS', async () => { const r = await run('sh', ['-c', 'echo hai'], { timeout: 5000 }); eq([r.state, r.stdout, classify(r)], ['OK', 'hai', S.PASS]); });
await uji('timeout handling', 'Case B: executable tidak ada -> run.state MISSING -> BLOCKED (juga dengan entri PATH tak teraksesibel)', async () => {
  const r = await run('perintah-yang-tidak-ada-rcs73', [], { timeout: 5000 });
  eq([r.state, classify(r)], ['MISSING', S.BLOCKED], 'PATH normal');
  // Kondisi nyata (mis. WSL): PATH memuat direktori tanpa izin akses. `execvp` melaporkan EACCES
  // untuk executable yang tidak ada; kontrak run() tetap harus MISSING. (Sebagai root, kernel
  // tidak menolak akses direktori — subkasus ini reproduktif pada user non-root.)
  const tertutup = mkdtempSync(join(TMP, 'noaccess-')); chmodSync(tertutup, 0o000);
  const r2 = await run('perintah-yang-tidak-ada-rcs73', [], { timeout: 5000, env: { PATH: `${tertutup}:${process.env.PATH}` } });
  chmodSync(tertutup, 0o700);
  eq([r2.state, classify(r2)], ['MISSING', S.BLOCKED], 'PATH dengan direktori tak teraksesibel');
});
await uji('timeout handling', 'Case C: exit non-zero -> FAIL (stderr & exit code tertangkap)', async () => { const r = await run('sh', ['-c', 'echo rusak >&2; exit 3'], { timeout: 5000 }); eq([r.state, r.code, r.stderr, classify(r)], ['NONZERO', 3, 'rusak', S.FAIL]); });
await uji('timeout handling', 'Case D: timeout -> selesai terbatas; BLOCKED (probe) / FAIL (verifikasi)', async () => {
  const t0 = Date.now();
  const r = await run('sh', ['-c', `${SLEEP} 30`], { timeout: 400 });
  ok(Date.now() - t0 < 6000, `terlalu lama: ${Date.now() - t0} ms`);
  eq([r.state, classify(r), classify(r, { timeoutAs: S.FAIL })], ['TIMEOUT', S.BLOCKED, S.FAIL]);
});
await uji('timeout handling', 'timeout menghentikan SELURUH process group (tanpa proses yatim)', async () => {
  // Penanda unik per run: proses sisa dari run LAIN tidak memengaruhi uji ini.
  // Durasi unik per run sebagai penanda (tanpa `exec -a`, yang tidak ada di dash).
  const unik = `${process.pid % 1000}${Date.now() % 100000}`;
  const cucu = `41.${unik}`, anak = `42.${unik}`;
  await run('sh', ['-c', `${SLEEP} ${cucu} & ${SLEEP} ${anak}`], { timeout: 400 });
  await new Promise((r) => setTimeout(r, 300));
  const ps = await run('ps', ['-eo', 'pid,args'], { timeout: 5000 });
  ok(ps.state === 'OK', 'ps tidak tersedia');
  ok(!ps.stdout.includes(cucu) && !ps.stdout.includes(anak), 'proses anak/cucu masih hidup setelah timeout');
});
await uji('timeout handling', 'cucu yang memegang pipe tidak membuat run() menggantung', async () => {
  const t0 = Date.now();
  const r = await run('sh', ['-c', `(${SLEEP} 30 &) ; ${SLEEP} 30`], { timeout: 400 });
  eq(r.state, 'TIMEOUT'); ok(Date.now() - t0 < 6000, `${Date.now() - t0} ms`);
});
await uji('timeout handling', 'timeout Infinity / 0 / tanpa timeout ditolak', () => {
  for (const t of [Infinity, 0, -1, undefined, NaN, 7 * 3_600_000]) { let lempar = false; try { run('sh', ['-c', 'true'], { timeout: t }); } catch { lempar = true; } ok(lempar, `timeout ${t} diterima`); }
});

// ===========================================================================
// configuration parser (formulir)
// ===========================================================================
await uji('configuration parser', 'template: 19 butir NOT RUN, tanpa PASS, memuat Run ID', () => {
  const t = formTemplate({ runId: 'r-1' }); const f = parseForm(t);
  eq(f.errors, []); ok(D_ITEMS.every((d) => f.items[d.id] === S.NOT_RUN), 'bukan NOT RUN'); ok(!/^D\d+ = PASS/m.test(t), 'memuat PASS'); eq(f.meta['Run ID'], 'r-1');
});
await uji('configuration parser', 'nilai tidak sah ditolak (PASS WITH LIMITATIONS, WARN, READY, kosong)', () => {
  let t = formTemplate({});
  t = t.replace(/^D2 = .*$/m, 'D2 = PASS WITH LIMITATIONS').replace(/^D3 = .*$/m, 'D3 = WARN').replace(/^D4 = .*$/m, 'D4 = READY').replace(/^D5 = .*$/m, 'D5 =');
  const f = parseForm(t);
  for (const id of ['D2', 'D3', 'D4', 'D5']) { ok(f.errors.some((e) => e.startsWith(id)), `${id} lolos`); eq(f.items[id], S.NOT_RUN, id); }
});
await uji('configuration parser', 'FAIL wajib detail lengkap; placeholder dianggap kosong', () => {
  let t = formTemplate({}).replace(/^D8 = .*$/m, 'D8 = FAIL');
  ok(parseForm(t).errors.some((e) => /D8 FAIL tanpa detail/.test(e)), 'tanpa detail lolos');
  ok(parseForm(t + '\nD8-Reproduction: <langkah persis>\nD8-Expected: a\nD8-Actual: b\nD8-Screenshot: c\nD8-Logcat: d\nD8-Severity: P1\n').errors.length > 0, 'placeholder lolos');
  eq(parseForm(t + '\nD8-Reproduction: x\nD8-Expected: a\nD8-Actual: b\nD8-Screenshot: c\nD8-Logcat: d\nD8-Severity: P1\n').errors, []);
});
await uji('configuration parser', 'butir ganda/hilang terdeteksi; setFormItem terlokalisasi', () => {
  const e = parseForm(formTemplate({}).replace(/^D5 = .*$\n/m, '') + '\nD6 = PASS\n').errors;
  ok(e.some((x) => /D5 tidak ditemukan/.test(x)) && e.some((x) => /D6 diisi lebih dari sekali/.test(x)), e.join(';'));
  const f = parseForm(setFormItem(formTemplate({}), 'D1', S.PASS));
  eq(f.items.D1, S.PASS); ok(D_ITEMS.filter((d) => d.id !== 'D1').every((d) => f.items[d.id] === S.NOT_RUN), 'butir lain berubah');
});

// ===========================================================================
// decision engine (Case I–K, dynamic count, mandatory logic)
// ===========================================================================
const bersih = () => ({
  evidenceConsistency: { status: S.PASS, issues: [] }, environment: { status: S.PASS }, build: { status: S.PASS },
  automated: { typescript: { status: S.PASS }, jest: { status: S.PASS }, rcS71: { status: S.PASS }, selftest: { status: S.PASS } },
  device: { precondition: S.PASS, install: { status: S.PASS }, logcat: { status: S.PASS }, form: { items: Object.fromEntries(D_ITEMS.map((d) => [d.id, S.PASS])), details: {}, meta: {}, errors: [] } },
  database: { status: S.PASS },
});
await uji('decision engine', 'Case I: semua gate PASS -> PASS / CLEAR', () => { const { finalDecision: f } = decide(bersih()); eq([f.status, f.release, f.primaryReason], [S.PASS, 'CLEAR', null]); });
await uji('decision engine', 'Case J/K: SETIAP gate tunggal FAIL/BLOCKED/NOT RUN -> NOT READY', () => {
  const total = decide(bersih()).gates.length; let n = 0;
  for (const st of [S.FAIL, S.BLOCKED, S.NOT_RUN]) {
    for (const i of decide(bersih()).gates.map((g) => g.id)) {
      const e = bersih();
      if (i === 'SCHEMA') { if (st !== S.FAIL) { n++; continue; } e.build.status = 'UNKNOWN'; }
      else if (i === 'TOOLING') e.automated.selftest.status = st;
      else if (i === 'EVIDENCE') e.evidenceConsistency.status = st; else if (i === 'ENV') e.environment.status = st; else if (i === 'BUILD') e.build.status = st;
      else if (i === 'TS') e.automated.typescript.status = st; else if (i === 'JEST') e.automated.jest.status = st; else if (i === 'RCS71') e.automated.rcS71.status = st;
      else if (i === 'LOGCAT') e.device.logcat.status = st; else if (i === 'FORM') { if (st === S.NOT_RUN) e.device.form = null; else e.device.form.errors = ['x']; }
      else e.device.form.items[i] = st;
      const d = decide(e).finalDecision; ok(d.status === 'NOT READY' && d.primaryReason, `${i}=${st} lolos atau tanpa alasan`); n++;
    }
  }
  eq(n, total * 3);
});
await uji('decision engine', '24/26 PASS tetap NOT READY (tanpa ambang jumlah)', () => { const e = bersih(); e.device.form.items.D17 = S.BLOCKED; e.device.form.items.D2 = S.NOT_RUN; const d = decide(e).finalDecision; eq(d.status, 'NOT READY'); eq(d.counts.PASS, d.counts.total - 2); });
await uji('decision engine', 'jumlah gate dinamis = struktur data', () => {
  const { gates, finalDecision: f } = decide(bersih());
  eq(f.counts.total, gates.length); eq(f.counts.PASS + f.counts.FAIL + f.counts.BLOCKED + f.counts['NOT RUN'], gates.length); eq(gates.length, 10 + D_ITEMS.length);
});
await uji('decision engine', 'reason code deterministik dan spesifik', () => {
  const kasus = [
    [(e) => { e.automated.jest.status = S.FAIL; }, REASON.AUTOMATED_REGRESSION_FAILED],
    [(e) => { e.device.form.items.D8 = S.FAIL; e.device.form.details.D8 = {}; }, REASON.DEVICE_GATE_FAILED],
    [(e) => { e.database.status = S.FAIL; }, REASON.DB_INTEGRITY_FAILED],
    [(e) => { e.device.precondition = S.BLOCKED; }, REASON.DEVICE_VERIFICATION_BLOCKED],
    [(e) => { e.build.status = S.BLOCKED; }, REASON.BUILD_BLOCKED],
    [(e) => { e.device.form.items.D5 = S.NOT_RUN; }, REASON.DEVICE_GATE_NOT_RUN],
    [(e) => { e.evidenceConsistency.status = S.BLOCKED; }, REASON.EVIDENCE_STALE],
  ];
  for (const [mut, harap] of kasus) { const e = bersih(); mut(e); eq(decide(e).finalDecision.primaryReason, harap); }
});
await uji('decision engine', 'hanya dua keputusan yang mungkin', () => {
  const set = new Set(); for (const st of S ? Object.values(S) : []) { const e = bersih(); e.automated.jest.status = st; set.add(decide(e).finalDecision.status); }
  eq([...set].sort(), ['NOT READY', 'PASS']);
});

// ===========================================================================
// no-fake-pass rule (Case G, H, §25)
// ===========================================================================
await uji('no-fake-pass rule', 'Case G: D1 tanpa bukti install -> tidak PASS', () => {
  const e = bersih(); e.device.install.status = S.NOT_RUN; eq(decide(e).gates.find((g) => g.id === 'D1').status, S.BLOCKED);
  const e2 = bersih(); e2.device.form.items.D1 = S.NOT_RUN; e2.device.install.status = S.NOT_RUN; eq(decide(e2).gates.find((g) => g.id === 'D1').status, S.NOT_RUN);
});
await uji('no-fake-pass rule', 'Case H: automated RC-S71 PASS + D11 belum diuji -> D11 NOT RUN', () => {
  const e = bersih(); e.device.form.items.D11 = S.NOT_RUN; const g = decide(e).gates.find((x) => x.id === 'D11');
  eq(g.status, S.NOT_RUN); eq(decide(e).finalDecision.status, 'NOT READY');
});
await uji('no-fake-pass rule', '§25: prasyarat perangkat bukan PASS -> TIDAK ADA D1–D19 yang PASS walau formulir PASS', () => {
  for (const pre of [S.BLOCKED, S.NOT_RUN, S.FAIL]) { const e = bersih(); e.device.precondition = pre; ok(decide(e).gates.filter((g) => g.category === 'device-gate').every((g) => g.status !== S.PASS), `pre=${pre}`); }
});
await uji('no-fake-pass rule', 'bukti otomatis/statis/SQL-fixture tidak pernah mengangkat gate perangkat', () => {
  for (const d of D_ITEMS) eq(finalItem(d, { form: S.NOT_RUN, precondition: S.PASS, machine: S.PASS }).status, S.NOT_RUN, d.id);
});
await uji('no-fake-pass rule', 'D19: formulir PASS tetapi DB perangkat NOT RUN -> tidak PASS', () => {
  const e = bersih(); e.database.status = S.NOT_RUN; eq(decide(e).gates.find((g) => g.id === 'D19').status, S.BLOCKED);
});

// ===========================================================================
// database checks
// ===========================================================================
const schemaSql = readFileSync(join(ROOT, 'src/database/schema.ts'), 'utf8').match(/export const CREATE_TABLES_SQL = `([\s\S]*?)`;/)[1];
function fixtureDb(nama, mutasi = () => {}) {
  const p = join(TMP, nama); const db = new DatabaseSync(p);
  db.exec(schemaSql);
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL); INSERT INTO schema_meta VALUES (1, 69);');
  const now = '2026-04-05T00:00:00Z';
  db.exec(`INSERT INTO app_user (id,nama,username,role,pin_hash,pin_salt,created_at,updated_at) VALUES ('u1','A','a','ADMIN','x','x','${now}','${now}')`);
  db.exec(`INSERT INTO accounting_period (id,tahun_buku,periode_mulai,periode_selesai,status) VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`);
  for (const [id, kode, kat, nb] of [['a-beban', '5-1950', 'BEBAN', 'DEBIT'], ['a-ub', '2-1700', 'LIABILITAS', 'KREDIT'], ['a-kas', '1-1000', 'ASET', 'DEBIT']]) db.exec(`INSERT INTO account (id,kode,nama,kategori,normal_balance,created_at,updated_at) VALUES ('${id}','${kode}','${kode}','${kat}','${nb}','${now}','${now}')`);
  db.exec(`INSERT INTO utang (id,nomor_utang,nama_pemberi,jenis_pemberi,pokok_pinjaman,persen_bunga,jenis_bunga,basis_bunga,tanggal,created_by,created_at,updated_at) VALUES ('utg1','UTG-1','Bank','BANK',120000000,12,'FLAT','TAHUNAN','2026-01-01','u1','${now}','${now}')`);
  for (const [n, per, tgl] of [[1, '2026-01', '2026-01-31'], [2, '2026-02', '2026-02-28'], [3, '2026-03', '2026-03-31']]) {
    db.exec(`INSERT INTO journal (id,nomor_jurnal,tanggal,period_id,sumber_transaksi,sumber_id,deskripsi,status,created_by,created_at,updated_at) VALUES ('j${n}','JRN-${n}','${tgl}','p2026','UTANG_BUNGA','utg1','Akrual (otomatis)','POSTED','u1','${now}','${now}')`);
    db.exec(`INSERT INTO journal_entry (id,journal_id,account_id,debit,kredit,urutan) VALUES ('e${n}a','j${n}','a-beban',1200000,0,0),('e${n}b','j${n}','a-ub',0,1200000,1)`);
    db.exec(`INSERT INTO utang_bunga_akrual (id,utang_id,periode,tipe_akrual,mode,basis_bunga,jenis_bunga,persen_bunga,dasar_perhitungan,nominal_target,nominal_dibukukan,tanggal_jurnal,journal_id,idempotency_key,created_by,created_at) VALUES ('s${n}','utg1','${per}','BUNGA_BULANAN','AUTO','TAHUNAN','FLAT',12,120000000,1200000,1200000,'${tgl}','j${n}','UTANG_BUNGA:utg1:${per}:BUNGA_BULANAN','u1','${now}')`);
  }
  mutasi(db); db.close(); return p;
}
const dbHasil = [];
await uji('database checks', 'SQL terurai menjadi 12 cek berlabel', () => eq(splitSqlChecks(readFileSync(tool('rc-s73-device-checks.sql'), 'utf8')).map((x) => x.id), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12']));
await uji('database checks', 'DB fixture sehat -> semua PASS', async () => { const r = await runDbChecks(fixtureDb('baik.db')); eq(r.checks.filter((c) => c.status !== S.PASS).map((c) => c.id), []); dbHasil.push(true); });
for (const [nama, id, mut] of [
  ['jurnal akrual ganda', 'C3', (db) => { db.exec(`INSERT INTO journal (id,nomor_jurnal,tanggal,period_id,sumber_transaksi,sumber_id,deskripsi,status,created_by,created_at,updated_at) VALUES ('jd','JRN-D','2026-01-31','p2026','UTANG_BUNGA','utg1','dup','POSTED','u1','x','x')`); db.exec(`INSERT INTO journal_entry (id,journal_id,account_id,debit,kredit,urutan) VALUES ('ed1','jd','a-beban',1200000,0,0),('ed2','jd','a-ub',0,1200000,1)`); }],
  ['arah Dr/Cr terbalik', 'C4', (db) => { db.exec(`UPDATE journal_entry SET debit=0, kredit=1200000 WHERE id='e1a'`); db.exec(`UPDATE journal_entry SET debit=1200000, kredit=0 WHERE id='e1b'`); }],
  ['subledger ≠ jurnal', 'C5', (db) => db.exec(`UPDATE utang_bunga_akrual SET nominal_dibukukan=1000000 WHERE id='s2'`)],
  ['total bukan 3.600.000', 'C6', (db) => db.exec(`DELETE FROM utang_bunga_akrual WHERE id='s3'`)],
  ['jurnal tidak seimbang', 'C7', (db) => db.exec(`UPDATE journal_entry SET kredit=1100000 WHERE id='e3b'`)],
  ['posting ke periode CLOSED', 'C8', (db) => db.exec(`UPDATE accounting_period SET status='CLOSED', closed_at='2026-01-01T00:00:00Z' WHERE id='p2026'`)],
  ['skema bukan 69', 'C1', (db) => db.exec('UPDATE schema_meta SET version=68')],
]) {
  await uji('database checks', `${nama} -> ${id} FAIL`, async () => { const r = await runDbChecks(fixtureDb(`${id}.db`, mut)); eq(r.checks.find((c) => c.id === id).status, S.FAIL, id); eq(r.status, S.FAIL); dbHasil.push(true); });
}
await uji('database checks', 'DB-check read-only', async () => { const p = fixtureDb('ro.db'); const a = readFileSync(p); await runDbChecks(p); ok(Buffer.compare(a, readFileSync(p)) === 0, 'berkas berubah'); });
fixtureDbStatus = hasil['database checks'].every((x) => x.ok) ? S.PASS : S.FAIL;

// ===========================================================================
// blocked-state handling (Case E, F; adb/eas non-blocking)
// ===========================================================================
function lingkunganPalsu(nama, { adbDevices = null, adbHang = false, installOut = 'Success', eas = true, npm = true }) {
  const dir = join(TMP, nama), bin = join(dir, 'bin'), sdk = join(dir, 'sdk'), out = join(dir, 'out');
  mkdirSync(bin, { recursive: true }); mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
  if (npm) sh(bin, 'npm', 'echo 10.0.0');
  if (adbDevices || adbHang) sh(bin, 'adb', `case "$*" in
  version) echo "Android Debug Bridge version 1.0.41";;
  "devices"|"devices -l") ${adbHang ? `${SLEEP} 60` : `printf '%s\\n' "List of devices attached" ${(adbDevices ?? []).map((d) => `"${d}"`).join(' ')}`};;
  *"ro.product.manufacturer"*) echo Samsung;; *"ro.product.model"*) echo SM-A155F;;
  *"ro.build.version.release"*) echo 14;; *"ro.build.version.sdk"*) echo 34;;
  *uninstall*) echo "Failure [DELETE_FAILED_INTERNAL_ERROR]"; exit 1;;
  *" install "*) echo "${installOut}"; [ "${installOut}" = "Success" ];;
  *"pm list packages"*) echo "package:id.koperasi.finance";;
  *) exit 0;; esac`);
  if (eas) sh(bin, 'eas', 'case "$*" in --version) echo "eas-cli/16.0.0";; whoami) echo tester;; *) exit 0;; esac');
  // PATH HANYA berisi bin palsu: biner nyata di mesin penguji tidak ikut memengaruhi uji.
  return { out, env: { PATH: bin, ANDROID_HOME: sdk, RC_S73_OUT: out, RC_S73_REPORT: join(dir, 'r.md'), RC_S73_TIMEOUT_SCALE: '0.05' } };
}
const jalankan = (f, args, env, timeout = 60_000) => { GRAFIK.push({ tool: f, path: env.PATH ?? null, scale: env.RC_S73_TIMEOUT_SCALE ?? null }); return run(NODE, [tool(f), ...args], { timeout, env }); };
const envJson = (L) => JSON.parse(readFileSync(join(L.out, 'environment.json'), 'utf8'));
const cek = (L, id) => envJson(L).checks.find((c) => c.id === id);
async function sesi(L) { const r = await jalankan('rc-s73-session.mjs', ['new'], L.env); eq(r.state, 'OK', 'session new'); }

await uji('blocked-state handling', 'adb tidak ada -> adb BLOCKED, device BLOCKED, selesai normal (exit 2)', async () => {
  const L = lingkunganPalsu('noadb', {}); await sesi(L);
  const r = await jalankan('rc-s73-environment-check.mjs', [], L.env);
  eq([r.state, r.code], ['NONZERO', 2]); eq([cek(L, 'adb').status, cek(L, 'device').status, envJson(L).status], [S.BLOCKED, S.BLOCKED, S.BLOCKED]);
});
await uji('blocked-state handling', 'Case E: adb ada, tanpa perangkat -> adb PASS, device BLOCKED', async () => {
  const L = lingkunganPalsu('nodev', { adbDevices: [] }); await sesi(L); await jalankan('rc-s73-environment-check.mjs', [], L.env);
  eq([cek(L, 'adb').status, cek(L, 'device').status], [S.PASS, S.BLOCKED]);
});
await uji('blocked-state handling', 'perangkat unauthorized / offline -> BLOCKED (bukan FAIL aplikasi)', async () => {
  for (const st of ['unauthorized', 'offline']) { const L = lingkunganPalsu(`dev-${st}`, { adbDevices: [`R58XYZ\t${st}`] }); await sesi(L); await jalankan('rc-s73-environment-check.mjs', [], L.env); eq(cek(L, 'device').status, S.BLOCKED, st); ok(cek(L, 'device').detail.includes(st), 'alasan hilang'); }
});
await uji('blocked-state handling', 'hanya emulator -> device BLOCKED (emulator tidak menggantikan fisik)', async () => {
  const L = lingkunganPalsu('emu', { adbDevices: ['emulator-5554\tdevice'] }); await sesi(L); await jalankan('rc-s73-environment-check.mjs', [], L.env); eq(cek(L, 'device').status, S.BLOCKED);
});
await uji('blocked-state handling', '`adb devices` menggantung -> BLOCKED dalam batas waktu, tidak hang', async () => {
  const L = lingkunganPalsu('adbhang', { adbHang: true }); await sesi(L);
  const t0 = Date.now(); const r = await jalankan('rc-s73-environment-check.mjs', [], L.env, 30_000);
  ok(r.state !== 'TIMEOUT', 'environment check menggantung'); ok(Date.now() - t0 < 20_000, `${Date.now() - t0} ms`); eq(cek(L, 'device').status, S.BLOCKED); ok(/TIMEOUT/.test(cek(L, 'device').detail), cek(L, 'device').detail);
});
await uji('blocked-state handling', 'EAS CLI tidak ada -> EAS & auth BLOCKED, tanpa retry', async () => {
  const L = lingkunganPalsu('noeas', { adbDevices: [], eas: false }); await sesi(L); await jalankan('rc-s73-environment-check.mjs', [], L.env);
  eq([cek(L, 'eas').status, cek(L, 'auth').status], [S.BLOCKED, S.BLOCKED]);
});
await uji('blocked-state handling', 'Case F: perangkat fisik siap -> prasyarat PASS; serial mentah tidak tersimpan', async () => {
  const L = lingkunganPalsu('ready', { adbDevices: ['R58M12345XYZ\tdevice usb:1-1'] }); await sesi(L);
  await jalankan('rc-s73-environment-check.mjs', [], L.env);
  const j = envJson(L); eq([j.status, j.devicePrecondition, j.device.apiLevel], [S.PASS, S.PASS, '34']);
  ok(!readFileSync(join(L.out, 'environment.json'), 'utf8').includes('R58M12345XYZ'), 'serial mentah tersimpan');
});
await uji('blocked-state handling', 'install: tanpa perangkat BLOCKED · gagal FAIL · Success -> hanya D1 berubah', async () => {
  const apk = join(TMP, 'app.apk'); writeFileSync(apk, 'PK');
  const L0 = lingkunganPalsu('inst-none', { adbDevices: [] }); await sesi(L0); await jalankan('rc-s73-device-runner.mjs', ['init'], L0.env);
  eq((await jalankan('rc-s73-device-runner.mjs', ['install', '--apk', apk], L0.env)).code, 2);
  const L1 = lingkunganPalsu('inst-fail', { adbDevices: ['R58\tdevice'], installOut: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]' }); await sesi(L1); await jalankan('rc-s73-device-runner.mjs', ['init'], L1.env);
  eq((await jalankan('rc-s73-device-runner.mjs', ['install', '--apk', apk], L1.env)).code, 1);
  const L2 = lingkunganPalsu('inst-ok', { adbDevices: ['R58\tdevice'] }); await sesi(L2); await jalankan('rc-s73-device-runner.mjs', ['init'], L2.env);
  eq((await jalankan('rc-s73-device-runner.mjs', ['install', '--apk', apk], L2.env)).code, 0);
  const f = parseForm(readFileSync(join(L2.out, 'RC-S73.1_DEVICE_RESULT.md'), 'utf8'));
  eq(f.items.D1, S.PASS); ok(D_ITEMS.filter((d) => d.id !== 'D1').every((d) => f.items[d.id] === S.NOT_RUN), 'butir lain terisi');
});
await uji('blocked-state handling', 'record-build: AAB ditolak (FAIL), APK preview PASS', async () => {
  const L = lingkunganPalsu('build', {}); await sesi(L);
  eq((await jalankan('rc-s73-device-runner.mjs', ['record-build', '--build-id', 'b1', '--url', 'u', '--artifact-url', 'https://x/app.aab'], L.env)).code, 1);
  eq((await jalankan('rc-s73-device-runner.mjs', ['record-build', '--build-id', 'b2', '--url', 'u', '--artifact-url', 'https://x/app.apk'], L.env)).code, 0);
});
await uji('blocked-state handling', 'tanpa sesi aktif -> BLOCKED (exit 2), bukan crash', async () => {
  const L = lingkunganPalsu('nosesi', {});
  eq((await jalankan('rc-s73-environment-check.mjs', [], L.env)).code, 2); eq((await jalankan('rc-s73-evidence.mjs', [], L.env)).code, 2);
});
await uji('blocked-state handling', 'logcat: tanpa START NOT RUN · START sesi lain NOT RUN · bersih PASS · FATAL FAIL', () => {
  eq(scanLogcat('', 'r1').status, S.NOT_RUN);
  eq(scanLogcat(`${LOGCAT_START} run=r0\n${LOGCAT_END}`, 'r1').status, S.NOT_RUN);
  eq(scanLogcat(`${LOGCAT_START} run=r1\n${LOGCAT_END}`, 'r1').status, S.PASS);
  eq(scanLogcat(`${LOGCAT_START} run=r1\nE AndroidRuntime: FATAL EXCEPTION: main\n`, 'r1').status, S.FAIL);
});

// ===========================================================================
// skenario evidence end-to-end (§28, §33) — report schema & stale protection
// ===========================================================================
const LANGKAH_PF = ['install', 'tooling', 'typescript', 'jest', 'rc-s71', 'bundle', 'package-config', 'schema', 'no-migration', 'no-accrual-menu', 'one-writer'];
async function skenario(nama, o = {}) {
  const out = join(TMP, `sk-${nama}`); const rep = join(TMP, `sk-${nama}.md`);
  process.env.RC_S73_OUT = out; process.env.RC_S73_REPORT = rep;
  writeFileSync(rep, 'LAPORAN LAMA YANG HARUS DIHAPUS');
  const r0 = newRun({ reportPath: rep });
  ok(!existsSync(rep), 'laporan lama tidak dihapus oleh sesi baru');
  const pre = o.pre ?? S.PASS;
  if (o.env !== false) writeComponent('environment.json', { status: o.envStatus ?? (pre === S.PASS ? S.PASS : S.BLOCKED), devicePrecondition: pre, checks: [{ id: 'device', label: 'Device (fisik)', status: pre, detail: 'fixture', required: true }], device: pre === S.PASS ? { model: 'Samsung SM-A155F', androidVersion: '14', apiLevel: '34', deviceId: 'dev-0' } : null });
  if (o.preflight !== false) writeComponent('preflight.json', { status: S.PASS, steps: Object.fromEntries(LANGKAH_PF.map((k) => [k, { status: S.PASS, detail: 'fixture', partial: false }])) });
  if (o.build !== false) writeComponent('build.json', { status: o.buildStatus ?? S.PASS, buildId: 'b-1', buildUrl: 'u', artifact: 'APK', appVersion: '1.0.0' });
  if (o.install !== false) writeComponent('install.json', { status: o.installStatus ?? (pre === S.PASS ? S.PASS : S.BLOCKED) });
  if (o.logcat !== false) writeComponent('logcat.json', { status: pre === S.PASS ? S.PASS : S.NOT_RUN, critical: 0, sample: [] });
  if (o.db !== false) {
    const semua = splitSqlChecks(readFileSync(tool('rc-s73-device-checks.sql'), 'utf8')).map((x) => x.id);
    const checks = semua.filter((id) => !(o.dbOmit ?? []).includes(id)).map((id) => ({ id, label: id, status: o.dbCheckStatus?.[id] ?? o.dbStatus ?? S.PASS, note: '' }));
    writeComponent('db-checks.json', { status: o.dbStatus ?? S.PASS, source: 'fixture', checks });
  }
  writeComponent('selftest.json', { status: S.PASS, dbFixture: S.PASS, passed: 1, total: 1 });
  if (o.form !== false) {
    let t = formTemplate({ runId: o.formRunId ?? r0.runId, build: { buildId: o.formBuildId ?? 'b-1' } });
    for (const d of D_ITEMS) t = setFormItem(t, d.id, o.items?.[d.id] ?? (pre === S.PASS ? S.PASS : d.id === 'D1' ? S.BLOCKED : S.NOT_RUN));
    writeFileSync(join(out, 'RC-S73.1_DEVICE_RESULT.md'), (o.formTransform ?? ((x) => x))(t + (o.formExtra ?? '')));
  }
  o.sebelumCollect?.(out);
  const ev = writeComponent('evidence.json', collect());
  o.sesudahCollect?.(out);
  const r = await run(NODE, [tool('rc-s73-final-report.mjs')], { timeout: 60_000, env: { RC_S73_OUT: out, RC_S73_REPORT: rep } });
  return { ev, out, rep, code: r.code, stdout: r.stdout, md: existsSync(rep) ? readFileSync(rep, 'utf8') : '' };
}
const stempel = (out, file, patch) => { const p = join(out, file); const j = JSON.parse(readFileSync(p, 'utf8')); Object.assign(j._stamp, patch); writeFileSync(p, JSON.stringify(j)); };

await uji('report schema', 'Skenario A (all PASS) -> FINAL PASS, exit 0, semua bagian §36', async () => {
  const s = await skenario('A');
  eq([s.ev.finalDecision.status, s.code], [S.PASS, 0], s.stdout);
  for (const h of ['SOURCE BASELINE', 'ENVIRONMENT', 'BUILD VERIFICATION', 'AUTOMATED VERIFICATION', 'DEVICE VERIFICATION', 'DATABASE VERIFICATION', 'D1-D19', 'FINDINGS', 'FIXES', 'OUT OF SCOPE', 'FINAL DECISION']) ok(s.md.includes(`## ${h}`), `bagian ${h}`);
  ok(s.md.includes('RC-S73.1.3 = PASS\nRELEASE = CLEAR'), 'keputusan');
  for (const k of ['Tooling', 'Automated', 'Environment', 'Build', 'Device', 'Database Device']) ok(new RegExp(`^${k} +\\= PASS$`, 'm').test(s.md), `ringkasan ${k}`);
  for (const h of ['BUILD VERIFICATION', 'ARTIFACTS']) ok(s.md.includes(`## ${h}`), `bagian ${h}`);
});
await uji('no-fake-pass rule', 'Skenario B (device BLOCKED) -> NOT READY; D1 BLOCKED, D2–D19 NOT RUN; akrual Device NOT RUN', async () => {
  const s = await skenario('B', { pre: S.BLOCKED, db: false });
  eq([s.ev.finalDecision.status, s.ev.finalDecision.primaryReason, s.code], ['NOT READY', REASON.DEVICE_VERIFICATION_BLOCKED, 2]);
  const G = (id) => s.ev.gates.find((g) => g.id === id).status;
  eq(G('D1'), S.BLOCKED); ok(D_ITEMS.slice(1).every((d) => G(d.id) === S.NOT_RUN), 'D2–D19 bukan NOT RUN');
  ok(/\| Accrual Dr 5-1950[^\n]*\| PASS \| NOT RUN \| C4=NOT RUN C5=NOT RUN \| NOT READY \|/.test(s.md), 'baris akrual tidak jujur');
  ok(/\| Automated SQL validation \(fixture self-test\) \| PASS \|\n\| Device extracted DB \| NOT RUN \|\n\| D19 \| NOT RUN \|/.test(s.md), 'lapisan DB tidak terpisah');
  ok(!/di perangkat: D11/.test(s.md), 'prosa hardcoded perangkat');
});
await uji('no-fake-pass rule', 'Skenario B2: formulir PASS semua tetapi perangkat BLOCKED -> tidak ada D yang PASS', async () => {
  const s = await skenario('B2', { pre: S.BLOCKED, items: Object.fromEntries(D_ITEMS.map((d) => [d.id, S.PASS])) });
  ok(s.ev.gates.filter((g) => g.category === 'device-gate').every((g) => g.status !== S.PASS), 'ada D PASS'); ok(s.code !== 0, 'exit 0');
});
await uji('report schema', 'Skenario C (device FAIL dengan detail) -> NOT READY, exit 1, FINDINGS berisi detail', async () => {
  const s = await skenario('C', { items: { D8: S.FAIL }, formExtra: '\nD8-Reproduction: edit tujuan\nD8-Expected: tersimpan\nD8-Actual: hilang\nD8-Screenshot: d8.png\nD8-Logcat: -\nD8-Severity: P1\n' });
  eq([s.ev.finalDecision.status, s.ev.finalDecision.primaryReason, s.code], ['NOT READY', REASON.DEVICE_GATE_FAILED, 1]);
  ok(s.md.includes('### D8 Pinjaman edit regression — P1') && s.md.includes('**Actual:** hilang'), 'FINDINGS');
});
await uji('no-fake-pass rule', 'Skenario D (automated PASS + device NOT RUN) -> NOT READY, DEVICE_GATE_NOT_RUN', async () => {
  const s = await skenario('D', { items: Object.fromEntries(D_ITEMS.map((d) => [d.id, d.id === 'D1' ? S.PASS : S.NOT_RUN])) });
  eq([s.ev.finalDecision.status, s.ev.finalDecision.primaryReason], ['NOT READY', REASON.DEVICE_GATE_NOT_RUN]);
  ok(/^Automated +\= PASS$/m.test(s.md), 'lapisan otomatis'); ok(!/^Device +\= PASS$/m.test(s.md), 'perangkat PASS palsu');
});
await uji('report schema', 'database NOT RUN vs PASS dibedakan', async () => {
  const a = await skenario('dbnr', { db: false }); eq(a.ev.gates.find((g) => g.id === 'D19').status, S.BLOCKED); eq(a.ev.database.status, S.NOT_RUN);
  const b = await skenario('dbfail', { dbStatus: S.FAIL }); eq([b.ev.gates.find((g) => g.id === 'D19').status, b.ev.finalDecision.primaryReason], [S.FAIL, REASON.DB_INTEGRITY_FAILED]);
});
await uji('report schema', 'bukti parsial (hanya lingkungan + preflight) -> NOT READY; sisa NOT RUN', async () => {
  const s = await skenario('partial', { build: false, install: false, logcat: false, db: false, form: false });
  eq(s.ev.finalDecision.status, 'NOT READY'); eq(s.ev.gates.find((g) => g.id === 'FORM').status, S.NOT_RUN); eq(s.ev.gates.find((g) => g.id === 'BUILD').status, S.NOT_RUN);
});
await uji('report schema', 'jumlah gate di laporan = hasil hitung (dinamis)', async () => {
  const s = await skenario('count', { pre: S.BLOCKED, db: false }); const c = s.ev.finalDecision.counts;
  ok(s.md.includes(`Mandatory gates = ${c.total}\nPASS = ${c.PASS}\nFAIL = ${c.FAIL}\nBLOCKED = ${c.BLOCKED}\nNOT RUN = ${c['NOT RUN']}`), 'hitungan'); eq(c.total, s.ev.gates.length);
});
await uji('report schema', 'tanpa istilah terlarang di laporan', async () => {
  const s = await skenario('kata', { pre: S.BLOCKED });
  for (const k of ['PASS WITH LIMITATIONS', 'ALMOST PASS', 'PROBABLY PASS', 'PASS EXCEPT DEVICE', 'READY PENDING DEVICE', 'nearly ready', 'should work', 'looks good', '[WARN]']) ok(!s.md.includes(k), k);
});
await uji('stale-evidence protection', 'Skenario E: komponen dari sesi lain (campuran) -> Evidence FAIL, NOT READY', async () => {
  // RC-S73.1.2 §17: bukti campuran antar-run = pelanggaran integritas -> FAIL (dulu BLOCKED).
  const s = await skenario('E', { sebelumCollect: (out) => stempel(out, 'db-checks.json', { runId: 'sesi-lama' }) });
  eq([s.ev.evidenceConsistency.status, s.ev.finalDecision.status, s.ev.finalDecision.primaryReason], [S.FAIL, 'NOT READY', REASON.EVIDENCE_STALE]); eq(s.ev.database.status, S.NOT_RUN);
});
await uji('stale-evidence protection', 'usang (source/timestamp) -> BLOCKED; campuran (Run ID/Build ID formulir) -> FAIL', async () => {
  for (const [n, o, harap] of [
    ['src', { sebelumCollect: (out) => stempel(out, 'preflight.json', { sourceVersion: 'deadbeefdeadbeef' }) }, S.BLOCKED],
    ['future', { sebelumCollect: (out) => stempel(out, 'environment.json', { generatedAt: '2099-01-01T00:00:00Z' }) }, S.BLOCKED],
    ['formrun', { formRunId: 'run-lain' }, S.FAIL],
    ['buildid', { formBuildId: 'b-lain' }, S.FAIL],
  ]) { const s = await skenario(`E-${n}`, o); eq([s.ev.evidenceConsistency.status, s.ev.finalDecision.status], [harap, 'NOT READY'], n); }
});
await uji('stale-evidence protection', 'evidence dimodifikasi (keputusan dipalsukan PASS) -> REPORT BLOCKED, exit 2', async () => {
  const s = await skenario('tamper', { pre: S.BLOCKED, sesudahCollect: (out) => { const p = join(out, 'evidence.json'); const j = JSON.parse(readFileSync(p, 'utf8')); j.finalDecision.status = 'PASS'; j.finalDecision.release = 'CLEAR'; writeFileSync(p, JSON.stringify(j)); } });
  eq(s.code, 2); ok(s.md.includes('REPORT = BLOCKED') && !s.md.includes('RELEASE = CLEAR'), 'pemalsuan lolos');
});
await uji('stale-evidence protection', 'evidence.json tidak ada -> REPORT BLOCKED; generator tidak menulis evidence', async () => {
  const s = await skenario('missing', { sesudahCollect: (out) => rmSync(join(out, 'evidence.json')) });
  eq(s.code, 2); ok(s.md.includes('REPORT = BLOCKED'), 'laporan'); ok(!existsSync(join(TMP, 'sk-missing', 'evidence.json')), 'generator menulis evidence');
});
await uji('stale-evidence protection', 'sesi baru membersihkan direktori (fresh output)', async () => {
  const out = join(TMP, 'fresh'); process.env.RC_S73_OUT = out; newRun({ reportPath: join(TMP, 'fresh.md') });
  writeFileSync(join(out, 'rc-s73-logcat.txt'), 'lama'); writeFileSync(join(out, 'evidence.json'), '{}'); const r1 = readRun();
  newRun({ reportPath: join(TMP, 'fresh.md') });
  ok(!existsSync(join(out, 'rc-s73-logcat.txt')) && !existsSync(join(out, 'evidence.json')), 'artifact lama tertinggal'); ok(readRun().runId !== r1.runId, 'runId sama');
});


// ===========================================================================
// audit diagnostic (diperkenalkan RC-S73.1.2) — 15+ skenario deterministik
// ===========================================================================
async function audit(s) {
  const r = await run(NODE, [tool('rc-s73-audit-diagnostic.mjs')], { timeout: 60_000, env: { RC_S73_OUT: s.out, RC_S73_REPORT: s.rep, RC_S73_AUDIT_REPORT: `${s.rep}.audit.md` } });
  const p = join(s.out, 'audit-diagnostic.json');
  return { code: r.code, stdout: r.stdout, j: existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null, md: existsSync(`${s.rep}.audit.md`) ? readFileSync(`${s.rep}.audit.md`, 'utf8') : '' };
}
const gd = (a, id) => a.j.gates.find((g) => g.gate === id);
const FAILDET = (id) => `\n${id}-Reproduction: x\n${id}-Expected: a\n${id}-Actual: b\n${id}-Screenshot: c\n${id}-Logcat: d\n${id}-Severity: P1\n`;
const semuaD = (st) => Object.fromEntries(D_ITEMS.map((d) => [d.id, st]));

await uji('audit diagnostic', '#1 all pass -> APPLICATION PASS, exit 0, tooling PASS, laporan konsisten', async () => {
  const a = await audit(await skenario('au1'));
  eq([a.code, a.j.application.status, a.j.tooling.status, a.j.reportCrossCheck.consistent], [0, S.PASS, S.PASS, true], a.stdout);
  ok(a.j.gates.every((g) => g.final === S.PASS && g.why), 'gate belum PASS / why kosong'); eq(a.j.missingEvidence, []);
});
await uji('audit diagnostic', '#2 device blocked (+build blocked) -> D1 BLOCKED, D2–D19 NOT RUN, TOOLING PASS / APP NOT READY', async () => {
  const a = await audit(await skenario('au2', { pre: S.BLOCKED, buildStatus: S.BLOCKED, db: false }));
  eq([a.code, a.j.tooling.status, a.j.application.status, a.j.application.primaryReason], [2, S.PASS, 'NOT READY', REASON.DEVICE_VERIFICATION_BLOCKED]);
  for (const r of [REASON.BUILD_BLOCKED, REASON.DEVICE_GATE_NOT_RUN]) ok(a.j.application.reasons.includes(r), r);
  eq(gd(a, D_ITEMS[0].id).status, S.BLOCKED);
  for (const d of D_ITEMS.slice(1)) { eq(gd(a, d.id).status, S.NOT_RUN, d.id); ok(a.j.notRunGates.includes(gd(a, d.id).name), `${d.id} tidak terdaftar eksplisit`); }
});
await uji('audit diagnostic', '#3 build blocked saja -> BUILD_BLOCKED', async () => {
  const a = await audit(await skenario('au3', { buildStatus: S.BLOCKED }));
  eq([a.j.application.status, a.j.application.primaryReason], ['NOT READY', REASON.BUILD_BLOCKED]); ok(gd(a, 'BUILD').remediation.includes('device-runner build'), 'remediasi');
});
for (const [n, id] of [['#4', 'D11'], ['#5', 'D12'], ['#6', 'D14'], ['#7', 'D17']]) {
  await uji('audit diagnostic', `${n} ${id} NOT RUN (lainnya PASS) -> NOT READY; missing ${id}; bukan "gagal"`, async () => {
    const a = await audit(await skenario(`au-${id}`, { items: { [id]: S.NOT_RUN } }));
    const g = gd(a, id);
    eq([a.j.application.status, a.j.application.primaryReason, g.status, g.final], ['NOT READY', REASON.DEVICE_GATE_NOT_RUN, S.NOT_RUN, 'NOT READY']);
    eq(g.missingEvidence, [id]); eq(g.failedEvidence, []); eq(g.severity, 'MANDATORY GATE');
    ok(!g.explanation.join(' ').includes('GAGAL') && g.explanation.join(' ').includes('bukan kegagalan'), 'penjelasan menyiratkan gagal');
    ok(g.remediation === D_ITEMS.find((d) => d.id === id).action, 'remediasi tidak dari graf');
  });
}
await uji('audit diagnostic', '#8 D19 NOT RUN (DB perangkat belum ada) -> missing device-db', async () => {
  const id = D_ITEMS.find((d) => d.machine === 'database').id;
  const a = await audit(await skenario('au8', { db: false, items: { [id]: S.NOT_RUN } }));
  const g = gd(a, id);
  eq([g.status, g.evidence.database, g.evidence.automated], [S.NOT_RUN, S.NOT_RUN, S.PASS]); ok(g.missingEvidence.includes('device-db'), g.missingEvidence.join());
});
await uji('audit diagnostic', '#9 device FAIL (D11/D12/D14/D17 masing-masing) -> DEVICE_GATE_FAILED', async () => {
  for (const id of ['D11', 'D12', 'D14', 'D17']) {
    const a = await audit(await skenario(`au9-${id}`, { items: { [id]: S.FAIL }, formExtra: FAILDET(id) }));
    eq([a.j.application.status, a.j.application.primaryReason, gd(a, id).final], ['NOT READY', REASON.DEVICE_GATE_FAILED, S.FAIL], id);
    ok(gd(a, id).failedEvidence.includes(id), 'failedEvidence');
  }
});
await uji('audit diagnostic', '#10 DB FAIL -> DB_INTEGRITY_FAILED (D19 FAIL)', async () => {
  const a = await audit(await skenario('au10', { dbStatus: S.FAIL }));
  eq([a.j.application.primaryReason, gd(a, D_ITEMS.find((d) => d.machine === 'database').id).final], [REASON.DB_INTEGRITY_FAILED, S.FAIL]);
});
await uji('audit diagnostic', '#11 stale (sourceVersion lain) -> Evidence BLOCKED, APP NOT READY', async () => {
  const a = await audit(await skenario('au11', { sebelumCollect: (out) => stempel(out, 'build.json', { sourceVersion: '0000000000000000' }) }));
  eq([gd(a, 'EVIDENCE').status, a.j.application.status, a.j.application.primaryReason], [S.BLOCKED, 'NOT READY', REASON.EVIDENCE_STALE]);
});
await uji('audit diagnostic', '#12 mixed-run (formulir Run A, DB Run B, build Run C) -> Evidence FAIL', async () => {
  const a = await audit(await skenario('au12', { formRunId: 'run-A', sebelumCollect: (out) => { stempel(out, 'db-checks.json', { runId: 'run-B' }); stempel(out, 'build.json', { runId: 'run-C' }); } }));
  eq([gd(a, 'EVIDENCE').status, a.j.application.status], [S.FAIL, 'NOT READY']);
  ok(a.j.gates.filter((g) => D_ITEMS.some((d) => d.id === g.gate)).every((g) => g.status !== S.PASS), 'bukti campuran dipakai');
});
await uji('audit diagnostic', '#13 bukti hilang (D11, D17, C6) -> MISSING D11, D17, C6; tanpa default PASS', async () => {
  const a = await audit(await skenario('au13', { dbOmit: ['C6'], formTransform: (t) => t.replace(/^D11 = .*\n/m, '').replace(/^D17 = .*\n/m, '') }));
  for (const m of ['D11', 'D17', 'C6']) ok(a.j.missingEvidence.includes(m), `missing ${m}`);
  eq([a.j.application.status, gd(a, 'D11').status, gd(a, 'D17').status], ['NOT READY', S.NOT_RUN, S.NOT_RUN]);
  eq(a.j.gates.find((g) => g.gate === D_ITEMS.find((d) => d.machine === 'database').id).evidence.database, S.NOT_RUN);
});
await uji('audit diagnostic', '#14 status tidak sah (UNKNOWN/READY/WARNING/PARTIAL) -> SCHEMA FAIL', async () => {
  const a = await audit(await skenario('au14', { installStatus: 'UNKNOWN', buildStatus: 'READY', envStatus: 'PARTIAL', dbCheckStatus: { C3: 'WARNING' } }));
  const g = gd(a, 'SCHEMA');
  eq([g.status, a.j.application.status, a.j.application.primaryReason], [S.FAIL, 'NOT READY', REASON.EVIDENCE_SCHEMA_INVALID]);
  for (const x of ['UNKNOWN', 'READY', 'PARTIAL', 'WARNING']) ok(g.why.includes(x), `skema tidak menyebut ${x}`);
});
await uji('audit diagnostic', '#15 automated PASS + device NOT RUN -> NOT READY; 19 gate NOT RUN terdaftar eksplisit', async () => {
  const a = await audit(await skenario('au15', { items: semuaD(S.NOT_RUN), installStatus: S.NOT_RUN, db: false }));
  eq([a.j.application.status, a.j.layers.automated], ['NOT READY', S.PASS]);
  for (const d of D_ITEMS) ok(a.j.notRunGates.includes(gd(a, d.id).name), `${d.id} tidak terdaftar`);
  ok(a.md.includes('NOT RUN (') && D_ITEMS.every((d) => a.md.includes(`- ${gd(a, d.id).name}`)), 'daftar NOT RUN tidak dicetak');
});
await uji('audit diagnostic', 'single-gate BLOCKED (D11/D12/D14/D17/D19) -> NOT READY, gate disebut', async () => {
  for (const id of ['D11', 'D12', 'D14', 'D17', 'D19']) {
    const a = await audit(await skenario(`au-bl-${id}`, { items: { [id]: S.BLOCKED }, formExtra: `\n${id}-reason: fixture\n` }));
    eq(a.j.application.status, 'NOT READY', id); ok(a.j.blockedGates.includes(gd(a, id).name), `${id} tidak disebut`);
  }
});
await uji('audit diagnostic', 'kondisi terkini (tanpa perangkat): D11/D12/D14/D17 NOT READY dengan missing tepat', async () => {
  const a = await audit(await skenario('aucur', { pre: S.BLOCKED, buildStatus: S.BLOCKED, db: false }));
  const harap = { D11: ['D11', 'C4', 'C5', 'C6'], D12: ['D12', 'C2', 'C3'], D14: ['D14'], D17: ['D17', 'C8'] };
  for (const [id, m] of Object.entries(harap)) { const g = gd(a, id); eq([g.evidence.automated, g.final], [S.PASS, 'NOT READY'], id); eq(g.missingEvidence, m, id); ok(g.blockers.includes(REASON.DEVICE_VERIFICATION_BLOCKED), id); }
  eq(gd(a, 'D14').evidence.database, 'N/A');
  eq(a.j.nextActions.length, new Set(a.j.nextActions).size); ok(!a.j.nextActions.some((x) => x.includes(' Lalu: ')), 'tindakan tidak dipecah');
  const d19 = D_ITEMS.find((d) => d.machine === 'database').id; eq(gd(a, d19).status, S.NOT_RUN);
  // Case-sensitive: "bukan kegagalan" (penegasan) tidak boleh terhitung sebagai klaim gagal.
  ok(!/GAGAL|\bfailed\b/.test(a.j.gates.flatMap((g) => g.explanation).join(' ')), 'menyiratkan kegagalan tanpa bukti FAIL');
});
const statusApp = (e) => diagnose({ ...e, ...decide(e) }).application.status;
const stateA = () => { const A = bersih(); A.device.form.items = semuaD(S.NOT_RUN); A.device.install.status = S.NOT_RUN; A.device.logcat.status = S.NOT_RUN; A.database.status = S.NOT_RUN; return A; };
await uji('audit diagnostic', 'REQ19 transisi NOT READY → PASS (bukti perangkat & DB masuk)', () => { eq([statusApp(stateA()), statusApp(bersih())], ['NOT READY', S.PASS]); });
await uji('audit diagnostic', 'REQ20 transisi PASS → FAIL (satu bukti FAIL) -> NOT READY', () => {
  const C = bersih(); C.device.form.items.D11 = S.FAIL; C.device.form.details.D11 = {};
  eq([statusApp(bersih()), statusApp(C)], [S.PASS, 'NOT READY']);
});
await uji('audit diagnostic', 'REQ21 transisi PASS → BLOCKED (satu bukti BLOCKED) -> NOT READY', () => {
  const D = bersih(); D.device.form.items.D11 = S.BLOCKED;
  eq([statusApp(bersih()), statusApp(D)], [S.PASS, 'NOT READY']);
});
await uji('audit diagnostic', 'REQ17 false-PASS: otomatis PASS, perangkat & DB NOT RUN -> tidak pernah PASS', () => { ok(statusApp(stateA()) !== S.PASS, 'false-pass'); });
await uji('audit diagnostic', 'REQ18 false-FAIL: semua bukti PASS -> PASS (tidak terlalu ketat)', () => { eq(statusApp(bersih()), S.PASS); });
await uji('audit diagnostic', 'REQ2 semua NOT RUN -> NOT READY; semua gate perangkat NOT RUN', () => {
  const e = { evidenceConsistency: { status: S.PASS, issues: [] } };
  const { gates, finalDecision } = decide(e);
  eq(finalDecision.status, 'NOT READY'); ok(gates.filter((g) => g.category === 'device-gate').every((g) => g.status === S.NOT_RUN), 'bukan NOT RUN');
});
await uji('stale-evidence protection', 'REQ13 versi tooling berbeda -> Evidence BLOCKED, NOT READY', async () => {
  const s = await skenario('stool', { sebelumCollect: (out) => stempel(out, 'preflight.json', { testRunnerVersion: 'RC-S73.1.2+0000000000000000' }) });
  eq([s.ev.evidenceConsistency.status, s.ev.finalDecision.status], [S.BLOCKED, 'NOT READY']);
});
await uji('stale-evidence protection', 'evidence skema lama (rc-s73.1.1) -> laporan BLOCKED & audit tidak percaya', async () => {
  const s = await skenario('oldschema', { sesudahCollect: (out) => { const p = join(out, 'evidence.json'); const j = JSON.parse(readFileSync(p, 'utf8')); j.schema = 'rc-s73.1.1/evidence@1'; writeFileSync(p, JSON.stringify(j)); } });
  ok(s.md.includes('REPORT = BLOCKED'), 'laporan menerima skema lama'); eq(s.code, 2);
  const a = await audit(s); eq([a.j.evidenceTrusted, a.j.application.status], [false, 'NOT READY']);
});
await uji('audit diagnostic', 'read-only: evidence.json tidak berubah; tidak ada bukti baru dibuat', async () => {
  const s = await skenario('auro', { pre: S.BLOCKED });
  const { readdirSync } = await import('node:fs');
  const sebelum = readFileSync(join(s.out, 'evidence.json')); const fs0 = readdirSync(s.out).sort();
  await audit(s);
  ok(Buffer.compare(sebelum, readFileSync(join(s.out, 'evidence.json'))) === 0, 'evidence berubah');
  eq(readdirSync(s.out).sort().filter((f) => !fs0.includes(f)), ['audit-diagnostic.json']);
});
await uji('audit diagnostic', 'evidence dipalsukan PASS -> audit tidak percaya bukti, APP NOT READY', async () => {
  const s = await skenario('autamper', { pre: S.BLOCKED, sesudahCollect: (out) => { const p = join(out, 'evidence.json'); const j = JSON.parse(readFileSync(p, 'utf8')); j.finalDecision.status = 'PASS'; writeFileSync(p, JSON.stringify(j)); } });
  const a = await audit(s); eq([a.j.evidenceTrusted, a.j.application.status], [false, 'NOT READY']);
});
await uji('audit diagnostic', 'laporan final dimanipulasi -> cross-check TIDAK KONSISTEN, exit 1', async () => {
  const s = await skenario('aux', { pre: S.BLOCKED });
  const asli = readFileSync(s.rep, 'utf8');
  const i = asli.indexOf('## FINAL DECISION');
  const nama = D_ITEMS.find((d) => d.support?.includes('db:C4')).name; // gate akrual, dari graf
  const palsu = asli.slice(0, i) + asli.slice(i).replace(new RegExp(`\\| (D\\d+ ${nama}) \\| NOT RUN \\|`), '| $1 | PASS |');
  ok(palsu !== asli, 'manipulasi tidak terjadi — uji akan kosong');
  writeFileSync(s.rep, palsu);
  const a = await audit(s); eq([a.code, a.j.reportCrossCheck.consistent], [1, false]);
});
await uji('audit diagnostic', 'tanpa hardcode: audit & laporan tidak memuat ID gate literal', () => {
  for (const f of ['rc-s73-audit-diagnostic.mjs', 'rc-s73-final-report.mjs']) ok(!/['"`]D\d{1,2}['"`]/.test(readFileSync(tool(f), 'utf8')), `${f} memuat ID gate literal`);
});


// ===========================================================================
// self-test lifecycle (RC-S73.1.3 §3–§8, §29) — no-hang, no-real-env, exit
// ===========================================================================
await uji('self-test lifecycle', 'SELFTEST_NO_REAL_ENV: default tidak menjalankan lingkungan nyata', () => {
  // Berlaku di semua mode: uji framework tidak pernah memakai lingkungan nyata;
  // diagnostik --real-env baru berjalan SETELAH seluruh uji framework selesai.
  const env = GRAFIK.filter((g) => g.tool === 'rc-s73-environment-check.mjs');
  ok(env.length > 0, 'grafik eksekusi kosong — uji akan kosong');
  for (const g of env) { ok(g.path && g.path.startsWith(TMP), `environment-check dijalankan dengan PATH nyata: ${g.path}`); ok(g.scale, 'probe tanpa skala timeout uji'); }
  const src = readFileSync(tool('rc-s73-selftest.mjs'), 'utf8');
  ok(/if \(REAL_ENV\) \{/.test(src), 'blok lingkungan nyata tidak dijaga flag --real-env');
});
const PS = ['/bin/ps', '/usr/bin/ps'].find((p) => existsSync(p));
async function salinanSelftest(extraEnv) {
  const bin = mkdtempSync(join(TMP, 'sterile-'));
  symlinkSync('/bin/sh', join(bin, 'sh'));
  if (PS) symlinkSync(PS, join(bin, 'ps'));
  // PATH steril: tanpa adb, eas, npx, emulator; SDK dikosongkan.
  const env = { PATH: bin, ANDROID_HOME: '', ANDROID_SDK_ROOT: '', RC_S73_SELFTEST_CHILD: '1', RC_S73_OUT: '', RC_S73_REPORT: '', ...extraEnv };
  const t0 = Date.now();
  const r = await run(NODE, [tool('rc-s73-selftest.mjs')], { timeout: 180_000, env });
  return { ...r, ms: Date.now() - t0, bin };
}
let anak = null, anakGagal = null;
if (!CHILD) [anak, anakGagal] = await Promise.all([salinanSelftest({}), salinanSelftest({ RC_S73_SELFTEST_INJECT_FAIL: '1' })]);
const anakOk = () => { ok(anak, 'salinan self-test tidak dijalankan'); ok(anak.state !== 'TIMEOUT', `menggantung (${anak.ms} ms)`); eq(anak.code, 0, String(anak.stdout).split('\n').filter((l) => /✗|FAIL/.test(l)).slice(0, 4).join(' | ')); ok(/SELF-TEST STATUS = PASS/.test(anak.stdout), 'status bukan PASS'); };
if (!CHILD) {
  await uji('self-test lifecycle', 'SELFTEST_COMPLETES_WITHOUT_ADB', () => { anakOk(); ok(!existsSync(join(anak.bin, 'adb')), 'adb ada di PATH steril'); });
  await uji('self-test lifecycle', 'SELFTEST_COMPLETES_WITHOUT_EAS', () => { anakOk(); ok(!existsSync(join(anak.bin, 'eas')) && !existsSync(join(anak.bin, 'npx')), 'eas/npx ada di PATH steril'); });
  await uji('self-test lifecycle', 'SELFTEST_COMPLETES_WITHOUT_SDK', () => {
    anakOk();
    ok(!/Environment \(real\) — diagnostik/.test(anak.stdout), 'salinan menjalankan lingkungan nyata');
    ok(/Environment \(real\): NOT RUN/.test(anak.stdout), 'salinan tidak menyatakan lingkungan nyata NOT RUN');
  });
  await uji('self-test lifecycle', 'kontrak exit: framework PASS -> 0; defect framework -> 1 (bukan hang)', () => {
    eq(anak.code, 0); ok(anakGagal && anakGagal.state !== 'TIMEOUT', 'salinan defect menggantung');
    eq(anakGagal.code, 1); ok(/SELF-TEST STATUS = FAIL/.test(anakGagal.stdout), 'status defect tidak FAIL');
  });
}
if (INJECT_FAIL) await uji('self-test lifecycle', 'kegagalan sintetis (RC_S73_SELFTEST_INJECT_FAIL)', () => { throw new Error('disuntikkan untuk uji kontrak exit'); });
await uji('self-test lifecycle', 'REQ30 kontrak exit tool: PASS 0 · FAIL 1 · NOT READY/BLOCKED 2', async () => {
  const a = await skenario('ex-pass'); const b = await skenario('ex-fail', { items: { D8: S.FAIL }, formExtra: FAILDET('D8') }); const c = await skenario('ex-bl', { pre: S.BLOCKED });
  eq([a.code, b.code, c.code], [0, 1, 2], 'final-report');
  eq([(await audit(a)).code, (await audit(c)).code], [0, 2], 'audit');
  const L = lingkunganPalsu('ex-env', {});
  eq((await jalankan('rc-s73-session.mjs', ['show'], L.env)).code, 2, 'session show tanpa sesi');
  await sesi(L); eq((await jalankan('rc-s73-environment-check.mjs', [], L.env)).code, 2, 'environment BLOCKED');
});
await uji('self-test lifecycle', 'watchdog dibersihkan tepat setelah uji framework, sebelum lingkungan nyata & exit', () => {
  const src = readFileSync(tool('rc-s73-selftest.mjs'), 'utf8');
  // Hanya pernyataan di awal baris yang dihitung (bukan string di dalam uji ini).
  const pernyataan = [...src.matchAll(/^clearTimeout\(watchdog\);/gm)];
  const iReal = src.search(/^if \(REAL_ENV\) \{/m), iExit = src.search(/^process\.exit\(/m);
  ok(pernyataan.length === 1, `watchdog dibersihkan ${pernyataan.length}x (harus 1x)`);
  ok(iReal > pernyataan[0].index && iExit > pernyataan[0].index, 'urutan lifecycle salah');
});

// ===========================================================================
// ringkasan
// ===========================================================================
clearTimeout(watchdog); // uji framework selesai: watchdog tidak boleh tetap hidup
let total = 0, lulus = 0;
console.log('RC-S73.1.3 SELF-TEST\n');
for (const k of KAT) {
  const xs = hasil[k]; total += xs.length; lulus += xs.filter((x) => x.ok).length;
  console.log(`[${xs.length && xs.every((x) => x.ok) ? 'PASS' : 'FAIL'}] ${k} (${xs.filter((x) => x.ok).length}/${xs.length})`);
  for (const x of xs.filter((y) => !y.ok)) console.log(`       ✗ ${x.nama}\n         ${x.err}`);
}
// --- 30 kasus wajib (§36): setiap kasus dipetakan ke uji nyata di atas.
const semua = KAT.flatMap((k) => hasil[k]);
const REQ = [
  [1, 'all-pass decision', ['Case I:', '#1 all pass']], [2, 'all-not-run decision', ['REQ2 ']], [3, 'device blocked', ['#2 device blocked']],
  [4, 'build blocked', ['#3 build blocked']], [5, 'D11 NOT RUN', ['#4 D11']], [6, 'D12 NOT RUN', ['#5 D12']], [7, 'D14 NOT RUN', ['#6 D14']],
  [8, 'D17 NOT RUN', ['#7 D17']], [9, 'D19 NOT RUN', ['#8 D19']], [10, 'device FAIL', ['#9 device FAIL']], [11, 'DB FAIL', ['#10 DB FAIL']],
  [12, 'stale source', ['#11 stale']], [13, 'stale tooling', ['REQ13 ']], [14, 'mixed run', ['#12 mixed-run']], [15, 'missing evidence', ['#13 bukti hilang']],
  [16, 'invalid state', ['#14 status tidak sah']], [17, 'false PASS', ['REQ17 ']], [18, 'false FAIL', ['REQ18 ']],
  [19, 'transition NOT READY → PASS', ['REQ19 ']], [20, 'transition PASS → FAIL', ['REQ20 ']], [21, 'transition PASS → BLOCKED', ['REQ21 ']],
  [22, 'audit read-only', ['read-only:']], [23, 'report consistency', ['laporan final dimanipulasi', '#1 all pass']],
  [24, 'real-env NOT REQUIRED for default self-test', ['SELFTEST_NO_REAL_ENV']],
  [25, 'self-test terminates without adb', CHILD ? ['SELFTEST_NO_REAL_ENV'] : ['SELFTEST_COMPLETES_WITHOUT_ADB']],
  [26, 'self-test terminates without EAS', CHILD ? ['SELFTEST_NO_REAL_ENV'] : ['SELFTEST_COMPLETES_WITHOUT_EAS']],
  [27, 'self-test terminates without SDK', CHILD ? ['SELFTEST_NO_REAL_ENV'] : ['SELFTEST_COMPLETES_WITHOUT_SDK']],
  [28, 'timeout kills child process group', ['timeout menghentikan SELURUH process group']],
  [29, 'timeout does not leave orphan', ['cucu yang memegang pipe', 'timeout menghentikan SELURUH process group']],
  [30, 'EXIT codes correct', CHILD ? ['REQ30 '] : ['REQ30 ', 'kontrak exit: framework PASS']],
];
const reqHasil = REQ.map(([n, nama, pref]) => {
  const cocok = semua.filter((t) => pref.some((p) => t.nama.startsWith(p)));
  return { n, nama, ok: cocok.length >= pref.length && cocok.every((t) => t.ok) };
});
const reqLulus = reqHasil.filter((r) => r.ok).length;
console.log(`\n[${reqLulus === REQ.length ? 'PASS' : 'FAIL'}] REQUIRED CASES ${reqLulus}/${REQ.length}`);
for (const r of reqHasil.filter((x) => !x.ok)) console.log(`       ✗ ${r.n}. ${r.nama}`);
const frameworkOk = lulus === total && total > 0 && reqLulus === REQ.length;

// Lingkungan NYATA — HANYA dengan --real-env (diagnostik; tidak memengaruhi status framework).
if (REAL_ENV) {
  console.log('\nEnvironment (real) — diagnostik mesin ini, tidak memengaruhi status framework:');
  const out = join(TMP, 'real-env');
  const base = { RC_S73_OUT: out, RC_S73_REPORT: join(TMP, 'real.md') };
  await run(NODE, [tool('rc-s73-session.mjs'), 'new'], { timeout: 30_000, env: base });
  const r = await run(NODE, [tool('rc-s73-environment-check.mjs')], { timeout: 180_000, env: base });
  if (existsSync(join(out, 'environment.json'))) {
    for (const c of JSON.parse(readFileSync(join(out, 'environment.json'), 'utf8')).checks) if (['adb', 'sdk', 'device', 'eas', 'auth'].includes(c.id)) console.log(`[${c.status}] ${c.label}`);
  } else console.log(`[BLOCKED] environment check (${r.state})`);
} else {
  console.log('\nEnvironment (real): NOT RUN — default self-test hanya menguji framework (pakai --real-env untuk diagnostik).');
}

if (RECORD) {
  if (ORIG_OUT) process.env.RC_S73_OUT = ORIG_OUT; else delete process.env.RC_S73_OUT;
  delete process.env.RC_S73_REPORT;
  if (readRun()) { writeComponent('selftest.json', { status: frameworkOk ? S.PASS : S.FAIL, dbFixture: fixtureDbStatus, passed: lulus, total }); console.log('\nHasil self-test dicatat ke sesi aktif (bukti TOOLING, bukan bukti perangkat).'); }
  else console.log('\n--record: tidak ada sesi aktif; hasil tidak dicatat.');
}
rmSync(TMP, { recursive: true, force: true });
console.log(`\nSELF-TEST STATUS = ${frameworkOk ? 'PASS' : 'FAIL'}  (${lulus}/${total})`);
console.log('Catatan: SELF-TEST PASS ≠ DEVICE PASS. Status rilis aplikasi ditentukan oleh bukti perangkat.');
process.exit(frameworkOk ? 0 : 1);

// RC-S73.1.3 — pustaka bersama tooling verifikasi rilis.
//
// TOOLING SAJA: tidak diimpor aplikasi, tidak menyentuh business logic, tidak
// menulis ke database aplikasi. Node murni (>= 22, memakai node:sqlite).
//
// Kontrak inti:
//   - Status gate hanya PASS | FAIL | BLOCKED | NOT RUN.
//       PASS    requirement tersedia dan berhasil diverifikasi
//       FAIL    requirement tersedia tetapi verifikasi gagal (defect)
//       BLOCKED verifikasi tidak dapat dilakukan (dependency/lingkungan tidak ada)
//       NOT RUN gate belum dieksekusi
//   - Setiap proses eksternal memakai `run()` dengan timeout TERBATAS dan wajib;
//     saat timeout seluruh process group dihentikan dan hasil tetap dikembalikan.
//   - Bukti otomatis/statis/SQL-fixture TIDAK PERNAH mengubah gate perangkat
//     menjadi PASS. Gate perangkat hanya PASS dari observasi perangkat.
//   - `evidence.json` = satu-satunya sumber kebenaran; laporan hanya membaca.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_LABEL = 'RC-S73.1.3';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = () => (process.env.RC_S73_OUT ? resolve(process.env.RC_S73_OUT) : join(ROOT, 'rc-s73-out'));
export const DEFAULT_REPORT = () => process.env.RC_S73_REPORT ? resolve(process.env.RC_S73_REPORT) : join(ROOT, 'RC-S73.1.3_FINAL_RELEASE_REPORT.md');
export const PACKAGE_ID = 'id.koperasi.finance';
export const EXPECTED_SCHEMA = 69;
export const EXPECTED_SUITES = 253;
export const EXPECTED_TESTS = 4642;
export const EXPECTED_RC_S71 = 34;
export const EVIDENCE_SCHEMA = 'rc-s73.1.3/evidence@1';

export const S = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', BLOCKED: 'BLOCKED', NOT_RUN: 'NOT RUN' });
export const GATE_STATES = Object.freeze([S.PASS, S.FAIL, S.BLOCKED, S.NOT_RUN]);

/** Exit code (§29). */
export const EXIT = Object.freeze({ OK: 0, FAIL: 1, BLOCKED: 2 });

/**
 * Batas waktu standar (ms) — semuanya terbatas. `RC_S73_TIMEOUT_SCALE`
 * (0 < s <= 1) hanya dapat MEMPERPENDEK (dipakai self-test untuk menguji probe
 * yang menggantung); nilai lain diabaikan. Minimum efektif 200 ms.
 */
const SCALE = (() => { const x = Number(process.env.RC_S73_TIMEOUT_SCALE); return Number.isFinite(x) && x > 0 && x <= 1 ? x : 1; })();
const skala = (o) => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, ms]) => [k, Math.max(200, Math.round(ms * SCALE))])));
export const TIMEOUT = skala({
  version: 15_000, adbList: 20_000, adbProp: 10_000, adbInstall: 300_000, easWhoami: 30_000,
  emulatorList: 15_000, npmCi: 900_000, tsc: 900_000, jestShard: 1_800_000, jestFull: 7_200_000,
  jestGate: 600_000, expoExport: 1_800_000, easBuild: 4 * 3_600_000, dbPull: 120_000, selftest: 600_000, envCheck: 300_000,
});
export const MAX_TIMEOUT = 6 * 3_600_000;

// ---------------------------------------------------------------------------
// PROSES EKSTERNAL — RUN → START → TIMEOUT WATCH → EXIT/ERROR/TIMEOUT → NORMALIZE
// ---------------------------------------------------------------------------

/**
 * Cari executable di PATH seperti shell, tetapi entri PATH yang tidak dapat
 * diakses (EACCES, bukan direktori, tidak ada) DILEWATI. Tanpa ini, `execvp`
 * melaporkan EACCES — bukan ENOENT — untuk executable yang sama sekali tidak ada
 * bila PATH memuat direktori tak teraksesibel (umum di WSL / mount), sehingga
 * "tidak ada" salah terbaca sebagai ERROR.
 * @returns {string|null} path yang ditemukan, atau null bila tidak ada di mana pun.
 */
export function resolveExecutable(cmd, { PATH = process.env.PATH ?? '', cwd = ROOT, PATHEXT = process.env.PATHEXT } = {}) {
  const ada = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
  const exts = process.platform === 'win32' ? ['', ...String(PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')] : [''];
  if (cmd.includes('/') || (process.platform === 'win32' && cmd.includes('\\'))) {
    const p = isAbsolute(cmd) ? cmd : join(cwd, cmd);
    return exts.map((e) => p + e).find(ada) ?? null;
  }
  for (const dir of String(PATH).split(delimiter).filter(Boolean)) {
    const hit = exts.map((e) => join(dir, cmd + e)).find(ada);
    if (hit) return hit;
  }
  return null;
}

/**
 * Kontrak status:
 *   executable ada + proses selesai exit 0      -> OK
 *   executable TIDAK ada di mana pun            -> MISSING  (tanpa spawn)
 *   executable ada + exit non-zero              -> NONZERO
 *   executable ada tetapi gagal dijalankan      -> ERROR    (mis. EACCES pada berkas tanpa bit eksekusi)
 *   melewati batas waktu                        -> TIMEOUT
 * @returns {Promise<{state:'OK'|'NONZERO'|'MISSING'|'TIMEOUT'|'ERROR', code:number|null, signal:string|null,
 *                    stdout:string|Buffer, stderr:string, ms:number, error:string|null}>}
 */
export function run(cmd, args = [], opts = {}) {
  const { timeout } = opts;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT) {
    throw new TypeError(`run(${cmd}): timeout wajib terbatas (0 < t <= ${MAX_TIMEOUT} ms), didapat ${timeout}`);
  }
  const binary = !!opts.binary;
  const maxOut = opts.maxOutput ?? 64 * 1024 * 1024;
  const t0 = Date.now();
  return new Promise((resolveP) => {
    let selesai = false, timedOut = false, outLen = 0, err = '';
    const out = [];
    let watch = null, paksa = null;
    const done = (r) => {
      if (selesai) return;
      selesai = true;
      clearTimeout(watch); clearTimeout(paksa);
      const buf = Buffer.concat(out);
      resolveP({ stdout: binary ? buf : buf.toString('utf8').trim(), stderr: err.trim(), ms: Date.now() - t0, code: null, signal: null, error: null, ...r });
    };
    const env = { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1', ...(opts.env ?? {}) };
    if (!resolveExecutable(cmd, { PATH: env.PATH ?? '', cwd: opts.cwd ?? ROOT, PATHEXT: env.PATHEXT })) {
      return done({ state: 'MISSING', error: `ENOENT executable tidak ditemukan: ${cmd}` });
    }
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd ?? ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'], // tidak pernah menunggu input interaktif
        detached: process.platform !== 'win32', // process group sendiri -> dihentikan utuh
      });
    } catch (e) {
      return done({ state: e.code === 'ENOENT' ? 'MISSING' : 'ERROR', error: `${e.code ?? ''} ${e.message}`.trim() });
    }
    const killTree = (sig) => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, sig); else child.kill(sig); }
      catch { try { child.kill(sig); } catch { /* sudah berhenti */ } }
    };
    watch = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      paksa = setTimeout(() => {
        killTree('SIGKILL');
        // Pipe bisa tetap terbuka oleh proses liar; jangan menunggunya tanpa batas.
        setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); done({ state: 'TIMEOUT', error: `timeout ${timeout} ms` }); }, 1000);
      }, 2000);
    }, timeout);
    child.stdout.on('data', (b) => { if (outLen < maxOut) { out.push(b); outLen += b.length; } });
    child.stderr.on('data', (b) => { if (err.length < 1_000_000) err += b.toString(); });
    child.on('error', (e) => done({ state: e.code === 'ENOENT' ? 'MISSING' : 'ERROR', error: `${e.code ?? ''} ${e.message}`.trim() }));
    child.on('close', (code, signal) => {
      if (timedOut) { killTree('SIGKILL'); return done({ state: 'TIMEOUT', code, signal, error: `timeout ${timeout} ms` }); }
      done({ state: code === 0 ? 'OK' : 'NONZERO', code, signal });
    });
  });
}

/**
 * Normalisasi hasil `run()` menjadi status gate.
 *   OK -> PASS · MISSING/ERROR (lingkungan) -> BLOCKED · NONZERO -> FAIL
 *   TIMEOUT -> `timeoutAs` (probe lingkungan: BLOCKED; langkah verifikasi: FAIL)
 */
export function classify(r, { timeoutAs = S.BLOCKED } = {}) {
  switch (r.state) {
    case 'OK': return S.PASS;
    case 'NONZERO': return S.FAIL;
    case 'TIMEOUT': return timeoutAs;
    default: return S.BLOCKED; // MISSING / ERROR
  }
}

// ---------------------------------------------------------------------------
// VERSI & SESI (anti-stale)
// ---------------------------------------------------------------------------

const SOURCE_ITEMS = ['src', 'app', 'package.json', 'package-lock.json', 'app.json', 'eas.json', 'tsconfig.json', 'babel.config.js', 'jest.config.js'];

function hashTree(items, base = ROOT) {
  const h = createHash('sha256');
  const files = [];
  const walk = (p) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) { for (const n of readdirSync(p).sort()) if (n !== 'node_modules' && n !== '.git') walk(join(p, n)); }
    else files.push(p);
  };
  items.forEach((i) => walk(join(base, i)));
  for (const f of files.sort()) { h.update(relative(base, f)); h.update('\0'); h.update(readFileSync(f)); h.update('\0'); }
  return h.digest('hex').slice(0, 16);
}

/** Sidik jari source produksi (tanpa tooling). */
export function sourceVersion() { return hashTree(SOURCE_ITEMS); }
/** Sidik jari tooling verifikasi. */
export function testRunnerVersion() {
  const tools = readdirSync(join(ROOT, 'tools')).filter((f) => /^rc-s73-.*\.(mjs|sql)$/.test(f)).map((f) => join('tools', f));
  return `${TOOL_LABEL}+${hashTree(tools)}`;
}

export function runFile() { return join(OUT_DIR(), 'run.json'); }
export function readRun() { return existsSync(runFile()) ? JSON.parse(readFileSync(runFile(), 'utf8')) : null; }

/** §27 — sesi baru: direktori keluaran DIBERSIHKAN, laporan lama dihapus. */
export function newRun({ reportPath = DEFAULT_REPORT() } = {}) {
  rmSync(OUT_DIR(), { recursive: true, force: true });
  mkdirSync(OUT_DIR(), { recursive: true });
  if (reportPath && existsSync(reportPath)) rmSync(reportPath);
  const r = { runId: randomUUID(), startedAt: new Date().toISOString(), sourceVersion: sourceVersion(), testRunnerVersion: testRunnerVersion() };
  writeFileSync(runFile(), JSON.stringify(r, null, 2));
  return r;
}

/** Wajib ada sesi aktif; tanpa sesi -> BLOCKED (exit 2). */
export function requireRun() {
  const r = readRun();
  if (!r) {
    console.log(line(S.BLOCKED, 'Sesi verifikasi', 'tidak ada sesi aktif — jalankan: node tools/rc-s73-session.mjs new'));
    process.exit(EXIT.BLOCKED);
  }
  return r;
}

export function outPath(name) { mkdirSync(OUT_DIR(), { recursive: true }); return join(OUT_DIR(), name); }

/** Tulis komponen bukti yang di-stempel sesi & versi. */
export function writeComponent(name, data) {
  const r = readRun();
  const stamped = { ...data, _stamp: { runId: r?.runId ?? null, generatedAt: new Date().toISOString(), sourceVersion: sourceVersion(), testRunnerVersion: testRunnerVersion() } };
  writeFileSync(outPath(name), JSON.stringify(stamped, null, 2));
  return stamped;
}
export function readComponent(name) {
  const p = join(OUT_DIR(), name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** @returns {string|null} alasan stale, atau null bila valid. */
export function staleReason(stamp, run0, now = Date.now(), cur = { sourceVersion: sourceVersion(), testRunnerVersion: testRunnerVersion() }) {
  if (!stamp) return 'tanpa stempel sesi';
  if (!run0) return 'tidak ada sesi aktif';
  if (stamp.runId !== run0.runId) return `runId berbeda (${String(stamp.runId).slice(0, 8)} ≠ ${run0.runId.slice(0, 8)})`;
  const t = Date.parse(stamp.generatedAt);
  if (!Number.isFinite(t)) return 'timestamp tidak valid';
  if (t < Date.parse(run0.startedAt) - 1000) return 'timestamp sebelum sesi dimulai';
  if (t > now + 5 * 60_000) return 'timestamp di masa depan';
  if (stamp.sourceVersion !== cur.sourceVersion) return 'sourceVersion berbeda dengan source saat ini';
  if (stamp.testRunnerVersion !== cur.testRunnerVersion) return 'versi tooling berbeda';
  return null;
}

// ---------------------------------------------------------------------------
// util
// ---------------------------------------------------------------------------

export function anonId(serial) {
  return serial ? 'dev-' + createHash('sha256').update(String(serial)).digest('hex').slice(0, 12) : null;
}
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}
export function line(status, label, detail = '') {
  return `[${status}] ${label}${detail ? ' — ' + detail : ''}`;
}

// ---------------------------------------------------------------------------
// D1–D19 + PEMETAAN BUKTI PELENGKAP (tidak pernah menentukan status final)
// ---------------------------------------------------------------------------

/**
 * `machine`: bukti mesin WAJIB (harus PASS bersama formulir) — hanya D1 & D19.
 * `support`: bukti pelengkap otomatis/statis/DB — ditampilkan, TIDAK menentukan.
 */
export const D_ITEMS = [
  { id: 'D1', name: 'Install', machine: 'install', support: [], device: 'install APK preview di perangkat fisik', action: 'Jalankan `device-runner install --apk <preview.apk>` (protokol §1 langkah 1–2).' },
  { id: 'D2', name: 'First launch', support: [], device: 'peluncuran pertama tanpa crash', action: 'Jalankan protokol perangkat §1 langkah 3.' },
  { id: 'D3', name: 'Navigation', support: ['auto:jest'], device: 'navigasi seluruh tab & tombol Back', action: 'Jalankan protokol perangkat §1 langkah 5.' },
  { id: 'D4', name: 'Persistence force close', support: [], device: 'data utuh setelah force close', action: 'Jalankan protokol perangkat §2 langkah 1–2.' },
  { id: 'D5', name: 'Persistence reboot', support: [], device: 'data utuh setelah reboot', action: 'Jalankan protokol perangkat §2 langkah 3.' },
  { id: 'D6', name: 'Offline-first', support: [], device: 'fungsi lokal dalam mode pesawat', action: 'Jalankan protokol perangkat §2 langkah 4.' },
  { id: 'D7', name: 'Master data / route', support: ['auto:jest'], device: 'layar master data Identitas', action: 'Jalankan protokol perangkat §2 langkah 5.' },
  { id: 'D8', name: 'Pinjaman edit regression', support: ['auto:jest', 'db:C9', 'db:C10'], device: 'edit tujuan & agunan pinjaman (P1–P6)', action: 'Jalankan protokol perangkat §3 (P1–P6).' },
  { id: 'D9', name: 'Transaksi dasar', support: ['auto:jest', 'db:C7'], device: 'transaksi dasar + restart', action: 'Jalankan protokol perangkat §4.' },
  { id: 'D10', name: 'No accrual menu', support: ['static:no-accrual-menu'], device: 'menu akrual tidak muncul di aplikasi', action: 'Jalankan protokol perangkat §5 langkah 2.' },
  { id: 'D11', name: 'Accrual runtime', support: ['auto:rc-s71', 'db:C4', 'db:C5', 'db:C6'], device: 'akrual otomatis saat startup (runtime)', action: 'Jalankan protokol perangkat §5 langkah 1–4 pada perangkat Android fisik.' },
  { id: 'D12', name: 'Restart/idempotency', support: ['auto:rc-s71', 'db:C2', 'db:C3'], device: 'restart berulang tanpa jurnal ganda', action: 'Jalankan protokol perangkat §5 langkah 5.' },
  { id: 'D13', name: 'Status bunga', support: ['auto:rc-s71'], device: 'status bunga di Daftar Utang', action: 'Jalankan protokol perangkat §5 langkah 6.' },
  { id: 'D14', name: 'Payment', support: ['auto:rc-s71'], device: 'pembayaran bunga terakru di aplikasi', action: 'Jalankan protokol perangkat §6 langkah 1.' },
  { id: 'D15', name: 'Reports', support: ['auto:rc-s71'], device: 'laporan terbuka & seimbang', action: 'Jalankan protokol perangkat §6 langkah 2.' },
  { id: 'D16', name: 'SHU', support: ['auto:rc-s71'], device: 'SHU akrual vs basis kas', action: 'Jalankan protokol perangkat §6 langkah 3.' },
  { id: 'D17', name: 'PeriodClose', support: ['auto:rc-s71', 'db:C8'], device: 'Tutup Periode runtime (gate wajib)', action: 'Jalankan PeriodClose sesuai protokol perangkat §6 langkah 4.' },
  { id: 'D18', name: 'Historical protection', support: ['db:C8'], device: 'jurnal historis tidak berubah', action: 'Jalankan protokol perangkat §6 langkah 5.' },
  { id: 'D19', name: 'DB integrity', machine: 'database', support: ['auto:sql-fixture'], device: 'DB yang diekstrak dari perangkat', action: 'Pasang build `development`, lalu `device-runner db-pull` dan `db-check` (protokol §7).' },
];

/** Tindakan remediasi gate non-D (satu sumber, dipakai audit). */
export const GATE_ACTIONS = Object.freeze({
  SCHEMA: 'Perbaiki/ulang komponen bukti yang memuat status tidak sah; mulai sesi baru.',
  TOOLING: 'Jalankan `preflight --step tooling` (self-test framework, dicatat ke sesi).',
  EVIDENCE: 'Mulai sesi baru (`session new`) dan kumpulkan ulang seluruh bukti dalam satu sesi.',
  ENV: 'Pasang Android SDK + adb, sambungkan perangkat fisik (USB debugging diizinkan), pasang EAS CLI dan `eas login`, lalu jalankan `environment-check`.',
  BUILD: 'Jalankan `device-runner build` (EAS profil preview → APK) atau `record-build` untuk build yang sudah ada.',
  TS: 'Jalankan `preflight --step typescript`.',
  JEST: 'Jalankan `preflight --step jest` (atau shard + `jest-aggregate`).',
  RCS71: 'Jalankan `preflight --step rc-s71`.',
  LOGCAT: 'Jalankan `device-runner logcat` selama pengujian perangkat, lalu `logcat-scan`.',
  FORM: 'Isi formulir `RC-S73.1_DEVICE_RESULT.md` berdasarkan observasi nyata (FAIL wajib detail).',
});

/**
 * Akuntansi — baris dual-evidence (dipakai laporan final & audit).
 * `gate` = gate perangkat, `auto` = bukti otomatis, `db` = cek DB perangkat.
 */
export const ACCOUNTING_ROWS = Object.freeze([
  { name: 'Accrual Dr 5-1950 / Cr 2-1700 · UTANG_BUNGA · AUTO', gate: 'D11', auto: 'auto:rc-s71', db: ['C4', 'C5'] },
  { name: 'Payment Dr 2-1700 / Cr Kas', gate: 'D14', auto: 'auto:rc-s71', db: [] },
  { name: 'WHOLE_MONTH', gate: 'D11', auto: 'auto:rc-s71', db: ['C6'] },
  { name: 'Idempotency', gate: 'D12', auto: 'auto:rc-s71', db: ['C2', 'C3'] },
  { name: 'PeriodClose', gate: 'D17', auto: 'auto:rc-s71', db: ['C8'] },
]);

/** Status satu kunci bukti pelengkap (`auto:…`, `static:…`, `db:Cn`) dari evidence. */
export function evidenceStatus(ev, key) {
  const [t, x] = key.split(':');
  const a = ev.automated ?? {};
  if (t === 'auto' && x === 'rc-s71') return a.rcS71?.status ?? S.NOT_RUN;
  if (t === 'auto' && x === 'jest') return a.jest?.status ?? S.NOT_RUN;
  if (t === 'auto' && x === 'sql-fixture') return a.sqlFixture?.status ?? S.NOT_RUN;
  if (t === 'static' && x === 'no-accrual-menu') return a.static?.noAccrualMenu?.status ?? S.NOT_RUN;
  if (t === 'db') return ev.database?.checks?.[x]?.status ?? S.NOT_RUN;
  return S.NOT_RUN;
}

/** Agregasi status bukti: semua PASS -> PASS; ada FAIL -> FAIL; ada BLOCKED -> BLOCKED; selain itu NOT RUN. */
export function aggregate(arr) {
  if (!arr.length) return 'N/A';
  return arr.every((s) => s === S.PASS) ? S.PASS : arr.includes(S.FAIL) ? S.FAIL : arr.includes(S.BLOCKED) ? S.BLOCKED : S.NOT_RUN;
}

/** Final komposit dual-evidence: PASS hanya bila semua lapisan PASS; ada FAIL -> FAIL; selain itu NOT READY. */
export function composite(...layers) {
  const xs = layers.filter((l) => l !== 'N/A');
  return xs.includes(S.FAIL) ? S.FAIL : xs.length && xs.every((l) => l === S.PASS) ? S.PASS : 'NOT READY';
}

/**
 * §19 — validasi skema status. Setiap status di evidence WAJIB salah satu
 * PASS|FAIL|BLOCKED|NOT RUN (preflight: READY|BLOCKED|NOT RUN). Mengembalikan
 * daftar pelanggaran; kosong = valid.
 */
export function validateEvidenceSchema(ev) {
  const bad = [];
  const cek = (path, val, allowed = GATE_STATES) => { if (val !== undefined && val !== null && !allowed.includes(val)) bad.push(`${path}=${JSON.stringify(val)}`); };
  cek('evidenceConsistency.status', ev.evidenceConsistency?.status);
  cek('environment.status', ev.environment?.status);
  (ev.environment?.checks ?? []).forEach((c, i) => cek(`environment.checks[${c.id ?? i}].status`, c.status));
  cek('build.status', ev.build?.status);
  const a = ev.automated ?? {};
  cek('automated.preflight', a.preflight);
  for (const k of ['typescript', 'jest', 'rcS71', 'install', 'bundle', 'selftest', 'sqlFixture']) cek(`automated.${k}.status`, a[k]?.status);
  for (const [k, x] of Object.entries(a.static ?? {})) cek(`automated.static.${k}.status`, x?.status);
  cek('device.precondition', ev.device?.precondition);
  cek('device.install.status', ev.device?.install?.status);
  cek('device.logcat.status', ev.device?.logcat?.status);
  for (const [k, x] of Object.entries(ev.device?.form?.items ?? {})) cek(`device.form.items.${k}`, x);
  cek('database.status', ev.database?.status);
  for (const [k, x] of Object.entries(ev.database?.checks ?? {})) cek(`database.checks.${k}.status`, x?.status);
  return bad;
}

export const FAIL_FIELDS = ['Reproduction', 'Expected', 'Actual', 'Screenshot', 'Logcat', 'Severity'];
export const SEVERITIES = ['P0', 'P1', 'P2'];

// ---------------------------------------------------------------------------
// FORMULIR HASIL PERANGKAT
// ---------------------------------------------------------------------------

export function formTemplate({ runId = '', device = {}, build = {}, testDate = new Date().toISOString().slice(0, 10) } = {}) {
  const v = (x) => (x == null ? '' : String(x));
  return [
    '# RC-S73.1.3 DEVICE RESULT', '',
    'Isi setiap butir dengan tepat satu nilai: PASS | FAIL | BLOCKED | NOT RUN.',
    'Nilai awal NOT RUN diisi tool, BUKAN hasil uji. Jangan ubah Run ID maupun Build ID.',
    'D1 dan D19 memerlukan bukti mesin (install / DB-check); PASS di formulir tanpa bukti itu DITOLAK.', '',
    '```text', 'RC-S73.1.3 DEVICE RESULT', '',
    `Run ID: ${v(runId)}`,
    `Device: ${v(device.model)}`, `Android: ${v(device.androidVersion)}`, `API: ${v(device.apiLevel)}`,
    `Device ID (anon): ${v(device.deviceId)}`, `App Version: ${v(build.appVersion)}`, `Build ID: ${v(build.buildId)}`,
    `Test Date: ${testDate}`, 'Tester: ', '',
    ...D_ITEMS.map((d) => `${d.id} = ${S.NOT_RUN}`),
    '```', '',
    '## Detail FAIL / BLOCKED', '',
    'Untuk SETIAP FAIL salin blok ini (contoh D8):', '', '```text',
    'D8-Reproduction: <langkah persis>', 'D8-Expected: <yang seharusnya>', 'D8-Actual: <yang terjadi>',
    'D8-Screenshot: <nama berkas>', 'D8-Logcat: <potongan / nama berkas>', 'D8-Severity: <P0 | P1 | P2>', '```', '',
    'Untuk BLOCKED: `D17-reason: <mengapa tidak dapat dieksekusi>`', '',
  ].join('\n');
}

export function parseForm(text) {
  const items = {}, details = {}, meta = {}, errors = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    let m = l.match(/^(D\d{1,2})\s*=\s*(.*)$/);
    if (m) { const val = m[2].trim().toUpperCase().replace(/\s+/g, ' '); if (items[m[1]] !== undefined) errors.push(`${m[1]} diisi lebih dari sekali`); items[m[1]] = val; continue; }
    m = l.match(/^(D\d{1,2})-(Reproduction|Expected|Actual|Screenshot|Logcat|Severity|reason)\s*:\s*(.*)$/i);
    if (m) { const k = m[2].toLowerCase() === 'reason' ? 'reason' : m[2][0].toUpperCase() + m[2].slice(1).toLowerCase(); (details[m[1]] ??= {})[k] = m[3].trim(); continue; }
    m = l.match(/^(Run ID|Device|Android|API|Device ID \(anon\)|App Version|Build ID|Test Date|Tester)\s*:\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  const hasil = {};
  for (const d of D_ITEMS) {
    const val = items[d.id];
    if (val === undefined) { errors.push(`${d.id} tidak ditemukan`); hasil[d.id] = S.NOT_RUN; continue; }
    if (!GATE_STATES.includes(val)) { errors.push(`${d.id} bernilai "${val}" — hanya ${GATE_STATES.join(' | ')}`); hasil[d.id] = S.NOT_RUN; continue; }
    if (val === S.FAIL) {
      const det = details[d.id] ?? {};
      const kurang = FAIL_FIELDS.filter((f) => !det[f] || /^<.*>$/.test(det[f]));
      if (kurang.length) errors.push(`${d.id} FAIL tanpa detail wajib: ${kurang.join(', ')}`);
      if (det.Severity && !SEVERITIES.includes(det.Severity.toUpperCase())) errors.push(`${d.id} Severity harus P0/P1/P2`);
    }
    hasil[d.id] = val;
  }
  for (const id of Object.keys(items)) if (!D_ITEMS.some((d) => d.id === id)) errors.push(`butir tidak dikenal: ${id}`);
  return { items: hasil, details, meta, errors };
}

export function setFormItem(text, id, value) {
  const re = new RegExp(`^${id}\\s*=.*$`, 'm');
  if (!re.test(text)) throw new Error(`${id} tidak ada di formulir`);
  return text.replace(re, `${id} = ${value}`);
}

// ---------------------------------------------------------------------------
// DECISION ENGINE (§19) — satu-satunya tempat status final dihitung
// ---------------------------------------------------------------------------

export const REASON = Object.freeze({
  EVIDENCE_SCHEMA_INVALID: 'EVIDENCE_SCHEMA_INVALID',
  TOOLING_NOT_VERIFIED: 'TOOLING_NOT_VERIFIED',
  EVIDENCE_STALE: 'EVIDENCE_STALE',
  AUTOMATED_REGRESSION_FAILED: 'AUTOMATED_REGRESSION_FAILED',
  DEVICE_GATE_FAILED: 'DEVICE_GATE_FAILED',
  DB_INTEGRITY_FAILED: 'DB_INTEGRITY_FAILED',
  DEVICE_VERIFICATION_BLOCKED: 'DEVICE_VERIFICATION_BLOCKED',
  ENVIRONMENT_BLOCKED: 'ENVIRONMENT_BLOCKED',
  BUILD_BLOCKED: 'BUILD_BLOCKED',
  DEVICE_GATE_NOT_RUN: 'DEVICE_GATE_NOT_RUN',
});

/**
 * Status final satu butir D: formulir + prasyarat perangkat + bukti mesin
 * wajib (D1/D19). Bukti pelengkap (otomatis/statis/DB) TIDAK dilibatkan.
 */
export function finalItem(d, { form, precondition, machine }) {
  const st = GATE_STATES.includes(form) ? form : S.NOT_RUN;
  if (precondition !== S.PASS) {
    // Anti-fake-pass (§25): tanpa perangkat terverifikasi, PASS mustahil.
    if (st === S.PASS) return { status: S.BLOCKED, reason: 'formulir PASS tanpa perangkat terverifikasi' };
    if (d.machine && machine === S.BLOCKED && st === S.NOT_RUN) return { status: S.BLOCKED, reason: 'bukti mesin BLOCKED' };
    return { status: st, reason: '' };
  }
  if (d.machine) {
    if (st === S.PASS && machine !== S.PASS) return { status: machine === S.FAIL ? S.FAIL : S.BLOCKED, reason: `formulir PASS tetapi bukti mesin ${machine ?? S.NOT_RUN}` };
    if (st !== S.PASS && machine === S.FAIL) return { status: S.FAIL, reason: 'bukti mesin FAIL' };
  }
  return { status: st, reason: '' };
}

/** @param ev evidence tanpa gates/finalDecision. */
export function decide(ev) {
  const gates = [];
  const g = (id, name, category, status, extra = {}) =>
    gates.push({ id, name, category, status: GATE_STATES.includes(status) ? status : S.NOT_RUN, reason: '', ...extra });
  const schemaBad = validateEvidenceSchema(ev);
  g('SCHEMA', 'Evidence schema valid', 'evidence', schemaBad.length ? S.FAIL : S.PASS, { reason: schemaBad.length ? `status tidak sah: ${schemaBad.join(', ')}` : '' });
  // §35: aplikasi tidak mungkin PASS bila framework verifikasi belum terbukti sehat dalam sesi ini.
  g('TOOLING', 'Tooling self-test', 'evidence', ev.automated?.selftest?.status);
  g('EVIDENCE', 'Evidence consistency', 'evidence', ev.evidenceConsistency?.status, { reason: (ev.evidenceConsistency?.issues ?? []).map((i) => (typeof i === 'string' ? i : i.message)).join('; ') });
  g('ENV', 'Environment', 'environment', ev.environment?.status);
  g('BUILD', 'Build (APK preview)', 'build', ev.build?.status, { reason: ev.build?.reason ?? '' });
  g('TS', 'TypeScript', 'automated', ev.automated?.typescript?.status);
  g('JEST', 'Full Jest', 'automated', ev.automated?.jest?.status);
  g('RCS71', 'RC-S71 regression', 'automated', ev.automated?.rcS71?.status);
  g('LOGCAT', 'Logcat (0 pola kritis)', 'device', ev.device?.logcat?.status);
  const form = ev.device?.form ?? null;
  g('FORM', 'Formulir hasil valid', 'device', !form ? S.NOT_RUN : form.errors.length ? S.FAIL : S.PASS, { reason: (form?.errors ?? []).join('; ') });
  const pre = ev.device?.precondition ?? S.NOT_RUN;
  for (const d of D_ITEMS) {
    const machine = d.machine === 'install' ? ev.device?.install?.status ?? S.NOT_RUN : d.machine === 'database' ? ev.database?.status ?? S.NOT_RUN : null;
    const r = finalItem(d, { form: form?.items?.[d.id], precondition: pre, machine });
    g(d.id, `${d.id} ${d.name}`, 'device-gate', r.status, { reason: r.reason, form: form?.items?.[d.id] ?? S.NOT_RUN, machine });
  }

  // Semua gate WAJIB; tanpa ambang jumlah (24/26 PASS tetap NOT READY).
  const clear = gates.every((x) => x.status === S.PASS);
  const counts = { total: gates.length, [S.PASS]: 0, [S.FAIL]: 0, [S.BLOCKED]: 0, [S.NOT_RUN]: 0 };
  for (const x of gates) counts[x.status]++;

  const st = (id) => gates.find((x) => x.id === id).status;
  const dGates = gates.filter((x) => x.category === 'device-gate');
  const reasons = [];
  if (st('SCHEMA') !== S.PASS) reasons.push(REASON.EVIDENCE_SCHEMA_INVALID);
  if (st('TOOLING') !== S.PASS) reasons.push(REASON.TOOLING_NOT_VERIFIED);
  if (st('EVIDENCE') !== S.PASS) reasons.push(REASON.EVIDENCE_STALE);
  if (['TS', 'JEST', 'RCS71'].some((i) => st(i) !== S.PASS && st(i) !== S.NOT_RUN)) reasons.push(REASON.AUTOMATED_REGRESSION_FAILED);
  if (dGates.some((x) => x.status === S.FAIL && x.id !== 'D19') || st('LOGCAT') === S.FAIL || st('FORM') === S.FAIL) reasons.push(REASON.DEVICE_GATE_FAILED);
  if (st('D19') === S.FAIL || ev.database?.status === S.FAIL) reasons.push(REASON.DB_INTEGRITY_FAILED);
  if (pre !== S.PASS) reasons.push(REASON.DEVICE_VERIFICATION_BLOCKED);
  if (st('ENV') !== S.PASS && pre === S.PASS) reasons.push(REASON.ENVIRONMENT_BLOCKED);
  if (st('BUILD') !== S.PASS && st('BUILD') !== S.FAIL) reasons.push(REASON.BUILD_BLOCKED);
  if (dGates.some((x) => x.status === S.NOT_RUN) || ['TS', 'JEST', 'RCS71'].some((i) => st(i) === S.NOT_RUN)) reasons.push(REASON.DEVICE_GATE_NOT_RUN);
  if (!clear && reasons.length === 0) {
    const sisa = gates.find((x) => x.status !== S.PASS);
    reasons.push(sisa.category === 'build' ? REASON.BUILD_BLOCKED : sisa.category === 'automated' ? REASON.AUTOMATED_REGRESSION_FAILED : REASON.DEVICE_GATE_FAILED);
  }
  return {
    gates,
    finalDecision: {
      status: clear ? S.PASS : 'NOT READY',
      release: clear ? 'CLEAR' : 'NOT CLEAR',
      primaryReason: clear ? null : reasons[0],
      reasons: clear ? [] : reasons,
      counts,
      blocking: gates.filter((x) => x.status !== S.PASS).map((x) => x.name),
    },
  };
}

/** Ringkasan per lapisan bukti — diturunkan dari evidence & gate yang sama. */
export function layerSummary(ev, gates) {
  const st = (id) => gates.find((x) => x.id === id)?.status ?? S.NOT_RUN;
  const agg = (arr) => (arr.length && arr.every((s) => s === S.PASS) ? S.PASS : arr.includes(S.FAIL) ? S.FAIL : arr.includes(S.BLOCKED) ? S.BLOCKED : S.NOT_RUN);
  const a = ev.automated ?? {};
  const statik = Object.values(a.static ?? {}).map((x) => x?.status ?? S.NOT_RUN);
  const dev = gates.filter((x) => x.category === 'device-gate').map((x) => x.status);
  return {
    tooling: st('TOOLING'),
    environment: st('ENV'),
    automated: agg([st('TS'), st('JEST'), st('RCS71'), a.bundle?.status ?? S.NOT_RUN, ...(statik.length ? statik : [S.NOT_RUN])]),
    device: (ev.device?.precondition ?? S.NOT_RUN) !== S.PASS ? S.BLOCKED : agg([...dev, st('LOGCAT'), st('FORM')]),
    database: ev.database?.status ?? S.NOT_RUN,
    build: st('BUILD'),
  };
}

// ---------------------------------------------------------------------------
// DB CHECK — tools/rc-s73-device-checks.sql apa adanya, read-only
// ---------------------------------------------------------------------------

export function splitSqlChecks(sqlText) {
  const bersih = sqlText.split('\n').filter((l) => !l.startsWith('.') && !l.trim().startsWith('--')).join('\n');
  const checks = [];
  let cur = null;
  for (const s of bersih.split(';').map((x) => x.trim()).filter(Boolean)) {
    const m = s.match(/^SELECT '== (C\d+)\s*(.*)'\s+AS cek$/s);
    if (m) { cur = { id: m[1], label: m[2], mustBeEmpty: /\[HARUS KOSONG\]/.test(m[2]), sql: null }; checks.push(cur); continue; }
    if (!cur) throw new Error('Statement SQL tanpa label cek: ' + s.slice(0, 60));
    if (cur.sql) throw new Error(`Cek ${cur.id} memiliki lebih dari satu query`);
    cur.sql = s;
  }
  return checks;
}

export async function runDbChecks(dbPath, sqlPath = join(ROOT, 'tools', 'rc-s73-device-checks.sql')) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const hasil = [];
  try {
    for (const c of splitSqlChecks(readFileSync(sqlPath, 'utf8'))) {
      const rows = db.prepare(c.sql).all();
      let status = S.PASS, note = '';
      if (c.mustBeEmpty) { if (rows.length) { status = S.FAIL; note = `${rows.length} baris (harus 0)`; } }
      else if (c.id === 'C1') { const v = rows[0]?.version; if (v !== EXPECTED_SCHEMA) { status = S.FAIL; note = `versi ${v} (harus ${EXPECTED_SCHEMA})`; } }
      else if (c.id === 'C6') { if (!rows.some((r) => Number(r.periode) === 3 && Number(r.total) === 3_600_000)) { status = S.FAIL; note = 'tidak ada utang 3 periode / 3.600.000 (skenario protokol §5)'; } }
      else if (c.id === 'C12') { if (!(rows.length === 1 && Object.values(rows[0])[0] === 'ok')) { status = S.FAIL; note = 'integrity_check bukan "ok"'; } }
      hasil.push({ id: c.id, label: c.label, status, note, rows });
    }
  } finally { db.close(); }
  return { status: hasil.every((h) => h.status === S.PASS) ? S.PASS : S.FAIL, checks: hasil };
}

export function formatDbChecks(r, dbName) {
  const out = [`${TOOL_LABEL} DB CHECKS — ${dbName}`, `STATUS = ${r.status}`, ''];
  for (const c of r.checks) {
    out.push(line(c.status, `${c.id} ${c.label}`, c.note));
    for (const row of c.rows.slice(0, 20)) out.push('    ' + JSON.stringify(row));
    if (c.rows.length > 20) out.push(`    ... ${c.rows.length - 20} baris lagi`);
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// LOGCAT
// ---------------------------------------------------------------------------

export const LOGCAT_PATTERN = /FATAL EXCEPTION|Unable to resolve module|Cannot read propert|SQLite|SQLITE_|migration|database is locked|Invariant Violation|ReactNativeJS.*(Error|Exception)/;
export const LOGCAT_START = '# RC-S73.1.3 LOGCAT CAPTURE START';
export const LOGCAT_END = '# RC-S73.1.3 LOGCAT CAPTURE END';

/** Tanpa penanda START (atau START dari sesi lain) -> NOT RUN. */
export function scanLogcat(text, runId) {
  const baris = text.split('\n');
  const start = baris.find((l) => l.startsWith(LOGCAT_START));
  if (!start) return { status: S.NOT_RUN, critical: 0, sample: [], note: 'penanda START tidak ada — perekaman tidak terbukti berjalan' };
  if (runId && !start.includes(runId)) return { status: S.NOT_RUN, critical: 0, sample: [], note: 'rekaman berasal dari sesi lain (stale)' };
  const hits = baris.filter((l) => !l.startsWith('# RC-S73') && LOGCAT_PATTERN.test(l));
  const ended = baris.some((l) => l.startsWith(LOGCAT_END));
  return { status: hits.length === 0 ? S.PASS : S.FAIL, critical: hits.length, sample: hits.slice(0, 30), note: ended ? '' : 'penanda END tidak ada (perekaman terputus)' };
}

#!/usr/bin/env node
// RC-S73.1.3 §6–§13 — DEVICE TEST RUNNER.
//
// Runner TIDAK mengotomatisasi tindakan bisnis dan TIDAK PERNAH mengisi PASS
// untuk butir observasi. Bukti mesin hanya untuk D1 (adb install) dan D19
// (DB-check pada DB yang diekstrak dari perangkat). Semua hasil di-stempel sesi.
//
//   environment                        jalankan environment-check (dengan timeout)
//   build                              EAS build profil `preview` (APK) — langkah RILIS, bukan self-test
//   record-build --build-id ID --url URL --artifact-url URL.apk [--apk FILE] [--version V] [--package P]
//   init                               formulir rc-s73-out/RC-S73.1_DEVICE_RESULT.md (semua NOT RUN)
//   install --apk FILE                 uninstall + install APK -> bukti D1
//   logcat [--max-minutes N]           rekam logcat terfilter (Ctrl+C; berhenti otomatis setelah N menit, default 240)
//   logcat-scan                        nilai rekaman logcat sesi ini
//   db-pull                            ambil koperasi.db dari build DEBUGGABLE (`development`)
//   db-check [--db FILE]               tools/rc-s73-device-checks.sql -> bukti D19
//   status                             status formulir
// Exit: 0 PASS · 1 FAIL · 2 BLOCKED/NOT RUN.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  S, EXIT, TIMEOUT, PACKAGE_ID, ROOT, run, readComponent, writeComponent, outPath, line, formTemplate, parseForm, setFormItem,
  runDbChecks, formatDbChecks, scanLogcat, LOGCAT_PATTERN, LOGCAT_START, LOGCAT_END, D_ITEMS, requireRun,
} from './rc-s73-lib.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const FORM = () => outPath('RC-S73.1_DEVICE_RESULT.md');
const exitOf = (st) => (st === S.PASS ? EXIT.OK : st === S.FAIL ? EXIT.FAIL : EXIT.BLOCKED);

async function adbBin() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const r = await run('adb', ['version'], { timeout: TIMEOUT.version });
  return r.state === 'OK' || !sdk ? 'adb' : join(sdk, 'platform-tools', 'adb');
}
async function serialFisik(adb) {
  const r = await run(adb, ['devices'], { timeout: TIMEOUT.adbList });
  if (r.state !== 'OK') return null;
  const l = r.stdout.split('\n').slice(1).map((x) => x.trim()).find((x) => /\tdevice$/.test(x) && !x.startsWith('emulator-'));
  return l ? l.split('\t')[0] : null;
}
function isiForm(id, status) {
  if (!existsSync(FORM())) return false;
  writeFileSync(FORM(), setFormItem(readFileSync(FORM(), 'utf8'), id, status));
  return true;
}

/** Paket aplikasi menurut konfigurasi source build (app.json). */
function paketKonfigurasi() {
  try { return JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8')).expo?.android?.package ?? null; } catch { return null; }
}

const CMDS = {
  async environment() {
    const r = await run(process.execPath, [join(ROOT, 'tools', 'rc-s73-environment-check.mjs')], { timeout: TIMEOUT.envCheck });
    console.log(String(r.stdout));
    return r.state === 'TIMEOUT' ? EXIT.BLOCKED : r.code ?? EXIT.BLOCKED;
  },
  async build() {
    const env = readComponent('environment.json');
    if (!env?.eas) { writeComponent('build.json', { status: S.BLOCKED, reason: 'EAS CLI tidak tersedia (environment check)' }); console.log(line(S.BLOCKED, 'Build', 'EAS CLI tidak tersedia')); return EXIT.BLOCKED; }
    console.log('Menjalankan EAS build profil `preview` (APK) — dapat memakan waktu lama (batas 4 jam)...');
    const r = await run(env.eas.cmd, [...env.eas.prefix, 'build', '-p', 'android', '--profile', 'preview', '--non-interactive', '--wait', '--json'], { timeout: TIMEOUT.easBuild });
    let b = null;
    try { b = JSON.parse(r.stdout)[0]; } catch { /* ditangani di bawah */ }
    if (!b) { const st = r.state === 'MISSING' ? S.BLOCKED : S.FAIL; writeComponent('build.json', { status: st, reason: `EAS ${r.state}; output tidak dapat dibaca`, tail: (r.stderr || String(r.stdout)).slice(-2000) }); console.log(line(st, 'Build', `EAS ${r.state}`)); return exitOf(st); }
    return catatBuild({ package: paketKonfigurasi(), buildId: b.id, buildUrl: `https://expo.dev/accounts/${b.project?.ownerAccount?.name ?? '-'}/projects/${b.project?.slug ?? '-'}/builds/${b.id}`, artifactUrl: b.artifacts?.buildUrl ?? b.artifacts?.applicationArchiveUrl, easStatus: b.status, profile: b.buildProfile, appVersion: [b.appVersion, b.appBuildVersion].filter(Boolean).join(' / ') });
  },
  async 'record-build'() {
    const buildId = arg('--build-id'), url = arg('--url');
    if (!buildId || !url) { console.log('--build-id dan --url wajib'); return EXIT.FAIL; }
    return catatBuild({ package: arg('--package') ?? paketKonfigurasi(), buildId, buildUrl: url, artifactUrl: arg('--artifact-url') ?? url, apkFile: arg('--apk'), easStatus: arg('--eas-status') ?? 'FINISHED', profile: 'preview', appVersion: arg('--version') ?? '' });
  },
  async init() {
    if (existsSync(FORM()) && !argv.includes('--force')) { console.log(`Formulir sudah ada: ${FORM()} (--force untuk menimpa; isian akan hilang)`); return EXIT.OK; }
    const run0 = requireRun();
    const env = readComponent('environment.json') ?? {};
    const b = readComponent('build.json') ?? {};
    writeFileSync(FORM(), formTemplate({ runId: run0.runId, device: env.device ?? {}, build: b }));
    console.log(`Formulir dibuat: ${FORM()}\nSemua butir = NOT RUN. Isi hanya setelah observasi nyata di perangkat.`);
    return EXIT.OK;
  },
  async install() {
    const apk = arg('--apk');
    if (!apk) { console.log('--apk FILE wajib'); return EXIT.FAIL; }
    const adb = await adbBin();
    const serial = await serialFisik(adb);
    if (!serial) { writeComponent('install.json', { status: S.BLOCKED, reason: 'tidak ada perangkat fisik berstatus `device`' }); isiForm('D1', S.BLOCKED); console.log(line(S.BLOCKED, 'D1 Install', 'tidak ada perangkat fisik')); return EXIT.BLOCKED; }
    if (!existsSync(apk) || !/\.apk$/i.test(apk)) { writeComponent('install.json', { status: S.FAIL, reason: `bukan APK / tidak ada: ${basename(apk)}` }); isiForm('D1', S.FAIL); console.log(line(S.FAIL, 'D1 Install', 'berkas bukan APK')); return EXIT.FAIL; }
    const un = await run(adb, ['-s', serial, 'uninstall', PACKAGE_ID], { timeout: TIMEOUT.adbInstall });
    const unNote = un.state === 'OK' ? 'terpasang sebelumnya, di-uninstall' : /Unknown package|not installed|DELETE_FAILED_INTERNAL_ERROR/i.test(`${un.stdout}${un.stderr}`) ? 'belum terpasang (bukan error)' : `uninstall ${un.state}`;
    const ins = await run(adb, ['-s', serial, 'install', apk], { timeout: TIMEOUT.adbInstall });
    const sukses = ins.state === 'OK' && /Success/.test(ins.stdout);
    const pm = sukses ? await run(adb, ['-s', serial, 'shell', 'pm', 'list', 'packages', PACKAGE_ID], { timeout: TIMEOUT.adbProp }) : null;
    // Perangkat ADA -> kegagalan install = FAIL (bukan BLOCKED), §7.
    const status = sukses && pm?.stdout.includes(`package:${PACKAGE_ID}`) ? S.PASS : S.FAIL;
    writeComponent('install.json', { status, apk: basename(apk), sizeBytes: statSync(apk).size, uninstall: unNote, state: ins.state, output: `${ins.stdout}\n${ins.stderr}`.slice(-2000) });
    isiForm('D1', status);
    console.log(line(status, 'D1 Install', status === S.PASS ? `Success · ${PACKAGE_ID} terdaftar · ${unNote}` : `${ins.state}: ${`${ins.stdout} ${ins.stderr}`.trim().slice(-200)}`));
    return exitOf(status);
  },
  async logcat() {
    const run0 = requireRun();
    const adb = await adbBin();
    const serial = await serialFisik(adb);
    if (!serial) { console.log(line(S.BLOCKED, 'Logcat', 'tidak ada perangkat fisik')); return EXIT.BLOCKED; }
    await run(adb, ['-s', serial, 'logcat', '-c'], { timeout: TIMEOUT.adbList });
    const maxMin = Math.max(1, Math.min(Number(arg('--max-minutes') ?? 240), 720));
    const file = outPath('rc-s73-logcat.txt');
    const out = createWriteStream(file);
    out.write(`${LOGCAT_START} run=${run0.runId} ${new Date().toISOString()}\n`);
    const p = spawn(adb, ['-s', serial, 'logcat'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let sisa = '', n = 0;
    p.stdout.on('data', (buf) => { const baris = (sisa + buf.toString()).split('\n'); sisa = baris.pop(); for (const l of baris) if (LOGCAT_PATTERN.test(l)) { out.write(l + '\n'); n++; process.stdout.write(`! ${l}\n`); } });
    return new Promise((res) => {
      const stop = (why) => { clearTimeout(t); p.kill('SIGTERM'); out.end(`${LOGCAT_END} ${new Date().toISOString()} · ${n} baris kritis · ${why}\n`, () => { console.log(`\nLogcat disimpan: ${file} (${n} baris kritis)`); res(EXIT.OK); }); };
      const t = setTimeout(() => stop(`batas ${maxMin} menit`), maxMin * 60_000);
      process.once('SIGINT', () => stop('dihentikan penguji'));
      process.once('SIGTERM', () => stop('SIGTERM'));
      p.on('close', () => stop('adb logcat berhenti'));
      console.log(`Merekam logcat terfilter (maks ${maxMin} menit) — jalankan pengujian, lalu Ctrl+C.`);
    });
  },
  async 'logcat-scan'() {
    const run0 = requireRun();
    const f = outPath('rc-s73-logcat.txt');
    const r = existsSync(f) ? scanLogcat(readFileSync(f, 'utf8'), run0.runId) : { status: S.NOT_RUN, critical: 0, sample: [], note: 'berkas logcat tidak ada' };
    writeComponent('logcat.json', r);
    console.log(line(r.status, 'Logcat', `${r.critical} baris kritis${r.note ? ' · ' + r.note : ''}`));
    r.sample.slice(0, 10).forEach((s) => console.log('   ' + s));
    return exitOf(r.status);
  },
  async 'db-pull'() {
    const adb = await adbBin();
    const serial = await serialFisik(adb);
    if (!serial) { console.log(line(S.BLOCKED, 'DB pull', 'tidak ada perangkat fisik')); return EXIT.BLOCKED; }
    const r = await run(adb, ['-s', serial, 'exec-out', 'run-as', PACKAGE_ID, 'cat', 'files/SQLite/koperasi.db'], { timeout: TIMEOUT.dbPull, binary: true, maxOutput: 1 << 30 });
    const buf = r.stdout;
    if (r.state !== 'OK' || buf.subarray(0, 15).toString() !== 'SQLite format 3') {
      console.log(line(S.BLOCKED, 'DB pull', `run-as gagal (${r.state}) — APK release tidak debuggable; pakai build \`development\`. ${(r.stderr || buf.toString('utf8', 0, 160)).trim()}`));
      return EXIT.BLOCKED;
    }
    writeFileSync(outPath('koperasi.db'), buf);
    writeComponent('db-pull.json', { status: S.PASS, bytes: buf.length });
    console.log(line(S.PASS, 'DB pull', `${buf.length} byte`));
    return EXIT.OK;
  },
  async 'db-check'() {
    const db = arg('--db') ? resolve(arg('--db')) : outPath('koperasi.db');
    if (!existsSync(db)) { writeComponent('db-checks.json', { status: S.NOT_RUN, reason: 'DB perangkat belum diekstrak', checks: [] }); console.log(line(S.NOT_RUN, 'D19 DB integrity', 'DB perangkat belum diekstrak')); return EXIT.BLOCKED; }
    const r = await runDbChecks(db);
    writeFileSync(outPath('rc-s73-db-checks.txt'), formatDbChecks(r, basename(db)));
    writeComponent('db-checks.json', { status: r.status, source: arg('--source') ?? 'DB perangkat (build development)', db: basename(db), checks: r.checks.map(({ id, label, status, note }) => ({ id, label, status, note })) });
    isiForm('D19', r.status);
    r.checks.forEach((c) => console.log(line(c.status, `${c.id} ${c.label}`, c.note)));
    console.log(`\nDevice extracted DB = ${r.status}`);
    return exitOf(r.status);
  },
  async status() {
    if (!existsSync(FORM())) { console.log('Formulir belum dibuat.'); return EXIT.BLOCKED; }
    const f = parseForm(readFileSync(FORM(), 'utf8'));
    D_ITEMS.forEach((d) => console.log(line(f.items[d.id], `${d.id} ${d.name}`, '(nilai formulir)')));
    if (f.errors.length) { console.log('\nKesalahan formulir:'); f.errors.forEach((e) => console.log('  - ' + e)); return EXIT.FAIL; }
    return EXIT.OK;
  },
};

function catatBuild(b) {
  const art = b.apkFile ?? b.artifactUrl ?? '';
  const apk = /\.apk(\?|$)/i.test(art), aab = /\.aab(\?|$)/i.test(art);
  let status = S.PASS, reason = '';
  if (String(b.easStatus).toUpperCase() !== 'FINISHED') { status = S.FAIL; reason = `status EAS ${b.easStatus}`; }
  else if (aab) { status = S.FAIL; reason = 'artifact AAB — gate install menuntut APK profil preview'; }
  else if (!apk) { status = S.FAIL; reason = 'artifact bukan .apk atau tidak diketahui'; }
  else if (b.profile && b.profile !== 'preview') { status = S.FAIL; reason = `profil ${b.profile} (harus preview)`; }
  if (b.apkFile && !existsSync(b.apkFile)) { status = S.FAIL; reason = `berkas ${basename(b.apkFile)} tidak ada`; }
  if (status === S.PASS && b.package !== PACKAGE_ID) { status = S.FAIL; reason = `paket ${b.package ?? '(tidak diketahui)'} ≠ ${PACKAGE_ID}`; }
  writeComponent('build.json', { status, reason, ...b, profile: b.profile ?? 'preview', apkFile: b.apkFile ? resolve(b.apkFile) : null, artifact: apk ? 'APK' : aab ? 'AAB' : 'UNKNOWN' });
  console.log(line(status, 'Build (APK preview)', reason || `${b.buildId} · ${b.appVersion}`));
  return exitOf(status);
}

if (!cmd || !CMDS[cmd]) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 19).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exitCode = cmd ? EXIT.FAIL : EXIT.OK;
} else {
  if (cmd !== 'status') requireRun();
  process.exitCode = await CMDS[cmd]();
}

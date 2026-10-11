#!/usr/bin/env node
// RC-S73.1.3 §27 — SESI VERIFIKASI.
//
//   node tools/rc-s73-session.mjs new    # direktori rc-s73-out/ DIBERSIHKAN, runId baru, laporan lama dihapus
//   node tools/rc-s73-session.mjs show   # tampilkan sesi aktif
//
// Semua komponen bukti di-stempel dengan runId sesi ini; bukti dari sesi lain
// (stale) tidak pernah dipakai tanpa validasi.
import { newRun, readRun, OUT_DIR, EXIT, line, S } from './rc-s73-lib.mjs';

const cmd = process.argv[2];
if (cmd === 'new') {
  const r = newRun();
  console.log(`Sesi baru: ${r.runId}\nDimulai : ${r.startedAt}\nSource  : ${r.sourceVersion}\nTooling : ${r.testRunnerVersion}\nOutput  : ${OUT_DIR()} (bersih)`);
} else if (cmd === 'show') {
  const r = readRun();
  if (!r) { console.log(line(S.BLOCKED, 'Sesi', 'tidak ada sesi aktif')); process.exitCode = EXIT.BLOCKED; }
  else console.log(JSON.stringify(r, null, 2));
} else {
  console.log('Pemakaian: node tools/rc-s73-session.mjs new|show');
  process.exitCode = cmd ? EXIT.FAIL : EXIT.OK;
}

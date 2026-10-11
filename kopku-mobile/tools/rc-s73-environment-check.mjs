#!/usr/bin/env node
// RC-S73.1.3 §2–§8 — ENVIRONMENT GATE + DEVICE DISCOVERY.
//
//   node tools/rc-s73-environment-check.mjs
//
// Wajib: Node, npm, adb, Android SDK, perangkat fisik berstatus `device`,
// EAS CLI, autentikasi Expo. Emulator = pelengkap (tidak memengaruhi gate).
// Setiap probe memakai timeout terbatas; tidak ada yang dapat menggantung.
// Lingkungan tidak tersedia = BLOCKED (bukan kegagalan aplikasi).
// Exit: 0 PASS · 1 FAIL · 2 BLOCKED. Serial perangkat disimpan sebagai hash.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { S, EXIT, TIMEOUT, run, classify, anonId, writeComponent, requireRun, line } from './rc-s73-lib.mjs';

requireRun();
const hasil = [];
const catat = (id, label, status, detail = '', required = true) => hasil.push({ id, label, status, detail, required });

// Node
{
  const major = Number(process.versions.node.split('.')[0]);
  catat('node', 'Node', major >= 22 ? S.PASS : S.BLOCKED, `v${process.versions.node}${major >= 22 ? '' : ' (butuh >= 22 untuk node:sqlite)'}`);
}
// npm
{
  const r = await run('npm', ['--version'], { timeout: TIMEOUT.version });
  catat('npm', 'npm', classify(r), r.state === 'OK' ? r.stdout : `${r.state} ${r.error ?? r.stderr}`.trim());
}
// Android SDK
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
{
  const ada = sdk && existsSync(join(sdk, 'platform-tools'));
  catat('sdk', 'Android SDK', ada ? S.PASS : S.BLOCKED, ada ? sdk : 'ANDROID_HOME/ANDROID_SDK_ROOT tidak diset atau tanpa platform-tools');
}
// adb
let adb = 'adb';
{
  let r = await run(adb, ['version'], { timeout: TIMEOUT.version });
  if (r.state === 'MISSING' && sdk) { adb = join(sdk, 'platform-tools', 'adb'); r = await run(adb, ['version'], { timeout: TIMEOUT.version }); }
  catat('adb', 'adb', classify(r), r.state === 'OK' ? r.stdout.split('\n')[0] : r.state === 'MISSING' ? 'adb tidak ditemukan di PATH maupun SDK' : `${r.state} ${r.error ?? r.stderr}`.trim());
}
// Device (prasyarat perangkat)
let device = null;
if (hasil.find((h) => h.id === 'adb').status !== S.PASS) {
  catat('device', 'Device (fisik)', S.BLOCKED, 'adb tidak tersedia');
} else {
  const r = await run(adb, ['devices', '-l'], { timeout: TIMEOUT.adbList });
  if (r.state !== 'OK') {
    catat('device', 'Device (fisik)', S.BLOCKED, `adb devices ${r.state}${r.state === 'TIMEOUT' ? ' (server adb tidak merespons)' : ''}`);
  } else {
    const baris = r.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
    const siap = baris.filter((l) => /\sdevice(\s|$)/.test(l));
    const masalah = baris.filter((l) => /\s(unauthorized|offline|no permissions)/.test(l));
    const fisik = siap.filter((l) => !/^emulator-/.test(l));
    if (!fisik.length) {
      catat('device', 'Device (fisik)', S.BLOCKED, masalah.length
        ? `perangkat ${masalah.map((l) => l.split(/\s+/)[1]).join(', ')} (izinkan USB debugging / sambung ulang)`
        : siap.length ? 'hanya emulator — emulator TIDAK menggantikan perangkat fisik' : 'tidak ada perangkat terhubung');
    } else {
      const serial = fisik[0].split(/\s+/)[0];
      const prop = async (k) => { const p = await run(adb, ['-s', serial, 'shell', 'getprop', k], { timeout: TIMEOUT.adbProp }); return p.state === 'OK' ? p.stdout : ''; };
      device = {
        deviceId: anonId(serial),
        model: `${await prop('ro.product.manufacturer')} ${await prop('ro.product.model')}`.trim(),
        androidVersion: await prop('ro.build.version.release'),
        apiLevel: await prop('ro.build.version.sdk'),
      };
      const lengkap = device.model && device.androidVersion && device.apiLevel;
      // Perangkat ada tetapi tidak dapat dibaca = FAIL (bukan lingkungan hilang).
      catat('device', 'Device (fisik)', lengkap ? S.PASS : S.FAIL,
        `${device.model || '?'} · Android ${device.androidVersion || '?'} · API ${device.apiLevel || '?'} · ${device.deviceId}${fisik.length > 1 ? ` (+${fisik.length - 1} lain; dipakai yang pertama)` : ''}`);
    }
  }
}
// EAS CLI (hanya ketersediaan; build TIDAK pernah dijalankan di sini)
let eas = null;
{
  const kandidat = [['eas', []], ['npx', ['--no-install', 'eas-cli']]];
  let terakhir = null;
  for (const [cmd, prefix] of kandidat) {
    const r = await run(cmd, [...prefix, '--version'], { timeout: TIMEOUT.version });
    terakhir = r;
    if (r.state === 'OK') { eas = { cmd, prefix, version: r.stdout.split('\n').pop() }; break; }
  }
  catat('eas', 'EAS CLI', eas ? S.PASS : S.BLOCKED, eas ? eas.version : `eas-cli tidak tersedia (${terakhir.state}) — npm i -g eas-cli`);
}
// Expo auth
if (!eas) catat('auth', 'Expo authentication', S.BLOCKED, 'EAS CLI tidak tersedia');
else {
  const r = await run(eas.cmd, [...eas.prefix, 'whoami'], { timeout: TIMEOUT.easWhoami });
  const login = r.state === 'OK' && r.stdout && !/not logged in/i.test(r.stdout);
  catat('auth', 'Expo authentication', login ? S.PASS : S.BLOCKED,
    login ? 'login terverifikasi (nama akun tidak dicatat)' : r.state === 'TIMEOUT' ? 'eas whoami timeout' : 'belum login (`eas login` atau EXPO_TOKEN)');
}
// Emulator (pelengkap; tidak memengaruhi gate)
{
  const emu = sdk ? join(sdk, 'emulator', 'emulator') : 'emulator';
  const r = await run(emu, ['-list-avds'], { timeout: TIMEOUT.emulatorList });
  const avd = r.state === 'OK' ? r.stdout.split('\n').filter(Boolean) : [];
  catat('emulator', 'Emulator', avd.length ? S.PASS : S.BLOCKED, avd.length ? `${avd.length} AVD (pelengkap)` : 'tidak tersedia — pelengkap, tidak memengaruhi gate', false);
}

const wajib = hasil.filter((h) => h.required);
const status = wajib.every((h) => h.status === S.PASS) ? S.PASS : wajib.some((h) => h.status === S.FAIL) ? S.FAIL : S.BLOCKED;
const devCheck = hasil.find((h) => h.id === 'device');
writeComponent('environment.json', {
  status, checks: hasil,
  device: devCheck.status === S.PASS ? device : null,
  devicePrecondition: devCheck.status,
  eas: eas ? { cmd: eas.cmd, prefix: eas.prefix } : null,
});
console.log('RC-S73.1.3 ENVIRONMENT CHECK\n');
for (const h of hasil) console.log(line(h.status, h.label + (h.required ? '' : ' (pelengkap)'), h.detail));
console.log(`\nSTATUS = ${status}`);
if (status === S.BLOCKED) console.log('Catatan: kegagalan LINGKUNGAN, bukan kegagalan aplikasi.');
process.exitCode = status === S.PASS ? EXIT.OK : status === S.FAIL ? EXIT.FAIL : EXIT.BLOCKED;

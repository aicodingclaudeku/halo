'use strict';
/**
 * UJI TAMPILAN KOPKU DESKTOP (screenshot nyata Electron).
 *
 *  1. Database berisi data realistis dibuat dengan service aplikasi ASLI
 *     (siapkan-data.ts: setup koperasi, 12 anggota, simpanan, 4 pinjaman).
 *  2. Renderer UJI dibangun dengan kunci publik lisensi tambahan (kunci uji
 *     sekali pakai) ke desktop/test/ui/.renderer — renderer rilis tidak
 *     tersentuh.
 *  3. Folder data Electron disiapkan: database + lisensi uji bertanda tangan
 *     Ed25519 (format identik server PHP).
 *  4. Electron dijalankan (xvfb) dengan smoke-ui.js yang menelusuri layar
 *     utama dan menyimpan screenshot ke KOPKU_UI_OUT.
 *
 * Pemakaian: node desktop/test/ui/jalankan-ui.js <folder-keluaran> [--lewati-build]
 */
const { execSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { bundle, ROOT } = require('../bundle.js');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '.hasil'));
const LEWATI_BUILD = process.argv.includes('--lewati-build');
const KERJA = path.join(__dirname, '.kerja');
const RENDERER = path.join(__dirname, '.renderer');
const KUNCI = path.join(__dirname, '.kunci.json');
fs.mkdirSync(OUT, { recursive: true });

// Kunci uji dipakai ulang antar-jalan supaya renderer uji tidak perlu dibangun ulang.
let kunci;
if (fs.existsSync(KUNCI) && LEWATI_BUILD) kunci = JSON.parse(fs.readFileSync(KUNCI, 'utf8'));
else {
  const p = crypto.generateKeyPairSync('ed25519');
  kunci = { priv: p.privateKey.export({ type: 'pkcs8', format: 'pem' }), pub: p.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') };
  fs.writeFileSync(KUNCI, JSON.stringify(kunci));
}

(async () => {
  // 1. Data
  fs.rmSync(KERJA, { recursive: true, force: true });
  fs.mkdirSync(KERJA, { recursive: true });
  await bundle(path.join(__dirname, 'siapkan-data.ts'), path.join(KERJA, 'siapkan.js'), { desktop: true });
  const root = path.join(KERJA, 'root');
  const r = spawnSync(process.execPath, [path.join(KERJA, 'siapkan.js')], {
    env: { ...process.env, KOPKU_TEST_ROOT: root, KOPKU_TEST_DB_DIR: path.join(root, 'documents', 'SQLite'), NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
  });
  process.stdout.write(r.stdout);
  if (r.status !== 0) throw new Error('Gagal menyiapkan data: ' + r.stderr);

  // 2. Renderer uji
  if (!LEWATI_BUILD || !fs.existsSync(path.join(RENDERER, 'index.html'))) {
    const prod = 'n8czx9Yis8m5GSxpkFDzig0MjaIp1UsBUcv5ZPsDQJ8=';
    execSync(`node ${JSON.stringify(path.join(ROOT, 'desktop/scripts/build-renderer.js'))}`, {
      stdio: 'inherit',
      env: { ...process.env, KOPKU_RENDERER_OUT: RENDERER, EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS: `${prod},${kunci.pub}` },
    });
  }

  // 3. Folder data Electron
  const ud = path.join(KERJA, 'userdata');
  fs.mkdirSync(path.join(ud, 'documents', 'SQLite'), { recursive: true });
  fs.copyFileSync(path.join(root, 'documents', 'SQLite', 'koperasi.db'), path.join(ud, 'documents', 'SQLite', 'koperasi.db'));
  const deviceId = 'KOPKU-INST-' + crypto.randomBytes(32).toString('hex');
  const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const kini = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const payload = {
    license_id: 42, license_type: 'PERMANENT', cooperative_name: 'Koperasi Simpan Pinjam Sejahtera Bersama',
    device_hash: crypto.createHash('sha256').update(deviceId).digest('hex'), device_class: 'desktop',
    activated_at: kini, expires_at: null, nonce: crypto.randomBytes(8).toString('hex'), iat: kini,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const token = `${body}.${b64url(crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(kunci.priv)))}`;
  const raw = (v) => 'raw:' + Buffer.from(String(v), 'utf8').toString('base64');
  fs.writeFileSync(path.join(ud, 'secure-store.json'), JSON.stringify({
    kopku_license_device_id: raw(deviceId),
    kopku_license_activation_token: raw(token),
    kopku_license_type: raw('PERMANENT'),
    kopku_license_activated_at: raw(kini),
    kopku_license_cooperative_name: raw(payload.cooperative_name),
    kopku_license_last_verified_at: raw(Date.now()),
    kopku_license_last_server_time: raw(Date.now()),
    kopku_license_last_server_status: raw('VALID'),
  }));

  // 4. Electron
  const electron = require(path.join(ROOT, 'desktop/node_modules/electron'));
  const env = { ...process.env, KOPKU_USERDATA: ud, KOPKU_RENDERER_DIR: RENDERER, KOPKU_SMOKE: path.join(__dirname, 'smoke-ui.js'), KOPKU_SMOKE_OUT: OUT, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
  // 4b. Layar aktivasi lisensi (folder data tanpa token) — untuk melihat bingkai layar luar.
  const ud2 = path.join(KERJA, 'userdata-tanpa-lisensi');
  fs.mkdirSync(path.join(ud2, 'documents', 'SQLite'), { recursive: true });
  fs.copyFileSync(path.join(ud, 'documents', 'SQLite', 'koperasi.db'), path.join(ud2, 'documents', 'SQLite', 'koperasi.db'));
  const e2 = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', electron, path.join(ROOT, 'desktop'), '--no-sandbox'], { env: { ...env, KOPKU_USERDATA: ud2 }, encoding: 'utf8', timeout: 300000 });
  console.log(((e2.stdout || '') + (e2.stderr || '')).split('\n').filter((l) => /^(UI|SMOKE|GALAT)/.test(l)).join('\n'));

  const e = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', electron, path.join(ROOT, 'desktop'), '--no-sandbox', '--window-size=1500,920'], { env, encoding: 'utf8', timeout: 600000 });
  const log = (e.stdout || '') + (e.stderr || '');
  fs.writeFileSync(path.join(OUT, 'log.txt'), log);
  console.log(log.split('\n').filter((l) => /^(UI|SMOKE|LANGKAH|GALAT)/.test(l)).join('\n'));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

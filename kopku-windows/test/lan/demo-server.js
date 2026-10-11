'use strict';
/**
 * DEMO/UJI TAMPILAN (bukan untuk produksi): KOPKU asli headless dengan data
 * contoh + server LAN asli, agar web UI dapat dibuka di browser tanpa Electron.
 *   node test/lan/demo-server.js [port]
 * Akun: admin / Admin#Kopku2026, bendahara / Bendahara#Kopku2026,
 *       operator / Operator#Kopku2026, pengawas / Pengawas#Kopku2026 (profil Pengawas)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { muatKopku, seed, ROOT } = require('./kopkuHeadless');
const { pasangAdapter } = require(path.join(ROOT, 'electron/server/rendererAdapter'));
const { DirectServiceBridge } = require(path.join(ROOT, 'electron/server/serviceBridge'));
const { KopkuLanServer } = require(path.join(ROOT, 'electron/server'));

(async () => {
  const port = Number(process.argv[2] || 47880);
  const k = muatKopku({ lisensiValid: true });
  const s = await seed(k);
  const bridge = new DirectServiceBridge(pasangAdapter(k.ids, { tanpaRegistrasi: true }));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kopku-demo-'));
  fs.writeFileSync(path.join(dataDir, 'kopku-server.json'), JSON.stringify({ mode: 'LAN_SERVER', host: '127.0.0.1', port }));
  const srv = new KopkuLanServer({ dataDir, rendererDir: path.join(ROOT, 'renderer'), bridge, env: {}, logFile: null });
  const st = await srv.mulai();
  const t = new Date().toISOString();
  for (const [u, profil] of [['bendahara', 'IKUT_ROLE'], ['operator', 'IKUT_ROLE'], ['pengawas', 'PENGAWAS']]) {
    srv.db.run('INSERT OR REPLACE INTO lan_akses (user_id, aktif, profil, diubah_oleh, created_at, updated_at) VALUES (?,?,?,?,?,?)', s.users[u], 1, profil, s.users.admin, t, t);
  }
  console.log('DEMO SIAP', st.server, st.urlLokal);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

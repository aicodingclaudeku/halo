'use strict';
/**
 * Uji e2e sinkronisasi KOPKU (RC-S133.4): dua/tiga proses Node (DESKTOP & HP),
 * HTTP lokal sungguhan, kriptografi kanal, SQLite asli, lisensi bertanda tangan
 * Ed25519 (kunci uji, format identik dengan server PHP).
 *
 * Model yang diuji:
 *  - HP terpasang = PENYIMPANAN CADANGAN baca-saja; transaksi & input hanya di desktop;
 *  - sinkron SATU ARAH desktop → HP;
 *  - sinkron hanya antar-perangkat dengan LISENSI YANG SAMA.
 */
const { fork } = require('node:child_process');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os'); const crypto = require('node:crypto');
const { bundle } = require('../bundle.js');
const OUT = path.join(__dirname, '.out'); fs.mkdirSync(OUT, { recursive: true });
let lulus = 0, gagal = 0;
function cek(nama, kondisi, info) { if (kondisi) { lulus++; console.log('  ✓', nama); } else { gagal++; console.log('  ✗', nama, info !== undefined ? JSON.stringify(info) : ''); } }

const pasangan = crypto.generateKeyPairSync('ed25519');
const PRIV = pasangan.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUB = pasangan.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');

function agen(peran, berkas, port) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kopku-${peran}-`));
  const kunciPublik = [PUB, process.env.KOPKU_TEST_PUBKEY].filter(Boolean).join(',');
  const p = fork(berkas, [], { env: { ...process.env, EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS: kunciPublik, KOPKU_TEST_PRIVKEY: PRIV, KOPKU_PERAN: peran, KOPKU_PORT: String(port), KOPKU_TEST_ROOT: root, KOPKU_TEST_DB_DIR: path.join(root, 'documents', 'SQLite'), NODE_NO_WARNINGS: '1' } });
  let n = 0; const tunggu = new Map(); let siap;
  const siapP = new Promise((r) => (siap = r));
  p.on('message', (m) => { if (m.siap) return siap(); const t = tunggu.get(m.id); tunggu.delete(m.id); m.ok ? t.res(m.hasil) : t.rej(Object.assign(new Error(m.galat), { kode: m.kode })); });
  const c = (cmd, args) => new Promise((res, rej) => { const id = ++n; tunggu.set(id, { res, rej }); p.send({ id, cmd, args }); });
  return { c, siapP, p, root };
}
const coba = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

(async () => {
  // Butuh server lisensi PHP lokal: KOPKU_LICENSE_BASE, KOPKU_LICENSE_KEY, KOPKU_TEST_PUBKEY.
  if (!process.env.KOPKU_LICENSE_BASE || !process.env.KOPKU_LICENSE_KEY) { console.log('Lewati: server lisensi lokal tidak diset.'); process.exit(0); }
  await bundle(path.join(__dirname, 'agen.ts'), path.join(OUT, 'desktop.js'), { desktop: true });
  await bundle(path.join(__dirname, 'agen.ts'), path.join(OUT, 'hp.js'));
  const port = 47000 + Math.floor(Math.random() * 900);
  const D = agen('DESKTOP', path.join(OUT, 'desktop.js'), port);
  const H = agen('HP', path.join(OUT, 'hp.js'), port);
  await D.siapP; await H.siapP;
  try {
    await D.c('init'); await H.c('init');
    await H.c('isi', { tabel: 'koperasi', nilai: { id: 'kop-1', nama: 'Koperasi Uji', standar_akuntansi: 'SAK_EP', tahun_buku_aktif: 2026 } });
    console.log('Lisensi desktop otomatis dari HP (server lisensi PHP asli) + aturan lisensi sama');
    const akt = await H.c('aktivasiLisensi', { key: process.env.KOPKU_LICENSE_KEY, nama: 'Koperasi Uji' });
    cek('HP aktivasi via activate.php', akt === 'OK', akt);
    await D.c('mulaiServer');
    const ps = await H.c('pasang', { teks: await D.c('qr') });
    cek('HP berlisensi server → terpasang', !!ps.desktopNama, ps);
    await H.c('kirimDataHp', { alasan: 'DATA_AWAL' });
    cek('lisensi desktop aktif OTOMATIS begitu data awal terkirim (tanpa License Key)', (await D.c('lisensiValid')) === true);
    const r = await H.c('sponsor');
    cek('tidak ada pengiriman ulang bukti lisensi', r.dikirim === false, r);
    await D.c('isi', { tabel: 'anggota', nilai: { id: 'ang-S1', nomor_anggota: 'S1', nama_lengkap: 'Server', tanggal_bergabung: '2026-01-01', status: 'AKTIF', created_at: 'now', updated_at: 'now' } });
    await H.c('sync');
    const st = await H.c('status');
    cek('lisensi desktop (dari sponsor) = lisensi HP → sinkron berjalan', st.status === 'SIAP' && ((await H.c('all', { sql: "SELECT COUNT(*) n FROM anggota WHERE id='ang-S1'" }))[0].n === 1), st);
  } catch (e) { gagal++; console.error('GALAT UJI:', e); } finally { D.p.kill(); H.p.kill(); }
  console.log(`\nHasil: ${lulus} lulus, ${gagal} gagal`);
  process.exit(gagal ? 1 : 0);
})();

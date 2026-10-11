'use strict';
/**
 * Uji e2e sinkronisasi KOPKU — RC-S133.5 SINKRON MANUAL: dua proses Node
 * (DESKTOP & HP), HTTP lokal sungguhan, kriptografi kanal, SQLite asli,
 * lisensi bertanda tangan Ed25519 (kunci uji, format identik server PHP).
 *
 * Model yang diuji (keputusan pengguna 9 Okt 2026):
 *  - langkah 1: memindai QR HANYA menghubungkan (tidak ada data berubah,
 *    HP tetap dapat dipakai — tidak ada mode baca-saja);
 *  - langkah 2: kirim data manual "HP → PC" / "PC → HP" (salinan utuh,
 *    penerima diganti; backup pengaman dibuat);
 *  - permintaan dari layar desktop dijalankan HP setelah disetujui / ditolak;
 *  - tidak ada sinkron otomatis, changelog tidak membesar;
 *  - hanya perangkat dengan LISENSI YANG SAMA.
 * Model lama (cadangan baca-saja + sinkron otomatis) ada di
 * jalankan-rc-s133.4-cadangan.js sebagai arsip, tidak dijalankan `npm test`.
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
  await bundle(path.join(__dirname, 'agen.ts'), path.join(OUT, 'desktop.js'), { desktop: true });
  await bundle(path.join(__dirname, 'agen.ts'), path.join(OUT, 'hp.js'));
  const port = 47000 + Math.floor(Math.random() * 900);
  const D = agen('DESKTOP', path.join(OUT, 'desktop.js'), port);
  const H = agen('HP', path.join(OUT, 'hp.js'), port);
  await D.siapP; await H.siapP;
  try {
    await D.c('init'); await H.c('init');
    const anggota = (no, nama) => ({ tabel: 'anggota', nilai: { id: 'ang-' + no, nomor_anggota: no, nama_lengkap: nama, tanggal_bergabung: '2026-01-01', status: 'AKTIF', created_at: 'now', updated_at: 'now' } });
    const nama = async (A, id) => ((await A.c('all', { sql: 'SELECT nama_lengkap FROM anggota WHERE id = ?', params: [id] }))[0] || {}).nama_lengkap;
    const hitung = async (A, sql) => (await A.c('all', { sql }))[0].n;
    await H.c('isi', { tabel: 'koperasi', nilai: { id: 'kop-1', nama: 'Koperasi Uji', standar_akuntansi: 'SAK_EP', tahun_buku_aktif: 2026 } });
    await H.c('isi', anggota('A001', 'Budi'));
    await H.c('isi', { tabel: 'app_user', nilai: { id: 'u-1', username: 'admin', nama: 'Admin', role: 'ADMIN', aktif: 1, created_at: 'now', updated_at: 'now' } });
    await H.c('lisensiUji', { id: 7 });

    console.log('1. Langkah 1 — hubungkan (QR) tanpa mengubah data');
    await D.c('mulaiServer');
    let qr = await D.c('qr');
    const ps = await H.c('pasang', { teks: qr });
    cek('HP berlisensi #7 terhubung dengan desktop kosong', ps.desktopNama && ps.info && ps.info.setupSelesai === false, ps);
    cek('HP TIDAK menjadi baca-saja setelah memindai QR', (await H.c('jumlahRo')) === 0);
    const okHp = await coba(() => H.c('isi', anggota('A002', 'Sari di HP')));
    cek('HP tetap bisa menambah data setelah terhubung', okHp === null, okHp);
    cek('belum ada data yang dikirim ke desktop', (await hitung(D, 'SELECT COUNT(*) n FROM anggota')) === 0);
    let st = await H.c('status');
    cek('status HP: SIAP (terhubung)', st.status === 'SIAP' && /Terhubung/.test(st.pesan || ''), st);
    st = await D.c('status');
    cek('status desktop: SIAP (terhubung), bukan "pilih data awal"', st.status === 'SIAP' && /terhubung/i.test(st.pesan || ''), st);
    const mHp = await H.c('maskerUji');
    cek('izin UI HP tidak disaring (bisa input)', mHp.anggota.canCreate === true, mHp);
    cek('QR sekali pakai', /tidak berlaku/i.test((await coba(() => H.c('pasang', { teks: qr }))) || ''));

    console.log('2. Langkah 2 — Kirim data HP → PC (desktop kosong: langsung diterapkan)');
    await H.c('kirimDataHp', { alasan: 'MANUAL' });
    cek('desktop menerima seluruh data HP', (await nama(D, 'ang-A001')) === 'Budi' && (await nama(D, 'ang-A002')) === 'Sari di HP');
    cek('HP tetap bisa input setelah mengirim', (await coba(() => H.c('isi', anggota('A003', 'Joko di HP')))) === null);
    cek('desktop tetap bisa input', (await coba(() => D.c('isi', anggota('A010', 'Dewi di PC')))) === null);
    cek('tidak ada trigger baca-saja di kedua perangkat', (await H.c('jumlahRo')) === 0 && (await D.c('jumlahRo')) === 0);
    cek('changelog tidak membesar (tanpa trigger changelog)', (await hitung(H, 'SELECT COUNT(*) n FROM sync_changelog')) === 0 && (await hitung(D, 'SELECT COUNT(*) n FROM sync_changelog')) === 0);
    cek('tidak ada data yang mengalir sendiri (tanpa sinkron otomatis)', !(await nama(D, 'ang-A003')) && !(await nama(H, 'ang-A010')));

    console.log('3. Ambil data PC → HP (data HP diganti)');
    await H.c('ambilDataDesktop', { alasan: 'MANUAL' });
    cek('HP kini berisi data desktop (termasuk input di PC)', (await nama(H, 'ang-A010')) === 'Dewi di PC');
    cek('input HP yang belum dikirim ikut tergantikan (sesuai peringatan)', !(await nama(H, 'ang-A003')));
    cek('HP tetap bisa input setelah menerima', (await coba(() => H.c('isi', anggota('A004', 'Rina di HP')))) === null && (await H.c('jumlahRo')) === 0);
    const bk = await H.c('all', { sql: "SELECT COUNT(*) n FROM sync_riwayat WHERE arah = 'SNAPSHOT_MASUK'" });
    cek('riwayat HP mencatat data diterima', bk[0].n >= 1, bk);

    console.log('4. HP → PC ke desktop yang sudah berisi data: perlu persetujuan di desktop');
    await H.c('kirimDataHpLatar', { alasan: 'MANUAL' });
    let k = false;
    for (let i = 0; i < 100 && !k; i++) { await D.c('tunda', { ms: 100 }); k = (await D.c('status')).status === 'MENUNGGU_KONFIRMASI'; }
    cek('desktop meminta persetujuan', k);
    await D.c('setujui');
    cek('pengiriman selesai setelah disetujui', (await H.c('tungguKirim')) === 'OK');
    cek('desktop berisi input HP terbaru', (await nama(D, 'ang-A004')) === 'Rina di HP');

    console.log('5. Permintaan dari layar desktop');
    await D.c('isi', anggota('A020', 'Data baru di PC'));
    await D.c('keputusan', { k: 'PAKAI_DESKTOP' });
    st = await D.c('status');
    cek('desktop menunggu persetujuan HP', st.status === 'MENUNGGU_KONFIRMASI', st);
    let r = await H.c('cekPermintaan');
    cek('HP melihat permintaan "Kirim data PC → HP"', r.permintaan === 'PAKAI_DESKTOP', r);
    await H.c('tolakPermintaan');
    r = await H.c('cekPermintaan');
    cek('ditolak di HP → permintaan hilang, data HP tidak berubah', r.permintaan === null && !(await nama(H, 'ang-A020')), r);
    st = await D.c('status');
    cek('desktop diberi tahu HP menolak', st.status === 'SIAP' && /menolak/.test(st.pesan || ''), st);
    await D.c('keputusan', { k: 'PAKAI_DESKTOP' });
    await H.c('jalankanPermintaan', { k: 'PAKAI_DESKTOP' });
    cek('disetujui di HP → HP menerima data PC', (await nama(H, 'ang-A020')) === 'Data baru di PC');
    cek('permintaan selesai (tidak muncul lagi)', (await H.c('cekPermintaan')).permintaan === null);
    await H.c('isi', anggota('A030', 'Data baru di HP'));
    await D.c('keputusan', { k: 'PAKAI_HP' });
    r = await H.c('cekPermintaan');
    cek('HP melihat permintaan "Minta data HP → PC"', r.permintaan === 'PAKAI_HP', r);
    await H.c('jalankanPermintaan', { k: 'PAKAI_HP' });
    cek('disetujui di HP → desktop menerima data HP tanpa dialog kedua', (await nama(D, 'ang-A030')) === 'Data baru di HP');
    cek('permintaan selesai', (await H.c('cekPermintaan')).permintaan === null);
    await D.c('keputusan', { k: 'PAKAI_DESKTOP' });
    await D.c('keputusan', { k: null });
    cek('desktop dapat membatalkan permintaan', (await H.c('cekPermintaan')).permintaan === null);

    console.log('6. Lisensi harus SAMA');
    await H.c('lisensiUji', { id: 8 });
    const gL = await coba(() => H.c('kirimDataHp', { alasan: 'MANUAL' }));
    cek('HP berlisensi beda → kirim DITOLAK', gL && /BERBEDA|lisensi/i.test(gL), gL);
    const gA = await coba(() => H.c('ambilDataDesktop', { alasan: 'MANUAL' }));
    cek('HP berlisensi beda → ambil DITOLAK', gA && /BERBEDA|lisensi/i.test(gA), gA);
    await H.c('lisensiUji', { id: 7 });

    console.log('7. Putus hubungan');
    await H.c('putusHp');
    cek('HP diputus → data tetap ada & bisa input', (await nama(H, 'ang-A030')) === 'Data baru di HP' && (await coba(() => H.c('isi', anggota('A040', 'Mandiri')))) === null);
    st = await D.c('status');
    cek('desktop ikut melepas pasangan', st.status === 'BELUM_DIPASANGKAN', st);

    console.log('8. Pembaruan dari RC-S133.4: HP yang dulu "cadangan baca-saja" kembali bisa input');
    await H.c('sql', { sql: "CREATE TABLE IF NOT EXISTS sync_guard (id INTEGER PRIMARY KEY CHECK (id = 1), aktif INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO sync_guard (id, aktif) VALUES (1, 0);" });
    await H.c('pasangRoLama');
    const gLama = await coba(() => H.c('isi', anggota('A050', 'Masih baca-saja')));
    cek('kondisi lama: HP menolak input (trigger baca-saja RC-S133.4)', gLama && /KOPKU_HP_CADANGAN/.test(gLama), gLama);
    await H.c('modeManual');
    cek('setelah pembaruan: trigger dilepas & HP bisa input', (await H.c('jumlahRo')) === 0 && (await coba(() => H.c('isi', anggota('A051', 'Sudah bisa')))) === null);
  } catch (e) {
    gagal++;
    console.log('  ✗ PENGECUALIAN', e && e.stack ? e.stack : e);
  } finally {
    D.p.kill(); H.p.kill();
    console.log(`\nHasil: ${lulus} lulus, ${gagal} gagal`);
    process.exit(gagal ? 1 : 0);
  }
})();

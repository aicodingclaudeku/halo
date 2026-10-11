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
  await bundle(path.join(__dirname, 'agen.ts'), path.join(OUT, 'desktop.js'), { desktop: true });
  await bundle(path.join(__dirname, 'agen.ts'), path.join(OUT, 'hp.js'));
  const port = 47000 + Math.floor(Math.random() * 900);
  const D = agen('DESKTOP', path.join(OUT, 'desktop.js'), port);
  const H = agen('HP', path.join(OUT, 'hp.js'), port);
  let H2 = null;
  await D.siapP; await H.siapP;
  try {
    await D.c('init'); await H.c('init');
    const anggota = (no, nama, id) => ({ tabel: 'anggota', nilai: { id: id ?? 'ang-' + no, nomor_anggota: no, nama_lengkap: nama, tanggal_bergabung: '2026-01-01', status: 'AKTIF', created_at: 'now', updated_at: 'now' } });
    const nama = async (A, id) => ((await A.c('all', { sql: 'SELECT nama_lengkap FROM anggota WHERE id = ?', params: [id] }))[0] || {}).nama_lengkap;
    const hitung = async (A, sql) => (await A.c('all', { sql }))[0].n;
    await H.c('isi', { tabel: 'koperasi', nilai: { id: 'kop-1', nama: 'Koperasi Uji', standar_akuntansi: 'SAK_EP', tahun_buku_aktif: 2026 } });
    await H.c('isi', anggota('A001', 'Budi'));
    await H.c('isi', { tabel: 'app_user', nilai: { id: 'u-1', username: 'admin', nama: 'Admin', role: 'ADMIN', aktif: 1, created_at: 'now', updated_at: 'now' } });

    console.log('1. Pemasangan QR, diagnosis jaringan, lisensi');
    await D.c('mulaiServer');
    let qr = await D.c('qr');
    const ubahQr = (teks, ubah) => {
      const o = JSON.parse(Buffer.from(teks.slice(7).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      return 'KOPKU1:' + Buffer.from(JSON.stringify({ ...o, ...ubah })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    const gTimeout = await coba(() => H.c('pasang', { teks: ubahQr(qr, { a: ['10.255.255.1'] }) }));
    cek('desktop tak menjawab → pesan menyebut Firewall & alamat uji (bukan "Aborted")', gTimeout && /tidak menjawab/.test(gTimeout) && /Firewall/.test(gTimeout) && /kopku\/v1\/ping/.test(gTimeout), gTimeout);
    const gTolak = await coba(() => H.c('pasang', { teks: ubahQr(qr, { p: port + 1 }) }));
    cek('port tertutup → "menolak koneksi"', gTolak && /menolak koneksi/.test(gTolak), gTolak);
    const gTanpa = await coba(() => H.c('pasang', { teks: qr }));
    cek('HP tanpa lisensi → pemasangan DITOLAK', gTanpa && /tidak menyertakan lisensi/i.test(gTanpa), gTanpa);
    await H.c('lisensiUji', { id: 7 });
    qr = await D.c('qr');
    const ps = await H.c('pasang', { teks: qr });
    cek('HP berlisensi #7 + desktop belum berlisensi → terpasang', ps.desktopNama && ps.info && ps.info.setupSelesai === false, ps);
    cek('begitu QR dipindai HP LANGSUNG mode cadangan (sebelum data awal)', (await H.c('jumlahRo')) > 0);
    const gAwal = await coba(() => H.c('isi', anggota('A099', 'Sebelum data awal')));
    cek('HP terpasang belum data awal → tetap tidak bisa input', gAwal && /KOPKU_HP_CADANGAN/.test(gAwal), gAwal);
    cek('QR sekali pakai', /tidak berlaku/i.test((await coba(() => H.c('pasang', { teks: qr }))) || ''));

    console.log('2. Data awal HP → desktop (termasuk desktop dimuat ulang di tengah jalan)');
    await H.c('kirimDataHpLatar', { alasan: 'DATA_AWAL' });
    let masuk = false;
    for (let i = 0; i < 200 && !masuk; i++) {
      await D.c('tunda', { ms: 50 });
      masuk = ((await D.c('all', { sql: 'SELECT COUNT(*) n FROM koperasi' }).catch(() => [{ n: 0 }]))[0] || {}).n > 0;
    }
    await D.c('simulasiMuatUlang', { ms: 3000 });
    const hasilKirim = await H.c('tungguKirim');
    cek('HP pulih sendiri walau desktop dimuat ulang (tanpa kirim ulang)', masuk && hasilKirim === 'OK', { masuk, hasilKirim });
    cek('desktop menerima data HP', (await nama(D, 'ang-A001')) === 'Budi');
    cek('HP kini MODE CADANGAN (trigger baca-saja terpasang)', (await H.c('jumlahRo')) > 0);
    cek('desktop TIDAK mewarisi trigger baca-saja dari salinan HP', (await D.c('jumlahRo')) === 0);

    console.log('3. HP = penyimpanan cadangan baca-saja');
    const gTambah = await coba(() => H.c('isi', anggota('A009', 'Coba di HP')));
    cek('HP menambah anggota → DITOLAK', gTambah && /KOPKU_HP_CADANGAN/.test(gTambah), gTambah);
    const gUbah = await coba(() => H.c('run', { sql: "UPDATE anggota SET nama_lengkap = 'X' WHERE id = 'ang-A001'" }));
    cek('HP mengubah data → DITOLAK', gUbah && /KOPKU_HP_CADANGAN/.test(gUbah), gUbah);
    const gHapus = await coba(() => H.c('run', { sql: "DELETE FROM anggota WHERE id = 'ang-A001'" }));
    cek('HP menghapus data → DITOLAK', gHapus && /KOPKU_HP_CADANGAN/.test(gHapus), gHapus);
    const gJurnal = await coba(() => H.c('run', { sql: "INSERT INTO sequence_counter (seq_key, last_value) VALUES ('JURNAL-2026', 1)" }));
    cek('HP membuat nomor dokumen/transaksi → DITOLAK', gJurnal && /KOPKU_HP_CADANGAN/.test(gJurnal), gJurnal);
    const gRole = await coba(() => H.c('run', { sql: "UPDATE app_user SET role = 'PETUGAS' WHERE id = 'u-1'" }));
    cek('HP mengubah role akun → DITOLAK', gRole && /KOPKU_HP_CADANGAN/.test(gRole), gRole);
    const okLokal = await coba(async () => {
      await H.c('run', { sql: "INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, created_at) VALUES ('aud-hp-1','u-1','2026-10-07','10:00:00','LOGIN','app_user','u-1','now')" });
      await H.c('run', { sql: "INSERT INTO app_config (key, value, updated_at) VALUES ('koperasi.session.userId', 'u-1', 'now')" });
      await H.c('run', { sql: "UPDATE app_user SET updated_at = 'baru' WHERE id = 'u-1'" });
    });
    cek('HP tetap boleh: log audit, sesi login, kolom keamanan akun', okLokal === null, okLokal);
    const gCfg = await coba(() => H.c('run', { sql: "INSERT INTO app_config (key, value, updated_at) VALUES ('policy.X', '1', 'now')" }));
    cek('HP mengubah kebijakan koperasi → DITOLAK', gCfg && /KOPKU_HP_CADANGAN/.test(gCfg), gCfg);
    const mHp = await H.c('maskerUji'); const mPc = await D.c('maskerUji');
    cek('izin UI HP: hanya Lihat/Export (Backup tetap penuh)', mHp.anggota.canCreate === false && mHp.anggota.canEdit === false && mHp.anggota.canView === true && mHp.anggota.canExport === true && mHp.backup.canCreate === true, mHp);
    cek('izin UI desktop tidak disaring', mPc.anggota.canCreate === true);
    cek('jurnal otomatis hanya di desktop', (await D.c('bolehTugas')) === true && (await H.c('bolehTugas')) === false);
    const okPc = await coba(() => D.c('isi', anggota('A003', 'Joko')));
    cek('desktop tetap bisa menambah data', okPc === null, okPc);

    console.log('4. Sinkron satu arah desktop → HP');
    await D.c('run', { sql: "UPDATE anggota SET nama_lengkap = 'Budi Santoso' WHERE id = 'ang-A001'" });
    await D.c('run', { sql: "INSERT INTO app_config (key, value, updated_at) VALUES ('policy.UJI_SINKRON', '7', 'now'), ('koperasi.session.userId', 'u-pc', 'now')" });
    await H.c('sync');
    let st = await H.c('status');
    cek('status HP SIAP', st.status === 'SIAP', st);
    cek('HP menerima data baru & perubahan dari desktop', (await nama(H, 'ang-A003')) === 'Joko' && (await nama(H, 'ang-A001')) === 'Budi Santoso');
    cek('HP menerima kebijakan, BUKAN sesi desktop', (await hitung(H, "SELECT COUNT(*) n FROM app_config WHERE key='policy.UJI_SINKRON'")) === 1 && ((await H.c('all', { sql: "SELECT value FROM app_config WHERE key='koperasi.session.userId'" }))[0] || {}).value === 'u-1');
    cek('catatan lokal HP TIDAK dikirim ke desktop', (await hitung(D, "SELECT COUNT(*) n FROM audit_log WHERE id='aud-hp-1'")) === 0);
    await H.c('sync');
    cek('sinkron ulang tidak menggandakan', (await hitung(D, 'SELECT COUNT(*) n FROM anggota')) === 2 && (await hitung(H, 'SELECT COUNT(*) n FROM anggota')) === 2);
    await D.c('run', { sql: "DELETE FROM anggota WHERE id = 'ang-A003'" });
    await H.c('sync');
    cek('penghapusan di desktop terbawa ke HP', !(await nama(H, 'ang-A003')));
    cek('mode cadangan tetap aktif setelah sinkron', (await H.c('jumlahRo')) > 0);

    console.log('5. Sinkron hanya untuk LISENSI YANG SAMA');
    await D.c('lisensiUji', { id: 7 });
    await D.c('isi', anggota('A004', 'Rina'));
    await H.c('sync');
    cek('desktop & HP lisensi sama (#7) → sinkron berjalan', (await nama(H, 'ang-A004')) === 'Rina');
    await H.c('lisensiUji', { id: 8 });
    await D.c('isi', anggota('A005', 'Sari'));
    await H.c('sync');
    st = await H.c('status');
    cek('HP lisensi berbeda (#8) → sinkron DITOLAK', st.status === 'GALAT' && /BERBEDA/.test(st.pesan || ''), st);
    cek('tidak ada data desktop yang terkirim ke HP berlisensi beda', !(await nama(H, 'ang-A005')));
    await H.c('lisensiUji', { id: 7 });
    await H.c('sync');
    cek('kembali ke lisensi yang sama → sinkron lanjut', (await nama(H, 'ang-A005')) === 'Sari');
    H2 = agen('HP', path.join(OUT, 'hp.js'), port); await H2.siapP; await H2.c('init');
    await H2.c('lisensiUji', { id: 9 });
    const gBeda = await coba(async () => H2.c('pasang', { teks: await D.c('qr') }));
    cek('HP lain berlisensi #9 → pemasangan DITOLAK', gBeda && /BERBEDA/.test(gBeda), gBeda);

    console.log('6. Pemulihan: HP dipulihkan/direset → buku induk desktop');
    await H.c('sql', { sql: "UPDATE sqlite_sequence SET seq = 0 WHERE name = 'sync_changelog';" });
    await H.c('sync');
    st = await H.c('status');
    cek('rollback HP terdeteksi → PERLU_SINKRON_ULANG', st.status === 'PERLU_SINKRON_ULANG', st);
    await D.c('keputusan', { k: 'PAKAI_DESKTOP' });
    await H.c('sync');
    st = await H.c('status');
    cek('HP diganti salinan desktop → SIAP', st.status === 'SIAP' && (await nama(H, 'ang-A005')) === 'Sari', st);
    cek('mode cadangan terpasang lagi setelah penggantian', (await H.c('jumlahRo')) > 0);
    const gLagi = await coba(() => H.c('isi', anggota('A010', 'Coba lagi')));
    cek('HP tetap tidak bisa menambah data', gLagi && /KOPKU_HP_CADANGAN/.test(gLagi));

    console.log('7. Pemulihan desktop dari cadangan HP (persetujuan di desktop)');
    await D.c('run', { sql: "DELETE FROM anggota WHERE id = 'ang-A004'" });
    const kirim = H.c('kirimDataHp', { alasan: 'KONFLIK' });
    let ok = false; for (let i = 0; i < 40 && !ok; i++) { await D.c('tunda', { ms: 250 }); ok = await D.c('setujui'); }
    cek('desktop meminta persetujuan', ok);
    await kirim;
    cek('desktop dipulihkan dari cadangan HP', (await nama(D, 'ang-A004')) === 'Rina');
    cek('desktop tetap bisa input setelah dipulihkan', (await D.c('jumlahRo')) === 0 && (await coba(() => D.c('isi', anggota('A006', 'Tono')))) === null);
    const cadangan = fs.readdirSync(path.join(D.root, 'documents', 'backups')).filter((f) => f.startsWith('sebelum-sinkron_'));
    cek('backup pengaman desktop dibuat sebelum diganti', cadangan.length >= 1, cadangan);

    console.log('8. Putus dari desktop (konfirmasi di UI) → HP tetap cadangan → pindai lagi = otomatis cadangan');
    await D.c('isi', anggota('A020', 'Sebelum putus'));
    await H.c('sync');
    await D.c('putusDesktop');
    await D.c('isi', anggota('A021', 'Sesudah putus'));
    await H.c('sync');
    st = await H.c('status');
    cek('HP mendeteksi diputus desktop (pesan jelas)', st.status === 'GALAT' && /diputus dari KOPKU Desktop/i.test(st.pesan || ''), st);
    cek('HP diputus desktop TETAP baca-saja (tidak ada transaksi ganda)', (await H.c('jumlahRo')) > 0 && /KOPKU_HP_CADANGAN/.test((await coba(() => H.c('isi', anggota('A022', 'X')))) || ''));
    cek('data desktop sesudah putus tidak terkirim', !(await nama(H, 'ang-A021')));
    // HP sempat "memodifikasi" data lewat jalur di luar aplikasi — pindai ulang harus tetap menyamakan ke desktop.
    const hasilPasang = await H.c('pasangCadangan', { teks: await D.c('qr') });
    cek('pindai QR lagi → otomatis ambil data desktop (tanpa memilih)', hasilPasang.arah === 'AMBIL_DESKTOP', hasilPasang);
    const pz = await H.c('pasanganHp');
    cek('HP terpasang ulang dengan baseline & tanpa tanda diputus', !!pz.baseline && !pz.diputusDesktop, pz);
    cek('HP otomatis mode cadangan setelah pindai ulang', (await H.c('jumlahRo')) > 0);
    cek('HP berisi data desktop terbaru', (await nama(H, 'ang-A021')) === 'Sesudah putus');
    await D.c('isi', anggota('A023', 'Sesudah sambung'));
    await H.c('sync');
    cek('sinkron satu arah berjalan lagi', (await nama(H, 'ang-A023')) === 'Sesudah sambung' && (await H.c('status')).status === 'SIAP');
    const cadHp = fs.readdirSync(path.join(H.root, 'documents', 'backups')).filter((f) => f.startsWith('sebelum-sinkron_'));
    cek('backup pengaman HP dibuat sebelum data HP diganti', cadHp.length >= 1, cadHp);

    console.log('9. Offline lalu tersambung kembali; putus dari HP');
    D.p.kill(); await new Promise((r) => setTimeout(r, 300));
    await H.c('sync');
    st = await H.c('status');
    cek('desktop mati → TIDAK_TERHUBUNG (data HP tetap utuh)', st.status === 'TIDAK_TERHUBUNG' && (await nama(H, 'ang-A004')) === 'Rina', st);
    await H.c('putusHp');
    cek('putus dari HP → HP keluar mode cadangan & bisa input mandiri', (await H.c('jumlahRo')) === 0 && (await coba(() => H.c('isi', anggota('A030', 'Mandiri')))) === null && !(await H.c('pasanganHp')));
  } catch (e) {
    gagal++; console.error('GALAT UJI:', e);
  } finally {
    D.p.kill(); H.p.kill(); if (H2) H2.p.kill();
  }
  console.log(`\nHasil: ${lulus} lulus, ${gagal} gagal`);
  process.exit(gagal ? 1 : 0);
})();

'use strict';
/**
 * Backup & restore KOPKU existing tetap berjalan saat LAN Server Mode aktif:
 *  - createBackup / restoreBackup = service ASLI (format .kdb terenkripsi);
 *  - koperasi.db hasil restore tetap schema v81 (DIPERBARUI 1.0.17; sebelumnya v80) dan dibaca API LAN;
 *  - kopku-server.db (sesi, audit, log WhatsApp) terpisah dan tidak ikut
 *    tertimpa/terhapus oleh restore.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { siapkan, Klien, PASSWORD } = require('./kit');

let K;
let A;
before(async () => {
  K = await siapkan();
  A = new Klien(K.base);
  assert.equal((await A.login('admin', PASSWORD.admin)).status, 200);
});
after(async () => {
  await K.srv.henti();
});

test('backup → transaksi LAN → restore → API membaca data hasil restore; server DB utuh', async () => {
  const R = K.k.R;
  const sebelum = await A.req('POST', '/api/anggota', { namaLengkap: 'Sebelum Backup', tanggalBergabung: '2026-09-01' });
  assert.equal(sebelum.status, 200);
  const bk = await R('backup').createBackup(K.s.users.admin);
  assert.match(bk.fileName, /\.kdb$/);
  // Catatan temuan (kode existing, TIDAK diubah): restoreBackup membuat backup pengaman bernama
  // timestamp resolusi 1 detik; restore backup yang dibuat pada detik yang sama menimpa berkas target.
  await new Promise((r) => setTimeout(r, 1100));
  const sesudah = await A.req('POST', '/api/anggota', { namaLengkap: 'Sesudah Backup', tanggalBergabung: '2026-09-02' });
  assert.equal(sesudah.status, 200);
  const auditSebelum = K.srv.db.get('SELECT COUNT(*) n FROM audit_lan').n;
  const daftar = await R('backup').listBackups();
  const target = daftar.find((b) => b.fileName === bk.fileName);
  assert.ok(target, 'backup terdaftar');
  await R('backup').restoreBackup(target.uri, K.s.users.admin);
  K.srv.api._statusCache = null;
  const d = await K.R_db();
  assert.equal((await d.getFirstAsync('SELECT version FROM schema_meta')).version, 81); // DIPERBARUI 1.0.17 / RC-S133.6.2: skema v81
  const cari = async (nama) => (await A.req('GET', '/api/anggota?cari=' + encodeURIComponent(nama))).body.data.baris.length;
  assert.equal(await cari('Sebelum Backup'), 1);
  assert.equal(await cari('Sesudah Backup'), 0, 'data setelah backup hilang sesuai restore');
  assert.ok(K.srv.db.get('SELECT COUNT(*) n FROM audit_lan').n >= auditSebelum, 'audit LAN tidak tertimpa restore');
  const bayar = await A.req('GET', `/api/pinjaman/${K.s.pinjaman[0]}`);
  assert.equal(bayar.status, 200);
});

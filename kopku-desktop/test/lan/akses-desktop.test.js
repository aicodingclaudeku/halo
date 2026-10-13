'use strict';
/**
 * Windows 1.0.21 — Akses LAN pengguna, sesi aktif & audit log LAN diatur dari
 * layar desktop (Pengaturan › LAN & WhatsApp → IPC lanmu:akses*, lanmu:sesi*,
 * lanmu:audit). Browser tidak lagi punya endpoint pengaturan.
 * (proses terpisah: satu DB per proses)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { siapkan, Klien, PASSWORD } = require('./kit');

test('Akses LAN, sesi aktif & cabut sesi diatur dari desktop', async () => {
  const K = await siapkan();
  try {
    const u = await K.bridge.panggil('auth.user', { userId: K.s.users.bendahara }, {});
    const daftar0 = await K.srv.aksesDaftar([u]);
    assert.equal(daftar0[0].aksesLan, false, 'bawaan: non-Admin belum punya akses');
    assert.equal((await new Klien(K.base).login('bendahara', PASSWORD.bendahara)).status, 403);
    await K.srv.aksesSimpan({ pengguna: u, aktif: true, profil: 'IKUT_ROLE', oleh: { userId: K.s.users.admin, username: 'admin' } });
    const daftar1 = await K.srv.aksesDaftar([u]);
    assert.equal(daftar1[0].aksesLan, true);
    const c = new Klien(K.base);
    assert.equal((await c.login('bendahara', PASSWORD.bendahara)).status, 200);
    const sesi = await K.srv.sesiDaftar();
    const milik = sesi.find((s) => s.userId === u.id);
    assert.ok(milik, 'sesi bendahara terlihat di desktop');
    await K.srv.sesiCabut({ id: milik.id, oleh: { userId: K.s.users.admin, username: 'admin' } });
    assert.equal((await c.req('GET', '/api/pinjaman')).status, 401, 'cabut sesi berlaku segera');
    // admin tidak dapat menurunkan akses sendiri
    const adm = await K.bridge.panggil('auth.user', { userId: K.s.users.admin }, {});
    await assert.rejects(() => K.srv.aksesSimpan({ pengguna: adm, aktif: false, profil: 'IKUT_ROLE', oleh: { userId: adm.id, username: 'admin' } }), /akun sendiri/);
    await assert.rejects(() => K.srv.aksesSimpan({ pengguna: u, aktif: true, profil: 'SUPER' }), /Profil/);
    const audit = (await K.srv.auditDaftar({})).baris;
    assert.ok(audit.some((r) => r.action === 'LAN_AKSES_UBAH' && r.username === 'admin'));
    assert.ok(audit.some((r) => r.action === 'SESI_CABUT'));
  } finally {
    await K.srv.henti();
  }
});

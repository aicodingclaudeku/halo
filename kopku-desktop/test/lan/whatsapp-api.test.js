'use strict';
/**
 * WhatsApp Reminder — sejak Windows 1.0.21 HANYA diatur dari layar desktop
 * (Pengaturan › LAN & WhatsApp → KopkuLanServer.wa*). Browser LAN tidak punya
 * endpoint pengaturan apa pun. Uji: endpoint web tidak ada, token tidak pernah
 * keluar, pesan uji hanya ke nomor admin, log tersamar, saklar ON/OFF.
 * (proses terpisah: satu DB per proses)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { siapkan, Klien, PASSWORD } = require('./kit');

const TOKEN = 'EAAGtokenRAHASIAuji1234567890abcdefXYZ';
const ENV = { WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_TEMPLATE_NAME: 'kopku_pengingat_angsuran', WHATSAPP_API_VERSION: 'v21.0' };

test('WhatsApp: tidak ada pengaturan di web; desktop menjaga token, nomor uji & log', async () => {
  const kirimApi = [];
  const K = await siapkan({
    env: ENV,
    fetch: async (url, init) => {
      kirimApi.push({ url, init });
      if (/fields=/.test(url)) return { status: 200, json: async () => ({ display_phone_number: '+62 811 0000', verified_name: 'Koperasi Uji', quality_rating: 'GREEN' }) };
      return { status: 200, json: async () => ({ messages: [{ id: 'wamid.TEST1' }] }) };
    },
  });
  try {
    // ---- browser: semua endpoint pengaturan WhatsApp sudah tidak ada (Admin sekalipun)
    const a = new Klien(K.base);
    await a.login('admin', PASSWORD.admin);
    for (const [m, p] of [
      ['GET', '/api/whatsapp/pengaturan'],
      ['PUT', '/api/whatsapp/pengaturan'],
      ['PUT', '/api/whatsapp/token'],
      ['POST', '/api/whatsapp/token/hapus'],
      ['POST', '/api/whatsapp/test-koneksi'],
      ['POST', '/api/whatsapp/test-pesan'],
      ['GET', '/api/whatsapp/log'],
      ['POST', '/api/whatsapp/jalankan'],
    ]) {
      const r = await a.req(m, p, m === 'GET' ? null : { aktif: true });
      assert.equal(r.status, 404, `${m} ${p} harus tidak ada di web, dapat ${r.status}`);
    }
    const sesi = (await a.req('GET', '/api/auth/sesi')).body.data;
    for (const k of ['waLihat', 'waUbah', 'adminLan', 'auditLihat']) assert.ok(!(k in sesi.menu), `menu ${k} tidak dikirim ke browser`);

    // ---- desktop (IPC lanmu:wa*): token tidak pernah dikembalikan
    const g = await K.srv.waInfo();
    assert.ok(!JSON.stringify(g).includes(TOKEN));
    assert.equal(g.kredensial.accessTokenTersedia, true);
    assert.equal(g.kredensial.sumberAccessToken, 'ENV');
    await assert.rejects(() => K.srv.waTestPesan(), /Nomor Test/);
    await assert.rejects(() => K.srv.waSimpan({ nomorTest: '12345' }));
    await K.srv.waSimpan({ jamKirim: '08:00', nomorTest: '0811-2222-3333' });
    await K.srv.aturWhatsApp(true);
    const tk = await K.srv.waTestKoneksi();
    assert.equal(tk.ok, true);
    K.srv._testTerakhir = 0;
    const tp = await K.srv.waTestPesan();
    assert.equal(tp.status, 'sent');
    const kirimPesan = kirimApi.filter((x) => x.init.method === 'POST');
    assert.equal(kirimPesan.length, 1);
    assert.equal(JSON.parse(kirimPesan[0].init.body).to, '6281122223333', 'hanya nomor test admin');
    await assert.rejects(() => K.srv.waTestPesan(), /sekali per menit/);
    const log = await K.srv.waLog({ status: 'sent' });
    assert.ok(log.baris.every((r) => r.status === 'sent'));
    assert.ok(!JSON.stringify(log).includes('6281122223333'), 'nomor ditampilkan tersamar');

    // token lewat layar desktop: secure store, write-only
    delete K.env.WHATSAPP_ACCESS_TOKEN;
    const t = await K.srv.waSimpanToken('EAAGtokenLEWATui0987654321zzzz');
    assert.equal(t.kredensial.sumberAccessToken, 'SECURE_STORE');
    assert.ok(!JSON.stringify(t).includes('EAAGtokenLEWATui'));
    const aud = JSON.stringify(K.srv.db.all('SELECT * FROM audit_lan')) + fs.readFileSync(path.join(K.dataDir, 'kopku-server.db')).toString('latin1');
    assert.ok(!aud.includes('EAAGtokenLEWATui'), 'token tidak ada di audit maupun berkas DB server');
    assert.ok(!aud.includes(TOKEN));

    // saklar OFF dari desktop → penjadwal berhenti, Server LAN tetap online
    assert.equal(K.srv.status().whatsapp.berjalan, true);
    const off = await K.srv.aturWhatsApp(false);
    assert.equal(off.whatsapp.berjalan, false, 'scheduler berhenti saat WhatsApp OFF');
    assert.equal(off.server, 'ONLINE');
    const on = await K.srv.aturWhatsApp(true);
    assert.equal(on.whatsapp.berjalan, true);

    // audit perubahan dari desktop tercatat di Audit Log LAN (dibaca layar desktop)
    const audit = (await K.srv.auditDaftar({ limit: 50 })).baris.map((r) => r.action);
    for (const x of ['WA_PENGATURAN_UBAH', 'WA_TEST_KONEKSI', 'WA_TEST_PESAN', 'WA_TOKEN_UBAH']) assert.ok(audit.includes(x), 'audit ' + x);
  } finally {
    await K.srv.henti();
  }
});

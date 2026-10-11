'use strict';
/** WhatsApp lewat API LAN: kerahasiaan token, test message, log. (proses terpisah: satu DB per proses) */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { siapkan, Klien, PASSWORD } = require('./kit');

const TOKEN = 'EAAGtokenRAHASIAuji1234567890abcdefXYZ';
const ENV = { WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_TEMPLATE_NAME: 'kopku_pengingat_angsuran', WHATSAPP_API_VERSION: 'v21.0' };

test('API WhatsApp: token tidak dikirim ke browser, test message hanya ke nomor admin, log terfilter', async () => {
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
    const a = new Klien(K.base);
    await a.login('admin', PASSWORD.admin);
    const g = await a.req('GET', '/api/whatsapp/pengaturan');
    assert.equal(g.status, 200);
    assert.ok(!JSON.stringify(g.body).includes(TOKEN));
    assert.equal(g.body.data.kredensial.accessTokenTersedia, true);
    assert.equal(g.body.data.kredensial.sumberAccessToken, 'ENV');
    const tanpaNomor = await a.req('POST', '/api/whatsapp/test-pesan', {});
    assert.equal(tanpaNomor.status, 422);
    const salah = await a.req('PUT', '/api/whatsapp/pengaturan', { nomorTest: '12345' });
    assert.equal(salah.status, 422);
    assert.equal((await a.req('PUT', '/api/whatsapp/pengaturan', { aktif: true, jamKirim: '08:00', nomorTest: '0811-2222-3333' })).status, 200);
    const tk = await a.req('POST', '/api/whatsapp/test-koneksi', {});
    assert.equal(tk.status, 200);
    assert.equal(tk.body.data.ok, true);
    const tp = await a.req('POST', '/api/whatsapp/test-pesan', { nomor: '081299999999', to: '081299999999' });
    assert.equal(tp.status, 200, JSON.stringify(tp.body));
    assert.equal(tp.body.data.status, 'sent');
    const kirimPesan = kirimApi.filter((x) => x.init.method === 'POST');
    assert.equal(kirimPesan.length, 1);
    assert.equal(JSON.parse(kirimPesan[0].init.body).to, '6281122223333', 'hanya nomor test admin, bukan nomor dari request');
    const lagi = await a.req('POST', '/api/whatsapp/test-pesan', {});
    assert.equal(lagi.status, 429, 'dibatasi sekali per menit');
    const log = await a.req('GET', '/api/whatsapp/log?status=sent');
    assert.equal(log.status, 200);
    assert.ok(log.body.data.baris.every((r) => r.status === 'sent'));
    assert.ok(!JSON.stringify(log.body).includes('6281122223333'), 'nomor ditampilkan tersamar');
    // token lewat UI disimpan di secure store, write-only
    const env2 = K.env;
    delete env2.WHATSAPP_ACCESS_TOKEN;
    const t = await a.req('PUT', '/api/whatsapp/token', { token: 'EAAGtokenLEWATui0987654321zzzz' });
    assert.equal(t.status, 200);
    assert.equal(t.body.data.kredensial.sumberAccessToken, 'SECURE_STORE');
    assert.ok(!JSON.stringify(t.body).includes('EAAGtokenLEWATui'));
    const aud = JSON.stringify(K.srv.db.all('SELECT * FROM audit_lan')) + fs.readFileSync(path.join(K.dataDir, 'kopku-server.db')).toString('latin1');
    assert.ok(!aud.includes('EAAGtokenLEWATui'), 'token tidak ada di audit maupun berkas DB server');
    assert.ok(!aud.includes(TOKEN));
    const st = await a.req('GET', '/api/whatsapp/pengaturan');
    assert.equal(st.body.data.scheduler.berjalan, true, 'scheduler berjalan di server');
    // saklar OFF dari Panel Web → penjadwal berhenti, Server LAN tetap online
    assert.equal((await a.req('PUT', '/api/whatsapp/pengaturan', { aktif: false })).status, 200);
    const st2 = await a.req('GET', '/api/whatsapp/pengaturan');
    assert.equal(st2.body.data.scheduler.berjalan, false, 'scheduler berhenti saat WhatsApp OFF');
    assert.equal(K.srv.status().server, 'ONLINE');
    assert.equal((await a.req('PUT', '/api/whatsapp/pengaturan', { aktif: true })).status, 200);
    assert.equal(K.srv.status().whatsapp.berjalan, true);
  } finally {
    await K.srv.henti();
  }
});


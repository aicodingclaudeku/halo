'use strict';
/** Saklar ON/OFF berdiri sendiri: WhatsApp Reminder tanpa Server LAN, bertahan setelah KOPKU dibuka ulang. (proses terpisah: satu DB per proses) */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { siapkan } = require('./kit');

const ENV = { WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_ACCESS_TOKEN: 'EAAGtokenRAHASIAuji1234567890abcdefXYZ', WHATSAPP_TEMPLATE_NAME: 'kopku_pengingat_angsuran', WHATSAPP_API_VERSION: 'v21.0' };

test('KOPKU dibuka ulang dengan Server LAN OFF + WhatsApp ON → hanya penjadwal yang berjalan (port tertutup)', async () => {
  const K = await siapkan({ env: ENV, fetch: async () => ({ status: 200, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }) });
  try {
    await K.srv.aturWhatsApp(true);
    await K.srv.aturMode('DESKTOP');
    assert.equal(K.srv.status().whatsapp.berjalan, true, 'WhatsApp tetap jalan walau LAN dimatikan');
    await K.srv.henti();
    const srv2 = K.buatServer();
    const st = await srv2.mulaiBilaAktif();
    try {
      assert.equal(st.server, 'NOT_CONFIGURED');
      assert.equal(st.lanAktif, false);
      assert.equal(st.whatsapp.aktif, true);
      assert.equal(st.whatsapp.berjalan, true);
      await assert.rejects(fetch(`${K.base}/api/health`), 'port LAN tertutup');
      // keduanya OFF → tidak ada yang berjalan setelah dibuka ulang
      await srv2.aturWhatsApp(false);
      assert.equal(srv2.status().whatsapp.berjalan, false);
      assert.equal(srv2.db, null, 'kopku-server.db ditutup saat semua OFF');
    } finally {
      await srv2.henti();
    }
    const srv3 = K.buatServer();
    const st3 = await srv3.mulaiBilaAktif();
    assert.equal(st3.whatsapp.berjalan, false);
    assert.equal(st3.server, 'NOT_CONFIGURED');
    await srv3.henti();
  } finally {
    await K.srv.henti();
  }
});

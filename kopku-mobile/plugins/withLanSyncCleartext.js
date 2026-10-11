/**
 * Plugin config Expo — SINKRON HP⇄DESKTOP LEWAT WI-FI LOKAL.
 *
 * Android 9+ memblokir HTTP polos secara bawaan. Sinkron dengan KOPKU
 * Desktop memakai HTTP ke alamat IP lokal (192.168.x.x) karena sertifikat
 * TLS untuk IP LAN tidak mungkin diterbitkan; keamanan dijamin oleh
 * enkripsi ujung-ke-ujung XChaCha20-Poly1305 di setiap pesan
 * (src/sync/SyncKripto.ts), bukan oleh TLS.
 *
 * Plugin ini HANYA menyalakan `android:usesCleartextTraffic`. Seluruh
 * panggilan lain aplikasi (server lisensi, pengumuman) tetap HTTPS — lihat
 * LICENSE_API_BASE ("HTTPS saja") di src/config/license.ts.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withLanSyncCleartext(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application && cfg.modResults.manifest.application[0];
    if (app) app.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });
};

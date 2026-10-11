/**
 * Plugin config Expo — kamera HANYA untuk memindai QR pemasangan KOPKU
 * Desktop (Pengaturan › Sinkron Desktop). Membungkus plugin resmi
 * `expo-camera` dengan opsi tetap: tanpa mikrofon/rekam audio.
 *
 * `expo-camera` adalah dependensi baru sejak RC-S133. Bila node_modules
 * dibuat sebelum RC-S133, modul ini belum terpasang — jalankan `npm install`.
 */
let withCamera;
try {
  withCamera = require('expo-camera/plugin/build/withCamera').default;
} catch (e) {
  if (e && e.code === 'MODULE_NOT_FOUND') {
    throw new Error(
      '[withKameraPindaiQr] Paket `expo-camera` belum terpasang di node_modules ' +
        '(dependensi baru sejak RC-S133). Jalankan `npm install` di folder proyek, ' +
        'lalu ulangi `npx expo start -c`.'
    );
  }
  throw e;
}

module.exports = function withKameraPindaiQr(config) {
  return withCamera(config, {
    cameraPermission: 'KOPKU memakai kamera hanya untuk memindai QR pemasangan KOPKU Desktop.',
    microphonePermission: false,
    recordAudioAndroid: false,
  });
};

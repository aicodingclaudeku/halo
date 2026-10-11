/**
 * Konfigurasi Metro.
 *
 * Untuk build Android (EAS / expo start) berkas ini IDENTIK dengan bawaan
 * Expo — satu-satunya tambahan adalah `blockList` folder build desktop
 * (node_modules Electron & hasil build) supaya tidak ikut dipindai Metro.
 *
 * Saat KOPKU_DESKTOP=1 dan platform `web` (dipakai `desktop/scripts/
 * build-renderer.js`), modul native Expo dialihkan ke shim desktop di
 * `desktop/shims/` yang memanggil proses utama Electron.
 */
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

const blok = [/[\\/]desktop[\\/](node_modules|renderer|dist|test[\\/]e2e[\\/]\.out)[\\/].*/];
const lama = config.resolver.blockList;
config.resolver.blockList = [...(Array.isArray(lama) ? lama : lama ? [lama] : []), ...blok];

if (process.env.KOPKU_DESKTOP === '1') {
  const shim = (f) => path.join(__dirname, 'desktop', 'shims', f);
  const PETA = {
    'expo-sqlite': shim('expo-sqlite.js'),
    'expo-file-system': shim('expo-file-system.js'),
    'expo-file-system/legacy': shim('expo-file-system-legacy.js'),
    'expo-secure-store': shim('expo-secure-store.js'),
    'expo-print': shim('expo-print.js'),
    'expo-sharing': shim('expo-sharing.js'),
    'expo-document-picker': shim('expo-document-picker.js'),
    'expo-image-picker': shim('expo-image-picker.js'),
    'expo-local-authentication': shim('expo-local-authentication.js'),
    'expo-task-manager': shim('expo-task-manager.js'),
    'expo-background-task': shim('expo-background-task.js'),
    'expo-camera': shim('expo-camera.js'),
    '@react-native-community/datetimepicker': shim('datetimepicker.js'),
  };
  const sebelumnya = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (platform === 'web' && PETA[moduleName]) return { type: 'sourceFile', filePath: PETA[moduleName] };
    return (sebelumnya || context.resolveRequest)(context, moduleName, platform);
  };
}

module.exports = config;

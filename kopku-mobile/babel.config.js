/**
 * Konfigurasi Babel untuk Metro bundler (Fase 10 - final audit).
 *
 * TEMUAN KRITIS: file ini sebelumnya TIDAK ADA SAMA SEKALI di project,
 * padahal 78 file di src/ memakai alias impor "@/..." (mis.
 * "@/services/AuthService"). Alias itu sudah dikenali TypeScript
 * (tsconfig.json paths) dan Jest (jest.config.js moduleNameMapper) —
 * tapi KEDUANYA hanya berlaku untuk typecheck & unit test, BUKAN untuk
 * Metro bundler yang dipakai `expo start`/build sungguhan. Tanpa babel
 * config ini, aplikasi akan gagal total saat dijalankan di
 * perangkat/emulator dengan error "Unable to resolve module @/...".
 *
 * "module-resolver" di bawah SENGAJA disamakan persis dengan
 * tsconfig.json ("@/*" -> "./src/*") supaya ketiga alat (TypeScript,
 * Jest, Metro) selalu konsisten.
 */
module.exports = function (api) {
  // KOPKU Desktop: bundel web memerlukan transformasi `import.meta` (paket
  // ESM seperti zustand memakainya; skrip web Expo bukan type=module).
  // Build Android (tanpa KOPKU_DESKTOP) memakai preset PERSIS seperti semula.
  const desktop = process.env.KOPKU_DESKTOP === '1';
  api.cache.using(() => (desktop ? 'desktop' : 'native'));
  return {
    presets: desktop ? [['babel-preset-expo', { unstable_transformImportMeta: true }]] : ['babel-preset-expo'],
    plugins: [
      [
        'module-resolver',
        {
          root: ['.'],
          alias: {
            '@': './src',
          },
          extensions: ['.ios.js', '.android.js', '.js', '.jsx', '.ts', '.tsx', '.json'],
        },
      ],
    ],
  };
};

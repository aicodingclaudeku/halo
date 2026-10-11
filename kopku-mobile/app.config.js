/**
 * Konfigurasi Expo dinamis. Tanpa KOPKU_DESKTOP=1 (build Android/EAS)
 * konfigurasi app.json dikembalikan APA ADANYA.
 * Dengan KOPKU_DESKTOP=1, platform `web` ditambahkan khusus untuk membuat
 * bundel renderer aplikasi desktop (Electron).
 */
module.exports = ({ config }) => {
  if (process.env.KOPKU_DESKTOP !== '1') return config;
  return {
    ...config,
    platforms: [...new Set([...(config.platforms || []), 'web'])],
    web: { ...(config.web || {}), output: 'single', bundler: 'metro', favicon: './assets/icon.png', name: 'KOPKU Desktop' },
  };
};

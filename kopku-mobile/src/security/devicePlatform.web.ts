/**
 * RC-S125 — dipilih Metro untuk build web. Build web KOPKU adalah aplikasi
 * DESKTOP (Electron): laporkan sistem operasinya supaya server lisensi
 * menghitungnya di slot Laptop/PC ('windows'/'macos' — lihat
 * LicensePolicy.php). Tanpa jembatan desktop → 'web' (juga slot desktop).
 */
export function getDevicePlatform(): string {
  const p = (globalThis as unknown as { kopkuDesktop?: { info?: { platform?: string } } }).kopkuDesktop?.info?.platform;
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  if (p === 'linux') return 'linux';
  return 'web';
}

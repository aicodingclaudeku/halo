/**
 * NATIVE SPLASH ANDROID POLOS — tidak ada gambar/logo sebelum SplashIntro.
 *
 * Diverifikasi juga lewat `expo prebuild --platform android` (lihat laporan):
 * Theme.App.SplashScreen memuat ikon splash transparan, drawable
 * ic_launcher_background hanya warna, dan tidak ada splashscreen_logo.png.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { splashTema } from '@/theme/colors';

const ROOT = join(__dirname, '..', '..');
const app = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8')).expo;
const plugin = readFileSync(join(ROOT, 'plugins/withSplashNativePolos.js'), 'utf8');

describe('native splash Android polos', () => {
  it('konfigurasi splash tanpa gambar (light & dark), plugin lokal terdaftar', () => {
    expect(app.android.splash).toEqual({
      backgroundColor: splashTema.terang.background,
      // RC-S123 — mode gelap perangkat memakai warna TERANG yang sama: aplikasi
      // dikunci terang, dan tanpa expo-system-ui kunci app.json tidak berlaku
      // di build Android (penyebab splash hitam di APK, putih di Expo Go).
      dark: { backgroundColor: splashTema.terang.background },
    });
    expect(app.splash).toBeUndefined();
    expect(JSON.stringify(app)).not.toMatch(/splash-icon|"image"/);
    expect(app.plugins).toContain('./plugins/withSplashNativePolos');
  });

  it('warna native splash = latar SplashIntro (tanpa kedip saat peralihan)', () => {
    expect(app.backgroundColor).toBe(splashTema.terang.background);
    expect(app.android.splash.backgroundColor).toBe(splashTema.terang.background);
    // RC-S123 — terang di kedua mode, sama dengan SplashIntro yang kini selalu terang.
    expect(app.android.splash.dark.backgroundColor).toBe(splashTema.terang.background);
  });

  it('plugin: ikon splash Android 12+ transparan, latar splash & jendela mengikuti mode', () => {
    expect(plugin).toContain("['android:windowSplashScreenAnimatedIcon', `@drawable/${DRAWABLE_POLOS}`]");
    expect(plugin).toContain("['android:windowSplashScreenBackground', '@color/splashscreen_background']");
    expect(plugin).toContain('<solid android:color="@android:color/transparent" />');
    expect(plugin).toMatch(/withAndroidColorsNight[\s\S]*activityBackground/);
    expect(plugin).toContain("require('expo/config-plugins')");
    // Tanpa kode native & tanpa dependensi baru.
    expect(plugin).not.toMatch(/withMainActivity|withMainApplication|expo-splash-screen'/);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies['expo-splash-screen']).toBeUndefined();
  });

  it('plugin dapat dimuat dan mendaftarkan mod Android', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const withSplashNativePolos = require(join(ROOT, 'plugins/withSplashNativePolos.js'));
    const hasil = withSplashNativePolos({ name: 'Kopku', slug: 'kopku', android: app.android });
    expect(Object.keys(hasil.mods.android)).toEqual(expect.arrayContaining(['dangerous', 'styles', 'colorsNight']));
  });

  it('aset lama tidak dihapus', () => {
    expect(existsSync(join(ROOT, 'assets/splash-icon.png'))).toBe(true);
    expect(existsSync(join(ROOT, 'assets/icon.png'))).toBe(true);
  });
});

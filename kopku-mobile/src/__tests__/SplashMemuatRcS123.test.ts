import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S123 — tampilan memuat: splash konsisten terang (Expo Go = APK) dan
 * indikator memuat bermerek di layar tunggu tingkat aplikasi.
 * Struktural — renderer RN tidak tersedia di lingkungan ini.
 */
const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('RC-S123 — indikator memuat bermerek', () => {
  const kode = strip(baca('src/components/IndikatorMemuat.tsx'));

  it('semua animasi native driver, berulang, dan dihentikan saat dilepas', () => {
    const timing = kode.match(/Animated\.timing\(/g) ?? [];
    const native = kode.match(/useNativeDriver: true/g) ?? [];
    expect(timing.length).toBeGreaterThan(0);
    expect(native.length).toBe(timing.length);
    expect(kode).toMatch(/return \(\) => \{\s*orbit\.stop\(\);\s*bernapas\.stop\(\);\s*kedip\.stop\(\);\s*\};/);
  });

  it('menghormati "kurangi gerakan" dan berlabel untuk pembaca layar', () => {
    expect(kode).toMatch(/AccessibilityInfo\.isReduceMotionEnabled\(\)/);
    expect(kode).toMatch(/if \(kurangiGerak\) return;/);
    expect(kode).toContain('accessibilityRole="progressbar"');
  });

  it('presentasi murni: tanpa service/store/database', () => {
    expect(kode).not.toMatch(/from '@\/(services|database|store|accounting|repositories)\//);
  });

  it.each([
    ['app/index.tsx'],
    ['src/components/LicenseGate.tsx'],
    ['src/components/FirstRunSetup.tsx'],
  ])('%s memakai IndikatorMemuat, bukan ActivityIndicator polos', (f) => {
    const s = strip(baca(f));
    expect(s).toMatch(/<IndikatorMemuat\b/);
    expect(s).not.toMatch(/<ActivityIndicator\b/);
  });

  it('layar LOADING app/index punya latar eksplisit (bukan latar jendela)', () => {
    expect(strip(baca('app/index.tsx'))).toMatch(/center: \{[^}]*backgroundColor: colors\.background/);
  });
});

describe('RC-S123 — splash sama di Expo Go dan APK', () => {
  it('SplashIntro tidak mengikuti mode gelap perangkat', () => {
    const s = strip(baca('src/components/SplashIntro.tsx'));
    expect(s).toMatch(/const p: PaletSplash = splashTema\.terang;/);
    expect(s).not.toMatch(/useColorScheme/);
  });

  it('native splash mode gelap memakai warna terang yang sama', () => {
    const app = JSON.parse(baca('app.json')).expo;
    expect(app.android.splash.dark.backgroundColor).toBe(app.android.splash.backgroundColor);
    expect(app.userInterfaceStyle).toBe('light');
  });

  it('tidak ada dependency baru (expo-system-ui tidak ditambahkan diam-diam)', () => {
    const pkg = JSON.parse(baca('package.json'));
    expect(pkg.dependencies['expo-system-ui']).toBeUndefined();
  });
});

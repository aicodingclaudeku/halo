/**
 * RC-S85 — LAYAR PEMBUKA "Kopku Finance by Alqizani" (RC-S121: sebelumnya "by Kopku").
 *
 * Tidak ada RN testing library di lingkungan ini, jadi yang dikunci adalah
 * kontraknya: durasi tepat 5 detik dari satu linimasa Animated, tanpa
 * setTimeout, overlay (bukan gerbang) yang tidak mengubah urutan
 * LicenseGate, dan logo dari assets/img.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { DURASI_TOTAL_MS, LINIMASA_SPLASH } from '@/components/splashLinimasa';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('RC-S85 — SplashIntro', () => {
  const kode = tanpaKomentar(baca('src/components/SplashIntro.tsx'));

  it('total durasi tepat 5 detik dan setiap elemen selesai muncul dalam fase pembuka', () => {
    expect(DURASI_TOTAL_MS).toBe(5000);
    const L = LINIMASA_SPLASH;
    expect(Math.max(L.logoMs, L.judulTundaMs + L.judulMs, L.subTundaMs + L.subMs)).toBe(L.pembukaMs);
  });

  it('tidak memakai setTimeout/setInterval sebagai pengatur waktu', () => {
    expect(kode).not.toMatch(/setTimeout|setInterval/);
    expect(kode).toMatch(/utama\.start\(\(\{ finished \}\) =>/);
    expect(kode).toMatch(/if \(finished\) setTampil\(false\)/);
  });

  it('semua animasi memakai native driver dan dihentikan saat unmount', () => {
    const timing = kode.match(/Animated\.timing\(/g) ?? [];
    const native = kode.match(/useNativeDriver: true/g) ?? [];
    expect(timing.length).toBeGreaterThan(0);
    expect(native.length).toBe(timing.length);
    expect(kode).toMatch(/return \(\) => \{\s*utama\.stop\(\);\s*orbit\.stop\(\);\s*aura\.stop\(\);/);
  });

  it('menghormati "kurangi gerakan"', () => {
    expect(kode).toMatch(/AccessibilityInfo\.isReduceMotionEnabled\(\)/);
    expect(kode).toMatch(/if \(!kurangiGerak\) \{\s*orbit\.start\(\);\s*aura\.start\(\);\s*\}/);
    expect(kode).toContain('const gerak = !kurangiGerak;');
  });

  it('teks merek dan logo dari assets/img', () => {
    expect(kode).toContain('Kopku Finance');
    expect(kode).toContain('by Alqizani'); // RC-S121 — sebelumnya 'by Kopku'
    expect(kode).not.toContain('by Kopku');
    expect(kode).toContain("require('../../assets/img/logo-kopku.png')");
    expect(existsSync(join(ROOT, 'assets/img/logo-kopku.png'))).toBe(true);
    // PNG RGBA (color type 6) — sudut transparan, bukan hitam.
    const png = readFileSync(join(ROOT, 'assets/img/logo-kopku.png'));
    expect(png.readUInt8(25)).toBe(6);
  });

  it('dipasang sebagai overlay terakhir; urutan LicenseGate & StatusBar default tidak berubah', () => {
    const layout = tanpaKomentar(baca('app/_layout.tsx'));
    const iGateTutup = layout.indexOf('</LicenseGate>');
    const iSplash = layout.indexOf('<SplashIntro />');
    const iProviderTutup = layout.indexOf('</SafeAreaProvider>');
    expect(iGateTutup).toBeGreaterThan(-1);
    expect(iSplash).toBeGreaterThan(iGateTutup);
    expect(iSplash).toBeLessThan(iProviderTutup);
    expect(layout).toMatch(/<StatusBar style="dark" \/>/);
    expect(layout.match(/<SplashIntro \/>/g)).toHaveLength(1);
  });

  // DIPERBARUI RC-S123: splash SELALU terang. Mengikuti mode perangkat
  // membuat APK (tanpa expo-system-ui) tampil gelap sementara Expo Go terang.
  it('palet selalu terang dari splashTema, tidak mengikuti mode perangkat', () => {
    expect(kode).toMatch(/const p: PaletSplash = splashTema\.terang;/);
    expect(kode).not.toMatch(/useColorScheme/);
    expect(kode).not.toMatch(/splashTema\.gelap/);
    expect(kode).toMatch(/<StatusBar style=\{p\.statusBar\} \/>/);
  });

  it('RC-S123 — bilah memuat: kilau & denyut berulang, dihentikan bersama linimasa', () => {
    expect(kode).toMatch(/const sapuBilah = Animated\.loop\(/);
    expect(kode).toMatch(/const denyutKepala = Animated\.loop\(/);
    expect(kode).toMatch(/if \(!kurangiGerak\) \{\s*sapuBilah\.start\(\);\s*denyutKepala\.start\(\);\s*\}/);
    expect(kode).toMatch(/aura\.stop\(\);\s*sapuBilah\.stop\(\);\s*denyutKepala\.stop\(\);\s*\};/);
  });
});

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * PART Q — HEADER TIDAK BOLEH MENUTUPI STATUS BAR ANDROID.
 *
 * ROOT CAUSE (RC-S42).
 * `RootNavigator.tsx` menyetel `headerShown: false` pada Tab.Navigator.
 * Empat tab dibungkus stack yang punya header, dan header itulah yang
 * menyediakan inset atas. `Dashboard` TIDAK: ia dipasang sebagai
 * `Tab.Screen` langsung, sehingga tidak ada header maupun stack yang
 * memberi inset.
 *
 * Jalur utama Dashboard sudah memakai `<SafeAreaView edges={['top']}>`,
 * tetapi dua early-return (loading & error) melewatinya. Pada Android
 * edge-to-edge — bawaan Expo SDK 54 — `<View>` polos menggambar sampai
 * ke balik jam dan ikon status.
 *
 * Hal yang sama berlaku untuk komponen yang dirender DI LUAR navigator:
 * `LicenseGate` dan `FirstRunSetup`.
 *
 * Suite ini menjaga sifatnya, dan sekaligus melarang solusi rapuh yang
 * §Q8 sebutkan: padding tetap, margin negatif, tinggi hardcode.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function berkasTsx(dir: string, hasil: string[] = []): string[] {
  for (const entri of readdirSync(dir)) {
    if (entri === 'node_modules' || entri === '.harness' || entri === '__tests__') continue;
    const penuh = join(dir, entri);
    if (statSync(penuh).isDirectory()) berkasTsx(penuh, hasil);
    else if (entri.endsWith('.tsx')) hasil.push(penuh);
  }
  return hasil;
}

describe('Q1. root cause terdokumentasi di navigator', () => {
  const nav = read('src/navigation/RootNavigator.tsx');

  it('Tab.Navigator memang menyetel headerShown: false', () => {
    expect(nav).toMatch(/headerShown: false/);
  });

  it('Dashboard adalah Tab.Screen langsung, tanpa stack ber-header', () => {
    // Inilah yang membuatnya berbeda dari tab lain.
    expect(nav).toMatch(/<Tab\.Screen name="Dashboard" component=\{DashboardScreen\}/);
    expect(nav).not.toMatch(/component=\{DashboardStackNavigator\}/);
  });
});

describe('Q2. layar tanpa header navigasi menghormati inset atas', () => {
  it('Dashboard: SELURUH jalur render memakai SafeAreaView', () => {
    const kode = read('src/screens/Dashboard/DashboardScreen.tsx');
    // Tiga jalur: error, loading, dan konten utama.
    const jumlah = (kode.match(/<SafeAreaView style=\{styles\.\w+\} edges=\{\['top'\]\}/g) ?? []).length;
    expect(jumlah).toBe(3);
  });

  it('Dashboard tidak lagi mengembalikan <View> polos di early-return', () => {
    const kode = read('src/screens/Dashboard/DashboardScreen.tsx');
    expect(kode).not.toMatch(/return \(\s*\n\s*<View style=\{styles\.center\}>/);
  });

  it.each([
    ['src/components/LicenseGate.tsx'],
    ['src/components/FirstRunSetup.tsx'],
  ])('%s dirender di luar navigator dan memakai SafeAreaView', (berkas) => {
    const kode = read(berkas);
    expect(kode).toMatch(/from 'react-native-safe-area-context'/);
    expect(kode).toMatch(/<SafeAreaView style=\{styles\.center\} edges=\{\['top'\]\}/);
  });
});

describe('Q8. tidak ada workaround rapuh', () => {
  const sumber = berkasTsx(join(ROOT, 'src')).concat(berkasTsx(join(ROOT, 'app')));

  /** Buang komentar: penyebutan pola di dalam penjelasan bukan pemakaian. */
  const tanpaKomentar = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('tidak ada margin atas negatif berukuran status bar', () => {
    /**
     * Ambangnya 20px, dan itu disengaja.
     *
     * Versi pertama test ini melarang SEMUA `marginTop` negatif, lalu
     * menandai empat berkas yang ternyata tidak bermasalah: `-2` untuk
     * memusatkan glyph "+" pada FAB, dan `-4`/`-8` untuk merapatkan
     * teks penjelas ke field di atasnya. Itu penyesuaian tipografi
     * biasa, bukan usaha menggeser header.
     *
     * Yang berbahaya adalah pergeseran sebesar tinggi status bar
     * (±24-48px). Melarang nudge kecil hanya akan memaksa perubahan
     * pada kode yang benar — dan test yang menuntut perubahan tak perlu
     * cepat diabaikan orang.
     */
    const pelanggaran: string[] = [];
    for (const berkas of sumber) {
      const kode = tanpaKomentar(readFileSync(berkas, 'utf8'));
      const cocok = [...kode.matchAll(/marginTop:\s*-(\d+)/g)];
      if (cocok.some((m) => Number(m[1]) >= 20)) {
        pelanggaran.push(berkas.replace(ROOT + '/', ''));
      }
    }
    expect(pelanggaran).toEqual([]);
  });

  it('tidak ada paddingTop angka tetap yang meniru tinggi status bar', () => {
    // Tinggi status bar berbeda antar-perangkat; angka tetap akan salah
    // di sebagian besar di antaranya.
    const pelanggaran: string[] = [];
    for (const berkas of sumber) {
      const kode = tanpaKomentar(readFileSync(berkas, 'utf8'));
      if (/paddingTop:\s*(24|25|30|32|40|44|48)\b/.test(kode)) {
        pelanggaran.push(berkas.replace(ROOT + '/', ''));
      }
    }
    expect(pelanggaran).toEqual([]);
  });

  it('pendeteksinya benar-benar menangkap pergeseran berukuran status bar', () => {
    // Tanpa ini, ambang yang salah akan membuat kedua test di atas
    // selalu hijau tanpa memeriksa apa pun.
    const contohSalah = "  header: { marginTop: -32 },";
    expect([...contohSalah.matchAll(/marginTop:\s*-(\d+)/g)].some((m) => Number(m[1]) >= 20)).toBe(true);
    const contohSah = "  fabIcon: { marginTop: -2 },";
    expect([...contohSah.matchAll(/marginTop:\s*-(\d+)/g)].some((m) => Number(m[1]) >= 20)).toBe(false);
  });

  it('tidak ada StatusBar.currentHeight yang dibaca langsung', () => {
    for (const berkas of sumber) {
      expect(readFileSync(berkas, 'utf8')).not.toMatch(/StatusBar\.currentHeight/);
    }
  });
});

describe('Q6. Export tetap di header dan tidak terpengaruh inset', () => {
  const kode = read('src/screens/Simpanan/SimpananHistoriScreen.tsx');

  it('Export tetap dipasang lewat headerRight navigasi', () => {
    // Header navigasi menangani inset atas sendiri, jadi Export otomatis
    // berada di bawah status bar tanpa perhitungan manual.
    expect(kode).toMatch(/headerRight: \(\) => \(/);
  });

  it('tidak ada inset manual yang ditambahkan ke tombol Export', () => {
    const blok = kode.slice(kode.indexOf('headerExportButton: {'), kode.indexOf('headerExportButton: {') + 300);
    expect(blok).not.toMatch(/insets\.top|paddingTop/);
  });
});

describe('SafeAreaProvider tunggal di root', () => {
  it('hanya ada satu SafeAreaProvider, di app/_layout.tsx', () => {
    const sumber = berkasTsx(join(ROOT, 'src')).concat(berkasTsx(join(ROOT, 'app')));
    const penyedia = sumber.filter((f) => /<SafeAreaProvider/.test(readFileSync(f, 'utf8')));
    expect(penyedia.map((f) => f.replace(ROOT + '/', ''))).toEqual(['app/_layout.tsx']);
  });
});

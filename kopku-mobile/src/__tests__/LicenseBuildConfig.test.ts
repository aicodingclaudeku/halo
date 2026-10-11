import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * KONSISTENSI KONFIGURASI BUILD.
 *
 * KENAPA SUITE INI ADA.
 * `babel.config.js` pernah HILANG SAMA SEKALI dari proyek ini,
 * sementara 337 berkas memakai alias `@/...`. TypeScript dan Jest
 * sama-sama mengenali alias itu lewat konfigurasi masing-masing,
 * sehingga typecheck hijau dan test hijau — tetapi Metro, satu-satunya
 * yang benar-benar membangun APK, tidak tahu apa-apa tentang alias itu.
 * Aplikasi akan mati saat dijalankan dengan "Unable to resolve module
 * @/...", dan tidak ada satu pun pemeriksaan otomatis yang menangkapnya.
 *
 * Itu kelas kegagalan yang paling mahal: hijau di semua tempat kecuali
 * di tempat yang menentukan. Suite ini menutupnya dengan memaksa
 * KETIGA alat menyepakati hal yang sama, dan memastikan setiap plugin
 * yang diumumkan `app.json` benar-benar terpasang.
 *
 * Semua pemeriksaan bersifat STRUKTURAL atas berkas konfigurasi —
 * tidak ada yang bisa dibuktikan dengan menjalankan kode aplikasi.
 */

const ROOT = join(__dirname, '..', '..');

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8')) as Record<string, unknown>;
}

describe('berkas konfigurasi build wajib ada', () => {
  it.each([
    ['app.json'],
    ['babel.config.js'],
    ['tsconfig.json'],
    ['jest.config.js'],
    ['eas.json'],
    ['package.json'],
  ])('%s ada di root proyek', (file) => {
    expect(existsSync(join(ROOT, file))).toBe(true);
  });
});

describe('alias "@" konsisten di TypeScript, Jest, dan Metro', () => {
  const babel = readFileSync(join(ROOT, 'babel.config.js'), 'utf8');
  const jest = readFileSync(join(ROOT, 'jest.config.js'), 'utf8');

  it('tsconfig memetakan @/* ke src/*', () => {
    const tsconfig = readJson('tsconfig.json');
    const options = tsconfig.compilerOptions as { paths?: Record<string, string[]> };
    expect(options.paths?.['@/*']).toEqual(['src/*']);
  });

  it('jest memetakan ^@/(.*)$ ke src', () => {
    expect(jest).toMatch(/'\^@\/\(\.\*\)\$':\s*'<rootDir>\/src\/\$1'/);
  });

  it('babel memakai module-resolver dengan alias @ -> ./src', () => {
    // Ini yang dipakai Metro saat build APK. Tanpa baris ini, alias
    // hanya bekerja di typecheck dan test — bukan di aplikasi nyata.
    expect(babel).toMatch(/module-resolver/);
    expect(babel).toMatch(/'@':\s*'\.\/src'/);
  });

  it('babel-plugin-module-resolver terpasang sebagai dependency', () => {
    // Konfigurasi yang menyebut plugin yang tidak terpasang gagal saat
    // bundling, bukan saat typecheck.
    const pkg = readJson('package.json');
    const dependencies = pkg.dependencies as Record<string, string>;
    const devDependencies = pkg.devDependencies as Record<string, string>;
    const installed =
      devDependencies['babel-plugin-module-resolver'] ??
      dependencies['babel-plugin-module-resolver'];
    expect(installed).toBeDefined();
  });

  it('babel memakai babel-preset-expo', () => {
    expect(babel).toMatch(/babel-preset-expo/);
  });

  it('alias benar-benar dipakai secara luas (bukan konfigurasi mati)', () => {
    // Kalau suatu saat alias tidak lagi dipakai, ketiga konfigurasi di
    // atas boleh disederhanakan. Selama masih dipakai, ketiganya wajib.
    const service = readFileSync(join(ROOT, 'src', 'services', 'LicenseService.ts'), 'utf8');
    expect(service).toMatch(/from '@\//);
  });
});

describe('app.json — plugin dan dependency sejalan', () => {
  const app = readJson('app.json');
  const expo = app.expo as Record<string, unknown>;
  const pkg = readJson('package.json');
  const dependencies = pkg.dependencies as Record<string, string>;

  it('setiap plugin yang diumumkan benar-benar terpasang', () => {
    // Plugin yang disebut tapi tidak terpasang membuat `expo prebuild`
    // gagal — dan gagalnya hanya terlihat saat build, bukan lebih awal.
    const plugins = (expo.plugins as string[]) ?? [];
    expect(plugins.length).toBeGreaterThan(0);
    for (const plugin of plugins) {
      // Plugin lokal ("./plugins/...") tidak berasal dari npm: yang wajib
      // ada adalah berkasnya. Selain itu harus terpasang sebagai dependency.
      if (plugin.startsWith('./')) {
        expect([plugin, existsSync(join(__dirname, '..', '..', `${plugin}.js`))]).toEqual([plugin, true]);
      } else {
        expect(dependencies[plugin]).toBeDefined();
      }
    }
  });

  it('expo-secure-store diumumkan sebagai plugin', () => {
    // Penyimpanan token lisensi bergantung padanya. Tanpa plugin,
    // modul native-nya tidak ikut ter-link pada build produksi.
    expect((expo.plugins as string[]) ?? []).toContain('expo-secure-store');
  });

  it('paket kripto lisensi TIDAK memerlukan config plugin', () => {
    // Bukti bahwa alur managed (tanpa `expo prebuild`) dipertahankan:
    // @noble adalah JavaScript murni, jadi ia tidak boleh muncul di
    // daftar plugin. Kalau suatu saat pindah ke pustaka native, test
    // ini akan mengingatkan bahwa konsekuensi EAS build ikut berubah.
    const plugins = (expo.plugins as string[]) ?? [];
    expect(plugins).not.toContain('@noble/ed25519');
    expect(dependencies['@noble/ed25519']).toBeDefined();
    expect(dependencies['@noble/hashes']).toBeDefined();
  });

  it('ikon yang dirujuk app.json benar-benar ada', () => {
    const icon = expo.icon as string;
    expect(existsSync(join(ROOT, icon))).toBe(true);
  });

  it('scheme deep link terdefinisi', () => {
    // Deep link TIDAK dapat melewati LicenseGate (dibuktikan di
    // LicenseRouteProtection.test.ts), tetapi scheme tetap harus ada
    // agar tautan dukungan seperti kopku://license berfungsi.
    expect(typeof expo.scheme).toBe('string');
    expect((expo.scheme as string).length).toBeGreaterThan(0);
  });

  it('package Android terdefinisi dan berbentuk applicationId yang sah', () => {
    const android = expo.android as Record<string, unknown>;
    expect(typeof android.package).toBe('string');
    expect(android.package as string).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  });
});

describe('rute lisensi dikenali struktur berkas Expo Router', () => {
  it('app/license.tsx ada sehingga /license adalah rute sah', () => {
    // `typedRoutes: true` membuat router.push('/license') diperiksa
    // compiler terhadap struktur berkas. Menghapus berkas ini akan
    // memutus tautan dari Pengaturan.
    expect(existsSync(join(ROOT, 'app', 'license.tsx'))).toBe(true);
  });

  it('Pengaturan menautkan ke rute yang benar-benar ada', () => {
    const settings = readFileSync(
      join(ROOT, 'src', 'screens', 'Pengaturan', 'PengaturanScreen.tsx'),
      'utf8'
    );
    const match = settings.match(/router\.push\('(\/[a-z-]+)'\)/);
    expect(match).not.toBeNull();
    if (match) {
      expect(existsSync(join(ROOT, 'app', `${match[1].slice(1)}.tsx`))).toBe(true);
    }
  });
});

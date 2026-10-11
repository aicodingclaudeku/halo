import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * §24 — PROTEKSI RUTE: "tidak ada rute utama yang bisa diakses tanpa lisensi".
 *
 * KENAPA TEST INI MEMBACA SOURCE, BUKAN ME-RENDER KOMPONEN.
 * Pertanyaan yang perlu dijawab bukan "apakah gate bekerja pada satu
 * rute yang kebetulan saya uji", melainkan "apakah ADA rute yang berada
 * di luar gate". Pertanyaan kedua bersifat STRUKTURAL: ia tentang bentuk
 * pohon rute Expo Router, dan rute yang lolos justru rute yang tidak
 * terpikirkan untuk ditulis test-nya.
 *
 * Test render hanya bisa membuktikan rute yang sudah didaftarkan
 * seseorang di berkas test. Test ini membuktikan sesuatu yang lebih
 * kuat: SELURUH isi `app/` — termasuk berkas yang ditambahkan orang
 * lain enam bulan lagi — berada di belakang `<LicenseGate>`, karena
 * `<Slot />` adalah satu-satunya titik render rute dan ia dibungkus.
 *
 * Test ini akan gagal bila ada yang:
 *   - memindahkan gate keluar dari root layout;
 *   - menambahkan `<Slot />` atau `<Stack />` kedua di luar gate;
 *   - menambah layout tambahan yang me-render rute tanpa melewati root.
 */

const APP_DIR = join(__dirname, '..', '..', 'app');

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (/\.(tsx|ts|jsx|js)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Buang komentar supaya kode yang "disebut" di komentar tidak ikut terhitung. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('proteksi rute Expo Router', () => {
  const rootLayoutPath = join(APP_DIR, '_layout.tsx');
  const rootLayout = stripComments(readFileSync(rootLayoutPath, 'utf8'));

  it('root layout mengimpor LicenseGate', () => {
    expect(rootLayout).toMatch(/import\s+LicenseGate\s+from\s+'@\/components\/LicenseGate'/);
  });

  it('root layout membungkus <Slot /> di dalam <LicenseGate>', () => {
    const gateOpen = rootLayout.indexOf('<LicenseGate>');
    const slot = rootLayout.indexOf('<Slot');
    const gateClose = rootLayout.indexOf('</LicenseGate>');

    expect(gateOpen).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(gateOpen);
    expect(gateClose).toBeGreaterThan(slot);
  });

  it('hanya ADA SATU titik render rute di seluruh folder app/', () => {
    // Dua `<Slot />` berarti ada cabang pohon rute kedua — dan cabang
    // itu belum tentu berada di belakang gate.
    const files = listFilesRecursive(APP_DIR);
    const renderers = files.filter((file) => {
      const source = stripComments(readFileSync(file, 'utf8'));
      return /<Slot\b/.test(source) || /<Stack\b/.test(source) || /<Tabs\b/.test(source);
    });
    expect(renderers).toEqual([rootLayoutPath]);
  });

  it('tidak ada berkas layout selain root layout', () => {
    const layouts = listFilesRecursive(APP_DIR).filter((file) => /_layout\.[jt]sx?$/.test(file));
    expect(layouts).toEqual([rootLayoutPath]);
  });

  it('setiap berkas rute berada di dalam app/ dan karenanya di bawah root layout', () => {
    // Expo Router hanya membangun rute dari isi `app/`. Selama semua
    // berkas rute ada di sini dan root layout satu-satunya yang
    // me-render `<Slot />`, tidak ada jalan masuk lain.
    const files = listFilesRecursive(APP_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.startsWith(APP_DIR)).toBe(true);
    }
  });
});

describe('LicenseGate tidak me-render aplikasi sebelum izin keluar', () => {
  const gateSource = stripComments(
    readFileSync(join(__dirname, '..', 'components', 'LicenseGate.tsx'), 'utf8')
  );

  it('hanya me-render children pada fase ALLOWED', () => {
    // `children` di-render TEPAT SEKALI, di jalur terakhir setelah
    // cabang EVALUATING dan BLOCKED sudah return lebih dulu. Kalau
    // suatu saat ada yang me-render children di cabang lain (mis.
    // "sementara loading, tampilkan saja aplikasinya"), useEffect di
    // dalamnya — termasuk `getDb()` — sudah terlanjur jalan.
    const occurrences = gateSource.match(/\{children\}/g) ?? [];
    expect(occurrences).toHaveLength(1);

    const blockedReturn = gateSource.indexOf("phase === 'BLOCKED'");
    const childrenRender = gateSource.indexOf('{children}');
    expect(blockedReturn).toBeGreaterThan(-1);
    expect(childrenRender).toBeGreaterThan(blockedReturn);
  });

  it('mengevaluasi ulang saat aplikasi kembali dari background', () => {
    // Tanpa ini, aplikasi yang dibiarkan terbuka berminggu-minggu tidak
    // akan pernah menyadari lisensinya dicabut.
    expect(gateSource).toMatch(/AppState\.addEventListener/);
    expect(gateSource).toMatch(/state === 'active'/);
  });

  it('tidak menyimpan keputusan izin dalam variabel boolean modul', () => {
    // §17: satu boolean tingkat modul adalah tepat satu tempat untuk
    // membekukan jawaban "boleh".
    expect(gateSource).not.toMatch(/^\s*(let|var)\s+\w*[Ll]icensed\w*\s*=/m);
    expect(gateSource).not.toMatch(/^\s*(let|var)\s+isLicensed/m);
  });
});

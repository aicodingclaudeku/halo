import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * ============================================================
 * RC-S48b — WORDING MENU LISENSI
 * ============================================================
 *
 * Subtitle menu "Lisensi" dulu berbunyi "Status lisensi, verifikasi
 * ulang, nonaktifkan perangkat". Kalimat terakhir itu menjanjikan aksi
 * yang tidak dimiliki pengguna aplikasi: deaktivasi perangkat adalah
 * kewenangan penerbit/admin lisensi. Menu yang menyebut aksi yang tidak
 * ada di baliknya membuat pengguna mencari sesuatu yang tidak akan
 * pernah ditemukannya.
 *
 * INI PERUBAHAN TEKS, TITIK. Suite ini menjaga dua hal sekaligus:
 * kalimatnya benar, DAN tidak ada logika lisensi yang ikut berubah
 * diam-diam di layar Pengaturan. Yang kedua itulah alasan sebenarnya
 * berkas ini ada — perubahan wording adalah tempat yang nyaman untuk
 * menyelipkan perubahan perilaku tanpa disadari.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const pengaturan = tanpaKomentar(read('src/screens/Pengaturan/PengaturanScreen.tsx'));

/** Kartu menu Lisensi, dari onPress-nya sampai penutup kartu. */
const kartuLisensi = (() => {
  const awal = pengaturan.indexOf("router.push('/license')");
  expect(awal).toBeGreaterThan(-1);
  return pengaturan.slice(awal, pengaturan.indexOf('</TouchableOpacity>', awal));
})();

describe('subtitle menu Lisensi', () => {
  it('TIDAK lagi menjanjikan deaktivasi perangkat', () => {
    // Diperiksa pada SELURUH layar, bukan hanya kartunya — supaya
    // kalimat itu tidak sekadar berpindah tempat.
    expect(pengaturan).not.toMatch(/nonaktifkan perangkat/i);
    expect(pengaturan).not.toMatch(/deaktivasi perangkat/i);
  });

  it('tetap menyebut status lisensi dan verifikasi ulang', () => {
    expect(kartuLisensi).toMatch(/Status lisensi dan verifikasi ulang/);
  });

  it('subtitle-nya persis satu kalimat, tidak ada sisa teks lama', () => {
    const cocok = [...pengaturan.matchAll(/Status lisensi[^<]*/g)].map((m) => m[0].trim());
    expect(cocok).toEqual(['Status lisensi dan verifikasi ulang']);
  });

  it('judul menu tetap "Lisensi"', () => {
    expect(kartuLisensi).toMatch(/<Text style=\{styles\.cardTitle\}>Lisensi<\/Text>/);
  });
});

describe('tidak ada logika lisensi yang ikut berubah', () => {
  it('menu tetap dibuka lewat expo-router, bukan dipindah ke navigator', () => {
    // Layar lisensi hidup di belakang LicenseGate, di pohon Expo
    // Router — memindahkannya ke RootNavigator akan menaruh layar
    // keamanan di dalam area yang baru boleh dibuka SETELAH lisensi sah.
    expect(kartuLisensi).toMatch(/router\.push\('\/license'\)/);
    const nav = read('src/navigation/RootNavigator.tsx');
    expect(nav).not.toMatch(/name="License/);
  });

  it('layar Pengaturan tidak memanggil service lisensi apa pun', () => {
    expect(pengaturan).not.toMatch(/LicenseService|activateLicense|deactivate|getLicenseStatus/i);
  });

  it('menu Lisensi tetap di luar filter permission seperti sebelumnya', () => {
    // Kartu Lisensi memang dirender terpisah dari `menuTampil` — RC-S48b
    // tidak memindahkannya ke dalam MENU (itu akan mengubah siapa yang
    // dapat melihatnya).
    const blokMenu = pengaturan.slice(
      pengaturan.indexOf('const MENU'),
      pengaturan.indexOf('export default function')
    );
    expect(blokMenu).not.toMatch(/Lisensi/);
  });
});

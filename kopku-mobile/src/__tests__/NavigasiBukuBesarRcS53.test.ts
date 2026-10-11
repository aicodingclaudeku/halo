import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * REGRESSION — "NAVIGATE BukuBesar was not handled by any navigator".
 *
 * Bug aslinya: `ImbalanKerjaFormScreen` hidup di `TransaksiStack` dan
 * memanggil `navigate('BukuBesar')` polos, padahal rute itu milik
 * `LaporanStack`. React Navigation menelusuri ke atas, tidak menemukan
 * rute bernama `BukuBesar` di mana pun pada jalur itu, lalu melempar.
 *
 * Yang dijaga suite ini bukan hanya satu baris yang sudah diperbaiki,
 * melainkan ATURANNYA: tidak boleh ada layar di luar `LaporanStack` yang
 * menavigasi ke `BukuBesar` secara polos, dan rute itu tetap satu.
 *
 * JENIS TEST: STATIC / NAVIGATION STRUCTURE. Lingkungan ini tidak dapat
 * me-mount navigator (`testEnvironment: 'node'`, tanpa
 * `react-test-renderer`/`@testing-library/react-native`), sehingga
 * `RUNTIME NAVIGATION = NOT VERIFIED` dan tidak diklaim sebaliknya.
 */

const ROOT = join(__dirname, '..', '..');

function baca(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}
function tanpaKomentar(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Seluruh berkas layar & komponen, untuk audit caller menyeluruh. */
function semuaBerkasUi(): string[] {
  const hasil: string[] = [];
  const telusuri = (dir: string) => {
    for (const entri of readdirSync(dir)) {
      const penuh = join(dir, entri);
      if (statSync(penuh).isDirectory()) {
        if (entri === '__tests__' || entri === 'node_modules') continue;
        telusuri(penuh);
        continue;
      }
      if (entri.endsWith('.tsx') || entri.endsWith('.ts')) hasil.push(penuh);
    }
  };
  telusuri(join(ROOT, 'src', 'screens'));
  telusuri(join(ROOT, 'src', 'components'));
  return hasil;
}

const NAV = tanpaKomentar(baca('src/navigation/RootNavigator.tsx'));

describe('Kepemilikan rute Buku Besar', () => {
  it('BukuBesar terdaftar TEPAT SATU KALI, dan pemiliknya LaporanStack', () => {
    const semuaPendaftaran = NAV.match(/name="BukuBesar"/g) ?? [];
    expect(semuaPendaftaran).toHaveLength(1);
    expect(NAV).toMatch(
      /<LaporanStack\.Screen name="BukuBesar" component=\{BukuBesarScreen\}/
    );
    // Tidak diduplikasi ke navigator lain.
    expect(NAV).not.toMatch(/<TransaksiStack\.Screen name="BukuBesar"/);
    expect(NAV).not.toMatch(/<RootStack\.Screen name="BukuBesar"/);
    expect(NAV).not.toMatch(/<AnggotaStack\.Screen name="BukuBesar"/);
    expect(NAV).not.toMatch(/<PengaturanStack\.Screen name="BukuBesar"/);
  });

  it('komponen layarnya satu — nol BukuBesarScreen duplikat', () => {
    const impor = NAV.match(/import BukuBesarScreen from/g) ?? [];
    expect(impor).toHaveLength(1);
    expect(NAV).toContain("import BukuBesarScreen from '@/screens/Laporan/BukuBesarScreen';");
  });

  it('tab Laporan ada dan menjadi induk LaporanStack', () => {
    expect(NAV).toMatch(/<Tab\.Screen name="Laporan" component=\{LaporanStackNavigator\}/);
  });
});

describe('ImbalanKerjaFormScreen — aksi Buku Besar', () => {
  const SRC = 'src/screens/Transaksi/ImbalanKerjaFormScreen.tsx';
  const src = tanpaKomentar(baca(SRC));

  it('aksi "Lihat riwayat lengkap di Buku Besar" tetap ada', () => {
    expect(src).toContain('Lihat riwayat lengkap di Buku Besar');
  });

  it('memakai navigasi bersarang lewat tab Laporan, bukan navigate polos', () => {
    expect(src).toMatch(
      /navigation\.navigate\('Laporan', \{ screen: 'BukuBesar' \}\)/
    );
    // Inilah bentuk yang dulu melempar error.
    expect(src).not.toMatch(/navigation\.navigate\('BukuBesar'\)/);
  });

  it('nol penekanan tipe untuk menutupi error navigasi', () => {
    expect(src).not.toContain('@ts-ignore');
    expect(src).not.toContain('@ts-expect-error');
    // `useNavigation<any>()` adalah pola existing di seluruh layar repo
    // ini, bukan sesuatu yang ditambahkan untuk menutupi bug ini.
    expect(src).toContain('useNavigation<any>()');
  });

  it('nol parameter dikarang — BukuBesarScreen memang tidak menerima params', () => {
    const layar = baca('src/screens/Laporan/BukuBesarScreen.tsx');
    expect(layar).toMatch(/export default function BukuBesarScreen\(\)/);
    expect(layar).not.toContain('useRoute');
  });
});

describe('Audit caller menyeluruh', () => {
  it('nol layar di luar LaporanStack yang navigate polos ke BukuBesar', () => {
    const pelanggar: string[] = [];
    for (const berkas of semuaBerkasUi()) {
      const isi = tanpaKomentar(readFileSync(berkas, 'utf8'));
      if (/navigate\(\s*['"]BukuBesar['"]\s*\)/.test(isi)) {
        pelanggar.push(berkas.replace(ROOT + '/', ''));
      }
    }
    // Layar DI DALAM LaporanStack boleh memakai bentuk polos, tetapi
    // saat ini tidak ada satu pun yang melakukannya lewat navigate()
    // langsung — menu Laporan memakai daftar `route` miliknya sendiri.
    expect(pelanggar).toEqual([]);
  });

  it('menu Rincian Laporan Lainnya tetap membuka BukuBesar seperti semula', () => {
    // Caller ini berada DI DALAM LaporanStack, jadi rutenya memang
    // tersedia dan TIDAK ikut diubah.
    const menu = baca('src/screens/Akuntansi/PenyusutanDimukaMenuScreen.tsx');
    expect(menu).toMatch(/route: 'BukuBesar'/);
    expect((menu.match(/route: 'BukuBesar'/g) ?? [])).toHaveLength(1);
  });

  it('pola navigasi bersarang yang dipakai sudah ada di repo ini', () => {
    // Bukan pola yang dikarang: bentuk `navigate('<tab>', { screen })`
    // sudah dipakai sebelumnya.
    const identitas = baca('src/screens/Pengaturan/IdentitasKoperasiScreen.tsx');
    expect(identitas).toMatch(/navigate\('Tabs', \{ screen: '[A-Za-z]+' \}\)/);
  });
});

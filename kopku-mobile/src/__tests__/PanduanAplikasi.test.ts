import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';

/**
 * PANDUAN APLIKASI — slide bergambar setelah setup & dari Dashboard, serta
 * panduan menu Bunga Simpanan Sukarela. Komponen .tsx diperiksa dari sumber
 * (tanpa transformer JSX); isi panduan & layanan penanda diuji langsung.
 */
let testDb: TestDb;
jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => fn(testDb)),
}));

import { PANDUAN_APLIKASI, PANDUAN_BUNGA_SUKARELA, type SlidePanduan } from '@/config/panduanAplikasi';
import { perluTampilkanPanduanAwal, tandaiPanduanAwalPerluTampil, tandaiPanduanAwalSudahDilihat } from '@/services/PanduanService';
import { hitungBungaHarian } from '@/accounting/BungaSimpananSukarela';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

describe('isi panduan', () => {
  const ilustrasi = baca('src/components/panduan/IlustrasiUi.tsx');
  const cek = (daftar: readonly SlidePanduan[]) => {
    expect(new Set(daftar.map((s) => s.kunci)).size).toBe(daftar.length);
    for (const s of daftar) {
      expect(s.judul.length).toBeGreaterThan(5);
      expect(s.isi.length).toBeGreaterThan(20);
      expect((s.poin ?? []).length).toBeLessThanOrEqual(3);
      // Setiap slide punya ilustrasi UI yang benar-benar digambar.
      expect(ilustrasi).toMatch(new RegExp(`\\b${s.ilustrasi}: [A-Za-z]+,`));
    }
  };

  it('panduan aplikasi: 8 slide (sesuai teks kartu Dashboard), lengkap & berilustrasi', () => {
    expect(PANDUAN_APLIKASI).toHaveLength(8);
    expect(baca('src/screens/Dashboard/DashboardScreen.tsx')).toContain('dalam 8 slide singkat');
    cek(PANDUAN_APLIKASI);
  });

  it('panduan bunga: 6 slide (sesuai teks banner), lengkap & berilustrasi', () => {
    expect(PANDUAN_BUNGA_SUKARELA).toHaveLength(6);
    expect(baca('src/screens/Simpanan/BungaSimpananSukarelaScreen.tsx')).toContain('6 slide singkat');
    cek(PANDUAN_BUNGA_SUKARELA);
  });

  it('contoh angka di panduan tertulis sama dengan mesin bunga (Rp31.000)', () => {
    const h = hitungBungaHarian({ periode: '2026-01', saldoAwal: 3_650_000, mutasi: [], tarifPersenTahun: 10 });
    expect(h.bunga).toBe(31_000);
    expect(baca('src/screens/Simpanan/BungaSimpananSukarelaScreen.tsx')).toContain('= Rp1.000 per hari × 31 hari = Rp31.000');
  });

  it('isi panduan konsisten dengan keputusan desain (365 hari, maks. 9%, berlaku bulan berikutnya)', () => {
    const teks = PANDUAN_BUNGA_SUKARELA.map((s) => [s.isi, ...(s.poin ?? [])].join(' ')).join(' ');
    expect(teks).toContain('÷ 365');
    expect(teks).toContain('9%');
    expect(teks).toContain('bulan berikutnya');
  });
});

describe('penanda panduan awal (app_config)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  it('belum diatur -> tidak tampil; setelah setup -> tampil; setelah ditutup -> tidak tampil lagi', async () => {
    expect(await perluTampilkanPanduanAwal()).toBe(false);
    await tandaiPanduanAwalPerluTampil();
    expect(await perluTampilkanPanduanAwal()).toBe(true);
    await tandaiPanduanAwalSudahDilihat();
    expect(await perluTampilkanPanduanAwal()).toBe(false);
  });
});

describe('pemasangan', () => {
  it('setup administrasi menandai panduan perlu tampil, setelah setupKoperasi dan tanpa menggagalkan setup', () => {
    const s = tanpaKomentar(baca('src/screens/Setup/SetupWizardScreen.tsx'));
    const iSetup = s.indexOf('await setupKoperasi({');
    const iTanda = s.indexOf('await tandaiPanduanAwalPerluTampil().catch(() => undefined);');
    const iSelesai = s.indexOf('onComplete();', iSetup);
    expect(iSetup).toBeGreaterThan(-1);
    expect(iTanda).toBeGreaterThan(iSetup);
    expect(iTanda).toBeLessThan(iSelesai);
  });

  it('Dashboard: kartu Panduan Aplikasi, tampil otomatis sekali, ditandai saat ditutup', () => {
    const d = tanpaKomentar(baca('src/screens/Dashboard/DashboardScreen.tsx'));
    expect(d).toContain('<Text style={styles.infoTitle}>Panduan Aplikasi</Text>');
    expect(d).toMatch(/perluTampilkanPanduanAwal\(\)\.then/);
    expect(d).toMatch(/tandaiPanduanAwalSudahDilihat\(\)/);
    expect(d).toContain('<PanduanSlide visible={panduanTerbuka} slides={PANDUAN_APLIKASI} onTutup={tutupPanduan} />');
  });

  it('menu Bunga Simpanan Sukarela: tab Panduan, slide bergambar, mulai dari Panduan bila kebijakan belum diatur', () => {
    const b = tanpaKomentar(baca('src/screens/Simpanan/BungaSimpananSukarelaScreen.tsx'));
    expect(b).toContain("['PANDUAN', 'Panduan']");
    expect(b).toMatch(/slides=\{PANDUAN_BUNGA_SUKARELA\}/);
    expect(b).toMatch(/if \(v\.length === 0\) setTab\('PANDUAN'\)/);
    expect(baca('src/screens/Transaksi/PenyesuaianScreen.tsx')).toContain('dan panduan penggunaan');
  });

  it('slide: geser berhalaman, animasi native-driver, tombol Lewati/Kembali/Lanjut', () => {
    const p = tanpaKomentar(baca('src/components/panduan/PanduanSlide.tsx'));
    expect(p).toMatch(/pagingEnabled/);
    expect(p).toMatch(/useNativeDriver: true/);
    expect(p).toContain("terakhir ? 'Tutup' : 'Lewati'");
    expect(p).toContain("terakhir ? judulAkhir : 'Lanjut'");
    expect(p).toMatch(/accessibilityLabel="Lewati panduan"/);
  });

  it('ilustrasi digambar dengan komponen aplikasi (tanpa file gambar) dan murni tampilan', () => {
    const i = tanpaKomentar(baca('src/components/panduan/IlustrasiUi.tsx'));
    expect(i).not.toMatch(/require\(|<Image|getDb|Service/);
    expect(i).toMatch(/Animated\.loop/);
  });
});

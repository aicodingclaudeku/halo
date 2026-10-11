import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * UI/UX REDESIGN (pasca RC-S54) — KONTRAK STATIK PRESENTASI.
 *
 * Renderer RN tidak tersedia; suite ini mengunci sifat tampilan lewat
 * sumber: header compact yang aman terhadap status bar, affordance kartu
 * & picker, ikon semantik, dan tidak ada tinggi tetap yang memotong teks.
 * Tidak ada assertion tentang logika bisnis.
 */

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function berkas(dir: string, ext: RegExp, hasil: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '__tests__' || e === '.harness') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) berkas(p, ext, hasil);
    else if (ext.test(e)) hasil.push(p);
  }
  return hasil;
}

const header = strip(baca('src/components/AppHeader.tsx'));
const nav = strip(baca('src/navigation/RootNavigator.tsx'));
const navTheme = strip(baca('src/theme/navigation.ts'));
const ui = strip(baca('src/theme/ui.ts'));

describe('Header compact & safe area', () => {
  it('AppHeader memakai inset dinamis dari safe-area-context, bukan angka tetap', () => {
    expect(header).toMatch(/from 'react-native-safe-area-context'/);
    expect(header).toMatch(/const insets = useSafeAreaInsets\(\)/);
    expect(header).toMatch(/paddingTop: insets\.top/);
    expect(header).not.toMatch(/StatusBar\.currentHeight/);
    expect(header).not.toMatch(/position:\s*'absolute'/);
    expect(header).not.toMatch(/\btop:\s*0/);
  });

  it('bar header compact dan tumbuh bila perlu (minHeight 56, bukan height tetap)', () => {
    expect(header).toMatch(/bar: \{\s*minHeight: 56,/);
    expect(header).not.toMatch(/\n\s+height: \d+/);
    expect(header).toMatch(/numberOfLines=\{2\}/);
  });

  it('perilaku header existing dipertahankan: goBack, judul options.title, headerRight', () => {
    expect(header).toMatch(/onPress=\{\(\) => navigation\.goBack\(\)\}/);
    expect(header).toMatch(/options\.title \?\? route\.name/);
    expect(header).toMatch(/options\.headerRight\(/);
    expect(header).toMatch(/accessibilityLabel="Kembali"/);
  });

  it('semua stack memakai AppHeader lewat stackScreenOptions; Tabs tetap tanpa header', () => {
    expect(nav).toMatch(/header: \(props: any\) => <AppHeader \{\.\.\.props\} \/>/);
    expect((nav.match(/screenOptions=\{stackScreenOptions\}/g) ?? []).length).toBe(5);
    expect(nav).toMatch(/<RootStack\.Screen name="Tabs" component=\{TabNavigator\} options=\{\{ headerShown: false \}\}/);
  });

  it('tidak ada inset atas kedua di layar ber-stack (AppHeader satu-satunya pemberi inset)', () => {
    const tanpaHeaderStack = /Dashboard|License|Setup/;
    const pelanggar = berkas(join(ROOT, 'src', 'screens'), /\.tsx$/)
      .filter((f) => !tanpaHeaderStack.test(f))
      .filter((f) => /insets\.top/.test(strip(readFileSync(f, 'utf8'))))
      .map((f) => f.replace(ROOT + '/', ''));
    expect(pelanggar).toEqual([]);
  });

  it('status bar berikon gelap di atas header terang', () => {
    expect(baca('app/_layout.tsx')).toMatch(/<StatusBar style="dark" \/>/);
  });
});

describe('Bottom navigation', () => {
  it('tanpa tinggi/padding tetap; tab bar disembunyikan saat keyboard terbuka', () => {
    const blok = navTheme.slice(navTheme.indexOf('tabBarPresentationOptions'));
    expect(blok).not.toMatch(/\bheight\s*:|paddingBottom/);
    expect(blok).toMatch(/tabBarHideOnKeyboard: true/);
  });

  it('tab Data memakai ikon basis data (isi tab bukan hanya anggota)', () => {
    expect(nav).toContain("Anggota: ['server-outline', 'server']");
  });
});

describe('Kartu menu: bahasa visual bersama & affordance', () => {
  const HUB = [
    'src/screens/Transaksi/TransaksiPenerimaanScreen.tsx',
    'src/screens/Transaksi/TransaksiPengeluaranScreen.tsx',
    'src/screens/Transaksi/PenyesuaianScreen.tsx',
    'src/screens/Transaksi/PendapatanLainnyaMenuScreen.tsx',
    'src/screens/Akuntansi/PenyusutanDimukaMenuScreen.tsx',
    'src/screens/Laporan/LaporanScreen.tsx',
    'src/screens/Pengaturan/InputDataHubScreen.tsx',
    'src/screens/Pengaturan/PengaturanScreen.tsx',
  ];

  it('style kartu bersama: border, elevasi halus, minHeight ≥ area sentuh, chevron tidak menyusut', () => {
    expect(ui).toMatch(/menuCard: \{[\s\S]*?borderWidth: 1,[\s\S]*?\.\.\.elevation\.card,/);
    expect(ui).toMatch(/minHeight: touchTarget \+ spacing\.lg/);
    expect(ui).toMatch(/chevron: \{ flexShrink: 0 \}/);
    expect(baca('src/theme/colors.ts')).toMatch(/elevation: 1,/);
  });

  it.each(HUB.map((f) => [f]))('%s memakai ui.menuCard, chevron, dan accessibilityRole', (f) => {
    const s = strip(baca(f));
    expect(s).toMatch(/import \{ ui, menuIconSize \} from '@\/theme\/ui'/);
    expect(s).toMatch(/(card|menuCard): \{ \.\.\.ui\.menuCard \}/);
    expect(s).toMatch(/name="chevron-forward"[^/]*style=\{ui\.chevron\}/);
    expect(s).toMatch(/accessibilityRole="button"/);
  });
});

describe('Ikon semantik', () => {
  const ikon = (f: string, judul: string) => {
    const s = strip(baca(f));
    const m = new RegExp(`icon: '([a-z-]+)',\\s*title: '${judul.replace(/[()/&]/g, (c) => '\\' + c)}'`).exec(s);
    return m ? m[1] : null;
  };
  it.each([
    ['src/screens/Akuntansi/PenyusutanDimukaMenuScreen.tsx', 'Daftar Aset Tetap & Penyusutan', 'business-outline'],
    ['src/screens/Akuntansi/PenyusutanDimukaMenuScreen.tsx', 'Daftar Rekening Antar Kantor/Unit (RAKU)', 'git-branch-outline'],
    ['src/screens/Transaksi/PenyesuaianScreen.tsx', 'Rekonsiliasi Kas/Bank', 'git-compare-outline'],
    ['src/screens/Transaksi/PenyesuaianScreen.tsx', 'Penyesuaian Nilai Wajar', 'stats-chart-outline'],
    ['src/screens/Transaksi/TransaksiPengeluaranScreen.tsx', 'Pemberian Pinjaman untuk Anggota', 'cash-outline'],
    ['src/screens/Transaksi/TransaksiPengeluaranScreen.tsx', 'Pembelian Aset', 'cart-outline'],
    ['src/screens/Transaksi/TransaksiPenerimaanScreen.tsx', 'Setor Simpanan', 'wallet-outline'],
    ['src/screens/Laporan/LaporanScreen.tsx', 'Rincian Laporan Lainnya', 'folder-open-outline'],
  ])('%s — %s = %s', (f, judul, harap) => {
    expect(ikon(f, judul)).toBe(harap);
  });

  it('Ringkasan Penyusutan = analytics, Status & Proses = calendar', () => {
    const aset = strip(baca('src/screens/Akuntansi/DaftarAsetTetapScreen.tsx'));
    expect(aset).toMatch(/name="analytics-outline"[\s\S]{0,400}>Ringkasan Penyusutan Aset</);
    expect(aset).toMatch(/name="calendar-outline"[\s\S]{0,300}>Status &amp; Proses Penyusutan</);
    expect(aset).toContain('Lihat status periode dan proses penyusutan');
  });
});

describe('Picker, form, empty state', () => {
  const PICKER = ['AccountPicker', 'AnggotaPicker', 'AnggotaPiutangPicker', 'DataReferensiPicker', 'InvestasiPicker', 'KewajibanAkunPicker', 'PinjamanPicker', 'RekeningPicker', 'UtangPicker'];

  it.each(PICKER.map((n) => [n]))('%s: trigger terlihat bisa dibuka (chevron-down) dan onPress tidak berubah', (n) => {
    const s = strip(baca(`src/components/${n}.tsx`));
    expect(s).toMatch(/setOpen\(true\)[\s\S]{0,400}name="chevron-down"/);
    expect(s).toMatch(/accessibilityRole="button"/);
  });

  it('DatePicker: trigger berikon kalender', () => {
    expect(strip(baca('src/components/DatePicker.tsx'))).toMatch(/setOpen\(true\)[\s\S]{0,300}name="calendar-outline"/);
  });

  it('input multiline tidak memakai tinggi tetap yang memotong teks pada font scale besar', () => {
    const pelanggar = berkas(join(ROOT, 'src'), /\.tsx$/)
      .filter((f) => /[^A-Za-z]height: 70\b/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(ROOT + '/', ''));
    expect(pelanggar).toEqual([]);
  });

  it('EmptyState bersama berikon, API message tetap kompatibel', () => {
    const s = strip(baca('src/components/report/EmptyState.tsx'));
    expect(s).toMatch(/message: string;/);
    expect(s).toMatch(/icon = 'file-tray-outline'/);
  });

  it('tombol aksi kartu aset membungkus (flexWrap) sehingga tidak keluar layar kecil', () => {
    const s = strip(baca('src/screens/Akuntansi/DaftarAsetTetapScreen.tsx'));
    expect(s).toMatch(/actionRow: \{\s*flexDirection: 'row',\s*flexWrap: 'wrap',/);
    expect(s).toMatch(/style=\{\[styles\.actionBtn, styles\.actionBtnDanger\]\}/);
  });
});

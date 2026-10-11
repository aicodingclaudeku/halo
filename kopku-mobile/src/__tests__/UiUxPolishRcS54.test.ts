import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * UI/UX POLISH (pasca RC-S54) — KONTRAK STATIK.
 *
 * Renderer RN tidak tersedia di repo, jadi presentasi dikunci lewat
 * sumber layar/navigator. Suite ini TIDAK menguji logika bisnis: ia
 * memastikan patch UI tetap UI (tidak ada rute yang hilang, tidak ada
 * header tidak aman, tidak ada ikon emoji) dan hasil visual yang diminta
 * tetap terpasang.
 */

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const hub = strip(baca('src/screens/Transaksi/TransaksiScreen.tsx'));
const pengeluaran = strip(baca('src/screens/Transaksi/TransaksiPengeluaranScreen.tsx'));
const aset = strip(baca('src/screens/Akuntansi/DaftarAsetTetapScreen.tsx'));
const nav = strip(baca('src/navigation/RootNavigator.tsx'));
const navTheme = strip(baca('src/theme/navigation.ts'));
const theme = strip(baca('src/theme/colors.ts'));

// RC-S68: keputusan pengguna MENGGANTIKAN keputusan pass ini — Penyesuaian
// kini kategori utama di root Transaksi dan TIDAK lagi di bawah Pengeluaran.
// Assertion diselaraskan (bukan dihapus): tetap satu kartu per kategori.
describe('Root Transaksi', () => {
  it('Penyesuaian tampil di root Transaksi sebagai kategori utama (RC-S68)', () => {
    expect((hub.match(/navigate\('Penyesuaian'\)/g) ?? []).length).toBe(1);
    expect(hub).toContain('>Penyesuaian</Text>');
  });

  it('Penerimaan, Pengeluaran & Penyesuaian tampil, masing-masing tepat satu kartu', () => {
    expect((hub.match(/navigate\('TransaksiPenerimaan'\)/g) ?? []).length).toBe(1);
    expect((hub.match(/navigate\('TransaksiPengeluaran'\)/g) ?? []).length).toBe(1);
    expect(hub).toContain('>Penerimaan</Text>');
    expect(hub).toContain('>Pengeluaran</Text>');
    expect((hub.match(/<TouchableOpacity/g) ?? []).length).toBe(3);
  });

  it('ikon kartu semantik: Penerimaan = arrow-down, Pengeluaran = arrow-up', () => {
    expect(hub).toMatch(/name="arrow-down-circle"[\s\S]*?>Penerimaan</);
    expect(hub).toMatch(/name="arrow-up-circle"[\s\S]*?>Pengeluaran</);
  });

  it('fitur Penyesuaian TIDAK hilang: rute terdaftar; tidak lagi di bawah Pengeluaran (RC-S68)', () => {
    expect(nav).toMatch(/<TransaksiStack\.Screen name="Penyesuaian" component=\{PenyesuaianScreen\}/);
    expect(pengeluaran).not.toMatch(/title: 'Penyesuaian'/);
    expect(pengeluaran).not.toMatch(/nav\.navigate\('Penyesuaian'\)/);
  });
});

describe('Daftar Aset Tetap & Penyusutan', () => {
  it('judul header navigator sama dengan label menu; subjudul ringkas ada; tanpa judul ganda di layar', () => {
    expect(nav).toMatch(/name="DaftarAsetTetap" component=\{DaftarAsetTetapScreen\} options=\{\{ title: 'Daftar Aset Tetap & Penyusutan' \}\}/);
    expect(aset).toContain('Kelola aset, nilai buku, dan informasi penyusutan');
    expect(aset).not.toMatch(/>Daftar Aset Tetap &amp; Penyusutan</);
  });

  it('Ringkasan Penyusutan Aset tampil SEKALI dengan ikon analytics', () => {
    expect((aset.match(/>Ringkasan Penyusutan Aset</g) ?? []).length).toBe(1);
    expect(aset).toMatch(/name="analytics-outline"[\s\S]{0,400}>Ringkasan Penyusutan Aset</);
    expect(aset).toMatch(/<RingkasanPenyusutanAsetList data=\{ringkasanPenyusutan\} \/>/);
  });

  it('Status & Proses Penyusutan tetap dapat diakses, satu pintu, ikon proses/jadwal', () => {
    expect((aset.match(/navigation\.navigate\('StatusPeriode'\)/g) ?? []).length).toBe(1);
    expect((aset.match(/>Status &amp; Proses Penyusutan</g) ?? []).length).toBe(1);
    expect(aset).toMatch(/name="calendar-outline"[\s\S]{0,300}>Status &amp; Proses Penyusutan</);
    expect(aset).not.toContain('trending-down-outline');
    expect(nav).toMatch(/name="StatusPeriode"/);
  });

  it('angka ringkasan tetap dari sumber existing (tanpa rumus baru di JSX)', () => {
    expect(aset).toMatch(/await Promise\.all\(\[listAsetDenganNilaiBuku\(\), listRingkasanPenyusutanAset\(\)\]\)/);
    expect(aset).toMatch(/<Row label="Total Nilai Perolehan" value=\{formatRupiah\(totalPerolehan\)\} \/>/);
    expect(aset).toMatch(/<Row label="Total Nilai Buku" value=\{formatRupiah\(totalNilaiBuku\)\} bold \/>/);
  });

  it('tombol aksi kartu diperluas area sentuhnya tanpa mengubah handler', () => {
    expect((aset.match(/hitSlop=\{HIT_SLOP\}/g) ?? []).length).toBe(3);
    expect(aset).toMatch(/onPress=\{\(\) => bukaPelepasan\(item\)\}/);
    expect(aset).toMatch(/navigation\.navigate\('AsetEditForm', \{ asetId \}\)/);
  });
});

describe('Header / safe area', () => {
  it('seluruh stack memakai opsi presentasi bersama', () => {
    for (const st of ['AnggotaStack', 'TransaksiStack', 'LaporanStack', 'PengaturanStack', 'RootStack']) {
      expect(nav).toMatch(new RegExp(`<${st}\\.Navigator[^>]*screenOptions=\\{stackScreenOptions\\}`));
    }
  });

  it('header tetap native: tanpa header kustom, tanpa absolute/top:0, tanpa tinggi/padding tetap', () => {
    expect(navTheme).not.toMatch(/\bheader\s*:/);
    expect(navTheme).not.toMatch(/position\s*:\s*'absolute'/);
    expect(navTheme).not.toMatch(/\btop\s*:\s*0/);
    expect(navTheme).not.toMatch(/\bheight\s*:/);
    expect(navTheme).not.toMatch(/paddingTop|paddingBottom/);
    expect(navTheme).not.toMatch(/headerTransparent|statusBarTranslucent/);
  });

  it('tidak ada inset ganda di layar yang sudah ber-header native', () => {
    for (const s of [hub, aset]) {
      expect(s).not.toMatch(/SafeAreaView|useSafeAreaInsets/);
    }
  });

  it('Dashboard (tanpa header) tetap memakai SafeAreaView edges top; Tabs tetap tanpa header', () => {
    const dash = baca('src/screens/Dashboard/DashboardScreen.tsx');
    expect((dash.match(/<SafeAreaView style=\{styles\.\w+\} edges=\{\['top'\]\}/g) ?? []).length).toBe(3);
    expect(nav).toMatch(/<RootStack\.Screen name="Tabs" component=\{TabNavigator\} options=\{\{ headerShown: false \}\}/);
  });
});

describe('Bottom navigation', () => {
  it('tab bar tidak memaksa tinggi/padding bawah (inset diurus bottom-tabs)', () => {
    const blok = navTheme.slice(navTheme.indexOf('tabBarPresentationOptions'));
    expect(blok).toMatch(/tabBarActiveTintColor: colors\.primary/);
    expect(blok).not.toMatch(/\bheight\s*:|paddingBottom/);
    expect(nav).toMatch(/\.\.\.tabBarPresentationOptions/);
  });

  it('ikon tab semantik & ukuran dari token', () => {
    for (const [route, ikon] of [
      ['Dashboard', 'grid'],
      // RC-S54 UI/UX REDESIGN §13: tab "Data" berisi data master, bukan hanya anggota.
      ['Anggota', 'server'],
      ['Transaksi', 'swap-horizontal'],
      ['Laporan', 'bar-chart'],
      ['Pengaturan', 'settings'],
    ]) {
      expect(nav).toContain(`${route}: ['${ikon}-outline', '${ikon}']`);
    }
    expect(nav).toMatch(/size=\{iconSize\.lg\}/);
    expect(theme).toMatch(/export const iconSize = \{/);
  });
});

describe('Ikon', () => {
  it('tidak ada emoji/simbol Unicode sebagai ikon di layar & navigator yang diubah', () => {
    const pola = /[\u2190-\u21FF\u2600-\u27BF\u25A0-\u25FF\u2B00-\u2BFF]|[\uD83C-\uD83E][\uDC00-\uDFFF]/;
    for (const s of [hub, aset, nav, navTheme]) expect(pola.test(s)).toBe(false);
  });
});

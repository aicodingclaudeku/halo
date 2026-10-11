import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S68.2 — POLISH SEMANTIK VISUAL HUB TRANSAKSI.
 *
 * Uji statis atas sumber (render perangkat tidak tersedia di lingkungan ini —
 * UI RUNTIME BLOCKED). Yang diuji: pemetaan warna semantik, ikon arus kas,
 * konsistensi bentuk ketiga kartu, pressed state, aksesibilitas, serta kunci
 * navigasi/akuntansi/database (tidak ada yang berubah).
 */

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const HUB = strip(baca('src/screens/Transaksi/TransaksiScreen.tsx'));
const WARNA = strip(baca('src/theme/colors.ts'));

describe('RC-S68.2 — token semantik', () => {
  it('TEST D — token expense/income/adjustment ada dan diturunkan dari palet existing (tanpa palet baru)', () => {
    for (const t of [
      'incomeIcon: colors.success',
      'incomeIconBackground: colors.primaryLight',
      'expenseIcon: colors.danger',
      'expenseIconBackground: colors.dangerBg',
      'adjustmentIcon: colors.primary',
      'adjustmentIconBackground: colors.primaryLight',
    ]) {
      expect(WARNA).toContain(t);
    }
    // Hanya tint tekan yang boleh berupa nilai hex baru (dua nilai).
    const blokSemantic = WARNA.slice(WARNA.indexOf('export const semantic'), WARNA.indexOf('export const spacing'));
    const hexBaru = blokSemantic.match(/'#[0-9A-Fa-f]{6}'/g) ?? [];
    expect(hexBaru.sort()).toEqual(["'#D6E9D8'", "'#D6E9D8'", "'#F9DADA'"]);
  });

  it('hub memakai token semantik, bukan hex lepas', () => {
    expect(HUB).not.toMatch(/#[0-9A-Fa-f]{6}/);
    expect(HUB).toMatch(/import \{[^}]*semantic[^}]*\} from '@\/theme\/colors'/);
  });
});

describe('RC-S68.2 — pemetaan warna & ikon per kategori', () => {
  const kartu = (judul: string) => {
    const i = HUB.indexOf(`accessibilityLabel="${judul}"`);
    expect(i).toBeGreaterThan(-1);
    return HUB.slice(i, HUB.indexOf('chevron-forward', i));
  };

  it('TEST C/D — Penerimaan hijau + panah masuk; Pengeluaran merah + panah keluar; Penyesuaian netral', () => {
    const terima = kartu('Penerimaan');
    expect(terima).toContain('semantic.incomeIcon');
    expect(terima).toContain('semantic.incomeIconBackground');
    expect(terima).toContain('name="arrow-down-circle"');

    const keluar = kartu('Pengeluaran');
    expect(keluar).toContain('semantic.expenseIcon');
    expect(keluar).toContain('semantic.expenseIconBackground');
    expect(keluar).toContain('name="arrow-up-circle"');
    expect(keluar).toContain('name="wallet"');
    // Ikon generik yang tidak representatif sebagai pengeluaran.
    for (const buruk of ['settings', 'create-outline', 'remove', 'trash-outline']) {
      expect(keluar).not.toContain(`name="${buruk}"`);
    }

    const sesuai = kartu('Penyesuaian');
    expect(sesuai).toContain('semantic.adjustmentIcon');
    expect(sesuai).toContain('name="options"');
    expect(sesuai).not.toContain('arrow-up-circle');
    expect(sesuai).not.toContain('arrow-down-circle');
  });

  it('TEST C — semua ikon berasal dari satu set (Ionicons), tanpa pustaka ikon baru', () => {
    expect(HUB).toMatch(/import \{ Ionicons \} from '@expo\/vector-icons'/);
    const impor = HUB.match(/^import .*$/gm) ?? [];
    for (const b of ['lucide', 'react-native-vector-icons', 'feather', 'phosphor']) {
      expect(impor.join('\n')).not.toContain(b);
    }
  });

  it('kartu tidak berwarna penuh — permukaan, judul, dan subjudul tetap netral', () => {
    expect(HUB).toMatch(/mainCard: \{[\s\S]*?backgroundColor: colors\.surface,/);
    expect(HUB).toMatch(/mainCardTitle: \{[^}]*color: colors\.text \}/);
    expect(HUB).toMatch(/mainCardSub: \{[^}]*color: colors\.textMuted,/);
    expect(HUB).not.toMatch(/backgroundColor: (colors\.danger|semantic\.expenseIcon)\b/);
    expect(HUB).not.toMatch(/color: colors\.white/);
  });
});

describe('RC-S68.2 — konsistensi bentuk & interaksi', () => {
  it('TEST E — ketiga kartu memakai gaya kartu & wadah ikon yang sama, ukuran ikon sama', () => {
    expect((HUB.match(/style=\{styles\.mainCard\}/g) ?? []).length).toBe(3);
    expect((HUB.match(/styles\.mainIcon,/g) ?? []).length).toBe(3);
    expect((HUB.match(/size=\{iconSize\.lg\}/g) ?? []).length).toBe(3);
    expect((HUB.match(/style=\{ui\.chevron\}/g) ?? []).length).toBe(3);
    expect((HUB.match(/style=\{styles\.mainCardTitle\}/g) ?? []).length).toBe(3);
    expect((HUB.match(/style=\{styles\.mainCardSub\}/g) ?? []).length).toBe(3);
    // Ukuran/radius wadah ikon didefinisikan sekali saja.
    expect((HUB.match(/width: 48,/g) ?? []).length).toBe(1);
    expect(HUB).toMatch(/mainIcon: \{[\s\S]*?height: 48,[\s\S]*?borderRadius: radius\.md,/);
    // Tinggi kartu tidak berubah dari RC-S68.1.
    expect(HUB).toContain('minHeight: touchTarget + spacing.xl,');
  });

  it('TEST G — pressed state: tint lebih kuat saat ditekan, kembali saat dilepas', () => {
    expect((HUB.match(/onPressIn=\{/g) ?? []).length).toBe(3);
    expect((HUB.match(/onPressOut=\{\(\) => setDitekan\(null\)\}/g) ?? []).length).toBe(3);
    expect((HUB.match(/activeOpacity=\{0\.7\}/g) ?? []).length).toBe(3);
    for (const p of ['semantic.incomePressed', 'semantic.expensePressed', 'semantic.adjustmentPressed']) {
      expect(HUB).toContain(p);
    }
  });

  it('TEST F — aksesibilitas lengkap; label & hint sesuai', () => {
    expect((HUB.match(/accessibilityRole="button"/g) ?? []).length).toBe(3);
    expect((HUB.match(/accessibilityLabel="/g) ?? []).length).toBe(3);
    expect((HUB.match(/accessibilityHint=\{/g) ?? []).length).toBe(3);
    expect(HUB).toContain('accessibilityLabel="Pengeluaran"');
    expect(HUB).toContain("hint: 'Buka transaksi pengeluaran koperasi'");
    expect(HUB).toContain("hint: 'Buka transaksi penerimaan koperasi'");
  });

  it('microcopy & header tidak berubah; teks panjang membungkus (tanpa clipping ke chevron)', () => {
    expect(HUB).toContain('Kelola aktivitas transaksi koperasi.');
    for (const d of [
      'Mencatat uang yang diterima koperasi',
      'Mencatat uang yang dikeluarkan koperasi',
      'Koreksi dan penyesuaian transaksi',
    ]) {
      expect(HUB).toContain(d);
    }
    expect(HUB).toMatch(/teks: \{ flex: 1, minWidth: 0 \}/);
    expect(HUB).toMatch(/flexShrink: 0,/); // wadah ikon tidak mengecil
    expect(HUB).toMatch(/chevron: |ui\.chevron/);
  });
});

describe('RC-S68.2 — kunci: navigasi, akuntansi, database', () => {
  it('TEST A/B — rute tetap sama & berurutan', () => {
    const a = HUB.indexOf("navigate('TransaksiPenerimaan')");
    const b = HUB.indexOf("navigate('TransaksiPengeluaran')");
    const c = HUB.indexOf("navigate('Penyesuaian')");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect((HUB.match(/navigation\.navigate\(/g) ?? []).length).toBe(3);
  });

  it('TEST H — hub tetap murni presentasi: tidak ada service, jurnal, atau SQL', () => {
    for (const terlarang of [
      'Service',
      'jurnal',
      'journal',
      'ledger',
      'buku_besar',
      'SELECT',
      'INSERT',
      'db.',
      'SCHEMA_VERSION',
    ]) {
      expect(HUB).not.toContain(terlarang);
    }
    const impor = (HUB.match(/^import .*$/gm) ?? []).join('\n');
    expect(impor).not.toMatch(/@\/(services|database|accounting)/);
  });
});

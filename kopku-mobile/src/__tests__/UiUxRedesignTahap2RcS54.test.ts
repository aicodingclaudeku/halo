import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * UI/UX REDESIGN TAHAP 2 — KONTRAK STATIK PRESENTASI.
 * Tidak ada assertion tentang logika bisnis; angka & sumber data laporan
 * dikunci oleh suite existing masing-masing.
 */
const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function berkas(dir: string, hasil: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === '__tests__' || e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) berkas(p, hasil);
    else if (e.endsWith('.tsx')) hasil.push(p);
  }
  return hasil;
}

const LAPORAN = ['ArusKasScreen', 'NeracaSaldoScreen', 'PerubahanEkuitasScreen', 'PosisiKeuanganScreen', 'LabaRugiScreen'];

describe('Laporan — status memakai Ionicons, bukan glyph Unicode', () => {
  it.each(LAPORAN.map((n) => [n]))('%s bebas ✓/⚠/🔒 di kode UI', (n) => {
    const s = strip(baca(`src/screens/Laporan/${n}.tsx`));
    expect(s).not.toMatch(/[✓⚠🔒]/u);
    expect(s).toMatch(/from '@expo\/vector-icons'/);
  });

  it('banner validasi tetap berteks (warna bukan satu-satunya penanda)', () => {
    const pk = strip(baca('src/screens/Laporan/PosisiKeuanganScreen.tsx'));
    expect(pk).toMatch(/Seimbang — Aset = Liabilitas \+ Ekuitas/);
    expect(pk).toMatch(/TIDAK SEIMBANG — selisih/);
    expect(pk).toMatch(/name="checkmark-circle-outline"[\s\S]{0,200}name="alert-circle-outline"/);
    const ns = strip(baca('src/screens/Laporan/NeracaSaldoScreen.tsx'));
    expect(ns).toMatch(/Seimbang — Total Debit = Total Kredit/);
  });

  it('ikon laporan sesuai fungsi', () => {
    const s = strip(baca('src/screens/Laporan/LaporanScreen.tsx'));
    const ikon = (t: string) => new RegExp(`icon: '([a-z-]+)',\\s*title: '${t.replace(/[/()]/g, (c) => '\\' + c)}'`).exec(s)?.[1];
    expect(ikon('Laporan Posisi Keuangan')).toBe('briefcase-outline');
    expect(ikon('Laporan Perhitungan Hasil Usaha')).toBe('bar-chart-outline');
    expect(ikon('Laporan Arus Kas')).toBe('cash-outline');
    expect(ikon('Catatan Atas Laporan Keuangan')).toBe('reader-outline');
  });
});

describe('Komponen laporan bersama — angka finansial', () => {
  const row = strip(baca('src/components/report/ReportRow.tsx'));
  it('nominal rata kanan, angka tabular, tidak bisa mendorong label keluar layar', () => {
    expect(row).toMatch(/value: \{\s*flexShrink: 1,\s*maxWidth: '62%',\s*fontVariant: \['tabular-nums'\],/);
    expect(row).toMatch(/textAlign: 'right'/);
    expect(row).toMatch(/minimumFontScale=\{0\.85\}/);
    expect(row).not.toMatch(/\\u26A0/);
    expect(row).toMatch(/name="warning-outline"/);
  });
  it('total punya garis penegas; section punya pemisah', () => {
    expect(row).toMatch(/rowTotal: \{\s*borderTopWidth: 2,\s*borderTopColor: colors\.text,/);
    expect(strip(baca('src/components/report/SectionHeader.tsx'))).toMatch(/borderBottomWidth: 1,/);
  });
  it('SummaryCard tidak mengecilkan nominal secara ekstrem', () => {
    expect(strip(baca('src/components/report/SummaryCard.tsx'))).toMatch(/minimumFontScale=\{0\.75\}/);
  });
});

describe('Form & picker', () => {
  const ci = strip(baca('src/components/CurrencyInput.tsx'));
  it('CurrencyInput: focus state visual, error berikon + teks', () => {
    expect(ci).toMatch(/onFocus=\{\(\) => setFokus\(true\)\}/);
    expect(ci).toMatch(/onBlur=\{\(\) => setFokus\(false\)\}/);
    expect(ci).toMatch(/fokus && styles\.wrapFocus/);
    expect(ci).toMatch(/name="alert-circle-outline"[\s\S]{0,120}\{error\}/);
    // nilai tetap mengalir lewat jalur lama
    expect(ci).toMatch(/onChangeText=\{handleChange\}/);
  });
  it('PeriodPicker: token tema, bukan hex lepas; chip terpilih berikon; role tombol', () => {
    const pp = strip(baca('src/components/PeriodPicker.tsx'));
    expect(pp).not.toMatch(/'#[0-9A-Fa-f]{3,6}'/);
    expect(pp).toMatch(/accessibilityState=\{\{ selected: selectedPeriodId === p\.id \}\}/);
    expect(pp).toMatch(/onPress=\{\(\) => onSelect\(p\)\}/);
  });
  it('PenerimaanPenghasilanLainAccountPicker: chip terpilih berikon centang', () => {
    const s = strip(baca('src/components/PenerimaanPenghasilanLainAccountPicker.tsx'));
    expect(s).toMatch(/value\?\.id === opt\.id \? \(\s*<Ionicons name="checkmark-circle"/);
    expect(s).toMatch(/onPress=\{\(\) => onChange\(opt\)\}/);
  });
});

describe('Modal / keyboard', () => {
  it('setiap ScrollView/FlatList di berkas ber-Modal + input meneruskan ketukan saat keyboard terbuka', () => {
    const pelanggar: string[] = [];
    for (const f of berkas(join(ROOT, 'src'))) {
      const s = readFileSync(f, 'utf8');
      if (!/<Modal/.test(s) || !/<TextInput|<CurrencyInput/.test(s)) continue;
      for (const m of s.matchAll(/<(ScrollView|FlatList)\b[\s\S]*?>/g)) {
        // RC-S110: prop papan ketik boleh datang lewat spread
        // {...PROP_SCROLL_FORM} (src/components/AreaAmanKeyboard.tsx),
        // yang memuat keyboardShouldPersistTaps: 'handled' PLUS
        // keyboardDismissMode dan automaticallyAdjustKeyboardInsets.
        // Isi konstanta itu sendiri diuji di AreaAmanKeyboardRcS110.
        if (!/keyboardShouldPersistTaps|PROP_SCROLL_FORM/.test(m[0])) pelanggar.push(f.replace(ROOT + '/', ''));
      }
    }
    expect(pelanggar).toEqual([]);
  });
});

describe('Tahap 1 tetap utuh', () => {
  // RC-S68: Penyesuaian kini kategori utama root Transaksi (keputusan pengguna).
  it('root Transaksi: Penerimaan, Pengeluaran & Penyesuaian ada', () => {
    const t = strip(baca('src/screens/Transaksi/TransaksiScreen.tsx'));
    expect(t).toMatch(/navigate\('Penyesuaian'\)/);
    expect(t).toMatch(/navigate\('TransaksiPenerimaan'\)/);
    expect(t).toMatch(/navigate\('TransaksiPengeluaran'\)/);
  });
  it('AppHeader: inset dinamis, judul 2 baris, tanpa absolute', () => {
    const h = strip(baca('src/components/AppHeader.tsx'));
    expect(h).toMatch(/paddingTop: insets\.top/);
    expect(h).toMatch(/numberOfLines=\{2\}/);
    expect(h).not.toMatch(/position:\s*'absolute'/);
  });
  it('tab Data = server (master data), Laporan = bar-chart', () => {
    const n = strip(baca('src/navigation/RootNavigator.tsx'));
    expect(n).toContain("Anggota: ['server-outline', 'server']");
    expect(n).toContain("Laporan: ['bar-chart-outline', 'bar-chart']");
  });
});

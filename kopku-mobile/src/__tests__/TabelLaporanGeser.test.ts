/**
 * UI laporan (Posisi Keuangan, Perubahan Ekuitas, Neraca Saldo, Buku Besar):
 * nominal besar satu baris & tabel dapat digeser ke kanan. Struktural —
 * renderer RN tidak tersedia di lingkungan test.
 */
import * as fs from 'fs';
import * as path from 'path';
import { formatRupiah } from '@/utils/money';
import { LEBAR_KOLOM_NILAI, lebarTabel } from '@/components/report/tabelGeserUkuran';

const baca = (rel: string) =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const LAYAR = [
  'screens/Laporan/PosisiKeuanganScreen.tsx',
  'screens/Laporan/PerubahanEkuitasScreen.tsx',
  'screens/Laporan/NeracaSaldoScreen.tsx',
  'screens/Laporan/BukuBesarScreen.tsx',
];

describe('TabelGeser', () => {
  const src = baca('components/report/TabelGeser.tsx');

  test('ScrollView horizontal & nominal satu baris dengan lebar tetap', () => {
    expect(src).toMatch(/<ScrollView\s+horizontal/);
    expect(src).toMatch(/numberOfLines=\{1\}/);
    expect(src).toMatch(/width: LEBAR_KOLOM_NILAI/);
  });

  test('lebar kolom cukup untuk nominal triliunan (≈7,5px/karakter @13px)', () => {
    const terpanjang = formatRupiah(-9_999_999_999_999);
    expect(terpanjang.length * 7.5).toBeLessThanOrEqual(LEBAR_KOLOM_NILAI);
  });

  test('lebar tabel bertambah per kolom nominal', () => {
    expect(lebarTabel(3) - lebarTabel(2)).toBe(LEBAR_KOLOM_NILAI);
  });
});

describe.each(LAYAR)('%s', (rel) => {
  const s = baca(rel);
  test('memakai TabelGeser & SelNilai, bukan kolom nominal flex', () => {
    expect(s).toMatch(/<TabelGeser lebarMinimum=/);
    expect(s).toMatch(/<SelNilai/);
    expect(s).not.toMatch(/numCol: \{ flex: 1/);
  });
});

describe('Posisi Keuangan — opsi sebagai tombol, urutan penyajian tetap', () => {
  const s = baca('screens/Laporan/PosisiKeuanganScreen.tsx');
  test('Mode Komparatif & Saldo Awal Draf adalah tombol, bukan checkbox', () => {
    expect(s).toMatch(/<TombolOpsi[\s\S]{0,200}label="Mode Komparatif"/);
    expect(s).toMatch(/<TombolOpsi[\s\S]{0,300}label="Saldo Awal Draf"/);
    expect(s).not.toMatch(/styles\.checkbox/);
  });
  test('mode tunggal TIDAK dapat digeser; hanya mode komparatif', () => {
    expect(s).toContain('geser={komparatif}');
    expect(s).toContain('const kolomAkun = komparatif ? tabelUi.kolomAkun : styles.kolomAkunPenuh;');
    expect(s).toMatch(/kolomAkunPenuh: \{ flex: 1, minWidth: 0/);
    const tg = baca('components/report/TabelGeser.tsx');
    expect(tg).toMatch(/if \(!geser\) \{\s*return <View style=\{styles\.kartu\}>\{children\}<\/View>;/);
  });

  test('urutan seksi ASET → LIABILITAS → EKUITAS dan helper urutan tidak berubah', () => {
    const iA = s.indexOf('title="ASET"');
    const iL = s.indexOf('title="LIABILITAS"');
    const iE = s.indexOf('title="EKUITAS"');
    expect(iA).toBeGreaterThan(-1);
    expect(iA).toBeLessThan(iL);
    expect(iL).toBeLessThan(iE);
    expect(s).toMatch(/aset: urutkanUntukPenyajian\(gabung\(data\.aset, pembandingData\?\.aset\), URUTAN_PENYAJIAN_ASET\)/);
    expect(s).toMatch(/ekuitas: urutkanUntukPenyajian\(ekuitas, URUTAN_PENYAJIAN_EKUITAS\)/);
  });
});

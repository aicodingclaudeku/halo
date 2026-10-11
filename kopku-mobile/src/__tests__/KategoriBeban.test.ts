/**
 * Form Beban (Pengeluaran) — kategori: tanpa "Beban Imbalan Kerja" &
 * "Beban Lainnya" generik; Data Beban Lain tampil menggantikannya.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_ACCOUNTS as DEFAULT_COA } from '@/config/defaultCOA';
import {
  KATEGORI_BEBAN_TETAP,
  KODE_AKUN_BEBAN_LAIN,
  cariOpsiKategoriBeban,
  susunOpsiKategoriBeban,
} from '@/utils/kategoriBeban';

describe('kategori beban', () => {
  test('Beban Imbalan Kerja & Beban Lainnya tidak ditawarkan', () => {
    const labels = susunOpsiKategoriBeban([]).map((o) => o.label);
    expect(labels).not.toContain('Beban Imbalan Kerja');
    expect(labels).not.toContain('Beban Lainnya');
    expect(labels).toEqual([...KATEGORI_BEBAN_TETAP]);
  });

  test('setiap kategori tetap ada sebagai akun BEBAN di COA (dicocokkan by-name)', () => {
    for (const nama of KATEGORI_BEBAN_TETAP) {
      const a = DEFAULT_COA.find((x: any) => x.nama === nama);
      expect(a?.kategori).toBe('BEBAN');
    }
  });

  test('Data Beban Lain tampil setelah kategori tetap, terurut, dan dibukukan ke akun Beban Lainnya (5-2000)', () => {
    const o = susunOpsiKategoriBeban([
      { id: 'b2', nama: 'Konsumsi Rapat', keterangan: 'snack & makan' },
      { id: 'b1', nama: 'Beban Kebersihan', keterangan: null },
    ]);
    const lain = o.filter((x) => x.sumber === 'BEBAN_LAIN');
    expect(lain.map((x) => x.label)).toEqual(['Beban Kebersihan', 'Konsumsi Rapat']);
    expect(o.slice(0, KATEGORI_BEBAN_TETAP.length).every((x) => x.sumber === 'KATEGORI')).toBe(true);
    for (const x of lain) expect(x.sumber === 'BEBAN_LAIN' && x.akunKode).toBe(KODE_AKUN_BEBAN_LAIN);
    const akun = DEFAULT_COA.find((x: any) => x.kode === KODE_AKUN_BEBAN_LAIN);
    expect(akun?.nama).toBe('Beban Lainnya');
    expect(akun?.kategori).toBe('BEBAN');
  });

  test('nama kosong, duplikat, atau sama dengan kategori tetap tidak digandakan', () => {
    const o = susunOpsiKategoriBeban([
      { id: '1', nama: '  ' },
      { id: '2', nama: 'beban sewa' },
      { id: '3', nama: 'Parkir' },
      { id: '4', nama: 'PARKIR' },
    ]);
    expect(o.filter((x) => x.sumber === 'BEBAN_LAIN').map((x) => x.label)).toEqual(['Parkir']);
  });

  test('pencarian mencakup nama dan keterangan beban lain', () => {
    const o = susunOpsiKategoriBeban([{ id: 'b', nama: 'Konsumsi Rapat', keterangan: 'snack' }]);
    expect(cariOpsiKategoriBeban(o, 'snack').map((x) => x.label)).toEqual(['Konsumsi Rapat']);
    expect(cariOpsiKategoriBeban(o, 'listrik').map((x) => x.label)).toEqual(['Beban Listrik']);
  });

  test('layar memakai daftar dinamis & memuat ulang Data Beban Lain saat fokus', () => {
    const src = fs.readFileSync(path.join(__dirname, '../screens/Transaksi/BebanFormScreen.tsx'), 'utf8');
    expect(src).toContain("listDataReferensi('BEBAN_LAIN')");
    expect(src).toContain('useFocusRefresh(muatBebanLain, [muatBebanLain]);');
    expect(src).toContain('susunOpsiKategoriBeban(bebanLain)');
    expect(src).not.toMatch(/'Beban Imbalan Kerja',/);
    expect(src).not.toMatch(/'Beban Lainnya',/);
  });
});

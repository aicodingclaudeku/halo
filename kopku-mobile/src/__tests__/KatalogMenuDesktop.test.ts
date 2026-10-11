import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_ROLE_PERMISSIONS } from '@/config/defaultPermissions';
import { IZIN_RUTE } from '@/navigation/izinRute';
import { KATALOG, GRUP_TAB, cariKatalog, katalogBoleh, bukaEntri } from '@/desktop/katalogMenu';

/**
 * KOPKU Desktop (RC-S133.4) — katalog navigasi sidebar & palet Ctrl+K.
 *
 * Sidebar/palet hanya pintu masuk tambahan ke rute yang SUDAH ADA; tidak
 * boleh ada rute baru, rute salah stack, atau entri yang melewati
 * Permission Matrix.
 */
const SUMBER_NAV = readFileSync(join(__dirname, '..', 'navigation', 'RootNavigator.tsx'), 'utf8');

function ruteDiStack(stack: string): Set<string> {
  const hasil = new Set<string>();
  const re = new RegExp(`<${stack}\\.Screen\\s+name="(\\w+)"`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(SUMBER_NAV))) hasil.add(m[1]);
  return hasil;
}

const STACK_TAB: Record<string, string> = {
  Anggota: 'AnggotaStack',
  Transaksi: 'TransaksiStack',
  Laporan: 'LaporanStack',
  Pengaturan: 'PengaturanStack',
  Root: 'RootStack',
};

describe('Katalog menu KOPKU Desktop', () => {
  test('setiap entri menunjuk rute yang terdaftar di stack tab yang benar', () => {
    for (const x of KATALOG) {
      if (x.tab === 'Dashboard') continue;
      const stack = STACK_TAB[x.tab];
      expect({ rute: x.rute, ada: ruteDiStack(stack).has(x.rute) }).toEqual({ rute: x.rute, ada: true });
    }
  });

  test('setiap entri punya syarat izin di IZIN_RUTE (tidak ada rute tanpa gerbang)', () => {
    for (const x of KATALOG) {
      expect({ rute: x.rute, terdaftar: x.rute in IZIN_RUTE }).toEqual({ rute: x.rute, terdaftar: true });
    }
  });

  test('akar setiap grup tab terdaftar di stack-nya', () => {
    for (const g of GRUP_TAB) {
      if (g.tab === 'Dashboard') continue;
      expect(ruteDiStack(STACK_TAB[g.tab]).has(g.akar)).toBe(true);
    }
  });

  test('id entri unik', () => {
    const id = KATALOG.map((x) => x.id);
    expect(new Set(id).size).toBe(id.length);
  });

  test('Permission Matrix: role ANGGOTA tidak melihat form transaksi/pengaturan admin, ADMIN melihat semuanya', () => {
    const admin = katalogBoleh(DEFAULT_ROLE_PERMISSIONS.ADMIN);
    const anggota = katalogBoleh(DEFAULT_ROLE_PERMISSIONS.ANGGOTA);
    expect(admin.length).toBe(KATALOG.length);
    expect(anggota.length).toBeLessThan(admin.length);
    for (const r of ['BayarAngsuranForm', 'UserManagement', 'PermissionMatrix', 'ResetData', 'BebanForm']) {
      expect(anggota.some((x) => x.rute === r)).toBe(false);
    }
    expect(katalogBoleh(null).every((x) => IZIN_RUTE[x.rute] === null)).toBe(true);
  });

  test('pencarian palet: cocok judul, kata kunci, dan urutan relevansi', () => {
    const neraca = cariKatalog(KATALOG, 'neraca').map((x) => x.rute);
    expect(neraca[0]).toBe('NeracaSaldo'); // awalan judul lebih relevan
    expect(neraca).toContain('PosisiKeuangan'); // lewat kata kunci "neraca"
    expect(cariKatalog(KATALOG, 'posisi')[0].rute).toBe('PosisiKeuangan');
    expect(cariKatalog(KATALOG, 'neraca saldo')[0].rute).toBe('NeracaSaldo');
    expect(cariKatalog(KATALOG, 'angsuran').some((x) => x.rute === 'BayarAngsuranForm')).toBe(true);
    expect(cariKatalog(KATALOG, 'zzzz-tidak-ada')).toEqual([]);
    expect(cariKatalog(KATALOG, '  ')).toHaveLength(KATALOG.length);
  });

  test('bukaEntri: lompat antar-tab mengembalikan stack ke akar lalu membuka rute yang sama dengan hub', () => {
    const aksi: any[] = [];
    const nav = {
      navigate: (...a: any[]) => aksi.push(['navigate', ...a]),
      dispatch: (a: any) => aksi.push(['dispatch', a]),
      getState: () => ({ routes: [{ name: 'Transaksi', state: { key: 'stk-1', index: 2 } }] }),
    };
    const bayar = KATALOG.find((x) => x.rute === 'TarikSimpananForm')!;
    bukaEntri(nav, bayar);
    expect(aksi).toEqual([
      ['dispatch', { type: 'POP_TO_TOP', target: 'stk-1' }],
      ['navigate', 'Transaksi', { screen: 'TarikSimpananForm', params: { aksen: 'PENGELUARAN' }, initial: false }],
    ]);
    aksi.length = 0;
    bukaEntri(nav, KATALOG.find((x) => x.rute === 'IdentitasKoperasi')!);
    expect(aksi).toEqual([['navigate', 'IdentitasKoperasi', undefined]]);
  });

  test('parameter entri sama dengan pintu masuk hub (DataReferensiList, PersonelKoperasi, BuktiTransaksiList)', () => {
    const hub = readFileSync(join(__dirname, '..', 'screens', 'Pengaturan', 'InputDataHubScreen.tsx'), 'utf8');
    for (const jenis of ['PEMASOK', 'PEMBERI_PINJAMAN_PIHAK_LAIN', 'PEMBERI_PINJAMAN_BANK', 'BEBAN_LAIN']) {
      expect(hub).toContain(`jenis: '${jenis}'`);
      expect(KATALOG.some((x) => x.rute === 'DataReferensiList' && (x.params as any)?.jenis === jenis)).toBe(true);
    }
    const rincian = readFileSync(join(__dirname, '..', 'screens', 'Akuntansi', 'PenyusutanDimukaMenuScreen.tsx'), 'utf8');
    for (const x of KATALOG.filter((k) => k.rute === 'BuktiTransaksiList')) {
      expect(rincian).toContain(`jenis: '${(x.params as any).jenis}'`);
    }
  });
});

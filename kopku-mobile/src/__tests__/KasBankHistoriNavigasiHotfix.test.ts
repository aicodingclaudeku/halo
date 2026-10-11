import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * HOTFIX v108.8.4 — KAS/BANK HISTORY NAVIGATION.
 *
 * Error: "The action 'NAVIGATE' ... 'KasBankHistori' was not handled by any navigator."
 * Root cause: `RekeningListScreen` dibuka dari tab "Data" (AnggotaStack), sedangkan
 * `KasBankHistori` hanya terdaftar di TransaksiStack (tab "Transaksi"). Route di stack
 * tab lain tidak terjangkau lewat nama; perbaikan: nested navigation ke owner route.
 *
 * Test membaca struktur navigator SUNGGUHAN dari `RootNavigator.tsx` (Jest di repo ini
 * tidak memiliki transformer JSX untuk me-render navigator).
 */

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const NAV = baca('src/navigation/RootNavigator.tsx');

/** stack -> { routeName -> componentName } dari registrasi `<X.Screen name=".." component={..}>`. */
function petaStack(): Record<string, Record<string, string>> {
  const peta: Record<string, Record<string, string>> = {};
  for (const m of NAV.matchAll(/<(\w+)\.Screen\s+name="(\w+)"\s+component=\{(\w+)\}/g)) {
    (peta[m[1]] ??= {})[m[2]] = m[3];
  }
  return peta;
}
const STACK = petaStack();
/** tab route -> nama stack navigator (mis. Transaksi -> TransaksiStack). */
function stackUntukTab(tab: string): string | null {
  const comp = STACK.Tab?.[tab];
  if (!comp) return null;
  const m = comp.match(/^(\w+)Navigator$/);
  return m && STACK[m[1]] ? m[1] : null;
}
/** stack tempat sebuah komponen layar terdaftar. */
function stackDari(komponen: string): string[] {
  return Object.entries(STACK).filter(([, rs]) => Object.values(rs).includes(komponen)).map(([s]) => s);
}
/** komponen -> path file layar (dari import RootNavigator). */
const IMPORT: Record<string, string> = Object.fromEntries(
  [...NAV.matchAll(/import (\w+) from '@\/(screens\/[^']+)'/g)].map((m) => [m[1], `src/${m[2]}.tsx`])
);

const REKENING = tanpaKomentar(baca('src/screens/KasBank/RekeningListScreen.tsx'));
const HISTORI = tanpaKomentar(baca('src/screens/KasBank/KasBankHistoriScreen.tsx'));

describe('HOTFIX v108.8.4 — navigasi Histori Kas/Bank', () => {
  it('TEST 1: screen histori existing terdaftar TEPAT SEKALI, di TransaksiStack milik tab "Transaksi"', () => {
    const registrasi = [...NAV.matchAll(/name="KasBankHistori"/g)];
    expect(registrasi).toHaveLength(1);
    expect(STACK.TransaksiStack?.KasBankHistori).toBe('KasBankHistoriScreen');
    expect(stackUntukTab('Transaksi')).toBe('TransaksiStack');
    expect(IMPORT.KasBankHistoriScreen).toBe('src/screens/KasBank/KasBankHistoriScreen.tsx');
  });

  it('konteks root cause: RekeningList dijangkau dari tab "Data" (AnggotaStack) yang TIDAK memuat KasBankHistori', () => {
    expect(stackDari('RekeningListScreen')).toContain('AnggotaStack');
    expect(STACK.AnggotaStack?.KasBankHistori).toBeUndefined();
    expect(stackUntukTab('Anggota')).toBe('AnggotaStack');
  });

  it('TEST 2: RekeningListScreen menuju owner route lewat tab: navigate("Transaksi", { screen: "KasBankHistori", initial: false })', () => {
    expect(REKENING).toMatch(/navigation\.navigate\('Transaksi', \{\s*screen: 'KasBankHistori',\s*initial: false,/);
    // Target nested benar-benar ada di stack tab tersebut.
    expect(STACK[stackUntukTab('Transaksi')!].KasBankHistori).toBe('KasBankHistoriScreen');
  });

  it('TEST 3: BANK -> Histori membawa jenis, bankAccountId, namaRekening — persis yang dibaca layar histori', () => {
    expect(REKENING).toMatch(/params: \{\s*jenis: item\.jenis,\s*bankAccountId: item\.id,\s*namaRekening: item\.nama,\s*\}/);
    for (const p of ['jenis', 'bankAccountId', 'namaRekening']) expect(HISTORI).toContain(`route.params?.${p}`);
  });

  it('TEST 4: daftar ini hanya berisi rekening BANK — alur KAS -> Histori tidak tersedia dari layar ini (jenis diteruskan generik)', () => {
    expect(REKENING).toMatch(/setData\(rows\.filter\(\(r\) => r\.jenis === 'BANK'\)\)/);
    expect(REKENING).toContain('jenis: item.jenis');
  });

  it('TEST 5: tidak ada duplicate route maupun duplicate screen histori rekening', () => {
    expect([...NAV.matchAll(/name="KasBankHistori"/g)]).toHaveLength(1);
    expect([...NAV.matchAll(/import KasBankHistoriScreen from/g)]).toHaveLength(1);
    const kasbank = readdirSync(join(ROOT, 'src/screens/KasBank'));
    expect(kasbank.filter((f) => /Histori/i.test(f))).toEqual(['KasBankHistoriScreen.tsx']);
  });

  it('TEST 6: tidak ada caller yang menuju KasBank* dari stack yang tidak memuat route tersebut', () => {
    const tujuan = ['KasBankHistori', 'KasBankDetail', 'KasBankTransaksiForm'];
    const mati: string[] = [];
    for (const [komp, path] of Object.entries(IMPORT)) {
      if (!existsSync(join(ROOT, path))) continue;
      const src = tanpaKomentar(baca(path));
      for (const m of src.matchAll(/navigate\(\s*'(\w+)'/g)) {
        if (!tujuan.includes(m[1])) continue;
        for (const st of stackDari(komp)) {
          if (st === 'Tab' || st === 'RootStack') continue;
          if (!STACK[st][m[1]]) mati.push(`${path} (${st}) -> ${m[1]}`);
        }
      }
    }
    expect(mati).toEqual([]);
  });

  it('setiap nested navigation navigate("<Tab>", { screen }) di repo menuju route yang terdaftar di stack tab itu', () => {
    const salah: string[] = [];
    const telusur = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') telusur(p); continue; }
        if (!/\.(ts|tsx)$/.test(n)) continue;
        const src = tanpaKomentar(readFileSync(p, 'utf8'));
        for (const m of src.matchAll(/navigate\(\s*'(\w+)',\s*\{\s*screen:\s*'(\w+)'/g)) {
          const st = stackUntukTab(m[1]);
          if (!st) continue; // bukan tab (mis. RootStack 'Tabs') — di luar cakupan cek ini
          if (!STACK[st][m[2]]) salah.push(`${relative(ROOT, p)}: ${m[1]} -> ${m[2]}`);
        }
      }
    };
    telusur(join(ROOT, 'src'));
    expect(salah).toEqual([]);
  });

  it("TEST 7: tidak ada lagi navigate('KasBankHistori') langsung dari layar di luar TransaksiStack", () => {
    const langsung: string[] = [];
    for (const [komp, path] of Object.entries(IMPORT)) {
      if (!existsSync(join(ROOT, path))) continue;
      if (/navigate\(\s*'KasBankHistori'/.test(tanpaKomentar(baca(path)))) {
        const st = stackDari(komp);
        if (!st.every((s) => s === 'TransaksiStack')) langsung.push(`${path} [${st.join(',')}]`);
      }
    }
    expect(langsung).toEqual([]);
  });
});

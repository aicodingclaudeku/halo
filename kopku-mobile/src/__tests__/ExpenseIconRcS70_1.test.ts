import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S70.1 — STANDARDISASI WARNA IKON MENU PENGELUARAN.
 *
 * Uji statis atas sumber (render perangkat tidak tersedia di lingkungan
 * ini — UI RUNTIME BLOCKED). Yang dikunci:
 *   1. seluruh ikon kartu di hub Pengeluaran memakai token merah
 *      Pengeluaran, bukan hijau brand;
 *   2. tidak ada merah baru — hanya `semantic.expense*` yang sudah ada
 *      sejak RC-S68.2;
 *   3. modul lain (Penerimaan, Penyesuaian, Kas & Bank, Simpanan) TIDAK
 *      ikut berubah;
 *   4. tidak ada perubahan logika: rute, service, dan jurnal tetap.
 */

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const PENGELUARAN = strip(baca('src/screens/Transaksi/TransaksiPengeluaranScreen.tsx'));
const PENERIMAAN = strip(baca('src/screens/Transaksi/TransaksiPenerimaanScreen.tsx'));
const PENYESUAIAN = strip(baca('src/screens/Transaksi/PenyesuaianScreen.tsx'));
const WARNA = strip(baca('src/theme/colors.ts'));
const UI = strip(baca('src/theme/ui.ts'));
const BAYAR_UTANG = strip(baca('src/screens/Transaksi/BayarUtangFormScreen.tsx'));
// DIPERBARUI RC-S71: AkruiBungaUtangFormScreen dihapus (akrual bunga utang
// kini infrastruktur otomatis, bukan menu) — tidak lagi dibaca di sini.
const BEBAN = strip(baca('src/screens/Transaksi/BebanFormScreen.tsx'));
const TARIK = strip(baca('src/screens/Transaksi/TarikSimpananFormScreen.tsx'));
const KASBANK = strip(baca('src/screens/KasBank/KasBankTransaksiFormScreen.tsx'));
const IMBALAN = strip(baca('src/screens/Transaksi/ImbalanKerjaFormScreen.tsx'));
const NAV = strip(baca('src/navigation/RootNavigator.tsx'));

/** Item hub Pengeluaran DITURUNKAN DARI SOURCE, bukan dari angka di dokumen. */
const BLOK_SUB_FITUR = PENGELUARAN.slice(
  PENGELUARAN.indexOf('const SUB_FITUR'),
  PENGELUARAN.indexOf('const GRUP')
);
const ITEM = [...BLOK_SUB_FITUR.matchAll(/title: '([^']+)'/g)].map((m) => m[1]);
const IKON = [...BLOK_SUB_FITUR.matchAll(/icon: '([^']+)'/g)].map((m) => m[1]);

describe('RC-S70.1 — token warna', () => {
  it('TEST A — memakai token yang sudah ada, tidak membuat sistem warna kedua', () => {
    expect(WARNA).toContain('expenseIcon: colors.danger');
    expect(WARNA).toContain('expenseIconBackground: colors.dangerBg');
  });

  it('TEST B — tidak ada hex merah baru di blok semantic', () => {
    const blok = WARNA.slice(WARNA.indexOf('export const semantic'), WARNA.indexOf('export const spacing'));
    const hex = (blok.match(/'#[0-9A-Fa-f]{6}'/g) ?? []).sort();
    expect(hex).toEqual(["'#D6E9D8'", "'#D6E9D8'", "'#F9DADA'"]);
  });

  it('TEST C — varian wadah ikon Pengeluaran ada dan terpisah dari default', () => {
    expect(UI).toContain('menuIconExpense: { backgroundColor: semantic.expenseIconBackground }');
    expect(UI).toContain('menuIconExpensePressed: { backgroundColor: semantic.expensePressed }');
    // Default global menuIcon TIDAK berubah.
    expect(UI).toContain('backgroundColor: colors.primaryLight');
  });
});

describe('RC-S70.1 FINAL — struktur hub diambil dari source', () => {
  it('TEST P — setiap item punya judul, ikon, grup, dan rute (jumlah tidak di-hardcode)', () => {
    expect(ITEM.length).toBeGreaterThan(0);
    expect(IKON.length).toBe(ITEM.length);
    const onPress = [...BLOK_SUB_FITUR.matchAll(/onPress: \(nav\)/g)].length;
    expect(onPress).toBe(ITEM.length);
    const grup = [...BLOK_SUB_FITUR.matchAll(/grup: '([^']+)'/g)].length;
    expect(grup).toBe(ITEM.length);
  });

  it('TEST Q — "Pemberian Pinjaman untuk ANGGOTA" aktif; versi "untuk KOPERASI" sudah dihapus', () => {
    // Yang AKTIF dan wajib tetap ada:
    expect(ITEM).toContain('Pemberian Pinjaman untuk Anggota');
    expect(BLOK_SUB_FITUR).toContain("nav.navigate('PinjamanList')");

    // Yang SUDAH DIHAPUS (RC-S70.2) — tidak boleh muncul di hub:
    expect(PENGELUARAN).not.toContain('Pinjaman untuk Koperasi');
    expect(PENGELUARAN).not.toContain('PemberianPinjamanKoperasi');
    expect(PENGELUARAN).not.toContain('PinjamanKoperasiList');
    expect(ITEM).not.toContain('Pemberian Pinjaman untuk Koperasi');
  });

  it('TEST U — RC-S70.2: berkas runtime fitur legacy benar-benar tidak ada lagi', () => {
    for (const rel of [
      'src/screens/Transaksi/PemberianPinjamanKoperasiFormScreen.tsx',
      'src/screens/Akuntansi/DaftarPinjamanKoperasiScreen.tsx',
      'src/services/PemberianPinjamanKoperasiService.ts',
    ]) {
      expect(existsSync(join(ROOT, rel))).toBe(false);
    }
    // Navigator tidak lagi mengimpor atau mendaftarkan apa pun miliknya.
    expect(NAV).not.toContain('PemberianPinjamanKoperasiFormScreen');
    expect(NAV).not.toContain('DaftarPinjamanKoperasiScreen');
    expect(NAV).not.toContain('name="PemberianPinjamanKoperasiForm"');
    expect(NAV).not.toContain('name="PinjamanKoperasiList"');
    // Builder ekspornya juga hilang.
    expect(strip(baca('src/export/ReportTableBuilders.ts'))).not.toContain(
      'buildPemberianPinjamanKoperasiExport'
    );
  });

  it('TEST V — RC-S70.2: struktur & klasifikasi historis SENGAJA dipertahankan', () => {
    // Tabel historis tetap ada (tidak boleh destruktif)...
    expect(baca('src/database/schema.ts')).toContain('CREATE TABLE IF NOT EXISTS pinjaman_koperasi');
    expect(baca('src/database/db.ts')).toContain('currentVersion < 39');
    // ...dan jurnal historis tetap terklasifikasi, bukan jatuh ke unknown.
    expect(baca('src/accounting/CashFlowClassification.ts')).toContain(
      "PEMBERIAN_PINJAMAN_KOPERASI: 'INVESTASI'"
    );
  });

  it('TEST R — tidak ada rute baru yang ditambahkan RC-S70.1', () => {
    for (const t of ITEM) {
      // setiap judul harus punya onPress yang menavigasi ke rute terdaftar
      expect(BLOK_SUB_FITUR).toContain(`title: '${t}'`);
    }
    // Sebagian <Stack.Screen> ditulis multi-baris, jadi ambil seluruh
    // atribut name="..." di RootNavigator, bukan hanya yang satu baris.
    const terdaftar = [...NAV.matchAll(/name="(\w+)"/g)].map((m) => m[1]);
    const dituju = [...BLOK_SUB_FITUR.matchAll(/nav\.navigate\('(\w+)'/g)].map((m) => m[1]);
    expect(dituju.length).toBe(ITEM.length);
    for (const r of dituju) expect(terdaftar).toContain(r);
  });
});

describe('RC-S70.1 — hub Pengeluaran', () => {
  it('TEST D — ikon kartu memakai merah Pengeluaran', () => {
    expect(PENGELUARAN).toContain('color={semantic.expenseIcon}');
  });

  it('TEST E — tidak ada lagi ikon hijau brand di hub Pengeluaran', () => {
    expect(PENGELUARAN).not.toContain('color={colors.primary}');
    expect(/<Ionicons[^>]*colors\.primary/.test(PENGELUARAN)).toBe(false);
  });

  it('TEST F — wadah ikon memakai varian scoped, bukan primaryLight', () => {
    expect(PENGELUARAN).toContain('...ui.menuIcon, ...ui.menuIconExpense');
    expect(PENGELUARAN).not.toContain('colors.primaryLight');
  });

  it('TEST G — chevron tetap netral (affordance navigasi, bukan identitas)', () => {
    expect(PENGELUARAN).toContain('name="chevron-forward"');
    expect(PENGELUARAN).toContain('color={colors.textFaint}');
  });

  it('TEST H — hanya warna ikon yang berubah: kartu, teks, dan latar layar tetap netral', () => {
    expect(PENGELUARAN).toContain('card: { ...ui.menuCard }');
    expect(PENGELUARAN).toContain('cardTitle: { ...ui.menuTitle }');
    expect(PENGELUARAN).toContain('backgroundColor: colors.background');
  });

  it('TEST I — label & aksesibilitas tidak dihapus (warna bukan satu-satunya informasi)', () => {
    expect(PENGELUARAN).toContain('accessibilityLabel={f.title}');
    expect(PENGELUARAN).toContain('accessibilityHint={f.sub}');
    expect(PENGELUARAN).toContain('accessibilityRole="header"');
  });
});

describe('RC-S70.1 — layar turunan Pengeluaran', () => {
  it('TEST J — ikon identitas di layar khusus Pengeluaran memakai merah', () => {
    expect(BAYAR_UTANG).toContain('name="wallet-outline" size={18} color={semantic.expenseIcon}');
    expect(BAYAR_UTANG).toContain('name="information-circle-outline" size={18} color={semantic.expenseIcon}');
    // DIPERBARUI RC-S71: assertion ikon layar akrual dihapus bersama layarnya.
    expect(BEBAN).toContain('name="checkmark-circle" size={20} color={semantic.expenseIcon}');
  });

  it('TEST K — layar bersama Tarik Simpanan dibedakan lewat parameter, bukan default global', () => {
    expect(TARIK).toContain("route?.params?.aksen === 'PENGELUARAN' ? semantic.expenseIcon : colors.primary");
    expect(TARIK).toContain('color={ikonAksen}');
    expect(TARIK).toContain('color={konfirmasiDini ? ikonAksen : colors.textMuted}');
    expect(PENGELUARAN).toContain("nav.navigate('TarikSimpananForm', { aksen: 'PENGELUARAN' })");
  });

  it('TEST S — tidak ada ikon hijau brand tersisa di layar khusus Pengeluaran', () => {
    // Hanya IKON yang diaudit. `ActivityIndicator color={colors.primary}`
    // SENGAJA dibiarkan: itu spinner brand, bukan ikon — spinner merah
    // akan terbaca sebagai galat.
    const tagIkon = (src: string) => src.match(/<Ionicons(?:(?!\/>)[\s\S])*?\/>/g) ?? [];
    for (const src of [BAYAR_UTANG, BEBAN, IMBALAN]) { // DIPERBARUI RC-S71: tanpa layar akrual
      for (const tag of tagIkon(src)) expect(tag).not.toContain('colors.primary');
    }
  });

  it('TEST T — chevron di Imbalan Kerja memakai warna netral, bukan hijau brand', () => {
    expect(IMBALAN).toContain('name="chevron-forward" size={iconSize.sm} color={colors.textFaint}');
  });
});

describe('RC-S70.1 — tidak ada regresi pada modul lain', () => {
  it('TEST L — Penerimaan & Penyesuaian tidak memakai merah Pengeluaran', () => {
    expect(PENERIMAAN).not.toContain('semantic.expenseIcon');
    expect(PENYESUAIAN).not.toContain('semantic.expenseIcon');
  });

  it('TEST M — layar bersama Kas & Bank tidak diubah', () => {
    expect(KASBANK).toContain('name="pricetag-outline" size={16} color={colors.primary}');
    expect(KASBANK).not.toContain('semantic.expense');
  });
});

describe('RC-S70.1 — tidak ada perubahan logika', () => {
  it('TEST N — seluruh rute Pengeluaran tetap sama', () => {
    for (const rute of [
      "nav.navigate('PinjamanList')",
      "nav.navigate('BayarUtangForm')",
      // DIPERBARUI RC-S71: 'AkruiBungaUtangForm' dikeluarkan dari hub (lihat test RC-S71).
      "nav.navigate('RAKForm', {})",
      "nav.navigate('InvestasiForm')",
      "nav.navigate('PembelianAsetForm')",
      "nav.navigate('BebanForm')",
      "nav.navigate('ImbalanKerjaForm')",
      "nav.navigate('PenghapusanPiutangForm')",
      // DIPERBARUI RESTRUKTURISASI HUB KELUAR ANGGOTA: menu Pengeluaran kini
      // membuka HUB 'KeluarAnggotaMenu' (Pengajuan | Daftar Pengajuan),
      // bukan langsung form. Rute 'KeluarAnggotaForm' tetap ada dan tetap
      // menjadi layar pengajuan — hanya pintu masuknya yang bergeser satu
      // tingkat. Maksud test ini (setiap entri hub menavigasi ke rute yang
      // benar) tidak berubah.
      "nav.navigate('KeluarAnggotaMenu')",
    ]) {
      expect(PENGELUARAN).toContain(rute);
    }
    expect(PENGELUARAN).toContain("nav.navigate('KasBankTransaksiForm', { tipe: 'TRANSFER'");
  });

  it('TEST O — hub Pengeluaran tetap murni presentasi (tanpa service/akuntansi/DB)', () => {
    for (const terlarang of ['Service', 'jurnal', 'migrasi', 'SCHEMA_VERSION', 'executeSql', 'repositories/']) {
      expect(PENGELUARAN).not.toContain(terlarang);
    }
  });
});

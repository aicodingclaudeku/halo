import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S68.1 — FULL UI/UX REDESIGN (Transaksi & Penyesuaian). Struktural:
 * konsistensi visual, aksesibilitas, pengelompokan, dan navigasi. Render
 * perangkat tidak tersedia di lingkungan ini (UI RUNTIME BLOCKED).
 */

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const HUB = strip(baca('src/screens/Transaksi/TransaksiScreen.tsx'));
const TERIMA = strip(baca('src/screens/Transaksi/TransaksiPenerimaanScreen.tsx'));
const KELUAR = strip(baca('src/screens/Transaksi/TransaksiPengeluaranScreen.tsx'));
const SESUAI = strip(baca('src/screens/Transaksi/PenyesuaianScreen.tsx'));
const SEMUA = { HUB, TERIMA, KELUAR, SESUAI };

describe('RC-S68.1 — konsistensi visual & interaksi', () => {
  it.each(Object.entries(SEMUA))('%s: setiap kartu punya umpan balik tekan, label & hint aksesibilitas, chevron kecil', (_n, s) => {
    const kartu = (s.match(/<TouchableOpacity/g) ?? []).length;
    expect(kartu).toBeGreaterThan(0);
    expect((s.match(/activeOpacity=\{0\.7\}/g) ?? []).length).toBe(kartu);
    expect((s.match(/accessibilityRole="button"/g) ?? []).length).toBe(kartu);
    expect((s.match(/accessibilityHint=/g) ?? []).length).toBe(kartu);
    expect((s.match(/accessibilityLabel=/g) ?? []).length).toBe(kartu);
    expect((s.match(/name="chevron-forward" size=\{iconSize\.md\} color=\{colors\.textFaint\} style=\{ui\.chevron\}/g) ?? []).length).toBe(kartu);
    expect(s).toMatch(/minWidth: 0/); // teks panjang membungkus, tidak menabrak chevron
  });

  // RC-S68.2 — aturan "satu warna ikon (brand)" TETAP berlaku untuk daftar
  // sub-fitur di dalam kategori (Penerimaan/Pengeluaran/Penyesuaian): di sana
  // warna per item hanya menimbulkan kebisingan. Aturan itu DICABUT khusus
  // untuk hub Transaksi, yang sekarang memakai aksen semantik arus kas
  // (hijau = masuk, merah = keluar, netral = penyesuaian). Lihat
  // TransaksiUiRcS68_2.test.ts untuk aturan penggantinya.
  it('sub-layar kategori: satu warna ikon (brand) — tidak ada kode warna per menu pada ikon kartu', () => {
    for (const s of [TERIMA, KELUAR, SESUAI]) {
      expect(s).not.toMatch(/Ionicons name=\{?[^}]*\}? size=\{(menuIconSize|iconSize\.(lg|xl))\} color=\{colors\.(danger|success|warning)\}/);
      expect(s).not.toMatch(/menuIconDanger|dangerBg/);
    }
  });

  it('hub Transaksi: tiga kartu kategori dengan wadah ikon seragam (persegi-bulat)', () => {
    expect((HUB.match(/styles\.mainIcon,/g) ?? []).length).toBe(3);
    expect(HUB).toMatch(/mainIcon: \{[\s\S]*?width: 48,[\s\S]*?height: 48,[\s\S]*?borderRadius: radius\.md,/);
    expect(HUB).toContain('Kelola aktivitas transaksi koperasi.');
    for (const d of ['Mencatat uang yang diterima koperasi', 'Mencatat uang yang dikeluarkan koperasi', 'Koreksi dan penyesuaian transaksi']) {
      expect(HUB).toContain(d);
    }
    // Judul layar dari header navigator — tanpa judul ganda di layar.
    expect(HUB).not.toMatch(/>Transaksi<\/Text>/);
  });
});

// DIPERBARUI (modul Penarikan Dana Investasi): Penerimaan 9 -> 10 item —
// entri baru "Penarikan Dana Investasi" di grup Pendanaan.
describe('RC-S68.1 — pengelompokan Penerimaan & Pengeluaran', () => {
  const grupItem = (s: string) => [...s.matchAll(/grup: '([A-Z_]+)',/g)].map((m) => m[1]);
  const grupDefinisi = (s: string) => [...s.matchAll(/\{ kode: '([A-Z_]+)', label: '([^']+)' \}/g)].map((m) => m[1]);

  // RC-S70.3 (instruksi eksplisit pengguna): Penerimaan 8 -> 9 item karena
  // "Pengembalian RAKU" dipindah dari menu Pendapatan Koperasi ke grup RAKU
  // tersendiri di hub ini. Kontrak test (setiap item punya grup yang tampil)
  // tidak dilonggarkan.
  // RC-S71 (instruksi eksplisit pengguna): Pengeluaran 12 -> 11 item karena
  // "Akrual & Kontrol Bunga Utang" dikeluarkan dari menu (akrual kini otomatis).
  // DIPERBARUI RC-S84 (instruksi eksplisit pengguna: buat menu Pajak):
  // Pengeluaran 11 -> 12 item karena kartu "Pajak" ditambahkan di grup
  // KEWAJIBAN. Daftar grup TIDAK berubah; kontrak test (setiap item punya
  // grup yang tampil) tidak dilonggarkan.
  // DIPERBARUI RC-S109 (permintaan eksplisit pengguna: pindahkan SHU ke
  // Pengeluaran): Pengeluaran 12 -> 13 item karena kartu "Pembagian Sisa
  // Hasil Usaha" ditambahkan di grup ANGGOTA — pembagian SHU menjurnal,
  // mengurangi ekuitas, dan menambah simpanan anggota, jadi memang
  // pengeluaran, bukan laporan. Entri itu DIHAPUS dari menu Laporan pada
  // saat yang sama, sehingga tetap satu pintu masuk. Daftar grup TIDAK
  // berubah; kontrak test (setiap item punya grup yang tampil) tidak
  // dilonggarkan.
  // DIPERBARUI RC-S121 (instruksi eksplisit pengguna): Penerimaan 10 -> 9
  // item karena entri manual "Pendapatan Diterima Dimuka" dikeluarkan dari
  // menu (pendapatan diterima dimuka dibentuk otomatis oleh sistem). Grup
  // PENDAPATAN tetap tampil (masih berisi Pendapatan Koperasi); kontrak
  // test (setiap item punya grup yang tampil) tidak dilonggarkan.
  it.each([['Penerimaan', TERIMA, 9], ['Pengeluaran', KELUAR, 13]] as const)('%s: setiap item punya grup yang ditampilkan (tidak ada item tersembunyi)', (_n, s, jumlah) => {
    const items = grupItem(s);
    const defs = grupDefinisi(s);
    expect(items).toHaveLength(jumlah);
    for (const g of items) expect(defs).toContain(g);
    expect(s).toContain('const item = SUB_FITUR.filter((f) => f.grup === g.kode);');
    expect(s).toMatch(/<Text style=\{styles\.sectionLabel\} accessibilityRole="header">/);
    expect(s).toContain('sectionLabel: { ...ui.sectionLabel },');
  });

  it('label bagian singkat', () => {
    // RC-S70.3: grup 'RAKU' ditambahkan — RAKU adalah posisi aset antar
    // kantor/unit, bukan kategori pendapatan.
    expect(grupDefinisi(TERIMA)).toEqual(['ANGGOTA', 'PENDANAAN', 'PENDAPATAN', 'RAKU', 'KAS_BANK']);
    expect(grupDefinisi(KELUAR)).toEqual(['ANGGOTA', 'KEWAJIBAN', 'INVESTASI_ASET', 'BEBAN_PIUTANG', 'KAS_BANK']);
    for (const m of [...TERIMA.matchAll(/label: '([^']+)' \}/g), ...KELUAR.matchAll(/label: '([^']+)' \}/g)]) {
      expect(m[1].length).toBeLessThanOrEqual(28);
    }
  });

  it('item tetap di tempatnya: Pembelian Aset di Investasi & Aset (Pengeluaran); Pendapatan Koperasi di Pendapatan (Penerimaan)', () => {
    expect(KELUAR).toMatch(/grup: 'INVESTASI_ASET',\s*icon: 'cart-outline',\s*title: 'Pembelian Aset'/);
    expect(TERIMA).toMatch(/grup: 'PENDAPATAN',\s*icon: 'trending-up-outline',\s*title: 'Pendapatan Koperasi'/);
    expect(KELUAR).not.toMatch(/Penyesuaian/);
  });
});

describe('RC-S68.1 — Penyesuaian', () => {
  it('catatan kebijakan tampil netral (bukan warna peringatan) dengan ikon info', () => {
    expect(SESUAI).not.toMatch(/colors\.warning/);
    expect(SESUAI).toContain('name="information-circle-outline"');
  });

  it('komentar usang "2 menu awal" sudah diperbarui', () => {
    for (const f of ['TransaksiPenerimaanScreen', 'TransaksiPengeluaranScreen']) {
      expect(baca(`src/screens/Transaksi/${f}.tsx`)).not.toMatch(/hanya punya 2 menu awal/);
    }
    expect(baca('src/screens/Transaksi/TransaksiScreen.tsx')).not.toMatch(/HANYA 2 menu/);
  });
});

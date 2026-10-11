import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * ============================================================
 * RC-S49b §A — TOMBOL REFRESH DI SETIAP LAPORAN
 * ============================================================
 *
 * APA YANG SEBENARNYA DIJAGA SUITE INI.
 *
 * Bahaya terbesar dari pekerjaan "tambahkan tombol refresh" bukanlah
 * tombolnya tidak muncul — itu ketahuan dalam sepuluh detik. Bahayanya
 * adalah tombol yang, demi terasa cepat, membangun jalur pemuatan
 * KEDUA: kueri sendiri, state sendiri, atau perhitungan sendiri yang
 * lambat laun menyimpang dari jalur `load()` yang dipakai initial load
 * dan focus refresh. Dua jalur untuk satu laporan keuangan berarti dua
 * jawaban yang mungkin berbeda, dan yang salah tidak akan tampak salah.
 *
 * Karena itu yang diperiksa di sini bukan "ada tombol", melainkan:
 * tombolnya memanggil FUNGSI YANG SUDAH ADA, hanya ada SATU lifecycle
 * pemuatan per layar, dan tidak ada satu pun layar yang menggambar
 * tombolnya sendiri.
 *
 * KENAPA STRUKTURAL. `testEnvironment: 'node'` tanpa renderer React
 * Native — layar tidak dapat dirender di sini. Sifat "satu sumber
 * loader" memang sifat SUMBER, jadi memeriksanya dari sumber bukan
 * kompromi.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const tanpaKomentar = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const KOMPONEN = 'src/components/report/ReportRefreshButton.tsx';

/**
 * Seluruh layar yang MENYAJIKAN data laporan, beserta nama fungsi
 * loader yang sudah ada di dalamnya SEBELUM RC ini.
 *
 * `loader` adalah inti daftar ini: nilainya harus fungsi yang memang
 * sudah dipakai layar itu untuk memuat datanya sendiri.
 */
const LAYAR_LAPORAN: { nama: string; berkas: string; loader: string }[] = [
  { nama: 'Posisi Keuangan', berkas: 'src/screens/Laporan/PosisiKeuanganScreen.tsx', loader: 'muat' },
  { nama: 'Laba Rugi (LHU)', berkas: 'src/screens/Laporan/LabaRugiScreen.tsx', loader: 'muat' },
  { nama: 'Perubahan Ekuitas', berkas: 'src/screens/Laporan/PerubahanEkuitasScreen.tsx', loader: 'muat' },
  { nama: 'Arus Kas', berkas: 'src/screens/Laporan/ArusKasScreen.tsx', loader: 'muat' },
  { nama: 'CALK', berkas: 'src/screens/Laporan/CalkScreen.tsx', loader: 'muat' },
  { nama: 'Neraca Saldo', berkas: 'src/screens/Laporan/NeracaSaldoScreen.tsx', loader: 'muat' },
  { nama: 'Buku Besar', berkas: 'src/screens/Laporan/BukuBesarScreen.tsx', loader: 'load' },
  { nama: 'Kolektibilitas Piutang', berkas: 'src/screens/Laporan/KolektibilitasPiutangScreen.tsx', loader: 'muat' },
  { nama: 'History Transaksi', berkas: 'src/screens/Laporan/HistoryTransaksiScreen.tsx', loader: 'load' },
  { nama: 'Bukti Transaksi', berkas: 'src/screens/Laporan/BuktiTransaksiListScreen.tsx', loader: 'load' },
  { nama: 'SHU', berkas: 'src/screens/Shu/ShuScreen.tsx', loader: 'load' },
];

// ============================================================
// §A1 — komponen tunggal
// ============================================================
describe('§A1 — satu komponen refresh untuk semua laporan', () => {
  const komponen = read(KOMPONEN);

  it('komponen bersama memang ada dan mengekspor hook pemasangnya', () => {
    expect(komponen).toMatch(/export default function ReportRefreshButton/);
    expect(komponen).toMatch(/export function useReportRefreshHeader/);
  });

  it('§A4 — memakai ikon & indikator yang diminta, bukan gaya baru', () => {
    expect(komponen).toMatch(/name="refresh-outline"/);
    expect(komponen).toMatch(/<ActivityIndicator/);
    // Token desain existing, bukan hex yang dikarang di tempat.
    expect(komponen).toMatch(/from '@\/theme\/colors'/);
    expect(komponen).not.toMatch(/#[0-9A-Fa-f]{6}/);
  });

  it('punya loading state dan mencegah spam tap', () => {
    const kode = tanpaKomentar(komponen);
    expect(kode).toMatch(/const terkunci = sibuk \|\| disabled;/);
    // Tap saat terkunci berhenti SEBELUM loader dipanggil.
    expect(kode).toMatch(/if \(terkunci\) return;[\s\S]{0,200}onRefresh\(\)/);
    expect(kode).toMatch(/disabled=\{terkunci\}/);
  });

  it('kembali normal setelah selesai, termasuk saat loader gagal', () => {
    const kode = tanpaKomentar(komponen);
    expect(kode).toMatch(/\.finally\(\(\) => setSibukLokal\(false\)\)/);
    expect(kode).toMatch(/\.catch\(/);
  });

  it('§A3 — komponen TIDAK menyentuh data, service, atau perhitungan', () => {
    // Satu-satunya hal yang boleh dilakukannya adalah memanggil
    // callback milik layar.
    expect(komponen).not.toMatch(/getDb|@\/services\/|@\/reports\/|@\/accounting\/|SELECT /);
  });
});

// ============================================================
// §A1/§A2 — setiap laporan memakai loader yang SUDAH ADA
// ============================================================
describe('§A1/§A2 — refresh memanggil loader existing, bukan kueri kedua', () => {
  it('daftar layar laporan tidak menyusut diam-diam', () => {
    expect(LAYAR_LAPORAN).toHaveLength(11);
  });

  it.each(LAYAR_LAPORAN)('$nama memasang tombol refresh bersama', ({ berkas }) => {
    const kode = read(berkas);
    expect(kode).toMatch(
      /import \{ useReportRefreshHeader \} from '@\/components\/report\/ReportRefreshButton';/
    );
    expect(kode).toMatch(/useReportRefreshHeader\(/);
  });

  it.each(LAYAR_LAPORAN)(
    '$nama menyerahkan loader yang sudah ada, bukan fungsi baru',
    ({ berkas, loader }) => {
      const kode = tanpaKomentar(read(berkas));
      expect(kode).toMatch(new RegExp(`useReportRefreshHeader\\(${loader}[,)]`));
    }
  );

  it.each(LAYAR_LAPORAN)('$nama meneruskan state loading layar ke tombol', ({ berkas }) => {
    const kode = tanpaKomentar(read(berkas));
    const panggilan = kode.slice(kode.indexOf('useReportRefreshHeader('));
    expect(panggilan.slice(0, panggilan.indexOf(');') + 2)).toMatch(/loading/);
  });

  it.each(LAYAR_LAPORAN)('$nama TIDAK menggambar tombol refresh sendiri', ({ berkas }) => {
    const kode = tanpaKomentar(read(berkas));
    // Kalau ada layar yang menaruh ikon refresh-nya sendiri, kita
    // kembali ke sebelas gaya yang berbeda — persis yang dilarang §A1.
    expect(kode).not.toMatch(/name="refresh-outline"/);
    expect(kode).not.toMatch(/name="refresh"/);
  });

  it.each(LAYAR_LAPORAN)('$nama tetap punya SATU lifecycle pemuatan', ({ berkas }) => {
    const kode = tanpaKomentar(read(berkas));
    const fokusHook = [...kode.matchAll(/useFocusRefresh\(/g)].length;
    const fokusListener = [...kode.matchAll(/addListener\('focus'/g)].length;
    // Tepat satu mekanisme fokus — hook ATAU listener, tidak keduanya
    // dan tidak dua kali.
    expect(fokusHook + fokusListener).toBe(1);
    expect(kode).not.toMatch(/useReportRefreshHeader\([\s\S]{0,120}getDb\(/);
  });
});

// ============================================================
// §A3/§N — batas yang tidak boleh dilewati
// ============================================================
describe('§A3/§N — refresh tidak menyentuh logic laporan', () => {
  it.each(LAYAR_LAPORAN)('$nama tidak menambah kueri/impor service baru untuk refresh', ({ berkas }) => {
    const kode = read(berkas);
    // Blok yang ditambahkan RC ini hanya boleh berisi pemanggilan hook.
    const i = kode.indexOf('useReportRefreshHeader(');
    const potongan = kode.slice(i, i + 200);
    expect(potongan).not.toMatch(/SELECT |getDb\(|await /);
  });

  it('tidak ada berkas laporan/akuntansi yang ikut diubah untuk fitur ini', () => {
    // Formula, mapping akun, dan urutan penyajian SAK EP hidup di sini.
    // Kalau tombol refresh sampai perlu menyentuhnya, sesuatu sudah
    // salah arah.
    const laporan = read('src/reports/FinancialReports.ts');
    expect(laporan).not.toMatch(/ReportRefreshButton|useReportRefreshHeader/);
  });
});

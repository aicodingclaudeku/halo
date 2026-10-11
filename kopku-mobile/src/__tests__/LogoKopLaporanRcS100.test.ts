import * as fs from 'fs';
import * as path from 'path';
import { buildReportHtml } from '@/export/HtmlReportBuilder';
import { buildDokumenSeksiHtml } from '@/export/DokumenSeksiHtml';
import type { DataLaporanExport } from '@/export/ExportTypes';

/**
 * RC-S100 — LOGO KOPERASI DI KOP LAPORAN.
 *
 * Permintaan pengguna: logo dipilih langsung dari berkas gambar di
 * Identitas Koperasi, lalu "ditampilkan di dasboard dan export".
 *
 * Bagian yang bisa diuji langsung di Node adalah PENYISIPANNYA ke HTML
 * (builder murni: string in, string out). Pemilihan berkas & penyalinannya
 * memakai `expo-image-picker`/`expo-file-system` — tidak ada jembatan
 * nativenya di Node, jadi untuk lapisan itu yang diuji adalah kontrak
 * strukturalnya (lihat §C), dan perilakunya harus dicoba di perangkat.
 */

const LOGO_PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function dataLaporan(tambahan: Partial<DataLaporanExport> = {}): DataLaporanExport {
  return {
    judulLaporan: 'Laporan Hasil Usaha',
    namaFileDasar: 'lhu',
    namaKoperasi: 'KSP Kenanga',
    alamatKoperasi: 'Jl. Mawar 1',
    standarAkuntansi: 'SAK_EP',
    periodeLabel: 'Untuk periode 1 Januari 2026 s.d. 31 Desember 2026',
    kolom: ['Uraian', 'Jumlah'],
    baris: [['Pendapatan Jasa Pinjaman', 1_000_000]],
    kolomAngka: [1],
    ...tambahan,
  };
}

describe('RC-S100 §A — logo disisipkan ke kop PDF laporan tabel', () => {
  test('logo tampil sebagai gambar saat data URI tersedia', () => {
    const html = buildReportHtml(dataLaporan({ logoDataUri: LOGO_PNG_1X1 }));
    expect(html).toContain(`src="${LOGO_PNG_1X1}"`);
    expect(html).toContain('class="logo"');
    // Ada aturan gayanya, kalau tidak gambarnya bisa sebesar setengah halaman.
    expect(html).toMatch(/\.header \.logo \{[^}]*object-fit: contain/);
    // Identitas koperasi TETAP tampil di sebelah logo.
    expect(html).toContain('KSP Kenanga');
  });

  test('tanpa logo, kop dicetak seperti sebelumnya — tidak ada img kosong', () => {
    const html = buildReportHtml(dataLaporan());
    expect(html).not.toContain('<img');
    expect(html).toContain('KSP Kenanga');
    expect(html).toContain('Laporan Hasil Usaha');
  });

  test('logo tidak menggeser isi laporan: tabel & ringkasan tetap dirender', () => {
    const tanpa = buildReportHtml(dataLaporan());
    const dengan = buildReportHtml(dataLaporan({ logoDataUri: LOGO_PNG_1X1 }));
    for (const html of [tanpa, dengan]) {
      expect(html).toContain('Pendapatan Jasa Pinjaman');
      expect(html).toContain('<table class="data">');
    }
  });

  test('dokumen berseksi (mis. Detail Anggota) juga memuat logo di kopnya', () => {
    const html = buildDokumenSeksiHtml(
      dataLaporan({
        logoDataUri: LOGO_PNG_1X1,
        seksi: [{ jenis: 'KV', judul: 'Identitas', baris: [{ label: 'Nama', nilai: 'Budi' }] }],
      }),
      '1 Januari 2026 08.00'
    );
    expect(html).toContain(`src="${LOGO_PNG_1X1}"`);
    expect(html).toContain('class="kop-logo"');
    expect(html).toMatch(/\.kop \.kop-logo \{[^}]*object-fit: contain/);
  });

  test('dokumen berseksi tanpa logo tetap seperti sebelumnya', () => {
    const html = buildDokumenSeksiHtml(
      dataLaporan({ seksi: [{ jenis: 'KV', judul: 'Identitas', baris: [{ label: 'Nama', nilai: 'Budi' }] }] }),
      '1 Januari 2026 08.00'
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('KSP Kenanga');
  });
});

describe('RC-S100 §B — logo hanya untuk PDF, tidak merusak Excel/CSV', () => {
  test('exportLaporan menyisipkan logo HANYA pada jalur PDF', () => {
    const service = fs.readFileSync(path.join(process.cwd(), 'src/services/ExportService.ts'), 'utf8');
    // Pembacaan berkas terjadi di lapisan service (bukan builder), dan
    // hanya di cabang PDF.
    expect(service).toMatch(/if \(format === 'PDF'\)[\s\S]{0,400}?muatLogoSebagaiDataUri/);
    // Excel & CSV menerima `data` apa adanya — base64 di dalam sel akan
    // merusak datanya.
    expect(service).toMatch(/if \(format === 'EXCEL'\) return exportToExcel\(data\);/);
    expect(service).toMatch(/return exportToCsv\(data\);/);
  });

  test('builder laporan TETAP murni — tidak ada satu pun yang membaca berkas', () => {
    const builders = fs.readFileSync(path.join(process.cwd(), 'src/export/ReportTableBuilders.ts'), 'utf8');
    expect(builders).not.toContain('expo-file-system');
    expect(builders).not.toContain('LogoKoperasiService');
  });

  test('ExportButton meneruskan logo dari store, satu titik untuk semua laporan', () => {
    const tombol = fs.readFileSync(path.join(process.cwd(), 'src/components/ExportButton.tsx'), 'utf8');
    expect(tombol).toMatch(/s\.koperasi\?\.logoUri/);
    expect(tombol).toMatch(/exportLaporan\(currentUser\.id, data, format, logoUri\)/);
  });
});

describe('RC-S100 §C — berkas logo disalin ke penyimpanan permanen', () => {
  const service = fs.readFileSync(path.join(process.cwd(), 'src/services/LogoKoperasiService.ts'), 'utf8');
  const pembaca = fs.readFileSync(path.join(process.cwd(), 'src/export/LogoKopLaporan.ts'), 'utf8');

  test('pembaca logo TIDAK mengimpor expo-image-picker', () => {
    // Versi pertama perubahan ini menaruh pembaca logo di berkas yang sama
    // dengan pemilih galeri, lalu ExportService mengimpornya — akibatnya
    // ExportService.test.ts & AkadUlangRcS82.test.ts GAGAL DIMUAT karena
    // `expo-image-picker` adalah ESM murni. Selain memecahkan test, itu
    // juga ketergantungan yang salah tempat: lapisan export tidak punya
    // urusan dengan pemilih gambar.
    // Diperiksa PERNYATAAN IMPORT-nya, bukan sekadar teks: nama paketnya
    // memang disebut di docblock berkas itu untuk menjelaskan kenapa ia
    // dipisah — dan versi pertama test ini gagal justru karena mencocokkan
    // komentar tersebut, bukan kodenya.
    expect(pembaca).not.toMatch(/^import .*expo-image-picker/m);
    expect(pembaca).toMatch(/^import .*expo-file-system/m);
  });

  test('ExportService mengimpor pembaca logo, bukan service pemilih galeri', () => {
    const exportService = fs.readFileSync(path.join(process.cwd(), 'src/services/ExportService.ts'), 'utf8');
    expect(exportService).toContain("from '@/export/LogoKopLaporan'");
    expect(exportService).not.toContain('LogoKoperasiService');
  });

  test('gambar terpilih DISALIN, bukan dipakai langsung dari cache galeri', () => {
    // URI dari galeri berada di direktori cache yang boleh dibersihkan
    // sistem; menyimpannya ke database membuat logo hilang sendiri di
    // kemudian hari. Inilah kontrak yang dijaga.
    expect(service).toContain('FileSystem.copyAsync');
    expect(service).toMatch(/DIREKTORI_LOGO = `\$\{FileSystem\.documentDirectory\}branding\//);
    // documentDirectory = permanen; cacheDirectory TIDAK boleh menjadi tujuan.
    expect(service).not.toContain('cacheDirectory');
  });

  test('berkas lama hanya dihapus bila milik aplikasi sendiri', () => {
    // URI lama pada instalasi lama bisa menunjuk galeri pengguna (dulu
    // diketik manual) — itu bukan milik aplikasi dan tidak boleh dihapus.
    expect(service).toMatch(/startsWith\(DIREKTORI_LOGO\)/);
  });

  test('pembacaan logo untuk PDF tidak pernah melempar', () => {
    // Laporan wajib tetap bisa dicetak tanpa logo.
    expect(pembaca).toMatch(/muatLogoSebagaiDataUri[\s\S]{0,900}?return null;/);
    expect(pembaca).toMatch(/\} catch \{\s*return null;/);
  });

  test('ada batas ukuran berkas, dengan pesan yang bisa ditampilkan apa adanya', () => {
    expect(service).toContain('MAKS_UKURAN_LOGO_BYTE');
    expect(service).toContain('LogoTerlaluBesarError');
  });
});

describe('RC-S100 §D — logo tampil di Dashboard', () => {
  const dashboard = fs.readFileSync(
    path.join(process.cwd(), 'src/screens/Dashboard/DashboardScreen.tsx'),
    'utf8'
  );

  test('logo koperasi dirender bila ada', () => {
    expect(dashboard).toMatch(/koperasi\?\.logoUri \?/);
    expect(dashboard).toMatch(/source=\{\{ uri: koperasi\.logoUri \}\}/);
  });

  test('tanpa logo, kotak brand berikon yang sudah ada TETAP dipakai', () => {
    // Bukan ruang kosong: koperasi yang belum mengunggah logo tetap
    // melihat tampilan seperti sebelumnya.
    expect(dashboard).toMatch(/<Ionicons name="business"/);
  });
});

describe('RC-S100 §E — layar Identitas memakai pemilih berkas, bukan kotak teks URI', () => {
  const layar = fs.readFileSync(
    path.join(process.cwd(), 'src/screens/Pengaturan/IdentitasKoperasiScreen.tsx'),
    'utf8'
  );

  test('kolom teks URI logo sudah TIDAK ADA lagi', () => {
    // Inilah keluhan aslinya: mengetik URI tidak bisa dilakukan di ponsel.
    // Yang diperiksa adalah JSX-nya, BUKAN frasa "Logo (URI)" — frasa itu
    // masih muncul di komentar yang menjelaskan apa yang digantikan, dan
    // versi pertama test ini gagal justru karena mencocokkan komentar itu.
    expect(layar).not.toMatch(/<Field\s+label="Logo/);
    expect(layar).not.toMatch(/onChange=\{setLogoUri\}/);
  });

  test('ada tombol pilih logo, pratinjau gambar, dan tombol hapus', () => {
    expect(layar).toContain('pilihLogoDariGaleri');
    expect(layar).toContain('tombol-pilih-logo');
    expect(layar).toContain('tombol-hapus-logo');
    expect(layar).toMatch(/<Image\s+source=\{\{ uri: logoUri \}\}/);
  });

  test('berkas lama dibersihkan SETELAH penyimpanan berhasil, bukan sebelumnya', () => {
    // Kalau dibersihkan lebih dulu lalu penyimpanan gagal, koperasi
    // kehilangan logonya tanpa mendapat yang baru.
    const iSimpan = layar.indexOf('await updateIdentitasKoperasi(');
    const iHapus = layar.indexOf('await hapusBerkasLogoLama(');
    expect(iSimpan).toBeGreaterThan(-1);
    expect(iHapus).toBeGreaterThan(iSimpan);
  });
});

import {
  susunBagianArusKas,
  labelCadangan,
  URUTAN_BAGIAN,
  JUDUL_BAGIAN,
  LABEL_JUMLAH_BAGIAN,
  NOMOR_BAGIAN,
  NAMA_BARIS,
  CATATAN_PENYAJIAN,
  type MutasiKasUntukSusunan,
} from '@/reports/ArusKasJuklat';
import { CASH_FLOW_CLASSIFICATION, classifyTransaction } from '@/accounting/CashFlowClassification';

/**
 * RC-S104 — LAPORAN ARUS KAS MENURUT JUKLAT SOM No. 3/2025.
 *
 * Yang dikunci di sini: urutan bagian & peristilahan sesuai contoh
 * naskah, penempatan simpanan yang diubah beserta alasannya, dan
 * jaminan bahwa reklasifikasi TIDAK pernah menggeser saldo kas.
 */

const m = (aktivitas: 'OPERASI' | 'INVESTASI' | 'PENDANAAN', sumberTransaksi: string, jumlah: number): MutasiKasUntukSusunan => ({
  aktivitas,
  sumberTransaksi,
  jumlah,
});

// ===========================================================================
// A. URUTAN & PERISTILAHAN SESUAI NASKAH
// ===========================================================================

describe('RC-S104 §A — urutan bagian & peristilahan mengikuti contoh naskah', () => {
  test('tiga bagian, urut Operasi -> Investasi -> Pendanaan', () => {
    expect(URUTAN_BAGIAN).toEqual(['OPERASI', 'INVESTASI', 'PENDANAAN']);
  });

  test('judul & nomor bagian sesuai contoh', () => {
    expect(JUDUL_BAGIAN.OPERASI).toBe('Kegiatan Operasi');
    expect(JUDUL_BAGIAN.INVESTASI).toBe('Kegiatan Investasi');
    expect(JUDUL_BAGIAN.PENDANAAN).toBe('Kegiatan Pendanaan');
    expect([NOMOR_BAGIAN.OPERASI, NOMOR_BAGIAN.INVESTASI, NOMOR_BAGIAN.PENDANAAN]).toEqual(['I', 'II', 'III']);
  });

  test('label jumlah tiap bagian memakai kalimat naskah, bukan istilah bebas', () => {
    expect(LABEL_JUMLAH_BAGIAN.OPERASI).toBe('Jumlah arus kas operasi');
    expect(LABEL_JUMLAH_BAGIAN.INVESTASI).toBe('Jumlah arus kas investasi');
    expect(LABEL_JUMLAH_BAGIAN.PENDANAAN).toBe('Jumlah arus kas pendanaan');
  });

  test('susunan selalu mengembalikan ketiga bagian walau salah satunya kosong', () => {
    const hasil = susunBagianArusKas([m('OPERASI', 'ANGSURAN_JASA', 1_000)]);
    expect(hasil.map((h) => h.bagian)).toEqual(['OPERASI', 'INVESTASI', 'PENDANAAN']);
    expect(hasil[1].baris).toEqual([]);
    expect(hasil[1].jumlah).toBe(0);
  });
});

// ===========================================================================
// B. PENGELOMPOKAN BARIS
// ===========================================================================

describe('RC-S104 §B — baris dikelompokkan per jenis transaksi, bukan per jurnal', () => {
  test('beberapa jurnal dengan jenis yang sama menjadi SATU baris neto', () => {
    const hasil = susunBagianArusKas([
      m('OPERASI', 'ANGSURAN_POKOK', 500_000),
      m('OPERASI', 'ANGSURAN_POKOK', 300_000),
      m('OPERASI', 'ANGSURAN_POKOK', -100_000),
    ]);
    const operasi = hasil[0];
    expect(operasi.baris).toHaveLength(1);
    expect(operasi.baris[0].label).toBe('Penerimaan pokok pinjaman dari anggota');
    expect(operasi.baris[0].jumlah).toBe(700_000);
  });

  test('penyaluran dan penerimaan pinjaman TETAP baris terpisah, seperti contoh naskah', () => {
    const hasil = susunBagianArusKas([
      m('OPERASI', 'PENCAIRAN_PINJAMAN', -10_000_000),
      m('OPERASI', 'ANGSURAN_POKOK', 4_000_000),
    ]);
    const label = hasil[0].baris.map((b) => b.label);
    expect(label).toContain('Penyaluran pinjaman kepada anggota');
    expect(label).toContain('Penerimaan pokok pinjaman dari anggota');
    // Urutannya: penyaluran lebih dulu, sama dengan contoh naskah.
    expect(label.indexOf('Penyaluran pinjaman kepada anggota')).toBeLessThan(
      label.indexOf('Penerimaan pokok pinjaman dari anggota')
    );
  });

  test('baris bernilai nol dibuang — contoh naskah tidak memuat baris nol', () => {
    const hasil = susunBagianArusKas([
      m('OPERASI', 'ANGSURAN_POKOK', 500_000),
      m('OPERASI', 'ANGSURAN_POKOK', -500_000),
      m('OPERASI', 'ANGSURAN_JASA', 25_000),
    ]);
    expect(hasil[0].baris.map((b) => b.label)).toEqual(['Penerimaan jasa pinjaman dari anggota']);
  });

  test('jumlah bagian SELALU sama dengan penjumlahan baris yang ditampilkan', () => {
    const mutasi = [
      m('OPERASI', 'PENCAIRAN_PINJAMAN', -10_000_000),
      m('OPERASI', 'ANGSURAN_POKOK', 4_000_000),
      m('OPERASI', 'ANGSURAN_JASA', 250_000),
      m('OPERASI', 'KAS_PENGELUARAN_LAIN', -1_250_000),
    ];
    const bagian = susunBagianArusKas(mutasi)[0];
    expect(bagian.jumlah).toBe(bagian.baris.reduce((t, b) => t + b.jumlah, 0));
    expect(bagian.jumlah).toBe(-7_000_000);
  });

  test('jenis transaksi yang belum dinamai TIDAK dibuang, tampil dengan nama cadangan', () => {
    const hasil = susunBagianArusKas([m('OPERASI', 'JENIS_BARU_BELUM_DINAMAI', 42_000)]);
    expect(hasil[0].baris).toHaveLength(1);
    expect(hasil[0].jumlah).toBe(42_000);
    expect(hasil[0].baris[0].label).toBe('Jenis baru belum dinamai');
  });

  test('labelCadangan tidak pernah mengembalikan string kosong', () => {
    expect(labelCadangan('')).toBe('Mutasi kas lainnya');
    expect(labelCadangan('   ')).toBe('Mutasi kas lainnya');
  });
});

// ===========================================================================
// C. PENEMPATAN POS — KEPUTUSAN YANG DIAMBIL & ALASANNYA
// ===========================================================================

describe('RC-S104 §C — penempatan simpanan & utang', () => {
  test('simpanan sukarela & berjangka pada KEGIATAN OPERASI (definisi 5.7(4)(d) + contoh naskah)', () => {
    expect(classifyTransaction('SIMPANAN_SUKARELA')).toBe('OPERASI');
    expect(classifyTransaction('SIMPANAN_BERJANGKA')).toBe('OPERASI');
    expect(classifyTransaction('SIMPANAN_BERJANGKA_PENCAIRAN')).toBe('OPERASI');
    expect(classifyTransaction('SIMPANAN_BERJANGKA_PENCAIRAN_DINI')).toBe('OPERASI');
  });

  test('simpanan pokok & wajib TETAP pada KEGIATAN PENDANAAN — itu modal anggota', () => {
    expect(classifyTransaction('SIMPANAN_POKOK')).toBe('PENDANAAN');
    expect(classifyTransaction('SIMPANAN_WAJIB')).toBe('PENDANAAN');
  });

  test('utang bank & pihak lain TETAP PENDANAAN mengikuti definisi 5.7(4)(f), bukan contohnya', () => {
    expect(classifyTransaction('UTANG_BANK')).toBe('PENDANAAN');
    expect(classifyTransaction('UTANG_PIHAK_LAIN')).toBe('PENDANAAN');
  });

  test('perbedaan dari contoh naskah DINYATAKAN di catatan penyajian, tidak didiamkan', () => {
    const teks = CATATAN_PENYAJIAN.join(' ');
    expect(teks).toMatch(/simpanan sukarela dan simpanan berjangka disajikan pada kegiatan operasi/i);
    expect(teks).toMatch(/utang bank dan utang kepada pihak lain disajikan pada kegiatan pendanaan/i);
    expect(teks).toMatch(/5\.7\(4\)\(f\)/);
    // Ketidakkonsistenan butir (3) juga disebut, bukan ditiru.
    expect(teks).toMatch(/5\.7\(3\)/);
  });
});

// ===========================================================================
// D. PENJAGA: REKLASIFIKASI TIDAK MENGGESER KAS
// ===========================================================================

describe('RC-S104 §D — reklasifikasi hanya memindah kolom, tidak mengubah kas', () => {
  test('jumlah ketiga bagian sama dengan jumlah seluruh mutasi, apa pun klasifikasinya', () => {
    const mutasi: MutasiKasUntukSusunan[] = [
      m('OPERASI', 'SIMPANAN_SUKARELA', 5_000_000),
      m('OPERASI', 'SIMPANAN_BERJANGKA', 10_000_000),
      m('OPERASI', 'PENCAIRAN_PINJAMAN', -12_000_000),
      m('INVESTASI', 'ASET_TETAP', -3_000_000),
      m('PENDANAAN', 'SIMPANAN_POKOK', 1_000_000),
      m('PENDANAAN', 'UTANG_BANK', 2_000_000),
    ];
    const total = susunBagianArusKas(mutasi).reduce((t, b) => t + b.jumlah, 0);
    expect(total).toBe(mutasi.reduce((t, x) => t + x.jumlah, 0));
    expect(total).toBe(3_000_000);
  });

  test('setiap jenis yang dinamai punya klasifikasi, dan setiap jenis kas punya nama baris', () => {
    // Nama baris tanpa klasifikasi = baris yang tidak akan pernah muncul.
    for (const sumber of Object.keys(NAMA_BARIS)) {
      expect(CASH_FLOW_CLASSIFICATION[sumber]).toBeDefined();
    }
    // Jenis yang MEMANG menyentuh kas wajib punya nama baris, supaya
    // tidak ada mutasi kas yang tampil dengan nama cadangan di laporan
    // resmi.
    for (const [sumber, klas] of Object.entries(CASH_FLOW_CLASSIFICATION)) {
      if (klas === 'NON_KAS') continue;
      expect(NAMA_BARIS[sumber]).toBeDefined();
    }
  });
});

// ===========================================================================
// E. PENJAGA STRUKTURAL
// ===========================================================================

describe('RC-S104 §E — penjaga struktural', () => {
  const baca = (rel: string) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('fs') as typeof import('fs')).readFileSync(
      (require('path') as typeof import('path')).join(process.cwd(), rel),
      'utf8'
    );

  test('layar Arus Kas TIDAK menghitung sendiri — memakai modul murni', () => {
    const src = baca('src/screens/Laporan/ArusKasScreen.tsx');
    expect(src).toMatch(/^import \{[\s\S]*?susunBagianArusKas/m);
    // Tidak ada penjumlahan aktivitas yang dikerjakan ulang di layar.
    const kode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(kode).not.toMatch(/data\.operasi\s*\+\s*data\.investasi/);
  });

  test('layar memakai komponen laporan bersama, bukan gaya sendiri', () => {
    const src = baca('src/screens/Laporan/ArusKasScreen.tsx');
    expect(src).toMatch(/^import ReportSectionCard from '@\/components\/report\/ReportSectionCard'/m);
    expect(src).toMatch(/^import ReportRow from '@\/components\/report\/ReportRow'/m);
  });

  test('export memakai penyusun baris yang SAMA dengan LHU, bukan tabel datar lagi', () => {
    const src = baca('src/export/ReportTableBuilders.ts');
    const fn = src.slice(src.indexOf('export function buildArusKasExport'));
    const badan = fn.slice(0, fn.indexOf('\n}\n'));
    expect(badan).toMatch(/new PenyusunBarisLhu\(1\)/);
    expect(badan).toMatch(/susunBagianArusKas\(data\.rincian\)/);
    expect(badan).toMatch(/catatanKaki/);
    // Baris datar lama sudah tidak ada.
    expect(badan).not.toMatch(/'Kas Awal Periode'/);
  });

  test('catatan kaki ikut tercetak di PDF dan di Excel/CSV, bukan hanya di layar', () => {
    expect(baca('src/export/HtmlReportBuilder.ts')).toMatch(/data\.catatanKaki/);
    // DIPERBARUI (Excel profesional): catatan kaki Excel kini disusun modul
    // tata letak murni; ExportService memakainya untuk setiap export Excel.
    expect(baca('src/export/ExcelLaporanBuilder.ts')).toMatch(/data\.catatanKaki/);
    expect(baca('src/services/ExportService.ts')).toMatch(/bangunSheetLaporan\(data, /);
  });

  test('getArusKas membawa sumberTransaksi pada rincian', () => {
    const src = baca('src/reports/FinancialReports.ts');
    expect(src).toMatch(/rincian\.push\(\{[^)]*sumberTransaksi: e\.sumber_transaksi/);
  });
});

import * as fs from 'fs';
import * as path from 'path';
import {
  CASH_FLOW_CLASSIFICATION,
  classifyTransaction,
  classifyTransactionSource,
  classifyByAccountKategori,
  daftarSumberTransaksiTerklasifikasi,
  UnknownCashFlowClassificationError,
  NonCashSourceOnCashLineError,
} from '@/accounting/CashFlowClassification';

/**
 * GAP-CASHFLOW — KONTRAK KLASIFIKASI ARUS KAS.
 *
 * Test paling penting di berkas ini adalah yang PERTAMA: ia memindai
 * source produksi untuk menemukan SETIAP nilai `sumberTransaksi` yang
 * benar-benar dipakai, lalu memastikan semuanya punya klasifikasi.
 *
 * WHY dipindai, bukan didaftar manual: daftar manual akan basi begitu
 * seseorang menambah jenis transaksi baru — dan justru itulah cara bug
 * ini lahir pertama kali. Enam sumber produksi (AKRUAL_JASA_PINJAMAN,
 * EIR_FEE_AMORTIZATION, IMPAIRMENT_INVESTASI,
 * PEMBERIAN_PINJAMAN_KOPERASI, SIMPANAN_DATA_AWAL, UTANG_IMBALAN_KERJA)
 * tidak pernah terdaftar dan semuanya jatuh diam-diam ke 'OPERASI'.
 */

const AKAR_SRC = path.resolve(__dirname, '..');

function kumpulkanFileTs(dir: string, hasil: string[] = []): string[] {
  for (const nama of fs.readdirSync(dir)) {
    const penuh = path.join(dir, nama);
    const stat = fs.statSync(penuh);
    if (stat.isDirectory()) {
      // Test dikecualikan: fixture boleh memakai nilai apa pun; yang
      // dijamin di sini adalah jenis transaksi yang BENAR-BENAR ditulis
      // aplikasi ke database produksi.
      if (nama === '__tests__' || nama === 'test-utils' || nama === 'node_modules') continue;
      kumpulkanFileTs(penuh, hasil);
    } else if (/\.tsx?$/.test(nama)) {
      hasil.push(penuh);
    }
  }
  return hasil;
}

function sumberTransaksiProduksi(): string[] {
  const ditemukan = new Set<string>();
  for (const berkas of kumpulkanFileTs(AKAR_SRC)) {
    const isi = fs.readFileSync(berkas, 'utf8');
    for (const m of isi.matchAll(/sumberTransaksi:\s*'([A-Z_]+)'/g)) {
      ditemukan.add(m[1]);
    }
  }
  return [...ditemukan].sort();
}

describe('GAP-CASHFLOW — setiap sumber transaksi produksi punya klasifikasi', () => {
  test('tidak ada sumber transaksi produksi yang belum terklasifikasi', () => {
    const dipakai = sumberTransaksiProduksi();
    expect(dipakai.length).toBeGreaterThan(20); // pemindaian benar-benar menemukan sesuatu

    const belumTerpetakan = dipakai.filter((s) => !CASH_FLOW_CLASSIFICATION[s]);
    expect(belumTerpetakan).toEqual([]);
  });

  test('enam sumber yang dulu jatuh diam-diam ke OPERASI kini terklasifikasi eksplisit', () => {
    expect(classifyTransactionSource('PEMBERIAN_PINJAMAN_KOPERASI')).toBe('INVESTASI');
    expect(classifyTransactionSource('SIMPANAN_DATA_AWAL')).toBe('PENDANAAN');
    expect(classifyTransactionSource('AKRUAL_JASA_PINJAMAN')).toBe('NON_KAS');
    expect(classifyTransactionSource('EIR_FEE_AMORTIZATION')).toBe('NON_KAS');
    expect(classifyTransactionSource('IMPAIRMENT_INVESTASI')).toBe('NON_KAS');
    expect(classifyTransactionSource('UTANG_IMBALAN_KERJA')).toBe('NON_KAS');
  });

  test('setiap nilai pada peta hanya boleh salah satu dari empat kategori sah', () => {
    const sah = ['OPERASI', 'INVESTASI', 'PENDANAAN', 'NON_KAS'];
    for (const [sumber, kategori] of Object.entries(CASH_FLOW_CLASSIFICATION)) {
      expect(sah).toContain(kategori);
      expect(sumber).toMatch(/^[A-Z_]+$/);
    }
  });
});

describe('GAP-CASHFLOW — fallback diam-diam ke OPERASI sudah dihapus', () => {
  test('sumber tidak dikenal MELEMPAR, bukan dianggap OPERASI', () => {
    expect(() => classifyTransaction('SUMBER_YANG_TIDAK_PERNAH_ADA')).toThrow(
      UnknownCashFlowClassificationError
    );
    expect(() => classifyTransactionSource('SUMBER_YANG_TIDAK_PERNAH_ADA')).toThrow(
      UnknownCashFlowClassificationError
    );
  });

  test('pesan errornya menyebut nama sumbernya supaya bisa langsung diperbaiki', () => {
    expect(() => classifyTransaction('SUMBER_ANEH')).toThrow(/SUMBER_ANEH/);
  });

  test('sumber NON_KAS yang muncul di baris kas MELEMPAR (kontradiksi data)', () => {
    // Kalau ini terjadi, entah klasifikasinya salah atau jurnalnya salah.
    // Keduanya perlu diperiksa manusia — bukan ditebak laporan.
    expect(() => classifyTransaction('PENYUSUTAN_ASET')).toThrow(NonCashSourceOnCashLineError);
    expect(() => classifyTransaction('AKRUAL_JASA_PINJAMAN')).toThrow(NonCashSourceOnCashLineError);
  });

  test('fallbackKategori tetap boleh dipakai — itu aturan eksplisit, bukan tebakan', () => {
    expect(classifyTransaction('SUMBER_BARU_BELUM_DIPETAKAN', 'PENDAPATAN')).toBe('OPERASI');
    expect(classifyTransaction('SUMBER_BARU_BELUM_DIPETAKAN', 'EKUITAS')).toBe('PENDANAAN');
    expect(classifyTransaction('SUMBER_BARU_BELUM_DIPETAKAN', 'ASET')).toBe('INVESTASI');
  });

  test('classifyByAccountKategori tetap konsisten dengan dokumentasinya', () => {
    expect(classifyByAccountKategori('PENDAPATAN')).toBe('OPERASI');
    expect(classifyByAccountKategori('BEBAN')).toBe('OPERASI');
    expect(classifyByAccountKategori('LIABILITAS')).toBe('PENDANAAN');
    expect(classifyByAccountKategori('EKUITAS')).toBe('PENDANAAN');
    expect(classifyByAccountKategori('ASET')).toBe('INVESTASI');
  });
});

describe('GAP-CASHFLOW — klasifikasi yang secara ekonomi wajib benar', () => {
  test('pemberian pinjaman ke koperasi lain BUKAN operasi (arus kas keluar sungguhan)', () => {
    // Ini yang paling berbahaya dari bug lama: Dr Piutang / Cr Kas —
    // kas benar-benar keluar, tetapi masuk kolom OPERASI.
    expect(classifyTransactionSource('PEMBERIAN_PINJAMAN_KOPERASI')).not.toBe('OPERASI');
    expect(classifyTransactionSource('PEMBERIAN_PINJAMAN_KOPERASI')).toBe(
      classifyTransactionSource('INVESTASI_KOPERASI_LAIN')
    );
  });

  test('perolehan aset tetap & tak berwujud = INVESTASI', () => {
    expect(classifyTransactionSource('ASET_TETAP')).toBe('INVESTASI');
    expect(classifyTransactionSource('ASET_TAK_BERWUJUD')).toBe('INVESTASI');
  });

  /**
   * DIPERBARUI RC-S104 — test ini dulu menuntut SELURUH jenis simpanan
   * masuk PENDANAAN. Tuntutan itu terlalu luas: simpanan pokok & wajib
   * adalah MODAL anggota, sedangkan simpanan sukarela & berjangka
   * adalah dana yang diputar koperasi menjadi pinjaman — yaitu
   * "aktivitas penghasil utama pendapatan" pada definisi butir
   * 5.7(4)(d) Juklat SOM No. 3/2025, dan contoh resmi pada naskah yang
   * sama juga menempatkannya di KEGIATAN OPERASI.
   *
   * Yang TIDAK ikut berubah: utang koperasi. Contoh naskah menaruhnya
   * di operasi, tetapi butir 5.7(4)(f) mendefinisikan pendanaan sebagai
   * perubahan "modal dan PINJAMAN perusahaan" — definisi dipakai,
   * contohnya tidak. Lihat ArusKasJuklat.CATATAN_PENYAJIAN.
   */
  test('modal anggota & utang koperasi = PENDANAAN', () => {
    for (const s of ['SIMPANAN_POKOK', 'SIMPANAN_WAJIB', 'SIMPANAN_DATA_AWAL',
                     'UTANG_BANK', 'UTANG_PIHAK_LAIN', 'UTANG_USAHA', 'MODAL_UANG', 'KELUAR_ANGGOTA']) {
      expect(classifyTransactionSource(s)).toBe('PENDANAAN');
    }
  });

  test('simpanan sukarela & berjangka = OPERASI (dana yang diputar jadi pinjaman)', () => {
    for (const s of ['SIMPANAN_SUKARELA', 'SIMPANAN_BERJANGKA',
                     'SIMPANAN_BERJANGKA_PENCAIRAN', 'SIMPANAN_BERJANGKA_PENCAIRAN_DINI']) {
      expect(classifyTransactionSource(s)).toBe('OPERASI');
    }
  });

  test('pinjaman anggota (usaha inti koperasi simpan pinjam) = OPERASI', () => {
    for (const s of ['PENCAIRAN_PINJAMAN', 'ANGSURAN_POKOK', 'ANGSURAN_JASA', 'ANGSURAN_DENDA']) {
      expect(classifyTransactionSource(s)).toBe('OPERASI');
    }
  });

  test('estimasi akuntansi & akrual = NON_KAS, bukan OPERASI', () => {
    for (const s of ['PENYUSUTAN_ASET', 'PENYISIHAN_PIUTANG', 'PENGHAPUSAN_PIUTANG',
                     'AMORTISASI_ASET_TAK_BERWUJUD', 'UTANG_BUNGA', 'UTANG_IMBALAN_KERJA',
                     'IMPAIRMENT_INVESTASI', 'AKRUAL_JASA_PINJAMAN', 'EIR_FEE_AMORTIZATION']) {
      expect(classifyTransactionSource(s)).toBe('NON_KAS');
    }
  });

  test('daftar terklasifikasi terurut dan tidak kosong (dipakai layar diagnostik)', () => {
    const daftar = daftarSumberTransaksiTerklasifikasi();
    expect(daftar.length).toBe(Object.keys(CASH_FLOW_CLASSIFICATION).length);
    expect([...daftar].sort()).toEqual(daftar);
  });
});

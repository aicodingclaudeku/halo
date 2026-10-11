import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CONTOH_KASUS,
  DAFTAR_PERIKSA,
  PANDUAN_IMPORT,
  adaBlokir,
  hariSebelumIso,
  kodeAkunBawaan,
  kolomIlustrasi,
  periksaSebelumImport,
  ribuan,
  tanggalPanjang,
} from '@/import/PanduanImportData';
import { SHEET_SALDO_AWAL_AKUN, SHEET_TEMPLATE, SHEET_TEMPLATE_TRANSAKSI_BARU, judulKolomExcel } from '@/import/TemplateDataAwal';
import { parseBerkasDataAwal, JUDUL_SHEET_SALDO_AWAL_AKUN } from '@/import/ExcelDataAwalParser';
import { DEFAULT_ACCOUNTS } from '@/config/defaultCOA';

/**
 * RC-S133.4.7 — panduan import (slide) & pemeriksaan sebelum import.
 */

/** Berkas template APA ADANYA (baris contoh belum dihapus). */
function berkasTemplateMentah() {
  const aoa = (sh: { keterangan: string; kolom: { contoh: string | number }[] } & { kolom: any[] }) => [
    [sh.keterangan],
    [],
    sh.kolom.map(judulKolomExcel),
    sh.kolom.map((k) => k.contoh),
  ];
  const by = (j: string) => aoa(SHEET_TEMPLATE.find((s) => s.jenis === j)! as any);
  return {
    ANGGOTA: by('ANGGOTA'),
    SIMPANAN: by('SIMPANAN'),
    PINJAMAN: by('PINJAMAN'),
    BERJANGKA: by('BERJANGKA'),
    ASET: by('ASET'),
    JASA: by('JASA'),
  };
}

const H_ANGGOTA = ['Kode Anggota', 'Nama Lengkap', 'Tanggal Bergabung'];
const H_SIMPANAN = ['Kode Anggota', 'Tanggal', 'Simpanan Pokok', 'Simpanan Wajib', 'Simpanan Sukarela'];
const H_PINJAMAN = ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Angsuran Sudah Dibayar', 'Sisa Pokok', 'Angsuran Tersisa'];

describe('PANDUAN_IMPORT — isi slide', () => {
  test('kedua template punya slide, kunci unik per template', () => {
    for (const jenis of ['SALDO_LAMA', 'TRANSAKSI_BARU'] as const) {
      const s = PANDUAN_IMPORT[jenis];
      expect(s.length).toBeGreaterThanOrEqual(8);
      expect(new Set(s.map((x) => x.kunci)).size).toBe(s.length);
      for (const x of s) {
        expect(x.judul.length).toBeGreaterThan(5);
        expect(x.isi.length).toBeGreaterThan(20);
      }
    }
  });

  test('setiap kolom pada ilustrasi Excel benar-benar ada di template (tidak boleh beda arah)', () => {
    const semua = [...SHEET_TEMPLATE, ...SHEET_TEMPLATE_TRANSAKSI_BARU, SHEET_SALDO_AWAL_AKUN as any];
    for (const jenis of ['SALDO_LAMA', 'TRANSAKSI_BARU'] as const) {
      for (const { sheet, kolom } of kolomIlustrasi(PANDUAN_IMPORT[jenis])) {
        const sh = semua.find((x: any) => x.nama === sheet);
        expect(sh).toBeDefined();
        expect(sh.kolom.map((k: any) => k.label)).toContain(kolom);
      }
    }
  });

  test('template Transaksi Baru tidak memakai kolom yang tidak ada di template-nya', () => {
    for (const { sheet, kolom } of kolomIlustrasi(PANDUAN_IMPORT.TRANSAKSI_BARU)) {
      const sh = SHEET_TEMPLATE_TRANSAKSI_BARU.find((x) => x.nama === sheet)!;
      expect(sh).toBeDefined();
      expect(sh.kolom.map((k) => k.label)).toContain(kolom);
    }
  });

  test('neraca contoh SEIMBANG dan kas = kredit - debit lain', () => {
    const slide = PANDUAN_IMPORT.SALDO_LAMA.find((s) => s.ilustrasi.jenis === 'NERACA')!;
    const il = slide.ilustrasi as Extract<typeof slide.ilustrasi, { jenis: 'NERACA' }>;
    const d = il.debit.reduce((t, b) => t + b.nilai, 0);
    const k = il.kredit.reduce((t, b) => t + b.nilai, 0);
    expect(d).toBe(k);
    expect(d).toBe(20221000);
    expect(CONTOH_KASUS.kas).toBe(k - (d - CONTOH_KASUS.kas));
  });

  test('kode akun pada panduan diambil dari COA bawaan, bukan diketik', () => {
    expect(kodeAkunBawaan('Kas')).toBe(DEFAULT_ACCOUNTS.find((a) => a.nama === 'Kas')!.kode);
    const slide = PANDUAN_IMPORT.SALDO_LAMA.find((s) => s.kunci === 'seimbang')!;
    const il = slide.ilustrasi as any;
    for (const b of [...il.debit, ...il.kredit]) expect(b.akun.startsWith('?')).toBe(false);
  });

  test('angka contoh pinjaman & jasa konsisten dengan aturan hitung (flat & menurun)', () => {
    // A001: 12.000.000 / 12 x, 5 kali bayar -> sisa 7.000.000; jasa flat 1% x 5
    expect(12000000 - 5 * (12000000 / 12)).toBe(7000000);
    expect(12000000 * 0.01 * 5).toBe(600000);
    // A002: 6.000.000 / 10 x menurun 1,5%, 2 kali bayar
    expect(6000000 - 2 * 600000).toBe(4800000);
    expect(Math.round(6000000 * 0.015) + Math.round(5400000 * 0.015)).toBe(171000);
    expect(CONTOH_KASUS.piutang).toBe(11800000);
    expect(CONTOH_KASUS.jasa).toBe(771000);
  });

  test('daftar periksa tersedia untuk kedua template', () => {
    expect(DAFTAR_PERIKSA.SALDO_LAMA.length).toBeGreaterThanOrEqual(4);
    expect(DAFTAR_PERIKSA.TRANSAKSI_BARU.length).toBeGreaterThanOrEqual(4);
  });

  test('utilitas tanggal & angka', () => {
    expect(ribuan(20221000)).toBe('20.221.000');
    expect(ribuan(0)).toBe('0');
    expect(hariSebelumIso('2026-07-01')).toBe('2026-06-30');
    expect(hariSebelumIso('2026-03-01')).toBe('2026-02-28');
    expect(hariSebelumIso('2024-03-01')).toBe('2024-02-29');
    expect(tanggalPanjang('2026-07-01')).toBe('1 Juli 2026');
  });
});

describe('periksaSebelumImport — baris CONTOH', () => {
  test('template apa adanya: BLOKIR dan menyebut setiap sheet yang masih punya baris contoh', () => {
    const r = parseBerkasDataAwal(berkasTemplateMentah() as any);
    // Parser memang meloloskan baris contoh (dijaga test lain) — justru karena itu pemeriksaan ini perlu.
    expect(r.siapDiimpor).toBe(true);
    const p = periksaSebelumImport(r, { sifat: 'SALDO_AWAL', cutOff: '2026-12-31' });
    expect(adaBlokir(p)).toBe(true);
    const c = p.find((x) => x.kunci === 'contoh')!;
    for (const sh of ['1. Anggota', '2. Simpanan', '3. Pinjaman', '4. Simpanan Berjangka', '5. Aset Tetap', '6. Jasa Dibayar']) {
      expect(c.pesan).toContain(sh);
    }
  });

  test('berkas bersih: tidak ada BLOKIR', () => {
    const r = parseBerkasDataAwal({
      ANGGOTA: [H_ANGGOTA, ['A001', 'Siti', '2024-01-05']],
      SIMPANAN: [H_SIMPANAN, ['A001', '2026-06-30', 100000, 0, 0]],
    } as any);
    const p = periksaSebelumImport(r, { sifat: 'SALDO_AWAL', cutOff: '2026-07-01' });
    expect(adaBlokir(p)).toBe(false);
  });
});

describe('periksaSebelumImport — sheet dengan judul kolom yang tidak dikenali', () => {
  test('sheet ada tetapi kolom wajib diganti nama -> BLOKIR (bukan terlewat diam-diam)', () => {
    const r = parseBerkasDataAwal({
      ANGGOTA: [H_ANGGOTA, ['A001', 'Siti', '2024-01-05']],
      PINJAMAN: [['Kode Anggota', 'Tgl Cair', 'Pokok Awal'], ['A001', '2026-01-10', 12000000]],
    } as any);
    // Parser sendiri tidak menghitungnya sebagai galat.
    expect(r.totalGalat).toBe(0);
    const p = periksaSebelumImport(r, { sifat: 'SALDO_AWAL', cutOff: '2026-07-01' });
    const b = p.find((x) => x.kunci === 'judul-kolom')!;
    expect(b.tingkat).toBe('BLOKIR');
    expect(b.pesan).toContain('3. Pinjaman');
  });

  test('sheet yang memang tidak ada di berkas TIDAK diblokir', () => {
    const r = parseBerkasDataAwal({ ANGGOTA: [H_ANGGOTA, ['A001', 'Siti', '2024-01-05']] } as any);
    expect(periksaSebelumImport(r, { sifat: 'SALDO_AWAL', cutOff: '2026-07-01' }).some((x) => x.kunci === 'judul-kolom')).toBe(false);
  });
});

describe('periksaSebelumImport — salah pilih jenis', () => {
  test('sheet 7 atau sheet 6 terisi pada "Transaksi baru" -> BLOKIR', () => {
    const r = parseBerkasDataAwal({
      ANGGOTA: [H_ANGGOTA, ['A001', 'Siti', '2024-01-05']],
      SALDO_AWAL_AKUN: [['Kode Akun', 'Nama Akun', 'Saldo'], ['1-1000', 'Kas', 5000000]],
    } as any);
    const p = periksaSebelumImport(r, { sifat: 'TRANSAKSI_BARU' });
    expect(p.find((x) => x.kunci === 'salah-template')!.tingkat).toBe('BLOKIR');
    expect(p.find((x) => x.kunci === 'salah-template')!.pesan).toContain(JUDUL_SHEET_SALDO_AWAL_AKUN);
    // Pilihan "Saldo lama" -> tidak diblokir
    expect(adaBlokir(periksaSebelumImport(r, { sifat: 'SALDO_AWAL', cutOff: '2026-07-01' }))).toBe(false);
  });

  test('kolom migrasi pinjaman pada "Transaksi baru" -> PERINGATAN', () => {
    const r = parseBerkasDataAwal({
      ANGGOTA: [H_ANGGOTA, ['A001', 'Siti', '2024-01-05']],
      PINJAMAN: [H_PINJAMAN, ['A001', '2026-01-10', 12000000, 12, 5, 7000000, 7]],
    } as any);
    const p = periksaSebelumImport(r, { sifat: 'TRANSAKSI_BARU' });
    expect(p.find((x) => x.kunci === 'kolom-migrasi')!.tingkat).toBe('PERINGATAN');
    expect(adaBlokir(p)).toBe(false);
  });
});

describe('periksaSebelumImport — Saldo lama', () => {
  test('baris pada/setelah cut-off diberi PERINGATAN dengan nomor baris & tanggal paling lambat', () => {
    const r = parseBerkasDataAwal({
      ANGGOTA: [H_ANGGOTA, ['A001', 'Siti', '2024-01-05']],
      SIMPANAN: [H_SIMPANAN, ['A001', '2026-07-01', 100000, 0, 0]],
      PINJAMAN: [H_PINJAMAN, ['A001', '2026-06-30', 1000000, 10, 0, null, null]],
    } as any);
    const p = periksaSebelumImport(r, { sifat: 'SALDO_AWAL', cutOff: '2026-07-01' });
    const w = p.find((x) => x.kunci === 'setelah-cutoff')!;
    expect(w.tingkat).toBe('PERINGATAN');
    expect(w.pesan).toContain('2. Simpanan baris 2');
    expect(w.pesan).not.toContain('3. Pinjaman');
    expect(w.pesan).toContain('30 Juni 2026');
  });

  test('beberapa baris saldo simpanan satu anggota -> PERINGATAN dijumlahkan', () => {
    const r = parseBerkasDataAwal({
      ANGGOTA: [H_ANGGOTA, ['A001', 'Siti', '2024-01-05']],
      SIMPANAN: [H_SIMPANAN, ['A001', '2026-01-05', 100000, 50000, 0], ['a001', '2026-02-05', 0, 50000, 0]],
    } as any);
    const p = periksaSebelumImport(r, { sifat: 'SALDO_AWAL', cutOff: '2026-07-01' });
    expect(p.find((x) => x.kunci === 'simpanan-ganda')!.pesan).toContain('A001: baris 2, 3');
  });

  test('total sheet 6 berbeda dari Pendapatan Jasa Pinjaman sheet 7 -> PERINGATAN; sama -> tidak', () => {
    const kode = kodeAkunBawaan('Pendapatan Jasa Pinjaman');
    const dasar = (saldo: number) =>
      parseBerkasDataAwal({
        ANGGOTA: [H_ANGGOTA, ['A001', 'Siti', '2024-01-05'], ['A002', 'Budi', '2025-03-10']],
        JASA: [['Kode Anggota', 'Jasa Pinjaman Dibayar'], ['A001', 600000], ['A002', 171000]],
        SALDO_AWAL_AKUN: [['Kode Akun', 'Saldo'], [kode, saldo]],
      } as any);
    expect(periksaSebelumImport(dasar(700000), { sifat: 'SALDO_AWAL', cutOff: '2026-07-01' }).some((x) => x.kunci === 'jasa-beda')).toBe(true);
    expect(periksaSebelumImport(dasar(771000), { sifat: 'SALDO_AWAL', cutOff: '2026-07-01' }).some((x) => x.kunci === 'jasa-beda')).toBe(false);
  });

  test('tanpa sheet 7 -> INFO; pemeriksaan tidak mengubah ringkasan', () => {
    const r = parseBerkasDataAwal({ ANGGOTA: [H_ANGGOTA, ['A001', 'Siti', '2024-01-05']] } as any);
    const sebelum = JSON.stringify(r);
    const p = periksaSebelumImport(r, { sifat: 'SALDO_AWAL', cutOff: '2026-07-01' });
    expect(p.find((x) => x.kunci === 'tanpa-sheet7')!.tingkat).toBe('INFO');
    expect(JSON.stringify(r)).toBe(sebelum);
  });
});

describe('Layar memakai modul panduan (struktural)', () => {
  const baca = (rel: string) =>
    readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('ImportDataAwalScreen: tombol Import ditahan oleh adaBlokir & panduan slide dapat dibuka', () => {
    const src = baca('screens/Pengaturan/ImportDataAwalScreen.tsx');
    expect(src).toMatch(/periksaSebelumImport\(/);
    expect(src).toMatch(/adaBlokir\(/);
    expect(src).toMatch(/<PanduanImportSlide/);
    // Alur & penulisan data tetap lewat service yang sama.
    expect(src).toMatch(/jalankanImportDataAwal\(ringkasan/);
    expect(src).toMatch(/tanggalCutOff: cutOffEfektif/);
  });

  test('StrukturTemplateScreen tetap satu sumber dengan template & bisa membuka panduan', () => {
    const src = baca('screens/Pengaturan/StrukturTemplateScreen.tsx');
    expect(src).toMatch(/<PanduanImportSlide/);
    expect(src).toMatch(/judulKolomExcel\(k\)/);
  });
});

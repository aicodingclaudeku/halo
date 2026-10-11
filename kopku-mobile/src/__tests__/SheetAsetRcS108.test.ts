import {
  cocokkanJenisSheet,
  ambilHasilSheet,
  parseBerkasDataAwal,
  URUTAN_PROSES,
  JUDUL_SHEET,
  LABEL_SHEET,
  type JenisSheetImport,
} from '@/import/ExcelDataAwalParser';
import { sheetTemplateUrutTampilan } from '@/import/TemplateDataAwal';

/**
 * RC-S108 — DUA BUG YANG DILAPORKAN PENGGUNA, DAN PENJAGA KELASNYA.
 *
 * 1. Tab "Aset Tetap" pada pratinjau menampilkan baris PINJAMAN.
 *    Sebabnya rantai ternary di layar yang BERAKHIR pada `pinjaman`
 *    sebagai fallback: jenis sheet baru jatuh ke sana tanpa suara.
 *
 * 2. Sheet "5. Aset Tetap" pada berkas sungguhan tidak pernah dikenali.
 *    `cocokkanJenisSheet` tidak ikut diperbarui saat jenis sheet baru
 *    ditambahkan, dan fungsi itu tinggal di modul yang mengimpor
 *    expo — sehingga tidak pernah ada test yang menyentuhnya. Test
 *    RC-S107 lolos karena memanggil `parseBerkasDataAwal({ASET: ...})`
 *    langsung, melewati pencocokan nama.
 *
 * Yang dikunci di sini bukan cuma kedua kasus itu, melainkan KELASNYA:
 * pemeriksaan di bawah berjalan atas SETIAP jenis sheet, jadi jenis
 * berikutnya tidak bisa lagi lolos tanpa dikenali maupun jatuh ke
 * sheet lain.
 */

const SEMUA_JENIS: JenisSheetImport[] = [...URUTAN_PROSES];

describe('RC-S108 §A — setiap jenis sheet dikenali dari namanya', () => {
  test('judul resmi setiap sheet cocok ke jenisnya sendiri', () => {
    for (const jenis of SEMUA_JENIS) {
      expect(cocokkanJenisSheet(JUDUL_SHEET[jenis])).toBe(jenis);
    }
  });

  test('nama sheet template yang sesungguhnya juga dikenali', () => {
    for (const sheet of sheetTemplateUrutTampilan()) {
      expect(cocokkanJenisSheet(sheet.nama)).toBe(sheet.jenis);
    }
  });

  test('sheet Aset Tetap: bug yang dilaporkan — dulu mengembalikan null', () => {
    expect(cocokkanJenisSheet('5. Aset Tetap')).toBe('ASET');
    expect(cocokkanJenisSheet('Aset Tetap')).toBe('ASET');
    expect(cocokkanJenisSheet('ASET')).toBe('ASET');
    expect(cocokkanJenisSheet('Daftar Aset')).toBe('ASET');
  });

  test('variasi penulisan umum tetap dikenali', () => {
    expect(cocokkanJenisSheet('1. Anggota')).toBe('ANGGOTA');
    expect(cocokkanJenisSheet('DATA ANGGOTA')).toBe('ANGGOTA');
    expect(cocokkanJenisSheet('simpanan_berjangka')).toBe('BERJANGKA');
    // BERJANGKA harus menang atas SIMPANAN — "Simpanan Berjangka"
    // mengandung kedua kata.
    expect(cocokkanJenisSheet('4. Simpanan Berjangka')).toBe('BERJANGKA');
  });

  test('sheet Petunjuk & sheet asing diabaikan, bukan dipaksa masuk', () => {
    expect(cocokkanJenisSheet('Petunjuk')).toBeNull();
    expect(cocokkanJenisSheet('Rekap Bulanan')).toBeNull();
    expect(cocokkanJenisSheet('')).toBeNull();
  });

  test('tidak ada dua jenis yang saling merebut judul jenis lain', () => {
    for (const a of SEMUA_JENIS) {
      for (const b of SEMUA_JENIS) {
        if (a === b) continue;
        expect(cocokkanJenisSheet(JUDUL_SHEET[a])).not.toBe(b);
      }
    }
  });
});

describe('RC-S108 §B — pratinjau menampilkan sheet yang benar', () => {
  const berkas = () =>
    parseBerkasDataAwal({
      ANGGOTA: [
        ['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *'],
        ['A1', 'Budi', '2024-01-02'],
      ],
      PINJAMAN: [
        ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor'],
        ['A1', '2025-07-01', '12000000', '12'],
      ],
      // Sheet ASET sengaja TIDAK diisi — inilah keadaan yang dilaporkan.
    });

  test('tab Aset Tetap KOSONG ketika sheetnya kosong — bukan berisi pinjaman', () => {
    const r = berkas();
    const aset = ambilHasilSheet(r.hasil, 'ASET');
    const pinjaman = ambilHasilSheet(r.hasil, 'PINJAMAN');
    expect(pinjaman.baris).toHaveLength(1);
    expect(aset.baris).toHaveLength(0);
    // Dan keduanya bukan objek yang sama — inti bugnya.
    expect(aset).not.toBe(pinjaman);
  });

  test('setiap jenis mengembalikan hasil parse MILIKNYA sendiri', () => {
    const r = berkas();
    const terlihat = new Set<unknown>();
    for (const jenis of SEMUA_JENIS) {
      const s = ambilHasilSheet(r.hasil, jenis);
      expect(s).toBeDefined();
      // Tidak boleh ada dua jenis yang menunjuk objek hasil yang sama.
      expect(terlihat.has(s)).toBe(false);
      terlihat.add(s);
    }
    expect(terlihat.size).toBe(SEMUA_JENIS.length);
  });

  test('judul & label tersedia untuk setiap jenis — tab tidak kosong namanya', () => {
    for (const jenis of SEMUA_JENIS) {
      expect(JUDUL_SHEET[jenis]?.length).toBeGreaterThan(0);
      expect(LABEL_SHEET[jenis]?.length).toBeGreaterThan(0);
    }
  });
});

describe('RC-S108 §C — penjaga struktural', () => {
  const baca = (rel: string) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('fs') as typeof import('fs')).readFileSync(
      (require('path') as typeof import('path')).join(process.cwd(), rel),
      'utf8'
    );

  test('layar pratinjau TIDAK lagi memilih sheet dengan rantai ternary ber-fallback', () => {
    const src = baca('src/screens/Pengaturan/ImportDataAwalScreen.tsx');
    expect(src).toMatch(/ambilHasilSheet\(ringkasan\.hasil, jenis\)/);
    // Bentuk lama yang menyebabkan bug.
    expect(src).not.toMatch(/:\s*ringkasan\.hasil\.pinjaman;/);
  });

  test('pencocokan nama sheet ada di modul MURNI, bukan di service ber-expo', () => {
    const parser = baca('src/import/ExcelDataAwalParser.ts');
    expect(parser).toMatch(/export function cocokkanJenisSheet/);
    const service = baca('src/services/ImportDataAwalService.ts');
    // Service hanya meneruskan, tidak punya salinan kedua.
    expect(service).not.toMatch(/export function cocokkanJenisSheet/);
    expect(service).toMatch(/export \{ cocokkanJenisSheet \}/);
  });
});

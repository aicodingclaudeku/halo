import { parseSheetPinjaman, parseBerkasDataAwal } from '@/import/ExcelDataAwalParser';
import { periksaSebelumImport, ringkasPinjamanImport, estimasiPinjamanImport } from '@/import/PanduanImportData';
import { SHEET_TEMPLATE } from '@/import/TemplateDataAwal';

/**
 * RC-S133.4.8 — kasus nyata: "Jasa Persen" diisi angka PER TAHUN (18)
 * sehingga terbaca 18% SEBULAN; sisa pokok Rp258,9 jt tampil sebagai
 * piutang berjalan Rp824,6 jt. Perbaikan: kolom "Satuan Jasa" (PERIODE/
 * TAHUN), peringatan jasa > pokok, dan ringkasan angka sebelum import.
 */

const H = ['Kode Anggota', 'Tanggal Pencairan', 'Jumlah Pinjaman', 'Tenor', 'Satuan Tenor', 'Metode Jasa', 'Jasa Persen', 'Satuan Jasa', 'Angsuran Sudah Dibayar'];

describe('parseSheetPinjaman — Satuan Jasa', () => {
  test('TAHUN: 18% setahun → 1,5% per bulan; angka asli tetap tercatat', () => {
    const s = parseSheetPinjaman([H, ['A1', '01/08/2026', '10000000', '10', 'BULAN', 'FLAT', '18', 'TAHUN', '4']]);
    expect(s.galat).toEqual([]);
    expect(s.baris[0].persentaseJasa).toBe(1.5);
    expect(s.baris[0].persentaseJasaDiisi).toBe(18);
    expect(s.baris[0].satuanJasa).toBe('TAHUN');
  });

  test('variasi penulisan TAHUN diterima (per tahun, tahunan, huruf kecil)', () => {
    for (const v of ['per tahun', 'Tahunan', 'tahun', 'PER_TAHUN']) {
      const s = parseSheetPinjaman([H, ['A1', '01/08/2026', '10000000', '10', '', '', '12', v, '']]);
      expect(s.galat).toEqual([]);
      expect(s.baris[0].persentaseJasa).toBe(1);
    }
  });

  test('kosong / PERIODE: perilaku lama, tanpa konversi', () => {
    for (const v of ['', 'PERIODE', 'per bulan']) {
      const s = parseSheetPinjaman([H, ['A1', '01/08/2026', '10000000', '10', '', '', '1,5', v, '']]);
      expect(s.galat).toEqual([]);
      expect(s.baris[0].persentaseJasa).toBe(1.5);
      expect(s.baris[0].satuanJasa).toBe('PERIODE');
    }
  });

  test('berkas lama TANPA kolom Satuan Jasa tetap terbaca sama', () => {
    const h = H.filter((x) => x !== 'Satuan Jasa');
    const s = parseSheetPinjaman([h, ['A1', '01/08/2026', '10000000', '10', '', '', '18', '']]);
    expect(s.galat).toEqual([]);
    expect(s.baris[0].persentaseJasa).toBe(18);
  });

  test('angka tahunan tak berujung dibulatkan 8 desimal', () => {
    const s = parseSheetPinjaman([H, ['A1', '01/08/2026', '17011697', '30', '', '', '4,8449', 'TAHUN', '1']]);
    expect(s.baris[0].persentaseJasa).toBe(Number((4.8449 / 12).toFixed(8)));
  });

  test('TAHUN untuk tenor MINGGU/HARI ditolak (konvensi hari/minggu per tahun tidak ditebak)', () => {
    const s = parseSheetPinjaman([H, ['A1', '01/08/2026', '1000000', '10', 'MINGGU', '', '12', 'TAHUN', '']]);
    expect(s.baris).toEqual([]);
    expect(s.galat[0].pesan).toMatch(/hanya untuk Satuan Tenor BULAN/);
  });

  test('isian Satuan Jasa tak dikenal → galat baris', () => {
    const s = parseSheetPinjaman([H, ['A1', '01/08/2026', '1000000', '10', '', '', '12', 'SEMESTER', '']]);
    expect(s.galat[0].pesan).toMatch(/Satuan Jasa "SEMESTER" tidak dikenali/);
  });
});

describe('estimasi & ringkasan sebelum import', () => {
  test('10 jt, 10 bulan, 18%/tahun flat, dibayar 4 → sisa pokok 6 jt, sisa jasa 900 rb', () => {
    const r = parseSheetPinjaman([H, ['A1', '01/08/2026', '10000000', '10', '', 'FLAT', '18', 'TAHUN', '4']]).baris[0];
    const e = estimasiPinjamanImport(r);
    expect(e.sisaPokok).toBe(6_000_000);
    expect(e.sisaJasa).toBe(900_000);
    expect(e.totalJasa).toBe(1_500_000);
  });

  test('angka yang SAMA dibaca per bulan → jasa 18 jt (> pokok) dan ditandai', () => {
    const r = parseSheetPinjaman([H, ['A1', '01/08/2026', '10000000', '10', '', 'FLAT', '18', '', '4']]).baris[0];
    const rk = ringkasPinjamanImport([r]);
    expect(rk.sisaJasa).toBe(6 * 1_800_000);
    expect(rk.jasaMelebihiPokok.map((x) => x.baris)).toEqual([2]);
  });

  test('periksaSebelumImport: PERINGATAN jasa-per-tahun + INFO ringkasan; TAHUN tidak ditandai', () => {
    const berkas = (satuan: string) =>
      parseBerkasDataAwal({
        ANGGOTA: [['Kode Anggota', 'Nama Lengkap', 'Tanggal Bergabung'], ['A1', 'Budi', '2024-01-02']],
        PINJAMAN: [H, ['A1', '01/08/2026', '10000000', '10', '', 'FLAT', '18', satuan, '4']],
      });
    const salah = periksaSebelumImport(berkas(''), { sifat: 'SALDO_AWAL', cutOff: '2026-10-01' });
    const w = salah.find((p) => p.kunci === 'jasa-per-tahun')!;
    expect(w.tingkat).toBe('PERINGATAN');
    expect(w.pesan).toMatch(/Satuan Jasa/);
    const info = salah.find((p) => p.kunci === 'ringkasan-pinjaman')!;
    expect(info.tingkat).toBe('INFO');
    expect(info.pesan).toContain('Sisa pokok (piutang) Rp6.000.000');

    const benar = periksaSebelumImport(berkas('TAHUN'), { sifat: 'SALDO_AWAL', cutOff: '2026-10-01' });
    expect(benar.some((p) => p.kunci === 'jasa-per-tahun')).toBe(false);
    expect(benar.find((p) => p.kunci === 'ringkasan-pinjaman')!.pesan).toContain('Sisa jasa terjadwal Rp900.000');
    // juga berlaku pada Transaksi baru
    const tb = periksaSebelumImport(berkas(''), { sifat: 'TRANSAKSI_BARU' });
    expect(tb.some((p) => p.kunci === 'jasa-per-tahun')).toBe(true);
  });

  test('tanpa pinjaman: tidak ada peringatan jasa', () => {
    const r = parseBerkasDataAwal({ ANGGOTA: [['Kode Anggota', 'Nama Lengkap', 'Tanggal Bergabung'], ['A1', 'Budi', '2024-01-02']] });
    const p = periksaSebelumImport(r, { sifat: 'SALDO_AWAL', cutOff: '2026-10-01' });
    expect(p.some((x) => x.kunci === 'ringkasan-pinjaman' || x.kunci === 'jasa-per-tahun')).toBe(false);
  });
});

describe('template', () => {
  test('kolom Satuan Jasa ada TEPAT setelah Jasa Persen, opsional, pilihan PERIODE/TAHUN', () => {
    const kolom = SHEET_TEMPLATE.find((s) => s.jenis === 'PINJAMAN')!.kolom;
    const i = kolom.findIndex((k) => k.label === 'Jasa Persen');
    expect(kolom[i + 1].label).toBe('Satuan Jasa');
    expect(kolom[i + 1].wajib).toBe(false);
    expect(kolom[i + 1].pilihan).toEqual(['PERIODE', 'TAHUN']);
    expect(kolom[i].catatan).toMatch(/PER TAHUN/);
  });
});

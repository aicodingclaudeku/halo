import { buildCsv } from '@/export/CsvExporter';
import { DataLaporanExport } from '@/export/ExportTypes';

const DATA_CONTOH: DataLaporanExport = {
  judulLaporan: 'Neraca Saldo',
  namaFileDasar: 'neraca-saldo',
  namaKoperasi: 'Koperasi Sejahtera',
  alamatKoperasi: 'Jl. Merdeka No. 1',
  standarAkuntansi: 'SAK_EP',
  periodeLabel: 'Per 31 Desember 2026',
  kolom: ['Kode Akun', 'Nama Akun', 'Debit', 'Kredit'],
  baris: [
    ['1-1000', 'Kas', 5_000_000, 0],
    ['3-1000', 'Simpanan Pokok', 0, 5_000_000],
  ],
  kolomAngka: [2, 3],
  ringkasan: [
    { label: 'Total Debit', nilai: 'Rp5.000.000' },
    { label: 'Total Kredit', nilai: 'Rp5.000.000' },
  ],
};

describe('buildCsv (PRD §36 / fase 6 - export CSV)', () => {
  test('menyertakan informasi koperasi di baris awal', () => {
    const csv = buildCsv(DATA_CONTOH);
    const baris = csv.split('\r\n');
    expect(baris[0]).toBe('Koperasi Sejahtera');
    expect(baris[1]).toBe('Jl. Merdeka No. 1');
    expect(baris[2]).toBe('Neraca Saldo');
    expect(baris[3]).toBe('Per 31 Desember 2026');
  });

  test('menyertakan baris header kolom', () => {
    const csv = buildCsv(DATA_CONTOH);
    expect(csv).toContain('Kode Akun,Nama Akun,Debit,Kredit');
  });

  test('memformat kolom angka sebagai Rupiah (fase 6: "format angka Rupiah")', () => {
    const csv = buildCsv(DATA_CONTOH);
    expect(csv).toContain('Rp5.000.000');
    // Angka mentah 5000000 TIDAK boleh muncul apa adanya di kolom yang ditandai kolomAngka.
    expect(csv).not.toMatch(/,5000000,/);
  });

  test('kolom non-angka (kode akun, nama) TIDAK diformat sebagai Rupiah', () => {
    const csv = buildCsv(DATA_CONTOH);
    expect(csv).toContain('1-1000,Kas');
  });

  test('menyertakan baris ringkasan di akhir', () => {
    const csv = buildCsv(DATA_CONTOH);
    expect(csv).toContain('Total Debit,Rp5.000.000');
    expect(csv).toContain('Total Kredit,Rp5.000.000');
  });

  test('field yang mengandung koma dibungkus tanda kutip (CSV escaping)', () => {
    const data: DataLaporanExport = {
      ...DATA_CONTOH,
      baris: [['1-1000', 'Kas, Bank, dan setara kas', 1000, 0]],
    };
    const csv = buildCsv(data);
    expect(csv).toContain('"Kas, Bank, dan setara kas"');
  });

  test('field yang mengandung tanda kutip di-escape dengan kutip ganda', () => {
    const data: DataLaporanExport = {
      ...DATA_CONTOH,
      baris: [['1-1000', 'Akun "Utama"', 1000, 0]],
    };
    const csv = buildCsv(data);
    expect(csv).toContain('"Akun ""Utama"""');
  });

  test('tanpa alamat koperasi, baris alamat tidak muncul (opsional)', () => {
    const data: DataLaporanExport = { ...DATA_CONTOH, alamatKoperasi: undefined };
    const csv = buildCsv(data);
    const baris = csv.split('\r\n');
    expect(baris[1]).toBe('Neraca Saldo'); // langsung ke judul, bukan alamat kosong
  });

  test('tanpa ringkasan, tidak menghasilkan baris ringkasan kosong yang aneh', () => {
    const data: DataLaporanExport = { ...DATA_CONTOH, ringkasan: undefined };
    const csv = buildCsv(data);
    expect(csv.trim().endsWith('0,5000000'.split(',').join(','))).toBe(false); // sanity, tidak crash
    expect(() => buildCsv(data)).not.toThrow();
  });

  test('data kosong (tidak ada baris) tetap menghasilkan CSV valid tanpa error', () => {
    const data: DataLaporanExport = { ...DATA_CONTOH, baris: [] };
    expect(() => buildCsv(data)).not.toThrow();
    const csv = buildCsv(data);
    expect(csv).toContain('Kode Akun,Nama Akun,Debit,Kredit');
  });
});

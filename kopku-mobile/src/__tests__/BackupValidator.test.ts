import {
  evaluasiValidasiBackup,
  formatNamaFileBackup,
  formatUkuranFile,
  TABEL_WAJIB_BACKUP,
  FaktaBackup,
} from '@/backup/BackupValidator';
import { SCHEMA_VERSION } from '@/database/schema';

const FAKTA_VALID: FaktaBackup = {
  integrityCheckResult: 'ok',
  tabelYangAda: [...TABEL_WAJIB_BACKUP, 'account_mapping', 'accounting_period'],
  totalDebitJurnalPosted: 5_000_000,
  totalKreditJurnalPosted: 5_000_000,
  namaKoperasi: 'Koperasi Sejahtera',
  jumlahAnggota: 12,
  jumlahJurnal: 34,
  tanggalJurnalTerakhir: '2026-07-01',
  // BUG-11 — backup dibuat oleh aplikasi dengan versi skema yang sama.
  schemaVersionBackup: SCHEMA_VERSION,
  schemaVersionAplikasi: SCHEMA_VERSION,
  jumlahPelanggaranForeignKey: 0,
};

describe('evaluasiValidasiBackup (PRD §35 / fase 5 §7 - validasi sebelum restore)', () => {
  test('file yang lolos integrity check, tabel lengkap, dan debit=kredit dinyatakan VALID', () => {
    const hasil = evaluasiValidasiBackup(FAKTA_VALID);
    expect(hasil.valid).toBe(true);
    expect(hasil.errors).toEqual([]);
    expect(hasil.ringkasan?.namaKoperasi).toBe('Koperasi Sejahtera');
    expect(hasil.ringkasan?.jumlahAnggota).toBe(12);
  });

  test('integrity_check yang gagal (bukan "ok") membuat file DITOLAK', () => {
    const hasil = evaluasiValidasiBackup({ ...FAKTA_VALID, integrityCheckResult: 'corruption detected' });
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.some((e) => e.includes('integritas'))).toBe(true);
  });

  test('integrity_check null (file gagal dibuka sama sekali) membuat file DITOLAK', () => {
    const hasil = evaluasiValidasiBackup({ ...FAKTA_VALID, integrityCheckResult: null });
    expect(hasil.valid).toBe(false);
  });

  test.each(TABEL_WAJIB_BACKUP)('tabel wajib "%s" yang hilang membuat file DITOLAK', (tabelHilang) => {
    const tabelTanpaSatu = FAKTA_VALID.tabelYangAda.filter((t) => t !== tabelHilang);
    const hasil = evaluasiValidasiBackup({ ...FAKTA_VALID, tabelYangAda: tabelTanpaSatu });
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.some((e) => e.includes(tabelHilang))).toBe(true);
  });

  test('file bukan backup Koperasi Finance (semua tabel tidak ada) DITOLAK dengan banyak error', () => {
    const hasil = evaluasiValidasiBackup({ ...FAKTA_VALID, tabelYangAda: ['some_random_table'] });
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.length).toBe(TABEL_WAJIB_BACKUP.length);
  });

  test('jurnal tidak balance (debit != kredit) membuat file DITOLAK — aturan inti PRD §19', () => {
    const hasil = evaluasiValidasiBackup({
      ...FAKTA_VALID,
      totalDebitJurnalPosted: 5_000_000,
      totalKreditJurnalPosted: 4_999_000,
    });
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.some((e) => e.includes('tidak balance'))).toBe(true);
  });

  test('debit=kredit dengan nilai 0 (belum ada transaksi) tetap dianggap VALID', () => {
    const hasil = evaluasiValidasiBackup({
      ...FAKTA_VALID,
      totalDebitJurnalPosted: 0,
      totalKreditJurnalPosted: 0,
      jumlahJurnal: 0,
      tanggalJurnalTerakhir: null,
    });
    expect(hasil.valid).toBe(true);
  });

  test('tabel hilang TIDAK memicu pengecekan debit/kredit sekaligus (satu jenis error dulu, bukan tumpuk salah arah)', () => {
    const hasil = evaluasiValidasiBackup({
      ...FAKTA_VALID,
      tabelYangAda: FAKTA_VALID.tabelYangAda.filter((t) => t !== 'journal'),
      totalDebitJurnalPosted: 100,
      totalKreditJurnalPosted: 999, // sengaja tidak balance juga
    });
    expect(hasil.valid).toBe(false);
    // Error tabel yang hilang harus ada; error debit/kredit TIDAK ditambahkan
    // karena query jurnal pada file dengan skema rusak tidak bermakna.
    expect(hasil.errors.some((e) => e.includes('journal'))).toBe(true);
    expect(hasil.errors.some((e) => e.includes('tidak balance'))).toBe(false);
  });

  test('ringkasan TIDAK disertakan saat file tidak valid', () => {
    const hasil = evaluasiValidasiBackup({ ...FAKTA_VALID, integrityCheckResult: 'rusak' });
    expect(hasil.ringkasan).toBeUndefined();
  });
});

describe('formatNamaFileBackup (fase 5 §4 - nama file dengan timestamp)', () => {
  test('menghasilkan nama dengan format koperasi_backup_YYYY-MM-DD_HHmmss.kdb', () => {
    const tanggal = new Date(2026, 6, 5, 14, 30, 45); // 5 Juli 2026, 14:30:45 (bulan 0-index)
    const nama = formatNamaFileBackup(tanggal);
    expect(nama).toBe('koperasi_backup_2026-07-05_143045.kdb');
  });

  test('melakukan zero-padding untuk tanggal/jam/menit/detik satu digit', () => {
    const tanggal = new Date(2026, 0, 3, 5, 7, 9); // 3 Jan 2026, 05:07:09
    const nama = formatNamaFileBackup(tanggal);
    expect(nama).toBe('koperasi_backup_2026-01-03_050709.kdb');
  });

  test('dua panggilan pada detik berbeda menghasilkan nama file yang berbeda (tidak collision)', () => {
    const nama1 = formatNamaFileBackup(new Date(2026, 0, 1, 10, 0, 0));
    const nama2 = formatNamaFileBackup(new Date(2026, 0, 1, 10, 0, 1));
    expect(nama1).not.toBe(nama2);
  });
});

describe('formatUkuranFile', () => {
  test('menampilkan bytes untuk file di bawah 1KB', () => {
    expect(formatUkuranFile(500)).toBe('500 B');
  });

  test('menampilkan KB untuk file di bawah 1MB', () => {
    expect(formatUkuranFile(2048)).toBe('2.0 KB');
  });

  test('menampilkan MB untuk file 1MB ke atas', () => {
    expect(formatUkuranFile(5 * 1024 * 1024)).toBe('5.00 MB');
  });
});


/**
 * BUG-11 — KEBIJAKAN KOMPATIBILITAS VERSI SKEMA BACKUP.
 *
 * Aturan yang diuji:
 *   backup < aplikasi  -> BOLEH (dimigrasikan setelah restore)
 *   backup = aplikasi  -> BOLEH
 *   backup > aplikasi  -> HARD REJECT
 *   metadata hilang    -> HARD REJECT
 */
describe('BUG-11 — kompatibilitas schemaVersion pada backup', () => {
  test('backup dengan schema LEBIH LAMA tetap diterima (akan dimigrasikan)', () => {
    const hasil = evaluasiValidasiBackup({ ...FAKTA_VALID, schemaVersionBackup: SCHEMA_VERSION - 5 });
    expect(hasil.valid).toBe(true);
    expect(hasil.ringkasan?.schemaVersion).toBe(SCHEMA_VERSION - 5);
  });

  test('backup dengan schema SAMA diterima', () => {
    const hasil = evaluasiValidasiBackup({ ...FAKTA_VALID, schemaVersionBackup: SCHEMA_VERSION });
    expect(hasil.valid).toBe(true);
  });

  test('backup dengan schema LEBIH BARU DITOLAK KERAS', () => {
    const hasil = evaluasiValidasiBackup({ ...FAKTA_VALID, schemaVersionBackup: SCHEMA_VERSION + 1 });
    expect(hasil.valid).toBe(false);
    expect(
      hasil.errors.some((e) => e.includes('schema yang lebih baru dan tidak kompatibel'))
    ).toBe(true);
  });

  test('backup tanpa metadata versi (schema_meta ada tapi kosong) DITOLAK', () => {
    const hasil = evaluasiValidasiBackup({ ...FAKTA_VALID, schemaVersionBackup: null });
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.some((e) => e.includes('Metadata versi skema'))).toBe(true);
  });

  test('backup dengan orphan record (pelanggaran FK) DITOLAK meski integrity_check ok', () => {
    const hasil = evaluasiValidasiBackup({ ...FAKTA_VALID, jumlahPelanggaranForeignKey: 3 });
    expect(hasil.valid).toBe(false);
    expect(hasil.errors.some((e) => e.includes('pelanggaran foreign key'))).toBe(true);
  });
});

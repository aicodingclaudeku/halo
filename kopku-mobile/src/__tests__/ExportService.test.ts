// Update pasca-Phase 18/19 §V: ExportService.ts mengimpor beberapa
// modul native (expo-file-system, expo-print, expo-sharing) & library
// besar (xlsx) yang tidak bisa dijalankan langsung di Jest — di-mock
// minimal di sini SUPAYA modulnya bisa di-import untuk menguji
// `sanitizeFileNamePart()` (fungsi murni, tidak menyentuh I/O apa pun).
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/mock/',
  getInfoAsync: jest.fn(async () => ({ exists: true })),
  makeDirectoryAsync: jest.fn(async () => {}),
  writeAsStringAsync: jest.fn(async () => {}),
}));
jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => false), shareAsync: jest.fn() }));
// DIPERBARUI RC-S106: penulis Excel pindah dari `xlsx` ke
// `xlsx-js-style` (fork SheetJS 0.18.5 yang benar-benar menulis gaya sel).
// Mock ini HARUS ikut pindah — mock ke modul yang tidak lagi terpasang
// membuat seluruh suite gagal dimuat, bukan sekadar tidak terpakai.
jest.mock('xlsx-js-style', () => ({ utils: { book_new: jest.fn(), aoa_to_sheet: jest.fn(), book_append_sheet: jest.fn() }, write: jest.fn() }));
jest.mock('@/database/db', () => ({ getDb: jest.fn() }));

import { sanitizeFileNamePart } from '@/services/ExportService';

describe('sanitizeFileNamePart (update pasca-Phase 18/19 §V — bugfix export, dipakai GLOBAL di buildFileName)', () => {
  test('nama aman tidak berubah (selain diganti spasi jadi tanda hubung)', () => {
    expect(sanitizeFileNamePart('bukti-bayar-piutang-AGS-2026-000001')).toBe('bukti-bayar-piutang-AGS-2026-000001');
  });

  test('karakter terlarang filesystem (/ \\ : * ? " < > |) diganti tanda hubung, TIDAK membuat export gagal', () => {
    expect(sanitizeFileNamePart('buku-besar-1/1000 "Kas/Bank"')).not.toMatch(/[\/\\:*?"<>|]/);
    expect(sanitizeFileNamePart('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  test('nama akun yang di-rename admin dengan slash (mis. lewat updateAccount) tetap menghasilkan nama file valid', () => {
    const namaAkunKustom = 'Kas/Bank Utama'; // skenario nyata: akun bisa di-rename bebas oleh admin
    const hasil = sanitizeFileNamePart(`buku-besar-${namaAkunKustom}`);
    expect(hasil).not.toContain('/');
    expect(hasil.length).toBeGreaterThan(0);
  });

  test('string kosong atau hanya karakter terlarang tetap menghasilkan nama file yang valid (fallback "laporan")', () => {
    expect(sanitizeFileNamePart('')).toBe('laporan');
    expect(sanitizeFileNamePart('///???')).toBe('laporan');
  });

  test('spasi berlebih & tanda hubung berulang dirapikan', () => {
    expect(sanitizeFileNamePart('bukti   tarik    simpanan')).toBe('bukti-tarik-simpanan');
    expect(sanitizeFileNamePart('a--b---c')).toBe('a-b-c');
  });

  test('nomor bukti fallback "-" (kalau journal_id null) tidak membuat nama file kosong/aneh', () => {
    expect(sanitizeFileNamePart('bukti-bayar-piutang--')).toBe('bukti-bayar-piutang');
  });
});

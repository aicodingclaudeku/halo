import { TestDb } from './testDb';

let testDb: TestDb;

jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import { buatFixtureHistoris, USER_ID } from './historicalFixture';
import { parseBerkasDataAwal } from '@/import/ExcelDataAwalParser';
import { jalankanImportDataAwal } from '@/import/EksekusiImportDataAwal';
import { periksaSebelumImport } from '@/import/PanduanImportData';

/**
 * RC-S133.6.1 — NIK pada impor (temuan audit E06, dibuktikan lewat UI):
 * pratinjau menyatakan "8 baris siap diimpor, tidak ada kesalahan" padahal
 * dua anggota pasti gagal karena NIK ganda (di dalam berkas dan dengan anggota
 * yang sudah ada), dan riwayat menampilkan pesan mentah
 * "UNIQUE constraint failed: anggota.nik".
 */
const HDR = ['Kode Anggota *', 'Nama Lengkap *', 'Tanggal Bergabung *', 'NIK'];

describe('RC-S133.6.1 — NIK ganda pada impor', () => {
  beforeEach(async () => {
    testDb = await buatFixtureHistoris();
  });

  test('NIK sama di dua baris berkas → galat di baris kedua (pratinjau tidak lagi "siap")', () => {
    const r = parseBerkasDataAwal({
      ANGGOTA: [HDR, ['Z1', 'Satu', '2026-01-01', '3206000000000001'], ['Z2', 'Dua', '2026-01-01', '3206000000000001'], ['Z3', 'Tiga', '2026-01-01', null]],
    });
    expect(r.hasil.anggota.galat).toEqual([{ baris: 3, pesan: expect.stringMatching(/NIK 3206000000000001 sudah dipakai baris 2/) }]);
    expect(r.siapDiimpor).toBe(false);
  });

  test('anggota tanpa NIK tidak dianggap ganda', () => {
    const r = parseBerkasDataAwal({ ANGGOTA: [HDR, ['Z1', 'Satu', '2026-01-01', null], ['Z2', 'Dua', '2026-01-01', '']] });
    expect(r.hasil.anggota.galat).toEqual([]);
  });

  test('NIK milik anggota yang sudah ada → BLOKIR di pratinjau bila daftar NIK diberikan', () => {
    const r = parseBerkasDataAwal({ ANGGOTA: [HDR, ['Z1', 'Satu', '2026-01-01', '1234567890123456']] });
    const p = periksaSebelumImport(r, { sifat: 'TRANSAKSI_BARU', nikTerdaftar: ['1234567890123456'] }).filter((x) => x.kunci === 'nik-terdaftar');
    expect(p).toHaveLength(1);
    expect(p[0].tingkat).toBe('BLOKIR');
    expect(periksaSebelumImport(r, { sifat: 'TRANSAKSI_BARU' }).filter((x) => x.kunci === 'nik-terdaftar')).toEqual([]);
  });

  test('eksekusi: NIK yang sudah terdaftar → pesan yang dapat ditindaklanjuti, bukan galat mentah database', async () => {
    const r = parseBerkasDataAwal({ ANGGOTA: [HDR, ['Z1', 'Satu', '2026-01-01', '1234567890123456']] });
    const h = await jalankanImportDataAwal(r, { createdBy: USER_ID, dbRiwayat: testDb as never });
    expect(h.totalGagal).toBe(1);
    expect(h.gagal[0].pesan).toMatch(/NIK 1234567890123456 sudah terdaftar pada anggota lain/);
    expect(h.gagal[0].pesan).not.toMatch(/UNIQUE constraint/);
  });
});

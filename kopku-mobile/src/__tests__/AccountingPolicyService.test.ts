import { createTestDb, TestDb } from './testDb';

let testDb: TestDb;

jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => testDb),
}));

import { getPolicyValue, getAllPolicies, setPolicyValue, getKebijakanAkuntansiNarasi } from '@/services/AccountingPolicyService';

describe('AccountingPolicyService (Phase 2)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  test('default value 0 (tidak membatasi) kalau belum pernah diatur', async () => {
    expect(await getPolicyValue('MINIMUM_CASH_RESERVE')).toBe(0);
    expect(await getPolicyValue('MAX_PINJAMAN_PER_ANGGOTA')).toBe(0);
  });

  test('set lalu get mengembalikan nilai yang sama', async () => {
    await setPolicyValue('MINIMUM_CASH_RESERVE', 2_000_000);
    expect(await getPolicyValue('MINIMUM_CASH_RESERVE')).toBe(2_000_000);
  });

  test('set dua kali (upsert) — nilai terakhir yang berlaku, bukan dua baris', async () => {
    await setPolicyValue('MAX_PINJAMAN_PER_ANGGOTA', 10_000_000);
    await setPolicyValue('MAX_PINJAMAN_PER_ANGGOTA', 15_000_000);
    expect(await getPolicyValue('MAX_PINJAMAN_PER_ANGGOTA')).toBe(15_000_000);

    const rows = await testDb.getAllAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM app_config WHERE key = 'policy.MAX_PINJAMAN_PER_ANGGOTA'`
    );
    expect(rows[0].cnt).toBe(1);
  });

  test('menolak nilai negatif', async () => {
    await expect(setPolicyValue('OVERDUE_LIMIT_HARI', -5)).rejects.toThrow(/>= 0/);
  });

  test('getAllPolicies: campuran default & yang sudah diatur', async () => {
    await setPolicyValue('RESERVED_LIQUIDITY', 1_000_000);
    const all = await getAllPolicies();
    expect(all.RESERVED_LIQUIDITY).toBe(1_000_000);
    expect(all.MINIMUM_CASH_RESERVE).toBe(0); // masih default
    // Update pasca-Phase 18 §17: 4 key PENYISIHAN_PERSEN_* dihapus dari
    // PolicyKey (persentase cadangan sekarang tetap, bukan configurable
    // — lihat LoanImpairmentService.ts), jadi sekarang 7 key.
    expect(Object.keys(all)).toHaveLength(7);
  });
});

// ============================================================
// Prioritas 11 (M) — Kebijakan Akuntansi naratif untuk CALK. Test ini
// murni memastikan STRUKTUR data lengkap & konsisten (setiap area
// wajib ada judul+narasi+sumberKode) — bukan menguji isi teksnya kata
// per kata (itu tanggung jawab audit manual/pembaca CALK).
// ============================================================
describe('getKebijakanAkuntansiNarasi (Prioritas 11/M)', () => {
  test('mencakup seluruh area wajib sesuai instruksi (§M)', () => {
    const areaWajib = [
      'basis_akuntansi',
      'periode_pelaporan',
      'mata_uang',
      'kas_setara_kas',
      'piutang',
      'penyisihan_piutang',
      'aset_tetap',
      'penyusutan',
      'aset_tak_berwujud',
      'amortisasi',
      'investasi',
      'utang',
      'simpanan_anggota',
      'ekuitas',
      'pendapatan',
      'beban',
      'shu',
      'imbalan_kerja',
      'biaya_pinjaman',
    ];
    const items = getKebijakanAkuntansiNarasi();
    const areaAda = items.map((i) => i.area);
    for (const area of areaWajib) {
      expect(areaAda).toContain(area);
    }
  });

  test('setiap butir punya judul, narasi non-kosong, dan sumberKode untuk audit', () => {
    const items = getKebijakanAkuntansiNarasi();
    for (const item of items) {
      expect(item.judul.length).toBeGreaterThan(0);
      expect(item.narasi.length).toBeGreaterThan(10);
      expect(item.sumberKode.length).toBeGreaterThan(0);
    }
  });

  test('nama standar akuntansi ikut termuat di narasi basis akuntansi', () => {
    const items = getKebijakanAkuntansiNarasi();
    const basis = items.find((i) => i.area === 'basis_akuntansi');
    expect(basis?.narasi).toContain('SAK EP');
  });
});

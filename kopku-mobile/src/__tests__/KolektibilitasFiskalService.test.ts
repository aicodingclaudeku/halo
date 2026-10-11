import { createTestDb, TestDb } from './testDb';

let testDb: TestDb;

jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => testDb),
}));

import {
  PERSENTASE_CADANGAN_FISKAL,
  PETA_KATEGORI_KE_FISKAL,
  petakanKeKolektibilitasFiskal,
  hitungCadanganFiskal,
  getKlasifikasiFiskalPinjamanAktif,
  getRingkasanCadanganFiskal,
  getPerbandinganCadanganBukuFiskal,
} from '@/services/KolektibilitasFiskalService';

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('anggota-1','A001','1234567890123456','Budi','2020-01-01','AKTIF',?,?)`,
    now,
    now
  );
  return db;
}

/** Buat satu pinjaman AKTIF dengan satu baris angsuran jatuh tempo N hari yang lalu, opsional dengan agunan. */
async function seedPinjamanTunggak(
  db: TestDb,
  id: string,
  sisaPokok: number,
  hariTerlambat: number,
  opts: { nilaiAgunan?: number } = {}
) {
  const now = new Date().toISOString();
  const tanggalJatuhTempo = new Date(Date.now() - hariTerlambat * 86400 * 1000).toISOString().slice(0, 10);
  await db.runAsync(
    `INSERT INTO pinjaman
      (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa,
       persentase_jasa, biaya_admin_tipe, biaya_admin_nilai, denda_aktif, denda_nilai,
       tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    `PJ-${id}`,
    'anggota-1',
    '2025-01-01',
    sisaPokok,
    1,
    'BULAN',
    'FLAT',
    0,
    'TIDAK_ADA',
    0,
    0,
    0,
    tanggalJatuhTempo,
    'AKTIF',
    'user-1',
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    `jadwal-${id}`,
    id,
    1,
    tanggalJatuhTempo,
    sisaPokok,
    0,
    0,
    sisaPokok,
    'BELUM_BAYAR'
  );
  if (opts.nilaiAgunan !== undefined) {
    await db.runAsync(
      `INSERT INTO pinjaman_agunan
        (id, pinjaman_id, jenis_agunan, pemilik, nomor_dokumen, nilai_agunan, keterangan, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      `agunan-${id}`,
      id,
      'TANAH',
      'Budi',
      'DOK-001',
      opts.nilaiAgunan,
      null,
      'user-1',
      now,
      now
    );
  }
}

describe('KolektibilitasFiskalService — konstanta PMK 74/2024 (Ps.7, Koperasi Simpan Pinjam)', () => {
  test('PERSENTASE_CADANGAN_FISKAL: PERSIS 4 kategori, TIDAK ADA Dalam Perhatian Khusus', () => {
    expect(PERSENTASE_CADANGAN_FISKAL.LANCAR).toBe(0.5);
    expect(PERSENTASE_CADANGAN_FISKAL.KURANG_LANCAR).toBe(10);
    expect(PERSENTASE_CADANGAN_FISKAL.DIRAGUKAN).toBe(50);
    expect(PERSENTASE_CADANGAN_FISKAL.MACET).toBe(100);
    expect(Object.keys(PERSENTASE_CADANGAN_FISKAL).sort()).toEqual(
      ['DIRAGUKAN', 'KURANG_LANCAR', 'LANCAR', 'MACET'].sort()
    );
  });

  test('PETA_KATEGORI_KE_FISKAL: identitas — kategori SOM dan kategori PMK 74 sudah sama', () => {
    // Sejak penggolongan buku memakai SOM Juklat 3/2025, kedua taksonomi
    // berisi 4 kategori yang sama, jadi tidak ada lagi kategori buku yang
    // perlu "dipaksa" masuk ke kategori fiskal (dulu DALAM_PERHATIAN).
    expect(petakanKeKolektibilitasFiskal('LANCAR')).toBe('LANCAR');
    expect(petakanKeKolektibilitasFiskal('KURANG_LANCAR')).toBe('KURANG_LANCAR');
    expect(petakanKeKolektibilitasFiskal('DIRAGUKAN')).toBe('DIRAGUKAN');
    expect(petakanKeKolektibilitasFiskal('MACET')).toBe('MACET');
    expect(Object.keys(PETA_KATEGORI_KE_FISKAL)).toHaveLength(4);
    expect(Object.keys(PETA_KATEGORI_KE_FISKAL)).not.toContain('DALAM_PERHATIAN');
  });

  test('hitungCadanganFiskal: kategori LANCAR dihitung TANPA pengurang agunan', () => {
    const { dasarPencadanganFiskal, cadanganFiskal } = hitungCadanganFiskal(10_000_000, 8_000_000, 'LANCAR');
    expect(dasarPencadanganFiskal).toBe(10_000_000); // agunan TIDAK dikurangkan
    expect(cadanganFiskal).toBe(50_000); // 0.5% x 10jt
  });

  test('hitungCadanganFiskal: kategori selain LANCAR dihitung dari piutang DIKURANGI agunan', () => {
    const macet = hitungCadanganFiskal(10_000_000, 3_000_000, 'MACET');
    expect(macet.dasarPencadanganFiskal).toBe(7_000_000); // 10jt - 3jt agunan
    expect(macet.cadanganFiskal).toBe(7_000_000); // 100% x 7jt

    const diragukan = hitungCadanganFiskal(10_000_000, 3_000_000, 'DIRAGUKAN');
    expect(diragukan.dasarPencadanganFiskal).toBe(7_000_000);
    expect(diragukan.cadanganFiskal).toBe(3_500_000); // 50% x 7jt
  });

  test('hitungCadanganFiskal: agunan melebihi piutang -> dasar pencadangan 0, bukan negatif', () => {
    const { dasarPencadanganFiskal, cadanganFiskal } = hitungCadanganFiskal(5_000_000, 9_000_000, 'MACET');
    expect(dasarPencadanganFiskal).toBe(0);
    expect(cadanganFiskal).toBe(0);
  });
});

describe('KolektibilitasFiskalService — I/O', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('getKlasifikasiFiskalPinjamanAktif: memetakan kategori internal ke fiskal & mengurangi agunan', async () => {
    await seedPinjamanTunggak(testDb, 'p1', 10_000_000, 200, { nilaiAgunan: 4_000_000 }); // internal MACET
    await seedPinjamanTunggak(testDb, 'p2', 5_000_000, 45); // ~1 bulan lewat jatuh tempo -> KURANG_LANCAR, tanpa agunan
    await seedPinjamanTunggak(testDb, 'p3', 2_000_000, 0); // internal LANCAR

    const hasil = await getKlasifikasiFiskalPinjamanAktif(testDb as any);

    const p1 = hasil.find((k) => k.pinjamanId === 'p1')!;
    expect(p1.kolektibilitasFiskal).toBe('MACET');
    expect(p1.nilaiAgunan).toBe(4_000_000);
    expect(p1.dasarPencadanganFiskal).toBe(6_000_000); // 10jt - 4jt
    expect(p1.cadanganFiskal).toBe(6_000_000); // 100%

    const p2 = hasil.find((k) => k.pinjamanId === 'p2')!;
    expect(p2.kolektibilitasFiskal).toBe('KURANG_LANCAR');
    expect(p2.nilaiAgunan).toBe(0);
    expect(p2.dasarPencadanganFiskal).toBe(5_000_000);
    expect(p2.cadanganFiskal).toBe(500_000); // 10% x 5jt

    const p3 = hasil.find((k) => k.pinjamanId === 'p3')!;
    expect(p3.kolektibilitasFiskal).toBe('LANCAR');
    expect(p3.cadanganFiskal).toBe(10_000); // 0.5% x 2jt
  });

  test('getRingkasanCadanganFiskal: agregat PERSIS 4 kategori', async () => {
    await seedPinjamanTunggak(testDb, 'p1', 10_000_000, 200); // MACET
    await seedPinjamanTunggak(testDb, 'p2', 5_000_000, 45); // KURANG_LANCAR

    const ringkasan = await getRingkasanCadanganFiskal();
    expect(ringkasan.map((r) => r.kategori)).toEqual(['LANCAR', 'KURANG_LANCAR', 'DIRAGUKAN', 'MACET']);

    const kurangLancar = ringkasan.find((r) => r.kategori === 'KURANG_LANCAR')!;
    expect(kurangLancar.jumlahPinjaman).toBe(1);
    expect(kurangLancar.totalCadanganFiskal).toBe(500_000);

    const macet = ringkasan.find((r) => r.kategori === 'MACET')!;
    expect(macet.jumlahPinjaman).toBe(1);
    expect(macet.totalCadanganFiskal).toBe(10_000_000);
  });

  test('getPerbandinganCadanganBukuFiskal: cadangan SOM jauh melebihi batas fiskal PMK 74', async () => {
    // DUA sumber selisih, keduanya nyata:
    //   1. PERSENTASE — SOM angka 15 mengenakan 50% untuk Kurang Lancar,
    //      PMK 74 hanya mengakui 10%.
    //   2. DASAR — PMK 74 mengurangkan nilai agunan (kecuali Lancar),
    //      cadangan SOM dikenakan atas saldo pokok penuh.
    // Di sini agunan 0, jadi yang bekerja hanya sumber pertama.
    await seedPinjamanTunggak(testDb, 'p1', 10_000_000, 100); // ~3 bulan lewat jatuh tempo -> KURANG_LANCAR

    const perbandingan = await getPerbandinganCadanganBukuFiskal();
    expect(perbandingan.totalCadanganBuku).toBe(5_000_000); // SOM 50% x 10jt
    expect(perbandingan.totalCadanganFiskal).toBe(1_000_000); // PMK 74 10% x 10jt
    expect(perbandingan.selisih).toBe(4_000_000); // buku > fiskal -> koreksi fiskal positif
  });

  test('getPerbandinganCadanganBukuFiskal: agunan memperlebar selisih karena hanya mengurangi dasar FISKAL', async () => {
    await seedPinjamanTunggak(testDb, 'p1', 10_000_000, 100, { nilaiAgunan: 4_000_000 });

    const perbandingan = await getPerbandinganCadanganBukuFiskal();
    expect(perbandingan.totalCadanganBuku).toBe(5_000_000); // SOM 50% x 10jt (agunan TIDAK mengurangi)
    expect(perbandingan.totalCadanganFiskal).toBe(600_000); // PMK 74 10% x (10jt - 4jt)
    expect(perbandingan.selisih).toBe(4_400_000);
  });
});

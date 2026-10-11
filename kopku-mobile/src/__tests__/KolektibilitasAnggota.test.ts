import { createTestDb, TestDb } from './testDb';

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

import {
  getKolektibilitasAnggota,
  getKlasifikasiPinjamanAktif,
  PERSENTASE_CADANGAN,
} from '@/services/LoanImpairmentService';

/**
 * REQUIREMENT 2 (permintaan pengguna) — "Kolektibilitas Piutang Anggota"
 * pada layar Detail Anggota.
 *
 * Yang dibuktikan:
 *   1) nilainya BERASAL DARI DATA AKTUAL (aging `angsuran_jadwal`), bukan
 *      hardcode — kategori berubah mengikuti hari tunggakan sungguhan;
 *   2) memakai MESIN YANG SAMA dengan layar Kolektibilitas Piutang —
 *      hasilnya identik dengan `getKlasifikasiPinjamanAktif()` yang
 *      disaring untuk anggota tersebut (tidak ada rumus kedua);
 *   3) kategori anggota = kategori TERBURUK dari seluruh pinjamannya;
 *   4) cadangan dijumlah PER PINJAMAN (persentase masing-masing), bukan
 *      totalPokok x persentase kategori terburuk;
 *   5) anggota tanpa pinjaman aktif menghasilkan empty state yang jujur,
 *      bukan angka Rp0 yang menyesatkan;
 *   6) piutang anggota LAIN tidak pernah ikut terhitung.
 */

const TANGGAL_LAPORAN = '2026-09-02';

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();
  const now = new Date().toISOString();

  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  for (const [id, nomor, nama, status] of [
    ['anggota-1', 'A001', 'Budi', 'AKTIF'],
    ['anggota-2', 'A002', 'Sari', 'AKTIF'],
    ['anggota-3', 'A003', 'Tono (Nonaktif)', 'TIDAK_AKTIF'],
  ] as const) {
    await db.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES (?,?,?,'2020-01-01',?,?,?)`,
      id,
      nomor,
      nama,
      status,
      now,
      now
    );
  }
  return db;
}

/**
 * Satu pinjaman AKTIF dengan satu baris angsuran yang jatuh tempo
 * `hariTerlambat` hari SEBELUM TANGGAL_LAPORAN — jadi aging-nya
 * deterministik (tidak bergantung jam berapa test dijalankan).
 */
async function seedPinjaman(
  db: TestDb,
  id: string,
  anggotaId: string,
  pokok: number,
  jasa: number,
  hariTerlambat: number
) {
  const now = new Date().toISOString();
  const jatuhTempo = new Date(new Date(TANGGAL_LAPORAN).getTime() - hariTerlambat * 86400 * 1000)
    .toISOString()
    .slice(0, 10);
  await db.runAsync(
    `INSERT INTO pinjaman
      (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa,
       persentase_jasa, biaya_admin_tipe, biaya_admin_nilai, denda_aktif, denda_nilai,
       tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
     VALUES (?,?,?,'2025-01-01',?,1,'BULAN','FLAT',0,'TIDAK_ADA',0,0,0,?,'AKTIF','user-1',?,?)`,
    id,
    `PJ-${id}`,
    anggotaId,
    pokok,
    jatuhTempo,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
     VALUES (?,?,1,?,?,?,0,?, 'BELUM_BAYAR')`,
    `jadwal-${id}`,
    id,
    jatuhTempo,
    pokok,
    jasa,
    pokok + jasa
  );
}

describe('REQ 2 — getKolektibilitasAnggota', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('anggota tanpa pinjaman aktif -> empty state jujur, bukan Rp0 yang menyesatkan', async () => {
    const hasil = await getKolektibilitasAnggota(testDb as any, 'anggota-1', TANGGAL_LAPORAN);

    expect(hasil.tanpaPinjamanAktif).toBe(true);
    expect(hasil.kolektibilitas).toBeNull();
    expect(hasil.jumlahPinjamanAktif).toBe(0);
    expect(hasil.rincian).toEqual([]);
  });

  test('kategori mengikuti HARI TUNGGAKAN AKTUAL (bukan hardcode)', async () => {
    await seedPinjaman(testDb, 'p-lancar', 'anggota-1', 1_000_000, 0, 0);
    const lancar = await getKolektibilitasAnggota(testDb as any, 'anggota-1', TANGGAL_LAPORAN);
    expect(lancar.kolektibilitas).toBe('LANCAR');
    expect(lancar.hariTunggakan).toBe(0);

    // Anggota lain, tunggakan 200 hari -> MACET (ambang >180 hari).
    await seedPinjaman(testDb, 'p-macet', 'anggota-2', 1_000_000, 0, 200);
    const macet = await getKolektibilitasAnggota(testDb as any, 'anggota-2', TANGGAL_LAPORAN);
    expect(macet.kolektibilitas).toBe('MACET');
    expect(macet.hariTunggakan).toBe(200);
  });

  test('kategori anggota = kategori TERBURUK di antara pinjamannya', async () => {
    await seedPinjaman(testDb, 'p-a', 'anggota-1', 1_000_000, 0, 0); // LANCAR
    await seedPinjaman(testDb, 'p-b', 'anggota-1', 2_000_000, 0, 100); // KURANG_LANCAR (91-120)

    const hasil = await getKolektibilitasAnggota(testDb as any, 'anggota-1', TANGGAL_LAPORAN);

    expect(hasil.jumlahPinjamanAktif).toBe(2);
    expect(hasil.hariTunggakan).toBe(100);
    expect(hasil.kolektibilitas).toBe('KURANG_LANCAR');
    // Satu pinjaman macet TIDAK menjadi "lancar" hanya karena ada
    // pinjaman lain yang lancar.
    expect(hasil.kolektibilitas).not.toBe('LANCAR');
  });

  test('cadangan dijumlah PER PINJAMAN (persentase masing-masing), bukan dari kategori terburuk', async () => {
    await seedPinjaman(testDb, 'p-a', 'anggota-1', 1_000_000, 0, 0); // LANCAR
    await seedPinjaman(testDb, 'p-b', 'anggota-1', 2_000_000, 0, 100); // KURANG_LANCAR

    const hasil = await getKolektibilitasAnggota(testDb as any, 'anggota-1', TANGGAL_LAPORAN);

    const diharapkan =
      Math.round((1_000_000 * PERSENTASE_CADANGAN.LANCAR) / 100) +
      Math.round((2_000_000 * PERSENTASE_CADANGAN.KURANG_LANCAR) / 100);
    expect(hasil.totalCadangan).toBe(diharapkan);

    // Kalau keliru memakai kategori terburuk untuk seluruh pokok, hasilnya
    // akan jauh lebih besar — dipastikan TIDAK terjadi.
    const salah = Math.round((3_000_000 * PERSENTASE_CADANGAN.KURANG_LANCAR) / 100);
    expect(hasil.totalCadangan).not.toBe(salah);
  });

  test('outstanding = pokok + jasa; basis cadangan = pokok SAJA', async () => {
    await seedPinjaman(testDb, 'p-a', 'anggota-1', 1_000_000, 250_000, 0);

    const hasil = await getKolektibilitasAnggota(testDb as any, 'anggota-1', TANGGAL_LAPORAN);

    expect(hasil.totalOutstanding).toBe(1_250_000);
    expect(hasil.totalPokok).toBe(1_000_000);
    expect(hasil.totalCadangan).toBe(Math.round((1_000_000 * PERSENTASE_CADANGAN.LANCAR) / 100));
  });

  test('piutang anggota LAIN tidak pernah ikut terhitung', async () => {
    await seedPinjaman(testDb, 'p-a', 'anggota-1', 1_000_000, 0, 0);
    await seedPinjaman(testDb, 'p-b', 'anggota-2', 9_000_000, 0, 200);

    const hasil = await getKolektibilitasAnggota(testDb as any, 'anggota-1', TANGGAL_LAPORAN);

    expect(hasil.jumlahPinjamanAktif).toBe(1);
    expect(hasil.totalOutstanding).toBe(1_000_000);
    expect(hasil.kolektibilitas).toBe('LANCAR');
    expect(hasil.rincian.every((r) => r.anggotaId === 'anggota-1')).toBe(true);
  });

  test('anggota berstatus TIDAK_AKTIF tetap menampilkan kolektibilitas piutangnya', async () => {
    // Piutang tetap berisiko apa pun status keanggotaannya — layar Detail
    // Anggota tidak boleh mendadak kosong hanya karena anggota nonaktif.
    await seedPinjaman(testDb, 'p-c', 'anggota-3', 500_000, 0, 150);

    const hasil = await getKolektibilitasAnggota(testDb as any, 'anggota-3', TANGGAL_LAPORAN);

    expect(hasil.tanpaPinjamanAktif).toBe(false);
    // Pinjaman tanpa angsuran, ~5 bulan lewat jatuh tempo (melampaui 3
    // bulan) dan tidak beragunan -> MACET menurut SOM Juklat 3/2025.
    expect(hasil.kolektibilitas).toBe('MACET');
  });

  test('hasilnya IDENTIK dengan mesin klasifikasi yang dipakai layar Kolektibilitas Piutang', async () => {
    await seedPinjaman(testDb, 'p-a', 'anggota-1', 1_000_000, 0, 0);
    await seedPinjaman(testDb, 'p-b', 'anggota-1', 2_000_000, 0, 100);

    const viaAgregat = await getKolektibilitasAnggota(testDb as any, 'anggota-1', TANGGAL_LAPORAN);
    const viaMesin = (
      await getKlasifikasiPinjamanAktif(testDb as any, {
        tanggalLaporan: TANGGAL_LAPORAN,
        statusAnggota: 'SEMUA',
      })
    ).filter((r) => r.anggotaId === 'anggota-1');

    expect(viaAgregat.rincian.length).toBe(viaMesin.length);
    expect(viaAgregat.totalCadangan).toBe(viaMesin.reduce((a, r) => a + r.nilaiCadangan, 0));
    expect(viaAgregat.totalOutstanding).toBe(viaMesin.reduce((a, r) => a + r.saldoPiutang, 0));
  });
});

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
  hitungPengakuanBulanan,
  prosesPengakuanPendapatanDimuka,
  jalankanPengakuanPeriode,
  getStatusPengakuanPeriode,
  listJurnalPengakuanDimuka,
} from '@/services/PendapatanDimukaService';

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  normalBalance: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    now,
    now
  );
}

async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${transactionType}-${role}`,
    transactionType,
    role,
    accountId
  );
}

async function seedDimuka(
  db: TestDb,
  id: string,
  anggotaId: string,
  jumlah: number,
  jangkaWaktuBulan: number,
  tanggal: string
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO pendapatan_diterima_dimuka
      (id, nomor_transaksi, anggota_id, jumlah, jangka_waktu_bulan, tanggal, sumber_dana, status, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    `PDM-${id}`,
    anggotaId,
    jumlah,
    jangkaWaktuBulan,
    tanggal,
    'KAS',
    'AKTIF',
    'user-1',
    now
  );
}

const ACC = {
  dimuka: 'acc-dimuka',
  pendapatan: 'acc-pendapatan',
};

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();

  await seedAccount(db, ACC.dimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.pendapatan, '4-3000', 'Pendapatan Lainnya', 'PENDAPATAN', 'KREDIT');
  await seedMapping(db, 'PENGAKUAN_PENDAPATAN_DIMUKA', 'DEBIT_DIMUKA', ACC.dimuka);
  await seedMapping(db, 'PENGAKUAN_PENDAPATAN_DIMUKA', 'KREDIT_PENDAPATAN', ACC.pendapatan);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );

  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    new Date().toISOString(),
    new Date().toISOString()
  );

  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('anggota-1','A001','1234567890123456','Budi Santoso','2025-01-01','AKTIF',?,?)`,
    new Date().toISOString(),
    new Date().toISOString()
  );

  return db;
}

describe('PendapatanDimukaService — pengakuan bulanan', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('hitungPengakuanBulanan: garis lurus jumlah / jangka waktu', () => {
    expect(hitungPengakuanBulanan(12_000_000, 12)).toBe(1_000_000);
    expect(hitungPengakuanBulanan(1_000_000, 0)).toBe(0); // dijaga, tidak divide-by-zero
  });

  test('prosesPengakuanPendapatanDimuka: jurnal balance, DEBIT Dimuka = KREDIT Pendapatan', async () => {
    await seedDimuka(testDb, 'dimuka-1', 'anggota-1', 12_000_000, 12, '2026-01-10');

    const hasil = await prosesPengakuanPendapatanDimuka({ pendapatanDimukaId: 'dimuka-1', periode: '2026-02', createdBy: 'user-1' });

    expect(hasil.dibuat).toBe(true);
    expect(hasil.row.nilaiPengakuan).toBe(1_000_000);
    expect(hasil.row.urutanBulan).toBe(2); // Jan=bulan ke-1, Feb=bulan ke-2
    expect(hasil.menyelesaikan).toBe(false);

    const dimukaRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.dimuka
    );
    const pendapatanRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.pendapatan
    );
    expect(dimukaRow?.total).toBe(1_000_000);
    expect(pendapatanRow?.total).toBe(1_000_000);
  });

  test('anti-duplikasi: proses periode yang sama dua kali TIDAK membuat jurnal kedua', async () => {
    await seedDimuka(testDb, 'dimuka-1', 'anggota-1', 12_000_000, 12, '2026-01-10');

    const pertama = await prosesPengakuanPendapatanDimuka({ pendapatanDimukaId: 'dimuka-1', periode: '2026-01', createdBy: 'user-1' });
    const kedua = await prosesPengakuanPendapatanDimuka({ pendapatanDimukaId: 'dimuka-1', periode: '2026-01', createdBy: 'user-1' });

    expect(pertama.dibuat).toBe(true);
    expect(kedua.dibuat).toBe(false);
    expect(kedua.row.id).toBe(pertama.row.id);

    const jumlahJurnal = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'PENGAKUAN_PENDAPATAN_DIMUKA' AND sumber_id = 'dimuka-1'`
    );
    expect(jumlahJurnal?.cnt).toBe(1);
  });

  test('bulan terakhir otomatis mengubah status jadi SELESAI, bulan setelahnya ditolak', async () => {
    await seedDimuka(testDb, 'dimuka-1', 'anggota-1', 2_000_000, 2, '2026-01-01'); // 2 bulan: Jan & Feb

    const bulanPertama = await prosesPengakuanPendapatanDimuka({ pendapatanDimukaId: 'dimuka-1', periode: '2026-01', createdBy: 'user-1' });
    expect(bulanPertama.menyelesaikan).toBe(false);

    const bulanKedua = await prosesPengakuanPendapatanDimuka({ pendapatanDimukaId: 'dimuka-1', periode: '2026-02', createdBy: 'user-1' });
    expect(bulanKedua.menyelesaikan).toBe(true);

    const statusRow = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM pendapatan_diterima_dimuka WHERE id = 'dimuka-1'`
    );
    expect(statusRow?.status).toBe('SELESAI');

    await expect(
      prosesPengakuanPendapatanDimuka({ pendapatanDimukaId: 'dimuka-1', periode: '2026-03', createdBy: 'user-1' })
    ).rejects.toThrow(/sudah SELESAI/);
  });

  test('jalankanPengakuanPeriode: batch proses, lewati yang belum mulai', async () => {
    await seedDimuka(testDb, 'dimuka-1', 'anggota-1', 12_000_000, 12, '2026-01-10');
    await seedDimuka(testDb, 'dimuka-2', 'anggota-1', 6_000_000, 6, '2026-05-01'); // belum mulai di Feb

    const hasil = await jalankanPengakuanPeriode('2026-02', 'user-1');

    expect(hasil.diproses).toHaveLength(1);
    expect(hasil.diproses[0].pendapatanDimukaId).toBe('dimuka-1');
    expect(hasil.dilewati.some((d) => d.pendapatanDimukaId === 'dimuka-2')).toBe(true);

    const hasilKedua = await jalankanPengakuanPeriode('2026-02', 'user-1');
    expect(hasilKedua.diproses).toHaveLength(0);

    const daftarJurnal = await listJurnalPengakuanDimuka({ periode: '2026-02' });
    expect(daftarJurnal).toHaveLength(1);
  });

  test('getStatusPengakuanPeriode: klasifikasi status benar', async () => {
    await seedDimuka(testDb, 'dimuka-1', 'anggota-1', 2_000_000, 2, '2026-01-01');

    const statusJan = await getStatusPengakuanPeriode('2026-01');
    expect(statusJan.find((s) => s.pendapatanDimukaId === 'dimuka-1')?.status).toBe('SIAP_DIPROSES');

    await prosesPengakuanPendapatanDimuka({ pendapatanDimukaId: 'dimuka-1', periode: '2026-01', createdBy: 'user-1' });
    const statusJanSetelah = await getStatusPengakuanPeriode('2026-01');
    expect(statusJanSetelah.find((s) => s.pendapatanDimukaId === 'dimuka-1')?.status).toBe('SUDAH_DIPROSES');

    const statusMaret = await getStatusPengakuanPeriode('2026-03');
    expect(statusMaret.find((s) => s.pendapatanDimukaId === 'dimuka-1')?.status).toBe('SELESAI');
  });
});

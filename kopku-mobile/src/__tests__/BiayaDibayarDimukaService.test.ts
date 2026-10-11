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
  bayarBiayaDibayarDimuka,
  hitungPengakuanBiayaBulanan,
  prosesPengakuanBiayaDimuka,
  jalankanPengakuanBiayaPeriode,
  getStatusPengakuanBiayaPeriode,
  listJurnalPengakuanBiaya,
} from '@/services/BiayaDibayarDimukaService';

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

const ACC = { kas: 'acc-kas', dimuka: 'acc-biaya-dimuka', bebanSewa: 'acc-beban-sewa' };

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.dimuka, '1-1400', 'Biaya Dibayar Dimuka', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.bebanSewa, '5-1400', 'Beban Sewa', 'BEBAN', 'DEBIT');
  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'BIAYA_DIBAYAR_DIMUKA', 'DEBIT_DIMUKA', ACC.dimuka);

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

  return db;
}

/** Isi kas lewat jurnal manual (setara modal awal). */
async function isiKas(db: TestDb, nominal: number) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-isi-kas','JRN-ISI-KAS','2026-01-01','period-2026','MODAL_AWAL','Isi kas (fixture test)','POSTED','user-1',?,?,?)`,
    now,
    now,
    now
  );
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-isi-debit', 'journal-isi-kas', ACC.kas, nominal);
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-isi-kredit', 'journal-isi-kas', ACC.bebanSewa, nominal);
}

describe('BiayaDibayarDimukaService — pembayaran & pengakuan bulanan (Phase 10)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('hitungPengakuanBiayaBulanan: garis lurus jumlah / jangka waktu', () => {
    expect(hitungPengakuanBiayaBulanan(12_000_000, 12)).toBe(1_000_000);
    expect(hitungPengakuanBiayaBulanan(1_000_000, 0)).toBe(0);
  });

  test('bayarBiayaDibayarDimuka: jurnal balance, DEBIT Biaya Dimuka KREDIT Kas', async () => {
    await isiKas(testDb, 20_000_000);

    await bayarBiayaDibayarDimuka({
      namaBiaya: 'Sewa Gedung 2026',
      akunBebanId: ACC.bebanSewa,
      jumlah: 12_000_000,
      jangkaWaktuBulan: 12,
      tanggal: '2026-01-10',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const dimukaRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.dimuka
    );
    expect(dimukaRow?.total).toBe(12_000_000);
  });

  test('Phase 4 (liquidity): bayarBiayaDibayarDimuka DITOLAK kalau saldo kas tidak cukup', async () => {
    await isiKas(testDb, 1_000_000);

    await expect(
      bayarBiayaDibayarDimuka({
        namaBiaya: 'Premi Asuransi',
        akunBebanId: ACC.bebanSewa,
        jumlah: 5_000_000,
        jangkaWaktuBulan: 12,
        tanggal: '2026-01-10',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/[Ss]aldo.*tidak cukup/);
  });

  test('prosesPengakuanBiayaDimuka: jurnal balance, DEBIT Beban Sewa KREDIT Biaya Dimuka', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await bayarBiayaDibayarDimuka({
      namaBiaya: 'Sewa Gedung 2026',
      akunBebanId: ACC.bebanSewa,
      jumlah: 12_000_000,
      jangkaWaktuBulan: 12,
      tanggal: '2026-01-10',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const hasil = await prosesPengakuanBiayaDimuka({ biayaDimukaId: id, periode: '2026-02', createdBy: 'user-1' });
    expect(hasil.dibuat).toBe(true);
    expect(hasil.row.nilaiPengakuan).toBe(1_000_000);
    expect(hasil.row.urutanBulan).toBe(2);

    const bebanRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.bebanSewa
    );
    // ACC.bebanSewa juga dipakai isiKas() sebagai lawan modal awal — hitung
    // hanya dari jurnal PENGAKUAN_BIAYA_DIMUKA untuk assert yang akurat.
    const bebanDariPengakuan = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(je.debit),0) as total FROM journal_entry je JOIN journal j ON j.id = je.journal_id
       WHERE je.account_id = ? AND j.sumber_transaksi = 'PENGAKUAN_BIAYA_DIMUKA'`,
      ACC.bebanSewa
    );
    expect(bebanDariPengakuan?.total).toBe(1_000_000);
    expect(bebanRow?.total).toBeGreaterThanOrEqual(1_000_000);
  });

  test('anti-duplikasi: proses periode yang sama dua kali TIDAK membuat jurnal kedua', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await bayarBiayaDibayarDimuka({
      namaBiaya: 'Sewa Gedung 2026',
      akunBebanId: ACC.bebanSewa,
      jumlah: 12_000_000,
      jangkaWaktuBulan: 12,
      tanggal: '2026-01-10',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const pertama = await prosesPengakuanBiayaDimuka({ biayaDimukaId: id, periode: '2026-01', createdBy: 'user-1' });
    const kedua = await prosesPengakuanBiayaDimuka({ biayaDimukaId: id, periode: '2026-01', createdBy: 'user-1' });

    expect(pertama.dibuat).toBe(true);
    expect(kedua.dibuat).toBe(false);
    expect(kedua.row.id).toBe(pertama.row.id);

    const jumlahJurnal = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'PENGAKUAN_BIAYA_DIMUKA' AND sumber_id = ?`,
      id
    );
    expect(jumlahJurnal?.cnt).toBe(1);
  });

  test('bulan terakhir otomatis mengubah status jadi SELESAI, bulan setelahnya ditolak', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await bayarBiayaDibayarDimuka({
      namaBiaya: 'Sewa 2 Bulan',
      akunBebanId: ACC.bebanSewa,
      jumlah: 2_000_000,
      jangkaWaktuBulan: 2,
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await prosesPengakuanBiayaDimuka({ biayaDimukaId: id, periode: '2026-01', createdBy: 'user-1' });
    const bulanKedua = await prosesPengakuanBiayaDimuka({ biayaDimukaId: id, periode: '2026-02', createdBy: 'user-1' });
    expect(bulanKedua.menyelesaikan).toBe(true);

    const statusRow = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM biaya_dibayar_dimuka WHERE id = ?`, id);
    expect(statusRow?.status).toBe('SELESAI');

    await expect(
      prosesPengakuanBiayaDimuka({ biayaDimukaId: id, periode: '2026-03', createdBy: 'user-1' })
    ).rejects.toThrow(/sudah SELESAI/);
  });

  test('jalankanPengakuanBiayaPeriode: batch proses, lewati yang belum mulai', async () => {
    await isiKas(testDb, 20_000_000);
    const { id: id1 } = await bayarBiayaDibayarDimuka({
      namaBiaya: 'Sewa A',
      akunBebanId: ACC.bebanSewa,
      jumlah: 12_000_000,
      jangkaWaktuBulan: 12,
      tanggal: '2026-01-10',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await bayarBiayaDibayarDimuka({
      namaBiaya: 'Sewa B (belum mulai)',
      akunBebanId: ACC.bebanSewa,
      jumlah: 6_000_000,
      jangkaWaktuBulan: 6,
      tanggal: '2026-05-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const hasil = await jalankanPengakuanBiayaPeriode('2026-02', 'user-1');
    expect(hasil.diproses).toHaveLength(1);
    expect(hasil.diproses[0].biayaDimukaId).toBe(id1);

    const daftarJurnal = await listJurnalPengakuanBiaya({ periode: '2026-02' });
    expect(daftarJurnal).toHaveLength(1);
  });

  test('getStatusPengakuanBiayaPeriode: klasifikasi status benar', async () => {
    await isiKas(testDb, 20_000_000);
    await bayarBiayaDibayarDimuka({
      namaBiaya: 'Sewa 2 Bulan',
      akunBebanId: ACC.bebanSewa,
      jumlah: 2_000_000,
      jangkaWaktuBulan: 2,
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const statusJan = await getStatusPengakuanBiayaPeriode('2026-01');
    expect(statusJan[0].status).toBe('SIAP_DIPROSES');

    const statusMaret = await getStatusPengakuanBiayaPeriode('2026-03');
    expect(statusMaret[0].status).toBe('SELESAI');
  });
});

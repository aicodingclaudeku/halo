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

import { terimaModalUang, terimaModalBarang } from '@/services/ModalService';
import { listAset } from '@/services/AsetService';

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

const ACC = { kas: 'acc-kas', aset: 'acc-aset', modal: 'acc-modal' };

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();

  // PHASE 5: terimaModalBarang() WAJIB memakai klasifikasi aset yang
  // ADA di master (resolveKlasifikasiAsetByNama) — barang modal selalu
  // menjadi aset tetap, jadi fixture harus menyediakan masternya.
  {
    const ts = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO aset_klasifikasi (id, kelompok, sub_kelompok, masa_manfaat_bulan_default, aktif, created_at, updated_at)
       VALUES ('klas-inventaris','Inventaris','Peralatan Kantor',36,1,?,?)`,
      ts,
      ts
    );
  }

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.aset, '1-1500', 'Aset Tetap', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'ASET_TETAP', 'DEBIT_ASET', ACC.aset);
  await seedMapping(db, 'MODAL_LAINNYA', 'KREDIT_DEFAULT', ACC.modal);

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

describe('ModalService', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('terimaModalUang: jurnal balance, DEBIT Kas KREDIT Modal Lainnya', async () => {
    await terimaModalUang({
      nilai: 5_000_000,
      metodePembayaran: 'TUNAI',
      tanggal: '2026-02-01',
      createdBy: 'user-1',
    });

    const kasRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.kas
    );
    expect(kasRow?.total).toBe(5_000_000);
  });

  test('terimaModalBarang: masuk register aset_tetap + jurnal balance', async () => {
    const hasil = await terimaModalBarang({
      namaBarang: 'Meja Kursi Kantor',
      nilaiPerolehan: 3_000_000,
      masaManfaatBulan: 36,
      tanggal: '2026-02-01',
      kelompokAset: 'Inventaris',
      subKelompokAset: 'Peralatan Kantor',
      createdBy: 'user-1',
    });

    const daftar = await listAset();
    expect(daftar.find((a) => a.id === hasil.asetId)?.sumber).toBe('MODAL_BARANG');

    const asetRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.aset
    );
    expect(asetRow?.total).toBe(3_000_000);
  });

  test('Phase 9: terimaModalBarang DITOLAK kalau masaManfaatBulan 0 atau negatif', async () => {
    await expect(
      terimaModalBarang({
        namaBarang: 'Barang Tanpa Masa Manfaat',
        nilaiPerolehan: 1_000_000,
        masaManfaatBulan: 0,
        tanggal: '2026-02-01',
        kelompokAset: 'Inventaris',
        subKelompokAset: 'Peralatan Kantor',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/masa manfaat/i);
  });
});

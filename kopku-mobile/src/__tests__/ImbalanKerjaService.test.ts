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

import { akruiImbalanKerja, getSaldoUtangImbalanKerjaSaatIni } from '@/services/ImbalanKerjaService';
import { createJournal } from '@/accounting/AccountingEngine';

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

const ACC = { kas: 'acc-kas', bebanImbalan: 'acc-beban-imbalan', utangImbalan: 'acc-utang-imbalan' };

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.bebanImbalan, '5-1050', 'Beban Imbalan Kerja', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.utangImbalan, '2-1600', 'Utang Imbalan Kerja', 'LIABILITAS', 'KREDIT');
  await seedMapping(db, 'UTANG_IMBALAN_KERJA', 'DEBIT_BEBAN', ACC.bebanImbalan);
  await seedMapping(db, 'UTANG_IMBALAN_KERJA', 'KREDIT_DEFAULT', ACC.utangImbalan);

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

describe('ImbalanKerjaService — akrual kewajiban imbalan kerja (Prioritas 9/K)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('akruiImbalanKerja: DEBIT Beban Imbalan Kerja = KREDIT Utang Imbalan Kerja, jurnal balance, TIDAK menyentuh kas', async () => {
    await akruiImbalanKerja({
      tanggal: '2026-11-01',
      nominal: 5_000_000,
      keterangan: 'Provisi THR 2026',
      createdBy: 'user-1',
    });

    const beban = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.bebanImbalan
    );
    const utang = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.utangImbalan
    );
    const kas = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) + COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.kas
    );
    expect(beban?.total).toBe(5_000_000);
    expect(utang?.total).toBe(5_000_000);
    expect(kas?.total ?? 0).toBe(0);
  });

  test('getSaldoUtangImbalanKerjaSaatIni: mencerminkan akumulasi akrual dikurangi pembayaran (via jurnal manual akun lawan Utang Imbalan Kerja)', async () => {
    await akruiImbalanKerja({
      tanggal: '2026-11-01',
      nominal: 5_000_000,
      keterangan: 'Provisi THR 2026',
      createdBy: 'user-1',
    });
    let saldo = await getSaldoUtangImbalanKerjaSaatIni('2026-12-31');
    expect(saldo).toBe(5_000_000);

    // Simulasi pembayaran sebagian lewat jalur Kas & Bank umum (akun
    // lawan "Utang Imbalan Kerja" dipilih via AccountPicker — di test
    // ini cukup lewat createJournal langsung, sesuai pola app: DEBIT
    // Utang Imbalan Kerja, KREDIT Kas).
    await createJournal(testDb as any, {
      tanggal: '2026-12-20',
      sumberTransaksi: 'KAS_PENGELUARAN_LAIN',
      deskripsi: 'Pembayaran THR sebagian',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.utangImbalan, debit: 2_000_000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 2_000_000 },
      ],
    });

    saldo = await getSaldoUtangImbalanKerjaSaatIni('2026-12-31');
    expect(saldo).toBe(3_000_000);
  });

  test('akruiImbalanKerja: DITOLAK kalau nominal 0/negatif', async () => {
    await expect(
      akruiImbalanKerja({ tanggal: '2026-11-01', nominal: 0, keterangan: 'Test', createdBy: 'user-1' })
    ).rejects.toThrow(/[Nn]ominal/);
    await expect(
      akruiImbalanKerja({ tanggal: '2026-11-01', nominal: -100, keterangan: 'Test', createdBy: 'user-1' })
    ).rejects.toThrow(/[Nn]ominal/);
  });

  test('akruiImbalanKerja: DITOLAK kalau keterangan kosong', async () => {
    await expect(
      akruiImbalanKerja({ tanggal: '2026-11-01', nominal: 1_000_000, keterangan: '  ', createdBy: 'user-1' })
    ).rejects.toThrow(/[Kk]eterangan/);
  });
});

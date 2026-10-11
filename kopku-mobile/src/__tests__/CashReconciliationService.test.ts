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

import { catatRekonsiliasi, listRekonsiliasi, getRekonsiliasiTerakhirPerAkun } from '@/services/CashReconciliationService';

async function seedAccount(db: TestDb, id: string, kode: string, nama: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id,
    kode,
    nama,
    'ASET',
    'DEBIT',
    now,
    now
  );
}

const ACC_KAS = 'acc-kas';
const ACC_MODAL = 'acc-modal';

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC_KAS, '1-1000', 'Kas');
  await seedAccount(db, ACC_MODAL, '3-3000', 'Modal Lainnya');
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  return db;
}

async function isiKas(db: TestDb, nominal: number, tanggal: string) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    `journal-${tanggal}`,
    `JRN-${tanggal}`,
    tanggal,
    'period-2026',
    'MODAL_AWAL',
    'Isi kas (fixture test)',
    'POSTED',
    'user-1',
    now,
    now,
    now
  );
  await seedAccount(db, `${ACC_KAS}-modal`, '3-3000', 'Modal Lainnya').catch(() => {});
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, `je-${tanggal}-d`, `journal-${tanggal}`, ACC_KAS, nominal);
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`,
    `je-${tanggal}-k`,
    `journal-${tanggal}`,
    ACC_MODAL,
    nominal
  );
}

describe('CashReconciliationService (Phase 11)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('catatRekonsiliasi: status COCOK kalau saldo fisik = saldo buku', async () => {
    await isiKas(testDb, 1_000_000, '2026-01-05');

    const hasil = await catatRekonsiliasi({
      accountId: ACC_KAS,
      namaRekening: 'Kas',
      tanggal: '2026-01-31',
      saldoFisik: 1_000_000,
      createdBy: 'user-1',
    });

    expect(hasil.status).toBe('COCOK');
    expect(hasil.selisih).toBe(0);
  });

  test('catatRekonsiliasi: status SELISIH kalau saldo fisik != saldo buku', async () => {
    await isiKas(testDb, 1_000_000, '2026-01-05');

    const hasil = await catatRekonsiliasi({
      accountId: ACC_KAS,
      namaRekening: 'Kas',
      tanggal: '2026-01-31',
      saldoFisik: 950_000, // fisik lebih kecil dari buku
      createdBy: 'user-1',
    });

    expect(hasil.status).toBe('SELISIH');
    expect(hasil.selisih).toBe(-50_000);
  });

  test('listRekonsiliasi: urut dari terbaru', async () => {
    await isiKas(testDb, 500_000, '2026-01-05');
    await catatRekonsiliasi({ accountId: ACC_KAS, namaRekening: 'Kas', tanggal: '2026-01-15', saldoFisik: 500_000, createdBy: 'user-1' });
    await catatRekonsiliasi({ accountId: ACC_KAS, namaRekening: 'Kas', tanggal: '2026-01-31', saldoFisik: 400_000, createdBy: 'user-1' });

    const daftar = await listRekonsiliasi({ accountId: ACC_KAS });
    expect(daftar).toHaveLength(2);
    expect(daftar[0].tanggal).toBe('2026-01-31'); // terbaru duluan
  });

  test('getRekonsiliasiTerakhirPerAkun: kalau rekonsiliasi TERAKHIR sudah COCOK, tidak dianggap bermasalah lagi', async () => {
    await isiKas(testDb, 1_000_000, '2026-01-05');
    // Pertama SELISIH...
    await catatRekonsiliasi({ accountId: ACC_KAS, namaRekening: 'Kas', tanggal: '2026-01-15', saldoFisik: 900_000, createdBy: 'user-1' });
    // ...lalu dicek ulang & COCOK.
    await catatRekonsiliasi({ accountId: ACC_KAS, namaRekening: 'Kas', tanggal: '2026-01-20', saldoFisik: 1_000_000, createdBy: 'user-1' });

    const terakhir = await getRekonsiliasiTerakhirPerAkun(testDb as any, '2026-01-31');
    expect(terakhir.find((r) => r.accountId === ACC_KAS)?.status).toBe('COCOK');
  });

  test('getRekonsiliasiTerakhirPerAkun: rekonsiliasi TERAKHIR masih SELISIH, tetap dianggap bermasalah', async () => {
    await isiKas(testDb, 1_000_000, '2026-01-05');
    await catatRekonsiliasi({ accountId: ACC_KAS, namaRekening: 'Kas', tanggal: '2026-01-15', saldoFisik: 1_000_000, createdBy: 'user-1' });
    await catatRekonsiliasi({ accountId: ACC_KAS, namaRekening: 'Kas', tanggal: '2026-01-31', saldoFisik: 800_000, createdBy: 'user-1' });

    const terakhir = await getRekonsiliasiTerakhirPerAkun(testDb as any, '2026-01-31');
    expect(terakhir.find((r) => r.accountId === ACC_KAS)?.status).toBe('SELISIH');
  });

  test('PHASE 1.1 (harden): "terakhir" ditentukan dari TANGGAL rekonsiliasi, bukan urutan input (rowid) — 31 Des (SELISIH) tetap dianggap terbaru walau 30 Des (COCOK) baru dicatat belakangan', async () => {
    await isiKas(testDb, 1_000_000, '2026-01-05');

    // 31 Des dicatat LEBIH DULU (rowid lebih kecil) — SELISIH.
    await catatRekonsiliasi({ accountId: ACC_KAS, namaRekening: 'Kas', tanggal: '2026-12-31', saldoFisik: 900_000, createdBy: 'user-1' });
    // 30 Des BARU dicatat BELAKANGAN (rowid lebih besar, created_at
    // lebih baru dari 31 Des) — COCOK. Skenario nyata: petugas lupa
    // mencatat rekonsiliasi 30 Des, baru menyusulkannya setelah sudah
    // sempat mencatat rekonsiliasi 31 Des lebih dulu.
    await catatRekonsiliasi({ accountId: ACC_KAS, namaRekening: 'Kas', tanggal: '2026-12-30', saldoFisik: 1_000_000, createdBy: 'user-1' });

    const terakhir = await getRekonsiliasiTerakhirPerAkun(testDb as any, '2026-12-31');
    const kas = terakhir.find((r) => r.accountId === ACC_KAS);
    // HARUS tetap dianggap 31 Des (SELISIH) sebagai yang terbaru —
    // BUKAN 30 Des (COCOK) walau rowid/urutan-input 30 Des lebih besar
    // (bug lama: MAX(rowid) akan salah memilih 30 Des di sini).
    expect(kas?.tanggal).toBe('2026-12-31');
    expect(kas?.status).toBe('SELISIH');
  });
});

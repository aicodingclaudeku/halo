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
  createAccount,
  updateAccount,
  setAccountActive,
  isAccountInUse,
  listAllAccounts,
  getAccountById,
  getAccountsForPenerimaanPenghasilanLain,
} from '@/repositories/AccountRepository';
import { newId } from '@/utils/id';

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  return db;
}

describe('AccountRepository — Input Akun (Phase 17 §Q)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('createAccount menyimpan akun baru dengan saldo normal & kategori yang benar', async () => {
    const akun = await createAccount('user-1', {
      kode: '1-1700',
      nama: 'Peralatan Kantor',
      kategori: 'ASET',
      normalBalance: 'DEBIT',
    });
    expect(akun.kode).toBe('1-1700');
    expect(akun.kategori).toBe('ASET');
    expect(akun.normalBalance).toBe('DEBIT');
    expect(akun.isActive).toBe(true);
  });

  test('akun baru OTOMATIS muncul di listAllAccounts (satu sumber COA, bukan tabel kedua)', async () => {
    await createAccount('user-1', { kode: '5-2000', nama: 'Beban Baru', kategori: 'BEBAN', normalBalance: 'DEBIT' });
    const semua = await listAllAccounts();
    expect(semua.some((a) => a.kode === '5-2000' && a.nama === 'Beban Baru')).toBe(true);
  });

  test('createAccount menolak kode akun duplikat', async () => {
    await createAccount('user-1', { kode: '1-1800', nama: 'Akun A', kategori: 'ASET', normalBalance: 'DEBIT' });
    await expect(
      createAccount('user-1', { kode: '1-1800', nama: 'Akun B', kategori: 'ASET', normalBalance: 'DEBIT' })
    ).rejects.toThrow(/sudah dipakai/);
  });

  test('createAccount dengan parentId valid tersimpan dengan hierarchy benar', async () => {
    const induk = await createAccount('user-1', { kode: '1-2000', nama: 'Induk Aset', kategori: 'ASET', normalBalance: 'DEBIT' });
    const anak = await createAccount('user-1', {
      kode: '1-2001',
      nama: 'Anak Aset',
      kategori: 'ASET',
      normalBalance: 'DEBIT',
      parentId: induk.id,
    });
    expect(anak.parentId).toBe(induk.id);
    expect(anak.parentNama).toBe('Induk Aset');
  });

  test('createAccount menolak parentId yang tidak ditemukan', async () => {
    await expect(
      createAccount('user-1', { kode: '1-2100', nama: 'Akun X', kategori: 'ASET', normalBalance: 'DEBIT', parentId: 'tidak-ada' })
    ).rejects.toThrow(/induk/i);
  });

  test('updateAccount mengubah data akun & tetap unik kode', async () => {
    const akun = await createAccount('user-1', { kode: '1-3000', nama: 'Nama Lama', kategori: 'ASET', normalBalance: 'DEBIT' });
    await updateAccount('user-1', akun.id, { kode: '1-3000', nama: 'Nama Baru', kategori: 'ASET', normalBalance: 'DEBIT' });
    const updated = await getAccountById(akun.id);
    expect(updated?.nama).toBe('Nama Baru');
  });

  test('update pasca-Phase 18 §2: akun BELUM dipakai jurnal — kode/kategori/normal balance BEBAS diubah', async () => {
    const akun = await createAccount('user-1', { kode: '1-3100', nama: 'Akun Baru', kategori: 'ASET', normalBalance: 'DEBIT' });
    await updateAccount('user-1', akun.id, { kode: '1-3200', nama: 'Akun Baru', kategori: 'BEBAN', normalBalance: 'DEBIT' });
    const updated = await getAccountById(akun.id);
    expect(updated?.kode).toBe('1-3200');
    expect(updated?.kategori).toBe('BEBAN');
  });

  test('update pasca-Phase 18 §2: akun SUDAH dipakai jurnal — kode/kategori/normal balance TERKUNCI, nama tetap bisa diubah', async () => {
    const akun = await createAccount('user-1', { kode: '1-3300', nama: 'Nama Lama', kategori: 'ASET', normalBalance: 'DEBIT' });
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      'period-2026',
      2026,
      '2026-01-01',
      '2026-12-31'
    );
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('journal-1','JRN-1','2026-01-01','period-2026','TEST','Test','POSTED','user-1',?,?,?)`,
      now,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-1','journal-1',?,?,0)`,
      akun.id,
      100000
    );

    // Kode berubah -> ditolak.
    await expect(updateAccount('user-1', akun.id, { kode: '1-3399', nama: 'Nama Lama', kategori: 'ASET', normalBalance: 'DEBIT' })).rejects.toThrow(
      /[Kk]ode akun tidak dapat diubah/
    );
    // Kategori berubah -> ditolak.
    await expect(updateAccount('user-1', akun.id, { kode: '1-3300', nama: 'Nama Lama', kategori: 'BEBAN', normalBalance: 'DEBIT' })).rejects.toThrow(
      /[Tt]ipe\/kategori akun tidak dapat diubah/
    );
    // Normal balance berubah -> ditolak.
    await expect(updateAccount('user-1', akun.id, { kode: '1-3300', nama: 'Nama Lama', kategori: 'ASET', normalBalance: 'KREDIT' })).rejects.toThrow(
      /[Ss]aldo normal akun tidak dapat diubah/
    );
    // Nama berubah (field aman) -> BERHASIL, walau akun sudah dipakai jurnal.
    await updateAccount('user-1', akun.id, { kode: '1-3300', nama: 'Nama Baru Aman', kategori: 'ASET', normalBalance: 'DEBIT' });
    const updated = await getAccountById(akun.id);
    expect(updated?.nama).toBe('Nama Baru Aman');
    expect(updated?.kode).toBe('1-3300'); // tidak berubah
  });

  test('update pasca-Phase 18 §2: akun SISTEM (is_system) — kode/kategori/normal balance TERKUNCI walau belum pernah dipakai jurnal', async () => {
    const now = new Date().toISOString();
    const idSystem = newId();
    await testDb.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES (?,?,?,?,?,1,1,?,?)`,
      idSystem,
      '1-1000',
      'Kas',
      'ASET',
      'DEBIT',
      now,
      now
    );

    await expect(updateAccount('user-1', idSystem, { kode: '1-1099', nama: 'Kas', kategori: 'ASET', normalBalance: 'DEBIT' })).rejects.toThrow(
      /[Kk]ode akun sistem tidak dapat diubah/
    );
    // Nama akun sistem tetap boleh diubah.
    await updateAccount('user-1', idSystem, { kode: '1-1000', nama: 'Kas Tunai Koperasi', kategori: 'ASET', normalBalance: 'DEBIT' });
    const updated = await getAccountById(idSystem);
    expect(updated?.nama).toBe('Kas Tunai Koperasi');
  });

  test('setAccountActive menonaktifkan akun (soft delete) — akun tetap ada, hanya is_active = false', async () => {
    const akun = await createAccount('user-1', { kode: '1-4000', nama: 'Akun Nonaktif', kategori: 'ASET', normalBalance: 'DEBIT' });
    await setAccountActive('user-1', akun.id, false);
    const setelah = await getAccountById(akun.id);
    expect(setelah?.isActive).toBe(false);
    expect(setelah?.nama).toBe('Akun Nonaktif'); // datanya tidak hilang
  });

  test('setAccountActive menolak nonaktifkan akun inti (is_system)', async () => {
    const now = new Date().toISOString();
    const idSystem = newId();
    await testDb.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES (?,?,?,?,?,1,1,?,?)`,
      idSystem,
      '1-1000',
      'Kas',
      'ASET',
      'DEBIT',
      now,
      now
    );
    await expect(setAccountActive('user-1', idSystem, false)).rejects.toThrow(/inti/i);
  });

  test('isAccountInUse mendeteksi akun yang sudah dipakai di journal_entry', async () => {
    const akun = await createAccount('user-1', { kode: '1-5000', nama: 'Akun Dipakai', kategori: 'ASET', normalBalance: 'DEBIT' });
    expect(await isAccountInUse(akun.id)).toBe(false);

    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      'period-2026',
      2026,
      '2026-01-01',
      '2026-12-31'
    );
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('journal-1','JRN-1','2026-01-01','period-2026','TEST','Test','POSTED','user-1',?,?,?)`,
      now,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`,
      'je-1',
      'journal-1',
      akun.id,
      100000
    );
    expect(await isAccountInUse(akun.id)).toBe(true);
  });
});

describe('getAccountsForPenerimaanPenghasilanLain (update pasca-Phase 18 §1)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('HANYA mengembalikan 4-2000 & 4-3000 — akun pendapatan lain TIDAK muncul', async () => {
    await createAccount('user-1', { kode: '4-2000', nama: 'Pendapatan Usaha Lain', kategori: 'PENDAPATAN', normalBalance: 'KREDIT' });
    await createAccount('user-1', { kode: '4-3000', nama: 'Pendapatan Lainnya', kategori: 'PENDAPATAN', normalBalance: 'KREDIT' });
    // Akun pendapatan LAIN yang TIDAK boleh muncul di picker ini.
    await createAccount('user-1', { kode: '4-1000', nama: 'Pendapatan Jasa Pinjaman', kategori: 'PENDAPATAN', normalBalance: 'KREDIT' });
    await createAccount('user-1', { kode: '4-1100', nama: 'Pendapatan Administrasi', kategori: 'PENDAPATAN', normalBalance: 'KREDIT' });

    const hasil = await getAccountsForPenerimaanPenghasilanLain();
    const kode = hasil.map((a) => a.kode).sort();
    expect(kode).toEqual(['4-2000', '4-3000']);
    expect(hasil.every((a) => a.kategori === 'PENDAPATAN')).toBe(true);
    expect(hasil.find((a) => a.kode === '4-2000')?.nama).toBe('Pendapatan Usaha Lain');
    expect(hasil.find((a) => a.kode === '4-3000')?.nama).toBe('Pendapatan Lainnya');
  });

  test('akun 4-2000/4-3000 yang NONAKTIF tidak ikut muncul (konsisten dengan picker aktif lain)', async () => {
    const a1 = await createAccount('user-1', { kode: '4-2000', nama: 'Pendapatan Usaha Lain', kategori: 'PENDAPATAN', normalBalance: 'KREDIT' });
    await createAccount('user-1', { kode: '4-3000', nama: 'Pendapatan Lainnya', kategori: 'PENDAPATAN', normalBalance: 'KREDIT' });
    await setAccountActive('user-1', a1.id, false);

    const hasil = await getAccountsForPenerimaanPenghasilanLain();
    expect(hasil.map((a) => a.kode)).toEqual(['4-3000']);
  });

  test('kalau akun 4-2000/4-3000 belum pernah dibuat, mengembalikan array kosong (bukan error/dummy data)', async () => {
    const hasil = await getAccountsForPenerimaanPenghasilanLain();
    expect(hasil).toEqual([]);
  });

  test('transaksi dengan akun 4-2000 tetap menghasilkan jurnal balance (via catatPemasukan, generic & tidak berubah)', async () => {
    const akun = await createAccount('user-1', { kode: '4-2000', nama: 'Pendapatan Usaha Lain', kategori: 'PENDAPATAN', normalBalance: 'KREDIT' });
    const kas = await createAccount('user-1', { kode: '1-1000', nama: 'Kas', kategori: 'ASET', normalBalance: 'DEBIT' });
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-kas','KAS_UMUM','DEFAULT',?)`,
      kas.id
    );
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      'period-2026',
      2026,
      '2026-01-01',
      '2026-12-31'
    );

    const { catatPemasukan } = await import('@/services/KasBankService');
    const { journalId } = await catatPemasukan({
      jenis: 'KAS',
      tanggal: '2026-02-01',
      nominal: 750_000,
      akunLawanId: akun.id,
      keterangan: 'Penghasilan lain',
      createdBy: 'user-1',
    });

    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`,
      journalId
    );
    const totalDebit = entries.reduce((a, e) => a + e.debit, 0);
    const totalKredit = entries.reduce((a, e) => a + e.kredit, 0);
    expect(totalDebit).toBe(totalKredit);
    expect(totalDebit).toBe(750_000);
  });
});

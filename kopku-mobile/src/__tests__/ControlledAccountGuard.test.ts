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
  resolveAccountId,
  resolveKasBankAccountId,
  MissingAccountMappingError,
  InactiveAccountError,
  InactiveBankAccountError,
} from '@/accounting/AccountMapping';
import { ajukanPinjaman, cairkanPinjaman } from '@/services/PinjamanService';

/**
 * BUG-02 — CONTROLLED ACCOUNT.
 *
 * Klaim yang diuji: TIDAK ADA jalur posting yang memakai akun lawan
 * generik, akun default, atau "akun pertama yang ketemu". Setiap event
 * akuntansi mengambil akunnya lewat `resolveAccountId(transaction_type,
 * role)`, dan resolver itu GAGAL KERAS bila mappingnya tidak ada atau
 * akunnya sudah dinonaktifkan.
 *
 * Yang penting bukan cuma "melempar error", tetapi bahwa kegagalan itu
 * TIDAK meninggalkan state parsial — tanpa itu, transaksi bisa
 * setengah terbukukan dan buku besar rusak diam-diam.
 */

const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  bank: 'acc-bank',
  modal: 'acc-modal',
  nonaktif: 'acc-nonaktif',
};

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  normalBalance: 'DEBIT' | 'KREDIT',
  aktif = 1
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)`,
    id, kode, nama, kategori, normalBalance, aktif, now, now
  );
}

beforeEach(async () => {
  testDb = await createTestDb();
  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.bank, '1-1100', 'Bank BRI', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.nonaktif, '1-9999', 'Akun Sudah Ditutup', 'ASET', 'DEBIT', 0);

  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m1','KAS_UMUM','DEFAULT',?)`,
    ACC.kas
  );
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m2','PENCAIRAN_PINJAMAN','DEBIT_PIUTANG',?)`,
    ACC.piutangPokok
  );
  await testDb.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m3','TRANSAKSI_UJI','DEBIT_NONAKTIF',?)`,
    ACC.nonaktif
  );

  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES ('p26',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('anggota-1','A001','1234567890123456','Budi','2020-01-01','AKTIF',?,?)`,
    now, now
  );
  for (const [id, jenis, nominal] of [['sp', 'POKOK', 100000], ['sw', 'WAJIB', 50000]] as const) {
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?, 'anggota-1', ?, 'SETOR','2020-01-01',?,'KAS',?,'user-1',?)`,
      id, jenis, nominal, id, now
    );
  }
});

describe('BUG-02 — resolver akun gagal keras, tidak pernah memakai fallback', () => {
  test('mapping tidak ada -> MissingAccountMappingError dengan pesan yang menyebut event & role', async () => {
    await expect(
      resolveAccountId(testDb as any, 'TRANSAKSI_TIDAK_DIPETAKAN', 'KREDIT_ENTAH')
    ).rejects.toThrow(MissingAccountMappingError);

    await expect(
      resolveAccountId(testDb as any, 'TRANSAKSI_TIDAK_DIPETAKAN', 'KREDIT_ENTAH')
    ).rejects.toThrow(/TRANSAKSI_TIDAK_DIPETAKAN.*KREDIT_ENTAH/s);
  });

  test('TIDAK mengembalikan akun sembarangan meskipun banyak akun tersedia', async () => {
    // Ada 5 akun di database. Resolver TIDAK BOLEH memilih salah satunya
    // "yang penting ada" — itulah pola fallback yang dilarang.
    const jumlahAkun = await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM account`);
    expect(jumlahAkun!.n).toBeGreaterThan(1);
    await expect(resolveAccountId(testDb as any, 'APAPUN', 'DEFAULT')).rejects.toThrow(
      MissingAccountMappingError
    );
  });

  test('akun yang sudah dinonaktifkan ditolak untuk transaksi BARU', async () => {
    await expect(
      resolveAccountId(testDb as any, 'TRANSAKSI_UJI', 'DEBIT_NONAKTIF')
    ).rejects.toThrow(InactiveAccountError);
  });

  test('rekening bank nonaktif ditolak untuk transaksi baru (berbeda dari pelaporan historis)', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, saldo_awal, aktif, created_at)
       VALUES ('bank-1','Bank BRI','123','Koperasi',?,0,0,?)`,
      ACC.bank, now
    );
    await expect(
      resolveKasBankAccountId(testDb as any, 'BANK', 'bank-1')
    ).rejects.toThrow(InactiveBankAccountError);
  });

  test('sumber dana BANK tanpa rekening ditolak, tidak jatuh ke akun kas default', async () => {
    await expect(resolveKasBankAccountId(testDb as any, 'BANK')).rejects.toThrow(
      /bankAccountId wajib diisi/
    );
  });
});

describe('BUG-02 — mapping hilang tidak meninggalkan state parsial', () => {
  test('pencairan gagal karena mapping hilang: tidak ada jurnal, tidak ada perubahan subledger', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: 'anggota-1',
      tanggal: '2026-01-01',
      jumlahPinjaman: 12_000_000,
      tenor: 12,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });

    // Hapus mapping yang dibutuhkan jurnal pencairan.
    await testDb.runAsync(
      `DELETE FROM account_mapping WHERE transaction_type = 'PENCAIRAN_PINJAMAN' AND role = 'DEBIT_PIUTANG'`
    );

    const jurnalSebelum = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM journal`))!.n;
    const entrySebelum = (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM journal_entry`))!.n;
    const statusSebelum = (
      await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM pinjaman WHERE id = ?`, id)
    )!.status;

    await expect(
      cairkanPinjaman({
        pinjamanId: id,
        sumberDana: 'KAS',
        approvedBy: 'user-1',
        tanggalPencairan: '2026-01-01',
      })
    ).rejects.toThrow(MissingAccountMappingError);

    // Rollback penuh: tidak ada jejak apa pun.
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM journal`))!.n).toBe(jurnalSebelum);
    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM journal_entry`))!.n).toBe(entrySebelum);
    expect(
      (await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM pinjaman WHERE id = ?`, id))!.status
    ).toBe(statusSebelum);
  });
});

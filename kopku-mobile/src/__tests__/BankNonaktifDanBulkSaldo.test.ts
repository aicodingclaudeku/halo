import { createTestDb, TestDb } from './testDb';

let dbAktif: TestDb;

jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => dbAktif),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await dbAktif.withTransactionAsync(async () => {
      result = await fn(dbAktif);
    });
    return result;
  }),
}));

import {
  createJournal,
  getAccountBalance,
  getAccountBalancesBulk,
} from '@/accounting/AccountingEngine';
import { getArusKas, getAkunKasBankUntukLaporan } from '@/reports/FinancialReports';

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  modal: 'acc-modal',
  beban: 'acc-beban',
  pendapatan: 'acc-pendapatan',
};
const BANK_ACCOUNT_ID = 'bank-1';

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

async function setup(): Promise<void> {
  dbAktif = await createTestDb();
  await seedAccount(dbAktif, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(dbAktif, ACC.bank, '1-1100', 'Bank BRI', 'ASET', 'DEBIT');
  await seedAccount(dbAktif, ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(dbAktif, ACC.beban, '5-1000', 'Beban Operasional', 'BEBAN', 'DEBIT');
  await seedAccount(dbAktif, ACC.pendapatan, '4-1000', 'Pendapatan Jasa', 'PENDAPATAN', 'KREDIT');

  await dbAktif.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('m-kas','KAS_UMUM','DEFAULT',?)`,
    ACC.kas
  );

  const now = new Date().toISOString();
  await dbAktif.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, saldo_awal, aktif, created_at)
     VALUES (?,?,?,?,?,0,1,?)`,
    BANK_ACCOUNT_ID,
    'Bank BRI',
    '1234567890',
    'Koperasi Uji',
    ACC.bank,
    now
  );
  await dbAktif.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p-2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  await dbAktif.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );

  // Modal masuk ke BANK (bukan kas) — inilah histori yang harus tetap
  // terlihat setelah rekening dinonaktifkan.
  await createJournal(dbAktif as any, {
    tanggal: '2026-01-10',
    sumberTransaksi: 'MODAL_UANG',
    deskripsi: 'Setoran simpanan pokok via bank',
    createdBy: 'user-1',
    autoPost: true,
    lines: [
      { accountId: ACC.bank, debit: 20_000_000, kredit: 0 },
      { accountId: ACC.modal, debit: 0, kredit: 20_000_000 },
    ],
  });
  // Beban dibayar dari bank pada periode yang sama.
  await createJournal(dbAktif as any, {
    tanggal: '2026-02-15',
    sumberTransaksi: 'KAS_PENGELUARAN_LAIN',
    deskripsi: 'Bayar listrik via bank',
    createdBy: 'user-1',
    autoPost: true,
    lines: [
      { accountId: ACC.beban, debit: 500_000, kredit: 0 },
      { accountId: ACC.bank, debit: 0, kredit: 500_000 },
    ],
  });
  // Satu transaksi kas biasa sebagai pembanding.
  await createJournal(dbAktif as any, {
    tanggal: '2026-03-01',
    sumberTransaksi: 'KAS_PENERIMAAN_LAIN',
    deskripsi: 'Penerimaan tunai',
    createdBy: 'user-1',
    autoPost: true,
    lines: [
      { accountId: ACC.kas, debit: 1_000_000, kredit: 0 },
      { accountId: ACC.pendapatan, debit: 0, kredit: 1_000_000 },
    ],
  });
}

async function nonaktifkanBank(): Promise<void> {
  await dbAktif.runAsync(`UPDATE bank_account SET aktif = 0 WHERE id = ?`, BANK_ACCOUNT_ID);
}

describe('BUG-04 — akun bank nonaktif tetap muncul di laporan historis', () => {
  beforeEach(async () => {
    await setup();
  });

  test('himpunan akun kas/bank laporan TIDAK bergantung pada status aktif rekening', async () => {
    const sebelum = await getAkunKasBankUntukLaporan(dbAktif as any);
    await nonaktifkanBank();
    const sesudah = await getAkunKasBankUntukLaporan(dbAktif as any);

    expect(sebelum.map((a) => a.id).sort()).toEqual([ACC.bank, ACC.kas].sort());
    // INI inti BUG-04: menonaktifkan rekening tidak boleh mengubah
    // himpunan akun yang dibaca laporan historis.
    expect(sesudah.map((a) => a.id).sort()).toEqual(sebelum.map((a) => a.id).sort());
  });

  test('Arus Kas periode lampau menghasilkan angka yang SAMA sebelum & sesudah bank dinonaktifkan', async () => {
    const sebelum = await getArusKas(dbAktif as any, '2026-01-01', '2026-12-31');
    await nonaktifkanBank();
    const sesudah = await getArusKas(dbAktif as any, '2026-01-01', '2026-12-31');

    expect(sesudah.kasAwal).toBe(sebelum.kasAwal);
    expect(sesudah.kasAkhirAktual).toBe(sebelum.kasAkhirAktual);
    expect(sesudah.rincian.length).toBe(sebelum.rincian.length);
  });

  test('kas akhir mencakup saldo rekening nonaktif (bukan hilang begitu saja)', async () => {
    await nonaktifkanBank();
    const arus = await getArusKas(dbAktif as any, '2026-01-01', '2026-12-31');

    const saldoBank = await getAccountBalance(dbAktif as any, ACC.bank, '2026-12-31');
    const saldoKas = await getAccountBalance(dbAktif as any, ACC.kas, '2026-12-31');
    expect(saldoBank).toBe(19_500_000);
    // Kalau rekening nonaktif dibuang, kasAkhir akan kehilangan 19,5 juta.
    expect(arus.kasAkhirAktual).toBe(saldoKas + saldoBank);
  });

  test('transaksi historis rekening nonaktif tetap terklasifikasi di rincian arus kas', async () => {
    await nonaktifkanBank();
    const arus = await getArusKas(dbAktif as any, '2026-01-01', '2026-12-31');
    const totalPergerakan = arus.rincian.reduce((a, r) => a + r.jumlah, 0);
    // Seluruh pergerakan kas periode ini = 20jt - 0,5jt + 1jt.
    expect(totalPergerakan).toBe(20_500_000);
  });
});

describe('BUG-15 — getAccountBalancesBulk setara dengan getAccountBalance', () => {
  beforeEach(async () => {
    await setup();
  });

  test('nilai per akun identik dengan pemanggilan satu per satu (tanggal cutoff)', async () => {
    const ids = [ACC.kas, ACC.bank, ACC.modal, ACC.beban, ACC.pendapatan];
    const bulk = await getAccountBalancesBulk(dbAktif as any, ids, '2026-12-31');
    for (const id of ids) {
      const satuan = await getAccountBalance(dbAktif as any, id, '2026-12-31');
      expect(bulk.get(id)).toBe(satuan);
    }
  });

  test('cutoff tanggal dihormati (transaksi setelah cutoff tidak ikut)', async () => {
    const ids = [ACC.bank, ACC.kas];
    const bulk = await getAccountBalancesBulk(dbAktif as any, ids, '2026-01-31');
    // Per 31 Jan: bank baru menerima 20jt, kas belum bergerak.
    expect(bulk.get(ACC.bank)).toBe(20_000_000);
    expect(bulk.get(ACC.kas)).toBe(0);
  });

  test('akun tanpa jurnal tetap dikembalikan dengan saldo 0, bukan hilang dari hasil', async () => {
    await seedAccount(dbAktif, 'acc-kosong', '1-9999', 'Akun Tanpa Mutasi', 'ASET', 'DEBIT');
    const bulk = await getAccountBalancesBulk(dbAktif as any, ['acc-kosong'], '2026-12-31');
    expect(bulk.has('acc-kosong')).toBe(true);
    expect(bulk.get('acc-kosong')).toBe(0);
  });

  test('daftar kosong tidak melakukan query dan mengembalikan Map kosong', async () => {
    const bulk = await getAccountBalancesBulk(dbAktif as any, [], '2026-12-31');
    expect(bulk.size).toBe(0);
  });
});

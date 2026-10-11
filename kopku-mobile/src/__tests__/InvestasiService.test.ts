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

import { catatInvestasi, listInvestasi, editInvestasi, batalkanInvestasi, getInvestasiDetail } from '@/services/InvestasiService';

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

/**
 * Revisi KOPKU (Bagian 1): seed satu baris Data Bank (bank_account) —
 * setiap bank_account butuh account_id ledger sendiri (skema
 * existing), jadi dibuatkan akun ASET dummy terpisah per baris supaya
 * tidak bentrok dengan akun investasi lain di fixture.
 */
async function seedBankAccount(
  db: TestDb,
  id: string,
  namaBank: string,
  nomorRekening: string,
  aktif: boolean = true
): Promise<void> {
  const accId = `acc-bank-${id}`;
  await seedAccount(db, accId, `1-11${id}`, `Bank ${namaBank} ${id}`, 'ASET', 'DEBIT');
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at)
     VALUES (?,?,?,?,0,?,?,?)`,
    id,
    namaBank,
    nomorRekening,
    'Koperasi Uji Coba',
    accId,
    aktif ? 1 : 0,
    new Date().toISOString()
  );
}

const ACC = {
  kas: 'acc-kas',
  investasiUnitUsaha: 'acc-investasi-unit-usaha',
  investasiKoperasiLain: 'acc-investasi-koperasi-lain',
  investasiUsahaLain: 'acc-investasi-usaha-lain',
  investasiTabungan: 'acc-investasi-tabungan',
  investasiGiro: 'acc-investasi-giro',
  investasiDeposito: 'acc-investasi-deposito',
  investasiProperti: 'acc-investasi-properti',
  modal: 'acc-modal',
};

async function isiKas(db: TestDb, nominal: number) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    'journal-isi-kas',
    'JRN-ISI-KAS',
    '2026-01-01',
    'period-2026',
    'MODAL_AWAL',
    'Isi kas (fixture test)',
    'POSTED',
    'user-1',
    now,
    now,
    now
  );
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-isi-debit', 'journal-isi-kas', ACC.kas, nominal);
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-isi-kredit', 'journal-isi-kas', ACC.modal, nominal);
}

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.investasiUnitUsaha, '1-1600', 'Penyertaan pada Unit Usaha', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.investasiKoperasiLain, '1-1610', 'Penyertaan pada Koperasi Lain', 'ASET', 'DEBIT');
  // Audit ulang (permintaan pengguna §2/§3/§4): 5 akun investasi baru.
  await seedAccount(db, ACC.investasiUsahaLain, '1-1620', 'Investasi pada Usaha Lain', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.investasiTabungan, '1-1630', 'Tabungan pada Bank Umum', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.investasiGiro, '1-1640', 'Giro pada Bank Umum', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.investasiDeposito, '1-1650', 'Deposito Berjangka (> 3 Bulan)', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.investasiProperti, '1-1660', 'Properti Investasi', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'INVESTASI_UNIT_USAHA', 'DEBIT_ASET', ACC.investasiUnitUsaha);
  await seedMapping(db, 'INVESTASI_KOPERASI_LAIN', 'DEBIT_ASET', ACC.investasiKoperasiLain);
  await seedMapping(db, 'INVESTASI_USAHA_LAIN', 'DEBIT_ASET', ACC.investasiUsahaLain);
  await seedMapping(db, 'INVESTASI_TABUNGAN_BANK_UMUM', 'DEBIT_ASET', ACC.investasiTabungan);
  await seedMapping(db, 'INVESTASI_GIRO_BANK_UMUM', 'DEBIT_ASET', ACC.investasiGiro);
  await seedMapping(db, 'INVESTASI_DEPOSITO_BANK_UMUM', 'DEBIT_ASET', ACC.investasiDeposito);
  await seedMapping(db, 'INVESTASI_PROPERTI_INVESTASI', 'DEBIT_ASET', ACC.investasiProperti);

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

describe('InvestasiService', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('catatInvestasi UNIT_USAHA: DITOLAK untuk transaksi baru (Phase 18 §2) — akun 1-1600 nonaktif, histori lama tetap tidak tersentuh', async () => {
    await isiKas(testDb, 20_000_000);

    await expect(
      catatInvestasi({
        // @ts-expect-error UNIT_USAHA sengaja tidak lagi ada di JenisInvestasiInput — dicek tetap ditolak di runtime kalau ada pemanggil lama yang lolos dari type-check (mis. lewat any).
        jenisInvestasi: 'UNIT_USAHA',
        namaTujuan: 'Unit Usaha Toko',
        jumlah: 10_000_000,
        tanggal: '2026-02-01',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/Unit Usaha Internal sudah tidak dapat dibuat/);

    const daftar = await listInvestasi();
    expect(daftar).toHaveLength(0);

    const investasiUnitUsahaRow = await testDb.getFirstAsync<{ total: number } | null>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.investasiUnitUsaha
    );
    expect(investasiUnitUsahaRow?.total ?? 0).toBe(0);
  });

  test('catatInvestasi KOPERASI_LAIN: jurnal balance, DEBIT Penyertaan pada Koperasi Lain KREDIT Kas — akun TERPISAH dari Unit Usaha (Bagian E)', async () => {
    await isiKas(testDb, 20_000_000);

    await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Sejahtera Bersama',
      jumlah: 7_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const investasiKoperasiLainRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.investasiKoperasiLain
    );
    expect(investasiKoperasiLainRow?.total).toBe(7_000_000);

    const investasiUnitUsahaRow = await testDb.getFirstAsync<{ total: number } | null>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.investasiUnitUsaha
    );
    expect(investasiUnitUsahaRow?.total ?? 0).toBe(0);
  });

  test('catatInvestasi: DITOLAK kalau saldo kas tidak cukup', async () => {
    await isiKas(testDb, 1_000_000);

    await expect(
      catatInvestasi({
        jenisInvestasi: 'KOPERASI_LAIN',
        namaTujuan: 'Koperasi Sejahtera',
        jumlah: 5_000_000,
        tanggal: '2026-02-01',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/[Ss]aldo.*tidak cukup/);

    const daftar = await listInvestasi();
    expect(daftar).toHaveLength(0);
  });

  test('catatInvestasi: DITOLAK kalau nama tujuan kosong', async () => {
    await isiKas(testDb, 10_000_000);
    await expect(
      catatInvestasi({
        jenisInvestasi: 'KOPERASI_LAIN',
        namaTujuan: '   ',
        jumlah: 1_000_000,
        tanggal: '2026-02-01',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/[Nn]ama/);
  });

  test('catatInvestasi: DITOLAK kalau jumlah 0 atau negatif', async () => {
    await isiKas(testDb, 10_000_000);
    await expect(
      catatInvestasi({
        jenisInvestasi: 'KOPERASI_LAIN',
        namaTujuan: 'Koperasi Sejahtera',
        jumlah: 0,
        tanggal: '2026-02-01',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/[Jj]umlah/);
  });
});

// ============================================================
// Audit ulang (permintaan pengguna §2/§3/§4/§5) — 5 jenis investasi
// baru: Usaha Lain, Bank Umum (Tabungan/Giro/Deposito > 3 bulan),
// Properti Investasi. Masing-masing HARUS masuk ke akun ASET
// terpisah (bukan akun generik), field opsional (nomor rekening,
// lokasi) tersimpan sesuai jenisnya.
// ============================================================
describe('InvestasiService — 5 jenis investasi baru (audit ulang §2/§3/§4/§5)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('catatInvestasi USAHA_LAIN: DEBIT akun Investasi pada Usaha Lain (1-1620), TERPISAH dari Koperasi Lain', async () => {
    await isiKas(testDb, 20_000_000);
    await catatInvestasi({
      jenisInvestasi: 'USAHA_LAIN',
      namaTujuan: 'Usaha Konveksi Maju',
      jumlah: 8_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const saldo = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.investasiUsahaLain
    );
    expect(saldo?.total).toBe(8_000_000);

    const saldoKoperasiLain = await testDb.getFirstAsync<{ total: number } | null>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.investasiKoperasiLain
    );
    expect(saldoKoperasiLain?.total ?? 0).toBe(0);
  });

  test.each([
    ['TABUNGAN_BANK_UMUM', 'investasiTabungan'] as const,
    ['GIRO_BANK_UMUM', 'investasiGiro'] as const,
    ['DEPOSITO_BANK_UMUM', 'investasiDeposito'] as const,
  ])(
    'catatInvestasi %s: DEBIT akun Bank Umum masing-masing, nama bank dari Data Bank, & nomorRekeningInvestasi tersimpan',
    async (jenis, accKey) => {
      await isiKas(testDb, 20_000_000);
      await seedBankAccount(testDb, 'bank-mandiri', 'Bank Mandiri', '001-22-33');
      const { id } = await catatInvestasi({
        jenisInvestasi: jenis,
        namaTujuan: 'diabaikan — bank umum wajib dari Data Bank',
        jumlah: 5_000_000,
        tanggal: '2026-02-01',
        sumberDana: 'KAS',
        bankTujuanId: 'bank-mandiri',
        nomorRekeningInvestasi: '1234567890',
        createdBy: 'user-1',
      });

      const saldo = await testDb.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
        ACC[accKey]
      );
      expect(saldo?.total).toBe(5_000_000);

      const detail = await getInvestasiDetail(id);
      expect(detail?.nomorRekeningInvestasi).toBe('1234567890');
      expect(detail?.jenisInvestasi).toBe(jenis);
      // Bug fix (test): assertion sebelumnya mengharapkan SEMUA jenis
      // (termasuk DEPOSITO_BANK_UMUM) mengambil nama dari Data Bank —
      // tapi kode service (lihat komentar "Permintaan pengguna §11" di
      // InvestasiService.ts) SENGAJA MENGECUALIKAN DEPOSITO_BANK_UMUM
      // dari aturan itu (`JENIS_WAJIB_NAMA_BANK` cuma berisi
      // TABUNGAN_BANK_UMUM & GIRO_BANK_UMUM) — Deposito Berjangka tetap
      // pakai teks bebas seperti jenis investasi lain. Assertion di
      // sini disesuaikan per jenis supaya konsisten dengan keputusan
      // §11 yang sudah terdokumentasi di kode, bukan menguji perilaku
      // yang sudah sengaja diubah.
      if (jenis === 'DEPOSITO_BANK_UMUM') {
        expect(detail?.namaTujuan).toBe('diabaikan — bank umum wajib dari Data Bank');
        expect(detail?.bankTujuanId ?? null).toBeNull();
      } else {
        // Revisi KOPKU (Bagian 1): nama tujuan otomatis dari Data Bank
        // (bank_account.nama_bank), BUKAN dari teks bebas yang dikirim.
        expect(detail?.namaTujuan).toBe('Bank Mandiri');
        expect(detail?.bankTujuanId).toBe('bank-mandiri');
      }
    }
  );

  test('catatInvestasi Bank Umum: DITOLAK kalau bankTujuanId tidak diisi (Bagian 1.3 — tidak boleh input teks bebas)', async () => {
    await isiKas(testDb, 20_000_000);
    await expect(
      catatInvestasi({
        jenisInvestasi: 'TABUNGAN_BANK_UMUM',
        namaTujuan: 'Bank Mandiri',
        jumlah: 5_000_000,
        tanggal: '2026-02-01',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/Nama bank wajib dipilih dari Data Bank/);
  });

  test('catatInvestasi Bank Umum: DITOLAK kalau bankTujuanId tidak ditemukan di Data Bank', async () => {
    await isiKas(testDb, 20_000_000);
    await expect(
      catatInvestasi({
        jenisInvestasi: 'TABUNGAN_BANK_UMUM',
        namaTujuan: 'abaikan',
        jumlah: 5_000_000,
        tanggal: '2026-02-01',
        sumberDana: 'KAS',
        bankTujuanId: 'bank-tidak-ada',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/Bank tujuan tidak ditemukan/);
  });

  test('catatInvestasi Bank Umum: bank yang sudah tidak aktif TETAP bisa dipilih untuk menghindari histori aneh (validasi aktif ada di picker UI, bukan service) & tampil benar', async () => {
    await isiKas(testDb, 20_000_000);
    await seedBankAccount(testDb, 'bank-lama', 'Bank Lama Tutup', '999', false);
    // Bug fix (test): jenisInvestasi sebelumnya 'DEPOSITO_BANK_UMUM' —
    // jenis itu SENGAJA dikecualikan dari resolusi wajib Data Bank
    // (lihat komentar "Permintaan pengguna §11" di InvestasiService.ts,
    // `JENIS_WAJIB_NAMA_BANK` cuma TABUNGAN_BANK_UMUM/GIRO_BANK_UMUM),
    // jadi skenario "bank tidak aktif tetap bisa dipilih & nama
    // ter-resolve dari Data Bank" yang dimaksud test ini tidak
    // teruji sama sekali dengan jenis itu. Diganti ke
    // TABUNGAN_BANK_UMUM (pola sama seperti test lain di file ini)
    // supaya benar-benar melewati jalur resolveBankTujuan().
    const { id } = await catatInvestasi({
      jenisInvestasi: 'TABUNGAN_BANK_UMUM',
      namaTujuan: 'abaikan',
      jumlah: 5_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      bankTujuanId: 'bank-lama',
      createdBy: 'user-1',
    });
    const detail = await getInvestasiDetail(id);
    expect(detail?.namaTujuan).toBe('Bank Lama Tutup');
    expect(detail?.bankTujuanId).toBe('bank-lama');
  });

  test('catatInvestasi PROPERTI_INVESTASI: DEBIT akun Properti Investasi (1-1660), lokasiProperti tersimpan', async () => {
    await isiKas(testDb, 600_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'PROPERTI_INVESTASI',
      namaTujuan: 'Ruko 2 Lantai',
      jumlah: 500_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      lokasiProperti: 'Jl. Sudirman No. 10, Jakarta',
      createdBy: 'user-1',
    });

    const saldo = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.investasiProperti
    );
    expect(saldo?.total).toBe(500_000_000);

    const detail = await getInvestasiDetail(id);
    expect(detail?.lokasiProperti).toBe('Jl. Sudirman No. 10, Jakarta');
  });

  test('nomorRekeningInvestasi/lokasiProperti TIDAK tersimpan (null) untuk jenis yang tidak relevan (mis. KOPERASI_LAIN)', async () => {
    await isiKas(testDb, 10_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Sejahtera',
      jumlah: 5_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const detail = await getInvestasiDetail(id);
    expect(detail?.nomorRekeningInvestasi).toBeNull();
    expect(detail?.lokasiProperti).toBeNull();
  });

  test('editInvestasi: jenis TIDAK berubah walau input tidak menyertakan jenis (tetap mengikuti jenis investasi asli); bank tujuan dari Data Bank tetap wajib saat edit', async () => {
    await isiKas(testDb, 20_000_000);
    await seedBankAccount(testDb, 'bank-bca', 'Bank BCA', '111');
    const { id: idLama } = await catatInvestasi({
      jenisInvestasi: 'GIRO_BANK_UMUM',
      namaTujuan: 'abaikan',
      jumlah: 5_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      bankTujuanId: 'bank-bca',
      nomorRekeningInvestasi: '999',
      createdBy: 'user-1',
    });

    const { id: idBaru } = await editInvestasi(idLama, 'user-1', {
      namaTujuan: 'abaikan',
      jumlah: 6_000_000,
      tanggal: '2026-02-05',
      sumberDana: 'KAS',
      bankTujuanId: 'bank-bca',
      nomorRekeningInvestasi: '888',
    }, 'Koreksi nomor rekening & nominal');

    const baru = await getInvestasiDetail(idBaru);
    expect(baru?.jenisInvestasi).toBe('GIRO_BANK_UMUM');
    expect(baru?.nomorRekeningInvestasi).toBe('888');
    expect(baru?.namaTujuan).toBe('Bank BCA');
    expect(baru?.bankTujuanId).toBe('bank-bca');

    const saldoGiro = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.investasiGiro
    );
    expect(saldoGiro?.total).toBe(6_000_000); // hanya transaksi baru yang berlaku
  });

  test('editInvestasi Bank Umum: DITOLAK kalau bankTujuanId tidak diisi saat edit', async () => {
    await isiKas(testDb, 20_000_000);
    await seedBankAccount(testDb, 'bank-bca', 'Bank BCA', '111');
    const { id: idLama } = await catatInvestasi({
      jenisInvestasi: 'GIRO_BANK_UMUM',
      namaTujuan: 'abaikan',
      jumlah: 5_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      bankTujuanId: 'bank-bca',
      createdBy: 'user-1',
    });

    await expect(
      editInvestasi(idLama, 'user-1', {
        namaTujuan: 'abaikan',
        jumlah: 6_000_000,
        tanggal: '2026-02-05',
        sumberDana: 'KAS',
      }, 'Koreksi data uji')
    ).rejects.toThrow(/Nama bank wajib dipilih dari Data Bank/);
  });

  test('editInvestasi: investasi UNIT_USAHA (legacy) DITOLAK untuk diedit', async () => {
    // Seed baris UNIT_USAHA lama secara langsung (jenis ini tidak bisa
    // dibuat lagi lewat catatInvestasi — lihat test penolakan di atas).
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO investasi
        (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal, sumber_dana,
         keterangan, journal_id, created_by, created_at, status, reversal_of_id, updated_at)
       VALUES ('inv-lama','INV-LAMA','UNIT_USAHA','Unit Usaha Toko',5000000,'2024-01-01','KAS',NULL,NULL,'user-1',?,'AKTIF',NULL,?)`,
      now,
      now
    );

    await expect(
      editInvestasi('inv-lama', 'user-1', {
        namaTujuan: 'Unit Usaha Toko (Edit)',
        jumlah: 6_000_000,
        tanggal: '2026-02-05',
        sumberDana: 'KAS',
      }, 'Koreksi data uji')
    ).rejects.toThrow(/Unit Usaha Internal.*tidak dapat diedit/);
  });
});

describe('InvestasiService — editInvestasi & batalkanInvestasi (§11, permintaan pengguna)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('batalkanInvestasi: reversal jurnal, saldo kembali seperti semula, status DIBATALKAN, baris asli TETAP ADA', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Sejahtera Bersama',
      jumlah: 7_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await batalkanInvestasi(id, 'user-1', 'Salah input nominal');

    const saldoInvestasi = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.investasiKoperasiLain
    );
    expect(saldoInvestasi?.total).toBe(0);

    const saldoKas = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.kas
    );
    expect(saldoKas?.total).toBe(20_000_000);

    const detail = await getInvestasiDetail(id);
    expect(detail?.status).toBe('DIBATALKAN');

    const daftar = await listInvestasi();
    expect(daftar).toHaveLength(1); // baris asli tetap ada, tidak dihapus fisik
  });

  test('batalkanInvestasi: DITOLAK kalau sudah dibatalkan sebelumnya', async () => {
    await isiKas(testDb, 10_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Sejahtera',
      jumlah: 5_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await batalkanInvestasi(id, 'user-1', 'Alasan pertama');
    await expect(batalkanInvestasi(id, 'user-1', 'Alasan kedua')).rejects.toThrow(/sudah dibatalkan/);
  });

  test('batalkanInvestasi: DITOLAK kalau alasan kosong', async () => {
    await isiKas(testDb, 10_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Sejahtera',
      jumlah: 5_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await expect(batalkanInvestasi(id, 'user-1', '   ')).rejects.toThrow(/[Aa]lasan/);
  });

  test('editInvestasi: transaksi lama di-reversal (bukan UPDATE mentah), transaksi baru dibuat dengan data hasil edit, ditaut via reversalOfId', async () => {
    await isiKas(testDb, 20_000_000);
    const { id: idLama } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Lama',
      jumlah: 10_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const { id: idBaru } = await editInvestasi(idLama, 'user-1', {
      namaTujuan: 'Koperasi Baru',
      jumlah: 6_000_000,
      tanggal: '2026-02-05',
      sumberDana: 'KAS',
      keterangan: 'Koreksi nominal & nama tujuan',
    }, 'Salah input nominal & nama tujuan saat transaksi awal');

    const lama = await getInvestasiDetail(idLama);
    expect(lama?.status).toBe('DIBATALKAN');

    const baru = await getInvestasiDetail(idBaru);
    expect(baru?.status).toBe('AKTIF');
    expect(baru?.namaTujuan).toBe('Koperasi Baru');
    expect(baru?.jumlah).toBe(6_000_000);
    expect(baru?.jenisInvestasi).toBe('KOPERASI_LAIN');
    expect(baru?.reversalOfId).toBe(idLama);

    const saldoInvestasi = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.investasiKoperasiLain
    );
    expect(saldoInvestasi?.total).toBe(6_000_000); // hanya transaksi baru yang berlaku

    const daftar = await listInvestasi();
    expect(daftar).toHaveLength(2); // lama (dibatalkan) + baru, keduanya tetap terlihat
  });

  test('editInvestasi: DITOLAK kalau saldo kas tidak cukup untuk nominal baru', async () => {
    await isiKas(testDb, 5_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Sejahtera',
      jumlah: 3_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await expect(
      editInvestasi(id, 'user-1', {
        namaTujuan: 'Koperasi Sejahtera',
        jumlah: 100_000_000,
        tanggal: '2026-02-01',
        sumberDana: 'KAS',
      }, 'Koreksi data uji')
    ).rejects.toThrow(/[Ss]aldo.*tidak cukup/);

    // Rollback penuh — transaksi lama TETAP AKTIF, bukan nyangkut separuh jalan.
    const detail = await getInvestasiDetail(id);
    expect(detail?.status).toBe('AKTIF');
  });

  test('update pasca-6-perbaikan §4: REGRESSION test end-to-end — create, edit, reload dari database, seluruh field berubah tersimpan (jenis, tujuan, nama kantor/unit tujuan, jumlah, tanggal, keterangan)', async () => {
    await isiKas(testDb, 20_000_000);

    // 1. create investment
    const { id: idAsli } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Awal',
      jumlah: 5_000_000,
      tanggal: '2026-01-10',
      sumberDana: 'KAS',
      keterangan: 'Catatan awal',
      createdBy: 'user-1',
    });

    // 2. edit investment — ubah SEMUA field yang bisa diedit.
    const { id: idHasilEdit } = await editInvestasi(idAsli, 'user-1', {
      namaTujuan: 'Kantor Cabang Makassar',
      jumlah: 9_500_000,
      tanggal: '2026-02-20',
      sumberDana: 'KAS',
      keterangan: 'Catatan setelah diedit',
    }, 'Koreksi tujuan, nominal, tanggal & keterangan');

    // 3. reload dari database — query BARU, BUKAN memakai nilai balikan editInvestasi.
    const hasilReload = await getInvestasiDetail(idHasilEdit);

    // 4. pastikan SEMUA perubahan tersimpan.
    expect(hasilReload).not.toBeNull();
    expect(hasilReload?.jenisInvestasi).toBe('KOPERASI_LAIN'); // jenis investasi
    expect(hasilReload?.namaTujuan).toBe('Kantor Cabang Makassar'); // tujuan investasi / nama kantor-unit tujuan
    expect(hasilReload?.jumlah).toBe(9_500_000); // jumlah
    expect(hasilReload?.tanggal).toBe('2026-02-20'); // tanggal
    expect(hasilReload?.keterangan).toBe('Catatan setelah diedit'); // keterangan
    expect(hasilReload?.status).toBe('AKTIF');

    // Juga pastikan lewat listInvestasi() (dipakai DaftarInvestasiScreen
    // sungguhan) — daftar yang di-reload dari database menampilkan hasil edit.
    const daftarUlang = await listInvestasi();
    const barisBaru = daftarUlang.find((d) => d.id === idHasilEdit);
    expect(barisBaru?.namaTujuan).toBe('Kantor Cabang Makassar');
    expect(barisBaru?.jumlah).toBe(9_500_000);
  });

  test('permintaan pengguna §7: editInvestasi DITOLAK kalau alasan perubahan kosong/whitespace', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Sejahtera',
      jumlah: 5_000_000,
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await expect(
      editInvestasi(id, 'user-1', {
        namaTujuan: 'Koperasi Sejahtera',
        jumlah: 6_000_000,
        tanggal: '2026-02-01',
        sumberDana: 'KAS',
      }, '   ')
    ).rejects.toThrow(/[Aa]lasan/);

    // Rollback penuh — transaksi lama TETAP AKTIF, tidak ada baris baru dibuat.
    const detail = await getInvestasiDetail(id);
    expect(detail?.status).toBe('AKTIF');
    const daftar = await listInvestasi();
    expect(daftar).toHaveLength(1);
  });
});

// ============================================================
// Phase 17 §2/§13 — Date-scoping historis: listInvestasi(asOfDate)
// ============================================================
describe('listInvestasi — date-scoping historis (Phase 17 §2)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('#5 investasi yang dibuat SETELAH asOfDate tidak muncul', async () => {
    await isiKas(testDb, 20_000_000);
    await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Sejahtera',
      jumlah: 5_000_000,
      tanggal: '2026-06-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const per2025 = await listInvestasi('2025-12-31');
    expect(per2025.find((i) => i.namaTujuan === 'Koperasi Sejahtera')).toBeUndefined();

    const per2026 = await listInvestasi('2026-12-31');
    expect(per2026.find((i) => i.namaTujuan === 'Koperasi Sejahtera')).toBeDefined();
  });

  test('#6/#7 investasi yang dibatalkan SETELAH asOfDate masih muncul; SEBELUM/PADA asOfDate tidak muncul', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Maju Bersama',
      jumlah: 5_000_000,
      tanggal: '2025-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await batalkanInvestasi(id, 'user-1', 'Dibatalkan, dana ditarik kembali');
    // Backdate updated_at supaya skenario deterministik (pola sama
    // dipakai AsetService.test.ts Phase 17 §1).
    await testDb.runAsync(`UPDATE investasi SET updated_at = ? WHERE id = ?`, '2026-06-15T00:00:00.000Z', id);

    // Setelah tanggal pembatalan: tidak lagi muncul.
    const setelahBatal = await listInvestasi('2026-12-31');
    expect(setelahBatal.find((i) => i.id === id)).toBeUndefined();

    // Pada tanggal pembatalan: sudah dianggap batal.
    const padaBatal = await listInvestasi('2026-06-15');
    expect(padaBatal.find((i) => i.id === id)).toBeUndefined();

    // Sebelum tanggal pembatalan: masih aktif, HARUS muncul.
    const sebelumBatal = await listInvestasi('2026-01-01');
    expect(sebelumBatal.find((i) => i.id === id)).toBeDefined();
  });

  test('TANPA asOfDate: perilaku current-state persis sama seperti sebelumnya (kompatibilitas mundur)', async () => {
    await isiKas(testDb, 20_000_000);
    await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Current',
      jumlah: 3_000_000,
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const daftar = await listInvestasi();
    expect(daftar.find((i) => i.namaTujuan === 'Koperasi Current')).toBeDefined();
  });
});

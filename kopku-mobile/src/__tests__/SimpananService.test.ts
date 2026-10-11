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

import { setorSimpanan, tarikSimpananSukarela, keluarAnggota, listAnggotaSaldoSukarelaTersedia, koreksiSimpanan, getSaldoSimpanan, listSaldoSimpananSemuaAnggota } from '@/services/SimpananService';

async function getJournalDeskripsi(db: TestDb, journalId: string): Promise<string> {
  const row = await db.getFirstAsync<{ deskripsi: string }>(`SELECT deskripsi FROM journal WHERE id = ?`, journalId);
  return row?.deskripsi ?? '';
}

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

const ACC = {
  kas: 'acc-kas',
  pokok: 'acc-simpanan-pokok',
  wajib: 'acc-simpanan-wajib',
  sukarela: 'acc-simpanan-sukarela',
};

const ANGGOTA_ID = 'anggota-1';

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.pokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.wajib, '3-1100', 'Simpanan Wajib', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.sukarela, '2-1200', 'Simpanan Sukarela', 'LIABILITAS', 'KREDIT');
  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'SIMPANAN_POKOK', 'KREDIT_DEFAULT', ACC.pokok);
  await seedMapping(db, 'SIMPANAN_WAJIB', 'KREDIT_DEFAULT', ACC.wajib);
  await seedMapping(db, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', ACC.sukarela);

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
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID,
    'A001',
    '1234567890123456',
    'Budi',
    '2020-01-01',
    now,
    now
  );

  return db;
}

describe('SimpananService — Phase 4: liquidity check saat penarikan (AUDIT_INTERNAL.md §3.1)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('tarikSimpananSukarela DITOLAK kalau saldo simpanan anggota cukup TAPI kas koperasi tidak cukup', async () => {
    await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'SUKARELA',
      tanggal: '2026-01-10',
      nominal: 500_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    // Kas koperasi jadi 500rb. Keluarkan sebagian lewat jurnal manual
    // supaya kas TIDAK cukup lagi, walau saldo simpanan anggota masih 500rb.
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('journal-kuras','JRN-KURAS','2026-01-15','period-2026','TEST_KURAS','Kuras kas (fixture test)','POSTED','user-1',?,?,?)`,
      now,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`,
      'je-kuras-kas',
      'journal-kuras',
      ACC.kas,
      400_000
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`,
      'je-kuras-pokok',
      'journal-kuras',
      ACC.pokok,
      400_000
    );
    // Kas sisa 100rb, tapi saldo simpanan sukarela anggota masih 500rb.

    await expect(
      tarikSimpananSukarela({
        anggotaId: ANGGOTA_ID,
        tanggal: '2026-01-20',
        nominal: 500_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/[Ss]aldo.*tidak cukup/);
  });

  test('keluarAnggota DITOLAK kalau kas koperasi tidak cukup mengembalikan seluruh simpanan', async () => {
    await setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'POKOK', tanggal: '2026-01-01', nominal: 100_000, sumberDana: 'KAS', createdBy: 'user-1' });
    await setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: '2026-01-01', nominal: 200_000, sumberDana: 'KAS', createdBy: 'user-1' });

    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('journal-kuras2','JRN-KURAS2','2026-01-05','period-2026','TEST_KURAS','Kuras kas (fixture test)','POSTED','user-1',?,?,?)`,
      now,
      now,
      now
    );
    await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-kuras2-kas', 'journal-kuras2', ACC.kas, 250_000);
    await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-kuras2-pokok', 'journal-kuras2', ACC.pokok, 250_000);
    // Kas sisa 50rb, total simpanan anggota tetap 300rb (100rb pokok + 200rb wajib).

    await expect(
      keluarAnggota({ anggotaId: ANGGOTA_ID, tanggal: '2026-01-10', sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/[Ss]aldo.*tidak cukup/);

    // Status anggota TIDAK berubah — penolakan harus utuh.
    const anggota = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM anggota WHERE id = ?`, ANGGOTA_ID);
    expect(anggota?.status).toBe('AKTIF');
  });
});

describe('SimpananService — Phase 5: gate anggota aktif (AUDIT_INTERNAL.md §3.1)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('setorSimpanan DITOLAK untuk anggota TIDAK_AKTIF', async () => {
    await testDb.runAsync(`UPDATE anggota SET status = 'TIDAK_AKTIF' WHERE id = ?`, ANGGOTA_ID);

    await expect(
      setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'POKOK', tanggal: '2026-01-01', nominal: 100_000, sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/AKTIF/);
  });

  test('setorSimpanan DITOLAK untuk anggota KELUAR', async () => {
    await testDb.runAsync(`UPDATE anggota SET status = 'KELUAR' WHERE id = ?`, ANGGOTA_ID);

    await expect(
      setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'WAJIB', tanggal: '2026-01-01', nominal: 50_000, sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/AKTIF/);
  });

  test('setorSimpanan tetap BERHASIL untuk anggota AKTIF (bukti gate tidak menghalangi kasus normal)', async () => {
    await expect(
      setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'POKOK', tanggal: '2026-01-01', nominal: 100_000, sumberDana: 'KAS', createdBy: 'user-1' })
    ).resolves.toHaveProperty('journalId');
  });

  test('tarikSimpananSukarela DITOLAK untuk anggota MENINGGAL, walau saldo cukup', async () => {
    await setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'SUKARELA', tanggal: '2026-01-01', nominal: 500_000, sumberDana: 'KAS', createdBy: 'user-1' });
    await testDb.runAsync(`UPDATE anggota SET status = 'MENINGGAL' WHERE id = ?`, ANGGOTA_ID);

    await expect(
      tarikSimpananSukarela({ anggotaId: ANGGOTA_ID, tanggal: '2026-01-10', nominal: 100_000, sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/AKTIF/);
  });
});

describe('SimpananService — listAnggotaSaldoSukarelaTersedia (Phase 17 §A)', () => {
  const ANGGOTA_POKOK_SAJA = 'anggota-pokok-saja';
  const ANGGOTA_WAJIB_SAJA = 'anggota-wajib-saja';
  const ANGGOTA_SUKARELA_HABIS = 'anggota-sukarela-habis';

  beforeEach(async () => {
    testDb = await seedFixture();
    const now = new Date().toISOString();
    for (const [id, nomor, nama] of [
      [ANGGOTA_POKOK_SAJA, 'A002', 'Hanya Pokok'],
      [ANGGOTA_WAJIB_SAJA, 'A003', 'Hanya Wajib'],
      [ANGGOTA_SUKARELA_HABIS, 'A004', 'Sukarela Habis'],
    ]) {
      await testDb.runAsync(
        `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
         VALUES (?,?,?,?,?,'AKTIF',?,?)`,
        id,
        nomor,
        `NIK-${nomor}`,
        nama,
        '2020-01-01',
        now,
        now
      );
    }
  });

  test('anggota yang hanya punya simpanan pokok TIDAK muncul', async () => {
    await setorSimpanan({ anggotaId: ANGGOTA_POKOK_SAJA, jenis: 'POKOK', tanggal: '2026-01-01', nominal: 100_000, sumberDana: 'KAS', createdBy: 'user-1' });

    const kandidat = await listAnggotaSaldoSukarelaTersedia();
    expect(kandidat.find((k) => k.id === ANGGOTA_POKOK_SAJA)).toBeUndefined();
  });

  test('anggota yang hanya punya simpanan wajib TIDAK muncul', async () => {
    await setorSimpanan({ anggotaId: ANGGOTA_WAJIB_SAJA, jenis: 'WAJIB', tanggal: '2026-01-01', nominal: 50_000, sumberDana: 'KAS', createdBy: 'user-1' });

    const kandidat = await listAnggotaSaldoSukarelaTersedia();
    expect(kandidat.find((k) => k.id === ANGGOTA_WAJIB_SAJA)).toBeUndefined();
  });

  test('anggota yang saldo sukarelanya sudah ditarik habis (0) TIDAK muncul lagi', async () => {
    await setorSimpanan({ anggotaId: ANGGOTA_SUKARELA_HABIS, jenis: 'SUKARELA', tanggal: '2026-01-01', nominal: 200_000, sumberDana: 'KAS', createdBy: 'user-1' });
    await tarikSimpananSukarela({ anggotaId: ANGGOTA_SUKARELA_HABIS, tanggal: '2026-01-05', nominal: 200_000, sumberDana: 'KAS', createdBy: 'user-1' });

    const kandidat = await listAnggotaSaldoSukarelaTersedia();
    expect(kandidat.find((k) => k.id === ANGGOTA_SUKARELA_HABIS)).toBeUndefined();
  });

  test('anggota dengan saldo sukarela > 0 MUNCUL dengan saldo yang benar', async () => {
    await setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'SUKARELA', tanggal: '2026-01-01', nominal: 300_000, sumberDana: 'KAS', createdBy: 'user-1' });

    const kandidat = await listAnggotaSaldoSukarelaTersedia();
    const row = kandidat.find((k) => k.id === ANGGOTA_ID);
    expect(row).toBeDefined();
    expect(row?.saldoSukarela).toBe(300_000);
  });
});

describe('SimpananService — sumber dana BANK (Phase 17 §D/§H)', () => {
  const BANK_ACCOUNT_ID = 'bank-account-1';
  const ACC_BANK_LEDGER = 'acc-bank-bca';

  beforeEach(async () => {
    testDb = await seedFixture();
    await seedAccount(testDb, ACC_BANK_LEDGER, '1-1100', 'Bank BCA', 'ASET', 'DEBIT');
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, created_at)
       VALUES (?,?,?,?,?,?,1,?)`,
      BANK_ACCOUNT_ID,
      'BCA',
      '1234567890',
      '',
      0,
      ACC_BANK_LEDGER,
      now
    );
  });

  test('setorSimpanan dengan sumberDana BANK mendebit akun bank yang dipilih (bukan Kas)', async () => {
    await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'SUKARELA',
      tanggal: '2026-01-10',
      nominal: 500_000,
      sumberDana: 'BANK',
      bankAccountId: BANK_ACCOUNT_ID,
      createdBy: 'user-1',
    });

    const saldoBank = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(je.debit - je.kredit),0) as total FROM journal_entry je WHERE je.account_id = ?`,
      ACC_BANK_LEDGER
    );
    const saldoKas = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(je.debit - je.kredit),0) as total FROM journal_entry je WHERE je.account_id = ?`,
      ACC.kas
    );
    expect(saldoBank?.total).toBe(500_000);
    expect(saldoKas?.total).toBe(0); // Kas TIDAK ikut terpakai
  });

  test('setorSimpanan sumberDana BANK tanpa bankAccountId DITOLAK (bukan diam-diam pakai Kas)', async () => {
    await expect(
      setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'SUKARELA', tanggal: '2026-01-10', nominal: 100_000, sumberDana: 'BANK', createdBy: 'user-1' })
    ).rejects.toThrow(/bankAccountId wajib diisi/);
  });

  test('tarikSimpananSukarela dengan sumberDana BANK mengkredit akun bank yang dipilih (bukan Kas)', async () => {
    await setorSimpanan({ anggotaId: ANGGOTA_ID, jenis: 'SUKARELA', tanggal: '2026-01-01', nominal: 500_000, sumberDana: 'KAS', createdBy: 'user-1' });
    // Beri saldo bank yang cukup untuk dibayarkan.
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('journal-isi-bank','JRN-ISI','2026-01-05','period-2026','TEST_ISI_BANK','Isi saldo bank (fixture test)','POSTED','user-1',?,?,?)`,
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString()
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`,
      'je-isi-bank',
      'journal-isi-bank',
      ACC_BANK_LEDGER,
      500_000
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`,
      'je-isi-bank-lawan',
      'journal-isi-bank',
      ACC.pokok,
      500_000
    );

    await tarikSimpananSukarela({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-10',
      nominal: 200_000,
      sumberDana: 'BANK',
      bankAccountId: BANK_ACCOUNT_ID,
      createdBy: 'user-1',
    });

    const saldoBank = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(je.debit - je.kredit),0) as total FROM journal_entry je WHERE je.account_id = ?`,
      ACC_BANK_LEDGER
    );
    expect(saldoBank?.total).toBe(300_000); // 500rb - 200rb ditarik lewat bank
  });
});

// ============================================================
// Prioritas 3 (E) — BUG FIX: koreksiSimpanan() mereversal jurnal
// (ledger benar) tapi sebelumnya TIDAK mengecualikan baris ASLI yang
// dikoreksi dari perhitungan saldo `simpanan_transaksi` (dipakai di
// getSaldoSimpanan, listSaldoSimpananSemuaAnggota, & basis SHU).
// ============================================================
describe('SimpananService — koreksiSimpanan() harus benar-benar menetralkan saldo (bukan cuma jurnal) (Prioritas 3/E)', () => {
  // Bug fix (test): describe block ini sebelumnya TIDAK punya beforeEach
  // sendiri untuk meng-assign `testDb` (variabel module-level yang jadi
  // acuan mock `getDb()`/`withTransaction` di atas) — tiap test di
  // bawah memanggil `const db = await seedFixture()` sebagai variabel
  // LOKAL, sementara `setorSimpanan()`/`koreksiSimpanan()` internal
  // tetap menulis ke `testDb` (kemungkinan basi, sisa test lain yang
  // jalan sebelumnya). Akibatnya penulisan & pembacaan saldo terjadi
  // di DUA instance database SQLite in-memory yang BERBEDA, sehingga
  // saldo selalu terbaca 0 walau setoran "berhasil". Fix: beforeEach
  // di sini menyamakan `testDb` dengan instance yang dipakai test.
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('Setelah dikoreksi, getSaldoSimpanan tidak lagi menghitung setoran yang sudah dikoreksi', async () => {
    const db = testDb;

    const { id: setoranId } = await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'SUKARELA',
      tanggal: '2026-02-01',
      nominal: 500_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    let saldo = await getSaldoSimpanan(db as any, ANGGOTA_ID, 'SUKARELA');
    expect(saldo).toBe(500_000);

    await koreksiSimpanan(setoranId, 'user-1', 'Salah input nominal, dibatalkan');

    // SEBELUM FIX: saldo tetap 500.000 (baris asli tidak pernah
    // dikeluarkan dari SUM) walaupun jurnalnya sudah direversal —
    // ledger & saldo simpanan jadi tidak sinkron.
    saldo = await getSaldoSimpanan(db as any, ANGGOTA_ID, 'SUKARELA');
    expect(saldo).toBe(0);
  });

  test('listSaldoSimpananSemuaAnggota juga ikut benar setelah koreksi (konsisten dengan getSaldoSimpanan)', async () => {
    const { id: setoranId } = await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'POKOK',
      tanggal: '2026-02-01',
      nominal: 100_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await koreksiSimpanan(setoranId, 'user-1', 'Salah anggota');

    const rekap = await listSaldoSimpananSemuaAnggota();
    const row = rekap.find((r) => r.anggotaId === ANGGOTA_ID);
    // Anggota tidak lagi muncul (semua saldo 0) ATAU muncul dengan pokok 0 —
    // yang penting BUKAN 100.000.
    expect(row?.pokok ?? 0).toBe(0);
  });

  test('Setoran yang TIDAK dikoreksi tetap terhitung normal (regresi: fix tidak boleh menghapus transaksi valid)', async () => {
    const db = testDb;
    await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'SUKARELA',
      tanggal: '2026-02-01',
      nominal: 300_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const saldo = await getSaldoSimpanan(db as any, ANGGOTA_ID, 'SUKARELA');
    expect(saldo).toBe(300_000);
  });
});

describe('SimpananService — Revisi KOPKU Bagian 4/5.2/10: Simpanan Pokok hanya satu kali', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('setorSimpanan jenis POKOK kedua kalinya DITOLAK', async () => {
    await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'POKOK',
      tanggal: '2026-01-05',
      nominal: 500_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await expect(
      setorSimpanan({
        anggotaId: ANGGOTA_ID,
        jenis: 'POKOK',
        tanggal: '2026-02-05',
        nominal: 500_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/Simpanan Pokok anggota ini sudah memiliki saldo awal/);
  });

  test('setelah Pokok dikoreksi (reversal), Pokok baru BOLEH dicatat lagi', async () => {
    const { id } = await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'POKOK',
      tanggal: '2026-01-05',
      nominal: 500_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await koreksiSimpanan(id, 'user-1', 'Salah nominal, dikoreksi');

    await expect(
      setorSimpanan({
        anggotaId: ANGGOTA_ID,
        jenis: 'POKOK',
        tanggal: '2026-02-05',
        nominal: 600_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).resolves.toMatchObject({ nomorTransaksi: expect.any(String) });
  });

  test('WAJIB dan SUKARELA TIDAK terkena batasan sekali-input (bisa berkali-kali, cicilan bulanan)', async () => {
    await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'WAJIB',
      tanggal: '2026-01-05',
      nominal: 100_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await expect(
      setorSimpanan({
        anggotaId: ANGGOTA_ID,
        jenis: 'WAJIB',
        tanggal: '2026-02-05',
        nominal: 100_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).resolves.toMatchObject({ nomorTransaksi: expect.any(String) });
  });
});

describe('SimpananService — Revisi KOPKU Bagian 5: catatDataAwalSimpanan (Data Awal Simpanan Anggota, satu form)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('Pokok + Wajib + Sukarela sekaligus: SATU jurnal balance, ketiga baris simpanan_transaksi tersimpan, saldo benar', async () => {
    const { catatDataAwalSimpanan } = await import('@/services/SimpananService');
    const hasil = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-10',
      pokok: 500_000,
      wajib: 1_200_000,
      sukarela: 2_000_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    expect(hasil.idPokok).toBeTruthy();
    expect(hasil.idWajib).toBeTruthy();
    expect(hasil.idSukarela).toBeTruthy();

    // Satu jurnal untuk seluruh baris (Bagian 6 — "satu input, satu transaksi").
    const journalRows = await testDb.getAllAsync<{ id: string }>(`SELECT id FROM journal WHERE id = ?`, hasil.journalId);
    expect(journalRows).toHaveLength(1);

    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`,
      hasil.journalId
    );
    expect(entries).toHaveLength(4); // 1 debit kas + 3 kredit (pokok/wajib/sukarela)
    const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
    const totalKredit = entries.reduce((s, e) => s + e.kredit, 0);
    expect(totalDebit).toBe(3_700_000);
    expect(totalKredit).toBe(3_700_000);

    const saldoPokok = await getSaldoSimpanan(testDb as any, ANGGOTA_ID, 'POKOK');
    const saldoWajib = await getSaldoSimpanan(testDb as any, ANGGOTA_ID, 'WAJIB');
    const saldoSukarela = await getSaldoSimpanan(testDb as any, ANGGOTA_ID, 'SUKARELA');
    expect(saldoPokok).toBe(500_000);
    expect(saldoWajib).toBe(1_200_000);
    expect(saldoSukarela).toBe(2_000_000);
  });

  test('Sukarela boleh 0 (Bagian 5.4 — tidak wajib diisi setiap anggota)', async () => {
    const { catatDataAwalSimpanan } = await import('@/services/SimpananService');
    const hasil = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-10',
      pokok: 500_000,
      wajib: 1_200_000,
      sukarela: 0,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(hasil.idSukarela).toBeNull();

    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`,
      hasil.journalId
    );
    expect(entries).toHaveLength(3); // debit kas + kredit pokok + kredit wajib (TANPA baris sukarela)
  });

  test('DITOLAK kalau Pokok anggota ini sudah pernah dicatat sebelumnya (lewat catatDataAwalSimpanan ATAU setorSimpanan biasa)', async () => {
    const { catatDataAwalSimpanan } = await import('@/services/SimpananService');
    await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'POKOK',
      tanggal: '2026-01-01',
      nominal: 500_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await expect(
      catatDataAwalSimpanan({
        anggotaId: ANGGOTA_ID,
        tanggal: '2026-02-01',
        pokok: 500_000,
        wajib: 100_000,
        sukarela: 0,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/Simpanan Pokok anggota ini sudah memiliki saldo awal/);
  });

  test('ATOMICITY: kalau gagal di tengah (mapping akun Wajib hilang), TIDAK ADA baris yang tersimpan sama sekali (rollback penuh)', async () => {
    const { catatDataAwalSimpanan } = await import('@/services/SimpananService');
    // Hapus mapping SIMPANAN_WAJIB supaya proses gagal SETELAH baris Pokok "seharusnya" tersimpan.
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type = 'SIMPANAN_WAJIB'`);

    await expect(
      catatDataAwalSimpanan({
        anggotaId: ANGGOTA_ID,
        tanggal: '2026-01-10',
        pokok: 500_000,
        wajib: 1_200_000,
        sukarela: 2_000_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow();

    // Rollback penuh — TIDAK ADA baris simpanan_transaksi tersisa untuk anggota ini.
    const sisa = await testDb.getAllAsync<{ id: string }>(
      `SELECT id FROM simpanan_transaksi WHERE anggota_id = ?`,
      ANGGOTA_ID
    );
    expect(sisa).toHaveLength(0);
    const saldoPokok = await getSaldoSimpanan(testDb as any, ANGGOTA_ID, 'POKOK');
    expect(saldoPokok).toBe(0);
  });

  test('nominal negatif DITOLAK', async () => {
    const { catatDataAwalSimpanan } = await import('@/services/SimpananService');
    await expect(
      catatDataAwalSimpanan({
        anggotaId: ANGGOTA_ID,
        tanggal: '2026-01-10',
        pokok: -100,
        wajib: 100_000,
        sukarela: 0,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/tidak boleh negatif/);
  });

  test('semua nominal 0 DITOLAK (harus isi minimal salah satu)', async () => {
    const { catatDataAwalSimpanan } = await import('@/services/SimpananService');
    await expect(
      catatDataAwalSimpanan({
        anggotaId: ANGGOTA_ID,
        tanggal: '2026-01-10',
        pokok: 0,
        wajib: 0,
        sukarela: 0,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/Isi minimal salah satu/);
  });

  test('menu Simpanan existing (listSimpananHistori) langsung membaca baris yang dibuat catatDataAwalSimpanan — tidak perlu input ulang (Bagian 7)', async () => {
    const { catatDataAwalSimpanan } = await import('@/services/SimpananService');
    const { listSimpananHistori } = await import('@/services/SimpananService');
    await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-10',
      pokok: 500_000,
      wajib: 1_200_000,
      sukarela: 2_000_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const histori = await listSimpananHistori({ anggotaId: ANGGOTA_ID });
    const jenisSet = new Set(histori.map((h) => h.jenis));
    expect(jenisSet.has('POKOK')).toBe(true);
    expect(jenisSet.has('WAJIB')).toBe(true);
    expect(jenisSet.has('SUKARELA')).toBe(true);
  });
});

describe('SimpananService — Perbaikan History Transaksi: deskripsi "Setor Simpanan" (bukan "Simpanan Data Awal")', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('TEST 1: Setor Pokok saja -> deskripsi "Setor Simpanan"', async () => {
    const { catatDataAwalSimpanan } = await import('@/services/SimpananService');
    const hasil = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-10',
      pokok: 500_000,
      wajib: 0,
      sukarela: 0,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(await getJournalDeskripsi(testDb, hasil.journalId)).toBe('Setor Simpanan');
  });

  test('TEST 2: Setor Wajib saja -> deskripsi "Setor Simpanan"', async () => {
    const { catatDataAwalSimpanan } = await import('@/services/SimpananService');
    const hasil = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-10',
      pokok: 0,
      wajib: 100_000,
      sukarela: 0,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(await getJournalDeskripsi(testDb, hasil.journalId)).toBe('Setor Simpanan');
  });

  test('TEST 3: Setor Sukarela saja -> deskripsi "Setor Simpanan"', async () => {
    const { catatDataAwalSimpanan } = await import('@/services/SimpananService');
    const hasil = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-10',
      pokok: 0,
      wajib: 0,
      sukarela: 250_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(await getJournalDeskripsi(testDb, hasil.journalId)).toBe('Setor Simpanan');
  });

  test('TEST 4: Pokok + Wajib + Sukarela sekaligus -> deskripsi "Setor Simpanan"', async () => {
    const { catatDataAwalSimpanan } = await import('@/services/SimpananService');
    const hasil = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-10',
      pokok: 500_000,
      wajib: 100_000,
      sukarela: 250_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(await getJournalDeskripsi(testDb, hasil.journalId)).toBe('Setor Simpanan');
  });

  test('TEST 5: user mengisi Keterangan sendiri -> deskripsi memakai keterangan user, bukan default', async () => {
    const { catatDataAwalSimpanan } = await import('@/services/SimpananService');
    const hasil = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-08-10',
      pokok: 0,
      wajib: 100_000,
      sukarela: 0,
      sumberDana: 'KAS',
      keterangan: 'Setoran simpanan bulan Agustus',
      createdBy: 'user-1',
    });
    expect(await getJournalDeskripsi(testDb, hasil.journalId)).toBe('Setoran simpanan bulan Agustus');
  });

  test('TEST 6: Keterangan kosong/tidak diisi -> deskripsi default "Setor Simpanan"', async () => {
    const { catatDataAwalSimpanan } = await import('@/services/SimpananService');
    const hasil = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-10',
      pokok: 0,
      wajib: 100_000,
      sukarela: 0,
      sumberDana: 'KAS',
      keterangan: '',
      createdBy: 'user-1',
    });
    expect(await getJournalDeskripsi(testDb, hasil.journalId)).toBe('Setor Simpanan');
  });

  test('TEST 7: perubahan deskripsi TIDAK mengubah debit/kredit/journal/ledger/saldo anggota', async () => {
    const { catatDataAwalSimpanan } = await import('@/services/SimpananService');
    const hasil = await catatDataAwalSimpanan({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-10',
      pokok: 500_000,
      wajib: 100_000,
      sukarela: 250_000,
      sumberDana: 'KAS',
      keterangan: 'Setoran simpanan bulan Agustus',
      createdBy: 'user-1',
    });

    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(
      `SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`,
      hasil.journalId
    );
    expect(entries).toHaveLength(4);
    const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
    const totalKredit = entries.reduce((s, e) => s + e.kredit, 0);
    expect(totalDebit).toBe(850_000);
    expect(totalKredit).toBe(850_000);

    const saldoPokok = await getSaldoSimpanan(testDb as any, ANGGOTA_ID, 'POKOK');
    const saldoWajib = await getSaldoSimpanan(testDb as any, ANGGOTA_ID, 'WAJIB');
    const saldoSukarela = await getSaldoSimpanan(testDb as any, ANGGOTA_ID, 'SUKARELA');
    expect(saldoPokok).toBe(500_000);
    expect(saldoWajib).toBe(100_000);
    expect(saldoSukarela).toBe(250_000);
  });
});

describe('SimpananService — Revisi KOPKU Bagian 12: cekStatusSimpananPokok', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('sudahAda = false sebelum Pokok pernah dicatat', async () => {
    const { cekStatusSimpananPokok } = await import('@/services/SimpananService');
    const status = await cekStatusSimpananPokok(ANGGOTA_ID);
    expect(status.sudahAda).toBe(false);
    expect(status.nominal).toBe(0);
  });

  test('sudahAda = true & nominal benar setelah Pokok dicatat', async () => {
    const { cekStatusSimpananPokok } = await import('@/services/SimpananService');
    await setorSimpanan({
      anggotaId: ANGGOTA_ID,
      jenis: 'POKOK',
      tanggal: '2026-01-05',
      nominal: 500_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const status = await cekStatusSimpananPokok(ANGGOTA_ID);
    expect(status.sudahAda).toBe(true);
    expect(status.nominal).toBe(500_000);
  });
});

/**
 * RC-S118.1 — `semuaData` pada daftar kandidat Tarik Simpanan.
 *
 * Test struktural di PickerAnggotaRcS118 hanya membaca sumber; ia tidak
 * membuktikan SQL-nya benar-benar jalan. Dua hal yang harus dibuktikan
 * terhadap database sungguhan: klausa LIMIT yang dilepas tidak
 * menyisakan tanda tanya tanpa parameter (SQLite akan menolaknya), dan
 * melepas batas TIDAK ikut melepas syarat "punya saldo sukarela".
 */
describe('SimpananService — listAnggotaSaldoSukarelaTersedia semuaData (RC-S118.1)', () => {
  const JUMLAH_BERSALDO = 35; // sengaja di atas 30, yaitu batas lama
  const TANPA_SALDO = 'anggota-tanpa-sukarela';

  beforeEach(async () => {
    testDb = await seedFixture();
    const now = new Date().toISOString();
    const tambahAnggota = async (id: string, nomor: string, nama: string) => {
      await testDb.runAsync(
        `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
         VALUES (?,?,?,?,?,'AKTIF',?,?)`,
        id, nomor, `NIK-${nomor}`, nama, '2020-01-01', now, now
      );
    };

    for (let i = 0; i < JUMLAH_BERSALDO; i++) {
      const nomor = `B${String(i).padStart(3, '0')}`;
      await tambahAnggota(`bersaldo-${i}`, nomor, `Anggota Bersaldo ${nomor}`);
      await setorSimpanan({
        anggotaId: `bersaldo-${i}`, jenis: 'SUKARELA', tanggal: '2026-01-01',
        nominal: 10_000, sumberDana: 'KAS', createdBy: 'user-1',
      });
    }
    await tambahAnggota(TANPA_SALDO, 'B900', 'Anggota Tanpa Sukarela');
  });

  test('tanpa semuaData, daftar berhenti di 30 — perilaku lama tetap utuh', async () => {
    // Pemanggil lain (mis. paginasi) tidak boleh ikut berubah.
    const kandidat = await listAnggotaSaldoSukarelaTersedia();
    expect(kandidat).toHaveLength(30);
  });

  test('dengan semuaData, SELURUH anggota bersaldo muncul — lebih dari 30', async () => {
    const kandidat = await listAnggotaSaldoSukarelaTersedia({ semuaData: true });
    expect(kandidat).toHaveLength(JUMLAH_BERSALDO);
  });

  test('semuaData TIDAK memunculkan anggota tanpa saldo sukarela', async () => {
    // Inti bahayanya: melepas batas halaman tidak boleh melepas syarat
    // kelayakan, karena itu akan memulai penarikan yang tak berdasar.
    const kandidat = await listAnggotaSaldoSukarelaTersedia({ semuaData: true });
    expect(kandidat.find((k) => k.id === TANPA_SALDO)).toBeUndefined();
  });

  test('semuaData tetap menghormati pencarian', async () => {
    const kandidat = await listAnggotaSaldoSukarelaTersedia({ search: 'B001', semuaData: true });
    expect(kandidat).toHaveLength(1);
    expect(kandidat[0].nomorAnggota).toBe('B001');
  });
});

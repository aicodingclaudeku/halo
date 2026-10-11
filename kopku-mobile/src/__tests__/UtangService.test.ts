import { createTestDb, TestDb } from './testDb';

/** Pola mock sama persis dengan KasBankService.test.ts. */
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

import { terimaUtang, bayarUtang, listUtang, akruiBungaUtang, getSaldoUtangBunga } from '@/services/UtangService';

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
  utangBank: 'acc-utang-bank',
  bebanBunga: 'acc-beban-bunga',
  utangBungaAkrual: 'acc-utang-bunga-akrual',
};

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.utangBank, '2-1400', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.utangBungaAkrual, '2-1700', 'Utang Bunga', 'LIABILITAS', 'KREDIT');

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);
  await seedMapping(db, 'UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping(db, 'UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBungaAkrual);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );

  // requirePermission() butuh baris app_user nyata — 'user-1' diberi role
  // ADMIN (izin penuh) supaya test business logic di file ini tidak
  // terganggu isu permission (pola sama dengan KasBankService.test.ts).
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    new Date().toISOString(),
    new Date().toISOString()
  );

  return db;
}

describe('UtangService', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('terimaUtang: jurnal balance, DEBIT Kas KREDIT Utang Bank', async () => {
    await terimaUtang({
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      pokokPinjaman: 10_000_000,
      persenBunga: 1.5, basisBunga: 'BULANAN',
      jenisBunga: 'FLAT',
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const daftar = await listUtang({ status: 'AKTIF' });
    expect(daftar).toHaveLength(1);
    expect(daftar[0].namaPemberi).toBe('Bank BRI');
    expect(daftar[0].pokokPinjaman).toBe(10_000_000);
    expect(daftar[0].sisaPokok).toBe(10_000_000);

    const kasRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.kas
    );
    expect(kasRow?.total).toBe(10_000_000);
  });

  test('bayarUtang: sisa pokok berkurang, status tetap AKTIF jika belum lunas', async () => {
    const { id } = await terimaUtang({
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      pokokPinjaman: 10_000_000,
      persenBunga: 1.5, basisBunga: 'BULANAN',
      jenisBunga: 'FLAT',
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const hasil = await bayarUtang({
      utangId: id,
      tanggal: '2026-03-01',
      pokok: 2_000_000,
      bunga: 150_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    expect(hasil.sisaPokokSetelah).toBe(8_000_000);

    const daftar = await listUtang();
    expect(daftar[0].status).toBe('AKTIF');
    expect(daftar[0].sisaPokok).toBe(8_000_000);

    // Jurnal bunga masuk ke Beban Bunga, bukan mengurangi pokok utang.
    const bebanBungaRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.bebanBunga
    );
    expect(bebanBungaRow?.total).toBe(150_000);
  });

  test('bayarUtang: pelunasan penuh mengubah status jadi LUNAS', async () => {
    // jenisPemberi PIHAK_LAIN butuh mapping UTANG_PIHAK_LAIN — tambahkan
    // SEBELUM terimaUtang, karena mapping di-resolve saat itu juga.
    await seedAccount(testDb, 'acc-utang-lain', '2-1500', 'Utang Pihak Lain', 'LIABILITAS', 'KREDIT');
    await seedMapping(testDb, 'UTANG_PIHAK_LAIN', 'KREDIT_DEFAULT', 'acc-utang-lain');

    const { id } = await terimaUtang({
      namaPemberi: 'Koperasi Sejahtera',
      jenisPemberi: 'PIHAK_LAIN',
      pokokPinjaman: 5_000_000,
      persenBunga: 0,
      jenisBunga: 'LAINNYA',
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const hasil = await bayarUtang({
      utangId: id,
      tanggal: '2026-04-01',
      pokok: 5_000_000,
      bunga: 0,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    expect(hasil.sisaPokokSetelah).toBe(0);
    const daftar = await listUtang();
    expect(daftar[0].status).toBe('LUNAS');
  });

  test('bayarUtang: menolak pembayaran pokok melebihi sisa utang', async () => {
    const { id } = await terimaUtang({
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      pokokPinjaman: 1_000_000,
      persenBunga: 1, basisBunga: 'BULANAN',
      jenisBunga: 'FLAT',
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await expect(
      bayarUtang({
        utangId: id,
        tanggal: '2026-03-01',
        pokok: 2_000_000,
        bunga: 0,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/melebihi sisa pokok/);
  });

  test('Phase 4: bayarUtang DITOLAK kalau saldo kas tidak cukup (AUDIT_INTERNAL.md §3.4)', async () => {
    const { id } = await terimaUtang({
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      pokokPinjaman: 1_000_000,
      persenBunga: 0,
      jenisBunga: 'FLAT',
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    // Kas sekarang 1.000.000 (dari penerimaan utang). "Keluarkan" 900.000
    // lewat jurnal manual supaya sisa kas cuma 100.000 — tidak cukup
    // untuk bayar pokok 500.000.
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('journal-kuras','JRN-KURAS','2026-02-05','period-2026','TEST_KURAS','Kuras kas (fixture test)','POSTED','user-1',?,?,?)`,
      now,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`,
      'je-kuras-kas',
      'journal-kuras',
      ACC.kas,
      900_000
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`,
      'je-kuras-beban',
      'journal-kuras',
      ACC.bebanBunga,
      900_000
    );

    await expect(
      bayarUtang({ utangId: id, tanggal: '2026-03-01', pokok: 500_000, bunga: 0, sumberDana: 'KAS', createdBy: 'user-1' })
    ).rejects.toThrow(/[Ss]aldo.*tidak cukup/);

    // Sisa pokok utang TIDAK berkurang — penolakan harus utuh.
    const daftar = await listUtang();
    expect(daftar[0].sisaPokok).toBe(1_000_000);
  });

  test('listUtang: keterangan ikut terbaca (update pasca-Phase 18/19 §E — Daftar Utang)', async () => {
    await terimaUtang({
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      pokokPinjaman: 5_000_000,
      persenBunga: 1, basisBunga: 'BULANAN',
      jenisBunga: 'FLAT',
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      keterangan: 'Modal kerja tahun 2026',
      createdBy: 'user-1',
    });

    const daftar = await listUtang();
    expect(daftar[0].keterangan).toBe('Modal kerja tahun 2026');
  });
});

// ============================================================
// Prioritas 10 (L) — Biaya Pinjaman: akrual bunga utang supaya
// diakui di periode terjadinya, bukan hanya saat kas keluar.
// ============================================================
describe('UtangService — akrual bunga utang (Prioritas 10/L)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('akruiBungaUtang: DEBIT Beban Bunga = KREDIT Utang Bunga, jurnal balance, TIDAK menyentuh kas', async () => {
    const { id: utangId } = await terimaUtang({
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      pokokPinjaman: 10_000_000,
      persenBunga: 1.5, basisBunga: 'BULANAN',
      jenisBunga: 'FLAT',
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const kasSebelum = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.kas
    );

    await akruiBungaUtang({
      utangId,
      tanggal: '2026-12-31',
      nominal: 300_000,
      keterangan: 'Bunga berjalan Okt-Des 2026',
      createdBy: 'user-1',
    });

    const beban = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.bebanBunga
    );
    const utangBunga = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.utangBungaAkrual
    );
    expect(beban?.total).toBe(300_000);
    expect(utangBunga?.total).toBe(300_000);

    const kasSesudah = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.kas
    );
    expect(kasSesudah?.total).toBe(kasSebelum?.total); // kas tidak berubah sama sekali
  });

  test('akruiBungaUtang: DITOLAK untuk utang usaha (tidak ada komponen bunga)', async () => {
    await testDb.runAsync(
      `INSERT INTO utang (id, nomor_utang, nama_pemberi, jenis_pemberi, pokok_pinjaman, persen_bunga, jenis_bunga, tanggal, status, created_by, created_at, updated_at)
       VALUES ('utang-usaha-1','UTG-USAHA-1','Toko Elektronik','UTANG_USAHA',5000000,0,'FLAT','2026-01-01','AKTIF','user-1',?,?)`,
      new Date().toISOString(),
      new Date().toISOString()
    );
    await expect(
      akruiBungaUtang({ utangId: 'utang-usaha-1', tanggal: '2026-06-01', nominal: 100_000, createdBy: 'user-1' })
    ).rejects.toThrow(/[Uu]tang usaha/);
  });

  test('akruiBungaUtang: DITOLAK kalau utang sudah LUNAS', async () => {
    const { id: utangId } = await terimaUtang({
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      pokokPinjaman: 1_000_000,
      persenBunga: 1, basisBunga: 'BULANAN',
      jenisBunga: 'FLAT',
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await bayarUtang({
      utangId,
      tanggal: '2026-02-01',
      pokok: 1_000_000,
      bunga: 0,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    await expect(
      akruiBungaUtang({ utangId, tanggal: '2026-03-01', nominal: 50_000, createdBy: 'user-1' })
    ).rejects.toThrow(/lunas/i);
  });

  test('getSaldoUtangBunga: naik saat akrual, turun saat dilunasi lewat akun lawan Utang Bunga', async () => {
    const { id: utangId } = await terimaUtang({
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      pokokPinjaman: 10_000_000,
      persenBunga: 1.5, basisBunga: 'BULANAN',
      jenisBunga: 'FLAT',
      tanggal: '2026-02-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await akruiBungaUtang({ utangId, tanggal: '2026-12-31', nominal: 300_000, createdBy: 'user-1' });

    let saldo = await getSaldoUtangBunga('2026-12-31');
    expect(saldo).toBe(300_000);

    // Pelunasan lewat Kas & Bank umum (akun lawan "Utang Bunga").
    const { createJournal } = await import('@/accounting/AccountingEngine');
    await createJournal(testDb as any, {
      tanggal: '2027-01-05',
      sumberTransaksi: 'KAS_PENGELUARAN_LAIN',
      deskripsi: 'Pelunasan bunga yang sudah diakrual',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.utangBungaAkrual, debit: 300_000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 300_000 },
      ],
    });

    saldo = await getSaldoUtangBunga('2027-01-31');
    expect(saldo).toBe(0);
  });
});

describe('UtangService — Revisi KOPKU Bagian 2: listAkunKewajiban & bayarKewajibanCoa', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
    // Akun tambahan untuk skenario Bagian 2: kewajiban COA umum (Dana
    // Pendidikan) & Simpanan Sukarela (harus dikecualikan).
    await seedAccount(testDb, 'acc-dana-pendidikan', '2-1800', 'Dana Pendidikan', 'LIABILITAS', 'KREDIT');
    await seedAccount(testDb, 'acc-simpanan-sukarela', '2-1200', 'Simpanan Sukarela Anggota', 'LIABILITAS', 'KREDIT');
    await seedMapping(testDb, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', 'acc-simpanan-sukarela');
  });

  test('listAkunKewajiban: menampilkan Utang Bank (tracked) & Dana Pendidikan (COA umum), MENGECUALIKAN Simpanan Sukarela', async () => {
    const { listAkunKewajiban } = await import('@/services/UtangService');
    const daftar = await listAkunKewajiban();

    const kodeList = daftar.map((a) => a.kode);
    expect(kodeList).toContain('2-1400'); // Utang Bank
    expect(kodeList).toContain('2-1800'); // Dana Pendidikan
    expect(kodeList).not.toContain('2-1200'); // Simpanan Sukarela — DIKECUALIKAN

    const utangBank = daftar.find((a) => a.kode === '2-1400');
    expect(utangBank?.jenisPemberiTerkait).toBe('BANK');

    const danaPendidikan = daftar.find((a) => a.kode === '2-1800');
    expect(danaPendidikan?.jenisPemberiTerkait).toBeNull();
  });

  test('listAkunKewajiban: saldo tiap akun berasal dari ledger (getAccountBalance), bukan Rp0 statis', async () => {
    const { listAkunKewajiban, bayarKewajibanCoa } = await import('@/services/UtangService');

    // Danai kas dulu, lalu bayar sebagian Dana Pendidikan supaya akun
    // ini punya saldo KREDIT sisa (kewajiban belum lunas) di ledger.
    await terimaUtang({
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      pokokPinjaman: 10_000_000,
      persenBunga: 0,
      jenisBunga: 'FLAT',
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    // DIPERBARUI RC-S74 (LEGACY EXPECTATION): versi lama membayar 1jt ke akun
    // bersaldo 0 lalu mengharapkan saldo -1jt. RC-S74 §9/§20 kini MENOLAK
    // pembayaran yang melebihi saldo kewajiban. Maksud test tetap dijaga:
    //  (a) saldo berasal dari LEDGER (bukan Rp0 statis), dan
    //  (b) saldo negatif historis tetap ditampilkan APA ADANYA.
    const { createJournal } = await import('@/accounting/AccountingEngine');
    const sebelum = await listAkunKewajiban();
    expect(sebelum.find((a) => a.kode === '2-1800')?.saldo).toBe(0);

    // Pengakuan kewajiban Dana Pendidikan 3jt (Dr beban / Cr kewajiban).
    await createJournal(testDb as any, {
      tanggal: '2026-01-15', sumberTransaksi: 'JURNAL_UMUM', deskripsi: 'Pengakuan Dana Pendidikan', createdBy: 'user-1',
      lines: [
        { accountId: ACC.bebanBunga, debit: 3_000_000, kredit: 0 },
        { accountId: 'acc-dana-pendidikan', debit: 0, kredit: 3_000_000 },
      ],
    });
    expect((await listAkunKewajiban()).find((a) => a.kode === '2-1800')?.saldo).toBe(3_000_000);

    await bayarKewajibanCoa({ accountId: 'acc-dana-pendidikan', tanggal: '2026-02-01', nominal: 1_000_000, sumberDana: 'KAS', createdBy: 'user-1' });
    expect((await listAkunKewajiban()).find((a) => a.kode === '2-1800')?.saldo).toBe(2_000_000);

    // Koreksi historis (jurnal langsung, bukan pembayaran normal) membuat saldo
    // negatif — listAkunKewajiban menampilkannya APA ADANYA (tanpa Math.max/abs).
    await createJournal(testDb as any, {
      tanggal: '2026-03-01', sumberTransaksi: 'JURNAL_UMUM', deskripsi: 'Koreksi historis', createdBy: 'user-1',
      lines: [
        { accountId: 'acc-dana-pendidikan', debit: 2_500_000, kredit: 0 },
        { accountId: ACC.kas, debit: 0, kredit: 2_500_000 },
      ],
    });
    const sesudah = await listAkunKewajiban();
    const danaPendidikanSesudah = sesudah.find((a) => a.kode === '2-1800');
    expect(danaPendidikanSesudah?.saldo).toBe(-500_000);
  });

  test('listAkunKewajiban: TIDAK ada duplikasi akun (setiap accountId hanya muncul sekali)', async () => {
    const { listAkunKewajiban } = await import('@/services/UtangService');
    const daftar = await listAkunKewajiban();
    const idSet = new Set(daftar.map((a) => a.accountId));
    expect(idSet.size).toBe(daftar.length);
  });

  test('bayarKewajibanCoa: Dana Pendidikan (kewajiban COA umum) — DEBIT akun kewajiban, KREDIT Kas, jurnal balance', async () => {
    const { bayarKewajibanCoa } = await import('@/services/UtangService');
    // Danai kas dulu lewat penerimaan utang (pola sama seperti test bayarUtang di atas).
    await terimaUtang({
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      pokokPinjaman: 10_000_000,
      persenBunga: 0,
      jenisBunga: 'FLAT',
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    // DIPERBARUI RC-S74: kewajiban diakui dulu (RC-S74 §9 menolak pembayaran
    // ke akun bersaldo 0). Assertion jurnal di bawah TIDAK berubah.
    const { createJournal } = await import('@/accounting/AccountingEngine');
    await createJournal(testDb as any, {
      tanggal: '2026-01-15', sumberTransaksi: 'JURNAL_UMUM', deskripsi: 'Pengakuan Dana Pendidikan', createdBy: 'user-1',
      lines: [
        { accountId: ACC.bebanBunga, debit: 1_000_000, kredit: 0 },
        { accountId: 'acc-dana-pendidikan', debit: 0, kredit: 1_000_000 },
      ],
    });

    const { journalId } = await bayarKewajibanCoa({
      accountId: 'acc-dana-pendidikan',
      tanggal: '2026-02-01',
      nominal: 1_000_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(journalId).toBeTruthy();

    const danaPendidikanRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      'acc-dana-pendidikan'
    );
    expect(danaPendidikanRow?.total).toBe(1_000_000);

    const kasRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.kas
    );
    expect(kasRow?.total).toBe(1_000_000);
  });

  test('bayarKewajibanCoa: DITOLAK untuk akun Simpanan Sukarela (Bagian 2.5 — alur tersendiri)', async () => {
    const { bayarKewajibanCoa } = await import('@/services/UtangService');
    await expect(
      bayarKewajibanCoa({
        accountId: 'acc-simpanan-sukarela',
        tanggal: '2026-02-01',
        nominal: 500_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/Simpanan Sukarela memiliki alur transaksi tersendiri/);
  });

  test('bayarKewajibanCoa: DITOLAK untuk akun yang dikelola lewat tracking utang (Utang Bank) — harus lewat bayarUtang/UtangPicker', async () => {
    const { bayarKewajibanCoa } = await import('@/services/UtangService');
    await expect(
      bayarKewajibanCoa({
        accountId: ACC.utangBank,
        tanggal: '2026-02-01',
        nominal: 500_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/dikelola lewat pencatatan Utang Koperasi/);
  });

  test('bayarKewajibanCoa: DITOLAK untuk akun bukan LIABILITAS (mis. Kas)', async () => {
    const { bayarKewajibanCoa } = await import('@/services/UtangService');
    await expect(
      bayarKewajibanCoa({
        accountId: ACC.kas,
        tanggal: '2026-02-01',
        nominal: 500_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/bukan akun Liabilitas/);
  });

  test('bayarUtang existing TETAP jalan normal setelah Bagian 2 (regresi — mekanisme lama tidak rusak)', async () => {
    const { id } = await terimaUtang({
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      pokokPinjaman: 5_000_000,
      persenBunga: 1, basisBunga: 'BULANAN',
      jenisBunga: 'FLAT',
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const hasil = await bayarUtang({
      utangId: id,
      tanggal: '2026-02-01',
      pokok: 1_000_000,
      bunga: 50_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(hasil.sisaPokokSetelah).toBe(4_000_000);
  });

  test('listUtang(jenisPemberi): filter berfungsi — dipakai UtangPicker setelah akun COA dipilih', async () => {
    await seedAccount(testDb, 'acc-utang-lain', '2-1500', 'Utang Pihak Lain', 'LIABILITAS', 'KREDIT');
    await seedMapping(testDb, 'UTANG_PIHAK_LAIN', 'KREDIT_DEFAULT', 'acc-utang-lain');

    await terimaUtang({
      namaPemberi: 'Bank BRI',
      jenisPemberi: 'BANK',
      pokokPinjaman: 3_000_000,
      persenBunga: 0,
      jenisBunga: 'FLAT',
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await terimaUtang({
      namaPemberi: 'Koperasi Mitra',
      jenisPemberi: 'PIHAK_LAIN',
      pokokPinjaman: 2_000_000,
      persenBunga: 0,
      jenisBunga: 'FLAT',
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const hanyaBank = await listUtang({ status: 'AKTIF', jenisPemberi: 'BANK' });
    expect(hanyaBank).toHaveLength(1);
    expect(hanyaBank[0].namaPemberi).toBe('Bank BRI');

    const hanyaPihakLain = await listUtang({ status: 'AKTIF', jenisPemberi: 'PIHAK_LAIN' });
    expect(hanyaPihakLain).toHaveLength(1);
    expect(hanyaPihakLain[0].namaPemberi).toBe('Koperasi Mitra');
  });
});

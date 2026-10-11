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
  listAkunPendapatanLainnya,
  tambahTransaksiPendapatan,
  listTransaksiPendapatan,
  koreksiTransaksiPendapatan,
  getPendapatanByClassification,
  getPendapatanAkunDetail,
} from '@/services/PendapatanLainnyaService';

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  normalBalance: 'DEBIT' | 'KREDIT',
  opts: { isSystem?: boolean; isActive?: boolean; lhuKlasifikasi?: string | null } = {}
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    opts.isActive === false ? 0 : 1,
    opts.isSystem ? 1 : 0,
    opts.lhuKlasifikasi ?? null,
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
  pendapatanJasa: 'acc-pendapatan-jasa', // is_system: true — tidak boleh muncul di menu ini
  pendapatanUsahaLain: 'acc-pendapatan-usaha-lain', // sudah diklasifikasikan
  pendapatanBelumKlasifikasi: 'acc-pendapatan-belum-klasifikasi',
  bebanGaji: 'acc-beban-gaji', // kategori BEBAN — bukan akun pendapatan
};

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT', { isSystem: true });
  await seedAccount(db, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT', { isSystem: true });
  await seedAccount(db, ACC.pendapatanUsahaLain, '4-2000', 'Pendapatan Usaha Lain', 'PENDAPATAN', 'KREDIT', {
    lhuKlasifikasi: 'PENDAPATAN_USAHA_LAIN',
  });
  await seedAccount(db, ACC.pendapatanBelumKlasifikasi, '4-9000', 'Pendapatan Belum Diklasifikasikan', 'PENDAPATAN', 'KREDIT', {});
  await seedAccount(db, ACC.bebanGaji, '5-1100', 'Beban Gaji', 'BEBAN', 'DEBIT', { lhuKlasifikasi: 'BEBAN_USAHA' });

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);

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

async function saldoAkun(db: TestDb, accountId: string): Promise<number> {
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(kredit),0) - COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
    accountId
  );
  return row?.total ?? 0;
}

describe('PendapatanLainnyaService', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('listAkunPendapatanLainnya: hanya akun PENDAPATAN non-sistem (Bagian E — Pendapatan Jasa Pinjaman/Administrasi/Denda tidak muncul di sini)', async () => {
    const options = await listAkunPendapatanLainnya();
    const kodeList = options.map((o) => o.kode).sort();
    expect(kodeList).toEqual(['4-2000', '4-9000']);
    expect(options.find((o) => o.kode === '4-2000')?.klasifikasiLhu).toBe('PENDAPATAN_USAHA_LAIN');
    expect(options.find((o) => o.kode === '4-9000')?.klasifikasiLhu).toBeNull();
  });

  test('tambahTransaksiPendapatan: Dr Kas, Kr akun pendapatan terpilih — jurnal balance, 1x jalan (Bagian L/AB)', async () => {
    const hasil = await tambahTransaksiPendapatan({
      tanggal: '2026-01-10',
      accountId: ACC.pendapatanUsahaLain,
      nominal: 2_000_000,
      jenis: 'KAS',
      createdBy: 'user-1',
    });
    expect(hasil.klasifikasiLhu).toBe('PENDAPATAN_USAHA_LAIN');
    expect(await saldoAkun(testDb, ACC.pendapatanUsahaLain)).toBe(2_000_000);
    expect(await saldoAkun(testDb, ACC.kas)).toBe(-2_000_000); // kas normal DEBIT, query di atas pakai kredit-debit -> negatif berarti debit bertambah, benar

    const jumlahJournal = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jumlahJournal?.cnt).toBe(1); // tidak ada duplikasi jurnal (Bagian AB)
  });

  test('tambahTransaksiPendapatan: DITOLAK kalau akun belum diklasifikasikan untuk LHU (Bagian AA — pesan persis)', async () => {
    await expect(
      tambahTransaksiPendapatan({
        tanggal: '2026-01-10',
        accountId: ACC.pendapatanBelumKlasifikasi,
        nominal: 1_000_000,
        jenis: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow('Akun ini belum diklasifikasikan untuk LHU.');
  });

  test('tambahTransaksiPendapatan: DITOLAK kalau akun yang dipilih bukan kategori Pendapatan', async () => {
    await expect(
      tambahTransaksiPendapatan({
        tanggal: '2026-01-10',
        accountId: ACC.bebanGaji,
        nominal: 1_000_000,
        jenis: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow('bukan akun Pendapatan');
  });

  test('listTransaksiPendapatan: menampilkan tanggal/akun/klasifikasi/nominal/kas-bank/keterangan/status (Bagian C)', async () => {
    await tambahTransaksiPendapatan({
      tanggal: '2026-02-01',
      accountId: ACC.pendapatanUsahaLain,
      nominal: 500_000,
      jenis: 'KAS',
      keterangan: 'Sewa aula',
      createdBy: 'user-1',
    });

    const rows = await listTransaksiPendapatan();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      akunKode: '4-2000',
      klasifikasiLhu: 'PENDAPATAN_USAHA_LAIN',
      nominal: 500_000,
      keterangan: 'Sewa aula',
      status: 'AKTIF',
    });
  });

  test('koreksiTransaksiPendapatan: reversal, saldo kembali, status berubah jadi DIKOREKSI (Bagian Z — bukan hapus langsung)', async () => {
    const { id } = await tambahTransaksiPendapatan({
      tanggal: '2026-02-01',
      accountId: ACC.pendapatanUsahaLain,
      nominal: 500_000,
      jenis: 'KAS',
      createdBy: 'user-1',
    });
    expect(await saldoAkun(testDb, ACC.pendapatanUsahaLain)).toBe(500_000);

    await koreksiTransaksiPendapatan('KAS', id, 'user-1', 'Salah input');
    expect(await saldoAkun(testDb, ACC.pendapatanUsahaLain)).toBe(0);

    const rows = await listTransaksiPendapatan();
    expect(rows.find((r) => r.id === id)?.status).toBe('DIKOREKSI');

    const jurnalRow = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM journal WHERE id = (SELECT journal_id FROM kas_transaksi WHERE id = ?)`, id);
    expect(jurnalRow?.status).toBe('REVERSED'); // jurnal asal di-reversal, bukan dihapus
  });

  test('membuka kembali Daftar/Riwayat Pendapatan tidak membuat jurnal baru (Bagian Y/AB)', async () => {
    await tambahTransaksiPendapatan({
      tanggal: '2026-02-01',
      accountId: ACC.pendapatanUsahaLain,
      nominal: 500_000,
      jenis: 'KAS',
      createdBy: 'user-1',
    });
    await listTransaksiPendapatan();
    await listTransaksiPendapatan();

    const jumlahJournal = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jumlahJournal?.cnt).toBe(1);
  });
});

describe('PendapatanLainnyaService — Revisi "Daftar Pendapatan": getPendapatanByClassification', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('mengelompokkan per lhu_klasifikasi, MENGECUALIKAN Pendapatan Jasa Pinjaman (Bagian 14)', async () => {
    await tambahTransaksiPendapatan({
      tanggal: '2026-01-10',
      accountId: ACC.pendapatanUsahaLain,
      nominal: 2_000_000,
      jenis: 'KAS',
      createdBy: 'user-1',
    });
    // Pendapatan Jasa Pinjaman (4-1000) diberi saldo langsung lewat jurnal manual
    // (fixture tidak punya alur angsuran) — HARUS tetap tidak muncul di hasil.
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('j-jasa','J-JASA-1','2026-01-15','period-2026','ANGSURAN_JASA','Angsuran jasa','POSTED','user-1',?,?,?)`,
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString()
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je-jasa-1','j-jasa',?,0,1000000,1)`,
      ACC.pendapatanJasa
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je-jasa-2','j-jasa',?,1000000,0,2)`,
      ACC.kas
    );

    const hasil = await getPendapatanByClassification('2026-01-01', '2026-01-31');

    const kodeUsahaLain = hasil.pendapatanUsahaLain.map((r) => r.kode);
    expect(kodeUsahaLain).toContain('4-2000');
    expect(hasil.pendapatanUsahaLain.find((r) => r.kode === '4-2000')?.nominal).toBe(2_000_000);
    expect(hasil.totalPendapatanUsahaLain).toBe(2_000_000);

    // Jasa Pinjaman TIDAK boleh muncul di kelompok mana pun (bukan usaha lain, bukan belum diklasifikasikan).
    const semuaKode = [
      ...hasil.pendapatanUsahaLain,
      ...hasil.hasilInvestasi,
      ...hasil.pendapatanLain,
      ...hasil.belumDiklasifikasikan,
    ].map((r) => r.kode);
    expect(semuaKode).not.toContain('4-1000');
  });

  test('akun belum diklasifikasikan masuk bucket terpisah, TIDAK ikut Total Pendapatan (Bagian 13)', async () => {
    await tambahTransaksiPendapatan({
      tanggal: '2026-01-10',
      accountId: ACC.pendapatanUsahaLain,
      nominal: 2_000_000,
      jenis: 'KAS',
      createdBy: 'user-1',
    });
    // Beri saldo langsung ke akun yang belum diklasifikasikan (4-9000) lewat jurnal manual.
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('j-belum','J-BELUM-1','2026-01-12','period-2026','KAS_PENERIMAAN_LAIN','Penerimaan lain','POSTED','user-1',?,?,?)`,
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString()
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je-belum-1','j-belum',?,0,750000,1)`,
      ACC.pendapatanBelumKlasifikasi
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, urutan) VALUES ('je-belum-2','j-belum',?,750000,0,2)`,
      ACC.kas
    );

    const hasil = await getPendapatanByClassification('2026-01-01', '2026-01-31');

    expect(hasil.belumDiklasifikasikan.find((r) => r.kode === '4-9000')?.nominal).toBe(750_000);
    expect(hasil.totalBelumDiklasifikasikan).toBe(750_000);
    // Total Pendapatan HANYA 3 kelompok resmi (Bagian 8) — belum diklasifikasikan TIDAK ikut dijumlah.
    expect(hasil.totalPendapatan).toBe(2_000_000);
  });

  test('akun terklasifikasi TANPA transaksi pada periode tetap tampil dengan nominal Rp0 (Bagian 4/8/21 — beda dari getLabaRugi yang skip)', async () => {
    const hasil = await getPendapatanByClassification('2026-01-01', '2026-01-31');
    const usahaLain = hasil.pendapatanUsahaLain.find((r) => r.kode === '4-2000');
    expect(usahaLain).toBeDefined();
    expect(usahaLain?.nominal).toBe(0);
  });

  test('akun nonaktif tidak ditampilkan (Bagian 12), histori tetap aman di ledger', async () => {
    await testDb.runAsync(`UPDATE account SET is_active = 0 WHERE id = ?`, ACC.pendapatanUsahaLain);
    const hasil = await getPendapatanByClassification('2026-01-01', '2026-01-31');
    const kodeSemua = [...hasil.pendapatanUsahaLain, ...hasil.hasilInvestasi, ...hasil.pendapatanLain, ...hasil.belumDiklasifikasikan].map(
      (r) => r.kode
    );
    expect(kodeSemua).not.toContain('4-2000');
  });

  test('periode berbeda -> nominal ikut berubah, transaksi di luar periode tidak ikut terhitung (Bagian 9)', async () => {
    await tambahTransaksiPendapatan({
      tanggal: '2026-01-10',
      accountId: ACC.pendapatanUsahaLain,
      nominal: 1_000_000,
      jenis: 'KAS',
      createdBy: 'user-1',
    });
    await tambahTransaksiPendapatan({
      tanggal: '2026-02-10',
      accountId: ACC.pendapatanUsahaLain,
      nominal: 500_000,
      jenis: 'KAS',
      createdBy: 'user-1',
    });

    const januari = await getPendapatanByClassification('2026-01-01', '2026-01-31');
    expect(januari.pendapatanUsahaLain.find((r) => r.kode === '4-2000')?.nominal).toBe(1_000_000);

    const februari = await getPendapatanByClassification('2026-02-01', '2026-02-28');
    expect(februari.pendapatanUsahaLain.find((r) => r.kode === '4-2000')?.nominal).toBe(500_000);
  });
});

describe('PendapatanLainnyaService — Revisi "Daftar Pendapatan": getPendapatanAkunDetail (Bagian 10)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('mengembalikan kode/nama/saldo periode + daftar transaksi dari ledger existing', async () => {
    await tambahTransaksiPendapatan({
      tanggal: '2026-01-10',
      accountId: ACC.pendapatanUsahaLain,
      nominal: 500_000,
      jenis: 'KAS',
      keterangan: 'Sewa aula',
      createdBy: 'user-1',
    });

    const detail = await getPendapatanAkunDetail(ACC.pendapatanUsahaLain, '2026-01-01', '2026-01-31');
    expect(detail.kode).toBe('4-2000');
    expect(detail.nama).toBe('Pendapatan Usaha Lain');
    expect(detail.saldoPeriode).toBe(500_000);
    expect(detail.transaksi).toHaveLength(1);
    expect(detail.transaksi[0]).toMatchObject({ debit: 0, kredit: 500_000, saldoBerjalan: 500_000 });
  });

  test('DITOLAK kalau akun bukan kategori Pendapatan', async () => {
    await expect(getPendapatanAkunDetail(ACC.bebanGaji, '2026-01-01', '2026-01-31')).rejects.toThrow('bukan akun Pendapatan');
  });

  test('akun tanpa transaksi pada periode -> saldoPeriode 0, transaksi kosong (bukan error)', async () => {
    const detail = await getPendapatanAkunDetail(ACC.pendapatanUsahaLain, '2026-01-01', '2026-01-31');
    expect(detail.saldoPeriode).toBe(0);
    expect(detail.transaksi).toHaveLength(0);
  });
});

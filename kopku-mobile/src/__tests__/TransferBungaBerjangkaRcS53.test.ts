import { createTestDb, TestDb } from './testDb';
import { seedKebijakanProdukUji } from './kebijakanProdukBerjangkaUji';

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

import { setorSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import {
  prosesAkrualBungaKontrak,
  prosesJatuhTempoSimpananBerjangka,
  cairkanSimpananBerjangka,
  prosesTransferBungaKeSukarela,
  processAccruedTermDepositInterestDue,
  getStatusTransferBunga,
  getTotalUtangBungaBerjangka,
  kunciTransferBunga,
  TRANSAKSI_BUNGA_TRANSFER,
} from '@/services/SimpananBerjangkaLifecycleService';

/**
 * §B — PEMINDAHAN BUNGA SIMPANAN BERJANGKA KE SIMPANAN SUKARELA.
 *
 * SELURUH suite ini berjalan di atas SQLite sungguhan
 * (`.harness/testDb.ts` / `node:sqlite`) dengan skema produksi dan
 * jurnal yang dibuat AccountingEngine asli. Tidak ada mock akuntansi:
 * angka yang diperiksa adalah angka yang benar-benar duduk di
 * `journal_entry`.
 *
 * Itu penting untuk fitur ini secara khusus. Klaim "idempotent" dan
 * "tidak double posting" hanya bermakna bila dibuktikan terhadap
 * constraint database yang sesungguhnya — bukan terhadap tiruan yang
 * kebetulan berperilaku seperti yang diharapkan penulis test.
 */

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  berjangka: 'acc-2-1210',
  sukarela: 'acc-2-1200',
  utangBunga: 'acc-2-1710',
  bebanBunga: 'acc-5-1955',
  modal: 'acc-3-1000',
};

const BANK_ID = 'bank-1';

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  nb: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id,
    kode,
    nama,
    kategori,
    nb,
    now,
    now
  );
}

async function seedMapping(db: TestDb, tt: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`,
    tt,
    role,
    accountId
  );
}

async function seedFixture(opts: { periode2027?: 'OPEN' | 'CLOSED' } = {}): Promise<TestDb> {
  const db = await createTestDb();
  await seedKebijakanProdukUji(db); // RC-S128: penempatan berjangka mewajibkan kebijakan produk
  const now = new Date().toISOString();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.bank, '1-1100', 'Bank A', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.berjangka, '2-1210', 'Simpanan Berjangka', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.sukarela, '2-1200', 'Simpanan Sukarela Anggota', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.utangBunga, '2-1710', 'Utang Bunga Simpanan Berjangka', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.bebanBunga, '5-1955', 'Beban Bunga Simpanan Berjangka', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'SIMPANAN_BERJANGKA', 'KREDIT_DEFAULT', ACC.berjangka);
  await seedMapping(db, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', ACC.sukarela);
  await seedMapping(db, 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'DEBIT_BEBAN', ACC.bebanBunga);
  await seedMapping(db, 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'KREDIT_UTANG_BUNGA', ACC.utangBunga);
  await seedMapping(db, 'SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_POKOK', ACC.berjangka);
  await seedMapping(db, 'SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_UTANG_BUNGA', ACC.utangBunga);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2026',2026,'2026-01-01','2026-12-31','OPEN')`
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES ('p2027',2027,'2027-01-01','2027-12-31',?)`,
    opts.periode2027 ?? 'OPEN'
  );

  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES ('anggota-A','A001','1111111111111111','Anggota A','2020-01-01','AKTIF',?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, created_at)
     VALUES (?,?,?,?,?,1,?)`,
    BANK_ID,
    'Bank A',
    '123',
    'Koperasi',
    ACC.bank,
    now
  );
  return db;
}

/** Saldo akun dari LEDGER — kredit dikurangi debit (akun liabilitas). */
async function saldoKredit(accountId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.kredit) - SUM(je.debit), 0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status = 'POSTED'`,
    accountId
  );
  return r?.s ?? 0;
}

/** Saldo akun beban — debit dikurangi kredit. */
async function saldoDebit(accountId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.debit) - SUM(je.kredit), 0) s
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE je.account_id = ? AND j.status = 'POSTED'`,
    accountId
  );
  return r?.s ?? 0;
}

async function jumlahJurnalTransfer(): Promise<number> {
  const r = await testDb.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = ?`,
    TRANSAKSI_BUNGA_TRANSFER
  );
  return r?.n ?? 0;
}

/** Saldo sukarela dari SUBLEDGER `simpanan_transaksi`, bukan dari ledger. */
async function saldoSukarelaSubledger(anggotaId: string): Promise<number> {
  const r = await testDb.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(CASE WHEN tipe='SETOR' THEN nominal
                              WHEN tipe='TARIK' THEN -nominal ELSE 0 END), 0) s
       FROM simpanan_transaksi WHERE anggota_id = ? AND jenis = 'SUKARELA'`,
    anggotaId
  );
  return r?.s ?? 0;
}

/**
 * Kontrak 12.000.000, 12%/tahun, tenor 3 bulan, mulai 2026-01-15.
 * Total bunga kontraktual = 12.000.000 x 12% x 3/12 = 360.000,
 * terbagi 120.000 per periode bulanan.
 */
async function buatKontrak(mulai = '2026-01-15'): Promise<string> {
  const hasil = await setorSimpananBerjangka({
    anggotaId: 'anggota-A',
    nominal: 12_000_000,
    tenorBulan: 3,
    sukuBungaPerTahun: 12,
    tanggal: mulai,
    sumberDana: 'KAS',
    createdBy: 'user-1',
  });
  return hasil.id;
}

beforeEach(async () => {
  testDb = await seedFixture();
});

afterEach(() => {
  testDb.closeSync();
});

// ===========================================================================
// BASIC
// ===========================================================================

describe('§B BASIC — posting pertama', () => {
  it('1-2. bunga terakru tersedia, posting pertama berhasil', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');

    const hasil = await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    expect(hasil.totalDipindahkanSekarang).toBe(120_000);
    expect(hasil.periodeDipindahkan).toEqual([1]);
  });

  it('3-5. Dr 2-1710, Cr 2-1200, jurnal balanced', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    const baris = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT je.account_id, je.debit, je.kredit
         FROM journal_entry je JOIN journal j ON j.id = je.journal_id
        WHERE j.sumber_transaksi = ? ORDER BY je.urutan`,
      TRANSAKSI_BUNGA_TRANSFER
    );
    expect(baris).toHaveLength(2);

    const debit = baris.filter((b) => b.debit > 0);
    const kredit = baris.filter((b) => b.kredit > 0);
    expect(debit).toHaveLength(1);
    expect(kredit).toHaveLength(1);
    expect(debit[0].account_id).toBe(ACC.utangBunga);
    expect(debit[0].debit).toBe(120_000);
    expect(kredit[0].account_id).toBe(ACC.sukarela);
    expect(kredit[0].kredit).toBe(120_000);

    const totalDebit = baris.reduce((t, b) => t + b.debit, 0);
    const totalKredit = baris.reduce((t, b) => t + b.kredit, 0);
    expect(totalDebit).toBe(totalKredit);
  });

  it('6. saldo Simpanan Sukarela bertambah di SUBLEDGER, bukan hanya di ledger', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    expect(await saldoSukarelaSubledger('anggota-A')).toBe(0);

    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    expect(await saldoSukarelaSubledger('anggota-A')).toBe(120_000);
    expect(await saldoKredit(ACC.sukarela)).toBe(120_000);
  });

  it('7. saldo Utang Bunga berkurang tepat sebesar yang dipindahkan', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    expect(await saldoKredit(ACC.utangBunga)).toBe(120_000);

    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
  });

  it('8. POKOK simpanan berjangka TIDAK berubah', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    const sebelum = await saldoKredit(ACC.berjangka);

    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    expect(await saldoKredit(ACC.berjangka)).toBe(sebelum);
    expect(await saldoKredit(ACC.berjangka)).toBe(12_000_000);
    const k = await testDb.getFirstAsync<{ nominal: number }>(
      `SELECT nominal FROM simpanan_berjangka WHERE id = ?`,
      id
    );
    expect(k?.nominal).toBe(12_000_000);
  });
});

// ===========================================================================
// IDEMPOTENCY
// ===========================================================================

describe('§B IDEMPOTENCY', () => {
  it('9-10. run kedua & ketiga memindahkan 0 dan tidak membuat jurnal', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');

    const r1 = await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    const r2 = await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    const r3 = await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    expect(r1.totalDipindahkanSekarang).toBe(120_000);
    expect(r2.totalDipindahkanSekarang).toBe(0);
    expect(r3.totalDipindahkanSekarang).toBe(0);
    expect(await jumlahJurnalTransfer()).toBe(1);
    expect(await saldoSukarelaSubledger('anggota-A')).toBe(120_000);
  });

  it('11. double-submit beruntun tidak menduplikasi', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    for (let i = 0; i < 5; i += 1) {
      await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    }
    expect(await jumlahJurnalTransfer()).toBe(1);
    expect(await saldoKredit(ACC.sukarela)).toBe(120_000);
  });

  it('12. restart aplikasi (state memori hilang) tetap tidak menduplikasi', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    // "Restart": tidak ada cache yang dibawa; keputusan hanya dari DB.
    const lagi = await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    expect(lagi.totalDipindahkanSekarang).toBe(0);
    expect(await jumlahJurnalTransfer()).toBe(1);
  });

  it('13. jurnal yang sudah ada terdeteksi lewat sumber_transaksi + sumber_id', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    const status = await getStatusTransferBunga(id);
    expect(status).toHaveLength(1);
    expect(status[0].sudahDitransfer).toBe(true);
    expect(status[0].journalTransferId).not.toBeNull();

    const j = await testDb.getFirstAsync<{ sumber_id: string }>(
      `SELECT sumber_id FROM journal WHERE sumber_transaksi = ?`,
      TRANSAKSI_BUNGA_TRANSFER
    );
    expect(j?.sumber_id).toBe(status[0].bungaId);
  });
});

// ===========================================================================
// CATCH-UP
// ===========================================================================

describe('§B CATCH-UP', () => {
  it('14-15. dua periode terlewat diproses SEMUANYA, bukan yang terakhir saja', async () => {
    const id = await buatKontrak();
    // Aplikasi baru dibuka 2026-04-20: periode 1, 2, dan 3 sudah earned.
    await prosesAkrualBungaKontrak(id, '2026-04-20', 'user-1');

    const hasil = await prosesTransferBungaKeSukarela(id, '2026-04-20', 'user-1');
    expect(hasil.periodeDipindahkan).toEqual([1, 2, 3]);
    expect(hasil.totalDipindahkanSekarang).toBe(360_000);
    expect(await jumlahJurnalTransfer()).toBe(3);
    expect(await saldoSukarelaSubledger('anggota-A')).toBe(360_000);
  });

  it('catch-up bertahap: periode 1 lalu periode 2, tanpa mengulang periode 1', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    await prosesAkrualBungaKontrak(id, '2026-03-20', 'user-1');
    const kedua = await prosesTransferBungaKeSukarela(id, '2026-03-20', 'user-1');

    expect(kedua.periodeDipindahkan).toEqual([2]);
    expect(kedua.totalDipindahkanSekarang).toBe(120_000);
    expect(await jumlahJurnalTransfer()).toBe(2);
  });

  it('16. periode yang BELUM jatuh tempo tidak dipindahkan', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-04-20', 'user-1');

    // Hanya periode 1 (berakhir 2026-02-15) yang sudah lewat.
    const hasil = await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    expect(hasil.periodeDipindahkan).toEqual([1]);
    expect(await jumlahJurnalTransfer()).toBe(1);
  });

  it('jurnal transfer bertanggal AKHIR PERIODE, bukan tanggal proses', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-04-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-04-20', 'user-1');

    const tanggal = await testDb.getAllAsync<{ tanggal: string }>(
      `SELECT tanggal FROM journal WHERE sumber_transaksi = ? ORDER BY tanggal`,
      TRANSAKSI_BUNGA_TRANSFER
    );
    expect(tanggal.map((t) => t.tanggal)).toEqual(['2026-02-15', '2026-03-15', '2026-04-15']);
  });
});

// ===========================================================================
// CONCURRENCY
// ===========================================================================

describe('§B CONCURRENCY', () => {
  it('17-18. dua pemanggil bersamaan menghasilkan SATU jurnal', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');

    const [a, b] = await Promise.allSettled([
      prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1'),
      prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1'),
    ]);

    // Salah satu memindahkan 120.000; yang lain memindahkan 0 ATAU
    // ditolak UNIQUE index. Yang TIDAK BOLEH: keduanya berhasil penuh.
    const nilai = [a, b].map((r) =>
      r.status === 'fulfilled' ? r.value.totalDipindahkanSekarang : -1
    );
    expect(nilai.filter((n) => n === 120_000)).toHaveLength(1);

    expect(await jumlahJurnalTransfer()).toBe(1);
    expect(await saldoSukarelaSubledger('anggota-A')).toBe(120_000);
    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
  });

  it('kunci idempotensi bersifat deterministik per kontrak + periode', async () => {
    expect(kunciTransferBunga('SB-001', 9)).toBe('SBT-SB-001-9');
    expect(kunciTransferBunga('SB-001', 9)).toBe(kunciTransferBunga('SB-001', 9));
    expect(kunciTransferBunga('SB-001', 9)).not.toBe(kunciTransferBunga('SB-001', 10));
  });

  it('UNIQUE index database benar-benar menolak kunci kembar', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');

    const status = await getStatusTransferBunga(id);
    const kunci = kunciTransferBunga(id, status[0].nomorPeriode);
    await expect(
      testDb.runAsync(
        `INSERT INTO simpanan_transaksi
          (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi,
           idempotency_key, created_by, created_at)
         VALUES ('dup','anggota-A','SUKARELA','SETOR','2026-02-15',1,'KAS','DUP-1',?, 'user-1','x')`,
        kunci
      )
    ).rejects.toThrow(/UNIQUE/i);
  });
});

// ===========================================================================
// FAILURE SAFETY
// ===========================================================================

describe('§B FAILURE SAFETY', () => {
  it('19. gagal SEBELUM jurnal (mapping 2-1200 hilang) -> tidak ada jurnal sama sekali', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await testDb.runAsync(
      `DELETE FROM account_mapping WHERE transaction_type='SIMPANAN_SUKARELA'`
    );

    await expect(prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1')).rejects.toThrow();
    expect(await jumlahJurnalTransfer()).toBe(0);
    expect(await saldoSukarelaSubledger('anggota-A')).toBe(0);
  });

  it('20-22. gagal di TENGAH batch menggulung SELURUH batch (atomic)', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-04-20', 'user-1');

    // Periode 3 berakhir 2026-04-15. Menutup 2026 membuat SELURUH batch
    // gagal — dan yang diperiksa di sini adalah tidak ada satu pun
    // periode yang tertinggal setengah jadi.
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);

    await expect(prosesTransferBungaKeSukarela(id, '2026-04-20', 'user-1')).rejects.toThrow();
    expect(await jumlahJurnalTransfer()).toBe(0);
    expect(await saldoSukarelaSubledger('anggota-A')).toBe(0);
    expect(await saldoKredit(ACC.utangBunga)).toBe(360_000);

    // Retry setelah periode dibuka kembali berhasil penuh, tanpa sisa
    // dari percobaan yang gagal.
    await testDb.runAsync(`UPDATE accounting_period SET status='OPEN' WHERE id='p2026'`);
    const ulang = await prosesTransferBungaKeSukarela(id, '2026-04-20', 'user-1');
    expect(ulang.totalDipindahkanSekarang).toBe(360_000);
    expect(await jumlahJurnalTransfer()).toBe(3);
  });
});

// ===========================================================================
// ACCOUNTING INVARIANTS
// ===========================================================================

describe('§B ACCOUNTING', () => {
  it('23. TOTAL BEBAN TIDAK BERTAMBAH akibat pemindahan', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-04-20', 'user-1');
    const bebanSebelum = await saldoDebit(ACC.bebanBunga);
    expect(bebanSebelum).toBe(360_000);

    await prosesTransferBungaKeSukarela(id, '2026-04-20', 'user-1');

    // Beban sudah diakui di fase akrual. Jurnal transfer hanya
    // memindahkan KEWAJIBAN, jadi angka ini WAJIB tidak bergerak.
    expect(await saldoDebit(ACC.bebanBunga)).toBe(bebanSebelum);
  });

  it('24. setiap jurnal transfer balanced', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-04-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-04-20', 'user-1');

    const perJurnal = await testDb.getAllAsync<{ d: number; k: number }>(
      `SELECT SUM(je.debit) d, SUM(je.kredit) k
         FROM journal_entry je JOIN journal j ON j.id = je.journal_id
        WHERE j.sumber_transaksi = ? GROUP BY j.id`,
      TRANSAKSI_BUNGA_TRANSFER
    );
    expect(perJurnal).toHaveLength(3);
    for (const p of perJurnal) expect(p.d).toBe(p.k);
  });

  it('25-26. utang bunga TIDAK PERNAH negatif; transfer tidak melebihi accrued', async () => {
    const id = await buatKontrak();
    // Hanya periode 1 yang diakru (120.000), walau diminta sampai April.
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');

    const hasil = await prosesTransferBungaKeSukarela(id, '2026-12-31', 'user-1');
    expect(hasil.totalDipindahkanSekarang).toBe(120_000);
    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
    expect(await saldoKredit(ACC.utangBunga)).toBeGreaterThan(-1);
  });

  it('pencairan TIDAK membayar ulang bunga yang sudah dipindahkan', async () => {
    // Inilah risiko terbesar §B: tanpa penyesuaian, pencairan membayar
    // SELURUH bunga_terakru sementara sebagiannya sudah masuk Simpanan
    // Sukarela — anggota dibayar dua kali dan 2-1710 menjadi negatif.
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-04-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-03-20', 'user-1'); // periode 1 & 2 = 240.000

    await prosesJatuhTempoSimpananBerjangka('2026-04-15', 'user-1');
    const cair = await cairkanSimpananBerjangka({
      kontrakId: id,
      tanggal: '2026-04-15',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    // RC-S128 — sisa bunga periode 3 dipindahkan ke Simpanan Sukarela
    // DI DALAM pencairan; tunai hanya pokok.
    expect(cair.bunga).toBe(0);
    expect(cair.bungaDipindahkanSaatPencairan).toBe(120_000);
    expect(cair.pokok).toBe(12_000_000);
    expect(cair.total).toBe(12_000_000);

    // 2-1710 kembali NOL, bukan negatif: 360.000 dikredit akrual,
    // 360.000 didebit transfer (240.000 sebelum + 120.000 saat pencairan).
    expect(await saldoKredit(ACC.utangBunga)).toBe(0);
    // Anggota menerima total 360.000 bunga — sekali saja, semuanya di Sukarela.
    expect(await saldoSukarelaSubledger('anggota-A')).toBe(360_000);
  });

  it('rekonsiliasi utang bunga memperhitungkan yang sudah dipindahkan', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-04-20', 'user-1');
    expect(await getTotalUtangBungaBerjangka()).toBe(360_000);

    await prosesTransferBungaKeSukarela(id, '2026-03-20', 'user-1');
    expect(await getTotalUtangBungaBerjangka()).toBe(120_000);
    expect(await getTotalUtangBungaBerjangka()).toBe(await saldoKredit(ACC.utangBunga));
  });
});

// ===========================================================================
// LIFECYCLE
// ===========================================================================

describe('§B LIFECYCLE', () => {
  it('27. kontrak AKTIF diproses', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    const k = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM simpanan_berjangka WHERE id = ?`,
      id
    );
    expect(k?.status).toBe('AKTIF');
    expect((await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1')).totalDipindahkanSekarang).toBe(120_000);
  });

  it('28. kontrak yang SUDAH DICAIRKAN tidak memindahkan apa pun', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-04-20', 'user-1');
    await prosesJatuhTempoSimpananBerjangka('2026-04-15', 'user-1');
    await cairkanSimpananBerjangka({
      kontrakId: id,
      tanggal: '2026-04-15',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    // RC-S128 — pencairan sendiri memindahkan 3 periode yang sudah earned.
    expect(await jumlahJurnalTransfer()).toBe(3);

    const hasil = await prosesTransferBungaKeSukarela(id, '2026-12-31', 'user-1');
    expect(hasil.totalDipindahkanSekarang).toBe(0);
    expect(await jumlahJurnalTransfer()).toBe(3); // setelah DICAIRKAN tidak ada pemindahan baru
  });

  it('29. kontrak DIBATALKAN tidak eligible', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await testDb.runAsync(`UPDATE simpanan_berjangka SET status='DIBATALKAN' WHERE id = ?`, id);

    const hasil = await prosesTransferBungaKeSukarela(id, '2026-12-31', 'user-1');
    expect(hasil.totalDipindahkanSekarang).toBe(0);
    expect(await jumlahJurnalTransfer()).toBe(0);
  });

  it('30. bunga NOL (rate 0%) tidak menghasilkan jurnal', async () => {
    const hasil = await setorSimpananBerjangka({
      anggotaId: 'anggota-A',
      nominal: 5_000_000,
      tenorBulan: 3,
      sukuBungaPerTahun: 0,
      tanggal: '2026-01-15',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await prosesAkrualBungaKontrak(hasil.id, '2026-04-20', 'user-1');

    const transfer = await prosesTransferBungaKeSukarela(hasil.id, '2026-04-20', 'user-1');
    expect(transfer.totalDipindahkanSekarang).toBe(0);
    expect(await jumlahJurnalTransfer()).toBe(0);
  });
});

// ===========================================================================
// PERIOD
// ===========================================================================

describe('§B PERIOD CLOSE', () => {
  it('31. periode OPEN -> posting berhasil', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1');
    expect(await jumlahJurnalTransfer()).toBe(1);
  });

  it('32. periode CLOSED -> DITOLAK dengan error jelas, periode TIDAK dibuka sendiri', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-02-20', 'user-1');
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='p2026'`);

    await expect(prosesTransferBungaKeSukarela(id, '2026-02-20', 'user-1')).rejects.toThrow(
      /ditutup|CLOSED/i
    );
    expect(await jumlahJurnalTransfer()).toBe(0);

    const p = await testDb.getFirstAsync<{ status: string }>(
      `SELECT status FROM accounting_period WHERE id='p2026'`
    );
    expect(p?.status).toBe('CLOSED');
  });
});

// ===========================================================================
// DATA INTEGRITY & ORKESTRATOR
// ===========================================================================

describe('§B DATA INTEGRITY', () => {
  it('33-35. referensi jurnal, kontrak, dan kunci periode benar', async () => {
    const id = await buatKontrak();
    await prosesAkrualBungaKontrak(id, '2026-03-20', 'user-1');
    await prosesTransferBungaKeSukarela(id, '2026-03-20', 'user-1');

    const status = await getStatusTransferBunga(id);
    expect(status).toHaveLength(2);

    for (const p of status) {
      // referensi jurnal
      const j = await testDb.getFirstAsync<{ id: string; sumber_id: string; sumber_transaksi: string }>(
        `SELECT id, sumber_id, sumber_transaksi FROM journal WHERE id = ?`,
        p.journalTransferId as string
      );
      expect(j?.sumber_transaksi).toBe(TRANSAKSI_BUNGA_TRANSFER);
      expect(j?.sumber_id).toBe(p.bungaId);

      // referensi kontrak lewat baris bunga
      const b = await testDb.getFirstAsync<{ simpanan_berjangka_id: string }>(
        `SELECT simpanan_berjangka_id FROM simpanan_berjangka_bunga WHERE id = ?`,
        p.bungaId
      );
      expect(b?.simpanan_berjangka_id).toBe(id);

      // kunci periode pada subledger
      const st = await testDb.getFirstAsync<{ idempotency_key: string; journal_id: string }>(
        `SELECT idempotency_key, journal_id FROM simpanan_transaksi WHERE journal_id = ?`,
        p.journalTransferId as string
      );
      expect(st?.idempotency_key).toBe(kunciTransferBunga(id, p.nomorPeriode));
    }
  });

  it('orkestrator processAccruedTermDepositInterestDue memproses semua kontrak, sekali', async () => {
    const a = await buatKontrak();
    await prosesAkrualBungaKontrak(a, '2026-03-20', 'user-1');

    const pertama = await processAccruedTermDepositInterestDue('2026-03-20', 'user-1');
    expect(pertama.totalDipindahkan).toBe(240_000);
    expect(pertama.gagal).toHaveLength(0);

    const kedua = await processAccruedTermDepositInterestDue('2026-03-20', 'user-1');
    expect(kedua.totalDipindahkan).toBe(0);
    expect(await jumlahJurnalTransfer()).toBe(2);
  });

  it('SELURUH jurnal dibuat AccountingEngine — tidak ada INSERT INTO journal manual', async () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'services', 'SimpananBerjangkaLifecycleService.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/INSERT INTO journal\b/);
    expect(src).not.toMatch(/INSERT INTO journal_entry\b/);
    expect(src).toMatch(/await createJournal\(db, \{/);
  });
});

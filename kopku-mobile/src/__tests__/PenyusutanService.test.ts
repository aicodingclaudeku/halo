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
  hitungPenyusutanBulanan,
  prosesPenyusutanAset,
  jalankanPenyusutanPeriode,
  getStatusPenyusutanPeriode,
  listJurnalPenyusutan,
} from '@/services/PenyusutanService';
import { getPosisiKeuangan } from '@/reports/FinancialReports';

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

async function seedAset(
  db: TestDb,
  id: string,
  namaAset: string,
  nilaiPerolehan: number,
  nilaiResidu: number,
  masaManfaatBulan: number,
  tanggalPerolehan: string,
  jenisAset: 'TETAP' | 'TAK_BERWUJUD' = 'TETAP'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO aset_tetap
      (id, nomor_aset, nama_aset, nilai_perolehan, nilai_residu, masa_manfaat_bulan, tanggal_perolehan,
       metode_pembayaran, sumber, created_by, created_at, jenis_aset)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    `AST-${id}`,
    namaAset,
    nilaiPerolehan,
    nilaiResidu,
    masaManfaatBulan,
    tanggalPerolehan,
    'TUNAI',
    'PEMBELIAN',
    'user-1',
    now,
    jenisAset
  );
}

const ACC = {
  bebanPenyusutan: 'acc-beban-penyusutan',
  akumulasi: 'acc-akumulasi-penyusutan',
  asetTetap: 'acc-aset-tetap',
  bebanAmortisasi: 'acc-beban-amortisasi',
  akumulasiAmortisasi: 'acc-akumulasi-amortisasi',
};

/** Buat periode akuntansi yang mencakup seluruh tahun yang dipakai test (2026 & 2027, karena test menguji lintas tahun). */
async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();

  await seedAccount(db, ACC.bebanPenyusutan, '5-1300', 'Beban Penyusutan', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.akumulasi, '1-1510', 'Akumulasi Penyusutan Aset Tetap', 'ASET', 'KREDIT');
  await seedAccount(db, ACC.asetTetap, '1-1500', 'Aset Tetap', 'ASET', 'DEBIT');
  await seedMapping(db, 'PENYUSUTAN_ASET', 'DEBIT_BEBAN', ACC.bebanPenyusutan);
  await seedMapping(db, 'PENYUSUTAN_ASET', 'KREDIT_AKUMULASI', ACC.akumulasi);
  await seedAccount(db, ACC.bebanAmortisasi, '5-1310', 'Beban Amortisasi', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.akumulasiAmortisasi, '1-1710', 'Akumulasi Amortisasi Aset Tak Berwujud', 'ASET', 'KREDIT');
  await seedMapping(db, 'AMORTISASI_ASET_TAK_BERWUJUD', 'DEBIT_BEBAN', ACC.bebanAmortisasi);
  await seedMapping(db, 'AMORTISASI_ASET_TAK_BERWUJUD', 'KREDIT_AKUMULASI', ACC.akumulasiAmortisasi);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2027',
    2027,
    '2027-01-01',
    '2027-12-31'
  );

  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    new Date().toISOString(),
    new Date().toISOString()
  );

  return db;
}

describe('PenyusutanService', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('hitungPenyusutanBulanan: garis lurus (perolehan - residu) / masa manfaat', () => {
    expect(hitungPenyusutanBulanan(48_000_000, 0, 48)).toBe(1_000_000);
    expect(hitungPenyusutanBulanan(12_000_000, 2_000_000, 10)).toBe(1_000_000);
    expect(hitungPenyusutanBulanan(1_000_000, 1_000_000, 12)).toBe(0); // dasar 0
    expect(hitungPenyusutanBulanan(1_000_000, 0, 0)).toBe(0); // masa manfaat 0 dijaga, tidak divide-by-zero
  });

  test('prosesPenyusutanAset: jurnal balance, DEBIT Beban Penyusutan = KREDIT Akumulasi', async () => {
    await seedAset(testDb, 'aset-1', 'Laptop Kantor', 24_000_000, 0, 24, '2026-01-15');

    const hasil = await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-02', createdBy: 'user-1' });

    expect(hasil.dibuat).toBe(true);
    expect(hasil.row.nilaiPenyusutan).toBe(1_000_000);
    expect(hasil.row.periode).toBe('2026-02');

    const bebanRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.bebanPenyusutan
    );
    const akumulasiRow = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.akumulasi
    );
    expect(bebanRow?.total).toBe(1_000_000);
    expect(akumulasiRow?.total).toBe(1_000_000);
    expect(bebanRow?.total).toBe(akumulasiRow?.total); // balance
  });

  test('anti-duplikasi: proses periode yang sama dua kali TIDAK membuat jurnal kedua', async () => {
    await seedAset(testDb, 'aset-1', 'Laptop Kantor', 24_000_000, 0, 24, '2026-01-15');

    const pertama = await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-02', createdBy: 'user-1' });
    const kedua = await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-02', createdBy: 'user-1' });

    expect(pertama.dibuat).toBe(true);
    expect(kedua.dibuat).toBe(false);
    expect(kedua.row.id).toBe(pertama.row.id); // baris yang sama, bukan baris baru

    const jumlahJurnal = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'PENYUSUTAN_ASET' AND sumber_id = 'aset-1'`
    );
    expect(jumlahJurnal?.cnt).toBe(1); // bukan 2

    const jumlahBaris = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM aset_penyusutan WHERE aset_id = 'aset-1' AND periode = '2026-02'`
    );
    expect(jumlahBaris?.cnt).toBe(1);
  });

  test('proses periode sebelum tanggal perolehan ditolak', async () => {
    await seedAset(testDb, 'aset-1', 'Laptop Kantor', 24_000_000, 0, 24, '2026-06-01');

    await expect(
      prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-03', createdBy: 'user-1' })
    ).rejects.toThrow(/sebelum tanggal perolehan/);
  });

  test('proses periode setelah masa manfaat habis ditolak', async () => {
    await seedAset(testDb, 'aset-1', 'Laptop Kantor', 2_400_000, 0, 2, '2026-01-01');
    // masa manfaat 2 bulan: index 0 = 2026-01, index 1 = 2026-02, index 2 (2026-03) sudah lewat.

    await expect(
      prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-03', createdBy: 'user-1' })
    ).rejects.toThrow(/melewati masa manfaat/);
  });

  test('getStatusPenyusutanPeriode: klasifikasi status per aset benar', async () => {
    await seedAset(testDb, 'aset-1', 'Laptop', 2_400_000, 0, 2, '2026-01-01'); // habis di 2026-02
    await seedAset(testDb, 'aset-2', 'Motor', 12_000_000, 0, 12, '2026-05-01'); // belum mulai di 2026-01

    const status2026Jan = await getStatusPenyusutanPeriode('2026-01');
    expect(status2026Jan.find((s) => s.asetId === 'aset-1')?.status).toBe('SIAP_DIPROSES');
    expect(status2026Jan.find((s) => s.asetId === 'aset-2')?.status).toBe('BELUM_MULAI');

    await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-01', createdBy: 'user-1' });
    const statusSetelahProses = await getStatusPenyusutanPeriode('2026-01');
    expect(statusSetelahProses.find((s) => s.asetId === 'aset-1')?.status).toBe('SUDAH_DIPROSES');

    const status2026Maret = await getStatusPenyusutanPeriode('2026-03');
    expect(status2026Maret.find((s) => s.asetId === 'aset-1')?.status).toBe('SELESAI');
  });

  test('jalankanPenyusutanPeriode: batch proses banyak aset, lewati yang belum mulai/sudah selesai', async () => {
    await seedAset(testDb, 'aset-1', 'Laptop', 24_000_000, 0, 24, '2026-01-15');
    await seedAset(testDb, 'aset-2', 'Motor', 12_000_000, 0, 12, '2026-05-01'); // belum mulai di Feb

    const hasil = await jalankanPenyusutanPeriode('2026-02', 'user-1');

    expect(hasil.diproses).toHaveLength(1);
    expect(hasil.diproses[0].asetId).toBe('aset-1');
    expect(hasil.dilewati.some((d) => d.asetId === 'aset-2')).toBe(true);

    // Jalankan lagi untuk periode yang sama — tidak boleh nambah jurnal baru.
    const hasilKedua = await jalankanPenyusutanPeriode('2026-02', 'user-1');
    expect(hasilKedua.diproses).toHaveLength(0);
    expect(hasilKedua.dilewati.some((d) => d.asetId === 'aset-1')).toBe(true);

    const daftarJurnal = await listJurnalPenyusutan({ periode: '2026-02' });
    expect(daftarJurnal).toHaveLength(1);
  });

  test('integrasi Posisi Keuangan: nilai buku = nilai perolehan - akumulasi penyusutan, dan berkurang tiap bulan diproses (Bagian A permintaan pengguna)', async () => {
    await seedAset(testDb, 'aset-1', 'Laptop', 24_000_000, 0, 24, '2026-01-15');
    // Jurnal PEROLEHAN aset (DEBIT Aset Tetap, KREDIT Modal — disuntik
    // langsung sebagai fixture, bukan lewat AsetService, supaya test
    // ini murni fokus ke integrasi Penyusutan <-> Posisi Keuangan).
    const { createJournal } = await import('@/accounting/AccountingEngine');
    await seedAccount(testDb, 'acc-modal', '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
    await createJournal(testDb as any, {
      tanggal: '2026-01-15',
      sumberTransaksi: 'ASET_TETAP',
      deskripsi: 'Perolehan Laptop',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.asetTetap, debit: 24_000_000, kredit: 0 },
        { accountId: 'acc-modal', debit: 0, kredit: 24_000_000 },
      ],
    });

    // Sebelum penyusutan: nilai buku = nilai perolehan penuh.
    const posisiAwal = await getPosisiKeuangan(testDb as any, '2026-01-31');
    const asetTetapRow = posisiAwal.aset.find((r) => r.kode === '1-1500');
    expect(asetTetapRow?.saldo).toBe(24_000_000);
    expect(posisiAwal.aset.find((r) => r.kode === '1-1510')).toBeUndefined(); // belum ada akumulasi

    // Proses penyusutan 3 bulan (Jan, Feb, Mar) — 1jt/bulan (24jt/24bulan).
    await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-01', createdBy: 'user-1' });
    await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-02', createdBy: 'user-1' });
    await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-03', createdBy: 'user-1' });

    const posisiSetelah = await getPosisiKeuangan(testDb as any, '2026-03-31');
    const asetTetapSetelah = posisiSetelah.aset.find((r) => r.kode === '1-1500');
    const akumulasiSetelah = posisiSetelah.aset.find((r) => r.kode === '1-1510');
    expect(asetTetapSetelah?.saldo).toBe(24_000_000); // nilai perolehan (bruto) TIDAK berubah
    expect(akumulasiSetelah?.saldo).toBe(-3_000_000); // akumulasi 3 bulan, ditampilkan sebagai pengurang
    // Nilai buku aset tetap dalam Total Aset = 24jt - 3jt = 21jt.
    const totalAsetTetapNeto = (asetTetapSetelah?.saldo ?? 0) + (akumulasiSetelah?.saldo ?? 0);
    expect(totalAsetTetapNeto).toBe(21_000_000);
    expect(posisiSetelah.isBalanced).toBe(true);
  });

  test('Bagian F2: listAsetDenganNilaiBuku (Daftar Aset Tetap) menghitung akumulasi & nilai buku sama seperti Posisi Keuangan', async () => {
    const { listAsetDenganNilaiBuku } = await import('@/services/AsetService');
    await seedAset(testDb, 'aset-1', 'Laptop', 24_000_000, 0, 24, '2026-01-15');

    let daftar = await listAsetDenganNilaiBuku();
    let item = daftar.find((a) => a.id === 'aset-1');
    expect(item?.akumulasiPenyusutan).toBe(0);
    expect(item?.nilaiBuku).toBe(24_000_000);

    await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-01', createdBy: 'user-1' });
    await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-02', createdBy: 'user-1' });

    daftar = await listAsetDenganNilaiBuku();
    item = daftar.find((a) => a.id === 'aset-1');
    expect(item?.akumulasiPenyusutan).toBe(2_000_000);
    expect(item?.nilaiBuku).toBe(22_000_000);
    expect(item?.nilaiBuku).toBeGreaterThanOrEqual(0); // tidak pernah negatif
  });
});

// ============================================================
// Prioritas 8 (J) — Amortisasi Aset Tak Berwujud. Mesin garis-lurus
// (hitungPenyusutanBulanan) dipakai ulang apa adanya — yang diuji di
// sini adalah PENCABANGAN akun (mapping AMORTISASI_ASET_TAK_BERWUJUD,
// BUKAN PENYUSUTAN_ASET) berdasarkan jenis_aset.
// ============================================================
describe('PenyusutanService — Amortisasi Aset Tak Berwujud (Prioritas 8/J)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('prosesPenyusutanAset untuk aset TAK_BERWUJUD: DEBIT Beban Amortisasi (5-1310) & KREDIT Akumulasi Amortisasi (1-1710), BUKAN akun penyusutan aset tetap', async () => {
    await seedAset(testDb, 'aset-itb-1', 'Lisensi Software', 36_000_000, 0, 36, '2026-01-15', 'TAK_BERWUJUD');

    const hasil = await prosesPenyusutanAset({ asetId: 'aset-itb-1', periode: '2026-02', createdBy: 'user-1' });

    expect(hasil.dibuat).toBe(true);
    expect(hasil.row.nilaiPenyusutan).toBe(1_000_000);

    const bebanAmortisasi = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.bebanAmortisasi
    );
    expect(bebanAmortisasi?.total).toBe(1_000_000);
    const akumulasiAmortisasi = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.akumulasiAmortisasi
    );
    expect(akumulasiAmortisasi?.total).toBe(1_000_000);

    // Akun penyusutan aset TETAP sama sekali tidak tersentuh.
    const bebanPenyusutanTetap = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.bebanPenyusutan
    );
    expect(bebanPenyusutanTetap?.total ?? 0).toBe(0);

    const journal = await testDb.getFirstAsync<{ deskripsi: string }>(
      `SELECT deskripsi FROM journal WHERE id = ?`,
      hasil.row.journalId
    );
    expect(journal?.deskripsi).toContain('Amortisasi');
  });

  test('getStatusPenyusutanPeriode: aset TAK_BERWUJUD ikut tampil dengan jenisAset yang benar', async () => {
    await seedAset(testDb, 'aset-itb-2', 'Hak Merek', 12_000_000, 0, 12, '2026-01-01', 'TAK_BERWUJUD');
    const status = await getStatusPenyusutanPeriode('2026-02');
    const item = status.find((s) => s.asetId === 'aset-itb-2');
    expect(item?.jenisAset).toBe('TAK_BERWUJUD');
  });

  test('jalankanPenyusutanPeriode (batch): aset TETAP dan TAK_BERWUJUD sama-sama diproses dalam satu batch, masing-masing ke akun yang benar', async () => {
    await seedAset(testDb, 'aset-tetap-x', 'Mesin', 24_000_000, 0, 24, '2026-01-01', 'TETAP');
    await seedAset(testDb, 'aset-itb-x', 'Software', 12_000_000, 0, 12, '2026-01-01', 'TAK_BERWUJUD');

    const hasil = await jalankanPenyusutanPeriode('2026-02', 'user-1');
    expect(hasil.diproses).toHaveLength(2);

    const bebanPenyusutan = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.bebanPenyusutan
    );
    const bebanAmortisasi = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.bebanAmortisasi
    );
    expect(bebanPenyusutan?.total).toBe(1_000_000); // 24jt/24bln
    expect(bebanAmortisasi?.total).toBe(1_000_000); // 12jt/12bln
  });
});

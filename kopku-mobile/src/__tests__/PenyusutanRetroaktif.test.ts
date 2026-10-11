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
  getPeriodePenyusutanYangSeharusnyaDiproses,
  getPeriodePenyusutanCutoff,
  periodePenyusutanSudahJatuhTempo,
  getPeriodePenyusutanTertunggak,
  jalankanPenyusutanOtomatisJikaPerlu,
  jalankanPenyusutanPeriode,
  prosesPenyusutanAset,
  getStatusPenyusutanPeriode,
  listRingkasanPenyusutanAset,
  auditRekonsiliasiPenyusutan,
  setModePenyusutan,
  getModePenyusutan,
} from '@/services/PenyusutanService';
import { beliAset } from '@/services/AsetService';
import { createJournal } from '@/accounting/AccountingEngine';
import { getPosisiKeuangan, getLabaRugi } from '@/reports/FinancialReports';

/**
 * REGRESI — PERBAIKAN PENYUSUTAN/AMORTISASI RETROAKTIF.
 *
 * Bug yang ditutup: `jalankanPenyusutanOtomatisJikaPerlu()` dulu hanya
 * memproses `toPeriode(tanggalSekarang)` — satu periode, yaitu bulan
 * berjalan. Dua akibatnya:
 *   1. periode yang terlewat (app tidak dibuka / aset dicatat dengan
 *      tanggal perolehan mundur) TIDAK PERNAH dikejar;
 *   2. bulan berjalan diposting PENUH walau bulannya belum berakhir.
 *
 * Kasus acuan pengguna: aset 2026-07-01 dilihat pada 2026-09-02 harus
 * menghasilkan TEPAT dua periode (Juli & Agustus), bukan satu
 * (September) dan bukan tiga.
 */

const ACC = {
  bebanPenyusutan: 'acc-beban-penyusutan',
  akumulasi: 'acc-akumulasi-penyusutan',
  asetTetap: 'acc-aset-tetap',
  kas: 'acc-kas',
  modal: 'acc-modal',
  bebanAmortisasi: 'acc-beban-amortisasi',
  akumulasiAmortisasi: 'acc-akumulasi-amortisasi',
  asetTakBerwujud: 'acc-aset-tak-berwujud',
};

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

async function seedFixture(): Promise<TestDb> {
  const db = await createTestDb();

  await seedAccount(db, ACC.bebanPenyusutan, '5-1300', 'Beban Penyusutan', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.akumulasi, '1-1510', 'Akumulasi Penyusutan Aset Tetap', 'ASET', 'KREDIT');
  await seedAccount(db, ACC.asetTetap, '1-1500', 'Aset Tetap', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.kas, '1-1100', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.bebanAmortisasi, '5-1310', 'Beban Amortisasi', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.akumulasiAmortisasi, '1-1710', 'Akumulasi Amortisasi Aset Tak Berwujud', 'ASET', 'KREDIT');
  await seedAccount(db, ACC.asetTakBerwujud, '1-1700', 'Aset Tak Berwujud', 'ASET', 'DEBIT');

  await seedMapping(db, 'PENYUSUTAN_ASET', 'DEBIT_BEBAN', ACC.bebanPenyusutan);
  await seedMapping(db, 'PENYUSUTAN_ASET', 'KREDIT_AKUMULASI', ACC.akumulasi);
  await seedMapping(db, 'AMORTISASI_ASET_TAK_BERWUJUD', 'DEBIT_BEBAN', ACC.bebanAmortisasi);
  await seedMapping(db, 'AMORTISASI_ASET_TAK_BERWUJUD', 'KREDIT_AKUMULASI', ACC.akumulasiAmortisasi);
  await seedMapping(db, 'ASET_TETAP', 'DEBIT_ASET', ACC.asetTetap);
  await seedMapping(db, 'ASET_TAK_BERWUJUD', 'DEBIT_ASET', ACC.asetTakBerwujud);
  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);

  for (const tahun of [2026, 2027]) {
    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      `period-${tahun}`,
      tahun,
      `${tahun}-01-01`,
      `${tahun}-12-31`
    );
  }

  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );

  return db;
}

async function seedAset(
  db: TestDb,
  id: string,
  opts: {
    nilai: number;
    residu?: number;
    masa: number;
    tanggal: string;
    jenis?: 'TETAP' | 'TAK_BERWUJUD';
    status?: 'AKTIF' | 'DIHAPUS';
    nama?: string;
  }
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO aset_tetap (id, nomor_aset, nama_aset, nilai_perolehan, nilai_residu, masa_manfaat_bulan,
      tanggal_perolehan, metode_pembayaran, sumber, created_by, created_at, jenis_aset, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    `AST-${id}`,
    opts.nama ?? 'Laptop Kantor',
    opts.nilai,
    opts.residu ?? 0,
    opts.masa,
    opts.tanggal,
    'TUNAI',
    'PEMBELIAN',
    'user-1',
    now,
    opts.jenis ?? 'TETAP',
    opts.status ?? 'AKTIF'
  );
}

/** Saldo GL sebuah akun (kredit - debit) dari jurnal POSTED — sumber yang sama dengan laporan. */
async function saldoGl(db: TestDb, accountId: string): Promise<number> {
  const row = await db.getFirstAsync<{ s: number }>(
    `SELECT COALESCE(SUM(je.kredit - je.debit), 0) as s
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE je.account_id = ? AND j.status = 'POSTED'`,
    accountId
  );
  return row?.s ?? 0;
}

async function periodeTercatat(db: TestDb, asetId: string): Promise<string[]> {
  const rows = await db.getAllAsync<{ periode: string }>(
    `SELECT periode FROM aset_penyusutan WHERE aset_id = ? ORDER BY periode ASC`,
    asetId
  );
  return rows.map((r) => r.periode);
}

// ============================================================
describe('Kebijakan periode penyusutan (fungsi murni)', () => {
  test('A: perolehan 2026-07-01 dilihat 2026-09-02 -> Juli & Agustus, BUKAN September', () => {
    expect(getPeriodePenyusutanYangSeharusnyaDiproses('2026-07-01', '2026-09-02', 12)).toEqual(['2026-07', '2026-08']);
  });

  test('B: perolehan 2026-07-01 dilihat 2026-08-31 -> 2 periode (Agustus tepat berakhir)', () => {
    expect(getPeriodePenyusutanYangSeharusnyaDiproses('2026-07-01', '2026-08-31', 12)).toEqual(['2026-07', '2026-08']);
  });

  test('C: perolehan 2026-07-01 dilihat 2026-08-01 -> HANYA Juli (Agustus belum berakhir)', () => {
    expect(getPeriodePenyusutanYangSeharusnyaDiproses('2026-07-01', '2026-08-01', 12)).toEqual(['2026-07']);
  });

  test('C2: policy bulan perolehan PENUH tetap berlaku — 2026-07-15 juga mulai dari periode 2026-07', () => {
    expect(getPeriodePenyusutanYangSeharusnyaDiproses('2026-07-15', '2026-09-02', 12)).toEqual(['2026-07', '2026-08']);
  });

  test('D: perolehan 2026-09-01 dilihat 2026-09-02 -> belum ada periode yang jatuh tempo', () => {
    expect(getPeriodePenyusutanYangSeharusnyaDiproses('2026-09-01', '2026-09-02', 12)).toEqual([]);
  });

  test('J: masa manfaat 12 bulan -> maksimum 12 periode, tidak pernah menembus 2027-07', () => {
    const hasil = getPeriodePenyusutanYangSeharusnyaDiproses('2026-07-01', '2030-01-01', 12);
    expect(hasil.length).toBe(12);
    expect(hasil[0]).toBe('2026-07');
    expect(hasil[11]).toBe('2027-06');
    expect(hasil).not.toContain('2027-07');
  });

  test('cutoff & jatuh tempo', () => {
    expect(getPeriodePenyusutanCutoff('2026-09-02')).toBe('2026-08');
    expect(getPeriodePenyusutanCutoff('2026-08-31')).toBe('2026-08');
    expect(periodePenyusutanSudahJatuhTempo('2026-09', '2026-09-02')).toBe(false);
    expect(periodePenyusutanSudahJatuhTempo('2026-08', '2026-09-02')).toBe(true);
  });
});

// ============================================================
describe('§28 KASUS PENGGUNA — aset 2026-07-01, sistem 2026-09-02', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('tepat 2 periode diposting, total Rp2.000.000, September TIDAK diposting, GL = subledger', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, residu: 0, masa: 12, tanggal: '2026-07-01' });

    const run = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02T09:00:00'));
    expect(run.dijalankan).toBe(true);
    expect(run.error).toBeUndefined();
    expect(run.periodeDiproses).toEqual(['2026-07', '2026-08']);
    expect(run.periodeCutoff).toBe('2026-08');

    const jumlahAset = await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM aset_tetap`);
    expect(jumlahAset?.c).toBe(1);
    expect(await periodeTercatat(testDb, 'aset-1')).toEqual(['2026-07', '2026-08']);

    const total = await testDb.getFirstAsync<{ t: number }>(
      `SELECT COALESCE(SUM(nilai_penyusutan),0) as t FROM aset_penyusutan`
    );
    expect(total?.t).toBe(2_000_000);

    // Tanggal jurnal = akhir periode masing-masing, BUKAN 2026-09-02.
    const jurnal = await testDb.getAllAsync<{ tanggal: string }>(
      `SELECT tanggal FROM journal WHERE sumber_transaksi = 'PENYUSUTAN_ASET' ORDER BY tanggal ASC`
    );
    expect(jurnal.map((j) => j.tanggal)).toEqual(['2026-07-31', '2026-08-31']);

    expect(await saldoGl(testDb, ACC.akumulasi)).toBe(2_000_000);
    expect(-(await saldoGl(testDb, ACC.bebanPenyusutan))).toBe(2_000_000);

    const audit = await auditRekonsiliasiPenyusutan('2026-09-02');
    expect(audit.totalSubledgerPenyusutan).toBe(2_000_000);
    expect(audit.totalGlPenyusutan).toBe(2_000_000);
    expect(audit.variancePenyusutan).toBe(0);
    expect(audit.seimbang).toBe(true);
  });

  test('§29 backdated: tanggal transaksi 2026-09-02 vs tanggal perolehan 2026-07-01 vs cutoff laporan', async () => {
    await testDb.withTransactionAsync(async () => {
      await createJournal(testDb as any, {
        tanggal: '2026-01-01',
        sumberTransaksi: 'MODAL',
        deskripsi: 'Modal awal kas',
        createdBy: 'user-1',
        lines: [
          { accountId: ACC.kas, debit: 50_000_000, kredit: 0 },
          { accountId: ACC.modal, debit: 0, kredit: 50_000_000 },
        ],
      });
    });

    const hasil = await beliAset({
      namaAset: 'Mesin Produksi',
      nilaiPerolehan: 12_000_000,
      nilaiResidu: 0,
      masaManfaatBulan: 12,
      tanggal: '2026-07-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    // Tanggal perolehan TIDAK diubah jadi tanggal input transaksi.
    const asetRow = await testDb.getFirstAsync<{ tanggal_perolehan: string }>(
      `SELECT tanggal_perolehan FROM aset_tetap WHERE id = ?`,
      hasil.id
    );
    expect(asetRow?.tanggal_perolehan).toBe('2026-07-01');

    const jurnalPerolehan = await testDb.getFirstAsync<{ tanggal: string }>(
      `SELECT tanggal FROM journal WHERE sumber_transaksi = 'ASET_TETAP'`
    );
    expect(jurnalPerolehan?.tanggal).toBe('2026-07-01');

    // §14: beliAset TIDAK membuat jurnal penyusutan sendiri — acquisition
    // dan depreciation tetap terpisah.
    const sebelum = await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM aset_penyusutan`);
    expect(sebelum?.c).toBe(0);

    // Lifecycle trigger (aplikasi dibuka 2026-09-02) yang melakukan catch-up.
    await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02T09:00:00'));
    expect(await periodeTercatat(testDb, hasil.id)).toEqual(['2026-07', '2026-08']);
  });
});

// ============================================================
describe('§27 catch-up, idempotency & invariant backend', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('E: aset 2026-01-01, aplikasi pertama kali dibuka 2026-09-02 -> Januari s.d. Agustus, September tidak', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 24_000_000, masa: 24, tanggal: '2026-01-01' });

    const run = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));
    expect(run.hasil?.diproses.length).toBe(8);
    expect(await periodeTercatat(testDb, 'aset-1')).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
    ]);
  });

  test('F: Juli sudah diproses -> hanya Agustus yang dibuat, jurnal Juli TIDAK disentuh', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-07', createdBy: 'user-1' });
    const juliSebelum = await testDb.getFirstAsync<{ journal_id: string }>(
      `SELECT journal_id FROM aset_penyusutan WHERE aset_id='aset-1' AND periode='2026-07'`
    );

    const run = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));
    expect(run.periodeDiproses).toEqual(['2026-08']);
    expect(await periodeTercatat(testDb, 'aset-1')).toEqual(['2026-07', '2026-08']);

    const juliSesudah = await testDb.getFirstAsync<{ journal_id: string }>(
      `SELECT journal_id FROM aset_penyusutan WHERE aset_id='aset-1' AND periode='2026-07'`
    );
    expect(juliSesudah?.journal_id).toBe(juliSebelum?.journal_id);
  });

  test('G/H: catch-up kedua pada tanggal yang sama -> 0 jurnal baru, tidak duplikat', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));
    const jurnalSebelum = await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM journal`);

    const run2 = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));
    expect(run2.periodeDiproses).toEqual([]);
    expect(run2.hasil?.diproses.length).toBe(0);

    const jurnalSesudah = await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM journal`);
    expect(jurnalSesudah?.c).toBe(jurnalSebelum?.c);
    const baris = await testDb.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) as c FROM aset_penyusutan WHERE aset_id='aset-1'`
    );
    expect(baris?.c).toBe(2);
  });

  test('I: dua jalur berbeda (catch-up + tombol manual periode sama) -> tetap satu jurnal per periode', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));

    const kedua = await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-07', createdBy: 'user-1' });
    expect(kedua.dibuat).toBe(false);

    const baris = await testDb.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) as c FROM aset_penyusutan WHERE aset_id='aset-1' AND periode='2026-07'`
    );
    expect(baris?.c).toBe(1);
    const jurnal = await testDb.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) as c FROM journal WHERE sumber_transaksi='PENYUSUTAN_ASET'`
    );
    expect(jurnal?.c).toBe(2);
  });

  test('J: catch-up berhenti di masa manfaat (12 periode), tidak pernah 2027-07', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2027-12-31'));

    const periode = await periodeTercatat(testDb, 'aset-1');
    expect(periode.length).toBe(12);
    expect(periode[11]).toBe('2027-06');
    expect(periode).not.toContain('2027-07');
  });

  test('K: nilai residu — akumulasi tidak pernah melampaui (perolehan - residu), nilai buku tidak turun di bawah residu', async () => {
    // Dasar 10.000.000 / 3 = 3.333.333 (pembulatan rupiah).
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, residu: 2_000_000, masa: 3, tanggal: '2026-01-01' });
    await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));

    const total = await testDb.getFirstAsync<{ t: number }>(
      `SELECT COALESCE(SUM(nilai_penyusutan),0) as t FROM aset_penyusutan WHERE aset_id='aset-1'`
    );
    // Sisa pembulatan SENGAJA dibiarkan (formula garis lurus tidak
    // diubah, tidak ada jurnal penyeimbang tambahan) — yang dijaga
    // adalah batas atasnya.
    expect(total!.t).toBeLessThanOrEqual(10_000_000);
    expect(await saldoGl(testDb, ACC.akumulasi)).toBe(total?.t);

    const ringkasan = await listRingkasanPenyusutanAset();
    expect(ringkasan[0].nilaiBuku).toBeGreaterThanOrEqual(ringkasan[0].nilaiResidu);
  });

  test('K2: penjaga dasar penyusutan menolak kelebihan akibat pembulatan (200 / 3 bulan tidak menjadi 201)', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 200, residu: 0, masa: 3, tanggal: '2026-01-01' });
    await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-01', createdBy: 'user-1' });
    await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-02', createdBy: 'user-1' });
    await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-03', createdBy: 'user-1' });

    const total = await testDb.getFirstAsync<{ t: number }>(
      `SELECT COALESCE(SUM(nilai_penyusutan),0) as t FROM aset_penyusutan WHERE aset_id='aset-1'`
    );
    expect(total?.t).toBe(200);
    expect(await saldoGl(testDb, ACC.akumulasi)).toBe(200);
  });

  test('L: aset TAK_BERWUJUD memakai mapping AMORTISASI, tidak tercampur ke akun penyusutan aset tetap', async () => {
    await seedAset(testDb, 'aset-itb', {
      nilai: 12_000_000,
      masa: 12,
      tanggal: '2026-07-01',
      jenis: 'TAK_BERWUJUD',
      nama: 'Lisensi Software',
    });

    await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));

    expect(await periodeTercatat(testDb, 'aset-itb')).toEqual(['2026-07', '2026-08']);
    expect(await saldoGl(testDb, ACC.akumulasiAmortisasi)).toBe(2_000_000);
    expect(-(await saldoGl(testDb, ACC.bebanAmortisasi))).toBe(2_000_000);
    expect(await saldoGl(testDb, ACC.akumulasi)).toBe(0);
    expect(await saldoGl(testDb, ACC.bebanPenyusutan)).toBe(0);

    const jurnal = await testDb.getFirstAsync<{ sumber_transaksi: string }>(
      `SELECT sumber_transaksi FROM journal WHERE sumber_transaksi='AMORTISASI_ASET_TAK_BERWUJUD'`
    );
    expect(jurnal?.sumber_transaksi).toBe('AMORTISASI_ASET_TAK_BERWUJUD');
  });

  test('M: mode MANUAL -> trigger app-open tidak memproses apa pun', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    await setModePenyusutan('MANUAL', 'user-1');

    const run = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));
    expect(run.dijalankan).toBe(false);
    const baris = await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM aset_penyusutan`);
    expect(baris?.c).toBe(0);
  });

  test('M2: tombol manual SATU periode tetap memproses satu periode saja (semantik tidak berubah)', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    await setModePenyusutan('MANUAL', 'user-1');

    const hasil = await jalankanPenyusutanPeriode('2026-07', 'user-1');
    expect(hasil.diproses.length).toBe(1);
    expect(await periodeTercatat(testDb, 'aset-1')).toEqual(['2026-07']);
  });

  test('N: mode OTOMATIS -> catch-up retroaktif berjalan', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    expect(await getModePenyusutan()).toBe('OTOMATIS');

    const run = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));
    expect(run.hasil?.diproses.length).toBe(2);
  });

  test('O: aset DIHAPUS tidak mendapat penyusutan baru lewat jalur mana pun', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01', status: 'DIHAPUS' });

    const run = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));
    expect(run.periodeDiproses).toEqual([]);
    const baris = await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM aset_penyusutan`);
    expect(baris?.c).toBe(0);

    const status = await getStatusPenyusutanPeriode('2026-07');
    expect(status[0].status).toBe('DIHENTIKAN');

    await expect(
      prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-07', createdBy: 'user-1' })
    ).rejects.toThrow(/dihapus|nonaktif/i);
  });

  test('P: satu aset gagal (mapping hilang) tidak merusak aset lain & tidak meninggalkan jurnal parsial', async () => {
    await seedAset(testDb, 'aset-tetap-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    await seedAset(testDb, 'aset-itb-1', {
      nilai: 12_000_000,
      masa: 12,
      tanggal: '2026-07-01',
      jenis: 'TAK_BERWUJUD',
    });
    await testDb.runAsync(`DELETE FROM account_mapping WHERE transaction_type = 'PENYUSUTAN_ASET'`);

    const run = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));
    expect(run.dijalankan).toBe(true);
    expect(run.hasil?.diproses.length).toBe(2); // aset tak berwujud tetap berhasil
    expect(run.hasil?.dilewati.length).toBe(2); // aset tetap dilaporkan gagal, bukan exception
    expect(run.hasil?.dilewati[0]?.alasan).toBeTruthy();
    expect(await periodeTercatat(testDb, 'aset-tetap-1')).toEqual([]);
    expect(await periodeTercatat(testDb, 'aset-itb-1')).toEqual(['2026-07', '2026-08']);
  });

  test('Q: audit rekonsiliasi READ-ONLY mendeteksi periode hilang tanpa membuat jurnal', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-07', createdBy: 'user-1' });

    const sebelum = await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM journal`);
    const audit = await auditRekonsiliasiPenyusutan('2026-09-02');
    const sesudah = await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM journal`);
    expect(sesudah?.c).toBe(sebelum?.c);

    expect(audit.jumlahAset).toBe(1);
    expect(audit.aset[0].periodeSeharusnya).toBe(2);
    expect(audit.aset[0].periodeTersedia).toBe(1);
    expect(audit.aset[0].periodeHilang).toEqual(['2026-08']);
    expect(audit.aset[0].variance).toBe(1_000_000);
    expect(audit.totalSubledgerPenyusutan).toBe(audit.totalGlPenyusutan);
    expect(audit.seimbang).toBe(true);
  });

  test('§31: periode CLOSED tidak dijurnal diam-diam — ditolak engine & dilaporkan sebagai dilewati', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    await testDb.runAsync(`UPDATE accounting_period SET status='CLOSED' WHERE id='period-2026'`);

    const run = await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));
    expect(run.dijalankan).toBe(true);
    expect(run.hasil?.diproses.length).toBe(0);
    expect(run.hasil?.dilewati[0]?.alasan).toMatch(/ditutup|CLOSED/i);

    const baris = await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM aset_penyusutan`);
    expect(baris?.c).toBe(0);
  });

  test('tidak ada jurnal orphan: setiap jurnal penyusutan punya baris subledger', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));

    const orphan = await testDb.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) as c FROM journal j
       WHERE j.sumber_transaksi = 'PENYUSUTAN_ASET'
         AND NOT EXISTS (SELECT 1 FROM aset_penyusutan ap WHERE ap.journal_id = j.id)`
    );
    expect(orphan?.c).toBe(0);
  });

  test('getPeriodePenyusutanTertunggak: READ-ONLY, melaporkan seharusnya vs sudah ada', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    await prosesPenyusutanAset({ asetId: 'aset-1', periode: '2026-07', createdBy: 'user-1' });

    const tertunggak = await getPeriodePenyusutanTertunggak('2026-09-02');
    expect(tertunggak[0].periodeSeharusnya).toEqual(['2026-07', '2026-08']);
    expect(tertunggak[0].periodeSudahAda).toEqual(['2026-07']);
    expect(tertunggak[0].periodeTertunggak).toEqual(['2026-08']);
  });
});

// ============================================================
describe('§22/§23 laporan tetap berbasis GL (bukan subledger)', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('R: Posisi Keuangan — akumulasi tampil sebagai kontra-aset, nilai bersih Rp10.000.000', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    await testDb.withTransactionAsync(async () => {
      await createJournal(testDb as any, {
        tanggal: '2026-07-01',
        sumberTransaksi: 'ASET_TETAP',
        deskripsi: 'Perolehan aset',
        createdBy: 'user-1',
        lines: [
          { accountId: ACC.asetTetap, debit: 12_000_000, kredit: 0 },
          { accountId: ACC.modal, debit: 0, kredit: 12_000_000 },
        ],
      });
    });

    await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));

    const posisi = await getPosisiKeuangan(testDb as any, '2026-09-02');
    const bruto = posisi.aset.find((a) => a.kode === '1-1500');
    const akumulasi = posisi.aset.find((a) => a.kode === '1-1510');
    expect(bruto?.saldo).toBe(12_000_000);
    expect(akumulasi?.saldo).toBe(-2_000_000);
    expect((bruto?.saldo ?? 0) + (akumulasi?.saldo ?? 0)).toBe(10_000_000);
  });

  test('S: LHU — beban penyusutan masuk ke periode masing-masing (Juli & Agustus), September nol', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    await jalankanPenyusutanOtomatisJikaPerlu('user-1', new Date('2026-09-02'));

    const bebanPenyusutan = (lr: Awaited<ReturnType<typeof getLabaRugi>>) =>
      lr.beban.find((b) => b.kode === '5-1300')?.jumlah ?? 0;

    expect(bebanPenyusutan(await getLabaRugi(testDb as any, '2026-07-01', '2026-07-31'))).toBe(1_000_000);
    expect(bebanPenyusutan(await getLabaRugi(testDb as any, '2026-08-01', '2026-08-31'))).toBe(1_000_000);
    expect(bebanPenyusutan(await getLabaRugi(testDb as any, '2026-09-01', '2026-09-30'))).toBe(0);
  });
});

/**
 * BUG-05 — PENYUSUTAN MANUAL TIDAK BOLEH KE PERIODE MASA DEPAN.
 *
 * `prosesPenyusutanAset()` sudah memvalidasi format periode, keberadaan
 * aset, status aset, periode >= tanggal perolehan, batas masa manfaat,
 * dan batas akumulasi. Satu hal yang TIDAK pernah diperiksa: apakah
 * periodenya sudah benar-benar berjalan.
 *
 * Tanpa penjaga itu, periode '2030-01' menghasilkan tanggal jurnal
 * 2030-01-31; `createJournal` -> `getOrCreatePeriodeUntukTanggal` akan
 * MEMBUAT periode akuntansi 2030 berstatus OPEN, dan beban penyusutan
 * masa depan benar-benar masuk ke buku hari ini.
 */
describe('BUG-05 — guard periode penyusutan', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  test('periode MASA DEPAN ditolak, dan tidak ada jurnal/subledger yang lahir', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-01-01' });

    const jurnalSebelum = (
      await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM journal`)
    )!.n;

    await expect(
      prosesPenyusutanAset({
        asetId: 'aset-1',
        periode: '2030-01',
        createdBy: 'user-1',
        tanggalLaporan: '2026-09-03',
      })
    ).rejects.toThrow(/belum berjalan/);

    expect((await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM journal`))!.n).toBe(
      jurnalSebelum
    );
    expect(
      (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM aset_penyusutan`))!.n
    ).toBe(0);
    // Periode akuntansi masa depan TIDAK boleh ikut terbuat.
    expect(
      (await testDb.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) as n FROM accounting_period WHERE tahun_buku = 2030`
      ))!.n
    ).toBe(0);
  });

  test('periode BERJALAN tetap diizinkan (guard tidak over-blocking)', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-01-01' });
    const hasil = await prosesPenyusutanAset({
      asetId: 'aset-1',
      periode: '2026-09',
      createdBy: 'user-1',
      tanggalLaporan: '2026-09-03',
    });
    expect(hasil.dibuat).toBe(true);
  });

  test('periode LAMPAU (catch-up retroaktif) tetap diizinkan', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-01-01' });
    const hasil = await prosesPenyusutanAset({
      asetId: 'aset-1',
      periode: '2026-03',
      createdBy: 'user-1',
      tanggalLaporan: '2026-09-03',
    });
    expect(hasil.dibuat).toBe(true);
  });

  test('periode SEBELUM tanggal perolehan tetap ditolak (aturan lama tidak berubah)', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    await expect(
      prosesPenyusutanAset({
        asetId: 'aset-1',
        periode: '2026-05',
        createdBy: 'user-1',
        tanggalLaporan: '2026-09-03',
      })
    ).rejects.toThrow(/sebelum tanggal perolehan/);
  });

  test('periode TERTUTUP ditolak lewat guard terpusat createJournal', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-01-01' });
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE tahun_buku = 2026`);
    await expect(
      prosesPenyusutanAset({
        asetId: 'aset-1',
        periode: '2026-03',
        createdBy: 'user-1',
        tanggalLaporan: '2026-09-03',
      })
    ).rejects.toThrow();
    expect(
      (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM aset_penyusutan`))!.n
    ).toBe(0);
  });

  test('manual dan otomatis memakai formula & guard yang SAMA', async () => {
    // Dua aset identik: satu diproses manual, satu lewat batch runner.
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-01-01' });
    await seedAset(testDb, 'aset-2', { nilai: 12_000_000, masa: 12, tanggal: '2026-01-01' });

    await prosesPenyusutanAset({
      asetId: 'aset-1',
      periode: '2026-03',
      createdBy: 'user-1',
      tanggalLaporan: '2026-09-03',
    });
    await jalankanPenyusutanPeriode('2026-03', 'user-1', { tanggalLaporan: '2026-09-03' });

    const nilai = await testDb.getAllAsync<{ aset_id: string; nilai_penyusutan: number }>(
      `SELECT aset_id, nilai_penyusutan FROM aset_penyusutan WHERE periode = '2026-03' ORDER BY aset_id`
    );
    expect(nilai.length).toBe(2);
    expect(nilai[0].nilai_penyusutan).toBe(nilai[1].nilai_penyusutan);
  });

  test('batch runner meneruskan acuan waktunya — catch-up historis tidak tertolak jam sistem', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-01-01' });
    // Periode 2026-11 adalah masa depan menurut jam sistem test, tetapi
    // runner dijalankan dengan acuan 2026-12-31 (mis. penutupan tahun
    // buku). Satu operasi = satu acuan waktu.
    const hasil = await jalankanPenyusutanPeriode('2026-11', 'user-1', {
      tanggalLaporan: '2026-12-31',
    });
    expect(hasil.diproses.length).toBe(1);
  });
});

/**
 * BUG-06 — TIGA TANGGAL YANG TIDAK BOLEH TERTUKAR.
 *
 *   tanggal transaksi  -> tanggal jurnal & periode akuntansi
 *   tanggal perolehan  -> register aset & mulai penyusutan
 *   periode penyusutan -> pengakuan beban
 */
describe('BUG-06 — semantik tanggal aset retroaktif', () => {
  beforeEach(async () => {
    testDb = await seedFixture();
  });

  async function seedKasAwal() {
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('j-kas','JRN-KAS','2026-01-01','period-2026','MODAL_UANG','Modal awal kas','POSTED','user-1','x','x','x')`
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-k1','j-kas',?,?,0)`,
      ACC.kas,
      100_000_000
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-k2','j-kas',?,0,?)`,
      ACC.modal,
      100_000_000
    );
  }

  test('perolehan retroaktif: jurnal memakai tanggal TRANSAKSI, register memakai tanggal PEROLEHAN', async () => {
    await seedKasAwal();
    const hasil = await beliAset({
      namaAset: 'Laptop Kantor',
      nilaiPerolehan: 12_000_000,
      nilaiResidu: 0,
      masaManfaatBulan: 12,
      // Dibukukan hari ini, tetapi asetnya diperoleh dua bulan lalu.
      tanggal: '2026-09-03',
      tanggalPerolehan: '2026-07-01',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const aset = await testDb.getFirstAsync<{ tanggal_perolehan: string; journal_id: string }>(
      `SELECT tanggal_perolehan, journal_id FROM aset_tetap WHERE id = ?`,
      (hasil as any).id
    );
    expect(aset!.tanggal_perolehan).toBe('2026-07-01');

    const jurnal = await testDb.getFirstAsync<{ tanggal: string }>(
      `SELECT tanggal FROM journal WHERE id = ?`,
      aset!.journal_id
    );
    // Jurnal TIDAK dipindahkan ke 2026-07-01 hanya karena perolehannya
    // retroaktif — itu akan mengubah laporan periode yang sudah lewat
    // tanpa transaksi koreksi yang sah.
    expect(jurnal!.tanggal).toBe('2026-09-03');
  });

  test('tanggal perolehan SETELAH tanggal transaksi ditolak', async () => {
    await expect(
      beliAset({
        namaAset: 'Laptop Kantor',
        nilaiPerolehan: 1_000_000,
        nilaiResidu: 0,
        masaManfaatBulan: 12,
        tanggal: '2026-07-01',
        tanggalPerolehan: '2026-09-03',
        metodePembayaran: 'TUNAI',
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/tidak boleh setelah tanggal transaksi/);
  });

  test('tanpa tanggalPerolehan, perilaku PERSIS sama seperti sebelumnya (default = tanggal transaksi)', async () => {
    await seedKasAwal();
    const hasil = await beliAset({
      namaAset: 'Meja Kantor',
      nilaiPerolehan: 2_000_000,
      nilaiResidu: 0,
      masaManfaatBulan: 24,
      tanggal: '2026-08-15',
      metodePembayaran: 'TUNAI',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const aset = await testDb.getFirstAsync<{ tanggal_perolehan: string }>(
      `SELECT tanggal_perolehan FROM aset_tetap WHERE id = ?`,
      (hasil as any).id
    );
    expect(aset!.tanggal_perolehan).toBe('2026-08-15');
  });

  test('eligibilitas penyusutan mengikuti tanggal PEROLEHAN, bukan tanggal transaksi', async () => {
    await seedAset(testDb, 'aset-1', { nilai: 12_000_000, masa: 12, tanggal: '2026-07-01' });
    // Periode Juli & Agustus sudah eligible walau input transaksinya
    // baru dilakukan September.
    const juli = await prosesPenyusutanAset({
      asetId: 'aset-1',
      periode: '2026-07',
      createdBy: 'user-1',
      tanggalLaporan: '2026-09-03',
    });
    expect(juli.dibuat).toBe(true);

    // Periode Juni (sebelum perolehan) tetap ditolak.
    await expect(
      prosesPenyusutanAset({
        asetId: 'aset-1',
        periode: '2026-06',
        createdBy: 'user-1',
        tanggalLaporan: '2026-09-03',
      })
    ).rejects.toThrow(/sebelum tanggal perolehan/);
  });
});

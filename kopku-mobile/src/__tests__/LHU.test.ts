import { createTestDb, TestDb } from './testDb';
import { createJournal, reverseJournal } from '@/accounting/AccountingEngine';
import { getLHU, getLabaRugi } from '@/reports/FinancialReports';

/**
 * Test getLHU() — Revisi LHU KOPKU, struktur final Bagian A. Memakai
 * SQLite sungguhan (sql.js) & jurnal sungguhan lewat
 * AccountingEngine.createJournal, bukan data dummy.
 */

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  normalBalance: 'DEBIT' | 'KREDIT',
  lhuKlasifikasi: string | null = null
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?,?)`,
    id,
    kode,
    nama,
    kategori,
    normalBalance,
    lhuKlasifikasi,
    now,
    now
  );
}

async function seedPeriod(db: TestDb, tahun: number) {
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    `period-${tahun}`,
    tahun,
    `${tahun}-01-01`,
    `${tahun}-12-31`
  );
}

const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanAdmin: 'acc-pendapatan-admin',
  pendapatanDenda: 'acc-pendapatan-denda',
  pendapatanUsahaLain: 'acc-pendapatan-usaha-lain',
  pendapatanBungaBank: 'acc-pendapatan-bunga-bank',
  keuntunganAset: 'acc-keuntungan-aset',
  bebanGaji: 'acc-beban-gaji',
  bebanPenurunanInvestasi: 'acc-beban-penurunan-investasi',
  bebanPajak: 'acc-beban-pajak',
};

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();

  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.bank, '1-1100', 'Bank', 'ASET', 'DEBIT');

  await seedAccount(db, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT', null);
  await seedAccount(db, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT', 'PENDAPATAN_USAHA_LAIN');
  await seedAccount(db, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT', 'PENDAPATAN_USAHA_LAIN');
  await seedAccount(db, ACC.pendapatanUsahaLain, '4-2000', 'Pendapatan Usaha Lain', 'PENDAPATAN', 'KREDIT', 'PENDAPATAN_USAHA_LAIN');
  await seedAccount(db, ACC.pendapatanBungaBank, '4-4000', 'Pendapatan Bunga Bank', 'PENDAPATAN', 'KREDIT', 'HASIL_INVESTASI');
  await seedAccount(db, ACC.keuntunganAset, '4-5000', 'Keuntungan Pelepasan Aset', 'PENDAPATAN', 'KREDIT', 'PENDAPATAN_LAIN');

  await seedAccount(db, ACC.bebanGaji, '5-1100', 'Beban Gaji', 'BEBAN', 'DEBIT', 'BEBAN_USAHA');
  await seedAccount(db, ACC.bebanPenurunanInvestasi, '5-2150', 'Beban Penurunan Nilai Investasi', 'BEBAN', 'DEBIT', 'BEBAN_LAIN');
  await seedAccount(db, ACC.bebanPajak, '5-2200', 'Beban Pajak Penghasilan', 'BEBAN', 'DEBIT', null);

  await seedPeriod(db, 2025);
  await seedPeriod(db, 2026);

  return db;
}

async function jurnal(db: TestDb, tanggal: string, debitAccountId: string, kreditAccountId: string, nominal: number) {
  await createJournal(db as any, {
    tanggal,
    sumberTransaksi: 'TEST',
    deskripsi: 'test',
    createdBy: 'user-1',
    lines: [
      { accountId: debitAccountId, debit: nominal, kredit: 0 },
      { accountId: kreditAccountId, debit: 0, kredit: nominal },
    ],
  });
}

describe('getLHU — Revisi LHU KOPKU (struktur final Bagian A)', () => {
  test('skenario lengkap Bagian AE: hitungan LHU persis sesuai contoh instruksi', async () => {
    const db = await setupFixture();

    await jurnal(db, '2026-03-01', ACC.kas, ACC.pendapatanJasa, 100_000_000);
    await jurnal(db, '2026-03-02', ACC.kas, ACC.pendapatanAdmin, 5_000_000);
    await jurnal(db, '2026-03-02', ACC.kas, ACC.pendapatanDenda, 5_000_000);
    await jurnal(db, '2026-03-02', ACC.kas, ACC.pendapatanUsahaLain, 10_000_000);
    await jurnal(db, '2026-03-03', ACC.bebanGaji, ACC.kas, 70_000_000);
    await jurnal(db, '2026-03-04', ACC.bank, ACC.pendapatanBungaBank, 5_000_000);
    await jurnal(db, '2026-03-05', ACC.kas, ACC.keuntunganAset, 3_000_000);
    await jurnal(db, '2026-03-06', ACC.bebanPenurunanInvestasi, ACC.kas, 1_000_000);
    await jurnal(db, '2026-03-07', ACC.bebanPajak, ACC.kas, 7_000_000);

    const lhu = await getLHU(db as any, '2026-01-01', '2026-12-31');

    expect(lhu.pendapatanJasaPinjaman).toBe(100_000_000);
    expect(lhu.totalPendapatanUsahaLain).toBe(20_000_000);
    expect(lhu.jumlahPartisipasiAnggota).toBe(120_000_000);

    expect(lhu.jumlahBebanUsaha).toBe(70_000_000);
    expect(lhu.shuBruto).toBe(50_000_000);

    expect(lhu.totalHasilInvestasi).toBe(5_000_000);

    expect(lhu.totalPendapatanLain).toBe(3_000_000);
    expect(lhu.totalBebanLain).toBe(1_000_000);
    expect(lhu.pendapatanBebanLainNeto).toBe(2_000_000);

    expect(lhu.shuSebelumPajak).toBe(57_000_000);
    expect(lhu.bebanPajakPenghasilan).toBe(7_000_000);
    expect(lhu.shuNeto).toBe(50_000_000);
  });

  test('akun COA tetap terpisah walau sama-sama diklasifikasikan PENDAPATAN_USAHA_LAIN (Bagian I: LHU hanya mengelompokkan, bukan menggabungkan akun)', async () => {
    const db = await setupFixture();
    await jurnal(db, '2026-01-05', ACC.kas, ACC.pendapatanAdmin, 1_000_000);
    await jurnal(db, '2026-01-05', ACC.kas, ACC.pendapatanDenda, 2_000_000);

    const lhu = await getLHU(db as any, '2026-01-01', '2026-12-31');
    const kodeList = lhu.pendapatanUsahaLain.map((r) => r.kode).sort();
    expect(kodeList).toEqual(['4-1100', '4-1200']);
    expect(lhu.pendapatanUsahaLain.find((r) => r.kode === '4-1100')?.jumlah).toBe(1_000_000);
    expect(lhu.pendapatanUsahaLain.find((r) => r.kode === '4-1200')?.jumlah).toBe(2_000_000);
  });

  test('LHU harus langsung membaca transaksi begitu jurnal terbentuk (Bagian X) — tanpa posting manual kedua', async () => {
    const db = await setupFixture();
    let lhu = await getLHU(db as any, '2026-01-01', '2026-12-31');
    expect(lhu.totalHasilInvestasi).toBe(0);

    await jurnal(db, '2026-02-01', ACC.bank, ACC.pendapatanBungaBank, 2_000_000);

    lhu = await getLHU(db as any, '2026-01-01', '2026-12-31');
    expect(lhu.totalHasilInvestasi).toBe(2_000_000);
    expect(lhu.hasilInvestasi[0].nama).toBe('Pendapatan Bunga Bank');
  });

  test('SHU Neto SELALU identik dengan getLabaRugi().hasilUsaha — LHU murni pengelompokan ulang, bukan angka baru (Bagian V/AN)', async () => {
    const db = await setupFixture();
    await jurnal(db, '2026-01-10', ACC.kas, ACC.pendapatanJasa, 40_000_000);
    await jurnal(db, '2026-01-10', ACC.kas, ACC.pendapatanUsahaLain, 6_000_000);
    await jurnal(db, '2026-01-11', ACC.bank, ACC.pendapatanBungaBank, 1_500_000);
    await jurnal(db, '2026-01-12', ACC.kas, ACC.keuntunganAset, 900_000);
    await jurnal(db, '2026-01-13', ACC.bebanGaji, ACC.kas, 15_000_000);
    await jurnal(db, '2026-01-14', ACC.bebanPenurunanInvestasi, ACC.kas, 400_000);
    await jurnal(db, '2026-01-15', ACC.bebanPajak, ACC.kas, 2_000_000);

    const lhu = await getLHU(db as any, '2026-01-01', '2026-12-31');
    const labaRugi = await getLabaRugi(db as any, '2026-01-01', '2026-12-31');
    expect(lhu.shuNeto).toBe(labaRugi.hasilUsaha);
  });

  test('nilai negatif (rugi) TETAP tampil signed, bukan Rp0 (Bagian V — larangan Math.abs/Math.max(0))', async () => {
    const db = await setupFixture();
    await jurnal(db, '2026-01-01', ACC.kas, ACC.pendapatanJasa, 5_000_000);
    await jurnal(db, '2026-01-02', ACC.bebanGaji, ACC.kas, 20_000_000);

    const lhu = await getLHU(db as any, '2026-01-01', '2026-12-31');
    expect(lhu.shuBruto).toBe(-15_000_000);
    expect(lhu.shuSebelumPajak).toBe(-15_000_000);
    expect(lhu.shuNeto).toBe(-15_000_000);
  });

  test('tidak ada transaksi sama sekali -> semua Rp0, tidak crash (Bagian AI)', async () => {
    const db = await setupFixture();
    const lhu = await getLHU(db as any, '2026-01-01', '2026-12-31');
    expect(lhu.pendapatanJasaPinjaman).toBe(0);
    expect(lhu.jumlahPartisipasiAnggota).toBe(0);
    expect(lhu.shuBruto).toBe(0);
    expect(lhu.shuSebelumPajak).toBe(0);
    expect(lhu.shuNeto).toBe(0);
    expect(lhu.pendapatanUsahaLain).toEqual([]);
    expect(lhu.hasilInvestasi).toEqual([]);
  });

  test('date scoping (Bagian W): LHU 2025 hanya transaksi 2025, LHU 2026 hanya transaksi 2026', async () => {
    const db = await setupFixture();
    await jurnal(db, '2025-06-01', ACC.kas, ACC.pendapatanJasa, 100_000_000);
    await jurnal(db, '2026-06-01', ACC.kas, ACC.pendapatanJasa, 50_000_000);

    const lhu2025 = await getLHU(db as any, '2025-01-01', '2025-12-31');
    expect(lhu2025.pendapatanJasaPinjaman).toBe(100_000_000);

    const lhu2026 = await getLHU(db as any, '2026-01-01', '2026-12-31');
    expect(lhu2026.pendapatanJasaPinjaman).toBe(50_000_000);
  });

  test('reversal/koreksi tetap dihitung benar (jurnal REVERSED ikut, konsisten dengan getLabaRugi)', async () => {
    const db = await setupFixture();
    const { journalId } = await createJournal(db as any, {
      tanggal: '2026-01-01',
      sumberTransaksi: 'TEST',
      deskripsi: 'test',
      createdBy: 'user-1',
      lines: [
        { accountId: ACC.kas, debit: 10_000_000, kredit: 0 },
        { accountId: ACC.pendapatanUsahaLain, debit: 0, kredit: 10_000_000 },
      ],
    });
    await reverseJournal(db as any, journalId, 'user-1', 'koreksi test');

    const lhu = await getLHU(db as any, '2026-01-01', '2026-12-31');
    expect(lhu.totalPendapatanUsahaLain).toBe(0);
    expect(lhu.jumlahPartisipasiAnggota).toBe(0);
  });

  test('akun Pendapatan/Beban yang belum diklasifikasikan tetap muncul (tidak hilang), ditandai belumDiklasifikasikan (Bagian AA/V)', async () => {
    const db = await setupFixture();
    await seedAccount(db, 'acc-belum-klasifikasi', '4-6000', 'Pendapatan Baru Belum Diklasifikasikan', 'PENDAPATAN', 'KREDIT', null);
    await jurnal(db, '2026-01-01', ACC.kas, 'acc-belum-klasifikasi', 1_000_000);

    const lhu = await getLHU(db as any, '2026-01-01', '2026-12-31');
    const row = lhu.pendapatanLain.find((r) => r.kode === '4-6000');
    expect(row).toBeDefined();
    expect(row?.belumDiklasifikasikan).toBe(true);
    expect(lhu.totalPendapatanLain).toBe(1_000_000);
  });
});

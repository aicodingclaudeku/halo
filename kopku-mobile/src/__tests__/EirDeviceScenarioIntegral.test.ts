import { createTestDb, TestDb } from './testDb';

/**
 * INTEGRATION TEST — REPLIKASI PERSIS SKENARIO DEVICE yang dilaporkan
 * masih menampilkan error "domain [-0.99, 10]":
 *
 *   Jumlah Pinjaman      : Rp1.000.000
 *   Tenor                : 10 HARI
 *   Jasa                 : EFEKTIF 2%
 *   Biaya Administrasi   : PERSENTASE 2%  (= Rp20.000)
 *   Metode biaya admin   : Jasa INTEGRAL (INTEGRAL_FINANCIAL_INSTRUMENT)
 *
 * BEDA dengan EirPinjamanTenorHarian.test.ts (yang sudah ada): test itu
 * memakai metode jasa FLAT dan biaya admin NOMINAL. Test ini memakai
 * kombinasi PERSIS dari layar device — EFEKTIF + PERSENTASE — supaya
 * jalur `normalisasiBiayaAdminKlasifikasi()` (PERSENTASE -> INTEGRAL)
 * dan jadwal angsuran metode EFEKTIF ikut terbukti, bukan hanya solver.
 *
 * PENTING: test ini memanggil `cairkanPinjaman()` SUNGGUHAN (service
 * layer, di dalam withTransaction, dengan SQLite nyata via sql.js) —
 * BUKAN memanggil `solveEffectiveInterestRate()` secara langsung.
 * Kalau solver yang dipakai runtime masih yang lama (bracket statis
 * rateMax=10), test ini GAGAL di baris pencairan.
 */

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

import { ajukanPinjaman, cairkanPinjaman, getJadwalAngsuran } from '@/services/PinjamanService';

const ACC = {
  kas: 'acc-kas',
  piutang: 'acc-piutang',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanAdmin: 'acc-pendapatan-admin',
  pendapatanDenda: 'acc-pendapatan-denda',
  modal: 'acc-modal',
};

const ANGGOTA_ID = 'anggota-1';
const TANGGAL_AKAD = '2026-03-02';

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
     VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kategori, normalBalance, now, now
  );
}

async function seedMapping(db: TestDb, tt: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutang, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.modal, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutang);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026', 2026, '2026-01-01', '2026-12-31'
  );

  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID, 'A001', '1234567890123456', 'Budi', '2020-01-01', now, now
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now, now
  );

  // Likuiditas: kas 50 juta (agar checkLiquiditasPencairan lolos).
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('j-modal','JRN-MODAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal fixture','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je1','j-modal',?,?,0)`,
    ACC.kas, 50_000_000
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je2','j-modal',?,0,?)`,
    ACC.modal, 50_000_000
  );

  for (const [id, jenis, nominal] of [['sp', 'POKOK', 100000], ['sw', 'WAJIB', 50000]] as const) {
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?,?,?,'SETOR','2020-01-01',?,'KAS',?, 'user-1',?)`,
      id, ANGGOTA_ID, jenis, nominal, id.toUpperCase(), now
    );
  }
}

/** Skenario device PERSIS: 1.000.000 / 10 HARI / EFEKTIF 2% / admin PERSENTASE 2% / INTEGRAL. */
async function ajukanSkenarioDevice() {
  return ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: TANGGAL_AKAD,
    jumlahPinjaman: 1_000_000,
    tenor: 10,
    satuanTenor: 'HARI',
    metodeJasa: 'EFEKTIF',
    persentaseJasa: 2,
    biayaAdminTipe: 'PERSENTASE',
    biayaAdminNilai: 2,
    biayaAdminKlasifikasi: 'INTEGRAL_FINANCIAL_INSTRUMENT',
    dendaAktif: false,
    createdBy: 'user-1',
  });
}

function npvManual(rate: number, cf: { hari: number; jumlah: number }[]): number {
  return cf.reduce((a, c) => a + c.jumlah / Math.pow(1 + rate, c.hari / 365), 0);
}

function selisihHari(a: string, b: string): number {
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
}

async function bacaRateEir(pinjamanId: string): Promise<number | null> {
  const row = await testDb.getFirstAsync<{ effective_interest_rate: number | null }>(
    `SELECT effective_interest_rate FROM pinjaman_akuntansi_jasa
     WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
    pinjamanId
  );
  return row?.effective_interest_rate ?? null;
}

describe('SKENARIO DEVICE — Rp1.000.000 / 10 hari / EFEKTIF 2% / admin 2% PERSENTASE / INTEGRAL', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('klasifikasi INTEGRAL bertahan lewat normalisasiBiayaAdminKlasifikasi (PERSENTASE tidak dipaksa jadi SEPARATE)', async () => {
    const { id } = await ajukanSkenarioDevice();
    const row = await testDb.getFirstAsync<{ biaya_admin_klasifikasi: string; biaya_admin_tipe: string; biaya_admin_nilai: number }>(
      `SELECT biaya_admin_klasifikasi, biaya_admin_tipe, biaya_admin_nilai FROM pinjaman WHERE id = ?`,
      id
    );
    expect(row?.biaya_admin_tipe).toBe('PERSENTASE');
    expect(row?.biaya_admin_nilai).toBe(2);
    expect(row?.biaya_admin_klasifikasi).toBe('INTEGRAL_FINANCIAL_INSTRUMENT');
  });

  test('cairkanPinjaman() SUKSES — tidak melempar error EIR, tidak rollback', async () => {
    const { id } = await ajukanSkenarioDevice();

    const hasil = await cairkanPinjaman({
      pinjamanId: id,
      sumberDana: 'KAS',
      approvedBy: 'user-1',
      tanggalPencairan: TANGGAL_AKAD,
    });

    expect(hasil.journalId).toBeTruthy();

    const p = await testDb.getFirstAsync<{ status: string; pencairan_journal_id: string | null }>(
      `SELECT status, pencairan_journal_id FROM pinjaman WHERE id = ?`,
      id
    );
    expect(p?.status).toBe('AKTIF');
    expect(p?.pencairan_journal_id).toBeTruthy();
  });

  test('eir_measurement_status = MEASURED dan EIR finite & > 10', async () => {
    const { id } = await ajukanSkenarioDevice();
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: TANGGAL_AKAD });

    const row = await testDb.getFirstAsync<{ eir_measurement_status: string }>(
      `SELECT eir_measurement_status FROM pinjaman WHERE id = ?`,
      id
    );
    const rate = await bacaRateEir(id);

    expect(row?.eir_measurement_status).toBe('MEASURED');
    expect(rate).not.toBeNull();
    expect(Number.isFinite(rate as number)).toBe(true);
    // Akar sah untuk tenor 10 hari berada JAUH di atas bracket lama (10).
    expect(rate as number).toBeGreaterThan(10);
  });

  test('EIR tersimpan benar-benar AKAR: NPV arus kas kontraktual dalam toleransi', async () => {
    const { id } = await ajukanSkenarioDevice();
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: TANGGAL_AKAD });

    const rate = (await bacaRateEir(id)) as number;
    const jadwal = await getJadwalAngsuran(id);

    // initial carrying amount = pokok - fee integral (2% x 1.000.000 = 20.000)
    const cf = [{ hari: 0, jumlah: -(1_000_000 - 20_000) }];
    for (const a of jadwal) {
      cf.push({ hari: selisihHari(a.tanggalJatuhTempo, TANGGAL_AKAD), jumlah: a.total });
    }

    expect(Math.abs(npvManual(rate, cf))).toBeLessThan(0.5);
  });

  test('jurnal pencairan BALANCE (debit = kredit) dan fee integral masuk Pendapatan Diterima Dimuka', async () => {
    const { id } = await ajukanSkenarioDevice();
    const { journalId } = await cairkanPinjaman({
      pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: TANGGAL_AKAD,
    });

    const agg = await testDb.getFirstAsync<{ d: number; k: number }>(
      `SELECT SUM(debit) AS d, SUM(kredit) AS k FROM journal_entry WHERE journal_id = ?`,
      journalId
    );
    expect(agg?.d).toBe(agg?.k);
    expect(agg?.d).toBe(1_000_000);

    // Fee integral 20.000 dikreditkan ke 2-1300 (bukan 4-1100 Pendapatan Administrasi).
    const dimuka = await testDb.getFirstAsync<{ k: number }>(
      `SELECT SUM(kredit) AS k FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
      journalId, ACC.pendapatanDimuka
    );
    expect(dimuka?.k).toBe(20_000);

    const adminIncome = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM journal_entry WHERE journal_id = ? AND account_id = ?`,
      journalId, ACC.pendapatanAdmin
    );
    expect(adminIncome?.n).toBe(0);
  });

  test('TIDAK ADA ROLLBACK: baris FEE_INTEGRAL_AMORTISASI tersimpan setelah commit', async () => {
    const { id } = await ajukanSkenarioDevice();
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: TANGGAL_AKAD });

    const row = await testDb.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM pinjaman_akuntansi_jasa
       WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
      id
    );
    expect(row?.n).toBe(1);
  });
});

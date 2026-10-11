import { createTestDb, TestDb } from './testDb';

/**
 * INTEGRATION TEST — kasus KOPKU nyata yang memicu bug:
 *   jumlah pinjaman Rp1.000.000, tenor 10 HARI.
 *
 * Sebelum perbaikan solver, `cairkanPinjaman()` untuk pinjaman ini
 * GAGAL TOTAL dengan pesan "tidak ditemukan rate pada domain
 * [-0.99, 10]", karena annualized EIR-nya secara matematis memang di
 * atas 1000% — konsekuensi wajar dari tenor 10 hari, BUKAN tanda arus
 * kas yang salah.
 *
 * Yang dibuktikan di sini:
 *   1) pencairan BERHASIL (tidak rollback) selama akar EIR memang ada;
 *   2) `eir_measurement_status` = MEASURED saat fee integral > 0;
 *   3) `effective_interest_rate` tersimpan, finite, dan > 10
 *      (membuktikan akar di luar bracket lama benar-benar terpakai);
 *   4) NPV arus kas kontraktual pada rate tersimpan berada dalam
 *      toleransi — jadi rate-nya benar-benar akar, bukan angka asal;
 *   5) jurnal pencairan tetap BALANCE;
 *   6) jalur Jasa Terpisah pada tenor pendek juga tidak ikut rusak.
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

const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanAdmin: 'acc-pendapatan-admin',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  pendapatanDenda: 'acc-pendapatan-denda',
  modal: 'acc-modal',
};
const ANGGOTA_ID = 'anggota-1';
const TANGGAL_AKAD = '2026-01-01';

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);

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
     VALUES ('user-1','Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('j-modal','JRN-MODAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal fixture','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je1','j-modal',?,?,0)`, ACC.kas, 50_000_000);
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je2','j-modal',?,0,?)`, ACC.modal, 50_000_000);

  for (const [id, jenis, nominal] of [['sp', 'POKOK', 100000], ['sw', 'WAJIB', 50000]] as const) {
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?,?,?,'SETOR','2020-01-01',?,'KAS',?, 'user-1',?)`,
      id, ANGGOTA_ID, jenis, nominal, id.toUpperCase(), now
    );
  }
}

/** Pinjaman Rp1.000.000 tenor 10 HARI (1 periode 10 hari). */
async function ajukan10Hari(klasifikasi: 'SEPARATE_SERVICE' | 'INTEGRAL_FINANCIAL_INSTRUMENT') {
  return ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: TANGGAL_AKAD,
    jumlahPinjaman: 1_000_000,
    tenor: 10,
    satuanTenor: 'HARI',
    metodeJasa: 'FLAT',
    persentaseJasa: 1,
    biayaAdminTipe: 'NOMINAL',
    biayaAdminNilai: 20_000,
    biayaAdminKlasifikasi: klasifikasi,
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

/**
 * Rate EIR disimpan di `pinjaman_akuntansi_jasa` (baris
 * FEE_INTEGRAL_AMORTISASI), BUKAN di kolom tabel `pinjaman` —
 * lihat EirAccountingService.inisiasiEirPinjaman().
 */
async function bacaRateEir(pinjamanId: string): Promise<number | null> {
  const row = await testDb.getFirstAsync<{ effective_interest_rate: number | null }>(
    `SELECT effective_interest_rate FROM pinjaman_akuntansi_jasa
     WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
    pinjamanId
  );
  return row?.effective_interest_rate ?? null;
}

describe('KOPKU nyata — pinjaman Rp1.000.000 tenor 10 HARI', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('Jasa Integral: pencairan BERHASIL (tidak lagi gagal karena EIR > 1000%)', async () => {
    const { id } = await ajukan10Hari('INTEGRAL_FINANCIAL_INSTRUMENT');

    // Sebelum perbaikan solver, baris ini melempar
    // "tidak ditemukan rate pada domain [-0.99, 10]" dan SELURUH
    // transaksi rollback.
    const hasil = await cairkanPinjaman({
      pinjamanId: id,
      sumberDana: 'KAS',
      approvedBy: 'user-1',
      tanggalPencairan: TANGGAL_AKAD,
    });
    expect(hasil.journalId).toBeTruthy();

    const p = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM pinjaman WHERE id = ?`, id);
    expect(p?.status).toBe('AKTIF');
  });

  test('eir_measurement_status = MEASURED dan rate tersimpan finite & > 10', async () => {
    const { id } = await ajukan10Hari('INTEGRAL_FINANCIAL_INSTRUMENT');
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: TANGGAL_AKAD });

    const row = await testDb.getFirstAsync<{ eir_measurement_status: string }>(
      `SELECT eir_measurement_status FROM pinjaman WHERE id = ?`,
      id
    );
    const rate = await bacaRateEir(id);

    expect(row?.eir_measurement_status).toBe('MEASURED');
    expect(rate).not.toBeNull();
    expect(Number.isFinite(rate as number)).toBe(true);
    // INI inti bug-nya: akar yang sah berada di atas bracket lama (10).
    expect(rate as number).toBeGreaterThan(10);
  });

  test('rate tersimpan benar-benar AKAR: NPV arus kas kontraktual ~ 0', async () => {
    const { id } = await ajukan10Hari('INTEGRAL_FINANCIAL_INSTRUMENT');
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: TANGGAL_AKAD });

    const rate = await bacaRateEir(id);
    expect(rate).not.toBeNull();
    const jadwal = await getJadwalAngsuran(id);

    // Rekonstruksi arus kas kontraktual: carrying amount awal = pokok
    // dikurangi fee integral (kas bersih yang keluar), lalu seluruh
    // penerimaan kontraktual pada tanggal jatuh temponya.
    const cashflows = [
      { hari: 0, jumlah: -(1_000_000 - 20_000) },
      ...jadwal.map((j) => ({
        hari: selisihHari(j.tanggalJatuhTempo, TANGGAL_AKAD),
        jumlah: j.pokok + j.jasa,
      })),
    ];

    const npv = npvManual(rate as number, cashflows);
    // Toleransi solver Rp0,5; diberi kelonggaran kecil untuk pembulatan
    // rekonstruksi jadwal di sisi test.
    expect(Math.abs(npv)).toBeLessThan(5);
  });

  test('jurnal pencairan tetap BALANCE pada tenor pendek', async () => {
    const { id } = await ajukan10Hari('INTEGRAL_FINANCIAL_INSTRUMENT');
    const { journalId } = await cairkanPinjaman({
      pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: TANGGAL_AKAD,
    });

    const t = await testDb.getFirstAsync<{ d: number; k: number }>(
      `SELECT COALESCE(SUM(debit),0) as d, COALESCE(SUM(kredit),0) as k FROM journal_entry WHERE journal_id = ?`,
      journalId
    );
    expect(t?.d).toBe(t?.k);
    expect(t?.d).toBe(1_000_000);
  });

  test('Jasa Terpisah pada tenor 10 hari juga tetap berjalan (tidak memicu EIR)', async () => {
    const { id } = await ajukan10Hari('SEPARATE_SERVICE');
    const { journalId } = await cairkanPinjaman({
      pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: TANGGAL_AKAD,
    });

    const row = await testDb.getFirstAsync<{ eir_measurement_status: string }>(
      `SELECT eir_measurement_status FROM pinjaman WHERE id = ?`,
      id
    );
    expect(row?.eir_measurement_status).not.toBe('MEASURED');

    const t = await testDb.getFirstAsync<{ d: number; k: number }>(
      `SELECT COALESCE(SUM(debit),0) as d, COALESCE(SUM(kredit),0) as k FROM journal_entry WHERE journal_id = ?`,
      journalId
    );
    expect(t?.d).toBe(t?.k);
  });

  test('ACCOUNTING SAFETY: tidak ada pinjaman AKTIF tanpa EIR saat fee integral > 0', async () => {
    const { id } = await ajukan10Hari('INTEGRAL_FINANCIAL_INSTRUMENT');
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: TANGGAL_AKAD });

    const row = await testDb.getFirstAsync<{ status: string; eir_measurement_status: string }>(
      `SELECT status, eir_measurement_status FROM pinjaman WHERE id = ?`,
      id
    );
    const rate = await bacaRateEir(id);
    // Kombinasi terlarang: AKTIF + fee integral MEASURED + rate kosong.
    const kombinasiTerlarang =
      row?.status === 'AKTIF' && row?.eir_measurement_status === 'MEASURED' && rate == null;
    expect(kombinasiTerlarang).toBe(false);
  });
});

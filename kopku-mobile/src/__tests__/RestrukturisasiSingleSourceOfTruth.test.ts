import { createTestDb, TestDb } from './testDb';

/**
 * BUG-08 / BUG-12 — REGRESSION END-TO-END RESTRUKTURISASI.
 *
 * Skenario yang dilaporkan audit: pinjaman 12.000.000 yang melewati
 * pembayaran lalu DUA kali akad ulang terbaca sebagai
 *
 *     12.000.000 -> 24.000.000 -> 38.880.000
 *
 * di layar/laporan yang membaca `angsuran_jadwal` TANPA menyaring baris
 * obsolete. Baris jadwal LAMA (status DIRESTRUKTURISASI) ikut
 * dijumlahkan bersama jadwal penggantinya.
 *
 * Test ini memakai SATU dataset untuk SEMUA modul (outstanding,
 * tunggakan, aging, impairment, eligibility) supaya inkonsistensi
 * lintas-modul ketahuan — bukan tiap modul diuji dengan fixture-nya
 * sendiri.
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

import {
  ajukanPinjaman,
  cairkanPinjaman,
  bayarAngsuran,
  akadUlangPinjaman,
  getJadwalAngsuran,
  isAngsuranAktif,
  listTunggakan,
  hapusPiutangPinjaman,
  getPinjamanDetail,
} from '@/services/PinjamanService';
import { getTotalOutstanding, getTunggakanAnggota } from '@/services/LoanEligibilityService';
import { getKlasifikasiPinjamanAktif } from '@/services/LoanImpairmentService';
import {
  isCurrentRepaymentSchedule,
  isObsoleteRepaymentSchedule,
  isScheduleObsoleteForRestructuring,
  sqlJadwalBukanObsolete,
} from '@/accounting/ScheduleLifecycle';

const ANGGOTA_ID = 'anggota-1';
const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanAdmin: 'acc-pendapatan-admin',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  pendapatanDenda: 'acc-pendapatan-denda',
  penyisihan: 'acc-penyisihan',
  bebanPenyisihan: 'acc-beban-penyisihan',
  modal: 'acc-modal',
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
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
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

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.penyisihan, '1-1210', 'Penyisihan Piutang Tak Tertagih', 'ASET', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.bebanPenyisihan, '5-2100', 'Beban Penyisihan Pinjaman', 'BEBAN', 'DEBIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'PENYISIHAN_PIUTANG', 'DEBIT_BEBAN', ACC.bebanPenyisihan);
  await seedMapping(testDb, 'PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN', ACC.penyisihan);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );
  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2027',
    2027,
    '2027-01-01',
    '2027-12-31'
  );

  const now = new Date().toISOString();
  await testDb.runAsync(
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
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  // Write-off mensyaratkan persetujuan RAT untuk tahun buku terkait.
  await testDb.runAsync(
    `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at) VALUES ('rat-2026',2026,'2026-05-01','user-1',?,?)`,
    now,
    now
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal (fixture test)','POSTED','user-1',?,?,?)`,
    now,
    now,
    now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`,
    'je-modal-debit',
    'journal-modal-awal',
    ACC.kas,
    100_000_000
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`,
    'je-modal-kredit',
    'journal-modal-awal',
    ACC.modal,
    100_000_000
  );

  // Syarat eligibilitas: anggota wajib punya Simpanan Pokok & Wajib.
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sp-fixture',?,'POKOK','SETOR','2020-01-01',100000,'KAS','SP-FIXTURE','user-1',?)`,
    ANGGOTA_ID,
    now
  );
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sw-fixture',?,'WAJIB','SETOR','2020-01-01',50000,'KAS','SW-FIXTURE','user-1',?)`,
    ANGGOTA_ID,
    now
  );
}

/** Total outstanding "naif" — meniru query LAMA yang tidak menyaring obsolete. */
async function outstandingTanpaFilter(): Promise<number> {
  const row = await testDb.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(aj.total - aj.pokok_terbayar - aj.jasa_terbayar),0) as total
     FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id
     WHERE p.anggota_id = ? AND p.status = 'AKTIF'`,
    ANGGOTA_ID
  );
  return row?.total ?? 0;
}

/** Total outstanding sesuai aturan lifecycle terpusat. */
async function outstandingCurrent(): Promise<number> {
  const row = await testDb.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(aj.total - aj.pokok_terbayar - aj.jasa_terbayar),0) as total
     FROM angsuran_jadwal aj JOIN pinjaman p ON p.id = aj.pinjaman_id
     WHERE p.anggota_id = ? AND p.status = 'AKTIF' AND ${sqlJadwalBukanObsolete('aj')}`,
    ANGGOTA_ID
  );
  return row?.total ?? 0;
}

describe('BUG-08/BUG-12 — restrukturisasi: satu sumber kebenaran jadwal', () => {
  let pinjamanId: string;

  beforeEach(async () => {
    await setupFixture();

    // ---- Loan 12.000.000, FLAT 1%/bulan, tenor 12, cair 2026-01-01 ----
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 12_000_000,
      tenor: 12,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    pinjamanId = id;
    await cairkanPinjaman({
      pinjamanId,
      sumberDana: 'KAS',
      approvedBy: 'user-1',
      tanggalPencairan: '2026-01-01',
    });

    // ---- Payment: angsuran #1 dibayar PENUH ----
    const jadwalAwal = await getJadwalAngsuran(pinjamanId);
    const angsuran1 = jadwalAwal[0];
    await bayarAngsuran({
      pinjamanId,
      jadwalId: angsuran1.id,
      tanggal: '2026-02-01',
      nominal: angsuran1.total,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    // ---- Restructuring #1 ----
    await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-03-01',
      tenorBaru: 12,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });

    // ---- Restructuring #2 ----
    await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-04-01',
      tenorBaru: 12,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });
  });

  test('baris obsolete memang ada di database (bukan dihapus) — jadi filter WAJIB bekerja', async () => {
    const semua = await getJadwalAngsuran(pinjamanId);
    const obsolete = semua.filter((j) => isObsoleteRepaymentSchedule(j.status));
    const current = semua.filter((j) => isCurrentRepaymentSchedule(j.status));

    // 11 baris lama dari akad asli + 12 baris dari akad ulang #1 = 23 obsolete.
    expect(obsolete.length).toBeGreaterThan(0);
    // Jadwal current = HANYA hasil akad ulang terakhir.
    expect(current.length).toBe(12);
    // Jejak audit tetap utuh.
    expect(semua.length).toBe(obsolete.length + current.length + 1 /* angsuran #1 LUNAS */);
  });

  test('outstanding TIDAK berlipat (12M -> 24M -> 38,88M adalah gejala bug)', async () => {
    const naif = await outstandingTanpaFilter();
    const benar = await outstandingCurrent();

    // Bukti bahwa datasetnya memang memicu bug kalau filter dilepas.
    expect(naif).toBeGreaterThan(benar * 2);

    // Outstanding yang benar tidak boleh melebihi total tagihan satu
    // jadwal current (pokok sisa + jasa kontraktual barunya).
    const currentRows = await testDb.getAllAsync<{ total: number }>(
      `SELECT total FROM angsuran_jadwal aj WHERE aj.pinjaman_id = ? AND ${sqlJadwalBukanObsolete('aj')} AND aj.status != 'LUNAS'`,
      pinjamanId
    );
    const totalJadwalCurrent = currentRows.reduce((a, r) => a + r.total, 0);
    expect(benar).toBe(totalJadwalCurrent);
  });

  test('eligibility, impairment, dan subledger memakai angka outstanding yang SAMA', async () => {
    const benar = await outstandingCurrent();

    // 1) LoanEligibilityService
    const outstandingEligibility = await getTotalOutstanding(testDb as any, ANGGOTA_ID);
    expect(outstandingEligibility).toBe(benar);

    // 2) LoanImpairmentService (klasifikasi/aging/penyisihan)
    const klasifikasi = await getKlasifikasiPinjamanAktif(testDb as any, { tanggalLaporan: '2026-12-31' });
    const baris = klasifikasi.find((k) => k.pinjamanId === pinjamanId);
    expect(baris).toBeDefined();
    expect(baris!.saldoPiutang).toBe(benar);
  });

  test('aging/tunggakan hanya dari jadwal current', async () => {
    // Jadwal current hasil akad ulang #2 mulai jatuh tempo 2026-05-01.
    // Baris obsolete punya jatuh tempo 2026-02-01 dst; kalau ikut
    // terhitung, hari tunggakan akan jauh lebih besar.
    const tunggakan = await getTunggakanAnggota(testDb as any, ANGGOTA_ID);
    const semua = await getJadwalAngsuran(pinjamanId);
    const currentTerlambat = semua.filter(
      (j) => isCurrentRepaymentSchedule(j.status) && j.tanggalJatuhTempo < new Date().toISOString().slice(0, 10)
    );
    expect(tunggakan.jumlahTunggakanAktif).toBe(currentTerlambat.length);

    // listTunggakan (laporan lintas anggota) harus konsisten dengan itu.
    const daftar = await listTunggakan();
    expect(daftar.filter((t) => t.pinjamanId === pinjamanId).length).toBe(currentTerlambat.length);
  });

  test('klasifikasi penyajian (UI/export) konsisten dengan aturan lifecycle', async () => {
    const semua = await getJadwalAngsuran(pinjamanId);
    for (const j of semua) {
      // Baris yang dianggap "aktif" untuk UI/export tidak boleh obsolete.
      if (isAngsuranAktif(j)) {
        expect(isObsoleteRepaymentSchedule(j.status)).toBe(false);
      }
      if (isObsoleteRepaymentSchedule(j.status)) {
        expect(isAngsuranAktif(j)).toBe(false);
      }
    }
  });
});

/**
 * SESI 2 §C — JADWAL BERSTATUS 'TERLAMBAT'.
 *
 * Status 'TERLAMBAT' sah menurut CHECK constraint tetapi tidak pernah
 * ditulis aplikasi (keterlambatan diturunkan dari tanggal jatuh tempo).
 * Data legacy / hasil import bisa memilikinya. Test ini menyuntikkannya
 * LANGSUNG lewat SQL — bukan memaksa service menulis status yang memang
 * bukan tugasnya — lalu membuktikan bahwa restrukturisasi & write-off
 * memperlakukannya sebagai baris current yang WAJIB ditandai obsolete.
 */
async function buatPinjamanDenganJadwalTerlambat(): Promise<string> {
  const { id } = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: '2026-01-01',
    jumlahPinjaman: 12_000_000,
    tenor: 12,
    satuanTenor: 'BULAN',
    metodeJasa: 'FLAT',
    persentaseJasa: 1,
    biayaAdminTipe: 'TIDAK_ADA',
    biayaAdminNilai: 0,
    dendaAktif: false,
    createdBy: 'user-1',
  });
  await cairkanPinjaman({
    pinjamanId: id,
    sumberDana: 'KAS',
    approvedBy: 'user-1',
    tanggalPencairan: '2026-01-01',
  });
  // Dua angsuran pertama ditandai TERLAMBAT (meniru data legacy).
  await testDb.runAsync(
    `UPDATE angsuran_jadwal SET status = 'TERLAMBAT'
     WHERE pinjaman_id = ? AND nomor_angsuran IN (1,2)`,
    id
  );
  return id;
}

describe('SESI 2 §C — jadwal TERLAMBAT pada restrukturisasi & write-off', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('TERLAMBAT diperlakukan sebagai CURRENT (bukan obsolete, bukan completed)', () => {
    expect(isCurrentRepaymentSchedule('TERLAMBAT')).toBe(true);
    expect(isObsoleteRepaymentSchedule('TERLAMBAT')).toBe(false);
    expect(isScheduleObsoleteForRestructuring('TERLAMBAT')).toBe(true);
    // Status yang memang sudah obsolete tidak boleh "dihidupkan lagi".
    expect(isScheduleObsoleteForRestructuring('DIRESTRUKTURISASI')).toBe(false);
    expect(isScheduleObsoleteForRestructuring('DIHAPUSBUKU')).toBe(false);
    expect(isScheduleObsoleteForRestructuring('LUNAS')).toBe(false);
  });

  test('restrukturisasi menandai jadwal TERLAMBAT sebagai DIRESTRUKTURISASI (histori tetap ada)', async () => {
    const pinjamanId = await buatPinjamanDenganJadwalTerlambat();

    await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-04-01',
      tenorBaru: 12,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });

    const semua = await getJadwalAngsuran(pinjamanId);
    // Baris lama TIDAK dihapus dan TIDAK di-reset jadi LUNAS.
    const lama = semua.filter((j) => !j.dibuatDariAkadUlangId);
    expect(lama.length).toBe(12);
    expect(lama.every((j) => j.status === 'DIRESTRUKTURISASI')).toBe(true);

    // Baris baru = satu-satunya jadwal current.
    const current = semua.filter((j) => isCurrentRepaymentSchedule(j.status));
    expect(current.length).toBe(12);
    expect(current.every((j) => j.dibuatDariAkadUlangId !== null)).toBe(true);
  });

  test('outstanding, aging, impairment & eligibility hanya dari jadwal current', async () => {
    const pinjamanId = await buatPinjamanDenganJadwalTerlambat();
    await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-04-01',
      tenorBaru: 12,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });

    const naif = await outstandingTanpaFilter();
    const benar = await outstandingCurrent();
    // Tanpa filter, jadwal TERLAMBAT lama ikut terjumlah bersama jadwal baru.
    expect(naif).toBeGreaterThan(benar);

    expect(await getTotalOutstanding(testDb as any, ANGGOTA_ID)).toBe(benar);

    const klasifikasi = await getKlasifikasiPinjamanAktif(testDb as any, {
      tanggalLaporan: '2026-12-31',
    });
    expect(klasifikasi.find((k) => k.pinjamanId === pinjamanId)!.saldoPiutang).toBe(benar);

    // Aging: jadwal current hasil akad ulang mulai jatuh tempo 2026-05-01.
    // Kalau baris TERLAMBAT lama (jatuh tempo Feb/Mar) ikut, hari
    // tunggakannya akan jauh lebih besar.
    const semua = await getJadwalAngsuran(pinjamanId);
    const currentTerlambat = semua.filter(
      (j) =>
        isCurrentRepaymentSchedule(j.status) &&
        j.tanggalJatuhTempo < new Date().toISOString().slice(0, 10)
    );
    const tunggakan = await getTunggakanAnggota(testDb as any, ANGGOTA_ID);
    expect(tunggakan.jumlahTunggakanAktif).toBe(currentTerlambat.length);
  });

  test('write-off menandai jadwal TERLAMBAT sebagai DIHAPUSBUKU dan outstanding menjadi 0', async () => {
    const pinjamanId = await buatPinjamanDenganJadwalTerlambat();

    await hapusPiutangPinjaman({
      pinjamanId,
      tanggal: '2026-11-01',
      alasan: 'Anggota tidak dapat dilacak',
      createdBy: 'user-1',
      topUpPenyisihanJikaKurang: true,
    });

    const semua = await getJadwalAngsuran(pinjamanId);
    // TIDAK ADA baris current yang tertinggal — kalau ada, pinjaman yang
    // sudah dihapusbukukan akan tetap menghasilkan outstanding & akrual.
    expect(semua.filter((j) => isCurrentRepaymentSchedule(j.status)).length).toBe(0);
    expect(semua.filter((j) => j.status === 'DIHAPUSBUKU').length).toBe(12);
    // Histori utuh: tidak ada baris yang hilang.
    expect(semua.length).toBe(12);

    expect(await outstandingCurrent()).toBe(0);
  });
});


/**
 * BUG-13 — REKONSILIASI HEADER vs JADWAL.
 *
 * Bug aslinya: `pinjaman.tanggal_jatuh_tempo` dihitung sekali-lompat
 * (`origin + tenor`) sementara tiap baris jadwal dihitung iteratif
 * (`hasil sebelumnya + 1`). Untuk akad akhir bulan kedua cara itu
 * berbeda, sehingga header dan jadwal saling bertentangan.
 *
 * Invarian yang dikunci di sini:
 *     pinjaman.tanggal_jatuh_tempo === MAX(jadwal current.tanggal_jatuh_tempo)
 */
describe('BUG-13 — header maturity === jadwal terakhir', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  async function buatPinjaman(tanggal: string, tenor: number, satuan: 'HARI' | 'MINGGU' | 'BULAN') {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal,
      jumlahPinjaman: 12_000_000,
      tenor,
      satuanTenor: satuan,
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    return id;
  }

  const KASUS: [string, number, 'BULAN'][] = [
    ['2026-01-31', 12, 'BULAN'],
    ['2026-08-31', 6, 'BULAN'],
    ['2026-12-31', 3, 'BULAN'],
    ['2026-01-30', 12, 'BULAN'],
    ['2026-02-28', 24, 'BULAN'],
  ];

  test.each(KASUS)('akad %s tenor %i %s — header cocok dengan jadwal terakhir', async (tanggal, tenor, satuan) => {
    const pinjamanId = await buatPinjaman(tanggal, tenor, satuan);

    const detail = await getPinjamanDetail(pinjamanId);
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const jadwalCurrent = jadwal.filter((j) => isCurrentRepaymentSchedule(j.status));
    const maxJadwal = jadwalCurrent
      .map((j) => j.tanggalJatuhTempo)
      .sort()
      .at(-1);

    expect(jadwalCurrent.length).toBe(tenor);
    expect(detail!.tanggalJatuhTempo).toBe(maxJadwal);
  });

  test('akad 31 Jan: jadwal tidak terjebak di tanggal 28', async () => {
    const pinjamanId = await buatPinjaman('2026-01-31', 12, 'BULAN');
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const tanggalTanggal = jadwal.map((j) => j.tanggalJatuhTempo);

    expect(tanggalTanggal[0]).toBe('2026-02-28');
    // Inti bug: sebelum perbaikan, angsuran ke-2 menjadi 2026-03-28.
    expect(tanggalTanggal[1]).toBe('2026-03-31');
    expect(tanggalTanggal[11]).toBe('2027-01-31');
  });

  test('setelah akad ulang, header tetap cocok dengan jadwal CURRENT (bukan jadwal lama)', async () => {
    const pinjamanId = await buatPinjaman('2026-01-31', 12, 'BULAN');
    await cairkanPinjaman({
      pinjamanId,
      sumberDana: 'KAS',
      approvedBy: 'user-1',
      tanggalPencairan: '2026-01-31',
    });
    await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-03-31',
      tenorBaru: 6,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });

    const detail = await getPinjamanDetail(pinjamanId);
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const current = jadwal.filter((j) => isCurrentRepaymentSchedule(j.status));
    const maxCurrent = current.map((j) => j.tanggalJatuhTempo).sort().at(-1);

    expect(current.length).toBe(6);
    expect(detail!.tanggalJatuhTempo).toBe(maxCurrent);
    expect(maxCurrent).toBe('2026-09-30');

    // Jadwal obsolete punya tanggal yang LEBIH JAUH (2027-01-31) —
    // header tidak boleh mengikutinya.
    const maxSemua = jadwal.map((j) => j.tanggalJatuhTempo).sort().at(-1);
    expect(maxSemua).toBe('2027-01-31');
    expect(detail!.tanggalJatuhTempo).not.toBe(maxSemua);
  });
});

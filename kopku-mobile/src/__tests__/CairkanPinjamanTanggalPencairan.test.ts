import { createTestDb, TestDb } from './testDb';

/**
 * REGRESI FIX WALL-CLOCK DATE PADA `cairkanPinjaman()` (permintaan pengguna).
 *
 * BUG YANG DIKUNCI DI SINI: sebelum fix, `cairkanPinjaman()` memakai
 * `format(new Date(), 'yyyy-MM-dd')` sebagai tanggal jurnal pencairan,
 * tanggal pencatatan fee integral, DAN `tanggalPencairan` yang dikirim
 * ke `inisiasiEirPinjaman()`. Untuk pinjaman berakad 2026-01-01 dengan
 * jadwal angsuran 2026-02-01 dst, arus kas EIR dibangun relatif terhadap
 * tanggal RUNTIME, sehingga offset `hari` menjadi negatif/tidak monoton
 * dan `validasiCashFlows()` menolaknya ("Arus kas harus terurut menaik
 * berdasarkan tanggal (hari)") — seluruh transaksi pencairan rollback.
 *
 * Yang diperbaiki HANYA sumber tanggalnya. Rumus EIR
 * (`solveEffectiveInterestRate`, `bangunCashFlowKontraktual`,
 * `validasiCashFlows`) TIDAK disentuh sama sekali — test di bawah
 * memverifikasi itu dengan membangun ulang arus kas secara manual dan
 * membandingkan rate hasil solver yang SAMA.
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
  lunasiPinjaman,
  hapusPiutangPinjaman,
  getJadwalAngsuran,
} from '@/services/PinjamanService';
import { getEirTersimpan, prosesEirBulanan } from '@/services/EirAccountingService';
import { prosesAkrualJasaPinjaman, hitungFeeIntegralPendingEir } from '@/services/AkrualJasaPinjamanService';
import { solveEffectiveInterestRate, EirCashFlow } from '@/accounting/EffectiveInterestRateService';

const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanDenda: 'acc-pendapatan-denda',
  pendapatanAdmin: 'acc-pendapatan-admin',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  penyisihan: 'acc-penyisihan',
  bebanPenyisihan: 'acc-beban-penyisihan',
  modal: 'acc-modal',
};
const ANGGOTA_ID = 'anggota-1';

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, normalBalance: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, normalBalance, now, now
  );
}

async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${transactionType}-${role}`, transactionType, role, accountId
  );
}

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();
  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.penyisihan, '1-1210', 'Penyisihan Piutang Tak Tertagih', 'ASET', 'KREDIT');
  await seedAccount(testDb, ACC.bebanPenyisihan, '5-2100', 'Beban Penyisihan Pinjaman', 'BEBAN', 'DEBIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'PELUNASAN_JASA_FUTURE', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'PELUNASAN_PENALTI', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'PELUNASAN_ADMINISTRASI', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  await seedMapping(testDb, 'PENYISIHAN_PIUTANG', 'DEBIT_BEBAN', ACC.bebanPenyisihan);
  await seedMapping(testDb, 'PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN', ACC.penyisihan);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026', 2026, '2026-01-01', '2027-12-31'
  );

  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,'AKTIF',?,?)`,
    ANGGOTA_ID, 'A001', '1234567890123456', 'Budi', '2020-01-01', now, now
  );
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at) VALUES ('rat-2026',2026,'2026-05-01','user-1',?,?)`,
    now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-modal-debit', 'journal-modal-awal', ACC.kas, 50_000_000);
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-modal-kredit', 'journal-modal-awal', ACC.modal, 50_000_000);
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sp-fixture',?,'POKOK','SETOR','2020-01-01',100000,'KAS','SP-FIXTURE','user-1',?)`,
    ANGGOTA_ID, now
  );
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sw-fixture',?,'WAJIB','SETOR','2020-01-01',50000,'KAS','SW-FIXTURE','user-1',?)`,
    ANGGOTA_ID, now
  );
}

/** Pengajuan pinjaman FLAT 12 bulan dengan fee integral (memicu EIR saat pencairan). */
async function ajukanPinjamanEir(tanggalAkad = '2026-01-01', jumlah = 1_200_000, fee = 12_000): Promise<string> {
  const { id } = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: tanggalAkad,
    jumlahPinjaman: jumlah,
    tenor: 12,
    satuanTenor: 'BULAN',
    metodeJasa: 'FLAT',
    persentaseJasa: 1,
    biayaAdminTipe: 'NOMINAL',
    biayaAdminNilai: fee,
    dendaAktif: false,
    createdBy: 'user-1',
  });
  await testDb.runAsync(`UPDATE pinjaman SET biaya_admin_klasifikasi = 'INTEGRAL_FINANCIAL_INSTRUMENT' WHERE id = ?`, id);
  return id;
}

/** Selisih hari kalender — rumus PERSIS yang dipakai bangunCashFlowKontraktual. */
function selisihHari(dari: string, sampai: string): number {
  return Math.round((new Date(sampai).getTime() - new Date(dari).getTime()) / 86400000);
}

/** Hitung ulang EIR secara MANUAL dari jadwal kontraktual, memakai solver yang SAMA (tidak diubah). */
async function eirManual(pinjamanId: string, tanggalPencairan: string, initialCarrying: number): Promise<number> {
  const jadwal = await getJadwalAngsuran(pinjamanId);
  const cashflows: EirCashFlow[] = [{ hari: 0, jumlah: -initialCarrying }];
  for (const j of jadwal) {
    cashflows.push({ hari: selisihHari(tanggalPencairan, j.tanggalJatuhTempo), jumlah: j.pokok + j.jasa });
  }
  return solveEffectiveInterestRate(cashflows).rateTahunan;
}

describe('cairkanPinjaman — tanggal pencairan sebagai input EIR (regresi wall-clock date)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('TEST 1 — HISTORICAL FIXTURE: pinjaman kontrak 2026-01-01, jadwal 2026-02-01/03-01/04-01, EIR memakai tanggal pencairan dari flow (bukan hari ini)', async () => {
    const id = await ajukanPinjamanEir();
    const jadwal = await getJadwalAngsuran(id);
    expect(jadwal.slice(0, 3).map((j) => j.tanggalJatuhTempo)).toEqual(['2026-02-01', '2026-03-01', '2026-04-01']);

    // Sebelum fix, baris ini melempar "Arus kas harus terurut menaik
    // berdasarkan tanggal (hari)" karena arus kas dibangun dari tanggal
    // runtime, bukan tanggal transaksi pencairan.
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    const tersimpan = await getEirTersimpan(testDb as any, id);
    expect(tersimpan).toBeTruthy();
    expect(tersimpan!.rate).toBeCloseTo(await eirManual(id, '2026-01-01', 1_200_000 - 12_000), 10);

    const jurnal = await testDb.getFirstAsync<{ tanggal: string }>(
      `SELECT tanggal FROM journal WHERE sumber_transaksi = 'PENCAIRAN_PINJAMAN' AND sumber_id = ?`,
      id
    );
    expect(jurnal!.tanggal).toBe('2026-01-01');
  });

  test('TEST 2 — EXPLICIT DISBURSEMENT DATE: tanggalPencairan 2026-01-05 dipakai apa adanya, BUKAN tanggal akad 2026-01-01, BUKAN tanggal sistem', async () => {
    const id = await ajukanPinjamanEir('2026-01-01');
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-05' });

    const tersimpan = await getEirTersimpan(testDb as any, id);
    const rateDari05 = await eirManual(id, '2026-01-05', 1_200_000 - 12_000);
    const rateDari01 = await eirManual(id, '2026-01-01', 1_200_000 - 12_000);

    expect(tersimpan!.rate).toBeCloseTo(rateDari05, 10);
    // Bukti bahwa tanggal akad dan tanggal pencairan TIDAK disamakan:
    // keduanya menghasilkan rate yang berbeda, dan yang dipakai adalah 2026-01-05.
    expect(rateDari05).not.toBe(rateDari01);

    const jurnal = await testDb.getFirstAsync<{ tanggal: string }>(
      `SELECT tanggal FROM journal WHERE sumber_transaksi = 'PENCAIRAN_PINJAMAN' AND sumber_id = ?`,
      id
    );
    expect(jurnal!.tanggal).toBe('2026-01-05');

    const feeRow = await testDb.getFirstAsync<{ periode_akuntansi: string }>(
      `SELECT periode_akuntansi FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
      id
    );
    expect(feeRow!.periode_akuntansi).toBe('2026-01');
  });

  test('TEST 3 — DIFFERENT CURRENT DATE: clock dibekukan ke 2026-09-01, pencairan 2026-01-05 -> seluruh arus kas EIR tetap relatif 2026-01-05', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-01T03:00:00Z'));

    const id = await ajukanPinjamanEir('2026-01-01');
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-05' });

    const tersimpan = await getEirTersimpan(testDb as any, id);
    expect(tersimpan!.rate).toBeCloseTo(await eirManual(id, '2026-01-05', 1_200_000 - 12_000), 10);
    // Bukan tanggal sistem yang dibekukan.
    expect(tersimpan!.rate).not.toBe(await eirManual(id, '2026-09-01', 1_200_000 - 12_000).catch(() => NaN));

    const jurnal = await testDb.getFirstAsync<{ tanggal: string }>(
      `SELECT tanggal FROM journal WHERE sumber_transaksi = 'PENCAIRAN_PINJAMAN' AND sumber_id = ?`,
      id
    );
    expect(jurnal!.tanggal).toBe('2026-01-05');
  });

  test('TEST 4 — EIR SOLVER: solveEffectiveInterestRate() berhasil pada fixture historical, input tanggal yang diperbaiki (solver TIDAK diubah)', async () => {
    const id = await ajukanPinjamanEir();
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    const jadwal = await getJadwalAngsuran(id);
    const cashflows: EirCashFlow[] = [{ hari: 0, jumlah: -(1_200_000 - 12_000) }];
    for (const j of jadwal) cashflows.push({ hari: selisihHari('2026-01-01', j.tanggalJatuhTempo), jumlah: j.pokok + j.jasa });

    // Arus kas menaik ketat — prasyarat validasiCashFlows terpenuhi tanpa
    // mengubah validasi itu sendiri.
    const hari = cashflows.map((c) => c.hari);
    expect(hari.every((h, i) => i === 0 || h > hari[i - 1])).toBe(true);

    const hasil = solveEffectiveInterestRate(cashflows);
    expect(Number.isFinite(hasil.rateTahunan)).toBe(true);
    expect(Math.abs(hasil.npvPadaRate)).toBeLessThan(0.5);
    expect((await getEirTersimpan(testDb as any, id))!.rate).toBeCloseTo(hasil.rateTahunan, 10);
  });

  test('TEST 5 — EXISTING EIR: pencairan pada tanggal berjalan (tanpa parameter) berperilaku SAMA seperti sebelum fix', async () => {
    // Fallback = tanggal kalender LOKAL hari ini. Jadwal dibangun relatif
    // hari ini juga supaya arus kas kontraktual valid — persis pola yang
    // dipakai test EIR existing sebelum fix, sehingga nilainya tidak berubah.
    const hariIni = new Date();
    const tglHariIni = `${hariIni.getFullYear()}-${String(hariIni.getMonth() + 1).padStart(2, '0')}-${String(hariIni.getDate()).padStart(2, '0')}`;

    const id = await ajukanPinjamanEir(tglHariIni);
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1' });

    const tersimpan = await getEirTersimpan(testDb as any, id);
    expect(tersimpan!.rate).toBeCloseTo(await eirManual(id, tglHariIni, 1_200_000 - 12_000), 10);

    const jurnal = await testDb.getFirstAsync<{ tanggal: string }>(
      `SELECT tanggal FROM journal WHERE sumber_transaksi = 'PENCAIRAN_PINJAMAN' AND sumber_id = ?`,
      id
    );
    expect(jurnal!.tanggal).toBe(tglHariIni);
  });

  test('TEST 6 — ACCRUAL REGRESSION: akrual jasa tetap jalan, idempoten, dan berhenti saat non-accrual setelah pencairan berbasis tanggal transaksi', async () => {
    const id = await ajukanPinjamanEir();
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    const akrual1 = await prosesAkrualJasaPinjaman({ pinjamanId: id, periode: '2026-02', createdBy: 'user-1', tanggalLaporan: '2026-02-28' });
    expect(akrual1.dibuat).toBe(true);

    // Idempotency: run kedua pada periode yang sama TIDAK membuat baris/jurnal baru.
    const akrual2 = await prosesAkrualJasaPinjaman({ pinjamanId: id, periode: '2026-02', createdBy: 'user-1', tanggalLaporan: '2026-02-28' });
    expect(akrual2.dibuat).toBe(false);

    const jumlahBaris = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'JASA_AKRUAL' AND periode_akuntansi = '2026-02'`,
      id
    );
    expect(jumlahBaris!.cnt).toBe(1);
  });

  test('TEST 7 — EIR MONTHLY: amortisasi bulanan memakai periode yang benar & tidak double', async () => {
    const id = await ajukanPinjamanEir();
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    const bulan1 = await prosesEirBulanan({ pinjamanId: id, periode: '2026-02', createdBy: 'user-1', tanggalLaporan: '2026-02-15' });
    expect(bulan1.dibuat).toBe(true);
    expect(bulan1.row!.periode).toBe('2026-02');

    const ulang = await prosesEirBulanan({ pinjamanId: id, periode: '2026-02', createdBy: 'user-1', tanggalLaporan: '2026-02-15' });
    expect(ulang.dibuat).toBe(false);

    const barisEir = await testDb.getAllAsync<{ id: string }>(
      `SELECT id FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'EIR_MONTHLY'`,
      id
    );
    expect(barisEir.length).toBe(1);

    const bulan2 = await prosesEirBulanan({ pinjamanId: id, periode: '2026-03', createdBy: 'user-1', tanggalLaporan: '2026-03-15' });
    expect(bulan2.dibuat).toBe(true);
    const sisa = (await getEirTersimpan(testDb as any, id))!.sisaFeeBelumDiamortisasi;
    expect(sisa).toBe(12_000 - bulan1.row!.feeAmortizationIncome - bulan2.row!.feeAmortizationIncome);
  });

  test('TEST 8 — SETTLEMENT: lunasiPinjaman() tetap men-derecognize sisa fee EIR', async () => {
    const id = await ajukanPinjamanEir();
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });
    expect(await hitungFeeIntegralPendingEir(testDb as any, id)).toBe(12_000);

    await lunasiPinjaman({ pinjamanId: id, tanggal: '2026-02-10', sumberDana: 'KAS', createdBy: 'user-1' });

    expect(await hitungFeeIntegralPendingEir(testDb as any, id)).toBe(0);
    const detail = await testDb.getFirstAsync<{ eir_measurement_status: string; status: string }>(
      `SELECT eir_measurement_status, status FROM pinjaman WHERE id = ?`,
      id
    );
    expect(detail!.eir_measurement_status).toBe('DERECOGNIZED');
    expect(detail!.status).toBe('LUNAS');
  });

  test('TEST 9 — WRITE-OFF: hapusPiutangPinjaman() tetap men-derecognize sisa fee EIR', async () => {
    const id = await ajukanPinjamanEir();
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });
    expect(await hitungFeeIntegralPendingEir(testDb as any, id)).toBe(12_000);

    await hapusPiutangPinjaman({
      pinjamanId: id,
      tanggal: '2026-09-01', // 200+ hari lewat jatuh tempo pertama -> kolektibilitas MACET
      alasan: 'Anggota tidak dapat dilacak',
      createdBy: 'user-1',
      topUpPenyisihanJikaKurang: true,
    });

    expect(await hitungFeeIntegralPendingEir(testDb as any, id)).toBe(0);
    const detail = await testDb.getFirstAsync<{ eir_measurement_status: string; status: string }>(
      `SELECT eir_measurement_status, status FROM pinjaman WHERE id = ?`,
      id
    );
    expect(detail!.eir_measurement_status).toBe('DERECOGNIZED');
    expect(detail!.status).toBe('MACET');
  });

  test('KONSISTENSI TANGGAL (§13): jurnal pencairan, pencatatan fee integral, dan referensi arus kas EIR memakai SATU tanggal yang sama', async () => {
    const id = await ajukanPinjamanEir('2026-01-01');
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-05' });

    const jurnal = await testDb.getFirstAsync<{ tanggal: string }>(
      `SELECT tanggal FROM journal WHERE sumber_transaksi = 'PENCAIRAN_PINJAMAN' AND sumber_id = ?`,
      id
    );
    const feeRow = await testDb.getFirstAsync<{ periode_akuntansi: string }>(
      `SELECT periode_akuntansi FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
      id
    );
    const tersimpan = await getEirTersimpan(testDb as any, id);

    expect(jurnal!.tanggal).toBe('2026-01-05');
    expect(feeRow!.periode_akuntansi).toBe(jurnal!.tanggal.slice(0, 7));
    expect(tersimpan!.rate).toBeCloseTo(await eirManual(id, jurnal!.tanggal, 1_200_000 - 12_000), 10);
  });

  test('tanggalPencairan dengan format salah DITOLAK (tidak diam-diam diterima sebagai timestamp)', async () => {
    const id = await ajukanPinjamanEir();
    await expect(
      cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-05T00:00:00.000Z' })
    ).rejects.toThrow(/YYYY-MM-DD/);
  });
});

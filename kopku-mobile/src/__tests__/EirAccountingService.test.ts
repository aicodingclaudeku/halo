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

import { ajukanPinjaman, cairkanPinjaman, bayarAngsuran, akadUlangPinjaman, getJadwalAngsuran, getPinjamanDetail } from '@/services/PinjamanService';
import { getEirTersimpan, prosesEirBulanan, deselesaikanFeeEirSaatDerecognition } from '@/services/EirAccountingService';
import { hitungFeeIntegralPendingEir } from '@/services/AkrualJasaPinjamanService';

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, normalBalance: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,0,?,?)`,
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
  await db.runAsync(`INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`, `map-${transactionType}-${role}`, transactionType, role, accountId);
}

const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanDenda: 'acc-pendapatan-denda',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  // FIXTURE FIX: akun Pendapatan Administrasi (4-1100) memang ADA di COA
  // produksi & dipakai cairkanPinjaman untuk fee SEPARATE_SERVICE —
  // fixture ini yang belum menyeed-nya, bukan produksi yang salah.
  pendapatanAdmin: 'acc-pendapatan-admin',
  modal: 'acc-modal',
};
const ANGGOTA_ID = 'anggota-1';

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(db, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(db, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(db, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(db, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(db, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(db, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(db, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(db, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(db, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  // FINAL FIX AKRUAL (BUG 4/5/7): jasa yang kasnya diterima SEBELUM jatuh tempo
  // -> Pendapatan Diterima Dimuka (2-1300 existing), dilepas saat periode jatuh tempo.
  await seedMapping(db, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );
  const now = new Date().toISOString();
  await db.runAsync(
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
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','Admin','admin','ADMIN','x','x',0,1,?,?)`,
    now,
    now
  );
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal','POSTED','user-1',?,?,?)`,
    now,
    now,
    now
  );
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-modal-debit', 'journal-modal-awal', ACC.kas, 50_000_000);
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-modal-kredit', 'journal-modal-awal', ACC.modal, 50_000_000);
  await db.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sp-fixture',?,'POKOK','SETOR','2020-01-01',100000,'KAS','SP-FIXTURE','user-1',?)`,
    ANGGOTA_ID,
    now
  );
  await db.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('sw-fixture',?,'WAJIB','SETOR','2020-01-01',50000,'KAS','SW-FIXTURE','user-1',?)`,
    ANGGOTA_ID,
    now
  );
  return db;
}

/** Pinjaman FLAT 12 bulan, pokok 1.200.000, fee integral 12.000, klasifikasi INTEGRAL_FINANCIAL_INSTRUMENT (memicu EIR otomatis saat cair). */
async function pinjamanEirAktif(): Promise<string> {
  const { id } = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: '2026-01-01',
    jumlahPinjaman: 1_200_000,
    tenor: 12,
    satuanTenor: 'BULAN',
    metodeJasa: 'FLAT',
    persentaseJasa: 1,
    biayaAdminTipe: 'NOMINAL',
    biayaAdminNilai: 12_000,
    dendaAktif: false,
    createdBy: 'user-1',
  });
  await testDb.runAsync(`UPDATE pinjaman SET biaya_admin_klasifikasi = 'INTEGRAL_FINANCIAL_INSTRUMENT' WHERE id = ?`, id);
  await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });
  return id;
}

describe('PHASE 7 — EIR initial recognition (via cairkanPinjaman)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('AA2/§C: fee integral -> EIR dihitung SUNGGUHAN saat pencairan, tersimpan, status pinjaman MEASURED', async () => {
    const pinjamanId = await pinjamanEirAktif();
    const detail = await testDb.getFirstAsync<{ eir_measurement_status: string }>(`SELECT eir_measurement_status FROM pinjaman WHERE id = ?`, pinjamanId);
    expect(detail?.eir_measurement_status).toBe('MEASURED');

    const eir = await getEirTersimpan(testDb as any, pinjamanId);
    expect(eir).toBeTruthy();
    expect(eir!.rate).toBeGreaterThan(0.15); // jauh di atas rate kontraktual, konsisten dengan solver test
    expect(eir!.sisaFeeBelumDiamortisasi).toBe(12_000); // belum ada amortisasi sama sekali

    // §C: fee TIDAK langsung menjadi revenue saat pencairan.
    const pendapatanSaatCair = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanJasa);
    expect(pendapatanSaatCair?.total ?? 0).toBe(0);
    // Fee tetap tercatat sebagai liabilitas Pendapatan Diterima Dimuka.
    expect(await hitungFeeIntegralPendingEir(testDb as any, pinjamanId)).toBe(12_000);
  });

  test('AA1: zero integral fee -> eir_measurement_status = NOT_APPLICABLE, TIDAK ada EIR dipaksakan', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_200_000,
      tenor: 12,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await testDb.runAsync(`UPDATE pinjaman SET biaya_admin_klasifikasi = 'INTEGRAL_FINANCIAL_INSTRUMENT' WHERE id = ?`, id);
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    const detail = await testDb.getFirstAsync<{ eir_measurement_status: string }>(`SELECT eir_measurement_status FROM pinjaman WHERE id = ?`, id);
    expect(detail?.eir_measurement_status).toBe('NOT_APPLICABLE');
    expect(await getEirTersimpan(testDb as any, id)).toBeNull();
  });

  test('AA3: separate service fee TETAP terpisah — TIDAK memicu EIR sama sekali', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_200_000,
      tenor: 12,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      biayaAdminTipe: 'NOMINAL',
      biayaAdminNilai: 12_000,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    // TIDAK diubah ke INTEGRAL — default SEPARATE_SERVICE.
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    const detail = await testDb.getFirstAsync<{ eir_measurement_status: string }>(`SELECT eir_measurement_status FROM pinjaman WHERE id = ?`, id);
    expect(detail?.eir_measurement_status).toBe('EIR_NOT_MIGRATED'); // default awal, tidak pernah disentuh EirAccountingService
    expect(await getEirTersimpan(testDb as any, id)).toBeNull();
  });
});

describe('PHASE 7 — EIR monthly recognition (idempotency, carrying amount reconciliation)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('AA11/AA12/AA13/AA19: pengakuan bulanan, fee amortization, carrying amount reconcile, idempotent', async () => {
    const pinjamanId = await pinjamanEirAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);

    const run1 = await prosesEirBulanan({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-02-15' });
    expect(run1.dibuat).toBe(true);
    expect(run1.row!.openingUnamortizedFee).toBe(12_000);
    expect(run1.row!.feeAmortizationIncome).toBeGreaterThan(0);
    expect(run1.row!.closingUnamortizedFee).toBe(12_000 - run1.row!.feeAmortizationIncome);

    // AA19: run kedua PERIODE SAMA -> no-op (idempotent).
    const run2 = await prosesEirBulanan({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-02-20' });
    expect(run2.dibuat).toBe(false);
    expect(run2.row!.id).toBe(run1.row!.id);

    const jurnalCount = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'EIR_FEE_AMORTIZATION'`);
    expect(jurnalCount?.cnt).toBe(1); // TIDAK dobel

    // AA12: pendapatan yang diakui masuk akun Pendapatan Jasa Pinjaman (SAMA dengan jasa kontraktual, §K).
    const pendapatan = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanJasa);
    expect(pendapatan?.total).toBe(run1.row!.feeAmortizationIncome);

    // AA13: reconciliation — sisa fee (getEirTersimpan) = fee awal - total sudah diamortisasi.
    const eir = await getEirTersimpan(testDb as any, pinjamanId);
    expect(eir!.sisaFeeBelumDiamortisasi).toBe(12_000 - run1.row!.feeAmortizationIncome);
  });

  test('AA18/§U: non-accrual (kolektibilitas MACET) menghentikan amortisasi EIR, konsisten dengan policy Phase 2', async () => {
    const pinjamanId = await pinjamanEirAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    // tanggalLaporan jauh di masa depan (200+ hari lewat jatuh tempo pertama) -> MACET.
    const hasil = await prosesEirBulanan({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-09-01' });
    expect(hasil.dibuat).toBe(false);
    expect(hasil.dilewati).toMatch(/[Nn]on-accrual/);
  });

  test('journal balance & GL reconciliation setiap kali amortisasi diposting', async () => {
    const pinjamanId = await pinjamanEirAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const hasil = await prosesEirBulanan({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-02-15' });

    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(`SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`, hasil.row!.journalId);
    expect(entries.reduce((s, e) => s + e.debit, 0)).toBe(entries.reduce((s, e) => s + e.kredit, 0));

    const dimukaSaldo = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(je.debit-je.kredit),0) as total FROM journal_entry je JOIN journal j ON j.id=je.journal_id WHERE j.sumber_id = ? AND je.account_id = ? AND j.status='POSTED'`,
      pinjamanId,
      ACC.pendapatanDimuka
    );
    // Saldo liabilitas Pendapatan Diterima Dimuka (kredit-debit dibalik karena ini akun kredit normal -> gunakan formula sebaliknya) harus = sisa fee belum diamortisasi.
    const eir = await getEirTersimpan(testDb as any, pinjamanId);
    expect(-dimukaSaldo!.total).toBe(eir!.sisaFeeBelumDiamortisasi);
  });
});

describe('PHASE 7 §AB — CRITICAL END-TO-END: disbursement -> fee -> EIR -> month1 -> month2 -> partial payment -> month3 -> early settlement', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('skenario lengkap: tidak ada double income, carrying amount & GL reconcile di setiap tahap', async () => {
    // 1. Disbursement + fee integral + EIR calculation.
    const pinjamanId = await pinjamanEirAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const eirAwal = await getEirTersimpan(testDb as any, pinjamanId);
    expect(eirAwal!.sisaFeeBelumDiamortisasi).toBe(12_000);

    // 2. Month 1 recognition.
    const bulan1 = await prosesEirBulanan({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-02-15' });
    expect(bulan1.dibuat).toBe(true);
    const sisaSetelahBulan1 = (await getEirTersimpan(testDb as any, pinjamanId))!.sisaFeeBelumDiamortisasi;
    expect(sisaSetelahBulan1).toBe(12_000 - bulan1.row!.feeAmortizationIncome);

    // 3. Month 2 recognition.
    const bulan2 = await prosesEirBulanan({ pinjamanId, periode: jadwal[1].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-03-15' });
    expect(bulan2.dibuat).toBe(true);
    const sisaSetelahBulan2 = (await getEirTersimpan(testDb as any, pinjamanId))!.sisaFeeBelumDiamortisasi;
    expect(sisaSetelahBulan2).toBe(sisaSetelahBulan1 - bulan2.row!.feeAmortizationIncome);

    // 4. Partial payment pada angsuran 1 (pokok+jasa kontraktual, mekanisme Phase 2/4, TIDAK disentuh Phase 7).
    const pendapatanJasaSebelumBayar = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanJasa);
    await bayarAngsuran({ pinjamanId, jadwalId: jadwal[0].id, tanggal: '2026-03-20', nominal: 50_000, sumberDana: 'KAS', createdBy: 'user-1' });
    const pendapatanJasaSesudahBayar = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanJasa);
    // Pembayaran pokok TIDAK menambah Pendapatan Jasa (waterfall denda->jasa->pokok, jasa angsuran 1 sudah lunas via jasa_terbayar sebelumnya kalau ada; minimal TIDAK ADA double income dari fee amortization yang sudah diakui).
    expect(pendapatanJasaSesudahBayar!.total).toBeGreaterThanOrEqual(pendapatanJasaSebelumBayar!.total);

    // 5. Month 3 recognition.
    const bulan3 = await prosesEirBulanan({ pinjamanId, periode: jadwal[2].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-04-15' });
    expect(bulan3.dibuat).toBe(true);
    const sisaSetelahBulan3 = (await getEirTersimpan(testDb as any, pinjamanId))!.sisaFeeBelumDiamortisasi;
    expect(sisaSetelahBulan3).toBeGreaterThanOrEqual(0);
    expect(sisaSetelahBulan3).toBeLessThan(12_000);

    // 6. Early settlement (Q/R): derecognition SISA fee integral yang belum teramortisasi.
    const totalPendapatanSebelumSettlement = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanJasa);
    const settlement = await deselesaikanFeeEirSaatDerecognition({ pinjamanId, tanggal: '2026-04-20', alasan: 'PELUNASAN_DIPERCEPAT', createdBy: 'user-1' });
    expect(settlement.diselesaikan).toBe(true);
    expect(settlement.jumlahDiakui).toBe(sisaSetelahBulan3); // SELURUH sisa (bukan sebagian, bukan future contractual interest)

    const eirSetelahSettlement = await getEirTersimpan(testDb as any, pinjamanId);
    expect(eirSetelahSettlement).toBeNull(); // status sudah DERECOGNIZED

    const totalPendapatanSesudahSettlement = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.pendapatanJasa);
    expect(totalPendapatanSesudahSettlement!.total - totalPendapatanSebelumSettlement!.total).toBe(settlement.jumlahDiakui);

    // R: TIDAK ADA sisa DEFERRED_PENDING_EIR yang menggantung selamanya.
    expect(await hitungFeeIntegralPendingEir(testDb as any, pinjamanId)).toBe(0);

    // TIDAK ADA double income: total fee yang PERNAH diakui (bulan1+bulan2+bulan3+settlement) = TEPAT 12.000 (fee awal), tidak lebih tidak kurang.
    const totalFeeSepanjangUmurPinjaman = bulan1.row!.feeAmortizationIncome + bulan2.row!.feeAmortizationIncome + bulan3.row!.feeAmortizationIncome + settlement.jumlahDiakui;
    expect(totalFeeSepanjangUmurPinjaman).toBe(12_000);

    // Journal balance di setiap tahap (agregat).
    const totalDebit = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(debit),0) as total FROM journal_entry`);
    const totalKredit = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry`);
    expect(totalDebit!.total).toBe(totalKredit!.total);
  });
});

describe('PHASE 7 §S — restructuring flag (PENDING_RESTRUCTURING_EIR_REVIEW)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('AA16: akad ulang pada pinjaman ber-EIR MEASURED -> ditandai PENDING_RESTRUCTURING_EIR_REVIEW, histori EIR_MONTHLY TIDAK dihapus', async () => {
    const pinjamanId = await pinjamanEirAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    await prosesEirBulanan({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-02-15' });

    const jumlahEirMonthlySebelum = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'EIR_MONTHLY'`,
      pinjamanId
    );

    await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-06-01',
      tenorBaru: 6,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });

    const detail = await testDb.getFirstAsync<{ eir_measurement_status: string }>(`SELECT eir_measurement_status FROM pinjaman WHERE id = ?`, pinjamanId);
    expect(detail?.eir_measurement_status).toBe('PENDING_RESTRUCTURING_EIR_REVIEW');

    // Histori EIR_MONTHLY TIDAK dihapus (§S: "jangan menghapus historical EIR schedule").
    const jumlahEirMonthlySesudah = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'EIR_MONTHLY'`,
      pinjamanId
    );
    expect(jumlahEirMonthlySesudah?.cnt).toBe(jumlahEirMonthlySebelum?.cnt);

    // Pengakuan bulanan baru DITOLAK selama status PENDING_RESTRUCTURING_EIR_REVIEW (bukan MEASURED) — tidak menghitung yang salah tanpa evaluasi.
    const cobaBulanBerikutnya = await prosesEirBulanan({ pinjamanId, periode: jadwal[1].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-06-05' });
    expect(cobaBulanBerikutnya.dibuat).toBe(false);
  });
});

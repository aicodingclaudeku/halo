import { createTestDb, TestDb } from './testDb';

/**
 * PHASE 2 — Akrual Jasa/Bunga Pinjaman. Teknik mock SAMA PERSIS dengan
 * PenyusutanService.test.ts/PinjamanService.test.ts (lihat komentar di
 * sana) — SQLite sungguhan (sql.js) lewat testDb, bukan mock data.
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
  prosesAkrualJasaPinjaman,
  jalankanAkrualJasaPeriode,
  jalankanAkrualJasaOtomatisJikaPerlu,
  getStatusAkrualJasaPeriode,
  hitungOutstandingPiutangJasa,
  hitungFeeIntegralPendingEir,
} from '@/services/AkrualJasaPinjamanService';
import {
  getNonAccrualMinKolektibilitas,
  setNonAccrualMinKolektibilitas,
  kolektibilitasMencapaiBoundary,
  getNonAccrualMinHariTunggakan,
  setNonAccrualMinHariTunggakan,
} from '@/services/AccountingPolicyService';
import { ajukanPinjaman, cairkanPinjaman, bayarAngsuran, lunasiPinjaman, getJadwalAngsuran, hitungTotalPelunasan } from '@/services/PinjamanService';

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, normalBalance: 'DEBIT' | 'KREDIT') {
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
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  // FINAL FIX AKRUAL (BUG 4/5/7): jasa yang kasnya diterima SEBELUM jatuh tempo
  // -> Pendapatan Diterima Dimuka (2-1300 existing), dilepas saat periode jatuh tempo.
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
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

  // Modal awal kas (liquidity check cairkanPinjaman).
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal (fixture test)','POSTED','user-1',?,?,?)`,
    now,
    now,
    now
  );
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-modal-debit', 'journal-modal-awal', ACC.kas, 50_000_000);
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-modal-kredit', 'journal-modal-awal', ACC.modal, 50_000_000);

  // Eligibility: simpanan pokok/wajib.
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

/** Ajukan + cairkan pinjaman FLAT 12 bulan, jasa 100.000/bulan, angsuran ke-1 jatuh tempo 2026-02-01. */
async function pinjamanAktif12Bulan(jumlahPinjaman = 1_200_000): Promise<string> {
  const { id } = await ajukanPinjaman({
    anggotaId: ANGGOTA_ID,
    tanggal: '2026-01-01',
    jumlahPinjaman,
    tenor: 12,
    satuanTenor: 'BULAN',
    metodeJasa: 'FLAT',
    persentaseJasa: 1,
    biayaAdminTipe: 'TIDAK_ADA',
    biayaAdminNilai: 0,
    dendaAktif: false,
    createdBy: 'user-1',
  });
  await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });
  return id;
}

describe('AkrualJasaPinjamanService — Phase 2', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  // ---- A/B/C: accrual bulan 1, bulan 2, future TIDAK diakui ----
  test('A/B: akrual jasa bulan 1 lalu bulan 2 — masing-masing HANYA jasa periode itu, bukan seluruh tenor', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const periodeBulan1 = jadwal[0].tanggalJatuhTempo.slice(0, 7); // '2026-02'
    const periodeBulan2 = jadwal[1].tanggalJatuhTempo.slice(0, 7); // '2026-03'

    const hasil1 = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: periodeBulan1,
      createdBy: 'user-1',
      tanggalLaporan: '2026-02-28',
    });
    expect(hasil1.dibuat).toBe(true);
    expect(hasil1.row?.jumlahJasa).toBe(jadwal[0].jasa); // hanya jasa bulan 1

    let outstanding = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
    expect(outstanding).toBe(jadwal[0].jasa); // BUKAN total 12 bulan

    const hasil2 = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: periodeBulan2,
      createdBy: 'user-1',
      tanggalLaporan: '2026-03-31',
    });
    expect(hasil2.dibuat).toBe(true);
    expect(hasil2.row?.jumlahJasa).toBe(jadwal[1].jasa);

    outstanding = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
    expect(outstanding).toBe(jadwal[0].jasa + jadwal[1].jasa); // 2 bulan, bukan 12
  });

  test('C: periode masa depan (relatif tanggalLaporan) TIDAK diakui — ditolak eksplisit', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const periodeBulan6 = jadwal[5].tanggalJatuhTempo.slice(0, 7);

    // tanggalLaporan MASIH bulan 1 — periode bulan 6 belum berjalan.
    const hasil = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: periodeBulan6,
      createdBy: 'user-1',
      tanggalLaporan: '2026-01-15',
    });
    expect(hasil.dibuat).toBe(false);
    expect(hasil.dilewati).toMatch(/belum berjalan/);

    const outstanding = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
    expect(outstanding).toBe(0); // tidak ada apa pun yang diakui di muka
  });

  // ---- D: idempotency — run kedua tidak membuat jurnal baru ----
  test('D: menjalankan akrual periode yang sama dua kali TIDAK membuat jurnal kedua', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const periode = jadwal[0].tanggalJatuhTempo.slice(0, 7);

    const run1 = await prosesAkrualJasaPinjaman({ pinjamanId, periode, createdBy: 'user-1', tanggalLaporan: '2026-02-28' });
    const run2 = await prosesAkrualJasaPinjaman({ pinjamanId, periode, createdBy: 'user-1', tanggalLaporan: '2026-02-28' });

    expect(run1.dibuat).toBe(true);
    expect(run2.dibuat).toBe(false);
    expect(run2.row?.id).toBe(run1.row?.id);

    const jumlahJurnal = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'AKRUAL_JASA_PINJAMAN' AND sumber_id = ?`,
      pinjamanId
    );
    expect(jumlahJurnal?.cnt).toBe(1);

    const outstanding = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
    expect(outstanding).toBe(jadwal[0].jasa); // TIDAK dobel
  });

  // ---- E/F/G: partial/full payment SETELAH akrual — Piutang Jasa berkurang, Pendapatan Jasa TIDAK diakui ulang ----
  test('E/F/G: pembayaran jasa setelah akrual mengurangi Piutang Jasa (BUKAN mengakui ulang Pendapatan Jasa)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const periode = jadwal[0].tanggalJatuhTempo.slice(0, 7);
    await prosesAkrualJasaPinjaman({ pinjamanId, periode, createdBy: 'user-1', tanggalLaporan: '2026-02-28' });

    const pendapatanJasaSebelumBayar = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.pendapatanJasa
    );

    await bayarAngsuran({
      pinjamanId,
      jadwalId: jadwal[0].id,
      tanggal: '2026-02-28',
      nominal: jadwal[0].total, // pokok + jasa penuh
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const pendapatanJasaSetelahBayar = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.pendapatanJasa
    );
    // Pendapatan Jasa TIDAK bertambah lagi saat bayar (sudah diakui saat akrual) — no double count.
    expect(pendapatanJasaSetelahBayar?.total).toBe(pendapatanJasaSebelumBayar?.total);

    const outstanding = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
    expect(outstanding).toBe(0); // Piutang Jasa lunas

    const kreditPiutangJasa = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.piutangJasa
    );
    expect(kreditPiutangJasa?.total).toBe(jadwal[0].jasa); // Piutang Jasa dikredit sebesar jasa yang dibayar
  });

  // ---- H: pembayaran SEBELUM akrual — tetap diakui langsung ke Pendapatan Jasa (perilaku pre-Phase-2, TIDAK ada income hilang) ----
  test('H: pembayaran jasa SEBELUM akrual dijalankan tetap diakui langsung ke Pendapatan Jasa', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);

    // TIDAK ada prosesAkrualJasaPinjaman() dipanggil sama sekali.
    await bayarAngsuran({
      pinjamanId,
      jadwalId: jadwal[0].id,
      tanggal: '2026-02-01',
      nominal: jadwal[0].total,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const pendapatanJasa = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.pendapatanJasa
    );
    expect(pendapatanJasa?.total).toBe(jadwal[0].jasa); // diakui langsung, seperti sebelum Phase 2

    const kreditPiutangJasa = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.piutangJasa
    );
    expect(kreditPiutangJasa?.total ?? 0).toBe(0); // tidak ada Piutang Jasa yang disentuh (belum pernah diakui)

    const outstanding = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
    expect(outstanding).toBe(0);
  });

  // ---- Partial payment across accrued portion ----
  test('pembayaran SEBAGIAN atas jasa yang sudah diakru mengurangi Piutang Jasa sesuai porsi, sisanya tetap outstanding', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const periode1 = jadwal[0].tanggalJatuhTempo.slice(0, 7);
    const periode2 = jadwal[1].tanggalJatuhTempo.slice(0, 7);
    await prosesAkrualJasaPinjaman({ pinjamanId, periode: periode1, createdBy: 'user-1', tanggalLaporan: '2026-02-28' });
    await prosesAkrualJasaPinjaman({ pinjamanId, periode: periode2, createdBy: 'user-1', tanggalLaporan: '2026-03-31' });

    const totalAkru = jadwal[0].jasa + jadwal[1].jasa;
    expect(await hitungOutstandingPiutangJasa(testDb as any, pinjamanId)).toBe(totalAkru);

    // KOREKSI: bayarAngsuran() beroperasi pada SATU baris jadwal — porsi
    // jasa yang bisa dibayar di sini dibatasi oleh sisa jasa jadwal[0]
    // SENDIRI (bukan seluruh akumulasi Piutang Jasa lintas periode).
    // Bayar PERSIS sejumlah jasa jadwal[0] (waterfall denda->jasa->pokok,
    // denda 0) supaya seluruhnya masuk porsi jasa, sisa pokok tidak ikut.
    await bayarAngsuran({
      pinjamanId,
      jadwalId: jadwal[0].id,
      tanggal: '2026-04-01',
      nominal: jadwal[0].jasa,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const outstandingSetelah = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
    // Hanya jasa jadwal[0] yang lunas (porsi jasa dari periode 2 TETAP
    // outstanding — pembayaran ini menyasar jadwal[0] saja).
    expect(outstandingSetelah).toBe(totalAkru - jadwal[0].jasa);
    expect(outstandingSetelah).toBe(jadwal[1].jasa);
  });

  // ---- J: non-accrual untuk kolektibilitas DIRAGUKAN/MACET ----
  test('J: pinjaman berkolektibilitas MACET (tunggakan jauh lewat jatuh tempo) TIDAK diakrualkan', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const periode = jadwal[0].tanggalJatuhTempo.slice(0, 7); // periode 2026-02

    // tanggalLaporan jauh di masa depan (200+ hari setelah jatuh tempo) -> kolektibilitas MACET.
    const status = await getStatusAkrualJasaPeriode(periode, { tanggalLaporan: '2026-09-01' });
    const item = status.find((s) => s.pinjamanId === pinjamanId);
    expect(item?.kolektibilitas).toBe('MACET');
    expect(item?.status).toBe('NON_ACCRUAL');

    const hasil = await prosesAkrualJasaPinjaman({ pinjamanId, periode, createdBy: 'user-1', tanggalLaporan: '2026-09-01' });
    expect(hasil.dibuat).toBe(false);
    expect(hasil.dilewati).toMatch(/Non-accrual/);
    expect(await hitungOutstandingPiutangJasa(testDb as any, pinjamanId)).toBe(0);
  });

  // ---- Q: reconciliation invariant ----
  test('Q: reconciliation — Piutang Jasa GL = jasa diakui - jasa dibayar, konsisten dengan saldo journal_entry', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const periode1 = jadwal[0].tanggalJatuhTempo.slice(0, 7);
    const periode2 = jadwal[1].tanggalJatuhTempo.slice(0, 7);
    await prosesAkrualJasaPinjaman({ pinjamanId, periode: periode1, createdBy: 'user-1', tanggalLaporan: '2026-02-28' });
    await prosesAkrualJasaPinjaman({ pinjamanId, periode: periode2, createdBy: 'user-1', tanggalLaporan: '2026-03-31' });
    await bayarAngsuran({ pinjamanId, jadwalId: jadwal[0].id, tanggal: '2026-04-01', nominal: jadwal[0].total, sumberDana: 'KAS', createdBy: 'user-1' });

    const outstandingFormula = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);

    const debitGL = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.piutangJasa);
    const kreditGL = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.piutangJasa);
    const saldoGL = (debitGL?.total ?? 0) - (kreditGL?.total ?? 0);

    expect(outstandingFormula).toBe(saldoGL); // reconciliation: schedule <-> GL
    expect(outstandingFormula).toBe(jadwal[1].jasa); // hanya jasa bulan 2 tersisa (bulan 1 sudah dibayar lunas)
  });

  // ---- R: closed period ----
  test('R: akrual ditolak pada periode akuntansi yang sudah CLOSED', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const periode = jadwal[0].tanggalJatuhTempo.slice(0, 7);

    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'period-2026'`);

    await expect(
      prosesAkrualJasaPinjaman({ pinjamanId, periode, createdBy: 'user-1', tanggalLaporan: '2026-02-28' })
    ).rejects.toThrow(/ditutup|CLOSED/);

    expect(await hitungOutstandingPiutangJasa(testDb as any, pinjamanId)).toBe(0); // rollback total, tidak ada baris orphan
  });

  // ---- O/P: fee integral vs separate service (cairkanPinjaman hook) ----
  test('O: biaya admin klasifikasi SEPARATE_SERVICE (default) tetap diakui langsung sebagai Pendapatan Administrasi — TIDAK ADA regresi', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_000_000,
      tenor: 12,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      biayaAdminTipe: 'NOMINAL',
      biayaAdminNilai: 50_000,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    const pendapatanAdmin = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.pendapatanAdmin
    );
    const dimuka = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.pendapatanDimuka
    );
    expect(pendapatanAdmin?.total).toBe(50_000);
    expect(dimuka?.total ?? 0).toBe(0);
  });

  test('P: biaya admin klasifikasi INTEGRAL_FINANCIAL_INSTRUMENT TIDAK diakui langsung sebagai pendapatan — dibukukan ke Pendapatan Diterima Dimuka', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_000_000,
      tenor: 12,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      biayaAdminTipe: 'NOMINAL',
      biayaAdminNilai: 50_000,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    // Tandai klasifikasi fee integral secara langsung (hook — belum ada UI Phase 2, §21).
    await testDb.runAsync(`UPDATE pinjaman SET biaya_admin_klasifikasi = 'INTEGRAL_FINANCIAL_INSTRUMENT' WHERE id = ?`, id);

    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    const pendapatanAdmin = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.pendapatanAdmin
    );
    const dimuka = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.pendapatanDimuka
    );
    expect(pendapatanAdmin?.total ?? 0).toBe(0); // TIDAK diakui sebagai pendapatan langsung
    expect(dimuka?.total).toBe(50_000); // dibukukan sebagai liabilitas (belum diakui)

    // Prinsip: aset/kas tetap benar terlepas dari klasifikasi fee.
    const piutangPokok = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.piutangPokok
    );
    expect(piutangPokok?.total).toBe(1_000_000);
  });

  // ---- MENURUN: jasa per periode tidak seragam — pastikan akrual mengambil jasa PER-PERIODE, bukan rata-rata/hardcode ----
  test('MENURUN: jasa antar periode berbeda-beda — akrual tiap periode mengambil angka jasa periode itu sendiri dari angsuran_jadwal', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_200_000,
      tenor: 3,
      satuanTenor: 'BULAN',
      metodeJasa: 'MENURUN',
      persentaseJasa: 2,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });
    const jadwal = await getJadwalAngsuran(id);
    expect(jadwal[0].jasa).not.toBe(jadwal[1].jasa); // MENURUN: jasa mengecil tiap periode (basis outstanding menurun)

    const hasil1 = await prosesAkrualJasaPinjaman({ pinjamanId: id, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-02-28' });
    const hasil2 = await prosesAkrualJasaPinjaman({ pinjamanId: id, periode: jadwal[1].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-03-31' });

    expect(hasil1.row?.jumlahJasa).toBe(jadwal[0].jasa);
    expect(hasil2.row?.jumlahJasa).toBe(jadwal[1].jasa);
    expect(hasil1.row?.jumlahJasa).not.toBe(hasil2.row?.jumlahJasa);
  });

  // ---- batch runner ----
  test('jalankanAkrualJasaPeriode: memproses seluruh pinjaman AKTIF untuk satu periode sekaligus, idempoten', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const periode = jadwal[0].tanggalJatuhTempo.slice(0, 7);

    const run1 = await jalankanAkrualJasaPeriode(periode, 'user-1', { tanggalLaporan: '2026-02-28' });
    expect(run1.diproses.length).toBe(1);
    expect(run1.diproses[0].pinjamanId).toBe(pinjamanId);

    const run2 = await jalankanAkrualJasaPeriode(periode, 'user-1', { tanggalLaporan: '2026-02-28' });
    expect(run2.diproses.length).toBe(0);
    expect(run2.dilewati.some((d) => d.pinjamanId === pinjamanId)).toBe(true);
  });

  // ================================================================
  // PHASE 2 KOREKSI §1 — non-accrual boundary DAPAT DIKONFIGURASI
  // ================================================================
  describe('Koreksi §1 — boundary non-accrual configurable (bukan hardcode SAK EP)', () => {
    test('default boundary adalah DIRAGUKAN, dan DIRAGUKAN/MACET sama-sama non-accrual (perilaku Phase 2 semula tidak berubah tanpa admin mengubah setting)', async () => {
      expect(await getNonAccrualMinKolektibilitas()).toBe('DIRAGUKAN');
      expect(kolektibilitasMencapaiBoundary('DIRAGUKAN', 'DIRAGUKAN')).toBe(true);
      expect(kolektibilitasMencapaiBoundary('MACET', 'DIRAGUKAN')).toBe(true);
      expect(kolektibilitasMencapaiBoundary('KURANG_LANCAR', 'DIRAGUKAN')).toBe(false);
    });

    /**
     * SESI 2 §J — DITULIS ULANG KARENA KEBIJAKANNYA BERUBAH, bukan
     * karena source-nya salah.
     *
     * Versi lama test ini menyatakan boundary non-accrual sebagai
     * KATEGORI KOLEKTIBILITAS (default 'DIRAGUKAN'), sehingga titik
     * non-accrual efektif jatuh di 121 hari. Kebijakan sekarang
     * dinyatakan langsung dalam HARI TUNGGAKAN dengan default 90 hari.
     *
     * MAKSUD test dipertahankan PERSIS: membuktikan bahwa ambang
     * non-accrual adalah SETTING koperasi yang bisa diubah admin, bukan
     * angka baku yang di-hardcode. Yang berubah hanya satuan ambangnya.
     */
    test('admin dapat MENGETATKAN ambang hari — pinjaman yang tadinya boleh akru jadi non-accrual', async () => {
      const pinjamanId = await pinjamanAktif12Bulan();
      const jadwal = await getJadwalAngsuran(pinjamanId);
      const periode = jadwal[0].tanggalJatuhTempo.slice(0, 7);

      // Jatuh tempo pertama 2026-02-01; tanggal laporan 2026-05-15 -> ~103 hari.
      const tanggalLaporanTunggakan = '2026-05-15';

      // Longgarkan dulu ke 150 hari supaya 103 hari masih boleh akru.
      await setNonAccrualMinHariTunggakan(150);
      const statusSebelum = await getStatusAkrualJasaPeriode(periode, { tanggalLaporan: tanggalLaporanTunggakan });
      const itemSebelum = statusSebelum.find((s) => s.pinjamanId === pinjamanId);
      expect(itemSebelum?.status).toBe('SIAP_DIAKUI');

      // Ketatkan ke default kebijakan (90 hari) -> 103 hari jadi non-accrual.
      await setNonAccrualMinHariTunggakan(90);
      expect(await getNonAccrualMinHariTunggakan()).toBe(90);

      const statusSesudah = await getStatusAkrualJasaPeriode(periode, { tanggalLaporan: tanggalLaporanTunggakan });
      const itemSesudah = statusSesudah.find((s) => s.pinjamanId === pinjamanId);
      expect(itemSesudah?.status).toBe('NON_ACCRUAL');

      const hasil = await prosesAkrualJasaPinjaman({ pinjamanId, periode, createdBy: 'user-1', tanggalLaporan: tanggalLaporanTunggakan });
      expect(hasil.dibuat).toBe(false);
      expect(hasil.dilewati).toMatch(/Non-accrual/);
    });

    test('admin dapat MELONGGARKAN ambang hari — pinjaman menunggak panjang jadi boleh diakru (membuktikan ini setting, bukan angka baku)', async () => {
      const pinjamanId = await pinjamanAktif12Bulan();
      const jadwal = await getJadwalAngsuran(pinjamanId);
      const periode = jadwal[0].tanggalJatuhTempo.slice(0, 7);
      const tanggalLaporanDiragukan = '2026-07-01'; // ~150 hari dari 2026-02-01

      // Dengan ambang default (90 hari) ini pasti non-accrual.
      expect(await getNonAccrualMinHariTunggakan()).toBe(90);
      const statusDefault = await getStatusAkrualJasaPeriode(periode, { tanggalLaporan: tanggalLaporanDiragukan });
      expect(statusDefault.find((s) => s.pinjamanId === pinjamanId)?.status).toBe('NON_ACCRUAL');

      // Admin melonggarkan ke 200 hari -> sekarang boleh diakru.
      await setNonAccrualMinHariTunggakan(200);

      const status = await getStatusAkrualJasaPeriode(periode, { tanggalLaporan: tanggalLaporanDiragukan });
      const item = status.find((s) => s.pinjamanId === pinjamanId);
      expect(item?.status).toBe('SIAP_DIAKUI');

      const hasil = await prosesAkrualJasaPinjaman({ pinjamanId, periode, createdBy: 'user-1', tanggalLaporan: tanggalLaporanDiragukan });
      expect(hasil.dibuat).toBe(true);
    });
  });

  // ================================================================
  // PHASE 2 KOREKSI §2 — integral fee dilacak sebagai DEFERRED_PENDING_EIR
  // ================================================================
  describe('Koreksi §2 — integral fee tracking (bukan pendapatan langsung, tidak hilang)', () => {
    async function cairkanDenganFeeIntegral(biayaAdminNilai = 50_000): Promise<string> {
      const { id } = await ajukanPinjaman({
        anggotaId: ANGGOTA_ID,
        tanggal: '2026-01-01',
        jumlahPinjaman: 1_000_000,
        tenor: 12,
        satuanTenor: 'BULAN',
        metodeJasa: 'FLAT',
        persentaseJasa: 1,
        biayaAdminTipe: 'NOMINAL',
        biayaAdminNilai,
        dendaAktif: false,
        createdBy: 'user-1',
      });
      await testDb.runAsync(`UPDATE pinjaman SET biaya_admin_klasifikasi = 'INTEGRAL_FINANCIAL_INSTRUMENT' WHERE id = ?`, id);
      await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });
      return id;
    }

    test('fee integral TIDAK menjadi pendapatan langsung (Pendapatan Administrasi tetap 0)', async () => {
      const id = await cairkanDenganFeeIntegral(50_000);
      const pendapatanAdmin = await testDb.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
        ACC.pendapatanAdmin
      );
      expect(pendapatanAdmin?.total ?? 0).toBe(0);
    });

    test('fee integral tercatat sebagai baris pinjaman_akuntansi_jasa dengan fee_lifecycle_status DEFERRED_PENDING_EIR', async () => {
      const id = await cairkanDenganFeeIntegral(50_000);

      const row = await testDb.getFirstAsync<any>(
        `SELECT * FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'FEE_INTEGRAL_AMORTISASI'`,
        id
      );
      expect(row).toBeTruthy();
      expect(row.fee_lifecycle_status).toBe('DEFERRED_PENDING_EIR');
      expect(row.pendapatan_akuntansi).toBe(0); // BUKAN pendapatan
      expect(row.saldo_akhir_carrying).toBe(50_000); // initial carrying amount untuk Phase EIR
      expect(row.kas_diterima).toBe(50_000); // cash flow tercatat

      const pending = await hitungFeeIntegralPendingEir(testDb as any, id);
      expect(pending).toBe(50_000); // saldo tidak hilang, dapat dilacak sampai Phase EIR
    });

    test('fee integral tidak tercampur dengan JASA_AKRUAL — hitungOutstandingPiutangJasa (jasa) tidak ikut menghitung fee integral', async () => {
      const id = await cairkanDenganFeeIntegral(50_000);
      const outstandingJasa = await hitungOutstandingPiutangJasa(testDb as any, id);
      expect(outstandingJasa).toBe(0); // belum ada akrual jasa sama sekali, fee integral juga tidak ikut terhitung di sini
    });
  });

  // ================================================================
  // BUGFIX P0-1/P0-2/P0-3 — jasa yang SUDAH dibayar/diakui LANGSUNG
  // (sebelum batch akrual periode itu dijalankan) TIDAK BOLEH diakru
  // ulang saat batch akhirnya jalan. Ini skenario yang SEBELUM
  // perbaikan menyebabkan double recognition (angsuran_jadwal.jasa
  // MENTAH dipakai `prosesAkrualJasaPinjaman`, bukan
  // jasa - jasa_terbayar).
  // ================================================================
  describe('BUGFIX P0-1/P0-2/P0-3 — akrual TIDAK dobel setelah pembayaran mendahului batch', () => {
    // TEST 1 (dokumen bug): bayar PENUH sebelum akrual -> batch akrual
    // periode itu TIDAK menambah apa pun.
    test('TEST 1: jasa dibayar PENUH sebelum akrual — batch akrual periode itu tidak menambah pendapatan/piutang jasa apa pun', async () => {
      const pinjamanId = await pinjamanAktif12Bulan();
      const jadwal = await getJadwalAngsuran(pinjamanId);
      const periode1 = jadwal[0].tanggalJatuhTempo.slice(0, 7);

      // Anggota bayar penuh angsuran ke-1 (pokok+jasa) SEBELUM akrual periode 1 dijalankan.
      await bayarAngsuran({
        pinjamanId,
        jadwalId: jadwal[0].id,
        tanggal: '2026-02-01',
        nominal: jadwal[0].total,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      });

      const pendapatanSetelahBayar = await testDb.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
        ACC.pendapatanJasa
      );
      expect(pendapatanSetelahBayar?.total).toBe(jadwal[0].jasa); // diakui langsung, sesuai P0-3/H

      // Batch akrual periode 1 BARU dijalankan SETELAH pembayaran.
      const hasil = await prosesAkrualJasaPinjaman({
        pinjamanId,
        periode: periode1,
        createdBy: 'user-1',
        tanggalLaporan: '2026-02-28',
      });

      // TIDAK ADA journal akrual tambahan — jasa periode ini sudah lunas/diakui semua.
      expect(hasil.dibuat).toBe(false);

      const pendapatanSetelahAkrual = await testDb.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
        ACC.pendapatanJasa
      );
      // Pendapatan Jasa TETAP hanya jadwal[0].jasa — BUKAN dobel jadi 2x.
      expect(pendapatanSetelahAkrual?.total).toBe(jadwal[0].jasa);

      const outstanding = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
      expect(outstanding).toBe(0); // Piutang Jasa = 0, tidak ada baris JASA_AKRUAL yang dibuat

      const jumlahJurnalAkrual = await testDb.getFirstAsync<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'AKRUAL_JASA_PINJAMAN' AND sumber_id = ?`,
        pinjamanId
      );
      expect(jumlahJurnalAkrual?.cnt).toBe(0); // sama sekali tidak ada jurnal AKRUAL_JASA_PINJAMAN untuk periode ini
    });

    // TEST 2 (dokumen bug): bayar SEBAGIAN sebelum akrual -> akrual
    // periode itu hanya mengakui SISANYA, total pendapatan tetap =
    // jasa kontraktual penuh.
    test('TEST 2: jasa dibayar SEBAGIAN sebelum akrual — batch akrual hanya mengakui sisanya, total pendapatan = jasa kontraktual penuh', async () => {
      const pinjamanId = await pinjamanAktif12Bulan();
      const jadwal = await getJadwalAngsuran(pinjamanId);
      const periode1 = jadwal[0].tanggalJatuhTempo.slice(0, 7);
      const jasaPenuh = jadwal[0].jasa;
      const porsiDibayarDuluan = Math.floor(jasaPenuh * 0.4); // simulasi "Rp40.000 dari Rp100.000"
      const sisaSeharusnya = jasaPenuh - porsiDibayarDuluan;

      // Bayar hanya SEBAGIAN dari jasa (bukan seluruh angsuran) —
      // waterfall denda->jasa->pokok, denda 0, jadi seluruh nominal ini masuk porsi jasa.
      await bayarAngsuran({
        pinjamanId,
        jadwalId: jadwal[0].id,
        tanggal: '2026-02-01',
        nominal: porsiDibayarDuluan,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      });

      const pendapatanSetelahBayar = await testDb.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
        ACC.pendapatanJasa
      );
      expect(pendapatanSetelahBayar?.total).toBe(porsiDibayarDuluan);

      const hasilAkrual = await prosesAkrualJasaPinjaman({
        pinjamanId,
        periode: periode1,
        createdBy: 'user-1',
        tanggalLaporan: '2026-02-28',
      });

      expect(hasilAkrual.dibuat).toBe(true);
      expect(hasilAkrual.row?.jumlahJasa).toBe(sisaSeharusnya); // BUKAN jasaPenuh (100.000) — HANYA sisanya (60.000)

      const pendapatanTotal = await testDb.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
        ACC.pendapatanJasa
      );
      expect(pendapatanTotal?.total).toBe(jasaPenuh); // 40.000 + 60.000 = 100.000, bukan 140.000

      const outstanding = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
      expect(outstanding).toBe(sisaSeharusnya); // Piutang Jasa = 60.000, bukan 100.000
    });

    // TEST 3/TEST 4 (dokumen bug): akrual dulu, baru dibayar — pola
    // ini SUDAH benar sebelum perbaikan (lihat test E/F/G & "pembayaran
    // SEBAGIAN..." di atas) — diulang di sini secara eksplisit sebagai
    // regression guard supaya perbaikan P0-1 TIDAK merusak alur ini.
    test('TEST 3/4: akrual dijalankan LEBIH DULU, baru dibayar (penuh & sebagian) — pendapatan tidak pernah dobel', async () => {
      const pinjamanId = await pinjamanAktif12Bulan();
      const jadwal = await getJadwalAngsuran(pinjamanId);
      const periode1 = jadwal[0].tanggalJatuhTempo.slice(0, 7);
      const jasaPenuh = jadwal[0].jasa;

      const hasilAkrual = await prosesAkrualJasaPinjaman({ pinjamanId, periode: periode1, createdBy: 'user-1', tanggalLaporan: '2026-02-28' });
      expect(hasilAkrual.row?.jumlahJasa).toBe(jasaPenuh);
      expect(await hitungOutstandingPiutangJasa(testDb as any, pinjamanId)).toBe(jasaPenuh);

      // Bayar SEBAGIAN (Rp40.000 dari Rp100.000) dari Piutang Jasa yang sudah diakru.
      const porsiBayar = Math.floor(jasaPenuh * 0.4);
      await bayarAngsuran({ pinjamanId, jadwalId: jadwal[0].id, tanggal: '2026-03-01', nominal: porsiBayar, sumberDana: 'KAS', createdBy: 'user-1' });
      expect(await hitungOutstandingPiutangJasa(testDb as any, pinjamanId)).toBe(jasaPenuh - porsiBayar);

      const pendapatanSetelahSebagian = await testDb.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
        ACC.pendapatanJasa
      );
      expect(pendapatanSetelahSebagian?.total).toBe(jasaPenuh); // hanya diakui SEKALI saat akrual, pembayaran tidak menambah lagi

      // Lunasi sisanya.
      await bayarAngsuran({ pinjamanId, jadwalId: jadwal[0].id, tanggal: '2026-03-15', nominal: jasaPenuh - porsiBayar, sumberDana: 'KAS', createdBy: 'user-1' });
      expect(await hitungOutstandingPiutangJasa(testDb as any, pinjamanId)).toBe(0);

      const pendapatanAkhir = await testDb.getFirstAsync<{ total: number }>(
        `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
        ACC.pendapatanJasa
      );
      expect(pendapatanAkhir?.total).toBe(jasaPenuh); // TETAP 100.000, tidak pernah bertambah lagi karena pembayaran
    });

    // TEST 15 (dokumen bug, dipersempit ke skenario P0-1): GL balance —
    // total debit = total kredit setelah rangkaian bayar-sebagian-lalu-akrual.
    test('TEST 15: GL balance tetap seimbang (total debit = total kredit) setelah bayar sebagian lalu akrual', async () => {
      const pinjamanId = await pinjamanAktif12Bulan();
      const jadwal = await getJadwalAngsuran(pinjamanId);
      const periode1 = jadwal[0].tanggalJatuhTempo.slice(0, 7);
      const porsiDibayarDuluan = Math.floor(jadwal[0].jasa * 0.4);

      await bayarAngsuran({ pinjamanId, jadwalId: jadwal[0].id, tanggal: '2026-02-01', nominal: porsiDibayarDuluan, sumberDana: 'KAS', createdBy: 'user-1' });
      await prosesAkrualJasaPinjaman({ pinjamanId, periode: periode1, createdBy: 'user-1', tanggalLaporan: '2026-02-28' });

      const balance = await testDb.getFirstAsync<{ totalDebit: number; totalKredit: number }>(
        `SELECT COALESCE(SUM(debit),0) as totalDebit, COALESCE(SUM(kredit),0) as totalKredit FROM journal_entry`
      );
      expect(balance?.totalDebit).toBe(balance?.totalKredit);
    });
  });

  // ================================================================
  // BUG P0-8 — trigger OTOMATIS akrual jasa (lifecycle app), termasuk
  // catch-up periode yang terlewat & idempotency run berulang.
  // ================================================================
  describe('BUG P0-8 — jalankanAkrualJasaOtomatisJikaPerlu (trigger lifecycle otomatis)', () => {
    // TEST 6 (dokumen bug): app tidak dibuka 2 periode -> login berikutnya
    // mengejar SEMUA periode yang sudah memenuhi syarat, TIDAK PERNAH periode future.
    test('TEST 6: mengejar periode yang terlewat (app tidak dibuka 1 bulan) tanpa pernah menyentuh periode future', async () => {
      const pinjamanId = await pinjamanAktif12Bulan();
      const jadwal = await getJadwalAngsuran(pinjamanId);
      const periode1 = jadwal[0].tanggalJatuhTempo.slice(0, 7); // 2026-02
      const periode2 = jadwal[1].tanggalJatuhTempo.slice(0, 7); // 2026-03
      const periode3 = jadwal[2].tanggalJatuhTempo.slice(0, 7); // 2026-04 — jatuh tempo 2026-04-01, MASIH future relatif tanggal login di bawah

      // App tidak pernah dibuka sepanjang Februari (periode 1 tidak
      // pernah diakru), baru dibuka lagi 2026-03-15 — periode 2 SUDAH
      // jatuh tempo (jadwal[1] jatuh tempo 2026-03-01) tapi periode 3
      // (jatuh tempo 2026-04-01) BELUM (simulasi "Oktober tidak
      // dibuka, November baru dibuka").
      const hasil = await jalankanAkrualJasaOtomatisJikaPerlu('user-1', new Date('2026-03-15T00:00:00.000Z'));

      expect(hasil.dijalankan).toBe(true);
      expect(hasil.periodeDiproses).toEqual([periode1, periode2]); // ASCENDING, hanya yang sudah jatuh tempo
      expect(hasil.periodeDiproses).not.toContain(periode3); // periode yang belum jatuh tempo TIDAK ikut

      const outstanding = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
      expect(outstanding).toBe(jadwal[0].jasa + jadwal[1].jasa); // 2 periode, bukan proyeksi ke depan

      const statusPeriode3 = await testDb.getFirstAsync<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND periode_akuntansi = ? AND tipe_pengakuan = 'JASA_AKRUAL'`,
        pinjamanId,
        periode3
      );
      expect(statusPeriode3?.cnt ?? 0).toBe(0); // periode future tidak pernah diproses
    });

    // TEST 7 (dokumen bug): trigger dijalankan dua kali -> jurnal tetap satu kali.
    test('TEST 7: trigger otomatis dijalankan dua kali berturut-turut — journal tetap SATU kali (idempotent)', async () => {
      const pinjamanId = await pinjamanAktif12Bulan();

      const run1 = await jalankanAkrualJasaOtomatisJikaPerlu('user-1', new Date('2026-02-28T00:00:00.000Z'));
      expect(run1.periodeDiproses.length).toBe(1);

      const run2 = await jalankanAkrualJasaOtomatisJikaPerlu('user-1', new Date('2026-02-28T00:00:00.000Z'));
      expect(run2.periodeDiproses.length).toBe(0); // sudah tidak ada periode yang perlu dikejar lagi

      const jumlahJurnal = await testDb.getFirstAsync<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'AKRUAL_JASA_PINJAMAN' AND sumber_id = ?`,
        pinjamanId
      );
      expect(jumlahJurnal?.cnt).toBe(1);
    });

    // TEST 8 (dokumen bug): trigger otomatis menghormati boundary non-accrual yang sama.
    test('TEST 8: trigger otomatis TIDAK mengakru pinjaman yang sudah mencapai boundary non-accrual', async () => {
      const pinjamanId = await pinjamanAktif12Bulan();
      const jadwal = await getJadwalAngsuran(pinjamanId);

      // Tunggakan jauh melewati jatuh tempo -> kolektibilitas MACET (boundary default DIRAGUKAN).
      const hasil = await jalankanAkrualJasaOtomatisJikaPerlu('user-1', new Date('2026-09-01T00:00:00.000Z'));
      expect(hasil.dijalankan).toBe(true);

      const outstanding = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
      expect(outstanding).toBe(0); // TIDAK ADA yang diakru — non-accrual sejak awal keterlambatan

      const statusAkhir = await getStatusAkrualJasaPeriode(jadwal[0].tanggalJatuhTempo.slice(0, 7), { tanggalLaporan: '2026-09-01' });
      const item = statusAkhir.find((s) => s.pinjamanId === pinjamanId);
      expect(item?.kolektibilitas).toBe('MACET');
    });
  });
});

/**
 * ============================================================
 * FINAL FIX AKRUAL JASA PINJAMAN — TEST A..P (permintaan pengguna)
 * ============================================================
 * SEMUA test di bawah memakai SQLite SUNGGUHAN (sql.js lewat testDb,
 * skema asli schema.ts) dan service code SUNGGUHAN — tidak ada
 * perhitungan yang di-mock/di-stub.
 */

/**
 * Tulis ulang jadwal angsuran sebuah pinjaman dengan tanggal & jasa
 * yang DIKONTROL PENUH. Dipakai supaya batas tanggal (jatuh tempo di
 * tengah bulan, batas awal bulan, dst.) bisa diuji eksplisit tanpa
 * bergantung pada tanggal wall-clock saat test dijalankan.
 * PinjamanCalculator TIDAK disentuh — service akrual memang membaca
 * `angsuran_jadwal` sebagai sumber kebenaran jadwal kontraktual.
 */
async function tulisUlangJadwal(
  pinjamanId: string,
  baris: { nomor: number; jatuhTempo: string; pokok: number; jasa: number }[]
): Promise<string[]> {
  await testDb.runAsync(`DELETE FROM angsuran_jadwal WHERE pinjaman_id = ?`, pinjamanId);
  const ids: string[] = [];
  for (const b of baris) {
    const id = `jdw-${pinjamanId}-${b.nomor}`;
    ids.push(id);
    await testDb.runAsync(
      `INSERT INTO angsuran_jadwal
        (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total,
         pokok_terbayar, jasa_terbayar, denda_terbayar, jasa_dimuka, status)
       VALUES (?,?,?,?,?,?,0,?,0,0,0,0,'BELUM_BAYAR')`,
      id,
      pinjamanId,
      b.nomor,
      b.jatuhTempo,
      b.pokok,
      b.jasa,
      b.pokok + b.jasa
    );
  }
  return ids;
}

async function jumlahJurnalAkrual(pinjamanId: string): Promise<number> {
  const row = await testDb.getFirstAsync<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'AKRUAL_JASA_PINJAMAN' AND sumber_id = ?`,
    pinjamanId
  );
  return row?.cnt ?? 0;
}

async function saldoAkun(accountId: string): Promise<{ debit: number; kredit: number }> {
  const row = await testDb.getFirstAsync<{ d: number; k: number }>(
    `SELECT COALESCE(SUM(je.debit),0) as d, COALESCE(SUM(je.kredit),0) as k
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE je.account_id = ? AND j.status = 'POSTED'`,
    accountId
  );
  return { debit: row?.d ?? 0, kredit: row?.k ?? 0 };
}

/** Pendapatan Jasa Pinjaman yang benar-benar diakui di GL (kredit - debit). */
async function pendapatanJasaGL(): Promise<number> {
  const s = await saldoAkun(ACC.pendapatanJasa);
  return s.kredit - s.debit;
}

/** Piutang Jasa Pinjaman yang benar-benar berdiri di GL (debit - kredit). */
async function piutangJasaGL(): Promise<number> {
  const s = await saldoAkun(ACC.piutangJasa);
  return s.debit - s.kredit;
}

/** Pendapatan Diterima Dimuka yang masih berdiri di GL (kredit - debit). */
async function pendapatanDimukaGL(): Promise<number> {
  const s = await saldoAkun(ACC.pendapatanDimuka);
  return s.kredit - s.debit;
}

async function totalDebitKreditSeluruhGL(): Promise<{ debit: number; kredit: number }> {
  const row = await testDb.getFirstAsync<{ d: number; k: number }>(
    `SELECT COALESCE(SUM(je.debit),0) as d, COALESCE(SUM(je.kredit),0) as k
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id WHERE j.status = 'POSTED'`
  );
  return { debit: row?.d ?? 0, kredit: row?.k ?? 0 };
}

describe('FINAL FIX AKRUAL — eligibility berbasis TANGGAL jatuh tempo', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('TEST A: bulan SAMA tapi tanggal jatuh tempo MASIH DI DEPAN -> tidak akrual; pada tanggal jatuh tempo -> akrual', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await tulisUlangJadwal(pinjamanId, [{ nomor: 1, jatuhTempo: '2026-09-25', pokok: 100_000, jasa: 12_000 }]);

    // 2026-09-10 dan 2026-09-25 sama-sama periode '2026-09', TAPI
    // 25 September belum terjadi -> TIDAK BOLEH akrual.
    const belum = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: '2026-09',
      createdBy: 'user-1',
      tanggalLaporan: '2026-09-10',
    });
    expect(belum.dibuat).toBe(false);
    expect(await jumlahJurnalAkrual(pinjamanId)).toBe(0);
    expect(await piutangJasaGL()).toBe(0);
    expect(await pendapatanJasaGL()).toBe(0);

    const sudah = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: '2026-09',
      createdBy: 'user-1',
      tanggalLaporan: '2026-09-25',
    });
    expect(sudah.dibuat).toBe(true);
    expect(sudah.row?.jumlahJasa).toBe(12_000);
    expect(await piutangJasaGL()).toBe(12_000);
    expect(await pendapatanJasaGL()).toBe(12_000);
  });

  test('TEST B: batas pergantian bulan — jatuh tempo 2026-10-01 tidak akrual pada 2026-09-30, akrual pada 2026-10-01', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await tulisUlangJadwal(pinjamanId, [{ nomor: 1, jatuhTempo: '2026-10-01', pokok: 100_000, jasa: 12_000 }]);

    const belum = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: '2026-10',
      createdBy: 'user-1',
      tanggalLaporan: '2026-09-30',
    });
    expect(belum.dibuat).toBe(false);
    expect(await jumlahJurnalAkrual(pinjamanId)).toBe(0);

    const sudah = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: '2026-10',
      createdBy: 'user-1',
      tanggalLaporan: '2026-10-01',
    });
    expect(sudah.dibuat).toBe(true);
    expect(sudah.row?.jumlahJasa).toBe(12_000);
  });

  test('TEST C: hanya periode yang SUDAH jatuh tempo yang diakui — jasa future tidak masuk Piutang/Pendapatan/jurnal', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const baris = Array.from({ length: 12 }, (_, i) => ({
      nomor: i + 1,
      jatuhTempo: `2026-${String(i + 1).padStart(2, '0')}-01`,
      pokok: 100_000,
      jasa: 12_000,
    }));
    await tulisUlangJadwal(pinjamanId, baris);

    // Tanggal laporan di bulan ke-3 -> hanya periode 01, 02, 03 eligible.
    const hasil = await jalankanAkrualJasaOtomatisJikaPerlu('user-1', new Date('2026-03-10T00:00:00.000Z'));
    expect(hasil.dijalankan).toBe(true);
    expect(hasil.periodeDiproses).toEqual(['2026-01', '2026-02', '2026-03']);

    expect(await pendapatanJasaGL()).toBe(36_000);
    expect(await piutangJasaGL()).toBe(36_000);
    expect(await jumlahJurnalAkrual(pinjamanId)).toBe(3);

    // Periode ke-4 dst BELUM punya baris akuntansi sama sekali.
    const barisFuture = await testDb.getAllAsync<{ periode_akuntansi: string }>(
      `SELECT periode_akuntansi FROM pinjaman_akuntansi_jasa
       WHERE pinjaman_id = ? AND tipe_pengakuan = 'JASA_AKRUAL' AND periode_akuntansi > '2026-03'`,
      pinjamanId
    );
    expect(barisFuture).toHaveLength(0);
  });

  test('TEST D: bayar PENUH setelah jatuh tempo sebelum akrual -> pendapatan diakui SEKALI, akrual tidak menambah', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const [jadwalId] = await tulisUlangJadwal(pinjamanId, [
      { nomor: 1, jatuhTempo: '2026-02-01', pokok: 100_000, jasa: 12_000 },
    ]);

    await bayarAngsuran({
      pinjamanId,
      jadwalId,
      tanggal: '2026-02-05', // SETELAH jatuh tempo -> sudah earned
      nominal: 112_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(await pendapatanJasaGL()).toBe(12_000);

    const akrual = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: '2026-02',
      createdBy: 'user-1',
      tanggalLaporan: '2026-02-28',
    });
    expect(akrual.dibuat).toBe(false);
    expect(await pendapatanJasaGL()).toBe(12_000); // BUKAN 24.000
    expect(await piutangJasaGL()).toBe(0);
  });

  test('TEST E: bayar SEBAGIAN (4.800) SEBELUM jatuh tempo -> Pendapatan Diterima Dimuka, bukan pendapatan; saat jatuh tempo diakui sekali', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const [jadwalId] = await tulisUlangJadwal(pinjamanId, [
      { nomor: 1, jatuhTempo: '2026-10-01', pokok: 100_000, jasa: 12_000 },
    ]);

    // Bayar 4.800 pada 2026-09-20 — kas diterima, TAPI jasa belum earned.
    await bayarAngsuran({
      pinjamanId,
      jadwalId,
      tanggal: '2026-09-20',
      nominal: 4_800,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(await pendapatanJasaGL()).toBe(0); // TIDAK diakui sebagai pendapatan
    expect(await pendapatanDimukaGL()).toBe(4_800);
    expect(await piutangJasaGL()).toBe(0);

    // Saat periode jatuh tempo: seluruh 12.000 diakui SEKALI —
    // 4.800 dari pelepasan liabilitas + 7.200 menjadi Piutang Jasa.
    const akrual = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: '2026-10',
      createdBy: 'user-1',
      tanggalLaporan: '2026-10-01',
    });
    expect(akrual.dibuat).toBe(true);
    expect(akrual.row?.jumlahJasa).toBe(12_000);
    expect(await pendapatanJasaGL()).toBe(12_000); // BUKAN 4.800 + 12.000
    expect(await pendapatanDimukaGL()).toBe(0);
    expect(await piutangJasaGL()).toBe(7_200);
    expect(await hitungOutstandingPiutangJasa(testDb as any, pinjamanId)).toBe(7_200);

    // Sisa 7.200 dibayar setelah jatuh tempo -> hanya mengurangi Piutang Jasa.
    await bayarAngsuran({
      pinjamanId,
      jadwalId,
      tanggal: '2026-10-05',
      nominal: 107_200,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(await pendapatanJasaGL()).toBe(12_000);
    expect(await piutangJasaGL()).toBe(0);
  });

  test('TEST F: akrual dulu lalu dibayar -> Pendapatan 12.000, Piutang Jasa 0 (bukan 24.000)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const [jadwalId] = await tulisUlangJadwal(pinjamanId, [
      { nomor: 1, jatuhTempo: '2026-02-01', pokok: 100_000, jasa: 12_000 },
    ]);

    await prosesAkrualJasaPinjaman({ pinjamanId, periode: '2026-02', createdBy: 'user-1', tanggalLaporan: '2026-02-01' });
    expect(await pendapatanJasaGL()).toBe(12_000);
    expect(await piutangJasaGL()).toBe(12_000);

    await bayarAngsuran({
      pinjamanId,
      jadwalId,
      tanggal: '2026-02-10',
      nominal: 112_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(await pendapatanJasaGL()).toBe(12_000);
    expect(await piutangJasaGL()).toBe(0);
  });

  test('TEST G: catch-up otomatis memproses periode yang sudah jatuh tempo saja, tidak menyentuh periode future', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await tulisUlangJadwal(pinjamanId, [
      { nomor: 1, jatuhTempo: '2026-08-01', pokok: 100_000, jasa: 12_000 },
      { nomor: 2, jatuhTempo: '2026-09-01', pokok: 100_000, jasa: 12_000 },
      { nomor: 3, jatuhTempo: '2026-10-25', pokok: 100_000, jasa: 12_000 },
    ]);

    // Aplikasi baru dibuka 2026-10-10: Agustus & September sudah jatuh
    // tempo, Oktober (25) BELUM.
    const hasil = await jalankanAkrualJasaOtomatisJikaPerlu('user-1', new Date('2026-10-10T00:00:00.000Z'));
    expect(hasil.dijalankan).toBe(true);
    expect(hasil.periodeDiproses).toEqual(['2026-08', '2026-09']);
    expect(await pendapatanJasaGL()).toBe(24_000);
    expect(await jumlahJurnalAkrual(pinjamanId)).toBe(2);

    const oktober = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND periode_akuntansi = '2026-10'`,
      pinjamanId
    );
    expect(oktober?.cnt).toBe(0);
  });

  test('TEST H: jalankanAkrualJasaOtomatisJikaPerlu() dua kali -> jumlah jurnal & pendapatan tetap sama (idempoten)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await tulisUlangJadwal(pinjamanId, [
      { nomor: 1, jatuhTempo: '2026-08-01', pokok: 100_000, jasa: 12_000 },
      { nomor: 2, jatuhTempo: '2026-09-01', pokok: 100_000, jasa: 12_000 },
    ]);

    await jalankanAkrualJasaOtomatisJikaPerlu('user-1', new Date('2026-10-10T00:00:00.000Z'));
    const jurnalRun1 = await jumlahJurnalAkrual(pinjamanId);
    const pendapatanRun1 = await pendapatanJasaGL();

    const run2 = await jalankanAkrualJasaOtomatisJikaPerlu('user-1', new Date('2026-10-10T00:00:00.000Z'));
    expect(run2.periodeDiproses).toEqual([]);
    expect(await jumlahJurnalAkrual(pinjamanId)).toBe(jurnalRun1);
    expect(await pendapatanJasaGL()).toBe(pendapatanRun1);
  });

  test('TEST I: kolektibilitas mencapai boundary non-accrual (DIRAGUKAN) -> akrual BERHENTI', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await tulisUlangJadwal(pinjamanId, [{ nomor: 1, jatuhTempo: '2026-02-01', pokok: 100_000, jasa: 12_000 }]);

    expect(await getNonAccrualMinKolektibilitas()).toBe('DIRAGUKAN');

    // Tanggal laporan jauh setelah jatuh tempo -> tunggakan panjang.
    const status = await getStatusAkrualJasaPeriode('2026-02', { tanggalLaporan: '2026-12-01' });
    const item = status.find((s) => s.pinjamanId === pinjamanId);
    expect(kolektibilitasMencapaiBoundary(item!.kolektibilitas, 'DIRAGUKAN')).toBe(true);
    expect(item?.status).toBe('NON_ACCRUAL');

    const hasil = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: '2026-02',
      createdBy: 'user-1',
      tanggalLaporan: '2026-12-01',
    });
    expect(hasil.dibuat).toBe(false);
    expect(hasil.dilewati).toMatch(/Non-accrual/);
    expect(await jumlahJurnalAkrual(pinjamanId)).toBe(0);
  });

  test('TEST J: FLAT 1.200.000 @1% 12 bulan -> 12.000 per periode, diakru tepat pada tanggal jatuh tempo', async () => {
    const pinjamanId = await pinjamanAktif12Bulan(1_200_000);
    const jadwal = await getJadwalAngsuran(pinjamanId);
    expect(jadwal[0].jasa).toBe(12_000);
    expect(jadwal.every((j) => j.jasa === 12_000)).toBe(true);

    const jatuhTempo1 = jadwal[0].tanggalJatuhTempo;
    const seharisebelum = new Date(new Date(jatuhTempo1).getTime() - 86400000).toISOString().slice(0, 10);

    const belum = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: jatuhTempo1.slice(0, 7),
      createdBy: 'user-1',
      tanggalLaporan: seharisebelum,
    });
    expect(belum.dibuat).toBe(false);

    const sudah = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: jatuhTempo1.slice(0, 7),
      createdBy: 'user-1',
      tanggalLaporan: jatuhTempo1,
    });
    expect(sudah.dibuat).toBe(true);
    expect(sudah.row?.jumlahJasa).toBe(12_000);
  });

  test('TEST K: MENURUN — tiap periode memakai jasa dari jadwalnya sendiri, bukan jasa periode pertama', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_200_000,
      tenor: 12,
      satuanTenor: 'BULAN',
      metodeJasa: 'MENURUN',
      persentaseJasa: 1,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    const jadwal = await getJadwalAngsuran(id);
    // Jasa MENURUN memang menurun tiap periode — buktikan tidak seragam.
    expect(jadwal[1].jasa).toBeLessThan(jadwal[0].jasa);
    expect(jadwal[2].jasa).toBeLessThan(jadwal[1].jasa);

    for (let i = 0; i < 3; i++) {
      const periode = jadwal[i].tanggalJatuhTempo.slice(0, 7);
      const hasil = await prosesAkrualJasaPinjaman({
        pinjamanId: id,
        periode,
        createdBy: 'user-1',
        tanggalLaporan: jadwal[i].tanggalJatuhTempo,
      });
      expect(hasil.dibuat).toBe(true);
      expect(hasil.row?.jumlahJasa).toBe(jadwal[i].jasa);
    }
    expect(await pendapatanJasaGL()).toBe(jadwal[0].jasa + jadwal[1].jasa + jadwal[2].jasa);
  });

  test('TEST L: EFEKTIF + fee integral — akrual jasa kontraktual TIDAK double dengan amortisasi fee EIR', async () => {
    // Tanggal pencairan mengikuti wall-clock (cairkanPinjaman memang
    // memakai tanggal hari ini), jadi jadwal dibuat relatif hari ini
    // supaya arus kas EIR valid tanpa mengubah service.
    const hariIni = new Date().toISOString().slice(0, 10);
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: hariIni,
      jumlahPinjaman: 1_200_000,
      tenor: 12,
      satuanTenor: 'BULAN',
      metodeJasa: 'EFEKTIF',
      persentaseJasa: 1,
      biayaAdminTipe: 'NOMINAL',
      biayaAdminNilai: 12_000,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await testDb.runAsync(`UPDATE pinjaman SET biaya_admin_klasifikasi = 'INTEGRAL_FINANCIAL_INSTRUMENT' WHERE id = ?`, id);
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    const jadwal = await getJadwalAngsuran(id);
    const periode1 = jadwal[0].tanggalJatuhTempo.slice(0, 7);

    // Fee integral TIDAK menjadi Piutang Jasa & TIDAK diakui sebagai
    // pendapatan saat pencairan — dia hidup di jalur EIR sendiri.
    expect(await piutangJasaGL()).toBe(0);
    expect(await pendapatanJasaGL()).toBe(0);
    expect(await hitungFeeIntegralPendingEir(testDb as any, id)).toBe(12_000);

    const hasil = await prosesAkrualJasaPinjaman({
      pinjamanId: id,
      periode: periode1,
      createdBy: 'user-1',
      tanggalLaporan: jadwal[0].tanggalJatuhTempo,
    });
    expect(hasil.dibuat).toBe(true);
    // Akrual HANYA mengakui jasa kontraktual jadwal — bukan fee EIR.
    expect(hasil.row?.jumlahJasa).toBe(jadwal[0].jasa);
    expect(await pendapatanJasaGL()).toBe(jadwal[0].jasa);
    // Saldo fee integral TIDAK tersentuh oleh akrual jasa.
    expect(await hitungFeeIntegralPendingEir(testDb as any, id)).toBe(12_000);

    // Baris akuntansi tetap terpisah per tipe pengakuan — tidak tercampur.
    const tipe = await testDb.getAllAsync<{ tipe_pengakuan: string }>(
      `SELECT DISTINCT tipe_pengakuan FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? ORDER BY tipe_pengakuan`,
      id
    );
    expect(tipe.map((t) => t.tipe_pengakuan)).toEqual(['FEE_INTEGRAL_AMORTISASI', 'JASA_AKRUAL']);
  });

  test('TEST M: CUSTOM — akrual mengikuti nilai jasa jadwal custom apa adanya', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await tulisUlangJadwal(pinjamanId, [
      { nomor: 1, jatuhTempo: '2026-02-01', pokok: 100_000, jasa: 7_777 },
      { nomor: 2, jatuhTempo: '2026-03-01', pokok: 100_000, jasa: 3_333 },
    ]);

    const p1 = await prosesAkrualJasaPinjaman({ pinjamanId, periode: '2026-02', createdBy: 'user-1', tanggalLaporan: '2026-02-01' });
    const p2 = await prosesAkrualJasaPinjaman({ pinjamanId, periode: '2026-03', createdBy: 'user-1', tanggalLaporan: '2026-03-01' });
    expect(p1.row?.jumlahJasa).toBe(7_777);
    expect(p2.row?.jumlahJasa).toBe(3_333);
    expect(await pendapatanJasaGL()).toBe(11_110);
  });

  test('TEST N: hitungTotalPelunasan memisahkan jasaSudahDiakru / jasaJatuhTempoBelumDiakru / jasaFuture', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await tulisUlangJadwal(pinjamanId, [
      { nomor: 1, jatuhTempo: '2026-02-01', pokok: 100_000, jasa: 12_000 }, // diakru
      { nomor: 2, jatuhTempo: '2026-03-01', pokok: 100_000, jasa: 12_000 }, // jatuh tempo, belum diakru
      { nomor: 3, jatuhTempo: '2026-06-01', pokok: 100_000, jasa: 12_000 }, // future
    ]);

    await prosesAkrualJasaPinjaman({ pinjamanId, periode: '2026-02', createdBy: 'user-1', tanggalLaporan: '2026-02-01' });

    const rincian = await hitungTotalPelunasan(testDb as any, pinjamanId, '2026-03-15');
    expect(rincian.jasaSudahDiakru).toBe(12_000);
    expect(rincian.jasaJatuhTempoBelumDiakru).toBe(12_000);
    expect(rincian.jasaFuture).toBe(12_000);
    expect(rincian.jasaSudahJatuhTempo).toBe(24_000);
    expect(rincian.jasaSudahDiakru + rincian.jasaJatuhTempoBelumDiakru).toBe(rincian.jasaSudahJatuhTempo);
    expect(rincian.jasaTerutang).toBe(36_000);
  });

  test('TEST O: seluruh GL tetap balance (total debit = total kredit) setelah akrual & pembayaran', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const [j1] = await tulisUlangJadwal(pinjamanId, [
      { nomor: 1, jatuhTempo: '2026-10-01', pokok: 100_000, jasa: 12_000 },
    ]);

    await bayarAngsuran({ pinjamanId, jadwalId: j1, tanggal: '2026-09-20', nominal: 4_800, sumberDana: 'KAS', createdBy: 'user-1' });
    let total = await totalDebitKreditSeluruhGL();
    expect(total.debit).toBe(total.kredit);

    await prosesAkrualJasaPinjaman({ pinjamanId, periode: '2026-10', createdBy: 'user-1', tanggalLaporan: '2026-10-01' });
    total = await totalDebitKreditSeluruhGL();
    expect(total.debit).toBe(total.kredit);

    await bayarAngsuran({ pinjamanId, jadwalId: j1, tanggal: '2026-10-05', nominal: 107_200, sumberDana: 'KAS', createdBy: 'user-1' });
    total = await totalDebitKreditSeluruhGL();
    expect(total.debit).toBe(total.kredit);
  });

  test('TEST P: setelah akrual Piutang Jasa & Pendapatan Jasa > 0; setelah bayar Piutang turun & pendapatan tidak double', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const [j1] = await tulisUlangJadwal(pinjamanId, [
      { nomor: 1, jatuhTempo: '2026-02-01', pokok: 100_000, jasa: 12_000 },
      { nomor: 2, jatuhTempo: '2026-03-01', pokok: 100_000, jasa: 12_000 },
    ]);

    await prosesAkrualJasaPinjaman({ pinjamanId, periode: '2026-02', createdBy: 'user-1', tanggalLaporan: '2026-02-01' });
    expect(await piutangJasaGL()).toBeGreaterThan(0);
    expect(await pendapatanJasaGL()).toBeGreaterThan(0);

    const pendapatanSebelum = await pendapatanJasaGL();
    await bayarAngsuran({ pinjamanId, jadwalId: j1, tanggal: '2026-02-20', nominal: 112_000, sumberDana: 'KAS', createdBy: 'user-1' });

    expect(await piutangJasaGL()).toBe(0);
    expect(await pendapatanJasaGL()).toBe(pendapatanSebelum); // tidak double

    // Periode 2 (masa depan pada tanggal ini) tidak muncul di mana pun.
    expect(await hitungOutstandingPiutangJasa(testDb as any, pinjamanId)).toBe(0);
  });
});

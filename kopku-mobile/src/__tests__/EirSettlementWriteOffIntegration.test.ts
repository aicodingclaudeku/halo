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

import { ajukanPinjaman, cairkanPinjaman, lunasiPinjaman, hapusPiutangPinjaman, getJadwalAngsuran, getPinjamanDetail, bayarAngsuran } from '@/services/PinjamanService';
import { getEirTersimpan, prosesEirBulanan } from '@/services/EirAccountingService';
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
  pendapatanAdmin: 'acc-pendapatan-admin',
  penyisihan: 'acc-penyisihan',
  bebanPenyisihan: 'acc-beban-penyisihan',
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
  await seedAccount(db, ACC.penyisihan, '1-1210', 'Penyisihan Piutang Tak Tertagih', 'ASET', 'KREDIT');
  await seedAccount(db, ACC.bebanPenyisihan, '5-2100', 'Beban Penyisihan Pinjaman', 'BEBAN', 'DEBIT');
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
  // FIXTURE FIX: lunasiPinjaman() memakai mapping ini untuk jasa
  // kontraktual yang BELUM jatuh tempo saat pelunasan dipercepat
  // (Pendapatan Diterima Dimuka 2-1300 existing) — mapping produksi
  // sudah benar, fixture-nya yang belum menyeed.
  await seedMapping(db, 'PELUNASAN_JASA_FUTURE', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'PELUNASAN_PENALTI', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(db, 'PELUNASAN_ADMINISTRASI', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  // FINAL FIX AKRUAL (BUG 4/5/7): jasa yang kasnya diterima SEBELUM jatuh tempo
  // -> Pendapatan Diterima Dimuka (2-1300 existing), dilepas saat periode jatuh tempo.
  await seedMapping(db, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(db, 'EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(db, 'PENYISIHAN_PIUTANG', 'DEBIT_BEBAN', ACC.bebanPenyisihan);
  await seedMapping(db, 'PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN', ACC.penyisihan);

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
    `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at) VALUES ('rat-2026',2026,'2026-05-01','user-1',?,?)`,
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

describe('PHASE 7 FINAL FIX §1/§13 — lunasiPinjaman() otomatis men-derecognize sisa fee EIR', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('§13: end-to-end — disbursement -> EIR -> month1 -> month2 -> month3 -> lunasiPinjaman() -> total fee recognized = 12.000 exact, tidak ada future interest yang jadi revenue', async () => {
    const pinjamanId = await pinjamanEirAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);

    const bulan1 = await prosesEirBulanan({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-02-15' });
    const bulan2 = await prosesEirBulanan({ pinjamanId, periode: jadwal[1].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-03-15' });
    const bulan3 = await prosesEirBulanan({ pinjamanId, periode: jadwal[2].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-04-15' });
    expect(bulan1.dibuat && bulan2.dibuat && bulan3.dibuat).toBe(true);

    const eirSebelumPelunasan = (await getEirTersimpan(testDb as any, pinjamanId))!;
    const sisaSebelumPelunasan = eirSebelumPelunasan.sisaFeeBelumDiamortisasi;
    // RC-S54 TAHAP 9 — MODEL BERUBAH (keputusan C, bukan penyesuaian angka).
    // Dulu: basis sisa fee -> setelah 3 bulan sisa masih 0 < sisa < 12.000
    // (artefak basis yang salah). Sekarang basis amortized cost: FLAT 1%
    // dengan EIR 26,2% meng-unwind fee integral penuh di bulan ke-2
    // (A_1 = 11.730, A_2 = 19.552 > fee) dan kelebihannya menjadi bunga
    // efektif akrual X = 15.677 per bulan ke-3 — dihitung independen di
    // RC-S54_TAHAP_9.md. Yang tetap dibuktikan: derecognition otomatis
    // lewat lunasiPinjaman(), total fee = 12.000, tidak ada saldo tersisa.
    expect(sisaSebelumPelunasan).toBe(0);
    expect(eirSebelumPelunasan.penyesuaianAkrual).toBeGreaterThan(0);

    // §1: TIDAK memanggil helper derecognition secara manual — HANYA lunasiPinjaman().
    const hasil = await lunasiPinjaman({ pinjamanId, tanggal: '2026-04-20', sumberDana: 'KAS', createdBy: 'user-1' });

    // §1/§8: eirFeeDiselesaikan otomatis muncul di hasil, TANPA pemanggilan tambahan.
    expect(hasil.eirFeeDiselesaikan).toBe(sisaSebelumPelunasan);

    // §10: invariant — initial fee = Σ amortisasi bulanan + derecognition + sisa (sisa harus 0).
    const totalFeeSepanjangUmur = bulan1.row!.feeAmortizationIncome + bulan2.row!.feeAmortizationIncome + bulan3.row!.feeAmortizationIncome + hasil.eirFeeDiselesaikan;
    expect(totalFeeSepanjangUmur).toBe(12_000); // BUKAN 17.000, BUKAN kurang dari 12.000

    // §11: carrying amount/EIR sudah ditutup — TIDAK ada saldo aktif untuk loan LUNAS.
    expect(await getEirTersimpan(testDb as any, pinjamanId)).toBeNull();
    expect(await hitungFeeIntegralPendingEir(testDb as any, pinjamanId)).toBe(0);

    const detail = await getPinjamanDetail(pinjamanId);
    expect(detail?.status).toBe('LUNAS');
    const pinjamanRow = await testDb.getFirstAsync<{ eir_measurement_status: string }>(`SELECT eir_measurement_status FROM pinjaman WHERE id = ?`, pinjamanId);
    expect(pinjamanRow?.eir_measurement_status).toBe('DERECOGNIZED');

    // §4: future contractual interest TIDAK masuk Pendapatan Penalti/
    // Administrasi hanya karena settlement — tidak ada penalti/
    // administrasi yang diinput eksplisit di test ini, jadi porsinya
    // harus tetap 0 (bukti langsung dari hasil lunasiPinjaman()).
    expect(hasil.porsiPenalti).toBe(0);
    expect(hasil.porsiAdministrasi).toBe(0);

    // §12/journal balance keseluruhan.
    const totalDebit = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(debit),0) as total FROM journal_entry`);
    const totalKredit = await testDb.getFirstAsync<{ total: number }>(`SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry`);
    expect(totalDebit!.total).toBe(totalKredit!.total);
  });

  test('§8: idempotency — lunasiPinjaman() dipanggil dua kali -> panggilan kedua DITOLAK, TIDAK ada jurnal fee kedua', async () => {
    const pinjamanId = await pinjamanEirAktif();
    await lunasiPinjaman({ pinjamanId, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1' });

    const jumlahJurnalEirSebelum = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'EIR_FEE_AMORTIZATION'`);

    await expect(lunasiPinjaman({ pinjamanId, tanggal: '2026-02-02', sumberDana: 'KAS', createdBy: 'user-1' })).rejects.toThrow(/sudah lunas/);

    const jumlahJurnalEirSesudah = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'EIR_FEE_AMORTIZATION'`);
    expect(jumlahJurnalEirSesudah?.cnt).toBe(jumlahJurnalEirSebelum?.cnt); // TIDAK ada jurnal fee tambahan
  });

  test('§17: pinjaman TANPA integral fee -> lunasiPinjaman() TIDAK terpengaruh sama sekali (EIR path tidak aktif, eirFeeDiselesaikan = 0)', async () => {
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
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    const hasil = await lunasiPinjaman({ pinjamanId: id, tanggal: '2026-02-01', sumberDana: 'KAS', createdBy: 'user-1' });
    expect(hasil.eirFeeDiselesaikan).toBe(0);
    const detail = await getPinjamanDetail(id);
    expect(detail?.status).toBe('LUNAS');
  });
});

describe('PHASE 7 FINAL FIX §2/§14 — hapusPiutangPinjaman() otomatis men-derecognize sisa fee EIR', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('§14: end-to-end write-off — disbursement -> fee -> monthly EIR -> MACET -> hapusPiutangPinjaman() -> sisa fee = 0, histori EIR_MONTHLY TETAP ADA', async () => {
    const pinjamanId = await pinjamanEirAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const bulan1 = await prosesEirBulanan({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-02-15' });
    expect(bulan1.dibuat).toBe(true);

    const sisaSebelumWriteOff = (await getEirTersimpan(testDb as any, pinjamanId))!.sisaFeeBelumDiamortisasi;

    // §1 (write-off dokumen) — tanggal jauh di masa depan supaya kolektibilitas MACET.
    const hasil = await hapusPiutangPinjaman({
      pinjamanId,
      tanggal: '2026-09-01',
      alasan: 'Macet total',
      createdBy: 'user-1',
      topUpPenyisihanJikaKurang: true,
    });

    expect(hasil.eirFeeDiselesaikan).toBe(sisaSebelumWriteOff);
    expect(await hitungFeeIntegralPendingEir(testDb as any, pinjamanId)).toBe(0); // §10: remaining fee balance = 0
    expect(await getEirTersimpan(testDb as any, pinjamanId)).toBeNull();

    // Histori EIR_MONTHLY (bulan 1) TETAP ADA (bukan dihapus).
    const jumlahEirMonthly = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'EIR_MONTHLY'`,
      pinjamanId
    );
    // §AB FIX — EXPECTED VALUE DIPERBARUI, dengan alasan domain:
    // expected LAMA (`cnt >= 2` untuk tipe 'EIR_MONTHLY') SALAH karena
    // menghitung baris derecognition sebagai amortisasi bulanan.
    // Derecognition adalah peristiwa akuntansi yang BERBEDA (penyelesaian
    // sisa fee sekaligus saat instrumen dihentikan, bukan pengakuan
    // bertahap satu periode), dan menulisnya dengan tipe 'EIR_MONTHLY'
    // membuatnya menabrak UNIQUE(pinjaman_id, periode_akuntansi,
    // tipe_pengakuan) setiap kali amortisasi bulanan periode yang sama
    // sudah diakui. Sejak fix, derecognition memakai tipe
    // 'EIR_DERECOGNITION'. Expected BARU: histori EIR_MONTHLY tetap utuh
    // (bulan 1 TIDAK dihapus), derecognition tercatat terpisah, dan
    // invariant fee dijaga atas GABUNGAN kedua tipe.
    expect(jumlahEirMonthly!.cnt).toBeGreaterThanOrEqual(1); // histori bulan1 TETAP ADA

    const jumlahDerecognition = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'EIR_DERECOGNITION'`,
      pinjamanId
    );
    expect(jumlahDerecognition!.cnt).toBe(1);

    // INVARIANT (§D): initial fee = SUM(amortisasi bulanan) + derecognition.
    const semuaBaris = await testDb.getAllAsync<{ pendapatan_akuntansi: number }>(
      `SELECT pendapatan_akuntansi FROM pinjaman_akuntansi_jasa
       WHERE pinjaman_id = ? AND tipe_pengakuan IN ('EIR_MONTHLY','EIR_DERECOGNITION') AND status = 'DIAKUI'`,
      pinjamanId
    );
    const totalFee = semuaBaris.reduce((s, r) => s + r.pendapatan_akuntansi, 0);
    expect(totalFee).toBe(12_000);
  });

  test('§9: idempotency write-off — panggilan pertama sukses, panggilan kedua ditolak, tidak ada jurnal fee ganda', async () => {
    const pinjamanId = await pinjamanEirAktif();
    await hapusPiutangPinjaman({ pinjamanId, tanggal: '2026-09-01', alasan: 'Macet', createdBy: 'user-1', topUpPenyisihanJikaKurang: true });

    const jumlahJurnalSebelum = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'EIR_FEE_AMORTIZATION'`);

    await expect(
      hapusPiutangPinjaman({ pinjamanId, tanggal: '2026-09-02', alasan: 'Coba lagi', createdBy: 'user-1', topUpPenyisihanJikaKurang: true })
    ).rejects.toThrow(/sudah pernah dihapusbukukan/);

    const jumlahJurnalSesudah = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'EIR_FEE_AMORTIZATION'`);
    expect(jumlahJurnalSesudah?.cnt).toBe(jumlahJurnalSebelum?.cnt);
  });

  test('§16: non-accrual (MACET) tidak mencegah write-off menyelesaikan sisa fee — derecognition tetap berjalan (bukan revenue baru, murni penyelesaian saldo)', async () => {
    const pinjamanId = await pinjamanEirAktif();
    // Langsung write-off tanpa akrual bulanan apa pun -> seluruh fee (12.000) masih pending.
    const hasil = await hapusPiutangPinjaman({
      pinjamanId,
      tanggal: '2026-09-01',
      alasan: 'Macet',
      createdBy: 'user-1',
      topUpPenyisihanJikaKurang: true,
    });
    expect(hasil.eirFeeDiselesaikan).toBe(12_000);
    expect(await hitungFeeIntegralPendingEir(testDb as any, pinjamanId)).toBe(0);
  });
});

// ============================================================
// BUG-03 — PEMBUKTIAN INVARIAN FEE INTEGRAL (EIR)
// ============================================================
/**
 * Sampai sesi ini, BUG-03 hanya pernah "terlihat aman" lewat
 * pembacaan source (`Math.min`, `Math.max(0, ...)`). Itu bukan bukti —
 * justru `Math.max(0, ...)` adalah pola yang MENYEMBUNYIKAN
 * over-amortisasi: kalau total yang diakui melampaui fee awal, sisanya
 * dilaporkan 0 dan tidak ada yang tahu.
 *
 * Invarian yang dikunci di sini dihitung MENTAH (tanpa clamp):
 *
 *     feeAwal = amortisasi + derecognition + sisa
 *     sisa >= 0
 *     amortisasi + derecognition <= feeAwal
 *
 * dan sisi GL-nya: saldo 2-1300 milik fee integral = sisa fee.
 */
describe('BUG-03 — invarian fee integral EIR', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  async function invarian(pinjamanId: string) {
    const { hitungInvarianFeeEir } = await import('@/accounting/EirFeeInvariant');
    const hasil = await hitungInvarianFeeEir(testDb as any, pinjamanId);
    expect(hasil).not.toBeNull();
    return hasil!;
  }

  /** Saldo GL akun 2-1300 (liabilitas, normal balance KREDIT). */
  async function glDeferred(): Promise<number> {
    const row = await testDb.getFirstAsync<{ saldo: number }>(
      `SELECT COALESCE(SUM(je.kredit - je.debit), 0) as saldo
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
       WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
      ACC.pendapatanDimuka
    );
    return row?.saldo ?? 0;
  }

  function assertInvarian(inv: {
    feeAwal: number; amortisasi: number; derecognition: number;
    totalDiakui: number; sisaFee: number; variance: number; seimbang: boolean;
  }) {
    expect(inv.variance).toBe(0);
    expect(inv.sisaFee).toBeGreaterThanOrEqual(0);
    expect(inv.amortisasi).toBeGreaterThanOrEqual(0);
    expect(inv.derecognition).toBeGreaterThanOrEqual(0);
    expect(inv.totalDiakui).toBeLessThanOrEqual(inv.feeAwal);
    expect(inv.amortisasi + inv.derecognition + inv.sisaFee).toBe(inv.feeAwal);
    expect(inv.seimbang).toBe(true);
  }

  /**
   * Angsuran DIBAYAR tepat waktu sebelum EIR periode itu dijalankan.
   *
   * Tanpa ini pinjaman menunggak dan melewati batas non-accrual 90 hari
   * (kebijakan terpusat `getAccrualStatus`), sehingga amortisasi EIR
   * BERHENTI — perilaku yang memang benar, tetapi bukan skenario
   * "tenor normal" yang ingin diuji di sini.
   */
  async function bayarDanAmortisasi(pinjamanId: string, indeks: number) {
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const baris = jadwal[indeks];
    const periode = baris.tanggalJatuhTempo.slice(0, 7);
    await bayarAngsuran({
      pinjamanId,
      jadwalId: baris.id,
      tanggal: baris.tanggalJatuhTempo,
      nominal: baris.total,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await prosesEirBulanan({
      pinjamanId, periode, createdBy: 'user-1',
      tanggalLaporan: `${periode}-28`,
    });
    return periode;
  }

  test('A — tenor normal 12 bulan (dibayar lancar): seluruh fee teramortisasi, sisa tepat 0', async () => {
    const pinjamanId = await pinjamanEirAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);

    for (let i = 0; i < jadwal.length; i++) {
      await bayarDanAmortisasi(pinjamanId, i);
      // Invarian dijaga di SETIAP periode, bukan hanya di akhir.
      assertInvarian(await invarian(pinjamanId));
    }

    const akhir = await invarian(pinjamanId);
    expect(akhir.feeAwal).toBe(12_000);
    expect(akhir.amortisasi + akhir.derecognition).toBe(12_000);
    expect(akhir.sisaFee).toBe(0);
    // Tidak ada residu palsu akibat pembulatan rupiah.
    expect(await glDeferred()).toBe(0);
  });

  test('A2 — pinjaman menunggak >= 90 hari: amortisasi BERHENTI, invarian tetap utuh', async () => {
    // Membuktikan kebijakan non-accrual terpusat juga mengikat EIR, dan
    // penghentiannya tidak merusak invarian (sisa tetap = fee - diakui).
    const pinjamanId = await pinjamanEirAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    for (let i = 0; i < jadwal.length; i++) {
      const periode = jadwal[i].tanggalJatuhTempo.slice(0, 7);
      await prosesEirBulanan({ pinjamanId, periode, createdBy: 'user-1', tanggalLaporan: `${periode}-28` });
      assertInvarian(await invarian(pinjamanId));
    }
    const akhir = await invarian(pinjamanId);
    // RC-S54 TAHAP 9 — MODEL BERUBAH (keputusan C). Dulu "berhenti" dibuktikan
    // lewat totalDiakui < 12.000, yang hanya benar karena basis sisa fee
    // mengamortisasi sangat lambat. Di basis amortized cost fee FLAT ini
    // sudah ter-unwind penuh di bulan ke-2, jadi penghentian dibuktikan
    // LANGSUNG: tidak ada baris EIR_MONTHLY sesudah pinjaman melewati
    // ambang non-accrual (2026-05-28 = 117 hari), dan saldo 2-1300 persis
    // sama dengan komponen EIR yang tersisa (sisaFee - X), tidak bergerak.
    const periodeTerposting = await testDb.getAllAsync<{ periode_akuntansi: string }>(
      `SELECT periode_akuntansi FROM pinjaman_akuntansi_jasa WHERE pinjaman_id = ? AND tipe_pengakuan = 'EIR_MONTHLY' ORDER BY periode_akuntansi`,
      pinjamanId
    );
    expect(periodeTerposting.map((r) => r.periode_akuntansi)).toEqual(['2026-02', '2026-03', '2026-04']);
    expect(akhir.totalDiakui).toBe(12_000);
    expect(akhir.penyesuaianAkrual).toBeGreaterThan(0);
    expect(await glDeferred()).toBe(akhir.saldoKomponenEir);
  });

  test('E — menjalankan periode melebihi tenor tidak menciptakan fee income berlebih', async () => {
    const pinjamanId = await pinjamanEirAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    for (let i = 0; i < jadwal.length; i++) {
      await bayarDanAmortisasi(pinjamanId, i);
    }
    // Periode tambahan SETELAH fee habis — tidak boleh menambah apa pun.
    for (const periode of ['2027-02', '2027-03']) {
      await prosesEirBulanan({ pinjamanId, periode, createdBy: 'user-1', tanggalLaporan: `${periode}-28` });
    }
    const inv = await invarian(pinjamanId);
    assertInvarian(inv);
    expect(inv.totalDiakui).toBe(12_000);
    expect(await glDeferred()).toBe(0);
  });

  test('F — pelunasan dipercepat: sisa fee diselesaikan SEKALI lewat derecognition', async () => {
    const pinjamanId = await pinjamanEirAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    for (let i = 0; i < 3; i++) {
      const periode = jadwal[i].tanggalJatuhTempo.slice(0, 7);
      await prosesEirBulanan({ pinjamanId, periode, createdBy: 'user-1', tanggalLaporan: `${periode}-28` });
    }
    const sebelum = await invarian(pinjamanId);
    // RC-S54 TAHAP 9 — MODEL BERUBAH (keputusan C): setelah 3 bulan fee FLAT
    // sudah ter-unwind penuh; yang masih terbuka dan WAJIB diselesaikan
    // sekali oleh derecognition adalah penyesuaian bunga efektif akrual X.
    expect(sebelum.sisaFee).toBe(0);
    expect(sebelum.penyesuaianAkrual).toBeGreaterThan(0);

    await lunasiPinjaman({
      pinjamanId, tanggal: '2026-05-01', sumberDana: 'KAS', createdBy: 'user-1',
      metodeJasaPelunasan: 'JASA_TERUTANG',
    });

    const sesudah = await invarian(pinjamanId);
    assertInvarian(sesudah);
    // Sisa yang tadi belum diamortisasi kini menjadi derecognition —
    // BUKAN amortisasi kedua, dan totalnya tetap 12.000.
    expect(sesudah.derecognition).toBe(sebelum.sisaFee);
    expect(sesudah.amortisasi).toBe(sebelum.amortisasi);
    expect(sesudah.totalDiakui).toBe(12_000);
    expect(sesudah.sisaFee).toBe(0);
    // X dibalik tepat sekali -> komponen EIR pinjaman ini di 2-1300 nol.
    expect(sesudah.penyesuaianAkrual).toBe(0);
    expect(sesudah.saldoKomponenEir).toBe(0);
  });

  test('G — hapus buku: fee integral ter-derecognize, invarian tetap utuh', async () => {
    const pinjamanId = await pinjamanEirAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const periode = jadwal[0].tanggalJatuhTempo.slice(0, 7);
    await prosesEirBulanan({ pinjamanId, periode, createdBy: 'user-1', tanggalLaporan: `${periode}-28` });

    await hapusPiutangPinjaman({
      pinjamanId, tanggal: '2026-11-01', alasan: 'Anggota tidak dapat dilacak',
      createdBy: 'user-1', topUpPenyisihanJikaKurang: true,
    });

    const inv = await invarian(pinjamanId);
    assertInvarian(inv);
    expect(inv.totalDiakui).toBe(12_000);
    expect(inv.sisaFee).toBe(0);
  });

  test('H — menjalankan periode yang SAMA dua kali tidak menghasilkan pengakuan ganda', async () => {
    const pinjamanId = await pinjamanEirAktif();
    const periode = (await getJadwalAngsuran(pinjamanId))[0].tanggalJatuhTempo.slice(0, 7);

    await prosesEirBulanan({ pinjamanId, periode, createdBy: 'user-1', tanggalLaporan: `${periode}-28` });
    const run1 = await invarian(pinjamanId);
    const jurnalRun1 = (
      await testDb.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) as n FROM journal WHERE sumber_transaksi = 'EIR_FEE_AMORTIZATION'`
      )
    )!.n;

    await prosesEirBulanan({ pinjamanId, periode, createdBy: 'user-1', tanggalLaporan: `${periode}-28` });
    const run2 = await invarian(pinjamanId);

    expect(run2.amortisasi).toBe(run1.amortisasi);
    expect(run2.sisaFee).toBe(run1.sisaFee);
    expect(
      (await testDb.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) as n FROM journal WHERE sumber_transaksi = 'EIR_FEE_AMORTIZATION'`
      ))!.n
    ).toBe(jurnalRun1);
    assertInvarian(run2);
  });

  /** Pinjaman ber-fee integral dengan tenor & satuan yang bisa diatur. */
  async function pinjamanEirKustom(opts: {
    tenor: number;
    satuanTenor: 'HARI' | 'MINGGU' | 'BULAN';
    fee: number;
    pokok?: number;
  }): Promise<string> {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: opts.pokok ?? 1_200_000,
      tenor: opts.tenor,
      satuanTenor: opts.satuanTenor,
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      biayaAdminTipe: 'NOMINAL',
      biayaAdminNilai: opts.fee,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await testDb.runAsync(
      `UPDATE pinjaman SET biaya_admin_klasifikasi = 'INTEGRAL_FINANCIAL_INSTRUMENT' WHERE id = ?`,
      id
    );
    await cairkanPinjaman({
      pinjamanId: id,
      sumberDana: 'KAS',
      approvedBy: 'user-1',
      tanggalPencairan: '2026-01-01',
    });
    return id;
  }

  test('B — tenor sangat pendek (1 periode): fee TIDAK tertinggal, sisa tepat 0', async () => {
    // Tenor 1 adalah kasus batas paling rawan: tidak ada periode
    // berikutnya untuk "menyapu" residu pembulatan, jadi kalau
    // amortisasi periode terakhir tidak menyelesaikan seluruh saldo,
    // fee akan mengendap selamanya di 2-1300.
    const pinjamanId = await pinjamanEirKustom({ tenor: 1, satuanTenor: 'BULAN', fee: 12_000 });

    const awal = await invarian(pinjamanId);
    expect(awal.feeAwal).toBe(12_000);
    expect(awal.sisaFee).toBe(12_000);
    assertInvarian(awal);

    await bayarDanAmortisasi(pinjamanId, 0);

    const akhir = await invarian(pinjamanId);
    assertInvarian(akhir);
    expect(akhir.sisaFee).toBe(0);
    expect(akhir.amortisasi + akhir.derecognition).toBe(12_000);
  });

  test('C — tenor HARIAN: pembulatan rupiah tidak menghasilkan residu abnormal', async () => {
    // Fee 1.000 dibagi 7 periode tidak habis dibagi rata (142,857...).
    // Yang diuji: invarian tetap utuh di SETIAP periode dan tidak ada
    // sisa negatif akibat pembulatan ke rupiah.
    const pinjamanId = await pinjamanEirKustom({ tenor: 7, satuanTenor: 'HARI', fee: 1_000 });
    const jadwal = await getJadwalAngsuran(pinjamanId);
    expect(jadwal.length).toBe(7);

    for (let i = 0; i < jadwal.length; i++) {
      await bayarDanAmortisasi(pinjamanId, i);
      const inv = await invarian(pinjamanId);
      assertInvarian(inv);
      // Residu tidak boleh melampaui fee awal pada titik mana pun.
      expect(inv.sisaFee).toBeLessThanOrEqual(1_000);
    }

    const akhir = await invarian(pinjamanId);
    expect(akhir.feeAwal).toBe(1_000);
    expect(akhir.amortisasi + akhir.derecognition + akhir.sisaFee).toBe(1_000);
  });

  test('D — pembayaran SEBAGIAN: EIR tidak menciptakan fee income berlebih', async () => {
    const pinjamanId = await pinjamanEirKustom({ tenor: 12, satuanTenor: 'BULAN', fee: 12_000 });
    const jadwal = await getJadwalAngsuran(pinjamanId);

    // Bayar HANYA separuh angsuran pertama, lalu jalankan EIR.
    const baris = jadwal[0];
    await bayarAngsuran({
      pinjamanId,
      jadwalId: baris.id,
      tanggal: baris.tanggalJatuhTempo,
      nominal: Math.floor(baris.total / 2),
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await prosesEirBulanan({
      pinjamanId,
      periode: baris.tanggalJatuhTempo.slice(0, 7),
      createdBy: 'user-1',
      tanggalLaporan: `${baris.tanggalJatuhTempo.slice(0, 7)}-28`,
    });

    const inv = await invarian(pinjamanId);
    assertInvarian(inv);
    // Pembayaran sebagian TIDAK boleh mempercepat pengakuan fee.
    expect(inv.totalDiakui).toBeLessThanOrEqual(inv.feeAwal);
    expect(inv.sisaFee).toBeGreaterThan(0);
  });

  test('§7 — deferred kontraktual dan fee integral berbagi 2-1300 tetapi punya subledger terpisah', async () => {
    const { rekonsiliasiDeferredIncome } = await import('@/accounting/DeferredIncomeReconciliation');
    const pinjamanId = await pinjamanEirAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);

    // Saat baru cair: seluruh saldo 2-1300 berasal dari fee integral,
    // belum ada jasa kontraktual yang diterima dimuka.
    let rekon = await rekonsiliasiDeferredIncome(testDb as any);
    expect(rekon.subledgerFeeIntegral).toBe(12_000);
    expect(rekon.subledgerJasaKontraktual).toBe(0);
    expect(rekon.variance).toBe(0);

    // Setelah beberapa periode amortisasi, variance tetap 0.
    for (let i = 0; i < 3; i++) {
      const periode = jadwal[i].tanggalJatuhTempo.slice(0, 7);
      await prosesEirBulanan({ pinjamanId, periode, createdBy: 'user-1', tanggalLaporan: `${periode}-28` });
      rekon = await rekonsiliasiDeferredIncome(testDb as any);
      expect(rekon.variance).toBe(0);
    }

    // Dan setelah derecognition lewat pelunasan, variance tetap 0 —
    // inilah kasus yang dulu menghasilkan selisih palsu karena baris
    // EIR_DERECOGNITION tidak ikut dikurangkan.
    await lunasiPinjaman({
      pinjamanId, tanggal: '2026-05-01', sumberDana: 'KAS', createdBy: 'user-1',
      metodeJasaPelunasan: 'JASA_TERUTANG',
    });
    rekon = await rekonsiliasiDeferredIncome(testDb as any);
    expect(rekon.subledgerFeeIntegral).toBe(0);
    expect(rekon.variance).toBe(0);
  });
});

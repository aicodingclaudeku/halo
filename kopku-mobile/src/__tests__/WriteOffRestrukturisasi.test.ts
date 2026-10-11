import { createTestDb, TestDb } from './testDb';
import { formatRupiah } from '@/utils/money';

/**
 * PHASE 3 — write-off (hapusPiutangPinjaman) + akad ulang/restrukturisasi.
 * Teknik mock SAMA PERSIS dengan AkrualJasaPinjamanService.test.ts/
 * PinjamanService.test.ts — SQLite sungguhan (sql.js) lewat testDb.
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
  lunasiPinjaman,
  hapusPiutangPinjaman,
  akadUlangPinjaman,
  getJadwalAngsuran,
  getPinjamanDetail,
  getRiwayatAkadUlang,
} from '@/services/PinjamanService';
import { prosesAkrualJasaPinjaman, hitungOutstandingPiutangJasa, catatFeeIntegralPendingEir, hitungFeeIntegralPendingEir } from '@/services/AkrualJasaPinjamanService';

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
  penyisihan: 'acc-penyisihan',
  bebanPenyisihan: 'acc-beban-penyisihan',
  modal: 'acc-modal',
};

const ANGGOTA_ID = 'anggota-1';

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
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  // FINAL FIX AKRUAL (BUG 4/5/7): jasa yang kasnya diterima SEBELUM jatuh tempo
  // -> Pendapatan Diterima Dimuka (2-1300 existing), dilepas saat periode jatuh tempo.
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  // PHASE 7 FINAL FIX (permintaan pengguna) — hapusPiutangPinjaman()
  // SEKARANG otomatis memanggil derecognition EIR (no-op untuk
  // pinjaman non-EIR, tapi AKTIF untuk fixture S4 di bawah yang
  // memang memakai INTEGRAL_FINANCIAL_INSTRUMENT) — mapping ini WAJIB
  // ada supaya resolveAccountId tidak melempar error saat itu terjadi.
  await seedMapping(testDb, 'EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'PENYISIHAN_PIUTANG', 'DEBIT_BEBAN', ACC.bebanPenyisihan);
  await seedMapping(testDb, 'PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN', ACC.penyisihan);

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
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-modal-debit', 'journal-modal-awal', ACC.kas, 50_000_000);
  await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-modal-kredit', 'journal-modal-awal', ACC.modal, 50_000_000);

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

/** Pinjaman FLAT 12 bulan, jasa 100.000/bulan, dicairkan 2026-01-01, jatuh tempo pertama 2026-02-01. */
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

describe('PHASE 3 — hapusPiutangPinjaman (write-off berbasis GL)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('S1: write-off principal only (belum ada jasa yang diakru)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();

    const hasil = await hapusPiutangPinjaman({
      pinjamanId,
      tanggal: '2026-09-01', // 200+ hari dari jatuh tempo pertama (2026-02-01) -> MACET
      alasan: 'Anggota tidak dapat dilacak',
      createdBy: 'user-1',
      topUpPenyisihanJikaKurang: true,
    });

    expect(hasil.writeOffPrincipal).toBe(1_200_000);
    expect(hasil.writeOffJasa).toBe(0);
    expect(hasil.writeOffTotal).toBe(1_200_000);

    const detail = await getPinjamanDetail(pinjamanId);
    expect(detail?.status).toBe('MACET');
  });

  /**
   * REGRESSION TEST — crash pre-existing di PenghapusanPiutangFormScreen.
   *
   * Layar itu SEBELUMNYA melakukan `const { sisaPiutang } = await
   * hapusPiutangPinjaman(...)` lalu memanggil
   * `sisaPiutang.toLocaleString(...)`. Field `sisaPiutang` TIDAK PERNAH
   * ada di HapusPiutangResult, jadi hapus buku yang BERHASIL justru
   * melempar "Cannot read properties of undefined" — jurnalnya sudah
   * tercatat tapi petugas melihat pesan Gagal.
   *
   * Test ini mengunci KONTRAK RETURN yang dibaca layar tersebut: field
   * yang dipakai harus benar-benar ada, bertipe number, dan bukan
   * undefined/NaN — sehingga pemformatan nominal di layar tidak akan
   * pernah crash lagi.
   */
  test('REGRESI: kontrak return dibaca layar Penghapusan Piutang — writeOffTotal/Principal/Jasa ADA & bertipe number', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();

    const hasil = await hapusPiutangPinjaman({
      pinjamanId,
      tanggal: '2026-09-01',
      alasan: 'Anggota tidak dapat dilacak',
      createdBy: 'user-1',
      topUpPenyisihanJikaKurang: true,
    });

    // Field yang SEKARANG dibaca layar.
    for (const key of ['writeOffTotal', 'writeOffPrincipal', 'writeOffJasa'] as const) {
      expect(hasil[key]).toBeDefined();
      expect(typeof hasil[key]).toBe('number');
      expect(Number.isNaN(hasil[key])).toBe(false);
    }

    // Field yang DULU dibaca layar memang tidak pernah ada — inilah akar
    // crash-nya. Assertion ini mencegah siapa pun "memperbaiki" bug ini
    // dengan menambah field alias, alih-alih membaca field yang benar.
    expect((hasil as unknown as Record<string, unknown>).sisaPiutang).toBeUndefined();

    // Konsistensi nilai: total = pokok + jasa, dan > 0 (kalau 0, service
    // sudah menolak transaksinya lebih dulu).
    expect(hasil.writeOffTotal).toBe(hasil.writeOffPrincipal + hasil.writeOffJasa);
    expect(hasil.writeOffTotal).toBeGreaterThan(0);

    // Simulasi PERSIS operasi yang dulu melempar TypeError: memformat
    // nominal hasil write-off. Sekarang harus aman.
    expect(() => hasil.writeOffTotal.toLocaleString('id-ID')).not.toThrow();
    expect(formatRupiah(hasil.writeOffTotal)).toBe('Rp1.200.000');
  });

  test('S2: write-off principal + accrued Piutang Jasa', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    await prosesAkrualJasaPinjaman({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-02-28' });

    // KOREKSI: FLAT jasa/periode = pokok(1.200.000) x persentaseJasa(1%) = 12.000 (BUKAN 100.000 — itu nilai pokok/periode, tertukar di draft sebelumnya).
    expect(await hitungOutstandingPiutangJasa(testDb as any, pinjamanId)).toBe(12_000);

    const hasil = await hapusPiutangPinjaman({
      pinjamanId,
      tanggal: '2026-09-01',
      alasan: 'Macet total',
      createdBy: 'user-1',
      topUpPenyisihanJikaKurang: true,
    });

    expect(hasil.writeOffPrincipal).toBe(1_200_000);
    expect(hasil.writeOffJasa).toBe(12_000);
    expect(hasil.writeOffTotal).toBe(1_212_000);

    // §D: Piutang Jasa outstanding sekarang 0 (bukan dihapus diam-diam, tapi di-writeoff eksplisit).
    expect(await hitungOutstandingPiutangJasa(testDb as any, pinjamanId)).toBe(0);
  });

  test('S3: jasa kontraktual MASA DEPAN (belum pernah diakru) TIDAK ikut write-off', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    // TIDAK ada prosesAkrualJasaPinjaman() dipanggil sama sekali —
    // seluruh jasa 12 bulan (1.200.000) MASIH murni kontraktual.
    const hasil = await hapusPiutangPinjaman({
      pinjamanId,
      tanggal: '2026-09-01',
      alasan: 'Macet',
      createdBy: 'user-1',
      topUpPenyisihanJikaKurang: true,
    });

    // Hanya pokok yang di-write-off (1.200.000), BUKAN pokok + seluruh
    // jasa 12 bulan (2.400.000) — ini persis bug lama yang diperbaiki.
    expect(hasil.writeOffPrincipal).toBe(1_200_000);
    expect(hasil.writeOffJasa).toBe(0);
    expect(hasil.writeOffTotal).toBe(1_200_000);
  });

  test('S4: fee integral DEFERRED_PENDING_EIR TIDAK dianggap receivable, tidak ikut write-off, saldo tetap ada setelahnya', async () => {
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
    await testDb.runAsync(`UPDATE pinjaman SET biaya_admin_klasifikasi = 'INTEGRAL_FINANCIAL_INSTRUMENT' WHERE id = ?`, id);
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });

    expect(await hitungFeeIntegralPendingEir(testDb as any, id)).toBe(50_000);

    const hasil = await hapusPiutangPinjaman({
      pinjamanId: id,
      tanggal: '2026-09-01',
      alasan: 'Macet',
      createdBy: 'user-1',
      topUpPenyisihanJikaKurang: true,
    });

    // Fee integral TIDAK ikut writeOffJasa/writeOffTotal sama sekali
    // (tetap benar, TIDAK berubah — write-off principal/jasa TIDAK
    // pernah menganggap fee integral sebagai piutang).
    expect(hasil.writeOffPrincipal).toBe(1_000_000);
    expect(hasil.writeOffJasa).toBe(0);
    // PHASE 7 FINAL FIX (permintaan pengguna §2/§5/§10): SEBELUM final
    // fix ini, saldo fee integral dibiarkan tetap 50.000 (DEFERRED_
    // PENDING_EIR) SELAMANYA setelah write-off — itu PERSIS masalah
    // yang diperbaiki instruksi ini ("Jangan meninggalkan
    // DEFERRED_PENDING_EIR setelah loan benar-benar WRITE-OFF").
    // SEKARANG hapusPiutangPinjaman() otomatis men-derecognize sisa
    // fee (lihat EirAccountingService.deselesaikanFeeEirDiDalamTransaksi)
    // — saldo pending HARUS 0, bukan 50.000 lagi. Nilai yang di-
    // derecognize muncul di `hasil.eirFeeDiselesaikan`.
    expect(hasil.eirFeeDiselesaikan).toBe(50_000);
    expect(await hitungFeeIntegralPendingEir(testDb as any, id)).toBe(0);
  });

  test('S5: penyisihan CUKUP — tidak ada jurnal top-up dibuat', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();

    // Isi penyisihan lebih dulu (Dr Beban / Cr Penyisihan) sampai cukup.
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('journal-pys-awal','JRN-PYS','2026-08-01','period-2026','PENYISIHAN_PIUTANG','Penyisihan awal','POSTED','user-1',?,?,?)`,
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString()
    );
    await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-pys-1', 'journal-pys-awal', ACC.bebanPenyisihan, 2_000_000);
    await testDb.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-pys-2', 'journal-pys-awal', ACC.penyisihan, 2_000_000);

    const jurnalSebelum = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);

    const hasil = await hapusPiutangPinjaman({
      pinjamanId,
      tanggal: '2026-09-01',
      alasan: 'Macet',
      createdBy: 'user-1',
      // TIDAK topUpPenyisihanJikaKurang — seharusnya tidak perlu karena penyisihan sudah cukup.
    });
    expect(hasil.penyisihanTopUpJournalId).toBeNull();
    expect(hasil.penyisihanTopUpJumlah).toBe(0);

    const jurnalSesudah = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    // Hanya SATU jurnal baru (write-off) — bukan dua (tidak ada top-up).
    expect(jurnalSesudah!.cnt).toBe(jurnalSebelum!.cnt + 1);
  });

  test('S6: penyisihan TIDAK CUKUP dan topUpPenyisihanJikaKurang=false -> DITOLAK, tidak ada perubahan apa pun', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();

    await expect(
      hapusPiutangPinjaman({ pinjamanId, tanggal: '2026-09-01', alasan: 'Macet', createdBy: 'user-1' })
    ).rejects.toThrow(/[Pp]enyisihan/);

    const detail = await getPinjamanDetail(pinjamanId);
    expect(detail?.status).toBe('AKTIF'); // TIDAK berubah — ditolak sebelum ada efek apa pun
    const jadwal = await getJadwalAngsuran(pinjamanId);
    expect(jadwal.every((j) => j.status === 'BELUM_BAYAR')).toBe(true); // tidak ada yang DIHAPUSBUKU
  });

  test('S6b: penyisihan tidak cukup DAN topUpPenyisihanJikaKurang=true -> top-up otomatis lewat mapping existing, lalu write-off berhasil', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();

    const hasil = await hapusPiutangPinjaman({
      pinjamanId,
      tanggal: '2026-09-01',
      alasan: 'Macet',
      createdBy: 'user-1',
      topUpPenyisihanJikaKurang: true,
    });

    expect(hasil.penyisihanTopUpJournalId).toBeTruthy();
    expect(hasil.penyisihanTopUpJumlah).toBe(1_200_000);

    const topUpEntries = await testDb.getAllAsync<{ account_id: string; debit: number; kredit: number }>(
      `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ?`,
      hasil.penyisihanTopUpJournalId
    );
    expect(topUpEntries.find((e) => e.account_id === ACC.bebanPenyisihan)?.debit).toBe(1_200_000);
    expect(topUpEntries.find((e) => e.account_id === ACC.penyisihan)?.kredit).toBe(1_200_000);
  });

  test('S8: write-off DUPLIKAT ditolak (idempotency)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await hapusPiutangPinjaman({ pinjamanId, tanggal: '2026-09-01', alasan: 'Pertama', createdBy: 'user-1', topUpPenyisihanJikaKurang: true });

    await expect(
      hapusPiutangPinjaman({ pinjamanId, tanggal: '2026-09-02', alasan: 'Kedua', createdBy: 'user-1', topUpPenyisihanJikaKurang: true })
    ).rejects.toThrow(/sudah pernah dihapusbukukan/);
  });

  test('S9: installment BELUM_BAYAR berubah menjadi DIHAPUSBUKU, historical TETAP ADA (tidak dihapus)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await hapusPiutangPinjaman({ pinjamanId, tanggal: '2026-09-01', alasan: 'Macet', createdBy: 'user-1', topUpPenyisihanJikaKurang: true });

    const jadwal = await getJadwalAngsuran(pinjamanId);
    expect(jadwal.length).toBe(12); // tidak ada yang dihapus
    expect(jadwal.every((j) => j.status === 'DIHAPUSBUKU')).toBe(true);
  });

  test('S10: akrual bulanan berhenti setelah write-off (status pinjaman MACET, bukan AKTIF)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await hapusPiutangPinjaman({ pinjamanId, tanggal: '2026-09-01', alasan: 'Macet', createdBy: 'user-1', topUpPenyisihanJikaKurang: true });

    const jadwal = await getJadwalAngsuran(pinjamanId);
    const hasil = await prosesAkrualJasaPinjaman({
      pinjamanId,
      periode: jadwal[5].tanggalJatuhTempo.slice(0, 7), // periode yang belum pernah diakru
      createdBy: 'user-1',
      tanggalLaporan: '2026-09-01',
    });
    expect(hasil.dibuat).toBe(false);
    // EXPECTED VALUE DIPERBARUI, dengan alasan domain: expected LAMA
    // (/AKTIF/) mencocokkan teks pesan versi lama. Pesan yang dihasilkan
    // AkrualJasaPinjamanService sekarang menyebutkan status pinjaman yang
    // SEBENARNYA ("Pinjaman berstatus \"MACET\", tidak diakrualkan."),
    // yang justru lebih informatif. Perilakunya sendiri TIDAK berubah dan
    // memang yang diuji: akrual BERHENTI setelah write-off (dibuat=false).
    // Assertion baru menguji substansi itu (status MACET + tidak
    // diakrualkan), bukan kata "AKTIF" yang kebetulan pernah muncul.
    expect(hasil.dilewati).toMatch(/MACET/);
    expect(hasil.dilewati).toMatch(/tidak diakrualkan/);
  });

  test('S11/S14: jurnal write-off balance & GL reconciliation setelah write-off (saldo Piutang Pokok+Jasa = 0)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    await prosesAkrualJasaPinjaman({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-02-28' });

    const hasil = await hapusPiutangPinjaman({ pinjamanId, tanggal: '2026-09-01', alasan: 'Macet', createdBy: 'user-1', topUpPenyisihanJikaKurang: true });

    const entries = await testDb.getAllAsync<{ debit: number; kredit: number }>(`SELECT debit, kredit FROM journal_entry WHERE journal_id = ?`, hasil.journalId);
    const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
    const totalKredit = entries.reduce((s, e) => s + e.kredit, 0);
    expect(totalDebit).toBe(totalKredit); // balance

    const glPokok = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(je.debit - je.kredit),0) as total FROM journal_entry je JOIN journal j ON j.id = je.journal_id WHERE j.sumber_id = ? AND je.account_id = ? AND j.status = 'POSTED'`,
      pinjamanId,
      ACC.piutangPokok
    );
    const glJasa = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(je.debit - je.kredit),0) as total FROM journal_entry je JOIN journal j ON j.id = je.journal_id WHERE j.sumber_id = ? AND je.account_id = ? AND j.status = 'POSTED'`,
      pinjamanId,
      ACC.piutangJasa
    );
    expect(glPokok?.total).toBe(0);
    expect(glJasa?.total).toBe(0);
  });

  test('DITOLAK kalau belum ada RAT untuk tahun buku terkait', async () => {
    await testDb.runAsync(`DELETE FROM rat WHERE id = 'rat-2026'`);
    const pinjamanId = await pinjamanAktif12Bulan();
    await expect(
      hapusPiutangPinjaman({ pinjamanId, tanggal: '2026-09-01', alasan: 'Macet', createdBy: 'user-1', topUpPenyisihanJikaKurang: true })
    ).rejects.toThrow(/Rapat Anggota Tahunan/);
  });

  test('DITOLAK kalau kolektibilitas belum MACET', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await expect(
      hapusPiutangPinjaman({ pinjamanId, tanggal: '2026-02-15', alasan: 'Coba', createdBy: 'user-1', topUpPenyisihanJikaKurang: true })
    ).rejects.toThrow(/kolektibilitas Macet/);
  });
});

describe('PHASE 3 — akadUlangPinjaman (restrukturisasi dengan audit trail historis)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('T5/T6: Piutang Jasa yang sudah diakui TETAP BENAR setelah restrukturisasi, future jasa TIDAK menjadi receivable', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    await prosesAkrualJasaPinjaman({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-02-28' });

    const outstandingSebelum = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
    // KOREKSI: FLAT jasa/periode = 1.200.000 x 1% = 12.000 (bukan 100.000, tertukar dgn pokok/periode di draft sebelumnya).
    expect(outstandingSebelum).toBe(12_000);

    const hasil = await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-06-01',
      tenorBaru: 6,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'MENURUN',
      persentaseJasaBaru: 1.5,
      actingUserId: 'user-1',
    });

    // §N: Piutang Jasa yang sudah diakui TIDAK hilang.
    const outstandingSesudah = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
    expect(outstandingSesudah).toBe(12_000);

    // §N: future jasa (jadwal baru) belum pernah diakru -> TIDAK menjadi Piutang Jasa hanya karena restrukturisasi.
    expect(outstandingSesudah).not.toBe(outstandingSebelum + hasil.sisaPokok); // bukan digabung jadi satu angka besar

    const riwayat = await getRiwayatAkadUlang(pinjamanId);
    expect(riwayat[0].outstandingPiutangJasa).toBe(12_000); // snapshot audit tercatat benar
  });

  test('T8: TIDAK ADA double income — total Pendapatan Jasa tidak berubah akibat restrukturisasi', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    await prosesAkrualJasaPinjaman({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-02-28' });

    const pendapatanSebelum = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.pendapatanJasa
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

    const pendapatanSesudah = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`,
      ACC.pendapatanJasa
    );
    expect(pendapatanSesudah?.total).toBe(pendapatanSebelum?.total); // TIDAK bertambah — tidak ada jurnal baru dari akad ulang
  });

  test('T9/T10: pembayaran setelah restrukturisasi masuk jadwal BARU; pembayaran ke jadwal LAMA (DIRESTRUKTURISASI) ditolak', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwalLama = await getJadwalAngsuran(pinjamanId);

    await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-06-01',
      tenorBaru: 6,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });

    // T10: bayar ke jadwal LAMA (sekarang DIRESTRUKTURISASI) -> ditolak.
    await expect(
      bayarAngsuran({
        pinjamanId,
        jadwalId: jadwalLama[0].id,
        tanggal: '2026-06-05',
        nominal: 50_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/akad ulang/);

    // T9: bayar ke jadwal BARU -> berhasil normal.
    const jadwalSesudah = await getJadwalAngsuran(pinjamanId);
    const jadwalBaru = jadwalSesudah.find((j) => j.status === 'BELUM_BAYAR')!;
    const hasilBayar = await bayarAngsuran({
      pinjamanId,
      jadwalId: jadwalBaru.id,
      tanggal: '2026-06-05',
      nominal: jadwalBaru.total,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    expect(hasilBayar.journalId).toBeTruthy();

    const jadwalTerbaru = await getJadwalAngsuran(pinjamanId);
    expect(jadwalTerbaru.find((j) => j.id === jadwalBaru.id)?.status).toBe('LUNAS');
  });

  test('T11: akad ulang KEDUA pada jadwal baru hasil akad ulang pertama — histori bertingkat tetap konsisten', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();

    const akadPertama = await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-06-01',
      tenorBaru: 6,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });

    const akadKedua = await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-08-01',
      tenorBaru: 4,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });

    expect(akadKedua.akadUlangId).not.toBe(akadPertama.akadUlangId);

    const seluruh = await getJadwalAngsuran(pinjamanId);
    // 12 asli (DIRESTRUKTURISASI oleh akad 1) + 6 dari akad 1 (semua DIRESTRUKTURISASI oleh akad 2) + 4 dari akad 2 (BELUM_BAYAR) = 22
    expect(seluruh.length).toBe(22);
    const aktifSekarang = seluruh.filter((j) => j.status === 'BELUM_BAYAR');
    expect(aktifSekarang.length).toBe(4);

    const riwayat = await getRiwayatAkadUlang(pinjamanId);
    expect(riwayat.length).toBe(2);
  });

  test('T12/T13: akad ulang TIDAK membuat jurnal apa pun & Piutang Jasa tetap reconcile dengan GL', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    await prosesAkrualJasaPinjaman({ pinjamanId, periode: jadwal[0].tanggalJatuhTempo.slice(0, 7), createdBy: 'user-1', tanggalLaporan: '2026-02-28' });

    const jurnalSebelum = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-06-01',
      tenorBaru: 6,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });
    const jurnalSesudah = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
    expect(jurnalSesudah!.cnt).toBe(jurnalSebelum!.cnt); // tidak ada jurnal baru

    const outstandingFormula = await hitungOutstandingPiutangJasa(testDb as any, pinjamanId);
    const glJasa = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(je.debit - je.kredit),0) as total FROM journal_entry je JOIN journal j ON j.id = je.journal_id WHERE j.sumber_id = ? AND je.account_id = ? AND j.status = 'POSTED'`,
      pinjamanId,
      ACC.piutangJasa
    );
    expect(outstandingFormula).toBe(glJasa?.total); // tetap reconcile
  });

  test('T14: audit_log tersedia untuk setiap akad ulang', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await akadUlangPinjaman({
      pinjamanId,
      tanggal: '2026-06-01',
      tenorBaru: 6,
      satuanTenorBaru: 'BULAN',
      metodeJasaBaru: 'FLAT',
      persentaseJasaBaru: 1,
      actingUserId: 'user-1',
    });
    const audit = await testDb.getAllAsync<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity_id = ? AND action = 'AKAD_ULANG'`,
      pinjamanId
    );
    expect(audit.length).toBe(1);
  });

  test('§Q: akad ulang DITOLAK untuk pinjaman yang sudah write-off (MACET)', async () => {
    const pinjamanId = await pinjamanAktif12Bulan();
    await hapusPiutangPinjaman({ pinjamanId, tanggal: '2026-09-01', alasan: 'Macet', createdBy: 'user-1', topUpPenyisihanJikaKurang: true });

    await expect(
      akadUlangPinjaman({
        pinjamanId,
        tanggal: '2026-09-05',
        tenorBaru: 6,
        satuanTenorBaru: 'BULAN',
        metodeJasaBaru: 'FLAT',
        persentaseJasaBaru: 1,
        actingUserId: 'user-1',
      })
    ).rejects.toThrow(/AKTIF/);
  });
});

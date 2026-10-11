import { createTestDb, TestDb } from './testDb';

/**
 * RC-S17 — ANGSURAN PINJAMAN vs LAPORAN ARUS KAS.
 *
 * Dua hal yang dijamin berkas ini, dan keduanya pernah gagal di
 * perangkat:
 *
 *  1. `ANGSURAN_PINJAMAN` — nilai `sumber_transaksi` yang TIDAK
 *     diproduksi source mana pun di RC-S16 (diverifikasi: pencarian di
 *     seluruh `src/` & `app/` nihil), tetapi ADA di basis data yang
 *     ditulis versi aplikasi terdahulu / hasil restore backup lama.
 *     `getArusKas()` menolak membuat laporan begitu bertemu nilai ini.
 *
 *  2. `ANGSURAN_POKOK` — sumber KANONIK yang benar-benar diproduksi
 *     `PinjamanService.bayarAngsuran()` hari ini. Diuji lewat transaksi
 *     angsuran SUNGGUHAN (ajukan -> jadwal -> cairkan -> bayar), bukan
 *     jurnal yang ditempel manual, supaya yang diuji adalah jurnal yang
 *     benar-benar dibuat aplikasi.
 *
 * Yang TIDAK diuji di sini karena memang tidak boleh berubah: nominal
 * jurnal, alokasi pembayaran, saldo pinjaman. Berkas ini hanya
 * menyatakan bahwa laporan arus kas SANGGUP memproses angsuran —
 * bukan mengubah cara angsuran dibukukan.
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
  simpanJadwalAngsuranCustom,
  cairkanPinjaman,
  bayarAngsuran,
  getJadwalAngsuran,
} from '@/services/PinjamanService';
import { getArusKas } from '@/reports/FinancialReports';
import {
  classifyTransactionSource,
  classifyTransaction,
  CASH_FLOW_CLASSIFICATION,
  UnknownCashFlowClassificationError,
} from '@/accounting/CashFlowClassification';

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

/**
 * Fixture memakai `MODAL_UANG` untuk modal awal kas — BUKAN nilai
 * bebas. `getArusKas()` mengklasifikasikan SETIAP baris jurnal pada
 * akun Kas/Bank, jadi jurnal pembuka fixture pun wajib memakai sumber
 * transaksi yang benar-benar ada di peta klasifikasi. Kalau tidak,
 * yang gagal adalah fixture-nya, bukan kode yang diuji.
 */
async function setupFixture(): Promise<void> {
  testDb = await createTestDb();
  const now = new Date().toISOString();

  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutang, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutang);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'PELUNASAN_JASA_FUTURE', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'PELUNASAN_PENALTI', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'PELUNASAN_ADMINISTRASI', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin);

  await testDb.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026',
    2026,
    '2026-01-01',
    '2026-12-31'
  );

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

  // Modal awal kas — sumber transaksi MODAL_UANG (PENDANAAN di peta).
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-modal-awal','JRN-MODAL-AWAL','2026-01-01','period-2026','MODAL_UANG','Modal awal (fixture test)','POSTED','user-1',?,?,?)`,
    now,
    now,
    now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`,
    'je-modal-awal-debit',
    'journal-modal-awal',
    ACC.kas,
    50_000_000
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`,
    'je-modal-awal-kredit',
    'journal-modal-awal',
    ACC.modal,
    50_000_000
  );

  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('simpanan-pokok-fixture',?, 'POKOK','SETOR','2020-01-01',100000,'KAS','SP-FIXTURE','user-1',?)`,
    ANGGOTA_ID,
    now
  );
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES ('simpanan-wajib-fixture',?, 'WAJIB','SETOR','2020-01-01',50000,'KAS','SW-FIXTURE','user-1',?)`,
    ANGGOTA_ID,
    now
  );
}

/**
 * Menyisipkan SATU jurnal bergaya versi lama: sumber transaksi
 * `ANGSURAN_PINJAMAN`, Dr Kas / Cr Piutang. Ini meniru baris yang sudah
 * TERLANJUR ADA di basis data produksi — bukan jalur yang bisa dibuat
 * aplikasi hari ini, dan memang tidak boleh bisa.
 */
async function sisipkanJurnalAngsuranLegacy(nominal: number, tanggal = '2026-03-01') {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('journal-legacy-angsuran','JRN-LEGACY-AGS',?,'period-2026','ANGSURAN_PINJAMAN','Angsuran pinjaman (data versi lama)','POSTED','user-1',?,?,?)`,
    tanggal,
    now,
    now,
    now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`,
    'je-legacy-angsuran-debit',
    'journal-legacy-angsuran',
    ACC.kas,
    nominal
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`,
    'je-legacy-angsuran-kredit',
    'journal-legacy-angsuran',
    ACC.piutang,
    nominal
  );
}

describe('RC-S17 — ANGSURAN_PINJAMAN (nilai historis) punya klasifikasi kanonik', () => {
  test('terklasifikasi OPERASI, mengikuti kebijakan arus pinjaman anggota yang sudah berlaku', () => {
    expect(classifyTransactionSource('ANGSURAN_PINJAMAN')).toBe('OPERASI');
  });

  test('konsisten dengan sumber KANONIK ANGSURAN_POKOK — bukan kategori yang berdiri sendiri', () => {
    expect(classifyTransactionSource('ANGSURAN_PINJAMAN')).toBe(
      classifyTransactionSource('ANGSURAN_POKOK')
    );
  });

  test('BUKAN NON_KAS — jurnalnya menggerakkan Kas/Bank, jadi klaim non-kas mustahil benar', () => {
    expect(CASH_FLOW_CLASSIFICATION['ANGSURAN_PINJAMAN']).not.toBe('NON_KAS');
    // classifyTransaction() dipanggil HANYA untuk baris kas/bank; kalau
    // klasifikasinya NON_KAS ia akan melempar. Tidak melempar =
    // klasifikasinya cocok dengan kenyataan jurnalnya.
    expect(classifyTransaction('ANGSURAN_PINJAMAN')).toBe('OPERASI');
  });

  test('tidak ada alias duplikat yang dibuat untuk menambalnya', () => {
    expect(CASH_FLOW_CLASSIFICATION['ANGSURAN_PINJAMAN_2']).toBeUndefined();
    expect(CASH_FLOW_CLASSIFICATION['ANGSURAN']).toBeUndefined();
    // ANGSURAN_POKOK tetap ada & tetap sumber kanoniknya.
    expect(CASH_FLOW_CLASSIFICATION['ANGSURAN_POKOK']).toBe('OPERASI');
  });
});

describe('RC-S17 — Laporan Arus Kas sanggup memproses angsuran pinjaman', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('jurnal ANGSURAN_PINJAMAN dari data versi lama TIDAK lagi menggagalkan getArusKas()', async () => {
    await sisipkanJurnalAngsuranLegacy(630_000);

    const hasil = await getArusKas(testDb as never, '2026-01-01', '2026-12-31');

    // Ini yang dulu melempar UnknownCashFlowClassificationError.
    expect(hasil.rincian.some((r) => r.jumlah === 630_000 && r.aktivitas === 'OPERASI')).toBe(true);
    expect(hasil.operasi).toBe(630_000);
    expect(hasil.pendanaan).toBe(50_000_000); // modal awal
    expect(hasil.terekonsiliasi).toBe(true);
  });

  test('angsuran SUNGGUHAN lewat bayarAngsuran() masuk laporan tanpa error klasifikasi', async () => {
    const { id: pinjamanId } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 1_000_000,
      tenor: 2,
      satuanTenor: 'BULAN',
      metodeJasa: 'CUSTOM',
      persentaseJasa: 0,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await simpanJadwalAngsuranCustom({
      pinjamanId,
      baris: [
        { nomorAngsuran: 1, tanggalJatuhTempo: '2026-02-01', pokok: 600_000, jasa: 30_000 },
        { nomorAngsuran: 2, tanggalJatuhTempo: '2026-03-01', pokok: 400_000, jasa: 20_000 },
      ],
      createdBy: 'user-1',
    });
    await cairkanPinjaman({ pinjamanId, sumberDana: 'KAS', approvedBy: 'user-1' });

    const jadwal = await getJadwalAngsuran(pinjamanId);
    await bayarAngsuran({
      pinjamanId,
      jadwalId: jadwal[0].id,
      tanggal: '2026-02-01',
      nominal: 630_000,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const hasil = await getArusKas(testDb as never, '2026-01-01', '2026-12-31');

    // Pencairan (kas keluar 1.000.000) & angsuran (kas masuk 630.000)
    // dua-duanya OPERASI menurut kebijakan KOPKU untuk pinjaman anggota.
    expect(hasil.rincian.some((r) => r.jumlah === -1_000_000 && r.aktivitas === 'OPERASI')).toBe(true);
    expect(hasil.rincian.some((r) => r.jumlah === 630_000 && r.aktivitas === 'OPERASI')).toBe(true);
    expect(hasil.operasi).toBe(-370_000);
    expect(hasil.investasi).toBe(0);
    expect(hasil.terekonsiliasi).toBe(true);
    expect(hasil.selisihRekonsiliasi).toBe(0);
  });

  test('sumber transaksi yang benar-benar tak dikenal TETAP menggagalkan laporan (tidak diam-diam OPERASI)', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES ('journal-aneh','JRN-ANEH','2026-04-01','period-2026','SUMBER_YANG_TIDAK_PERNAH_ADA','Uji',
               'POSTED','user-1',?,?,?)`,
      now,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-aneh-d','journal-aneh',?,100000,0)`,
      ACC.kas
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-aneh-k','journal-aneh',?,0,100000)`,
      ACC.modal
    );

    await expect(getArusKas(testDb as never, '2026-01-01', '2026-12-31')).rejects.toBeInstanceOf(
      UnknownCashFlowClassificationError
    );
  });
});

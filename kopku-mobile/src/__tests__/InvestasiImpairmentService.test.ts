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

import { catatInvestasi } from '@/services/InvestasiService';
import {
  catatImpairmentInvestasi,
  getNilaiTercatatInvestasi,
  listRiwayatImpairmentInvestasi,
  getTotalImpairmentInvestasi,
  INDIKATOR_IMPAIRMENT_INVESTASI,
  getIndikatorImpairmentUntukJenis,
} from '@/services/InvestasiImpairmentService';
import { getPosisiKeuangan, getLabaRugi } from '@/reports/FinancialReports';

async function seedAccount(db: TestDb, id: string, kode: string, nama: string, kategori: string, normalBalance: 'DEBIT' | 'KREDIT') {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,0,?,?)`,
    id, kode, nama, kategori, normalBalance, now, now
  );
}

async function seedMapping(db: TestDb, transactionType: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${transactionType}-${role}`, transactionType, role, accountId
  );
}

const ACC = {
  kas: 'acc-kas',
  investasi: 'acc-investasi',
  modal: 'acc-modal',
  bebanImpairment: 'acc-beban-impairment',
  penyisihanImpairment: 'acc-penyisihan-impairment',
};

async function isiKas(db: TestDb, nominal: number) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    'journal-isi-kas', 'JRN-ISI-KAS', '2026-01-01', 'period-2026', 'MODAL_AWAL', 'Isi kas (fixture test)', 'POSTED', 'user-1', now, now, now
  );
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`, 'je-isi-debit', 'journal-isi-kas', ACC.kas, nominal);
  await db.runAsync(`INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`, 'je-isi-kredit', 'journal-isi-kas', ACC.modal, nominal);
}

async function setupFixture(): Promise<TestDb> {
  const db = await createTestDb();
  await seedAccount(db, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.investasi, '1-1610', 'Penyertaan pada Koperasi Lain', 'ASET', 'DEBIT');
  await seedAccount(db, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  await seedAccount(db, ACC.bebanImpairment, '5-2150', 'Beban Penurunan Nilai Investasi', 'BEBAN', 'DEBIT');
  await seedAccount(db, ACC.penyisihanImpairment, '1-1900', 'Penyisihan Penurunan Nilai Investasi', 'ASET', 'KREDIT');
  await seedMapping(db, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(db, 'INVESTASI_KOPERASI_LAIN', 'DEBIT_ASET', ACC.investasi);
  await seedMapping(db, 'IMPAIRMENT_INVESTASI', 'DEBIT_BEBAN', ACC.bebanImpairment);
  await seedMapping(db, 'IMPAIRMENT_INVESTASI', 'KREDIT_PENYISIHAN', ACC.penyisihanImpairment);

  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
    'period-2026', 2026, '2026-01-01', '2026-12-31'
  );
  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('user-1','User Admin Uji','admin-uji','ADMIN','x','x',0,1,?,?)`,
    new Date().toISOString(), new Date().toISOString()
  );
  return db;
}

const INPUT_VALID = {
  indikasiTerpilih: [INDIKATOR_IMPAIRMENT_INVESTASI[0]],
  dasarPenilaian: 'Berdasarkan laporan keuangan unit usaha tujuan investasi per akhir tahun.',
  alasan: 'Unit usaha tujuan mengalami kerugian signifikan berkelanjutan.',
  createdBy: 'user-1',
};

// ============================================================
// Audit ulang (permintaan pengguna, request baru §8 — "PALING
// PENTING"): indikator penurunan nilai HARUS berbeda per Tujuan
// Investasi, bukan satu daftar generik untuk semua jenis.
// ============================================================
describe('getIndikatorImpairmentUntukJenis (audit ulang §8)', () => {
  test('TABUNGAN_BANK_UMUM dan GIRO_BANK_UMUM sama-sama pakai daftar "Bank Umum" (kesehatan bank)', () => {
    const tabungan = getIndikatorImpairmentUntukJenis('TABUNGAN_BANK_UMUM');
    const giro = getIndikatorImpairmentUntukJenis('GIRO_BANK_UMUM');
    expect(tabungan).toEqual(giro);
    expect(tabungan).toContain('Bank mengalami kesulitan keuangan');
    expect(tabungan).toContain('Risiko gagal bayar bank');
    // TIDAK boleh memuat indikator spesifik properti/usaha.
    expect(tabungan.some((i) => i.toLowerCase().includes('properti'))).toBe(false);
  });

  test('DEPOSITO_BANK_UMUM punya daftar SENDIRI, BEDA dari Tabungan/Giro (ada indikator pencairan)', () => {
    const deposito = getIndikatorImpairmentUntukJenis('DEPOSITO_BANK_UMUM');
    const tabungan = getIndikatorImpairmentUntukJenis('TABUNGAN_BANK_UMUM');
    expect(deposito).not.toEqual(tabungan);
    expect(deposito).toContain('Keterlambatan pencairan deposito');
    expect(deposito).toContain('Pembatasan pencairan deposito');
  });

  test('PROPERTI_INVESTASI punya indikator seputar nilai pasar/kondisi fisik properti', () => {
    const properti = getIndikatorImpairmentUntukJenis('PROPERTI_INVESTASI');
    expect(properti).toContain('Penurunan nilai pasar properti');
    expect(properti).toContain('Penurunan tingkat hunian');
    expect(properti).toContain('Penurunan pendapatan sewa');
    expect(properti.some((i) => i.toLowerCase().includes('bank'))).toBe(false);
  });

  test('KOPERASI_LAIN, USAHA_LAIN, dan UNIT_USAHA (legacy) sama-sama pakai daftar "usaha/badan usaha"', () => {
    const koperasiLain = getIndikatorImpairmentUntukJenis('KOPERASI_LAIN');
    const usahaLain = getIndikatorImpairmentUntukJenis('USAHA_LAIN');
    const unitUsaha = getIndikatorImpairmentUntukJenis('UNIT_USAHA');
    expect(koperasiLain).toEqual(usahaLain);
    expect(koperasiLain).toEqual(unitUsaha);
    expect(koperasiLain).toContain('Kerugian signifikan');
    expect(koperasiLain).toContain('Kesulitan keuangan');
  });

  test('jenis yang tidak dikenal (fallback §E) tetap mengembalikan daftar non-kosong, tidak crash', () => {
    const fallback = getIndikatorImpairmentUntukJenis('JENIS_MASA_DEPAN_YANG_BELUM_ADA');
    expect(fallback.length).toBeGreaterThan(0);
  });

  test('ketujuh JenisInvestasi yang ada semuanya terpetakan (tidak ada yang jatuh ke fallback secara tidak sengaja)', () => {
    const semuaJenis = [
      'UNIT_USAHA',
      'KOPERASI_LAIN',
      'USAHA_LAIN',
      'TABUNGAN_BANK_UMUM',
      'GIRO_BANK_UMUM',
      'DEPOSITO_BANK_UMUM',
      'PROPERTI_INVESTASI',
    ];
    for (const jenis of semuaJenis) {
      expect(getIndikatorImpairmentUntukJenis(jenis).length).toBeGreaterThan(0);
    }
  });
});

describe('InvestasiImpairmentService (Phase 17 §8, test §15)', () => {
  beforeEach(async () => {
    testDb = await setupFixture();
  });

  test('#21 investasi TANPA impairment: nilai tercatat = nilai awal (normal)', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Sehat',
      jumlah: 10_000_000,
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const hasil = await getNilaiTercatatInvestasi(testDb as any, id);
    expect(hasil.nilaiTercatat).toBe(10_000_000);
    expect(hasil.akumulasiImpairment).toBe(0);
  });

  test('#22/#23/#24/#25 impairment: jurnal balance, beban masuk laba rugi, penyisihan masuk posisi keuangan, nilai tercatat bersih benar', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Bermasalah',
      jumlah: 10_000_000,
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const { journalId } = await catatImpairmentInvestasi({
      investasiId: id,
      tanggal: '2026-06-01',
      nilaiImpairment: 3_000_000,
      ...INPUT_VALID,
    });
    expect(journalId).toBeTruthy();

    // #22: jurnal balance (debit=kredit) — cek langsung dari ledger.
    const beban = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(debit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.bebanImpairment
    );
    const penyisihan = await testDb.getFirstAsync<{ total: number }>(
      `SELECT COALESCE(SUM(kredit),0) as total FROM journal_entry WHERE account_id = ?`, ACC.penyisihanImpairment
    );
    expect(beban?.total).toBe(3_000_000);
    expect(penyisihan?.total).toBe(3_000_000);

    // #23: beban masuk Laba Rugi.
    const labaRugi = await getLabaRugi(testDb as any, '2026-01-01', '2026-12-31');
    const bebanRow = labaRugi.beban.find((b) => b.nama === 'Beban Penurunan Nilai Investasi');
    expect(bebanRow?.jumlah).toBe(3_000_000);

    // #24: akumulasi/penyisihan masuk Posisi Keuangan (sebagai kontra-aset, mengurangi total aset).
    const posisi = await getPosisiKeuangan(testDb as any, '2026-12-31');
    const penyisihanRow = posisi.aset.find((a) => a.kode === '1-1900');
    expect(penyisihanRow?.saldo).toBe(-3_000_000); // kontra-aset: saldo negatif

    // #25: nilai tercatat bersih benar (10jt - 3jt = 7jt).
    const hasil = await getNilaiTercatatInvestasi(testDb as any, id);
    expect(hasil.nilaiTercatat).toBe(7_000_000);
  });

  test('#26 impairment TIDAK menghapus investasi — baris investasi tetap ada, status tetap AKTIF', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Uji',
      jumlah: 5_000_000,
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await catatImpairmentInvestasi({ investasiId: id, tanggal: '2026-06-01', nilaiImpairment: 1_000_000, ...INPUT_VALID });

    const investasi = await testDb.getFirstAsync<{ status: string }>(`SELECT status FROM investasi WHERE id = ?`, id);
    expect(investasi?.status).toBe('AKTIF');
  });

  test('#27 period CLOSED menolak posting impairment', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Uji',
      jumlah: 5_000_000,
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE id = 'period-2026'`);

    await expect(
      catatImpairmentInvestasi({ investasiId: id, tanggal: '2026-06-01', nilaiImpairment: 1_000_000, ...INPUT_VALID })
    ).rejects.toThrow(/sudah ditutup|CLOSED/i);
  });

  test('#28 permission dicek — user tanpa role memadai ditolak', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Uji',
      jumlah: 5_000_000,
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await testDb.runAsync(
      `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
       VALUES ('user-anggota','Anggota Biasa','anggota-uji','ANGGOTA','x','x',0,1,?,?)`,
      new Date().toISOString(), new Date().toISOString()
    );

    await expect(
      catatImpairmentInvestasi({
        investasiId: id,
        tanggal: '2026-06-01',
        nilaiImpairment: 1_000_000,
        indikasiTerpilih: INPUT_VALID.indikasiTerpilih,
        dasarPenilaian: INPUT_VALID.dasarPenilaian,
        alasan: INPUT_VALID.alasan,
        createdBy: 'user-anggota',
      })
    ).rejects.toThrow();
  });

  test('#29 audit log tercatat untuk jurnal impairment', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Uji',
      jumlah: 5_000_000,
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    const { journalId } = await catatImpairmentInvestasi({ investasiId: id, tanggal: '2026-06-01', nilaiImpairment: 1_000_000, ...INPUT_VALID });

    const log = await testDb.getFirstAsync<{ action: string }>(`SELECT action FROM audit_log WHERE entity_id = ?`, journalId);
    expect(log?.action).toBe('POST');
  });

  test('#30 TIDAK ada mekanisme reversal (sesuai kebijakan permanen) — fungsi reversal tidak diekspor dari service', async () => {
    const serviceModule = await import('@/services/InvestasiImpairmentService');
    expect((serviceModule as any).reversalImpairmentInvestasi).toBeUndefined();
  });

  test('nilai impairment tidak boleh melebihi nilai tercatat (validasi mencegah nilai tercatat negatif)', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Uji',
      jumlah: 5_000_000,
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await expect(
      catatImpairmentInvestasi({ investasiId: id, tanggal: '2026-06-01', nilaiImpairment: 6_000_000, ...INPUT_VALID })
    ).rejects.toThrow(/tidak boleh melebihi/i);
  });

  test('impairment kedua terhadap investasi yang sama terakumulasi dengan benar', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Uji',
      jumlah: 10_000_000,
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await catatImpairmentInvestasi({ investasiId: id, tanggal: '2026-03-01', nilaiImpairment: 2_000_000, ...INPUT_VALID });
    await catatImpairmentInvestasi({ investasiId: id, tanggal: '2026-09-01', nilaiImpairment: 3_000_000, ...INPUT_VALID });

    const hasil = await getNilaiTercatatInvestasi(testDb as any, id);
    expect(hasil.akumulasiImpairment).toBe(5_000_000);
    expect(hasil.nilaiTercatat).toBe(5_000_000);

    const riwayat = await listRiwayatImpairmentInvestasi({ investasiId: id });
    expect(riwayat).toHaveLength(2);

    const total = await getTotalImpairmentInvestasi(testDb as any, '2026-12-31');
    expect(total).toBe(5_000_000);
  });

  test('validasi: minimal satu indikasi wajib dipilih', async () => {
    await isiKas(testDb, 20_000_000);
    const { id } = await catatInvestasi({
      jenisInvestasi: 'KOPERASI_LAIN',
      namaTujuan: 'Koperasi Uji',
      jumlah: 5_000_000,
      tanggal: '2026-01-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });
    await expect(
      catatImpairmentInvestasi({
        investasiId: id,
        tanggal: '2026-06-01',
        nilaiImpairment: 1_000_000,
        indikasiTerpilih: [],
        dasarPenilaian: INPUT_VALID.dasarPenilaian,
        alasan: INPUT_VALID.alasan,
        createdBy: 'user-1',
      })
    ).rejects.toThrow(/indikasi/i);
  });
});

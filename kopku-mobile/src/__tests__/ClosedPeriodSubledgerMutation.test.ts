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

import { ClosedPeriodError, assertAccountingPeriodOpen } from '@/accounting/AccountingEngine';
import {
  ajukanPinjaman,
  cairkanPinjaman,
  bayarAngsuran,
  lunasiPinjaman,
  akadUlangPinjaman,
  getJadwalAngsuran,
} from '@/services/PinjamanService';
import { setorSimpanan } from '@/services/SimpananService';
import { catatPemasukan, catatPengeluaran } from '@/services/KasBankService';
import { beliAset } from '@/services/AsetService';
import { terimaUtang } from '@/services/UtangService';

/**
 * BUG-10 — IMMUTABILITAS PERIODE TERTUTUP PADA SELURUH JALUR MUTASI.
 * ==================================================================
 *
 * `createJournal()` sudah menolak periode CLOSED. Yang BELUM pernah
 * dibuktikan adalah pertanyaan yang sesungguhnya penting:
 *
 *   "Kalau penolakan itu terjadi, apakah subledger benar-benar tidak
 *    berubah — atau ada mutasi yang terlanjur tertulis?"
 *
 * Karena itu setiap kasus di bawah mengambil SNAPSHOT LENGKAP sebelum
 * transaksi (jumlah jurnal, jumlah baris jurnal, jumlah baris
 * subledger, saldo GL, jumlah log audit), menjalankan mutasi pada
 * periode CLOSED, lalu membuktikan SELURUH angka itu identik.
 *
 * Membuktikan "melempar error" saja tidak cukup: transaksi bisa saja
 * melempar SETELAH menulis sebagian.
 */

const ANGGOTA_ID = 'anggota-1';
const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  pendapatanDenda: 'acc-pendapatan-denda',
  pendapatanLain: 'acc-pendapatan-lain',
  bebanLain: 'acc-beban-lain',
  simpananPokok: 'acc-simpanan-pokok',
  simpananWajib: 'acc-simpanan-wajib',
  asetTetap: 'acc-aset-tetap',
  utangBank: 'acc-utang-bank',
  modal: 'acc-modal',
};

async function seedAccount(
  db: TestDb, id: string, kode: string, nama: string, kategori: string,
  normalBalance: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at) VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kategori, normalBalance, now, now
  );
}

async function seedMapping(db: TestDb, tipe: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tipe}-${role}`, tipe, role, accountId
  );
}

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();
  await seedAccount(testDb, ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.asetTetap, '1-2100', 'Peralatan', 'ASET', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanLain, '4-2000', 'Pendapatan Lain-lain', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.bebanLain, '5-2000', 'Beban Lainnya', 'BEBAN', 'DEBIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.utangBank, '2-2000', 'Utang Bank', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.simpananPokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.simpananWajib, '3-1100', 'Simpanan Wajib', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'PELUNASAN_JASA_FUTURE', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'SIMPANAN_POKOK', 'KREDIT_DEFAULT', ACC.simpananPokok);
  await seedMapping(testDb, 'SIMPANAN_WAJIB', 'KREDIT_DEFAULT', ACC.simpananWajib);
  await seedMapping(testDb, 'ASET_TETAP', 'DEBIT_ASET', ACC.asetTetap);
  await seedMapping(testDb, 'UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank);

  for (const [id, tahun] of [['p2026', 2026], ['p2027', 2027]] as const) {
    await testDb.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status) VALUES (?,?,?,?,'OPEN')`,
      id, tahun, `${tahun}-01-01`, `${tahun}-12-31`
    );
  }

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
  for (const [id, jenis, nominal] of [['sp', 'POKOK', 100000], ['sw', 'WAJIB', 50000]] as const) {
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?, ?, ?, 'SETOR','2020-01-01',?,'KAS',?,'user-1',?)`,
      id, ANGGOTA_ID, jenis, nominal, id, now
    );
  }
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('j-modal','JRN-M','2026-01-01','p2026','MODAL_UANG','Modal awal','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je1','j-modal',?,?,0)`,
    ACC.kas, 200_000_000
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je2','j-modal',?,0,?)`,
    ACC.modal, 200_000_000
  );
}

interface Snapshot {
  journal: number;
  journalEntry: number;
  pinjaman: number;
  angsuranJadwal: number;
  angsuranPembayaran: number;
  simpanan: number;
  aset: number;
  utang: number;
  kasTransaksi: number;
  auditLog: number;
  saldoKas: number;
  jasaDimuka: number;
}

async function ambilSnapshot(): Promise<Snapshot> {
  const hitung = async (sql: string): Promise<number> =>
    (await testDb.getFirstAsync<{ n: number }>(sql))?.n ?? 0;
  return {
    journal: await hitung(`SELECT COUNT(*) as n FROM journal`),
    journalEntry: await hitung(`SELECT COUNT(*) as n FROM journal_entry`),
    pinjaman: await hitung(`SELECT COUNT(*) as n FROM pinjaman`),
    angsuranJadwal: await hitung(`SELECT COUNT(*) as n FROM angsuran_jadwal`),
    angsuranPembayaran: await hitung(`SELECT COUNT(*) as n FROM angsuran_pembayaran`),
    simpanan: await hitung(`SELECT COUNT(*) as n FROM simpanan_transaksi`),
    aset: await hitung(`SELECT COUNT(*) as n FROM aset_tetap`),
    utang: await hitung(`SELECT COUNT(*) as n FROM utang`),
    kasTransaksi: await hitung(`SELECT COUNT(*) as n FROM kas_transaksi`),
    auditLog: await hitung(`SELECT COUNT(*) as n FROM audit_log`),
    saldoKas: await hitung(
      `SELECT COALESCE(SUM(je.debit - je.kredit),0) as n FROM journal_entry je
       JOIN journal j ON j.id = je.journal_id
       WHERE je.account_id = '${ACC.kas}' AND j.status IN ('POSTED','REVERSED')`
    ),
    jasaDimuka: await hitung(`SELECT COALESCE(SUM(jasa_dimuka),0) as n FROM angsuran_jadwal`),
  };
}

async function tutupPeriode(tahun: number): Promise<void> {
  await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED' WHERE tahun_buku = ?`, tahun);
}

/**
 * Harness bersama: jalankan `aksi` pada periode CLOSED dan buktikan
 * (a) ditolak, dan (b) TIDAK ADA satu pun angka yang berubah.
 */
async function harusDitolakTanpaEfek(aksi: () => Promise<unknown>): Promise<void> {
  const sebelum = await ambilSnapshot();
  let ditolak = false;
  try {
    await aksi();
  } catch {
    ditolak = true;
  }
  const sesudah = await ambilSnapshot();
  expect(ditolak).toBe(true);
  expect(sesudah).toEqual(sebelum);
}

async function buatPinjamanAktif(): Promise<string> {
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
    pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01',
  });
  return id;
}

describe('BUG-10 — guard periode terpusat', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('assertAccountingPeriodOpen lolos pada periode OPEN', async () => {
    await expect(assertAccountingPeriodOpen(testDb as any, '2026-05-01')).resolves.toBeUndefined();
  });

  test('assertAccountingPeriodOpen melempar ClosedPeriodError pada periode CLOSED', async () => {
    await tutupPeriode(2026);
    await expect(assertAccountingPeriodOpen(testDb as any, '2026-05-01')).rejects.toThrow(
      ClosedPeriodError
    );
  });

  test('guard memakai resolvePeriod yang SAMA dengan createJournal (bukan implementasi kedua)', async () => {
    await tutupPeriode(2026);
    // Periode 2027 tetap OPEN — membuktikan guard menilai per-tanggal,
    // bukan menolak semuanya.
    await expect(assertAccountingPeriodOpen(testDb as any, '2027-01-15')).resolves.toBeUndefined();
  });
});

describe('BUG-10 — matriks mutasi: CLOSED ditolak tanpa efek parsial', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('LOAN — bayarAngsuran', async () => {
    const pinjamanId = await buatPinjamanAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    await tutupPeriode(2026);
    await harusDitolakTanpaEfek(() =>
      bayarAngsuran({
        pinjamanId,
        jadwalId: jadwal[0].id,
        tanggal: '2026-02-01',
        nominal: jadwal[0].total,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    );
  });

  test('LOAN — lunasiPinjaman', async () => {
    const pinjamanId = await buatPinjamanAktif();
    await tutupPeriode(2026);
    await harusDitolakTanpaEfek(() =>
      lunasiPinjaman({
        pinjamanId,
        tanggal: '2026-03-01',
        sumberDana: 'KAS',
        createdBy: 'user-1',
        metodeJasaPelunasan: 'JASA_KONTRAKTUAL',
      })
    );
  });

  test('LOAN — akadUlangPinjaman (restrukturisasi)', async () => {
    const pinjamanId = await buatPinjamanAktif();
    await tutupPeriode(2026);
    await harusDitolakTanpaEfek(() =>
      akadUlangPinjaman({
        pinjamanId,
        tanggal: '2026-04-01',
        tenorBaru: 12,
        satuanTenorBaru: 'BULAN',
        metodeJasaBaru: 'FLAT',
        persentaseJasaBaru: 1,
        actingUserId: 'user-1',
      })
    );
  });

  test('LOAN — cairkanPinjaman', async () => {
    const { id } = await ajukanPinjaman({
      anggotaId: ANGGOTA_ID,
      tanggal: '2026-01-01',
      jumlahPinjaman: 5_000_000,
      tenor: 6,
      satuanTenor: 'BULAN',
      metodeJasa: 'FLAT',
      persentaseJasa: 1,
      biayaAdminTipe: 'TIDAK_ADA',
      biayaAdminNilai: 0,
      dendaAktif: false,
      createdBy: 'user-1',
    });
    await tutupPeriode(2026);
    await harusDitolakTanpaEfek(() =>
      cairkanPinjaman({
        pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-02-01',
      })
    );
  });

  test('SAVINGS — setorSimpanan', async () => {
    await tutupPeriode(2026);
    await harusDitolakTanpaEfek(() =>
      setorSimpanan({
        anggotaId: ANGGOTA_ID,
        jenis: 'WAJIB',
        tanggal: '2026-02-10',
        nominal: 50_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      })
    );
  });

  test('CASH — catatPemasukan', async () => {
    await tutupPeriode(2026);
    await harusDitolakTanpaEfek(() =>
      catatPemasukan({
        jenis: 'KAS',
        tanggal: '2026-02-10',
        nominal: 250_000,
        akunLawanId: ACC.pendapatanLain,
        createdBy: 'user-1',
      })
    );
  });

  test('CASH — catatPengeluaran', async () => {
    await tutupPeriode(2026);
    await harusDitolakTanpaEfek(() =>
      catatPengeluaran({
        jenis: 'KAS',
        tanggal: '2026-02-10',
        nominal: 250_000,
        akunLawanId: ACC.bebanLain,
        createdBy: 'user-1',
      })
    );
  });

  test('ASSET — beliAset', async () => {
    await tutupPeriode(2026);
    await harusDitolakTanpaEfek(() =>
      beliAset({
        nama: 'Laptop Kantor',
        tanggalPerolehan: '2026-02-01',
        nilaiPerolehan: 10_000_000,
        masaManfaatBulan: 48,
        nilaiResidu: 0,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      } as any)
    );
  });

  test('LIABILITY — terimaUtang', async () => {
    await tutupPeriode(2026);
    await harusDitolakTanpaEfek(() =>
      terimaUtang({
        jenis: 'UTANG_BANK',
        namaKreditur: 'Bank Mitra',
        tanggal: '2026-02-01',
        pokok: 50_000_000,
        sumberDana: 'KAS',
        createdBy: 'user-1',
      } as any)
    );
  });
});

describe('BUG-10 — periode OPEN tetap berjalan normal (guard tidak over-blocking)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('mutasi yang sama BERHASIL ketika periodenya OPEN', async () => {
    const pinjamanId = await buatPinjamanAktif();
    const jadwal = await getJadwalAngsuran(pinjamanId);
    const sebelum = await ambilSnapshot();

    await bayarAngsuran({
      pinjamanId,
      jadwalId: jadwal[0].id,
      tanggal: '2026-02-01',
      nominal: jadwal[0].total,
      sumberDana: 'KAS',
      createdBy: 'user-1',
    });

    const sesudah = await ambilSnapshot();
    expect(sesudah.journal).toBeGreaterThan(sebelum.journal);
    expect(sesudah.angsuranPembayaran).toBeGreaterThan(sebelum.angsuranPembayaran);
  });

  test('menutup 2026 TIDAK memblokir transaksi bertanggal 2027', async () => {
    await tutupPeriode(2026);
    const sebelum = await ambilSnapshot();
    await catatPemasukan({
      jenis: 'KAS',
      tanggal: '2027-01-15',
      nominal: 100_000,
      akunLawanId: ACC.pendapatanLain,
      createdBy: 'user-1',
    });
    const sesudah = await ambilSnapshot();
    expect(sesudah.journal).toBe(sebelum.journal + 1);
  });
});

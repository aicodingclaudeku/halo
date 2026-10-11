import { createTestDb, TestDb } from './testDb';

/**
 * BUG-09 — PENDAPATAN DITERIMA DIMUKA (JASA FUTURA) SETELAH PELUNASAN.
 * ====================================================================
 *
 * KEBIJAKAN: OPSI B — jasa futura tetap deferred, dilepas periode demi
 * periode mengikuti tanggal jatuh tempo jadwal aslinya.
 *
 * Yang dibuktikan test ini:
 *   1. Settlement menulis `angsuran_jadwal.jasa_dimuka` PER BARIS
 *      (bukan ditumpuk di satu baris), sehingga pelepasannya bisa
 *      mengikuti tanggal masing-masing angsuran.
 *   2. Subledger (SUM jasa_dimuka) = GL (saldo 2-1300) di SETIAP titik.
 *   3. Pinjaman berstatus LUNAS TETAP diproses mesin akrual — inilah
 *      akar bug aslinya (`WHERE p.status = 'AKTIF'`).
 *   4. Pelepasan bersifat idempoten: dijalankan dua kali tidak
 *      menghasilkan pendapatan ganda.
 *   5. Total yang dilepas TIDAK PERNAH melebihi deferred awal, dan
 *      pada akhir seluruh periode jasa saldonya nol.
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
  getJadwalAngsuran,
} from '@/services/PinjamanService';
import { jalankanAkrualJasaPeriode } from '@/services/AkrualJasaPinjamanService';

const ANGGOTA_ID = 'anggota-1';
const ACC = {
  kas: 'acc-kas',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  pendapatanDenda: 'acc-pendapatan-denda',
  pendapatanAdmin: 'acc-pendapatan-admin',
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
  await seedAccount(testDb, ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT');
  await seedAccount(testDb, ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT');
  await seedAccount(testDb, ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT');
  // Fixture menyeed simpanan_transaksi (syarat eligibilitas pinjaman),
  // jadi domain simpanan WAJIB punya akun & mapping — kalau tidak,
  // rekonsiliasi akan gagal keras, dan itu memang perilaku yang benar.
  await seedAccount(testDb, 'acc-simp-pokok', '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT');
  await seedAccount(testDb, 'acc-simp-wajib', '3-1100', 'Simpanan Wajib', 'EKUITAS', 'KREDIT');

  await seedMapping(testDb, 'KAS_UMUM', 'DEFAULT', ACC.kas);
  await seedMapping(testDb, 'PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa);
  await seedMapping(testDb, 'PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa);
  // Mapping yang dipakai jurnal pelunasan untuk jasa masa depan.
  await seedMapping(testDb, 'PELUNASAN_JASA_FUTURE', 'KREDIT_DIMUKA', ACC.pendapatanDimuka);
  await seedMapping(testDb, 'SIMPANAN_POKOK', 'KREDIT_DEFAULT', 'acc-simp-pokok');
  await seedMapping(testDb, 'SIMPANAN_WAJIB', 'KREDIT_DEFAULT', 'acc-simp-wajib');

  for (const [id, tahun] of [['period-2026', 2026], ['period-2027', 2027]] as const) {
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
  // Simpanan diseed BERSAMA jurnalnya supaya subledger dan GL konsisten
  // sejak awal — fixture yang menulis subledger tanpa jurnal akan
  // menghasilkan selisih rekonsiliasi yang bukan berasal dari bug.
  for (const [id, jenis, nominal, akun] of [
    ['sp-f', 'POKOK', 100000, 'acc-simp-pokok'],
    ['sw-f', 'WAJIB', 50000, 'acc-simp-wajib'],
  ] as const) {
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
       VALUES (?,?,'2026-01-02','period-2026',?,'Setoran simpanan (fixture)','POSTED','user-1',?,?,?)`,
      `j-${id}`, `JRN-${id}`, jenis === 'POKOK' ? 'SIMPANAN_POKOK' : 'SIMPANAN_WAJIB', now, now, now
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,?,0)`,
      `je-${id}-d`, `j-${id}`, ACC.kas, nominal
    );
    await testDb.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES (?,?,?,0,?)`,
      `je-${id}-k`, `j-${id}`, akun, nominal
    );
    await testDb.runAsync(
      `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
       VALUES (?,?,?,'SETOR','2026-01-02',?,'KAS',?,'user-1',?)`,
      id, ANGGOTA_ID, jenis, nominal, id, now
    );
  }
  await testDb.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('j-modal','JRN-MODAL','2026-01-01','period-2026','MODAL_AWAL','Modal awal','POSTED','user-1',?,?,?)`,
    now, now, now
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-md','j-modal',?,?,0)`,
    ACC.kas, 100_000_000
  );
  await testDb.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-mk','j-modal',?,0,?)`,
    ACC.modal, 100_000_000
  );
}

/** Saldo GL akun 2-1300 (liabilitas, normal balance KREDIT). */
async function saldoGlDeferred(): Promise<number> {
  const row = await testDb.getFirstAsync<{ saldo: number }>(
    `SELECT COALESCE(SUM(je.kredit - je.debit), 0) as saldo
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    ACC.pendapatanDimuka
  );
  return row?.saldo ?? 0;
}

/** Subledger deferred = SUM(angsuran_jadwal.jasa_dimuka). */
async function subledgerDeferred(): Promise<number> {
  const row = await testDb.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(jasa_dimuka), 0) as total FROM angsuran_jadwal`
  );
  return row?.total ?? 0;
}

async function pendapatanJasaGl(): Promise<number> {
  const row = await testDb.getFirstAsync<{ saldo: number }>(
    `SELECT COALESCE(SUM(je.kredit - je.debit), 0) as saldo
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    ACC.pendapatanJasa
  );
  return row?.saldo ?? 0;
}

async function buatDanLunasi(): Promise<{ pinjamanId: string; deferredAwal: number }> {
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
  const hasil = await lunasiPinjaman({
    pinjamanId: id,
    tanggal: '2026-03-01',
    sumberDana: 'KAS',
    createdBy: 'user-1',
    metodeJasaPelunasan: 'JASA_KONTRAKTUAL',
  });
  return { pinjamanId: id, deferredAwal: hasil.jasaFuturePendingEirAccounting };
}

describe('BUG-09 — deferred income setelah pelunasan (Opsi B)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('settlement mencatat jasa_dimuka PER BARIS jadwal, bukan ditumpuk di satu baris', async () => {
    const { pinjamanId, deferredAwal } = await buatDanLunasi();
    expect(deferredAwal).toBeGreaterThan(0);

    const jadwal = await getJadwalAngsuran(pinjamanId);
    const rows = await testDb.getAllAsync<{ nomor_angsuran: number; tanggal_jatuh_tempo: string; jasa_dimuka: number }>(
      `SELECT nomor_angsuran, tanggal_jatuh_tempo, jasa_dimuka FROM angsuran_jadwal
       WHERE pinjaman_id = ? ORDER BY nomor_angsuran ASC`,
      pinjamanId
    );
    expect(jadwal.length).toBe(12);

    // Angsuran yang SUDAH jatuh tempo per 2026-03-01 tidak boleh punya deferred.
    const sudahJatuhTempo = rows.filter((r) => r.tanggal_jatuh_tempo <= '2026-03-01');
    expect(sudahJatuhTempo.length).toBeGreaterThan(0);
    expect(sudahJatuhTempo.every((r) => r.jasa_dimuka === 0)).toBe(true);

    // Angsuran masa depan masing-masing memikul porsinya sendiri.
    const masaDepan = rows.filter((r) => r.tanggal_jatuh_tempo > '2026-03-01');
    expect(masaDepan.length).toBeGreaterThan(1);
    expect(masaDepan.every((r) => r.jasa_dimuka > 0)).toBe(true);
    expect(masaDepan.reduce((a, r) => a + r.jasa_dimuka, 0)).toBe(deferredAwal);
  });

  test('subledger = GL 2-1300 tepat setelah pelunasan', async () => {
    const { deferredAwal } = await buatDanLunasi();
    expect(await subledgerDeferred()).toBe(deferredAwal);
    expect(await saldoGlDeferred()).toBe(deferredAwal);
  });

  test('pinjaman LUNAS tetap dilepas deferred-nya periode demi periode (akar BUG-09)', async () => {
    const { pinjamanId, deferredAwal } = await buatDanLunasi();

    const rows = await testDb.getAllAsync<{ tanggal_jatuh_tempo: string; jasa_dimuka: number }>(
      `SELECT tanggal_jatuh_tempo, jasa_dimuka FROM angsuran_jadwal
       WHERE pinjaman_id = ? AND jasa_dimuka > 0 ORDER BY nomor_angsuran ASC`,
      pinjamanId
    );
    const periodePertama = rows[0].tanggal_jatuh_tempo.slice(0, 7);
    const nilaiPertama = rows[0].jasa_dimuka;

    const pendapatanSebelum = await pendapatanJasaGl();
    const hasil = await jalankanAkrualJasaPeriode(periodePertama, 'user-1', {
      tanggalLaporan: `${periodePertama}-30`,
    });
    expect(hasil.diproses.length).toBe(1);

    // Pendapatan bertambah tepat sebesar porsi periode itu.
    expect(await pendapatanJasaGl()).toBe(pendapatanSebelum + nilaiPertama);
    // Liabilitas berkurang dengan jumlah yang sama, subledger ikut turun.
    expect(await saldoGlDeferred()).toBe(deferredAwal - nilaiPertama);
    expect(await subledgerDeferred()).toBe(deferredAwal - nilaiPertama);
    // Rekonsiliasi tetap terjaga.
    expect(await subledgerDeferred()).toBe(await saldoGlDeferred());
  });

  test('pelepasan idempoten — dijalankan dua kali tidak menghasilkan pendapatan ganda', async () => {
    const { pinjamanId } = await buatDanLunasi();
    const rows = await testDb.getAllAsync<{ tanggal_jatuh_tempo: string }>(
      `SELECT tanggal_jatuh_tempo FROM angsuran_jadwal WHERE pinjaman_id = ? AND jasa_dimuka > 0 ORDER BY nomor_angsuran ASC`,
      pinjamanId
    );
    const periode = rows[0].tanggal_jatuh_tempo.slice(0, 7);

    await jalankanAkrualJasaPeriode(periode, 'user-1', { tanggalLaporan: `${periode}-30` });
    const pendapatanRun1 = await pendapatanJasaGl();
    const deferredRun1 = await saldoGlDeferred();

    await jalankanAkrualJasaPeriode(periode, 'user-1', { tanggalLaporan: `${periode}-30` });
    expect(await pendapatanJasaGl()).toBe(pendapatanRun1);
    expect(await saldoGlDeferred()).toBe(deferredRun1);
    expect(await subledgerDeferred()).toBe(deferredRun1);
  });

  test('seluruh periode dilepas: jasa_dimuka = 0, GL 2-1300 = 0, dan total rilis TIDAK melebihi deferred awal', async () => {
    const { pinjamanId, deferredAwal } = await buatDanLunasi();
    const pendapatanSebelum = await pendapatanJasaGl();

    const periodeRows = await testDb.getAllAsync<{ periode: string }>(
      `SELECT DISTINCT substr(tanggal_jatuh_tempo,1,7) as periode FROM angsuran_jadwal
       WHERE pinjaman_id = ? AND jasa_dimuka > 0 ORDER BY periode ASC`,
      pinjamanId
    );
    expect(periodeRows.length).toBeGreaterThan(1);

    for (const { periode } of periodeRows) {
      await jalankanAkrualJasaPeriode(periode, 'user-1', { tanggalLaporan: `${periode}-28` });
      // Invarian di SETIAP langkah, bukan hanya di akhir.
      expect(await subledgerDeferred()).toBe(await saldoGlDeferred());
      expect(await subledgerDeferred()).toBeGreaterThanOrEqual(0);
    }

    expect(await subledgerDeferred()).toBe(0);
    expect(await saldoGlDeferred()).toBe(0);
    // Pendapatan yang diakui = deferred awal. Pelunasan TIDAK menciptakan
    // pendapatan tambahan di luar jasa kontraktual yang memang ditagih.
    expect(await pendapatanJasaGl() - pendapatanSebelum).toBe(deferredAwal);
  });

  test('JASA_TERUTANG (jasa masa depan dirabat) TIDAK menghasilkan deferred income sama sekali', async () => {
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
    await cairkanPinjaman({ pinjamanId: id, sumberDana: 'KAS', approvedBy: 'user-1', tanggalPencairan: '2026-01-01' });
    const hasil = await lunasiPinjaman({
      pinjamanId: id,
      tanggal: '2026-03-01',
      sumberDana: 'KAS',
      createdBy: 'user-1',
      metodeJasaPelunasan: 'JASA_TERUTANG',
    });

    expect(hasil.jasaFuturePendingEirAccounting).toBe(0);
    expect(await subledgerDeferred()).toBe(0);
    expect(await saldoGlDeferred()).toBe(0);
  });
});

/**
 * §9 — PELEPASAN DEFERRED INCOME PADA PERIODE TERTUTUP.
 *
 * Pelepasan menghasilkan accounting effect (Dr 2-1300 / Cr Pendapatan
 * Jasa), jadi ia tunduk pada aturan immutability periode tertutup sama
 * seperti transaksi lain. Yang diuji bukan sekadar "tidak ada jurnal",
 * tetapi bahwa penolakannya BERSUARA (ada pesan) dan TIDAK meninggalkan
 * state parsial — `jasa_dimuka` tidak boleh berkurang kalau jurnalnya
 * gagal dibuat.
 */
describe('BUG-09 + BUG-10 — pelepasan deferred pada periode CLOSED', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  async function tutupPeriode(tahun: number): Promise<void> {
    await testDb.runAsync(
      `UPDATE accounting_period SET status = 'CLOSED' WHERE tahun_buku = ?`,
      tahun
    );
  }

  test('prosesAkrualJasaPinjaman MENOLAK (melempar) saat periode akuntansinya tertutup', async () => {
    const { pinjamanId } = await buatDanLunasi();
    const rows = await testDb.getAllAsync<{ tanggal_jatuh_tempo: string }>(
      `SELECT tanggal_jatuh_tempo FROM angsuran_jadwal WHERE pinjaman_id = ? AND jasa_dimuka > 0 ORDER BY nomor_angsuran ASC`,
      pinjamanId
    );
    const periode = rows[0].tanggal_jatuh_tempo.slice(0, 7);

    await tutupPeriode(2026);

    const { prosesAkrualJasaPinjaman } = await import('@/services/AkrualJasaPinjamanService');
    await expect(
      prosesAkrualJasaPinjaman({
        pinjamanId,
        periode,
        createdBy: 'user-1',
        tanggalLaporan: `${periode}-28`,
      })
    ).rejects.toThrow();
  });

  test('penolakan TIDAK meninggalkan state parsial: subledger, GL, dan jumlah jurnal tidak berubah', async () => {
    const { pinjamanId, deferredAwal } = await buatDanLunasi();
    const rows = await testDb.getAllAsync<{ tanggal_jatuh_tempo: string }>(
      `SELECT tanggal_jatuh_tempo FROM angsuran_jadwal WHERE pinjaman_id = ? AND jasa_dimuka > 0 ORDER BY nomor_angsuran ASC`,
      pinjamanId
    );
    const periode = rows[0].tanggal_jatuh_tempo.slice(0, 7);

    const jumlahJurnalSebelum = (
      await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM journal`)
    )?.n;
    const jumlahEntrySebelum = (
      await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM journal_entry`)
    )?.n;

    await tutupPeriode(2026);

    const hasil = await jalankanAkrualJasaPeriode(periode, 'user-1', {
      tanggalLaporan: `${periode}-28`,
    });

    // Bukan silent skip: alasannya tercatat.
    expect(hasil.diproses.length).toBe(0);
    expect(hasil.dilewati.length).toBeGreaterThan(0);

    // Tidak ada perubahan apa pun.
    expect(await subledgerDeferred()).toBe(deferredAwal);
    expect(await saldoGlDeferred()).toBe(deferredAwal);
    expect(
      (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM journal`))?.n
    ).toBe(jumlahJurnalSebelum);
    expect(
      (await testDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) as n FROM journal_entry`))?.n
    ).toBe(jumlahEntrySebelum);
  });

  test('setelah periode dibuka kembali, pelepasan berjalan normal', async () => {
    const { pinjamanId, deferredAwal } = await buatDanLunasi();
    const rows = await testDb.getAllAsync<{ tanggal_jatuh_tempo: string; jasa_dimuka: number }>(
      `SELECT tanggal_jatuh_tempo, jasa_dimuka FROM angsuran_jadwal WHERE pinjaman_id = ? AND jasa_dimuka > 0 ORDER BY nomor_angsuran ASC`,
      pinjamanId
    );
    const periode = rows[0].tanggal_jatuh_tempo.slice(0, 7);

    await tutupPeriode(2026);
    await jalankanAkrualJasaPeriode(periode, 'user-1', { tanggalLaporan: `${periode}-28` });
    expect(await subledgerDeferred()).toBe(deferredAwal);

    await testDb.runAsync(`UPDATE accounting_period SET status = 'OPEN' WHERE tahun_buku = 2026`);
    const hasil = await jalankanAkrualJasaPeriode(periode, 'user-1', { tanggalLaporan: `${periode}-28` });

    expect(hasil.diproses.length).toBe(1);
    expect(await subledgerDeferred()).toBe(deferredAwal - rows[0].jasa_dimuka);
    expect(await subledgerDeferred()).toBe(await saldoGlDeferred());
  });
});

/**
 * §10 — PEMISAHAN DEFERRED CONTRACTUAL SERVICE vs FEE INTEGRAL (EIR).
 *
 * Akun 2-1300 menampung DUA objek akuntansi yang berbeda. Test ini
 * mengunci bahwa rekonsiliasinya menyatakan keduanya secara terpisah,
 * sehingga variance nol benar-benar berarti nol.
 */
describe('§10 — rekonsiliasi 2-1300 memisahkan jasa kontraktual dari fee integral', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('tanpa fee integral: seluruh saldo 2-1300 berasal dari jasa kontraktual, variance 0', async () => {
    const { rekonsiliasiDeferredIncome } = await import('@/accounting/DeferredIncomeReconciliation');
    const { deferredAwal } = await buatDanLunasi();

    const rekon = await rekonsiliasiDeferredIncome(testDb as any);
    expect(rekon.glDeferredIncome).toBe(deferredAwal);
    expect(rekon.subledgerJasaKontraktual).toBe(deferredAwal);
    expect(rekon.subledgerFeeIntegral).toBe(0);
    expect(rekon.variance).toBe(0);
    expect(rekon.seimbang).toBe(true);
  });

  test('variance tetap 0 di setiap tahap pelepasan', async () => {
    const { rekonsiliasiDeferredIncome } = await import('@/accounting/DeferredIncomeReconciliation');
    const { pinjamanId } = await buatDanLunasi();

    const periodeRows = await testDb.getAllAsync<{ periode: string }>(
      `SELECT DISTINCT substr(tanggal_jatuh_tempo,1,7) as periode FROM angsuran_jadwal
       WHERE pinjaman_id = ? AND jasa_dimuka > 0 ORDER BY periode ASC`,
      pinjamanId
    );
    for (const { periode } of periodeRows) {
      await jalankanAkrualJasaPeriode(periode, 'user-1', { tanggalLaporan: `${periode}-28` });
      const rekon = await rekonsiliasiDeferredIncome(testDb as any);
      expect(rekon.variance).toBe(0);
    }
    const akhir = await rekonsiliasiDeferredIncome(testDb as any);
    expect(akhir.glDeferredIncome).toBe(0);
    expect(akhir.totalSubledger).toBe(0);
  });

  test('mapping COA hilang -> gagal KERAS, bukan melaporkan saldo 0 palsu', async () => {
    const { rekonsiliasiDeferredIncome } = await import('@/accounting/DeferredIncomeReconciliation');
    await buatDanLunasi();
    await testDb.runAsync(
      `DELETE FROM account_mapping WHERE transaction_type = 'AKRUAL_JASA_PINJAMAN' AND role = 'DEBIT_DIMUKA'`
    );
    await expect(rekonsiliasiDeferredIncome(testDb as any)).rejects.toThrow(
      /belum memiliki mapping COA/
    );
  });
});

/**
 * §11/§13 — MATRIKS REKONSIILIASI SUBLEDGER vs GL.
 *
 * Dijalankan pada dataset yang SAMA dengan skenario deferred income di
 * atas, sehingga inkonsistensi lintas modul ketahuan — bukan tiap
 * domain diuji dengan fixture-nya sendiri.
 */
describe('§11 — rekonsiliasi lengkap subledger vs GL', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('setelah pencairan: seluruh domain seimbang dan jurnal balance', async () => {
    const { jalankanRekonsiliasiLengkap } = await import('@/accounting/FullReconciliation');
    await buatDanLunasi();

    const hasil = await jalankanRekonsiliasiLengkap(testDb as any);

    // Kontrol GL global.
    expect(hasil.totalDebit).toBe(hasil.totalKredit);
    expect(hasil.jurnalSeimbang).toBe(true);

    // Tidak boleh ada satu pun baris SELISIH.
    const selisih = hasil.baris.filter((b) => b.status === 'SELISIH');
    expect(selisih.map((b) => `${b.domain}: ${b.variance}`)).toEqual([]);
    expect(hasil.seluruhnyaSeimbang).toBe(true);
  });

  test('variance tetap 0 di SETIAP tahap pelepasan deferred', async () => {
    const { jalankanRekonsiliasiLengkap } = await import('@/accounting/FullReconciliation');
    const { pinjamanId } = await buatDanLunasi();

    const periodeRows = await testDb.getAllAsync<{ periode: string }>(
      `SELECT DISTINCT substr(tanggal_jatuh_tempo,1,7) as periode FROM angsuran_jadwal
       WHERE pinjaman_id = ? AND jasa_dimuka > 0 ORDER BY periode ASC`,
      pinjamanId
    );
    for (const { periode } of periodeRows) {
      await jalankanAkrualJasaPeriode(periode, 'user-1', { tanggalLaporan: `${periode}-28` });
      const hasil = await jalankanRekonsiliasiLengkap(testDb as any);
      expect(hasil.baris.filter((b) => b.status === 'SELISIH')).toEqual([]);
      expect(hasil.jurnalSeimbang).toBe(true);
    }
  });

  test('domain tanpa aktivitas dilaporkan TIDAK_BERLAKU, bukan diklaim seimbang', async () => {
    const { jalankanRekonsiliasiLengkap } = await import('@/accounting/FullReconciliation');
    const hasil = await jalankanRekonsiliasiLengkap(testDb as any);
    const aset = hasil.baris.find((b) => b.domain === 'Asset gross');
    expect(aset?.status).toBe('TIDAK_BERLAKU');
    expect(aset?.catatan).toBeTruthy();
  });

  test('mapping hilang PADAHAL ada aktivitas -> gagal keras, bukan variance 0 palsu', async () => {
    const { jalankanRekonsiliasiLengkap } = await import('@/accounting/FullReconciliation');
    await buatDanLunasi();
    await testDb.runAsync(
      `DELETE FROM account_mapping WHERE transaction_type = 'PENCAIRAN_PINJAMAN' AND role = 'DEBIT_PIUTANG'`
    );
    await expect(jalankanRekonsiliasiLengkap(testDb as any)).rejects.toThrow(
      /sudah memiliki aktivitas/
    );
  });
});

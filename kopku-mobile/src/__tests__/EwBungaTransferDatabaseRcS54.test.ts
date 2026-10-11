jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);

import {
  siapkanDb,
  pasangKebijakan,
  saldoGl,
  snapshotBuku,
  KEBIJAKAN_NETRAL,
  KEBIJAKAN_ENAM_KOMPONEN,
  ACC,
  ANGGOTA_ID,
  USER_ID,
  PLACEMENT,
  TANGGAL_TARIK,
} from './earlyWithdrawalHarness';
import { buatKontrakUji } from './earlyWithdrawalKontrak';
import { TestDb } from './testDb';
import { getDb } from '@/database/db';
import { KebijakanEarlyWithdrawal } from '@/accounting/EarlyWithdrawalPolicy';
import { SettlementDiniTidakDapatDihitungError } from '@/accounting/EarlyWithdrawalCalculation';
import { jalankanRekonsiliasiLengkap } from '@/accounting/FullReconciliation';
import {
  prosesAkrualBungaKontrak,
  prosesTransferBungaKeSukarela,
  getStatusTransferBunga,
  getTotalUtangBungaBerjangka,
  kunciTransferBunga,
  TRANSAKSI_BUNGA_TRANSFER,
} from '@/services/SimpananBerjangkaLifecycleService';
import {
  previewPencairanDiniPadaDb,
  cairkanSimpananBerjangkaDini,
  TRANSAKSI_PENCAIRAN_DINI,
  PESAN_SUDAH_DICAIRKAN_DINI,
} from '@/services/SimpananBerjangkaEarlyWithdrawalService';
import { getSaldoSimpanan } from '@/services/SimpananService';

/**
 * RC-S54 TAHAP 6 — ITEM #1 — END-TO-END DI DATABASE NYATA
 * =========================================================================
 *
 * Alur yang dibuktikan:
 *   Simpanan Berjangka -> akrual bunga -> Transfer Bunga ke Simpanan
 *   Sukarela -> COMMIT -> preview penarikan dini -> eksekusi penarikan dini
 *
 * HARNESS. Suite ini memakai harness DB RESMI repository:
 *   - Jest + ts-jest (jest.config.js), dengan `jest.mock` yang di-hoist
 *     oleh ts-jest sehingga `@/database/db` sudah diganti SEBELUM service
 *     produksi di-import;
 *   - `src/__tests__/testDb.ts` (SQLite sungguhan, skema dari schema.ts);
 *   - `earlyWithdrawalHarness.dbMock` — mock `@/database/db` yang sama
 *     dengan 20+ suite penarikan dini lainnya (bukan mock kedua).
 *
 * TIDAK ADA yang di-mock selain koneksi database. Transfer bunga dibuat
 * oleh `prosesTransferBungaKeSukarela()` produksi dan dibaca kembali dari
 * tabel `journal` oleh `getTotalBungaDitransferPadaDb()` produksi.
 * Seluruh assertion jurnal mengambil baris `journal_entry` dari database,
 * bukan nilai kembalian fungsi.
 *
 * TIPE. Service `...PadaDb` & rekonsiliasi menerima `SQLiteDatabase`.
 * Handle diambil lewat `getDb()` (yang di-mock mengembalikan DB uji yang
 * sama), sehingga tidak ada cast `as any` di berkas ini.
 *
 * ANGKA. Pokok Rp20.000.000, 6%/tahun, tenor 6 bulan -> bunga
 * Rp100.000 per periode. Tanggal tarik 2026-09-15 -> tiga periode earned
 * (12 Jul, 12 Agu, 12 Sep) = Rp300.000. Angka kebijakan adalah FIXTURE
 * UJI dari harness, bukan kebijakan koperasi.
 */

const POKOK_UJI = 20_000_000;
const BUNGA_PERIODE = 100_000;
const EARNED = 300_000;
const AKHIR_PERIODE = ['2026-07-12', '2026-08-12', '2026-09-12'] as const;

let db: TestDb;

interface Baseline {
  utangBunga: number;
  beban: number;
  kas: number;
  berjangka: number;
  sukarelaGl: number;
  sukarelaSubledger: number;
}
let awal: Baseline;

async function ambilBaseline(): Promise<Baseline> {
  const dbProd = await getDb();
  return {
    utangBunga: await saldoGl(db, ACC.utangBungaBerjangka),
    beban: await saldoGl(db, ACC.bebanBungaBerjangka),
    kas: await saldoGl(db, ACC.kas),
    berjangka: await saldoGl(db, ACC.berjangka),
    sukarelaGl: await saldoGl(db, ACC.simpananSukarela),
    sukarelaSubledger: await getSaldoSimpanan(dbProd, ANGGOTA_ID, 'SUKARELA'),
  };
}

/**
 * Siapkan kontrak dan transfer `jumlahPeriodeTransfer` periode pertama.
 *
 * `akrualSampai` menentukan sejauh apa akrual sudah berjalan SEBELUM
 * transfer. Sisa akrual (bila ada) diselesaikan oleh eksekusi penarikan
 * dini di dalam transaksinya sendiri — perilaku produksi.
 */
async function siapkanKontrakDenganTransfer(
  jumlahPeriodeTransfer: 0 | 1 | 2 | 3,
  opsi: { kebijakan?: KebijakanEarlyWithdrawal; akrualSampai?: string } = {}
): Promise<string> {
  await pasangKebijakan(db, opsi.kebijakan ?? KEBIJAKAN_NETRAL);
  const kontrakId = await buatKontrakUji({ pokok: POKOK_UJI });

  if (jumlahPeriodeTransfer > 0) {
    const batasTransfer = AKHIR_PERIODE[jumlahPeriodeTransfer - 1];
    await prosesAkrualBungaKontrak(kontrakId, opsi.akrualSampai ?? batasTransfer, USER_ID);
    // Komit transfer terpisah — withTransaction produksi.
    const t = await prosesTransferBungaKeSukarela(kontrakId, batasTransfer, USER_ID);
    expect(t.totalDipindahkanSekarang).toBe(jumlahPeriodeTransfer * BUNGA_PERIODE);
  } else if (opsi.akrualSampai) {
    await prosesAkrualBungaKontrak(kontrakId, opsi.akrualSampai, USER_ID);
  }
  return kontrakId;
}

interface BarisJurnal {
  account_id: string;
  debit: number;
  kredit: number;
}

async function barisJurnal(journalId: string): Promise<BarisJurnal[]> {
  return db.getAllAsync<BarisJurnal>(
    `SELECT account_id, debit, kredit FROM journal_entry WHERE journal_id = ? ORDER BY account_id`,
    journalId
  );
}

const sumDebit = (b: BarisJurnal[], acc: string) =>
  b.filter((x) => x.account_id === acc).reduce((t, x) => t + x.debit, 0);
const sumKredit = (b: BarisJurnal[], acc: string) =>
  b.filter((x) => x.account_id === acc).reduce((t, x) => t + x.kredit, 0);

/** Debit/kredit 2-1710 dari seluruh jurnal ber-sumber tertentu untuk kontrak ini. */
async function mutasi2_1710PerSumber(sumber: string): Promise<{ debit: number; kredit: number }> {
  const row = await db.getFirstAsync<{ d: number; k: number }>(
    `SELECT COALESCE(SUM(je.debit),0) d, COALESCE(SUM(je.kredit),0) k
       FROM journal_entry je JOIN journal j ON j.id = je.journal_id
      WHERE j.sumber_transaksi = ? AND je.account_id = ? AND j.status IN ('POSTED','REVERSED')`,
    sumber,
    ACC.utangBungaBerjangka
  );
  return { debit: row?.d ?? 0, kredit: row?.k ?? 0 };
}

async function settlementRow(kontrakId: string) {
  return db.getFirstAsync<{
    id: string;
    journal_id: string;
    bunga_akrual_kontrak: number;
    bunga_bruto: number;
    bunga_hangus: number;
    bunga_dibayar: number;
    pokok_bruto: number;
    pokok_dibayar: number;
    total_payout: number;
  }>(`SELECT * FROM simpanan_berjangka_pencairan_dini WHERE simpanan_berjangka_id = ?`, kontrakId);
}

async function hitung(sql: string, ...params: (string | number)[]): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(sql, ...params);
  return row?.n ?? 0;
}

beforeEach(async () => {
  db = await siapkanDb();
  awal = await ambilBaseline();
});

// ===========================================================================
// HARNESS — DB contract yang dipakai production repository benar-benar ada
// ===========================================================================

describe('HARNESS — getDb() mengembalikan SQLite nyata dengan kontrak expo-sqlite', () => {
  it('getDb() dan withTransaction() yang di-mock menunjuk ke DB uji yang SAMA', async () => {
    const dbProd = await getDb();
    await dbProd.runAsync(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('harness-probe','1',?)`,
      new Date().toISOString()
    );
    const baca = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM app_config WHERE key = 'harness-probe'`
    );
    expect(baca?.value).toBe('1');
  });

  it('runAsync / getFirstAsync / getAllAsync / execAsync mengeksekusi SQL sungguhan', async () => {
    await db.execAsync(`CREATE TABLE harness_probe (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)`);
    await db.runAsync(`INSERT INTO harness_probe (id, v) VALUES (?, ?)`, 1, 10);
    await db.runAsync(`INSERT INTO harness_probe (id, v) VALUES (?, ?)`, 2, 20);
    const upd = await db.runAsync(`UPDATE harness_probe SET v = v + 1 WHERE id = ?`, 2);
    expect(upd.changes).toBe(1);
    expect((await db.getFirstAsync<{ v: number }>(`SELECT v FROM harness_probe WHERE id = 2`))?.v).toBe(21);
    expect(await db.getAllAsync(`SELECT * FROM harness_probe`)).toHaveLength(2);
    // Constraint nyata: NOT NULL ditolak oleh engine, bukan oleh mock.
    await expect(db.runAsync(`INSERT INTO harness_probe (id, v) VALUES (3, NULL)`)).rejects.toThrow();
  });

  it('BEGIN/COMMIT menyimpan; kegagalan di dalam transaksi di-ROLLBACK', async () => {
    await db.execAsync(`CREATE TABLE harness_tx (v INTEGER)`);
    await db.withTransactionAsync(async () => {
      await db.runAsync(`INSERT INTO harness_tx (v) VALUES (1)`);
    });
    await expect(
      db.withTransactionAsync(async () => {
        await db.runAsync(`INSERT INTO harness_tx (v) VALUES (2)`);
        throw new Error('gagal disengaja');
      })
    ).rejects.toThrow('gagal disengaja');
    expect(await hitung(`SELECT COUNT(*) n FROM harness_tx`)).toBe(1);
  });
});

// ===========================================================================
// CASE A — PARTIAL TRANSFER
// ===========================================================================

describe('CASE A — sebagian bunga sudah ditransfer (100.000 dari 300.000)', () => {
  it('transfer nyata terbaca dari DB oleh preview; preview === eksekusi', async () => {
    const kontrakId = await siapkanKontrakDenganTransfer(1);

    // Transfer benar-benar duduk di DB.
    const status = await getStatusTransferBunga(kontrakId);
    expect(status.filter((p) => p.sudahDitransfer).map((p) => p.nomorPeriode)).toEqual([1]);

    const preview = await previewPencairanDiniPadaDb(await getDb(), kontrakId, TANGGAL_TARIK);
    expect(preview.alasanTidakBoleh).toBeNull();
    expect(preview.settlement).not.toBeNull();
    expect(preview.settlement?.totalBungaEarned).toBe(EARNED);
    expect(preview.settlement?.bungaSudahDitransfer).toBe(100_000);
    expect(preview.settlement?.bungaMasihTerutang).toBe(200_000);

    const hasil = await cairkanSimpananBerjangkaDini({
      kontrakId,
      tanggal: TANGGAL_TARIK,
      sumberDana: 'KAS',
      createdBy: USER_ID,
    });
    expect(hasil.duplikat).toBe(false);
    expect(hasil.settlement?.bungaSudahDitransfer).toBe(100_000);
    expect(hasil.settlement?.bungaMasihTerutang).toBe(200_000);
    // Preview dan eksekusi harus bertemu di angka yang sama.
    expect(hasil.settlement?.bungaAkrualKontrak).toBe(preview.settlement?.bungaAkrualKontrak);
    expect(hasil.settlement?.totalPayout).toBe(preview.settlement?.totalPayout);

    const row = await settlementRow(kontrakId);
    expect(row?.bunga_akrual_kontrak).toBe(200_000);
    expect(row?.total_payout).toBe(POKOK_UJI + 200_000);

    const baris = await barisJurnal(row!.journal_id);
    expect(sumDebit(baris, ACC.utangBungaBerjangka)).toBe(200_000);
  });
});

// ===========================================================================
// CASE B — FULL TRANSFER
// ===========================================================================

describe('CASE B — seluruh bunga earned sudah ditransfer', () => {
  it('outstanding 0 -> debit 2-1710 = 0 dan tidak ada beban baru', async () => {
    const kontrakId = await siapkanKontrakDenganTransfer(3);
    const bebanSebelumEw = await saldoGl(db, ACC.bebanBungaBerjangka);

    const preview = await previewPencairanDiniPadaDb(await getDb(), kontrakId, TANGGAL_TARIK);
    expect(preview.settlement?.bungaSudahDitransfer).toBe(EARNED);
    expect(preview.settlement?.bungaMasihTerutang).toBe(0);

    await cairkanSimpananBerjangkaDini({
      kontrakId,
      tanggal: TANGGAL_TARIK,
      sumberDana: 'KAS',
      createdBy: USER_ID,
    });

    const row = await settlementRow(kontrakId);
    expect(row?.bunga_akrual_kontrak).toBe(0);
    expect(row?.bunga_dibayar).toBe(0);
    expect(row?.total_payout).toBe(POKOK_UJI);

    const baris = await barisJurnal(row!.journal_id);
    expect(sumDebit(baris, ACC.utangBungaBerjangka)).toBe(0);
    expect(sumDebit(baris, ACC.bebanBungaBerjangka)).toBe(0);
    // Tidak ada beban baru: saldo beban tidak bergerak oleh pencairan dini.
    expect(await saldoGl(db, ACC.bebanBungaBerjangka)).toBe(bebanSebelumEw);
    expect(await saldoGl(db, ACC.bebanBungaBerjangka) - awal.beban).toBe(EARNED);
  });
});

// ===========================================================================
// CASE C — NO TRANSFER
// ===========================================================================

describe('CASE C — tanpa transfer (perilaku sebelum Item #1 utuh)', () => {
  it('outstanding = earned; debit 2-1710 = seluruh earned', async () => {
    const kontrakId = await siapkanKontrakDenganTransfer(0);

    const preview = await previewPencairanDiniPadaDb(await getDb(), kontrakId, TANGGAL_TARIK);
    expect(preview.settlement?.bungaSudahDitransfer).toBe(0);
    expect(preview.settlement?.bungaMasihTerutang).toBe(EARNED);

    await cairkanSimpananBerjangkaDini({
      kontrakId,
      tanggal: TANGGAL_TARIK,
      sumberDana: 'KAS',
      createdBy: USER_ID,
    });
    const row = await settlementRow(kontrakId);
    expect(row?.bunga_akrual_kontrak).toBe(EARNED);
    expect(row?.total_payout).toBe(POKOK_UJI + EARNED);
    const baris = await barisJurnal(row!.journal_id);
    expect(sumDebit(baris, ACC.utangBungaBerjangka)).toBe(EARNED);
    expect(await saldoGl(db, ACC.utangBungaBerjangka)).toBe(awal.utangBunga);
  });

  it('kebijakan enam komponen tanpa transfer tetap menghasilkan angka suite EW existing (skala pokok 20 jt)', async () => {
    const kontrakId = await siapkanKontrakDenganTransfer(0, { kebijakan: KEBIJAKAN_ENAM_KOMPONEN });
    const preview = await previewPencairanDiniPadaDb(await getDb(), kontrakId, TANGGAL_TARIK);
    const hasil = await cairkanSimpananBerjangkaDini({
      kontrakId,
      tanggal: TANGGAL_TARIK,
      sumberDana: 'KAS',
      createdBy: USER_ID,
    });
    expect(hasil.settlement).toEqual(preview.settlement);
    expect(hasil.settlement?.bungaSudahDitransfer).toBe(0);
    expect(hasil.settlement?.bungaAkrualKontrak).toBe(EARNED);
  });
});

// ===========================================================================
// CASE D — MULTIPLE PERIODS
// ===========================================================================

describe('CASE D — multi periode: P1 & P2 ditransfer, P3 belum', () => {
  it('akrual P3 diselesaikan eksekusi: earned 300.000, transferred 200.000, outstanding 100.000', async () => {
    const kontrakId = await siapkanKontrakDenganTransfer(2);
    const preview = await previewPencairanDiniPadaDb(await getDb(), kontrakId, TANGGAL_TARIK);
    expect(preview.settlement?.totalBungaEarned).toBe(EARNED);
    expect(preview.settlement?.bungaSudahDitransfer).toBe(200_000);
    expect(preview.settlement?.bungaMasihTerutang).toBe(100_000);
    // P3 belum diakru saat preview; eksekusi yang menyelesaikannya.
    expect(preview.bungaBelumDiakru).toBe(BUNGA_PERIODE);

    await cairkanSimpananBerjangkaDini({
      kontrakId,
      tanggal: TANGGAL_TARIK,
      sumberDana: 'KAS',
      createdBy: USER_ID,
    });
    const row = await settlementRow(kontrakId);
    expect(row?.bunga_akrual_kontrak).toBe(100_000);
    expect(sumDebit(await barisJurnal(row!.journal_id), ACC.utangBungaBerjangka)).toBe(100_000);
  });

  it('akrual P3 sudah lebih dulu diposting sebelum transfer P1–P2: hasil identik', async () => {
    const kontrakId = await siapkanKontrakDenganTransfer(2, { akrualSampai: TANGGAL_TARIK });
    const preview = await previewPencairanDiniPadaDb(await getDb(), kontrakId, TANGGAL_TARIK);
    expect(preview.bungaBelumDiakru).toBe(0);
    expect(preview.settlement?.bungaMasihTerutang).toBe(100_000);

    await cairkanSimpananBerjangkaDini({
      kontrakId,
      tanggal: TANGGAL_TARIK,
      sumberDana: 'KAS',
      createdBy: USER_ID,
    });
    const row = await settlementRow(kontrakId);
    expect(row?.bunga_akrual_kontrak).toBe(100_000);
  });

  it('forfeiture/rate dini kebijakan enam komponen hanya bekerja atas outstanding', async () => {
    const kontrakId = await siapkanKontrakDenganTransfer(2, { kebijakan: KEBIJAKAN_ENAM_KOMPONEN });
    const preview = await previewPencairanDiniPadaDb(await getDb(), kontrakId, TANGGAL_TARIK);
    const hasil = await cairkanSimpananBerjangkaDini({
      kontrakId,
      tanggal: TANGGAL_TARIK,
      sumberDana: 'KAS',
      createdBy: USER_ID,
    });
    expect(hasil.settlement).toEqual(preview.settlement);
    const s = hasil.settlement!;
    expect(s.bungaAkrualKontrak).toBe(100_000);
    expect(s.bungaHangus).toBeLessThanOrEqual(s.bungaMasihTerutang);
    expect(s.bungaDibayar).toBeLessThanOrEqual(s.bungaMasihTerutang);

    const row = await settlementRow(kontrakId);
    const baris = await barisJurnal(row!.journal_id);
    const d = baris.reduce((t, x) => t + x.debit, 0);
    const k = baris.reduce((t, x) => t + x.kredit, 0);
    expect(d).toBe(k);
    expect(sumDebit(baris, ACC.utangBungaBerjangka)).toBe(100_000);
    // 2-1710 kontrak ini habis tepat nol — tidak negatif.
    expect(await saldoGl(db, ACC.utangBungaBerjangka)).toBe(awal.utangBunga);
  });
});

// ===========================================================================
// CASE E — SUBLEDGER
// ===========================================================================

describe('CASE E — subledger setelah penarikan dini', () => {
  it('Sukarela tetap memuat bunga yang ditransfer; Berjangka lunas; Utang Bunga hanya outstanding yang diselesaikan', async () => {
    const kontrakId = await siapkanKontrakDenganTransfer(1);
    const dbProd = await getDb();

    const sukarelaSetelahTransfer = await getSaldoSimpanan(dbProd, ANGGOTA_ID, 'SUKARELA');
    expect(sukarelaSetelahTransfer - awal.sukarelaSubledger).toBe(100_000);
    const utangSebelumEw = await getTotalUtangBungaBerjangka();

    await cairkanSimpananBerjangkaDini({
      kontrakId,
      tanggal: TANGGAL_TARIK,
      sumberDana: 'KAS',
      createdBy: USER_ID,
    });

    // Simpanan Sukarela — bunga yang sudah ditransfer TIDAK ditarik kembali.
    expect(await getSaldoSimpanan(dbProd, ANGGOTA_ID, 'SUKARELA')).toBe(sukarelaSetelahTransfer);
    expect(await saldoGl(db, ACC.simpananSukarela) - awal.sukarelaGl).toBe(100_000);
    expect(
      await hitung(
        `SELECT COUNT(*) n FROM simpanan_transaksi WHERE idempotency_key = ?`,
        kunciTransferBunga(kontrakId, 1)
      )
    ).toBe(1);

    // Simpanan Berjangka — kontrak selesai, pokok lunas di GL.
    const kontrak = await db.getFirstAsync<{ status: string; bunga_terakru: number; bunga_dibayar: number }>(
      `SELECT status, bunga_terakru, bunga_dibayar FROM simpanan_berjangka WHERE id = ?`,
      kontrakId
    );
    expect(kontrak?.status).toBe('DICAIRKAN');
    expect(kontrak?.bunga_terakru).toBe(EARNED);
    expect(kontrak?.bunga_dibayar).toBe(200_000);
    expect(await saldoGl(db, ACC.berjangka)).toBe(awal.berjangka);

    // Utang Bunga — sebelum EW: P1 diakru lalu ditransfer, jadi subledger
    // 0. Eksekusi mengakru P2 & P3 (+200.000) lalu menyelesaikan HANYA
    // bagian itu; P1 (sudah di Sukarela) tidak didebit ulang.
    expect(utangSebelumEw).toBe(0);
    expect((await mutasi2_1710PerSumber(TRANSAKSI_PENCAIRAN_DINI)).debit).toBe(200_000);
    expect((await mutasi2_1710PerSumber(TRANSAKSI_BUNGA_TRANSFER)).debit).toBe(100_000);
    expect(await getTotalUtangBungaBerjangka()).toBe(0);
    expect(await saldoGl(db, ACC.utangBungaBerjangka)).toBe(awal.utangBunga);

    // Kas: +pokok saat penempatan, -(pokok + outstanding) saat pencairan.
    expect(awal.kas - (await saldoGl(db, ACC.kas))).toBe(200_000);
  });
});

// ===========================================================================
// CASE F — JOURNAL
// ===========================================================================

describe('CASE F — jurnal aktual dari database', () => {
  it.each([
    [0, EARNED],
    [1, 200_000],
    [2, 100_000],
    [3, 0],
  ] as const)(
    'transfer %i periode -> debit 2-1710 = %i, seimbang, tanpa double expense',
    async (nTransfer, outstanding) => {
      const kontrakId = await siapkanKontrakDenganTransfer(nTransfer);
      const hasil = await cairkanSimpananBerjangkaDini({
        kontrakId,
        tanggal: TANGGAL_TARIK,
        sumberDana: 'KAS',
        createdBy: USER_ID,
      });

      const jurnal = await db.getFirstAsync<{ id: string; sumber_transaksi: string; status: string }>(
        `SELECT id, sumber_transaksi, status FROM journal WHERE id = ?`,
        hasil.journalId
      );
      expect(jurnal?.sumber_transaksi).toBe(TRANSAKSI_PENCAIRAN_DINI);
      expect(jurnal?.status).toBe('POSTED');

      const baris = await barisJurnal(jurnal!.id);
      const totalD = baris.reduce((t, x) => t + x.debit, 0);
      const totalK = baris.reduce((t, x) => t + x.kredit, 0);
      expect(totalD).toBe(totalK);

      const debit2_1710 = sumDebit(baris, ACC.utangBungaBerjangka);
      expect(debit2_1710).toBe(outstanding);
      expect(debit2_1710).toBeLessThanOrEqual(EARNED - nTransfer * BUNGA_PERIODE);
      expect(sumKredit(baris, ACC.utangBungaBerjangka)).toBe(0);
      expect(sumDebit(baris, ACC.berjangka)).toBe(POKOK_UJI);
      expect(sumKredit(baris, ACC.kas)).toBe(POKOK_UJI + outstanding);
      // Kebijakan netral: tidak ada baris beban sama sekali.
      expect(sumDebit(baris, ACC.bebanBungaBerjangka)).toBe(0);
      expect(sumKredit(baris, ACC.bebanBungaBerjangka)).toBe(0);

      // Beban total = akrual saja (satu kali), tidak ada beban kedua.
      expect(await saldoGl(db, ACC.bebanBungaBerjangka) - awal.beban).toBe(EARNED);
      // 2-1710 tidak pernah negatif untuk kontrak ini.
      expect(await saldoGl(db, ACC.utangBungaBerjangka)).toBe(awal.utangBunga);
    }
  );
});

// ===========================================================================
// CASE G — FOUR-LAYER RECONCILIATION
// ===========================================================================

describe('CASE G — Settlement / Transfer history / Subledger / GL konsisten', () => {
  it.each([0, 1, 2, 3] as const)('transfer %i periode', async (nTransfer) => {
    const kontrakId = await siapkanKontrakDenganTransfer(nTransfer);
    await cairkanSimpananBerjangkaDini({
      kontrakId,
      tanggal: TANGGAL_TARIK,
      sumberDana: 'KAS',
      createdBy: USER_ID,
    });
    const dbProd = await getDb();

    // Layer 1 — Settlement
    const s = await settlementRow(kontrakId);
    // Layer 2 — Transfer history (status per periode + baris subledger transfer)
    const history = await getStatusTransferBunga(kontrakId);
    const transferHistory = history.filter((p) => p.sudahDitransfer).reduce((t, p) => t + p.bunga, 0);
    const transferRows = await hitung(
      `SELECT COALESCE(SUM(nominal),0) n FROM simpanan_transaksi WHERE idempotency_key LIKE ?`,
      `SBT-${kontrakId}-%`
    );
    // Layer 3 — Subledger
    const sukarelaDelta = (await getSaldoSimpanan(dbProd, ANGGOTA_ID, 'SUKARELA')) - awal.sukarelaSubledger;
    const bungaRows = await hitung(
      `SELECT COALESCE(SUM(bunga),0) n FROM simpanan_berjangka_bunga WHERE simpanan_berjangka_id = ?`,
      kontrakId
    );
    // Layer 4 — GL
    const akrual = await mutasi2_1710PerSumber('SIMPANAN_BERJANGKA_BUNGA_AKRUAL');
    const transferGl = await mutasi2_1710PerSumber(TRANSAKSI_BUNGA_TRANSFER);
    const ewGl = await mutasi2_1710PerSumber(TRANSAKSI_PENCAIRAN_DINI);
    const sukarelaGlDelta = (await saldoGl(db, ACC.simpananSukarela)) - awal.sukarelaGl;

    const T = nTransfer * BUNGA_PERIODE;
    expect(transferHistory).toBe(T);
    expect(transferRows).toBe(T);
    expect(sukarelaDelta).toBe(T);
    expect(sukarelaGlDelta).toBe(T);
    expect(transferGl.debit).toBe(T);

    expect(bungaRows).toBe(EARNED);
    expect(akrual.kredit).toBe(EARNED);

    expect(s?.bunga_akrual_kontrak).toBe(EARNED - T);
    expect(ewGl.debit).toBe(s?.bunga_akrual_kontrak);

    // Identitas penutup: seluruh kredit akrual = transfer + settlement.
    expect(akrual.kredit).toBe(transferGl.debit + ewGl.debit);
    expect(await saldoGl(db, ACC.utangBungaBerjangka)).toBe(awal.utangBunga);
    expect(await getTotalUtangBungaBerjangka()).toBe(0);
  });
});

// ===========================================================================
// CASE H — REPEAT WITHDRAWAL
// ===========================================================================

describe('CASE H — request berulang', () => {
  it('idempotency key sama -> tidak ada settlement/jurnal/debit/pengurangan saldo kedua', async () => {
    const kontrakId = await siapkanKontrakDenganTransfer(1);
    const input = {
      kontrakId,
      tanggal: TANGGAL_TARIK,
      sumberDana: 'KAS' as const,
      createdBy: USER_ID,
      idempotencyKey: 'EW-RCS54-T6-KEY-1',
    };
    const pertama = await cairkanSimpananBerjangkaDini(input);
    expect(pertama.duplikat).toBe(false);
    const setelahPertama = await snapshotBuku(db);
    const debit2_1710Pertama = (await mutasi2_1710PerSumber(TRANSAKSI_PENCAIRAN_DINI)).debit;
    const sukarelaPertama = await getSaldoSimpanan(await getDb(), ANGGOTA_ID, 'SUKARELA');

    const kedua = await cairkanSimpananBerjangkaDini(input);
    expect(kedua.duplikat).toBe(true);
    expect(kedua.settlementId).toBe(pertama.settlementId);
    expect(kedua.journalId).toBe(pertama.journalId);

    expect(await snapshotBuku(db)).toEqual(setelahPertama);
    expect(
      await hitung(
        `SELECT COUNT(*) n FROM simpanan_berjangka_pencairan_dini WHERE simpanan_berjangka_id = ?`,
        kontrakId
      )
    ).toBe(1);
    expect(
      await hitung(`SELECT COUNT(*) n FROM journal WHERE sumber_transaksi = ?`, TRANSAKSI_PENCAIRAN_DINI)
    ).toBe(1);
    expect((await mutasi2_1710PerSumber(TRANSAKSI_PENCAIRAN_DINI)).debit).toBe(debit2_1710Pertama);
    expect(debit2_1710Pertama).toBe(200_000);
    expect(await getSaldoSimpanan(await getDb(), ANGGOTA_ID, 'SUKARELA')).toBe(sukarelaPertama);
  });

  it('request BARU setelah kontrak tidak eligible ditolak lifecycle existing, tanpa efek', async () => {
    const kontrakId = await siapkanKontrakDenganTransfer(1);
    await cairkanSimpananBerjangkaDini({
      kontrakId,
      tanggal: TANGGAL_TARIK,
      sumberDana: 'KAS',
      createdBy: USER_ID,
      idempotencyKey: 'EW-RCS54-T6-KEY-A',
    });
    const snap = await snapshotBuku(db);

    await expect(
      cairkanSimpananBerjangkaDini({
        kontrakId,
        tanggal: TANGGAL_TARIK,
        sumberDana: 'KAS',
        createdBy: USER_ID,
        idempotencyKey: 'EW-RCS54-T6-KEY-B',
      })
    ).rejects.toThrow(PESAN_SUDAH_DICAIRKAN_DINI);
    await expect(
      cairkanSimpananBerjangkaDini({ kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID })
    ).rejects.toThrow(PESAN_SUDAH_DICAIRKAN_DINI);

    // Transfer bunga setelah pencairan tidak memindahkan apa pun lagi.
    const transferLagi = await prosesTransferBungaKeSukarela(kontrakId, TANGGAL_TARIK, USER_ID);
    expect(transferLagi.totalDipindahkanSekarang).toBe(0);

    const preview = await previewPencairanDiniPadaDb(await getDb(), kontrakId, TANGGAL_TARIK);
    expect(preview.alasanTidakBoleh).toBe(PESAN_SUDAH_DICAIRKAN_DINI);
    expect(preview.settlement).toBeNull();

    expect(await snapshotBuku(db)).toEqual(snap);
  });
});

// ===========================================================================
// CASE I — RECONCILIATION SERVICE (existing)
// ===========================================================================

describe('CASE I — jalankanRekonsiliasiLengkap() existing', () => {
  it.each([0, 1, 2, 3] as const)('transfer %i periode -> seluruh domain SEIMBANG', async (nTransfer) => {
    const kontrakId = await siapkanKontrakDenganTransfer(nTransfer);
    await cairkanSimpananBerjangkaDini({
      kontrakId,
      tanggal: TANGGAL_TARIK,
      sumberDana: 'KAS',
      createdBy: USER_ID,
    });
    const h = await jalankanRekonsiliasiLengkap(await getDb());
    expect(h.jurnalSeimbang).toBe(true);
    const tidakSeimbang = h.baris.filter((b) => b.status === 'SELISIH');
    expect(tidakSeimbang.map((b) => `${b.domain}:${b.variance}`)).toEqual([]);
    const utang = h.baris.find((b) => b.domain === 'Savings berjangka (utang bunga)');
    expect(utang?.variance).toBe(0);
    expect(h.seluruhnyaSeimbang).toBe(true);
  });
});

// ===========================================================================
// CASE J — INVALID DATA (dibaca dari database, tidak di-clamp)
// ===========================================================================

describe('CASE J — data transfer tidak valid ditolak, tidak di-clamp', () => {
  async function korupsiPeriodeTransfer(kontrakId: string, nilaiBaru: number) {
    const upd = await db.runAsync(
      `UPDATE simpanan_berjangka_bunga SET bunga = ? WHERE simpanan_berjangka_id = ? AND nomor_periode = 1`,
      nilaiBaru,
      kontrakId
    );
    expect(upd.changes).toBe(1);
  }

  it('total transfer < 0 -> preview & eksekusi menolak, buku tidak berubah', async () => {
    const kontrakId = await siapkanKontrakDenganTransfer(1, { akrualSampai: TANGGAL_TARIK });
    await korupsiPeriodeTransfer(kontrakId, -1);
    const snap = await snapshotBuku(db);

    await expect(previewPencairanDiniPadaDb(await getDb(), kontrakId, TANGGAL_TARIK)).rejects.toThrow(
      SettlementDiniTidakDapatDihitungError
    );
    await expect(
      cairkanSimpananBerjangkaDini({ kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID })
    ).rejects.toThrow(/tidak boleh negatif/);
    expect(await snapshotBuku(db)).toEqual(snap);
  });

  it('total transfer > earned -> preview & eksekusi menolak, buku tidak berubah', async () => {
    const kontrakId = await siapkanKontrakDenganTransfer(1, { akrualSampai: TANGGAL_TARIK });
    await korupsiPeriodeTransfer(kontrakId, EARNED + 1);
    const snap = await snapshotBuku(db);

    await expect(previewPencairanDiniPadaDb(await getDb(), kontrakId, TANGGAL_TARIK)).rejects.toThrow(
      /melebihi bunga yang sudah earned/
    );
    await expect(
      cairkanSimpananBerjangkaDini({ kontrakId, tanggal: TANGGAL_TARIK, sumberDana: 'KAS', createdBy: USER_ID })
    ).rejects.toThrow(/melebihi bunga yang sudah earned/);
    expect(await snapshotBuku(db)).toEqual(snap);
  });

  it('kontrol: PLACEMENT fixture sesuai asumsi suite', () => {
    expect(PLACEMENT).toBe('2026-06-12');
    expect(TANGGAL_TARIK).toBe('2026-09-15');
  });
});

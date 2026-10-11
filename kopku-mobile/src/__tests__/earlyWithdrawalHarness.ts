import { TestDb } from './testDb';
import { buatFixtureHistoris, ACC, ANGGOTA_ID, USER_ID } from './historicalFixture';
import { KebijakanEarlyWithdrawal } from '@/accounting/EarlyWithdrawalPolicy';

/**
 * ============================================================
 * HARNESS BERSAMA — SUITE PENARIKAN DINI SIMPANAN BERJANGKA (S21)
 * ============================================================
 *
 * PERINGATAN PENTING TENTANG ANGKA KEBIJAKAN DI BERKAS INI:
 *
 * Seluruh nilai kebijakan di bawah (persentase penalti, porsi bunga
 * hangus, nominal biaya administrasi, rate penarikan dini) adalah
 * FIXTURE UJI — angka yang dipilih semata-mata supaya perhitungannya
 * bulat dan mudah diperiksa manusia. Angka-angka ini **BUKAN kebijakan
 * koperasi**, tidak pernah diklaim demikian, dan TIDAK di-seed ke
 * database produksi mana pun: tabel `simpanan_berjangka_kebijakan_dini`
 * tetap KOSONG pada instalasi baru maupun hasil migrasi.
 *
 * Yang dibuktikan suite-suite ini adalah bahwa MESIN-nya benar untuk
 * kebijakan apa pun yang kelak diisi pengurus — bukan bahwa kebijakan
 * tertentu sudah berlaku.
 */

interface Harness {
  db: TestDb | null;
}

export const harness: Harness = { db: null };

/**
 * Mock modul `@/database/db`. Dipakai setiap suite lewat
 *   jest.mock('@/database/db', () => require('./earlyWithdrawalHarness').dbMock);
 * sehingga blok mock tidak perlu disalin ke 20 berkas.
 */
export const dbMock = {
  getDb: async () => harness.db,
  withTransaction: async (fn: (db: TestDb) => Promise<unknown>) => {
    let hasil: unknown;
    await harness.db!.withTransactionAsync(async () => {
      hasil = await fn(harness.db!);
    });
    return hasil;
  },
};

export { ACC, ANGGOTA_ID, USER_ID };

// ---- Kontrak contoh §AQ ----
export const POKOK = 24_000_000;
export const RATE_KONTRAK = 6; // % per tahun
export const TENOR = 6 as const; // bulan
export const PLACEMENT = '2026-06-12';
export const JATUH_TEMPO = '2026-12-12';
/** 3 periode bunga sudah earned (12 Jul, 12 Agu, 12 Sep). */
export const TANGGAL_TARIK = '2026-09-15';
/** 24.000.000 x 6% x 6/12 = 720.000, dibagi rata 6 periode. */
export const BUNGA_PER_PERIODE = 120_000;
export const BUNGA_EARNED_3_PERIODE = 360_000;

export async function siapkanDb(): Promise<TestDb> {
  const db = await buatFixtureHistoris();
  harness.db = db;
  return db;
}

/**
 * Kebijakan dasar: SEMUA komponen tidak berlaku. Dipakai skenario §P
 * (no-adjustment) dan sebagai titik awal varian lain.
 */
export const KEBIJAKAN_NETRAL: KebijakanEarlyWithdrawal = {
  versi: 'EW-UJI-NETRAL',
  berlakuMulai: '2026-01-01',
  diizinkan: true,
  jenisPenalti: 'TIDAK_ADA',
  nilaiPenalti: null,
  basisPenalti: null,
  akunPenaltiId: null,
  jenisForfeiture: 'TIDAK_ADA',
  nilaiForfeiture: null,
  jenisBiayaAdmin: 'TIDAK_ADA',
  nilaiBiayaAdmin: null,
  basisBiayaAdmin: null,
  akunBiayaAdminId: null,
  rateDini: null,
  jenisPenyesuaianRate: 'TIDAK_ADA',
  cakupanPenyesuaianRate: null,
  perlakuanPokok: 'PENUH',
  perlakuanBunga: 'BAYAR_SETELAH_FORFEITURE',
  dasarPenetapan: 'FIXTURE UJI — bukan kebijakan koperasi',
  ditetapkanOleh: 'suite otomatis',
};

/**
 * Kebijakan lengkap enam komponen — dipakai contoh konkret §AQ.
 *
 * penalti 2% dari pokok, bunga hangus 50%, biaya admin Rp50.000,
 * rate dini 3%/tahun sejak penempatan, potongan dibebankan ke POKOK.
 */
export const KEBIJAKAN_ENAM_KOMPONEN: KebijakanEarlyWithdrawal = {
  ...KEBIJAKAN_NETRAL,
  versi: 'EW-UJI-ENAM',
  jenisPenalti: 'PERSENTASE',
  nilaiPenalti: 2,
  basisPenalti: 'POKOK',
  akunPenaltiId: ACC.pendapatanDenda,
  jenisForfeiture: 'PERSENTASE_BUNGA',
  nilaiForfeiture: 50,
  jenisBiayaAdmin: 'NOMINAL_TETAP',
  nilaiBiayaAdmin: 50_000,
  akunBiayaAdminId: ACC.pendapatanAdmin,
  rateDini: 3,
  jenisPenyesuaianRate: 'RATE_DINI',
  cakupanPenyesuaianRate: 'SEJAK_PENEMPATAN',
  perlakuanPokok: 'DIKURANGI_PENALTI_DAN_BIAYA',
};

/** Tulis kebijakan langsung ke tabel (menonaktifkan yang lama). */
export async function pasangKebijakan(
  db: TestDb,
  k: KebijakanEarlyWithdrawal
): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE simpanan_berjangka_kebijakan_dini SET status = 'NONAKTIF' WHERE status = 'AKTIF'`
  );
  await db.runAsync(
    `INSERT INTO simpanan_berjangka_kebijakan_dini
      (id, versi, berlaku_mulai, diizinkan,
       jenis_penalti, nilai_penalti, basis_penalti, akun_penalti_id,
       jenis_forfeiture, nilai_forfeiture,
       jenis_biaya_admin, nilai_biaya_admin, basis_biaya_admin, akun_biaya_admin_id,
       rate_dini, jenis_penyesuaian_rate, cakupan_penyesuaian_rate,
       perlakuan_pokok, perlakuan_bunga, dasar_penetapan, ditetapkan_oleh,
       status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'AKTIF',?,?,?)`,
    `kbj-${k.versi}-${Math.random().toString(36).slice(2, 8)}`,
    k.versi,
    k.berlakuMulai,
    k.diizinkan ? 1 : 0,
    k.jenisPenalti,
    k.nilaiPenalti,
    k.basisPenalti,
    k.akunPenaltiId,
    k.jenisForfeiture,
    k.nilaiForfeiture,
    k.jenisBiayaAdmin,
    k.nilaiBiayaAdmin,
    k.basisBiayaAdmin,
    k.akunBiayaAdminId,
    k.rateDini,
    k.jenisPenyesuaianRate,
    k.cakupanPenyesuaianRate,
    k.perlakuanPokok,
    k.perlakuanBunga,
    k.dasarPenetapan,
    k.ditetapkanOleh,
    USER_ID,
    now,
    now
  );
}

/** Saldo GL satu akun (POSTED/REVERSED), menghormati normal balance. */
export async function saldoGl(db: TestDb, accountId: string): Promise<number> {
  const row = await db.getFirstAsync<{ nb: string; d: number; k: number }>(
    `SELECT a.normal_balance nb,
            COALESCE(SUM(je.debit),0) d, COALESCE(SUM(je.kredit),0) k
     FROM account a
     LEFT JOIN journal_entry je ON je.account_id = a.id
     LEFT JOIN journal j ON j.id = je.journal_id AND j.status IN ('POSTED','REVERSED')
     WHERE a.id = ? GROUP BY a.id, a.normal_balance`,
    accountId
  );
  if (!row) return 0;
  return row.nb === 'DEBIT' ? row.d - row.k : row.k - row.d;
}

export async function totalDebitKredit(db: TestDb): Promise<{ debit: number; kredit: number }> {
  const row = await db.getFirstAsync<{ d: number; k: number }>(
    `SELECT COALESCE(SUM(je.debit),0) d, COALESCE(SUM(je.kredit),0) k
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE j.status IN ('POSTED','REVERSED')`
  );
  return { debit: row?.d ?? 0, kredit: row?.k ?? 0 };
}

/** Snapshot menyeluruh untuk uji atomicity / closed period. */
export async function snapshotBuku(db: TestDb) {
  return {
    jurnal: await db.getAllAsync<Record<string, unknown>>(
      `SELECT id, tanggal, sumber_transaksi, status FROM journal ORDER BY id`
    ),
    entry: await db.getAllAsync<Record<string, unknown>>(
      `SELECT journal_id, account_id, debit, kredit FROM journal_entry ORDER BY journal_id, account_id, debit, kredit`
    ),
    kontrak: await db.getAllAsync<Record<string, unknown>>(
      `SELECT id, status, nominal, suku_bunga, bunga_terakru, bunga_dibayar,
              tanggal_pencairan, journal_pencairan_id
       FROM simpanan_berjangka ORDER BY id`
    ),
    bungaEvent: await db.getAllAsync<Record<string, unknown>>(
      `SELECT simpanan_berjangka_id, nomor_periode, bunga FROM simpanan_berjangka_bunga
       ORDER BY simpanan_berjangka_id, nomor_periode`
    ),
    settlementDini: await db.getAllAsync<Record<string, unknown>>(
      `SELECT * FROM simpanan_berjangka_pencairan_dini ORDER BY id`
    ),
    kas: await saldoGl(db, ACC.kas),
    berjangka: await saldoGl(db, ACC.berjangka),
    utangBunga: await saldoGl(db, ACC.utangBungaBerjangka),
    beban: await saldoGl(db, ACC.bebanBungaBerjangka),
    denda: await saldoGl(db, ACC.pendapatanDenda),
    admin: await saldoGl(db, ACC.pendapatanAdmin),
    periode: await db.getAllAsync<Record<string, unknown>>(
      `SELECT id, status FROM accounting_period ORDER BY id`
    ),
  };
}

import { createTestDb, TestDb } from './testDb';
import { seedKebijakanProdukUji } from './kebijakanProdukBerjangkaUji';

/**
 * ============================================================
 * FIXTURE BERSAMA — AUDIT TRANSAKSI HISTORIS / BACKDATED
 * ============================================================
 *
 * SATU dataset awal yang dipakai seluruh suite historis supaya
 * perbandingan antar-suite (dan antar-DATABASE pada differential test)
 * benar-benar setara. Yang disuntik langsung ke tabel HANYA data
 * referensi (akun, mapping, anggota, user, rekening bank, periode) dan
 * SATU jurnal modal awal — seluruh transaksi yang diuji dibuat lewat
 * service asli supaya jurnalnya melewati `createJournal()` seperti di
 * produksi.
 *
 * Tahun buku yang dipakai audit ini: 2026 (periode 2025 & 2027 ikut
 * disiapkan supaya batas tahun bisa diuji tanpa membuat periode di
 * tengah test).
 */

export const ACC = {
  kas: 'acc-kas',
  bank: 'acc-bank',
  piutangPokok: 'acc-piutang-pokok',
  piutangJasa: 'acc-piutang-jasa',
  penyisihan: 'acc-penyisihan',
  asetTetap: 'acc-aset-tetap',
  akumulasi: 'acc-akumulasi',
  pendapatanDimuka: 'acc-pendapatan-dimuka',
  simpananSukarela: 'acc-simpanan-sukarela',
  berjangka: 'acc-berjangka',
  utangBungaBerjangka: 'acc-utang-bunga-berjangka',
  utangBank: 'acc-utang-bank',
  utangBunga: 'acc-utang-bunga',
  simpananPokok: 'acc-simpanan-pokok',
  simpananWajib: 'acc-simpanan-wajib',
  modal: 'acc-modal',
  pendapatanJasa: 'acc-pendapatan-jasa',
  pendapatanAdmin: 'acc-pendapatan-admin',
  pendapatanDenda: 'acc-pendapatan-denda',
  pendapatanLain: 'acc-pendapatan-lain',
  bebanPenyusutan: 'acc-beban-penyusutan',
  bebanBunga: 'acc-beban-bunga',
  bebanBungaBerjangka: 'acc-beban-bunga-berjangka',
  bebanPenyisihan: 'acc-beban-penyisihan',
  bebanLain: 'acc-beban-lain',
} as const;

export const ANGGOTA_ID = 'anggota-1';
export const ANGGOTA_2_ID = 'anggota-2';
export const ANGGOTA_3_ID = 'anggota-3';
export const USER_ID = 'user-1';
export const BANK_ID = 'bank-1';
export const MODAL_AWAL_KAS = 300_000_000;
export const MODAL_AWAL_BANK = 200_000_000;
export const MODAL_AWAL = MODAL_AWAL_KAS + MODAL_AWAL_BANK;

async function seedAccount(
  db: TestDb,
  id: string,
  kode: string,
  nama: string,
  kategori: string,
  nb: 'DEBIT' | 'KREDIT'
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
     VALUES (?,?,?,?,?,1,1,?,?)`,
    id, kode, nama, kategori, nb, now, now
  );
}

async function seedMapping(db: TestDb, tt: string, role: string, accountId: string) {
  await db.runAsync(
    `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
    `map-${tt}-${role}`, tt, role, accountId
  );
}

/** Bangun database uji lengkap. Dipanggil ulang untuk tiap database differential. */
export async function buatFixtureHistoris(): Promise<TestDb> {
  const db = await createTestDb();
  await seedKebijakanProdukUji(db); // RC-S128: penempatan berjangka mewajibkan kebijakan produk
  const now = new Date().toISOString();

  const akun: [string, string, string, string, 'DEBIT' | 'KREDIT'][] = [
    [ACC.kas, '1-1000', 'Kas', 'ASET', 'DEBIT'],
    [ACC.bank, '1-1100', 'Bank BRI', 'ASET', 'DEBIT'],
    [ACC.piutangPokok, '1-1200', 'Piutang Pinjaman Anggota', 'ASET', 'DEBIT'],
    [ACC.piutangJasa, '1-1205', 'Piutang Jasa Pinjaman', 'ASET', 'DEBIT'],
    [ACC.penyisihan, '1-1210', 'Penyisihan Piutang Tak Tertagih', 'ASET', 'KREDIT'],
    [ACC.asetTetap, '1-1500', 'Aset Tetap', 'ASET', 'DEBIT'],
    [ACC.akumulasi, '1-1510', 'Akumulasi Penyusutan', 'ASET', 'KREDIT'],
    [ACC.simpananSukarela, '2-1100', 'Simpanan Sukarela', 'LIABILITAS', 'KREDIT'],
    [ACC.berjangka, '2-1210', 'Simpanan Anggota (Berjangka)', 'LIABILITAS', 'KREDIT'],
    [ACC.pendapatanDimuka, '2-1300', 'Pendapatan Diterima Dimuka', 'LIABILITAS', 'KREDIT'],
    [ACC.utangBank, '2-1400', 'Utang Bank', 'LIABILITAS', 'KREDIT'],
    [ACC.utangBunga, '2-1700', 'Utang Bunga Akrual', 'LIABILITAS', 'KREDIT'],
    [ACC.utangBungaBerjangka, '2-1710', 'Utang Bunga Simpanan Berjangka', 'LIABILITAS', 'KREDIT'],
    [ACC.simpananPokok, '3-1000', 'Simpanan Pokok', 'EKUITAS', 'KREDIT'],
    [ACC.simpananWajib, '3-1100', 'Simpanan Wajib', 'EKUITAS', 'KREDIT'],
    [ACC.modal, '3-3000', 'Modal Lainnya', 'EKUITAS', 'KREDIT'],
    [ACC.pendapatanJasa, '4-1000', 'Pendapatan Jasa Pinjaman', 'PENDAPATAN', 'KREDIT'],
    [ACC.pendapatanAdmin, '4-1100', 'Pendapatan Administrasi', 'PENDAPATAN', 'KREDIT'],
    [ACC.pendapatanDenda, '4-1200', 'Pendapatan Denda', 'PENDAPATAN', 'KREDIT'],
    [ACC.pendapatanLain, '4-2000', 'Pendapatan Lain-lain', 'PENDAPATAN', 'KREDIT'],
    [ACC.bebanPenyusutan, '5-1300', 'Beban Penyusutan', 'BEBAN', 'DEBIT'],
    [ACC.bebanBunga, '5-1950', 'Beban Bunga', 'BEBAN', 'DEBIT'],
    [ACC.bebanBungaBerjangka, '5-1955', 'Beban Bunga Simpanan Berjangka', 'BEBAN', 'DEBIT'],
    [ACC.bebanLain, '5-2000', 'Beban Lainnya', 'BEBAN', 'DEBIT'],
    [ACC.bebanPenyisihan, '5-2100', 'Beban Penyisihan', 'BEBAN', 'DEBIT'],
  ];
  for (const a of akun) await seedAccount(db, ...a);

  const mappings: [string, string, string][] = [
    ['KAS_UMUM', 'DEFAULT', ACC.kas],
    ['PENCAIRAN_PINJAMAN', 'DEBIT_PIUTANG', ACC.piutangPokok],
    ['ANGSURAN_JASA', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa],
    ['ANGSURAN_JASA', 'KREDIT_DIMUKA', ACC.pendapatanDimuka],
    ['ANGSURAN_DENDA', 'KREDIT_PENDAPATAN', ACC.pendapatanDenda],
    ['BIAYA_ADMIN_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanAdmin],
    ['BIAYA_ADMIN_PINJAMAN', 'KREDIT_DIMUKA', ACC.pendapatanDimuka],
    ['PELUNASAN_JASA_FUTURE', 'KREDIT_DIMUKA', ACC.pendapatanDimuka],
    ['AKRUAL_JASA_PINJAMAN', 'DEBIT_PIUTANG_JASA', ACC.piutangJasa],
    ['AKRUAL_JASA_PINJAMAN', 'DEBIT_DIMUKA', ACC.pendapatanDimuka],
    ['AKRUAL_JASA_PINJAMAN', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa],
    ['PEMBAYARAN_JASA_PINJAMAN', 'KREDIT_PIUTANG_JASA', ACC.piutangJasa],
    ['EIR_FEE_AMORTIZATION', 'DEBIT_DIMUKA', ACC.pendapatanDimuka],
    ['EIR_FEE_AMORTIZATION', 'KREDIT_PENDAPATAN', ACC.pendapatanJasa],
    ['PENYISIHAN_PIUTANG', 'DEBIT_BEBAN', ACC.bebanPenyisihan],
    ['PENYISIHAN_PIUTANG', 'KREDIT_PENYISIHAN', ACC.penyisihan],
    ['SIMPANAN_POKOK', 'KREDIT_DEFAULT', ACC.simpananPokok],
    ['SIMPANAN_WAJIB', 'KREDIT_DEFAULT', ACC.simpananWajib],
    ['SIMPANAN_SUKARELA', 'KREDIT_DEFAULT', ACC.simpananSukarela],
    ['SIMPANAN_BERJANGKA', 'KREDIT_DEFAULT', ACC.berjangka],
    ['SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'DEBIT_BEBAN', ACC.bebanBungaBerjangka],
    ['SIMPANAN_BERJANGKA_BUNGA_AKRUAL', 'KREDIT_UTANG_BUNGA', ACC.utangBungaBerjangka],
    ['SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_POKOK', ACC.berjangka],
    ['SIMPANAN_BERJANGKA_PENCAIRAN', 'DEBIT_UTANG_BUNGA', ACC.utangBungaBerjangka],
    ['ASET_TETAP', 'DEBIT_ASET', ACC.asetTetap],
    ['PENYUSUTAN_ASET', 'DEBIT_BEBAN', ACC.bebanPenyusutan],
    ['PENYUSUTAN_ASET', 'KREDIT_AKUMULASI', ACC.akumulasi],
    ['UTANG_BANK', 'KREDIT_DEFAULT', ACC.utangBank],
    ['UTANG_PIHAK_LAIN', 'KREDIT_DEFAULT', ACC.utangBank],
    ['UTANG_USAHA', 'KREDIT_DEFAULT', ACC.utangBank],
    ['UTANG_BUNGA', 'DEBIT_BEBAN', ACC.bebanBunga],
    ['UTANG_BUNGA', 'KREDIT_AKRUAL', ACC.utangBunga],
    ['MODAL_LAINNYA', 'KREDIT_DEFAULT', ACC.modal],
    ['PENDAPATAN_DITERIMA_DIMUKA', 'KREDIT_DEFAULT', ACC.pendapatanDimuka],
    ['PENGAKUAN_PENDAPATAN_DIMUKA', 'DEBIT_DIMUKA', ACC.pendapatanDimuka],
    ['PENGAKUAN_PENDAPATAN_DIMUKA', 'KREDIT_PENDAPATAN', ACC.pendapatanLain],
  ];
  for (const [t, r, a] of mappings) await seedMapping(db, t, r, a);

  for (const tahun of [2025, 2026, 2027]) {
    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
      `p${tahun}`, tahun, `${tahun}-01-01`, `${tahun}-12-31`
    );
  }

  for (const [id, nomor, nik] of [
    [ANGGOTA_ID, 'A001', '1234567890123456'],
    [ANGGOTA_2_ID, 'A002', '1234567890123457'],
    [ANGGOTA_3_ID, 'A003', '1234567890123458'],
  ]) {
    await db.runAsync(
      `INSERT INTO anggota (id, nomor_anggota, nik, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
       VALUES (?,?,?,?,'2020-01-01','AKTIF',?,?)`,
      id, nomor, nik, `Anggota ${nomor}`, now, now
    );
  }

  await db.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES (?,'Admin','admin','ADMIN','x','x',0,1,?,?)`,
    USER_ID, now, now
  );

  await db.runAsync(
    `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, account_id, saldo_awal, aktif, created_at)
     VALUES (?,?,?,?,?,0,1,?)`,
    BANK_ID, 'Bank BRI', '123456', 'Koperasi Uji', ACC.bank, now
  );

  await db.runAsync(
    `INSERT INTO rat (id, tahun_buku, tanggal_rat, created_by, created_at, updated_at)
     VALUES ('rat-2026',2026,'2026-05-01',?,?,?)`,
    USER_ID, now, now
  );

  // Modal awal tunai — SATU-SATUNYA jurnal yang disuntik langsung,
  // supaya seluruh transaksi berikutnya punya kas yang cukup dan
  // guard likuiditas tidak menolak pengeluaran historis.
  await db.runAsync(
    `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at, posted_at)
     VALUES ('j-modal','JRN-MODAL','2026-01-01','p2026','MODAL_UANG','Modal awal koperasi','POSTED',?,?,?,?)`,
    USER_ID, now, now, now
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-m1','j-modal',?,?,0)`,
    ACC.kas, MODAL_AWAL_KAS
  );
  // Bank ikut didanai di muka. WHY: guard likuiditas
  // (`checkSaldoAkunCukup`) memeriksa saldo BERJALAN akun, bukan saldo
  // pada tanggal transaksi — lihat temuan §H-2. Tanpa pendanaan awal,
  // uji urutan-acak akan gagal karena guard itu, bukan karena
  // akuntansinya salah, dan temuan yang sebenarnya jadi tertutup.
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-m1b','j-modal',?,?,0)`,
    ACC.bank, MODAL_AWAL_BANK
  );
  await db.runAsync(
    `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit) VALUES ('je-m2','j-modal',?,0,?)`,
    ACC.modal, MODAL_AWAL
  );

  return db;
}

// ============================================================
// PEMBANTU PEMERIKSAAN — dipakai berulang oleh suite historis
// ============================================================

/** Saldo GL satu akun sampai tanggal tertentu (POSTED/REVERSED saja). */
export async function saldoGl(db: TestDb, accountId: string, asOf?: string): Promise<number> {
  const filter = asOf ? 'AND j.tanggal <= ?' : '';
  const params = asOf ? [accountId, asOf] : [accountId];
  const row = await db.getFirstAsync<{ d: number; k: number }>(
    `SELECT COALESCE(SUM(je.debit),0) d, COALESCE(SUM(je.kredit),0) k
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED') ${filter}`,
    ...params
  );
  return (row?.d ?? 0) - (row?.k ?? 0);
}

/** Total debit & kredit seluruh buku — invarian Debit = Kredit. */
export async function totalDebitKredit(db: TestDb): Promise<{ debit: number; kredit: number }> {
  const row = await db.getFirstAsync<{ d: number; k: number }>(
    `SELECT COALESCE(SUM(je.debit),0) d, COALESCE(SUM(je.kredit),0) k
     FROM journal_entry je JOIN journal j ON j.id = je.journal_id
     WHERE j.status IN ('POSTED','REVERSED')`
  );
  return { debit: row?.d ?? 0, kredit: row?.k ?? 0 };
}

export interface JejakGl {
  nomorJurnal: string | null;
  tanggal: string;
  sumberTransaksi: string;
  kode: string;
  debit: number;
  kredit: number;
}

/** Jejak GL satu jurnal (§AD) — tanggal, sumber, akun, debit, kredit. */
export async function jejakJurnal(db: TestDb, journalId: string): Promise<JejakGl[]> {
  return db.getAllAsync<JejakGl>(
    `SELECT j.nomor_jurnal as nomorJurnal, j.tanggal as tanggal,
            j.sumber_transaksi as sumberTransaksi, a.kode as kode,
            je.debit as debit, je.kredit as kredit
     FROM journal_entry je
     JOIN journal j ON j.id = je.journal_id
     JOIN account a ON a.id = je.account_id
     WHERE je.journal_id = ?
     ORDER BY je.debit DESC, a.kode`,
    journalId
  );
}

/**
 * Ringkasan seluruh buku yang TIDAK bergantung pada id acak / urutan
 * penyisipan — dipakai membandingkan dua database pada differential
 * test (§G/§AH). Yang dibandingkan adalah AKIBAT AKUNTANSI, bukan
 * bentuk barisnya.
 */
export async function ringkasanAkuntansi(db: TestDb) {
  const perAkun = await db.getAllAsync<{ kode: string; debit: number; kredit: number }>(
    `SELECT a.kode as kode, COALESCE(SUM(je.debit),0) debit, COALESCE(SUM(je.kredit),0) kredit
     FROM journal_entry je
     JOIN journal j ON j.id = je.journal_id
     JOIN account a ON a.id = je.account_id
     WHERE j.status IN ('POSTED','REVERSED')
     GROUP BY a.kode ORDER BY a.kode`
  );
  const perTanggalSumber = await db.getAllAsync<{
    tanggal: string; sumber: string; n: number; debit: number; kredit: number;
  }>(
    `SELECT j.tanggal tanggal, j.sumber_transaksi sumber, COUNT(DISTINCT j.id) n,
            COALESCE(SUM(je.debit),0) debit, COALESCE(SUM(je.kredit),0) kredit
     FROM journal j JOIN journal_entry je ON je.journal_id = j.id
     WHERE j.status IN ('POSTED','REVERSED')
     GROUP BY j.tanggal, j.sumber_transaksi
     ORDER BY j.tanggal, j.sumber_transaksi`
  );
  const penyusutan = await db.getAllAsync<{ periode: string; nilai: number }>(
    `SELECT periode, COALESCE(SUM(nilai_penyusutan),0) nilai
     FROM aset_penyusutan GROUP BY periode ORDER BY periode`
  );
  return { perAkun, perTanggalSumber, penyusutan };
}

export type { TestDb };

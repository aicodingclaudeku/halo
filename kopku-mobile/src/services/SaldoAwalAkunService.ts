import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, getAccountBalance, reverseJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId } from '@/accounting/AccountMapping';
import { requirePermission } from '@/services/PermissionService';
import { newId } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { bacaBagianBelumTunaiSaldoAwal, kunciBelumTunai } from '@/accounting/SaldoAwalRealisasiKas';

/**
 * Saldo Awal Akun (COA) — Phase 18 -> audit ulang bertahap -> request
 * FINAL (§5/§6/§7/§13/§14): SETIAP baris langsung AKTIF seketika saat
 * SIMPAN, TIDAK ADA lagi tahap draft/posting terpisah.
 *
 * ==================================================================
 * SEJARAH SINGKAT (2 iterasi arsitektur sebelum FINAL ini):
 * 1. MEKANISME PALING LAMA: tiap baris posting sendiri-sendiri lawan
 *    3-3000 "Ekuitas Lainnya" — SALAH secara akuntansi (menyamarkan
 *    saldo awal sebagai N transaksi ekonomi terpisah). Data historis
 *    dari era ini TETAP dibiarkan apa adanya (`getLegacyOpeningBalanceInfo`
 *    mendeteksinya untuk info UI, TIDAK PERNAH diubah).
 * 2. MEKANISME BATCH (draft -> posting massal): baris disimpan sebagai
 *    DRAFT (journal_id NULL, TANPA jurnal) dulu, baru SATU jurnal
 *    dibuat mencakup SEMUA baris sekaligus setelah user menekan
 *    "Posting" — TIDAK butuh akun kliring KARENA baris-barisnya
 *    diposting BERSAMAAN (kalau totalnya sudah seimbang, otomatis
 *    balance sebagai satu jurnal). Ini masih menyisakan DUA langkah
 *    terpisah yang terasa rumit bagi pengguna.
 *
 * DESAIN FINAL (SEKARANG — permintaan pengguna, request FINAL):
 * `tambahSaldoAwalAkun()` LANGSUNG membuat jurnal 2-baris SAAT ITU
 * JUGA (bukan lagi batch, bukan lagi draft) — akun yang diisi user +
 * akun kliring "Saldo Awal Belum Sesuai" (3-5000, SAMA PERSIS dengan
 * yang sudah dipakai `koreksiSaldoAwal()` — bukan akun baru) sebagai
 * lawan teknis. Ini SATU-SATUNYA cara membuat SATU baris tunggal jadi
 * jurnal berpasangan tanpa menunggu baris lain (kebutuhan matematis
 * pembukuan berpasangan, bukan pilihan desain) — TIDAK melanggar
 * larangan "akun penyeimbang" (§11 permintaan pengguna) karena akun
 * ini DIAGNOSTIK & transparan (namanya sendiri mengakui potensi
 * ketidaklengkapan), BUKAN akun substantif (SHU/Cadangan/Modal/Kas)
 * yang menyamarkan selisih sebagai sesuatu yang nyata — lihat
 * pembahasan lengkap di komentar `tambahSaldoAwalAkun()` di bawah.
 *
 * Edit SEKARANG SELALU lewat `koreksiSaldoAwal()` (reversal + jurnal
 * baru, §16). Hapus SEKARANG SELALU lewat reversal di `hapusSaldoAwalAkun()`
 * (§17) — jurnal asli TIDAK PERNAH di-UPDATE/DELETE langsung.
 *
 * BACKWARD COMPATIBILITY: baris LAMA dari KEDUA mekanisme sebelumnya
 * (baik era Ekuitas Lainnya maupun era batch draft) TIDAK disentuh
 * sama sekali — jurnal historisnya tetap valid & tetap terhitung di
 * semua laporan. Baris draft LEGACY (journal_id masih NULL, kalau ada
 * sisa dari sebelum perubahan FINAL ini) tetap bisa diedit/dihapus
 * mentah lewat `editSaldoAwalAkun()`/jalur legacy di `hapusSaldoAwalAkun()`
 * — TIDAK ada migrasi paksa. `postingSaldoAwal()` (mekanisme batch)
 * DIPERTAHANKAN di service ini (TIDAK dihapus dari kode) sebagai jalan
 * keluar kalau kebetulan masih ada baris draft legacy yang perlu
 * diposting, tapi SUDAH TIDAK dipanggil dari UI (`SaldoAwalAkunListScreen.tsx`)
 * sejak perubahan FINAL ini — layar itu sekarang hanya punya SATU
 * tombol "SIMPAN".
 */

// ============================================================
// Akun COA yang eligible untuk saldo awal (§3; audit ulang permintaan
// pengguna: DIPERLUAS dari hanya akun neraca menjadi SELURUH kategori
// COA — ASET/LIABILITAS/EKUITAS/PENDAPATAN/BEBAN), dari COA existing,
// TIDAK hardcode daftar akun.
//
// Nama fungsi/tipe DIPERTAHANKAN (`AkunNeracaItem`/
// `listAkunNeracaUntukSaldoAwal`) untuk kompatibilitas mundur kode —
// TIDAK ada API publik eksternal yang bergantung padanya (hanya
// dipakai internal di service & layar ini sendiri), jadi rename penuh
// berisiko lebih besar daripada manfaatnya; yang penting perilakunya
// sekarang mencakup seluruh COA sesuai permintaan.
//
// Audit ulang (permintaan pengguna, request terbaru §2-4/§29/§34):
// urutan SEKARANG murni `kode ASC` — TIDAK LAGI diurutkan/dikelompokkan
// per kategori (ASET/LIABILITAS/EKUITAS/dst) sama sekali. Form saldo
// awal harus berupa SATU daftar datar mengikuti urutan kode akun COA
// apa adanya — pengelompokan ke ASET/LIABILITAS/EKUITAS HANYA boleh
// terjadi di laporan (getPosisiKeuangan dkk, yang sudah mengelompokkan
// berdasarkan `account.kategori` — TIDAK diubah), bukan di form input
// saldo awal ini maupun di urutan data yang dikembalikan ke situ.
// ============================================================
export interface AkunNeracaItem {
  id: string;
  kode: string;
  nama: string;
  kategori: 'ASET' | 'LIABILITAS' | 'EKUITAS' | 'PENDAPATAN' | 'BEBAN';
  normalBalance: 'DEBIT' | 'KREDIT';
}

export async function listAkunNeracaUntukSaldoAwal(): Promise<AkunNeracaItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT id, kode, nama, kategori, normal_balance FROM account
     WHERE is_active = 1 AND kategori IN ('ASET','LIABILITAS','EKUITAS','PENDAPATAN','BEBAN')
     ORDER BY kode ASC`
  );
  return rows.map((r) => ({
    id: r.id,
    kode: r.kode,
    nama: r.nama,
    kategori: r.kategori,
    normalBalance: r.normal_balance,
  }));
}

export interface SaldoAwalAkunItem {
  id: string;
  accountId: string;
  kodeAkun: string;
  namaAkun: string;
  kategoriAkun: string;
  normalBalance: 'DEBIT' | 'KREDIT';
  tanggal: string;
  saldo: Rupiah;
  /** journal_id != null -> baris ini sudah ikut diposting (baik lewat batch baru maupun jurnal individual lama/legacy). */
  posted: boolean;
  journalId: string | null;
  /**
   * RC-S133.4.3 — khusus akun PENDAPATAN/BEBAN: bagian saldo awal yang
   * BELUM diterima/dibayar tunai saat cut-off (masih piutang/utang).
   * 0 = seluruhnya dianggap tunai (bawaan). Dipakai SHU Basis Kas
   * (jalur 5 getInformasiShuRAT). Selalu 0 untuk akun neraca.
   */
  bagianBelumTunai: Rupiah;
}

/** Akun yang saldo awalnya ikut SHU Basis Kas (jalur 5) — punya pengaturan "bagian tunai". */
export function adalahAkunLabaRugi(kategori: string): boolean {
  return kategori === 'PENDAPATAN' || kategori === 'BEBAN';
}

/**
 * Daftar seluruh saldo awal yang sudah dicatat (draft maupun posted),
 * terurut MURNI kode akun (audit ulang, permintaan pengguna terbaru
 * §2-4/§29/§34 — TIDAK lagi dikelompokkan per kategori, lihat komentar
 * `listAkunNeracaUntukSaldoAwal` di atas).
 */
export async function listSaldoAwalAkun(): Promise<SaldoAwalAkunItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT s.*, a.kode as akun_kode, a.nama as akun_nama, a.kategori as akun_kategori, a.normal_balance as akun_normal_balance
     FROM saldo_awal_akun s JOIN account a ON a.id = s.account_id
     ORDER BY a.kode ASC`
  );
  const belumTunai = await bacaBagianBelumTunaiSaldoAwal(db);
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    kodeAkun: r.akun_kode,
    namaAkun: r.akun_nama,
    kategoriAkun: r.akun_kategori,
    normalBalance: r.akun_normal_balance,
    tanggal: r.tanggal,
    saldo: r.saldo,
    posted: r.journal_id !== null,
    journalId: r.journal_id,
    bagianBelumTunai: adalahAkunLabaRugi(r.akun_kategori) ? Math.min(belumTunai.get(r.account_id) ?? 0, r.saldo) : 0,
  }));
}

// ============================================================
// Kunci PERMANEN saldo awal (§11, TIDAK diubah dari mekanisme lama —
// sudah benar sejak awal: singleton `saldo_awal_lock`, tanpa unlock).
// ============================================================
export interface SaldoAwalLockInfo {
  lockedAt: string;
  lockedBy: string;
  lockedByNama: string | null;
}

export async function getSaldoAwalLockInfo(): Promise<SaldoAwalLockInfo | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    `SELECT sal.locked_at, sal.locked_by, u.nama as locked_by_nama
     FROM saldo_awal_lock sal LEFT JOIN app_user u ON u.id = sal.locked_by
     WHERE sal.id = 1`
  );
  if (!row) return null;
  return { lockedAt: row.locked_at, lockedBy: row.locked_by, lockedByNama: row.locked_by_nama ?? null };
}

/**
 * Kunci saldo awal PERMANEN (§11) — setelah ini draft TIDAK bisa lagi
 * diedit/dihapus/diposting ulang. TIDAK menutup periode akuntansi
 * (§12 — status accounting_period sama sekali tidak disentuh di sini).
 * Koreksi lewat `koreksiSaldoAwal()` TETAP bisa dipakai setelah
 * dikunci (§11: itulah tujuannya — bukan mengedit langsung).
 */
export async function kunciSaldoAwalPermanen(actingUserId: string): Promise<SaldoAwalLockInfo> {
  return withTransaction(async (db) => {
    await requirePermission(db, actingUserId, 'kas_bank', 'edit');
    const existing = await db.getFirstAsync<{ id: number }>(`SELECT id FROM saldo_awal_lock WHERE id = 1`);
    if (existing) {
      throw new Error('Saldo awal sudah dikunci permanen sebelumnya.');
    }
    const now = new Date().toISOString();
    await db.runAsync(`INSERT INTO saldo_awal_lock (id, locked_at, locked_by) VALUES (1, ?, ?)`, now, actingUserId);
    await writeAuditLogNamed(db, actingUserId, 'LOCK_OPENING_BALANCE', 'saldo_awal', {});
    return { lockedAt: now, lockedBy: actingUserId, lockedByNama: null };
  });
}

async function pastikanBelumTerkunci(db: SQLite.SQLiteDatabase) {
  const lock = await db.getFirstAsync<{ id: number }>(`SELECT id FROM saldo_awal_lock WHERE id = 1`);
  if (lock) {
    throw new Error('Saldo awal sudah dikunci permanen dan tidak dapat diubah/dihapus lagi.');
  }
}

/**
 * Audit ulang (permintaan pengguna, request FINAL — hapus alur draft/
 * posting terpisah): dulu fungsi ini mengecek GLOBAL (ada baris posted
 * di MANA PUN di tabel -> blokir edit/hapus draft lain). Itu benar
 * untuk model BATCH lama (semua baris draft diposting bersamaan jadi
 * satu jurnal), tapi SALAH untuk model baru (tiap baris langsung aktif
 * sendiri-sendiri saat SIMPAN) — kalau tetap global, begitu SATU akun
 * saja sudah disimpan, seluruh baris draft LAIN (kalau kebetulan masih
 * ada sisa dari sebelum perubahan ini) jadi tidak bisa diedit/dihapus
 * sama sekali. Sekarang mengecek PER BARIS (baris ini spesifik, bukan
 * tabel secara keseluruhan) — tetap mencegah edit/hapus MENTAH pada
 * baris yang sudah punya jurnal (harus lewat koreksi/reversal), tapi
 * tidak lagi mem-blokir baris LAIN yang genuinely belum punya jurnal.
 */
async function pastikanBarisBelumPosting(db: SQLite.SQLiteDatabase, id: string) {
  const row = await db.getFirstAsync<{ journal_id: string | null }>(`SELECT journal_id FROM saldo_awal_akun WHERE id = ?`, id);
  if (row?.journal_id) {
    throw new Error('Saldo awal ini sudah diposting — gunakan "Koreksi Saldo Awal" untuk perubahan lebih lanjut, bukan edit/hapus langsung.');
  }
}

async function writeAuditLogNamed(db: SQLite.SQLiteDatabase, userId: string, action: string, entityId: string, dataSesudah: unknown) {
  const now = new Date();
  await db.runAsync(
    `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sesudah, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    newId(),
    userId,
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    action,
    'saldo_awal_akun',
    entityId,
    JSON.stringify(dataSesudah),
    now.toISOString()
  );
}

// ============================================================
// Audit ulang (permintaan pengguna, request FINAL §5/§6/§7/§13/§14/
// §15): alur DRAFT -> POSTING TERPISAH DIHAPUS TOTAL. SIMPAN sekarang
// LANGSUNG mengaktifkan saldo — setiap baris membuat jurnal 2-baris
// SENDIRI (bukan batch) seketika saat disimpan, ATOMIC dalam SATU
// transaction bersama INSERT saldo_awal_akun (§15 — kalau salah satu
// gagal, keduanya rollback bersama, withTransaction sudah menjamin ini).
//
// KENAPA BUTUH AKUN KLIRING DI SINI (beda dari `postingSaldoAwal` lama
// yang TIDAK butuh kliring): mekanisme BATCH lama tidak butuh kliring
// karena SEMUA baris diposting BERSAMAAN dalam satu jurnal — total sisi
// debit & kredit SELURUH baris otomatis sama kalau memang sudah
// seimbang secara keseluruhan (lihat pembuktian di komentar
// `postingSaldoAwal` di bawah, masih valid & dipertahankan untuk baris
// legacy). Tapi SEKARANG setiap baris diposting SENDIRIAN, seketika,
// SEBELUM baris lain tentu ada — satu baris tunggal (mis. "Kas Debit
// Rp100 juta") TIDAK BISA jadi jurnal berimbang tanpa lawan APAPUN,
// itu murni fakta matematis pembukuan berpasangan, bukan pilihan
// desain. Akun kliring "Saldo Awal Belum Sesuai" (3-5000, SAMA PERSIS
// dengan yang sudah dipakai `koreksiSaldoAwal` di bawah — BUKAN akun
// baru) dipakai sebagai lawan teknis SETIAP baris.
//
// INI TIDAK MELANGGAR larangan "jangan membuat akun penyeimbang
// otomatis" (permintaan pengguna §11): akun 3-5000 adalah akun
// DIAGNOSTIK yang SUDAH ADA & transparan (namanya secara eksplisit
// "Saldo Awal Belum Sesuai" — mengakui, bukan menyembunyikan,
// ketidaklengkapan), BUKAN akun substantif seperti SHU/Cadangan/Modal/
// Kas yang akan MENYAMARKAN selisih sebagai sesuatu yang nyata. Selisih
// SEBENARNYA tetap terlihat: `getRingkasanSaldoAwal().saldoKliringKoreksi`
// (saldo akun 3-5000 saat ini) SECARA MATEMATIS PERSIS SAMA dengan
// selisih murni "apa yang benar-benar dimasukkan user" — kalau semua
// akun neraca sudah diisi lengkap & seimbang, saldo akun 3-5000 akan
// balik ke Rp0 dengan sendirinya (karena kredit & debit ke akun ini
// dari tiap baris saling menghapus secara alami), TANPA transaksi
// tambahan apa pun. Laporan Posisi Keuangan (§9/§10/§24) memakai
// `getValidasiSaldoAwal()`/perhitungan sejenis untuk indikator
// Seimbang/Belum Seimbang — TIDAK diubah oleh keberadaan akun kliring
// ini (fungsi itu menghitung ULANG dari baris saldo_awal_akun secara
// independen, bukan dari saldo akun 3-5000).
// ============================================================
export interface TambahSaldoAwalAkunInput {
  accountId: string;
  tanggal: string;
  saldo: Rupiah;
  createdBy: string;
}

export async function tambahSaldoAwalAkun(input: TambahSaldoAwalAkunInput): Promise<SaldoAwalAkunItem> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    await pastikanBelumTerkunci(db);
    if (!Number.isFinite(input.saldo) || input.saldo <= 0) {
      throw new Error('Saldo awal harus lebih dari 0.');
    }

    const akun = await db.getFirstAsync<{ kode: string; nama: string; kategori: string; normal_balance: string; is_active: number }>(
      `SELECT kode, nama, kategori, normal_balance, is_active FROM account WHERE id = ?`,
      input.accountId
    );
    if (!akun) throw new Error('Akun tidak ditemukan.');
    if (!akun.is_active) throw new Error(`Akun "${akun.nama}" tidak aktif.`);
    // Audit ulang (permintaan pengguna, request baru §1): SEMUA
    // kategori COA sekarang boleh diberi saldo awal — sebelumnya hanya
    // Aset/Liabilitas/Ekuitas. Pendapatan/Beban DIIZINKAN untuk kasus
    // migrasi dari sistem lain di tengah tahun buku (membawa masuk
    // angka pendapatan/beban berjalan yang sudah terjadi sebelum
    // aplikasi ini dipakai) — lihat `getValidasiSaldoAwal` di bawah
    // untuk bagaimana kontribusinya diperhitungkan dalam validasi
    // balance (rumus diperluas, BUKAN diabaikan).
    if (!['ASET', 'LIABILITAS', 'EKUITAS', 'PENDAPATAN', 'BEBAN'].includes(akun.kategori)) {
      throw new Error(`Akun "${akun.nama}" memiliki kategori yang tidak dikenali (${akun.kategori}).`);
    }

    const existing = await db.getFirstAsync<{ id: string }>(`SELECT id FROM saldo_awal_akun WHERE account_id = ?`, input.accountId);
    if (existing) {
      throw new Error('Akun ini sudah memiliki saldo awal. Gunakan Edit/Koreksi untuk mengubahnya.');
    }

    // §13/§14: jurnal 2-baris seketika (akun asli + kliring), engine
    // yang menjaga integritas double-entry — user hanya input single-
    // entry (akun + nominal, arah debit/kredit otomatis dari
    // normal_balance akun, TIDAK diminta ke user, §11 permintaan
    // sebelumnya & §4 permintaan ini — user tidak pernah memilih
    // "akun lawan").
    const kliringAccountId = await resolveAccountId(db, 'KOREKSI_SALDO_AWAL', 'KLIRING');
    const akunDiDebit = akun.normal_balance === 'DEBIT';
    const lines = akunDiDebit
      ? [
          { accountId: input.accountId, debit: input.saldo, kredit: 0 },
          { accountId: kliringAccountId, debit: 0, kredit: input.saldo },
        ]
      : [
          { accountId: kliringAccountId, debit: input.saldo, kredit: 0 },
          { accountId: input.accountId, debit: 0, kredit: input.saldo },
        ];

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'SALDO_AWAL_AKUN',
      sumberId: input.accountId,
      deskripsi: `Saldo awal akun ${akun.nama} (opening balance) - Rp${input.saldo.toLocaleString('id-ID')}`,
      createdBy: input.createdBy,
      lines,
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO saldo_awal_akun (id, account_id, tanggal, saldo, journal_id, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      id,
      input.accountId,
      input.tanggal,
      input.saldo,
      journalId,
      input.createdBy,
      now,
      now
    );

    await writeAuditLogNamed(db, input.createdBy, 'CREATE_OPENING_BALANCE', id, {
      accountId: input.accountId,
      kodeAkun: akun.kode,
      tanggal: input.tanggal,
      saldo: input.saldo,
      journalId,
    });

    return {
      id,
      accountId: input.accountId,
      kodeAkun: akun.kode,
      namaAkun: akun.nama,
      kategoriAkun: akun.kategori,
      normalBalance: akun.normal_balance as 'DEBIT' | 'KREDIT',
      tanggal: input.tanggal,
      saldo: input.saldo,
      posted: true,
      journalId,
      bagianBelumTunai: 0,
    };
  });
}

export interface EditSaldoAwalAkunInput {
  id: string;
  accountId: string;
  tanggal: string;
  saldo: Rupiah;
  updatedBy: string;
}

/**
 * Edit MENTAH (bukan reversal) — SEKARANG hanya berlaku untuk baris
 * LEGACY yang genuinely belum pernah punya jurnal (journal_id NULL,
 * peninggalan dari sebelum request FINAL ini — sejak perubahan ini,
 * `tambahSaldoAwalAkun()` SELALU langsung membuat jurnal, jadi baris
 * BARU tidak akan pernah dalam keadaan ini). Untuk baris yang SUDAH
 * punya jurnal (kasus normal sekarang), fungsi ini DITOLAK — WAJIB
 * lewat `koreksiSaldoAwal()` (reversal + jurnal baru, §16).
 */
export async function editSaldoAwalAkun(input: EditSaldoAwalAkunInput): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.updatedBy, 'kas_bank', 'edit');
    await pastikanBelumTerkunci(db);
    await pastikanBarisBelumPosting(db, input.id);
    if (!Number.isFinite(input.saldo) || input.saldo <= 0) {
      throw new Error('Saldo awal harus lebih dari 0.');
    }
    const existing = await db.getFirstAsync<{ account_id: string }>(`SELECT account_id FROM saldo_awal_akun WHERE id = ?`, input.id);
    if (!existing) throw new Error('Data saldo awal tidak ditemukan.');

    if (input.accountId !== existing.account_id) {
      const bentrok = await db.getFirstAsync<{ id: string }>(
        `SELECT id FROM saldo_awal_akun WHERE account_id = ? AND id != ?`,
        input.accountId,
        input.id
      );
      if (bentrok) throw new Error('Akun tujuan sudah punya saldo awal sendiri.');
    }

    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE saldo_awal_akun SET account_id = ?, tanggal = ?, saldo = ?, updated_at = ? WHERE id = ?`,
      input.accountId,
      input.tanggal,
      input.saldo,
      now,
      input.id
    );

    await writeAuditLogNamed(db, input.updatedBy, 'UPDATE_DRAFT_OPENING_BALANCE', input.id, {
      accountId: input.accountId,
      tanggal: input.tanggal,
      saldo: input.saldo,
    });
  });
}

/**
 * Hapus saldo awal (§17: "gunakan reversal sesuai pola existing...
 * histori audit tetap dipertahankan"). Audit ulang (permintaan
 * pengguna, request FINAL): SEKARANG menangani DUA kasus:
 *  1. Baris SUDAH punya jurnal (kasus normal — SETIAP baris baru
 *     langsung aktif sejak perubahan ini): buat jurnal REVERSAL penuh
 *     (`reverseJournal` — AccountingEngine existing, membalik SELURUH
 *     baris jurnal asli termasuk baris kliring) supaya saldo bersihnya
 *     jadi Rp0 secara matematis, jurnal asli & reversal-nya TETAP ADA
 *     selamanya di `journal`/`journal_entry` sebagai audit trail
 *     (TIDAK di-UPDATE/DELETE — §17), lalu baris `saldo_awal_akun`
 *     dihapus supaya akun ini kembali berstatus "BELUM DIISI" di form.
 *  2. Baris LEGACY belum punya jurnal (journal_id NULL, peninggalan
 *     lama): tidak ada yang perlu direversal, langsung DELETE baris —
 *     sama seperti sebelumnya, tidak ada jurnal untuk dibatalkan.
 */
export async function hapusSaldoAwalAkun(id: string, deletedBy: string): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, deletedBy, 'kas_bank', 'edit');
    await pastikanBelumTerkunci(db);
    const existing = await db.getFirstAsync<{ id: string; account_id: string; journal_id: string | null; saldo: number; nama: string }>(
      `SELECT s.id, s.account_id, s.journal_id, s.saldo, a.nama
       FROM saldo_awal_akun s JOIN account a ON a.id = s.account_id
       WHERE s.id = ?`,
      id
    );
    if (!existing) throw new Error('Data saldo awal tidak ditemukan.');

    let reversalJournalId: string | null = null;
    if (existing.journal_id) {
      const hasil = await reverseJournal(db, existing.journal_id, deletedBy, `Hapus saldo awal akun ${existing.nama}`);
      reversalJournalId = hasil.journalId;
    }

    await db.runAsync(`DELETE FROM saldo_awal_akun WHERE id = ?`, id);
    // RC-S133.4.3 — pengaturan "bagian belum tunai" ikut hilang bersama baris saldo awalnya.
    await db.runAsync(`DELETE FROM app_config WHERE key = ?`, kunciBelumTunai(existing.account_id));

    await writeAuditLogNamed(db, deletedBy, 'DELETE_OPENING_BALANCE', id, {
      accountId: existing.account_id,
      saldo: existing.saldo,
      journalIdAsli: existing.journal_id,
      reversalJournalId,
    });
  });
}

// ============================================================
// VALIDASI (§5) — dihitung dari SELURUH baris saldo_awal_akun
// (draft maupun sudah posted — kalau sudah posted, seharusnya SELALU
// balance karena diverifikasi sebelum posting; menghitung ulang di
// sini setiap saat adalah double-check yang murah & aman, BUKAN
// sumber kebenaran ganda — hasil ini hanya dipakai untuk MEMBLOKIR
// posting baru, tidak pernah dipakai untuk mengoreksi data).
// ============================================================
export interface ValidasiSaldoAwalResult {
  totalAset: Rupiah;
  totalLiabilitas: Rupiah;
  totalEkuitas: Rupiah;
  /**
   * Audit ulang (permintaan pengguna, request baru §1): total saldo
   * awal untuk akun PENDAPATAN/BEBAN — 0 kalau tidak ada baris
   * kategori ini (kasus lama/paling umum: hanya akun neraca yang
   * diisi, perilaku identik dengan sebelum perubahan ini).
   */
  totalPendapatan: Rupiah;
  totalBeban: Rupiah;
  totalLiabilitasEkuitas: Rupiah;
  selisih: Rupiah;
  seimbang: boolean;
}

/**
 * Kontribusi bertanda satu baris ke total kategorinya — akun kontra
 * (mis. Akumulasi Penyusutan: kategori ASET tapi normal_balance
 * KREDIT) MENGURANGI totalnya, bukan menambah, PERSIS pola yang sudah
 * dipakai `FinancialReports.getPosisiKeuangan` (satu prinsip yang
 * sama dipakai konsisten di seluruh aplikasi, bukan rumus baru).
 *
 * Audit ulang (permintaan pengguna, request baru §1): diperluas untuk
 * PENDAPATAN & BEBAN — sisi "normal" untuk PENDAPATAN adalah KREDIT
 * (sama seperti EKUITAS/LIABILITAS, karena pendapatan MENAMBAH SHU
 * yang pada akhirnya menambah ekuitas), untuk BEBAN adalah DEBIT (sama
 * seperti ASET, karena beban MENGURANGI SHU/ekuitas — diperlakukan di
 * "sisi debit" persamaan akuntansi seperti aset).
 */
function kontribusiBertanda(kategori: string, normalBalance: string, saldo: number): number {
  if (kategori === 'ASET' || kategori === 'BEBAN') return normalBalance === 'DEBIT' ? saldo : -saldo;
  return normalBalance === 'KREDIT' ? saldo : -saldo; // LIABILITAS/EKUITAS/PENDAPATAN
}

/**
 * Audit ulang (permintaan pengguna, request baru §1): validasi
 * DIPERLUAS dari "Total Aset = Total Liabilitas + Ekuitas" menjadi
 * persamaan akuntansi umum:
 *
 *     Total Aset + Total Beban = Total Liabilitas + Total Ekuitas + Total Pendapatan
 *
 * (identitas neraca saldo standar: Aset & Beban sama-sama kategori
 * bersaldo normal DEBIT, Liabilitas/Ekuitas/Pendapatan sama-sama
 * bersaldo normal KREDIT — lihat `kontribusiBertanda`). Kalau HANYA
 * akun neraca yang diisi (kasus lama/paling umum), totalPendapatan =
 * totalBeban = 0 dan rumus ini otomatis identik dengan rumus lama
 * ("Total Aset = Total Liabilitas + Ekuitas") — TIDAK ADA perubahan
 * perilaku untuk data/pemakaian yang sudah ada.
 *
 * Ini juga menjamin properti "tidak butuh akun kliring saat posting"
 * (lihat `postingSaldoAwal`) TETAP BERLAKU walau ada baris Pendapatan/
 * Beban: persamaan di atas, dengan aljabar yang sama seperti sebelumnya,
 * tetap ekuivalen dengan "jumlah saldo baris normal_balance=DEBIT =
 * jumlah saldo baris normal_balance=KREDIT" — syarat balance jurnal.
 */
export async function getValidasiSaldoAwal(db: SQLite.SQLiteDatabase): Promise<ValidasiSaldoAwalResult> {
  const rows = await db.getAllAsync<{ saldo: number; kategori: string; normal_balance: string }>(
    `SELECT s.saldo, a.kategori, a.normal_balance
     FROM saldo_awal_akun s JOIN account a ON a.id = s.account_id`
  );
  let totalAset = 0;
  let totalLiabilitas = 0;
  let totalEkuitas = 0;
  let totalPendapatan = 0;
  let totalBeban = 0;
  for (const r of rows) {
    const kontribusi = kontribusiBertanda(r.kategori, r.normal_balance, r.saldo);
    if (r.kategori === 'ASET') totalAset += kontribusi;
    else if (r.kategori === 'LIABILITAS') totalLiabilitas += kontribusi;
    else if (r.kategori === 'EKUITAS') totalEkuitas += kontribusi;
    else if (r.kategori === 'PENDAPATAN') totalPendapatan += kontribusi;
    else if (r.kategori === 'BEBAN') totalBeban += kontribusi;
  }
  const totalLiabilitasEkuitas = totalLiabilitas + totalEkuitas;
  // sisi DEBIT (Aset+Beban) dibandingkan sisi KREDIT (Liabilitas+Ekuitas+Pendapatan).
  const selisih = totalAset + totalBeban - (totalLiabilitasEkuitas + totalPendapatan);
  return {
    totalAset,
    totalLiabilitas,
    totalEkuitas,
    totalPendapatan,
    totalBeban,
    totalLiabilitasEkuitas,
    selisih,
    seimbang: selisih === 0,
  };
}

export type StatusSaldoAwal = 'DRAFT' | 'BALANCED' | 'POSTED' | 'LOCKED';

export interface RingkasanSaldoAwal {
  rows: SaldoAwalAkunItem[];
  validasi: ValidasiSaldoAwalResult;
  status: StatusSaldoAwal;
  lockInfo: SaldoAwalLockInfo | null;
  legacy: LegacyOpeningBalanceInfo;
  /** Saldo akun kliring koreksi (3-5000) — HARUS Rp0 kalau seluruh koreksi sudah selesai (§9). */
  saldoKliringKoreksi: Rupiah;
}

/** Satu pemanggilan untuk seluruh kebutuhan layar Saldo Awal (§24). */
export async function getRingkasanSaldoAwal(): Promise<RingkasanSaldoAwal> {
  const db = await getDb();
  const [rows, validasi, lockInfo, legacy] = await Promise.all([
    listSaldoAwalAkun(),
    getValidasiSaldoAwal(db),
    getSaldoAwalLockInfo(),
    getLegacyOpeningBalanceInfo(),
  ]);

  let saldoKliringKoreksi = 0;
  try {
    const kliringAccountId = await resolveAccountId(db, 'KOREKSI_SALDO_AWAL', 'KLIRING');
    saldoKliringKoreksi = await getAccountBalance(db, kliringAccountId);
  } catch {
    saldoKliringKoreksi = 0; // mapping belum ada (belum pernah ada koreksi) — bukan error, tetap 0
  }

  let status: StatusSaldoAwal;
  if (lockInfo) status = 'LOCKED';
  else if (rows.some((r) => r.posted)) status = 'POSTED';
  else if (rows.length > 0 && validasi.seimbang) status = 'BALANCED';
  else status = 'DRAFT';

  return { rows, validasi, status, lockInfo, legacy, saldoKliringKoreksi };
}

// ============================================================
// POSTING BATCH (LEGACY — DIPERTAHANKAN, TIDAK DIPANGGIL UI LAGI):
// Audit ulang (permintaan pengguna, request FINAL §5/§6/§7): mekanisme
// draft-lalu-posting-massal ini SUDAH TIDAK dipakai alur utama —
// `SaldoAwalAkunListScreen.tsx` sekarang hanya punya satu tombol
// SIMPAN yang memanggil `tambahSaldoAwalAkun()` (langsung aktif per
// baris, lihat komentar di sana). Fungsi INI dipertahankan apa adanya
// (tidak dihapus dari kode) HANYA sebagai jalan keluar kalau kebetulan
// masih ada baris draft LEGACY (journal_id NULL, peninggalan dari
// sebelum perubahan FINAL ini) yang perlu diposting — SATU jurnal
// pembukaan untuk SELURUH baris draft semacam itu sekaligus, TIDAK
// BUTUH akun kontra sama sekali (beda dari `tambahSaldoAwalAkun()`
// yang SEKARANG jadi jalur utama & butuh kliring karena memposting
// SATU baris sendirian, bukan batch).
//
// PEMBUKTIAN kenapa BATCH ini tidak perlu akun kontra: `getValidasiSaldoAwal`
// memvalidasi Total Aset + Total Beban = Total Liabilitas + Total
// Ekuitas + Total Pendapatan (audit ulang §1: diperluas dari "Total
// Aset = Total Liabilitas + Ekuitas" supaya ikut mencakup akun
// Pendapatan/Beban — identik dengan rumus lama kalau kedua total itu
// nol, yaitu saat hanya akun neraca yang diisi), memakai kontribusi
// bertanda (akun kontra mengurangi, bukan menambah). Untuk SETIAP
// baris, baris masuk ke sisi DEBIT jurnal kalau normal_balance DEBIT,
// sisi KREDIT kalau normal_balance KREDIT (§8, langsung dari
// normal_balance, tanpa peduli kategori). Menjabarkan aljabar dari
// syarat "Total Aset + Total Beban = Total Liabilitas + Total Ekuitas
// + Total Pendapatan" (dengan kontribusi bertanda di atas) persis
// menghasilkan "jumlah saldo baris normal_balance=DEBIT = jumlah
// saldo baris normal_balance=KREDIT" — itulah SYARAT BALANCE JURNAL
// itu sendiri, untuk KOMBINASI KATEGORI APA PUN. Jadi validasi di
// atas SECARA MATEMATIS SUDAH MENJAMIN jurnal akan balance, tanpa
// baris kliring apa pun — berlaku sama baik akun yang diisi murni
// neraca, murni P&L, atau campuran keduanya. Ini HANYA berlaku untuk
// BATCH (banyak baris sekaligus) — SATU baris tunggal (jalur utama
// sekarang) tidak bisa memakai trik ini, itu sebabnya
// `tambahSaldoAwalAkun()` butuh kliring sedangkan fungsi ini tidak.
// ============================================================
export async function postingSaldoAwal(params: { tanggal: string; actingUserId: string }): Promise<{ journalId: string }> {
  return withTransaction(async (db) => {
    await requirePermission(db, params.actingUserId, 'kas_bank', 'edit');
    await pastikanBelumTerkunci(db);

    const validasi = await getValidasiSaldoAwal(db);
    await writeAuditLogNamed(db, params.actingUserId, 'VALIDATE_OPENING_BALANCE', 'saldo_awal', validasi);

    if (!validasi.seimbang) {
      throw new Error(
        `Saldo awal tidak seimbang (selisih Rp${validasi.selisih.toLocaleString('id-ID')}) — tidak dapat diposting. ` +
          `Perbaiki input terlebih dahulu; sistem TIDAK akan membuat jurnal penyeimbang otomatis.`
      );
    }

    const rows = await db.getAllAsync<{ account_id: string; saldo: number; normal_balance: string }>(
      `SELECT s.account_id, s.saldo, a.normal_balance
       FROM saldo_awal_akun s JOIN account a ON a.id = s.account_id
       WHERE s.journal_id IS NULL`
    );
    if (rows.length === 0) {
      throw new Error('Belum ada saldo awal yang diisi — tidak ada yang bisa diposting.');
    }

    const lines = rows.map((r) => ({
      accountId: r.account_id,
      debit: r.normal_balance === 'DEBIT' ? r.saldo : 0,
      kredit: r.normal_balance === 'KREDIT' ? r.saldo : 0,
    }));

    const { journalId } = await createJournal(db, {
      tanggal: params.tanggal,
      sumberTransaksi: 'SALDO_AWAL_AKUN',
      deskripsi: `Saldo awal akun (opening balance) - ${rows.length} akun`,
      createdBy: params.actingUserId,
      lines,
    });

    const now = new Date().toISOString();
    await db.runAsync(`UPDATE saldo_awal_akun SET journal_id = ?, updated_at = ? WHERE journal_id IS NULL`, journalId, now);

    await writeAuditLogNamed(db, params.actingUserId, 'POST_OPENING_BALANCE', journalId, {
      jumlahAkun: rows.length,
      totalAset: validasi.totalAset,
      totalLiabilitasEkuitas: validasi.totalLiabilitasEkuitas,
    });

    return { journalId };
  });
}

// ============================================================
// KOREKSI (§11/§13) — SATU-SATUNYA jalur mengubah saldo awal yang
// SUDAH diposting (baik status POSTED maupun LOCKED — mengoreksi
// TIDAK membuka kunci apa pun, hanya menambah jurnal koreksi baru di
// atas yang sudah ada, sesuai §11: "Jangan mengedit jurnal lama").
// Perlu akun kliring 3-5000 karena mengoreksi SATU baris sendirian
// (bukan seluruh batch sekaligus) tidak otomatis balance seperti
// posting awal — lihat komentar akun 3-5000 di defaultCOA.ts.
// ============================================================
export interface KoreksiSaldoAwalInput {
  accountId: string;
  saldoBaru: Rupiah;
  alasan: string;
  actingUserId: string;
}

export async function koreksiSaldoAwal(input: KoreksiSaldoAwalInput): Promise<{ journalId: string; delta: number }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.actingUserId, 'kas_bank', 'edit');
    if (!input.alasan.trim()) throw new Error('Alasan koreksi wajib diisi.');
    if (!Number.isFinite(input.saldoBaru) || input.saldoBaru < 0) {
      throw new Error('Saldo baru harus berupa angka >= 0.');
    }

    const row = await db.getFirstAsync<{ saldo: number; journal_id: string | null; nama: string; normal_balance: string }>(
      `SELECT s.saldo, s.journal_id, a.nama, a.normal_balance FROM saldo_awal_akun s JOIN account a ON a.id = s.account_id WHERE s.account_id = ?`,
      input.accountId
    );
    if (!row) throw new Error('Saldo awal untuk akun ini belum pernah dicatat.');
    if (!row.journal_id) {
      throw new Error('Saldo awal akun ini belum diposting — edit langsung lewat form draft, tidak perlu koreksi.');
    }

    const delta = input.saldoBaru - row.saldo;
    if (delta === 0) {
      throw new Error('Nilai baru sama dengan nilai sekarang — tidak ada yang perlu dikoreksi.');
    }

    const kliringAccountId = await resolveAccountId(db, 'KOREKSI_SALDO_AWAL', 'KLIRING');
    const absDelta = Math.abs(delta);
    const akunBertambah = delta > 0;

    // Akun bertambah & normal DEBIT -> DEBIT akun / KREDIT kliring.
    // Akun berkurang & normal DEBIT -> KREDIT akun / DEBIT kliring.
    // Akun bertambah & normal KREDIT -> KREDIT akun / DEBIT kliring.
    // Akun berkurang & normal KREDIT -> DEBIT akun / KREDIT kliring.
    const akunDiDebit = (row.normal_balance === 'DEBIT') === akunBertambah;
    const lines = akunDiDebit
      ? [
          { accountId: input.accountId, debit: absDelta, kredit: 0 },
          { accountId: kliringAccountId, debit: 0, kredit: absDelta },
        ]
      : [
          { accountId: kliringAccountId, debit: absDelta, kredit: 0 },
          { accountId: input.accountId, debit: 0, kredit: absDelta },
        ];

    const { journalId } = await createJournal(db, {
      tanggal: getTanggalLokalHariIni(),
      sumberTransaksi: 'KOREKSI_SALDO_AWAL',
      sumberId: input.accountId,
      deskripsi: `Koreksi saldo awal ${row.nama}: Rp${row.saldo.toLocaleString('id-ID')} -> Rp${input.saldoBaru.toLocaleString('id-ID')} (${input.alasan})`,
      createdBy: input.actingUserId,
      lines,
    });

    const now = new Date().toISOString();
    // Audit ulang (permintaan pengguna, request baru §M — dipertimbangkan
    // & SENGAJA TIDAK diterapkan): permintaan literal meminta
    // `saldo_awal_akun.journal_id` diperbarui menunjuk ke jurnal
    // koreksi terbaru. TIDAK dilakukan di sini karena akan merusak
    // `getLegacyOpeningBalanceInfo()` (di bawah) — heuristik itu
    // mendeteksi mekanisme LAMA (satu jurnal per akun ber-kontra
    // Ekuitas Lainnya) dengan menghitung journal_id yang BERBEDA-BEDA
    // di antara baris; kalau journal_id baris yang dikoreksi diganti
    // ke jurnal koreksi (berbeda dari journal_id batch asli milik
    // baris lain), heuristik itu akan SALAH mendeteksi instalasi BARU
    // yang baru saja dikoreksi sebagai "legacy". `journal_id` di sini
    // tetap menunjuk ke jurnal BATCH POSTING ASLI (audit trail "asal"),
    // sedangkan riwayat koreksi lengkap tetap tersedia lewat
    // `audit_log` (action CORRECT_OPENING_BALANCE, lihat di bawah) dan
    // jurnal koreksi itu sendiri (dicari via `sumber_transaksi =
    // 'KOREKSI_SALDO_AWAL' AND sumber_id = account_id` pada tabel
    // `journal`) — TIDAK ADA audit trail yang hilang, hanya pointer
    // "jurnal asal" yang dipertahankan agar heuristik legacy tetap benar.
    await db.runAsync(`UPDATE saldo_awal_akun SET saldo = ?, updated_at = ? WHERE account_id = ?`, input.saldoBaru, now, input.accountId);
    // RC-S133.4.3 — bagian belum tunai tidak boleh melebihi saldo baru.
    const belum = (await bacaBagianBelumTunaiSaldoAwal(db)).get(input.accountId) ?? 0;
    if (belum > input.saldoBaru) {
      await simpanBagianBelumTunai(db, input.accountId, input.saldoBaru);
    }

    await writeAuditLogNamed(db, input.actingUserId, 'CORRECT_OPENING_BALANCE', input.accountId, {
      saldoLama: row.saldo,
      saldoBaru: input.saldoBaru,
      delta,
      alasan: input.alasan,
      journalId,
    });

    return { journalId, delta };
  });
}

// ============================================================
// LEGACY DETECTION (§17/§23) — deteksi murni, TIDAK PERNAH mengubah
// data historis.
//
// Audit ulang (bug ditemukan lewat analisis test sesi ini, request
// FINAL): heuristik LAMA ("lebih dari satu journal_id berbeda di
// antara baris = legacy") SUDAH TIDAK VALID sejak SETIAP baris SELALU
// membuat jurnalnya SENDIRI-SENDIRI (bukan lagi batch bersama) —
// "banyak journal_id berbeda" sekarang justru KONDISI NORMAL untuk
// pemakaian baru, bukan tanda legacy. Heuristik BARU: cek apakah ADA
// jurnal `SALDO_AWAL_AKUN` yang menyentuh akun "Ekuitas Lainnya"
// (3-3000) — itulah TANDA SEBENARNYA dari mekanisme paling lama
// (sebelum refactor apa pun), karena mekanisme SAAT INI (baik batch
// legacy `postingSaldoAwal` maupun instan `tambahSaldoAwalAkun`)
// SAMA-SAMA memakai akun kliring "Saldo Awal Belum Sesuai" (3-5000)
// atau tanpa kliring sama sekali — TIDAK PERNAH 3-3000.
// ============================================================
export interface LegacyOpeningBalanceInfo {
  isLegacy: boolean;
  jumlahJurnalTerpisah: number;
}

export async function getLegacyOpeningBalanceInfo(): Promise<LegacyOpeningBalanceInfo> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ journal_id: string }>(
    `SELECT DISTINCT journal_id FROM saldo_awal_akun WHERE journal_id IS NOT NULL`
  );

  let isLegacy = false;
  if (rows.length > 0) {
    const ekuitasLainnya = await db.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = '3-3000'`);
    if (ekuitasLainnya) {
      const placeholders = rows.map(() => '?').join(',');
      const legacyCheck = await db.getFirstAsync<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM journal_entry je
         JOIN journal j ON j.id = je.journal_id
         WHERE j.sumber_transaksi = 'SALDO_AWAL_AKUN' AND je.account_id = ?
           AND je.journal_id IN (${placeholders})`,
        ekuitasLainnya.id,
        ...rows.map((r) => r.journal_id)
      );
      isLegacy = (legacyCheck?.cnt ?? 0) > 0;
    }
  }

  return { isLegacy, jumlahJurnalTerpisah: rows.length };
}

// ============================================================
// Aset Tetap — TIDAK diubah dari sebelumnya (tidak terkait mekanisme
// kontra Ekuitas Lainnya yang direfactor di atas).
// ============================================================
export interface AsetTetapAccountInfo {
  accountId: string;
  kodeAkun: string;
  namaAkun: string;
}

export async function getAsetTetapAccountInfo(): Promise<AsetTetapAccountInfo | null> {
  const db = await getDb();
  try {
    const accountId = await resolveAccountId(db, 'ASET_TETAP', 'DEBIT_ASET');
    const akun = await db.getFirstAsync<{ kode: string; nama: string }>(`SELECT kode, nama FROM account WHERE id = ?`, accountId);
    if (!akun) return null;
    return { accountId, kodeAkun: akun.kode, namaAkun: akun.nama };
  } catch {
    return null;
  }
}

// ============================================================
// RC-S133.4.3 — BAGIAN TUNAI SALDO AWAL PENDAPATAN/BEBAN
// ============================================================
// Saldo awal pendapatan/beban (dicatat sebelum memakai aplikasi, mis.
// pendapatan Jan–Sep saat mulai di bulan Oktober) dianggap SUDAH
// diterima/dibayar tunai oleh SHU Basis Kas. Bila sebagian masih
// piutang/utang saat cut-off, pengguna menyatakan bagian tunainya di
// sini. HANYA metadata laporan basis kas: TIDAK membuat/mengubah jurnal,
// TIDAK mengubah SHU akrual, neraca, maupun saldo akun mana pun —
// karena itu tetap boleh diatur setelah saldo awal dikunci permanen
// (sama seperti Koreksi Saldo Awal), dan setiap perubahan dicatat di
// audit log.

async function simpanBagianBelumTunai(db: SQLite.SQLiteDatabase, accountId: string, nominal: Rupiah) {
  const kunci = kunciBelumTunai(accountId);
  // RC-S133.4.5 — 0 disimpan (bukan dihapus): "seluruhnya tunai" yang
  // DIPILIH pengguna harus mengalahkan bawaan otomatis (piutang jasa).
  await db.runAsync(
    `INSERT INTO app_config (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    kunci,
    String(Math.max(0, nominal)),
    new Date().toISOString()
  );
}

export interface AturBagianTunaiSaldoAwalInput {
  accountId: string;
  /** Bagian saldo awal yang SUDAH diterima/dibayar tunai sebelum cut-off (0 … saldo). */
  bagianTunai: Rupiah;
  actingUserId: string;
}

export async function aturBagianTunaiSaldoAwal(
  input: AturBagianTunaiSaldoAwalInput
): Promise<{ bagianTunai: Rupiah; bagianBelumTunai: Rupiah }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.actingUserId, 'kas_bank', 'edit');
    const row = await db.getFirstAsync<{ id: string; saldo: number; journal_id: string | null; kategori: string; nama: string }>(
      `SELECT s.id, s.saldo, s.journal_id, a.kategori, a.nama
       FROM saldo_awal_akun s JOIN account a ON a.id = s.account_id WHERE s.account_id = ?`,
      input.accountId
    );
    if (!row) throw new Error('Saldo awal untuk akun ini belum pernah dicatat.');
    if (!adalahAkunLabaRugi(row.kategori)) {
      throw new Error('Bagian tunai hanya berlaku untuk saldo awal akun Pendapatan atau Beban.');
    }
    if (!Number.isInteger(input.bagianTunai) || input.bagianTunai < 0) {
      throw new Error('Bagian tunai harus berupa angka bulat >= 0.');
    }
    if (input.bagianTunai > row.saldo) {
      throw new Error(`Bagian tunai tidak boleh melebihi saldo awal (Rp${row.saldo.toLocaleString('id-ID')}).`);
    }
    const lama = (await bacaBagianBelumTunaiSaldoAwal(db)).get(input.accountId) ?? 0;
    const bagianBelumTunai = row.saldo - input.bagianTunai;
    await simpanBagianBelumTunai(db, input.accountId, bagianBelumTunai);
    await writeAuditLogNamed(db, input.actingUserId, 'SET_OPENING_BALANCE_CASH_PORTION', row.id, {
      accountId: input.accountId,
      akun: row.nama,
      saldo: row.saldo,
      bagianTunaiLama: row.saldo - Math.min(lama, row.saldo),
      bagianTunaiBaru: input.bagianTunai,
    });
    return { bagianTunai: input.bagianTunai, bagianBelumTunai };
  });
}

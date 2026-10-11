import * as SQLite from 'expo-sqlite';
import { newId, nextSequence } from '@/utils/id';
import { isBalanced, sum, Rupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * ACCOUNTING ENGINE — terpisah total dari UI (PRD §20).
 * Semua transaksi keuangan WAJIB lewat engine ini (PRD §21, §43).
 *
 * Aturan tak bisa ditawar:
 *  - total debit HARUS SAMA DENGAN total kredit, atau REJECT (§19).
 *  - jurnal POSTED tidak boleh diedit langsung — koreksi via reversal (§19, §33).
 *  - semua operasi dibungkus BEGIN/COMMIT/ROLLBACK (§20).
 */

export type JournalStatus = 'DRAFT' | 'POSTED' | 'VOID' | 'REVERSED';

export interface JournalLineInput {
  accountId: string;
  debit: Rupiah;
  kredit: Rupiah;
  keterangan?: string;
}

export interface CreateJournalInput {
  tanggal: string;              // ISO date
  sumberTransaksi: string;      // e.g. 'SIMPANAN_POKOK', 'ANGSURAN'
  sumberId?: string;
  nomorReferensi?: string;
  deskripsi: string;
  lines: JournalLineInput[];
  createdBy: string;
  autoPost?: boolean;           // true = langsung POSTED, false = DRAFT
  /**
   * REQUIREMENT 4 — escape hatch SEMPIT untuk KOREKSI histori, bukan
   * untuk transaksi baru. Satu-satunya pemakai sah: `reverseJournal()`
   * (membalik jurnal POSTED lama yang mungkin menyentuh akun yang
   * SEKARANG sudah dinonaktifkan). Kalau flag ini tidak ada, menonaktifkan
   * sebuah COA akan membuat jurnal lamanya MUSTAHIL dikoreksi — persis
   * yang dilarang requirement ("historical transaction tetap aman",
   * "tidak menyebabkan foreign key/reference error").
   *
   * TIDAK BOLEH dipakai service transaksi biasa. Default false.
   */
  izinkanAkunNonaktif?: boolean;
}

export class UnbalancedJournalError extends Error {
  constructor(totalDebit: number, totalKredit: number) {
    super(
      `Jurnal tidak balance: total debit (${totalDebit}) != total kredit (${totalKredit}). Transaksi ditolak.`
    );
    this.name = 'UnbalancedJournalError';
  }
}

export class ClosedPeriodError extends Error {
  constructor(periodId: string) {
    super(`Periode akuntansi ${periodId} sudah ditutup (CLOSED). Tidak bisa menambah jurnal.`);
    this.name = 'ClosedPeriodError';
  }
}

export class InvalidJournalStateError extends Error {}

/**
 * REQUIREMENT 4 (permintaan pengguna) — COA NON-ACTIVE tidak boleh
 * dipakai untuk TRANSAKSI BARU. Ditegakkan di level ENGINE (satu-satunya
 * pintu masuk jurnal di seluruh aplikasi), BUKAN cuma dengan
 * menyembunyikan akun dari dropdown UI — jadi mustahil ditembus lewat
 * state UI basi, deep link, maupun service yang menerima accountId dari
 * luar.
 *
 * CATATAN: ini melengkapi `InactiveAccountError` di AccountMapping.ts
 * yang sudah lebih dulu menjaga jalur akun OTOMATIS (resolveAccountId).
 * Yang belum terjaga sebelumnya adalah akun yang dipilih MANUAL lewat
 * picker (Beban, Pendapatan Lainnya, Saldo Awal Akun, Kas/Bank).
 */
export class InactiveAccountJournalError extends Error {
  constructor(daftarAkun: string[]) {
    super(
      `Akun berikut berstatus NON-ACTIVE dan tidak dapat dipakai untuk transaksi baru: ${daftarAkun.join(
        ', '
      )}. Aktifkan kembali akun tersebut lewat Pengaturan > Daftar Akun kalau memang masih dipakai.`
    );
    this.name = 'InactiveAccountJournalError';
  }
}

/**
 * REQUIREMENT 4 — validasi keberadaan & status aktif seluruh akun yang
 * dirujuk baris jurnal. Dipanggil SEBELUM baris apa pun ditulis.
 */
async function validateAccountsAktif(
  db: SQLite.SQLiteDatabase,
  lines: JournalLineInput[]
): Promise<void> {
  const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
  if (accountIds.length === 0) return;
  const placeholders = accountIds.map(() => '?').join(',');
  const rows = await db.getAllAsync<{ id: string; kode: string; nama: string; is_active: number }>(
    `SELECT id, kode, nama, is_active FROM account WHERE id IN (${placeholders})`,
    ...accountIds
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  const tidakDitemukan = accountIds.filter((id) => !byId.has(id));
  if (tidakDitemukan.length > 0) {
    throw new Error(`Akun tidak ditemukan untuk baris jurnal: ${tidakDitemukan.join(', ')}.`);
  }

  const nonaktif = rows.filter((r) => !r.is_active).map((r) => `${r.kode} - ${r.nama}`);
  if (nonaktif.length > 0) {
    throw new InactiveAccountJournalError(nonaktif);
  }
}

/**
 * Cari periode akuntansi yang mencakup tanggal ini, ATAU buat periode
 * baru (satu tahun penuh, status OPEN) kalau belum ada — mengatasi bug
 * kritis: sebelumnya `accounting_period` HANYA diisi sekali oleh
 * SetupService untuk tahun buku pertama, dan tidak ada satupun jalan
 * lain untuk membuat periode tahun berikutnya. Akibatnya begitu
 * koperasi masuk tahun buku ke-2, SEMUA transaksi baru akan ditolak
 * (lihat AUDIT_INTERNAL.md §2 poin 2).
 *
 * TIDAK menyentuh/mengubah periode yang sudah ada (termasuk yang
 * CLOSED) — hanya menambah baris baru kalau memang belum ada periode
 * yang mencakup tahun tersebut. Idempoten: dicek dulu by tahun_buku
 * SEBELUM insert, supaya dua transaksi di tahun yang sama tidak
 * membuat dua periode.
 *
 * Rentang tanggal (1 Jan - 31 Des) sengaja fixed ke tahun kalender —
 * BUKAN kebijakan koperasi yang di-hardcode (limit, minimum reserve,
 * dst, itu beda hal & jadi bagian AccountingPolicyService di phase
 * berikutnya). Tahun buku kalender adalah default yang sudah dipakai
 * SetupService sejak awal (lihat services/SetupService.ts), jadi ini
 * konsisten dengan itu, bukan angka baru yang dikarang.
 */
export async function getOrCreatePeriodeUntukTanggal(
  db: SQLite.SQLiteDatabase,
  tanggal: string
): Promise<{ id: string; status: string }> {
  const existing = await db.getFirstAsync<{ id: string; status: string }>(
    `SELECT id, status FROM accounting_period
     WHERE ? BETWEEN periode_mulai AND periode_selesai
     ORDER BY periode_mulai DESC LIMIT 1`,
    tanggal
  );
  if (existing) return existing;

  const tahun = new Date(tanggal).getFullYear();

  // Cek by tahun_buku dulu (bukan cuma by rentang tanggal) — jaga-jaga
  // kalau suatu saat ada periode dengan rentang tidak persis Jan-Des.
  const existingByTahun = await db.getFirstAsync<{ id: string; status: string }>(
    `SELECT id, status FROM accounting_period WHERE tahun_buku = ? LIMIT 1`,
    tahun
  );
  if (existingByTahun) return existingByTahun;

  const id = newId();
  await db.runAsync(
    `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
     VALUES (?,?,?,?,'OPEN')`,
    id,
    tahun,
    `${tahun}-01-01`,
    `${tahun}-12-31`
  );
  return { id, status: 'OPEN' };
}

/**
 * Cari periode akuntansi aktif (OPEN) yang mencakup tanggal ini —
 * otomatis membuat periode baru kalau belum ada (lihat
 * getOrCreatePeriodeUntukTanggal), lalu REJECT kalau periode itu
 * CLOSED (§43).
 */
async function resolvePeriod(db: SQLite.SQLiteDatabase, tanggal: string) {
  const period = await getOrCreatePeriodeUntukTanggal(db, tanggal);
  if (period.status === 'CLOSED') {
    throw new ClosedPeriodError(period.id);
  }
  return period;
}

/**
 * BUG-10 — GUARD PERIODE TERTUTUP YANG DAPAT DIPANGGIL LEBIH AWAL.
 *
 * `createJournal()` sudah menolak periode CLOSED lewat `resolvePeriod`
 * di atas, dan karena seluruh operasi finansial berjalan dalam satu
 * transaksi, penolakan itu me-rollback semuanya. Jadi mengapa perlu
 * fungsi ini?
 *
 * Karena "rollback menyelamatkan database" TIDAK SAMA dengan "tidak
 * ada yang terjadi". Sebelum `createJournal()` dipanggil, sebuah
 * service bisa sudah: menaikkan nomor urut dokumen, menulis log audit,
 * memanggil layanan lain, atau melakukan perhitungan mahal. Efek di
 * luar transaksi database tidak ikut ter-rollback. Validasi periode
 * adalah pemeriksaan yang MURAH dan PASTI — tempatnya di awal, bukan
 * di tengah.
 *
 * Fungsi ini SENGAJA memakai `resolvePeriod` yang sama persis dengan
 * `createJournal`, bukan menyalin logikanya. Kalau aturan periode
 * berubah, ia berubah di satu tempat — dua implementasi yang "mirip"
 * adalah bagaimana bug lifecycle lahir.
 *
 * @throws ClosedPeriodError bila periode akuntansi untuk `tanggal` CLOSED.
 */
export async function assertAccountingPeriodOpen(
  db: SQLite.SQLiteDatabase,
  tanggal: string
): Promise<void> {
  await resolvePeriod(db, tanggal);
}

/**
 * Validasi baris jurnal: tiap baris hanya boleh debit ATAU kredit
 * (tidak dua-duanya), nominal >= 0, dan minimal 2 baris.
 */
function validateLines(lines: JournalLineInput[]) {
  if (lines.length < 2) {
    throw new Error('Jurnal minimal harus mempunyai 2 baris (debit dan kredit).');
  }
  for (const line of lines) {
    if (line.debit < 0 || line.kredit < 0) {
      throw new Error('Nominal debit/kredit tidak boleh negatif.');
    }
    if (line.debit > 0 && line.kredit > 0) {
      throw new Error('Satu baris jurnal tidak boleh mengisi debit dan kredit sekaligus.');
    }
    if (line.debit === 0 && line.kredit === 0) {
      throw new Error('Baris jurnal tidak boleh kosong (debit dan kredit sama-sama 0).');
    }
    // INVARIAN RUPIAH BULAT (PRD §40: "Semua nominal uang disimpan &
    // dihitung sebagai INTEGER Rupiah — tidak pernah floating point
    // langsung").
    //
    // Ini BUKAN aturan akuntansi baru — hanya penegakan aturan yang
    // sudah tertulis, di satu-satunya pintu masuk sah pembuatan jurnal.
    //
    // Alasannya konkret: kolom `journal_entry.debit`/`kredit` ber-afinitas
    // INTEGER, tetapi SQLite MENYIMPAN REAL apa adanya kalau nilainya
    // tidak bisa dikonversi tanpa kehilangan presisi. Jadi nominal
    // pecahan yang lolos ke sini TIDAK ditolak database — ia mengendap
    // diam-diam di ledger dan baru terlihat belakangan sebagai selisih
    // laporan berdesimal yang sulit ditelusuri asalnya. Audit seluruh
    // pemanggil createJournal() menunjukkan SEMUA nominal saat ini sudah
    // melewati roundToRupiah()/Math.round(), jadi guard ini TIDAK
    // mengubah perilaku satu jalur pun yang ada sekarang — ia mencegah
    // jalur BARU menembusnya tanpa disadari, dan gagal keras di titik
    // pembuatan (bukan berbulan-bulan kemudian di laporan).
    if (!Number.isInteger(line.debit) || !Number.isInteger(line.kredit)) {
      throw new Error(
        `Nominal jurnal harus berupa Rupiah bulat (integer), bukan pecahan — ` +
          `diterima debit=${line.debit}, kredit=${line.kredit}. ` +
          `Bulatkan dengan roundToRupiah() di titik perhitungan sebelum membuat jurnal.`
      );
    }
  }
}

/**
 * Buat & (opsional) posting jurnal baru. Ini SATU-SATUNYA cara sah
 * untuk menghasilkan entri jurnal di seluruh aplikasi.
 *
 * Menggunakan SQLite transaction: BEGIN -> proses -> validasi -> COMMIT,
 * ROLLBACK otomatis jika ada error (via withTransactionAsync di caller).
 */
export async function createJournal(
  db: SQLite.SQLiteDatabase,
  input: CreateJournalInput
): Promise<{ journalId: string; nomorJurnal: string }> {
  validateLines(input.lines);

  const totalDebit = sum(input.lines.map((l) => l.debit));
  const totalKredit = sum(input.lines.map((l) => l.kredit));

  if (!isBalanced(totalDebit, totalKredit)) {
    throw new UnbalancedJournalError(totalDebit, totalKredit);
  }

  // REQUIREMENT 4 — gate akun NON-ACTIVE. Ditaruh SETELAH validasi
  // balance (supaya pesan error paling mendasar tetap didahulukan) tapi
  // SEBELUM satu baris pun ditulis ke database.
  if (!input.izinkanAkunNonaktif) {
    await validateAccountsAktif(db, input.lines);
  }

  const period = await resolvePeriod(db, input.tanggal);
  const year = new Date(input.tanggal).getFullYear();
  const nomorJurnal = await nextSequence(db, 'JRN', year);
  const journalId = newId();
  const now = new Date().toISOString();
  const status: JournalStatus = input.autoPost === false ? 'DRAFT' : 'POSTED';

  await db.runAsync(
    `INSERT INTO journal
      (id, nomor_jurnal, tanggal, period_id, nomor_referensi, sumber_transaksi,
       sumber_id, deskripsi, status, created_by, posted_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    journalId,
    nomorJurnal,
    input.tanggal,
    period.id,
    input.nomorReferensi ?? null,
    input.sumberTransaksi,
    input.sumberId ?? null,
    input.deskripsi,
    status,
    input.createdBy,
    status === 'POSTED' ? now : null,
    now,
    now
  );

  let urutan = 0;
  for (const line of input.lines) {
    await db.runAsync(
      `INSERT INTO journal_entry (id, journal_id, account_id, debit, kredit, keterangan, urutan)
       VALUES (?,?,?,?,?,?,?)`,
      newId(),
      journalId,
      line.accountId,
      line.debit,
      line.kredit,
      line.keterangan ?? null,
      urutan++
    );
  }

  await writeAuditLog(db, {
    userId: input.createdBy,
    action: status === 'POSTED' ? 'POST' : 'CREATE',
    entity: 'journal',
    entityId: journalId,
    dataSesudah: { nomorJurnal, status, totalDebit, totalKredit, lines: input.lines },
  });

  return { journalId, nomorJurnal };
}

/** Posting jurnal DRAFT menjadi POSTED. */
export async function postJournal(
  db: SQLite.SQLiteDatabase,
  journalId: string,
  userId: string
): Promise<void> {
  const journal = await db.getFirstAsync<{ status: string }>(
    'SELECT status FROM journal WHERE id = ?',
    journalId
  );
  if (!journal) throw new Error('Jurnal tidak ditemukan.');
  if (journal.status !== 'DRAFT') {
    throw new InvalidJournalStateError('Hanya jurnal berstatus DRAFT yang bisa di-posting.');
  }
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE journal SET status = 'POSTED', posted_at = ?, updated_at = ? WHERE id = ?`,
    now,
    now,
    journalId
  );
  await writeAuditLog(db, { userId, action: 'POST', entity: 'journal', entityId: journalId });
}

/**
 * Koreksi jurnal POSTED lewat REVERSAL (bukan edit langsung) — PRD §19, §33.
 * Membuat jurnal baru dengan debit/kredit dibalik, lalu menandai jurnal
 * asal sebagai REVERSED.
 */
export async function reverseJournal(
  db: SQLite.SQLiteDatabase,
  journalId: string,
  userId: string,
  alasan: string
): Promise<{ journalId: string; nomorJurnal: string }> {
  const original = await db.getFirstAsync<{
    id: string;
    tanggal: string;
    sumber_transaksi: string;
    sumber_id: string | null;
    deskripsi: string;
    status: string;
  }>('SELECT * FROM journal WHERE id = ?', journalId);

  if (!original) throw new Error('Jurnal tidak ditemukan.');
  if (original.status !== 'POSTED') {
    throw new InvalidJournalStateError('Hanya jurnal berstatus POSTED yang bisa di-reversal.');
  }

  const entries = await db.getAllAsync<{
    account_id: string;
    debit: number;
    kredit: number;
    keterangan: string | null;
  }>('SELECT account_id, debit, kredit, keterangan FROM journal_entry WHERE journal_id = ?', journalId);

  const reversedLines: JournalLineInput[] = entries.map((e) => ({
    accountId: e.account_id,
    debit: e.kredit,   // dibalik
    kredit: e.debit,   // dibalik
    keterangan: e.keterangan ?? undefined,
  }));

  const { journalId: newJournalId, nomorJurnal } = await createJournal(db, {
    tanggal: getTanggalLokalHariIni(),
    sumberTransaksi: original.sumber_transaksi,
    sumberId: original.sumber_id ?? undefined,
    nomorReferensi: original.id,
    deskripsi: `REVERSAL: ${alasan} (jurnal asal: ${original.deskripsi})`,
    lines: reversedLines,
    createdBy: userId,
    autoPost: true,
    // REQUIREMENT 4: reversal adalah KOREKSI atas jurnal yang SUDAH ADA,
    // bukan transaksi baru. Akun yang dirujuk sudah pasti pernah sah
    // dipakai; kalau sejak itu dinonaktifkan, koreksinya HARUS tetap
    // bisa jalan — kalau tidak, menonaktifkan COA justru mengunci
    // histori (melanggar "tidak menghapus/mengunci journal lama").
    izinkanAkunNonaktif: true,
  });

  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE journal SET status = 'REVERSED', reversed_by_id = ?, updated_at = ? WHERE id = ?`,
    newJournalId,
    now,
    journalId
  );
  await db.runAsync(`UPDATE journal SET reversal_of_id = ? WHERE id = ?`, journalId, newJournalId);

  await writeAuditLog(db, {
    userId,
    action: 'REVERSE',
    entity: 'journal',
    entityId: journalId,
    dataSesudah: { reversedByJournalId: newJournalId, alasan },
  });

  return { journalId: newJournalId, nomorJurnal };
}

/** Void jurnal DRAFT (belum posted) — boleh dihapus statusnya jadi VOID. */
export async function voidJournal(
  db: SQLite.SQLiteDatabase,
  journalId: string,
  userId: string
): Promise<void> {
  const journal = await db.getFirstAsync<{ status: string }>(
    'SELECT status FROM journal WHERE id = ?',
    journalId
  );
  if (!journal) throw new Error('Jurnal tidak ditemukan.');
  if (journal.status !== 'DRAFT') {
    throw new InvalidJournalStateError(
      'Jurnal POSTED tidak boleh di-void langsung — gunakan reversal.'
    );
  }
  const now = new Date().toISOString();
  await db.runAsync(`UPDATE journal SET status = 'VOID', updated_at = ? WHERE id = ?`, now, journalId);
  await writeAuditLog(db, { userId, action: 'VOID', entity: 'journal', entityId: journalId });
}

/** Saldo akun pada satu titik waktu (untuk buku besar, neraca saldo, laporan). */
export async function getAccountBalance(
  db: SQLite.SQLiteDatabase,
  accountId: string,
  asOfDate?: string
): Promise<Rupiah> {
  const account = await db.getFirstAsync<{ normal_balance: string }>(
    'SELECT normal_balance FROM account WHERE id = ?',
    accountId
  );
  if (!account) throw new Error('Akun tidak ditemukan.');

  const dateFilter = asOfDate ? 'AND j.tanggal <= ?' : '';
  const params = asOfDate ? [accountId, asOfDate] : [accountId];

  // PENTING (bug fix fase 7, bukan perubahan arsitektur): jurnal berstatus
  // REVERSED tetap dihitung, bukan dikecualikan. Jurnal REVERSED adalah
  // transaksi yang BENAR-BENAR TERJADI lalu dikoreksi lewat reversal
  // TERPISAH (§19) — entrinya tetap fakta historis yang valid, dan sudah
  // dinetralkan oleh jurnal reversal (yang statusnya POSTED). Jika
  // REVERSED dikecualikan, hasilnya jadi "dobel negatif" (saldo bukan
  // kembali ke sebelum transaksi asli, tapi malah surplus sebesar
  // reversal-nya) — hanya VOID (jurnal DRAFT yang dibatalkan, tidak
  // pernah diposting) yang benar-benar tidak pernah terjadi dan layak
  // dikecualikan.
  const row = await db.getFirstAsync<{ total_debit: number; total_kredit: number }>(
    `SELECT COALESCE(SUM(je.debit),0) as total_debit, COALESCE(SUM(je.kredit),0) as total_kredit
     FROM journal_entry je
     JOIN journal j ON j.id = je.journal_id
     WHERE je.account_id = ? AND j.status IN ('POSTED','REVERSED') ${dateFilter}`,
    ...params
  );

  const totalDebit = row?.total_debit ?? 0;
  const totalKredit = row?.total_kredit ?? 0;

  return account.normal_balance === 'DEBIT' ? totalDebit - totalKredit : totalKredit - totalDebit;
}

/**
 * BUG-15 — versi BULK dari `getAccountBalance`.
 *
 * `getArusKas()` sebelumnya memanggil `getAccountBalance()` di dalam
 * loop, DUA kali per akun (saldo awal + saldo akhir), dan setiap
 * panggilan itu sendiri melakukan 2 query (lookup normal_balance +
 * agregasi journal_entry). Untuk N akun kas/bank itu 4N query hanya
 * untuk menghitung kas awal/akhir — N+1 klasik yang tumbuh linear
 * terhadap jumlah rekening.
 *
 * Fungsi ini mengambil SELURUH saldo dalam SATU query agregat.
 * Semantiknya WAJIB identik dengan `getAccountBalance` (termasuk
 * memasukkan jurnal REVERSED dan menghormati normal_balance), karena
 * keduanya harus selalu menghasilkan angka yang sama — kalau berbeda,
 * Arus Kas tidak akan pernah rekonsiliasi dengan Neraca Saldo.
 *
 * Akun yang tidak punya entri jurnal sama sekali tetap dikembalikan
 * dengan saldo 0 (bukan dihilangkan dari Map), supaya pemanggil tidak
 * perlu membedakan "tidak ada data" dari "saldo nol".
 */
export async function getAccountBalancesBulk(
  db: SQLite.SQLiteDatabase,
  accountIds: string[],
  asOfDate?: string
): Promise<Map<string, Rupiah>> {
  const hasil = new Map<string, Rupiah>();
  if (accountIds.length === 0) return hasil;

  const placeholders = accountIds.map(() => '?').join(',');
  const dateFilter = asOfDate ? 'AND j.tanggal <= ?' : '';
  // URUTAN PENTING: placeholder tanggal berada di klausa ON (sebelum
  // WHERE), jadi parameternya harus mendahului daftar accountId.
  const params: SQLite.SQLiteBindValue[] = asOfDate ? [asOfDate, ...accountIds] : [...accountIds];

  const rows = await db.getAllAsync<{
    id: string;
    normal_balance: string;
    total_debit: number;
    total_kredit: number;
  }>(
    `SELECT a.id, a.normal_balance,
            COALESCE(SUM(CASE WHEN j.id IS NOT NULL THEN je.debit ELSE 0 END), 0) as total_debit,
            COALESCE(SUM(CASE WHEN j.id IS NOT NULL THEN je.kredit ELSE 0 END), 0) as total_kredit
     FROM account a
     LEFT JOIN journal_entry je ON je.account_id = a.id
     LEFT JOIN journal j ON j.id = je.journal_id AND j.status IN ('POSTED','REVERSED') ${dateFilter}
     WHERE a.id IN (${placeholders})
     GROUP BY a.id, a.normal_balance`,
    ...params
  );

  for (const row of rows) {
    // LEFT JOIN ke journal bisa menyisakan baris journal_entry yang
    // jurnalnya tersaring (VOID / di luar tanggal) — baris seperti itu
    // menghasilkan j.id NULL sehingga debit/kredit-nya TIDAK boleh
    // ikut. Kondisi status/tanggal sengaja ditaruh di ON (bukan WHERE)
    // supaya akun tanpa jurnal tetap muncul dengan saldo 0.
    const debit = row.total_debit ?? 0;
    const kredit = row.total_kredit ?? 0;
    hasil.set(row.id, row.normal_balance === 'DEBIT' ? debit - kredit : kredit - debit);
  }
  for (const id of accountIds) {
    if (!hasil.has(id)) hasil.set(id, 0);
  }
  return hasil;
}

async function writeAuditLog(
  db: SQLite.SQLiteDatabase,
  entry: {
    userId: string;
    action: string;
    entity: string;
    entityId?: string;
    dataSebelum?: unknown;
    dataSesudah?: unknown;
  }
) {
  const now = new Date();
  await db.runAsync(
    `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sebelum, data_sesudah, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId(),
    entry.userId,
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    entry.action,
    entry.entity,
    entry.entityId ?? null,
    entry.dataSebelum ? JSON.stringify(entry.dataSebelum) : null,
    entry.dataSesudah ? JSON.stringify(entry.dataSesudah) : null,
    now.toISOString()
  );
}

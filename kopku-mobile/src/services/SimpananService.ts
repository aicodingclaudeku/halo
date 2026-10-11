import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, reverseJournal } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { checkSaldoAkunCukup } from '@/services/LiquidityService';
import { checkAnggotaAktif } from '@/validators/BusinessRuleEngine';
import { requirePermission } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';

export type JenisSimpanan = 'POKOK' | 'WAJIB' | 'SUKARELA';
type TipeTransaksi = 'SETOR' | 'TARIK' | 'KOREKSI';

/**
 * BUG FIX (Prioritas 3/E — audit SHU, "ACCOUNTING LOGIC ERROR"):
 * `koreksiSimpanan()` mereversal JURNAL asal (jadi saldo akun Kas/
 * Simpanan di LEDGER sudah benar-benar dinetralkan), tapi baris
 * `simpanan_transaksi` ASLI yang dikoreksi TETAP ADA dengan
 * `reversal_of_id IS NULL` (dia bukan baris koreksi, dia yang
 * DIKOREKSI). Baris KOREKSI barunya sendiri memang `tipe = 'KOREKSI'`
 * sehingga CASE di bawah otomatis memberi kontribusi 0 padanya — tapi
 * filter lama `WHERE reversal_of_id IS NULL` TIDAK PERNAH mengeluarkan
 * baris ASLI yang sudah dikoreksi itu dari SUM. Akibatnya saldo
 * simpanan versi `simpanan_transaksi` (dipakai di sini & di seluruh
 * layar saldo anggota) bisa BERBEDA dari saldo versi ledger/jurnal
 * (yang sudah benar) — setoran yang sudah dikoreksi/dibatalkan tetap
 * ikut terhitung selamanya.
 *
 * Fix: keluarkan juga baris ASLI yang sudah pernah dikoreksi (id-nya
 * muncul sebagai `reversal_of_id` pada baris lain) — bukan hanya
 * mengecualikan baris koreksinya sendiri.
 *
 * Dipindah ke dekat atas file (sebelumnya di tengah) supaya bisa
 * dipakai oleh guard "Simpanan Pokok satu kali" (Revisi KOPKU Bagian
 * 5.2/10) di `pastikanBelumAdaSimpananPokok` di bawah, yang dipanggil
 * dari `setorSimpanan` SEBELUM definisi constant ini sebelumnya.
 */
const SIMPANAN_TIDAK_DIKOREKSI_CLAUSE = `reversal_of_id IS NULL AND id NOT IN (
  SELECT reversal_of_id FROM simpanan_transaksi WHERE reversal_of_id IS NOT NULL
)`;
/** Sama seperti di atas, versi ber-alias `st.` untuk dipakai di JOIN ON. */
const SIMPANAN_TIDAK_DIKOREKSI_CLAUSE_ST = `st.reversal_of_id IS NULL AND st.id NOT IN (
  SELECT reversal_of_id FROM simpanan_transaksi WHERE reversal_of_id IS NOT NULL
)`;

/**
 * Phase 5 (AUDIT_INTERNAL.md §3.1): sebelum ini setorSimpanan &
 * tarikSimpananSukarela tidak pernah mengecek status anggota sama
 * sekali — anggota berstatus TIDAK_AKTIF/KELUAR/MENINGGAL tetap bisa
 * jadi subjek transaksi simpanan baru. Helper ini dipakai di kedua
 * fungsi supaya satu sumber kebenaran, bukan duplikasi query+check.
 */
async function pastikanAnggotaAktif(db: SQLite.SQLiteDatabase, anggotaId: string): Promise<void> {
  const anggota = await db.getFirstAsync<{ status: string }>(`SELECT status FROM anggota WHERE id = ?`, anggotaId);
  if (!anggota) throw new Error('Anggota tidak ditemukan.');
  const cek = checkAnggotaAktif(anggota.status);
  if (!cek.valid) throw new Error(cek.reason);
}

/**
 * Revisi KOPKU (Bagian 4/5.2/10): Simpanan Pokok anggota HANYA boleh
 * dicatat SATU KALI. Cek didasarkan pada `anggota_id` + `jenis =
 * 'POKOK'` + `tipe = 'SETOR'` yang masih AKTIF (belum pernah dikoreksi
 * — pakai exclusion clause yang sama dengan perhitungan saldo, supaya
 * kalau setoran Pokok yang salah sudah dikoreksi lewat
 * `koreksiSimpanan()`, admin BISA mencatat Pokok yang benar lagi —
 * bukan terkunci permanen).
 *
 * Dipanggil dari DUA tempat (Bagian 10: "karena user dapat memanggil
 * service dari jalur lain"): `setorSimpanan()` (jalur lama, satu
 * jenis per submit) dan `catatDataAwalSimpanan()` (jalur baru,
 * gabungan) — supaya validasi ini tidak bisa dilewati lewat salah
 * satu pintu masuk.
 *
 * CATATAN JUJUR soal "validasi di level Database" (diminta Bagian
 * 10): SQLite tidak mendukung partial UNIQUE INDEX yang bisa
 * menghormati exclusion clause di atas (index tidak bisa mengecek
 * "apakah baris ini nanti direferensikan sebagai reversal_of_id oleh
 * baris lain" — itu properti masa depan, bukan properti baris saat
 * insert). Constraint DB murni (UNIQUE index sederhana) akan salah
 * mengunci admin setelah koreksi yang sah. Alternatif yang benar
 * (trigger) akan jadi pola BARU yang belum pernah dipakai sama sekali
 * di skema ini (tidak ada CREATE TRIGGER lain) — jadi enforcement
 * SENGAJA tetap di lapisan service (di dalam `withTransaction` yang
 * sama dengan insert-nya, jadi tetap atomic terhadap SATU koneksi
 * SQLite aplikasi ini), bukan constraint/trigger DB.
 */
async function pastikanBelumAdaSimpananPokok(db: SQLite.SQLiteDatabase, anggotaId: string): Promise<void> {
  const row = await db.getFirstAsync<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM simpanan_transaksi
     WHERE anggota_id = ? AND jenis = 'POKOK' AND tipe = 'SETOR' AND ${SIMPANAN_TIDAK_DIKOREKSI_CLAUSE}`,
    anggotaId
  );
  if ((row?.cnt ?? 0) > 0) {
    throw new Error(
      'Simpanan Pokok anggota ini sudah memiliki saldo awal. Gunakan Koreksi Simpanan untuk memperbaikinya, bukan input baru.'
    );
  }
}

export interface SetorSimpananInput {
  anggotaId: string;
  jenis: JenisSimpanan;
  tanggal: string;
  nominal: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  periode?: string; // untuk simpanan wajib, format YYYY-MM
  keterangan?: string;
  createdBy: string;
}

const MAPPING_BY_JENIS: Record<JenisSimpanan, string> = {
  POKOK: 'SIMPANAN_POKOK',
  WAJIB: 'SIMPANAN_WAJIB',
  SUKARELA: 'SIMPANAN_SUKARELA',
};

/**
 * Setor simpanan (pokok/wajib/sukarela). Transaksi otomatis membuat
 * jurnal (PRD §8-10):
 *   DEBIT  Kas/Bank
 *   KREDIT Simpanan <jenis>
 */
export async function setorSimpanan(input: SetorSimpananInput) {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'simpanan', 'create');
    await pastikanAnggotaAktif(db, input.anggotaId);
    // Revisi KOPKU (Bagian 4/5.2/10): Simpanan Pokok hanya boleh
    // dicatat satu kali per anggota — ditegakkan di sini juga (bukan
    // cuma di `catatDataAwalSimpanan`) supaya jalur setor satu-jenis
    // yang lama ini tidak bisa dipakai untuk melewati validasi.
    if (input.jenis === 'POKOK') {
      await pastikanBelumAdaSimpananPokok(db, input.anggotaId);
    }
    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    const simpananAccountId = await resolveAccountId(db, MAPPING_BY_JENIS[input.jenis], 'KREDIT_DEFAULT');

    const year = new Date(input.tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, `SP-${input.jenis}`, year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: MAPPING_BY_JENIS[input.jenis],
      nomorReferensi: nomorTransaksi,
      deskripsi: `Setoran simpanan ${input.jenis.toLowerCase()} - ${nomorTransaksi}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: kasBankAccountId, debit: input.nominal, kredit: 0 },
        { accountId: simpananAccountId, debit: 0, kredit: input.nominal },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO simpanan_transaksi
        (id, anggota_id, jenis, tipe, tanggal, periode, nominal, sumber_dana, bank_account_id,
         nomor_transaksi, keterangan, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.anggotaId,
      input.jenis,
      'SETOR' satisfies TipeTransaksi,
      input.tanggal,
      input.periode ?? null,
      input.nominal,
      input.sumberDana,
      input.bankAccountId ?? null,
      nomorTransaksi,
      input.keterangan ?? null,
      journalId,
      input.createdBy,
      now
    );

    return { id, nomorTransaksi, journalId };
  });
}

/** Penarikan simpanan sukarela — satu-satunya jenis yang boleh ditarik (PRD §10). */
export async function tarikSimpananSukarela(input: Omit<SetorSimpananInput, 'jenis' | 'periode'>) {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'simpanan', 'create');
    await pastikanAnggotaAktif(db, input.anggotaId);
    const saldo = await getSaldoSimpanan(db, input.anggotaId, 'SUKARELA');
    if (saldo < input.nominal) {
      throw new Error(`Saldo simpanan sukarela tidak cukup (saldo: ${saldo}, penarikan: ${input.nominal}).`);
    }

    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    // Phase 4: cek saldo simpanan anggota di atas cuma memastikan
    // ANGGOTA punya cukup simpanan — belum tentu KAS/BANK koperasi
    // punya cukup uang fisik untuk membayarkannya. Dua-duanya perlu
    // dicek terpisah.
    const cekSaldo = await checkSaldoAkunCukup(db, {
      accountId: kasBankAccountId,
      namaRekening: input.sumberDana === 'BANK' ? 'rekening bank yang dipilih' : 'Kas',
      nominalKeluar: input.nominal,
    });
    if (!cekSaldo.valid) throw new Error(cekSaldo.reason);

    const simpananAccountId = await resolveAccountId(db, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT');

    const year = new Date(input.tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'ST-TARIK', year);

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'SIMPANAN_SUKARELA',
      nomorReferensi: nomorTransaksi,
      deskripsi: `Penarikan simpanan sukarela - ${nomorTransaksi}`,
      createdBy: input.createdBy,
      lines: [
        // dibalik dari setoran: debit simpanan (mengurangi kewajiban), kredit kas/bank
        { accountId: simpananAccountId, debit: input.nominal, kredit: 0 },
        { accountId: kasBankAccountId, debit: 0, kredit: input.nominal },
      ],
    });

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO simpanan_transaksi
        (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, bank_account_id,
         nomor_transaksi, keterangan, journal_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.anggotaId,
      'SUKARELA' satisfies JenisSimpanan,
      'TARIK' satisfies TipeTransaksi,
      input.tanggal,
      input.nominal,
      input.sumberDana,
      input.bankAccountId ?? null,
      nomorTransaksi,
      input.keterangan ?? null,
      journalId,
      input.createdBy,
      now
    );

    return { id, nomorTransaksi, journalId };
  });
}

export interface SimpananHistoriRow {
  id: string;
  anggotaId: string;
  namaAnggota: string;
  jenis: JenisSimpanan;
  tipe: TipeTransaksi;
  tanggal: string;
  nominal: Rupiah;
  nomorTransaksi: string;
  keterangan: string | null;
}

/** Histori simpanan (opsional filter per anggota/jenis), untuk layar histori (PRD §8-10). */
export async function listSimpananHistori(opts: {
  anggotaId?: string;
  jenis?: JenisSimpanan;
  limit?: number;
  offset?: number;
} = {}): Promise<SimpananHistoriRow[]> {
  const db = await getDb();
  const filters: string[] = [];
  const params: (string | number)[] = [];

  if (opts.anggotaId) {
    filters.push('st.anggota_id = ?');
    params.push(opts.anggotaId);
  }
  if (opts.jenis) {
    filters.push('st.jenis = ?');
    params.push(opts.jenis);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const rows = await db.getAllAsync<any>(
    `SELECT st.id, st.anggota_id, a.nama_lengkap, st.jenis, st.tipe, st.tanggal,
            st.nominal, st.nomor_transaksi, st.keterangan
     FROM simpanan_transaksi st
     JOIN anggota a ON a.id = st.anggota_id
     ${where}
     ORDER BY st.tanggal DESC, st.created_at DESC
     LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset
  );

  return rows.map((r) => ({
    id: r.id,
    anggotaId: r.anggota_id,
    namaAnggota: r.nama_lengkap,
    jenis: r.jenis,
    tipe: r.tipe,
    tanggal: r.tanggal,
    nominal: r.nominal,
    nomorTransaksi: r.nomor_transaksi,
    keterangan: r.keterangan,
  }));
}

/**
 * (Definisi `SIMPANAN_TIDAK_DIKOREKSI_CLAUSE` dipindah ke dekat atas
 * file — lihat komentar di sana untuk latar belakang bug fix
 * Prioritas 3/E yang membuat exclusion clause ini diperlukan.)
 */
/** Saldo dihitung dari transaksi, TIDAK disimpan manual (PRD §10). */
export async function getSaldoSimpanan(
  db: SQLite.SQLiteDatabase,
  anggotaId: string,
  jenis: JenisSimpanan
): Promise<Rupiah> {
  const row = await db.getFirstAsync<{ total: number }>(
    `SELECT COALESCE(SUM(CASE WHEN tipe = 'SETOR' THEN nominal
                               WHEN tipe = 'TARIK' THEN -nominal
                               ELSE 0 END), 0) as total
     FROM simpanan_transaksi
     WHERE anggota_id = ? AND jenis = ? AND ${SIMPANAN_TIDAK_DIKOREKSI_CLAUSE}`,
    anggotaId,
    jenis
  );
  return row?.total ?? 0;
}

/**
 * Versi getSaldoSimpanan yang membuka koneksi db sendiri — dipakai
 * langsung dari layar (UI) untuk deteksi saldo real-time, mis. di form
 * tarik simpanan sukarela, tanpa layar perlu mengimpor expo-sqlite
 * sendiri (PRD §44: akses SQL harus lewat repositories/services).
 */
export async function getSaldoSimpananAnggota(
  anggotaId: string,
  jenis: JenisSimpanan
): Promise<Rupiah> {
  const db = await getDb();
  return getSaldoSimpanan(db, anggotaId, jenis);
}

export interface SaldoSimpananAnggotaRow {
  anggotaId: string;
  nomorAnggota: string;
  namaAnggota: string;
  pokok: Rupiah;
  wajib: Rupiah;
  sukarela: Rupiah;
  total: Rupiah;
}

/**
 * Rekap saldo simpanan (pokok/wajib/sukarela) per anggota — dipakai
 * untuk export "Rekap Simpanan per Anggota" (beda dari histori
 * transaksi mentah di buildSimpananExport: ini satu baris per anggota
 * berisi saldo akhir tiap jenis).
 */
export async function listSaldoSimpananSemuaAnggota(): Promise<SaldoSimpananAnggotaRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT
       a.id as anggota_id,
       a.nomor_anggota,
       a.nama_lengkap,
       COALESCE(SUM(CASE WHEN st.jenis = 'POKOK' AND st.tipe = 'SETOR' THEN st.nominal
                          WHEN st.jenis = 'POKOK' AND st.tipe = 'TARIK' THEN -st.nominal ELSE 0 END), 0) as pokok,
       COALESCE(SUM(CASE WHEN st.jenis = 'WAJIB' AND st.tipe = 'SETOR' THEN st.nominal
                          WHEN st.jenis = 'WAJIB' AND st.tipe = 'TARIK' THEN -st.nominal ELSE 0 END), 0) as wajib,
       COALESCE(SUM(CASE WHEN st.jenis = 'SUKARELA' AND st.tipe = 'SETOR' THEN st.nominal
                          WHEN st.jenis = 'SUKARELA' AND st.tipe = 'TARIK' THEN -st.nominal ELSE 0 END), 0) as sukarela
     FROM anggota a
     LEFT JOIN simpanan_transaksi st ON st.anggota_id = a.id AND ${SIMPANAN_TIDAK_DIKOREKSI_CLAUSE_ST}
     GROUP BY a.id, a.nomor_anggota, a.nama_lengkap
     HAVING (pokok != 0 OR wajib != 0 OR sukarela != 0)
     ORDER BY a.nomor_anggota ASC`
  );
  return rows.map((r) => ({
    anggotaId: r.anggota_id,
    nomorAnggota: r.nomor_anggota,
    namaAnggota: r.nama_lengkap,
    pokok: r.pokok,
    wajib: r.wajib,
    sukarela: r.sukarela,
    total: r.pokok + r.wajib + r.sukarela,
  }));
}

export interface AnggotaSaldoSukarelaCandidate {
  id: string;
  nomorAnggota: string;
  namaLengkap: string;
  nik: string | null;
  status: string;
  saldoSukarela: Rupiah;
}

/**
 * Kandidat anggota untuk "Tarik Simpanan Anggota" — HANYA anggota
 * dengan saldo simpanan SUKARELA > 0 (Phase 17 §A). Sengaja query
 * saldo aktual dari simpanan_transaksi (bukan sekadar status anggota)
 * supaya anggota yang saldo sukarelanya sudah 0 (pernah ditarik habis)
 * otomatis hilang dari daftar tanpa perlu flag terpisah.
 */
export async function listAnggotaSaldoSukarelaTersedia(opts: {
  search?: string;
  limit?: number;
  offset?: number;
  /**
   * RC-S118.1: ambil SELURUH kandidat tanpa LIMIT/OFFSET sama sekali.
   * Dipakai picker anggota, yang harus memperlihatkan jumlah anggota
   * yang SEBENARNYA — bukan halaman pertama. Penyaringan kelayakan di
   * query TIDAK berubah; yang hilang hanya batas halamannya. Pemanggil
   * lain yang tidak mengisi opsi ini tetap ber-pagination seperti semula.
   */
  semuaData?: boolean;
} = {}): Promise<AnggotaSaldoSukarelaCandidate[]> {
  const db = await getDb();
  const filters: string[] = [`a.status = 'AKTIF'`];
  const params: (string | number)[] = [];
  if (opts.search) {
    filters.push('(a.nama_lengkap LIKE ? OR a.nomor_anggota LIKE ? OR a.nik LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s, s);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  /*
   * RC-S118.1: HANYA klausa paginasi yang ikut `semuaData` — WHERE,
   * JOIN, dan `HAVING saldo_sukarela > 0` tetap apa adanya. Syarat
   * kelayakan "punya saldo sukarela" adalah inti fungsi ini dan tidak
   * boleh ikut hilang bersama batas halaman.
   */
  const paginasi = opts.semuaData ? '' : 'LIMIT ? OFFSET ?';
  const paramPaginasi = opts.semuaData ? [] : [opts.limit ?? 30, opts.offset ?? 0];

  const rows = await db.getAllAsync<any>(
    `SELECT a.id, a.nomor_anggota, a.nama_lengkap, a.nik, a.status,
       COALESCE(SUM(CASE WHEN st.jenis = 'SUKARELA' AND st.tipe = 'SETOR' THEN st.nominal
                          WHEN st.jenis = 'SUKARELA' AND st.tipe = 'TARIK' THEN -st.nominal ELSE 0 END), 0) as saldo_sukarela
     FROM anggota a
     LEFT JOIN simpanan_transaksi st ON st.anggota_id = a.id AND ${SIMPANAN_TIDAK_DIKOREKSI_CLAUSE_ST}
     ${where}
     GROUP BY a.id, a.nomor_anggota, a.nama_lengkap, a.nik, a.status
     HAVING saldo_sukarela > 0
     ORDER BY a.nama_lengkap ASC
     ${paginasi}`,
    ...params,
    ...paramPaginasi
  );
  return rows.map((r) => ({
    id: r.id,
    nomorAnggota: r.nomor_anggota,
    namaLengkap: r.nama_lengkap,
    nik: r.nik,
    status: r.status,
    saldoSukarela: r.saldo_sukarela,
  }));
}

/**
 * ============================================================
 * DETAIL SATU TRANSAKSI SIMPANAN — READ-ONLY (fitur Detail Simpanan)
 * ============================================================
 *
 * `listSimpananHistori()` sengaja TIDAK dipakai ulang untuk layar
 * detail: ia tidak membaca `periode`, `sumber_dana`, `journal_id`,
 * maupun `reversal_of_id`, sehingga status koreksi/reversal — satu-satunya
 * hal yang wajib terlihat di halaman detail agar tidak menyesatkan —
 * tidak akan pernah bisa ditampilkan. Menambah kolom-kolom itu ke
 * `listSimpananHistori` berarti setiap baris daftar (dimuat 100.000
 * sekaligus di layar histori) ikut membawa data yang tidak dipakainya.
 *
 * Fungsi ini MURNI membaca: satu SELECT + dua LEFT JOIN untuk
 * menerjemahkan `reversal_of_id` ke nomor transaksi yang dapat dibaca
 * manusia, di kedua arah:
 *
 *   `koreksiDariNomorTransaksi` — diisi bila baris INI adalah KOREKSI
 *                                 (yaitu nomor transaksi ASLI yang dikoreksi).
 *   `dikoreksiOlehNomorTransaksi` — diisi bila baris INI adalah transaksi
 *                                 ASLI yang SUDAH dikoreksi transaksi lain.
 *
 * Definisi "sudah dikoreksi" DISAMAKAN PERSIS dengan
 * `SIMPANAN_TIDAK_DIKOREKSI_CLAUSE` yang dipakai `getSaldoSimpanan`
 * (`id` muncul sebagai `reversal_of_id` milik baris lain) — supaya
 * layar tidak pernah menyatakan sebuah transaksi "masih berlaku"
 * padahal saldo sudah mengecualikannya.
 *
 * TIDAK menulis apa pun: tanpa INSERT/UPDATE/DELETE, tanpa jurnal,
 * tanpa reversal. Semantics `koreksiSimpanan()` tidak disentuh.
 */
export interface SimpananDetailRow {
  id: string;
  anggotaId: string;
  nomorAnggota: string | null;
  namaAnggota: string | null;
  jenis: JenisSimpanan;
  tipe: TipeTransaksi;
  tanggal: string;
  periode: string | null;
  nominal: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId: string | null;
  nomorTransaksi: string;
  keterangan: string | null;
  journalId: string | null;
  reversalOfId: string | null;
  /** Nomor transaksi ASLI yang dikoreksi baris ini (hanya untuk tipe KOREKSI). */
  koreksiDariNomorTransaksi: string | null;
  /** Nomor transaksi KOREKSI yang membatalkan baris ini (bila sudah dikoreksi). */
  dikoreksiOlehNomorTransaksi: string | null;
  createdBy: string;
  createdAt: string;
}

/**
 * Baca satu transaksi simpanan untuk layar detail. `null` bila id tidak
 * ada — pemanggil menampilkan empty state, bukan melempar.
 *
 * `LEFT JOIN anggota` (bukan INNER seperti `listSimpananHistori`) supaya
 * transaksi dengan anggota yang hilang tetap dapat dibuka; layar
 * menampilkan "Data anggota tidak ditemukan." alih-alih layar kosong.
 */
export async function getSimpananDetailById(
  simpananId: string
): Promise<SimpananDetailRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<any>(
    `SELECT st.id, st.anggota_id, a.nomor_anggota, a.nama_lengkap,
            st.jenis, st.tipe, st.tanggal, st.periode, st.nominal,
            st.sumber_dana, st.bank_account_id, st.nomor_transaksi,
            st.keterangan, st.journal_id, st.reversal_of_id,
            asli.nomor_transaksi AS koreksi_dari_nomor,
            koreksi.nomor_transaksi AS dikoreksi_oleh_nomor,
            st.created_by, st.created_at
     FROM simpanan_transaksi st
     LEFT JOIN anggota a ON a.id = st.anggota_id
     LEFT JOIN simpanan_transaksi asli ON asli.id = st.reversal_of_id
     LEFT JOIN simpanan_transaksi koreksi ON koreksi.reversal_of_id = st.id
     WHERE st.id = ?`,
    simpananId
  );
  if (!r) return null;
  return {
    id: r.id,
    anggotaId: r.anggota_id,
    nomorAnggota: r.nomor_anggota ?? null,
    namaAnggota: r.nama_lengkap ?? null,
    jenis: r.jenis,
    tipe: r.tipe,
    tanggal: r.tanggal,
    periode: r.periode ?? null,
    nominal: r.nominal,
    sumberDana: r.sumber_dana,
    bankAccountId: r.bank_account_id ?? null,
    nomorTransaksi: r.nomor_transaksi,
    keterangan: r.keterangan ?? null,
    journalId: r.journal_id ?? null,
    reversalOfId: r.reversal_of_id ?? null,
    koreksiDariNomorTransaksi: r.koreksi_dari_nomor ?? null,
    dikoreksiOlehNomorTransaksi: r.dikoreksi_oleh_nomor ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/**
 * Saldo Pokok/Wajib/Sukarela + total untuk satu anggota, dibaca lewat
 * `getSaldoSimpanan` yang SAMA dengan seluruh aplikasi (exclusion-aware
 * terhadap koreksi). Layar TIDAK menjumlahkan transaksi sendiri.
 *
 * Simpanan Berjangka SENGAJA tidak ikut: itu subledger terpisah
 * (`simpanan_berjangka`), dan mencampurnya ke total simpanan reguler
 * akan menghasilkan angka yang tidak sebanding dengan layar mana pun.
 */
export async function getRingkasanSaldoSimpananAnggota(
  anggotaId: string
): Promise<{ pokok: Rupiah; wajib: Rupiah; sukarela: Rupiah; total: Rupiah }> {
  const db = await getDb();
  const [pokok, wajib, sukarela] = await Promise.all([
    getSaldoSimpanan(db, anggotaId, 'POKOK'),
    getSaldoSimpanan(db, anggotaId, 'WAJIB'),
    getSaldoSimpanan(db, anggotaId, 'SUKARELA'),
  ]);
  return { pokok, wajib, sukarela, total: pokok + wajib + sukarela };
}

/** Koreksi transaksi simpanan lewat reversal jurnal (PRD §8: "koreksi menggunakan reversal"). */
export async function koreksiSimpanan(
  simpananTransaksiId: string,
  userId: string,
  alasan: string
) {
  return withTransaction(async (db) => {
    await requirePermission(db, userId, 'simpanan', 'edit');
    const trx = await db.getFirstAsync<{ journal_id: string | null }>(
      'SELECT journal_id FROM simpanan_transaksi WHERE id = ?',
      simpananTransaksiId
    );
    if (!trx) throw new Error('Transaksi simpanan tidak ditemukan.');
    if (!trx.journal_id) throw new Error('Transaksi ini tidak mempunyai jurnal terkait.');

    await reverseJournal(db, trx.journal_id, userId, alasan);

    const id = newId();
    const now = new Date().toISOString();
    const original = await db.getFirstAsync<any>(
      'SELECT * FROM simpanan_transaksi WHERE id = ?',
      simpananTransaksiId
    );
    await db.runAsync(
      `INSERT INTO simpanan_transaksi
        (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, bank_account_id,
         nomor_transaksi, keterangan, reversal_of_id, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      original.anggota_id,
      original.jenis,
      'KOREKSI' satisfies TipeTransaksi,
      now.slice(0, 10),
      original.nominal,
      original.sumber_dana,
      original.bank_account_id,
      `KOREKSI-${original.nomor_transaksi}`,
      alasan,
      simpananTransaksiId,
      userId,
      now
    );
    return { id };
  });
}

/**
 * Keluar Anggota (sub-fitur Pengeluaran) — "diambil dari data simpanan
 * anggota" sesuai permintaan: total saldo simpanan pokok+wajib+sukarela
 * DIAMBIL OTOMATIS (bukan diketik manual) dari getSaldoSimpanan, lalu
 * dikembalikan seluruhnya ke anggota via kas/bank, dan status anggota
 * otomatis diubah jadi KELUAR — semua dalam satu transaksi DB supaya
 * konsisten (tidak mungkin uang keluar tapi status anggota tidak
 * berubah, atau sebaliknya).
 *
 * Jurnal: DEBIT Simpanan Pokok + Simpanan Wajib + Simpanan Sukarela
 * (menghapus kewajiban/ekuitas), KREDIT Kas/Bank (uang keluar).
 */
export async function keluarAnggota(input: {
  anggotaId: string;
  tanggal: string;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  keterangan?: string;
  createdBy: string;
}) {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'simpanan', 'create');
    await requirePermission(db, input.createdBy, 'anggota', 'edit');

    const anggota = await db.getFirstAsync<{ nama_lengkap: string; status: string }>(
      `SELECT nama_lengkap, status FROM anggota WHERE id = ?`,
      input.anggotaId
    );
    if (!anggota) throw new Error('Anggota tidak ditemukan.');
    if (anggota.status === 'KELUAR') throw new Error('Anggota ini sudah berstatus Keluar.');

    const [pokok, wajib, sukarela] = await Promise.all([
      getSaldoSimpanan(db, input.anggotaId, 'POKOK'),
      getSaldoSimpanan(db, input.anggotaId, 'WAJIB'),
      getSaldoSimpanan(db, input.anggotaId, 'SUKARELA'),
    ]);
    const totalSimpanan = pokok + wajib + sukarela;
    if (totalSimpanan <= 0) {
      throw new Error('Anggota ini tidak memiliki saldo simpanan untuk dikembalikan.');
    }

    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);
    // Phase 4: sama seperti tarikSimpananSukarela — pastikan kas/bank
    // koperasi benar-benar punya cukup uang untuk mengembalikan seluruh
    // simpanan anggota yang keluar.
    const cekSaldo = await checkSaldoAkunCukup(db, {
      accountId: kasBankAccountId,
      namaRekening: input.sumberDana === 'BANK' ? 'rekening bank yang dipilih' : 'Kas',
      nominalKeluar: totalSimpanan,
    });
    if (!cekSaldo.valid) throw new Error(cekSaldo.reason);

    const year = new Date(input.tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'KLA', year);

    const lines: { accountId: string; debit: number; kredit: number }[] = [];
    if (pokok > 0) lines.push({ accountId: await resolveAccountId(db, 'SIMPANAN_POKOK', 'KREDIT_DEFAULT'), debit: pokok, kredit: 0 });
    if (wajib > 0) lines.push({ accountId: await resolveAccountId(db, 'SIMPANAN_WAJIB', 'KREDIT_DEFAULT'), debit: wajib, kredit: 0 });
    if (sukarela > 0) lines.push({ accountId: await resolveAccountId(db, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT'), debit: sukarela, kredit: 0 });
    lines.push({ accountId: kasBankAccountId, debit: 0, kredit: totalSimpanan });

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'KELUAR_ANGGOTA',
      nomorReferensi: nomorTransaksi,
      deskripsi: `Pengembalian simpanan - anggota keluar: ${anggota.nama_lengkap} - ${nomorTransaksi}`,
      createdBy: input.createdBy,
      lines,
    });

    const now = new Date().toISOString();
    // Catat sebagai TARIK di ketiga jenis simpanan (jejak audit tetap
    // lengkap & konsisten dengan cara simpanan lain dicatat), lalu
    // update status anggota — semua dalam satu transaksi database.
    const insertTarik = async (jenis: JenisSimpanan, nominal: number) => {
      if (nominal <= 0) return;
      const id = newId();
      await db.runAsync(
        `INSERT INTO simpanan_transaksi
          (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, bank_account_id,
           nomor_transaksi, keterangan, journal_id, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.anggotaId,
        jenis,
        'TARIK' satisfies TipeTransaksi,
        input.tanggal,
        nominal,
        input.sumberDana,
        input.bankAccountId ?? null,
        `${nomorTransaksi}-${jenis}`,
        input.keterangan ?? 'Keluar anggota',
        journalId,
        input.createdBy,
        now
      );
    };
    await insertTarik('POKOK', pokok);
    await insertTarik('WAJIB', wajib);
    await insertTarik('SUKARELA', sukarela);

    await db.runAsync(`UPDATE anggota SET status = 'KELUAR', updated_at = ? WHERE id = ?`, now, input.anggotaId);

    return { nomorTransaksi, journalId, totalSimpanan, pokok, wajib, sukarela };
  });
}

// ============================================================
// Revisi KOPKU (Bagian 5-13) — DATA AWAL SIMPANAN ANGGOTA:
// satu form, satu input, Pokok + Wajib + Sukarela sekaligus,
// satu jurnal, atomic (semua atau tidak sama sekali).
// ============================================================

export interface CekStatusSimpananPokokResult {
  sudahAda: boolean;
  nominal: Rupiah;
}

/**
 * Revisi KOPKU (Bagian 12): dipakai layar "Data Awal Simpanan" untuk
 * menampilkan status Pokok anggota SEBELUM submit (read-only,
 * tanpa transaksi) — kalau `sudahAda`, field Pokok ditampilkan
 * sebagai saldo existing (read-only/disabled), bukan input kosong.
 * Saldo Pokok tidak bisa berkurang lewat penarikan (hanya Sukarela
 * yang bisa ditarik — PRD §10), jadi `saldo > 0` valid dipakai
 * sebagai proksi "sudah pernah dicatat" — tetap dihitung lewat
 * `getSaldoSimpanan` (exclusion-aware) supaya konsisten dengan
 * `pastikanBelumAdaSimpananPokok`.
 */
export async function cekStatusSimpananPokok(anggotaId: string): Promise<CekStatusSimpananPokokResult> {
  const db = await getDb();
  const nominal = await getSaldoSimpanan(db, anggotaId, 'POKOK');
  return { sudahAda: nominal > 0, nominal };
}

export interface DataAwalSimpananInput {
  anggotaId: string;
  tanggal: string;
  /** Simpanan Pokok — 0 kalau tidak diisi (sudah ada sebelumnya, atau anggota ini belum mau isi Pokok). WAJIB > 0 hanya kalau anggota belum pernah punya Pokok sama sekali & user memang mengisinya. */
  pokok: Rupiah;
  wajib: Rupiah;
  sukarela: Rupiah;
  sumberDana: 'KAS' | 'BANK';
  bankAccountId?: string;
  keterangan?: string;
  createdBy: string;
}

export interface DataAwalSimpananResult {
  journalId: string;
  nomorTransaksi: string;
  pokok: Rupiah;
  wajib: Rupiah;
  sukarela: Rupiah;
  idPokok: string | null;
  idWajib: string | null;
  idSukarela: string | null;
}

/**
 * Revisi KOPKU (Bagian 5.1/5.5/5.6/6/7): "DATA AWAL SIMPANAN ANGGOTA"
 * — SATU form, SATU submit, mengisi Simpanan Pokok + Wajib + Sukarela
 * sekaligus (Sukarela boleh 0/kosong — Bagian 5.4: "jangan memaksa
 * setiap anggota memiliki Simpanan Sukarela").
 *
 * ATOMICITY (Bagian 5.5/5.6): SATU journal untuk seluruh baris yang
 * diisi (Debit Kas/Bank sebesar total, Kredit tiap jenis simpanan
 * yang > 0) — BUKAN tiga jurnal terpisah (Bagian 6: "satu input, satu
 * transaksi akuntansi"). Dibungkus `withTransaction` yang sama
 * (pola SAMA PERSIS dengan `keluarAnggota` di atas, BUKAN memanggil
 * `setorSimpanan()` tiga kali — memanggil fungsi lain yang juga
 * membuka `withTransaction` sendiri-sendiri akan membuat 3 jurnal
 * terpisah DAN transaksi bersarang yang tidak didukung bersih oleh
 * expo-sqlite) — kalau salah satu baris gagal (mis. mapping akun
 * hilang), SELURUHNYA rollback otomatis, tidak ada kondisi Pokok
 * tersimpan tapi Wajib gagal.
 *
 * Simpanan Pokok tetap tunduk pada aturan satu-kali (Bagian 4/5.2) —
 * lihat `pastikanBelumAdaSimpananPokok`.
 *
 * Menu Simpanan (Pokok/Wajib/Sukarela) existing TIDAK perlu diubah
 * sama sekali (Bagian 7/8) — semuanya membaca `getSaldoSimpanan`/
 * `listSimpananHistori` yang sama, yang otomatis membaca baris
 * `simpanan_transaksi` yang dibuat fungsi ini (Bagian 8: akun COA
 * yang dipakai PERSIS `SIMPANAN_POKOK`/`SIMPANAN_WAJIB`/
 * `SIMPANAN_SUKARELA` yang sudah ada, tidak ada akun baru).
 */
export async function catatDataAwalSimpanan(input: DataAwalSimpananInput): Promise<DataAwalSimpananResult> {
  return withTransaction(async (db) => catatDataAwalSimpananDb(db, input));
}

/**
 * RC-S133.6.2 — isi fungsi di atas TANPA membuka transaksi sendiri (ekstraksi murni,
 * logika tidak diubah), supaya koreksi transaksi dari History dapat membalik
 * transaksi asal lalu mencatat ulang dalam SATU transaksi database.
 * Pemanggil WAJIB sudah berada di dalam withTransaction.
 */
export async function catatDataAwalSimpananDb(db: SQLite.SQLiteDatabase, input: DataAwalSimpananInput) : Promise<DataAwalSimpananResult> {
    await requirePermission(db, input.createdBy, 'simpanan', 'create');
    await pastikanAnggotaAktif(db, input.anggotaId);

    if (input.pokok < 0 || input.wajib < 0 || input.sukarela < 0) {
      throw new Error('Nominal Simpanan Pokok/Wajib/Sukarela tidak boleh negatif.');
    }
    const total = input.pokok + input.wajib + input.sukarela;
    if (total <= 0) {
      throw new Error('Isi minimal salah satu dari Simpanan Pokok, Wajib, atau Sukarela.');
    }
    if (input.pokok > 0) {
      await pastikanBelumAdaSimpananPokok(db, input.anggotaId);
    }

    const kasBankAccountId = await resolveKasBankAccountId(db, input.sumberDana, input.bankAccountId);

    const year = new Date(input.tanggal).getFullYear();
    const nomorTransaksi = await nextSequence(db, 'SP-AWAL', year);

    const lines: { accountId: string; debit: number; kredit: number }[] = [
      { accountId: kasBankAccountId, debit: total, kredit: 0 },
    ];
    if (input.pokok > 0) {
      lines.push({ accountId: await resolveAccountId(db, 'SIMPANAN_POKOK', 'KREDIT_DEFAULT'), debit: 0, kredit: input.pokok });
    }
    if (input.wajib > 0) {
      lines.push({ accountId: await resolveAccountId(db, 'SIMPANAN_WAJIB', 'KREDIT_DEFAULT'), debit: 0, kredit: input.wajib });
    }
    if (input.sukarela > 0) {
      lines.push({ accountId: await resolveAccountId(db, 'SIMPANAN_SUKARELA', 'KREDIT_DEFAULT'), debit: 0, kredit: input.sukarela });
    }

    // Perbaikan History Transaksi: layar ini SEKARANG bagian dari
    // "Setor Simpanan" (bukan menu terpisah "Data Awal Simpanan
    // Anggota" lagi), jadi deskripsi jurnal & keterangan baris
    // simpanan_transaksi TIDAK boleh lagi berbunyi "Data awal simpanan
    // anggota" — deskripsi keterangan user (kalau diisi) dipakai apa
    // adanya, kalau kosong pakai default "Setor Simpanan". HANYA
    // string ini yang berubah — jurnal/journal lines/debit/kredit/
    // ledger/saldo/COA/perhitungan SHU/laporan/service TIDAK disentuh.
    // `sumberTransaksi`/`transaction_type` ('SIMPANAN_DATA_AWAL') juga
    // SENGAJA TIDAK diganti (bukan sekadar tampilan — dipakai untuk
    // filter/pengelompokan jenis transaksi), history lama yang sudah
    // terlanjur tersimpan dengan deskripsi lama juga TIDAK disentuh.
    const deskripsiTransaksi = input.keterangan?.trim() ? input.keterangan.trim() : 'Setor Simpanan';

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'SIMPANAN_DATA_AWAL',
      nomorReferensi: nomorTransaksi,
      deskripsi: deskripsiTransaksi,
      createdBy: input.createdBy,
      lines,
    });

    const now = new Date().toISOString();
    const insertBaris = async (jenis: JenisSimpanan, nominal: Rupiah): Promise<string | null> => {
      if (nominal <= 0) return null;
      const id = newId();
      await db.runAsync(
        `INSERT INTO simpanan_transaksi
          (id, anggota_id, jenis, tipe, tanggal, periode, nominal, sumber_dana, bank_account_id,
           nomor_transaksi, keterangan, journal_id, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.anggotaId,
        jenis,
        'SETOR' satisfies TipeTransaksi,
        input.tanggal,
        null,
        nominal,
        input.sumberDana,
        input.bankAccountId ?? null,
        `${nomorTransaksi}-${jenis}`,
        deskripsiTransaksi,
        journalId,
        input.createdBy,
        now
      );
      return id;
    };

    const idPokok = await insertBaris('POKOK', input.pokok);
    const idWajib = await insertBaris('WAJIB', input.wajib);
    const idSukarela = await insertBaris('SUKARELA', input.sukarela);

    return {
      journalId,
      nomorTransaksi,
      pokok: input.pokok,
      wajib: input.wajib,
      sukarela: input.sukarela,
      idPokok,
      idWajib,
      idSukarela,
    };
}

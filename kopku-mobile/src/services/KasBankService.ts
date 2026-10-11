import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { createJournal, reverseJournal, getAccountBalance } from '@/accounting/AccountingEngine';
import { resolveAccountId, resolveKasBankAccountId } from '@/accounting/AccountMapping';
import { checkSaldoAkunCukup } from '@/services/LiquidityService';
import { requirePermission } from '@/services/PermissionService';
import { newId, nextSequence } from '@/utils/id';
import { Rupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * Service Kas & Bank (PRD §16-17, fase 7). Mengikuti pola arsitektur
 * yang sama persis dengan SimpananService.ts/PinjamanService.ts:
 *  - Semua transaksi keuangan lewat AccountingEngine.createJournal()
 *    (fase ini §18: "integrasi otomatis dengan accounting engine",
 *    §19: "double-entry accounting").
 *  - Saldo TIDAK PERNAH disimpan manual — selalu dihitung dari jurnal
 *    lewat AccountingEngine.getAccountBalance() (§20: "saldo harus
 *    konsisten dengan jurnal" — dengan pola ini konsisten by construction,
 *    bukan dua sumber data yang bisa berbeda).
 *  - Koreksi transaksi POSTED lewat reversal (bukan hapus langsung),
 *    sama seperti koreksiSimpanan() — "jangan menghapus transaksi yang
 *    sudah masuk laporan tanpa mekanisme yang aman".
 *
 * TIDAK ADA perubahan pada AccountingEngine.ts inti — hanya menambah
 * pemetaan baru (additive) dan memakai fungsi yang sudah ada.
 */

export type JenisRekening = 'KAS' | 'KAS_KECIL' | 'BANK';
type TipeTransaksiKasBank = 'PENERIMAAN' | 'PENGELUARAN' | 'TRANSFER' | 'KOREKSI';

/** Kategori transaksi bebas (bukan enum kaku di DB — konsisten dengan filosofi COA configurable). */
export const KATEGORI_TRANSAKSI_DEFAULT = [
  'Operasional',
  'Sewa',
  'Gaji',
  'Listrik & Air',
  'Pendapatan Lain',
  'Saldo Awal',
  'Lainnya',
];

/**
 * Sub-fitur Penerimaan & Pengeluaran (menu Transaksi — TransaksiScreen
 * hanya punya 2 menu awal: Penerimaan & Pengeluaran, lihat
 * TransaksiPenerimaanScreen/TransaksiPengeluaranScreen). Dipakai sebagai
 * pilihan Kategori di KasBankTransaksiFormScreen untuk transaksi yang
 * TIDAK punya form khusus sendiri (Simpanan, Pemberian Pinjaman, dan
 * Pemindahan Saldo Rekening tetap pakai form/fitur yang sudah ada,
 * Penghapusan Piutang pakai PenghapusanPiutangFormScreen karena non-kas
 * — lihat PinjamanService.hapusPiutangPinjaman).
 */
export const KATEGORI_PENERIMAAN = [
  'Utang',
  'Modal',
  'Penghasilan Lain',
  'Pendapatan Diterima Dimuka',
  ...KATEGORI_TRANSAKSI_DEFAULT,
];

export const KATEGORI_PENGELUARAN = [
  'Kewajiban',
  'Pembelian Aset',
  'Beban',
  'Keluar Anggota',
  ...KATEGORI_TRANSAKSI_DEFAULT,
];

async function pastikanAccountId(
  db: SQLite.SQLiteDatabase,
  jenis: JenisRekening,
  bankAccountId?: string
): Promise<string> {
  if (jenis === 'BANK') return resolveKasBankAccountId(db, 'BANK', bankAccountId);
  return resolveKasBankAccountId(db, jenis);
}

async function writeAuditLog(db: SQLite.SQLiteDatabase, userId: string, action: string, entityId: string) {
  const now = new Date();
  await db.runAsync(
    `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    newId(),
    userId,
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    action,
    'kas_bank_transaksi',
    entityId,
    now.toISOString()
  );
}

// ============================================================
// REKENING — daftar, tambah, edit, saldo (PRD fase 7 §1-6)
// ============================================================

export interface RekeningItem {
  jenis: JenisRekening;
  /** 'KAS'/'KAS_KECIL' untuk kas, atau bank_account.id untuk bank. */
  id: string;
  nama: string;
  accountId: string;
  saldo: Rupiah;
  aktif: boolean;
  nomorRekening?: string;
  namaPemilik?: string;
  /** Target §10 (permintaan pengguna): Tabungan/Giro/Deposito — hanya untuk rekening BANK, null kalau belum diisi (rekening lama). */
  jenisSimpanan?: string | null;
}

/** Daftar seluruh rekening kas & bank beserta saldo (dari jurnal, bukan field terpisah). */
export async function listRekening(): Promise<RekeningItem[]> {
  const db = await getDb();

  const hasil: RekeningItem[] = [];

  // Kas Umum (KAS_UMUM) & Kas Kecil (KAS_KECIL). Kas Kecil dinonaktifkan
  // Phase 18 §4 — akunnya (1-1001) di-set is_active=0 dan mapping-nya
  // dihapus lewat migration v18, jadi TIDAK dipetakan lagi lewat
  // resolveKasBankAccountId (yang akan menolak akun nonaktif/mapping
  // hilang). Query mapping langsung di sini supaya instalasi lama yang
  // masih punya histori jurnal di Kas Kecil tetap bisa menampilkan
  // saldonya (ditandai aktif:false, disaring dari picker transaksi baru
  // oleh RekeningPicker) — bukan melempar error yang merusak seluruh
  // daftar rekening. Instalasi baru (tidak pernah ada mapping KAS_KECIL
  // sama sekali) otomatis melewati baris ini (row null -> skip).
  const kasJenisMap: Record<'KAS' | 'KAS_KECIL', string> = { KAS: 'KAS_UMUM', KAS_KECIL: 'KAS_KECIL' };
  for (const jenis of ['KAS', 'KAS_KECIL'] as const) {
    const row = await db.getFirstAsync<{ account_id: string; is_active: number }>(
      `SELECT am.account_id, a.is_active
       FROM account_mapping am JOIN account a ON a.id = am.account_id
       WHERE am.transaction_type = ? AND am.role = 'DEFAULT'`,
      kasJenisMap[jenis]
    );
    if (!row) continue; // Kas Kecil belum/tidak lagi dikonfigurasi (instalasi baru Phase 18).
    const saldo = await getAccountBalance(db, row.account_id);
    hasil.push({
      jenis,
      id: jenis,
      nama: jenis === 'KAS' ? 'Kas Tunai' : 'Kas Kecil',
      accountId: row.account_id,
      saldo,
      aktif: !!row.is_active,
    });
  }

  const bankRows = await db.getAllAsync<any>(
    `SELECT id, nama_bank, nomor_rekening, nama_pemilik, account_id, aktif, jenis_simpanan FROM bank_account ORDER BY nama_bank ASC`
  );
  for (const row of bankRows) {
    const saldo = await getAccountBalance(db, row.account_id);
    hasil.push({
      jenis: 'BANK',
      id: row.id,
      nama: `${row.nama_bank} — ${row.nomor_rekening}`,
      accountId: row.account_id,
      saldo,
      aktif: !!row.aktif,
      nomorRekening: row.nomor_rekening,
      namaPemilik: row.nama_pemilik,
      jenisSimpanan: row.jenis_simpanan ?? null,
    });
  }

  return hasil;
}

export async function getRekening(jenis: JenisRekening, bankAccountId?: string): Promise<RekeningItem | null> {
  const semua = await listRekening();
  if (jenis === 'BANK') return semua.find((r) => r.jenis === 'BANK' && r.id === bankAccountId) ?? null;
  return semua.find((r) => r.jenis === jenis) ?? null;
}

/** Saldo satu rekening — selalu dari getAccountBalance() (fase 7 §20). */
export async function getSaldoRekening(jenis: JenisRekening, bankAccountId?: string): Promise<Rupiah> {
  const db = await getDb();
  const accountId = await pastikanAccountId(db, jenis, bankAccountId);
  return getAccountBalance(db, accountId);
}

/** Hasilkan kode akun baru untuk rekening bank baru (tidak bentrok dengan yang sudah ada). */
async function generateKodeAkunBank(db: SQLite.SQLiteDatabase): Promise<string> {
  const row = await db.getFirstAsync<{ kode: string }>(
    `SELECT kode FROM account WHERE kode LIKE '1-11%' ORDER BY kode DESC LIMIT 1`
  );
  let nextSuffix = 1;
  if (row?.kode) {
    const suffix = parseInt(row.kode.split('-')[1].slice(2), 10); // "1-1105" -> "05" -> 5
    if (!isNaN(suffix)) nextSuffix = suffix + 1;
  }
  return `1-11${nextSuffix.toString().padStart(2, '0')}`;
}

export interface TambahRekeningBankInput {
  namaBank: string;
  nomorRekening: string;
  /**
   * Phase 17 §N: field ini dihapus dari UI form (`RekeningFormScreen`).
   * Opsional di sini supaya caller lama/API lain yang masih mengirim
   * nilai tetap jalan; kolom DB `nama_pemilik` dipertahankan (masih
   * dipakai data lama) tapi TIDAK wajib diisi lagi.
   */
  namaPemilik?: string;
  /**
   * Audit ulang (permintaan pengguna §21/§22): field ini SEKARANG
   * OPSIONAL dan TIDAK LAGI memicu pembuatan jurnal saldo awal sama
   * sekali — dulu (fase 7 §4) mengisi field ini otomatis memposting
   * jurnal DEBIT rekening/KREDIT Ekuitas Lainnya. Menurut instruksi
   * baru, "Data Bank" hanya boleh berisi Nama Bank + Nomor Rekening;
   * saldo awal rekening bank sekarang WAJIB dimasukkan lewat modul
   * "Saldo Akun (COA)" (SaldoAwalAkunService — akun ASET rekening
   * bank yang baru dibuat di sini otomatis muncul di daftar akun
   * neraca yang bisa diisi saldo awalnya di sana). Parameter ini
   * dipertahankan (bukan dihapus) HANYA untuk kompatibilitas mundur
   * caller lama; nilainya disimpan ke kolom `bank_account.saldo_awal`
   * untuk keperluan riwayat/audit, TAPI TIDAK PERNAH dipakai untuk
   * membuat jurnal maupun memengaruhi saldo yang ditampilkan (saldo
   * SELALU dari ledger — `getAccountBalance`, lihat `listRekening`).
   */
  saldoAwal?: Rupiah;
  createdBy: string;
  /** Target §10 (permintaan pengguna): "Jenis Simpanan" — Tabungan/Giro/Deposito, opsional. */
  jenisSimpanan?: string;
}

/**
 * Tambah rekening bank baru (fase 7 §4). Setiap rekening bank punya
 * akun ledger SENDIRI (bukan berbagi satu akun "Bank" generik) supaya
 * saldo per-rekening bisa dihitung terpisah & akurat (§6, §20).
 *
 * Audit ulang (permintaan pengguna §21/§22): SEBELUMNYA jika
 * `saldoAwal > 0` di sini, langsung diposting jurnal saldo awal
 * (DEBIT rekening, KREDIT Ekuitas Lainnya) secara otomatis. Perilaku
 * itu DIHAPUS — pembuatan rekening bank SEKARANG murni hanya membuat
 * data bank (baris `bank_account`) + akun ledger terkait (`account`),
 * TIDAK PERNAH membuat jurnal apa pun. Saldo awal rekening (baru
 * maupun lama) diisi lewat modul "Saldo Akun (COA)" terpisah
 * (SaldoAwalAkunService) yang berlaku untuk SEMUA akun neraca, bukan
 * cuma rekening bank. Untuk histori: rekening yang DULU dibuat lewat
 * jalur lama (jurnal saldo awal otomatis) TIDAK terpengaruh sama
 * sekali — jurnal lamanya tetap ada apa adanya, tidak dibalik/dihapus.
 */
export async function tambahRekeningBank(input: TambahRekeningBankInput): Promise<{ id: string; accountId: string }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    const saldoAwal = input.saldoAwal ?? 0;
    if (saldoAwal < 0) throw new Error('Saldo awal tidak boleh negatif.');

    const kode = await generateKodeAkunBank(db);
    const accountId = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES (?,?,?,?,?,1,0,?,?)`,
      accountId,
      kode,
      `Bank ${input.namaBank}`,
      'ASET',
      'DEBIT',
      now,
      now
    );

    const bankAccountId = newId();
    await db.runAsync(
      `INSERT INTO bank_account (id, nama_bank, nomor_rekening, nama_pemilik, saldo_awal, account_id, aktif, jenis_simpanan, created_at)
       VALUES (?,?,?,?,?,?,1,?,?)`,
      bankAccountId,
      input.namaBank,
      input.nomorRekening,
      input.namaPemilik ?? '',
      saldoAwal,
      accountId,
      input.jenisSimpanan ?? null,
      now
    );

    // Audit ulang §21/§22: TIDAK LAGI membuat jurnal saldo awal di
    // sini. Isi saldo awal (kalau ada) lewat modul Saldo Akun (COA).

    return { id: bankAccountId, accountId };
  });
}

export interface CatatSaldoAwalKasInput {
  jenisKas: 'KAS_UMUM' | 'KAS_KECIL';
  saldoAwal: Rupiah;
  tanggal: string;
  createdBy: string;
}

/**
 * Catat saldo awal untuk Kas Umum/Kas Kecil (sub-fitur "Saldo Awal",
 * hub Input Data) — dua akun ini TIDAK lewat `tambahRekeningBank`
 * (yang sudah punya field saldoAwal sendiri untuk rekening BANK),
 * jadi sebelumnya tidak ada jalan resmi memberi saldo awal ke
 * Kas/Kas Kecil selain lewat "Penghasilan Lain" (yang salah kategori
 * — itu pendapatan usaha, bukan modal awal) atau jurnal manual.
 * Pola jurnal SAMA PERSIS dengan saldo awal rekening bank (DEBIT
 * Kas/Kas Kecil, KREDIT Ekuitas Lainnya). Ditolak kalau sudah pernah
 * dicatat sebelumnya (satu kali per akun, koreksi lanjutan harus lewat
 * transaksi kas/bank biasa atau koreksi, bukan "saldo awal" lagi).
 */
export async function catatSaldoAwalKas(input: CatatSaldoAwalKasInput): Promise<{ journalId: string }> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    if (!Number.isFinite(input.saldoAwal) || input.saldoAwal <= 0) {
      throw new Error('Saldo awal harus lebih dari 0.');
    }

    const accountId = await resolveAccountId(db, input.jenisKas, 'DEFAULT');
    const sudahAda = await db.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM journal WHERE sumber_transaksi = 'SALDO_AWAL_REKENING' AND sumber_id = ? AND status IN ('POSTED','REVERSED')`,
      accountId
    );
    if ((sudahAda?.cnt ?? 0) > 0) {
      throw new Error('Saldo awal untuk akun ini sudah pernah dicatat sebelumnya. Gunakan transaksi Kas & Bank biasa untuk penyesuaian lanjutan.');
    }

    const modalLainnyaId = await resolveAccountId(db, 'SHU_DISTRIBUSI', 'KREDIT_DANA_LAINNYA');
    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'SALDO_AWAL_REKENING',
      sumberId: accountId,
      deskripsi: `Saldo awal ${input.jenisKas === 'KAS_UMUM' ? 'Kas' : 'Kas Kecil'}`,
      createdBy: input.createdBy,
      lines: [
        { accountId, debit: input.saldoAwal, kredit: 0 },
        { accountId: modalLainnyaId, debit: 0, kredit: input.saldoAwal },
      ],
    });

    return { journalId };
  });
}

export interface EditRekeningBankInput {
  namaBank: string;
  nomorRekening: string;
  aktif: boolean;
  /** Target §10 (permintaan pengguna): opsional — undefined berarti tidak diubah (dipertahankan apa adanya). */
  jenisSimpanan?: string | null;
}

/**
 * Edit rekening bank (fase 7 §5). Sengaja TIDAK mengizinkan ubah
 * saldoAwal/account_id — itu sudah terkunci oleh jurnal saldo awal
 * yang sudah diposting, mengubahnya akan membuat saldo tidak
 * konsisten dengan jurnal (§20).
 *
 * Phase 17 §N: `nama_pemilik` SENGAJA TIDAK ada di klausa SET lagi —
 * field itu dihapus dari form UI, dan nilai lama (jika ada, dari data
 * sebelum perubahan ini) dibiarkan apa adanya di database, tidak
 * ditimpa kosong oleh edit yang tidak mengirim field tsb.
 *
 * Target §10: `jenisSimpanan` OPSIONAL — kalau `undefined` (caller
 * tidak mengirim), kolom `jenis_simpanan` TIDAK disentuh, supaya
 * rekening lama yang belum diisi tetap null apa adanya sampai memang
 * diedit eksplisit.
 */
export async function editRekeningBank(actingUserId: string, id: string, input: EditRekeningBankInput): Promise<void> {
  const db = await getDb();
  await requirePermission(db, actingUserId, 'kas_bank', 'edit');
  const existing = await db.getFirstAsync<{ id: string }>(`SELECT id FROM bank_account WHERE id = ?`, id);
  if (!existing) throw new Error('Rekening bank tidak ditemukan.');
  if (input.jenisSimpanan !== undefined) {
    await db.runAsync(
      `UPDATE bank_account SET nama_bank = ?, nomor_rekening = ?, aktif = ?, jenis_simpanan = ? WHERE id = ?`,
      input.namaBank,
      input.nomorRekening,
      input.aktif ? 1 : 0,
      input.jenisSimpanan,
      id
    );
  } else {
    await db.runAsync(
      `UPDATE bank_account SET nama_bank = ?, nomor_rekening = ?, aktif = ? WHERE id = ?`,
      input.namaBank,
      input.nomorRekening,
      input.aktif ? 1 : 0,
      id
    );
  }
}

export interface JenisSimpananItem {
  kode: string;
  nama: string;
  aktif: boolean;
}

/** Daftar jenis simpanan bank (Tabungan/Giro/Deposito) — target §10, dipakai picker Data Bank. */
export async function listJenisSimpanan(opts: { hanyaAktif?: boolean } = {}): Promise<JenisSimpananItem[]> {
  const db = await getDb();
  // Permintaan pengguna §7: urutan tampilan diubah menjadi
  // Deposito, Tabungan, Giro (bukan lagi alfabetis) — dipakai
  // konsisten di seluruh tempat yang menampilkan daftar jenis
  // simpanan (form tambah/edit bank, dropdown/picker, filter,
  // detail), karena semuanya memanggil fungsi ini sebagai satu
  // sumber data. Urutan tampilan SAJA yang berubah lewat CASE di
  // bawah — kode/nilai yang sudah tersimpan di `bank_account` /
  // `bank_jenis_simpanan` TIDAK diubah.
  const urutanTampilan = `CASE kode WHEN 'DEPOSITO' THEN 1 WHEN 'TABUNGAN' THEN 2 WHEN 'GIRO' THEN 3 ELSE 4 END ASC, nama ASC`;
  const rows = await db.getAllAsync<{ kode: string; nama: string; aktif: number }>(
    opts.hanyaAktif
      ? `SELECT kode, nama, aktif FROM bank_jenis_simpanan WHERE aktif = 1 ORDER BY ${urutanTampilan}`
      : `SELECT kode, nama, aktif FROM bank_jenis_simpanan ORDER BY ${urutanTampilan}`
  );
  return rows.map((r) => ({ kode: r.kode, nama: r.nama, aktif: !!r.aktif }));
}

/** ON/OFF-kan satu jenis simpanan (target §10) — TIDAK menghapus data, rekening yang sudah memakainya tetap menyimpan nilainya apa adanya, hanya disembunyikan dari picker saat OFF. */
export async function setJenisSimpananAktif(actingUserId: string, kode: string, aktif: boolean): Promise<void> {
  const db = await getDb();
  await requirePermission(db, actingUserId, 'kas_bank', 'edit');
  await db.runAsync(`UPDATE bank_jenis_simpanan SET aktif = ?, updated_at = ? WHERE kode = ?`, aktif ? 1 : 0, new Date().toISOString(), kode);
}

// ============================================================
// TRANSAKSI — pemasukan, pengeluaran, transfer (PRD fase 7 §7-14)
// ============================================================

export interface CatatTransaksiInput {
  jenis: JenisRekening;
  bankAccountId?: string;
  tanggal: string;
  nominal: Rupiah;
  akunLawanId: string;
  kategori?: string;
  keterangan?: string;
  createdBy: string;
  /**
   * BUG-07 — KUNCI IDEMPOTENSI (opsional).
   *
   * Kolom `idempotency_key` beserta UNIQUE INDEX parsialnya SUDAH ADA
   * di skema (`idx_kas_idempotency` / `idx_bank_idempotency`) sejak
   * lama, tetapi tidak pernah dipakai satu pun service — infrastruktur
   * mati yang membuat double-submit tetap menghasilkan DUA jurnal.
   *
   * Kalau diisi, pemanggil kedua dengan kunci yang sama TIDAK membuat
   * jurnal baru; ia mengembalikan efek akuntansi yang sudah ada.
   *
   * WHY berbasis kunci, bukan kombinasi nominal+tanggal+akun: dua
   * setoran Rp50.000 dari anggota berbeda pada hari yang sama adalah
   * dua transaksi SAH. Menganggapnya duplikat akan memblokir pencatatan
   * yang benar — kerusakan yang lebih halus dan lebih sulit disadari
   * daripada jurnal ganda.
   *
   * UI mengisinya dengan identitas SUBMIT (mis. UUID yang dibuat saat
   * form dibuka), bukan identitas isi form.
   */
  idempotencyKey?: string;
  /**
   * OPSIONAL, hanya untuk `catatPemasukan`. Tanpa kedua field ini, sumber
   * transaksi = KAS_/BANK_PENERIMAAN_LAIN.
   *
   * `jalurKhusus: 'RAK_PENGEMBALIAN'` memilih sumber transaksi
   * RAK_PENGEMBALIAN_KAS / RAK_PENGEMBALIAN_BANK (bukan
   * KAS_/BANK_PENERIMAAN_LAIN) supaya pengembalian pokok RAK
   * diklasifikasikan arus kas INVESTASI — pasangan dari penyaluran RAK —
   * bukan OPERASI. Nilai dibatasi union literal: pemanggil tidak dapat
   * menyuntikkan sumber transaksi sembarang.
   *
   * `sumberId` diteruskan ke `journal.sumber_id` (kolom existing, dipakai
   * pola yang sama oleh Bagian SHU / Impairment / Akrual Jasa).
   */
  jalurKhusus?: 'RAK_PENGEMBALIAN';
  sumberId?: string;
  /**
   * v77 (Poin 5) — referensi master unit usaha (`koperasi_unit_usaha.id`),
   * OPSIONAL, hanya untuk `catatPemasukan`. Dipakai Pendapatan Unit Usaha
   * supaya laporan & histori tahu asal unitnya. Tidak memengaruhi jurnal.
   */
  unitUsahaId?: string;
}

function validasiNominal(nominal: number) {
  if (!Number.isFinite(nominal) || nominal <= 0) {
    throw new Error('Nominal harus lebih besar dari 0.');
  }
}

async function insertBarisTransaksi(
  db: SQLite.SQLiteDatabase,
  jenis: JenisRekening,
  params: {
    bankAccountId?: string;
    tipe: TipeTransaksiKasBank;
    tanggal: string;
    nominal: Rupiah;
    akunLawanId?: string;
    kategori?: string;
    keterangan?: string;
    nomorTransaksi: string;
    journalId: string;
    createdBy: string;
    reversalOfId?: string;
    idempotencyKey?: string;
    /**
     * S19/P2 — arah transfer, WAJIB diisi untuk `tipe: 'TRANSFER'`.
     * `tipe` sendiri tidak bisa membedakan kaki keluar dan kaki masuk
     * (keduanya 'TRANSFER' dengan nominal positif), sehingga tanpa
     * kolom ini rekonsiliasi Kas/Bank menghitung transfer sebagai nol
     * dan melaporkan selisih palsu. Diabaikan untuk tipe lain.
     */
    arahTransfer?: 'MASUK' | 'KELUAR';
    /** v77 (Poin 5) — referensi unit usaha; NULL bila tidak diisi. */
    unitUsahaId?: string;
  }
): Promise<string> {
  const id = newId();
  const now = new Date().toISOString();
  if (jenis === 'BANK') {
    if (!params.bankAccountId) throw new Error('bankAccountId wajib diisi untuk transaksi bank.');
    await db.runAsync(
      `INSERT INTO bank_transaksi
        (id, bank_account_id, tipe, tanggal, nominal, akun_lawan_id, kategori, keterangan,
         nomor_transaksi, journal_id, reversal_of_id, created_by, created_at, idempotency_key, arah_transfer, unit_usaha_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      params.bankAccountId,
      params.tipe,
      params.tanggal,
      params.nominal,
      params.akunLawanId ?? null,
      params.kategori ?? null,
      params.keterangan ?? null,
      params.nomorTransaksi,
      params.journalId,
      params.reversalOfId ?? null,
      params.createdBy,
      now,
      params.idempotencyKey ?? null,
      params.tipe === 'TRANSFER' ? params.arahTransfer ?? null : null,
      params.unitUsahaId ?? null
    );
  } else {
    await db.runAsync(
      `INSERT INTO kas_transaksi
        (id, jenis_kas, tipe, tanggal, nominal, akun_lawan_id, kategori, keterangan,
         nomor_transaksi, journal_id, reversal_of_id, created_by, created_at, idempotency_key, arah_transfer, unit_usaha_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      jenis,
      params.tipe,
      params.tanggal,
      params.nominal,
      params.akunLawanId ?? null,
      params.kategori ?? null,
      params.keterangan ?? null,
      params.nomorTransaksi,
      params.journalId,
      params.reversalOfId ?? null,
      params.createdBy,
      now,
      params.idempotencyKey ?? null,
      params.tipe === 'TRANSFER' ? params.arahTransfer ?? null : null,
      params.unitUsahaId ?? null
    );
  }
  return id;
}

/** Transaksi pemasukan (fase 7 §7): DEBIT rekening, KREDIT akun lawan. */
/**
 * BUG-07 — cari efek akuntansi yang SUDAH ADA untuk sebuah kunci
 * idempotensi. Dikembalikan apa adanya kalau ketemu, sehingga
 * pemanggilan kedua (double-click, retry setelah timeout) TIDAK
 * membuat jurnal & baris kas kedua.
 *
 * Dicari di kas_transaksi MAUPUN bank_transaksi: kunci yang sama tidak
 * boleh dipakai ulang lintas jenis rekening.
 */
async function cariEfekIdempoten(
  db: SQLite.SQLiteDatabase,
  idempotencyKey: string | undefined
): Promise<{ id: string; journalId: string } | null> {
  if (!idempotencyKey) return null;
  const kas = await db.getFirstAsync<{ id: string; journal_id: string }>(
    `SELECT id, journal_id FROM kas_transaksi WHERE idempotency_key = ?`,
    idempotencyKey
  );
  if (kas) return { id: kas.id, journalId: kas.journal_id };
  const bank = await db.getFirstAsync<{ id: string; journal_id: string }>(
    `SELECT id, journal_id FROM bank_transaksi WHERE idempotency_key = ?`,
    idempotencyKey
  );
  if (bank) return { id: bank.id, journalId: bank.journal_id };
  return null;
}

export async function catatPemasukan(input: CatatTransaksiInput): Promise<{ id: string; journalId: string }> {
  validasiNominal(input.nominal);
  return withTransaction(async (db) => catatPemasukanPadaDb(db, input));
}

/**
 * v72 — isi `catatPemasukan` yang dapat dipanggil DI DALAM transaksi
 * pemanggil (mis. penarikan investasi + bunga deposito dalam SATU
 * transaksi DB). Perilaku identik: permission, idempotensi, nomor urut,
 * jurnal, dan baris kas/bank sama persis.
 */
export async function catatPemasukanPadaDb(
  db: SQLite.SQLiteDatabase,
  input: CatatTransaksiInput
): Promise<{ id: string; journalId: string }> {
  validasiNominal(input.nominal);
  {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');

    // BUG-07: dicek SEBELUM nomor urut diambil dan jurnal dibuat.
    // Kalau kunci ini sudah pernah diproses, kembalikan efek yang sudah
    // ada — bukan membuat yang kedua.
    const sudahAda = await cariEfekIdempoten(db, input.idempotencyKey);
    if (sudahAda) return sudahAda;
    const accountId = await pastikanAccountId(db, input.jenis, input.bankAccountId);
    const sumberTransaksi =
      input.jalurKhusus === 'RAK_PENGEMBALIAN'
        ? input.jenis === 'BANK'
          ? 'RAK_PENGEMBALIAN_BANK'
          : 'RAK_PENGEMBALIAN_KAS'
        : input.jenis === 'BANK'
          ? 'BANK_PENERIMAAN_LAIN'
          : 'KAS_PENERIMAAN_LAIN';
    const nomorTransaksi = await nextSequence(db, `${sumberTransaksi}`, new Date(input.tanggal).getFullYear());

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi,
      sumberId: input.sumberId,
      nomorReferensi: nomorTransaksi,
      deskripsi: input.keterangan || `Penerimaan ${input.kategori ?? 'lain-lain'} - ${nomorTransaksi}`,
      createdBy: input.createdBy,
      lines: [
        { accountId, debit: input.nominal, kredit: 0 },
        { accountId: input.akunLawanId, debit: 0, kredit: input.nominal },
      ],
    });

    const id = await insertBarisTransaksi(db, input.jenis, {
      bankAccountId: input.bankAccountId,
      tipe: 'PENERIMAAN',
      tanggal: input.tanggal,
      nominal: input.nominal,
      akunLawanId: input.akunLawanId,
      kategori: input.kategori,
      keterangan: input.keterangan,
      nomorTransaksi,
      journalId,
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey,
      unitUsahaId: input.unitUsahaId,
    });

    return { id, journalId };
  }
}

/** Transaksi pengeluaran (fase 7 §8): DEBIT akun lawan, KREDIT rekening. */
export async function catatPengeluaran(input: CatatTransaksiInput): Promise<{ id: string; journalId: string }> {
  validasiNominal(input.nominal);

  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');

    // BUG-07: dicek SEBELUM nomor urut diambil dan jurnal dibuat.
    // Kalau kunci ini sudah pernah diproses, kembalikan efek yang sudah
    // ada — bukan membuat yang kedua.
    const sudahAda = await cariEfekIdempoten(db, input.idempotencyKey);
    if (sudahAda) return sudahAda;
    const accountId = await pastikanAccountId(db, input.jenis, input.bankAccountId);

    // Phase 4 (AUDIT_INTERNAL.md §3.3): sebelum ini tidak pernah cek
    // saldo — kas/bank bisa negatif tanpa penolakan lewat jalur
    // "Beban", "Kewajiban", dst manapun yang lewat catatPengeluaran.
    const cekSaldo = await checkSaldoAkunCukup(db, {
      accountId,
      namaRekening: input.jenis === 'BANK' ? 'rekening bank yang dipilih' : input.jenis === 'KAS_KECIL' ? 'Kas Kecil' : 'Kas',
      nominalKeluar: input.nominal,
    });
    if (!cekSaldo.valid) throw new Error(cekSaldo.reason);

    const sumberTransaksi = input.jenis === 'BANK' ? 'BANK_PENGELUARAN_LAIN' : 'KAS_PENGELUARAN_LAIN';
    const nomorTransaksi = await nextSequence(db, `${sumberTransaksi}`, new Date(input.tanggal).getFullYear());

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi,
      nomorReferensi: nomorTransaksi,
      deskripsi: input.keterangan || `Pengeluaran ${input.kategori ?? 'lain-lain'} - ${nomorTransaksi}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: input.akunLawanId, debit: input.nominal, kredit: 0 },
        { accountId, debit: 0, kredit: input.nominal },
      ],
    });

    const id = await insertBarisTransaksi(db, input.jenis, {
      bankAccountId: input.bankAccountId,
      tipe: 'PENGELUARAN',
      tanggal: input.tanggal,
      nominal: input.nominal,
      akunLawanId: input.akunLawanId,
      kategori: input.kategori,
      keterangan: input.keterangan,
      nomorTransaksi,
      journalId,
      createdBy: input.createdBy,
      idempotencyKey: input.idempotencyKey,
    });

    return { id, journalId };
  });
}

export interface TransferAntarRekeningInput {
  sumberJenis: JenisRekening;
  sumberBankAccountId?: string;
  tujuanJenis: JenisRekening;
  tujuanBankAccountId?: string;
  tanggal: string;
  nominal: Rupiah;
  keterangan?: string;
  createdBy: string;
}

/**
 * Transfer antar rekening (fase 7 §9): SATU jurnal (DEBIT tujuan,
 * KREDIT sumber — "jangan membuat jurnal ganda"), dicatat sebagai DUA
 * baris transaksi (satu di rekening sumber, satu di rekening tujuan)
 * yang SAMA-SAMA merujuk journal_id yang sama — supaya riwayat kedua
 * rekening menampilkan transfer ini dengan benar (mirip pola distribusi
 * SHU di fase 4: satu jurnal, banyak baris aplikasi).
 */
export async function transferAntarRekening(input: TransferAntarRekeningInput): Promise<{ journalId: string }> {
  validasiNominal(input.nominal);

  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'edit'); // transfer dianggap setara edit (memengaruhi 2 rekening)
    const accountSumber = await pastikanAccountId(db, input.sumberJenis, input.sumberBankAccountId);
    const accountTujuan = await pastikanAccountId(db, input.tujuanJenis, input.tujuanBankAccountId);

    if (accountSumber === accountTujuan) {
      throw new Error('Rekening sumber dan rekening tujuan transfer tidak boleh sama.');
    }

    // Phase 4: rekening sumber transfer harus cukup saldonya — sebelum
    // ini transfer bisa membuat rekening sumber negatif tanpa penolakan.
    const cekSaldo = await checkSaldoAkunCukup(db, {
      accountId: accountSumber,
      namaRekening: input.sumberJenis === 'BANK' ? 'rekening bank sumber' : 'rekening kas sumber',
      nominalKeluar: input.nominal,
    });
    if (!cekSaldo.valid) throw new Error(cekSaldo.reason);

    const nomorSumber = await nextSequence(db, 'TRANSFER_KELUAR', new Date(input.tanggal).getFullYear());
    const nomorTujuan = await nextSequence(db, 'TRANSFER_MASUK', new Date(input.tanggal).getFullYear());

    const { journalId } = await createJournal(db, {
      tanggal: input.tanggal,
      sumberTransaksi: 'TRANSFER_BANK',
      nomorReferensi: nomorSumber,
      deskripsi: input.keterangan || `Transfer antar rekening - ${nomorSumber}`,
      createdBy: input.createdBy,
      lines: [
        { accountId: accountTujuan, debit: input.nominal, kredit: 0 },
        { accountId: accountSumber, debit: 0, kredit: input.nominal },
      ],
    });

    await insertBarisTransaksi(db, input.sumberJenis, {
      bankAccountId: input.sumberBankAccountId,
      tipe: 'TRANSFER',
      // S19/P2 — rekening SUMBER: uang keluar dari rekening ini.
      arahTransfer: 'KELUAR',
      tanggal: input.tanggal,
      nominal: input.nominal,
      akunLawanId: accountTujuan,
      kategori: 'Transfer',
      keterangan: input.keterangan || `Transfer keluar - ${nomorSumber}`,
      nomorTransaksi: nomorSumber,
      journalId,
      createdBy: input.createdBy,
    });

    await insertBarisTransaksi(db, input.tujuanJenis, {
      bankAccountId: input.tujuanBankAccountId,
      tipe: 'TRANSFER',
      // S19/P2 — rekening TUJUAN: uang masuk ke rekening ini.
      arahTransfer: 'MASUK',
      tanggal: input.tanggal,
      nominal: input.nominal,
      akunLawanId: accountSumber,
      kategori: 'Transfer',
      keterangan: input.keterangan || `Transfer masuk - ${nomorTujuan}`,
      nomorTransaksi: nomorTujuan,
      journalId,
      createdBy: input.createdBy,
    });

    return { journalId };
  });
}

// ============================================================
// RIWAYAT & DETAIL — dengan filter (PRD fase 7 §15-17)
// ============================================================

export interface RiwayatTransaksiRow {
  id: string;
  jenis: JenisRekening;
  rekeningNama: string;
  tipe: TipeTransaksiKasBank;
  tanggal: string;
  nominal: Rupiah;
  akunLawanNama: string | null;
  kategori: string | null;
  keterangan: string | null;
  nomorTransaksi: string;
  journalId: string | null;
  reversalOfId: string | null;
}

export interface FilterRiwayatKasBank {
  jenis?: JenisRekening;
  bankAccountId?: string;
  tanggalMulai?: string;
  tanggalSelesai?: string;
  kategori?: string;
  limit?: number;
  offset?: number;
}

/** Riwayat transaksi gabungan Kas + Kas Kecil + Bank, dengan filter (§15-16). */
export async function listRiwayatTransaksi(filter: FilterRiwayatKasBank = {}): Promise<RiwayatTransaksiRow[]> {
  const db = await getDb();
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;

  const kasFilters: string[] = [];
  const kasParams: (string | number)[] = [];
  const bankFilters: string[] = [];
  const bankParams: (string | number)[] = [];

  if (filter.jenis && filter.jenis !== 'BANK') {
    kasFilters.push('kt.jenis_kas = ?');
    kasParams.push(filter.jenis);
  }
  if (filter.tanggalMulai) {
    kasFilters.push('kt.tanggal >= ?');
    kasParams.push(filter.tanggalMulai);
    bankFilters.push('bt.tanggal >= ?');
    bankParams.push(filter.tanggalMulai);
  }
  if (filter.tanggalSelesai) {
    kasFilters.push('kt.tanggal <= ?');
    kasParams.push(filter.tanggalSelesai);
    bankFilters.push('bt.tanggal <= ?');
    bankParams.push(filter.tanggalSelesai);
  }
  if (filter.kategori) {
    kasFilters.push('kt.kategori = ?');
    kasParams.push(filter.kategori);
    bankFilters.push('bt.kategori = ?');
    bankParams.push(filter.kategori);
  }
  if (filter.bankAccountId) {
    bankFilters.push('bt.bank_account_id = ?');
    bankParams.push(filter.bankAccountId);
  }

  const hasil: RiwayatTransaksiRow[] = [];

  if (filter.jenis !== 'BANK') {
    const whereKas = kasFilters.length ? `WHERE ${kasFilters.join(' AND ')}` : '';
    const kasRows = await db.getAllAsync<any>(
      `SELECT kt.*, a.nama as akun_lawan_nama
       FROM kas_transaksi kt
       LEFT JOIN account a ON a.id = kt.akun_lawan_id
       ${whereKas}
       ORDER BY kt.tanggal DESC, kt.created_at DESC`,
      ...kasParams
    );
    for (const r of kasRows) {
      hasil.push({
        id: r.id,
        jenis: r.jenis_kas,
        rekeningNama: r.jenis_kas === 'KAS' ? 'Kas Tunai' : 'Kas Kecil',
        tipe: r.tipe,
        tanggal: r.tanggal,
        nominal: r.nominal,
        akunLawanNama: r.akun_lawan_nama,
        kategori: r.kategori,
        keterangan: r.keterangan,
        nomorTransaksi: r.nomor_transaksi,
        journalId: r.journal_id,
        reversalOfId: r.reversal_of_id,
      });
    }
  }

  if (!filter.jenis || filter.jenis === 'BANK') {
    const whereBank = bankFilters.length ? `WHERE ${bankFilters.join(' AND ')}` : '';
    const bankRows = await db.getAllAsync<any>(
      `SELECT bt.*, a.nama as akun_lawan_nama, ba.nama_bank, ba.nomor_rekening
       FROM bank_transaksi bt
       LEFT JOIN account a ON a.id = bt.akun_lawan_id
       JOIN bank_account ba ON ba.id = bt.bank_account_id
       ${whereBank}
       ORDER BY bt.tanggal DESC, bt.created_at DESC`,
      ...bankParams
    );
    for (const r of bankRows) {
      hasil.push({
        id: r.id,
        jenis: 'BANK',
        rekeningNama: `${r.nama_bank} — ${r.nomor_rekening}`,
        tipe: r.tipe,
        tanggal: r.tanggal,
        nominal: r.nominal,
        akunLawanNama: r.akun_lawan_nama,
        kategori: r.kategori,
        keterangan: r.keterangan,
        nomorTransaksi: r.nomor_transaksi,
        journalId: r.journal_id,
        reversalOfId: r.reversal_of_id,
      });
    }
  }

  return hasil.sort((a, b) => (a.tanggal < b.tanggal ? 1 : -1)).slice(offset, offset + limit);
}

/** Detail satu transaksi (§17). */
export async function getTransaksiDetail(jenis: JenisRekening, id: string): Promise<RiwayatTransaksiRow | null> {
  const filter: FilterRiwayatKasBank = { jenis, limit: 100000 };
  const semua = await listRiwayatTransaksi(filter);
  return semua.find((r) => r.id === id) ?? null;
}

/**
 * Koreksi transaksi lewat reversal (fase 7: "jangan menghapus transaksi
 * yang sudah masuk laporan tanpa mekanisme yang aman") — pola identik
 * dengan koreksiSimpanan() di SimpananService.ts.
 */
export async function koreksiTransaksiKasBank(
  jenis: JenisRekening,
  id: string,
  userId: string,
  alasan: string
): Promise<{ id: string }> {
  return withTransaction(async (db) => {
    await requirePermission(db, userId, 'kas_bank', 'edit');
    const tabel = jenis === 'BANK' ? 'bank_transaksi' : 'kas_transaksi';
    const original = await db.getFirstAsync<any>(`SELECT * FROM ${tabel} WHERE id = ?`, id);
    if (!original) throw new Error('Transaksi tidak ditemukan.');
    if (!original.journal_id) throw new Error('Transaksi ini tidak mempunyai jurnal terkait.');
    if (original.tipe === 'KOREKSI') throw new Error('Transaksi koreksi tidak bisa dikoreksi lagi.');

    await reverseJournal(db, original.journal_id, userId, alasan);
    await writeAuditLog(db, userId, 'REVERSE', id);

    const idBaru = await insertBarisTransaksi(db, jenis, {
      bankAccountId: original.bank_account_id,
      tipe: 'KOREKSI',
      tanggal: getTanggalLokalHariIni(),
      nominal: original.nominal,
      akunLawanId: original.akun_lawan_id ?? undefined,
      kategori: original.kategori,
      keterangan: alasan,
      nomorTransaksi: `KOREKSI-${original.nomor_transaksi}`,
      journalId: original.journal_id,
      createdBy: userId,
      reversalOfId: id,
    });

    return { id: idBaru };
  });
}

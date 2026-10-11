import { getDb, withTransaction } from '@/database/db';
import { newId } from '@/utils/id';
import { requirePermission } from '@/services/PermissionService';
import type { LhuKlasifikasi } from '@/config/defaultCOA';
import { assertKodeAkunTidakKonflikPolicy } from '@/config/coaPolicyRegistry';

export type KategoriAkun = 'ASET' | 'LIABILITAS' | 'EKUITAS' | 'PENDAPATAN' | 'BEBAN';
export type NormalBalance = 'DEBIT' | 'KREDIT';
export type { LhuKlasifikasi };

/** Label tampilan untuk klasifikasi LHU (Bagian F: "jangan membuat banyak variasi nama"). */
export const LHU_KLASIFIKASI_LABEL: Record<LhuKlasifikasi, string> = {
  PENDAPATAN_USAHA_LAIN: 'Pendapatan Usaha Lain',
  HASIL_INVESTASI: 'Hasil Investasi',
  PENDAPATAN_LAIN: 'Pendapatan Lain',
  BEBAN_USAHA: 'Beban Usaha',
  BEBAN_LAIN: 'Beban Lain',
};

/** Saldo normal default per kategori akuntansi (dipakai sebagai default form Input Akun, bisa dioverride untuk kasus kontra-akun). */
export const DEFAULT_NORMAL_BALANCE: Record<KategoriAkun, NormalBalance> = {
  ASET: 'DEBIT',
  LIABILITAS: 'KREDIT',
  EKUITAS: 'KREDIT',
  PENDAPATAN: 'KREDIT',
  BEBAN: 'DEBIT',
};

export interface AccountItem {
  id: string;
  kode: string;
  nama: string;
  kategori: string;
  normalBalance: 'DEBIT' | 'KREDIT';
}

export interface AccountFull extends AccountItem {
  subKategori: string | null;
  parentId: string | null;
  parentNama: string | null;
  isActive: boolean;
  isSystem: boolean;
  lhuKlasifikasi: LhuKlasifikasi | null;
}

/** Daftar akun aktif (Chart of Accounts) untuk picker Buku Besar (PRD §18, §22). */
export async function listAccounts(opts: { search?: string } = {}): Promise<AccountItem[]> {
  const db = await getDb();
  const filters: string[] = ['is_active = 1'];
  const params: string[] = [];

  if (opts.search) {
    filters.push('(kode LIKE ? OR nama LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s);
  }

  const rows = await db.getAllAsync<any>(
    `SELECT id, kode, nama, kategori, normal_balance FROM account WHERE ${filters.join(' AND ')} ORDER BY kode ASC`,
    ...params
  );
  return rows.map((r) => ({
    id: r.id,
    kode: r.kode,
    nama: r.nama,
    kategori: r.kategori,
    normalBalance: r.normal_balance,
  }));
}

/**
 * Daftar akun untuk "Penerimaan Penghasilan Lain" (permintaan pengguna,
 * update pasca-Phase 18) — HANYA dua akun (4-2000 Pendapatan Usaha
 * Lain, 4-3000 Pendapatan Lainnya), BUKAN seluruh COA. Filter
 * dilakukan DI QUERY (WHERE kode IN (...)), bukan di UI — jadi
 * mustahil akun lain terpilih walau state di komponen dimanipulasi,
 * karena akun lain tidak pernah ada di hasil query ini sama sekali.
 * SENGAJA fungsi terpisah dari `listAccounts()` (bukan menambah
 * parameter filter ke situ) supaya picker global (dipakai Buku Besar,
 * History Transaksi, Penghapusan Piutang, Saldo Awal Akun, dst) tidak
 * ikut berubah perilakunya.
 */
const KODE_AKUN_PENERIMAAN_PENGHASILAN_LAIN = ['4-2000', '4-3000'] as const;

export async function getAccountsForPenerimaanPenghasilanLain(): Promise<AccountItem[]> {
  const db = await getDb();
  const placeholders = KODE_AKUN_PENERIMAAN_PENGHASILAN_LAIN.map(() => '?').join(',');
  const rows = await db.getAllAsync<any>(
    `SELECT id, kode, nama, kategori, normal_balance FROM account
     WHERE is_active = 1 AND kode IN (${placeholders})
     ORDER BY kode ASC`,
    ...KODE_AKUN_PENERIMAAN_PENGHASILAN_LAIN
  );
  return rows.map((r) => ({
    id: r.id,
    kode: r.kode,
    nama: r.nama,
    kategori: r.kategori,
    normalBalance: r.normal_balance,
  }));
}

/**
 * Revisi KOPKU (Bagian 2): daftar akun untuk "Bayar Kewajiban" —
 * SEMUA akun kategori LIABILITAS yang aktif, KECUALI Simpanan
 * Sukarela Anggota (Bagian 2.5: alur transaksi tersendiri lewat menu
 * Simpanan/Tarik Simpanan Anggota — lihat SimpananService.ts, BUKAN
 * lewat Bayar Kewajiban).
 *
 * Pengecualian dilakukan BERDASARKAN account_id (lewat account_mapping
 * SIMPANAN_SUKARELA/KREDIT_DEFAULT), BUKAN mencocokkan nama akun
 * (Bagian 2.1: "jangan hanya melakukan filter berdasarkan nama jika
 * tersedia account_id atau mapping") — tetap benar walau admin
 * mengganti nama akun Simpanan Sukarela dari default.
 *
 * SENGAJA fungsi terpisah dari `listAccounts()` (picker global) —
 * pola sama dengan `getAccountsForPenerimaanPenghasilanLain()` di
 * atas — supaya picker lain tidak ikut berubah perilakunya.
 */
export async function getAccountsUntukKewajiban(): Promise<AccountItem[]> {
  const db = await getDb();
  const simpananSukarelaMapping = await db.getFirstAsync<{ account_id: string }>(
    `SELECT account_id FROM account_mapping WHERE transaction_type = 'SIMPANAN_SUKARELA' AND role = 'KREDIT_DEFAULT'`
  );
  const excludedId = simpananSukarelaMapping?.account_id ?? null;

  const rows = await db.getAllAsync<any>(
    `SELECT id, kode, nama, kategori, normal_balance FROM account
     WHERE is_active = 1 AND kategori = 'LIABILITAS' ${excludedId ? 'AND id != ?' : ''}
     ORDER BY kode ASC`,
    ...(excludedId ? [excludedId] : [])
  );
  return rows.map((r) => ({
    id: r.id,
    kode: r.kode,
    nama: r.nama,
    kategori: r.kategori,
    normalBalance: r.normal_balance,
  }));
}

/**
 * Daftar LENGKAP akun (Phase 17 §Q — "Daftar Akun / COA") — termasuk
 * akun nonaktif (ditandai, bukan disembunyikan) supaya konsisten
 * dengan pola nonaktif/soft-delete lain di app ini (Anggota,
 * Rekening). Dipakai layar AccountListScreen (Input Data -> Input
 * Akun).
 */
export type FilterStatusAkun = 'SEMUA' | 'AKTIF' | 'NONAKTIF';

export async function listAllAccounts(
  opts: {
    search?: string;
    /**
     * REQUIREMENT 4 (permintaan pengguna) — filter Active/Non-active/All
     * pada menu COA. Difilter DI QUERY (bukan memfilter array di layar)
     * mengikuti pola picker lain di file ini. Default 'SEMUA' = perilaku
     * lama persis, jadi caller existing (getAccountById,
     * listAkunPendapatanLainnya) tidak berubah sama sekali.
     */
    status?: FilterStatusAkun;
  } = {}
): Promise<AccountFull[]> {
  const db = await getDb();
  const filters: string[] = [];
  const params: string[] = [];
  if (opts.search) {
    filters.push('(a.kode LIKE ? OR a.nama LIKE ?)');
    const s = `%${opts.search}%`;
    params.push(s, s);
  }
  if (opts.status === 'AKTIF') filters.push('a.is_active = 1');
  else if (opts.status === 'NONAKTIF') filters.push('a.is_active = 0');
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = await db.getAllAsync<any>(
    `SELECT a.id, a.kode, a.nama, a.kategori, a.sub_kategori, a.parent_id, a.normal_balance, a.is_active, a.is_system,
            a.lhu_klasifikasi, p.nama as parent_nama
     FROM account a
     LEFT JOIN account p ON p.id = a.parent_id
     ${where}
     ORDER BY a.kode ASC`,
    ...params
  );
  return rows.map((r) => ({
    id: r.id,
    kode: r.kode,
    nama: r.nama,
    kategori: r.kategori,
    subKategori: r.sub_kategori,
    parentId: r.parent_id,
    parentNama: r.parent_nama,
    normalBalance: r.normal_balance,
    isActive: !!r.is_active,
    isSystem: !!r.is_system,
    lhuKlasifikasi: r.lhu_klasifikasi ?? null,
  }));
}

export async function getAccountById(id: string): Promise<AccountFull | null> {
  const semua = await listAllAccounts();
  return semua.find((a) => a.id === id) ?? null;
}

export interface AccountInput {
  kode: string;
  nama: string;
  kategori: KategoriAkun;
  normalBalance: NormalBalance;
  subKategori?: string;
  parentId?: string;
}

/**
 * Tambah akun baru ke Chart of Accounts (Phase 17 §Q — "Input Akun").
 * Memakai tabel `account` yang SUDAH ADA (dipakai AccountingEngine,
 * AccountMapping, seluruh laporan) — BUKAN tabel akun kedua. Begitu
 * tersimpan, otomatis muncul di semua tempat yang query `account`
 * (Daftar Akun di sini, Buku Besar, Neraca Saldo, picker akun form
 * Beban, dst.) karena semuanya baca dari sumber yang sama.
 */
export async function createAccount(actingUserId: string, input: AccountInput): Promise<AccountFull> {
  return withTransaction(async (db) => {
    await requirePermission(db, actingUserId, 'pengaturan', 'create');

    const kodeTrim = input.kode.trim();
    const namaTrim = input.nama.trim();
    if (!kodeTrim) throw new Error('Kode akun wajib diisi.');
    if (!namaTrim) throw new Error('Nama akun wajib diisi.');
    // RC-S54 T12 (#14): kode yang ditolak keputusan COA RC-S53 tidak boleh
    // dibuat diam-diam lewat menu COA — POLICY_CONFLICT, bukan akun baru.
    assertKodeAkunTidakKonflikPolicy(kodeTrim);

    const existing = await db.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = ?`, kodeTrim);
    if (existing) throw new Error(`Kode akun "${kodeTrim}" sudah dipakai akun lain.`);

    if (input.parentId) {
      const parent = await db.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE id = ?`, input.parentId);
      if (!parent) throw new Error('Akun induk (parent) tidak ditemukan.');
    }

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, sub_kategori, parent_id, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,1,0,?,?)`,
      id,
      kodeTrim,
      namaTrim,
      input.kategori,
      input.subKategori ?? null,
      input.parentId ?? null,
      input.normalBalance,
      now,
      now
    );

    const created = await getAccountById(id);
    if (!created) throw new Error('Gagal membaca akun yang baru dibuat.');
    return created;
  });
}

/** Edit akun (Phase 17 §Q). Kode boleh diubah asal tetap unik; kategori/normalBalance tidak diubah kalau akun sudah dipakai transaksi (lihat cek delete) supaya ledger tidak jadi tidak konsisten. */
/**
 * Edit akun (Phase 17 §Q; diperketat pasca-Phase 18 §2 permintaan
 * pengguna). Field yang SELALU aman diubah: nama, sub kategori, akun
 * induk. Field STRUKTURAL (kode, kategori/tipe akun, normal balance)
 * HANYA boleh diubah kalau akun BELUM pernah dipakai di jurnal/mapping
 * (`isAccountInUse`) DAN bukan akun sistem (`is_system`) — mengubah
 * salah satunya pada akun yang sudah dipakai bisa membuat histori
 * jurnal lama "salah baca" (mis. akun yang tadinya ASET/DEBIT tiba-tiba
 * jadi LIABILITAS/KREDIT, padahal saldo & laporan lama dihitung
 * berdasarkan definisi lama) atau merusak `account_mapping` (akun
 * sistem dirujuk lewat account_id, tapi transaction_type/role di
 * mapping mengasumsikan kategori/normal_balance tertentu).
 */
export async function updateAccount(actingUserId: string, id: string, input: AccountInput): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, actingUserId, 'pengaturan', 'edit');
    const kodeTrim = input.kode.trim();
    const namaTrim = input.nama.trim();
    if (!kodeTrim) throw new Error('Kode akun wajib diisi.');
    if (!namaTrim) throw new Error('Nama akun wajib diisi.');

    const current = await db.getFirstAsync<{ kode: string; kategori: string; normal_balance: string; is_system: number }>(
      `SELECT kode, kategori, normal_balance, is_system FROM account WHERE id = ?`,
      id
    );
    if (!current) throw new Error('Akun tidak ditemukan.');

    const dipakai = await isAccountInUse(id);
    const terkunci = dipakai || !!current.is_system;

    if (terkunci) {
      if (kodeTrim !== current.kode) {
        throw new Error(
          current.is_system
            ? 'Kode akun sistem tidak dapat diubah — dipakai mapping transaksi otomatis.'
            : 'Kode akun tidak dapat diubah karena sudah dipakai di jurnal/mapping transaksi. Histori lama harus tetap merujuk kode yang sama.'
        );
      }
      if (input.kategori !== current.kategori) {
        throw new Error(
          current.is_system
            ? 'Tipe/kategori akun sistem tidak dapat diubah — dipakai mapping transaksi otomatis.'
            : 'Tipe/kategori akun tidak dapat diubah karena sudah dipakai di jurnal — mengubahnya akan membuat histori laporan lama salah baca.'
        );
      }
      if (input.normalBalance !== current.normal_balance) {
        throw new Error(
          current.is_system
            ? 'Saldo normal akun sistem tidak dapat diubah — dipakai mapping transaksi otomatis.'
            : 'Saldo normal akun tidak dapat diubah karena sudah dipakai di jurnal — mengubahnya akan membuat histori laporan lama salah baca.'
        );
      }
    }

    // RC-S54 T12 (#14): mengganti kode MENJADI kode yang ditolak keputusan COA
    // juga POLICY_CONFLICT. Akun lama yang kebetulan sudah berkode itu tetap
    // dapat diedit selama kodenya tidak diubah (histori tidak disentuh).
    const kodeLama = (current as { kode: string }).kode;
    if (kodeTrim !== kodeLama) assertKodeAkunTidakKonflikPolicy(kodeTrim);

    const bentrok = await db.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = ? AND id != ?`, kodeTrim, id);
    if (bentrok) throw new Error(`Kode akun "${kodeTrim}" sudah dipakai akun lain.`);

    if (input.parentId) {
      if (input.parentId === id) throw new Error('Akun tidak boleh menjadi induk dirinya sendiri.');
      const parent = await db.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE id = ?`, input.parentId);
      if (!parent) throw new Error('Akun induk (parent) tidak ditemukan.');
    }

    await db.runAsync(
      `UPDATE account SET kode = ?, nama = ?, kategori = ?, sub_kategori = ?, parent_id = ?, normal_balance = ?, updated_at = ? WHERE id = ?`,
      kodeTrim,
      namaTrim,
      input.kategori,
      input.subKategori ?? null,
      input.parentId ?? null,
      input.normalBalance,
      new Date().toISOString(),
      id
    );
  });
}

/**
 * Nonaktifkan/aktifkan kembali akun (soft delete). Akun yang sudah
 * dipakai di jurnal (`journal_entry`) atau `account_mapping` TIDAK
 * BOLEH dihapus permanen — histori ledger harus tetap utuh (pola sama
 * dengan `deleteAnggota`) — jadi "Delete" di UI ini selalu berarti
 * nonaktifkan, akun tetap ada untuk laporan periode lama.
 */
export async function setAccountActive(actingUserId: string, id: string, active: boolean): Promise<void> {
  const db = await getDb();
  await requirePermission(db, actingUserId, 'pengaturan', 'edit');
  const account = await db.getFirstAsync<{ is_system: number; is_active: number }>(
    `SELECT is_system, is_active FROM account WHERE id = ?`,
    id
  );
  if (!account) throw new Error('Akun tidak ditemukan.');
  if (!active && account.is_system) {
    throw new Error('Akun inti (system) yang dipakai mapping otomatis tidak dapat dinonaktifkan.');
  }
  // REQUIREMENT 4: idempoten — menonaktifkan akun yang sudah nonaktif
  // (mis. dari dua perangkat/dua tab) bukan error, cukup tidak
  // melakukan apa-apa supaya `updated_at` tidak berubah tanpa sebab.
  if (!!account.is_active === active) return;
  await db.runAsync(`UPDATE account SET is_active = ?, updated_at = ? WHERE id = ?`, active ? 1 : 0, new Date().toISOString(), id);
}

/**
 * Bagian H (Revisi LHU) — "Pengaturan Klasifikasi": tempat mengatur
 * mapping account_id -> klasifikasi LHU. REUSE layar Input Akun yang
 * sudah ada (bukan layar konfigurasi terpisah) — field ini muncul di
 * `AccountFormScreen` untuk akun PENDAPATAN/BEBAN. Klasifikasi TIDAK
 * PERNAH mengubah jurnal (Bagian M) — murni penyajian laporan LHU.
 * Akun 4-1000 (Pendapatan Jasa Pinjaman) & 5-2200 (Beban Pajak
 * Penghasilan) SENGAJA ditolak — keduanya baris tersendiri di LHU
 * (dibaca langsung by kode), bukan bagian dari klasifikasi manapun.
 */
export async function setLhuKlasifikasi(
  actingUserId: string,
  accountId: string,
  klasifikasi: LhuKlasifikasi | null
): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, actingUserId, 'pengaturan', 'edit');
    const acc = await db.getFirstAsync<{ kode: string; kategori: string }>(
      `SELECT kode, kategori FROM account WHERE id = ?`,
      accountId
    );
    if (!acc) throw new Error('Akun tidak ditemukan.');
    if (acc.kode === '4-1000' || acc.kode === '5-2200') {
      throw new Error('Akun ini sudah punya baris tersendiri di LHU dan tidak perlu diklasifikasikan.');
    }
    if (klasifikasi) {
      const untukPendapatan = klasifikasi === 'PENDAPATAN_USAHA_LAIN' || klasifikasi === 'HASIL_INVESTASI' || klasifikasi === 'PENDAPATAN_LAIN';
      const untukBeban = klasifikasi === 'BEBAN_USAHA' || klasifikasi === 'BEBAN_LAIN';
      if (acc.kategori === 'PENDAPATAN' && !untukPendapatan) {
        throw new Error('Klasifikasi ini hanya berlaku untuk akun Beban.');
      }
      if (acc.kategori === 'BEBAN' && !untukBeban) {
        throw new Error('Klasifikasi ini hanya berlaku untuk akun Pendapatan.');
      }
      if (acc.kategori !== 'PENDAPATAN' && acc.kategori !== 'BEBAN') {
        throw new Error('Klasifikasi LHU hanya berlaku untuk akun Pendapatan/Beban.');
      }
    }
    await db.runAsync(
      `UPDATE account SET lhu_klasifikasi = ?, updated_at = ? WHERE id = ?`,
      klasifikasi,
      new Date().toISOString(),
      accountId
    );
  });
}

/**
 * Akun Pendapatan yang bisa dipilih di menu "Pendapatan Lainnya"
 * (Bagian E) — akun PENDAPATAN aktif yang BUKAN akun sistem terkait
 * pinjaman (4-1000/4-1100/4-1200 sudah punya jalur transaksi
 * otomatis sendiri lewat AngsuranService/BiayaAdminPinjaman, bukan
 * dicatat manual di sini). Filter DI QUERY, bukan di UI (pola sama
 * `getAccountsForPenerimaanPenghasilanLain`).
 */
export async function listAkunPendapatanLainnya(): Promise<AccountFull[]> {
  const semua = await listAllAccounts();
  return semua.filter((a) => a.kategori === 'PENDAPATAN' && a.isActive && !a.isSystem);
}

/** Cek apakah akun sudah dipakai transaksi/mapping — dipakai UI untuk memberi peringatan sebelum nonaktifkan. */
export async function isAccountInUse(id: string): Promise<boolean> {
  const db = await getDb();
  const je = await db.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal_entry WHERE account_id = ?`, id);
  if ((je?.cnt ?? 0) > 0) return true;
  const mapping = await db.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM account_mapping WHERE account_id = ?`, id);
  return (mapping?.cnt ?? 0) > 0;
}

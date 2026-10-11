import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { requirePermission } from '@/services/PermissionService';
import { newId } from '@/utils/id';

/**
 * Master data Kelompok/Sub Kelompok Aset Tetap — dipakai form Pembelian
 * Aset supaya Kelompok -> Sub Kelompok -> Masa Manfaat bisa terisi
 * otomatis. Phase 18 §14-19 (permintaan pengguna): tabel ini SEKARANG
 * diisi 4 kelompok bawaan (Kelompok 1-4, lihat
 * config/defaultAsetKlasifikasi.ts) baik untuk instalasi baru
 * (SetupService.setupKoperasi) maupun instalasi lama (migration v20 di
 * database/db.ts) — sebelumnya sengaja dimulai kosong. Admin koperasi
 * tetap bisa menambah kelompok/sub-kelompok custom lewat layar "Data
 * Klasifikasi Aset" (hub Input Data), termasuk "Kelompok Lainnya"
 * (field `kelompok` adalah TEXT bebas, bukan enum kaku, jadi tidak
 * perlu baris placeholder khusus untuk itu). Metode penyusutan TETAP
 * garis lurus (satu-satunya metode yang diimplementasikan
 * `PenyusutanService.ts` — tidak ada field "metode" di sini karena
 * tidak ada pilihan metode lain yang benar-benar berjalan di mesin
 * penyusutan, supaya tidak ada opsi yang terlihat bisa dipilih padahal
 * tidak didukung).
 */

export interface AsetKlasifikasiItem {
  id: string;
  kelompok: string;
  subKelompok: string;
  /**
   * Audit ulang (permintaan pengguna §18/§19): SEKARANG boleh `null`
   * ("Masa manfaat belum ditentukan" — khususnya Kelompok 5 "Lainnya").
   * `null` di sini TIDAK berarti aset boleh punya masa manfaat 0 —
   * `AsetService.validasiMasaManfaatDanResidu()` tetap mewajibkan aset
   * sungguhan (`aset_tetap.masa_manfaat_bulan`) berupa bilangan bulat
   * > 0, TIDAK diubah oleh perubahan ini. `null` di sini HANYA berarti
   * form aset tidak bisa auto-isi dari klasifikasi — pengguna wajib
   * mengetik masa manfaat secara manual sebelum menyimpan aset.
   */
  masaManfaatBulanDefault: number | null;
  aktif: boolean;
}

/** Daftar kelompok unik (aktif saja secara default) — untuk picker tingkat pertama. */
export async function listKelompokAset(opts: { termasukNonaktif?: boolean } = {}): Promise<string[]> {
  const db = await getDb();
  const where = opts.termasukNonaktif ? '' : 'WHERE aktif = 1';
  const rows = await db.getAllAsync<{ kelompok: string }>(
    `SELECT DISTINCT kelompok FROM aset_klasifikasi ${where} ORDER BY kelompok ASC`
  );
  return rows.map((r) => r.kelompok);
}

/** Daftar sub-kelompok untuk satu kelompok — untuk picker tingkat kedua (masa manfaat default disertakan). */
export async function listSubKelompokAset(
  kelompok: string,
  opts: { termasukNonaktif?: boolean } = {}
): Promise<AsetKlasifikasiItem[]> {
  const db = await getDb();
  const filters = ['kelompok = ?'];
  const params: (string | number)[] = [kelompok];
  if (!opts.termasukNonaktif) filters.push('aktif = 1');
  const rows = await db.getAllAsync<any>(
    `SELECT * FROM aset_klasifikasi WHERE ${filters.join(' AND ')} ORDER BY sub_kelompok ASC`,
    ...params
  );
  return rows.map(rowToItem);
}

/** Seluruh klasifikasi (untuk layar manajemen "Data Klasifikasi Aset"). */
export async function listAsetKlasifikasi(opts: { termasukNonaktif?: boolean } = {}): Promise<AsetKlasifikasiItem[]> {
  const db = await getDb();
  const where = opts.termasukNonaktif ? '' : 'WHERE aktif = 1';
  const rows = await db.getAllAsync<any>(`SELECT * FROM aset_klasifikasi ${where} ORDER BY kelompok ASC, sub_kelompok ASC`);
  return rows.map(rowToItem);
}

function rowToItem(r: any): AsetKlasifikasiItem {
  return {
    id: r.id,
    kelompok: r.kelompok,
    subKelompok: r.sub_kelompok,
    masaManfaatBulanDefault: r.masa_manfaat_bulan_default,
    aktif: !!r.aktif,
  };
}

/**
 * PHASE 5 (permintaan pengguna §F/§G/§I) — cari klasifikasi lewat
 * kelompok+sub_kelompok (UNIQUE existing di schema, dipakai sebagai
 * kunci pencarian) untuk mengisi `aset_tetap.aset_klasifikasi_id`
 * secara OTOMATIS tanpa mengubah kontrak form Pembelian Aset yang
 * sudah mengirim kelompok/sub_kelompok sebagai teks. Dipanggil DI
 * DALAM transaction yang sama dengan AsetService (`db` diteruskan,
 * bukan `getDb()` baru) supaya konsisten dengan baris yang sedang
 * ditulis.
 *
 * - Kembalikan `null` kalau kelompok/subKelompok kosong (klasifikasi
 *   opsional untuk pembelian aset langsung, §F tidak mengubah itu).
 * - Lempar error kalau kelompok+subKelompok TIDAK ditemukan di master
 *   data SAMA SEKALI, ATAU ditemukan tapi `aktif = 0` — §I: "Jika
 *   classification dihapus/nonaktif: jangan boleh digunakan untuk
 *   aset baru", divalidasi di backend, bukan cuma di UI (yang secara
 *   default sudah memfilter `aktif=1` lewat listKelompokAset/
 *   listSubKelompokAset, tapi ini lapis kedua yang independen).
 */
export async function resolveKlasifikasiAsetByNama(
  db: SQLite.SQLiteDatabase,
  kelompok: string | undefined | null,
  subKelompok: string | undefined | null
): Promise<{ id: string; masaManfaatBulanDefault: number | null } | null> {
  const k = kelompok?.trim();
  const s = subKelompok?.trim();
  if (!k && !s) return null;
  if (!k || !s) {
    throw new Error('Kelompok dan Sub Kelompok aset harus diisi bersamaan.');
  }
  const row = await db.getFirstAsync<{ id: string; aktif: number; masa_manfaat_bulan_default: number | null }>(
    `SELECT id, aktif, masa_manfaat_bulan_default FROM aset_klasifikasi WHERE kelompok = ? AND sub_kelompok = ?`,
    k,
    s
  );
  if (!row) {
    throw new Error(`Klasifikasi aset "${k} / ${s}" tidak ditemukan di master data. Pilih dari daftar klasifikasi yang tersedia, atau tambahkan dulu lewat "Data Klasifikasi Aset".`);
  }
  if (!row.aktif) {
    throw new Error(`Klasifikasi aset "${k} / ${s}" sudah nonaktif — tidak dapat digunakan untuk aset baru.`);
  }
  return { id: row.id, masaManfaatBulanDefault: row.masa_manfaat_bulan_default };
}

export interface TambahAsetKlasifikasiInput {
  kelompok: string;
  subKelompok: string;
  /** Audit ulang §18: boleh `null`/tidak diisi (mis. untuk Kelompok 5 "Lainnya"). Kalau diisi, tetap harus > 0. */
  masaManfaatBulanDefault: number | null;
  createdBy: string;
}

/** Tambah kelompok/sub-kelompok baru. Anti-duplikat lewat UNIQUE(kelompok, sub_kelompok) di skema. */
export async function tambahAsetKlasifikasi(input: TambahAsetKlasifikasiInput): Promise<AsetKlasifikasiItem> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    const kelompok = input.kelompok.trim();
    const subKelompok = input.subKelompok.trim();
    if (!kelompok) throw new Error('Kelompok aset wajib diisi.');
    if (!subKelompok) throw new Error('Sub kelompok aset wajib diisi.');
    // Audit ulang §18: `null`/tidak diisi kini VALID (masa manfaat
    // belum ditentukan) — validasi HANYA berlaku kalau nilainya diisi.
    if (
      input.masaManfaatBulanDefault !== null &&
      input.masaManfaatBulanDefault !== undefined &&
      (!Number.isFinite(input.masaManfaatBulanDefault) || input.masaManfaatBulanDefault <= 0)
    ) {
      throw new Error('Masa manfaat default harus lebih dari 0 bulan, atau dikosongkan.');
    }

    const existing = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM aset_klasifikasi WHERE LOWER(kelompok) = LOWER(?) AND LOWER(sub_kelompok) = LOWER(?)`,
      kelompok,
      subKelompok
    );
    if (existing) {
      throw new Error(`Kelompok "${kelompok}" / Sub Kelompok "${subKelompok}" sudah ada.`);
    }

    const id = newId();
    const now = new Date().toISOString();
    const masaManfaat = input.masaManfaatBulanDefault ?? null;
    await db.runAsync(
      `INSERT INTO aset_klasifikasi (id, kelompok, sub_kelompok, masa_manfaat_bulan_default, aktif, created_at, updated_at)
       VALUES (?,?,?,?,1,?,?)`,
      id,
      kelompok,
      subKelompok,
      masaManfaat,
      now,
      now
    );
    return { id, kelompok, subKelompok, masaManfaatBulanDefault: masaManfaat, aktif: true };
  });
}

export interface EditAsetKlasifikasiInput {
  id: string;
  /** Audit ulang §18: boleh `null`/tidak diisi (mis. untuk Kelompok 5 "Lainnya"). Kalau diisi, tetap harus > 0. */
  masaManfaatBulanDefault: number | null;
  aktif: boolean;
  updatedBy: string;
}

/** Edit masa manfaat default / aktifkan-nonaktifkan — kelompok/sub-kelompok (nama) tidak diedit di sini supaya aset lama yang sudah memakainya tetap konsisten; buat entri baru kalau perlu nama berbeda. */
export async function editAsetKlasifikasi(input: EditAsetKlasifikasiInput): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.updatedBy, 'kas_bank', 'edit');
    if (
      input.masaManfaatBulanDefault !== null &&
      input.masaManfaatBulanDefault !== undefined &&
      (!Number.isFinite(input.masaManfaatBulanDefault) || input.masaManfaatBulanDefault <= 0)
    ) {
      throw new Error('Masa manfaat default harus lebih dari 0 bulan, atau dikosongkan.');
    }
    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE aset_klasifikasi SET masa_manfaat_bulan_default = ?, aktif = ?, updated_at = ? WHERE id = ?`,
      input.masaManfaatBulanDefault ?? null,
      input.aktif ? 1 : 0,
      now,
      input.id
    );
  });
}

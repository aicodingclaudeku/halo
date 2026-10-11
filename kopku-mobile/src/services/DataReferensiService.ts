import { getDb, withTransaction } from '@/database/db';
import { requirePermission } from '@/services/PermissionService';
import { newId } from '@/utils/id';

/**
 * Data Referensi — master data ringan untuk hub "Input Data" (dulu
 * nav "Kas & Bank" di menu Transaksi): Pemasok (Pembelian Aset
 * kredit), Pemberi Pinjaman Bank/Pihak Lain (form Utang), Beban Lain.
 * Lihat komentar lengkap di schema.ts §9c-ter untuk alasan satu tabel
 * generik dipakai untuk ke-4 jenis ini.
 */

export type JenisDataReferensi = 'PEMASOK' | 'PEMBERI_PINJAMAN_BANK' | 'PEMBERI_PINJAMAN_PIHAK_LAIN' | 'BEBAN_LAIN';

export const LABEL_JENIS_DATA_REFERENSI: Record<JenisDataReferensi, string> = {
  PEMASOK: 'Data Pemasok',
  PEMBERI_PINJAMAN_BANK: 'Data Bank Pemberi Pinjaman',
  PEMBERI_PINJAMAN_PIHAK_LAIN: 'Data Pemberi Pinjaman',
  BEBAN_LAIN: 'Data Beban Lain',
};

export interface DataReferensiItem {
  id: string;
  jenis: JenisDataReferensi;
  nama: string;
  keterangan: string | null;
  alamat: string | null;
  aktif: boolean;
}

/** Daftar data referensi per jenis, default hanya yang aktif (dipakai picker di form transaksi). */
export async function listDataReferensi(
  jenis: JenisDataReferensi,
  opts: { termasukNonaktif?: boolean } = {}
): Promise<DataReferensiItem[]> {
  const db = await getDb();
  const where = opts.termasukNonaktif ? 'WHERE jenis = ?' : 'WHERE jenis = ? AND aktif = 1';
  const rows = await db.getAllAsync<any>(`SELECT * FROM data_referensi ${where} ORDER BY nama ASC`, jenis);
  return rows.map((r) => ({ id: r.id, jenis: r.jenis, nama: r.nama, keterangan: r.keterangan, alamat: r.alamat, aktif: !!r.aktif }));
}

export interface TambahDataReferensiInput {
  jenis: JenisDataReferensi;
  nama: string;
  keterangan?: string;
  /** Phase 17 §U/§V: dipakai untuk jenis PEMASOK & PEMBERI_PINJAMAN_PIHAK_LAIN. */
  alamat?: string;
  createdBy: string;
}

/**
 * Tambah entri data referensi baru. Dipanggil baik dari layar
 * "Data Pemasok"/dst secara eksplisit, MAUPUN otomatis dari picker di
 * form transaksi (mis. mengetik nama pemasok baru di form Pembelian
 * Aset) — supaya master data terisi secara alami dari pemakaian
 * sehari-hari, bukan harus diinput manual dulu sebelum bisa transaksi.
 */
export async function tambahDataReferensi(input: TambahDataReferensiInput): Promise<DataReferensiItem> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'kas_bank', 'create');
    const nama = input.nama.trim();
    if (!nama) throw new Error('Nama wajib diisi.');

    // Anti-duplikat case-insensitive per jenis — mengetik "Toko Jaya"
    // dua kali (beda kapitalisasi) tidak membuat dua entri berbeda.
    const existing = await db.getFirstAsync<{ id: string; nama: string; keterangan: string | null; alamat: string | null; aktif: number }>(
      `SELECT id, nama, keterangan, alamat, aktif FROM data_referensi WHERE jenis = ? AND LOWER(nama) = LOWER(?)`,
      input.jenis,
      nama
    );
    if (existing) {
      return { id: existing.id, jenis: input.jenis, nama: existing.nama, keterangan: existing.keterangan, alamat: existing.alamat, aktif: !!existing.aktif };
    }

    const id = newId();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO data_referensi (id, jenis, nama, keterangan, alamat, aktif, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)`,
      id,
      input.jenis,
      nama,
      input.keterangan ?? null,
      input.alamat ?? null,
      now,
      now
    );
    return { id, jenis: input.jenis, nama, keterangan: input.keterangan ?? null, alamat: input.alamat ?? null, aktif: true };
  });
}

export interface EditDataReferensiInput {
  id: string;
  nama: string;
  keterangan?: string;
  alamat?: string;
  aktif: boolean;
  updatedBy: string;
}

/** Edit / nonaktifkan entri data referensi — TIDAK menghapus (transaksi lama tetap menyimpan namanya sebagai teks bebas, tidak terpengaruh). */
export async function editDataReferensi(input: EditDataReferensiInput): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.updatedBy, 'kas_bank', 'edit');
    const nama = input.nama.trim();
    if (!nama) throw new Error('Nama wajib diisi.');
    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE data_referensi SET nama = ?, keterangan = ?, alamat = ?, aktif = ?, updated_at = ? WHERE id = ?`,
      nama,
      input.keterangan ?? null,
      input.alamat ?? null,
      input.aktif ? 1 : 0,
      now,
      input.id
    );
  });
}

/**
 * Hapus entri data referensi secara permanen (Phase 17 §U/§V: "Data
 * harus bisa Add/Edit/Delete"). Berbeda dari Anggota/Rekening yang
 * di-FK oleh transaksi (delete berisiko orphan data), transaksi yang
 * memakai nama pemasok/pemberi pinjaman menyimpan NAMA-nya sebagai
 * teks bebas (`utang.nama_pemberi`, dst — lihat skema), BUKAN
 * mereferensikan `data_referensi.id`. Jadi hapus permanen di sini AMAN
 * — histori transaksi lama tetap utuh apa adanya, tidak jadi orphan
 * foreign key.
 */
export async function hapusDataReferensi(actingUserId: string, id: string): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, actingUserId, 'kas_bank', 'edit'); // hapus dianggap setara edit-destruktif, pola sama dengan deleteAnggota
    const existing = await db.getFirstAsync<{ id: string }>(`SELECT id FROM data_referensi WHERE id = ?`, id);
    if (!existing) throw new Error('Data tidak ditemukan.');
    await db.runAsync(`DELETE FROM data_referensi WHERE id = ?`, id);
  });
}

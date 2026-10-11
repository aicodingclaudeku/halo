import { getDb, withTransaction } from '@/database/db';
import { requirePermission } from '@/services/PermissionService';
import { newId } from '@/utils/id';
import type * as SQLite from 'expo-sqlite';

/**
 * RATService — Rapat Anggota Tahunan (update pasca-Phase 18 §12/§13,
 * permintaan pengguna). Satu RAT per tahun buku (`UNIQUE(tahun_buku)`
 * di skema) — dipakai sebagai syarat:
 *  - §12: tombol "Bagikan SHU" pada `ShuDetailScreen` (status DIHITUNG)
 *    baru aktif setelah RAT tahun buku terkait tersimpan.
 *  - §19: `PinjamanService.hapusPiutangPinjaman()` menolak penghapusan
 *    piutang kalau belum ada RAT untuk tahun buku terkait.
 * Data RAT SUNGGUHAN tersimpan ke database (tabel `rat`) — bukan cuma
 * state UI, sesuai instruksi eksplisit.
 */

export interface RATInput {
  tahunBuku: number;
  tanggalRat: string;
  nomorRat?: string;
  keterangan?: string;
  createdBy: string;
}

export interface RATItem {
  id: string;
  tahunBuku: number;
  tanggalRat: string;
  nomorRat: string | null;
  keterangan: string | null;
  createdAt: string;
}

function rowToItem(r: any): RATItem {
  return {
    id: r.id,
    tahunBuku: r.tahun_buku,
    tanggalRat: r.tanggal_rat,
    nomorRat: r.nomor_rat,
    keterangan: r.keterangan,
    createdAt: r.created_at,
  };
}

/** Audit trail generik untuk CREATE/UPDATE/DELETE data RAT (permintaan pengguna §13) — pola sama dipakai service lain, lihat KasBankService.writeAuditLog. */
async function writeAuditLog(
  db: SQLite.SQLiteDatabase,
  userId: string,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  entityId: string,
  dataSebelum?: unknown,
  dataSesudah?: unknown
) {
  const now = new Date();
  await db.runAsync(
    `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sebelum, data_sesudah, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId(),
    userId,
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    action,
    'rat',
    entityId,
    dataSebelum !== undefined ? JSON.stringify(dataSebelum) : null,
    dataSesudah !== undefined ? JSON.stringify(dataSesudah) : null,
    now.toISOString()
  );
}

/**
 * Simpan data RAT untuk satu tahun buku. Memakai permission `shu`
 * (action `approve`) — RAT adalah gerbang persetujuan yang levelnya
 * sama dengan `bagikanSHU()` (yang juga memakai `shu:approve`), bukan
 * resource baru terpisah, supaya konsisten dengan siapa yang boleh
 * mengesahkan keputusan RAT di app ini.
 */
export async function simpanRAT(input: RATInput): Promise<RATItem> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'shu', 'approve');

    if (!input.tanggalRat) throw new Error('Tanggal pelaksanaan RAT wajib diisi.');
    if (!Number.isFinite(input.tahunBuku) || input.tahunBuku < 2000) {
      throw new Error('Tahun buku tidak valid.');
    }

    const existing = await db.getFirstAsync<{ id: string }>(`SELECT id FROM rat WHERE tahun_buku = ?`, input.tahunBuku);
    const now = new Date().toISOString();

    if (existing) {
      // Satu RAT per tahun buku (§13) — kalau sudah ada, UPDATE data
      // yang sama (mis. koreksi tanggal/keterangan), BUKAN membuat
      // baris duplikat.
      const before = await db.getFirstAsync<any>(`SELECT * FROM rat WHERE id = ?`, existing.id);
      await db.runAsync(
        `UPDATE rat SET tanggal_rat = ?, nomor_rat = ?, keterangan = ?, updated_at = ? WHERE id = ?`,
        input.tanggalRat,
        input.nomorRat ?? null,
        input.keterangan ?? null,
        now,
        existing.id
      );
      const updated = await db.getFirstAsync<any>(`SELECT * FROM rat WHERE id = ?`, existing.id);
      await writeAuditLog(db, input.createdBy, 'UPDATE', existing.id, rowToItem(before), rowToItem(updated));
      return rowToItem(updated);
    }

    const id = newId();
    await db.runAsync(
      `INSERT INTO rat (id, tahun_buku, tanggal_rat, nomor_rat, keterangan, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      id,
      input.tahunBuku,
      input.tanggalRat,
      input.nomorRat ?? null,
      input.keterangan ?? null,
      input.createdBy,
      now,
      now
    );
    const created = await db.getFirstAsync<any>(`SELECT * FROM rat WHERE id = ?`, id);
    await writeAuditLog(db, input.createdBy, 'CREATE', id, undefined, rowToItem(created));
    return rowToItem(created);
  });
}

/** Ambil RAT untuk satu tahun buku (null kalau belum ada — dipakai untuk gate tombol Bagikan SHU / Penghapusan Piutang). */
export async function getRATByTahunBuku(tahunBuku: number): Promise<RATItem | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(`SELECT * FROM rat WHERE tahun_buku = ?`, tahunBuku);
  return row ? rowToItem(row) : null;
}

/** Daftar seluruh RAT yang pernah tercatat, terbaru dulu. */
export async function listRAT(): Promise<RATItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(`SELECT * FROM rat ORDER BY tahun_buku DESC`);
  return rows.map(rowToItem);
}

/**
 * Hapus data RAT satu tahun buku (permintaan pengguna §13). RAT
 * sendiri TIDAK pernah menghasilkan jurnal (murni catatan administratif
 * — lihat komentar header file), jadi TIDAK butuh reversal jurnal
 * seperti transaksi keuangan lain. TAPI dua hal lain yang BERGANTUNG
 * padanya tetap harus dijaga, jadi penghapusan DITOLAK (bukan
 * hard-delete membabi buta) kalau:
 *  - Periode akuntansi (`accounting_period`) untuk tahun buku ini
 *    SUDAH CLOSED — RAT adalah salah satu syarat penutupan periode
 *    (lihat komentar header), menghapusnya setelah periode ditutup
 *    akan membuat gerbang itu retroaktif tidak valid.
 *  - Ada baris `shu_konfigurasi` (tahun buku sama) yang SUDAH memakai
 *    keputusan RAT ini (`rat_id` terisi, lewat alur Bagikan SHU) — RAT
 *    yang sudah dipakai untuk mengesahkan SHU tidak boleh hilang dari
 *    riwayat audit SHU tahun tersebut.
 * Kalau tidak ada keterkaitan di atas, baris `rat` dihapus fisik (bukan
 * jurnal/transaksi keuangan, jadi tidak melanggar aturan "jangan hard
 * delete data yang sudah jadi referensi jurnal" — referensi jurnal
 * satu-satunya yang relevan di sini, `shu_konfigurasi.rat_id`, justru
 * yang dicek & diblokir di atas).
 */
export async function hapusRAT(params: { id: string; alasan: string; actingUserId: string }): Promise<void> {
  return withTransaction(async (db) => {
    await requirePermission(db, params.actingUserId, 'shu', 'approve');
    if (!params.alasan.trim()) throw new Error('Alasan penghapusan wajib diisi.');

    const rat = await db.getFirstAsync<{ id: string; tahun_buku: number }>(`SELECT id, tahun_buku FROM rat WHERE id = ?`, params.id);
    if (!rat) throw new Error('Data RAT tidak ditemukan.');

    const periodeClosed = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM accounting_period WHERE tahun_buku = ? AND status = 'CLOSED'`,
      rat.tahun_buku
    );
    if (periodeClosed) {
      throw new Error(
        `Periode akuntansi tahun buku ${rat.tahun_buku} sudah ditutup (CLOSED) — data RAT yang menjadi syarat penutupan tidak dapat dihapus.`
      );
    }

    const shuTerkait = await db.getFirstAsync<{ id: string }>(`SELECT id FROM shu_konfigurasi WHERE rat_id = ?`, params.id);
    if (shuTerkait) {
      throw new Error('RAT ini sudah dipakai untuk mengesahkan SHU tahun buku terkait dan tidak dapat dihapus.');
    }

    // Audit trail penghapusan (permintaan pengguna §13) — pola sama
    // dipakai CREATE/UPDATE di atas, alasan disimpan di data_sesudah.
    await writeAuditLog(db, params.actingUserId, 'DELETE', params.id, rat, { alasan: params.alasan.trim() });

    await db.runAsync(`DELETE FROM rat WHERE id = ?`, params.id);
  });
}

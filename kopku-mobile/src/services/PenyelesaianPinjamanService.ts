import { getDb, withTransaction } from '@/database/db';
import { requirePermission } from '@/services/PermissionService';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { newId } from '@/utils/id';
import {
  bacaPenyelesaianDariRow,
  validasiPenyelesaian,
  type BarisPenyelesaian,
  type InputPenyelesaian,
  type PenyelesaianPinjaman,
} from '@/accounting/PenyelesaianPinjaman';

export type { PenyelesaianPinjaman };
export { bacaPenyelesaianDariRow };

/**
 * RC-S133.6.4 (v82) — PENCATATAN MANUAL penyelesaian pinjaman ke Pengadilan
 * Negeri / klaim asuransi kredit (kriteria Macet angka 3, SOM 12.1).
 *
 * Yang dilakukan: mengisi/mengubah/menghapus kolom `pinjaman.penyelesaian_*`.
 * Nilai itu dibaca `getKlasifikasiPinjamanAktif` dan diteruskan ke
 * `klasifikasikanSom`, sehingga pinjaman tergolong MACET sejak tanggal
 * pencatatan (bukan sebelumnya).
 *
 * Yang SENGAJA tidak dilakukan:
 *  - tidak membuat jurnal / mengubah saldo / status pinjaman / jadwal.
 *    Penyisihan mengikuti klasifikasi seperti kategori lain; penghapusbukuan
 *    tetap lewat alur terpisah (hapusPiutangPinjaman);
 *  - tidak menebak apa pun: jalur, tanggal, nomor perkara/klaim, dan dokumen
 *    diisi manusia;
 *  - tidak membuka pencatatan bagi role selain yang berizin `pinjaman:approve`
 *    (bawaan: Admin dan Pengurus).
 *
 * Setiap pencatatan, perubahan, dan pembatalan menulis `audit_log`
 * (entity 'pinjaman') dengan data sebelum & sesudah.
 */

export async function getPenyelesaianPinjaman(pinjamanId: string): Promise<PenyelesaianPinjaman | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<BarisPenyelesaian>(
    `SELECT penyelesaian_jalur, penyelesaian_tanggal, penyelesaian_nomor, penyelesaian_dokumen,
            penyelesaian_alasan, penyelesaian_oleh
     FROM pinjaman WHERE id = ?`,
    pinjamanId
  );
  return bacaPenyelesaianDariRow(pinjamanId, row);
}

const SQL_BACA = `SELECT status, tanggal, nomor_pinjaman, penyelesaian_jalur, penyelesaian_tanggal, penyelesaian_nomor,
                         penyelesaian_dokumen, penyelesaian_alasan, penyelesaian_oleh
                  FROM pinjaman WHERE id = ?`;

type RowPinjaman = BarisPenyelesaian & { status: string; tanggal: string; nomor_pinjaman: string };

async function tulisAudit(
  db: { runAsync: (sql: string, ...p: any[]) => Promise<unknown> },
  o: { userId: string; action: string; pinjamanId: string; sebelum: unknown; sesudah: unknown }
) {
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sebelum, data_sesudah, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId(),
    o.userId,
    now.slice(0, 10),
    now.slice(11, 19),
    o.action,
    'pinjaman',
    o.pinjamanId,
    JSON.stringify(o.sebelum),
    JSON.stringify(o.sesudah),
    now
  );
}

export interface CatatPenyelesaianInput extends InputPenyelesaian {
  pinjamanId: string;
  actingUserId: string;
}

/**
 * Catat (atau ubah) penyelesaian ke Pengadilan Negeri / klaim asuransi.
 * Hanya untuk pinjaman berstatus AKTIF (yang masih punya piutang dan ikut
 * penggolongan kolektibilitas).
 */
export async function catatPenyelesaianPinjaman(input: CatatPenyelesaianInput): Promise<PenyelesaianPinjaman> {
  return withTransaction(async (db) => {
    await requirePermission(db, input.actingUserId, 'pinjaman', 'approve');

    const row = await db.getFirstAsync<RowPinjaman>(SQL_BACA, input.pinjamanId);
    if (!row) throw new Error('Pinjaman tidak ditemukan.');
    if (row.status !== 'AKTIF') {
      throw new Error(
        `Penyelesaian ke Pengadilan/asuransi hanya dapat dicatat untuk pinjaman berstatus AKTIF (status saat ini: ${row.status}).`
      );
    }

    const v = validasiPenyelesaian(input, getTanggalLokalHariIni(), row.tanggal);
    if (!v.valid) throw new Error(v.galat.join(' '));

    const sebelum = bacaPenyelesaianDariRow(input.pinjamanId, row);
    const now = new Date().toISOString();
    await db.runAsync(
      `UPDATE pinjaman
         SET penyelesaian_jalur = ?, penyelesaian_tanggal = ?, penyelesaian_nomor = ?, penyelesaian_dokumen = ?,
             penyelesaian_alasan = ?, penyelesaian_oleh = ?, updated_at = ?
       WHERE id = ?`,
      v.nilai.jalur,
      v.nilai.tanggal,
      v.nilai.nomor,
      v.nilai.dokumen,
      v.nilai.alasan,
      input.actingUserId,
      now,
      input.pinjamanId
    );

    const sesudah: PenyelesaianPinjaman = {
      pinjamanId: input.pinjamanId,
      ...v.nilai,
      dicatatOleh: input.actingUserId,
    };
    await tulisAudit(db, {
      userId: input.actingUserId,
      action: sebelum ? 'UBAH_PENYELESAIAN' : 'CATAT_PENYELESAIAN',
      pinjamanId: input.pinjamanId,
      sebelum,
      sesudah: { ...sesudah, nomorPinjaman: row.nomor_pinjaman },
    });
    return sesudah;
  });
}

export interface BatalkanPenyelesaianInput {
  pinjamanId: string;
  /** Alasan pembatalan — WAJIB (mis. salah catat). */
  alasan: string;
  actingUserId: string;
}

/**
 * Batalkan pencatatan (salah catat / perkara dicabut / klaim ditarik).
 * Kolom dikosongkan; riwayatnya tetap ada di audit_log. Pinjaman kembali
 * digolongkan menurut tunggakan/agunan seperti biasa.
 */
export async function batalkanPenyelesaianPinjaman(input: BatalkanPenyelesaianInput): Promise<void> {
  const alasan = (input.alasan ?? '').trim();
  if (!alasan) throw new Error('Alasan pembatalan wajib diisi.');
  await withTransaction(async (db) => {
    await requirePermission(db, input.actingUserId, 'pinjaman', 'approve');

    const row = await db.getFirstAsync<RowPinjaman>(SQL_BACA, input.pinjamanId);
    if (!row) throw new Error('Pinjaman tidak ditemukan.');
    const sebelum = bacaPenyelesaianDariRow(input.pinjamanId, row);
    if (!sebelum) throw new Error('Pinjaman ini tidak memiliki pencatatan penyelesaian ke Pengadilan/asuransi.');

    await db.runAsync(
      `UPDATE pinjaman
         SET penyelesaian_jalur = NULL, penyelesaian_tanggal = NULL, penyelesaian_nomor = NULL,
             penyelesaian_dokumen = NULL, penyelesaian_alasan = NULL, penyelesaian_oleh = NULL, updated_at = ?
       WHERE id = ?`,
      new Date().toISOString(),
      input.pinjamanId
    );
    await tulisAudit(db, {
      userId: input.actingUserId,
      action: 'BATAL_PENYELESAIAN',
      pinjamanId: input.pinjamanId,
      sebelum: { ...sebelum, nomorPinjaman: row.nomor_pinjaman },
      sesudah: { dibatalkan: true, alasan },
    });
  });
}

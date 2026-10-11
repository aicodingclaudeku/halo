import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { requirePermission } from '@/services/PermissionService';
import { newId } from '@/utils/id';
import {
  alasanKebijakanTidakLayak,
  DrafKebijakanProduk,
  KebijakanProdukBerjangka,
  petakanKebijakanProduk,
  pilihKebijakanUntukTanggal,
  StatusPolicyKontrak,
  validasiDrafKebijakanProduk,
} from '@/accounting/SimpananBerjangkaKebijakanProduk';

/**
 * ============================================================
 * KEBIJAKAN PRODUK SIMPANAN BERJANGKA — PENYIMPANAN (RC-S128)
 * ============================================================
 * Aturan pemilihan & validasi ada di `SimpananBerjangkaKebijakanProduk.ts`
 * (murni). Modul ini hanya membaca/menulis tabel berversi dan mencatat
 * penerapan kebijakan ke kontrak lama.
 *
 * APPEND-ONLY dijamin dua lapis: service tidak punya fungsi "ubah", dan
 * trigger database menolak UPDATE parameter/DELETE baris (lihat
 * schema.ts §7f). Izin: `pengaturan/edit`, sama dengan kebijakan
 * penarikan dini.
 */

export class KebijakanProdukDitolakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KebijakanProdukDitolakError';
  }
}

export async function listKebijakanProdukPadaDb(db: SQLite.SQLiteDatabase): Promise<KebijakanProdukBerjangka[]> {
  const rows = await db.getAllAsync<Record<string, any>>(
    `SELECT * FROM simpanan_berjangka_kebijakan_produk ORDER BY berlaku_mulai DESC, created_at DESC`
  );
  return rows.map(petakanKebijakanProduk);
}

export async function listKebijakanProduk(): Promise<KebijakanProdukBerjangka[]> {
  return listKebijakanProdukPadaDb(await getDb());
}

/** Kebijakan yang berlaku pada `tanggal`, atau null. */
export async function getKebijakanProdukUntukTanggalPadaDb(
  db: SQLite.SQLiteDatabase,
  tanggal: string
): Promise<KebijakanProdukBerjangka | null> {
  return pilihKebijakanUntukTanggal(await listKebijakanProdukPadaDb(db), tanggal);
}

export async function getKebijakanProdukUntukTanggal(tanggal: string): Promise<KebijakanProdukBerjangka | null> {
  return getKebijakanProdukUntukTanggalPadaDb(await getDb(), tanggal);
}

/** Jumlah kontrak yang memakai suatu versi (snapshot maupun penerapan). */
export async function hitungKontrakPemakaiKebijakan(policyId: string): Promise<number> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM simpanan_berjangka WHERE policy_id = ?`, policyId);
  return r?.n ?? 0;
}

export async function simpanKebijakanProduk(input: DrafKebijakanProduk & { createdBy: string }): Promise<KebijakanProdukBerjangka> {
  const galat = validasiDrafKebijakanProduk(input);
  if (galat.length) throw new KebijakanProdukDitolakError(galat.join(' '));
  return withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'pengaturan', 'edit');
    const versiSama = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM simpanan_berjangka_kebijakan_produk WHERE versi = ?`,
      input.versi.trim()
    );
    if (versiSama) throw new KebijakanProdukDitolakError(`Versi ${input.versi.trim()} sudah ada. Gunakan nomor versi baru.`);
    const tanggalSama = await db.getFirstAsync<{ versi: string }>(
      `SELECT versi FROM simpanan_berjangka_kebijakan_produk WHERE berlaku_mulai = ? AND status = 'AKTIF'`,
      input.berlakuMulai
    );
    if (tanggalSama) {
      throw new KebijakanProdukDitolakError(
        `Sudah ada kebijakan aktif (versi ${tanggalSama.versi}) yang berlaku mulai ${input.berlakuMulai}. ` +
          'Pilih tanggal mulai berlaku lain, atau cabut versi itu bila belum dipakai kontrak.'
      );
    }
    const id = newId();
    await db.runAsync(
      `INSERT INTO simpanan_berjangka_kebijakan_produk
        (id, versi, berlaku_mulai, status, auto_renewal, bunga_pasca_jatuh_tempo_aktif, rate_pasca_jatuh_tempo,
         basis_rate, metode_periode, bunga_dikreditkan_ke, kapitalisasi_bunga, pokok_tetap_di_berjangka,
         dasar_penetapan, ditetapkan_oleh, ditetapkan_pada, catatan, created_by, created_at)
       VALUES (?,?,?,'AKTIF',?,?,?,'TAHUNAN','BULAN_KALENDER','SIMPANAN_SUKARELA',0,1,?,?,?,?,?,?)`,
      id,
      input.versi.trim(),
      input.berlakuMulai,
      input.autoRenewal ? 1 : 0,
      input.bungaPascaJatuhTempoAktif ? 1 : 0,
      input.bungaPascaJatuhTempoAktif ? input.ratePascaJatuhTempo : null,
      input.dasarPenetapan.trim(),
      input.ditetapkanOleh.trim(),
      input.ditetapkanPada,
      input.catatan?.trim() || null,
      input.createdBy,
      new Date().toISOString()
    );
    const row = await db.getFirstAsync<Record<string, any>>(`SELECT * FROM simpanan_berjangka_kebijakan_produk WHERE id = ?`, id);
    return petakanKebijakanProduk(row!);
  });
}

/**
 * Cabut versi yang BELUM dipakai kontrak (mis. salah ketik). Versi yang
 * sudah dipakai tidak bisa dicabut — trigger database juga menolaknya;
 * perubahan kebijakan dilakukan dengan versi baru.
 */
export async function cabutKebijakanProduk(input: { id: string; alasan: string; createdBy: string }): Promise<void> {
  const alasan = input.alasan.trim();
  if (!alasan) throw new KebijakanProdukDitolakError('Alasan pencabutan wajib diisi.');
  await withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'pengaturan', 'edit');
    const k = await db.getFirstAsync<{ status: string; versi: string }>(
      `SELECT status, versi FROM simpanan_berjangka_kebijakan_produk WHERE id = ?`,
      input.id
    );
    if (!k) throw new KebijakanProdukDitolakError('Kebijakan tidak ditemukan.');
    if (k.status !== 'AKTIF') throw new KebijakanProdukDitolakError(`Kebijakan versi ${k.versi} sudah dicabut.`);
    const dipakai = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM simpanan_berjangka WHERE policy_id = ?`, input.id);
    if ((dipakai?.n ?? 0) > 0) {
      throw new KebijakanProdukDitolakError(
        `Kebijakan versi ${k.versi} sudah dipakai ${dipakai!.n} kontrak dan tidak dapat dicabut. Tetapkan versi baru untuk kontrak berikutnya.`
      );
    }
    await db.runAsync(
      `UPDATE simpanan_berjangka_kebijakan_produk
          SET status = 'DICABUT', dicabut_oleh = ?, dicabut_pada = ?, alasan_dicabut = ?
        WHERE id = ?`,
      input.createdBy,
      new Date().toISOString(),
      alasan,
      input.id
    );
  });
}

// ------------------------------------------------------------------
// Kontrak LEGACY (dibuat sebelum kebijakan produk tersedia)
// ------------------------------------------------------------------

export interface KontrakLegacyReview {
  id: string;
  nomorTransaksi: string;
  anggotaId: string;
  namaAnggota: string;
  nominal: number;
  tanggalMulai: string;
  tanggalJatuhTempo: string;
  status: string;
  statusPolicy: StatusPolicyKontrak;
}

export async function listKontrakLegacyPerluReview(): Promise<KontrakLegacyReview[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT sb.id, sb.nomor_transaksi, sb.anggota_id, a.nama_lengkap, sb.nominal, sb.tanggal_mulai,
            sb.tanggal_jatuh_tempo, sb.status, sb.status_policy
       FROM simpanan_berjangka sb JOIN anggota a ON a.id = sb.anggota_id
      WHERE sb.status_policy = 'LEGACY_POLICY_REVIEW_REQUIRED' AND sb.status IN ('AKTIF','JATUH_TEMPO')
      ORDER BY sb.tanggal_jatuh_tempo ASC`
  );
  return rows.map((r) => ({
    id: r.id,
    nomorTransaksi: r.nomor_transaksi,
    anggotaId: r.anggota_id,
    namaAnggota: r.nama_lengkap,
    nominal: r.nominal,
    tanggalMulai: r.tanggal_mulai,
    tanggalJatuhTempo: r.tanggal_jatuh_tempo,
    status: r.status,
    statusPolicy: r.status_policy,
  }));
}

export interface PenerapanKebijakanRow {
  id: string;
  kontrakId: string;
  policyId: string;
  policyVersi: string;
  tanggalEfektif: string;
  alasan: string;
  ditetapkanOleh: string;
  createdBy: string;
  createdAt: string;
}

export async function getPenerapanKebijakanKontrak(kontrakId: string): Promise<PenerapanKebijakanRow | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<any>(`SELECT * FROM simpanan_berjangka_penerapan_kebijakan WHERE simpanan_berjangka_id = ?`, kontrakId);
  return r
    ? {
        id: r.id,
        kontrakId: r.simpanan_berjangka_id,
        policyId: r.policy_id,
        policyVersi: r.policy_versi,
        tanggalEfektif: r.tanggal_efektif,
        alasan: r.alasan,
        ditetapkanOleh: r.ditetapkan_oleh,
        createdBy: r.created_by,
        createdAt: r.created_at,
      }
    : null;
}

/**
 * Memberlakukan kebijakan produk pada kontrak LEGACY secara EKSPLISIT.
 *
 * Tidak ada backfill: periode pasca jatuh tempo yang tanggal awalnya
 * sebelum `tanggalEfektif` tidak pernah diakui. Rate kontrak tidak
 * berubah. Keputusan dicatat append-only di
 * `simpanan_berjangka_penerapan_kebijakan` (siapa, kapan, versi, alasan).
 */
export async function terapkanKebijakanKeKontrakLegacy(input: {
  kontrakId: string;
  policyId: string;
  tanggalEfektif: string;
  alasan: string;
  ditetapkanOleh: string;
  createdBy: string;
}): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.tanggalEfektif)) throw new KebijakanProdukDitolakError('Tanggal efektif harus berformat YYYY-MM-DD.');
  if (!input.alasan.trim()) throw new KebijakanProdukDitolakError('Alasan penerapan wajib diisi.');
  if (!input.ditetapkanOleh.trim()) throw new KebijakanProdukDitolakError('Pihak yang menetapkan wajib diisi.');
  await withTransaction(async (db) => {
    await requirePermission(db, input.createdBy, 'pengaturan', 'edit');
    const k = await db.getFirstAsync<{ status: string; status_policy: string; nomor_transaksi: string }>(
      `SELECT status, status_policy, nomor_transaksi FROM simpanan_berjangka WHERE id = ?`,
      input.kontrakId
    );
    if (!k) throw new KebijakanProdukDitolakError('Kontrak tidak ditemukan.');
    if (k.status_policy !== 'LEGACY_POLICY_REVIEW_REQUIRED') {
      throw new KebijakanProdukDitolakError(`Kontrak ${k.nomor_transaksi} sudah memiliki kebijakan produk.`);
    }
    if (k.status !== 'AKTIF' && k.status !== 'JATUH_TEMPO') {
      throw new KebijakanProdukDitolakError(`Kontrak ${k.nomor_transaksi} sudah selesai (${k.status}).`);
    }
    const row = await db.getFirstAsync<Record<string, any>>(
      `SELECT * FROM simpanan_berjangka_kebijakan_produk WHERE id = ?`,
      input.policyId
    );
    const kebijakan = row ? petakanKebijakanProduk(row) : null;
    const tidakLayak = alasanKebijakanTidakLayak(kebijakan);
    if (tidakLayak) throw new KebijakanProdukDitolakError(tidakLayak);
    if (input.tanggalEfektif < kebijakan!.berlakuMulai) {
      throw new KebijakanProdukDitolakError(
        `Tanggal efektif tidak boleh sebelum kebijakan versi ${kebijakan!.versi} mulai berlaku (${kebijakan!.berlakuMulai}).`
      );
    }
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO simpanan_berjangka_penerapan_kebijakan
        (id, simpanan_berjangka_id, policy_id, policy_versi, tanggal_efektif, alasan, ditetapkan_oleh, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      newId(),
      input.kontrakId,
      kebijakan!.id,
      kebijakan!.versi,
      input.tanggalEfektif,
      input.alasan.trim(),
      input.ditetapkanOleh.trim(),
      input.createdBy,
      now
    );
    await db.runAsync(
      `UPDATE simpanan_berjangka
          SET policy_id = ?, policy_versi = ?, policy_auto_renewal = ?, policy_bunga_pasca_aktif = ?,
              policy_rate_pasca_jatuh_tempo = ?, policy_basis_rate = ?, policy_metode_periode = ?,
              policy_bunga_dikreditkan_ke = ?, policy_kapitalisasi_bunga = 0, policy_pokok_tetap = 1,
              policy_pasca_mulai_efektif = ?, status_policy = 'LEGACY_POLICY_DITERAPKAN', updated_at = ?
        WHERE id = ? AND policy_id IS NULL`,
      kebijakan!.id,
      kebijakan!.versi,
      kebijakan!.autoRenewal ? 1 : 0,
      kebijakan!.bungaPascaJatuhTempoAktif ? 1 : 0,
      kebijakan!.bungaPascaJatuhTempoAktif ? kebijakan!.ratePascaJatuhTempo : null,
      kebijakan!.basisRate,
      kebijakan!.metodePeriode,
      kebijakan!.bungaDikreditkanKe,
      input.tanggalEfektif,
      now,
      input.kontrakId
    );
  });
}

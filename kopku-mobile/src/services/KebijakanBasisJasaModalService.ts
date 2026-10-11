import * as SQLite from 'expo-sqlite';
import { getDb, withTransaction } from '@/database/db';
import { requirePermission } from '@/services/PermissionService';
import { newId } from '@/utils/id';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { bulanBerikut } from '@/accounting/BungaSimpananSukarela';
import { kebijakanUntukBulan, listVersiKebijakanBunga, type VersiKebijakanBunga } from '@/services/BungaSukarelaService';

/**
 * KEBIJAKAN "SIMPANAN SUKARELA SEBAGAI BASIS JASA MODAL SHU" — PER TAHUN BUKU.
 * ============================================================
 * Juklat SOM 2025 (hlm. 28 & 32): balas jasa modal berasal dari simpanan
 * pokok dan simpanan wajib. Kebijakan ini menentukan apakah simpanan
 * sukarela (termasuk bunga yang sudah dikreditkan) ikut dasar jasa modal.
 *
 *   - Versi APPEND-ONLY di `kebijakan_basis_jasa_modal`. Nilai untuk tahun
 *     buku T = versi dengan `berlaku_mulai_tahun` terbesar <= T.
 *   - Tanpa versi = OFF (instalasi baru, mengikuti Juklat). Migrasi v78
 *     menulis versi (0, ON) untuk instalasi lama — perilaku lama tetap.
 *   - SNAPSHOT per tahun buku di `shu_konfigurasi.sukarela_basis_jasa_modal`,
 *     diisi saat SHU tahun itu PERTAMA kali dihitung. Hitung ulang &
 *     pengesahan memakai snapshot, jadi perubahan kebijakan sesudahnya
 *     tidak pernah mengubah tahun buku tersebut.
 *   - Versi baru hanya boleh berlaku mulai tahun buku yang SHU-nya belum
 *     pernah dihitung (tahun berjalan bila belum, selebihnya tahun depan).
 *
 * REDESIGN KEBIJAKAN TUNGGAL (RC-S93)
 * ------------------------------------------------------------
 * Pengurus hanya mengatur SATU kebijakan: Bunga Simpanan Sukarela ON/OFF
 * (`bunga_sukarela_kebijakan`, satu-satunya sumber kebenaran status bunga).
 * Toggle terpisah "Sukarela sebagai Basis Jasa Modal SHU" DIHAPUS dari UI.
 * Perlakuan SHU untuk tahun buku T kini DITURUNKAN:
 *
 *   bunga aktif pada salah satu bulan tahun buku T
 *        -> sukarela TIDAK ikut basis jasa modal (tidak ada imbal ganda:
 *           bunga harian + jasa modal atas saldo yang sama);
 *   bunga tidak aktif sepanjang tahun buku T
 *        -> mengikuti kebijakan pembagian SHU koperasi yang sudah ada
 *           (`kebijakan_basis_jasa_modal`: versi migrasi v78 untuk
 *           instalasi lama, tanpa versi = pokok + wajib saja). OFF TIDAK
 *           memaksa sukarela ikut.
 *
 * Hasil turunan itu tetap DISIMPAN sebagai snapshot per tahun buku saat
 * SHU pertama kali dihitung (`tentukanSnapshotBasisJasaModal`) — kolom
 * `shu_konfigurasi.sukarela_basis_jasa_modal` bukan lagi setting manual
 * melainkan hasil turunan yang dikunci. Snapshot yang sudah ada tidak
 * pernah diubah.
 */

export interface VersiBasisJasaModal {
  id: string;
  berlakuMulaiTahun: number;
  sukarelaIkut: boolean;
  createdAt: string;
}

export async function listVersiBasisJasaModal(dbParam?: SQLite.SQLiteDatabase): Promise<VersiBasisJasaModal[]> {
  const db = dbParam ?? (await getDb());
  const rows = await db.getAllAsync<{ id: string; berlaku_mulai_tahun: number; sukarela_ikut: number; created_at: string }>(
    `SELECT id, berlaku_mulai_tahun, sukarela_ikut, created_at FROM kebijakan_basis_jasa_modal
      ORDER BY berlaku_mulai_tahun, created_at`
  );
  return rows.map((r) => ({ id: r.id, berlakuMulaiTahun: r.berlaku_mulai_tahun, sukarelaIkut: r.sukarela_ikut === 1, createdAt: r.created_at }));
}

/** Murni: nilai kebijakan untuk tahun buku T dari daftar versi (urut naik). */
export function basisJasaModalUntukTahun(versi: readonly VersiBasisJasaModal[], tahun: number): boolean {
  let hasil = false;
  for (const v of versi) if (v.berlakuMulaiTahun <= tahun) hasil = v.sukarelaIkut;
  return hasil;
}

/** Murni: apakah bunga sukarela aktif pada salah satu bulan rentang [mulai, selesai] (YYYY-MM). */
export function bungaAktifDalamRentang(versi: readonly VersiKebijakanBunga[], bulanMulai: string, bulanSelesai: string): boolean {
  for (let m = bulanMulai, i = 0; m <= bulanSelesai && i < 36; m = bulanBerikut(m), i++) {
    if (kebijakanUntukBulan(versi, m)?.aktif) return true;
  }
  return false;
}

/**
 * Murni: aturan turunan kebijakan tunggal.
 * Bunga aktif -> sukarela tidak ikut. Bunga tidak aktif -> kebijakan SHU koperasi apa adanya.
 */
export function turunkanSukarelaIkutBasis(p: { bungaAktifDiTahunBuku: boolean; kebijakanShuSukarelaIkut: boolean }): boolean {
  return p.bungaAktifDiTahunBuku ? false : p.kebijakanShuSukarelaIkut;
}

/** Rentang bulan tahun buku T: dari `accounting_period` bila ada, selain itu Januari–Desember. */
async function rentangBulanTahunBuku(db: SQLite.SQLiteDatabase, tahun: number): Promise<[string, string]> {
  const p = await db.getFirstAsync<{ periode_mulai: string; periode_selesai: string }>(
    `SELECT periode_mulai, periode_selesai FROM accounting_period WHERE tahun_buku = ?`,
    tahun
  );
  return p ? [p.periode_mulai.slice(0, 7), p.periode_selesai.slice(0, 7)] : [`${tahun}-01`, `${tahun}-12`];
}

export type SumberPerlakuanShu = 'SNAPSHOT' | 'BUNGA_AKTIF' | 'KEBIJAKAN_SHU';

export interface PerlakuanShuSukarela {
  tahunBuku: number;
  /** true = sukarela ikut basis jasa modal. */
  sukarelaIkut: boolean;
  /** SNAPSHOT = tahun buku sudah dikunci saat SHU dihitung. */
  sumber: SumberPerlakuanShu;
}

/** Perlakuan turunan (belum dikunci) untuk tahun buku T. */
async function turunanUntukTahun(db: SQLite.SQLiteDatabase, tahun: number): Promise<{ sukarelaIkut: boolean; bungaAktif: boolean }> {
  const [mulai, selesai] = await rentangBulanTahunBuku(db, tahun);
  const bungaAktif = bungaAktifDalamRentang(await listVersiKebijakanBunga(db), mulai, selesai);
  const kebijakanShu = basisJasaModalUntukTahun(await listVersiBasisJasaModal(db), tahun);
  return { bungaAktif, sukarelaIkut: turunkanSukarelaIkutBasis({ bungaAktifDiTahunBuku: bungaAktif, kebijakanShuSukarelaIkut: kebijakanShu }) };
}

/** Nilai turunan untuk tahun buku T (dipakai saat snapshot dibentuk). */
export async function getSukarelaIkutJasaModalTahun(tahun: number, dbParam?: SQLite.SQLiteDatabase): Promise<boolean> {
  const db = dbParam ?? (await getDb());
  return (await turunanUntukTahun(db, tahun)).sukarelaIkut;
}

/** Untuk tampilan read-only: snapshot bila tahun buku sudah dikunci, selain itu hasil turunan. */
export async function getPerlakuanShuSukarela(tahun: number, dbParam?: SQLite.SQLiteDatabase): Promise<PerlakuanShuSukarela> {
  const db = dbParam ?? (await getDb());
  const snap = await db.getFirstAsync<{ s: number | null }>(
    `SELECT sukarela_basis_jasa_modal AS s FROM shu_konfigurasi WHERE tahun_buku = ? AND sukarela_basis_jasa_modal IS NOT NULL`,
    tahun
  );
  if (snap && (snap.s === 0 || snap.s === 1)) return { tahunBuku: tahun, sukarelaIkut: snap.s === 1, sumber: 'SNAPSHOT' };
  const t = await turunanUntukTahun(db, tahun);
  return { tahunBuku: tahun, sukarelaIkut: t.sukarelaIkut, sumber: t.bungaAktif ? 'BUNGA_AKTIF' : 'KEBIJAKAN_SHU' };
}

/** Teks konsekuensi untuk pengurus (read-only, bukan setting). */
export const TEKS_PERLAKUAN_SHU_ON =
  'Perlakuan SHU: Simpanan Sukarela tidak diperhitungkan sebagai basis jasa modal selama kebijakan bunga aktif.';
export const TEKS_PERLAKUAN_SHU_OFF = 'Perlakuan SHU: mengikuti kebijakan pembagian SHU koperasi.';
export function teksPerlakuanShu(bungaAktif: boolean): string {
  return bungaAktif ? TEKS_PERLAKUAN_SHU_ON : TEKS_PERLAKUAN_SHU_OFF;
}
export function teksSnapshotShu(p: PerlakuanShuSukarela): string | null {
  if (p.sumber !== 'SNAPSHOT') return null;
  return `Tahun buku ${p.tahunBuku} sudah dikunci saat SHU dihitung: Simpanan Sukarela ${
    p.sukarelaIkut ? 'diperhitungkan' : 'tidak diperhitungkan'
  } sebagai basis jasa modal. Perubahan kebijakan tidak mengubah tahun buku ini.`;
}

/**
 * Snapshot untuk satu baris `shu_konfigurasi`. Bila belum ada, ditentukan
 * dari kebijakan TURUNAN tahun buku itu (bunga sukarela + kebijakan SHU
 * koperasi, lihat `turunkanSukarelaIkutBasis`) lalu DISIMPAN (sekali). WAJIB dipanggil
 * di dalam transaksi perhitungan SHU.
 */
export async function tentukanSnapshotBasisJasaModal(
  db: SQLite.SQLiteDatabase,
  konfigurasi: { id: string; tahun_buku: number; sukarela_basis_jasa_modal?: number | null }
): Promise<boolean> {
  if (konfigurasi.sukarela_basis_jasa_modal === 0 || konfigurasi.sukarela_basis_jasa_modal === 1) {
    return konfigurasi.sukarela_basis_jasa_modal === 1;
  }
  const ikut = await getSukarelaIkutJasaModalTahun(konfigurasi.tahun_buku, db);
  await db.runAsync(`UPDATE shu_konfigurasi SET sukarela_basis_jasa_modal = ? WHERE id = ?`, ikut ? 1 : 0, konfigurasi.id);
  return ikut;
}

/** Tahun buku paling awal yang masih boleh diberi versi baru. */
export async function tahunMinimumVersiBaru(dbParam?: SQLite.SQLiteDatabase): Promise<number> {
  const db = dbParam ?? (await getDb());
  const tahunIni = Number(getTanggalLokalHariIni().slice(0, 4));
  const terkunci = await db.getFirstAsync<{ t: number | null }>(
    `SELECT MAX(tahun_buku) AS t FROM shu_konfigurasi WHERE sukarela_basis_jasa_modal IS NOT NULL`
  );
  return Math.max(tahunIni, (terkunci?.t ?? 0) + 1);
}

/**
 * @deprecated Sejak RC-S93 tidak ada pemanggil UI. Tabel ini kini hanya
 * mewakili kebijakan pembagian SHU koperasi yang SUDAH ADA (dipakai bila
 * bunga sukarela tidak aktif sepanjang tahun buku). Dipertahankan untuk
 * kompatibilitas data & pengujian; bila kelak dibutuhkan pengaturan SHU
 * sesuai AD/ART, tempatnya di modul SHU, bukan di layar bunga.
 */
export async function simpanVersiBasisJasaModal(userId: string, sukarelaIkut: boolean, berlakuMulaiTahun: number): Promise<void> {
  await withTransaction(async (db) => {
    await requirePermission(db, userId, 'pengaturan', 'edit');
    const minimum = await tahunMinimumVersiBaru(db);
    if (!Number.isInteger(berlakuMulaiTahun) || berlakuMulaiTahun < minimum) {
      throw new Error(`Perubahan hanya berlaku ke depan: paling awal tahun buku ${minimum}.`);
    }
    await db.runAsync(
      `INSERT INTO kebijakan_basis_jasa_modal (id, berlaku_mulai_tahun, sukarela_ikut, created_by, created_at) VALUES (?,?,?,?,?)`,
      newId(),
      berlakuMulaiTahun,
      sukarelaIkut ? 1 : 0,
      userId,
      new Date().toISOString()
    );
  });
}

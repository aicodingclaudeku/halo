import { getDb } from '@/database/db';
import {
  LaporanLpea,
  ParameterLpea,
  parameterLpeaKosong,
  rakitLaporanLpea,
} from '@/reports/LpeaPlan';
import {
  bacaParameterLpea,
  bagianShuAnggota,
  rincianBagianShuAnggota,
  simpanParameterLpea,
  susunKomponenLpea,
  type RincianShuAnggotaLpea,
} from '@/reports/LpeaRepository';

/**
 * RC-S101 — LAYANAN LPEA untuk lapisan UI.
 *
 * Hanya menyambungkan koneksi database ke mesin murni (`LpeaPlan`) dan
 * pengambil data (`LpeaRepository`). TIDAK ADA rumus di sini.
 */

export interface LaporanLpeaLengkap {
  laporan: LaporanLpea;
  /** Rincian per anggota dari pembagian SHU yang sudah diproses; kosong bila belum. */
  rincianShu: RincianShuAnggotaLpea[];
}

/**
 * Susun LPEA satu tahun buku.
 *
 * Periode mengikuti tahun buku penuh (1 Januari–31 Desember), sesuai
 * butir 5.8 angka 1 naskah: "manfaat ekonomi yang diperoleh anggota
 * Koperasi selama 1 TAHUN tertentu". Basis pinjaman/simpanan dibaca
 * sampai akhir periode; bagian SHU dibaca dari pembagian tahun buku itu.
 */
export async function getLpea(tahunBuku: number): Promise<LaporanLpeaLengkap> {
  const db = await getDb();
  const tanggalMulai = `${tahunBuku}-01-01`;
  const tanggalSelesai = `${tahunBuku}-12-31`;

  const parameter = (await bacaParameterLpea(db, tahunBuku)) ?? parameterLpeaKosong(tahunBuku);
  const [komponen, bagianShu, rincianShu] = await Promise.all([
    susunKomponenLpea(db, tanggalSelesai, parameter),
    bagianShuAnggota(db, tahunBuku),
    rincianBagianShuAnggota(db, tahunBuku),
  ]);

  return {
    laporan: rakitLaporanLpea({
      tahunBuku,
      tanggalMulai,
      tanggalSelesai,
      parameter,
      komponen,
      bagianShu,
    }),
    rincianShu,
  };
}

/** Baca parameter tarif; `null` berarti belum pernah diisi untuk tahun itu. */
export async function getParameterLpea(tahunBuku: number): Promise<ParameterLpea | null> {
  const db = await getDb();
  return bacaParameterLpea(db, tahunBuku);
}

/**
 * Simpan parameter tarif pembanding.
 *
 * Jam ASLI dipakai untuk `diperbaruiPada` (bukan jam simulasi Mode
 * Pengujian Waktu): ini jejak "kapan koperasi menetapkan asumsi ini",
 * dan harus tetap terbaca benar walau jam aplikasi sedang digeser untuk
 * pengujian — alasan yang sama dipakai `createBackup` & riwayat import.
 */
export async function setParameterLpea(parameter: ParameterLpea): Promise<void> {
  const db = await getDb();
  await simpanParameterLpea(db, parameter, new Date().toISOString());
}

/**
 * Tahun buku yang punya data untuk LPEA — dipakai filter periode.
 *
 * Diambil dari `accounting_period` (sumber tahun buku yang sudah dipakai
 * seluruh laporan lain), digabung dengan tahun yang punya konfigurasi
 * SHU, supaya tahun yang SHU-nya sudah dibagikan tidak pernah hilang
 * dari daftar walau periodenya sudah ditutup.
 */
export async function getTahunBukuTersedia(): Promise<number[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ tahun: number }>(
    `SELECT tahun_buku AS tahun FROM accounting_period
     UNION
     SELECT tahun_buku AS tahun FROM shu_konfigurasi
     ORDER BY tahun DESC`
  );
  return rows.map((r) => Number(r.tahun)).filter((t) => Number.isFinite(t));
}

export type { RincianShuAnggotaLpea };
export {
  LABEL_KOMPONEN_PEA,
  LABEL_KELOMPOK_PEA,
  LABEL_PARAMETER_LPEA,
  LABEL_STATUS_KOMPONEN,
  KETERBATASAN_STRUKTURAL,
  URUTAN_KOMPONEN_PEA,
  parameterLpeaKosong,
  type HasilKomponenPea,
  type KomponenPea,
  type LaporanLpea,
  type ParameterLpea,
  type StatusKomponenPea,
} from '@/reports/LpeaPlan';

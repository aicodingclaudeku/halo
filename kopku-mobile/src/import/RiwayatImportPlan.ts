import type { HasilImportDataAwal } from './EksekusiImportDataAwal';

/**
 * RC-S100 — ATURAN PENYAJIAN RIWAYAT IMPORT (MODUL MURNI).
 *
 * Tanpa import database maupun modul native, supaya penurunan status dan
 * pelabelannya bisa diuji langsung — konvensi yang sama dengan
 * `ResetDataPlan` dan `ExcelDataAwalParser`.
 */

export type StatusRiwayatImport = 'BERHASIL' | 'SEBAGIAN' | 'GAGAL';

/**
 * Status satu kali import diturunkan HANYA dari dua angka: berapa baris
 * berhasil dan berapa gagal.
 *
 *   gagal = 0  dan berhasil > 0  -> BERHASIL
 *   berhasil > 0 dan gagal > 0   -> SEBAGIAN  (inilah kasus yang paling
 *                                  perlu terlihat: sebagian data MASUK,
 *                                  sisanya tidak — kalau disebut "gagal"
 *                                  begitu saja, pengguna bisa mengimpor
 *                                  ulang berkas yang sama dan membuat
 *                                  data ganda)
 *   berhasil = 0                 -> GAGAL
 *
 * Import dari berkas yang tidak berisi satu baris pun (berhasil 0 dan
 * gagal 0) juga GAGAL, bukan BERHASIL: tidak ada yang masuk, jadi
 * menyebutnya berhasil menyesatkan.
 */
export function turunkanStatusRiwayat(totalBerhasil: number, totalGagal: number): StatusRiwayatImport {
  if (totalBerhasil <= 0) return 'GAGAL';
  return totalGagal > 0 ? 'SEBAGIAN' : 'BERHASIL';
}

export function statusDariHasil(hasil: HasilImportDataAwal): StatusRiwayatImport {
  return turunkanStatusRiwayat(hasil.totalBerhasil, hasil.totalGagal);
}

export const LABEL_STATUS_RIWAYAT: Record<StatusRiwayatImport, string> = {
  BERHASIL: 'Berhasil',
  SEBAGIAN: 'Berhasil sebagian',
  GAGAL: 'Gagal',
};

export const KETERANGAN_STATUS_RIWAYAT: Record<StatusRiwayatImport, string> = {
  BERHASIL: 'Seluruh baris pada berkas berhasil dimasukkan.',
  // RC-S133.6.2 — sejak v81 baris yang sudah masuk dikenali dari sidik isinya
  // dan DILEWATI saat berkas yang sama diimpor ulang.
  SEBAGIAN:
    'Sebagian baris MASUK, sebagian gagal. Perbaiki baris yang gagal lalu impor ulang berkas yang sama: baris yang sudah masuk dikenali dan dilewati, sehingga tidak menggandakan data.',
  GAGAL: 'Tidak ada satu pun baris yang masuk.',
};

/**
 * RC-S133.6.4 — peringatan syarat pinjaman pada baris yang BERHASIL.
 *
 * Pinjaman historis dari import data awal tidak ditolak bila syarat
 * pengajuan (simpanan pokok/wajib, saldo minimum, batas pinjaman, batas
 * tunggakan) tidak terpenuhi PADA TANGGAL PINJAMAN; baris tetap berhasil,
 * dan alasannya dicatat di kolom `pesan` log baris tersebut (kolom itu
 * sebelumnya hanya terisi untuk baris GAGAL) — tanpa perubahan skema.
 */
export const AWALAN_PERINGATAN_SYARAT = 'Peringatan syarat pinjaman pada tanggal pinjaman: ';

export function pesanPeringatanSyarat(alasan: readonly string[]): string {
  return AWALAN_PERINGATAN_SYARAT + alasan.join(' ');
}

/** Baris log yang BERHASIL tetapi membawa peringatan syarat pinjaman. */
export function adalahPeringatanSyarat(b: { status: string; pesan: string | null }): boolean {
  return b.status === 'BERHASIL' && !!b.pesan && b.pesan.startsWith(AWALAN_PERINGATAN_SYARAT);
}

export type FilterLogRiwayat = 'SEMUA' | 'BERHASIL' | 'GAGAL';

export const LABEL_FILTER_LOG: Record<FilterLogRiwayat, string> = {
  SEMUA: 'Semua',
  BERHASIL: 'Berhasil',
  GAGAL: 'Gagal',
};

/**
 * Baris log apa adanya seperti tersimpan — dipakai bersama oleh service
 * dan layar supaya bentuknya satu.
 */
export interface BarisLogRiwayat {
  id: string;
  jenisSheet: string;
  baris: number;
  keterangan: string;
  status: 'BERHASIL' | 'GAGAL';
  pesan: string | null;
}

/**
 * Penyaringan log di layar. Sengaja fungsi MURNI dan bukan kueri SQL
 * baru per filter: seluruh log satu import sudah dimuat, jadi berpindah
 * tab tidak menyentuh database lagi, dan aturannya bisa diuji.
 *
 * Urutan dipertahankan apa adanya (urutan proses import), TIDAK diurut
 * ulang — pengguna mencocokkannya dengan nomor baris di berkas Excel.
 */
export function saringLogRiwayat(
  log: BarisLogRiwayat[],
  filter: FilterLogRiwayat
): BarisLogRiwayat[] {
  if (filter === 'SEMUA') return log;
  return log.filter((b) => b.status === filter);
}

/**
 * Ringkasan satu kali import untuk kartu di daftar riwayat. `namaBerkas`
 * boleh null (berkas dipilih lewat pemilih sistem yang tidak selalu
 * memberi nama) — pemanggil menampilkan teks gantinya, bukan "null".
 */
export interface RingkasanRiwayatImport {
  id: string;
  dijalankanPada: string;
  dijalankanOleh: string;
  namaBerkas: string | null;
  status: StatusRiwayatImport;
  totalBaris: number;
  totalBerhasil: number;
  totalGagal: number;
  /** RC-S133.6.2 — baris yang dilewati karena sudah pernah diimpor (0 untuk riwayat sebelum v81). */
  totalDilewati?: number;
  perSheet: { jenis: string; label: string; berhasil: number; gagal: number; dilewati?: number; rincianDilewati?: { baris: number; keterangan: string; pesan: string }[] }[];
}

/**
 * RC-S74 — gerbang tampilan & tombol "Utang Bunga" di form Bayar Kewajiban.
 * MURNI (tanpa I/O, tanpa perhitungan bunga, tanpa akuntansi) — hanya
 * `import type` dari service — supaya tabel kebenarannya dapat diuji langsung.
 *
 * DUA KONSEP YANG TERPISAH (final interest status hardening):
 *
 *  A. DATA READINESS (`tahap`, milik layar)
 *     MEMUAT          sedang menunggu tugas startup / membaca read-model
 *     SIAP            pembacaan status bunga BERHASIL selesai
 *     TIDAK_TERSEDIA  pembacaan gagal / utang tidak ada di read-model
 *     AKRUAL_GAGAL    (hotfix) tugas selesai, tetapi mesin akrual otomatis
 *                     GAGAL untuk utang ini -> angka yang terbaca BASI,
 *                     bukan hasil akuntansi final (tidak pernah tampil Rp0)
 *
 *  B. ACCOUNTING STATUS (`statusBunga`, milik service — dibawa APA ADANYA)
 *     TERKENDALI · MENUNGGU_PERIODE · KONTRAK_BELUM_LENGKAP · PERLU_PERHATIAN
 *
 * `SIAP` TIDAK berarti "TERKENDALI". Status accounting tidak pernah diubah
 * menjadi tahap, dan tahap tidak pernah menyembunyikan status accounting.
 *
 * Aturan tampilan (nilai):
 *   belum ada / info basi (utang lain)  -> "—"      (tombol terkunci)
 *   MEMUAT                              -> memuat   (tombol terkunci; teks dari
 *                                                   `teksMemuatBunga`, estimasi dari durasi
 *                                                   runtime NYATA StartupTasks)
 *   TIDAK_TERSEDIA / AKRUAL_GAGAL       -> "—"      (tombol terkunci)
 *   SIAP + outstanding                  -> RpX      (termasuk Rp0 final yang sah)
 *   kontrak 0% (tidak berbunga)         -> "Tidak berbunga"
 * Aturan tombol: readiness saja. SIAP (status accounting APA PUN) atau tidak
 * berbunga atau utang usaha -> validasi transaksi normal; selain itu terkunci.
 */
import type { StatusBungaUtang, StatusBungaUtangDetail, HasilProsesAkrualOtomatis } from '@/services/UtangBungaAccrualService';
import { formatRupiah } from '@/utils/money';

/** State yang disimpan layar untuk satu utang (diikat ke `utangId`). */
export type InfoBunga =
  | { utangId: string; tahap: 'MEMUAT' }
  | { utangId: string; tahap: 'SIAP'; nilai: number; statusBunga: StatusBungaUtang; pesanBunga: string | null }
  | { utangId: string; tahap: 'TIDAK_TERSEDIA' }
  | { utangId: string; tahap: 'AKRUAL_GAGAL' };

/** Tampilan yang diturunkan untuk utang terpilih. */
export type TampilanBunga =
  | InfoBunga
  | { utangId: string; tahap: 'BELUM_ADA' } // null/undefined atau info milik utang lain
  | { utangId: string; tahap: 'TIDAK_BERBUNGA' }; // kontrak 0%

export interface UtangUntukGate {
  id: string;
  jenisPemberi: string;
  persenBunga: number;
}

/**
 * Hasil baca read-model -> state layar. Status accounting & outstanding diambil
 * APA ADANYA dari service; tidak ada transformasi status, tidak ada perhitungan.
 */
export function infoDariDetail(
  utangId: string,
  detail: Pick<StatusBungaUtangDetail, 'status' | 'outstandingBunga' | 'pesan'> | null | undefined,
  akrualGagal = false
): InfoBunga {
  if (!detail) return { utangId, tahap: 'TIDAK_TERSEDIA' };
  // HOTFIX RC-S74 §13 — mesin gagal: angka yang terbaca adalah sisa keadaan
  // SEBELUM akrual, bukan hasil akuntansi final. Jangan pernah jadi SIAP.
  if (akrualGagal) return { utangId, tahap: 'AKRUAL_GAGAL' };
  return { utangId, tahap: 'SIAP', nilai: detail.outstandingBunga, statusBunga: detail.status, pesanBunga: detail.pesan ?? null };
}

/**
 * HOTFIX RC-S74 §13 — apakah eksekusi mesin akrual TERAKHIR gagal untuk utang
 * ini. Sumber: hasil yang sudah dikembalikan mesin (`getHasilAkrualBungaUtangTerakhir()`,
 * dibaca layar), BUKAN pemicu baru. `null` = mesin belum berjalan dalam proses
 * ini -> tidak ada bukti kegagalan.
 *
 *   dijalankan === false            -> MESIN_GAGAL (seluruh batch gagal)
 *   exception KEGAGALAN_TEKNIS utang -> gagal untuk utang ini saja
 * Kondisi data (kontrak belum lengkap, periode tertutup, akrual dibalik) BUKAN
 * kegagalan — itu status accounting yang tetap ditampilkan apa adanya.
 */
export function akrualBungaGagalUntuk(
  utangId: string,
  hasil: Pick<HasilProsesAkrualOtomatis, 'dijalankan' | 'exception'> | null | undefined
): boolean {
  if (!hasil) return false;
  if (!hasil.dijalankan) return true;
  return hasil.exception.some((e) => e.utangId === utangId && e.kode === 'KEGAGALAN_TEKNIS');
}

/** Tampilan bunga untuk utang terpilih (null = tidak ada baris bunga: utang usaha / belum memilih). */
export function infoBungaUntuk(utang: UtangUntukGate | null, info: InfoBunga | null | undefined): TampilanBunga | null {
  if (!utang || utang.jenisPemberi === 'UTANG_USAHA') return null;
  if (!(utang.persenBunga > 0)) return { utangId: utang.id, tahap: 'TIDAK_BERBUNGA' };
  if (!info || info.utangId !== utang.id) return { utangId: utang.id, tahap: 'BELUM_ADA' };
  return info;
}

/** Readiness gate tombol bayar utang — TIDAK memakai status accounting. */
export function bungaSiapUntukBayar(utang: UtangUntukGate | null, info: InfoBunga | null | undefined): boolean {
  if (!utang) return false;
  if (utang.jenisPemberi === 'UTANG_USAHA') return true;
  const tampil = infoBungaUntuk(utang, info);
  return tampil?.tahap === 'SIAP' || tampil?.tahap === 'TIDAK_BERBUNGA';
}

/** Teks nilai "Utang Bunga". Rp0 hanya mungkin dari SIAP (nilai final yang dibaca). */
export function teksNilaiBunga(tampil: TampilanBunga): string {
  switch (tampil.tahap) {
    case 'SIAP':
      return formatRupiah(tampil.nilai);
    case 'MEMUAT':
      return TEKS_MEMUAT_AWAL;
    case 'TIDAK_BERBUNGA':
      return 'Tidak berbunga';
    default:
      return '—'; // TIDAK_TERSEDIA, AKRUAL_GAGAL & BELUM_ADA: tidak pernah Rp0
  }
}

// ===========================================================================
// HOTFIX RC-S74 — ESTIMASI REAL-TIME SAAT AKRUAL BERJALAN
// ===========================================================================
//
// Estimasi = rata-rata durasi AKTUAL batch StartupTasks sebelumnya
// (`getStatusTugasStartup().estimasiMs`), dikurangi waktu yang SUDAH berjalan
// sejak batch yang sekarang mulai. Tidak ada angka tetap di sini.
//
// Estimasi hanya TEKS. Selesai/tidaknya proses tetap ditentukan promise
// `tungguTugasStartupSelesai()` di layar: estimasi yang habis tidak
// membatalkan, mengulang, atau memaksa hasil apa pun.

/** Teks pertama yang terlihat saat bunga sedang diproses. */
export const TEKS_MEMUAT_AWAL = 'Menghitung otomatis…';
/** Proses berjalan tetapi belum ada durasi historis (mis. aplikasi baru dibuka). */
export const TEKS_ESTIMASI_TANPA_RIWAYAT = 'Estimasi beberapa detik';
/** Estimasi terlampaui tetapi proses belum selesai — tidak pernah angka negatif. */
export const TEKS_MELEWATI_ESTIMASI = 'Proses masih berjalan…';
/** Penjelasan singkat, hanya saat proses latar benar-benar berjalan. */
export const TEKS_PENJELASAN_PROSES = 'Proses ini dijalankan otomatis untuk memperbarui akrual bunga.';

/** Potret proses latar yang sedang ditunggu layar (null = tidak ada proses berjalan). */
export interface ProsesLatarBunga {
  /** Kapan batch yang sedang berjalan dimulai (ms epoch). */
  mulaiMs: number;
  /** Rata-rata durasi aktual batch sebelumnya; null = belum ada riwayat. */
  estimasiMs: number | null;
}

/** Sisa estimasi dalam detik penuh (dibulatkan ke atas), tidak pernah negatif. */
export function hitungSisaEstimasiDetik(estimasiMs: number, berjalanMs: number): number {
  return Math.max(0, Math.ceil((estimasiMs - berjalanMs) / 1000));
}

export interface TeksMemuatBunga {
  judul: string;
  /** Baris estimasi; null bila tidak ada proses latar (hanya membaca read-model). */
  estimasi: string | null;
  /** Penjelasan proses otomatis; null bila tidak ada proses latar. */
  penjelasan: string | null;
}

/**
 * Teks loading "Utang Bunga".
 *
 *   tanpa proses latar                -> judul saja (pembacaan singkat)
 *   proses, tanpa riwayat durasi      -> "Estimasi beberapa detik"
 *   proses, sisa >= 1 detik           -> "Estimasi selesai dalam ±N detik"
 *   proses, estimasi terlampaui       -> "Proses masih berjalan…"
 */
export function teksMemuatBunga(proses: Pick<ProsesLatarBunga, 'estimasiMs'> | null, berjalanMs: number): TeksMemuatBunga {
  if (!proses) return { judul: TEKS_MEMUAT_AWAL, estimasi: null, penjelasan: null };
  const berjalan = Number.isFinite(berjalanMs) && berjalanMs > 0 ? berjalanMs : 0;
  const est = proses.estimasiMs;
  let estimasi: string;
  if (est === null || !Number.isFinite(est) || est <= 0) {
    estimasi = TEKS_ESTIMASI_TANPA_RIWAYAT;
  } else {
    const sisa = hitungSisaEstimasiDetik(est, berjalan);
    estimasi = sisa > 0 ? `Estimasi selesai dalam ±${sisa} detik` : TEKS_MELEWATI_ESTIMASI;
  }
  return { judul: TEKS_MEMUAT_AWAL, estimasi, penjelasan: TEKS_PENJELASAN_PROSES };
}

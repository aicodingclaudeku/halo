import type { LicenseType } from '@/config/license';

/**
 * ============================================================
 * COUNTDOWN LISENSI — PRESENTASI SAJA (RC-S49b §C/§D)
 * ============================================================
 *
 * Berkas ini TIDAK memutuskan apa pun tentang lisensi.
 *
 * Ia tidak membaca token, tidak menyentuh SecureStore, tidak memanggil
 * server, tidak mengenal Ed25519, dan tidak pernah menyimpulkan "boleh
 * masuk aplikasi atau tidak". Ia hanya mengubah dua angka — `expiresAt`
 * dan waktu sekarang — menjadi kalimat berbahasa Indonesia.
 *
 * Pemisahan ini disengaja dan penting:
 *
 *     LicenseService  = sumber kebenaran (getLicenseStatus)
 *     LicenseGate     = penegakan (mengunci aplikasi)
 *     berkas ini      = tampilan
 *
 * Selama pembagian itu dijaga, tidak ada cara bagi kode countdown untuk
 * memperpanjang, memperpendek, atau memalsukan masa berlaku lisensi:
 * angka `expiresAt`-nya datang dari token bertanda tangan server, dan
 * satu-satunya yang bisa dilakukan berkas ini adalah salah menuliskan
 * sisa waktunya di layar.
 *
 * KARENA ITU FUNGSINYA MURNI. Tidak ada `Date.now()` di dalam sini —
 * waktu sekarang SELALU diberikan pemanggil. Itulah yang membuat
 * seluruh perilakunya dapat diuji tanpa mengarang jam palsu.
 */

const DETIK = 1000;
const MENIT = 60 * DETIK;
const JAM = 60 * MENIT;
const HARI = 24 * JAM;

/** Label yang dibaca pengguna untuk tiap tipe lisensi server. */
export const LABEL_TIPE_LISENSI: Record<LicenseType, string> = {
  PERMANENT: 'Lisensi Permanen',
  TRIAL_3D: 'Lisensi Trial 3 Hari',
  TRIAL_7D: 'Lisensi Trial 7 Hari',
  TRIAL_1M: 'Lisensi Trial 1 Bulan',
};

/**
 * Apakah tipe ini menampilkan countdown?
 *
 * §C2 — PERMANENT TIDAK PERNAH menampilkan countdown. Aturannya
 * ditulis sebagai "bukan PERMANENT", bukan sebagai daftar tiga tipe
 * trial: kalau kelak server menambah tipe berbatas waktu baru, ia
 * langsung ikut berperilaku benar alih-alih diam-diam tampil sebagai
 * lisensi tanpa batas.
 */
export function tipeLisensiPakaiCountdown(tipe: LicenseType | null): boolean {
  return tipe !== null && tipe !== 'PERMANENT';
}

/**
 * Sisa waktu dalam milidetik, dihitung dari `expiresAt` MILIK TOKEN.
 *
 * §C3 — tanggal kedaluwarsa TIDAK PERNAH dihitung ulang dari
 * "3 hari sejak sekarang" atau "7 hari sejak Dashboard dibuka". Kalau
 * ia dihitung dari saat layar dibuka, setiap pembukaan layar akan
 * memperpanjang trial — dan countdown-nya menjadi hiasan yang tidak
 * pernah mencapai nol.
 *
 * Mengembalikan `null` bila lisensi memang tanpa batas waktu
 * (`expiresAt === null`, kasus PERMANENT) atau bila nilainya tidak
 * dapat diurai. Nilai negatif TIDAK dinormalkan menjadi nol: pemanggil
 * perlu bisa membedakan "habis tepat sekarang" dari "sudah lewat".
 */
export function hitungSisaMs(expiresAt: string | null, sekarangMs: number): number | null {
  if (expiresAt === null) return null;
  const kedaluwarsaMs = Date.parse(expiresAt);
  if (!Number.isFinite(kedaluwarsaMs)) return null;
  return kedaluwarsaMs - sekarangMs;
}

/**
 * Sisa waktu sebagai kalimat, sesuai format yang diminta §C1:
 *
 *     >= 24 jam : "2 hari 14 jam 32 menit"
 *     <  24 jam : "13 jam 42 menit"
 *     <   1 jam : "42 menit 15 detik"
 *     <=      0 : "Sudah berakhir"
 *
 * Satuan yang lebih besar sengaja TIDAK disembunyikan ketika bernilai
 * nol pada dua format teratas ("1 hari 0 jam 5 menit"), supaya panjang
 * teksnya stabil dan angkanya tidak tampak melompat-lompat tiap detik.
 */
export function formatSisaWaktu(sisaMs: number): string {
  if (sisaMs <= 0) return 'Sudah berakhir';

  if (sisaMs >= HARI) {
    const hari = Math.floor(sisaMs / HARI);
    const jam = Math.floor((sisaMs % HARI) / JAM);
    const menit = Math.floor((sisaMs % JAM) / MENIT);
    return `${hari} hari ${jam} jam ${menit} menit`;
  }

  if (sisaMs >= JAM) {
    const jam = Math.floor(sisaMs / JAM);
    const menit = Math.floor((sisaMs % JAM) / MENIT);
    return `${jam} jam ${menit} menit`;
  }

  const menit = Math.floor(sisaMs / MENIT);
  const detik = Math.floor((sisaMs % MENIT) / DETIK);
  return `${menit} menit ${detik} detik`;
}

/**
 * Tingkat urgensi untuk pewarnaan kartu. Murni ambang tampilan — ia
 * TIDAK memengaruhi akses sama sekali; lisensi yang tersisa satu menit
 * tetap sepenuhnya sah sampai `LicenseService` menyatakan sebaliknya.
 */
export type UrgensiLisensi = 'NORMAL' | 'SEGERA_HABIS' | 'HAMPIR_HABIS' | 'BERAKHIR';

export function urgensiSisaWaktu(sisaMs: number | null): UrgensiLisensi {
  if (sisaMs === null) return 'NORMAL';
  if (sisaMs <= 0) return 'BERAKHIR';
  if (sisaMs < JAM) return 'HAMPIR_HABIS';
  if (sisaMs < HARI) return 'SEGERA_HABIS';
  return 'NORMAL';
}

/**
 * RC-S120 — HITUNGAN AREA KEYBOARD (MODUL MURNI).
 *
 * Dipisah dari `AreaAmanKeyboard.tsx` karena berkas itu mengimpor
 * `react-native`, yang tidak dapat dimuat ts-jest. Semua keputusan
 * angka ada di sini supaya dapat diuji dengan nilai sungguhan, bukan
 * hanya dibaca sebagai teks.
 *
 * Seluruh koordinat dalam SATU sumbu: koordinat jendela (dp), yaitu yang
 * dikembalikan `measureInWindow`. Di Android edge-to-edge, jendela
 * aplikasi — termasuk jendela dialog milik <Modal> — berawal di pojok
 * kiri atas layar, sehingga koordinat jendela sama dengan koordinat
 * layar yang dipakai `endCoordinates.screenY` milik event papan ketik.
 */

export interface KotakVertikal {
  /** Tepi atas, koordinat jendela. */
  y: number;
  tinggi: number;
}

/** Jarak lega antara tepi bawah input yang difokuskan dan tepi atas papan ketik. */
export const JARAK_LEGA_INPUT = 16;

function sah(k: KotakVertikal): boolean {
  return Number.isFinite(k.y) && Number.isFinite(k.tinggi) && k.tinggi > 0;
}

/**
 * Berapa jauh (dp, ke bawah) isi harus digulir supaya input yang
 * difokuskan terlihat utuh di atas papan ketik. `0` = tidak perlu.
 *
 * Batas bawah yang terlihat adalah yang LEBIH TINGGI dari dua hal: tepi
 * bawah wadah gulir, dan tepi atas papan ketik. Keduanya dihitung karena
 * dua keadaan sama-sama terjadi:
 *   - normalnya wadah sudah menyusut sampai tepi atas papan ketik, jadi
 *     keduanya berimpit;
 *   - kalau padding belum sempat terpasang (atau wadahnya memang tidak
 *     menyusut), tepi atas papan ketik yang menentukan.
 *
 * Pergeseran tidak pernah melebihi jarak yang membuat tepi ATAS input
 * keluar dari wadah. Untuk input bertingkat yang lebih tinggi dari ruang
 * yang tersisa, melihat awal teksnya lebih berguna daripada akhirnya.
 */
export function hitungGeserGulir(p: {
  input: KotakVertikal;
  wadah: KotakVertikal;
  atasKeyboard: number;
  jarak?: number;
}): number {
  const jarak = p.jarak ?? JARAK_LEGA_INPUT;
  if (!sah(p.input) || !sah(p.wadah) || !Number.isFinite(p.atasKeyboard)) return 0;

  const batasBawah = Math.min(p.wadah.y + p.wadah.tinggi, p.atasKeyboard) - jarak;
  const lebih = p.input.y + p.input.tinggi - batasBawah;
  if (!(lebih > 0)) return 0;

  const ruangAtas = p.input.y - (p.wadah.y + jarak);
  return Math.max(0, Math.min(lebih, ruangAtas));
}

/**
 * Posisi gulir TUJUAN (mutlak) dari pergeseran di atas.
 *
 * Posisi gulir saat ini tidak dibaca langsung — ScrollView tidak
 * menyediakannya secara sinkron. Ia diturunkan dari dua pengukuran
 * yang memang tersedia: letak input di dalam isi (`yDalamIsi`, dari
 * `measureLayout` terhadap isi ScrollView) dan letaknya di jendela
 * relatif terhadap wadah. Selisih keduanya adalah seberapa jauh isi
 * sudah tergulir.
 */
export function hitungTujuanGulir(p: {
  yDalamIsi: number;
  input: KotakVertikal;
  wadah: KotakVertikal;
  geser: number;
}): number | null {
  if (!Number.isFinite(p.yDalamIsi) || !(p.geser > 0)) return null;
  const sekarang = p.yDalamIsi - (p.input.y - p.wadah.y);
  if (!Number.isFinite(sekarang)) return null;
  return Math.max(0, sekarang + p.geser);
}

/**
 * Jeda sebelum padding dilepas setelah papan ketik tertutup.
 *
 * Saat fokus berpindah antar-input yang jenis papan ketiknya berbeda
 * (teks <-> angka), sebagian papan ketik Android menutup lalu membuka
 * lagi dalam hitungan milidetik. Tanpa jeda, padding ikut lepas lalu
 * terpasang lagi, dan seluruh form meloncat turun-naik sekali. Jeda
 * sependek ini tidak terasa saat papan ketik memang ditutup, karena
 * event `keyboardDidHide` baru datang setelah animasinya selesai.
 */
export const JEDA_LEPAS_PADDING_MS = 120;

/**
 * Pengukuran ulang setelah padding terpasang. Tata letak (Yoga) selesai
 * SETELAH state dikomit, jadi pengukuran di event papan ketik bisa
 * membaca bingkai yang belum final. Karena bingkai pembungkus ber-flex
 * tidak berubah oleh padding-nya sendiri, pengukuran ulang ini
 * idempoten: hasilnya sama, atau membetulkan yang meleset.
 */
export const JEDA_UKUR_ULANG_MS = 180;

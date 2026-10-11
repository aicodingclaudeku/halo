import { addDays, addMonths, addWeeks, format } from 'date-fns';

/**
 * PERHITUNGAN TANGGAL ANGSURAN — SATU SUMBER KEBENARAN (BUG-13).
 * ============================================================
 *
 * ROOT CAUSE
 * ----------
 * Sebelum modul ini, tanggal jatuh tempo dihitung DUA cara berbeda di
 * dalam fungsi yang sama:
 *
 *   Header  (`pinjaman.tanggal_jatuh_tempo`):
 *       tambahTenor(tanggalAkad, satuan, tenor)      <- SEKALI lompat
 *
 *   Jadwal  (`angsuran_jadwal.tanggal_jatuh_tempo`):
 *       tanggalAngsuran = tambahTenor(tanggalAngsuran, satuan, 1)
 *                                                    <- ITERATIF
 *
 * Untuk satuan HARI/MINGGU keduanya identik. Untuk BULAN tidak, karena
 * penambahan bulan melakukan CLAMPING ke akhir bulan:
 *
 *       31 Jan + 1 bulan = 28 Feb   (Feb tidak punya tanggal 31)
 *
 * Pada versi iteratif, hasil clamping itu menjadi basis langkah
 * berikutnya sehingga tanggalnya "terjebak":
 *
 *       31 Jan -> 28 Feb -> 28 Mar -> 28 Apr -> ... -> 28 Jan
 *
 * sementara header menghitung sekali lompat dan menghasilkan 31 Jan.
 * Akibatnya `pinjaman.tanggal_jatuh_tempo` TIDAK SAMA dengan
 * `MAX(angsuran_jadwal.tanggal_jatuh_tempo)` — dua angka resmi untuk
 * fakta yang sama, dan seluruh aging/tunggakan/denda pada angsuran
 * tengah bergeser beberapa hari.
 *
 * KONVENSI: END-OF-MONTH ANCHORED
 * -------------------------------
 * Setiap tanggal angsuran dihitung RELATIF TERHADAP TANGGAL AKAD
 * (origin) ditambah nomor angsurannya — tidak pernah relatif terhadap
 * hasil perhitungan sebelumnya. Dengan begitu clamping hanya berlaku
 * untuk bulan yang memang pendek, dan tanggal "kembali" ke tanggal
 * aslinya pada bulan-bulan berikutnya:
 *
 *       31 Jan -> 28 Feb -> 31 Mar -> 30 Apr -> 31 Mei -> ... -> 31 Jan
 *
 * WHY: anggota yang berakad pada akhir bulan mengharapkan tagihan jatuh
 * pada akhir bulan, bukan bergeser mundur permanen ke tanggal 28 karena
 * kebetulan Februari pendek.
 */

export type SatuanTenorAngsuran = 'HARI' | 'MINGGU' | 'BULAN';

/**
 * Tanggal jatuh tempo angsuran ke-`nomorAngsuran` (1-based).
 *
 * @param tanggalAkad     Tanggal akad/origin, 'YYYY-MM-DD'.
 * @param nomorAngsuran   1 = angsuran pertama. Harus >= 1.
 * @param satuan          Satuan tenor.
 * @returns               'YYYY-MM-DD'.
 */
export function calculateInstallmentDate(
  tanggalAkad: string,
  nomorAngsuran: number,
  satuan: SatuanTenorAngsuran
): string {
  if (!Number.isInteger(nomorAngsuran) || nomorAngsuran < 1) {
    throw new Error(
      `Nomor angsuran "${nomorAngsuran}" tidak valid — harus bilangan bulat >= 1.`
    );
  }
  // AUDIT F-5 — `new Date('YYYY-MM-DD')` dibaca sebagai 00:00 UTC, sedangkan
  // addDays/addMonths/format bekerja pada waktu LOKAL: di zona waktu UTC-
  // (mis. Amerika) hasilnya mundur satu hari. Tanggal kalender murni
  // dibangun dari komponen lokalnya. Perilaku untuk masukan lain (termasuk
  // tanggal tak lazim) sengaja tidak diubah.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tanggalAkad);
  let origin: Date;
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // Rentang bulan/hari di luar 1-12/1-31 ditolak seperti `new Date('YYYY-MM-DD')` lama.
    origin = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? new Date(y, mo - 1, d) : new Date(Number.NaN);
  } else {
    origin = new Date(tanggalAkad);
  }
  if (Number.isNaN(origin.getTime())) {
    throw new Error(`Tanggal akad "${tanggalAkad}" bukan tanggal yang valid.`);
  }

  // KUNCI PERBAIKAN: selalu dari `origin`, TIDAK PERNAH dari hasil
  // langkah sebelumnya. Inilah yang mencegah tanggal terjebak di 28.
  let hasil: Date;
  if (satuan === 'HARI') hasil = addDays(origin, nomorAngsuran);
  else if (satuan === 'MINGGU') hasil = addWeeks(origin, nomorAngsuran);
  else hasil = addMonths(origin, nomorAngsuran);

  return format(hasil, 'yyyy-MM-dd');
}

/**
 * Tanggal jatuh tempo AKHIR (maturity) sebuah pinjaman.
 *
 * Sengaja didefinisikan sebagai `calculateInstallmentDate(origin, tenor)`
 * — yaitu angsuran TERAKHIR — supaya secara konstruksi selalu identik
 * dengan `MAX(angsuran_jadwal.tanggal_jatuh_tempo)` untuk jadwal yang
 * dibangkitkan dari akad yang sama. Tidak ada algoritma kedua.
 */
export function calculateMaturityDate(
  tanggalAkad: string,
  tenor: number,
  satuan: SatuanTenorAngsuran
): string {
  return calculateInstallmentDate(tanggalAkad, tenor, satuan);
}

/**
 * Seluruh tanggal jatuh tempo untuk satu akad, angsuran 1..tenor.
 * Dipakai pembangkit jadwal supaya tidak ada loop tanggal manual lagi.
 */
export function calculateInstallmentDates(
  tanggalAkad: string,
  tenor: number,
  satuan: SatuanTenorAngsuran
): string[] {
  const hasil: string[] = [];
  for (let n = 1; n <= tenor; n++) {
    hasil.push(calculateInstallmentDate(tanggalAkad, n, satuan));
  }
  return hasil;
}

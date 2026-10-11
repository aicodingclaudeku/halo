/**
 * Ukuran kolom TabelGeser — dipisah dari komponen (tanpa import
 * react-native) supaya dapat diuji di Jest.
 */

/** Lebar kolom nominal — cukup untuk "-Rp9.999.999.999.999" satu baris. */
export const LEBAR_KOLOM_NILAI = 156;
/** Lebar minimum kolom nama akun/keterangan. */
export const LEBAR_KOLOM_AKUN = 196;
/** Padding horizontal baris tabel (kiri + kanan). */
export const PADDING_BARIS = 12 * 2;

export function lebarTabel(jumlahKolomNilai: number, lebarAkun = LEBAR_KOLOM_AKUN): number {
  return lebarAkun + jumlahKolomNilai * LEBAR_KOLOM_NILAI + PADDING_BARIS;
}

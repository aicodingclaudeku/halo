/**
 * RC-S114 — KODE PEMULIHAN (MODUL MURNI).
 *
 * ============================================================
 * KENAPA KODE PEMULIHAN ADA SAMA SEKALI
 * ============================================================
 * Kunci pembungkus utama disimpan di SecureStore, yang di Android
 * bersandar pada AndroidKeyStore (lihat SecureStoreModule.kt di
 * expo-secure-store). Kunci AndroidKeyStore TIDAK DAPAT DIEKSPOR: ia
 * tidak ikut pindah ke perangkat baru, tidak ikut cadangan cloud, dan
 * hilang saat aplikasi di-uninstall.
 *
 * Artinya, kalau HANYA itu jalannya, backup menjadi tidak berguna
 * tepat pada saat ia paling dibutuhkan: ponsel pengurus hilang,
 * rusak, atau diganti. Kode pemulihan adalah jalan kedua yang tidak
 * bersandar pada perangkat mana pun.
 *
 * ============================================================
 * KENAPA DIBUATKAN, BUKAN DIKETIK PENGGUNA
 * ============================================================
 * Kata sandi pilihan manusia untuk berkas yang disimpan selamanya
 * adalah titik terlemah: ia bisa ditebak secara offline tanpa batas
 * percobaan. Kode ini dibuat dari sumber acak sistem, 100 bit — di
 * luar jangkauan penebakan, berapa pun lama waktunya.
 *
 * ============================================================
 * BENTUKNYA
 * ============================================================
 *     XXXX-XXXX-XXXX-XXXX-XXXX-C
 *
 * 20 karakter data (100 bit) + 1 karakter periksa. Abjadnya Crockford
 * base32: tanpa huruf I, L, O, dan U. Tiga yang pertama dibuang karena
 * tertukar dengan 1 dan 0 saat ditulis tangan — dan kode ini memang
 * dimaksudkan untuk DITULIS TANGAN atau dicetak. `U` dibuang mengikuti
 * Crockford agar kata-kata tak sengaja terbentuk lebih jarang.
 *
 * Karakter periksa bukan keamanan, melainkan KEJUJURAN PESAN: tanpa
 * itu, satu huruf salah ketik hanya menghasilkan "gagal membuka
 * kunci", yang tidak bisa dibedakan dari "ini kode perangkat lain".
 * Dengan itu, aplikasi bisa mengatakan "kode salah ketik" dengan
 * yakin, sebelum membuang waktu menjalankan scrypt.
 */

export const ABJAD_KODE = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: tanpa I, L, O, U
export const PANJANG_DATA_KODE = 20; // 20 x 5 bit = 100 bit
export const UKURAN_GRUP_KODE = 4;

/** Salah ketik yang paling sering terjadi saat menyalin kode tulisan tangan. */
const PEMBETULAN: Record<string, string> = { I: '1', L: '1', O: '0', U: 'V' };

/**
 * Karakter periksa: jumlah nilai semua karakter data, modulo 32.
 * Sederhana dan cukup — ia menangkap setiap salah-satu-karakter, yaitu
 * kesalahan yang hendak dibedakan.
 */
export function karakterPeriksa(data: string): string {
  let jumlah = 0;
  for (const c of data) {
    const nilai = ABJAD_KODE.indexOf(c);
    if (nilai < 0) throw new Error(`Karakter "${c}" bukan bagian dari abjad kode pemulihan.`);
    jumlah += nilai;
  }
  return ABJAD_KODE[jumlah % 32];
}

/**
 * Susun kode pemulihan dari 13 byte acak (104 bit; 100 bit dipakai).
 * Byte-nya disediakan pemanggil supaya modul ini tetap murni dan
 * hasilnya dapat diuji dengan masukan tetap.
 */
export function susunKodePemulihan(acak: Uint8Array): string {
  if (acak.length < 13) {
    throw new Error('Kode pemulihan membutuhkan minimal 13 byte acak.');
  }
  let bit = 0;
  let tampung = 0;
  let data = '';
  for (let i = 0; i < acak.length && data.length < PANJANG_DATA_KODE; i++) {
    tampung = (tampung << 8) | acak[i];
    bit += 8;
    while (bit >= 5 && data.length < PANJANG_DATA_KODE) {
      bit -= 5;
      data += ABJAD_KODE[(tampung >> bit) & 31];
    }
  }
  return formatKodePemulihan(data + karakterPeriksa(data));
}

/** Sisipkan tanda hubung tiap 4 karakter supaya mudah disalin. */
export function formatKodePemulihan(kode: string): string {
  const grup: string[] = [];
  for (let i = 0; i < kode.length; i += UKURAN_GRUP_KODE) {
    grup.push(kode.slice(i, i + UKURAN_GRUP_KODE));
  }
  return grup.join('-');
}

/**
 * Rapikan masukan pengguna: huruf besar, tanda hubung/spasi dibuang,
 * dan huruf yang mudah tertukar dibetulkan.
 *
 * Pembetulan ini SENGAJA. Pengguna yang menyalin dari kertas akan
 * menulis O untuk 0 dan I untuk 1 — menolak masukannya dengan "kode
 * salah" sementara yang ia tulis persis seperti di kertas adalah cara
 * tercepat membuat orang menyerah pada pemulihan yang sebenarnya bisa.
 */
export function rapikanKodePemulihan(masukan: string): string {
  const kasar = (masukan ?? '').toUpperCase().replace(/[\s-]/g, '');
  let keluar = '';
  for (const c of kasar) keluar += PEMBETULAN[c] ?? c;
  return keluar;
}

export type HasilPeriksaKode = 'SAH' | 'PANJANG_SALAH' | 'KARAKTER_ASING' | 'PERIKSA_GAGAL';

export function periksaKodePemulihan(masukan: string): HasilPeriksaKode {
  const kode = rapikanKodePemulihan(masukan);
  if (kode.length !== PANJANG_DATA_KODE + 1) return 'PANJANG_SALAH';
  for (const c of kode) {
    if (ABJAD_KODE.indexOf(c) < 0) return 'KARAKTER_ASING';
  }
  const data = kode.slice(0, PANJANG_DATA_KODE);
  return karakterPeriksa(data) === kode[PANJANG_DATA_KODE] ? 'SAH' : 'PERIKSA_GAGAL';
}

export const PESAN_PERIKSA_KODE: Record<Exclude<HasilPeriksaKode, 'SAH'>, string> = {
  PANJANG_SALAH: `Kode pemulihan terdiri dari ${PANJANG_DATA_KODE + 1} karakter. Periksa kembali salinannya.`,
  KARAKTER_ASING: 'Ada karakter yang bukan bagian dari kode pemulihan. Huruf I, L, O, dan U tidak dipakai.',
  PERIKSA_GAGAL: 'Kode pemulihan tidak cocok — kemungkinan ada satu karakter yang salah ketik.',
};

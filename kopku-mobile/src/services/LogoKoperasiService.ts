import * as FileSystem from 'expo-file-system/legacy'; // SDK 54: API lama ada di path /legacy
import * as ImagePicker from 'expo-image-picker';
import { ekstensiLogo } from '@/export/LogoKopLaporan';

// Diteruskan supaya pemanggil (layar Identitas) cukup mengimpor dari satu
// tempat; implementasinya ada di `@/export/LogoKopLaporan` yang bebas dari
// `expo-image-picker` — lihat alasannya di berkas itu.
export { ekstensiLogo, muatLogoSebagaiDataUri } from '@/export/LogoKopLaporan';

/**
 * RC-S100 — LOGO KOPERASI DARI BERKAS GAMBAR.
 *
 * Permintaan pengguna: "di identitas koperasi branding logo itu pilih
 * logo langsung (file gambar) dan di tampilkan di dasboard dan export".
 *
 * Sebelum ini kolom Logo adalah kotak teks tempat pengguna diminta
 * MENGETIK sebuah URI — praktis tidak bisa dipakai di ponsel, dan tidak
 * ada satu pun tempat di aplikasi yang menampilkan logonya.
 *
 * ============================================================
 * KENAPA BERKASNYA DISALIN, BUKAN DIPAKAI DARI TEMPATNYA
 * ============================================================
 * Gambar yang dipilih lewat galeri/kamera diserahkan sistem di dalam
 * direktori CACHE aplikasi. Direktori itu boleh dibersihkan sistem
 * operasi kapan saja saat penyimpanan menipis, dan pada iOS URI-nya bisa
 * tidak berlaku lagi setelah aplikasi ditutup. Kalau URI itu yang
 * disimpan ke database, logo akan tampil normal hari ini lalu hilang
 * beberapa hari kemudian tanpa sebab yang terlihat — dan laporan yang
 * sudah dicetak tidak bisa dijelaskan lagi.
 *
 * Karena itu berkasnya DISALIN ke `documentDirectory` (penyimpanan
 * permanen aplikasi, folder yang sama yang dipakai backup), dan yang
 * disimpan ke `koperasi.logo_uri` adalah salinan itu.
 */

export const DIREKTORI_LOGO = `${FileSystem.documentDirectory}branding/`;

/** Ukuran maksimum berkas logo. */
export const MAKS_UKURAN_LOGO_BYTE = 2 * 1024 * 1024; // 2 MB

export class LogoTerlaluBesarError extends Error {
  constructor(ukuranByte: number) {
    super(
      `Ukuran gambar ${(ukuranByte / 1024 / 1024).toFixed(1)} MB melebihi batas ${
        MAKS_UKURAN_LOGO_BYTE / 1024 / 1024
      } MB. Pilih gambar yang lebih kecil.`
    );
    this.name = 'LogoTerlaluBesarError';
  }
}

async function pastikanDirektori(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DIREKTORI_LOGO);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DIREKTORI_LOGO, { intermediates: true });
  }
}

export interface HasilPilihLogo {
  /** URI salinan permanen — inilah yang disimpan ke database. */
  uri: string;
  ukuranByte: number;
}

/**
 * Buka galeri, lalu salin gambar terpilih ke penyimpanan permanen.
 * Mengembalikan `null` bila pengguna membatalkan (bukan melempar —
 * membatalkan bukan kesalahan).
 *
 * Izin diminta lebih dulu; penolakan izin dilempar sebagai pesan yang
 * bisa langsung ditampilkan, bukan dibiarkan menjadi galat teknis.
 */
export async function pilihLogoDariGaleri(): Promise<HasilPilihLogo | null> {
  const izin = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!izin.granted) {
    throw new Error('Izin akses galeri belum diberikan. Aktifkan izin foto untuk aplikasi ini di pengaturan perangkat.');
  }

  const hasil = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: false,
    // Dipangkas persegi: logo ditampilkan di kop laporan & Dashboard
    // dalam kotak, jadi memangkasnya di sini lebih baik daripada
    // membiarkan gambar panjang terpotong sembarangan saat dirender.
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.9,
  });
  if (hasil.canceled || !hasil.assets?.[0]) return null;

  const aset = hasil.assets[0];
  const infoAsal = await FileSystem.getInfoAsync(aset.uri);
  const ukuranByte = infoAsal.exists ? infoAsal.size : 0;
  if (ukuranByte > MAKS_UKURAN_LOGO_BYTE) throw new LogoTerlaluBesarError(ukuranByte);

  await pastikanDirektori();
  // Nama berisi timestamp: berkas BARU tidak menimpa yang lama, sehingga
  // penggantian logo tidak pernah merusak tampilan sebelum perubahan
  // disimpan. Yang lama dibersihkan `hapusBerkasLogoLama` setelah
  // penyimpanan berhasil.
  const tujuan = `${DIREKTORI_LOGO}logo-${Date.now()}.${ekstensiLogo(aset.uri)}`;
  await FileSystem.copyAsync({ from: aset.uri, to: tujuan });

  return { uri: tujuan, ukuranByte };
}

/**
 * Hapus salinan logo yang sudah tidak dipakai. Dipanggil SETELAH URI baru
 * tersimpan ke database — bukan sebelumnya, supaya kegagalan menyimpan
 * tidak meninggalkan koperasi tanpa logo sama sekali.
 *
 * Tidak pernah melempar: gagal membersihkan satu berkas lama tidak boleh
 * membuat penyimpanan identitas tampak gagal.
 */
export async function hapusBerkasLogoLama(uriLama: string | null | undefined, uriBaru: string | null): Promise<void> {
  if (!uriLama || uriLama === uriBaru) return;
  // Hanya berkas milik aplikasi di folder branding yang boleh dihapus —
  // URI lama bisa saja menunjuk galeri pengguna (data instalasi lama yang
  // dulu diketik manual), dan itu BUKAN milik aplikasi.
  if (!uriLama.startsWith(DIREKTORI_LOGO)) return;
  try {
    await FileSystem.deleteAsync(uriLama, { idempotent: true });
  } catch {
    /* diabaikan dengan sengaja — lihat alasan di atas */
  }
}

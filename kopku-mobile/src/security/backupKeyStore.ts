import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { keBase64, dariBase64, PANJANG_KUNCI } from '@/backup/FormatBackupTerenkripsi';
import { susunKodePemulihan, periksaKodePemulihan } from '@/backup/KodePemulihan';

/**
 * RC-S114 — PENYIMPANAN KUNCI BACKUP.
 *
 * ============================================================
 * APA YANG DISIMPAN DI SINI, DAN APA YANG TIDAK
 * ============================================================
 * DISIMPAN (SecureStore -> AndroidKeyStore):
 *   - kunci perangkat 32 byte, pembungkus kunci berkas;
 *   - kode pemulihan, supaya SATU kode berlaku untuk seluruh backup
 *     dan bisa ditampilkan ulang bila pengurus lupa mencatatnya;
 *   - penanda instalasi, hanya untuk memberi pesan yang jujur
 *     ("backup ini dari perangkat lain") alih-alih "gagal membuka".
 *
 * TIDAK PERNAH DISIMPAN:
 *   - kunci berkas. Ia acak per backup dan hanya ada di dalam berkas
 *     itu sendiri dalam bentuk terbungkus.
 *
 * ============================================================
 * KENAPA KODE PEMULIHAN IKUT DISIMPAN
 * ============================================================
 * Terlihat seperti melemahkan, tetapi tidak menambah apa pun: siapa
 * yang bisa membaca kode dari SecureStore sudah bisa membaca kunci
 * perangkat di tempat yang sama, dan dengan itu sudah bisa membuka
 * seluruh backup. Yang didapat sebagai gantinya nyata: pengurus cukup
 * mencatat SATU kode untuk selamanya, bukan kode baru setiap kali
 * membuat backup — dan kode yang berganti setiap kali adalah kode yang
 * pasti tidak akan dicatat siapa pun.
 *
 * ============================================================
 * SATU SIFAT YANG HARUS DIINGAT
 * ============================================================
 * Kunci AndroidKeyStore tidak dapat diekspor: ia tidak ikut pindah ke
 * perangkat baru, tidak ikut cadangan cloud, dan hilang saat aplikasi
 * di-uninstall. Karena itu KODE PEMULIHAN BUKAN PELENGKAP — ia
 * satu-satunya jalan pulang ketika perangkat hilang atau berganti.
 */

const KUNCI = {
  idInstalasi: 'kopku.backup.idInstalasi',
  kunciPerangkat: 'kopku.backup.kunciPerangkat',
  kodePemulihan: 'kopku.backup.kodePemulihan',
} as const;

export const KUNCI_PENYIMPANAN_BACKUP: readonly string[] = Object.values(KUNCI);

/**
 * Semua pembacaan dibungkus: SecureStore melempar bila keystore rusak
 * atau kuncinya sudah tidak sah (mis. pengguna mengganti kunci layar).
 * Kegagalan baca BUKAN kondisi fatal di sini — artinya jalur perangkat
 * tidak tersedia, dan kode pemulihan mengambil alih.
 */
async function baca(kunci: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(kunci);
  } catch {
    return null;
  }
}

export async function getIdInstalasi(): Promise<string> {
  const ada = await baca(KUNCI.idInstalasi);
  if (ada) return ada;
  const baru = Crypto.randomUUID();
  await SecureStore.setItemAsync(KUNCI.idInstalasi, baru);
  return baru;
}

/**
 * Kunci perangkat, dibuat sekali lalu dipakai seterusnya.
 *
 * Dibuat malas (saat backup pertama), bukan saat aplikasi pertama
 * dijalankan — supaya kegagalan keystore hanya berdampak pada fitur
 * backup, tidak membuat aplikasi gagal dibuka sama sekali.
 */
export async function getKunciPerangkat(): Promise<Uint8Array> {
  const ada = await baca(KUNCI.kunciPerangkat);
  if (ada) {
    const bytes = dariBase64(ada);
    if (bytes.length === PANJANG_KUNCI) return bytes;
    // Nilai rusak diganti, bukan dipakai. Backup LAMA yang dibungkus
    // kunci lama tetap dapat dibuka lewat kode pemulihan.
  }
  const baru = Crypto.getRandomBytes(PANJANG_KUNCI);
  await SecureStore.setItemAsync(KUNCI.kunciPerangkat, keBase64(baru));
  return baru;
}

/** Ada tidaknya kunci perangkat — dipakai UI untuk menjelaskan keadaan. */
export async function punyaKunciPerangkat(): Promise<boolean> {
  const ada = await baca(KUNCI.kunciPerangkat);
  return !!ada && dariBase64(ada).length === PANJANG_KUNCI;
}

export async function getKodePemulihan(): Promise<string | null> {
  const ada = await baca(KUNCI.kodePemulihan);
  if (!ada) return null;
  return periksaKodePemulihan(ada) === 'SAH' ? ada : null;
}

/**
 * Buat kode pemulihan bila belum ada, lalu kembalikan.
 *
 * Idempoten dengan sengaja: memanggilnya dua kali TIDAK menghasilkan
 * kode baru. Kode yang berganti diam-diam akan membuat catatan
 * pengurus menjadi usang tanpa ia tahu — persis kegagalan yang paling
 * mahal, karena baru ketahuan saat pemulihan dibutuhkan.
 */
export async function pastikanKodePemulihan(): Promise<string> {
  const ada = await getKodePemulihan();
  if (ada) return ada;
  const kode = susunKodePemulihan(Crypto.getRandomBytes(13));
  await SecureStore.setItemAsync(KUNCI.kodePemulihan, kode);
  return kode;
}

/**
 * Ganti kode pemulihan dengan yang baru.
 *
 * BATAS YANG JUJUR: ini hanya berlaku untuk backup YANG DIBUAT SETELAH
 * ini. Berkas yang sudah ada tetap terbuka dengan kode lama — kunci
 * berkasnya sudah terbungkus di dalam berkas itu dan tidak bisa diubah
 * dari luar. Pemanggil WAJIB menyampaikan hal ini kepada pengguna.
 */
export async function gantiKodePemulihan(): Promise<string> {
  const kode = susunKodePemulihan(Crypto.getRandomBytes(13));
  await SecureStore.setItemAsync(KUNCI.kodePemulihan, kode);
  return kode;
}

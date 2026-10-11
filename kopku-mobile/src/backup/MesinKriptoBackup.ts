import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { scrypt } from '@noble/hashes/scrypt';
import { sha256 } from '@noble/hashes/sha2';
import {
  HeaderBackup,
  ParameterScrypt,
  SlotPembungkus,
  JenisPembungkus,
  PANJANG_KUNCI,
  PANJANG_NONCE,
  PANJANG_TAG,
  dariBase64,
  keBase64,
  gabungBytes,
  teksKeBytes,
  nonceSegmen,
  ukuranPlaintextSegmen,
} from './FormatBackupTerenkripsi';
import { rapikanKodePemulihan, periksaKodePemulihan, PESAN_PERIKSA_KODE } from './KodePemulihan';

/**
 * RC-S114 — MESIN KRIPTO BACKUP (MODUL MURNI).
 *
 * Tidak menyentuh berkas, tidak menyentuh SecureStore, tidak memanggil
 * expo apa pun. Ia hanya mengubah byte menjadi byte — sehingga SELURUH
 * keputusan kriptografinya dapat diuji langsung, termasuk yang paling
 * penting: bahwa berkas yang diutak-atik DITOLAK, bukan diam-diam
 * menghasilkan database yang salah.
 *
 * ============================================================
 * PILIHAN ALGORITMA
 * ============================================================
 * XChaCha20-Poly1305, bukan AES-256-GCM. Dua alasan:
 *
 *  1. KECEPATAN DI JS MURNI. Tidak ada AES-NI di JavaScript. Diukur di
 *     mesin pengembangan: XChaCha20-Poly1305 103 MB/s enkripsi,
 *     AES-256-GCM 30 MB/s — tiga kali lebih lambat.
 *
 *  2. NONCE 24 BYTE. Nonce 12 byte milik GCM memaksa berhati-hati soal
 *     pengulangan nonce; dengan 24 byte, prefiks acak per berkas aman
 *     diambil langsung dari sumber acak tanpa pembukuan tambahan.
 *
 * ============================================================
 * SUSUNAN KUNCI
 * ============================================================
 *     kunciBerkas (32 B acak, satu per backup)
 *        |- dibungkus kunci perangkat (SecureStore/AndroidKeyStore)
 *        `- dibungkus kunci turunan kode pemulihan (scrypt)
 *
 * Kunci berkas tidak pernah disimpan di mana pun — ia hanya ada di
 * dalam berkas, dalam bentuk terbungkus. Menambah atau mencabut satu
 * cara membuka kunci berarti membungkus ulang kunci berkas, bukan
 * mengenkripsi ulang seluruh database.
 */

/** scrypt 32 MiB. Diukur 269 ms di mesin pengembangan; perkirakan 2-3 detik di perangkat. */
export const PARAMETER_SCRYPT_BAWAAN: Omit<ParameterScrypt, 'salt'> = { nama: 'scrypt', N: 32768, r: 8, p: 1 };

/**
 * AAD untuk pembungkus kunci. Mengikat ciphertext pada PERANNYA,
 * sehingga slot perangkat tidak bisa dipindahkan ke posisi slot kode
 * pemulihan (atau sebaliknya) dan tetap terbuka.
 */
function aadPembungkus(jenis: JenisPembungkus): Uint8Array {
  return teksKeBytes(`kopku-bungkus-v1:${jenis}`);
}

/**
 * AAD setiap segmen: sidik jari pendahuluan berkas.
 *
 * Inilah yang membuat header — yang tidak dienkripsi karena memuat
 * salt dan parameter yang dibutuhkan SEBELUM ada kunci — tetap tidak
 * dapat diutak-atik: mengubah satu byte di sana membuat seluruh segmen
 * gagal dibuka, bukan gagal diam-diam.
 */
export function aadSegmen(bytesPendahuluan: Uint8Array): Uint8Array {
  return sha256(bytesPendahuluan);
}

export function turunkanKunciDariKode(kode: string, salt: Uint8Array, parameter = PARAMETER_SCRYPT_BAWAAN): Uint8Array {
  const periksa = periksaKodePemulihan(kode);
  if (periksa !== 'SAH') {
    throw new Error(PESAN_PERIKSA_KODE[periksa]);
  }
  const bersih = rapikanKodePemulihan(kode);
  return scrypt(teksKeBytes(bersih), salt, { N: parameter.N, r: parameter.r, p: parameter.p, dkLen: PANJANG_KUNCI });
}

export function bungkusKunci(
  kunciBerkas: Uint8Array,
  kunciPembungkus: Uint8Array,
  nonce: Uint8Array,
  jenis: JenisPembungkus
): Uint8Array {
  pastikanPanjang(kunciBerkas, PANJANG_KUNCI, 'kunci berkas');
  pastikanPanjang(kunciPembungkus, PANJANG_KUNCI, 'kunci pembungkus');
  pastikanPanjang(nonce, PANJANG_NONCE, 'nonce pembungkus');
  return xchacha20poly1305(kunciPembungkus, nonce, aadPembungkus(jenis)).encrypt(kunciBerkas);
}

export function bukaKunci(slot: SlotPembungkus, kunciPembungkus: Uint8Array): Uint8Array {
  pastikanPanjang(kunciPembungkus, PANJANG_KUNCI, 'kunci pembungkus');
  const nonce = dariBase64(slot.nonce);
  const terbungkus = dariBase64(slot.kunciTerbungkus);
  const kunci = xchacha20poly1305(kunciPembungkus, nonce, aadPembungkus(slot.jenis)).decrypt(terbungkus);
  if (kunci.length !== PANJANG_KUNCI) {
    throw new Error('Kunci berkas hasil pembukaan tidak berukuran benar.');
  }
  return kunci;
}

export function buatSlot(input: {
  jenis: JenisPembungkus;
  kunciBerkas: Uint8Array;
  kunciPembungkus: Uint8Array;
  nonce: Uint8Array;
  kdf?: ParameterScrypt;
  idInstalasi?: string;
}): SlotPembungkus {
  const slot: SlotPembungkus = {
    jenis: input.jenis,
    kunciTerbungkus: keBase64(bungkusKunci(input.kunciBerkas, input.kunciPembungkus, input.nonce, input.jenis)),
    nonce: keBase64(input.nonce),
  };
  if (input.kdf) slot.kdf = input.kdf;
  if (input.idInstalasi) slot.idInstalasi = input.idInstalasi;
  return slot;
}

export function cariSlot(header: HeaderBackup, jenis: JenisPembungkus): SlotPembungkus | null {
  return header.pembungkus.find((s) => s.jenis === jenis) ?? null;
}

/** Enkripsi satu segmen. `terakhir` wajib benar — lihat nonceSegmen(). */
export function enkripsiSegmen(input: {
  plaintext: Uint8Array;
  kunciBerkas: Uint8Array;
  prefiksNonce: Uint8Array;
  indeks: number;
  terakhir: boolean;
  aad: Uint8Array;
}): Uint8Array {
  pastikanPanjang(input.kunciBerkas, PANJANG_KUNCI, 'kunci berkas');
  const nonce = nonceSegmen(input.prefiksNonce, input.indeks, input.terakhir);
  return xchacha20poly1305(input.kunciBerkas, nonce, input.aad).encrypt(input.plaintext);
}

export function dekripsiSegmen(input: {
  ciphertext: Uint8Array;
  kunciBerkas: Uint8Array;
  prefiksNonce: Uint8Array;
  indeks: number;
  terakhir: boolean;
  aad: Uint8Array;
}): Uint8Array {
  pastikanPanjang(input.kunciBerkas, PANJANG_KUNCI, 'kunci berkas');
  const nonce = nonceSegmen(input.prefiksNonce, input.indeks, input.terakhir);
  return xchacha20poly1305(input.kunciBerkas, nonce, input.aad).decrypt(input.ciphertext);
}

/**
 * Enkripsi seluruh isi dalam memori — dipakai test dan berkas kecil.
 * Jalur produksi untuk database besar melakukannya per segmen langsung
 * ke berkas (lihat BackupService), memakai fungsi segmen di atas.
 */
export function enkripsiSeluruhnya(input: {
  data: Uint8Array;
  kunciBerkas: Uint8Array;
  header: HeaderBackup;
  bytesPendahuluan: Uint8Array;
}): Uint8Array {
  const prefiks = dariBase64(input.header.prefiksNonce);
  const aad = aadSegmen(input.bytesPendahuluan);
  const potongan: Uint8Array[] = [];
  for (let i = 0; i < input.header.totalSegmen; i++) {
    const mulai = i * input.header.ukuranSegmen;
    const panjang = ukuranPlaintextSegmen(input.header, i);
    potongan.push(
      enkripsiSegmen({
        plaintext: input.data.subarray(mulai, mulai + panjang),
        kunciBerkas: input.kunciBerkas,
        prefiksNonce: prefiks,
        indeks: i,
        terakhir: i === input.header.totalSegmen - 1,
        aad,
      })
    );
  }
  return gabungBytes(...potongan);
}

export function dekripsiSeluruhnya(input: {
  data: Uint8Array;
  kunciBerkas: Uint8Array;
  header: HeaderBackup;
  bytesPendahuluan: Uint8Array;
}): Uint8Array {
  const prefiks = dariBase64(input.header.prefiksNonce);
  const aad = aadSegmen(input.bytesPendahuluan);
  const potongan: Uint8Array[] = [];
  let posisi = 0;
  for (let i = 0; i < input.header.totalSegmen; i++) {
    const panjangCipher = ukuranPlaintextSegmen(input.header, i) + PANJANG_TAG;
    if (posisi + panjangCipher > input.data.length) {
      throw new Error('Berkas backup terpotong — segmen terakhir tidak lengkap.');
    }
    potongan.push(
      dekripsiSegmen({
        ciphertext: input.data.subarray(posisi, posisi + panjangCipher),
        kunciBerkas: input.kunciBerkas,
        prefiksNonce: prefiks,
        indeks: i,
        terakhir: i === input.header.totalSegmen - 1,
        aad,
      })
    );
    posisi += panjangCipher;
  }
  const hasil = gabungBytes(...potongan);
  if (hasil.length !== input.header.ukuranAsli) {
    throw new Error('Ukuran hasil dekripsi tidak sesuai dengan yang dicatat di header.');
  }
  return hasil;
}

function pastikanPanjang(b: Uint8Array, panjang: number, nama: string): void {
  if (!(b instanceof Uint8Array) || b.length !== panjang) {
    throw new Error(`Panjang ${nama} harus ${panjang} byte, diterima ${b?.length ?? 'bukan byte'}.`);
  }
}

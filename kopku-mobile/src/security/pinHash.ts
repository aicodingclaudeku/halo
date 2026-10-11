import { scrypt, scryptAsync } from '@noble/hashes/scrypt';
import { sha256 } from '@noble/hashes/sha2';

/**
 * RC-S114 — TURUNAN HASH PIN (MODUL MURNI).
 *
 * ============================================================
 * TEMUAN AUDIT (TINGGI)
 * ============================================================
 * Sampai RC-S113, PIN di-hash dengan SATU putaran SHA-256:
 *
 *     hashPin = SHA256(`${salt}:${pin}`)
 *
 * PIN aplikasi ini 6 digit — ruang tebakannya 1.000.000. SHA-256 satu
 * putaran dapat dihitung ratusan juta kali per detik di GPU biasa,
 * sehingga SELURUH ruang tebakan habis dalam hitungan MILIDETIK bagi
 * siapa pun yang memegang salinan database. Salt tidak menolong di
 * sini: ia mencegah tabel pelangi yang dipakai ulang antar-pengguna,
 * bukan penebakan terhadap satu pengguna tertentu.
 *
 * Sampai RC-S113 salinan database itu justru mudah didapat, karena
 * berkas backup tidak terenkripsi. Enkripsi backup menutup jalur
 * masuknya; modul ini menutup kelemahan hash-nya sendiri, supaya
 * keamanannya tidak bergantung pada satu lapis saja.
 *
 * ============================================================
 * PILIHAN PARAMETER
 * ============================================================
 * scrypt N=2^14, r=8, p=1 — 16 MiB memori per percobaan. Diukur 90 ms
 * di mesin pengembangan; perkirakan di bawah satu detik pada perangkat
 * kelas menengah, yaitu batas yang masih terasa wajar untuk membuka
 * kunci aplikasi.
 *
 * Sengaja LEBIH RINGAN daripada scrypt kode pemulihan (N=2^15, 32 MiB):
 * PIN diverifikasi setiap kali aplikasi dibuka, sementara kode
 * pemulihan dipakai sekali seumur pemulihan. Keduanya ditulis terpisah
 * supaya perbedaan ini disengaja dan terlihat, bukan terjadi diam-diam.
 *
 * ============================================================
 * VERSI HASH
 * ============================================================
 * `v1` = SHA-256 satu putaran (warisan). `v2` = scrypt. Nilai lama
 * TETAP dapat diverifikasi supaya tidak ada pengguna yang terkunci di
 * luar aplikasinya sendiri; ia dinaikkan ke v2 secara diam-diam pada
 * login berikutnya yang berhasil, saat PIN-nya memang sedang ada di
 * tangan dan tidak perlu ditanyakan lagi.
 */

export type VersiHashPin = 1 | 2;

export const VERSI_HASH_PIN_SEKARANG: VersiHashPin = 2;

export const PARAMETER_SCRYPT_PIN = { N: 16384, r: 8, p: 1, dkLen: 32 } as const;

export function keHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * Pengkodean UTF-8 eksplisit.
 *
 * SENGAJA TIDAK memakai `unescape(encodeURIComponent(...))` — dua
 * fungsi itu bagian dari Annex B dan tidak dijamin ada di Hermes,
 * mesin JavaScript yang dipakai aplikasi ini di perangkat. Kegagalannya
 * pun tidak akan terlihat saat pengembangan di Node: `unescape` ada di
 * sana. `TextEncoder` juga tidak dipakai karena ketersediaannya di
 * React Native bergantung pada polyfill yang tidak dijamin terpasang.
 *
 * Ditulis tangan supaya hanya bergantung pada operasi inti bahasa,
 * yang pasti ada di mesin mana pun.
 */
export function teksKeBytes(teks: string): Uint8Array {
  const keluar: number[] = [];
  for (let i = 0; i < teks.length; i++) {
    let titik = teks.charCodeAt(i);
    // Pasangan pengganti (surrogate pair) digabung jadi satu titik kode.
    if (titik >= 0xd800 && titik <= 0xdbff && i + 1 < teks.length) {
      const rendah = teks.charCodeAt(i + 1);
      if (rendah >= 0xdc00 && rendah <= 0xdfff) {
        titik = (titik - 0xd800) * 0x400 + (rendah - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (titik < 0x80) {
      keluar.push(titik);
    } else if (titik < 0x800) {
      keluar.push(0xc0 | (titik >> 6), 0x80 | (titik & 0x3f));
    } else if (titik < 0x10000) {
      keluar.push(0xe0 | (titik >> 12), 0x80 | ((titik >> 6) & 0x3f), 0x80 | (titik & 0x3f));
    } else {
      keluar.push(
        0xf0 | (titik >> 18),
        0x80 | ((titik >> 12) & 0x3f),
        0x80 | ((titik >> 6) & 0x3f),
        0x80 | (titik & 0x3f)
      );
    }
  }
  return Uint8Array.from(keluar);
}

/** Hash warisan — HANYA untuk memverifikasi nilai lama, tidak pernah untuk menulis baru. */
export function hashPinV1(pin: string, salt: string): string {
  return keHex(sha256(teksKeBytes(`${salt}:${pin}`)));
}

export function hashPinV2(pin: string, salt: string): string {
  return keHex(
    scrypt(teksKeBytes(pin), teksKeBytes(salt), {
      N: PARAMETER_SCRYPT_PIN.N,
      r: PARAMETER_SCRYPT_PIN.r,
      p: PARAMETER_SCRYPT_PIN.p,
      dkLen: PARAMETER_SCRYPT_PIN.dkLen,
    })
  );
}

/**
 * RC-S130 — scrypt yang SAMA (parameter identik, hasil identik dengan
 * `hashPinV2`), tetapi dikerjakan bertahap: setiap ±16 ms ia memberi
 * giliran ke event loop. Tanpa ini, scrypt di Hermes (tanpa JIT, bisa
 * beberapa detik) memblokir thread JS sehingga layar membeku — indikator
 * "Memverifikasi…" tidak sempat tampil dan sentuhan tidak direspons.
 * Total waktunya hampir sama; yang berubah hanya layar tetap hidup.
 */
export const JEDA_GILIRAN_SCRYPT_MS = 16;

export async function hashPinV2Async(pin: string, salt: string): Promise<string> {
  return keHex(
    await scryptAsync(teksKeBytes(pin), teksKeBytes(salt), {
      N: PARAMETER_SCRYPT_PIN.N,
      r: PARAMETER_SCRYPT_PIN.r,
      p: PARAMETER_SCRYPT_PIN.p,
      dkLen: PARAMETER_SCRYPT_PIN.dkLen,
      asyncTick: JEDA_GILIRAN_SCRYPT_MS,
    })
  );
}

export function hashPin(pin: string, salt: string, versi: VersiHashPin = VERSI_HASH_PIN_SEKARANG): string {
  return versi === 1 ? hashPinV1(pin, salt) : hashPinV2(pin, salt);
}

/**
 * Perbandingan waktu-tetap.
 *
 * Membandingkan hash dengan `===` membocorkan berapa banyak karakter
 * awal yang sudah cocok lewat selisih waktu. Untuk PIN 6 digit yang
 * ruangnya sempit, kebocoran sekecil itu pun memangkas biaya serangan.
 */
export function samaAman(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let beda = 0;
  for (let i = 0; i < a.length; i++) beda |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return beda === 0;
}

export interface HasilVerifikasiPin {
  cocok: boolean;
  /** true bila hash tersimpan masih versi lama dan perlu dinaikkan. */
  perluDinaikkan: boolean;
}

/**
 * Verifikasi PIN terhadap hash tersimpan, apa pun versinya.
 *
 * Versi yang tidak dikenal diperlakukan sebagai TIDAK COCOK, bukan
 * dicoba dengan versi terbaru: menebak-nebak versi berarti menerima
 * nilai yang formatnya tidak kita kenali sebagai sah.
 */
export function verifikasiPin(input: {
  pin: string;
  salt: string;
  hashTersimpan: string;
  versiTersimpan: VersiHashPin;
}): HasilVerifikasiPin {
  const { pin, salt, hashTersimpan, versiTersimpan } = input;
  if (versiTersimpan !== 1 && versiTersimpan !== 2) {
    return { cocok: false, perluDinaikkan: false };
  }
  const cocok = samaAman(hashPin(pin, salt, versiTersimpan), hashTersimpan);
  return { cocok, perluDinaikkan: cocok && versiTersimpan < VERSI_HASH_PIN_SEKARANG };
}

/**
 * RC-S130 — versi asinkron `verifikasiPin` (aturan identik): v2 memakai
 * `hashPinV2Async` supaya UI tidak membeku; v1 (SHA-256) tetap sinkron
 * karena sudah instan.
 */
export async function verifikasiPinAsync(input: {
  pin: string;
  salt: string;
  hashTersimpan: string;
  versiTersimpan: VersiHashPin;
}): Promise<HasilVerifikasiPin> {
  const { pin, salt, hashTersimpan, versiTersimpan } = input;
  if (versiTersimpan !== 1 && versiTersimpan !== 2) {
    return { cocok: false, perluDinaikkan: false };
  }
  const hitung = versiTersimpan === 2 ? await hashPinV2Async(pin, salt) : hashPinV1(pin, salt);
  const cocok = samaAman(hitung, hashTersimpan);
  return { cocok, perluDinaikkan: cocok && versiTersimpan < VERSI_HASH_PIN_SEKARANG };
}

/**
 * RC-S114 — FORMAT BERKAS BACKUP TERENKRIPSI (MODUL MURNI).
 *
 * ============================================================
 * MASALAH YANG DIPERBAIKI
 * ============================================================
 * Sampai RC-S113, berkas `.kdb` adalah SALINAN BYTE-PER-BYTE database
 * SQLite — `FileSystem.copyAsync(dbAktif -> backup)`. Siapa pun yang
 * memegang berkas itu bisa membukanya dengan DB Browser for SQLite dan
 * membaca NIK, tanggal lahir, alamat, nomor HP, serta seluruh saldo
 * simpanan dan pinjaman setiap anggota. Berkas itu justru DIRANCANG
 * untuk keluar dari perangkat (tombol Bagikan -> WhatsApp/Drive), di
 * mana tidak ada lagi perlindungan sistem operasi.
 *
 * ============================================================
 * KENAPA BERKAS INI MURNI
 * ============================================================
 * Seluruh keputusan yang BISA salah secara kriptografis — tata letak
 * berkas, turunan nonce, apa yang ikut diautentikasi — ditaruh di sini,
 * tanpa satu pun impor expo/filesystem, supaya bisa diuji langsung oleh
 * ts-jest. `BackupService` hanya mengurus baca-tulis berkas.
 *
 * ============================================================
 * TATA LETAK
 * ============================================================
 *   [0  .. 8)      magic "KOPKUBK1" (ASCII)
 *   [8  .. 10)     versi format, uint16 big-endian
 *   [10 .. 14)     panjang header, uint32 big-endian
 *   [14 .. 14+H)   header JSON (UTF-8)
 *   [14+H .. )     segmen berurutan: ciphertext ‖ tag 16 byte
 *
 * Header TIDAK dienkripsi (ia memuat salt & parameter yang dibutuhkan
 * untuk membuka kunci), tetapi ia DIAUTENTIKASI: sidik jarinya menjadi
 * AAD setiap segmen. Mengubah satu byte header membuat SELURUH segmen
 * gagal dibuka — bukan cuma gagal diam-diam.
 *
 * ============================================================
 * KENAPA SEGMEN, BUKAN SATU BLOK
 * ============================================================
 * Dua alasan, dan keduanya menentukan:
 *
 *  1. MEMORI. Database koperasi bisa puluhan MB. Mengenkripsi sekaligus
 *     berarti menahan plaintext + ciphertext + string base64-nya di
 *     memori bersamaan — jalan tercepat menuju OOM di perangkat murah.
 *
 *  2. INTEGRITAS URUTAN. Tag AEAD per segmen saja TIDAK cukup: tanpa
 *     pengikat posisi, segmen bisa ditukar urutannya atau berkas
 *     dipotong di tengah, dan setiap segmen yang tersisa tetap lolos
 *     verifikasi. Karena itu nonce memakai konstruksi STREAM
 *     (Hoang-Reyhanitabar-Rogaway-Vizar):
 *
 *         nonce = prefiks acak (19 B) ‖ nomor segmen BE (4 B) ‖ penanda akhir (1 B)
 *
 *     Nomor segmen membuat penukaran urutan gagal; penanda akhir (1 di
 *     segmen terakhir, 0 di segmen lain) membuat PEMOTONGAN gagal,
 *     karena segmen terakhir yang sah tidak akan pernah cocok di posisi
 *     mana pun selain posisi terakhir.
 */

export const MAGIC_BACKUP = 'KOPKUBK1';
export const PANJANG_MAGIC = 8;
export const VERSI_FORMAT_SEKARANG = 1;

/** Magic file SQLite — dipakai mengenali backup lama yang belum terenkripsi. */
export const MAGIC_SQLITE = 'SQLite format 3\u0000';

export const UKURAN_SEGMEN_BAWAAN = 1024 * 1024; // 1 MiB
export const PANJANG_TAG = 16;
export const PANJANG_NONCE = 24;
export const PANJANG_KUNCI = 32;
export const PANJANG_PREFIKS_NONCE = 19; // 24 - 4 (nomor segmen) - 1 (penanda akhir)

/** Batas atas jumlah segmen: nomor segmen hanya 4 byte. */
export const MAKS_SEGMEN = 0xffffffff;

export type JenisPembungkus = 'PERANGKAT' | 'KODE_PEMULIHAN';

export interface ParameterScrypt {
  nama: 'scrypt';
  N: number;
  r: number;
  p: number;
  /** base64 */
  salt: string;
}

export interface SlotPembungkus {
  jenis: JenisPembungkus;
  /** base64 — kunci berkas yang sudah dibungkus (ciphertext ‖ tag). */
  kunciTerbungkus: string;
  /** base64, 24 byte. */
  nonce: string;
  /** Hanya untuk slot yang kuncinya diturunkan dari teks (kode pemulihan). */
  kdf?: ParameterScrypt;
  /**
   * Penanda instalasi pemilik slot PERANGKAT. Dipakai untuk memberi
   * pesan yang jujur ("backup ini dari perangkat lain") alih-alih
   * sekadar "gagal membuka kunci".
   */
  idInstalasi?: string;
}

export interface HeaderBackup {
  v: number;
  alg: 'xchacha20poly1305';
  ukuranSegmen: number;
  totalSegmen: number;
  /** Ukuran database asli dalam byte — dipakai memverifikasi hasil dekripsi. */
  ukuranAsli: number;
  /** base64, 19 byte. */
  prefiksNonce: string;
  dibuatPada: string;
  /** Versi skema database di dalamnya — informasi untuk layar restore. */
  skema: number | null;
  pembungkus: SlotPembungkus[];
}

/* ------------------------------------------------------------------ */
/* Bantuan byte — sengaja tanpa Buffer supaya berjalan di Hermes juga. */
/* ------------------------------------------------------------------ */

export function teksKeBytes(teks: string): Uint8Array {
  const keluar = new Uint8Array(teks.length);
  for (let i = 0; i < teks.length; i++) keluar[i] = teks.charCodeAt(i) & 0xff;
  return keluar;
}

export function bytesKeTeks(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
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
export function utf8KeBytes(teks: string): Uint8Array {
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

/** Kebalikan `utf8KeBytes`. Byte tak sah menjadi U+FFFD, bukan melempar. */
export function bytesKeUtf8(bytes: Uint8Array): string {
  let keluar = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    let titik: number;
    if (b0 < 0x80) titik = b0;
    else if ((b0 & 0xe0) === 0xc0) titik = ((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if ((b0 & 0xf0) === 0xe0)
      titik = ((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else if ((b0 & 0xf8) === 0xf0)
      titik =
        ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else titik = 0xfffd;
    if (titik > 0xffff) {
      titik -= 0x10000;
      keluar += String.fromCharCode(0xd800 + (titik >> 10), 0xdc00 + (titik & 0x3ff));
    } else {
      keluar += String.fromCharCode(titik);
    }
  }
  return keluar;
}

const ABJAD_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function keBase64(bytes: Uint8Array): string {
  let keluar = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    keluar += ABJAD_B64[b0 >> 2];
    keluar += ABJAD_B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    keluar += b1 === undefined ? '=' : ABJAD_B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    keluar += b2 === undefined ? '=' : ABJAD_B64[b2 & 63];
  }
  return keluar;
}

export function dariBase64(teks: string): Uint8Array {
  const bersih = teks.replace(/[^A-Za-z0-9+/]/g, '');
  const panjang = Math.floor((bersih.length * 3) / 4);
  const keluar = new Uint8Array(panjang);
  let posisi = 0;
  for (let i = 0; i < bersih.length; i += 4) {
    const n0 = ABJAD_B64.indexOf(bersih[i]);
    const n1 = ABJAD_B64.indexOf(bersih[i + 1]);
    const n2 = ABJAD_B64.indexOf(bersih[i + 2]);
    const n3 = ABJAD_B64.indexOf(bersih[i + 3]);
    if (posisi < panjang) keluar[posisi++] = (n0 << 2) | (n1 >> 4);
    if (posisi < panjang && n2 >= 0) keluar[posisi++] = ((n1 & 15) << 4) | (n2 >> 2);
    if (posisi < panjang && n3 >= 0) keluar[posisi++] = ((n2 & 3) << 6) | n3;
  }
  return keluar;
}

export function gabungBytes(...bagian: Uint8Array[]): Uint8Array {
  const total = bagian.reduce((a, b) => a + b.length, 0);
  const keluar = new Uint8Array(total);
  let posisi = 0;
  for (const b of bagian) {
    keluar.set(b, posisi);
    posisi += b.length;
  }
  return keluar;
}

function uint16BE(nilai: number): Uint8Array {
  return new Uint8Array([(nilai >> 8) & 0xff, nilai & 0xff]);
}

function uint32BE(nilai: number): Uint8Array {
  return new Uint8Array([(nilai >>> 24) & 0xff, (nilai >>> 16) & 0xff, (nilai >>> 8) & 0xff, nilai & 0xff]);
}

function bacaUint16BE(b: Uint8Array, offset: number): number {
  return (b[offset] << 8) | b[offset + 1];
}

function bacaUint32BE(b: Uint8Array, offset: number): number {
  return ((b[offset] << 24) >>> 0) + (b[offset + 1] << 16) + (b[offset + 2] << 8) + b[offset + 3];
}

/* ------------------------------------------------------------------ */
/* Nonce per segmen — konstruksi STREAM.                               */
/* ------------------------------------------------------------------ */

/**
 * Nonce segmen ke-`indeks`. `terakhir` menandai segmen penutup.
 *
 * Penanda akhir itulah yang membuat PEMOTONGAN berkas gagal: segmen
 * penutup yang sah dienkripsi dengan penanda 1, sehingga tidak akan
 * pernah terbuka bila diletakkan di posisi mana pun selain posisi
 * penutup — dan berkas yang dipotong kehilangan penutupnya.
 */
export function nonceSegmen(prefiks: Uint8Array, indeks: number, terakhir: boolean): Uint8Array {
  if (prefiks.length !== PANJANG_PREFIKS_NONCE) {
    throw new Error(`Prefiks nonce harus ${PANJANG_PREFIKS_NONCE} byte, diterima ${prefiks.length}.`);
  }
  if (!Number.isInteger(indeks) || indeks < 0 || indeks > MAKS_SEGMEN) {
    throw new Error(`Nomor segmen di luar jangkauan: ${indeks}.`);
  }
  return gabungBytes(prefiks, uint32BE(indeks), new Uint8Array([terakhir ? 1 : 0]));
}

/** Jumlah segmen untuk sebuah ukuran berkas. Berkas kosong tetap 1 segmen. */
export function jumlahSegmen(ukuranByte: number, ukuranSegmen: number): number {
  if (ukuranSegmen <= 0) throw new Error('Ukuran segmen harus lebih besar dari nol.');
  if (ukuranByte <= 0) return 1;
  return Math.ceil(ukuranByte / ukuranSegmen);
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

export function rakitPendahuluan(header: HeaderBackup): Uint8Array {
  const json = utf8KeBytes(JSON.stringify(header));
  return gabungBytes(teksKeBytes(MAGIC_BACKUP), uint16BE(header.v), uint32BE(json.length), json);
}

export interface PendahuluanTerbaca {
  versi: number;
  header: HeaderBackup;
  /** Byte pendahuluan apa adanya — dipakai menghitung AAD. */
  bytesPendahuluan: Uint8Array;
  /** Offset byte tempat segmen pertama dimulai. */
  offsetData: number;
}

/**
 * Baca pendahuluan dari awal berkas. `bytes` cukup memuat bagian awal
 * saja — pemanggil boleh membaca beberapa KB pertama, tidak perlu
 * seluruh berkas.
 */
export function bacaPendahuluan(bytes: Uint8Array): PendahuluanTerbaca {
  if (bytes.length < PANJANG_MAGIC + 6) {
    throw new Error('Berkas terlalu pendek untuk menjadi backup terenkripsi.');
  }
  if (bytesKeTeks(bytes.subarray(0, PANJANG_MAGIC)) !== MAGIC_BACKUP) {
    throw new Error('Berkas ini bukan backup terenkripsi Koperasi Finance.');
  }
  const versi = bacaUint16BE(bytes, 8);
  if (versi !== VERSI_FORMAT_SEKARANG) {
    throw new Error(
      `Versi format backup (v${versi}) tidak dikenal aplikasi ini (mendukung v${VERSI_FORMAT_SEKARANG}). ` +
        'Gunakan versi aplikasi yang lebih baru.'
    );
  }
  const panjangHeader = bacaUint32BE(bytes, 10);
  const awalJson = PANJANG_MAGIC + 6;
  if (panjangHeader <= 0 || awalJson + panjangHeader > bytes.length) {
    throw new Error('Header backup tidak lengkap atau rusak.');
  }
  const json = bytesKeUtf8(bytes.subarray(awalJson, awalJson + panjangHeader));
  let header: HeaderBackup;
  try {
    header = JSON.parse(json);
  } catch {
    throw new Error('Header backup tidak dapat dibaca (JSON rusak).');
  }
  validasiHeader(header);
  return {
    versi,
    header,
    bytesPendahuluan: bytes.subarray(0, awalJson + panjangHeader),
    offsetData: awalJson + panjangHeader,
  };
}

/**
 * Periksa header sebelum dipakai.
 *
 * Ini bukan formalitas: header dibaca SEBELUM ada kunci, jadi nilainya
 * belum terautentikasi pada titik itu. `totalSegmen` yang tidak masuk
 * akal akan dipakai sebagai batas perulangan, dan `ukuranSegmen`
 * raksasa akan dipakai sebagai ukuran alokasi. Keduanya harus ditolak
 * lebih dulu, bukan dipercaya lalu ketahuan saat memori habis.
 */
export function validasiHeader(header: HeaderBackup): void {
  const salah = (pesan: string) => {
    throw new Error(`Header backup tidak valid: ${pesan}`);
  };
  if (!header || typeof header !== 'object') salah('bukan objek.');
  if (header.alg !== 'xchacha20poly1305') salah(`algoritma "${header.alg}" tidak didukung.`);
  if (!Number.isInteger(header.ukuranSegmen) || header.ukuranSegmen <= 0 || header.ukuranSegmen > 64 * 1024 * 1024) {
    salah('ukuran segmen di luar batas wajar.');
  }
  if (!Number.isInteger(header.totalSegmen) || header.totalSegmen <= 0 || header.totalSegmen > MAKS_SEGMEN) {
    salah('jumlah segmen di luar batas wajar.');
  }
  if (!Number.isInteger(header.ukuranAsli) || header.ukuranAsli < 0) salah('ukuran asli tidak masuk akal.');
  // Jumlah segmen WAJIB konsisten dengan ukuran asli. Tanpa ini, header
  // bisa mengaku punya segmen lebih sedikit daripada isinya dan
  // pemulihan berhenti diam-diam di tengah database.
  if (header.totalSegmen !== jumlahSegmen(header.ukuranAsli, header.ukuranSegmen)) {
    salah('jumlah segmen tidak cocok dengan ukuran asli.');
  }
  if (dariBase64(header.prefiksNonce ?? '').length !== PANJANG_PREFIKS_NONCE) salah('prefiks nonce tidak sah.');
  if (!Array.isArray(header.pembungkus) || header.pembungkus.length === 0) salah('tidak ada slot kunci.');
  for (const slot of header.pembungkus) {
    if (slot.jenis !== 'PERANGKAT' && slot.jenis !== 'KODE_PEMULIHAN') salah(`jenis slot "${slot.jenis}" tidak dikenal.`);
    if (dariBase64(slot.nonce ?? '').length !== PANJANG_NONCE) salah('nonce slot kunci tidak sah.');
    if (dariBase64(slot.kunciTerbungkus ?? '').length !== PANJANG_KUNCI + PANJANG_TAG) {
      salah('panjang kunci terbungkus tidak sah.');
    }
  }
}

/** Ukuran satu segmen terenkripsi (plaintext + tag). */
export function ukuranSegmenTerenkripsi(ukuranPlaintext: number): number {
  return ukuranPlaintext + PANJANG_TAG;
}

/**
 * Ukuran plaintext segmen ke-`indeks`. Segmen terakhir bisa lebih
 * pendek daripada yang lain.
 */
export function ukuranPlaintextSegmen(header: HeaderBackup, indeks: number): number {
  const sisa = header.ukuranAsli - indeks * header.ukuranSegmen;
  if (sisa <= 0) return 0;
  return Math.min(sisa, header.ukuranSegmen);
}

export type JenisBerkasBackup = 'TERENKRIPSI' | 'SQLITE_LAMA' | 'TIDAK_DIKENAL';

/**
 * Kenali jenis berkas dari beberapa byte pertamanya.
 *
 * Backup lama (sebelum RC-S114) adalah berkas SQLite apa adanya. Ia
 * HARUS tetap bisa dipulihkan — pengguna punya arsip berbulan-bulan
 * yang tidak boleh mendadak tidak terbaca hanya karena aplikasinya
 * diperbarui.
 */
export function kenaliJenisBerkas(bytesAwal: Uint8Array): JenisBerkasBackup {
  const awal = bytesKeTeks(bytesAwal.subarray(0, Math.max(PANJANG_MAGIC, MAGIC_SQLITE.length)));
  if (awal.startsWith(MAGIC_BACKUP)) return 'TERENKRIPSI';
  if (awal.startsWith(MAGIC_SQLITE)) return 'SQLITE_LAMA';
  return 'TIDAK_DIKENAL';
}

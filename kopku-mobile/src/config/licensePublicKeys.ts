/**
 * PUBLIC VERIFICATION KEY(S) — Ed25519
 * =========================================================================
 *
 * Berkas ini HANYA boleh berisi PUBLIC key. Public key aman untuk
 * diketahui siapa pun: ia hanya bisa MEMERIKSA tanda tangan, tidak bisa
 * MEMBUAT tanda tangan. Private key (`TOKEN_SIGNING_SECRET`) TETAP hanya
 * ada di server dan TIDAK BOLEH masuk ke repo/APK ini dalam bentuk apa
 * pun (§5, §28).
 *
 * ---------------------------------------------------------------------
 * STATUS: TERKONFIGURASI (RC-S32)
 * ---------------------------------------------------------------------
 * Kunci produksi sudah terpasang di `LICENSE_TOKEN_PUBLIC_KEYS` di bawah.
 * Catatan historis di bawah ini SENGAJA DIPERTAHANKAN, karena ia
 * menjelaskan kenapa berkas ini pernah kosong dan kenapa nilai
 * placeholder berbahaya — konteks yang akan hilang bila dihapus.
 *
 * Berkas `.env` yang Anda unggah berisi NILAI PLACEHOLDER, bukan kunci
 * produksi:
 *
 *   TOKEN_PUBLIC_KEY=aS9dF2gH4jK6lZ1xC3vB8nM0qW5eR7tY9uI0oP7aS3dF5gH2jK9lZ4xC7vB1q==
 *
 * Panjangnya 63 karakter (base64 yang valid selalu kelipatan 4) dan
 * polanya adalah keyboard-walk. `TOKEN_SIGNING_SECRET` di berkas yang
 * sama juga bukan secret key sodium yang valid (59 karakter; seharusnya
 * 88 karakter base64 untuk 64 byte). Artinya `.env` yang terunggah
 * adalah template, dan kunci produksi yang sesungguhnya ada di `.env`
 * di luar web root pada server (lihat `includes/bootstrap.php`).
 *
 * Karena itu public key produksi TIDAK DAPAT diketahui dari materi yang
 * tersedia, dan aturan proyek melarang mengarang nilai kebijakan/kunci.
 * Array di bawah sengaja DIBIARKAN KOSONG dan aplikasi FAIL-CLOSED:
 * selama kosong, tidak ada satu pun token yang akan lolos verifikasi
 * dan layar aktivasi menampilkan pesan konfigurasi. Ini disengaja —
 * jauh lebih aman daripada menanam kunci karangan yang membuat seluruh
 * rantai kepercayaan tidak berarti.
 *
 * ---------------------------------------------------------------------
 * CARA MENGISI
 * ---------------------------------------------------------------------
 * 1. Di server, ambil public key dari `.env` produksi:
 *
 *      grep TOKEN_PUBLIC_KEY /home/<user>/.env
 *
 *    Bila `TOKEN_PUBLIC_KEY` kosong di sana, turunkan dari secret key
 *    (JANGAN salin secret key-nya ke mana pun):
 *
 *      php -r 'require "vendor-less"; $sk=base64_decode(getenv("TOKEN_SIGNING_SECRET"));
 *              echo base64_encode(sodium_crypto_sign_publickey_from_secretkey($sk)), PHP_EOL;'
 *
 *    Public key Ed25519 panjangnya tepat 32 byte. Yang diterima parser
 *    di sini adalah kunci MENTAH 32 byte dalam salah satu bentuk:
 *      - base64  : 44 karakter, berakhiran satu '=' (atau base64url)
 *      - hex     : 64 karakter
 *    JANGAN memakai bentuk SPKI/DER ("MCowBQYDK2Vw...") atau blok PEM
 *    ("-----BEGIN PUBLIC KEY-----"); keduanya membungkus 32 byte itu
 *    dengan header ASN.1 dan akan ditolak.
 *
 * 2. Tempel ke `LICENSE_TOKEN_PUBLIC_KEYS` di bawah.
 *
 * 3. Alternatif tanpa mengubah source: set environment variable saat
 *    build EAS (nilainya tetap publik, hanya lebih mudah dirotasi):
 *
 *      eas secret:create --name EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS --value "<base64>"
 *
 * ---------------------------------------------------------------------
 * ROTASI KUNCI (§28)
 * ---------------------------------------------------------------------
 * Array ini sengaja berbentuk DAFTAR, bukan satu string, supaya rotasi
 * kunci bisa dilakukan tanpa mematikan perangkat yang sudah aktif:
 * selama masa transisi, isi [kunci_baru, kunci_lama]. Token lama masih
 * terverifikasi, token baru sudah diterima. Setelah semua perangkat
 * melakukan re-aktivasi, hapus kunci lama.
 */

/**
 * Diisi manual. Format tiap entri: base64 (44 char, raw 32 byte) atau
 * hex (64 char). Urutan tidak penting — token dianggap sah bila cocok
 * dengan SALAH SATU kunci.
 */
export const LICENSE_TOKEN_PUBLIC_KEYS: readonly string[] = [
  // Kunci produksi koperasikufinanace.my.id.
  //
  // Diturunkan di server dari TOKEN_SIGNING_SECRET dengan
  // sodium_crypto_sign_publickey_from_secretkey(), lalu diverifikasi di
  // runtime produksi (PHP 8.2.33 / SAPI litespeed / libsodium 1.0.18):
  //   PUBLIC_KEY_MATCH=true, TOKEN_SIGN_VERIFY_TEST=PASS.
  //
  // DUA SIDIK JARI, untuk dua tempat yang berbeda. Keduanya berasal dari
  // kunci yang sama tetapi dihitung dengan cara berbeda, jadi jangan
  // saling dibandingkan:
  //
  //   SHA-256, 16 hex pertama          : d4444e3315fab892
  //     -> yang tercatat di audit log server saat rotasi kunci.
  //
  //   4 byte awal + 4 byte akhir       : 9fc733c7…fb03409f
  //     -> yang ditampilkan di aplikasi, pada
  //        Pengaturan > Lisensi > Diagnostik Keamanan.
  //
  // CATATAN ROTASI (RC-S34). Kunci sebelumnya bersidik jari
  // 0dd7d85d942b7ef8 dan SUDAH TIDAK BERLAKU — signing key server
  // dirotasi setelah RC-S32. Kunci lama sengaja TIDAK dipertahankan di
  // daftar ini: tidak ada activation token yang pernah ditandatangani
  // dengannya (ACTIVE_TOKENS=0 saat rotasi), jadi menyimpannya hanya
  // memperluas himpunan kunci yang dipercaya tanpa memberi manfaat apa
  // pun. Daftar ini baru diisi lebih dari satu bila rotasi dilakukan
  // saat ada token aktif yang harus tetap sah selama masa transisi.
  //
  // Ini PUBLIC key: ia hanya dapat MEMERIKSA tanda tangan, tidak dapat
  // MEMBUATNYA. Aman berada di dalam APK dan aman masuk version control.
  // Private key (TOKEN_SIGNING_SECRET) TETAP hanya di server.
  'n8czx9Yis8m5GSxpkFDzig0MjaIp1UsBUcv5ZPsDQJ8=',
];

/**
 * Sumber tambahan lewat environment variable build-time (opsional).
 * `process.env.EXPO_PUBLIC_*` di-inline oleh Metro saat bundling, jadi
 * ini tetap nilai statis di dalam bundle — cocok untuk public key,
 * TIDAK BOLEH dipakai untuk secret apa pun.
 */
declare const process: { env?: Record<string, string | undefined> } | undefined;

/**
 * Dibaca SETIAP kali dipanggil, bukan sekali saat modul dimuat.
 *
 * Di produksi tidak ada bedanya: Metro meng-inline
 * `process.env.EXPO_PUBLIC_*` menjadi literal saat bundling, jadi
 * nilainya tetap konstan di dalam APK. Yang berubah adalah di TEST —
 * suite bisa menyetel kunci uji sebelum memanggil, tanpa perlu ada
 * setter khusus test di kode produksi. Setter semacam itu justru akan
 * menjadi titik masuk yang rapi bagi siapa pun yang mem-patch bundle
 * untuk memasang public key miliknya sendiri (§17).
 */
function readEnvKeys(): readonly string[] {
  const raw =
    typeof process !== 'undefined' && process?.env
      ? process.env.EXPO_PUBLIC_KOPKU_LICENSE_PUBLIC_KEYS
      : undefined;
  if (!raw) return [];
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/**
 * Gabungan kunci MENTAH seperti dikonfigurasi — belum divalidasi.
 *
 * Berkas ini sengaja hanya membawa DATA. Validasi format (32 byte,
 * base64/base64url/hex, penolakan bentuk PEM/SPKI) ada di
 * `src/security/publicKeyRegistry.ts`, karena "apakah kunci ini bisa
 * dipakai" adalah keputusan keamanan, bukan urusan konfigurasi.
 *
 * JANGAN memanggil fungsi ini langsung dari kode verifikasi. Pakai
 * `getUsablePublicKeys()` di registry — ia sudah membuang kunci yang
 * rusak, sehingga tidak ada jalur yang mengira kunci cacat itu sah.
 */
export function getConfiguredPublicKeyStrings(): readonly string[] {
  return [...LICENSE_TOKEN_PUBLIC_KEYS, ...readEnvKeys()];
}

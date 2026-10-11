/**
 * AUGMENTASI TIPE KHUSUS TEST — `@noble/ed25519`.
 *
 * MASALAH (ditemukan RC-S59, ditutup RC-S60 §1)
 * ---------------------------------------------
 * `jest.config.js` memetakan `@noble/ed25519` ke
 * `src/test-utils/nobleEd25519Mock.ts` lewat `moduleNameMapper`.
 * Pemetaan itu HANYA berlaku saat runtime: TypeScript/ts-jest tidak
 * membacanya sama sekali dan tetap mengetik `import * as ed from
 * '@noble/ed25519'` terhadap paket ASLI di `node_modules`.
 *
 * Akibatnya `LicenseCrypto.test.ts` GAGAL DIMUAT dengan
 * `TS2339: Property '__resetHashSlotsForTests' does not exist` — suite
 * berhenti di kompilasi dan 38 test-nya tidak pernah dieksekusi sejak
 * RC-S56. Helper itu sendiri MEMANG ADA di mock
 * (`nobleEd25519Mock.ts:141`); yang hilang cuma deklarasi tipenya.
 *
 * MENGAPA AUGMENTASI, BUKAN `paths` DI TSCONFIG
 * ---------------------------------------------
 * Memetakan `@noble/ed25519` ke mock lewat `compilerOptions.paths`
 * akan mengalihkan resolusi tipe untuk SELURUH repo — termasuk
 * `src/services/LicenseService.ts` dan kode produksi lain yang memakai
 * paket asli. Itu membuat tipe produksi ikut memakai tipe mock, persis
 * yang tidak boleh terjadi pada modul kriptografi.
 *
 * Augmentasi ini hanya MENAMBAH satu deklarasi fungsi ke tipe yang
 * sudah ada. Tidak ada tipe asli yang ditimpa, tidak ada perilaku
 * runtime yang berubah, dan tidak ada jalur produksi yang menyentuh
 * simbol ini — prefiks `__` dan sufiks `ForTests` sengaja dipakai
 * supaya pemakaian di produksi langsung terlihat saat review.
 *
 * TIDAK ADA perilaku kriptografi yang diubah, TIDAK ADA bypass, dan
 * TIDAK ADA expected security result yang disentuh (RC-S60 §1).
 */

// WAJIB: `export {}` membuat berkas ini sebuah MODUL.
//
// Tanpa baris ini berkas dianggap script global, dan `declare module`
// di bawah menjadi DEKLARASI MODUL AMBIENT yang MENGGANTIKAN seluruh
// tipe asli `@noble/ed25519` — bukan menambahinya. Gejalanya langsung
// terlihat: `__resetHashSlotsForTests` dikenali, tetapi `ed.etc` (yang
// nyata ada di paket asli) ikut hilang dan lima baris test lain gagal
// dengan TS2339. Terbukti pada percobaan pertama RC-S60 §1.
//
// Dengan `export {}`, `declare module` diperlakukan sebagai MODULE
// AUGMENTATION: tipe asli tetap utuh, hanya ditambah satu fungsi.
export {};

declare module '@noble/ed25519' {
  /**
   * Hanya tersedia pada mock test (`src/test-utils/nobleEd25519Mock.ts`).
   * Mengembalikan slot hash `etc.sha512Sync` / `etc.sha512Async` ke
   * keadaan default noble v2 supaya test dapat membuktikan bahwa
   * default yang belum ditimpa memang MELEMPAR — sama seperti di Hermes.
   *
   * Paket asli TIDAK mengekspor fungsi ini. Memanggilnya dari kode
   * produksi akan gagal saat runtime; itu disengaja.
   */
  export function __resetHashSlotsForTests(): void;
}

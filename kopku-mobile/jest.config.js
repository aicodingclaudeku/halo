/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    // expo-crypto di-ship sebagai ESM murni & butuh Metro/Babel untuk
    // dijalankan — Jest (ts-jest) tidak bisa mem-parsingnya langsung.
    // Diganti mock berbasis `crypto` bawaan Node (lihat komentar di file
    // mock) supaya service yang transitif memakainya (utils/id.ts,
    // security/pin.ts) tetap bisa diuji.
    '^expo-crypto$': '<rootDir>/src/test-utils/expoCryptoMock.ts',
    // `expo-task-manager` & `expo-background-task` adalah native module:
    // di Node tidak ada jembatan nativenya, dan paketnya di-ship sebagai
    // ESM sehingga ts-jest tidak bisa mem-parsingnya langsung — persis
    // alasan yang sama dengan expo-crypto di atas.
    //
    // Tanpa dua baris ini, SETIAP berkas test yang menyentuh
    // `StartupTasks` gagal DIMUAT (bukan gagal assertion):
    // SimpananBerjangkaScheduler.test.ts, StartupTasks.test.ts, dan
    // PosisiKeuanganFirstOpenDeterminism.test.ts. Keduanya sengaja
    // diarahkan ke SATU stub bersama supaya `defineTask` &
    // `registerTaskAsync` berbagi state — itulah yang membuat test
    // idempotensi registrasi (§42) bisa mengamati keduanya sekaligus.
    //
    // Pemetaan ini HANYA berlaku di Jest. Bundle produksi (Metro) tetap
    // memakai paket asli dari package.json.
    '^expo-task-manager$': '<rootDir>/src/test-utils/expoBackgroundMock.ts',
    '^expo-background-task$': '<rootDir>/src/test-utils/expoBackgroundMock.ts',
    // BASELINE FIX (audit RC-S17): `expo-sqlite` & `expo-file-system` juga
    // di-ship sebagai ESM murni. Tanpa pemetaan ini 65 dari 107 suite
    // GAGAL DIMUAT pada instalasi bersih ("Unexpected token 'export'"),
    // bukan gagal assertion. Mock-nya SUDAH ADA di repo
    // (src/test-utils/expoSqliteMock.ts) tetapi tidak pernah didaftarkan.
    // Hanya konfigurasi test — tidak menyentuh source produksi.
    // SISTEM LISENSI (RC-S23). Tiga paket berikut sama-sama tidak bisa
    // dimuat langsung oleh ts-jest — dua alasan berbeda:
    //
    //  - `expo-secure-store`  : native module, di-ship sebagai ESM murni
    //    (alasan identik dengan expo-crypto/expo-sqlite di atas).
    //  - `@noble/ed25519` & `@noble/hashes/sha512` : ESM murni juga.
    //
    // PENTING — mock noble TIDAK memalsukan hasil verifikasi. Ia
    // meneruskan ke Ed25519 asli milik Node (`crypto.verify`), sehingga
    // test tanda tangan benar-benar menguji kriptografinya, bukan
    // sekadar mengembalikan `true`. Lihat komentar di berkas mock-nya.
    // Yang TIDAK diuji lewat jalur ini: perilaku @noble di Hermes —
    // itu hanya bisa dibuktikan di perangkat.
    '^expo-secure-store$': '<rootDir>/src/test-utils/expoSecureStoreMock.ts',
    '^@noble/ed25519$': '<rootDir>/src/test-utils/nobleEd25519Mock.ts',
    '^@noble/hashes/sha512$': '<rootDir>/src/test-utils/nobleSha512Mock.ts',
    '^expo-sqlite$': '<rootDir>/src/test-utils/expoSqliteMock.ts',
    '^expo-file-system/legacy$': '<rootDir>/src/test-utils/expoSqliteMock.ts',
    '^expo-file-system$': '<rootDir>/src/test-utils/expoSqliteMock.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};

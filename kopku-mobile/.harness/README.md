# Harness verifikasi offline — sistem lisensi

Berkas di folder ini BUKAN bagian dari aplikasi dan TIDAK ikut ter-bundle.
Ia ada semata-mata karena `node_modules` tidak tersedia dan registry npm
terblokir di lingkungan tempat kode ini ditulis, sehingga `npm test`
(Jest asli) dan `npm run typecheck` tidak dapat dijalankan.

## Isi

- `ambient.d.ts` — deklarasi tipe minimal pengganti `@types/node` &
  `@types/jest`. Lebih longgar daripada tipe aslinya.
- `run-tests.js` — mini-runner kompatibel Jest, satu proses per berkas
  suite agar state modul tidak bocor antar-suite.

## Cara menjalankan

    npx tsc -p tsconfig.license-check.json     # typecheck ter-scope
    npx tsc -p tsconfig.harness-build.json     # emit CommonJS
    ln -sfn ../../app                          .harness/out/app
    ln -sfn ../../../src/components            .harness/out/src/components
    ln -sfn ../../../src/screens               .harness/out/src/screens
    ln -sfn ../../../../src/services/LicenseService.ts \
            .harness/out/src/services/LicenseService.ts
    ln -sfn ../../../../src/security/ed25519.ts \
            .harness/out/src/security/ed25519.ts

    # RC-S52 — berkas root & aset yang dibaca suite struktural.
    for f in babel.config.js package.json jest.config.js app.json \
             eas.json tsconfig.json; do
      ln -sfn ../../$f .harness/out/$f
    done
    ln -sfn ../../assets .harness/out/assets

    # RC-S52 — sumber `.ts` di samping hasil emit `.js`. Diperlukan
    # karena sebagian suite MEMBACA source (mis. SetupLicenseFlow
    # memeriksa `src/config/license.ts`). Tidak bentrok: nama berkasnya
    # berbeda ekstensi, dan Node tetap me-resolve `.js` lebih dulu.
    for d in config security services utils accounting; do
      for f in src/$d/*.ts; do
        ln -sfn "$PWD/$f" ".harness/out/src/$d/$(basename $f)"
      done
    done

    node .harness/run-tests.js

Symlink diperlukan karena sebagian test bersifat STRUKTURAL: ia membaca
source `.tsx`/`.ts` untuk membuktikan sifat yang tidak bisa dibuktikan
lewat pemanggilan fungsi (mis. "tidak ada rute di luar LicenseGate",
"kesehatan kriptografi diperiksa sebelum konfigurasi kunci"). Di Jest
asli symlink ini tidak diperlukan — `__dirname` sudah menunjuk source.

## Status hasil

Hasil dari harness ini berstatus **HARNESS-VERIFIED**, BUKAN
**JEST-VERIFIED**. Keduanya tidak boleh disamakan. Setelah `npm install`
berhasil di mesin Anda, jalankan `npm run typecheck && npm test` — itulah
angka yang sah untuk rilis.

Seluruh folder ini boleh dihapus tanpa memengaruhi aplikasi.

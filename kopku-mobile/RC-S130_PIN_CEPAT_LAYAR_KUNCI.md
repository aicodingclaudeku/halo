# RC-S130 — Buka Kunci PIN Cepat & Layar Kunci Tanpa Papan Ketik Otomatis

Baseline: KOPKU-terbaru20-RC-S129. Tidak ada perubahan skema/migrasi (tetap v79), akuntansi, maupun format hash PIN di database.

## 1. Keluhan

1. Menunggu setelah memasukkan PIN terasa lama.
2. Papan ketik langsung muncul dan mengganggu animasi pembuka (SplashIntro) saat aplikasi dibuka.

## 2. Akar masalah (diukur)

| Temuan | Bukti |
|---|---|
| Hash PIN (RC-S114) = scrypt N=2^14, r=8, dihitung dalam JavaScript murni (@noble/hashes 1.8.0). | `security/pinHash.ts` |
| Di mesin JS **dengan** JIT, scrypt ini cepat; di mesin **tanpa** JIT (Hermes di HP adalah interpreter) sangat lambat. | Benchmark noble-hashes 1.8.0 di server ini: **92 ms** di Node biasa, **5.601 ms** di Node `--jitless`. HMAC-SHA256: 0,25 ms (jitless). |
| scrypt berjalan **sinkron** di thread JS, sehingga layar membeku selama verifikasi. | `verifikasiPin()` sinkron dipanggil dari `unlockWithPin()` |
| Kunci layar dibuka berkali-kali sehari: saat aplikasi dibuka dan setelah auto-lock 5 menit. | `app/index.tsx` `AUTO_LOCK_MINUTES = 5` |
| `PinInput autoFocus` di LockScreen membuka papan ketik saat SplashIntro masih tampil. | `LockScreen.tsx` RC-S120 |

Angka 5,6 detik adalah ukuran di server dengan V8 tanpa JIT, bukan di HP. Hermes dan CPU HP berbeda, tetapi besarnya (beberapa detik) cocok dengan keluhan.

## 3. Perubahan

### 3.1 Verifikasi cepat terikat kredensial — `src/security/unlockCepat.ts` (baru)
- Setelah PIN **sekali** terbukti benar lewat scrypt, aplikasi menyimpan pemverifikasi ringan di **SecureStore** (Android Keystore / iOS Keychain): `tag = HMAC-SHA256(pepper acak 32 byte, userId:ikatan:PIN)`.
- Pembukaan kunci berikutnya hanya menghitung HMAC: < 1 ms, sehingga terasa instan.
- `ikatan` = SHA-256 dari versi, salt, dan hash PIN di database. Bila PIN diganti atau di-reset, database dipulihkan, atau hash dinaikkan versinya, ikatan berbeda, catatan diabaikan, dan verifikasi kembali ke scrypt penuh.
- **Fail-closed.** Catatan rusak, format asing, user berbeda, atau SecureStore gagal menghasilkan `TIDAK_TERSEDIA`, lalu scrypt penuh dijalankan. Jalur ini tidak pernah meloloskan PIN tanpa pembuktian.
- **PIN salah lewat jalur cepat** diberi jeda bertahap sebagai pengganti "biaya" scrypt: 0,8 detik untuk 3 kali pertama, lalu 2, 4, 8, 16 detik, maksimal 30 detik. Hitungan direset saat berhasil.
- **Logout** menghapus catatan.
- **Hanya untuk kunci layar (PIN).** Login dengan password tetap memakai scrypt penuh.
- **Saklar:** `VERIFIKASI_CEPAT_AKTIF` (true). Jika diubah menjadi false, perilakunya kembali ke scrypt di setiap pembukaan.

**Keputusan keamanan yang perlu diketahui.** Ancaman RC-S114 (pemegang salinan database atau berkas backup) **tidak berubah**: pepper dan tag tidak pernah ditulis ke SQLite maupun ke backup. Pihak yang sudah menguasai perangkat dengan akses root dapat membaca SecureStore dan menebak PIN lebih cepat. Dalam skenario itu database aplikasi juga sudah dapat dibaca langsung karena tidak terenkripsi di perangkat. Bila koperasi tidak menerima tradeoff ini, set `VERIFIKASI_CEPAT_AKTIF = false`: layar tetap responsif (lihat 3.2), tetapi setiap pembukaan kembali menunggu scrypt.

### 3.2 scrypt asinkron — `src/security/pinHash.ts`
- `hashPinV2Async` / `verifikasiPinAsync` memakai parameter dan hasil yang identik dengan versi sinkron (diuji), tetapi memberi giliran ke event loop setiap ±16 ms.
- Saat scrypt penuh dipakai (pembukaan pertama, login password), layar tetap hidup dan menampilkan "Memverifikasi PIN…".
- `verifikasiDanNaikkan()` di AuthService kini memakai varian asinkron. Fungsi sinkron lama tetap ada.

### 3.3 Layar kunci — `src/screens/Setup/LockScreen.tsx`, `src/components/PinInput.tsx`
- **Tanpa `autoFocus`.** Papan ketik baru muncul saat kotak PIN diketuk, sehingga animasi pembuka tidak terganggu. Petunjuk "Ketuk kotak PIN untuk mulai mengetik" ditampilkan.
- **Verifikasi otomatis pada digit ke-6.** Tombol "Buka Kunci" tetap ada untuk aksesibilitas dan percobaan ulang. Dobel-submit dicegah.
- **Status satu baris dengan tinggi tetap:** petunjuk, "Memverifikasi PIN…", atau pesan salah.
- **PIN salah:** kotak bergetar (native driver) dan memerah, isian dikosongkan, dan papan ketik tetap terbuka untuk mengetik ulang.
- **Kartu terpusat:** sapaan "Halo, {nama}", nama koperasi di kaki layar.
- **Tombol biometrik** hanya tampil bila user mengaktifkannya **dan** perangkat punya sensor yang sudah didaftarkan. Tidak ada dialog biometrik otomatis saat layar muncul.
- `AuthService.getInfoLayarKunci()` (baru, hanya membaca): mengambil nama dan ketersediaan biometrik, tidak pernah melempar error.
- Struktur RC-S120 dipertahankan: `AreaAmanKeyboard` → `ScrollView`, dengan tata letak tengah di isi gulir.

## 4. Yang sengaja TIDAK diubah
- Parameter scrypt (N=2^14, r=8, p=1), format & versi hash di database, kolom `pin_hash/pin_salt/pin_hash_versi`, migrasi, dan kenaikan v1 → v2.
- Login password, SetupService, UserManagementService (pembuatan/reset PIN), SplashIntro, alur fase `app/index.tsx`.

## 5. Test
- **Baru:** `UnlockPinCepatRcS130.test.ts` — 17/17 lulus dengan @noble/hashes **asli** (versi 1.8.0 diambil dari GitHub dan dibundel di scratch; tidak ditambahkan ke repo). Cakupannya:
  - scrypt async = sync;
  - verifikasi async = sync untuk v1, v2, PIN salah, dan versi asing;
  - ikatan kredensial;
  - COCOK/TIDAK_COCOK/TIDAK_TERSEDIA;
  - PIN diganti, user lain, dan restore;
  - catatan tidak memuat PIN/hash dan pepper baru di setiap simpan;
  - fail-closed (catatan rusak, SecureStore gagal);
  - logout;
  - jadwal jeda;
  - urutan jalur di AuthService;
  - tidak ada penulisan ke database;
  - LockScreen tanpa autoFocus, auto-submit, getar, biometrik kondisional.
- Karena harness repo tidak memiliki `@noble/hashes`, regresi penuh dijalankan seperti biasa dan suite baru dijalankan terpisah dengan `NODE_PATH` menunjuk ke paket noble tersebut.
- **Regresi penuh (harness, 344 berkas suite):** identik dengan RC-S129. `EstimasiAkrualRealtimeRcS74Hotfix` (suite timer) tetap 30/33 saat dijalankan sendiri, sama seperti RC-S129.
- **Typecheck strict** `unlockCepat.ts` + `pinHash.ts` terhadap tipe @noble/hashes asli: bersih.
- **Render visual:** LockScreen dirender di Chromium (shim RN→DOM) dalam 4 keadaan: awal, mengetik, PIN salah, memverifikasi.
- **Status:** HARNESS-VERIFIED. Kecepatan di HP, papan ketik, dan getar **perlu diuji di perangkat Android**. `npm run typecheck && npm test` masih BLOCKED BY ENVIRONMENT.

## 6. Cara menguji di HP
1. Buka aplikasi. Pastikan animasi pembuka berjalan tanpa papan ketik muncul.
2. Ketuk kotak PIN. Papan ketik angka muncul.
3. **Pembukaan pertama setelah update:** ketik PIN. Tampil "Memverifikasi PIN…" (scrypt penuh, beberapa detik, layar tetap hidup).
4. Kunci lagi (tunggu auto-lock 5 menit atau tutup-buka aplikasi), lalu ketik PIN. Aplikasi terbuka hampir seketika.
5. Ketik PIN salah. Kotak bergetar dan memerah, ada jeda singkat, lalu bisa mengetik ulang.
6. Ganti PIN di Pengaturan › Keamanan. Pembukaan berikutnya kembali memakai scrypt sekali, lalu cepat lagi.

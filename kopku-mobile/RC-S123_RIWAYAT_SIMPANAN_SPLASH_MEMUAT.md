# RC-S123 — Riwayat Simpanan, Splash Expo Go vs APK, Animasi Memuat

Baseline: hasil RC-S122. Lingkup: **tampilan saja**. Service, jurnal, database, dan dependency tidak diubah.

## 1. Riwayat Setor Simpanan dipindah ke layar Simpanan

Masalahnya: riwayat setor simpanan berada di tab "Riwayat" **di dalam form Setor Simpanan**. Untuk melihatnya, pengguna harus menekan tombol + lebih dulu, baru kemudian membuka tab tersebut.

Perubahannya:

- **Layar Simpanan** (Transaksi › Penerimaan › Setor Simpanan, `SimpananHistoriScreen`) sekarang punya dua segmen di bagian atas:
  - **Daftar Simpanan**: daftar per jenis yang sudah ada sebelumnya, tidak diubah.
  - **Riwayat**: panel riwayat standar (`RiwayatTransaksiMenu menu="SIMPANAN_SETOR"`) yang menyediakan filter periode, pencarian, status Dibatalkan/Koreksi, dan pintu ke Detail History Transaksi untuk koreksi atau pembatalan.
- **Form Setor Simpanan** (jalur reguler) tidak lagi menampilkan tab Riwayat. Tab tetap ada pada jalur **Simpanan Berjangka**.
- Tombol + diganti tombol berlabel **"Setor Simpanan"**, dan daftar diberi ruang bawah supaya tombol itu tidak menutupi baris terakhir.

## 2. Penyebab splash putih di Expo Go tetapi hitam di APK (EAS)

`app.json` mengunci `userInterfaceStyle: "light"`. Namun di build Android, kunci itu **hanya berlaku bila paket `expo-system-ui` terpasang**, dan proyek ini tidak memasangnya.

- **Expo Go** menerapkan kunci tersebut sendiri, jadi tampilan selalu terang.
- **APK** di ponsel bermode gelap berperilaku berbeda:
  - `useColorScheme()` mengembalikan `'dark'`, sehingga SplashIntro memakai palet navy gelap.
  - Native splash dan latar jendela memakai warna `dark.backgroundColor` (#061429).
  - Layar tunggu `app/index` tidak punya warna latar sendiri, sehingga ikut menampilkan latar jendela gelap itu.

Perbaikannya tanpa menambah dependency:

- SplashIntro **selalu memakai palet terang** (`splashTema.terang`).
- `android.splash.dark.backgroundColor` di `app.json` disamakan dengan warna terang (#F5F8FC). Kode plugin native splash tidak diubah, hanya nilai warnanya.
- Layar tunggu `app/index` diberi latar eksplisit `colors.background`.

Perubahan ini butuh **build EAS baru**, karena warna native splash ditulis saat prebuild.

**Alternatif:** memasang `expo-system-ui` (`npx expo install expo-system-ui`) membuat kunci terang berlaku di seluruh native UI APK, termasuk dialog sistem. Sengaja tidak dilakukan di sini karena berarti menambah dependency.

## 3. Animasi memuat

**Bilah memuat pada splash:**
- Trek dibuat lebih tebal (6 dp).
- Isi bilah berwarna cyan dengan ujung bernuansa hijau logo.
- Pita cahaya menyapu isi bilah secara berulang.
- Kepala bilah berbentuk cincin dengan halo yang berdenyut.

**Komponen baru `IndikatorMemuat`:**
- Logo Kopku dengan dua busur orbit cyan/hijau yang berputar berlawanan arah.
- Logo tampak "bernapas" pelan.
- Label diikuti tiga titik yang menyala bergantian.
- Komponen ini menggantikan `ActivityIndicator` polos di layar tunggu tingkat aplikasi. Labelnya per layar:

| Layar | Label |
|---|---|
| `app/index` | "Memuat" |
| `LicenseGate` | "Memeriksa lisensi" |
| `FirstRunSetup` | "Menyiapkan aplikasi" |

Semua animasi memakai native driver, berhenti saat komponen dilepas, dan menghormati pengaturan "Kurangi gerakan". Durasi splash tetap 5 detik.

## Verifikasi (HARNESS-VERIFIED, bukan JEST-VERIFIED)

**TypeScript**
- Tidak ada error baru selain error lingkungan.
- `IndikatorMemuat` mendapat error lingkungan yang sama persis dengan `SplashIntro` (deklarasi `Animated`/`Image` tidak ada di ambient harness).

**Test struktural**
- 39 suite dijalankan, termasuk dua suite baru/diperbarui: `SplashMemuatRcS123` (10 tes) dan `RiwayatMenuTransaksi` (+3 tes).
- Semua suite yang dapat dimuat lulus.
- Pengecualian karena lingkungan:
  - 1 tes `SplashNativePolos` butuh `expo/config-plugins`.
  - 3 suite butuh `sql.js`.

**Test yang disesuaikan**

| Test | Perubahan |
|---|---|
| `SplashIntroRcS85` | Kontrak "ikut mode perangkat" diganti "selalu terang", ditambah kontrak bilah memuat |
| `SplashNativePolos` | Warna mode gelap sekarang sama dengan warna terang |
| `RiwayatMenuTransaksi` | Riwayat setor sekarang dicek di layar Simpanan; form hanya untuk jalur berjangka |

**Wajib dijalankan lokal:** `npm run typecheck && npm test`, lalu buat build EAS baru dan cek di ponsel dengan mode gelap aktif.

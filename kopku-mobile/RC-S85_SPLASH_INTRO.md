# RC-S85 — Layar Pembuka "Kopku Finance by Kopku"

## Ringkasan
Animasi layar pembuka 5 detik saat aplikasi dibuka: logo Kopku, judul "Kopku Finance", garis "by Kopku", tagline, bilah progres, dan © tahun berjalan, di atas latar navy yang diambil dari warna logo.

## Hasil tes
| | Sebelum (akhir RC-S84) | Sesudah |
|---|---|---|
| Suite | 279 (272 lulus, 7 gagal) | 280 (273 lulus, 7 gagal) |
| Tes | 5.301 (5.296 lulus, 5 gagal) | 5.307 (5.302 lulus, 5 gagal) |
| `tsc --noEmit` | 0 error | 0 error |

Tujuh suite yang gagal identik dengan baseline — dokumen kebijakan `.md` yang tidak ada di ZIP. Bukan regresi. Suite penuh ini juga memvalidasi perbaikan `keyboardShouldPersistTaps` RC-S84 yang sebelumnya hanya diuji per suite.

## Berkas
Baru:
- `assets/img/logo-kopku.png` — dari `assets/icon.png`, 640×640 RGBA, sudut hitam dibuang (mask sudut membulat, transparan).
- `src/components/SplashIntro.tsx` — overlay animasi.
- `src/components/splashLinimasa.ts` — linimasa murni (dapat diuji).
- `src/__tests__/SplashIntroRcS85.test.ts` — 6 tes.

Diubah (aditif):
- `app/_layout.tsx` — `<SplashIntro />` sebagai elemen terakhir di SafeAreaProvider.
- `src/theme/colors.ts` — `splashColors` (hanya dipakai layar pembuka; palet aplikasi tidak berubah).

## Keputusan desain
1. **Overlay, bukan gerbang.** LicenseGate, migrasi database, dan setup/login berjalan di bawahnya sejak detik pertama, sehingga 5 detik tidak menambah waktu inisialisasi dan urutan License Gate -> Setup/Login -> PIN tidak berubah. Sentuhan di bawahnya tertahan selama overlay tampil.
2. **Satu Animated.sequence, tanpa setTimeout** (aturan proyek). Overlay dilepas di callback `finished`. Semua animasi `useNativeDriver: true`; animasi dihentikan saat unmount.
3. Linimasa: 0–0,8 s logo (fade + skala); 0,5–1,2 s judul; 0,9–1,5 s "by Kopku" & tagline; 1,5–4,4 s progres; 4,4–5,0 s memudar. Cincin di belakang logo berdenyut.
4. **Kurangi gerakan** (aksesibilitas) dihormati: tanpa denyut & skala, hanya fade, durasi sama.
5. StatusBar terang selama overlay tampil; `StatusBar style="dark"` aplikasi tetap (dikunci tes lama).

## Keterbatasan
- Tampilan belum dilihat di perangkat (tidak ada emulator/RN renderer di lingkungan ini). Perlu dicek di dev build.
- **Splash native** (sebelum JavaScript termuat) masih bawaan Expo, jadi mungkin ada kilasan singkat berwarna berbeda sebelum animasi. Menyamakannya perlu paket `expo-splash-screen` (latar `#061429`, gambar `assets/img/logo-kopku.png`) dan build ulang native — tidak dilakukan karena menambah dependensi.
- Layar pembuka tampil setiap aplikasi dibuka dari keadaan tertutup (cold start), selalu 5 detik, tanpa tombol lewati — sesuai permintaan.

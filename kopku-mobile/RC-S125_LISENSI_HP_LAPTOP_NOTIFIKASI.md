# RC-S125 — Lisensi HP + Laptop, antrian verifikasi, lonceng notifikasi

Perubahan sengaja dibatasi pada empat hal yang diminta. Tidak ada logika akuntansi,
database, laporan, atau alur setup yang disentuh.

## 1. Satu lisensi = 1 HP/Tablet + 1 Laptop/PC
- `src/security/devicePlatform*.ts` — platform dipilih Metro lewat ekstensi
  (`.android.ts`, `.ios.ts`, `.windows.ts`, `.macos.ts`, `.web.ts`). Tidak mengimpor
  `react-native` ke LicenseService, jadi suite Jest tetap dapat memuatnya.
- `LicenseService.activateLicense()` mengirim field tambahan `device_platform`.
  Verifikasi token Ed25519 tidak berubah; server yang menegakkan slot per kelas.

## 2. Antrian verifikasi (anti-lag)
- `verifyLicense()` kini single-flight: pemanggilan bersamaan berbagi satu request.
- `LicenseGate`: bila token lokal SUDAH sah, layar tidak ditahan menunggu server;
  verifikasi berjalan di latar lalu gate mengevaluasi ulang dari nol (lisensi yang
  dicabut tetap terblokir). Bila token lokal tidak sah, perilaku lama dipertahankan.
  Nomor urut evaluasi mencegah hasil basi menimpa hasil terbaru.

## 3. Lonceng notifikasi di Dashboard (kiri logo koperasi)
- `src/components/LoncengNotifikasi.tsx` — tombol lonceng + lencana jumlah belum dibaca,
  lembar bawah dengan tab **Pengumuman** (dari website) dan **Notifikasi** (sisa masa
  lisensi, batas verifikasi online, jam perangkat, versi baru tersedia).
- `src/services/PengumumanService.ts` — `GET /api/announcements.php`, ETag/304,
  jeda minimum 30 menit, single-flight, cache JSON terpisah, isi disanitasi, tautan https saja.
- `src/store/usePengumumanStore.ts` — state tipis untuk komponen.
- `DashboardScreen.tsx` — hanya menambah `<LoncengNotifikasi />` di header.
  Dashboard tetap tanpa `fetch(`, `setTimeout`, `AppState`, dan tetap satu `setInterval`.

## Uji
Tidak ada assertion test lama yang diubah. Jalankan `npm test` untuk memastikan.

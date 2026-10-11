# RC-S133 — KOPKU Desktop (Windows & macOS) + Sinkron HP lewat QR

## Isi rilis
- **KOPKU Desktop** (Electron 44) menjalankan kode aplikasi yang sama dengan Android: seluruh layar, service, aturan bisnis, laporan, PDF/cetak, ekspor/impor Excel, backup/restore, login, PIN, lisensi. Penyimpanan lokal SQLite (`node:sqlite`), offline penuh. Lihat `desktop/README.md`.
- **Pemasangan HP lewat QR** + **sinkron dua arah** via Wi-Fi lokal/hotspot tanpa internet, terenkripsi ujung-ke-ujung, dengan aturan konflik eksplisit, backup pengaman otomatis, dan arsip perubahan. Lihat `docs/SINKRONISASI.md`.
- Pemetaan arsitektur, padanan fungsi khusus Android, dan risiko: `docs/DESKTOP_ARSITEKTUR.md`.

## Android
Perubahan aditif: menu **Pengaturan › Sinkron Desktop**, `AgenSinkron` (tidak melakukan apa pun sampai HP dipasangkan), pemeriksaan perangkat utama pada tugas otomatis (selalu lolos bila tidak dipasangkan). **Wajib build APK baru** (EAS) karena dependensi `expo-camera` dan plugin `withKameraPindaiQr` / `withLanSyncCleartext`. `SCHEMA_VERSION` tetap 80 — tabel & trigger `sync_*` hanya dipasang saat perangkat dipasangkan.

## Pemeriksaan
| Pemeriksaan | Hasil |
|---|---|
| `tsc --noEmit` | 0 galat |
| Uji e2e sinkron (`desktop/test/e2e/jalankan.js`, 2 proses, HTTP + SQLite asli) | 31/31 lulus |
| Jest berkas terkait (87 berkas) | Lulus kecuali 6 berkas yang JUGA gagal pada RC-S132 asli (merujuk dokumen kebijakan yang tidak ada di ZIP): PendapatanKoperasiRcS67, ReleaseHardeningRcS57, TemporalIntegrityRcS58, SimpananDetailScreen, PermissionMatrixUiRcS132, ImbalHasilTetapRcS67_6 |
| Migrasi v80 di `node:sqlite` | 70 tabel, semua ber-PK eksplisit |
| Uji asap Electron | Layar setup tampil; QR pemasangan dibuat oleh server LAN desktop |

## Batasan diketahui
Aplikasi desktop belum ditandatangani (SmartScreen/Gatekeeper); installer `Setup.exe` dibangun di Windows; Windows Hello tidak didukung (PIN/password); tugas latar desktop hanya saat aplikasi terbuka; logo koperasi tidak ikut tersinkron; sinkron memerlukan desktop terbuka di jaringan yang sama (jaringan dengan AP isolation memblokir).

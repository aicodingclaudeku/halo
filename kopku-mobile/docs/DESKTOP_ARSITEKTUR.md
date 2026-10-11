# KOPKU Desktop — Pemetaan Arsitektur, Rencana, dan Risiko Kompatibilitas

## 1. Peta aplikasi Android (RC-S132, skema v80)

| Lapisan | Isi | Dipakai ulang di desktop? |
|---|---|---|
| Entry | Expo Router (`app/_layout.tsx`, `app/index.tsx`, `app/license.tsx`) | Ya, apa adanya |
| Navigasi | React Navigation 7: 5 tab + 4 stack, ±135 layar, gerbang izin `izinRute.ts` | Ya; tab bar digambar ulang sebagai sidebar |
| Service | 84 service TypeScript (akuntansi double-entry, simpanan, pinjaman, SHU, aset, utang, laporan, backup, impor/ekspor) | Ya, 100% tanpa perubahan |
| Database | `expo-sqlite`, 70 tabel, migrasi berantai sampai v80 | Ya — skema & migrasi sama |
| Keamanan | Lisensi Ed25519 + server PHP, PIN, biometrik, backup terenkripsi XChaCha20 | Ya |
| Ekspor | PDF (`expo-print`), Excel/CSV, bagikan (`expo-sharing`) | Ya, lewat shim |
| Impor | `expo-document-picker` (Excel data awal, berkas backup) | Ya, lewat shim |

## 2. Fungsi khusus Android → padanan desktop

| Modul Android | Padanan desktop (`desktop/shims` + `electron/hosts`) |
|---|---|
| `expo-sqlite` | `node:sqlite` bawaan Electron 44 (SQLite 3.53, berkas asli di disk, WAL) — tanpa modul native yang perlu dikompilasi |
| `expo-file-system` (legacy & `File`) | Host berkas Node; URI `kopkufs://local/…` dibatasi ke folder data |
| `expo-secure-store` | `safeStorage` Electron → DPAPI (Windows) / Keychain (macOS) |
| `expo-print` | `printToPDF` Chromium + dialog cetak sistem (sidecar HTML untuk cetak kualitas penuh) |
| `expo-sharing` | Lembar aksi berkas: Simpan Sebagai, Buka, Tampilkan di Folder, Cetak |
| `expo-document-picker` / `expo-image-picker` | Dialog Buka berkas sistem |
| `expo-local-authentication` | Touch ID (macOS); Windows → tidak tersedia, otomatis PIN/password |
| `expo-background-task` / `expo-task-manager` | Dijalankan berkala selama aplikasi terbuka + catch-up saat startup |
| `@react-native-community/datetimepicker` | Kalender modal (mouse/keyboard) |
| `Alert.alert` (no-op di web) | Dialihkan ke pop-up aplikasi `notify()` |
| `fetch` ke server lisensi | Diteruskan proses utama (tanpa CORS), HTTPS saja |
| `devicePlatform` | Melapor `windows`/`macos` → slot Laptop/PC di `LicensePolicy.php` |

## 3. Perubahan pada kode bersama (semua aditif)

| Berkas | Perubahan | Efek di Android |
|---|---|---|
| `metro.config.js` (baru) | Konfigurasi default Expo + blockList folder build desktop; shim hanya saat `KOPKU_DESKTOP=1` & platform web | Tidak ada |
| `app.config.js` (baru) | Mengembalikan `app.json` apa adanya kecuali `KOPKU_DESKTOP=1` | Tidak ada |
| `babel.config.js` | Opsi `unstable_transformImportMeta` hanya saat `KOPKU_DESKTOP=1` | Tidak ada |
| `app/_layout.tsx` | `<AgenSinkron/>` (diam sampai HP dipasangkan), `<DesktopHost/>` (null di Android), `<BingkaiAplikasi>` (Android: anak apa adanya) | Tidak ada sebelum dipasangkan |
| `RootNavigator.tsx` | Spread `propsTabDesktop`/`opsiTabDesktop` (objek kosong di Android) + rute `SinkronPerangkat` | Rute baru saja |
| `izinRute.ts`, `PengaturanScreen.tsx` | Rute & menu *Sinkron Desktop* (izin `backup`) | Menu baru |
| `StartupTasks.ts`, `SimpananBerjangkaBackgroundTask.ts` | Pemeriksaan perangkat utama (sinkron, tanpa jeda async tambahan) | Tidak ada bila tidak dipasangkan |
| `DatePicker.tsx` | Menutup kalender juga di web | Tidak ada |
| `SetupWizardScreen.tsx` | `<TombolHubungkanHpSetup/>` (null di Android) | Tidak ada |
| `devicePlatform.web.ts` | Melapor OS desktop | Tidak dipakai Android |
| `app.json` | Plugin `./plugins/withKameraPindaiQr` (izin kamera untuk QR) & `./plugins/withLanSyncCleartext` | Izin kamera + HTTP LAN (lihat risiko) |
| `package.json` | `expo-camera`; devDependencies `react-native-web`, `@expo/metro-runtime` | Butuh build APK baru |

Kode khusus desktop memakai berkas `*.web.tsx`/`*.web.ts` sehingga **tidak masuk bundel Android**.

### Tampilan desktop (RC-S133.4) — berbeda dari HP, fungsi sama
| Berkas desktop | Peran |
|---|---|
| `src/theme/colors.web.ts`, `form.web.ts`, `ui.web.ts`, `modal.web.ts` | Token desain desktop (latar abu dingin, emerald, kontrol 38 px, sudut 6/8/12, dialog terpusat). Semua layar otomatis memakai tampilan desktop tanpa diubah. |
| `src/desktop/desktopNav.web.tsx` + `src/desktop/shell/*` | Kerangka: sidebar gelap bergrup dengan sub-menu langsung (bisa diciutkan, Ctrl+\\), bilah atas (cari Ctrl+K, status sinkron, lonceng, menu akun + Keluar), bilah status (database lokal, koperasi, tahun buku, pengguna, sinkron, lisensi, versi), lebar konten per jenis layar. |
| `src/desktop/katalogMenu.ts` | Katalog tujuan sidebar & palet perintah — salinan pintu masuk hub (rute & parameter sama), disaring Permission Matrix. Diuji `KatalogMenuDesktop.test.ts`. |
| `src/components/AppHeader.web.tsx` | Header halaman: jejak (Tab › layar sebelumnya › layar), judul besar, tombol kembali (Alt+←), aksi layar. |
| `src/components/AppNotificationHost.web.tsx` | Dialog konfirmasi desktop (Enter = utama, Esc = batal). |
| `src/screens/Dashboard/DashboardScreen.web.tsx` | Dashboard grid (KPI, aksi cepat, statistik, panel lisensi/sinkron/identitas/panduan) — kueri & tujuan navigasi sama dengan Dashboard HP. |
| `src/desktop/BingkaiAplikasi.web.tsx` | Layar lisensi/setup/masuk/kunci dalam bingkai: panel merek kiri + formulir terpusat. |
| `desktop/scripts/build-renderer.js` | Gaya global: font sistem (Segoe UI/SF), scrollbar tipis, cincin fokus keyboard. |

## 4. Rencana bertahap (yang dijalankan)

1. Host SQLite `node:sqlite` + uji migrasi v80 nyata di Node (70 tabel, semua ber-PK eksplisit, tanpa BLOB).
2. Mesin sinkron `src/sync/` + uji e2e dua proses.
3. Shim modul native + proses utama Electron + build renderer `expo export`.
4. Tampilan desktop: sidebar gelap bergrup + palet Ctrl+K, bilah atas & status, dashboard desktop, header halaman, dialog, bingkai layar masuk; lembar aksi berkas, kalender.
5. Layar Sinkron (desktop: QR; HP: pindai kamera) + opsi "Ambil data dari HP" di setup.
6. Typecheck, Jest, uji asap Electron, paket Windows/macOS.

## 5. Risiko kompatibilitas & batasan

1. **APK baru wajib** untuk fitur pemasangan (modul `expo-camera` & manifest). Bangun ulang dengan EAS seperti biasa.
2. **HTTP polos di LAN** (`usesCleartextTraffic`) diaktifkan karena TLS tidak dapat diterbitkan untuk IP lokal; seluruh isi tetap terenkripsi ujung-ke-ujung. Panggilan lisensi tetap HTTPS.
3. **Aplikasi desktop belum ditandatangani** (SmartScreen/Gatekeeper memberi peringatan). Installer `Setup.exe` dibangun di Windows.
4. **Windows Hello** tidak didukung (Electron tidak menyediakannya tanpa modul native) → PIN/password. Touch ID di macOS didukung.
5. **Tugas latar** desktop hanya berjalan saat aplikasi terbuka (OS desktop tidak menjalankan tugas latar aplikasi tertutup). Catch-up saat startup menutup celahnya, sama seperti HP.
6. **Sinkron hanya saat desktop terbuka** dan HP berada di jaringan yang sama. Jaringan tamu/kantor yang mengisolasi klien (AP isolation) akan memblokir koneksi — gunakan hotspot HP atau router rumah.
7. **Tampilan memuat ulang** setelah data baru diterima: Dashboard desktop menyegarkan angka otomatis; layar lain menampilkan data baru saat dibuka ulang (atau tombol *Muat ulang tampilan*).
8. **Satu HP per desktop** (sesuai lisensi 1 HP + 1 PC). Memasangkan HP lain mengganti pemasangan lama.
9. **Logo koperasi** (berkas gambar) tidak ikut tersinkron — yang disinkronkan hanya database. Bila logo tidak tampil di salah satu perangkat, pilih ulang logo di perangkat tersebut (Identitas Koperasi).
10. **Transaksi hanya di desktop (RC-S133.4)**: HP yang terpasang menjadi cadangan baca-saja, sehingga transaksi ganda lintas perangkat tidak mungkin terjadi. Konsekuensinya: selama terpasang, HP tidak dapat dipakai mencatat transaksi di lapangan — putuskan pemasangan bila HP perlu berdiri sendiri.
11. **Layar hub di desktop** memakai daftar menu yang sama dengan HP (lebar dibatasi 1000 px); navigasi cepat utamanya lewat sidebar & palet Ctrl+K.

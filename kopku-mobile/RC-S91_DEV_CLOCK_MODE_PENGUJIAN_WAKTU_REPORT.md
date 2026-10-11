# RC-S91 — Menu Developer: Mode Pengujian Waktu

## Permintaan

Tambahkan menu "Developer" (dikunci password `01022003`, bisa on/off) berisi
mode pengujian waktu: real-time (default), waktu yang bisa ditentukan
(tanggal+jam), dan tahun yang bisa disesuaikan secara cepat.

## Desain & keputusan kunci

**Satu titik integrasi, bukan mengganti `new Date()` di mana-mana.**
`getTanggalLokalHariIni()` di `utils/tanggal.ts` sudah didokumentasikan
sebagai "satu-satunya sumber 'hari ini' untuk keperluan AKUNTANSI" dan
dipakai di 80+ berkas (akrual, non-accrual, tutup periode, pajak,
lisensi, dst.). Menyambungkan jam simulasi di SATU tempat ini berarti
seluruh mesin akuntansi otomatis ikut memakai waktu simulasi tanpa
menyentuh 80+ file itu satu per satu — sekaligus meminimalkan risiko
regresi.

**Sinkron, bukan async.** Karena dipanggil dari banyak call site sinkron
yang sudah ada, jam simulasi disimpan sebagai cache in-memory di
`DevClockService` (bukan dibaca dari SQLite setiap kali dipanggil).
Cache dimuat sekali saat startup (`app/index.tsx`) dan diperbarui setiap
kali developer mengubah pengaturan di layar Developer.

**Gagal aman (fail-safe) ke waktu asli.** Kalau `app_config` belum pernah
diisi, belum sempat dimuat, atau baris rusak — `getWaktuSekarang()`
SELALU kembali ke `new Date()` asli. Tidak ada jalur di mana kegagalan
baca konfigurasi diam-diam membuat aplikasi memakai tanggal simulasi
yang tidak diinginkan.

**Timestamp audit TIDAK ikut disimulasikan.** `created_at`, `updated_at`,
kolom `waktu` di `audit_log` tetap memakai `new Date()` ASLI — konsisten
dengan keputusan yang sudah didokumentasikan di `tanggal.ts` untuk
`toISOString()`. Jam simulasi hanya memengaruhi "tanggal akuntansi hari
ini", bukan jejak forensik kapan sesuatu benar-benar terjadi.

**Password tetap, tidak disimpan di DB.** `01022003` di-hardcode di
`DevClockService.ts` — bukan kredensial user/PIN aplikasi, sengaja tidak
ikut tersimpan di `app_config` supaya tidak terbawa kalau file database
(hasil backup) dibaca orang lain. Diminta ULANG setiap kali layar
Developer dibuka (tidak diingat antar sesi).

**Gerbang password, bukan permission role.** Menu "Developer" didaftarkan
di luar array `MENU` yang difilter `can()` di `PengaturanScreen.tsx` —
pola yang sama persis dengan menu "Lisensi" yang sudah ada. Keamanannya
murni dari password, bukan matrix permission.

## Perubahan

### File baru
- **`src/services/DevClockService.ts`** — cache in-memory + persistensi
  `app_config` (4 key: `dev.jam_uji_aktif`, `dev.jam_uji_mode`,
  `dev.jam_uji_basis_iso`, `dev.jam_uji_ditetapkan_epoch`). Fungsi utama:
  `getWaktuSekarang()` (sinkron), `muatJamUjiDariDb()`, `setJamUjiAktif()`,
  `setModeRealtime()`, `setWaktuKustom()`, `setTahunKustom()`,
  `cocokkanPasswordDeveloper()`. Waktu kustom BERJALAN MAJU mengikuti
  waktu asli sejak ditetapkan (bukan beku di satu titik).
- **`src/screens/Pengaturan/DeveloperScreen.tsx`** — gerbang password,
  lalu: toggle on/off, pilihan Real-time/Waktu Kustom, form tanggal+jam,
  form "Ubah Tahun Cepat" (mengganti tahun saja, bulan/tanggal/jam
  mengikuti waktu berjalan), pratinjau waktu berjalan (tick per detik),
  dan banner peringatan penggunaan.
- **`src/__tests__/DevClockService.test.ts`** — 12 test: password,
  fail-safe ke waktu asli, persistensi lewat `app_config`, mode kustom
  (termasuk berjalan maju & validasi format), ubah tahun cepat (dari
  basis kustom maupun dari realtime), validasi rentang tahun.

### File diubah
- **`src/utils/tanggal.ts`** — `getTanggalLokalHariIni()` memanggil
  `getWaktuSekarang()` (DevClockService) alih-alih `new Date()` langsung.
  Default (mode pengujian mati) hasilnya PERSIS sama seperti sebelumnya.
- **`app/index.tsx`** — memanggil `muatJamUjiDariDb(db)` sekali di
  `evaluatePhase()`, sebelum fase READY.
- **`src/screens/Pengaturan/PengaturanScreen.tsx`** — kartu menu
  "Developer" ditambahkan (pola sama dengan kartu "Lisensi" — di luar
  `menuTampil`/`can()`).
- **`src/navigation/RootNavigator.tsx`** — rute `Developer` didaftarkan
  di `PengaturanStack`, tepat setelah `PermissionMatrix`.
- **`src/__tests__/IdentitasRuteIndependenRcS49b.test.ts`** — test guard
  yang mendaftar rute `PengaturanStack` secara eksplisit diperbarui
  memasukkan `'Developer'` (perubahan legitimate mengikuti penambahan
  rute baru, bukan melonggarkan assertion — daftar tetap persis/`toEqual`,
  urutan tetap dicocokkan terhadap urutan pendaftaran sungguhan).

## Verifikasi

- `tsc --noEmit`: **0 error** (dijalankan 2×: setelah service+layar
  dibuat, dan final setelah semua berkas selesai).
- `DevClockService.test.ts`: **12/12 lulus**.
- `TanggalLokalAkrual.test.ts` + `CairkanPinjamanTanggalPencairan.test.ts`
  (test tanggal yang paling sensitif terhadap perubahan `tanggal.ts`):
  **22/22 lulus**, tanpa perubahan sama sekali (default REALTIME = perilaku
  lama persis).
- Regresi menyeluruh — **seluruh 291 file test** (290 lama + 1 baru),
  dipecah 6 batch:
  - **0 regresi baru.** Satu-satunya perubahan status test adalah
    `IdentitasRuteIndependenRcS49b.test.ts` (guard rute PengaturanStack),
    yang memang SEHARUSNYA berubah karena rute baru ditambahkan — sudah
    diperbarui & lulus lagi (17/17).
  - **7 kegagalan pra-eksis tetap sama** seperti sesi-sesi sebelumnya,
    seluruhnya `ENOENT` pada dokumen `.md` root yang tidak ikut
    ter-upload di ZIP ini (`KontrolAkhirRcS53`, `PolicyRegisterRcS53`,
    `PendapatanKoperasiRcS67`, `PendapatanBungaCoaRcS70_6`,
    `ImbalHasilTetapRcS67_6`, `ReleaseHardeningRcS57`,
    `TemporalIntegrityRcS58`) — tidak satu pun menyentuh modul yang
    diubah sesi ini.
  - Total test individual yang lulus: 795+701+1039+799+1138+975 ≈
    **5.447 passed** dari total ~5.454.

## Cara pakai (untuk mnaz)

1. Pengaturan → kartu "Developer" (paling bawah) → masukkan `01022003`.
2. Nyalakan toggle "Mode Pengujian Waktu".
3. Pilih "Real-time" (kembali ke waktu asli) atau "Waktu Kustom" (atur
   tanggal+jam lewat form yang muncul).
4. Untuk lompat tahun cepat tanpa mengatur ulang tanggal/jam: bagian
   "Ubah Tahun Cepat".
5. **Matikan toggle sebelum kembali memakai database koperasi
   sungguhan** — banner peringatan di layar sudah mengingatkan ini.

## Batasan yang perlu diketahui

- Hanya memengaruhi "tanggal akuntansi hari ini" (`getTanggalLokalHariIni`/
  `getPeriodeLokalSekarang`) — TIDAK memengaruhi timestamp audit trail,
  dan TIDAK mengubah jam perangkat/OS sungguhan.
- Belum ada indikator global (mis. banner permanen di Dashboard) yang
  mengingatkan kalau mode pengujian masih menyala di luar layar Developer
  itu sendiri — kalau diperlukan, ini bisa ditambahkan sesi berikutnya.

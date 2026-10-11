# RC-S131 — Keamanan: Buat & Ganti PIN, UI/UX Menu Keamanan

Baseline: KOPKU-terbaru21-RC-S130. Tidak ada perubahan skema/migrasi (tetap v79), service penyimpanan PIN, maupun format hash.

## 1. Keluhan
"Di Keamanan tidak bisa menambahkan PIN baru."

## 2. Akar masalah
`KeamananScreen` (RC-S121) hanya menampilkan formulir PIN bila `pinState === 'PIN_ENABLED_SETUP_REQUIRED'`. State itu berasal dari penanda **global** `security.pin_belum_ditetapkan`, yang hanya bernilai 1 bila setup awal dilewati tanpa PIN. Akibatnya:
1. PIN yang sudah ada **tidak pernah bisa diganti**. Tidak ada tombol apa pun untuk itu.
2. Pengguna buatan Admin (`createUser`) mendapat PIN **acak yang memang tidak dapat dipakai** (`pinAcakTidakDapatDipakai`). Komentar service menyebut PIN itu "ditetapkan sendiri oleh pemiliknya lewat Pengaturan > Keamanan", tetapi formulirnya tidak pernah muncul karena penanda global sudah 0. Begitu aplikasi terkunci, layar kunci menanyakan PIN yang tidak pernah mereka ketahui.

## 3. Perbaikan
- **Formulir PIN**:
  - `SETUP_REQUIRED` → formulir "Buat PIN" langsung terbuka seperti sebelumnya, tanpa verifikasi.
  - Selain itu → tombol **Ganti PIN** (PIN aktif) / **Atur PIN** (PIN nonaktif) membuka formulir.
- **Bukti identitas sebelum mengganti**: isian "PIN saat ini atau password login". Fungsinya `AuthService.verifikasiIdentitasPengguna()` (baru):
  - teks 6 digit dicoba sebagai PIN (jalur cepat RC-S130, lalu scrypt), kemudian sebagai password;
  - pengguna yang tidak tahu PIN-nya (termasuk pengguna buatan Admin) cukup memakai password login;
  - gagal → jeda bertahap yang sama dengan PIN salah;
  - pengguna nonaktif ditolak.
- **Validasi PIN baru** (`utils/pinBaru.ts`, murni):
  - 6 digit;
  - konfirmasi harus sama, dengan indikator langsung "PIN cocok" atau "Konfirmasi PIN berbeda";
  - PIN terlalu mudah **ditolak**: 6 angka sama (111111) dan urutan naik/turun (123456, 987654).
  - Tombol Simpan aktif hanya bila semua syarat terpenuhi.
- **Penyimpanan tetap** `aturPinKunciAplikasi` + `tandaiPinSudahDitetapkan`. Setelah itu `siapkanPinCepatSetelahDiatur()` (baru) langsung menyiapkan jalur buka kunci cepat untuk PIN baru, sehingga pembukaan berikutnya sudah instan.
- **UI/UX**:
  - kop penjelasan "Keamanan Aplikasi";
  - kartu "Kunci Aplikasi" dengan ikon, saklar, dan lencana status (Aktif / PIN belum dibuat / Nonaktif) plus info kunci otomatis 5 menit;
  - formulir rapi: tombol Batal + Simpan dan tips memilih PIN;
  - kartu "Biometrik" dengan keterangan bahwa biometrik dipakai di layar kunci.
- **Layar kunci**: tautan keluar kini berbunyi "Lupa PIN? Keluar, lalu masuk dengan password".

## 4. Tidak diubah
`aturPinKunciAplikasi`, `SecurityService` (state PIN), `createUser`, format & parameter hash, migrasi, saklar "Gunakan PIN" dan biometrik (logika sama persis).

## 5. Test
- **Baru:** `KeamananPinRcS131.test.ts` — 8/8 lulus dengan SQLite + @noble/hashes asli (dijalankan dengan `NODE_PATH` ke paket scratch, seperti RC-S130). Cakupannya:
  - validasi PIN (mudah ditebak, konfirmasi);
  - **alur nyata pengguna buatan Admin**: PIN acak tidak bisa membuka kunci → verifikasi dengan password → atur PIN → jalur cepat siap → buka kunci berhasil;
  - ganti PIN dengan PIN lama: PIN baru berlaku dan PIN lama ditolak;
  - verifikasi menolak PIN/password salah dan pengguna nonaktif;
  - struktur layar (formulir tidak lagi hanya SETUP_REQUIRED; urutan verifikasi → simpan → jalur cepat).
- **Regresi penuh (harness):** identik dengan RC-S130 per nama test.
- **Render visual** layar Keamanan (awal, ganti PIN, buat PIN dengan galat) di Chromium.
- **Status:** HARNESS-VERIFIED. Uji di perangkat Android tetap diperlukan.

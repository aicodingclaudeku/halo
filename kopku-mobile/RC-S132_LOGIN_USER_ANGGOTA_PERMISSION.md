# RC-S132 — Tombol Keluar, Login per User, Akun Anggota, Permission Matrix Berlaku

Baseline: KOPKU-terbaru22-RC-S131. Skema naik **v79 → v80** (aditif murni: satu kolom + satu indeks).

## 1. Permintaan
"Tambahkan tombol keluar di pengaturan lalu ada menu login setelah keluar di mana kita bisa login sesuai dengan user management; untuk pembuatan user anggota pilih anggota, ganti fitur nama lengkap jadi pilih anggota; dan permission matrix-nya berfungsi sesuai mestinya. Buat profesional, modern, dan rapi."

## 2. Temuan audit
1. **Tidak ada tombol Keluar.** Sesi hanya bisa diakhiri lewat "Lupa PIN" di layar kunci.
2. **Logout tanpa PIN langsung masuk lagi sebagai Admin.** Bila PIN nonaktif (`PIN_DISABLED`), startup memanggil `mulaiSesiTanpaPin()`. Fungsi itu memulai sesi untuk Admin pertama, sehingga layar Login tidak pernah tampil.
3. **User ber-role Anggota tidak terhubung ke data anggota.** Namanya diketik bebas, jadi tidak ada kaitan apa pun ke anggota sebenarnya.
4. **Permission Matrix hanya berlaku di service.**
   - `requirePermission()` menolak saat *menyimpan*.
   - Menu, tab, kartu Dashboard, dan layar baca (laporan keuangan, buku besar, backup) tetap terbuka untuk semua role. Laporan tidak pernah ditolak karena tidak ada penulisan.
   - Matrix juga punya kelemahan:
     - izin Admin hanya dikunci di chip UI; service menerima pencabutan izin Admin, termasuk `user_management`;
     - baris tidak konsisten seperti "Buat tanpa Lihat" bisa disimpan;
     - perubahan pada role yang sedang login baru berlaku setelah login ulang.

## 3. Perbaikan

### A. Keluar & Login
- **Pengaturan:**
  - kartu akun di atas (inisial, nama, role);
  - tombol **Keluar** (merah, garis tepi) dengan dialog konfirmasi. Tombol ini ada di atas Zona Berbahaya.
- **Proses Keluar:**
  - `logout()` membersihkan sesi dan jalur PIN cepat, lalu menulis penanda `koperasi.session.keluarManual`;
  - cache izin dan pengguna di store dikosongkan;
  - aplikasi kembali ke layar Login.
- **Startup:** bila penanda keluar manual ada, aplikasi menampilkan **Login** walau PIN nonaktif, alih-alih sesi otomatis. Login yang berhasil menghapus penanda dan mengingat username terakhir.
- **Layar Login:**
  - nama koperasi tampil;
  - username terakhir terisi otomatis;
  - ikon pada kolom;
  - tombol **Tampilkan password**;
  - Enter langsung masuk;
  - teks bantuan "Akun dibuat oleh Admin di Pengaturan › User Management".
- **Akun yang bisa masuk:** semua akun aktif dari User Management, memakai username + password masing-masing. Izin sesi mengikuti role akun.

### B. Akun Anggota = pilih anggota
- **Migrasi v80** (`migrasiV80`, idempoten): `app_user.anggota_id TEXT REFERENCES anggota(id)` dan indeks unik parsial `idx_app_user_anggota`. Satu anggota hanya boleh punya satu akun.
- **Form user:**
  1. **Hak akses** — role dipilih lebih dulu.
  2. Untuk role **Anggota**, kolom "Nama Lengkap" diganti **pemilih anggota** (picker bersama, tanpa batas). Nama akun otomatis mengikuti nama anggota dan ditampilkan sebagai tautan "Nama akun: … · No. …".
  3. Password.
- **Service** (`tentukanTautanAnggota`):
  - Anggota wajib dipilih.
  - Anggota yang keluar atau meninggal ditolak.
  - Anggota yang sudah punya akun ditolak.
  - Role lain tidak pernah menautkan.
  - Mengubah role dari Anggota melepas tautan. Menjadikan akun Anggota lewat dialog role saja ditolak, karena anggota harus dipilih di form.
- **Daftar user:** lencana "No. A001" untuk akun Anggota.
- **Integritas data:**
  - anggota yang punya akun tidak dapat dihapus (pesan menyebut username);
  - "Hapus Data Transaksi" melepas tautan lebih dulu, sehingga tidak ada referensi menggantung dan akunnya tetap ada.

### C. Permission Matrix berlaku di seluruh aplikasi
- **`navigation/izinRute.ts`:** satu peta syarat untuk **setiap** rute di RootNavigator, berupa resource + aksi. Untuk form tambah/ubah cukup salah satu izin. Rute yang tidak terdaftar ditutup (fail-closed).
- **Gerbang layar** `GerbangIzinLayar`:
  - dipasang lewat `screenLayout` di keempat stack, jadi berlaku dari pintu mana pun (menu, Dashboard, tautan dalam layar);
  - tanpa izin, yang tampil adalah kartu **"Akses dibatasi"** yang menyebut role, aksi, dan modul, plus tombol Kembali;
  - layar asli tidak di-mount, sehingga datanya pun tidak dimuat.
- **Menu disaring:**
  - hub Penerimaan, Pengeluaran, Penyesuaian, Data, Laporan, dan Keluar Anggota;
  - **Aksi Cepat** di Dashboard;
  - tab bawah Data, Transaksi, Laporan disembunyikan bila tidak ada modul yang bisa dilihat. Tab Laporan hanya tampil bila ada izin laporan atau history transaksi, jadi tidak ada tab berisi menu kosong.
- **Service:**
  - `updateRolePermission` menolak perubahan role **Admin** (`IzinAdminTerkunciError`);
  - perubahan dinormalisasi (aksi apa pun ⇒ Lihat);
  - setiap perubahan dicatat di `audit_log` (`UPDATE_PERMISSION`);
  - baru: `pulihkanIzinDefaultRole` (`RESET_PERMISSION_DEFAULT`).
- **Layar Permission Matrix** (didesain ulang):
  - tab role berikon, dengan Admin ditandai gembok;
  - kartu ringkasan role berisi keterangan dan tiga angka: modul terbuka, modul bisa input, beda dari bawaan;
  - tombol **Pulihkan izin bawaan** dengan konfirmasi;
  - panel "Cara kerja";
  - kartu per modul dengan keterangan isi modul, lencana **Tertutup/Diubah**, dan lima chip berikon sejajar satu baris;
  - menyalakan Buat/Ubah/Setuju/Export otomatis menyalakan Lihat; mematikan Lihat menutup modul;
  - perubahan langsung tersimpan (optimistis, dikembalikan bila gagal). Bila role yang diubah adalah role pengguna yang sedang login, cache izin sesi langsung disegarkan.

## 4. Keputusan kebijakan yang perlu dikonfirmasi
1. **Cakupan data akun Anggota.**
   - Permission Matrix mengatur *modul*, bukan *baris data*. Akun Anggota dengan izin Lihat Simpanan melihat simpanan **semua** anggota, dan Dashboard menampilkan total koperasi.
   - Bila akun Anggota hanya boleh melihat datanya sendiri, perlu RC lanjutan: penyaringan per anggota di layar baca dan Dashboard khusus anggota. Tautan `anggota_id` di RC ini adalah dasarnya.
2. **Menu Developer** tetap terlihat untuk semua role karena dikunci password developer (keputusan RC sebelumnya). Bila perlu, bisa dibatasi ke role dengan izin Ubah Pengaturan.
3. **Password awal akun lama:** untuk instalasi lama, password awal = PIN lama (RC-S117). Teks bantuan di Login menyebutkannya.

## 5. Test
- **Baru:** `PermissionMatrixUiRcS132.test.ts` — **28/28** lulus (SQLite + scrypt @noble/hashes asli).
  - **Peta rute:** setiap rute RootNavigator terdaftar, resource/aksi sah, fail-closed, Admin dapat membuka semua.
  - **Matriks bawaan:** Anggota hanya melihat; Petugas tanpa user/backup/akun.
  - **Fungsi bantu:** `ruteDariAksi`, form create/edit.
  - **Aturan klik dan normalisasi**, termasuk konsistensi matriks bawaan.
  - **Service matrix:** Admin terkunci, normalisasi + audit, pulihkan bawaan, non-Admin ditolak.
  - **Migrasi v80:** pada tabel bentuk v79 kolom bertambah, idempoten, data utuh, indeks unik ada.
  - **Akun Anggota:** wajib pilih, nama mengikuti anggota, duplikat/keluar ditolak, role lain tidak menautkan, sunting/ganti role, guard hapus anggota, Hapus Data Transaksi melepas tautan.
  - **Keluar/Login:** penanda keluar manual, username terakhir, akun Anggota login dengan password dan mendapat izin role ANGGOTA.
  - **Struktur layar:** Pengaturan, startup, Login, Form user, gerbang di 4 stack, penyaring hub/Dashboard, layar Matrix.
- **Penyesuaian test lama** (DIPERBARUI RC-S132, tidak ada yang dihapus):
  - kunci `SCHEMA_VERSION` 79→80 (dan ambang `currentVersion < 81`) di 26 berkas test;
  - sensus `PickerAnggotaRcS118` menambah `UserFormScreen` sebagai pemakai `AnggotaPicker`.
- **Regresi penuh (harness):**
  - 345 suite, 6122/6159 lulus;
  - daftar test gagal **identik** dengan baseline RC-S130 (37 kegagalan lama, nol baru);
  - 24 suite tidak dapat dijalankan oleh harness, sama seperti sebelumnya.
- **Typecheck:** tidak ada galat baru di layar. Galat baru di service hanya pola stub `expo-sqlite`/modul native yang sudah ada di baseline.
- **Render visual (Chromium):** Pengaturan (Admin, Anggota), Login, User Management, Form user (Petugas, Anggota), Permission Matrix (Pengurus, Anggota, Admin), Akses dibatasi.
- **Status:** HARNESS-VERIFIED. Jest asli dan uji perangkat Android belum dijalankan.

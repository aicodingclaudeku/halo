# Sinkronisasi HP ⇄ KOPKU Desktop

## Ringkas
- **Pemasangan sekali lewat QR.** Desktop menampilkan QR; HP memindainya (Pengaturan › Sinkron Desktop). QR hanya untuk memasangkan perangkat — tidak berisi lisensi maupun data.
- **Tanpa internet.** HP menghubungi desktop langsung lewat Wi-Fi atau hotspot yang sama (HTTP ke IP lokal, port 47821–47840).
- **Satu arah: Desktop → HP (sejak RC-S133.4).** Setelah terpasang, **KOPKU Desktop adalah buku induk** — satu-satunya tempat transaksi dan input data. HP menjadi **penyimpanan cadangan** baca-saja yang menerima salinan perubahan desktop saat login, saat aplikasi kembali ke depan, dan tiap 60 detik. Dengan begitu transaksi tidak mungkin tercatat ganda di dua perangkat.
- **Hanya lisensi yang sama.** Desktop hanya mau berpasangan/bertukar data dengan HP yang lisensinya sama (lihat *Lisensi harus sama*).
- **Aman.** Kunci jangka panjang diturunkan HKDF-SHA256 dari rahasia QR sekali pakai (berlaku 10 menit) + kontribusi acak kedua perangkat. Setiap pesan dienkripsi & diautentikasi XChaCha20-Poly1305, terikat ID perangkat, dengan stempel waktu ±10 menit dan penolakan replay.

## Data awal
Kedua perangkat harus mulai dari data yang sama. Setelah memindai QR, HP memilih:
- **Kirim data HP ke desktop** (disarankan bila desktop masih kosong), atau
- **Ambil data desktop ke HP**.

Salinan dibuat konsisten (`VACUUM INTO`), dikirim terpotong 256 KB dengan verifikasi SHA-256, lalu menggantikan database penerima dengan pola yang sama seperti *Restore* (validasi → backup pengaman → tukar berkas → buka & migrasi → kembalikan bila gagal). Penerima keluar ke layar Login (akun pengguna ikut terbawa).

## Aturan konflik (jelas & tanpa kehilangan data)
> Sejak RC-S133.4 konflik dua-arah praktis tidak terjadi karena HP baca-saja. Aturan di bawah tetap berlaku untuk pemulihan (HP/desktop dipulihkan dari backup) dan pemasangan lama.

| Situasi | Hasil |
|---|---|
| Hanya satu perangkat yang berubah | Diterapkan ke perangkat lain |
| Keduanya berubah, **baris berbeda** | Digabung otomatis |
| **Baris yang sama** (tabel + kunci primer) diubah di kedua perangkat | **Ditahan** — tidak ada yang diterapkan; pengguna memilih buku induk |
| Penggabungan melanggar UNIQUE/FK/CHECK (mis. nomor dokumen sama) | **Ditahan** (atomik: dibatalkan seluruhnya) |
| Penggabungan membuat jurnal tidak seimbang (debit ≠ kredit) | **Ditahan** |
| Salah satu perangkat dipulihkan dari backup/direset sejak sinkron terakhir | **Perlu sinkron ulang** — pilih buku induk |

**Memilih buku induk** ("Pakai data Desktop" / "Pakai data HP", dari HP atau desktop): data perangkat yang kalah diganti dengan salinan pemenang. Sebelumnya, perangkat yang kalah otomatis membuat **backup pengaman terenkripsi** (`sebelum-sinkron_*.kdb`, tampil di Backup & Restore) dan **mengarsipkan perubahan yang belum terkirim** sebagai JSON (Sinkron › Arsip) agar dapat ditinjau/dimasukkan ulang. Penggantian data desktop yang diminta HP memerlukan **persetujuan di layar desktop** oleh pengguna berizin Backup › Setujui (kecuali desktop masih kosong).

## Jaminan teknis
- Penerapan selalu **satu skrip SQL `BEGIN…COMMIT`** yang juga memperbarui kursor — gagal di tengah = tidak ada yang berubah.
- **Idempoten**: paket yang terkirim ulang (mis. koneksi putus sebelum balasan) dilewati berdasarkan nomor urut; penerapan berbentuk upsert per kunci primer → tidak ada duplikasi.
- **Tidak menimpa diam-diam** perubahan pengguna yang terjadi selama sinkron (pemeriksaan balapan nomor urut).
- Perubahan dari pasangan **tidak dicatat ulang** (tidak memantul).
- **Pengaturan khusus perangkat tidak disinkronkan**: sesi login, PIN cepat, username terakhir, saklar PIN, jam uji developer, status panduan. Lisensi tidak pernah ada di database.
- **Perangkat utama**: hanya satu perangkat (default desktop, diatur di desktop) yang menjalankan jurnal otomatis (penyusutan, akrual, EIR, bunga) selama terpasang, agar tidak tercatat ganda.

## Mode cadangan HP (baca-saja) — RC-S133.4
Begitu data awal dipilih, HP masuk **mode cadangan**:
- **Database terkunci** dengan trigger `sync_ro_*` (`BEFORE INSERT/UPDATE/DELETE … RAISE(ABORT,'KOPKU_HP_CADANGAN…')`) pada setiap tabel data. Pengecualian lokal: `audit_log`, pengaturan khusus perangkat di `app_config` (sesi, PIN cepat, panduan, jam uji), dan kolom keamanan akun (`pin_*`, `password_*`, biometrik). Penerapan data dari desktop tetap bisa karena berjalan dengan `sync_guard.aktif = 1`.
- **Menu & formulir input tertutup**: izin setiap modul disaring menjadi *Lihat* + *Export* saja (Backup tetap penuh agar HP bisa membuat cadangan `.kdb`). Layar input menampilkan "Mode cadangan KOPKU Desktop".
- **Jurnal otomatis** (penyusutan, akrual, EIR, bunga) hanya dijalankan desktop.
- HP **tidak mengirim** perubahan apa pun ke desktop; antrian lokal HP dikosongkan setiap sinkron.
- Dashboard HP menampilkan banner *Mode cadangan KOPKU Desktop* dengan waktu sinkron terakhir.
- Desktop **tidak pernah** dalam mode ini (trigger dilepas bila desktop menerima salinan dari HP). *Putuskan pemasangan* di HP melepas mode cadangan.
- **Pemulihan**: bila komputer rusak/diganti, HP tetap bisa *Pulihkan desktop dari HP ini* (kirim salinan lengkap ke desktop, dengan persetujuan di desktop).

## Putus & pindai ulang — RC-S133.4.2
- **Konfirmasi putus** (desktop & HP): dialog berisi akibat + centang "Saya mengerti"; hanya pengguna berizin Backup › Setujui.
- **Desktop memutus** → HP mendeteksi (`TIDAK_DIPASANGKAN`), menandai `diputusDesktop`, tetap **baca-saja**; HP memilih *Pindai QR lagi* atau *Pakai HP mandiri*.
- **HP memutus** → HP keluar dari mode cadangan (trigger `sync_ro_*` dilepas); desktop ikut dilepas bila terjangkau.
- **Pindai QR (pertama kali atau ulang)** → HP langsung baca-saja dan data disamakan otomatis (`pasangSebagaiCadangan`): desktop berisi data → HP mengambil salinan desktop (backup pengaman dulu); desktop kosong → HP mengirim datanya.

## Lisensi harus sama — RC-S133.4
- Saat memindai QR, HP menyertakan **token aktivasi lisensinya** di kanal terenkripsi. Desktop memverifikasi tanda tangan Ed25519 token itu secara offline, mencocokkan ikatan perangkat (hash ID perangkat HP), lalu membandingkan **ID lisensi** dengan lisensi desktop (atau lisensi yang tercatat saat pertama kali dipasangkan bila desktop belum berlisensi).
- Berbeda → pemasangan & sinkron **ditolak**: "Lisensi HP BERBEDA dengan lisensi KOPKU Desktop ini…". HP tanpa lisensi / token tidak sah → ditolak.
- Diperiksa ulang pada setiap operasi data (`SYNC`, `SNAP_BUAT`, `UNGGAH_MULAI`), bukan hanya saat pemasangan.

## Animasi kirim & transfer data
Panel Sinkron (HP & desktop) menampilkan animasi HP ⇄ laptop: paket data mengalir sesuai arah, perangkat pengirim berdenyut, bilah progres memakai persentase nyata saat mengirim salinan (potongan 256 KB) dan bergerak tak tentu saat sinkron perubahan; tanda centang muncul saat selesai.

## Pencadangan & pemulihan lokal
Fitur Backup & Restore yang ada berjalan sama di desktop (backup terenkripsi `.kdb`, kode pemulihan, pilih berkas dari disk). Backup dari HP dapat dipulihkan di desktop dan sebaliknya (format SQLite & skema sama). Setelah restore pada perangkat yang terpasang, sinkron otomatis meminta pemilihan buku induk agar kedua perangkat kembali sama.

## Memutus pemasangan
Sinkron › *Putuskan pemasangan* (di HP atau desktop). Trigger & tabel `sync_*` dilepas; data koperasi tetap utuh di kedua perangkat.

## Tidak terhubung ("Aborted")
"Aborted" berarti HP tidak mendapat jawaban. Urutan pemeriksaan:
1. **Windows Firewall.** Penyebab tersering: dialog izin pertama ditutup sehingga Windows memblokir aplikasi. Perbaiki di desktop: *Sinkron HP › Izinkan di Firewall*. Installer 1.0.1 memasangnya otomatis.
2. **Uji jangkauan.** Buka `http://<IP desktop>:47821/kopku/v1/ping` di browser HP. Harus muncul `kopku`, dan desktop menampilkan IP HP yang berhasil menjangkau.
3. **Jaringan.** Pastikan Wi-Fi sama dan tanpa isolasi klien (atau pakai hotspot HP). Bila Wi-Fi tanpa internet, matikan data seluler sementara.

Sejak RC-S133.1, HP menguji jangkauan sebelum memasangkan. Pesannya membedakan "tidak menjawab" (firewall/jaringan) dari "menolak koneksi" (aplikasi desktop tertutup).

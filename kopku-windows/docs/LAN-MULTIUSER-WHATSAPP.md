# KOPKU Desktop 1.0.8 — LAN Multi-User & WhatsApp Reminder

## §0 Pembaruan LAN-WhatsApp2 — menu di Pengaturan & saklar ON/OFF terpisah

| Sebelumnya (LAN-WhatsApp1) | Sekarang (LAN-WhatsApp2) |
|---|---|
| Hanya lewat menu bilah atas *Berkas › Server LAN Multi-User & WhatsApp…* (jendela panel terpisah). | **Pengaturan › LAN & WhatsApp** di dalam aplikasi: sidebar Pengaturan, kartu di *Semua Pengaturan*, pencarian `Ctrl+K`. *Berkas › LAN & WhatsApp…* membuka layar yang sama. Jendela panel terpisah dihapus. |
| Satu pilihan mode: Desktop Mode / LAN Server Mode. WhatsApp Reminder hanya berjalan bila LAN Server Mode aktif. | **Dua saklar berdiri sendiri**: *Server LAN Multi-User* ON/OFF dan *WhatsApp Reminder* ON/OFF. WhatsApp dapat berjalan dengan Server LAN OFF (port tertutup). |
| Pengaturan WhatsApp (jam, jenis, nomor test, token) hanya di Panel Web → butuh Server LAN menyala + browser. | Semua pengaturan WhatsApp juga ada di layar desktop: jam kirim, H-3…H+7, nomor test, Phone Number ID, Business Account ID, nama/bahasa template, versi API, access token (write-only, terenkripsi DPAPI), Test koneksi, Kirim pesan uji, Jalankan sekarang, riwayat pengiriman. |

Perilaku saklar:
- Keduanya OFF (bawaan) → tidak ada server, adapter, mutex, penjadwal; `kopku-server.db` ditutup. Desktop berjalan persis seperti 1.0.5.
- Server LAN: disimpan di `kopku-server.json` (`mode`). WhatsApp: disimpan di `kopku-server.db` (`pengaturan.whatsapp.reminder.aktif`) — satu sumber kebenaran yang sama dengan Panel Web; mengubahnya dari Panel Web langsung menyalakan/menghentikan penjadwal.
- Saat KOPKU dibuka, fitur yang tersimpan ON otomatis menyala; gagal start Server LAN (mis. port dipakai) **tidak** mematikan WhatsApp, dan sebaliknya.
- Menyalakan saklar meminta konfirmasi (dialog KOPKU); mematikan langsung. Hanya peran dengan izin `pengaturan.edit` yang dapat mengubah; peran dengan `pengaturan.view` hanya melihat. Rute baru `LanWhatsApp` = `pengaturan.view`.
- Kredensial non-rahasia yang diisi di layar disimpan di `kopku-server.db` (prioritas terendah: env → `kopku-server.env` → layar). Access token tetap hanya di secure store; tidak ada kanal yang mengembalikannya ke layar.
- Aksi dari layar desktop dicatat di `audit_lan` dengan pelaku "KOPKU Desktop (lokal)".

Implementasi:
- Layar = modul baru `renderer-patch/LanWhatsAppScreen.js`, dipasang ke bundle renderer oleh `scripts/pasang-menu-lan-wa.js` (idempoten; memverifikasi id modul dependensi & setiap jangkar harus tepat 1×; dijalankan otomatis oleh `npm start`, `dist:win`, `dist:mac`, dan `rakit-win-tanpa-npm.sh`). Fungsi `lepas()` membalik pemasangan; uji regresi membuktikan bundle setelah dilepas **byte-identik** dengan bundle 1.0.5 asli (tidak ada logika bisnis yang tersentuh). Bila renderer dibangun ulang dari source aplikasi, layar ini sebaiknya ditambahkan ke source (`app/`, `src/`) — skrip akan menolak bundle yang berbeda.
- `electron/server/index.js`: orkestrator dua saklar (`aturMode`, `aturWhatsApp`, `waInfo`, `waSimpan`, `waSimpanKredensial`, `waSimpanToken`, `waHapusToken`, `waTestKoneksi`, `waTestPesan`, `waLog`, `waJalankan`), transisi diserialkan (klik cepat aman).
- `electron/main.js`: kanal `lanmu:*` kini hanya diterima dari **jendela utama** (sebelumnya dari jendela panel). Jendela utama sudah memegang akses penuh `koperasi.db`, jadi tidak ada hak baru. `electron/preload.js`: namespace `kopkuDesktop.lanWa`.
- `electron/server/config.js`: sumber kredensial ke-4 (nilai non-rahasia dari layar) + validasinya.

Uji: `npm run test:lan` **68/68** (termasuk saklar terpisah, WhatsApp tanpa LAN, buka ulang aplikasi, OFF/ON dari Panel Web). Electron nyata (Linux, xvfb): `smoke-lan` 21/21, `smoke-menu-lan-wa` 15/15 (login, menu di sidebar/Semua Pengaturan/Ctrl+K/Berkas, klik saklar + dialog konfirmasi, port terbuka/tertutup), `smoke-basic` & `smoke-setup` lulus. Tangkapan layar: `docs/tangkapan-layar/30-*.png`.

Catatan bagian di bawah: rujukan ke "panel Server LAN" / "Berkas › Server LAN Multi-User & WhatsApp…" kini berarti layar **Pengaturan › LAN & WhatsApp**; "LAN Server Mode" = saklar *Server LAN Multi-User* ON.

---

Laporan implementasi + panduan operasional. Status: **RC / DEVICE VALIDATION REQUIRED** — uji dijalankan di Node 22 terhadap bundle KOPKU asli **dan** di Electron 44.5.1 nyata (Linux, layar virtual). Windows nyata (installer, firewall/UAC), perangkat fisik di Wi-Fi, dan WhatsApp Cloud API nyata **belum** diuji (lihat §16–§17, §22).

---

## §0b Pembaruan LAN-WhatsApp3 — versi LAN lengkap sesuai Permission Matrix

Web KOPKU LAN (browser PC/laptop/HP) kini bertampilan seperti KOPKU Desktop (sidebar hijau gelap bergrup, pencarian menu `Ctrl+K`, bilah status, tampilan HP) dan menunya dibangun dari **peta izin** user = Permission Matrix existing (`hasPermission`), dipersempit profil Pengawas. Semua endpoint tetap memeriksa izin di server.

| Grup | Menu | Izin (resource.aksi) |
|---|---|---|
| Dashboard | KPI per bagian (anggota, simpanan, pinjaman+kolektibilitas+tunggakan teratas, saldo kas & bank, transaksi terakhir) + aksi cepat | tiap bagian hanya diisi bila boleh *lihat* resource-nya |
| Data | Anggota (lihat/tambah/ubah, detail: profil, pinjaman, riwayat simpanan, berjangka) | anggota.view/create/edit |
| | Pengurus & Pengawas (personel) | anggota.view |
| | Daftar Akun (COA) | pengaturan.view |
| | Data Bank & Kas (saldo) | kas_bank.view |
| Transaksi | Setor simpanan · Tarik simpanan sukarela | simpanan.create |
| | Riwayat simpanan · Saldo simpanan anggota · Simpanan berjangka (lihat) | simpanan.view |
| | Pinjaman (daftar/detail) · Simulasi angsuran | pinjaman.view |
| | Ajukan pinjaman (EFEKTIF/FLAT/MENURUN, biaya admin, denda, agunan, tujuan) · Bayar angsuran · Pelunasan | pinjaman.create |
| | Cairkan pinjaman | pinjaman.approve |
| | Batalkan pengajuan | pinjaman.edit |
| | Kas masuk (pendapatan lain — akun dari `listAkunPendapatanLainnya`) · Kas keluar (kategori beban — sama dengan menu Beban desktop) | kas_bank.create |
| | Pemindahan saldo antar rekening | kas_bank.edit |
| | Riwayat kas & bank | kas_bank.view |
| Laporan | Posisi Keuangan, LHU, Laba Rugi, Arus Kas, Perubahan Ekuitas, Neraca Saldo, Buku Besar (cetak) | laporan.view |
| | Kolektibilitas, Tunggakan | pinjaman.view |
| | History Transaksi + detail jurnal | history_transaksi.view |
| | SHU (riwayat & per anggota) | shu.view |
| Pengaturan | Pengguna & Permission Matrix (baca saja) | user_management.view |
| | Akses LAN, sesi · Audit Log LAN · WhatsApp · Log WhatsApp · Status server | seperti sebelumnya |

Tetap **hanya di KOPKU Desktop** (proses akuntansi berat / berisiko): metode pinjaman CUSTOM, tutup periode, saldo awal, hitung & ajukan SHU, pajak, aset, investasi, RAK, utang, penempatan/pencairan simpanan berjangka, koreksi/pembatalan transaksi, backup/restore, reset data, perubahan user & matriks izin.

Keamanan & integritas transaksi baru: semua lewat service KOPKU yang sama dengan layar desktop (`tarikSimpananSukarela`, `ajukanPinjaman`, `cairkanPinjaman`, `batalkanPinjaman`, `tambahTransaksiPendapatan`, `catatPengeluaran`, `transferAntarRekening`) yang juga memeriksa izin sendiri (`requirePermission`) atas nama user LAN; CSRF + Idempotency-Key wajib; validasi bentuk di server (`V.dataPinjaman` dst.); akun lawan kas masuk/keluar dibatasi seperti menu Pendapatan/Beban desktop (akun piutang/simpanan ditolak, sehingga buku pembantu tidak rusak); pencairan membawa versi data (KONFLIK bila berubah); audit `SIMPANAN_TARIK`, `KAS_MASUK`, `KAS_KELUAR`, `KAS_TRANSFER`, `PINJAMAN_AJUKAN`, `PINJAMAN_CAIR`, `PINJAMAN_BATAL`.

Uji:
- `npm run test:lan` **73/73**, termasuk `menu-lengkap.test.js` (peta izin 5 peran = `DEFAULT_ROLE_PERMISSIONS`; **140 kombinasi peran × endpoint** baru; dashboard per izin; tarik/kas/transfer/ajukan/cair/batal; simulasi = jadwal service; klik ganda → 1 transaksi) dan regresi kembar yang diperluas (tarik, kas masuk/keluar kas & bank, transfer, ajukan+cairkan dengan agunan & biaya admin, pembatalan → jurnal, saldo, Laba Rugi, Arus Kas, Posisi Keuangan **identik** dengan desktop).
- `test/lan/ui-browser.py` (Chromium, 21/21): menu per peran, Ctrl+K, ajukan → simulasi → cairkan lewat klik, tarik, kas keluar, transfer ditolak, neraca saldo → buku besar, history → jurnal, admin (laptop) & bendahara (HP) bayar angsuran sama → konflik, Operator tanpa Cairkan, Pengawas tanpa tombol ubah, HP tanpa geser horizontal, tanpa galat JavaScript. Tangkapan layar: `docs/tangkapan-layar/lan-*.png`.

---

## §1 Hasil audit arsitektur

| § | Temuan | Dampak pada desain |
|---|---|---|
| 1.1 | ZIP ini adalah *shell* Electron. Seluruh logika bisnis (anggota, pinjaman, angsuran, jasa, denda, pelunasan, jurnal, COA, SHU, laporan, login, izin, lisensi, backup) berada di **bundle renderer hasil compile** `renderer/_expo/static/js/web/entry-*.js` (1.561 modul Metro). Source TS (`src/`, `app/`) **tidak ada** di ZIP. | Tidak ada service yang bisa di-`require` dari main process. Server LAN memanggil service yang **sama** di jendela desktop yang sedang berjalan (§1.6). |
| 1.2 | Main process tipis: `SqliteHost` (`node:sqlite`) mengeksekusi SQL yang dikirim renderer lewat IPC; satu koneksi ke `documents/SQLite/koperasi.db`. | Penulis tunggal `koperasi.db` tetap proses KOPKU ini; klien LAN tidak pernah menyentuh SQLite. |
| 1.3 | Sudah ada: `app_user` (role ADMIN/PENGURUS/BENDAHARA/PETUGAS/ANGGOTA; password **scrypt** v2 N=16384, warisan SHA-256 v1), `role_permission` + `requirePermission()` yang dipanggil di dalam service, `audit_log`. | **Dipakai ulang**: verifikasi password memakai `verifikasiPinAsync` existing; otorisasi memakai `hasPermission` existing; service tetap menulis `audit_log` atas nama user LAN. |
| 1.4 | Transaksi: hampir semua lewat `withTransaction()` → `SQLiteDatabase.prototype.withTransactionAsync` (shim desktop, BEGIN/COMMIT di satu koneksi). Dua transaksi async bersamaan pada koneksi yang sama saling menyisip → "cannot start a transaction within a transaction". Terbukti oleh uji kontrol negatif. | Mutex transaksi + antrian tunggal di adapter (§8). |
| 1.5 | `bayarAngsuran()` **tidak** menerima idempotency key (kolom `angsuran_pembayaran.idempotency_key` tidak diisi). | Proteksi duplikat di layer API: Idempotency-Key + cek versi jadwal (§8). |
| 1.6 | Registry modul Metro (`globalThis.__r`) tersedia di renderer; nomor modul berubah tiap build. | `bundleIndex.js` memindai teks bundle tiap start dan mencari modul **berdasarkan nama ekspor** (harus tepat satu modul); bila tidak ditemukan → server menolak start (fail-closed). |
| 1.7 | Server LAN existing (`lanServer.js`, port 47821–47840) hanya pipa sinkron HP terenkripsi. Scheduler existing: shim `expo-background-task` (setInterval di renderer). | Server multi-user **terpisah** (port bawaan 47880) — pipa sinkron HP tidak diubah. Scheduler WhatsApp di **main process** (bukan renderer, bukan browser). |
| 1.8 | Backup/restore existing mengganti berkas `koperasi.db` lalu memuat ulang renderer. | Data server di `kopku-server.db` terpisah → tidak tertimpa restore; adapter dipasang ulang otomatis setelah reload. |

**Konflik & solusi minimal**

- **K-1 Role Pengawas** tidak ada di CHECK `app_user.role`; menambahkannya butuh rebuild tabel lewat migration existing yang ada di source yang tidak tersedia. → Profil LAN "PENGAWAS" (baca saja) di `kopku-server.db`, dapat dipasang pada user non-Anggota mana pun; **hanya mempersempit** hak, tidak pernah menambah.
- **K-2 Migration** existing ada di bundle compiled. Menambah tabel ke `koperasi.db` akan mengubah versi schema (v80), format backup dan sinkron HP. → Tabel baru di `kopku-server.db` dengan migration berversi sendiri (aditif, idempoten, backup berkas sebelum naik versi). `koperasi.db` tetap v80.
- **K-3 Web UI**: renderer existing tidak bisa dipakai klien browser tanpa membuka SQL mentah lewat jaringan (shim SQLite = SQL arbitrer). → Web UI ringan terpisah yang **hanya** bicara ke API, bergaya KOPKU Desktop (palet & sidebar yang sama).
- **K-4 Pengaturan di desktop**: (LAN-WhatsApp2, lihat §0) layar **Pengaturan › LAN & WhatsApp** dipasang ke bundle compiled oleh `scripts/pasang-menu-lan-wa.js` (dapat dibalik, diuji byte-identik). Akses pengguna LAN & audit tetap di Panel Web (Admin).

Tidak ada bagian yang menuntut perubahan engine, database engine, atau business logic — tidak ada titik berhenti yang tersisa.

## §2 Berkas existing yang diubah (penambahan saja, 0 baris dihapus)

| Berkas | Perubahan |
|---|---|
| `electron/main.js` | +105 baris: require modul server; `registerLanMultiUser()` (IPC `srv:reply` hanya dari jendela utama, `lanmu:*` hanya dari panel); `bukaPanelServer()`; item menu *Server LAN Multi-User & WhatsApp…*; pasang/putus adapter pada `did-finish-load`/`did-start-loading`; henti server saat `will-quit`. webPreferences jendela utama **tidak berubah**. |
| `electron/preload.js` | +21 baris: namespace `kopkuDesktop.server.onCall(handler)` (satu handler saja) + listener `srv:call` → `srv:reply`. Namespace lama utuh. |
| `package.json` | +1 skrip `test:lan`. Dependensi tidak berubah. |
| `README.md`, `MULAI-DI-SINI.md` | Bagian dokumentasi singkat ditambahkan di akhir. |

## §3 Berkas baru

```
electron/server/
  index.js              orkestrator KopkuLanServer (mode, start/stop, status, alamat LAN)
  bundleIndex.js        indeks ekspor → id modul Metro (fail-closed)
  rendererAdapter.js    adapter yang disuntik ke renderer: operasi whitelist → service existing,
                        antrian tunggal, mutex transaksi, cek versi (optimistic concurrency)
  serviceBridge.js      jembatan IPC main ⇄ adapter (+ DirectServiceBridge untuk uji)
  api.js                router & handler API, pipeline auth→CSRF→lisensi→RBAC→validasi→idempotensi→audit
  httpServer.js         HTTP(S), hanya-IP-privat, anti DNS-rebinding, header keamanan, batas badan/laju
  auth.js               sesi (token hash), cookie, CSRF, pembatas login & penguncian
  rbac.js               akses LAN + otorisasi di atas matriks existing (+ profil Pengawas)
  validasi.js           validasi bentuk input
  audit.js              audit_lan + logger yang menyamarkan rahasia
  config.js             kopku-server.json + kredensial WhatsApp (env / berkas env / secure store)
  serverDb.js           kopku-server.db + migration
  firewallLan.js        aturan firewall opsional via UAC (hanya bila Admin menekan tombol)
  whatsapp/WhatsAppService.js   klien Cloud API (template), klasifikasi galat
  whatsapp/ReminderScheduler.js penjadwal H-3/H-1/H/H+1/H+7, lease, retry, PengaturanWa
  whatsapp/nomor.js     normalisasi & penyamaran nomor
  web/                  index.html, app.js, style.css, logo.svg (web UI klien)
  control/              panel.html, panel.js, panel.css, panel-preload.js (panel desktop)
.env.example, .gitignore
test/lan/               61 uji (lihat §16) + harness headless + demo server + uji browser opsional
docs/                   dokumen ini + tangkapan layar
```

## §4 Database migration

`koperasi.db`: **tidak ada migration**, tetap schema v80, daftar tabel identik (diuji).

`kopku-server.db` (folder data KOPKU, berkas baru), `server_meta.version = 1`:

| Tabel | Isi |
|---|---|
| `lan_akses` | user_id, aktif, profil (`IKUT_ROLE`/`PENGAWAS`), diubah_oleh, created_at, updated_at |
| `sesi` | id = SHA-256(token), user_id, csrf, ip, user_agent, created_at, last_seen_at, expires_at, revoked_at |
| `login_gagal` | kunci (`u:username` / `ip:alamat`), jumlah, pertama_at, terakhir_at, kunci_sampai |
| `audit_lan` | waktu, user_id, username, action, entity, entity_id, status (BERHASIL/GAGAL/DITOLAK), ip, metadata (dibersihkan) |
| `idempotensi` | kunci (user:key), rute, status (PROSES/SELESAI), http_status, respons, created_at |
| `pengaturan` | kunci, nilai JSON (mis. `whatsapp.reminder`), updated_at, updated_by |
| `whatsapp_notifications` | id, anggota_id, pinjaman_id, jadwal_id, nama_anggota, nomor_pinjaman, angsuran_ke, tanggal_jatuh_tempo, jenis_notifikasi, tanggal_jadwal, nomor_tujuan, nomor_masked, sisa_tagihan, status, percobaan, berikutnya_at, provider_message_id, sent_at, error_kode, error_message, dibuat_oleh, created_at, updated_at — **UNIQUE(pinjaman_id, jenis_notifikasi, tanggal_jadwal)**; CHECK status ∈ pending/sending/sent/failed/skipped |
| `scheduler_lease`, `scheduler_run` | kepemilikan scheduler (single instance) & catatan proses harian |

Semua DDL `CREATE … IF NOT EXISTS`, dijalankan dalam transaksi; versi lebih baru dari aplikasi → ditolak (tidak menimpa). Tidak ada DROP/DELETE data.

## §5 API endpoints

Publik: `GET /api/health` (status saja, tanpa data sensitif), `POST /api/auth/login`, `POST /api/auth/logout`.

| Metode & jalur | Izin (matriks KOPKU existing) |
|---|---|
| `GET /api/auth/sesi`, `GET /api/server/status`, `GET /api/rekening` | sesi valid |
| `GET /api/dashboard` | pinjaman.view |
| `GET /api/anggota`, `GET /api/anggota/:id` | anggota.view |
| `POST /api/anggota` | anggota.create |
| `PUT /api/anggota/:id` (wajib `versi`) | anggota.edit |
| `GET /api/pinjaman`, `GET /api/pinjaman/:id` | pinjaman.view |
| `POST /api/pinjaman/:id/angsuran/:jadwalId/bayar` (wajib `versiJadwal`) | pinjaman.create (sama dengan `bayarAngsuran`) |
| `GET /api/pinjaman/:id/pelunasan?tanggal&metode` | pinjaman.view |
| `POST /api/pinjaman/:id/pelunasan` (wajib `totalDilihat`) | pinjaman.create |
| `POST /api/simpanan/setor` | simpanan.create |
| `GET /api/laporan/tunggakan` | pinjaman.view |
| `GET /api/laporan/posisi-keuangan?tanggal`, `GET /api/laporan/lhu?mulai&selesai` | laporan.view |
| `GET /api/admin/lan-akses`, `GET /api/admin/sesi` | user_management.view |
| `PUT /api/admin/lan-akses/:userId`, `POST /api/admin/sesi/:id/cabut` | user_management.edit |
| `GET /api/admin/audit` | user_management.view **atau** profil Pengawas |
| `GET /api/whatsapp/pengaturan`, `GET /api/whatsapp/log` | pengaturan.view |
| `PUT /api/whatsapp/pengaturan`, `PUT /api/whatsapp/token`, `POST /api/whatsapp/token/hapus`, `POST /api/whatsapp/test-koneksi`, `POST /api/whatsapp/test-pesan`, `POST /api/whatsapp/jalankan` | pengaturan.edit |

Semua request ubah data (POST/PUT) wajib header `X-KOPKU-CSRF` dan `Idempotency-Key`. Kode galat: 401 SESI, 403 IZIN/CSRF/AKSES_LAN, 404, 409 KONFLIK/SEDANG_DIPROSES, 413, 415, 421 HOST, 422 VALIDASI, 429 TERKUNCI/TERLALU_SERING, 503 LISENSI/BELUM_SETUP/LAYANAN_BELUM_SIAP/DB_SIBUK, 504 TIMEOUT, 500 INTERNAL (pesan generik + requestId; tanpa stack trace).

Tidak ada endpoint SQL, berkas, unduh database, eksekusi perintah, atau internal Electron.

## §6 Autentikasi & sesi

- Login memakai **username + password KOPKU existing** (`app_user`), diverifikasi oleh `verifikasiPinAsync` existing (scrypt). Tidak ada tabel user baru, tidak ada password baru.
- Hash warisan v1 (SHA-256 satu putaran) **ditolak** lewat LAN dan tidak diperbarui dari LAN: user cukup masuk sekali di KOPKU Desktop (desktop menaikkannya ke scrypt).
- Username tak dikenal tetap menjalankan scrypt (waktu respons setara; pesan galat sama).
- Token sesi 256-bit acak → cookie `kopku_sid` **HttpOnly; SameSite=Strict; Path=/** (+`Secure` bila HTTPS). Database hanya menyimpan SHA-256 token.
- CSRF token per sesi di memori JS (tidak di localStorage); wajib di setiap request ubah data.
- Sesi berakhir: idle 30 menit, absolut 12 jam (dapat diatur 5–480 menit / 1–24 jam di `kopku-server.json`), logout, dicabut Admin, akses LAN dicabut, user dinonaktifkan/role berubah di desktop (dicek ulang setiap request dari `app_user`).
- Brute force: penundaan progresif (250 ms → 3 dtk), kunci 15 menit setelah 5 gagal per username atau 20 gagal per IP; tersimpan di database (tetap berlaku setelah restart). Pembatas laju umum 600 request/menit/IP.

## §7 Matriks peran & izin

Sumber kebenaran: `role_permission` KOPKU existing (dapat diubah Admin di desktop › User Management). Nilai bawaan (`DEFAULT_ROLE_PERMISSIONS` existing):

| Peran permintaan | Role KOPKU | Lewat LAN | Lihat anggota | Tambah anggota | Ubah anggota | Bayar angsuran / pelunasan | Setor simpanan | Laporan keuangan | Pengaturan WhatsApp | Akses LAN & sesi | Audit LAN |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Admin | ADMIN | ya (bawaan) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | lihat+ubah | ✔ | ✔ |
| Pengurus | PENGURUS | bila diberi Admin | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | lihat | – | – |
| Bendahara | BENDAHARA | bila diberi Admin | ✔ | – | – | ✔ | ✔ | ✔ | – | – | – |
| Operator | PETUGAS | bila diberi Admin | ✔ | ✔ | – | ✔ | ✔ | ✔ | – | – | – |
| Pengawas | profil LAN di atas role apa pun | bila diberi Admin | ✔ | – | – | – | – | ✔ | – | – | ✔ |
| Anggota | ANGGOTA | **tidak pernah** | – | – | – | – | – | – | – | – | – |

Profil Pengawas: hanya aksi *lihat* pada anggota/simpanan/pinjaman/laporan/SHU/riwayat, dan tetap hanya bila role dasarnya juga mengizinkan *lihat*.

Catatan: "Operator boleh bayar angsuran" adalah perilaku matriks existing (PETUGAS pinjaman.create = true), bukan aturan baru. Ubah di desktop bila kebijakan koperasi berbeda — server langsung mengikuti. Semua izin diperiksa di server; menu web hanya menyesuaikan tampilan. Service existing juga memeriksa ulang (`requirePermission`) — dua lapis.

## §8 Strategi konkurensi

1. **Satu penulis**: hanya proses KOPKU Desktop di komputer server yang membuka `koperasi.db`.
2. **Antrian tunggal** di adapter: operasi LAN dieksekusi satu per satu (FIFO, batas 60 dtk/operasi).
3. **Mutex transaksi**: `withTransactionAsync` (shim) dibungkus mutex global saat LAN Server Mode aktif → transaksi desktop dan LAN tidak pernah menyisip. Isi transaksi (BEGIN → service → COMMIT/ROLLBACK) tetap implementasi asli → pembayaran + jurnal tetap atomik. Menunggu > 30 dtk → 503 DB_SIBUK (bukan deadlock).
4. **Optimistic concurrency**: bayar angsuran membawa `versiJadwal` (terbayar pokok|jasa|denda|status); pelunasan membawa `totalDilihat` (dihitung ulang server); ubah anggota membawa `versi` (updated_at). Tidak cocok → 409 KONFLIK.
5. **Idempotency-Key** per request ubah data (disimpan 24 jam): klik ganda/retry jaringan/retry setelah restart server → satu transaksi, respons identik.
6. **SQLite busy** (proses lain mengunci berkas) → 503 DB_SIBUK, kunci idempotensi dilepas agar aman dicoba lagi.
7. Data uang selalu dari service: klien hanya mengirim nominal yang diketik; alokasi pokok/jasa/denda, total pelunasan, jurnal = service existing.

Risiko sisa (dicatat jujur): penulisan desktop **non-transaksional** (mis. `updateAnggotaStatus`) yang terjadi tepat di tengah transaksi LAN berada di koneksi yang sama; bila transaksi LAN itu di-ROLLBACK, penulisan tersebut ikut batal. Jendela waktunya milidetik; penyelesaian total memerlukan perubahan di source renderer (tidak tersedia di ZIP ini).

## §9 Konfigurasi LAN server

`%APPDATA%\KOPKU Desktop\kopku-server.json` (diatur lewat panel; nilai tidak sah diganti bawaan aman):

```json
{ "mode": "DESKTOP", "host": "0.0.0.0", "port": 47880, "hanyaJaringanPrivat": true,
  "https": { "aktif": false, "certFile": "", "keyFile": "" }, "sesiIdleMenit": 30, "sesiMaksJam": 12 }
```

- `mode`: `DESKTOP` (bawaan, server mati) atau `LAN_SERVER`.
- `host`: `0.0.0.0` (semua antarmuka LAN), `127.0.0.1` (hanya komputer ini), atau satu IP LAN tertentu.
- `hanyaJaringanPrivat`: menolak koneksi dari IP non-privat (10/8, 172.16/12, 192.168/16, loopback, link-local, IPv6 ULA/link-local diterima). Catatan: alamat VPN CGNAT 100.64/10 (mis. Tailscale) ikut ditolak.
- HTTPS: isi path sertifikat & kunci PEM milik Anda (mis. dari CA internal / mkcert) lalu `"aktif": true`.
- Alamat yang ditampilkan diambil dari antarmuka jaringan nyata (IPv4 privat, tanpa adapter virtual) — tidak dikarang.
- Firewall: installer **tidak** diubah dan tidak membuka port ini. Tombol *Izinkan di Windows Firewall…* di panel menjalankan (dengan dialog UAC):
  `netsh advfirewall firewall add rule name="KOPKU Desktop LAN Multi-User" dir=in action=allow protocol=TCP localport=47880 remoteip=localsubnet profile=private,domain`
  Jaringan Wi-Fi bertipe **Public** tidak dibuka (sengaja). Ubah profil jaringan ke Private bila jaringan kantor dipercaya.

## §10 Cara client terhubung lewat browser

1. Komputer server: KOPKU Desktop terbuka, LAN Server Mode aktif (§19).
2. Perangkat lain di Wi-Fi/LAN yang sama membuka alamat yang tampil di panel, mis. `http://192.168.1.100:47880` (atau pindai QR di panel).
3. Masuk dengan username/password KOPKU. Selain Admin, akun harus diberi akses di Panel Web › **Akses LAN Pengguna**.
4. Bilah status bawah menampilkan **Server Online/Offline** dan **Database Ready/Not Configured**; bila koneksi putus, muncul pita merah dan klien menyambung ulang otomatis (sesi tetap berlaku).

## §11 Arsitektur WhatsApp

```
KOPKU Desktop (main process, komputer server)
  └─ ReminderScheduler (1 instance: single-instance lock + lease DB + flag re-entrancy)
       ├─ data: adapter → service/SQL status jadwal existing (baca saja) di koperasi.db
       ├─ log : whatsapp_notifications (kopku-server.db)
       └─ WhatsAppService ── HTTPS ──► graph.facebook.com/{versi}/{PHONE_NUMBER_ID}/messages ──► WhatsApp anggota
```

- Hanya **pesan template approved**. Body template wajib 6 parameter: `{{1}}` nama anggota, `{{2}}` nomor pinjaman, `{{3}}` angsuran ke, `{{4}}` tanggal jatuh tempo, `{{5}}` sisa angsuran (Rp), `{{6}}` keterangan waktu (mis. "akan jatuh tempo 3 hari lagi"). Contoh di `.env.example`.
- `WhatsAppService`: `sendTemplateMessage`, `validatePhoneNumber`, `testConnection`, `getDeliveryStatus` (status delivered/read butuh webhook publik → tidak didukung server lokal; yang dicatat adalah "sent" = diterima Cloud API).
- Penanganan galat: 400 template (1320xx) → failed tanpa retry; nomor (131026/131030 dst.) → failed; 401/403 → tetap pending, scheduler dijeda 30 menit, tidak menghabiskan percobaan; 429/5xx/timeout → retry maks 3× dengan backoff 1/5/15 menit; offline/DNS → pending tanpa menghabiskan percobaan, dicoba tiap 5 menit.

## §12 Aturan reminder

- Jenis: **H-3, H-1, H, H+1, H+7** relatif `angsuran_jadwal.tanggal_jatuh_tempo` (tanggal lokal komputer server). Masing-masing dapat dimatikan; waktu kirim bawaan **08:00**.
- Kandidat: pinjaman berstatus **AKTIF** dan angsuran berstatus tertagih menurut definisi existing (`BELUM_BAYAR`, `SEBAGIAN`, `TERLAMBAT`) — definisi yang sama dengan `listTunggakan()`. Sisa = `total − pokok_terbayar − jasa_terbayar` (rumus `listTunggakan()`); **denda tidak dihitung ulang** (dihitung service saat pembayaran).
- Tepat sebelum kirim, status dicek ulang: sudah dibayar/lunas/pinjaman tidak aktif → `skipped`.
- Nomor: dinormalisasi (`081234567890` → `6281234567890`); tidak sah/kosong → `skipped` tanpa dikirim.
- Tidak pernah ganda: UNIQUE(pinjaman, jenis, tanggal_jadwal) + `INSERT OR IGNORE` + klaim atomik `pending→sending`. Baris yang tertinggal di `sending` (aplikasi mati saat mengirim) → `failed` (STATUS_TIDAK_PASTI), **tidak** dikirim ulang.
- Kedaluwarsa: reminder yang belum terkirim sampai tanggal jadwal + 1 hari → `skipped` (KEDALUWARSA).
- Pesan uji hanya ke **Nomor Test Administrator** yang tersimpan (nomor dari request diabaikan), maksimal 1×/menit.

**Butuh keputusan kebijakan (tidak saya karang):**
- P-1: anggota berstatus **MENINGGAL** di-skip (tidak dikirimi). Anggota KELUAR/TIDAK_AKTIF dengan pinjaman AKTIF **tetap** dikirimi. Konfirmasi apakah sesuai kebijakan koperasi.
- P-2: pinjaman **MACET** tidak diingatkan (mengikuti `listTunggakan()` yang hanya `AKTIF`). Konfirmasi.

## §13 Langkah keamanan

Server: bawaan mati; hanya IP privat; anti DNS-rebinding (Host harus IP/localhost/nama komputer); CSP ketat (`default-src 'self'`, tanpa inline script/style), X-Frame-Options DENY, nosniff, no-referrer, COOP/CORP; tanpa CORS; batas badan 64 KB, JSON wajib; whitelist berkas statis; galat tanpa stack trace; HTTPS opsional + HSTS.
Electron: jendela utama tetap `contextIsolation:true, nodeIntegration:false, sandbox:true`; kanal `lanmu:*` (layar LAN & WhatsApp) ditolak bila pengirim bukan jendela utama; balasan `srv:reply` ditolak bila bukan dari jendela utama (diuji dengan balasan palsu); token WhatsApp tidak pernah ke renderer/preload.
Data: password tidak disimpan/di-log; token sesi di-hash; token WhatsApp hanya di env/berkas env/secure store DPAPI, disamarkan di log/galat, tidak pernah di respons API; nomor HP disamarkan di log/UI; validasi input di server; `createdBy`/`userId` selalu dari sesi; lisensi & setup KOPKU tidak valid → fail-closed 503.

## §14 Audit log

- `audit_lan` (kopku-server.db): LOGIN, LOGIN_GAGAL, LOGIN_DIKUNCI, LOGIN_DITOLAK, LOGOUT, SESI_DICABUT, AKSES_DITOLAK, ANGGOTA_BUAT, ANGGOTA_UBAH, ANGSURAN_BAYAR, PELUNASAN, SIMPANAN_SETOR, LAN_AKSES_UBAH, SESI_CABUT, WA_PENGATURAN_UBAH, WA_TOKEN_UBAH, WA_TOKEN_HAPUS, WA_TEST_KONEKSI, WA_TEST_PESAN, WA_JALANKAN_MANUAL — dengan user_id, username, entity, entity_id, status BERHASIL/GAGAL/DITOLAK, IP, metadata yang dibersihkan (kunci password/token/secret/pin/cookie/csrf/hash dibuang; pola token disamarkan).
- `audit_log` existing (koperasi.db): tetap ditulis oleh service atas nama user LAN (mis. CREATE anggota oleh operator).
- Lihat di Panel Web › Audit Log LAN (Admin & Pengawas).

## §15 Environment variables

`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_API_VERSION` (bawaan `v21.0`), `WHATSAPP_TEMPLATE_NAME`, `WHATSAPP_TEMPLATE_LANG` (bawaan `id`). Prioritas: env proses → `%APPDATA%\KOPKU Desktop\kopku-server.env` → token di secure store (diisi lewat Panel Web, write-only). Hanya `.env.example` (kosong) yang dikirim; `.gitignore` mengecualikan `.env`/`*.env`.

## §16 Hasil uji (HARNESS-VERIFIED — Node 22.22, node:sqlite, bundle KOPKU 1.0.5 asli)

`npm run test:lan` → **62 uji, 62 lulus, 0 gagal**, diulang tanpa flaky (±18 dtk).

| Berkas | Uji | Cakupan |
|---|---|---|
| `unit.test.js` | 15 | nomor, config, kredensial, migration server DB, UNIQUE notifikasi, sesi idle/absolut, lockout user/IP, sanitasi audit, akses LAN, otorisasi fail-closed, IP privat & Host, validasi, klasifikasi galat API, indeks modul |
| `api-auth-rbac.test.js` | 15 | health, 401 tanpa sesi, cookie flags, login gagal anti-enumerasi, brute force & kunci, akses LAN per role, **RBAC server-side 16 kombinasi role×endpoint** + createdBy authoritative, CSRF, Idempotency-Key wajib, validasi input & aturan bisnis service, tanpa endpoint SQL/berkas, DNS-rebinding, sesi kedaluwarsa/logout/user dinonaktifkan, pencabutan akses seketika, lisensi tidak valid → 503, isi audit tanpa rahasia |
| `konkurensi.test.js` | 9 | dua klien data sama, **bayar angsuran sama bersamaan → 1 sukses + 1 KONFLIK**, klik ganda → 1 transaksi, desktop + 2 klien LAN paralel (jurnal seimbang, tiap pembayaran/simpanan punya jurnal), **kontrol negatif tanpa mutex → galat transaksi**, DB dikunci → 503 + retry aman, **restart server + reconnect** (sesi bertahan, tanpa duplikat), KOPKU belum siap → 503, konflik edit anggota |
| `whatsapp.test.js` | 10 | jam kirim, **H-3/H-1/H/H+1/H+7**, nomor tidak sah, **eksekusi ganda/lease/restart → tanpa pesan ganda**, angsuran dibayar & pinjaman lunas, **offline** (pending, lalu terkirim), dibayar sebelum terkirim → skipped, **401** (jeda, tidak menghabiskan percobaan), **429** backoff, **500×3 → failed**, **timeout**, **template error tanpa retry**, pemulihan `sending`, kedaluwarsa, nonaktif, **token tidak ada di log/DB/galat** |
| `whatsapp-api.test.js` | 1 | token tidak dikirim ke browser, test message hanya ke nomor admin + batas 1/menit, log terfilter & tersamar, token UI tersimpan write-only, tidak ada di audit/berkas DB |
| `regresi.test.js` | 4 | **skenario kembar langsung vs API: 16 bagian identik** (§17), cakupan denda/jasa dimuka/rabat, schema v80 & tabel sama, **76 berkas terlindungi byte-identik** dengan ZIP asli |
| `desktop-electron.test.js` | 7 | main.js+preload.js asli dengan tiruan Electron: kanal IPC lama utuh, webPreferences sama, menu lama utuh, **Desktop Mode tanpa server/adapter/injeksi**, panel terisolasi, **end-to-end browser→HTTP→main→preload→adapter→service**, balasan IPC palsu ditolak, navigasi dalam-halaman SPA tidak memutus layanan, reload → adapter dipasang ulang, kembali ke Desktop Mode → Server Offline |
| `backup-restore.test.js` | 1 | createBackup/restoreBackup existing saat server LAN aktif; API membaca data hasil restore; kopku-server.db utuh |

Uji tampilan (Python Playwright + Chromium, `test/lan/ui-browser.py`): login, dashboard, daftar & detail pinjaman, bayar dari laptop Admin **bersamaan** dengan HP Bendahara (HP mendapat pesan konflik), menu HP, akses LAN, audit, Posisi Keuangan, LHU, WhatsApp, Pengawas tanpa tombol bayar; tanpa galat JS/CSP. Tangkapan layar di `docs/tangkapan-layar/`.

**ELECTRON NYATA (44.5.1 Linux x64, xvfb, `--no-sandbox` karena sandbox berjalan sebagai root):**
- Smoke test lama `smoke-basic`, `smoke-setup` (QR + server sinkron HP), `smoke-firewall` (banner blokir, ping HP, perbaikan): hasil **identik** antara 1.0.5 asli dan versi ini (Desktop Mode tidak berubah saat runtime). `smoke-lisensi` tidak dijalankan (butuh data fixture).
- `test/smoke-lan.js` (baru) **19/19**: server ONLINE dari konfigurasi, health NOT_CONFIGURED → LICENSE_REQUIRED, login fail-closed tanpa lisensi, login scrypt lewat IPC nyata, baca pinjaman, klik ganda → 1 transaksi, konflik, tepat 1 pembayaran di koperasi.db, mutex terpasang, Posisi Keuangan seimbang, scheduler WhatsApp berjalan, panel via IPC `lanmu:*`, renderer utama tanpa akses panel, kembali ke Desktop Mode → port tertutup. Status lisensi pada bagian transaksi memakai tiruan khusus uji (aktivasi asli butuh server lisensi).
- Dijalankan juga terhadap isi paket `dist/win-unpacked/resources/app` hasil build: 19/19, smoke basic & setup (QR dari `qrcode` yang dibundel) lulus.

**CACAT YANG DITEMUKAN ELECTRON NYATA & DIPERBAIKI:** versi ZIP sebelumnya memutus jembatan layanan pada event `did-start-loading`; expo-router memicu event itu saat navigasi dalam-halaman tanpa `did-finish-load` berikutnya, sehingga di Electron nyata server tetap "Database belum siap". Sekarang pemutusan hanya pada `did-navigate` (dokumen diganti) / `render-process-gone`; uji `desktop-electron.test.js` kini memodelkan urutan event nyata tersebut.

**BLOCKED BY ENVIRONMENT** (tidak diklaim lulus): menjalankan `.exe`/installer di Windows nyata, Windows Firewall/UAC nyata, perangkat HP/laptop fisik di Wi-Fi nyata, WhatsApp Cloud API nyata (butuh akun & template approved), `npm run dist:win` dengan electron-builder (registry npm 403 — diganti perakitan manual §22), typecheck/lint (proyek JavaScript tanpa konfigurasi tsc/eslint; seluruh berkas lolos `node --check`).

## §17 Hasil regresi

Skenario yang sama di dua proses (A: service dipanggil langsung = perilaku desktop; B: lewat API LAN): 12 operasi — bayar terlambat ber-denda, bayar tepat waktu, bayar sebelum jatuh tempo (jasa dimuka), bayar sebagian, pelunasan JASA_TERUTANG (dengan rabat) & JASA_KONTRAKTUAL, anggota baru, setor pokok/wajib/sukarela, ubah anggota. Bagian yang dibandingkan dan **identik**: hasil per operasi, schema, daftar tabel, pinjaman, jadwal (termasuk jasa_dimuka & denda), pembayaran (porsi pokok/jasa/denda, metode, rabat), jurnal per baris & kode akun, saldo akun, Laporan Posisi Keuangan, LHU, tunggakan, saldo simpanan, anggota, audit bisnis, nomor urut. Neraca seimbang (selisih 0). Tidak ada rumus pinjaman/angsuran/jasa/denda/pelunasan/jurnal/SHU/laporan yang disalin atau diubah. Backup/restore, login desktop, lisensi, dan sinkron HP tidak disentuh (berkas byte-identik, kecuali dua berkas Electron yang hanya ditambah).

## §18 Menjalankan Desktop Mode

Tidak ada yang berubah: `npm install` → `npm start` (atau installer). Bawaan `mode: DESKTOP` → server, adapter, mutex, dan scheduler WhatsApp **tidak** dijalankan.

## §19 Menjalankan LAN Server Mode

1. Buka KOPKU Desktop di komputer server, masuk sebagai Admin.
2. **Pengaturan › LAN & WhatsApp** → (opsional) *Pengaturan jaringan* untuk port/host → geser saklar **Server LAN Multi-User** ke **ON** → konfirmasi. Lencana berubah **Online**; alamat LAN + QR tampil.
3. Klik **Izinkan di Windows Firewall…** (setujui UAC) atau jalankan perintah netsh di §9 sebagai Administrator.
4. **Buka Panel Web (Admin)** → *Akses LAN Pengguna*: centang user yang boleh masuk; pilih profil *Pengawas* bila hanya boleh melihat.
5. WhatsApp (di layar yang sama, tidak butuh Server LAN): isi Phone Number ID, nama template, **Simpan kredensial**; tempel access token → **Simpan token**; isi Nomor Test & jam kirim, centang jenis → **Simpan jadwal**; **Test koneksi**, **Kirim pesan uji**; geser saklar **WhatsApp Reminder** ke **ON**.
6. Biarkan KOPKU Desktop tetap terbuka. Mode tersimpan; saat KOPKU dibuka lagi, server otomatis aktif.
7. Sebelum **restore backup** disarankan memberi tahu pengguna LAN (selama restore, request LAN mendapat 503 lalu pulih otomatis).

## §20 Uji dari HP/laptop di Wi-Fi yang sama

1. Pastikan HP/laptop di Wi-Fi yang sama (bukan Wi-Fi tamu yang mengisolasi klien) dan profil jaringan komputer server = Private.
2. Buka `http://<IP-server>:47880/api/health` → harus tampil `"server":"ONLINE","database":"READY"`.
3. Buka `http://<IP-server>:47880` → login → buka *Pinjaman & Angsuran* di dua perangkat sekaligus → bayar angsuran yang sama dari keduanya: satu tercatat, yang lain mendapat pesan "baru saja berubah".
4. Matikan Wi-Fi HP → pita merah "Server Offline"; nyalakan lagi → tersambung otomatis.
5. Bila tidak bisa terhubung: cek firewall (§9), profil Public, isolasi klien di router, IP berubah (DHCP — sebaiknya reservasi IP server di router).

## §21 Yang sengaja TIDAK diubah

Engine/framework (Electron 44, Expo web export), database engine (SQLite/node:sqlite), `koperasi.db` (schema v80, tanpa migration), renderer/UI desktop (`renderer/` byte-identik), seluruh service & rumus (pinjaman, angsuran, jasa, denda, pelunasan, jurnal, COA, SHU, laporan, simpanan), login/PIN desktop, lisensi, backup/restore, sinkron HP & `lanServer.js`, `firewallHost.js`, shims, installer NSIS & `firewall.nsh`, skrip build, dependensi npm. Tidak ada cloud dependency untuk fungsi dasar (WhatsApp hanya fitur opsional).

**Temuan pada kode existing (tidak diperbaiki — di luar cakupan):**
- E-1 `restoreBackup`: backup pengaman diberi nama timestamp resolusi 1 detik; me-restore backup yang dibuat pada detik yang sama menimpa berkas target sebelum dibaca ("bukan backup Koperasi Finance").
- E-2 Penyisipan transaksi pada koneksi tunggal (§1.4) secara teori juga dapat terjadi di Desktop Mode bila tugas latar desktop berjalan bersamaan dengan transaksi pengguna (belum diverifikasi; mutex hanya dipasang saat LAN Server Mode aktif agar Desktop Mode tetap identik).

## §22 Build Windows (.exe) tanpa npm

Registry npm tidak dapat diakses di lingkungan build, sehingga paket dirakit setara `electron-builder --win dir` oleh `scripts/rakit-win-tanpa-npm.sh`:

1. `electron-v44.5.1-win32-x64.zip` resmi (GitHub electron/electron, SHA-256 `9b382492…00d7db` cocok dengan SHASUMS256.txt).
2. Isi aplikasi = `build.files` package.json (electron/**, renderer/**, build/icon.png, package.json) di `resources/app/` (folder, bukan app.asar — perilaku runtime sama; `app.isPackaged` = true) + dependensi produksi `qrcode@1.5.4`, `dijkstrajs@1.0.3`, `pngjs@5.0.0` dari sumber GitHub resmi (tag/commit rilis).
3. `electron.exe` → `KOPKU Desktop.exe`; ikon KOPKU multi-ukuran (16–256 px dari build/icon.png) + info versi dipasang oleh `scripts/pe_ikon_versi.py` (pengganti resedit; section resource baru, checksum PE dihitung ulang, divalidasi `objdump`).
4. Installer: `installer/kopku-setup.nsi` ASLI (tidak diubah) dikompilasi makensis NSIS 3 (bundel electron-builder-binaries `nsis-3.0.5.0` + `nsis-resources-3.4.1`); kompresi LZMA solid diberikan lewat argumen makensis `-X"SetCompressor /SOLID /FINAL lzma"` (installer ±111 MB, bukan ±156 MB dengan zlib bawaan skrip); CRC diverifikasi `scripts/verifikasi-installer.py`; build deterministik (dua kali build → berkas identik).

Distribusi lewat chat dibatasi 30 MiB per berkas: installer dipecah menjadi `…Setup.exe.001`–`.004`; jalankan `GABUNG-KOPKU-SETUP.cmd` di folder yang sama (menggabungkan dengan `copy /b` lalu mencocokkan SHA-256 dengan PowerShell `Get-FileHash`).

Hasil: `KOPKU-Desktop-1.0.8-LAN-WhatsApp6-Setup.exe` (installer per-pengguna, pintasan, uninstaller, izin firewall sinkron HP) dan `KOPKU-Desktop-1.0.8-LAN-WhatsApp6-Windows-x64.zip` (portable, jalankan `KOPKU Desktop.exe`). Akhiran nama diatur lewat `AKHIRAN`. Menginstal di atas versi lama mengganti program; data `%APPDATA%\KOPKU Desktop` tetap.

Catatan: berkas tidak ditandatangani (sama seperti 1.0.5) → Windows SmartScreen dapat menampilkan "Windows protected your PC" → *More info* → *Run anyway*. Installer tidak membuka port LAN Multi-User (47880); gunakan tombol di panel Server LAN.

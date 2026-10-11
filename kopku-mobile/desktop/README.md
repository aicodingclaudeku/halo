# KOPKU Desktop (Windows & macOS)

KOPKU Desktop adalah aplikasi KOPKU yang sama dengan versi Android, dijalankan di komputer. Seluruh layar, service, aturan bisnis, laporan, ekspor/impor, backup, login, dan lisensi berasal dari kode yang sama (`src/`, `app/`). Folder `desktop/` hanya berisi:

| Bagian | Isi |
|---|---|
| `electron/main.js` | Jendela, menu, protokol `app://` (aplikasi) & `kopkufs://` (berkas data) |
| `electron/preload.js` | Jembatan aman `window.kopkuDesktop` (contextIsolation + sandbox) |
| `electron/hosts/` | SQLite (`node:sqlite`), berkas, secure store (DPAPI/Keychain), PDF & cetak, server LAN sinkron |
| `shims/` | Pengganti modul native Expo untuk desktop (dipilih Metro saat `KOPKU_DESKTOP=1`) |
| `scripts/build-renderer.js` | Membangun UI dari kode aplikasi (`expo export --platform web`) |
| `test/` | Uji e2e sinkronisasi, uji tampilan (screenshot Electron nyata) & uji asap |

## Menjalankan dari sumber

Prasyarat: Node.js 20 LTS atau 22, npm, Git. Internet hanya diperlukan saat memasang dependensi dan saat aktivasi lisensi pertama kali.

```bash
# 1) dependensi aplikasi (akar repo)
npm ci

# 2) dependensi desktop
cd desktop
npm ci

# 3) bangun UI lalu jalankan
npm run dev            # = build:renderer + electron .
```

`npm start` menjalankan ulang tanpa membangun ulang UI. Mode pengembang dengan DevTools dapat dibuka dengan `KOPKU_DEV=1 npm start`.

## Membangun paket

| Target | Perintah (di folder `desktop/`) | Hasil di `desktop/dist/` |
|---|---|---|
| Windows x64 — installer + portable ZIP | `npm run dist:win` (jalankan di Windows; installer sudah memasang izin firewall) | `KOPKU-Desktop-<versi>-Windows-x64.zip`, `KOPKU-Desktop-<versi>-Setup.exe` |
| macOS Apple Silicon & Intel | `npm run dist:mac` (sebaiknya di macOS) | `KOPKU-Desktop-<versi>-macOS-arm64.zip`, `…-macOS-x64.zip` |

Installer NSIS (`Setup.exe`):
- di Windows: `npm run dist:win`;
- di Linux/macOS tanpa Wine: `npm run dist:win-installer` (butuh `makensis`, mis. `apt install nsis`) — memakai `installer/kopku-setup.nsi` dan memasang ikon/info versi exe dengan `scripts/pasang-ikon-exe.mjs`.

ZIP portable dapat dibuat di sistem apa pun.

Penandatanganan kode: bila tersedia sertifikat, set `CSC_LINK`/`CSC_KEY_PASSWORD` (Windows) atau `CSC_NAME` + notarisasi Apple (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) lalu hapus `"identity": null` di `package.json`. Tanpa tanda tangan, aplikasi tetap berjalan tetapi sistem operasi menampilkan peringatan (lihat di bawah).

## Memasang

### Windows 10/11 (x64) — installer (disarankan)
1. Jalankan `KOPKU-Desktop-1.0.0-Setup.exe`. Bila SmartScreen muncul: **Info selengkapnya → Tetap jalankan**.
2. Ikuti wizard (tanpa hak Administrator; folder default `%LOCALAPPDATA%\Programs\KOPKU Desktop`). Pintasan dibuat di Desktop & Menu Start.
3. Pembaruan: jalankan Setup versi baru — data tidak tersentuh. Uninstall lewat *Pengaturan › Aplikasi*; data koperasi tetap disimpan.

### Windows 10/11 (x64) — portable ZIP
1. Ekstrak `KOPKU-Desktop-…-Windows-x64.zip` ke folder tetap, mis. `C:\KOPKU Desktop`.
2. Jalankan `KOPKU Desktop.exe`. Bila SmartScreen muncul: **Info selengkapnya → Tetap jalankan** (aplikasi belum ditandatangani).
3. Saat pertama memakai Sinkron HP, Windows Firewall akan bertanya — centang **Jaringan pribadi** lalu **Izinkan akses**. Tanpa izin ini HP tidak dapat terhubung.
4. (Opsional) Klik kanan `KOPKU Desktop.exe` → *Sematkan ke Mulai/Taskbar*.

### macOS 12+ (Apple Silicon: `arm64`, Intel: `x64`)
1. Ekstrak ZIP yang sesuai, seret **KOPKU Desktop.app** ke folder **Applications**.
2. Pembukaan pertama: klik kanan → **Buka** → **Buka** (aplikasi belum dinotarisasi). Bila tetap ditolak, jalankan di Terminal:
   `xattr -cr "/Applications/KOPKU Desktop.app"`
3. Saat pertama memakai Sinkron HP, izinkan **koneksi masuk** dan **Jaringan Lokal** (Pengaturan Sistem → Privasi & Keamanan → Jaringan Lokal).

## Lokasi data (offline penuh)

| Sistem | Folder |
|---|---|
| Windows | `%APPDATA%\KOPKU Desktop\` |
| macOS | `~/Library/Application Support/KOPKU Desktop/` |

Di dalamnya: `documents/SQLite/koperasi.db` (database — format SQLite yang sama dengan HP), `documents/backups/` (backup `.kdb`), `documents/sinkron/arsip/` (arsip konflik), `secure-store.json` (kunci & lisensi, terenkripsi DPAPI/Keychain). Menu **Berkas → Buka Folder Data** membuka folder ini. Mencopot aplikasi tidak menghapus data.

## Tampilan desktop

Tampilan dibuat khusus untuk layar lebar, mouse & keyboard — berbeda dari HP, fungsi sama persis:
- **Sidebar gelap bergrup** (Dashboard, Data, Transaksi, Laporan, Pengaturan) dengan sub-menu langsung ke layar yang paling sering dipakai; bisa diciutkan menjadi ikon.
- **Palet perintah `Ctrl+K`**: ketik nama menu, laporan, transaksi, atau pengaturan lalu Enter. Hanya menu yang diizinkan peran pengguna yang muncul.
- **Bilah atas**: pencarian, status Sinkron HP, lonceng pengumuman, menu akun (Identitas, Keamanan, Backup, Keluar).
- **Bilah status**: database lokal, koperasi, tahun buku, pengguna & peran, status sinkron, lisensi, versi.
- **Dashboard desktop**: KPI, aksi cepat, statistik, panel lisensi/sinkron/identitas/panduan.
- **Header halaman** dengan jejak lokasi dan tombol kembali (`Alt+←`); dialog konfirmasi terpusat (`Enter`/`Esc`).
- Layar lisensi, setup, masuk, dan kunci tampil dalam bingkai: panel merek di kiri, formulir di kanan.

## HP sebagai penyimpanan cadangan

Setelah HP dipasangkan, **transaksi & input data hanya di KOPKU Desktop**. HP menerima salinan data (sinkron satu arah desktop → HP) untuk dilihat, diekspor, dan dicadangkan — HP tidak bisa menambah/mengubah data sehingga transaksi tidak tercatat ganda. Desktop hanya mau tersambung dengan HP yang **lisensinya sama**. Rincian: `docs/SINKRONISASI.md`.

## Pertama kali dipakai

- **Sudah memakai KOPKU di HP:** di layar *Selamat Datang* pilih **Sudah memakai KOPKU di HP?** → tampilkan QR → di HP buka *Pengaturan › Sinkron Desktop › Pindai QR Desktop* → *Kirim data HP ke desktop*. Desktop memuat ulang ke layar Login dengan akun yang sama seperti di HP.
- **Koperasi baru:** isi wizard seperti di HP (butuh internet sekali untuk aktivasi lisensi).
- Lisensi desktop memakai slot **Laptop/PC** di server lisensi (1 HP + 1 PC per kunci). Setelah aktif, aplikasi berjalan tanpa internet sesuai masa berlaku token offline.

## Mengatasi HP "Tidak dapat menghubungi desktop … Aborted"

1. Buka **Sinkron HP** di desktop. Bila kartu *Koneksi & firewall* merah, klik **Izinkan di Firewall** dan setujui dialog Windows. Installer 1.0.1 sudah memasang izin ini otomatis.
2. Buka alamat uji yang tertera (mis. `http://192.168.1.7:47821/kopku/v1/ping`) di Chrome HP. Bila muncul tulisan `kopku`, jaringan sudah tembus, dan desktop menampilkan "HP berhasil menjangkau desktop".
3. Bila alamat uji tidak terbuka padahal firewall sudah hijau:
   - Wi-Fi memakai isolasi klien → pakai hotspot HP;
   - HP/komputer beda jaringan;
   - Wi-Fi tanpa internet → matikan data seluler HP sementara;
   - antivirus pihak ketiga punya firewall sendiri.

Perbaikan manual (PowerShell sebagai Administrator):
```
netsh advfirewall firewall delete rule name=all program="$env:LOCALAPPDATA\Programs\KOPKU Desktop\KOPKU Desktop.exe"
netsh advfirewall firewall add rule name="KOPKU Desktop Sinkron" dir=in action=allow protocol=TCP localport=47821-47840 remoteip=localsubnet profile=any
```

## Pintasan

`Ctrl/⌘ + K` cari menu · `Ctrl/⌘ + 1…5` pindah menu utama · `Ctrl/⌘ + \` ciutkan sidebar · `Alt + ←` kembali · `Ctrl/⌘ + Shift + S` Sinkron HP · `Ctrl/⌘ + B` Backup & Restore · `Ctrl/⌘ + =/-/0` ukuran tampilan · `F11`/`⌃⌘F` layar penuh.

## Uji

```bash
cd desktop
npm test                                   # 41 skenario sinkronisasi (2–3 proses, HTTP, kriptografi & SQLite asli)
npm run test:ui -- /tmp/hasil-ui           # data uji realistis + screenshot 18 layar di Electron (butuh xvfb di Linux)
```

Lihat `docs/DESKTOP_ARSITEKTUR.md` dan `docs/SINKRONISASI.md` untuk rincian.

# KOPKU Desktop 1.0.25 — Pengaturan › Asisten AI (MCP untuk Claude)

Basis: KOPKU Desktop 1.0.24 (source KOPKU RC-S133.6.9). Skema database **TETAP v82** — tanpa migrasi,
tidak ada tabel baru di `koperasi.db`. Perhitungan bisnis tidak berubah: bundle renderer byte-identik
dengan 1.0.24 setelah sisipan menu dilepas (diuji `test/lan/regresi.test.js`).

## §A Permintaan

> "Untuk aplikasi desktop, buat agar bisa MCP dengan Claude — bagus dan benar-benar berfungsi —
> tambahkan menunya di Pengaturan dengan nama **Asisten AI**."

Catatan: konektor Claude pernah ada di 1.0.12–1.0.13 lalu dihapus di 1.0.14 (`electron/bersihkanClaude.js`
melepas entri `kopku` dari Claude Desktop setiap kali KOPKU dibuka). Berkas pembersih itu **dihapus**
di 1.0.25 agar konektor baru tidak ikut terlepas.

## §B Cara kerja

```
Claude Desktop ──stdio MCP (JSON-RPC 2.0)──▶ KOPKU Desktop.exe --kopku-mcp-stdio --data <folder>   (electron/mcp/modeStdio.js + stdio.js)
     │                                         └ atau: ekstensi .mcpb (Node.js bawaan Claude Desktop)
     └── HTTP 127.0.0.1:<port acak> + Bearer <token 256-bit> ──▶ McpHost di proses utama KOPKU (electron/mcp/host.js)
              └── IPC ──▶ adapter renderer (SAMA dengan Server LAN, hanya operasi BACA) ──▶ service KOPKU ──▶ koperasi.db
```

- Proses stdio **tidak membuka database**, tidak membuat jendela, tidak mendaftarkan IPC, tidak mengambil
  kunci instance tunggal, dan memakai profil Chromium sementara (dihapus saat keluar). Fuse `runAsNode`
  tetap **OFF** — tidak perlu `ELECTRON_RUN_AS_NODE` maupun Node.js terpasang.
- KOPKU Desktop tertutup / Asisten AI mati → Claude tetap mengenal 14 alat, tetapi setiap pemanggilan
  dijawab "KOPKU Desktop belum terbuka atau Asisten AI belum dinyalakan…".
- Protokol: `initialize` (negosiasi versi 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05), `ping`,
  `tools/list`, `tools/call`, `resources/list`, `prompts/list`; notifikasi tidak dijawab; batch didukung;
  galat JSON-RPC standar (-32700, -32600, -32601, -32602). stdout hanya berisi pesan protokol.

## §C Keamanan & privasi

| Aturan | Penerapan |
|---|---|
| Bawaan MATI | `<userData>/mcp/pengaturan.json` tidak ada = mati; tidak ada port, adapter, maupun injeksi kode |
| Siapa yang boleh menyalakan | Hanya pengguna aktif dengan izin **Pengaturan › Ubah** (diperiksa di proses utama, bukan hanya di layar) |
| Atas nama siapa Claude membaca | Pengguna yang menyalakan; setiap pemanggilan memeriksa ulang: masih aktif, bukan role Anggota, lisensi KOPKU valid, izin **Lihat** resource alat (Permission Matrix) — gagal tertutup |
| Baca saja | Daftar putih `OPERASI_BACA` di `electron/mcp/alat.js`; diuji: jumlah baris SEMUA tabel tidak berubah setelah semua alat dipanggil |
| Data pribadi | NIK, alamat, nomor HP/telepon, tempat & tanggal lahir, email, nomor rekening, nama pemilik rekening, NPWP, password/PIN/hash/salt/token **selalu dibuang** (penyaring rekursif) |
| Data per anggota | Sakelar terpisah, bawaan **MATI**: tanpa sakelar ini hanya angka total, laporan keuangan, dan kolektibilitas ringkas |
| Jaringan | Host hanya 127.0.0.1; token acak baru setiap menyala (`endpoint.json`, mode 0600); permintaan ber-header `Origin` (halaman web) atau `Host` selain localhost ditolak (cegah DNS rebinding) |
| Konfigurasi Claude Desktop | Hanya entri `mcpServers.kopku` milik KOPKU yang ditulis/dilepas; server lain & preferensi tidak disentuh; cadangan dibuat; JSON rusak tidak ditimpa; entri `kopku` milik program lain tidak ditimpa |
| Log | `<userData>/mcp/pemakaian.log`: waktu, alat, berhasil/gagal, durasi — **tanpa isi data** |
| Anti-bypass 1.0.13 | Mode stdio aplikasi terpasang tetap menolak saklar debug (`--inspect`, dll.) |

Data yang dibaca alat dikirim ke Claude (Anthropic) sebagai bagian percakapan pengguna — dijelaskan di
dialog konfirmasi saat menyalakan.

## §D Alat (semua baca saja)

| Alat | Isi | Izin Lihat | Per anggota |
|---|---|---|---|
| status_kopku | koperasi, tahun buku, pengguna, versi, tanggal | – | – |
| ringkasan_koperasi | anggota aktif, simpanan per jenis, pinjaman & sisa piutang, tunggakan, kolektibilitas, kas/bank (bagian tanpa izin disembunyikan) | per bagian | – |
| laporan_keuangan | posisi keuangan, hasil usaha (LHU), laba rugi, arus kas (rekap per sumber), perubahan ekuitas, neraca saldo | laporan | – |
| buku_besar | mutasi & saldo satu akun (kode/nama), termasuk saldo awal | laporan | – |
| kolektibilitas_pinjaman | ringkasan per golongan; rincian per pinjaman hanya bila per anggota ON | pinjaman | sebagian |
| riwayat_shu | SHU per tahun buku | shu | – |
| saldo_kas_bank | saldo rekening kas & bank aktif (tanpa nomor rekening) | kas_bank | – |
| daftar_tunggakan | angsuran lewat jatuh tempo, urut terlama | pinjaman | ✓ |
| cari_anggota / detail_anggota | nomor, nama, status, simpanan, pinjaman | anggota | ✓ |
| saldo_simpanan | pokok/wajib/sukarela per anggota + total | simpanan | ✓ |
| daftar_pinjaman / detail_pinjaman | pinjaman & jadwal angsuran | pinjaman | ✓ |
| riwayat_transaksi | jurnal/transaksi terbaru, filter teks & tanggal | history_transaksi | ✓ |

Angka berasal dari service yang sama dengan layar (diuji sama persis: posisi keuangan, tunggakan, simpanan).

## §E Layar — Pengaturan › Asisten AI

Dapat dibuka dari sidebar Pengaturan (di bawah LAN & WhatsApp), kartu di **Semua Pengaturan**,
pencarian **Ctrl+K** ("ai", "claude", "mcp", "asisten"), dan menu **Berkas › Asisten AI…**.

1. **Hubungkan ke Claude** (sakelar + dialog konfirmasi yang menjelaskan data yang dikirim), status
   *Mati / Menyala — belum terpasang / Siap dipakai Claude*, nama pengguna yang memberi akses.
2. **Izinkan data per anggota** (sakelar + konfirmasi) dan ringkasan privasi.
3. **Pasang di Claude Desktop** — 4 langkah bertanda centang otomatis (Claude Desktop terdeteksi, konektor
   menyala & terdaftar, mulai ulang Claude, bertanya). Tombol *Pasang/Pasang ulang*, *Lepas*, *Unduh Claude Desktop*.
   Cara lain: **Ekstensi Claude (.mcpb)** dan **Pasang manual** (potongan JSON + tombol Salin).
4. **Contoh pertanyaan** (tombol Salin) dan daftar alat (alat bergembok bila per anggota OFF).
5. **Aktivitas**: jumlah pemakaian sesi ini dan 15 aktivitas terakhir; tombol *Buka folder log*.

Tangkapan layar: `docs/tangkapan-layar/1.0.25-asisten-ai-*.png`, `1.0.25-semua-pengaturan.png`.

## §F Langkah pengguna

1. Pasang KOPKU Desktop 1.0.25 dan **Claude Desktop** (claude.ai/download); buka Claude Desktop sekali lalu masuk.
2. KOPKU › **Pengaturan › Asisten AI** → nyalakan **Hubungkan ke Claude** → *Hubungkan*.
   (Opsional) nyalakan **Izinkan data per anggota**.
3. Tutup Claude Desktop **sepenuhnya** (Windows: klik kanan ikon Claude di tray › Quit; macOS: Claude › Quit), buka lagi.
4. Tanyakan di Claude Desktop, mis. "Buatkan ringkasan kondisi koperasi hari ini." → izinkan alat **kopku**.
   KOPKU Desktop harus tetap terbuka.
5. Bila konektor tidak muncul: Claude Desktop › Settings › Developer → lihat log server "kopku"; atau
   gunakan **Buat & buka ekstensi** (.mcpb → klik Install), atau **Pasang manual**.

KOPKU dipindah ke folder lain / diperbarui: entri `kopku` diperbarui otomatis saat KOPKU dibuka.

## §G Berkas

**Baru:** `electron/mcp/katalog.js` (daftar alat, tanpa dependensi), `stdio.js` (server MCP stdio),
`modeStdio.js` (mode stdio di dalam exe), `host.js` (host 127.0.0.1 + token), `alat.js` (implementasi alat
& penyaring data pribadi), `claudeConfig.js` (pemasang konfigurasi Claude Desktop), `mcpb.js` (paket ekstensi
.mcpb, ZIP tanpa dependensi), `ipc.js` (kanal `asistenAi:*`); `renderer-patch/AsistenAiScreen.js`;
`scripts/pasang-menu-asisten-ai.js`; `test/mcp/asisten-ai.test.js`; `test/smoke-asisten-ai-chromium.js`;
`test/smoke-asisten-ai.js` (Electron nyata).

**Berubah:** `electron/entry.js` (mode `--kopku-mcp-stdio`), `electron/main.js` (host, IPC, menu Berkas,
start otomatis bila tersimpan ON), `electron/preload.js` (`kopkuDesktop.asistenAi`), `renderer/` (menu
disisipkan, idempoten), `package.json`/`package-lock.json`/`installer/kopku-setup.nsi` (1.0.25, skrip
pasang menu di `prestart`/`predist:*`), `scripts/rakit-win-tanpa-npm.sh`, uji `test/lan/desktop-electron.test.js`,
`test/lan/regresi.test.js`, `test/lan/electronMock.js`, `test/keamanan/anti-bypass.test.js`,
`test/keamanan/electron-stub.js`, `test/lan/baseline-manifest.json` (hash nsi & lock karena versi).

**Dihapus:** `electron/bersihkanClaude.js`.

Bila renderer dibangun ulang dari source aplikasi (`npm run build:renderer`), skrip `prestart`/`predist:*`
memasang menu ini lagi secara otomatis (sama seperti menu LAN & WhatsApp).

## §H Hasil uji (Linux, Node 22, Electron 44.5.1)

| Pemeriksaan | Hasil |
|---|---|
| `npm run test:mcp` — protokol stdio, per anggota ON/OFF, angka = service, data pribadi, validasi, izin/lisensi/role Anggota, log, paket .mcpb (ZIP+CRC, servernya dijalankan), mati, pemasang menu | 12/12 |
| `npm run test:lan` — termasuk main.js/preload ASLI: kanal IPC, hanya jendela utama, hanya izin ubah Pengaturan, klien stdio → host → preload → adapter → service, **tidak ada baris tabel yang berubah**, muat ulang halaman, pengguna nonaktif, lisensi, token/Origin/Host, mati; ekstensi & lepas; regresi bundle byte-identik | 81/81 |
| `npm run test:keamanan` — pemasang konfigurasi Claude aman; `entry.js --kopku-mcp-stdio` menjawab MCP tanpa jendela/IPC/data; saklar debug ditolak di mode stdio | 15/15 |
| `test/smoke-asisten-ai-chromium.js` — layar asli di Chromium + IPC & host asli + klien stdio + config Claude tiruan + .mcpb | 25/25 |
| `test/smoke-asisten-ai.js` — **Electron 44.5.1 nyata** (xvfb): login, Berkas › Asisten AI…, klik sakelar, entri ditulis, perintah PERSIS dari `claude_desktop_config.json` dijalankan sebagai Claude Desktop, data terbaca, stdout bersih | 14/14 |
| `test/smoke-renderer-rc-s133.6.6-chromium.js` (uji asap UI 1.0.21, regresi) | 14/14 |

Belum diuji di Windows/macOS sungguhan dengan aplikasi Claude Desktop terpasang (lingkungan pengerjaan Linux).
Yang perlu dicoba di Windows: langkah §F; bila konektor tidak muncul, gunakan cara ekstensi `.mcpb`.

Menjalankan uji Electron nyata:
```bash
KOPKU_USERDATA=/tmp/ud KOPKU_CLAUDE_HOME=/tmp/claude KOPKU_SMOKE=$PWD/test/smoke-asisten-ai.js KOPKU_SMOKE_OUT=/tmp/hasil npx electron .
```

## §I 1.0.26 — perbaikan Windows: "kopku — Gagal / Server disconnected"

**Temuan (log Claude Desktop pengguna, Windows 11):** `Server started and connected successfully` →
`[kopku-mcp] siap · data: C:\Users\…\KOPKU Desktop` → ±0,3 detik kemudian `Server transport closed
unexpectedly`. Proses `KOPKU Desktop.exe --kopku-mcp-stdio` keluar sebelum menjawab `initialize`: stdin
proses Electron (subsistem GUI) di Windows tertutup seketika. Pola yang sama terlihat pada log versi 1.0.13
(9–11 Okt). Di Linux (lingkungan uji) stdin Electron berfungsi, sehingga uji 1.0.25 lulus.

**Perbaikan (`electron/mcp/serverLokal.js`, `ipc.js`, `claudeConfig.js`):**
1. Node.js ≥ 18 dicari (PATH, `Program Files\nodejs`, nvm, Homebrew, Volta) dan diuji `node -v`.
   Ada → entri `{ command: "<node.exe>", args: ["<userData>\mcp\server\stdio.js", "--data", "<userData>"] }`;
   `stdio.js` + `katalog.js` disalin dari app.asar ke folder data (ditulis ulang hanya bila berbeda).
2. Windows tanpa Node.js → menyalakan Asisten AI / "Pasang ke Claude Desktop" membuat & membuka paket
   `.mcpb` (Node.js bawaan Claude Desktop); tidak ada entri exe yang pasti gagal.
3. Saat KOPKU dibuka dan Asisten AI menyala, entri `kopku` milik KOPKU (termasuk entri exe 1.0.25)
   diperbarui otomatis ke cara 1 (cadangan konfigurasi dibuat; server lain tidak disentuh).
4. Server stdio menulis ke stderr (tampil di log Claude) "stdin ditutup setelah N pesan" dan petunjuk
   bila N = 0 di dalam exe.

**Langkah pengguna setelah memasang 1.0.26:** buka KOPKU Desktop (entri diperbarui otomatis), lalu tutup
Claude Desktop sepenuhnya (tray › Quit) dan buka lagi. Di Claude › Settings › Developer, "kopku" harus
berstatus *running*; Perintah = `C:\Program Files\nodejs\node.exe`.

## §J 1.0.27 — Claude dapat mengubah data (input, import Excel, koreksi)

**Permintaan pengguna:** "bukan hanya membaca, tapi juga membantu mengimport data, memperbaiki, mengedit/koreksi seperti reverse."

**Sakelar:** Pengaturan › Asisten AI › **Izinkan Claude mengubah data** — bawaan MATI, hanya pengguna dengan
izin Pengaturan › Ubah, dialog peringatan; menyalakannya ikut menyalakan data per anggota, mematikan data per
anggota ikut mematikannya. Disimpan `bolehTulis` di `<userData>/mcp/pengaturan.json`.

**Alat (16):** `opsi_transaksi` (baca), `anggota_tambah`, `anggota_ubah`, `simpanan_setor`, `simpanan_tarik`,
`pinjaman_ajukan`, `pinjaman_cairkan`, `pinjaman_batalkan`, `angsuran_bayar`, `pinjaman_lunasi`, `kas_masuk`,
`kas_keluar`, `kas_transfer`, `koreksi_transaksi`, `import_data_awal`, `buat_backup`. Total alat 30 bila ON.

**Pengaman (`electron/mcp/alatTulis.js`, semua gagal tertutup):**
1. **Dua langkah:** panggilan tanpa `konfirmasi` hanya PRATINJAU (diuji: jumlah baris semua tabel tidak berubah)
   + kode `K-XXXXXX` sekali pakai, berlaku 10 menit, terikat nama alat + argumen + isi pratinjau. Bila argumen atau
   data KOPKU berubah (mis. saldo berubah karena transaksi lain), kode lama ditolak dan pratinjau baru dikirim.
   Petunjuk server & deskripsi alat mewajibkan Claude meminta persetujuan eksplisit pengguna; Claude Desktop juga
   meminta izin per alat (alat bertanda `destructiveHint`).
2. **Izin per aksi** (Permission Matrix): anggota create/edit, simpanan create, pinjaman create/approve/edit,
   kas_bank create/edit, history_transaksi edit, backup create; service KOPKU memeriksa ulang.
3. **Backup otomatis** terenkripsi (BackupService, sama dengan menu Backup) sebelum perubahan pertama tiap 30 menit;
   gagal → perubahan DIBATALKAN.
4. **Hanya service KOPKU:** operasi tulis Server LAN yang sudah teruji (validasi `electron/server/validasi.js`) +
   adapter tulis baru `electron/mcp/adapterTulis.js` (disuntikkan ke jendela utama hanya saat dipakai) untuk
   KoreksiTransaksiService, koreksiSimpanan, koreksiTransaksiKasBank, ImportDataAwalService + PanduanImportData,
   BackupService. Tidak ada SQL tulis langsung.
5. **Koreksi = jurnal pembalik** (transaksi asal tetap tercatat; jejak koreksi); opsional catat ulang untuk
   pencairan pinjaman, angsuran, setoran data awal. Ditolak bila periode tutup buku, SHU final, sudah dikoreksi,
   saldo akan negatif, dst. (aturan KoreksiTransaksiService).
6. **Import Excel:** alur layar Import Data Awal persis (pratinjau → periksaSebelumImport → jalankanImportDataAwal
   atas pratinjau yang sama); berkas BLOKIR tidak mendapat kode; impor ganda dicegah sidik KOPKU; Saldo Lama wajib
   cut-off; berkas disalin ke cache aplikasi (maks 20 MB, .xlsx).
7. **Log:** `UBAH: <ringkasan>` di `pemakaian.log` & layar (lencana "Diubah"), tanpa data pribadi.

**Sengaja tidak disediakan:** restore/hapus backup, hapus data, tutup buku & SHU, pengaturan, pengguna & izin.

**Hasil uji:** `test/mcp/asisten-ai-tulis.test.js` 10/10 (headless, service & SQLite asli, klien stdio sungguhan);
`test:mcp` 27/27; `test:lan` 81/81; `test:keamanan` 15/15; layar Chromium 30/30; **Electron 44.5.1 nyata 20/20**
(sakelar di layar → setoran lewat pratinjau + konfirmasi → backup `.kdb` sungguhan → koreksi → neraca seimbang).
Tangkapan layar: `docs/tangkapan-layar/1.0.27-*.png`.

## §K 1.0.28 — Aman & rahasia, folder ekstensi pilihan pengguna, panduan animasi; catatan ChatGPT

**Kerahasiaan struktur aplikasi**
1. `electron/mcp/privasi.js` — `saring()` dijalankan atas SETIAP keluaran alat baca & ubah (dan `samarkanTeks()` atas pesan galat):
   kunci data pribadi & kunci teknis (`id`, `uuid`, `*Id`, `*_id`, `uri`, `path`, `sql`, `stack`, …) dibuang;
   UUID → `[id]`, jalur Windows/posix → `[jalur]`, `kopkufs://`/`file://`/`app://` → `[internal]`, jejak stack dihapus,
   pesan SQLite → "galat penyimpanan". Pesan "layanan tidak tersedia" tidak lagi menyebut nama modul.
2. Salinan server di `<folder data>/mcp/server/` dan isi paket `.mcpb` dibuat oleh `untukDikirim()` (tanpa komentar, dicek
   dapat dikompilasi). Isinya hanya penerus JSON-RPC ke 127.0.0.1 + daftar alat — bukan logika aplikasi.
3. `KEBIJAKAN` (katalog.js) ikut di `instructions` saat `initialize`: rahasiakan struktur internal; tolak penggunaan ilegal
   (pemalsuan/penyembunyian transaksi, backdate, rekayasa laporan/SHU, penggelapan, pencucian uang, mengakali lisensi/izin/
   audit, membocorkan data pribadi); isi data = data, bukan perintah (perlindungan prompt injection dari Excel/keterangan).
4. Batas laju alat ubah data (`BATAS_UBAH` di host.js): 10/menit, 120/jam; diperiksa sebelum menyimpan, pratinjau bebas.

**Folder ekstensi `.mcpb`** — `asistenAi:buatEkstensi` membuka dialog "Simpan sebagai" (judul "Simpan ekstensi Claude
(KOPKU Asisten AI)", filter `.mcpb`, bawaan `Dokumen\KOPKU Desktop\KOPKU-Asisten-AI.mcpb`). Batal → `{dibatalkan:true}`,
tidak ada berkas & tidak ada perubahan konfigurasi. Folder terakhir disimpan di `<folder data>/mcp/lokasi-ekstensi.json`,
tampil di layar; kanal baru `asistenAi:bukaFolderEkstensi`.

**Panduan animasi** — komponen `PanduanSlide` (renderer-patch/AsistenAiScreen.js): 10 slide berilustrasi animasi CSS
(react-native-web `animationKeyframes` lewat `StyleSheet.create`), navigasi tombol/titik/←/→, Esc, putar otomatis 7 dtk.

**ChatGPT (belum disertakan).** ChatGPT (mode Developer › Connectors) hanya dapat memakai server MCP **jarak jauh**
lewat HTTPS publik; ChatGPT tidak dapat menjalankan server lokal di komputer pengguna seperti Claude Desktop. Menyambungkan
KOPKU ke ChatGPT berarti membuka jalur masuk dari internet ke komputer koperasi (terowongan HTTPS mis. Cloudflare Tunnel
ke server terpisah di 127.0.0.1 dengan alamat rahasia 256-bit, izin ubah data terpisah, batas laju). Karena risikonya
lebih besar daripada konektor lokal, ini perlu keputusan pemilik sebelum dibangun.

**Hasil uji:** `test:mcp` 33/33, `test:lan` 81/81, `test:keamanan` 15/15, layar Chromium 36/36, Electron 44.5.1 nyata 20/20.
Tangkapan layar: `docs/tangkapan-layar/1.0.28-*.png`.


# KOPKU Desktop 1.0.25 — Source Code Aplikasi Windows

Folder ini adalah source aplikasi **KOPKU Desktop** (Electron) yang **siap dibangun** menjadi `.exe` di Windows. Tampilan aplikasi sudah di-build dari source utama KOPKU dan tersimpan di `renderer/`, jadi tidak perlu memasang Expo/React Native.

## Yang baru di 1.0.25 — Pengaturan › Asisten AI (MCP untuk Claude; skema database TETAP v82)
Tanpa migrasi database; perhitungan tidak berubah. Rincian & bukti: `docs/DESKTOP-1.0.25_ASISTEN_AI_MCP_CLAUDE.md`.
- **Menu baru Pengaturan › Asisten AI** (sidebar di bawah LAN & WhatsApp, Semua Pengaturan, Ctrl+K "ai"/"claude", Berkas › Asisten AI…). Tanya data koperasi dalam bahasa sehari-hari dari aplikasi **Claude Desktop** di komputer ini lewat **MCP** — tanpa API key, tanpa membuka data ke internet.
- **Baca saja, 14 alat:** ringkasan koperasi, laporan keuangan (posisi keuangan, LHU, laba rugi, arus kas, perubahan ekuitas, neraca saldo), buku besar, kolektibilitas, SHU, kas & bank, dan — bila **Izinkan data per anggota** ON — tunggakan, anggota, simpanan, pinjaman & jadwal angsuran, riwayat transaksi. Angka dari service yang sama dengan layar.
- **Aman:** bawaan MATI; hanya Admin (izin ubah Pengaturan) yang dapat menyalakan; Claude membaca atas nama pengguna itu sesuai Permission Matrix & lisensi; NIK, alamat, nomor HP, tanggal lahir, nomor rekening **tidak pernah** dikirim; hanya 127.0.0.1 + token acak; setiap pemakaian dicatat (tanpa isi data).
- **Pasang satu klik:** menyalakan sakelar otomatis mendaftarkan konektor "kopku" ke Claude Desktop (server MCP lain tidak disentuh, cadangan dibuat). Claude Desktop menjalankan `KOPKU Desktop.exe --kopku-mcp-stdio` (tanpa Node.js). Cara cadangan: **ekstensi `.mcpb`** (klik Install di Claude Desktop) atau **pasang manual** (JSON + tombol Salin).
- `electron/bersihkanClaude.js` (pembersih fitur Claude 1.0.14) dihapus. Kode baru: `electron/mcp/`, layar `renderer-patch/AsistenAiScreen.js`, pemasang `scripts/pasang-menu-asisten-ai.js` (otomatis di `npm start`/`dist:*`).
- Uji: `npm run test:mcp` 12/12, `npm run test:lan` 81/81, `npm run test:keamanan` 15/15, uji layar Chromium 25/25, **Electron 44.5.1 nyata** 14/14, uji asap UI 1.0.21 14/14.
- **Aplikasi HP tidak berubah** (fitur khusus desktop).

## Yang baru di 1.0.24 (source KOPKU RC-S133.6.9 — Penurunan Nilai Jasa Pinjaman; skema database TETAP v82)
Tanpa migrasi database. Rincian & bukti: `docs/RC-S133.6.9_PENURUNAN_NILAI_JASA_PINJAMAN.md`.
- **Menu baru Transaksi › Penyesuaian › Penurunan Nilai Jasa Pinjaman** (tepat di bawah Kolektibilitas; juga di sidebar & Ctrl+K). Piutang Jasa Pinjaman (jasa sudah diakui, belum dibayar) dinilai per pinjaman menurut kolektibilitas (0/50/75/100%) sesuai SAK EP Bab 11; hanya selisih yang dijurnal: Dr 5-2110 Beban Penurunan Nilai Jasa Pinjaman / Cr 1-1215 Penyisihan Penurunan Nilai Jasa Pinjaman (pemulihan sebaliknya). Layar menampilkan alur bruto → neto, pratinjau jurnal, konfirmasi, rekonsiliasi buku besar vs buku pembantu, dasar SAK EP, export, dan rincian per pinjaman.
- Akun 1-1215 & 5-2110 disiapkan otomatis saat pertama kali dibukukan. Posisi Keuangan menyajikan 1-1215 sebagai pengurang tepat di bawah Piutang Jasa; LHU memuat bebannya; CALK 6 mengungkapkannya (narasi penyisihan kini sesuai SOM 4 kategori).
- Penghapusan piutang memakai penyisihan jasa (1-1215) lebih dulu untuk porsi jasa.
- `renderer/` = bundle 1.0.23 + tambalan **RC-S133.6.9** (`scripts/tambal-renderer-rc-s133.6.9.js`, laporan `docs/laporan-tambal-rc-s133.6.9.json`). Uji: `npm run test:lan` 77/77, `npm run test:keamanan` 14/14, uji langsung bundle 10/10 (termasuk klik tombol Bukukan), uji asap 14/14, 20 layar audit tanpa galat halaman.
- **Aplikasi HP perlu APK baru** dari source RC-S133.6.9.

## Yang baru di 1.0.23 (source KOPKU RC-S133.6.8 — temuan uji import Saldo Lama; skema database TETAP v82)
Tanpa migrasi database: data 1.0.22 terbuka apa adanya. Rincian & bukti: `docs/RC-S133.6.8_TEMUAN_UJI_IMPORT_SALDO_LAMA.md`.
- **Import Data Awal › Saldo lama: tanggal cut-off wajib dipilih.** Layar menampilkan "Belum dipilih", tombol Import terkunci sampai tanggal dipilih (ada tautan "Pakai hari ini"). Saldo per 30 Juni → cut-off 1 Juli.
- **Pratinjau import lebih ketat:** simpanan berjangka tanpa Kebijakan Produk yang berlaku kini **memblokir** import (dulu hanya info, lalu baris gagal dan selisihnya masuk "Saldo Awal Belum Sesuai"); **peringatan** bila cut-off jauh sesudah tanggal saldo di berkas; **info** pinjaman yang sudah lunas sebelum cut-off.
- **Pinjaman yang sudah lunas sebelum cut-off** kini tercatat **dilewati** (bukan gagal) dengan penjelasan; jasanya cukup di sheet 6 dan Pendapatan Jasa sheet 7. Neraca tidak berubah.
- **Posisi Keuangan & CALK memberi peringatan** bila "Saldo Awal Belum Sesuai" (3-5000) belum Rp0 — di layar, di export (baris *Peringatan*), dan di CALK 16.
- **CALK 15 Simpanan Anggota** kini menyebut **Simpanan Berjangka**.
- **Arus Kas:** subjudul tidak lagi menampilkan teks "\u00b7".
- `renderer/` = bundle 1.0.22 + tambalan **RC-S133.6.8** (`scripts/tambal-renderer-rc-s133.6.8.js`, laporan `docs/laporan-tambal-rc-s133.6.8.json`). Uji: `npm run test:lan` 77/77, `npm run test:keamanan` 14/14, uji langsung bundle 9/9, uji asap `test/smoke-renderer-rc-s133.6.6-chromium.js` 14/14, 20 layar audit tanpa galat halaman.
- **Aplikasi HP perlu APK baru** dari source RC-S133.6.8 agar aturan yang sama berlaku di HP.

## Yang baru di 1.0.22 (source KOPKU RC-S133.6.7 — perbaikan temuan audit DAMY; skema database TETAP v82)
Tanpa migrasi database: data 1.0.21 terbuka apa adanya. Rincian & bukti: `docs/RC-S133.6.7_PERBAIKAN_TEMUAN_TERBUKA_AUDIT_DAMY.md`.
- **Keluar anggota yang masih punya pinjaman ditolak.** Lunasi pinjaman dulu (Bayar Piutang/Pelunasan), lalu ajukan keluar. Layar Keluar Anggota menampilkan peringatan dan mengunci tombol Ajukan. Jadwal, status pinjaman, buku pembantu, dan buku besar tetap sama.
- **Import Saldo Lama:** saldo awal akun pendapatan/beban (sheet 7) dibukukan sehari sebelum cut-off, sehingga LHU bulan cut-off tidak lagi memuat pendapatan/beban Jan–Jun (LHU tahunan tetap memuatnya).
- **Tanggal masa depan ditolak juga di layanan** (setor/tarik simpanan, saldo awal) — bukan hanya di pemilih tanggal; berlaku juga untuk input dari browser LAN.
- **Setoran simpanan ganda** (isi sama persis, < 10 detik) ditolak di layanan.
- **Neraca Saldo** menolak tanggal tidak sah; **CALK** menulis narasi penyusutan sesuai mode (Otomatis/Manual).
- **LPEA:** koreksi setoran yang dibuat sesudah tanggal laporan tidak lagi mengubah basis tabungan periode lampau.
- 37 aset ikon/font `renderer/assets/node_modules` sudah dilengkapi (`npm run cek:aset` OK).
- `renderer/` = bundle 1.0.21-perbaikan-audit + tambalan **RC-S133.6.7** (`scripts/tambal-renderer-rc-s133.6.7.js`, laporan `docs/laporan-tambal-rc-s133.6.7.json`). Uji: `npm run test:lan` 77/77, `npm run test:keamanan` 14/14, uji layar Chromium 146/146.
- **Belum diubah (menunggu keputusan pengurus):** batas suku bunga simpanan berjangka.
- **Aplikasi HP perlu APK baru** dari source RC-S133.6.7 agar aturan yang sama berlaku di HP.

## Yang baru di 1.0.21 (source KOPKU RC-S133.6.6 — UI/UX desktop & LAN; skema database TETAP v82)
Tanpa migrasi database: data 1.0.20 terbuka apa adanya, HP (APK RC-S133.6.5) tetap dapat sinkron.
- **Popup desktop tidak lagi bergaya Android.** Dialog notifikasi/konfirmasi kini kotak dialog desktop: bilah judul dengan ikon kecil & ×, pesan rata kiri, bilah tombol abu-abu; tombol utama hijau (merah bila menghapus) paling kiri dan langsung terfokus, Batal paling kanan; Enter = tombol utama, Esc = Batal. Pemilih (Pilih Akun/Anggota/Pinjaman/Rekening, filter, dsb.) tampil sebagai **jendela dialog di tengah**, bukan layar penuh yang meluncur dari bawah; lembar konfirmasi dipusatkan. Rincian: `docs/RC-S133.6.6_UI_UX_POPUP_DESKTOP.md`.
- **Tidak ada lagi pengaturan di browser LAN.** Menu *Pengaturan* (Pengguna & Izin, Akses LAN Pengguna, Audit Log LAN, WhatsApp Reminder, Log WhatsApp, Status Server) dihapus beserta endpoint servernya. Semua diatur di aplikasi: **Pengaturan › LAN & WhatsApp** kini juga berisi **Akses LAN Pengguna** (saklar + profil Pengawas per pengguna), **Sesi aktif di browser** (Akhiri sesi), dan **Audit log LAN**.
- **Browser menunjukkan dengan jelas bahwa data sudah tersimpan:** setelah setiap input muncul dialog bukti "Data berhasil disimpan" berisi ringkasan, nomor transaksi, waktu & nama pencatat, dengan **Cetak bukti** dan *Input lagi*.
- **Ekspor dari browser mengikuti aplikasi:** tombol **Ekspor ▾ PDF / Excel / CSV** di laporan & daftar. Berkas dibuat oleh KOPKU Desktop dengan builder & layanan ekspor yang sama dengan tombol Export di aplikasi (kop, logo, penanda tangan). Butuh izin Export. Buku Besar di browser kini juga membawa Saldo Awal seperti di aplikasi.
- `renderer/` = bundle 1.0.20 + tambalan source **KOPKU RC-S133.6.6** (`scripts/tambal-renderer-rc-s133.6.6.js`, laporan `docs/laporan-tambal-rc-s133.6.6.json`), kemudian tambalan perbaikan audit DAMY (`scripts/tambal-renderer-rc-s133.6.6-perbaikan-audit.js`, `docs/PERBAIKAN_AUDIT_TRANSAKSI_DATA_LAPORAN.md`) + layar LAN & WhatsApp versi baru (`scripts/pasang-menu-lan-wa.js`). Uji: `npm run test:lan` 77/77, `npm run test:keamanan` 14/14, uji asap `test/smoke-renderer-rc-s133.6.6-chromium.js` 14/14 (dan 6.5: 17/17), alur browser `test/lan/ui-browser.py` 25/25. Rincian LAN: `docs/LAN-MULTIUSER-WHATSAPP.md` §00. Tangkapan layar: `docs/tangkapan-layar/1.0.21-*.png`.

## Yang baru di 1.0.20 (source KOPKU RC-S133.6.5 — skema database TETAP v82)
Perbaikan temuan audit **KOPKU-AUDIT-TEST-DAMY** yang sudah divalidasi. Tanpa migrasi database: data 1.0.19 terbuka apa adanya dan HP (APK RC-S133.6.4 atau RC-S133.6.5) tetap dapat sinkron. Rincian & bukti: `docs/RC-S133.6.5_PERBAIKAN_TEMUAN_AUDIT_DAMY.md`.
- **Buku Besar dengan filter tanggal kini membawa Saldo Awal** (baris "Saldo Awal"); Saldo Akhir sama dengan Neraca Saldo. Ekspor ikut.
- **Persentase jasa pinjaman & komponen SHU menerima koma** ("1,5" = 1,5%, dulu terbaca 1%).
- **Validasi transaksi:** pencairan tidak boleh sebelum pengajuan; angsuran tidak boleh sebelum tanggal akad/pencairan, harus milik pinjaman yang dipilih dan pinjaman harus sudah cair; setor/tarik simpanan tidak boleh sebelum anggota bergabung; penarikan diperiksa terhadap saldo pada tanggal penarikan; tanggal fiktif (mis. 30 Februari) ditolak di semua jurnal.
- **Batas kewajaran pinjaman:** jasa maksimal 100% per periode, biaya admin harus lebih kecil dari pokok (persentase < 100%), denda tidak negatif — ditolak saat pengajuan dengan pesan per kolom.
- **Jadwal CUSTOM:** tanggal jatuh tempo harus tanggal kalender YYYY-MM-DD; nominal Rupiah bulat.
- **Form Anggota:** peringatan bila anggota baru tanpa NIK punya nama & tanggal bergabung yang sama dengan anggota lain.
- **Tombol simpan Setor/Tarik Simpanan & Bayar Piutang** tidak lagi bisa mengirim dua kali karena ketukan ganda.
- **Import Data Awal:** kolom opsional baru **"Denda per Hari"** (sheet Pinjaman); pratinjau MEMBLOKIR tanggal setelah hari ini, Simpanan Pokok ganda per anggota, Nomor Pinjaman Lama ganda, setoran sebelum anggota bergabung; MEMPERINGATKAN nominal berdesimal yang dibulatkan dan nominal di atas Rp10 miliar; jasa di atas 100% per periode ditolak. Template lama tetap terbaca.
- **Pembaruan basis data versi sangat lama** tidak lagi berhenti di migrasi v78/v82; salinan pra-migrasi tidak bertabrakan nama.
- **Build:** `npm run dist:win`/`dist:mac` kini berhenti dengan petunjuk bila 37 aset ikon/font `renderer/assets/node_modules` belum dilengkapi (`npm run lengkapi:aset`; cek: `npm run cek:aset`). Tanpa aset itu, ikon tidak tampil — penyebab "A network error occurred." pada uji asap.
- **Belum diubah (menunggu keputusan pengurus):** akrual jasa pinjaman yang menjadi non-accrual — akrual susulan sekali jalan dapat berbeda dari akrual bulanan. Biarkan aplikasi menjalankan akrual tiap bulan (otomatis saat dibuka).
- `renderer/` = bundle 1.0.19 + tambalan source **KOPKU RC-S133.6.5** (`scripts/tambal-renderer-rc-s133.6.5.js`, laporan `docs/laporan-tambal-rc-s133.6.5.json`). Uji asap: `test/smoke-renderer-rc-s133.6.5-chromium.js`.
- **Aplikasi HP perlu APK baru** dari source RC-S133.6.5 agar perbaikan yang sama berlaku di HP.

## Yang baru di 1.0.19 (source KOPKU RC-S133.6.4 — skema database v82)
- **Syarat pinjaman dinilai pada tanggal pengajuan, bukan hari ini.** Pengajuan bertanggal lampau memakai saldo simpanan, sisa pinjaman berjalan, dan tunggakan **pada tanggal itu**. Untuk tanggal hari ini hasilnya tidak berubah. **Form pengajuan tetap menolak**; **Import Data Awal hanya memperingatkan** (pinjaman historis sudah terjadi, jadi tidak ditolak): hasil pengecekan tampil di pratinjau, di hasil import, dan di **Riwayat Import** (baris bertanda kuning).
- **Pencatatan penyelesaian ke Pengadilan Negeri / klaim asuransi** (kriteria Macet angka 3, SOM 12.1): Detail Pinjaman › kartu *Penyelesaian Pengadilan / Asuransi*. Dicatat **manual oleh Admin/Pengurus** (jalur, tanggal, nomor perkara/klaim, dokumen), masuk audit log, dapat diubah/dibatalkan. Pinjaman yang tercatat digolongkan **Macet sejak tanggal pencatatan** di Kolektibilitas Piutang dan export. Tidak membuat jurnal.
- **Pembaruan database v81 → v82 otomatis** saat 1.0.19 pertama dibuka (hanya menambah enam kolom di tabel pinjaman). Sebelumnya dibuat salinan `pra-migrasi-v81-ke-v82-<waktu>.db`; bila salinan gagal dibuat, pembaruan dibatalkan dan data tidak diubah.
- **HP dan desktop harus sama-sama versi baru** (APK dari source RC-S133.6.4): sinkron menolak versi skema berbeda. Perbarui keduanya dalam satu waktu.
- **Tidak diubah (menunggu dasar tertulis):** penempatan masa angsuran 1 bulan dan 4–5 bulan pada penggolongan kolektibilitas. Mohon konfirmasi tertulis pengawas/pengurus.
- `renderer/` = bundle 1.0.18 + tambalan source **KOPKU RC-S133.6.4** (`scripts/tambal-renderer-rc-s133.6.4.js`, laporan `docs/laporan-tambal-rc-s133.6.4.json`). Rincian: `docs/RC-S133.6.4_SYARAT_PINJAMAN_PENYELESAIAN_V82.md`.

## Yang baru di 1.0.18 (source KOPKU RC-S133.6.3 — skema database TETAP v81)
- **Export Kolektibilitas Piutang (PDF/Excel/CSV) diperbaiki & dirapikan.** Format Rupiah kini jatuh di kolom yang benar (Saldo Piutang, Saldo Pokok, Angsuran Terbayar, Nilai Agunan, Nilai Penyisihan — dulu salah kolom). PDF A4 tidak lagi memotong kolom: isinya dibagi menjadi Ringkasan, Rekap per Kolektibilitas, Rincian per Pinjaman, Dasar Penggolongan, Batasan Fiskal (PMK 74/2024), Rincian Fiskal per Pinjaman, serta Dasar & Catatan. Excel: teks panjang dibungkus, tinggi baris menyesuaikan.
- **Data fiskal yang tampil di layar kini ikut ter-export**, beserta penyisihan yang tercatat di buku besar, penyesuaian yang diperlukan, selisih buku − fiskal, dan lingkup anggota.
- **Angka penggolongan & penyisihan TIDAK berubah** (hanya tampilan export). Tanpa migrasi database — data HP & desktop 1.0.17 tetap kompatibel.
- **Dicatat terbuka di export (menunggu keputusan pengurus):** kriteria Macet "diserahkan ke Pengadilan Negeri / klaim asuransi" belum dapat dicatat di aplikasi; penafsiran masa angsuran 1 bulan dan 4–5 bulan.
- `renderer/` = bundle 1.0.17 + tambalan source **KOPKU RC-S133.6.3** (`scripts/tambal-renderer-rc-s133.6.3.js`, laporan `docs/laporan-tambal-rc-s133.6.3.json`). Rincian: `docs/RC-S133.6.3_EXPORT_KOLEKTIBILITAS.md`.

## Yang baru di 1.0.17 (source KOPKU RC-S133.6.2 — skema database v81)
- **Import Excel tidak bisa lagi menggandakan data.** Setiap baris yang sudah masuk dicatat "sidik" isinya (bukan nama berkas/NIK). Berkas yang sama — walau namanya diganti dan anggotanya tanpa NIK — **ditolak** di pratinjau. Berkas yang sebagian barisnya sudah masuk: baris lama **dilewati**, hanya baris baru diproses (import yang gagal sebagian cukup diperbaiki lalu diimpor ulang). Hasil import & Riwayat Import menampilkan jumlah/rincian "dilewati".
- **Pembaruan database v80 → v81 otomatis** saat 1.0.17 pertama dibuka. Sebelumnya dibuat salinan `pra-migrasi-v80-ke-v81-<waktu>.db` di folder database; bila salinan gagal dibuat, pembaruan dibatalkan dan data tidak diubah.
- **Posisi Keuangan:** baris SHU yang menggabungkan SHU tahun lalu yang belum dibagikan dengan hasil tahun ini berlabel **"SHU Tahun Sebelumnya yang Belum Dibagikan dan SHU Tahun Berjalan"**; **ketuk barisnya** untuk melihat rinciannya. Angka tidak berubah, tanpa jurnal penutup.
- **History Transaksi › Koreksi Transaksi** untuk setoran simpanan, pencairan pinjaman, dan pembayaran angsuran: transaksi asal tidak diedit/dihapus — dibuat jurnal pembalik lalu (opsional) dicatat ulang dengan data yang benar; alasan wajib, pengguna & jurnal asal/pembalik/pengganti tercatat. Ditolak dengan alasan bila ada transaksi lanjutan (mis. pencairan yang sudah ada angsurannya, angsuran yang bukan terakhir, akrual jasa) atau periode ditutup.
- **HP dan desktop harus sama-sama versi baru** (APK dari source RC-S133.6.2): sinkron menolak versi skema berbeda.
- `renderer/` = bundle 1.0.16 + tambalan source **KOPKU RC-S133.6.2** (`scripts/tambal-renderer-rc-s133.6.2.js`, laporan `docs/laporan-tambal-rc-s133.6.2.json`). Rincian: `docs/RC-S133.6.2_SIDIK_IMPORT_LABEL_SHU_KOREKSI_TRANSAKSI.md`.

## Yang baru di 1.0.16 (source KOPKU RC-S133.6.1 — tindak lanjut audit input manual vs import Excel)
- **Kolom baru "Rekening Bank" (opsional) di template import** (sheet Simpanan, Pinjaman, Simpanan Berjangka; Template Saldo Lama & Transaksi Baru). Isi nomor rekening seperti di menu Data Bank. Kosong + satu rekening aktif → rekening itu; kosong + lebih dari satu → baris ditolak; nomor tidak terdaftar → ditolak; diisi pada Sumber Dana KAS → ditolak. Template lama tanpa kolom ini tetap terbaca.
- **Pratinjau import kini menolak lebih awal** (tombol Import terkunci) baris BANK yang rekeningnya tidak jelas, NIK yang ganda di dalam berkas, dan NIK yang sudah dipakai anggota lain. Pesan "UNIQUE constraint failed" diganti pesan yang jelas.
- **Pesan "Gagal" tidak lagi tersembunyi di balik jendela** (mis. Cairkan Pinjaman saat saldo rekening tidak cukup).
- **Perubahan Ekuitas:** baris SHU kini dirinci menjadi *SHU tahun buku sebelumnya (− yang dibagikan)* dan *Hasil usaha periode berjalan (= Laporan Hasil Usaha)*; alokasi pembagian SHU (ke Cadangan vs ke dana/simpanan) ditampilkan. Angka, jurnal, dan Posisi Keuangan tidak berubah. Tanpa jurnal penutup tahun.
- **Belum diubah (menunggu keputusan):** import berkas yang sama dua kali masih dapat menggandakan data bila NIK tidak diisi.
- `renderer/` = bundle 1.0.15 + tambalan source **KOPKU RC-S133.6.1** (`scripts/tambal-renderer-rc-s133.6.1.js`, laporan `docs/laporan-tambal-rc-s133.6.1.json`). Rincian: `docs/RC-S133.6.1_TINDAK_LANJUT_AUDIT_MANUAL_VS_IMPOR.md`.
- **Aplikasi HP perlu APK baru** dari source RC-S133.6.1 agar perbaikan yang sama berlaku di HP.

## Yang baru di 1.0.15 (source KOPKU RC-S133.6 — tindak lanjut audit rekonsiliasi)
- **Import "Transaksi baru" dengan Sumber Dana BANK kini berhasil** bila ada tepat satu rekening bank aktif (dulu selalu gagal). Lebih dari satu rekening → baris ditolak dengan pesan jelas (pakai KAS atau menu transaksi).
- **Tidak ada lagi pinjaman "DIAJUKAN" tertinggal** bila pencairan dari import gagal (mis. saldo kas/bank tidak cukup) — pinjaman otomatis dibatalkan (DITOLAK), jadi import ulang tidak menggandakan.
- **Arus Kas:** simpanan sukarela dari Setor Simpanan gabungan/import masuk aktivitas **Operasi** (sama seperti setor sukarela biasa); pokok & wajib tetap Pendanaan. Pembalikannya ikut simetris.
- **Perubahan Ekuitas menyambung antar-tahun:** saldo awal tahun ini = ekuitas akhir tahun lalu; baris SHU menampilkan saldo awal, hasil usaha periode ini (= LHU), dan SHU yang dibagikan. Jurnal & Posisi Keuangan tidak berubah.
- **Posisi Keuangan** per tanggal sebelum jurnal pembagian SHU berlabel "pembagiannya dicatat sesudah tanggal laporan ini" (angka tetap).
- **Import Excel lebih aman:** sel berformat persen (1,5%) terbaca 1,5 (dulu 0,015); Tenor/Angsuran/Masa Manfaat pecahan ditolak (dulu "12,5" terbaca 125).
- `renderer/` = bundle 1.0.14 + tambalan source **KOPKU RC-S133.6** (`scripts/tambal-renderer-rc-s133.6.js`, laporan `docs/laporan-tambal-rc-s133.6.json`). Rincian & bukti uji: `docs/RC-S133.6_TINDAK_LANJUT_AUDIT_REKONSILIASI.md`. Uji asap bundle di Chromium: `test/smoke-renderer-rc-s133.6-chromium.js`.
- **Aplikasi HP perlu APK baru** dari source RC-S133.6 agar perbaikan yang sama berlaku di HP.

## Yang baru di 1.0.14 (source KOPKU RC-S133.5)
- **Fitur Claude dihapus seluruhnya** (Asisten Claude & Konektor Claude Desktop). Saat 1.0.14 pertama dibuka, sisa versi lama dibersihkan otomatis: entri `kopku` di `claude_desktop_config.json` (hanya milik KOPKU; server lain tidak disentuh, cadangan dibuat), folder `%APPDATA%\KOPKU Desktop\mcp`, dan API key tersimpan. Kode: `electron/bersihkanClaude.js`.
- **Sinkron HP: hubungkan dulu, kirim manual.** Langkah 1 pindai QR (hanya memasangkan). Langkah 2 pilih **HP → PC** atau **PC → HP** (ganti penuh; backup pengaman otomatis dibuat sebelum data diganti). Tidak ada sinkron otomatis; HP dan PC sama-sama bisa dipakai input.
- **Akun Anggota hanya melihat data dirinya** (Portal Anggota: simpanan, pinjaman & jadwal angsuran, riwayat, SHU). Izin role Anggota terkunci di Permission Matrix.
- **User Management:** tombol **Hapus** user (nama tetap di riwayat), **Buat akun semua anggota** (username nomor anggota/acak, password acak per anggota/sama untuk semua, wajib ganti password saat masuk pertama, daftar bisa diekspor/cetak), kolom cari & pengelompokan staf/anggota.
- **Aplikasi HP perlu APK baru** dari source RC-S133.5 agar alur sinkron baru & portal anggota juga berlaku di HP.
- `renderer/` = bundle 1.0.13 + tambalan source **KOPKU RC-S133.5** (`scripts/tambal-renderer-rc-s133.5.js` memakai `scripts/peta-modul-bundle.js`; laporan `docs/laporan-tambal-rc-s133.5.json`). Rincian: `docs/RC-S133.5_SINKRON_MANUAL_PORTAL_ANGGOTA_AKUN_MASSAL.md`.

## Yang baru di 1.0.13 — anti-bypass
- **Pintu belakang ditutup pada aplikasi terpasang:** `KOPKU_SMOKE` (dulu dapat memuat skrip apa pun ke aplikasi), `KOPKU_DEVTOOLS`, dan `KOPKU_USERDATA` kini hanya berlaku saat dijalankan dari source (`npm start`).
- **Opsi debug ditolak:** KOPKU terpasang tidak mau dibuka dengan `--remote-debugging-port`, `--inspect`, `--js-flags`, dll. DevTools langsung ditutup bila sempat terbuka; `<webview>`, jendela baru, dan navigasi keluar aplikasi ditolak.
- **Electron Fuses** (`build.electronFuses` di package.json): RunAsNode, NODE_OPTIONS, `--inspect` mati; **integritas app.asar divalidasi** dan aplikasi hanya dimuat dari app.asar — kode yang diubah membuat KOPKU menolak jalan.
- Setelah `npm run dist:win`, `scripts/verifikasi-fuse.js` memeriksa exe otomatis; build gagal bila fuse tidak terpasang. Pastikan muncul **`verifikasi-fuse: OK`**.
- *(dihapus di 1.0.14)* **Konektor Claude Desktop** kini berjalan sebagai `KOPKU Desktop.exe --kopku-mcp-stdio` (tanpa ELECTRON_RUN_AS_NODE). Entri lama diperbarui otomatis saat KOPKU dibuka; cadangan Node.js tersedia di "Pasang manual".
- `scripts/rakit-win-tanpa-npm.sh` (build tanpa npm, dipakai untuk exe dari server) kini juga memasang app.asar + integritas + fuse lewat `scripts/rakit-asar-fuse.js`.
- Font ikon & gambar `renderer/assets/node_modules/` (37 berkas) **sudah lengkap** di paket ini (SHA256 sama dengan manifest) — tidak perlu disalin lagi.
- Rincian & sisa risiko: `docs/RC-S133.4.10_DESKTOP_ANTI_BYPASS.md`. Uji: `npm run test:keamanan`.
- **Bila KOPKU tidak mau terbuka:** pakai `KOPKU-Desktop-1.0.13-CADANGAN-tanpa-cek-integritas-Windows-x64.zip`, atau ubah `enableEmbeddedAsarIntegrityValidation` menjadi `false` lalu build ulang — dan kabari.

## Yang baru di 1.0.12 *(fitur Claude dihapus di 1.0.14)*
- **Konektor Claude Desktop (baru)** — Pengaturan › Asisten Claude › *3. Konektor Claude Desktop*. Tanya data KOPKU langsung dari aplikasi **Claude Desktop** di komputer ini (tanpa API key):
  - **Baca saja** — 11 alat (ringkasan, laporan keuangan, kolektibilitas, tunggakan, anggota, pinjaman, simpanan, riwayat transaksi, SHU); tidak ada alat yang mencatat transaksi.
  - **Data per anggota** dapat dinyalakan/dimatikan. NIK, alamat, nomor HP, tanggal lahir **tidak pernah** dikirim.
  - Tombol **Pasang ke Claude Desktop** mendaftarkan konektor "kopku" otomatis (server lain di Claude Desktop tidak disentuh, cadangan dibuat).
  - Hanya di komputer ini (127.0.0.1 + token), mengikuti izin user KOPKU & lisensi, setiap pemakaian dicatat (`%APPDATA%\KOPKU Desktop\mcp\audit.log`). KOPKU Desktop harus terbuka saat bertanya.
- Kode: `electron/mcp/` (host, stdio, daftar alat, pemasang konfigurasi Claude). Uji: `npm run test:mcp`.
- `renderer/` = bundle 1.0.11 + tambalan source **KOPKU RC-S133.4.9** (`scripts/tambal-renderer-rc-s133.4.9.js`). Rincian: `docs/RC-S133.4.9_KONEKTOR_CLAUDE_DESKTOP.md`; tangkapan layar `docs/tangkapan-layar/rc-s133.4.9-*.png`.
- ChatGPT Desktop belum didukung (hanya menerima konektor yang dibuka ke internet).

## Yang baru di 1.0.11
- **Piutang Berjalan = sisa POKOK pinjaman aktif.** Dulu kartu ini menjumlah sisa angsuran (pokok + jasa yang belum jatuh tempo). Subjudul kini "Sisa pokok · + jasa terjadwal RpX".
- **Import pinjaman: kolom baru "Satuan Jasa" (PERIODE/TAHUN).** Jasa Persen tetap dibaca per bulan/periode; isi TAHUN bila angkanya per tahun (18 → 1,5% sebulan). Sebelum import muncul **peringatan** bila jasa sebuah pinjaman lebih besar dari pokoknya, dan **ringkasan** pokok awal, sisa pokok, sisa jasa, sisa angsuran.
- **Pengaturan › Asisten Claude (baru):** hubungkan KOPKU ke Claude (Anthropic) dengan API key koperasi; tanya jawab baca-saja, ringkasan angka total (tanpa data pribadi) bisa dikirim atau dimatikan. API key disimpan terenkripsi (DPAPI/Keychain). Butuh internet.
- `renderer/` = bundle 1.0.10 + tambalan source **KOPKU RC-S133.4.8** (`scripts/tambal-renderer-rc-s133.4.8.js`, laporan `docs/laporan-tambal-rc-s133.4.8.json`). Rincian & hasil uji: `docs/RC-S133.4.8_PIUTANG_JASA_TAHUNAN_ASISTEN_CLAUDE.md`; tangkapan layar `docs/tangkapan-layar/rc-s133.4.8-*.png`. Folder `renderer/assets/node_modules/` (font ikon) tetap perlu disalin dari renderer lama sebelum `npm run dist:win`.
- Uji asap headless baru: `node test/smoke-piutang-claude-rc-s133.4.8.js <berkas.xlsx> [cut-off]`.

## Yang baru di 1.0.10
- **Layar Import Data Awal dirapikan menjadi 4 langkah** (Jenis data → Template → Periksa → Import) dengan penanda kemajuan. Jenis data dipilih paling awal, tanggal cut-off tampil jelas (bukan lagi tersembunyi), hasil pemeriksaan berupa ubin per sheet, dan angka "Saldo Awal Belum Sesuai" tampil besar di hasil import.
- **Panduan Pengisian berbentuk slide beranimasi**: 16 slide Template Saldo Lama, 9 slide Template Transaksi Baru. Lembar Excel tiruan menyorot kolom yang dijelaskan, isinya "diketik" di bilah rumus, ada poin Benar/Hindari dan contoh kasus yang angkanya saling cocok (sudah diimpor sungguhan: Saldo Awal Belum Sesuai Rp0).
- **Pemeriksaan tambahan sebelum import**: tombol Import terkunci bila baris CONTOH belum dihapus, judul kolom sebuah sheet tidak dikenali, atau berkas Saldo Lama dipilih sebagai Transaksi baru. Ada peringatan untuk tanggal pada/setelah cut-off, saldo simpanan ganda per anggota, dan total jasa sheet 6 ≠ sheet 7.
- **Template Excel lebih rapi**: sheet Petunjuk tidak lagi terlipat per huruf, ada bagian "Sebelum mulai" & "Kesalahan yang sering terjadi", sheet baru **Panduan Kolom**, catatan di setiap judul kolom, 200 baris isian bergaris (NIK/kode berformat teks, tanggal tampil yyyy-mm-dd), catatan kolom pinjaman lama diperbaiki.
- Contoh berkas terisi: `docs/Contoh-Terisi-Template-Saldo-Lama.xlsx`. Rincian: `docs/RC-S133.4.7_UI_UX_IMPORT_PANDUAN_SLIDE.md`. Tangkapan layar: `docs/tangkapan-layar/import-5*.png`.
- `renderer/` = bundle 1.0.9 dengan 8 modul Import Data Awal ditambal dari source **KOPKU RC-S133.4.7** (`scripts/tambal-renderer-rc-s133.4.7.js`). Disarankan membangun ulang dengan `npm run build:renderer` dari source utama. Folder `renderer/assets/node_modules/` (font ikon) tetap perlu disalin dari renderer lama di laptop sebelum `npm run dist:win`.

## Yang baru di 1.0.9
- **Import "Saldo lama" kini setara transaksi biasa** (diuji: saldo seluruh akun, neraca, SHU, SHU Basis Kas, simpanan, pinjaman sama persis).
  - Simpanan berjangka lama (sheet 4) tidak lagi menambah Kas; saldo awal Simpanan Berjangka terisi otomatis; bunga sebelum cut-off tidak dihitung dua kali.
  - SHU Basis Kas: saldo awal beban non-kas (penyusutan, amortisasi, penyisihan, bunga simpanan) tidak lagi dianggap tunai.
  - Sheet baru **"7. Saldo Awal Akun"**: Kas, Bank, pendapatan & beban tahun berjalan, cadangan, utang langsung dari Excel; layar menampilkan "Saldo Awal Belum Sesuai" (harus Rp0).
  - **Dua template**: "Template Saldo Lama" (koperasi yang sudah berjalan) dan "Template Transaksi Baru" (koperasi baru).
  - Rincian: `docs/RC-S133.4.6_IMPORT_SALDO_LAMA_SETARA_TEMPLATE_BARU.md`.
- `renderer/` = bundle 1.0.8 dengan modul Import Data Awal ditambal dari source **KOPKU RC-S133.4.6** (`scripts/tambal-renderer-rc-s133.4.6.js`), karena `expo export` tidak dapat dijalankan di lingkungan pengerjaan. Disarankan membangun ulang dengan `npm run build:renderer` dari source utama.
- **PENTING:** ZIP sumber yang diterima tidak memuat `renderer/assets/node_modules/` (font ikon & gambar navigasi). Salin folder itu dari folder `renderer/` lama di laptop Anda (atau bangun ulang renderer) sebelum `npm run dist:win`, supaya ikon tampil.
- Uji asap baru: `test/smoke-import-saldo-lama-setara.js` (Electron nyata).

## Yang baru di 1.0.8
- **Import data awal kini menghasilkan pinjaman yang sama persis dengan pinjaman yang dicatat lewat transaksi biasa.** Jadwal disusun dari tanggal akad & tenor asli (angsuran yang sudah dibayar tercatat LUNAS), jatuh tempo, tunggakan, kolektibilitas, sisa pokok, dan sisa jasa sama dengan bila semua angsuran diinput satu per satu. Piutang jasa per pinjaman tidak diakui dua kali; angsuran dibayar di muka masuk Pendapatan Diterima Dimuka; Arus Kas tidak lagi menampilkan saldo awal sebagai penerimaan; SHU jasa usaha per anggota terisi walau sheet 6 kosong. Layar hasil import menampilkan pinjaman yang datanya tidak cocok dengan akadnya. Rincian: `docs/RC-S133.4.5_IMPORT_SETARA_TRANSAKSI_LANGSUNG.md`.
- `renderer/` dibangun ulang dari source **KOPKU RC-S133.4.5** (`expo export`); menu Pengaturan › LAN & WhatsApp dipasang ulang.

## Yang baru di 1.0.7 dan 1.0.6
- **SHU Basis Kas tidak lagi Rp0 untuk saldo awal pendapatan/beban.** Pendapatan Jan–cut-off yang diisi lewat Saldo Awal Akun sekarang dianggap sudah diterima tunai (uangnya sudah ada di saldo awal Kas). Bila sebagian masih piutang, atur lewat tombol **Ubah** di kartu akun pada layar Saldo Awal. SHU akrual, neraca, dan jurnal tidak berubah. Rincian: `docs/RC-S133.4.3_SHU_BASIS_KAS_SALDO_AWAL.md`.
- **Import data awal:** petunjuk template kini menjelaskan pilihan *Saldo lama* (tanpa jurnal kas) dan *Transaksi baru* secara terpisah. Ada **sheet baru "6. Jasa Dibayar"**: jasa pinjaman yang sudah dibayar tiap anggota sebelum cut-off, untuk pembagian SHU jasa usaha. Sheet ini boleh diunggah sendiri dengan nomor anggota yang sudah ada. Riwayat import tidak lagi hilang bila berkas memuat sheet Aset/Jasa. Rincian: `docs/RC-S133.4.4_IMPORT_DATA_AWAL_JASA_DIBAYAR.md`.
- `renderer/` dibangun ulang dari source **KOPKU RC-S133.4.4** (`expo export`); menu Pengaturan › LAN & WhatsApp dipasang ulang.

## Yang baru di 1.0.5
- **Konfirmasi putus sinkronisasi** (centang "Saya mengerti"; hanya Admin/izin Backup › Setujui). HP yang diputus dari desktop tetap baca-saja.
- **Pindai QR lagi = HP otomatis penyimpanan cadangan** (data disamakan otomatis, backup pengaman HP dibuat dulu).
- Animasi transfer data dirapikan & menyesuaikan lebar layar.

## Yang baru di 1.0.4
- **Tampilan desktop baru** — sidebar gelap bergrup + sub-menu, palet `Ctrl+K`, bilah atas & bilah status, dashboard desktop, header halaman dengan jejak lokasi, dialog terpusat, layar masuk/lisensi berbingkai. Semua fungsi tetap sama.
- **HP menjadi penyimpanan cadangan** setelah dipasangkan: transaksi & input data hanya di desktop (mencegah transaksi ganda); sinkron satu arah desktop → HP.
- **Sinkron hanya dengan HP berlisensi sama**; berbeda → gagal dengan pesan jelas.
- **Animasi kirim/transfer data** HP ⇄ desktop.
- Perlu **APK baru** di HP.

## Isi folder
| Folder / berkas | Isi |
|---|---|
| `electron/main.js` | Proses utama: jendela, menu, pintasan, protokol `app://` dan `kopkufs://` |
| `electron/preload.js` | Jembatan aman ke tampilan (`window.kopkuDesktop`) |
| `electron/hosts/sqliteHost.js` | Database SQLite lokal (`node:sqlite`), format sama dengan HP |
| `electron/hosts/fsHost.js` | Berkas: backup, ekspor, impor, logo |
| `electron/hosts/secureHost.js` | Penyimpanan rahasia (lisensi, kunci) terenkripsi DPAPI Windows / Keychain macOS |
| `electron/hosts/printHost.js` | PDF & cetak |
| `electron/hosts/lanServer.js` | Server sinkron HP di Wi-Fi lokal (port 47821–47840) |
| `electron/hosts/firewallHost.js` | Cek & izin Windows Firewall untuk sinkron HP |
| `renderer/` | Tampilan aplikasi yang sudah di-build (semua layar, aturan bisnis, laporan, sinkron) |
| `shims/` | Implementasi desktop untuk modul HP (SQLite, berkas, cetak, kamera, dll.) — sudah tertanam di `renderer/` |
| `installer/` | Skrip installer NSIS (izin firewall otomatis) |
| `build/` | Ikon aplikasi |
| `scripts/` | Verifikasi installer, pemasang ikon exe, build ulang tampilan |

## Menjalankan & membangun di Windows
1. Pasang **Node.js 22 LTS** dari https://nodejs.org.
2. Ekstrak ZIP ini, mis. ke `C:\KOPKU-Windows`, lalu buka **PowerShell** di folder tersebut.
3. Pasang dependensi (sekali saja):
   ```
   npm install
   ```
4. Coba jalankan tanpa memaketkan:
   ```
   npm start
   ```
5. Bangun installer dan versi portable:
   ```
   npm run dist:win
   ```
   Hasilnya ada di `dist\`:
   - `KOPKU-Desktop-1.0.13-Setup.exe` — installer yang sekaligus memasang izin Windows Firewall untuk sinkron HP;
   - `KOPKU-Desktop-1.0.13-Windows-x64.zip` — versi portable.

   Bila ingin satu berkas `.exe` tanpa instalasi, jalankan `npm run dist:win-portable`.

Untuk macOS (di Mac): `npm install` lalu `npm run dist:mac`.

## Mengubah tampilan / aturan bisnis
Layar, aturan bisnis, laporan, dan sinkron berada di **source utama KOPKU** (`src/`, `app/`), yaitu ZIP `KOPKU-Source-RC-S133.4.2-Mobile-Desktop.zip`. HP dan desktop memakai kode yang sama. Setelah mengubah source utama, bangun ulang tampilan dari folder `desktop/` di source utama:
```
npm run build:renderer
```
Setelah itu salin folder `renderer/` hasilnya ke sini.

## Data & keamanan
- Data koperasi tersimpan di `%APPDATA%\KOPKU Desktop` dan tidak terhapus saat aplikasi di-uninstall.
- Lisensi desktop bisa diaktifkan otomatis dari HP yang terpasang (perlu `api/activate_companion.php` di web lisensi) atau manual dengan License Key.
- Aplikasi belum ditandatangani sertifikat. Bila punya sertifikat code signing, set `CSC_LINK` dan `CSC_KEY_PASSWORD` sebelum `npm run dist:win`.


## LAN Multi-User & WhatsApp Reminder (opsional)

Menu: **Pengaturan › LAN & WhatsApp** (sidebar, layar *Semua Pengaturan*, pencarian `Ctrl+K` "lan"/"whatsapp", atau menu **Berkas › LAN & WhatsApp…**). Hanya tampil/bisa diubah oleh peran yang punya izin Pengaturan (Admin).

Dua saklar **ON/OFF yang berdiri sendiri** (keduanya OFF secara bawaan — KOPKU Desktop berjalan seperti biasa):

| Saklar | ON | OFF |
|---|---|---|
| **Server LAN Multi-User** | PC/laptop/tablet/HP di Wi-Fi/LAN yang sama membuka KOPKU lewat browser (`http://IP-komputer:47880`) dengan menu lengkap (Data, Transaksi harian, semua Laporan, Pengaturan) sesuai Permission Matrix tiap peran; database tetap hanya di komputer ini. Alamat + QR tampil di layar. | Port ditutup; perangkat lain tidak dapat terhubung. |
| **WhatsApp Reminder** | Pengingat angsuran otomatis (H-3, H-1, H, H+1, H+7) lewat WhatsApp Cloud API — **tidak butuh Server LAN menyala**. | Penjadwal berhenti; tidak ada pesan dikirim. |

- Jam kirim, jenis pengingat, nomor test, Phone Number ID, nama template, dan access token (disimpan terenkripsi, tidak pernah ditampilkan lagi) diatur langsung di layar yang sama — tanpa browser. Kredensial juga tetap bisa lewat env / `kopku-server.env` (lihat `.env.example`; jangan commit kredensial asli).
- Saklar tersimpan: saat KOPKU dibuka lagi, fitur yang ON otomatis menyala kembali.
- Uji: `npm run test:lan` (Node 22+, tanpa Electron).
- Rincian lengkap, keamanan, matriks izin, hasil uji: `docs/LAN-MULTIUSER-WHATSAPP.md`.

# RC-S82 — AKAD ULANG DETAIL PINJAMAN + DOKUMEN EXPORT

Basis: `koperasi-finance_RC-S81-REKONSILIASI-FINAL` (dikunci). Patch terkontrol, additive.

## 1. Ringkasan Hasil

| | RC-S81 (worktree bersih) | RC-S82 |
|---|---|---|
| `npx tsc --noEmit` | 0 error | **0 error** |
| Suite | 267 (260 lulus / 7 gagal) | **268 (261 lulus / 7 gagal)** |
| Test | 5034 (5029 lulus / 5 gagal) | **5088 (5083 lulus / 5 gagal)** |

Himpunan kegagalan dibandingkan **nama per nama** (JSON Jest kedua run): **IDENTIK** — 0 kegagalan baru, 0 hilang, 0 suite hilang. Satu-satunya suite baru: `AkadUlangRcS82.test.ts` (54 test, semua lulus). Tidak ada test lama yang dihapus atau nilai ekspektasinya diubah.

Kegagalan pre-existing (semuanya environmental — dokumen kebijakan `.md` tidak ikut ZIP, ENOENT):
`ImbalHasilTetapRcS67_6`, `KontrolAkhirRcS53` (gagal muat), `PendapatanBungaCoaRcS70_6`, `PendapatanKoperasiRcS67`, `PolicyRegisterRcS53` (gagal muat), `ReleaseHardeningRcS57`, `TemporalIntegrityRcS58`.

## 2. Root Cause Bug §A

`PinjamanDetailScreen.tsx` menghitung "Outstanding Pokok" dan "Jadwal Lama Tersisa" dari daftar status yang diketik ulang di layar (`BELUM_BAYAR || SEBAGIAN`). `ScheduleLifecycle.ts` mendefinisikan CURRENT = `BELUM_BAYAR / SEBAGIAN / TERLAMBAT`, dan `akadUlangPinjaman()` memakai definisi itu. Akibatnya jadwal `TERLAMBAT` tidak tampil di modal, sehingga angka UI lebih kecil daripada sisa pokok yang benar-benar diakadulangkan service.

Bukti (test N1): pinjaman 12 jt / 12 bulan, angsuran #1 lunas, #2–#3 `TERLAMBAT` → rumus lama **9.000.000 / 9 jadwal**, yang benar (dan yang ditulis service) **11.000.000 / 11 jadwal**.

Perbaikan: `ringkasPosisiAkadUlang()` memakai `isCurrentRepaymentSchedule()` — tidak ada daftar status di layar, tidak ada rumus kedua di service.

Uji mutasi: mengembalikan daftar status lama ke helper membuat 3 test gagal (N1, N2, helper murni).

## 3. Perubahan Berkas

Baru:
- `src/services/AkadUlangPresentasi.ts` — helper murni (tanpa DB): ringkasan CURRENT, preflight, parser input ketat, periode relatif, status event, urutan event, nomor dokumen, label manusiawi.
- `src/export/AkadUlangDocumentBuilder.ts` — view model dokumen (murni).
- `src/export/AkadUlangHtmlBuilder.ts` — renderer HTML A4 khusus (tidak memakai `buildReportHtml()`).
- `src/components/DokumenAkadExportButton.tsx` — tombol dokumen akad (awal/ulang), PDF saja, notifikasi + "Bagikan" (lihat §12).
- `src/__tests__/AkadUlangRcS82.test.ts` — 31 test.

Diubah (additive):
- `src/services/PinjamanService.ts` — `+getAkadUlangDocumentData()` (+104 baris, 0 baris dihapus, **SELECT saja**, tanpa transaksi).
- `src/services/ExportService.ts` — `+exportDokumenAkadUlangPdf()`, `+UKURAN_A4_PORTRAIT` (+39 baris). `exportLaporan`/PDF/Excel/CSV tidak diubah.
- `src/screens/Pinjaman/PinjamanDetailScreen.tsx` — bug fix §A, preflight §B, redesign modal §C, konfirmasi §D, validasi §E, riwayat §F, periode relatif §G, tombol export §H/§M.

TIDAK disentuh: `akadUlangPinjaman()`, jurnal, COA, EIR, `ScheduleLifecycle.ts`, schema/migrasi, `nomor_angsuran`, generic export, layar lain.

## 4. Keputusan Desain

- **Satu draft untuk preview, konfirmasi, dan payload.** Saat "Simpan Akad Ulang" ditekan, hasil `validasiFormAkadUlang()` dibekukan ke `akadDraft`; dialog konfirmasi menampilkan draft itu dan `submitAkadUlang()` mengirim draft yang sama. Jatuh tempo baru di preview memakai `calculateMaturityDate()` — fungsi yang sama yang dipakai service.
- **Preflight §B** hanya memblokir kondisi yang juga ditolak service (pembayaran pada jadwal current, atau tidak ada jadwal current). `TERLAMBAT` tidak diblokir. Validasi service tetap sebagai second layer (dibuktikan test).
- **Parser input**: tenor hanya digit; persentase angka non-negatif dengan satu pemisah desimal **titik atau koma** (`1,5` diterima — sebelumnya `parseFloat('1,5')` diam-diam menjadi 1). Tidak ada batas tenor maksimal baru.
- **Status event** ditentukan dari jadwal `dibuat_dari_akad_ulang_id`, bukan kolom `status` (selalu `SELESAI`): `BERLAKU` (ada jadwal current), `HISTORIS — DIGANTIKAN`, `HISTORIS — LUNAS`, `HISTORIS — DIHAPUSBUKU`. Dua status terakhir **tambahan di luar spec**: tanpa itu, akad terakhir pada pinjaman yang sudah lunas/dihapusbuku akan salah tampil.
- **Urutan event**: `created_at` → `tanggal` → `id` (tie-break deterministik untuk `created_at` identik pada resolusi milidetik).
- **Nomor dokumen**: `AU/<nomor pinjaman>/<YYYYMMDD>/<NNN>` — deterministik, stabil, tanpa kolom DB baru.
- **Dokumen**: sisa pokok & piutang jasa dari **snapshot** `pinjaman_akad_ulang`; jadwal dari `dibuat_dari_akad_ulang_id = akadUlangId`; syarat akad awal dari nilai `*_lama` event pertama (baris `pinjaman` sudah memuat syarat terbaru); "Dasar Pokok sebelum" = jumlah pinjaman awal (event pertama) atau snapshot sisa pokok event sebelumnya; "Jatuh Tempo sebelum" = jatuh tempo terakhir jadwal event sebelumnya (atau jadwal akad asli).
- **Ukuran kertas**: `expo-print` default US Letter; jalur dokumen mengirim A4 (595×842 pt) eksplisit. Jalur laporan existing tidak diubah (dijaga test).
- **Judul modal Bayar** memakai label periode relatif ("Bayar Periode 1 dari 6") agar konsisten dengan daftar jadwal. Satu baris; mudah dikembalikan bila ingin scope ketat.

## 5. Deviasi dari Spec (dengan alasan)

- **Footer §K** tampil **sekali di akhir dokumen** (menyatu dengan blok Pengesahan), bukan di setiap halaman. Render Chromium membuktikan tabel jadwal yang bersarang di dalam wrapper `tfoot` (teknik footer berulang) kehilangan pengulangan header dan memecah baris — padahal "table header repeat" adalah syarat eksplisit. Nomor pinjaman & nomor akad ulang juga tercantum di identitas dokumen halaman 1.

## 6. Verifikasi Render PDF

Dirender dengan **Chromium headless** (`@sparticuz/chromium` 131 + `puppeteer-core`, di luar repo — bukan dependency proyek), mesin yang sama dengan Android WebView:

- Skenario normal (6 periode): 3 halaman A4, blok tidak terpecah.
- Skenario ekstrem (60 periode, nama & alamat sangat panjang, nominal 12 digit, keterangan ±1.200 karakter): 6 halaman A4; header tabel berulang di tiap halaman, tidak ada baris terpotong, teks panjang terbungkus, tidak ada tumpang-tindih.
- Dua cacat ditemukan lewat render dan diperbaiki: (1) wrapper tabel bersarang → header tidak berulang; (2) footer tertinggal sendirian di halaman terakhir.
- Catatan: `wkhtmltopdf 0.12.6` di container tidak mendukung pengulangan `thead` bahkan pada dokumen kontrol sederhana, sehingga tidak dipakai sebagai acuan.

## 7. Regresi yang Tertangkap Selama Sesi

`UiInputStandardizationRcS54` gagal: `ScrollView` baru di dialog konfirmasi tidak memiliki `keyboardShouldPersistTaps`. Diperbaiki di kode produksi (satu atribut); test lama tidak diubah.

## 8. Cakupan Test Wajib (§N)

| # | Test |
|---|---|
| N1 | TERLAMBAT ikut current (+ bukti rumus lama salah) |
| N2 | Ringkasan UI = sisa pokok service = snapshot DB = SUM langsung dari tabel |
| N3 | Jadwal obsolete/LUNAS tidak ikut, tanpa double count |
| N4 | Jadwal dokumen = baris `dibuat_dari_akad_ulang_id` (dibanding query langsung) |
| N5 | Dua event → dua dokumen berbeda (nomor, isi, jadwal, nama file) |
| N6 | Dokumen historis memakai jadwal event historis; status DIGANTIKAN/BERLAKU |
| N7 | Periode 1/N…N/N; nomor internal 19–22 tetap di DB |
| N8 | Sisa pokok dari snapshot (dibuktikan dengan mengubah snapshot di fixture) |
| N9 | Piutang jasa tidak ditambahkan ke pokok; catatan audit tampil |
| N10 | Export tidak mengubah DB (seluruh tabel byte-identik); A4 dikirim ke expo-print |
| N11 | `exportLaporan` PDF tetap `buildReportHtml` generik tanpa opsi baru; seluruh suite export lama lulus |
| N12 | `tsc --noEmit` 0 error |

Tambahan: preflight (TERLAMBAT lolos, parsial ditolak di UI **dan** service), parser ketat, izin export (PETUGAS ditolak sebelum file dibuat), escape HTML, audit struktural layar/tombol.

## 9. Checklist Manual

| Item | Status |
|---|---|
| Akad ulang normal / dengan TERLAMBAT / kedua kali | Terverifikasi di test (DB nyata) |
| Pembayaran parsial ditolak jelas | Terverifikasi di test (preflight + service) |
| Riwayat > 1, export terbaru & historis | Terverifikasi di test |
| PDF multi-page, nominal/nama/keterangan/tenor panjang, tanpa overlap | Terverifikasi via render Chromium |
| Tidak ada perubahan accounting | Terverifikasi (diff: 0 DML, 0 baris service dihapus; suite accounting lulus) |
| Tampilan modal & kartu riwayat di perangkat | **BELUM** — tidak ada renderer React Native di Jest |
| PDF di WebView perangkat Android/iOS | **BELUM** — perlu dev build |

## 10. Keterbatasan Tersisa

- Layout UI hanya diaudit struktural; perlu uji visual di perangkat.
- iOS: `margins` expo-print ditambah `@page` CSS berpotensi margin ganda — belum diverifikasi.
- Dokumen pendek (6 periode) menjadi 3 halaman karena blok tidak dipecah — rapi, tetapi boros kertas; dapat dilonggarkan bila diinginkan.
- Lingkungan test direkonstruksi dari `package.json` di ZIP (`npm install --ignore-scripts`).

## 11. Revisi UX (umpan balik screenshot perangkat)

**Masalah terlihat di perangkat:** formulir Akad Ulang "bocor" — latar kartu putih berhenti di tengah formulir, sedangkan Keterangan dan Preview Perubahan dirender di atas backdrop gelap; judul modal ikut tergulung keluar layar.

**Root cause:** formulir panjang ditempatkan di `modalUi.card` (`maxHeight: '90%'`) yang dibungkus `ScrollView` luar. Batas tinggi berlaku pada latar kartu, tetapi anak-anaknya tetap dirender melewati batas itu.

**Perbaikan (hanya `PinjamanDetailScreen.tsx` + `AkadUlangExportButton.tsx`):**
- Komponen lokal `AkadSheet` (bottom sheet) untuk formulir Akad Ulang **dan** konfirmasinya: header TETAP (judul + tombol tutup) → body SCROLL → footer aksi TETAP. Tinggi dibatasi di satu tempat (`sheetWrap maxHeight 92%`), sheet `overflow: hidden`, body `flexShrink: 1`. Tombol Batal/Simpan selalu terlihat.
- Tombol aksi memakai token `modalUi.primaryButton/secondaryButton` (tinggi sentuh 44 dp), lebar sama.
- Satuan Tenor & Metode Jasa: segmented control lebar penuh (`accessibilityRole="radio"`), bukan chip terpisah. Tenor & persentase diberi sufiks satuan ("Bulan", "% / periode").
- Preview kosong menampilkan pesan validasi yang sebenarnya (bukan teks generik).
- **Seksi "Akad Ulang" di Detail Pinjaman** (satu kartu): judul + jumlah akad ulang → tombol **Akad Ulang** → **Export Dokumen Akad Ulang** tepat di bawahnya (selalu terlihat; nonaktif dengan keterangan "Tersedia setelah akad ulang pertama disimpan." bila belum ada akad) → Riwayat Akad Ulang (lipat/buka) dengan export per kartu.
- `AkadUlangExportButton`: varian `block`/`compact`, ikon dokumen, lencana PDF, `akadUlangId` boleh `null` (nonaktif).
- Style yang menjadi tidak terpakai karena perubahan ini dihapus (`chip*`, `errorTextModal`, `riwayatAkadLink`, `akadDokumenTerbaru`). `pencairanActionRow` sudah mati sejak RC-S81 — di luar scope, dibiarkan.

**Test:** +6 test struktural (formulir tidak lagi di `modalCard`; urutan header→scroll→footer; batas tinggi di satu tempat; token tombol; export tepat di bawah aksi Akad Ulang dan sebelum riwayat; label radio manusiawi). Full suite: 5071 test, himpunan kegagalan **identik** dengan baseline RC-S81 bersih.

**Belum diverifikasi:** tampilan di perangkat (tidak ada renderer React Native di Jest) — mohon uji ulang di layar yang sama dengan screenshot.

## 12. Dokumen Akad Awal + Penyempurnaan Template

**Permintaan:** dokumen akad pinjaman dapat diekspor tanpa harus melakukan akad ulang; dokumen dibuat lebih profesional dan rapi.

**Data (read-only):** `PinjamanService.getAkadAwalDocumentData(pinjamanId)` — SELECT saja.
- Syarat akad awal: bila pinjaman pernah diakadulangkan, baris `pinjaman` sudah memuat syarat TERBARU, sehingga syarat asli diambil dari nilai `*_lama` event akad ulang pertama; bila belum pernah, dari baris `pinjaman`.
- Jadwal: baris dengan `dibuat_dari_akad_ulang_id IS NULL` (jadwal akad asli, termasuk yang sudah digantikan).
- Biaya administrasi ditampilkan SEPERTI TERSIMPAN (`Rp…` atau "x% dari jumlah pinjaman") — nominal persentase TIDAK dihitung ulang (tidak ada rumus kedua). Denda hanya ditampilkan diberlakukan/tidak (satuan nilai denda bergantung tipe; tidak ditafsirkan).
- Ringkasan kewajiban = penjumlahan baris jadwal akad awal apa adanya (dibuktikan test terhadap SUM langsung dari tabel).

**Dokumen "DOKUMEN AKAD PINJAMAN" (Akad Awal):** nomor `AK/<nomor pinjaman>/<YYYYMMDD>`; bab I Identitas Anggota, II Ketentuan Pinjaman, III Ringkasan Kewajiban, IV Jadwal Angsuran (1/N…N/N), V Keterangan, VI Pengesahan.
- Pinjaman DIAJUKAN/DISETUJUI → banner **DRAF — PINJAMAN BELUM DICAIRKAN**. Pinjaman DITOLAK → tidak ada dokumen (loader menolak, tombol tidak tampil).
- Bila sudah diakadulangkan → status "HISTORIS — DIGANTIKAN AKAD ULANG" + pemberitahuan bahwa dokumen adalah salinan arsip.

**Template bersama** `src/export/DokumenKontrakHtml.ts` dipakai Dokumen Akad Awal DAN Dokumen Akad Ulang (visual identik). `AkadUlangHtmlBuilder` di-refactor ke template ini tanpa perubahan isi (37 test lama tetap lulus sebelum test baru ditambahkan). Penyempurnaan untuk kedua dokumen:
- Nomor dokumen + "Halaman X dari Y" di SETIAP halaman (kotak margin `@page`; mesin tanpa dukungan mengabaikannya — tidak ada overlap). Terverifikasi Chromium 131: jumlah label halaman = jumlah halaman pada keempat dokumen uji.
- Baris "Ditandatangani di …, tanggal …" (diisi tangan; tidak ada tanda tangan otomatis).

**Export:** `ExportService.exportDokumenAkadAwalPdf()`; kedua dokumen memakai satu jalur privat `cetakDokumenKontrakPdf()` (izin `requirePermission(…'export','export')` sebelum HTML/file dibuat, A4). `exportLaporan` tidak berubah.

**UI:** kartu **"Akad & Dokumen"** di Detail Pinjaman — (A) Akad Awal: status, tanggal · tenor · jasa, tombol **Export Dokumen Akad** (tersedia tanpa akad ulang); (B) Akad Ulang: aksi Akad Ulang → export dokumen akad ulang tepat di bawahnya → riwayat.
- `AkadUlangExportButton.tsx` diganti `DokumenAkadExportButton.tsx` (generik, prop `dokumen: {jenis:'AWAL'} | {jenis:'ULANG', akadUlangId}`), dihapus bersih — tidak ada wrapper. Test RC-S82 yang merujuk nama file lama diarahkan ke file baru (test sesi ini, bukan test baseline).

**Test tambahan (+7):** akad awal tanpa akad ulang (nomor, periode 1/12…12/12, total pokok = jumlah pinjaman, jasa & total = SUM tabel); setelah akad ulang tetap syarat & jadwal asli; DRAF & DITOLAK; export tidak mengubah DB + A4 + PETUGAS ditolak; helper murni; template bersama (nomor halaman, tempat/tanggal); layar (export akad awal tidak bergantung riwayat dan tampil sebelum blok akad ulang).

**Hasil:** tsc 0 error; full suite 5078 test, himpunan kegagalan IDENTIK dengan baseline RC-S81 bersih.

**Belum diverifikasi:** tampilan kartu di perangkat; kotak margin nomor halaman pada WebView Android versi lama (fallback: tidak tampil, tanpa overlap).

## 13. Perjanjian Pinjaman Berdasar Hukum + Pengurus Inti

**Permintaan:** dokumen akad dalam format perjanjian yang merujuk peraturan perundang-undangan Indonesia; terhubung ke menu Pengurus dengan tiga jabatan (Ketua, Sekretaris, Bendahara) yang tampil di PDF.

### Verifikasi status hukum (24 September 2026)
- UU No. 25 Tahun 1992 tentang Perkoperasian **masih berlaku**. RUU Perubahan Keempat baru disetujui menjadi RUU usul inisiatif DPR (paripurna 18 November 2025); tidak ditemukan pengundangan. Dirujuk "beserta perubahannya" agar tidak salah merinci rantai perubahan.
- UU 25/1992 **Pasal 30 ayat (2) huruf a**: Pengurus berwenang mewakili Koperasi di dalam dan di luar pengadilan — dasar Ketua menandatangani atas nama koperasi.
- **Permenkop UKM No. 8 Tahun 2023** tentang Usaha Simpan Pinjam oleh Koperasi.
- Rujukan lain: KUHPerdata Pasal 1320, 1338, 1754; UU 27/2022 (Pelindungan Data Pribadi); UU 10/2020 (Bea Meterai, meterai Rp10.000); AD/ART Koperasi.
- Seluruh rujukan ada di SATU modul `src/export/DasarHukumAkad.ts` (dikunci test) agar mudah ditinjau/diperbarui.

### Pengurus inti — TANPA tabel/migrasi baru
- Tetap memakai `koperasi_personel` (`jenis_personel = 'PENGURUS'`). Modul murni `src/services/PengurusInti.ts`: pengenalan jabatan KETAT (Wakil Ketua / Ketua Pengawas bukan Ketua; ejaan "Sekertaris" diterima), pemilihan pejabat per tanggal, deteksi tumpang-tindih masa jabatan.
- `KoperasiMasterService` (additive): `getSusunanPengurusInti(tanggal)` (read-only); teks jabatan inti dikanonikkan ("ketua pengurus" → "Ketua"); **aturan baru: satu jabatan inti = satu orang aktif pada masa jabatan yang sama** (buat / ubah / aktifkan kembali). Pergantian dilakukan dengan mengisi tanggal berakhir jabatan pejabat lama — histori tetap tersimpan. **Ini aturan bisnis baru — mohon konfirmasi.** 201 test personel lama tetap lulus.
- Menu **Data › Pengurus**: kartu **Susunan Pengurus** (Ketua/Sekretaris/Bendahara yang menjabat hari ini, tombol "Tetapkan" bila kosong); pilihan jabatan Ketua / Sekretaris / Bendahara / Lainnya (Lainnya = teks bebas, mis. Wakil Ketua, supaya data lama tetap bisa diedit). Tanpa SQL di layar.

### Dokumen "PERJANJIAN PINJAMAN" (akad awal)
Kepala (hari & tanggal akad) → komparisi PIHAK PERTAMA (Ketua, atas nama koperasi, nomor badan hukum, kedudukan, dasar kewenangan) & PIHAK KEDUA (anggota) → dasar hukum a–f → Pasal 1–10 (Pokok Pinjaman, Jangka Waktu, Jasa & Biaya, Cara Pembayaran, Keterlambatan & Kelalaian, Pelunasan Sebelum Jatuh Tempo, Perubahan Perjanjian, Pelindungan Data Pribadi, Penyelesaian Perselisihan, Penutup) → tanda tangan (PIHAK KEDUA di atas kotak **Meterai Rp10.000**, PIHAK PERTAMA oleh **Ketua**; **Mengetahui: Sekretaris, Bendahara**) → **LAMPIRAN** (halaman baru): ringkasan ketentuan + jadwal angsuran.
- Nominal disertai **terbilang** ("Rp12.000.000 (dua belas juta rupiah)"); tenor "12 (dua belas) Bulan".
- **Pengurus yang dicetak = yang menjabat pada TANGGAL AKAD**, bukan hari ini (dokumen historis tetap benar setelah pergantian pengurus). Jabatan kosong dicetak garis titik-titik untuk diisi tangan — tidak pernah nama karangan. Detail Pinjaman menampilkan peringatan sebelum mencetak bila ada jabatan kosong.
- Tidak mengarang kebijakan: denda hanya "sesuai ketentuan koperasi" / "tidak dikenakan"; pelunasan dipercepat & penagihan merujuk ketentuan koperasi dan AD/ART.
- **Revisi atas permintaan pengguna:** kolom tanda tangan **Sekretaris dan Bendahara DIHAPUS dari PDF** — dokumen hanya ditandatangani PIHAK KEDUA (anggota, di atas meterai) dan PIHAK PERTAMA (Ketua, atas nama koperasi sesuai Pasal 30 ayat (2) huruf a UU 25/1992). Baris "Mengetahui," ikut dihapus. Kedua jabatan TETAP dikelola di menu Data › Pengurus (kartu Susunan Pengurus tidak berubah); hanya pencetakannya yang dihilangkan. Peringatan jabatan kosong di Detail Pinjaman kini hanya untuk **Ketua**. Test menguncinya dua arah: nama Ketua HARUS muncul, nama Sekretaris/Bendahara HARUS TIDAK muncul.
- **Dokumen Akad Ulang** memakai blok tanda tangan yang sama (pengurus pada tanggal akad ulang) dan menyatakan diri sebagai perubahan atas Perjanjian Pinjaman Nomor `AK/...` (mengacu Pasal 7).
- Render Chromium 131: perjanjian 3 halaman + lampiran 1 halaman (contoh 12 periode); nomor dokumen + "Halaman X dari Y" tiap halaman.

### Test (+10)
Pengenalan jabatan; pemilihan per tanggal; aturan satu-jabatan-satu-orang (buat/ubah/aktifkan kembali, Wakil Ketua & Ketua Pengawas tidak bentrok); terbilang (0 s.d. ratusan miliar) & nama hari; isi perjanjian (kepala, PARA PIHAK, nomor badan hukum, Pasal 30, dasar hukum lengkap, Pasal 1–10, terbilang, meterai, Mengetahui, lampiran halaman baru); pengurus pada tanggal akad (bukan pejabat setelahnya); jabatan kosong → garis titik-titik; akad ulang merujuk nomor perjanjian awal & pengurus pada tanggal akad ulang; export tetap read-only; audit struktural layar. Empat test RC-S82 sebelumnya (format dokumen akad awal lama) disesuaikan ke format perjanjian — test sesi ini, bukan test baseline.

### PERLU TINJAUAN SEBELUM DIPAKAI
- Teks pasal adalah **template umum**. Mohon ditinjau pengurus / penasihat hukum koperasi dan disesuaikan dengan AD/ART (terutama Pasal 5, 6, 9) sebelum dipakai untuk penandatanganan.
- Aturan "satu jabatan inti satu orang per masa jabatan" adalah keputusan bisnis baru.
- `pinjaman.keterangan` (catatan internal) sengaja tidak dicetak di perjanjian.
- Belum diverifikasi di perangkat: tampilan kartu Susunan Pengurus & tombol jabatan (4 tombol dalam satu baris) di layar sempit.

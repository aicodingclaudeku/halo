# Patch 19 Poin — Presentasi/UI/Label/Navigasi (STRICT PATCH)

Prinsip: perbaikan tampilan, label, dan navigasi dikerjakan lebih dulu;
logika akuntansi tidak disentuh. Jurnal, perhitungan saldo, SHU, LHU,
EIR, settlement, dan service akuntansi lain **tidak diubah**. Perubahan
skema hanya satu: **migrasi v77**, yang menambah kolom dan memperbarui
klasifikasi/label tanpa membangun ulang tabel. Migrasi ini dibuktikan
perlu untuk Poin 5 (lihat di bawah).

## Ringkasan per poin

| # | Status | Perubahan |
|---|---|---|
| 1 | Selesai | `DokumenKontrakHtml.ts`: `.info`, `.identitas-dokumen`, `.nilai-utama`, `.nilai-info`, dan `.keterangan` kini tanpa border, latar, atau padding kotak. Indentasi daftar/pasal dikurangi 22px → 18px. Isi dokumen tidak berubah. |
| 2 | Selesai | Modul baru `src/export/TeksPdf.ts` dipakai kedua renderer PDF (`HtmlReportBuilder`, `DokumenSeksiHtml`). Modul ini menghapus label "SAK EP"/"SAK Entitas Privat" dan mengubah tanggal ISO menjadi "4 Oktober 2026". Tanggal yang menempel pada nomor dokumen tidak diubah. Baris "Standar Akuntansi: SAK EP" di kop dihapus, dan "Dicetak pada" berformat Indonesia. Logika SAK EP, CSV/Excel, dan teks di layar tidak berubah. |
| 3 | Selesai | `MasterKoperasiScreens.tsx`: tanggal masa jabatan Pengurus/Pengawas/Karyawan/Pengelola memakai `DatePicker` yang sudah ada, ditambah tombol "Kosongkan" untuk tanggal opsional. Nilai tersimpan tetap 'YYYY-MM-DD'. Ada validasi untuk tanggal lama yang formatnya salah, dan daftar menampilkan "D MMMM YYYY". |
| 4 | **Tidak dikerjakan** | Kontrak simpanan berjangka tanpa tenor tidak diizinkan business logic yang ada: `CHECK (tenor_bulan IN (3,6,12)) NOT NULL`, `tanggal_jatuh_tempo NOT NULL`, dan seluruh perhitungan bunga, jatuh tempo, penalti dini, catch-up, serta PPh bergantung pada tenor. Mewujudkannya butuh rebuild tabel dan **kebijakan bunga baru untuk kontrak terbuka** (kapan diakru, kapan berhenti, penalti). Itu keputusan bisnis/akuntansi, bukan perbaikan tampilan. |
| 5 | Selesai | Field "Nomor Dokumen" dihapus dari form dan service. Ditambah `UnitUsahaPicker` (komponen existing, hanya unit AKTIF). Service menolak unit yang kosong, tidak ditemukan, atau nonaktif, dan tidak pernah membuat unit baru. Referensi unit disimpan di kolom baru `kas_transaksi.unit_usaha_id` / `bank_transaksi.unit_usaha_id` (v77). Idempotensi memakai kunci pengiriman per isian form. Riwayat menampilkan nama unit. Jurnal tetap Dr Kas/Bank, Cr 4-1400. |
| 6 | Selesai | Klasifikasi LHU 4-1500 diubah ke `PENDAPATAN_USAHA_LAIN` di `defaultCOA`. Untuk instalasi lama, v77 hanya mengubahnya bila nilainya masih bawaan `HASIL_INVESTASI`. Kode, nama akun, jurnal, dan saldo tidak berubah. Sudah diaudit: `pendapatanKoperasiPolicy`, `coaPolicyRegistry`, dan `KomposisiPendapatanLhu` tidak memetakan 4-1500 secara hardcode. |
| 7 | Selesai | "Penyusutan Properti Investasi" dipindah ke Transaksi › Penyesuaian, tepat di bawah Penyesuaian Nilai Wajar. Layar yang sama didaftarkan di `TransaksiStack`. Rute `LaporanStack` dan service-nya tetap. |
| 8 | Selesai | "Kolektibilitas Piutang" kini paling atas di hub Penyesuaian. Rute dan layarnya tetap. |
| 9 | Selesai | Baris SHU tahun berjalan tepat di bawah Cadangan Risiko, di layar dan di PDF (tunggal & komparatif). Murni posisi baris. |
| 10 | Selesai | Label tampilan "Rekening Antar Kantor/Unit (RAKU)"/"RAKU" dipakai di navigasi, export, histori, matriks izin, dan layar RAK/Pengembalian/Daftar/Detail. Nama akun 1-1800 diperbarui v77 hanya bila masih nama bawaan. Kode COA, tabel, field, dan logika RAK tetap. |
| 11 | Selesai | RAKU (1-1800) tepat di bawah Piutang Jasa Pinjaman. Urutan dipindah ke modul bersama `src/reports/UrutanPenyajianPosisiKeuangan.ts`, yang dipakai layar dan seluruh export (tunggal & komparatif). Sebelumnya PDF memakai urutan kode akun mentah. |
| 12 | Selesai | `PelepasanAsetFormScreen.tsx` dibagi dalam kartu bernomor: Aset & Nilai Buku, Rincian Pelepasan, Rekening Penerimaan, Keterangan, Pratinjau Laba/Rugi. Ditambah galat inline, warna laba/rugi, dan tombol konfirmasi. Service, validasi, jurnal, dan perhitungan tidak diubah. |
| 13 | Selesai | Blok tanda tangan Ketua/Sekretaris/Bendahara pada LPK, LPHU, CALK, LAK, dan LPE. Nama diambil `ExportService` dari `getSusunanPengurusInti(akhir periode)`; bila kosong dicetak garis titik-titik, tidak pernah nama karangan. Blok memakai `page-break-inside: avoid`, header tabel berulang, dan baris tidak dipecah. |
| 14 | Selesai | Kolom komparatif kini berlabel tahun dari periode laporan ("2026" vs "2025", tidak di-hardcode). Bila kedua periode di tahun yang sama, dipakai tanggal lengkap. Label ringkasan ikut berubah. Tanda tangan juga dicetak di keempat PDF komparatif. |
| 15 | Selesai (PDF) | Gaya formal untuk laporan keuangan (`body.lk`): kop di tengah, garis tipis tanpa band hijau, judul kelompok tanpa kotak abu, subtotal bergaris, total bergaris ganda, angka tabular rata kanan, dan spasi antar-seksi. Angka dan logika LHU tetap. |
| 16 | Selesai | `TombolOpsi`: label dan keterangan boleh dua baris, ikon tidak menyusut, `minWidth` 140. `opsiRow` memakai `flexWrap` sehingga tombol turun baris di layar sempit, tidak terpotong. |
| 17 | Selesai | "Laporan Perhitungan Hasil Usaha" dipakai di menu, judul layar, judul export, dan header PDF (`ACCOUNTING_POLICY.SAK_EP.labelLabaRugi`). Rute internal tetap `LabaRugi`. |
| 18 | Selesai | Label menjadi "Persentase Jasa per Periode/Bulan (%) *". Ejaan baku "Persentase" dipertahankan. Nilai dan perhitungan tetap. |
| 19 | Selesai | Form Imbalan Kerja dibagi lima bagian: Data Personel (read-only dari master), Jenis Imbalan dikelompokkan Tetap/Variabel/**Honorarium terpisah**, Periode & Tanggal (`DatePicker`), Nilai, serta Keterangan & Nilai Awal. "Jadikan nilai awal" disimpan di tabel `app_config` yang sudah ada (tanpa tabel baru), per penerima dan jenis; nilainya bisa diedit dan dihapus. Jurnal pengakuan dan pembayaran tidak berubah. Daftar memakai tanggal Indonesia. |

## Bukti perlunya v77 (Poin 5)

`kas_transaksi`/`bank_transaksi` tidak punya kolom yang bisa menyimpan unit
usaha, dan komentar lama `PendapatanUnitUsahaService` sendiri mencatat
batas ini ("tidak ada atribusi per unit usaha"). Menyimpan ID unit di
teks keterangan ditolak karena bukan relasi. Karena itu kolom nullable
ditambahkan lewat `ALTER TABLE ADD COLUMN`: tanpa rebuild, dan baris lama
tetap NULL. Poin 6 dan 10 ikut menumpang di v77 karena keduanya juga
harus diterapkan ke instalasi lama.

## Verifikasi

- **Typecheck:** `tsc -p tsconfig.rcs67-all.json` (tanpa node_modules). Tidak ada error baru di luar kelas "tipe pustaka tidak tersedia", yaitu panggilan `getFirstAsync`/`runAsync` dan matcher Jest yang sama dengan ratusan baris baseline.
- **Test (harness node:sqlite, HARNESS-VERIFIED, bukan Jest):** seluruh 321 suite dijalankan.
  - Semua suite yang gagal setelah patch dijalankan ulang pada source asli.
  - Setelah test yang terdampak patch diperbarui, tidak ada kegagalan baru.
  - Sisa kegagalan identik dengan baseline: modul native/`sql.js` tidak tersedia, `describe.each`, berkas dokumen kebijakan, dan ketergantungan jam sistem.
- **Suite baru:** `src/__tests__/Patch19PoinPresentasi.test.ts`.

Jalankan `npm run typecheck && npm test` di mesin dengan `node_modules`.

## File yang diubah

**Kode aplikasi**
- `src/components/report/TombolOpsi.tsx`
- `src/config/defaultCOA.ts`
- `src/database/db.ts`
- `src/database/schema.ts`
- `src/export/DokumenKontrakHtml.ts`
- `src/export/DokumenSeksiHtml.ts`
- `src/export/ExportTypes.ts`
- `src/export/HtmlReportBuilder.ts`
- `src/export/ReportTableBuilders.ts`
- `src/export/TeksPdf.ts` *(baru)*
- `src/navigation/RootNavigator.tsx`
- `src/reports/UrutanPenyajianPosisiKeuangan.ts` *(baru)*
- `src/screens/Akuntansi/PenyusutanDimukaMenuScreen.tsx`
- `src/screens/Akuntansi/RAKListScreen.tsx`
- `src/screens/Laporan/HistoryTransaksiDetailScreen.tsx`
- `src/screens/Laporan/LaporanScreen.tsx`
- `src/screens/Laporan/PosisiKeuanganScreen.tsx`
- `src/screens/Pengaturan/MasterKoperasiScreens.tsx`
- `src/screens/Pengaturan/PermissionMatrixScreen.tsx`
- `src/screens/Pinjaman/PinjamanFormScreen.tsx`
- `src/screens/Transaksi/ImbalanKerjaFormScreen.tsx`
- `src/screens/Transaksi/PelepasanAsetFormScreen.tsx`
- `src/screens/Transaksi/PendapatanUnitUsahaFormScreen.tsx`
- `src/screens/Transaksi/PengembalianRAKFormScreen.tsx`
- `src/screens/Transaksi/PenyesuaianScreen.tsx`
- `src/screens/Transaksi/RAKFormScreen.tsx`
- `src/services/ExportService.ts`
- `src/services/HistoryTransaksiService.ts`
- `src/services/ImbalanKerjaService.ts`
- `src/services/KasBankService.ts`
- `src/services/PendapatanUnitUsahaService.ts`
- `src/utils/imbalanKerjaUi.ts`

**Test**
- Baru: `Patch19PoinPresentasi.test.ts`.
- Diperbarui karena perubahan yang memang diminta: penguncian versi skema 76→77 dan ambang "tanpa migrasi" 77→78, label RAKU dan nama laporan, label kolom komparatif, klasifikasi 4-1500, lokasi daftar urutan penyajian, lokasi menu Penyusutan Properti, dan jumlah `FocusTextInput` 95→94. Setiap perubahan diberi komentar `DIPERBARUI Poin N`.

## Catatan terbuka

- **Poin 18:** form pinjaman juga punya satuan tenor HARI/MINGGU. Untuk pinjaman bersatuan itu, kata "/Bulan" di label bisa menyesatkan. Label dibuat statis sesuai permintaan.
- **Poin 2:** teks "SAK EP" masih tampil di layar (bukan PDF): kop layar LHU, catatan hub Penyesuaian, dan petunjuk form pinjaman. Ini sesuai cakupan "hasil PDF".
- **Poin 14:** label "Periode Berjalan/Komparatif" masih ada di tabel layar Perubahan Ekuitas dan Arus Kas. Cakupan poin ini adalah PDF.

---

# Lanjutan — Riwayat per Menu Transaksi & Penyederhanaan Imbalan Kerja

## Riwayat per menu (satu pintu koreksi)

- **Komponen baru** `src/components/RiwayatTransaksiMenu.tsx`
  - Menampilkan 5 transaksi terakhir dari jenis menu itu: tanggal, nomor, nominal, dan penanda *Dibatalkan*/*Koreksi*/*Draf*. Transaksi yang dibatalkan tampil dicoret.
  - Mengetuk baris membuka **Detail History Transaksi** yang sudah ada. Di sanalah satu-satunya tempat koreksi/pembatalan, lengkap dengan cek periode tertutup, izin, jurnal pembalik, dan jejak audit.
  - "Lihat semua riwayat" membuka History Transaksi dengan filter jenis menu itu sudah terpasang.
  - Komponen hanya membaca: tidak ada aksi koreksi, jurnal, atau SQL. Komponen disembunyikan bila pengguna tidak punya izin lihat History Transaksi, dan dimuat ulang setiap layar kembali fokus.
- **Konfigurasi** `src/utils/riwayatMenu.ts`: jenis `sumber_transaksi` per menu, diaudit dari service. Test memastikan setiap jenis memang dipakai service, atau merupakan jenis lama yang masih berlabel.
- **Terpasang di 16 menu**:
  - Simpanan: setor (berjangka otomatis memakai riwayat berjangka), tarik sukarela.
  - Pinjaman: bayar angsuran, penghapusan piutang.
  - Kas/bank: beban, penerimaan lain, pemindahan saldo.
  - Utang & modal: utang (catat/bayar), modal.
  - Aset & investasi: pembelian aset, pelepasan aset, investasi.
  - RAKU: RAKU, pengembalian RAKU.
  - Pendapatan diterima dimuka.
  - *Pendapatan Unit Usaha sudah punya riwayat sendiri yang membuka Detail Kas/Bank; tidak diubah.*
- **Navigasi**: `HistoryTransaksi` & `HistoryTransaksiDetail` juga didaftarkan di stack Transaksi (komponen yang sama), sehingga tombol Kembali kembali ke form asal. `HistoryTransaksiScreen` menerima filter awal (`jenis`, `search`) dari parameter rute.
- **Service (hanya-baca, aditif)**: `HistoryTransaksiRow.reversalOfId` untuk penanda "Koreksi".

## Imbalan Kerja — sederhana

- **Dua bagian**: *Catat Imbalan* dan *Daftar & Bayar (n)*.
- **Catat**, tiga langkah:
  1. Penerima — dipilih dari daftar personel, jenis personel & jabatan tampil read-only.
  2. Jenis Imbalan — satu baris pilihan, dengan satu kalimat penjelas.
  3. Nilai & Tanggal.
- **Rincian tambahan (opsional)** dilipat: jatuh tempo (bawaan sama dengan tanggal, tidak bisa lebih awal), gaji pokok/dasar perhitungan, dan keterangan.
- **Ringkasan sebelum simpan** dalam bahasa sehari-hari, dengan baris jurnal kecil sebagai keterangan.
- **"Ingat nilai ini untuk bulan berikutnya"**: nilai terisi otomatis bulan berikutnya, tetap bisa diubah atau "Lupakan".
- **Bayar per baris** lewat lembar konfirmasi. Kas/Bank dan rekening dipilih di lembar itu, bukan lewat pilihan global.
- Jurnal pengakuan (`catatImbalanKerja`) dan pembayaran (`bayarImbalanKerja`) **tidak berubah**.

## Verifikasi

- Seluruh 322 suite dijalankan di harness node:sqlite. Tidak ada regresi dibanding putaran sebelumnya.
- Suite baru `RiwayatMenuTransaksi.test.ts` lolos 29/29.
- Typecheck: tidak ada error baru, kecuali satu matcher Jest (`toBeLessThanOrEqual`) yang tidak dikenali di konfigurasi tanpa node_modules. Matcher yang sama sudah dipakai test lain.

## File

- **Baru**: `src/components/RiwayatTransaksiMenu.tsx`, `src/utils/riwayatMenu.ts`, `src/__tests__/RiwayatMenuTransaksi.test.ts`.
- **Diubah**:
  - `src/navigation/RootNavigator.tsx`, `src/services/HistoryTransaksiService.ts`, `src/screens/Laporan/HistoryTransaksiScreen.tsx`
  - `src/screens/Transaksi/ImbalanKerjaFormScreen.tsx` (ditulis ulang)
  - 16 form transaksi: tambahan satu baris impor dan satu elemen `<RiwayatTransaksiMenu />` di bawah tombol simpan.

---

# Lanjutan 2 — Riwayat sebagai Tab Tersendiri di Setiap Menu Transaksi

- **Pola**: setiap menu transaksi kini punya pemisah di atas layar, `<label menu> | Riwayat`. Contohnya "Setor Simpanan | Riwayat", "Bayar Angsuran | Riwayat", "Pengajuan Penghapusan | Riwayat". Riwayat tampil sebagai bagian tersendiri, bukan kartu kecil di bawah form.
  - Isian form tidak hilang saat berpindah tab, karena state tetap di layar.
  - Pada mode edit (RAKU, Investasi) tab disembunyikan.
- **Komponen**: `src/components/transaksi/TabTransaksi.tsx`. Labelnya diambil dari `RIWAYAT_MENU[menu].labelBaru` dan bisa ditimpa, misalnya "Bayar Utang".
- **Panel Riwayat** (`RiwayatTransaksiMenu.tsx`):
  - Ringkasan berisi jumlah transaksi, nilai transaksi aktif (diberi label **"bukan saldo"** karena beberapa menu mencampur setor/tarik atau terima/bayar), dan jumlah yang dibatalkan.
  - Pencarian nomor/keterangan dengan jeda ketik.
  - Filter periode (Bulan ini / 3 bulan / Tahun ini / Semua) dan status (Semua / Aktif / Dibatalkan).
  - Daftar dikelompokkan per bulan. Setiap baris menampilkan kotak tanggal, keterangan, nomor & pembuat, nominal, dan lencana status. Transaksi yang dibatalkan tampil dicoret.
  - Ada tombol "Muat lebih banyak" (30 per halaman), keadaan kosong/galat yang jelas, dan catatan bahwa pembatalan tidak menghapus data.
  - Mengetuk baris membuka **Detail History Transaksi**, tetap satu pintu koreksi. Panel hanya membaca data dan dimuat ulang setiap layar kembali fokus.
- **Menu**: 16 menu sebelumnya, ditambah **Pendapatan Unit Usaha**. Daftar riwayat khususnya di layar itu diganti panel standar, sehingga tidak ada daftar ganda.
- **Logika tampilan murni** di `src/utils/riwayatMenu.ts`: periode (lintas tahun benar), ringkasan, filter status, dan pengelompokan per bulan, semuanya dites.
- **Verifikasi**: 322 suite dijalankan di harness, tidak ada regresi. `RiwayatMenuTransaksi.test.ts` lolos 35/35.

---

# Lanjutan 3 — PDF Laporan Keuangan Mengikuti Lampiran Juklat SOM 2025

Acuan: Petunjuk Pelaksanaan SOM 2025, Lampiran 1–8 (Contoh Perhitungan Hasil Usaha, Contoh Neraca, Contoh Laporan Arus Kas, Contoh Laporan Promosi Ekonomi Anggota).

## Yang disamakan (PDF)

- **Bentuk tabel naskah**
  - Kop berada **di dalam** tabel bergaris: NAMA KOPERASI (tebal, kapital), judul laporan (tebal), lalu baris periode.
  - Periode ditulis seperti naskah: "Tahun yang berakhir 31 Desember 2021 dan 2022" untuk laporan arus, dan "Tanggal 31 Desember 2021 dan 2022 (Dalam Rupiah)" untuk posisi keuangan. Bila periodenya bukan satu tahun penuh: "Periode 1 Januari 2026 s.d. 30 Juni 2026".
  - Kolom angka berjudul **tahun**, dengan urutan naskah: **tahun lama di kiri, tahun berjalan di kanan**.
  - Angka **tanpa "Rp"**, titik sebagai pemisah ribuan, dan pengurang **dalam kurung**.
  - Band kelompok ditulis tebal kapital, baris "Jumlah …/Total …" tebal dan menjorok, dan akun pengurang (penyisihan/akumulasi) menjorok satu tingkat.
  - Jenis huruf Bookman Old Style seperti naskah. Bila perangkat tidak memilikinya, dipakai huruf serif pengganti.
  - Kop dan judul kolom berulang di halaman berikutnya, dan baris tidak pernah terpotong.
- **Laporan Perhitungan Hasil Usaha**: susunan persis naskah.
  - PARTISIPASI ANGGOTA, lalu Jumlah partisipasi anggota.
  - BEBAN USAHA, lalu Jumlah beban usaha.
  - SISA HASIL USAHA BRUTO sebagai band tanpa angka, diikuti Hasil investasi dan Beban perkoperasian.
  - PENDAPATAN & BEBAN LAIN, lalu Sisa hasil usaha sebelum pajak dan Beban pajak penghasilan.
  - **SISA HASIL USAHA**, lalu Penghasilan komprehensif lain dan **PENGHASILAN KOMPREHENSIF**.
  - Di bawah tabel: perhitungan **komposisi pendapatan per tahun** seperti penutup naskah (87,6% / 12,4%).
- **Laporan Posisi Keuangan**: ASET / Total aset · LIABILITAS / Total liabilitas · EKUITAS / Total ekuitas · **Total liabilitas dan ekuitas**.
  - Akun pengurang kini tepat di bawah akun yang dikuranginya, seperti "Pinjaman anggota / Penyisihan pinjaman" pada naskah. Perubahan ini juga berlaku di layar karena urutannya memakai modul bersama.
  - Poin 9 dan 11 tetap berlaku: SHU di bawah Cadangan Risiko, RAKU di bawah Piutang Jasa Pinjaman.
- **Laporan Arus Kas**: KEGIATAN OPERASI / INVESTASI / PENDANAAN dengan rincian pos, "Jumlah arus kas …", lalu **KENAIKAN · SALDO AWAL · SALDO AKHIR**.
  - **Versi komparatif kini memuat rincian pos per kegiatan**, seperti naskah. Sebelumnya hanya berisi total per kegiatan.
- **LPEA**: kini dicetak dengan tabel yang sama, termasuk keterangan dan tanda tangan pengurus. Juklat memasukkan LPEA sebagai bagian dari laporan keuangan koperasi.
- **Perubahan Ekuitas & CALK**: naskah tidak memberi contoh, jadi keduanya memakai bentuk tabel naskah yang sama.
- **Tanda tangan** Ketua, Sekretaris, dan Bendahara tetap dicetak di bawah tabel.

## Yang sengaja tidak diubah

- **Perhitungan dan data**: semua angka dibaca dari service apa adanya.
- **Excel/CSV**: tetap memakai baris builder yang lengkap.
- **Layar**: tidak diubah, kecuali posisi akun penyisihan.
- **Laporan non-keuangan** (daftar anggota, buku besar, dll.): tidak diubah.
- **Rincian per akun**: di tempat naskah menulis satu pos (mis. Beban usaha), PDF menampilkan akun COA koperasi apa adanya. Bila nama akun sama dengan pos naskah, hasilnya identik.

## File

- **Baru**: `src/export/JuklatPdf.ts`, `src/__tests__/FormatJuklatPdf.test.ts`.
- **Diubah**:
  - `src/export/HtmlReportBuilder.ts` (renderer format Juklat)
  - `src/export/ExportTypes.ts` (`laporanKeuangan.juklat`)
  - `src/export/ReportTableBuilders.ts` (menyertakan tampilan Juklat, termasuk LPEA)
  - `src/reports/UrutanPenyajianPosisiKeuangan.ts` (akun pengurang di bawah induknya)
  - `src/reports/ArusKasJuklat.ts` (label RAKU yang terlewat di Poin 10)
  - Tes: `Patch19PoinPresentasi.test.ts`, `RiwayatMenuTransaksi.test.ts`.
- **Verifikasi**: 323 suite dijalankan di harness, tidak ada regresi. `FormatJuklatPdf` lolos 14/14 dan mereproduksi angka contoh naskah 2021–2022.

---

# Lanjutan 4 — Dua Pilihan Tampilan PDF Laporan Keuangan

Di lembar **Export**, saat laporannya laporan keuangan pokok (LPK, LPHU, LPE, LAK, CALK, LPEA), kini ada pilihan **Tampilan PDF**:

| Pilihan | Bentuk |
|---|---|
| **Juklat SOM 2025** (bawaan) | Format Lampiran Juklat: kop di dalam tabel bergaris, kolom tahun lama → baru, angka tanpa "Rp" dengan kurung untuk pengurang, komposisi pendapatan di bawah LPHU. |
| **Standar** | Tampilan formal sebelumnya: kop di tengah, tabel bergaris tipis, angka Rp, ringkasan di bawah tabel, kolom berjalan → pembanding. |

- Keduanya mencetak **blok tanda tangan** Ketua, Sekretaris, dan Bendahara.
- Pilihan terakhir **diingat** di tabel existing `app_config` (`PDF_GAYA_LAPORAN_KEUANGAN`), tanpa skema baru.
- Pilihan tidak muncul untuk laporan lain, serta tidak memengaruhi Excel/CSV maupun angka.
- **File**:
  - Baru: `src/services/PreferensiCetakService.ts`.
  - Diubah: `src/components/ExportButton.tsx` (pilihan di lembar Export), `src/export/ExportTypes.ts` (`laporanKeuangan.gayaPdf`), `src/export/HtmlReportBuilder.ts` (pemilih renderer), `src/__tests__/FormatJuklatPdf.test.ts` (+4 tes).
- **Verifikasi**: 323 suite dijalankan di harness, tidak ada regresi. `FormatJuklatPdf` lolos 18/18.

---

# Lanjutan 5 — Tampilan Excel Profesional

Seluruh export **Excel** (laporan tabel dan dokumen berseksi seperti Detail Anggota) kini bergaya. Gayanya memakai palet `GayaExcel` yang sama dengan template Import Data Awal, yaitu hijau primer aplikasi.

## Tampilan

- **Kop**: nama koperasi (besar, hijau), alamat, judul laporan (tebal), periode, dan keterangan "Nilai dalam Rupiah". Semuanya digabung selebar tabel dan ditutup garis hijau.
- **Judul kolom**: bar hijau dengan teks putih tebal. Kolom teks rata kiri, kolom nominal rata kanan.
- **Nominal**: kini **angka sungguhan** (bisa dijumlah/diolah), bukan teks "Rp…". Formatnya pemisah ribuan dengan **negatif dalam kurung**.
- **Laporan keuangan**: band kelompok berlatar hijau muda, rincian menjorok, subtotal tebal bergaris atas, dan total tebal bergaris ganda.
- **Laporan daftar**: baris belang lembut dan **filter otomatis** di judul kolom.
- **Bagian bawah**: blok **Ringkasan** dan **Catatan Penyajian** (teks dibungkus), lalu jejak "Dicetak pada …".
- **Dokumen berseksi**: judul seksi berlatar hijau muda, label–nilai rapi, tabel dengan bar judul hijau, dan baris total bergaris ganda.
- **Ukuran**: lebar kolom dan tinggi baris diatur dari isinya. Garis kisi bawaan tidak dipakai sebagai pengganti garis tabel.

## Yang tidak berubah

- Isi dan angka laporan.
- PDF, CSV, dan seluruh service akuntansi.

## Batasan pustaka

Pustaka `xlsx-js-style` tidak menulis **freeze pane** dan **dropdown**. Ini sudah tercatat di `GayaExcel`, jadi keduanya tidak dijanjikan.

## File

- **Baru**: `src/export/ExcelLaporanBuilder.ts` (tata letak murni), `src/__tests__/ExcelLaporanProfesional.test.ts` (11 tes).
- **Diubah**:
  - `src/services/ExportService.ts`: `exportToExcel` kini menerjemahkan tata letak ke worksheet, dan pengukur lebar lama dihapus.
  - `src/export/ExcelSeksiBuilder.ts`: tambahan aditif `peran` per baris.
  - `src/export/GayaExcel.ts`: `alignment.indent`.
  - `src/__tests__/ArusKasJuklatRcS104.test.ts`: penjaga lokasi catatan kaki.

## Verifikasi

- 324 suite dijalankan di harness, tidak ada regresi.
- Tampilan diperiksa visual dengan menerjemahkan tata letak yang sama ke openpyxl dan merendernya lewat LibreOffice, karena `xlsx-js-style` tidak tersedia di lingkungan uji.

---

# Lanjutan 6 — Bunga Harian Simpanan Sukarela & Basis Jasa Modal SHU (v78)

Kebijakan produk koperasi (Juklat SOM 2025 hlm. 7, 28, 30–32). Sifatnya aditif, digerakkan kebijakan, dan kompatibel ke belakang. Menu ada di **Transaksi › Penyesuaian › Bunga Simpanan Sukarela**.

## Keputusan yang diterapkan
- **Bunga harian.** Bunga hari = saldo **akhir hari** × tarif tahunan ÷ 365. Seluruh hari kalender dihitung, termasuk hari terakhir bulan. Transaksi berlaku sejak tanggalnya, dan basis 365 hari juga dipakai di tahun kabisat. Contoh Lampiran 10 Juklat (30 hari, Rp11.013) diperlakukan sebagai ilustrasi; mesin menghitung 31 hari, menghasilkan Rp11.309.
- **Basis jasa modal SHU.**
  - Instalasi lama: **ON** (perilaku dipertahankan oleh migrasi v78).
  - Instalasi baru: **OFF** (mengikuti Juklat).
  - Kebijakan berversi per tahun buku dan hanya berlaku ke depan.
  - Snapshot disimpan per tahun buku di `shu_konfigurasi.sukarela_basis_jasa_modal`.
  - Saat OFF, saldo sukarela beserta bunganya tidak masuk basis jasa modal.
- **PPh.** Memakai mesin pajak KOPKU yang sudah ada (`hitungPphBungaSimpanan`, `catatBuktiPotongBungaSimpananPadaDb`). Aturan agregasi lintas produk tidak diubah.

## Desain
- **Kebijakan bunga berversi (append-only).** Isinya aktif/nonaktif, tarif ≤ 9%/tahun, dan bulan mulai berlaku. Versi baru hanya boleh berlaku mulai bulan berikutnya dan setelah bulan terakhir yang diakru. Default OFF: tanpa versi, tidak ada perhitungan, akrual, maupun jurnal.
- **Akrual bulanan idempoten.** Satu proses POSTED per bulan (indeks unik), satu jurnal bertanggal akhir bulan:
  - Dr Beban Bunga Simpanan Sukarela (5-1956, Beban Usaha)
  - Cr Simpanan Sukarela (2-1200)
  - Cr Utang PPh 4(2) (2-1901)
  - Ditambah satu baris simpanan per anggota, sehingga saldo bertambah sebesar bunga neto.
- **Urutan wajib.** Bulan-bulan diakru berurutan. Bulan yang belum berakhir ditolak, periode tertutup ditolak oleh mesin jurnal, dan proses otomatis berjalan saat aplikasi dibuka.
- **Koreksi otomatis.** Setiap akrual menghitung ulang bulan-bulan yang sudah diakru. Transaksi bertanggal mundur, koreksi, atau pembatalan menghasilkan baris **KOREKSI** (selisih positif atau negatif) di akrual berikutnya, tanpa bunga ganda dan tanpa mengubah data lama.
- **Batal.** Hanya bulan terakhir yang bisa dibatalkan, lewat jurnal pembalik dan baris koreksi simpanan. Bulan itu lalu dapat diakru ulang.
- **Bunga tidak berbunga di bulan yang sama.** Kredit bunga bulan M tidak ikut dasar bunga bulan M; bunga itu mulai berbunga di M+1.
- **Anggota keluar.** Anggota yang hak keluarnya sudah dibayar paling lambat akhir bulan M tidak menerima bunga bulan M maupun koreksi sesudahnya. Anggota yang keluar lewat jalur lama dengan saldo nol juga dilewati.
- **Audit trail** (`bunga_sukarela_rincian`): periode, tarif, metode (saldo harian), jumlah hari, saldo-hari, saldo awal dan akhir, **ruas saldo harian (JSON)**, bruto, PPh, neto, dan waktu proses.
- **Detail anggota**, dalam kartu terpisah tanpa mengubah kartu Simpanan:
  - saldo sukarela;
  - bunga hari ini;
  - bunga bulan berjalan (perkiraan);
  - bunga yang sudah diakru tahun ini;
  - PPh yang dipotong;
  - total bunga yang sudah masuk saldo.
- **Laporan.** Rincian akrual per anggota dapat diekspor (PDF/Excel/CSV). Akun 5-1956 otomatis tampil di LPHU sebagai Beban Usaha; struktur laporan keuangan tidak diubah.
- **Migrasi v78 aditif.** Tabel `bunga_sukarela_kebijakan`, `bunga_sukarela_proses`, `bunga_sukarela_rincian`, `kebijakan_basis_jasa_modal`, dan kolom snapshot SHU. Baris SHU lama diisi snapshot 1 (cara hitung lama). Akun dan pemetaan disiapkan blok self-heal COA. Reset Data: dua tabel kebijakan dipertahankan, dua tabel transaksi dikosongkan.

## Audit diff
- **Tidak berubah:** AccountingEngine, AccountMapping, SimpananService, PinjamanService, layanan Simpanan Berjangka, PajakService, PphPotongService, pajakPolicy, KeluarAnggotaService, ShuCalculator, FinancialReports.
- **ShuService:** hanya filter jenis simpanan pada basis jasa modal, yang membaca snapshot tahun buku.
- **Diekspor untuk tes:** `getBasisAnggotaSHU` (perilakunya tidak berubah).

## Verifikasi
- `BungaSimpananSukarela.test.ts`: 29/29 skenario lolos, mencakup:
  - ON/OFF, saldo tetap, setor dan tarik di tengah bulan, beberapa mutasi, saldo nol/negatif, kabisat;
  - re-run idempoten, perubahan tarif berlaku periode berikutnya, beberapa jenis simpanan, bunga masuk saldo, PPh;
  - koreksi transaksi bertanggal mundur dan pembatalan, anggota keluar, batal dan akru ulang, mode otomatis, detail anggota;
  - basis jasa modal OFF/ON, snapshot per tahun buku, versi per tahun, migrasi instalasi lama, registri.
- **Suite penuh (harness):** tidak ada regresi. Penjaga versi skema diperbarui ke v78, dan Reset Data mengklasifikasi tabel baru. Kegagalan yang tersisa identik dengan baseline.
- **Typecheck:** tidak ada error baru selain kelas "tipe pustaka tidak tersedia" tanpa `node_modules`.

## Catatan terbuka
- Bunga bulan saat anggota keluar tidak dikreditkan (rekening sudah ditutup). Bila koperasi ingin membayarnya saat penyelesaian hak keluar, perlu integrasi ke alur Keluar Anggota.
- Bukti potong untuk baris KOREKSI dicatat dengan nilai selisih (bisa negatif) pada masa bunga aslinya, sehingga total per masa tetap benar.
- Apakah batas Rp240.000 untuk PPh digabung lintas produk perlu dikonfirmasi ke konsultan pajak. Sesuai arahan, mesin pajak existing tidak diubah.

---

# Hotfix — Snapshot Basis Jasa Modal: DRAFT tidak dikunci migrasi v78

**Masalah.** Migrasi v78 mengunci SEMUA baris `shu_konfigurasi` lama menjadi ON, termasuk yang masih DRAFT dan belum pernah dihitung. Akibatnya:
- desain "snapshot dikunci saat SHU pertama kali dihitung" dilanggar;
- `tahunMinimumVersiBaru()` ikut terdorong ke tahun berikutnya, sehingga koperasi lama tidak bisa mengubah kebijakan untuk tahun buku berjalan yang SHU-nya belum dihitung.

**Query migrasi — sebelum:**
```sql
UPDATE shu_konfigurasi SET sukarela_basis_jasa_modal = 1 WHERE sukarela_basis_jasa_modal IS NULL
```
**Sesudah:**
```sql
UPDATE shu_konfigurasi SET sukarela_basis_jasa_modal = 1
 WHERE sukarela_basis_jasa_modal IS NULL
   AND (status <> 'DRAFT'
        OR total_shu IS NOT NULL
        OR shu_informasi_rat IS NOT NULL
        OR shu_diajukan_rat IS NOT NULL
        OR shu_disahkan_rat IS NOT NULL
        OR journal_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM shu_anggota sa WHERE sa.shu_konfigurasi_id = shu_konfigurasi.id))
```

**Aturan deteksi "tahun buku sudah pernah dihitung".** Cukup salah satu bukti berikut:
- status bukan DRAFT;
- `total_shu` atau `shu_anggota` masih ada;
- `shu_informasi_rat`, `shu_diajukan_rat`, `shu_disahkan_rat`, atau `journal_id` terisi.

Keempat kolom terakhir **tidak dikosongkan** oleh `simpanKonfigurasiShu`, padahal fungsi itu mengembalikan status ke DRAFT serta menghapus `total_shu` dan `shu_anggota`. `hitungSHU` selalu menulis `shu_informasi_rat`. Karena itu tahun yang pernah dihitung lalu konfigurasinya disimpan ulang tetap terdeteksi sebagai sudah dihitung.

**Batasan.** Baris DRAFT hasil simpan ulang dari versi aplikasi sebelum kolom RAT itu ada tidak meninggalkan bukti. Baris seperti itu diperlakukan sebagai belum dihitung. Kebijakan global instalasi lama tetap ON, jadi hasilnya sama dengan perilaku lama, kecuali pengurus sengaja mengubah kebijakan untuk tahun itu.

**ShuService: tidak perlu diubah.** Titik inisialisasinya, `tentukanSnapshotBasisJasaModal(db, konfigurasi)`, dipanggil saat `hitungSHU` dan pengesahan RAT. Fungsi itu sudah memperlakukan NULL sebagai "belum ditentukan", membaca kebijakan yang berlaku, lalu menyimpan snapshot permanen. Pemanggilan berikutnya selalu memakai snapshot. `simpanKonfigurasiShu` tidak menyentuh kolom snapshot. Ketiga perilaku ini dikunci dengan tes.

**File yang berubah**
- `src/database/db.ts`: query di `migrasiV78` beserta komentarnya.
- `src/__tests__/SnapshotBasisJasaModalDraftV78.test.ts` (baru, 11 tes):
  - DRAFT lama tetap NULL setelah migrasi;
  - setiap jenis bukti "sudah dihitung" tetap ON, termasuk DRAFT hasil simpan ulang dan DRAFT yang masih punya `shu_anggota`;
  - migrasi idempoten dan tidak mengubah kolom lain;
  - kebijakan tahun berjalan masih bisa diubah selama tahun itu DRAFT;
  - DRAFT yang dihitung dengan kebijakan OFF menghasilkan snapshot OFF, dan mengubah kebijakan global menjadi ON sesudahnya tidak mengubahnya;
  - tahun lain yang belum dihitung memakai kebijakan barunya;
  - tahun lama yang sudah dihitung tetap ON;
  - instalasi baru default OFF;
  - penjaga titik integrasi ShuService.
- `src/__tests__/BungaSimpananSukarela.test.ts`: satu tes migrasi yang menguji snapshot ini secara langsung. Baris contohnya kini berstatus DIHITUNG, karena DRAFT memang tidak lagi dikunci.

**Bukti tidak ada perubahan lain.** File berikut tidak berubah: `BungaSimpananSukarela.ts`, `BungaSukarelaService.ts`, `KebijakanBasisJasaModalService.ts`, `ShuService.ts`, `SimpananService.ts`, `PinjamanService.ts`, `AccountingEngine.ts`, `pajakPolicy.ts`, `PajakService.ts`, `PphPotongService.ts`, layanan Simpanan Berjangka, `FinancialReports.ts`, `ReportTableBuilders.ts`, dan `schema.ts`.

**Verifikasi**
- `SnapshotBasisJasaModalDraftV78`: 11/11 lolos.
- `BungaSimpananSukarela`: 29/29 lolos.
- `ShuService`: 43/43 lolos.
- Suite penuh 326 suite (harness): tidak ada regresi.
- Typecheck: tidak ada error baru di kode sumber.

---

# Lanjutan 7 — Panduan Aplikasi (slide bergambar) & Panduan Bunga Simpanan Sukarela

## Yang ditambahkan

**1. Panduan Aplikasi (8 slide).**
- Tampil otomatis **sekali** di Dashboard setelah setup administrasi selesai, dan dapat dibuka lagi kapan saja dari kartu **"Panduan Aplikasi"** di Dashboard.
- Isi slide berurutan: sambutan, Dashboard, Data Anggota, Transaksi & Riwayat, Penyesuaian akhir periode, Laporan & Export (Juklat/Standar), Pengaturan & Backup, Tiga Langkah Pertama.
- Instalasi yang sudah berjalan tidak dipaksa melihat panduan, tetapi bisa membukanya dari kartu yang sama.

**2. Menu Transaksi › Penyesuaian › Bunga Simpanan Sukarela — tab baru "Panduan".**
- Isi tertulis:
  - penjelasan fitur;
  - rumus beserta contoh angka;
  - empat langkah penggunaan, dengan tombol langsung ke Kebijakan;
  - enam pertanyaan umum: koreksi transaksi mundur, pembatalan, perubahan tarif, pajak, anggota keluar, dan jasa modal SHU.
- Banner menuju **panduan bergambar (6 slide)**.
- Bila kebijakan belum pernah diatur, layar langsung terbuka di tab Panduan.

**3. Gambar UI aplikasi.**
- Ilustrasi digambar dengan komponen React Native: bingkai ponsel mini yang meniru layar KOPKU (header hijau, kartu, tab bar, tabel laporan bergaris, lembar export).
- Tidak memakai file gambar, sehingga tetap tajam dan selalu sesuai warna aplikasi.
- Elemen yang sedang dijelaskan diberi **sorotan kuning berdenyut**.

**4. Animasi** (React Native `Animated`, native driver, tanpa pustaka tambahan):
- geser berhalaman;
- ilustrasi membesar dan memudar masuk;
- teks bergerak paralaks;
- titik indikator melebar;
- tombol Lewati / Kembali / Lanjut / Mulai.

## File
- **Baru:**
  - `src/config/panduanAplikasi.ts` (isi panduan, data murni);
  - `src/components/panduan/IlustrasiUi.tsx` (14 ilustrasi UI);
  - `src/components/panduan/PanduanSlide.tsx` (slide beranimasi);
  - `src/services/PanduanService.ts` (penanda di `app_config`, tanpa tabel baru);
  - `src/__tests__/PanduanAplikasi.test.ts` (10 tes).
- **Diubah:**
  - `SetupWizardScreen.tsx`: menandai panduan perlu tampil setelah `setupKoperasi`; kegagalan menandai tidak menggagalkan setup.
  - `DashboardScreen.tsx`: kartu Panduan dan modal slide.
  - `BungaSimpananSukarelaScreen.tsx`: tab Panduan dan slide.
  - `PenyesuaianScreen.tsx`: teks menu.
- Tidak ada perubahan pada service akuntansi, jurnal, pajak, maupun skema database.

## Verifikasi
- `PanduanAplikasi` lolos 10/10:
  - jumlah slide sesuai teks kartu dan banner;
  - setiap slide punya ilustrasi yang benar-benar digambar;
  - contoh angka sama dengan mesin bunga (Rp31.000);
  - siklus penanda tampil sekali;
  - urutan pemasangan di setup;
  - kartu dan modal Dashboard;
  - tab Panduan;
  - animasi native driver.
- Suite penuh (327 suite, harness): tidak ada regresi.
- Typecheck: satu kesalahan sintaks tertangkap dan diperbaiki. Sisanya hanya deklarasi tipe React Native yang tidak tersedia di lingkungan uji.
- **Belum diverifikasi di perangkat:** tampilan dan kehalusan animasi perlu dicek langsung di HP.

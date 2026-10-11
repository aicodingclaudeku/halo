# RC-S128 — Simpanan Berjangka: Kebijakan Produk, Bunga Pasca Jatuh Tempo, Bukti Penempatan & Pencairan

Baseline: KOPKU-terbaru18-RC-S127. Prinsip: audit-first, aditif, backward-compatible.
Aturan lengkap: `src/ATURAN_BISNIS.md` §19.C.

## 1. Temuan audit (sebelum coding)

| Area | Yang sudah ada | Keputusan |
|---|---|---|
| `SimpananBerjangkaTenor.ts` | `tambahBulanKalender` = satu-satunya aritmetika bulan | Dipakai juga untuk periode pasca jatuh tempo (tidak disalin). |
| `SimpananBerjangkaBunga.ts` | Bunga kontrak pokok×rate×tenor/12, residu di periode terakhir | Tidak diubah; ditambah generator periode pasca jatuh tempo di modul yang sama. |
| `simpanan_berjangka_bunga` | Tabel event + UNIQUE(kontrak, nomor_periode) | Dipakai juga untuk periode pasca jatuh tempo (+ `jenis_periode`, `rate_persen`). |
| §B `prosesTransferBungaKeSukarelaPadaDb` | Satu-satunya pemindahan bunga, fakta dari jurnal | Tetap satu-satunya; tidak ada tabel transfer kedua. |
| `SimpananBerjangkaCatchUpService` + background task | Satu pintu untuk startup/foreground/background | Tidak diubah; kandidat akrual diperluas di lifecycle. |
| Kebijakan penarikan dini | Pola kebijakan berversi | Dicontoh untuk kebijakan produk. |
| Dokumen pinjaman | `DokumenKontrakHtml`, `cetakDokumenKontrakPdf`, resolver pengurus | Dipakai ulang; engine PDF tidak diganti. |

Bug yang ditemukan dan diperbaiki dalam lingkup ini:
1. `getTotalUtangBungaBerjangkaPadaDb` menjumlah SEMUA debit jurnal transfer. Sejak PPh agregat RC-S127 jurnal itu bisa memuat debit 2-1200/2-1901, sehingga rekonsiliasi 2-1710 bisa meleset. Kini hanya debit akun utang bunga yang dihitung.
2. `getRingkasanPencairan` menampilkan `pokok + seluruh bunga terakru`, padahal bunga yang sudah di Simpanan Sukarela tidak dibayar lagi. Inilah sumber kebingungan di layar Tarik.
3. Bukti Tarik Berjangka menghitung bunga sebagai `total debit − pokok`, salah bila jurnal memuat debit PPh. Kini memakai debit akun Utang Bunga.
4. Baris TARIK hasil pemindahan bunga dengan neto negatif (RC-S127) tampil sebagai "penarikan anggota" di Bukti Tarik. Kini disaring.

## 2. Migration — v79 (`migrasiV79`, SCHEMA_VERSION 78 → 79)

Aditif dan idempoten. ADD COLUMN diperiksa lewat `PRAGMA table_info` lalu dijalankan tanpa try/catch, sehingga error DDL sungguhan gagal keras.
- Tabel baru `simpanan_berjangka_kebijakan_produk`. Berversi dan append-only (trigger: tidak bisa diedit atau dihapus; status hanya AKTIF→DICABUT), dengan satu kebijakan AKTIF per tanggal berlaku. **Kosong** pada instalasi baru maupun upgrade.
- Tabel baru `simpanan_berjangka_penerapan_kebijakan`, catatan penerapan kebijakan ke kontrak lama. Tidak bisa diubah; hanya terhapus lewat Reset Data bersama kontraknya.
- `simpanan_berjangka` + kolom snapshot `policy_*` dan `status_policy` (DEFAULT `LEGACY_POLICY_REVIEW_REQUIRED`).
- `simpanan_berjangka_bunga` + `jenis_periode` (DEFAULT `KONTRAK`) dan `rate_persen`. Baris lama diisi dari `suku_bunga` kontraknya.
- Trigger penjaga:
  - snapshot kontrak tidak bisa diubah;
  - kontrak hanya bisa memakai kebijakan AKTIF;
  - **pokok kontrak tidak bisa diubah**.
- Tidak ada perubahan COA atau mapping. Akrual pasca jatuh tempo memakai mapping akrual yang sudah ada (5-1955/2-1710).
- Reset Data: tabel kebijakan **dipertahankan**; tabel penerapan **dihapus** sebelum kontrak.

## 3. Kebijakan yang tersedia

Field per versi: `id`, `versi`, `berlaku_mulai`, `status`, `auto_renewal`, `bunga_pasca_jatuh_tempo_aktif`, `rate_pasca_jatuh_tempo`, `basis_rate` (TAHUNAN), `metode_periode` (BULAN_KALENDER), `bunga_dikreditkan_ke` (SIMPANAN_SUKARELA), `kapitalisasi_bunga` (0), `pokok_tetap_di_berjangka` (1), `dasar_penetapan`, `ditetapkan_oleh`, `ditetapkan_pada`, `catatan`, `created_by`, `created_at`, serta jejak pencabutan.

Rekomendasi KOPKU dipakai sebagai **isian awal form**, bukan nilai berlaku: AUTO_RENEWAL=FALSE, POST_MATURITY_INTEREST=ENABLED, INTEREST_CREDIT_DESTINATION=SIMPANAN_SUKARELA, PRINCIPAL_REMAINS_IN_TERM_SAVINGS=TRUE, INTEREST_IS_CAPITALIZED_TO_PRINCIPAL=FALSE.

## 4. Asumsi yang sengaja TIDAK di-hard-code

- **Rate pasca jatuh tempo**: tidak ada angka bawaan di kode, migrasi, maupun form. Wajib diisi pengurus.
- **Kebijakan bawaan**: tidak ada. Tanpa kebijakan yang berlaku, penempatan baru ditolak dengan pesan yang menunjuk layar kebijakan.
- **Perpanjangan otomatis**: `auto_renewal = TRUE` **ditolak**, bukan diterima lalu diabaikan, karena mesin perpanjangan belum ada.
- **Prorata periode parsial**: tidak didukung. Periode yang belum genap satu bulan kalender tidak diakui, dan alasannya dicetak di Bukti Pencairan.
- **Bunga pasca jatuh tempo untuk kontrak lama**: tidak ada backfill dan tidak ada rate karangan. Hanya berlaku lewat penerapan eksplisit yang tercatat, mulai tanggal efektif.
- Rate kontrak tetap kolom `suku_bunga` (sudah snapshot sejak awal). Tidak diduplikasi ke kolom baru; diekspos sebagai `rateKontrak` di tipe baris.

## 5. File

Baru:
- `src/accounting/SimpananBerjangkaKebijakanProduk.ts` — policy layer murni.
- `src/services/SimpananBerjangkaKebijakanProdukService.ts` — simpan versi, cabut, pemilihan per tanggal, penerapan ke kontrak lama.
- `src/services/SimpananBerjangkaDokumenService.ts` — data PDF dari kontrak tersimpan.
- `src/export/SimpananBerjangkaDokumenBuilder.ts` — HTML murni BUKTI PENEMPATAN / BUKTI PENCAIRAN.
- `src/screens/Simpanan/KebijakanProdukBerjangkaScreen.tsx` — layar kebijakan.

Diubah:
- `database/schema.ts`, `database/db.ts` — v79.
- `accounting/SimpananBerjangkaBunga.ts` — `periodePascaJatuhTempoEarned`, `periodePascaJatuhTempoBerikutnya`, `hitungBungaPascaJatuhTempoSatuPeriode`.
- `services/SimpananBerjangkaService.ts` — snapshot saat penempatan.
- `services/SimpananBerjangkaLifecycleService.ts`:
  - akrual pasca jatuh tempo;
  - pencairan: pokok ke anggota, bunga ke Sukarela;
  - guard tanggal mundur;
  - status/rincian periode;
  - `getRincianBungaKontrak`;
  - perbaikan rekonsiliasi.
- `services/BuktiTransaksiService.ts` — perbaikan bukti tarik.
- `services/ExportService.ts` — `exportDokumenHtmlPdf`, pembungkus jalur cetak yang ada.
- `services/ResetDataPlan.ts` — klasifikasi dua tabel baru.
- `utils/tarikSimpananUi.ts` — konfirmasi "pokok saja".
- Layar: `SimpananFormScreen` (info kebijakan, cetak), `SimpananBerjangkaDetailScreen` (rincian bunga, kebijakan, tombol cetak), `TarikSimpananFormScreen` (panel pokok saja).
- `navigation/RootNavigator.tsx` — rute `KebijakanProdukBerjangka`.
- `ATURAN_BISNIS.md` — §19.C.

## 6. Test

Baru (37 test, semua lulus):
- `SimpananBerjangkaPascaJatuhTempoRcS128.test.ts` (24):
  - Skenario wajib: Rp10 jt, 15 Juli 2026, tenor 6, jatuh tempo 15 Januari 2027. Bunga kontrak 6×50.000 hanya sampai akhir tenor, lalu periode pasca 4% muncul.
  - Catch-up 20 Agustus 2027: 7 periode sekali dan berurutan; scheduler diulang tanpa duplikasi.
  - Bunga ke Sukarela dengan jurnal Dr 2-1710 / Cr 2-1200; pencairan hanya pokok.
  - auto_renewal FALSE tidak membuat kontrak baru; pokok tidak bisa bertambah.
  - Snapshot tidak berubah oleh kebijakan baru; kalender konsisten (31 Agu→28 Feb→31 Mar).
  - PPh agregat lintas produk dan bukti potong 0%.
  - Subledger Sukarela = 2-1200, 2-1710 = subledger utang bunga, rekonsiliasi pokok & bunga variance 0.
  - Kontrak legacy: tanpa backfill; penerapan eksplisit; jalur lama tidak berubah.
  - Trigger append-only; Reset Data tetap berjalan.
- `MigrationV79KebijakanBerjangka.test.ts` (4): v78 → v79 pada database v78 berisi data. Data utuh, idempoten, trigger aktif, struktur sama dengan instalasi baru.
- `SimpananBerjangkaDokumenRcS128.test.ts` (4): isi kedua PDF, termasuk nama Ketua dari resolver pengurus dan total kas = GL. Juga dirender ke PDF (Chromium) dan diperiksa visual.
- `SimpananBerjangkaUiRcS128.test.ts` (5).

Test lama yang disesuaikan, dan alasannya:
- 13 fixture menanam satu kebijakan (`seedKebijakanProdukUji`, tanpa bunga pasca, sehingga perilakunya sama dengan sebelum RC-S128).
- 7 suite yang mengunci "bunga dibayar tunai saat pencairan" diubah ke aturan baru "pokok ke anggota, bunga ke Sukarela". Maksud aslinya tetap diuji: tidak ada pembayaran ganda, 2-1710 kembali nol, dan aturan PPh per bulan PP 15/2009.
- Penguncian SCHEMA_VERSION dan ambang versi digeser ke v79/v80 sesuai konvensi proyek.
- `UiInputStandardization` 96→104: 8 input baru, semuanya `FocusTextInput`.
- `EarlyWithdrawalAudit` 1 regex: kolom `policy_*` bukan rate penarikan dini.

Regresi penuh (341 file, ±6.460 test, 10 batch):
- Suite yang gagal: MigrationV18/V24/V25, FullMigration, ImbalHasilTetap, KontrolAkhir, PendapatanKoperasi, PendapatanBungaCoa, PolicyRegister, ReleaseHardening, TemporalIntegrity, dan SimpananDetailScreen.
- Seluruhnya **identik per nama test dengan baseline RC-S127**. Tidak ada regresi baru.
- Selama regresi, 9 kegagalan baru sempat muncul akibat RC-S128 dan semuanya sudah diperbaiki: invarian keyboard/modal, label lama layar detail, Reset Data, ambang versi, serta trigger yang rapuh terhadap `ALTER TABLE RENAME` di MigrationV51/V52.
- `tsc --noEmit` bersih.

Static audit:
- Tidak ada INSERT jurnal langsung; semua lewat `createJournal`.
- Tidak ada aritmetika tanggal di luar `SimpananBerjangkaTenor`, dan tidak ada rumus bunga di layar.
- Tidak ada `setTimeout`/`setInterval`, impor EIR, rate pasca yang di-hard-code, perpanjangan otomatis tersembunyi, maupun PPh di luar mesin pajak.

## 7. Yang sengaja TIDAK disentuh

Engine akuntansi (`AccountingEngine`, `AccountMapping`), mesin pajak (`pajakPolicy`, `PphPotongService`, `PajakService`), Simpanan Pokok/Wajib/Sukarela (termasuk `BungaSukarelaService`), Pinjaman/EIR, SHU, laporan SAK EP, COA, lisensi, penarikan dini (`SimpananBerjangkaEarlyWithdrawalService` dan kebijakannya), `SimpananBerjangkaCatchUpService`, dan `SimpananBerjangkaBackgroundTask`.

## 8. Catatan untuk go-live

1. Setelah update, pengurus **wajib** menetapkan kebijakan produk pertama (Simpanan › form Simpanan Berjangka › "Buka Kebijakan Produk") sebelum ada penempatan baru.
2. Tinjau daftar "Kontrak lama perlu ditinjau". Kontrak lama tetap berjalan seperti sebelumnya sampai ada keputusan.
3. Isi data pengurus (Ketua) agar namanya tercetak di bukti; bila kosong, dicetak garis titik-titik.
4. Angka resmi: `npm run typecheck && npm test` di mesin pengembang.

# RC-S93 — Kebijakan Tunggal Bunga Simpanan Sukarela

## Tujuan

Pengurus hanya mengatur **satu** kebijakan: **Bunga Simpanan Sukarela ON/OFF**.
Toggle terpisah "Simpanan Sukarela sebagai Basis Jasa Modal SHU" dihapus dari UI.
Perlakuan Simpanan Sukarela dalam basis jasa modal SHU ditentukan otomatis oleh
sistem dan tetap disimpan sebagai snapshot per tahun buku (audit-able).

## Aturan final

| Bunga Simpanan Sukarela (tahun buku T) | Perlakuan SHU T (sebelum dikunci) |
|---|---|
| ON pada salah satu bulan tahun buku T | Sukarela **tidak** diperhitungkan sebagai basis jasa modal |
| OFF sepanjang tahun buku T | **Mengikuti kebijakan pembagian SHU koperasi yang sudah ada** (tidak dipaksa ikut) |

- "Kebijakan SHU koperasi yang sudah ada" = data `kebijakan_basis_jasa_modal`
  yang sudah tersimpan (instalasi lama: versi migrasi v78 "ikut"; instalasi baru:
  tanpa versi = pokok + wajib saja). Data ini **tidak dihapus**, hanya tidak lagi
  diatur dari layar bunga.
- Rentang tahun buku diambil dari `accounting_period`; bila belum ada, Januari–Desember.
- Saat SHU tahun buku T pertama kali dihitung, hasil turunan dikunci ke
  `shu_konfigurasi.sukarela_basis_jasa_modal`. Setelah itu perubahan kebijakan
  apa pun tidak mengubah tahun buku tersebut.
- Pilihan "salah satu bulan" dipilih supaya tidak ada imbal ganda (bunga harian
  **dan** jasa modal atas saldo yang sama) dalam satu tahun buku.

## File yang diubah

| File | Perubahan |
|---|---|
| `src/services/KebijakanBasisJasaModalService.ts` | Aturan turunan (`turunkanSukarelaIkutBasis`, `bungaAktifDalamRentang`), `getSukarelaIkutJasaModalTahun` kini membaca kebijakan bunga, `getPerlakuanShuSukarela` + teks read-only untuk UI. `simpanVersiBasisJasaModal` ditandai `@deprecated` (tidak ada pemanggil UI). |
| `src/services/BungaSukarelaService.ts` | Perbaikan: bulan **belum** diakru pada hari terakhirnya (`akhirBulan < hariIni`), sesuai aturan "jangan mengakru bulan berjalan". Rumus, jurnal, pajak tidak berubah. |
| `src/screens/Simpanan/BungaSimpananSukarelaScreen.tsx` | Tab Kebijakan disusun ulang: header, satu toggle, tarif tahunan (read-only saat OFF, nilai lama tetap tampil), metode Saldo Harian (read-only), berlaku mulai, konsekuensi SHU (read-only), status periode akrual, ringkasan kebijakan aktif, histori (bulan, status, tarif, waktu perubahan). Kartu basis jasa modal dihapus. Panduan tertulis diperbarui. Perbaikan type error lama `koperasi.alamat` (properti tidak ada di store; nilainya selalu kosong). |
| `src/config/panduanAplikasi.ts` | Slide panduan bunga diperbarui (satu kebijakan, akrual setelah bulan selesai, perlakuan SHU otomatis); teks threshold PPh yang di-hardcode diganti rujukan ke mesin pajak. |
| `src/components/panduan/IlustrasiUi.tsx` | Ilustrasi slide: label toggle baru + metode Saldo Harian; ilustrasi jasa modal tanpa saklar, diganti keterangan ON/OFF. |
| `src/__tests__/BungaSimpananSukarela.test.ts` | Mock `@/database/db` memakai `requireActual` (sebelumnya test migrasi v78 gagal dengan TypeError). Satu test snapshot disesuaikan ke aturan baru. |
| `src/__tests__/BungaSukarelaKebijakanTunggal.test.ts` | Baru: 28 test, mencakup 23 butir checklist. |

## Migration

Tidak ada migration baru. Migration v78 yang sudah ada dipakai apa adanya:
tahun buku yang sudah pernah dihitung tetap terkunci "ikut"; DRAFT yang belum
pernah dihitung tetap `NULL` dan baru dikunci saat perhitungan SHU pertama.
Kolom `sukarela_basis_jasa_modal` dan tabel `kebijakan_basis_jasa_modal`
dipertahankan untuk kompatibilitas.

## Code path

- **Dinonaktifkan dari UI:** `simpanVersiBasisJasaModal`, `tahunMinimumVersiBaru`,
  `listVersiBasisJasaModal`, `basisJasaModalUntukTahun` (tidak lagi diimpor layar
  mana pun). Fungsi tetap ada untuk data lama dan pengujian.
- **Sumber kebenaran status bunga:** `bunga_sukarela_kebijakan`
  (`listVersiKebijakanBunga` / `kebijakanUntukBulan`).
- **Sumber kebenaran perlakuan SHU:** `getSukarelaIkutJasaModalTahun` (turunan) →
  dikunci oleh `tentukanSnapshotBasisJasaModal` (dua titik pemanggilan di
  `ShuService` tidak berubah).

## Bukti tidak ada perubahan engine lain

Tidak ada perubahan pada: formula bunga (`src/accounting/BungaSimpananSukarela.ts`),
AccountingEngine, AccountMapping, COA default, `pajakPolicy`, `PphPotongService`,
`PajakService`, `ShuService`, schema, migration, Simpanan Pokok/Wajib/Berjangka,
Pinjaman/EIR, laporan keuangan, export. Lihat `git diff --stat`: hanya 6 file
sumber + 1 test baru.

## Hasil uji

- `tsc --noEmit`: bersih (0 error; sebelumnya 1 error lama di layar ini).
- Suite terkait: `BungaSukarelaKebijakanTunggal` 28/28, `BungaSimpananSukarela`
  29/29 (sebelumnya 1 gagal karena mock), `SnapshotBasisJasaModalDraftV78` 11/11.
- Regresi hari terakhir bulan dibuktikan: test (7) gagal pada kode lama, lulus pada kode baru.
- `PanduanAplikasi`: 10/10 (teks slide disesuaikan agar tetap menyebut "bulan berikutnya").
- Full suite: 317/328 suite lulus. 11 suite yang gagal (17 test) **sudah gagal
  sebelum patch ini** dengan daftar test yang identik (dibandingkan pada kode
  asli vs kode patch): FullMigration, ImbalHasilTetapRcS67_6, KontrolAkhirRcS53,
  MigrationV18, MigrationV24, MigrationV25, PendapatanBungaCoaRcS70_6,
  PendapatanKoperasiRcS67, PolicyRegisterRcS53, ReleaseHardeningRcS57,
  TemporalIntegrityRcS58. Tidak ada regresi baru.

## Keputusan bisnis yang dicatat (tidak diubah dalam patch ini)

1. **Anggota keluar:** aturan existing dipertahankan — anggota yang hak keluarnya
   sudah dibayar paling lambat akhir bulan M tidak menerima bunga bulan M maupun
   koreksi sesudahnya; anggota KELUAR jalur lama dengan saldo nol dilewati. Ini
   aturan hardcoded di `BungaSukarelaService` dan dapat dikembangkan menjadi
   kebijakan tersendiri (mis. bunga pro-rata sampai tanggal keluar).
2. **Pengaturan basis jasa modal saat bunga OFF:** karena toggle dihapus, nilai
   kebijakan SHU koperasi kini tetap seperti yang tersimpan. Bila AD/ART berubah
   dan koperasi perlu memasukkan/mengeluarkan sukarela saat bunga OFF, tempat
   yang tepat adalah modul SHU (Konfigurasi SHU), bukan layar bunga.
3. Teks di `ShuAnggotaDetailScreen` masih menyebut basis "pokok+wajib+sukarela"
   (sudah tidak akurat sejak v78). Tidak diubah karena di luar cakupan; disarankan
   diperbaiki pada patch modul SHU.

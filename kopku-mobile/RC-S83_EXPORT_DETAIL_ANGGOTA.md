# RC-S83 — Export Detail Anggota: Simpanan Berjangka + Dokumen Profesional

## 1. Permintaan
Export pada layar Detail Anggota (1) tidak memuat Simpanan Berjangka, (2) tampilannya kurang profesional/rapi.

## 2. Analisis akar masalah
| # | Temuan | Lokasi |
|---|--------|--------|
| 1 | `buildAnggotaDetailExport()` tidak pernah menerima data simpanan berjangka. Kartu berjangka dirender dari state `berjangka`/`periodeBunga`, tetapi state itu tidak diteruskan ke tombol Export. | `AnggotaDetailScreen.tsx`, `ReportTableBuilders.ts` |
| 2 | Detail Anggota memakai template tabel generik (`buildReportHtml`): satu tabel histori, lalu identitas, simpanan, dan pinjaman dicampur dalam satu daftar label di bawah. Tanggal ISO mentah, kode enum mentah (`SETOR`, `Simpanan WAJIB`), dan kertas default (Letter di iOS). | `HtmlReportBuilder.ts`, `ExportService.ts` |

## 3. Perubahan (seluruhnya additive)
- **`ExportTypes.ts`**: field opsional `seksi?: SeksiLaporan[]` (`KV` | `TABEL`) dan `nomorDokumen?`. Laporan yang tidak mengisi `seksi` dirender persis seperti sebelumnya.
- **`ReportTableBuilders.ts`**: `buildAnggotaDetailExport(..., berjangka?)` dengan parameter ke-6 opsional `BerjangkaAnggotaExport { ringkasan, kontrak, periodeBunga }`. Mengisi 7 seksi:
  1. Data Anggota
  2. Simpanan
  3. Simpanan Berjangka
  4. Rincian Kontrak (seluruh kontrak, termasuk DICAIRKAN/DIBATALKAN)
  5. Jadwal Bunga per Periode
  6. Pinjaman
  7. Histori Transaksi (kronologis, bernomor)
- **Struktur datar** (`kolom`/`baris`/`ringkasan`) tetap diisi dengan label yang sama. Ditambah 3 baris berjangka yang diletakkan sesudah "Total Simpanan" dan tidak dijumlahkan ke dalamnya (§22).
- **`periodeLabel`**: sekarang "Per 24 September 2026" (sebelumnya ISO).
- **`DokumenSeksiHtml.ts` (baru)**: template PDF A4 bergaya dokumen kontrak.
  - Kop bergaris ganda dan seksi bernomor; data label/nilai dua kolom (nilai panjang memakai satu baris penuh).
  - Header tabel berulang tiap halaman, baris total di kaki tabel.
  - `@page` menampilkan kode dokumen dan "Halaman X dari Y"; semua teks di-escape.
- **`ExcelSeksiBuilder.ts` (baru)**: susunan sheet murni. Nominal ditulis sebagai angka dengan format `"Rp"#,##0` (bisa dijumlah), lebar kolom otomatis.
- **`CsvExporter.ts` / `ExportService.ts`**: jalur `seksi` untuk CSV dan Excel. PDF berseksi dicetak dengan `UKURAN_A4_PORTRAIT`.
- **`AnggotaDetailScreen.tsx`**: memuat `listSimpananBerjangka(anggotaId)` dan meneruskan `{ ringkasan: berjangka, kontrak, periodeBunga }` ke export. Objek yang sama dengan yang dirender di layar.

Tidak ada formula akuntansi, akun, kueri saldo, atau skema yang diubah. Tidak ada angka turunan baru: nominal pencairan tidak dirakit ulang; kontrak menampilkan pokok, bunga terakru, dan bunga dibayar apa adanya dari subledger.

## 4. Hasil verifikasi (dijalankan, bukan diasumsikan)
| Pemeriksaan | Hasil |
|---|---|
| `tsc --noEmit` | **0 error** |
| Jest penuh (setelah perubahan) | 269 suite: 262 lulus, 7 gagal. 5.097 test: 5.092 lulus, 5 gagal |
| Test baru `DetailAnggotaExportRcS83.test.ts` | 9/9 lulus |
| Test lama ReportTableBuilders / CsvExporter / ExportService | Lulus, tanpa perubahan nilai ekspektasi |
| Render PDF nyata (Chromium, A4) | 3 halaman, tata letak rapi, tanpa overflow |

### Kegagalan yang sudah ada sebelumnya (bukan regresi)
Ke-7 suite dijalankan ulang pada kode asli RC-S82 (git worktree terpisah). Hasilnya **identik**: 5 test gagal plus 2 suite gagal dimuat, dengan daftar kegagalan sama persis (diff kosong). Penyebabnya file dokumen kebijakan yang tidak ada di ZIP yang diunggah, misalnya `POLICY_REGISTER_RC-S53.md` (ENOENT) dan `POLICY_DECISION_RC-S53.md`. Suite yang terdampak:
- PendapatanKoperasiRcS67
- PendapatanBungaCoaRcS70_6
- TemporalIntegrityRcS58
- ReleaseHardeningRcS57
- ImbalHasilTetapRcS67_6
- KontrolAkhirRcS53
- PolicyRegisterRcS53

## 5. Audit statis
- Tidak ada `setTimeout`, toleransi saldo, atau perubahan skema/migrasi.
- Tidak ada test yang dihapus dan tidak ada nilai ekspektasi yang diubah.
- Renderer baru murni (string in, string out); izin `export` tetap diperiksa lewat `exportLaporan()`.

## 6. Keterbatasan tersisa
- **Histori Transaksi** tetap hanya dari `simpanan_transaksi` dan `angsuran_pembayaran` (repository tidak diubah). Setoran dan pencairan berjangka tercantum di Rincian Kontrak.
- **Kalimat penutup PDF** dibuat netral. Blok tanda tangan pengurus sengaja tidak ditambahkan karena itu keputusan kebijakan koperasi. Bila diinginkan, bisa mengikuti pola `SusunanPengurusInti` pada dokumen akad.
- **Render `@page` di perangkat** (Android WebView dan iOS) belum diverifikasi; yang terverifikasi hanya Chromium desktop.
- **Excel**: SheetJS edisi community tidak menulis style (tebal/warna); yang terbawa hanya format angka.


---

# RC-S83.1 — Bagian yang tidak dimiliki anggota tidak ditampilkan

## Permintaan
Jika anggota tidak punya simpanan berjangka, pinjaman, atau simpanan, bagian itu tidak perlu muncul di export.

## Aturan tampil (berlaku sama untuk PDF, Excel, dan CSV)
Kriteria memakai angka yang sudah ada; tidak ada kueri baru.

| Bagian | Ditampilkan bila |
|---|---|
| Simpanan | Setidaknya satu jenis (Pokok/Wajib/Sukarela) saldonya ≠ 0. Jenis bersaldo 0 tidak dicantumkan. |
| Simpanan Berjangka (ringkasan) | Ada kontrak berjalan (`jumlahKontrakAktif > 0`), sama dengan syarat kartu di layar. |
| Rincian Kontrak Simpanan Berjangka | Anggota pernah punya kontrak (termasuk yang sudah dicairkan). |
| Jadwal Bunga per Periode | Ada periode bunga. |
| Pinjaman | Ada pinjaman (aktif atau lunas), angsuran dibayar, sisa pinjaman, atau data kolektibilitas. Pinjaman yang sudah lunas tetap ditampilkan. |

Pelengkap:
- Nomor seksi menyesuaikan otomatis.
- Baris ringkasan datar untuk berjangka juga hanya muncul bila ada kontrak.
- Catatan histori hanya menyebut Rincian Kontrak bila bagian itu memang ada.

## Verifikasi
| Pemeriksaan | Hasil |
|---|---|
| `tsc --noEmit` | 0 error |
| Jest penuh | 269 suite, 5.102 test: 5.097 lulus, 5 gagal. Ke-5 kegagalan identik dengan baseline RC-S82 (dokumen kebijakan tidak ada di ZIP), diff daftar kegagalan kosong. |
| Test baru | 5 test tambahan di `DetailAnggotaExportRcS83.test.ts` (total 14, semua lulus) |
| Render PDF (Chromium) | Anggota tanpa pinjaman dan tanpa berjangka: hanya Data Anggota, Simpanan, dan Histori; 1 halaman. |

## Catatan
- Struktur datar lama (`ringkasan`) untuk Simpanan/Pinjaman tidak difilter, demi kompatibilitas test existing. Struktur ini tidak dipakai renderer bila `seksi` terisi.
- Histori Transaksi tetap selalu tampil. Bila kosong, isinya "Belum ada transaksi."

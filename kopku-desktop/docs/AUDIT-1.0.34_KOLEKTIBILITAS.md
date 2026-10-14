# Audit Menyeluruh Modul Kolektibilitas Pinjaman — KOPKU Desktop 1.0.34 / Source RC-S133.6.11

Tanggal audit: 14-10-2026. Baseline: KOPKU Desktop 1.0.33 = source RC-S133.6.10 (perbaikan usia tunggakan kalender).
Seluruh pengujian memakai fixture / database uji terpisah (sql.js, SQLite sementara). Tidak ada data produksi, migrasi,
perubahan skema (tetap v82), atau jurnal historis yang disentuh.

---

## Peta implementasi (alur data)

```
angsuran_jadwal (pokok, jasa, pokok_terbayar, jasa_terbayar, status, tanggal_jatuh_tempo)   ← ajukan/cairkan/bayarAngsuran,
pinjaman (satuan_tenor, tanggal_jatuh_tempo, penyelesaian_*) · pinjaman_agunan (nilai_agunan)    impor saldo lama (MigrasiPinjamanPlan)
        │  SATU query per tanggal laporan
        ▼
LoanImpairmentService.getKlasifikasiPinjamanAktif(db, {tanggalLaporan, statusAnggota, anggotaId})
   - saldo_pokok / saldo_jasa / saldo_piutang  = Σ baris jadwal bukan-obsolete (termasuk jasa BELUM jatuh tempo)
   - jatuh_tempo_pokok_tertua / jasa_tertua    = baris current, jatuh tempo ≤ tanggal laporan, komponen belum lunas
   - hari_max (julianday)                       = hari tunggakan (tampilan & non-accrual; BUKAN dasar golongan)
   - usia bulan = bulanTunggakanTepat(jatuh tempo, tanggal laporan)  [1.0.33: kalender + pecahan]
   - 1.0.34: angsuranTertunggak, pokokTertunggak, jasaTertunggak, jasaBelumJatuhTempo (tambahan, tampilan)
        ▼
KolektibilitasSomService.klasifikasikanSom()  — SATU-SATUNYA mesin penggolongan (Juklak SOM 3/2025 angka 12.1)
        ▼
hitungCadangan = hitungPenyisihanSom(saldo POKOK, kategori) = roundToRupiah(pokok × % kategori)  (per pinjaman, ½ ke atas)
        ▼
├─ ringkasKualitasPinjaman / getRingkasanAging      → layar & laporan (Σ per pinjaman, tanpa pembulatan ulang)
├─ getKolektibilitasAnggota                        → Detail Anggota, Portal Anggota (kategori terburuk)
├─ KolektibilitasFiskalService                     → batas fiskal PMK 74/2024 (laporan pembanding, tanpa jurnal)
├─ getTotalPenyisihanTarget (SEMUA anggota)        → sesuaikanPenyisihanPiutang: jurnal PSH Dr Beban / Cr 1-1210 sebesar
│                                                     (target − saldo 1-1210 per tanggal) — satu-satunya jalur jurnal
├─ PenurunanNilaiJasaPinjamanService, AkrualJasa…, EirAccounting…, PinjamanService (hapus buku) → memakai kategori yang sama
└─ KolektibilitasPiutangScreen + buildKolektibilitasExport (PDF/Excel/CSV)
NonAccrualPolicy (≥ 90 hari, dapat dikonfigurasi) = kebijakan PENGAKUAN PENDAPATAN terpisah, bukan kategori kolektibilitas.
```

Tidak ditemukan implementasi penggolongan kedua: semua pemanggil (layar, ekspor, detail anggota, portal, akrual, EIR,
penurunan nilai jasa, hapus buku) memakai `getKlasifikasiPinjamanAktif` → `klasifikasikanSom`.

---

## A. Ringkasan hasil audit & status kelayakan

- Penggolongan & cadangan per pinjaman **konsisten** di service, database, ekspor, detail anggota, fiskal, dan jurnal
  (uji 16–17). Lima kasus LAMA direproduksi persis (lihat F).
- **Satu bug terbukti dan diperbaiki (F1):** layar Kolektibilitas Piutang dan ekspornya membandingkan saldo buku besar
  dengan total daftar yang **difilter status anggota** (default Aktif), sedangkan jurnal memakai target **semua anggota**.
- **Satu kekurangan transparansi diperbaiki (F2):** rincian tunggakan (jumlah angsuran, pokok & jasa jatuh tempo, jasa
  belum jatuh tempo) ditambahkan tanpa mengubah angka lain.
- **Satu temuan pada bukti audit:** pembanding independen C5e (audit DAMY) masih memakai usia "bulan penuh dibulatkan
  ke bawah" sehingga mencatat 6 GAGAL sejak 1.0.33 — tidak terlihat karena Jest tetap hijau. Saya melewatkannya pada
  laporan 1.0.33; kini diperbarui (lihat B-T3).
- **Status kelayakan:** lolos audit TEKNIS untuk konsistensi perhitungan. **Belum** dapat dinyatakan lolos audit
  REGULASI: naskah Juklak SOM 3/2025, PMK 74/2024, dan SAK EP tidak dapat dibuka dari lingkungan ini (lihat C & J), dan
  dua penafsiran (masa angsuran bulanan; arti "melampaui N bulan") perlu konfirmasi pengawas/pengurus.

## B. Temuan, keparahan, bukti, akar masalah

| # | Temuan | Keparahan | Jenis | Status |
|---|---|---|---|---|
| F1 | Selisih penyisihan, kalimat konfirmasi "akan disesuaikan … menjadi Rp X", kartu "Target hasil penggolongan", dan baris ekspor "Penyesuaian penyisihan yang diperlukan" memakai `ringkasan.totalCadangan` dari daftar yang difilter (`statusAnggota` default `AKTIF`), padahal `sesuaikanPenyisihanPiutang` membukukan `getTotalPenyisihanTarget` (statusAnggota `SEMUA`). | Sedang (angka yang dijanjikan ≠ jurnal; selisih tidak pernah nol bila ada anggota nonaktif bermasalah) | Bug kode (UI/ekspor) | Diperbaiki |
| F2 | `saldoPiutang`/`saldoJasa` memuat jasa jadwal yang belum jatuh tempo; item tidak menyebut jumlah angsuran tertunggak / pokok & jasa yang sudah jatuh tempo. | Rendah (tampilan; cadangan tidak terpengaruh karena basis pokok) | Penyajian | Ditambah field & tampilan |
| T3 | Pembanding independen `audit-damy/C5e` memakai `bulanPenuh` (dibulatkan ke bawah) → 6 kasus GAGAL di catatan audit sejak 1.0.33, Jest tetap lulus. Diuji: dengan usia kalender, 48/48 cocok — perbedaan murni penafsiran usia, bukan bug lain. | Rendah (bukti audit) | Uji | Pembanding diperbarui, ditandai DIPERBARUI |
| I1 | Impor saldo lama mode SISA/LAMA (sisa pokok tidak cocok jadwal akad / tanpa tenor / CUSTOM) menanggalkan angsuran tertunggak **mundur dari tanggal cut-off** (`susunJadwalSisa`), bukan tanggal jatuh tempo buku lama. Usia tunggakan — dan dekat batas, kategorinya — bergantung pada cut-off. | Sedang untuk data impor | Keterbatasan data/desain (template tidak memuat tanggal jatuh tempo tunggakan) | Didokumentasikan + uji 14; tidak diubah |
| I2 | Usia tunggakan kalender (1.0.33): "melampaui 3 bulan" ⇔ tanggal laporan > jatuh tempo + 3 bulan kalender. Sebelum 1.0.33 dibaca "≥ 4 bulan penuh". | — | Penafsiran regulasi | Perlu konfirmasi |
| I3 | Masa angsuran tepat 1 bulan (bulanan) & 4–5 bulan tidak disebut naskah; aplikasi memakai ambang kelompok "2–3 bulan" (3/6 bulan). Kelompok "≥ 6 bulan" tidak pernah terpakai dari satuan tenor (hanya HARI/MINGGU/BULAN). | — | Penafsiran (RC-S92) | Perlu konfirmasi |
| I4 | Pinjaman 91 hari dapat Lancar namun non-accrual (≥ 90 hari): dua kebijakan berbeda (penggolongan vs pengakuan pendapatan). | Info | Desain | Didokumentasikan |
| I5 | Pinjaman dengan pokok 0 tetapi jasa tertunggak digolongkan dari tunggakan jasa, cadangan SOM Rp0 (basis pokok); penurunan nilai piutang jasa ada di menu tersendiri (RC-S133.6.9). | Info | Desain | Didokumentasikan, uji 11 |

Bukti F1 (source RC-S133.6.10): `KolektibilitasPiutangScreen.tsx` — `const [statusAnggota] = useState('AKTIF')`;
`selisihPenyisihan = ringkasan.totalCadangan - saldoTercatat`; `LoanImpairmentService.ts` —
`getTotalPenyisihanTarget(...) { getKlasifikasiPinjamanAktif(db, { tanggalLaporan, statusAnggota: 'SEMUA' }) }`;
`ReportTableBuilders.ts` — `const sel = totalCadangan - opsi.penyisihanTercatat`. Reproduksi: uji 17 (source) dan
"1.0.34 F1" (desktop): sebelum perbaikan ekspor menyatakan "Kurangi …" padahal jurnal sungguhan delta 0.

Kasus LAMA — penjelasan perbedaan status (bukan bug): 86 hari (jatuh tempo 20-07) & 91 hari (15-07) **belum** melampaui
3 bulan kalender pada 14-10 (batasnya 20-10 dan 15-10); 96 hari (10-07) & 101 hari (05-07) **sudah** (batas 10-10 dan
05-10). Hari dipakai hanya untuk tampilan; golongan memakai bulan kalender dari jadwal.

## C. Dasar regulasi / kebijakan akuntansi

| Ketentuan | Dipakai untuk | Status verifikasi di sesi ini |
|---|---|---|
| Petunjuk Pelaksanaan (Juklak/Juklat) Standar Operasional Manajemen KSP/USP — Deputi Bidang Pengawasan Koperasi No. 3 Tahun 2025, angka 12.1 "Kriteria Pinjaman Bermasalah" (hal. 42–43) | Kriteria Kurang Lancar / Diragukan (75% angsuran atau 100% agunan) / Macet (21 bulan; pengadilan/asuransi) | **Belum terkonfirmasi ulang.** Kutipan berasal dari dokumentasi proyek RC-S92 (naskah dibaca pada sesi pengembangan sebelumnya). `jdih.kop.go.id` tidak dapat diakses (koneksi gagal). |
| Juklak SOM 3/2025 angka 15 "Contoh Perhitungan Taksiran Piutang Tak Tertagih" (hal. 86): 0% / 50% / 75% / 100% | Persentase cadangan buku | **Belum terkonfirmasi ulang.** Catatan: angka ini berasal dari **contoh perhitungan**, sehingga sifat normatifnya (wajib vs ilustrasi) perlu dikonfirmasi. Tidak diubah. |
| PMK 74 Tahun 2024 (baris Koperasi Simpan Pinjam): 0,5% / 10% / 50% / 100%, agunan dikurangkan kecuali Lancar | Hanya laporan pembanding fiskal (tanpa jurnal) | **Belum terkonfirmasi ulang** (`jdih.kemenkeu.go.id` tidak dapat diakses). Tidak dipakai sebagai cadangan akuntansi. |
| SAK EP (IAI) — penurunan nilai aset keuangan yang diukur pada biaya perolehan diamortisasi | Dasar umum bahwa cadangan buku adalah estimasi kerugian kredit | **Tidak diverifikasi**; tidak ada paragraf yang dikutip. Aplikasi memakai persentase SOM sebagai kebijakan estimasi; kecukupannya terhadap SAK EP adalah penilaian manajemen/akuntan. |

Tidak ada ambang, persentase, atau aturan penggolongan baru yang ditambahkan.

## D. Berkas & fungsi yang diubah

Source RC-S133.6.11:
- `src/services/LoanImpairmentService.ts` — `KlasifikasiPinjamanItem`: 4 field opsional baru; `getKlasifikasiPinjamanAktif`:
  3 kolom agregat SQL tambahan (+3 parameter tanggal) dan pemetaan field. Penggolongan & cadangan tidak berubah. (F2)
- `src/screens/Laporan/KolektibilitasPiutangScreen.tsx` — membaca `getTotalPenyisihanTarget` (sumber yang sama dengan
  jurnal); selisih, kartu target, kalimat konfirmasi memakai target itu; catatan bila lingkup tampilan berbeda; rincian
  tunggakan per pinjaman; ekspor menerima target. (F1, F2)
- `src/export/ReportTableBuilders.ts` — `OpsiExportKolektibilitas.targetPenyisihanBukuBesar` (opsional; tanpa nilai =
  perilaku lama); baris ringkasan rincian tunggakan. Kolom tabel datar TIDAK berubah. (F1, F2)
- `src/__tests__/KolektibilitasAuditRcS133_6_11.test.ts` — baru, 19 uji (skenario 1–18 + kasus LAMA).
- `src/__tests__/audit-damy/C5e_kolektibilitas.test.ts` — fungsi usia pembanding diperbarui ke kalender (T3).

Desktop 1.0.34:
- `scripts/tambal-kolektibilitas-1.0.34.js` — 11 penggantian berjangkar, idempoten, mensyaratkan tambalan 1.0.33.
- `renderer/.../entry-*.js` — hasil tambalan di atas (modul LoanImpairmentService, ReportTableBuilders, layar).
- `test/kolektibilitas/kolektibilitas.test.js` — +3 uji; `test/smoke-kolektibilitas-chromium.js` — uji UI baru.
- Versi 1.0.34: `package.json`, `package-lock.json`, `installer/kopku-setup.nsi`, `test/lan/baseline-manifest.json`
  (hash bundle/nsi/lock), komentar `test/lan/regresi.test.js`.

## E. Rumus / aturan sebelum & sesudah

- Penggolongan: **tidak berubah** di 1.0.34. (1.0.33: usia = bulan kalender + pecahan; > N = melampaui.)
- Cadangan per pinjaman: **tidak berubah** — `roundToRupiah(saldo pokok × % kategori SOM)`; total = Σ per pinjaman.
- Selisih penyisihan di layar/ekspor: sebelum = `Σ cadangan daftar terfilter − saldo 1-1210`; sesudah =
  `getTotalPenyisihanTarget(tanggal) − saldo 1-1210` = delta yang dibukukan `sesuaikanPenyisihanPiutang`.
- Baru (tampilan): `angsuranTertunggak` = banyaknya baris current jatuh tempo ≤ tanggal laporan yang belum lunas;
  `pokokTertunggak`/`jasaTertunggak` = sisa komponen baris tsb; `jasaBelumJatuhTempo = saldoJasa − jasaTertunggak`.

## F. Lima kasus investigasi (fixture yang mereproduksi angka pemeriksaan; jadwal asli tidak tersedia)

| Pinjaman | Pokok | Jasa | Hari | Jatuh tempo tertua | Sebelum 1.0.33 | 1.0.33 = 1.0.34 | Cadangan 1.0.34 | Angsuran tertunggak / jasa belum JT |
|---|---|---|---|---|---|---|---|---|
| LAMA-001 | 3.480.000 | 540.000 | 86 | 20-07-2026 | Lancar, 0 | Lancar 0% | 0 | 3 / 270.000 |
| LAMA-005 | 2.400.000 | 90.000 | 86 | 20-07-2026 | Lancar, 0 | Lancar 0% | 0 | 3 / 45.000 |
| LAMA-003 | 7.103.767 | 286.980 | 91 | 15-07-2026 | Lancar, 0 | Lancar 0% (KL mulai 16-10) | 0 | 3 / 0 |
| LAMA-002 | 1.000.000 | 30.000 | 96 | 10-07-2026 | Lancar, 0 | Kurang Lancar 50% | 500.000 | 2 / 0 |
| LAMA-004 | 4.000.000 | 240.000 | 101 | 05-07-2026 | Lancar, 0 | Kurang Lancar 50% | 2.000.000 | 4 / 0 |
| **Total** | **17.983.767** | 1.186.980 | | | **0** | | **2.500.000** | |

"Total saldo piutang Rp17.983.767" pada pemeriksaan = Σ saldo **pokok** (kartu "Piutang Pinjaman Outstanding");
Σ saldo piutang (pokok + jasa) = Rp19.170.747, termasuk Rp315.000 jasa yang belum jatuh tempo.

## G. Hasil pengujian

| Uji | Hasil |
|---|---|
| Source: `KolektibilitasAuditRcS133_6_11` (TZ Asia/Jakarta, UTC, America/New_York) | 19/19 ×3 (pada source sebelum perubahan: 8 gagal — F1/F2) |
| Source: suite kolektibilitas/ekspor/migrasi/penurunan nilai terkait (11 suite) | 193/193; C5e 48 LULUS (sebelumnya 42 LULUS / 6 GAGAL) |
| Source: Jest penuh | 6703/6710 lulus; 6 gagal & 22 suite tak termuat **identik** dengan source asli (dokumen kebijakan tidak ada di paket, paket xlsx-js-style/expo-*/react/zustand tidak terpasang) |
| Source: audit DAMY (16 perekam) | identik dengan asli kecuali C5e (kini 48/48); C3 1 GAGAL sudah ada di source asli |
| Source: TypeScript (berkas yang diubah + ujinya) | 319 error sebelum = 319 sesudah (lingkungan: tipe react-native/expo tidak terpasang); 0 error baru |
| Lint | Proyek tidak memiliki skrip/konfigurasi ESLint → tidak dijalankan |
| Desktop: kolektibilitas | 13/13 (pada bundle 1.0.33: 3 uji baru gagal) |
| Desktop: lan / mcp / keamanan | 81/81 · 47/47 · 15/15 |
| Desktop: UI Chromium `smoke-kolektibilitas-chromium` | 5/5 (target Rp6.000.000 = SEMUA; lingkup Aktif Rp3.000.000; rincian tunggakan tampil; tanpa galat) |

## H. Rekonsiliasi

- Σ cadangan per pinjaman = `getTotalPenyisihanTarget` = `ringkasKualitasPinjaman.totalCadangan` = Σ `getRingkasanAging`
  = baris total ekspor (uji 16; termasuk pembulatan 1.000.002 × 50% = 500.001).
- Σ saldo pokok klasifikasi = saldo akun 1-1200 di buku besar; saldo 1-1210 setelah penyesuaian = target; neraca seimbang
  (uji desktop "konsistensi").
- Fiskal & detail anggota memakai kategori/cadangan yang sama per pinjaman (uji 17).

## I. Dampak terhadap jurnal & laporan keuangan

- Tidak ada jurnal otomatis baru, tidak ada perubahan jurnal/saldo historis, tidak ada perubahan skema.
- Jalur jurnal tetap satu: tombol **Sesuaikan Penyisihan** (Dr Beban Penyisihan / Cr 1-1210 sebesar delta, idempoten).
  Yang berubah hanya angka yang DITAMPILKAN sebelum menekan tombol — kini sama dengan jurnal yang akan dibuat.
- Bila koperasi sudah menekan tombol dengan versi lama: jurnal yang dibuat sudah benar (selalu target SEMUA anggota);
  yang keliru hanya angka di layar/ekspor. Tidak perlu koreksi jurnal karena F1.
- Dampak 1.0.33 (usia kalender) terhadap penyisihan: target naik untuk pinjaman 3 bulan + 1…30 hari; dibukukan hanya
  bila pengguna menekan Sesuaikan Penyisihan (buat backup dulu).

## J. Risiko tersisa & rekomendasi

1. Konfirmasi pengawas/pengurus atas penafsiran I2 (melampaui N bulan = kalender) dan I3 (pinjaman bulanan → ambang 3/6
   bulan). Bila berbeda, yang diubah hanya `kelompokMasaAngsuran()` / `bulanTunggakanTepat()`; uji akan menandainya.
2. Verifikasi naskah resmi Juklak SOM 3/2025 (angka 12.1 & 15), PMK 74/2024, dan kebijakan akuntansi SAK EP koperasi;
   khususnya apakah persentase angka 15 normatif atau contoh.
3. Data impor mode SISA/LAMA: periksa tanggal jatuh tempo tunggakan pinjaman impor terhadap kartu angsuran lama; bila
   berbeda, koreksi lewat mekanisme koreksi impor yang ada (bukan ubah massal). Pertimbangkan kolom "jatuh tempo
   tunggakan tertua" pada template (perubahan template, bukan skema).
4. Lingkungan uji: Jest penuh memiliki 6 kegagalan & 22 suite tak termuat yang sudah ada sebelumnya (dokumen/paket tidak
   ada di paket source) — tidak terkait kolektibilitas, tetapi berarti bagian itu tidak terverifikasi di sini.
5. Perekam audit DAMY (`R.uji`) tidak menggagalkan Jest saat GAGAL — sebaiknya dibuat menggagalkan suite.

## K. Cakupan perubahan

Perubahan hanya menyentuh modul kolektibilitas: service klasifikasi (field tambahan), layar Kolektibilitas Piutang,
builder ekspor kolektibilitas, dan uji. Tidak ada perubahan pada pembayaran angsuran, simpanan, kas/bank, jurnal lain,
skema, dependensi, atau versi framework. Bundle desktop: hanya 11 jangkar pada tiga modul tsb; regresi LAN memverifikasi
hash seluruh berkas lain identik.

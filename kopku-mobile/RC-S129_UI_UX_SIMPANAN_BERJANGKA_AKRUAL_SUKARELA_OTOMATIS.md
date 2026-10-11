# RC-S129 — UI/UX Simpanan Berjangka, Pencarian & Filter Daftar, Akrual Bunga Sukarela Otomatis

Baseline: KOPKU-terbaru19-RC-S128. Lingkup: **tampilan dan pemicu otomatis saja**. Tidak ada perubahan skema/migrasi (tetap v79), COA, pemetaan akun, rumus bunga, mesin pajak, atau jurnal.

## 1. Permintaan

1. UI/UX Simpanan Berjangka dirapikan dan dibuat profesional, lengkap dengan penjelasan yang mudah dimengerti.
2. Daftar Simpanan Berjangka diberi pencarian dan filter.
3. Akrual bunga Simpanan Sukarela tidak lagi ditekan manual, tetapi berjalan otomatis.

## 2. Temuan audit (sebelum coding)

| Area | Temuan | Keputusan |
|---|---|---|
| Daftar berjangka | Kartu hanya menampilkan nomor kontrak, tanpa nama anggota. Tidak ada pencarian atau filter. Baris "Total Dicairkan = pokok + bunga dibayar" dihitung di layar, padahal sejak RC-S128 kas yang keluar hanya pokok. | Ditambah fungsi baca `listSimpananBerjangkaDaftar` (JOIN nama & nomor anggota), pencarian dan filter murni di `utils/daftarSimpananBerjangka.ts`, dan baris hitungan di layar dihapus. |
| Detail berjangka | Informasinya lengkap, tetapi aksi (Cairkan) berada di paling bawah dan tidak ada ringkasan status dalam bahasa sehari-hari. | Disusun ulang: kartu utama dengan penunjuk tahap, penjelasan status, aksi di atas, lalu rincian. |
| Form penempatan | Isian sudah benar, tetapi belum memakai pola kartu langkah RC-S122 dan tidak ada ringkasan sebelum simpan. | Jalur BERJANGKA memakai `KartuLangkah`, `RingkasanTransaksi`, `KotakInfo`, `PilihanOpsi`, dan `TombolUtama`. Jalur REGULER tidak diubah susunannya. |
| Bunga Sukarela | Mesin otomatis **sudah ada** (`jalankanAkrualBungaSukarelaOtomatis` di StartupTasks). Masalahnya ada di layar: layar dimuat tanpa menunggu batch latar, sehingga bulan yang sedang diakru tampil sebagai "Akrual berikutnya" dengan tombol "Akru Bunga". Selain itu, bila bulan berganti saat aplikasi tetap terbuka, tidak ada pemicu baru sampai aplikasi dibuka ulang. | Layar sekarang menunggu `tungguTugasStartupSelesai()`. Bila masih ada bulan tertunda, layar memicu koordinator yang sama (`jalankanTugasStartup`) sekali. Tombol manual dihapus. |

## 3. Perubahan

### 3.1 Daftar Simpanan Berjangka — `SimpananBerjangkaHistoriScreen.tsx`
- **Pencarian** (`SearchField`) mencakup nama anggota, nomor anggota, nomor kontrak, keterangan, versi kebijakan, dan nominal. Untuk nominal, ketik awalan angkanya, misalnya `10.000.000`.
- **Filter status**: kotak "Ringkasan Kontrak" (Semua / Belum jatuh tempo / Siap dicairkan / Sudah dicairkan) dapat diketuk. Tautan "Lihat kontrak dibatalkan" muncul bila ada kontrak yang dibatalkan.
- **Saring cepat**: "Jatuh tempo bulan ini" dan "Kontrak lama perlu ditinjau", masing-masing dengan jumlahnya.
- **Urutan**: Terbaru, Jatuh tempo terdekat (kontrak berjalan lebih dulu), atau Pokok terbesar.
- Baris "Menampilkan X dari Y kontrak" dilengkapi tombol **Reset filter**.
- **Kartu kontrak** baru berisi:
  - avatar inisial, nama, nomor anggota, dan nomor kontrak;
  - lencana status berwarna;
  - pokok, serta blok Tenor / Suku bunga / Jatuh tempo;
  - sorotan "Siap dicairkan…" dan "Kontrak lama…";
  - rincian pencairan dini yang bisa dibuka-tutup.
- Bila belum ada kontrak sama sekali, tampil penjelasan "Cara kerja" dan petunjuk tombol +.
- Hitungan per status hanyalah jumlah kontrak, bukan nilai uang.

### 3.2 Detail kontrak — `SimpananBerjangkaDetailScreen.tsx`
- **Kartu utama** memuat nomor kontrak, status, nama anggota, pokok, tenor, suku bunga, dan tanggal jatuh tempo. Di bawahnya ada **penunjuk tahap**: Ditempatkan → Berjalan → Jatuh tempo → Dicairkan, lengkap dengan tanggalnya.
- **Penjelasan status** (`penjelasanKontrak`) menjelaskan dalam satu-dua kalimat apa yang terjadi dan langkah berikutnya, termasuk kasus kontrak lama tanpa kebijakan.
- Aksi **Cairkan** dan **Tarik sebelum jatuh tempo** dipindah ke atas.
- Rincian bunga dibagi menjadi **"Dari mana bunganya"** (bunga tenor dan bunga pasca jatuh tempo) dan **"Ke mana bunganya"** (sudah masuk Sukarela, belum dipindahkan, PPh). Disertai keterangan "Dihitung otomatis · terakhir s.d. …".
- Bagian Rincian Kontrak, Kebijakan Produk, Dokumen (dengan keterangan tiap bukti), dan Pencairan ditampilkan dengan tanggal yang mudah dibaca.
- Kartu "Cara kerja" ada di bagian bawah.
- Tetap tidak ada perhitungan di layar. Semua angka berasal dari `getSimpananBerjangka`, `getRincianBungaKontrak`, dan service pencairan dini.

### 3.3 Form penempatan — `SimpananFormScreen.tsx` (jalur BERJANGKA)
- **Tiga kartu langkah**:
  1. Anggota & tanggal.
  2. Nominal, tenor & bunga. Tenor dipilih lewat ubin besar, tanggal jatuh tempo tampil langsung, dan ada perkiraan bunga per bulan.
  3. Sumber dana, dipilih lewat ubin Kas/Bank.
- Peringatan "Kebijakan produk belum ditetapkan" dipindah ke **paling atas** dan dilengkapi tombol menuju layar kebijakan.
- **Ringkasan penempatan** sebelum simpan: anggota, tenor, suku bunga, tanggal mulai, jatuh tempo, sumber dana, perkiraan bunga selama tenor, dan pokok.
- Perkiraan bunga memakai `hitungTotalBungaKontrak` / `buatJadwalBungaSimpananBerjangka`, yaitu helper akuntansi yang sama dengan akrual. Tidak ada rumus di layar.
- Jalur REGULER (Setor Simpanan) tetap: isian, tombol "Simpan Transaksi", dan total tidak berubah.

### 3.4 Kebijakan Produk — `KebijakanProdukBerjangkaScreen.tsx`
- Kartu pembuka **"Apa yang diatur di sini?"** berisi 3 poin.
- Kolom wajib ditandai `*`.
- Tanggal ditampilkan dalam format mudah dibaca, status ditulis "Aktif"/"Dicabut" alih-alih kode, dan status kontrak lama memakai bahasa sehari-hari.
- Rate pasca jatuh tempo tetap kosong pada awalnya, tanpa angka bawaan.

### 3.5 Komponen & modul bersama baru
- `src/components/simpanan/CaraKerjaBerjangka.tsx` — kartu "Cara kerja Simpanan Berjangka" (5 poin + alur Pokok → anggota, Bunga → Sukarela) yang bisa dibuka-tutup.
- `src/screens/Simpanan/tampilanBerjangka.ts` — label, warna, tanggal pendek, tahap kontrak, kalimat penjelasan, dan isi "Cara kerja" (murni, tanpa database).
- `src/utils/daftarSimpananBerjangka.ts` — pencarian, filter, urutan, dan hitungan per status (murni).
- `SimpananBerjangkaService.listSimpananBerjangkaDaftar()` — baca-saja, `mapRow` yang sama + `nama_lengkap`/`nomor_anggota` (LEFT JOIN).

### 3.6 Bunga Simpanan Sukarela otomatis — `BungaSimpananSukarelaScreen.tsx`
- **Tombol "Akru Bunga …" dihapus.** Layar tidak lagi memanggil `prosesAkrualBungaSukarela`.
- Saat dibuka, layar:
  1. menunggu batch latar yang sedang berjalan (`tungguTugasStartupSelesai`);
  2. membaca status;
  3. bila masih ada bulan selesai yang belum dibukukan, menjalankan **koordinator yang sama** dengan startup/foreground (`jalankanTugasStartup`). Urutannya tetap: catch-up berjangka dulu, lalu sukarela. Proses ini idempoten dan hanya dijalankan sekali per pemuatan, tanpa timer;
  4. membaca ulang.
- Selama proses berjalan, tampil kartu "Memproses bunga {bulan}… Tidak perlu menekan apa pun."
- Tab Akrual berisi kartu **"Akrual bunga otomatis"**: lencana Otomatis/Nonaktif, "Semua bulan yang sudah selesai sudah dibukukan", terakhir dibukukan, bulan berjalan, dan tanggal pembukuan otomatis berikutnya.
- Bila otomatis tertahan (misalnya periode tertutup atau izin pengguna), tampil peringatan berisi alasannya dan cara memperbaikinya, beserta angka bulan yang menunggu. Proses dicoba lagi otomatis pada pembukaan berikutnya.
- "Batalkan akrual" tetap ada. Setelah dibatalkan, bulan itu dihitung ulang otomatis dengan data terbaru (teks dialog disesuaikan).
- Teks panduan disesuaikan: panduan tertulis, slide `panduanAplikasi.ts`, ilustrasi `IlustrasiUi.tsx`, dan subjudul menu Penyesuaian.

## 4. Yang sengaja TIDAK disentuh

- `BungaSukarelaService` (rumus, jurnal, PPh, idempotensi, pembatalan), `StartupTasks`, catch-up dan background task berjangka.
- `SimpananBerjangkaLifecycleService`, kebijakan produk (service & aturan), dokumen PDF, mesin pajak, AccountingEngine/AccountMapping, COA.
- Skema & migrasi (tetap v79), Simpanan Pokok/Wajib, Pinjaman, SHU, dan laporan.

## 5. Test

- **Baru** — `SimpananBerjangkaDaftarRcS129.test.ts` (16 test, semua lulus di harness):
  - pencarian (nama, kata acak, nomor, keterangan, nominal), filter status/jatuh tempo bulan ini/perlu ditinjau, urutan, dan hitungan;
  - bahasa tampilan (tanggal, tahap, penjelasan semua status);
  - integrasi SQLite: `listSimpananBerjangkaDaftar` = `listSimpananBerjangka` + nama/nomor anggota;
  - struktur layar, termasuk "tidak ada tombol akru manual" dan "layar menunggu & memicu koordinator".
- **Disesuaikan** — `UiInputStandardizationRcS54`: sensus SearchField 21 → 22 karena ada kolom pencarian baru (dicatat di komentar, guard tidak dilonggarkan).
- **Regresi penuh di harness** (343 berkas suite): hasil per suite dan per nama test **identik dengan baseline RC-S128**, kecuali:
  - `SimpananBerjangkaDaftarRcS129` adalah suite baru (16/16);
  - `EstimasiAkrualRealtimeRcS74Hotfix` di baseline tidak menghasilkan baris hasil (macet/timeout pada fake timer harness), sedangkan di RC-S129 hasilnya 30/33. Ketiga kegagalan adalah test timer `jest.useFakeTimers` milik hook `useDetikMemuat`. Hook ini dan `StartupTasks` tidak diubah, jadi tidak ada regresi yang terbukti, tetapi status suite ini **belum terverifikasi**.
- **Typecheck** `tsc -p tsconfig.screen-check.json`: tidak ada error baru pada layar/komponen yang diubah. Tiga error tambahan di `SimpananBerjangkaService.ts` berpola sama dengan error mock `expo-sqlite` yang sudah ada di fungsi tetangganya (`getAllAsync<any>` → TS2558). Berkas baru dimasukkan ke `tsconfig.screen-check.json`.
- **Render visual**: kelima layar dirender di Chromium (390 px) lewat shim React-Native→DOM dengan data contoh, lalu diperiksa secara visual. Ini bukan render perangkat.
- Status: **HARNESS-VERIFIED, bukan JEST-VERIFIED**. `npm run typecheck && npm test` dan uji perangkat Android masih **BLOCKED BY ENVIRONMENT** (node_modules tidak tersedia).

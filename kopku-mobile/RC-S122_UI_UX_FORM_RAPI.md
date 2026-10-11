# RC-S122 — UI/UX Form: Modal Koperasi, Penarikan dari Bank, Penghapusan Piutang, Pemindahan Saldo, User Management

Baseline: hasil RC-S121. Lingkup: **tampilan saja**. Service, validasi, jurnal, COA, database, dan dependency tidak diubah.

## Arah desain

Desain tetap memakai design system yang sudah ada: hijau brand, token radius/elevasi/tipografi, dan Ionicons. Tidak ada hex baru.

Setiap form dibagi menjadi **langkah bernomor**, polanya sama dengan form Pinjaman (RC-S86). Di akhir form ada **ringkasan sebelum simpan** dan **satu tombol utama**.

Satu elemen dibuat menonjol, yaitu kartu **Alur Dana**. Kartu ini menunjukkan rekening asal, rekening tujuan, nominal, dan saldo masing-masing sebelum dan sesudah transaksi. Itulah pertanyaan yang biasanya ingin dijawab petugas sebelum menekan Simpan.

## Komponen bersama baru — `src/components/form/`

Semua komponen di folder ini murni presentasi: tidak mengimpor service, store, atau utils, dan tidak punya state. Angka diterima dari pemanggil dalam bentuk yang sudah terformat.

| Komponen | Fungsi |
|---|---|
| `KartuLangkah` | Kartu bagian form, dengan nomor langkah atau ikon |
| `PilihanOpsi` / `UbinOpsi` | Pilihan tunggal berbentuk ubin. Opsi terpilih ditandai warna, latar, dan ikon centang. Role aksesibilitas: radio |
| `RingkasanTransaksi` | Ringkasan sebelum simpan, dengan nada `utama` atau `bahaya` |
| `TombolUtama` | Tombol penuh lebar dengan status memuat dan nonaktif |
| `KotakInfo` | Kotak info atau peringatan, bisa diberi tombol aksi |
| `AlurDana` | Kartu dari → ke dengan saldo sebelum/sesudah dan tombol tukar opsional |

## Perubahan per layar

**Modal Koperasi**
- Dibagi menjadi 3 langkah (bentuk Uang) atau 4 langkah (bentuk Barang).
- Pilihan Uang/Barang, Tunai/Transfer, dan Aset Tetap/Tak Berwujud memakai ubin yang diberi keterangan.
- Klasifikasi aset dipilih lewat pemilih ber-chevron, dengan tanda error dan centang pada pilihan di modal.
- Masa manfaat dibantu teks "setara x tahun".
- Tidak ada perubahan perilaku.

**Penarikan dari Bank**
- Ditambah kartu Alur Dana, 3 langkah, dan tombol "Tarik seluruh saldo".
- Perbaikan perilaku UI:
  - Pemilih sumber sekarang hanya menampilkan rekening **bank**. Sebelumnya kas juga bisa dipilih, padahal service pasti menolaknya.
  - Pemilih tujuan dibatasi ke **Kas dan Kas Kecil**.
  - Kolom **Keterangan** sekarang tampil. Parameternya sudah dikirim ke service sejak awal, tetapi kolom isiannya tidak pernah ada.
  - Tombol Simpan benar-benar nonaktif saat saldo bank tidak cukup.

**Penghapusan Piutang**
- Dibagi menjadi 2 langkah, ditambah kartu detail pinjaman terpilih (sisa piutang, plafon, tunggakan, tenor) dan ringkasan dampak.
- Sebelum hapus buku sekarang muncul **dialog konfirmasi**.
- Peringatan RAT sekarang punya tombol **"Buka Pelaksanaan RAT"**. Teks lama menyuruh ke "menu SHU", padahal RAT kini ada di menu Data.
- Picker pinjaman macet ditampilkan dalam bentuk kartu.

**Pemindahan Saldo Rekening** (`KasBankTransaksiFormScreen`, mode TRANSFER)
- Ditambah kartu Alur Dana dengan tombol **tukar** sumber/tujuan.
- Ditambah tombol "Pindahkan seluruh saldo".
- Muncul peringatan dan tombol Simpan dinonaktifkan bila saldo sumber jelas tidak cukup.
- Ditambah tab **Riwayat** baru, memakai konfigurasi `PEMINDAHAN_SALDO` yang sudah ada.
- Mode Penerimaan/Pengeluaran (tombol "+" di Kas & Bank) ikut dirapikan:
  - Jenis transaksi dipilih lewat ubin.
  - Kategori bersifat opsional dan bisa dibatalkan dengan mengetuk ulang.
  - Ditambah ringkasan sebelum simpan.

**User Management**
- Ditambah ringkasan di atas daftar: total user, user aktif, dan user yang perlu ganti password.
- Daftar dikelompokkan menjadi Aktif dan Nonaktif.
- Setiap kartu menampilkan avatar inisial, role (ikon + label), dan badge status.
- Ditambah tombol aksi berlabel, tombol "Tambah User" berlabel, tarik untuk muat ulang, dan tombol "Coba lagi" saat gagal memuat.
- Perbaikan:
  - Kartu sebelumnya memakai `flexDirection: 'row'`, sehingga peringatan password dan tombol Sunting tampil berdampingan dengan identitas user. Sekarang tersusun bertumpuk.
  - Status dulu tampil sebagai pil "Aktif" yang sebenarnya tombol. Sekarang status hanya badge, dan aksi aktif/nonaktif menjadi tombol terpisah yang berlabel jelas.
  - **Akun sendiri tidak bisa dinonaktifkan dari daftar.** Service hanya menjaga agar Admin terakhir tidak dinonaktifkan.
  - Dialog "Ubah Role" yang tidak pernah bisa dibuka dihapus. Role tetap diubah lewat Sunting.
  - Warna hex lepas per role diganti ikon (`ikonRole.ts`).
- Form user dibagi menjadi 3 langkah. Saat menyunting, tampil kartu profil. Role dipilih lewat ubin berikon.

## Verifikasi (HARNESS-VERIFIED, bukan JEST-VERIFIED)

**TypeScript**
- Typecheck seluruh `src` + `app`: 2983 error sebelum perubahan, 2982 sesudahnya. Tidak ada error baru; semuanya error lingkungan karena tidak ada `node_modules`.
- `SectionList` ditambahkan ke deklarasi ambient harness `.harness/rn-ambient.d.ts`. Penambahan ini sekaligus menghilangkan satu error lama di `AreaAmanKeyboard.tsx`.

**Test struktural**
- 34 suite dijalankan, termasuk suite baru `UiFormRapiRcS122` (22 tes). Semua suite yang bisa dimuat lulus.
- Sensus tetap sama: 96 FocusTextInput, 21 SearchField, 20 pasangan invalid/FieldError.
- 4 suite tidak dapat dimuat karena butuh `sql.js` (database asli). Keadaannya sama dengan baseline.

**Wajib dijalankan di lokal:** `npm run typecheck && npm test`, lalu periksa tampilan di dev build atau emulator. Tidak ada renderer React Native di lingkungan ini, jadi tampilan belum dilihat langsung.

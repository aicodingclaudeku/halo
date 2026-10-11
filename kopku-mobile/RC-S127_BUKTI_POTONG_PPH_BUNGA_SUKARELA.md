# RC-S127 — PPh 4(2) Bunga Simpanan: Bukti Potong Sukarela + Batas Agregat Lintas Produk

## Temuan audit (sebelum coding)

Pemotongan PPh 4(2) atas bunga Simpanan Sukarela **sudah berjalan di service**
sejak modul bunga sukarela dibuat (`BungaSukarelaService.prosesAkrualBungaSukarela`):

```
Akrual bulan M (satu jurnal, tanggal akhir M):
  Dr 5-1956 Beban Bunga Simpanan Sukarela        bruto
     Cr 2-1200 Simpanan Sukarela Anggota          neto   (yang masuk saldo anggota)
     Cr 2-1901 Utang PPh Ps.4(2) Bunga Simpanan   PPh    (hanya bila > 0)
+ satu bukti potong per anggota per masa di `pajak_potong_bunga_simpanan` (termasuk 0%)
```

Test lama (`BungaSimpananSukarela.test.ts`) sudah membuktikan Budi (bunga
Rp3.100.000) dipotong Rp310.000. Yang **belum ada** adalah sisi yang bisa dilihat
pengguna, sehingga dari layar PPh-nya tampak "tidak ada":

1. Tidak ada layar Bukti Potong. Teks layar menyebut "bukti potong tercatat di
   menu Pajak", padahal menu Pajak tidak punya tempat membacanya
   (`listBuktiPotongPphBungaSimpanan` hanya dipakai test; sudah dicatat sebagai
   "belum dikerjakan" di RC-S86).
2. Layar Bunga Simpanan Sukarela menyembunyikan PPh per anggota bila Rp0
   (`pajak !== 0 ? … : null`). Koperasi dengan bunga anggota ≤ Rp240.000/bulan
   (kasus paling umum) tidak pernah melihat baris PPh sama sekali.
3. Riwayat Pajak hanya memuat jurnal yang menyentuh 2-1901 (PPh > 0), dan
   catatannya menyuruh membatalkan "lewat layar Simpanan Berjangka" — salah
   untuk bunga sukarela.

## Perubahan

| File | Perubahan |
|---|---|
| `src/services/PphPotongService.ts` | `PENANDA_BUKTI_POTONG_SUKARELA` dipindah ke sini (nilai sama, `'SUKARELA'`). `BuktiPotongPphBungaSimpanan` + field aditif: `produk`, `nomorAnggota`, `nikAnggota`, `nomorKontrak`, `nomorJurnal`, `dibatalkan`. Baru: `listBuktiPotongTahun`, `getIdentitasPemotong`, `labelMasaPajak`, `keteranganTarifBuktiPotong`, `ringkasBuktiPotong`, `filterBuktiPotong`, `buildDaftarBuktiPotongExport`, `buildBuktiPotongSatuExport`. |
| `src/services/BungaSukarelaService.ts` | `PENANDA_BUKTI_POTONG_SUKARELA` kini merujuk konstanta mesin pajak (tanpa impor melingkar). Rumus, jurnal, pajak **tidak berubah**. |
| `src/screens/Pajak/BuktiPotongPphScreen.tsx` **(baru)** | Pilih tahun, filter Semua/Sukarela/Berjangka, ringkasan (PPh dipotong, jumlah bukti potong, tarif 0%, dibatalkan), daftar per anggota, lembar detail, **Export Daftar** dan **Cetak Bukti Potong** per anggota (PDF/Excel/CSV). Ikon (!) dengan contoh hitung. |
| `src/navigation/RootNavigator.tsx` | Rute `BuktiPotongPph`. |
| `src/screens/Pajak/PajakMenuScreen.tsx` | Baris "Bukti Potong Bunga Simpanan" (tampil di semua rezim). |
| `src/screens/Pajak/infoPajak.ts` | Kunci info `menuBuktiPotong`; contoh hitung dari `hitungPphBungaSimpanan`. |
| `src/screens/Simpanan/BungaSimpananSukarelaScreen.tsx` | PPh per anggota **selalu** tampil (termasuk Rp0) di pratinjau & rincian; aturan tarif ditampilkan dari konstanta `pajakPolicy`; tautan "Bukti potong PPh" di Riwayat akrual. |
| `src/screens/Pajak/RiwayatPajakScreen.tsx` | Catatan pembatalan PPh bunga berlaku untuk Sukarela & Berjangka. |
| `src/__tests__/BuktiPotongPphBungaSimpananRcS127.test.ts` **(baru)** | 11 test. |

## Migrasi

Tidak ada. Tanpa kenaikan `SCHEMA_VERSION`, tanpa kolom baru. Produk diturunkan
dari penanda `simpanan_berjangka_id = 'SUKARELA'` yang sudah ditulis sejak awal;
status dibatalkan diturunkan dari `journal.status` (pola RC-S86).

## Test

`BuktiPotongPphBungaSimpananRcS127.test.ts` — 11/11:
- akrual sukarela → utang 2-1901 = Rp310.000, dua bukti potong (Budi 10%, Andi 0%) lengkap dengan nomor anggota, NIK, nomor jurnal;
- ringkasan hanya menjumlah bukti potong yang berlaku;
- batal akrual → bukti lama "dibatalkan", utang PPh kembali 0; akru ulang → bukti baru;
- baris berjangka terbaca dan terfilter terpisah;
- export daftar & satu lembar (NPWP koperasi, sumber bunga, PPh);
- keterangan tarif & contoh hitung dari mesin pajak;
- struktural: rute terdaftar & tertaut, layar tidak menghitung pajak sendiri, PPh Rp0 tidak lagi disembunyikan.

## Bagian 2 — Batas Rp240.000 agregat per anggota per bulan (lintas produk)

**Keputusan pengurus:** batas Rp240.000 dihitung atas TOTAL bunga simpanan yang
dibayarkan koperasi kepada satu anggota dalam satu bulan masa — Sukarela +
Berjangka digabung. Bila total melebihi batas, PPh 10% atas SELURUH bruto bulan itu.
Dicatat di `src/ATURAN_BISNIS.md` §19.B (butir POLICY terbuka di §19 ditutup).

### Cara kerja

```
PPh peristiwa ini = PPh(total bruto bulan itu SESUDAH peristiwa ini)
                  − PPh yang SUDAH dipotong bulan itu (bukti potong berlaku, semua produk)
```

Contoh (anggota A, Februari):

| Urutan | Peristiwa | Bruto | Total bulan | PPh dipotong | Neto |
|---|---|---|---|---|---|
| 1 | Transfer bunga Berjangka (15 Feb) | 120.000 | 120.000 | 0 | 120.000 |
| 2 | Akrual bunga Sukarela (akhir Feb) | 140.000 | 260.000 | **26.000** (10% × 260.000, termasuk susulan 12.000 atas Berjangka) | 114.000 |

Bila susulan lebih besar dari bunga peristiwa itu (mis. Sukarela 239.400 lalu
Berjangka 1.000 → PPh 24.040), neto −23.040 **ditarik dari Simpanan Sukarela**
(jurnal Dr 2-1200, subledger TARIK). Koreksi turun yang membuat total kembali ≤
batas menghasilkan PPh negatif (pengembalian, Dr 2-1901).

Invarian yang diuji: total PPh berlaku satu anggota satu bulan = PPh atas total
bruto berlaku bulan itu.

### File

| File | Perubahan |
|---|---|
| `src/config/pajakPolicy.ts` | + `PosisiPphBungaBulanan`, `hitungPphBungaSimpananAgregat()` (rumus di policy layer). |
| `src/services/PphPotongService.ts` | + `getPosisiPphBungaBulananPadaDb()`, `buatPenghitungPphAgregat()` (posisi dibaca sekali per anggota+masa, akumulasi di memori dalam satu transaksi), `hitungPphBungaSimpananPeriodeAgregatPadaDb()`. Keterangan tarif mengenali potongan susulan & pengembalian. Catatan kaki export diperbarui. |
| `src/services/BungaSukarelaService.ts` | Akrual & koreksi memakai penghitung agregat (sebelumnya `hitungPphBungaSimpanan` per produk). |
| `src/services/SimpananBerjangkaLifecycleService.ts` | §B transfer & pencairan memakai penghitung agregat; jurnal & subledger menangani neto negatif dan PPh negatif. |
| `src/screens/Pajak/infoPajak.ts`, `BungaSimpananSukarelaScreen.tsx` | Penjelasan: total semua produk; contoh 150rb + 150rb. |
| `src/ATURAN_BISNIS.md` | §19.B keputusan & batasan. |
| `src/__tests__/PphBungaAgregatLintasProdukRcS127.test.ts` **(baru)** | 12 test. |

### Test agregat (12/12)
- Rumus: 200rb + 200rb → 0 lalu 40.000; tepat batas → 0; koreksi turun → negatif; pecahan ditolak.
- Berjangka dulu lalu Sukarela → susulan di akrual Sukarela; utang 2-1901 = invarian.
- Sukarela dulu lalu Berjangka kecil → neto negatif ditarik dari Sukarela, jurnal seimbang, subledger TARIK; §B dijalankan ulang tidak memotong lagi.
- Pencairan: masa Feb digabung dengan Sukarela Feb, Mar & Apr berdiri sendiri.
- Anggota lain tidak ikut dijumlah; transfer yang dibatalkan tidak ikut posisi bulan.

### Batasan yang diketahui
Bila peristiwa yang sudah memotong susulan kemudian **dibalik** sementara peristiwa
lain di bulan itu tetap berlaku, total potongan bulan itu bisa berbeda dari 10% ×
total sampai ada pembayaran/koreksi berikutnya di bulan itu. Tidak ada jurnal
penyesuaian otomatis.

### Tetap wajib
Tarif, ambang, dan tata cara setor/lapor tetap perlu dikonfirmasi konsultan pajak
sebelum go-live.

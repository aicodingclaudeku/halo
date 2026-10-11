# RC-S87 — Tax Engine: PPh Final UMKM 0,5% | PPh Badan Pasal 31E (11%) + Tarif Umum (22%)

## Ringkasan

Modul Pajak RC-S84/RC-S86 diperluas secara aditif menjadi tax engine yang
**menentukan rezim pajak sendiri** per tahun pajak, menghitung PPh Badan
non-final dengan fasilitas Pasal 31E, mengkredit PPh 25/22/23/24 yang sah,
membentuk PPh 29, jurnal, dan snapshot terkunci. Tidak ada lagi input
"PPh terutang" di layar, dan operator tidak pernah memilih tarif.
Istilah "PPh Final 11%/22%" tidak ada di kode produksi (dikunci test).

## 1. Audit & konflik (diputuskan dengan jalur paling aman)

| # | Temuan | Keputusan |
|---|---|---|
| 1 | `SkemaPajak = FINAL_UMKM \| UMUM` disimpan di `app_config` dan dikunci ±10 test RC-S84 | Dipertahankan sebagai **deklarasi**. Rezim efektif (`FINAL_UMKM`/`BADAN_31E`/`BADAN_UMUM`) dihitung resolver. Label deklarasi diubah menjadi "Memakai PPh Final UMKM 0,5%" / "Tidak memakai PPh Final (PPh Badan)". |
| 2 | `catatPphBadan()` meminta angka PPh terutang tanpa sumber; dikunci test | Dipertahankan di service (kompatibilitas), **tidak lagi ditawarkan di UI**. Engine memakai kunci jurnal yang sama `PPH_BADAN:<tahun>` → kedua jalur tidak mungkin tercatat bersamaan (diuji). |
| 3 | Kredit PPh 25 lama = saldo 1-1410 per 31 Des (bisa tercampur sisa tahun lain/jurnal bebas) | Engine memakai **angsuran sah tahun pajak itu** (transaksi kas/bank `PAJAK:PPH25:<masa>` + jurnal POSTED), dan menolak kunci bila melebihi saldo buku 1-1410. |
| 4 | Omzet > Rp4,8 M hanya peringatan di PPh Final | Resolver: omzet **tahun sebelumnya** > Rp4,8 M ⇒ PPh Badan mulai tahun berikutnya dan tidak kembali ke final; omzet **tahun berjalan** > Rp4,8 M ⇒ tetap final s.d. akhir tahun (peringatan). `catatPphFinal` kini ditolak bila rezim efektif bukan final. |
| 5 | `pastikanSkemaUmum` hanya memeriksa deklarasi — koperasi yang fasilitas finalnya habis tidak bisa mencatat PPh 25 | Diganti `pastikanRezimBadan(db, tahun)` berbasis rezim efektif; pesan untuk rezim final tidak berubah (test lama tetap lulus). |
| 6 | Pengecualian omzet hanya centang di UI PPh Final | Ditambah pengecualian **terkonfigurasi** (akun, alasan, dasar aturan, user, waktu, bisa dicabut) — dipakai PPh Final, resolver, dan peredaran bruto Pasal 31E. Centang UI lama tetap berfungsi. |
| 7 | `SCHEMA_VERSION = 72` dikunci test | Tabel baru dibuat idempoten (`CREATE TABLE IF NOT EXISTS`) seperti RC-S86; versi tidak dinaikkan, `db.ts` tidak disentuh. |
| 8 | Tidak ada akun untuk PPh 22/23/24 yang dipotong pihak lain | Akun baru **1-1411 Pajak Dibayar Dimuka (PPh 22/23/24)** lewat `pastikanAkunPajak()` (tidak masuk DEFAULT_ACCOUNTS). |
| 9 | Lebih bayar ditolak di RC-S84 (kebijakan belum ada) | Tetap: engine menampilkan nilai lebih bayar tetapi status `LEBIH_BAYAR_BELUM_ADA_KEBIJAKAN`, tidak bisa dikunci. **POLICY — perlu keputusan Anda.** |

## 2. Desain

```
Deklarasi + tahun terdaftar + omzet ledger (− pengecualian) + override berdokumen
        │  tentukanRezimPajak()  → alasan, peringatan, dasar aturan, parameter, versi kebijakan
        ▼
 FINAL_UMKM ──► PPh Final 0,5% × peredaran bruto per masa (mekanisme RC-S84, 2-1904)
 BADAN_31E / BADAN_UMUM
        ▼
 Laba komersial (getLHU: SHU sebelum pajak)
   + koreksi positif − koreksi negatif (data diaudit)  → PKP (⌊/1000⌋×1000)
        ▼  hitungPphBadanNonFinal()
 PKP fasilitas (11%) + PKP non-fasilitas (22%) → Total PPh Badan
   − kredit PPh 25 sah − PPh 22/23/24 terdaftar → PPh 29 / lebih bayar
        ▼  kunciPerhitunganPphBadan()
 Snapshot immutabel + jurnal → Setor Pajak (NTPN) → Riwayat
```

Kebijakan regulasi **diversikan** (`KEBIJAKAN_PAJAK`, versi `KOPKU-PAJAK-2026.1`, berlaku mulai 2020): tarif 22%, pengurangan 50%, batas Rp4,8 M & Rp50 M, pembulatan PKP 1.000, jatuh tempo PPh 25 tanggal 15. Regulasi baru = tambah versi; service & UI tidak disentuh. Snapshot menyimpan salinan kebijakannya sendiri.

## 3. Formula

```
PKP                = max(0, ⌊(laba komersial + koreksi+ − koreksi−) / 1.000⌋ × 1.000)
PKP fasilitas      = PKP                              bila bruto ≤ Rp4,8 M
                   = ⌊Rp4,8 M × PKP / bruto⌋          bila Rp4,8 M < bruto ≤ Rp50 M
                   = 0                                bila bruto > Rp50 M atau rezim BADAN_UMUM
PPh fasilitas      = ⌊PKP fasilitas × 22% × (100% − 50%)⌋      (tarif efektif 11%)
PKP non-fasilitas  = PKP − PKP fasilitas
PPh non-fasilitas  = ⌊PKP non-fasilitas × 22%⌋
Total PPh Badan    = PPh fasilitas + PPh non-fasilitas
PPh 29             = max(0, Total − kredit);   lebih bayar = max(0, kredit − Total)
```
Seluruh perhitungan antara memakai BigInt; nilai eksak PKP fasilitas (pecahan) disimpan untuk audit.

## 4. Contoh hasil (dari test)

| Kasus | Bruto | PKP | PKP fas. | PPh 11% | PKP non | PPh 22% | Total |
|---|---|---|---|---|---|---|---|
| Omzet ≤ 4,8 M | 1 M | 310 jt | 310 jt | 34,1 jt | 0 | 0 | **34,1 jt** |
| Alokasi | 10 M | 1 M | 480 jt | 52,8 jt | 520 jt | 114,4 jt | **167,2 jt** |
| Pecahan | 7 M | 123.456.000 | 84.655.542 | 9.312.109 | 38.800.458 | 8.536.100 | **17.848.209** |
| > 50 M / tarif umum | 60 M | 1 M | 0 | 0 | 1 M | 220 jt | **220 jt** |
| Rugi | — | 0 | 0 | 0 | 0 | 0 | **0** (dikunci tanpa jurnal) |

Alur integrasi penuh: laba komersial 300 jt + koreksi positif 10 jt (sumbangan) → PKP 310 jt → PPh 34,1 jt − kredit PPh 25 3 jt (3 angsuran sah) → **PPh 29 = 31,1 jt**. Jurnal: Dr 5-2200 34.100.000 / Cr 1-1410 3.000.000 / Cr 2-1905 31.100.000; LHU menampilkan beban pajak 34,1 jt dan SHU sebelum pajak tetap 300 jt.

## 5. Jurnal yang dibentuk

| Peristiwa | Jurnal |
|---|---|
| Angsuran PPh 25 terjadwal | Dr 1-1410 / Cr Kas-Bank (mesin `catatAngsuranPph25` existing) |
| Daftar bukti potong PPh 22/23/24 | Dr 1-1411 / Cr akun lawan (pendapatan bruto yang tercatat neto, atau kas bila dibayar sendiri) |
| Kunci PPh Badan | Dr 5-2200 total / Cr 1-1410 kredit PPh 25 / Cr 1-1411 kredit lain / Cr 2-1905 PPh 29 |
| Batalkan perhitungan | Reversal jurnal di atas (ditolak bila PPh 29 sudah disetor) + snapshot `DIBATALKAN` |
| Setor PPh 29 | `setorPajak()` → `bayarKewajibanCoa()` existing, NTPN |

## 6. Migrasi (aditif, idempoten, tanpa naik SCHEMA_VERSION)

`pajak_rezim_evaluasi`, `pajak_rezim_override`, `pajak_pengecualian_omzet` (di `PajakService`); `pajak_koreksi_fiskal`, `pajak_rekonsiliasi_fiskal`, `pajak_kredit_lain`, `pajak_pph25_dasar`, `pajak_badan_snapshot` (di `PajakBadanService`). Akun baru 1-1411.

## 7. File diubah/dibuat

| File | Perubahan |
|---|---|
| `src/config/pajakPolicy.ts` | `RezimPajak`, `LABEL_REZIM`, `KEBIJAKAN_PAJAK` (versioned), `tentukanRezimPajak`, `hitungPphBadanNonFinal`, `jatuhTempoPph25`, sumber dasar PPh 25, akun 1-1411; label deklarasi |
| `src/services/PajakService.ts` | Resolver berbasis DB + catatan audit keputusan, override berdokumen, pengecualian omzet terkonfigurasi, `pastikanRezimBadan`, cek rezim di `catatPphFinal`, `batalkanPengakuanPajakPadaDb` |
| `src/services/PajakBadanService.ts` **(baru)** | Koreksi fiskal, rekonsiliasi, kredit PPh 22/23/24, dasar & jadwal & pembayaran PPh 25, engine, snapshot, kunci/batal, dashboard |
| `src/screens/Pajak/PengaturanPajakScreen.tsx` | Rezim hasil sistem + alasan/omzet/batas/masa fasilitas/versi; override berdokumen |
| `src/screens/Pajak/PphBadanFormScreen.tsx` | Ditulis ulang: breakdown lengkap, Hitung Ulang / Review / Kunci / Batalkan |
| `src/screens/Pajak/KoreksiFiskalScreen.tsx` **(baru)** | Tambah/hapus koreksi (beralasan), nyatakan rekonsiliasi lengkap |
| `src/screens/Pajak/AngsuranPph25FormScreen.tsx` | Dasar angsuran; nominal otomatis; fallback manual wajib alasan |
| `src/screens/Pajak/PajakMenuScreen.tsx` | Dashboard: rezim, omzet, masa fasilitas, utang pajak, PPh 4(2), PPh 25 bulan ini & jatuh tempo, PPh Badan tahun lalu, setoran terakhir; menu mengikuti rezim efektif |
| `src/navigation/RootNavigator.tsx` | Rute `KoreksiFiskal` |
| `src/ATURAN_BISNIS.md` | §19.A |
| `src/__tests__/PajakBadanRcS87.test.ts` **(baru)** | 31 test |

## 8. Hasil verifikasi

| Pemeriksaan | Hasil |
|---|---|
| `tsc --noEmit` | 0 error |
| Test baru RC-S87 | **31/31** (murni: 31E ≤4,8 M, alokasi 4,8–50 M, >50 M, pembulatan/BigInt, rugi, kredit & PPh 29, resolver final/transisi/tidak-kembali/override, terminologi; integrasi: final 0,5%, penolakan final, pengecualian, override, PPh 25 jadwal/duplikat/NTPN, belum lengkap, alur penuh + rekonsiliasi LHU, kredit sah, anti-dobel, snapshot vs perubahan kebijakan, batal & kunci ulang, periode tertutup, rugi, kredit PPh 23, dashboard) |
| Regresi RC-S84 + RC-S86 | 48/48 tanpa perubahan expected value |
| Regresi penuh | 283 suite, 5.364 test: 5.359 lulus; **7 suite gagal identik baseline** (dokumen kebijakan tidak ikut ZIP: ImbalHasilTetapRcS67_6, KontrolAkhirRcS53, PendapatanBungaCoaRcS70_6, PendapatanKoperasiRcS67, PolicyRegisterRcS53, ReleaseHardeningRcS57, TemporalIntegrityRcS58) — tidak ada regresi |
| Build | `npx expo export --platform android` sukses (Hermes bundle 8,75 MB) |
| Lint | **Tidak dapat dijalankan** — proyek tidak memiliki konfigurasi ESLint maupun skrip `lint` |

## 9. Batasan & keputusan terbuka

- **POLICY:** perlakuan lebih bayar PPh Badan (restitusi/kompensasi) — masih diblokir.
- Kompensasi kerugian fiskal tahun lalu belum dimodelkan; saat ini hanya bisa dimasukkan sebagai koreksi negatif beralasan.
- Pendaftaran bukti potong PPh 22/23/24 baru tersedia di service (belum ada layar).
- Pengecualian omzet terkonfigurasi baru tersedia di service (belum ada layar pengelola).
- Laba komersial diambil dari LHU tahun kalender; bila kelak ada jurnal penutup tahun yang menihilkan akun pendapatan/beban, sumber ini perlu ditinjau.
- Tarif, batas, aturan transisi (PP 55/2022 jo. PP 20/2026), dan jatuh tempo (PMK 81/2024) **wajib dikonfirmasi konsultan pajak** sebelum go-live; seluruhnya ada di satu tempat (`KEBIJAKAN_PAJAK`).
- Render UI tidak bisa diuji otomatis (tidak ada React Native testing library); layar diverifikasi lewat typecheck, test struktural, dan build.

---

## RC-S87.1 — Desain ulang UI/UX Pengaturan Pajak

**Susunan layar baru** (atas ke bawah):
1. **Kartu status rezim** — rezim tahun berjalan dengan ikon, lencana *Dihitung otomatis* / *Ditetapkan manual*, dan ringkasan satu kalimat berbahasa awam.
2. **"Mengapa rezim ini?"** — alasan dari resolver (ikon centang) + peringatan.
3. **Angka penentu** — bilah batas omzet (hijau < 80%, kuning 80–100%, merah > batas; selalu disertai angka & persen), plus masa fasilitas PPh Final dengan sisa tahun.
4. **① Data Koperasi** — deklarasi PPh Final sebagai kartu pilihan berdeskripsi (bukan segmen singkat), tahun terdaftar dengan pratinjau langsung "berlaku s.d. tahun X", penanda "ada perubahan belum disimpan", tombol *Simpan & Hitung Ulang* (tetap di layar, rezim langsung diperbarui).
5. **Penetapan manual** — dilipat secara default, hanya dibuka bila ada dokumen resmi.
6. **Kaki** — versi kebijakan + saran konfirmasi konsultan.

**Ikon tanda seru (penjelasan)** di 13 istilah: rezim pajak, tiap rezim (dengan contoh hitung), otomatis/manual, deklarasi, tahun terdaftar, peredaran bruto, batas Rp4,8 M, batas Rp50 M, masa fasilitas, penetapan manual, versi kebijakan. Ditekan → lembar dari bawah layar berisi ringkasan, poin penjelasan, kotak contoh angka, dasar aturan, dan tombol *Mengerti*.

Semua angka dalam penjelasan (batas, tarif, contoh 31E) **dihitung dari `pajakPolicy.ts`**, tidak ditulis tangan — dikunci test.

**File:** `src/screens/Pajak/PengaturanPajakScreen.tsx` (ditulis ulang), `src/screens/Pajak/PajakUi.tsx` (+ `TombolInfo`, `LembarInfo`, `JudulSeksi`, `LabelInfo`, `BilahBatas`, `KartuPilihan`, `Lencana` — memakai token tema & modal bersama, tanpa warna baru), `src/screens/Pajak/infoPajak.ts` (baru), `src/__tests__/PengaturanPajakUxRcS87_1.test.ts` (baru, 18 test).

**Verifikasi:** `tsc --noEmit` 0 error; 18/18 test baru; seluruh suite UI struktural + pajak (13 suite, 291 test) lulus; `expo export --platform android` sukses. Tidak ada perubahan service, jurnal, atau skema.

---

## RC-S87.2 — Pembayaran pajak lewat menu Kewajiban + desain ulang Setor Pajak

**Bayar Kewajiban** (Transaksi › Pengeluaran › Kewajiban)
- Kartu ketiga **"Setor Pajak"** di bawah "Utang Koperasi" dan "Kewajiban Lainnya"; subjudulnya menampilkan jumlah & total utang pajak belum disetor. Ditekan → alur Setor Pajak.
- Bila utang pajak (2-1904 / 2-1905 / 2-1901 / utang pajak umum) dipilih lewat "Kewajiban Lainnya", form pembayaran umum tidak ditampilkan; muncul kartu "Ini utang pajak" + tombol **Lanjut ke Setor Pajak** (akun terpilih otomatis). Tujuannya: masa pajak dan NTPN selalu tercatat.
- Dua kartu lama, label, dan mesin `bayarUtang` / `bayarKewajibanCoa` tidak berubah (test RC-S74 tetap lulus).

**Setor Pajak** (didesain ulang, jurnal tidak berubah)
- Kartu ringkasan: total utang pajak belum disetor.
- ① **Pilih utang pajak** — kartu per jenis dengan saldo dan lencana golongan (*Pajak koperasi* / *Dipotong dari anggota* / *Lainnya*).
- ② **Rincian setoran** — masa pajak (+ penjelasan "bulan pajak, bukan tanggal bayar"), nominal terisi otomatis sebesar saldo dengan tautan *Setor penuh*, sisa utang langsung terlihat, peringatan bila melebihi saldo, rekening & tanggal.
- ③ **Bukti setor** — NTPN dengan status langsung (*Format valid* / *Belum diisi*), catatan.
- **Ringkasan setoran** + pratinjau jurnal sebelum simpan; tombol terkunci bila belum lengkap/melebihi saldo.
- Setelah simpan: pilihan *Lihat Riwayat* atau *Selesai*. Bila tidak ada utang pajak: tampilan kosong yang jelas.
- Penjelasan (ikon tanda seru): jenis utang pajak, masa pajak, nominal/setoran sebagian, NTPN.

**Dashboard Pajak:** kartu "Utang pajak belum disetor" kini punya aksi **Setor sekarang**.

**File:** `BayarUtangFormScreen.tsx`, `SetorPajakFormScreen.tsx` (ditulis ulang), `PajakMenuScreen.tsx`, `infoPajak.ts`, `src/__tests__/SetorPajakKewajibanRcS87_2.test.ts` (baru, 7 test).

**Verifikasi:** `tsc --noEmit` 0 error; 19 suite terkait (Bayar Kewajiban RC-S74, ikon Pengeluaran, seluruh UI struktural, Pajak RC-S84/86/87/87.1/87.2) — 510/510 lulus; build Android sukses. Tidak ada perubahan service, jurnal, atau skema.

---

## RC-S87.3 — Perhitungan pajak otomatis + rincian yang seragam

**Yang kini otomatis**
| Pajak | Sebelumnya | Sekarang |
|---|---|---|
| PPh Final UMKM 0,5% | Pilih satu masa, centang akun, simpan satu per satu; layar ikut menghitung pajak | 12 masa terakhir dihitung otomatis dari buku besar dengan status (*Perlu dicatat / Dicatat / Nihil / Masa berjalan / Bukan PPh Final*), jatuh tempo, dan tanda terlambat. Tombol **Catat Otomatis n Masa** mencatat semuanya sekaligus lewat `catatPphFinal()` existing; aman dipanggil ulang. Pengecualian terkonfigurasi otomatis dipakai; pengecualian sekali pakai tetap tersedia sebagai opsi lanjutan. |
| Dasar angsuran PPh 25 | Diketik dari dokumen | Diusulkan otomatis dari PPh Badan tahun lalu yang **sudah dikunci**: (PPh terutang − kredit PPh 22/23/24) ÷ 12 (Pasal 25 ayat 1), satu ketukan *Gunakan Perhitungan Otomatis*, referensi = snapshot. Tanpa snapshot terkunci tidak ada usulan (tidak menebak). Input dari SPT/SKP/keputusan DJP tetap tersedia. |
| Jadwal PPh 25 | — | Jadwal 12 masa dengan status *Lunas / Perlu dibayar / Terlambat / Belum jatuh tempo*, nomor jurnal & NTPN; masa tertua yang belum dibayar dipilih otomatis. |
| PPh Badan | Dua kartu angka terpisah | Rincian langkah demi langkah (lihat di bawah); setelah dikunci diambil dari snapshot. |

**Rincian perhitungan — satu format untuk semua pajak** (`RincianPerhitungan` di `pajakPolicy.ts`, dirender `KartuRincian` di `PajakUi.tsx`): tanda operasi (+ − × =), label, rumus, sumber data (Buku besar / Koreksi fiskal / NTPN angsuran / snapshot), nominal; subtotal & hasil ditebalkan, akun dikecualikan dicoret beserta alasannya; kartu dapat dilipat dengan ringkasan hasil di judul. Angka rincian = angka jurnal (dibangun dari kalkulator yang sama; layar tidak menghitung apa pun).

Contoh PPh Final masa Maret (dari test): Jasa 30.000.000 + Bunga deposito 4.000.000 = 34.000.000 × 0,5% = **170.000**, jatuh tempo 15 April. Dengan bunga deposito dikecualikan (beralasan): dasar 30.000.000 → **150.000**.
Contoh PPh 25: PPh Badan 2025 terkunci 33.000.000 → angsuran 2026 **2.750.000/bulan**.

**Kebijakan:** `tanggalJatuhTempoPphFinal` (15) ditambahkan ke versi kebijakan; dasar aturan Pasal 25 ayat (1) dicatat.

**File:** `pajakPolicy.ts`, `PajakService.ts` (`getRincianPphFinal`, `getDaftarMasaPphFinal`, `catatPphFinalOtomatis`), `PajakBadanService.ts` (rincian di engine & snapshot, `getUsulanDasarPph25`, `tetapkanDasarPph25Otomatis`), `PajakUi.tsx` (`KartuRincian`), `PphFinalFormScreen.tsx` (ditulis ulang), `AngsuranPph25FormScreen.tsx`, `PphBadanFormScreen.tsx`, `PajakMenuScreen.tsx`, test baru `PerhitunganOtomatisRcS87_3.test.ts` (11 test).

**Verifikasi:** `tsc --noEmit` 0 error; 11/11 test baru; regresi penuh 286 suite / 5.400 test — 5.395 lulus, 7 suite gagal **identik baseline** (dokumen kebijakan tidak ikut ZIP); build Android sukses. Tidak ada perubahan skema; jurnal tetap lewat fungsi existing.

---

## RC-S87.4 — Desain ulang hub Pajak (untuk pengguna & pengawas)

Layar disusun untuk menjawab tiga pertanyaan secara berurutan:

1. **"Status pajak kita apa?"** — kartu rezim (ikon, nama rezim, arti dalam satu kalimat, lencana *Dihitung otomatis/Ditetapkan manual*, masa fasilitas; ketuk → Pengaturan Pajak) + tiga angka kunci: *Utang pajak*, *Tugas*, *Mendesak*.
2. **"Apa yang harus dikerjakan?"** — **Yang perlu dilakukan**: daftar tugas yang disusun service (`susunTugasPajak`), urut mendesak → perlu, masing-masing langsung membuka layarnya: lengkapi pengaturan, catat PPh Final n masa, bayar angsuran PPh 25 (terlambat/jatuh tempo), tetapkan dasar PPh 25, lengkapi koreksi fiskal, kunci/periksa PPh Badan, setor tiap utang pajak. Bila kosong: "Semua kewajiban pajak beres".
3. **"Berapa utang pajak, milik siapa?"** — **Posisi pajak** dikelompokkan menurut sifatnya: *Pajak koperasi* (PPh Final, PPh 29), *Dipotong dari anggota* (PPh 4(2) bunga simpanan + jumlah bukti potong bulan ini), *Kredit pajak* (PPh 25, PPh 22/23/24 — aset), total, tombol *Setor sekarang*.

Lalu **PPh Badan tahun lalu** (kartu rincian yang dapat dilipat, status terkunci/sementara) dan **menu menurut alur kerja**: ① Hitung & catat → ② Setor → ③ Pantau & atur, plus *Setoran terakhir*.

**Ikon tanda seru** di: *Cara kerja* (alur 5 langkah menu pajak), rezim, Yang perlu dilakukan, Posisi pajak, tiap kelompok posisi, PPh Badan tahun lalu, dan **setiap item menu** (7 menu).

**Arsitektur:** dashboard dipindah ke `src/services/PajakDashboardService.ts` (baru) supaya engine PPh Badan tetap tidak menyentuh pajak yang dipotong dari anggota — jaminan test RC-S87 dipertahankan, bukan dilonggarkan. Layar tidak menghitung dan tidak menulis ke database.

**File:** `PajakMenuScreen.tsx` (ditulis ulang), `PajakDashboardService.ts` (baru), `PajakBadanService.ts` (bagian dashboard dipindah), `infoPajak.ts` (+15 penjelasan), test baru `MenuPajakUxRcS87_4.test.ts` (8 test), `PajakBadanRcS87.test.ts` (hanya jalur import dashboard).

**Verifikasi:** `tsc --noEmit` 0 error; 21 suite terkait (seluruh suite pajak, UI struktural, Bayar Kewajiban, ikon Pengeluaran, rute, menu Transaksi) — 505/505 lulus; semua modul yang bergantung pada file yang diubah tercakup; build Android sukses. Tidak ada perubahan perhitungan, jurnal, atau skema.

---

## RC-S87.5 — Menu Pajak & Pengaturan Pajak versi sangat sederhana

**Menu Pajak — hanya empat blok:**
1. **Pajak koperasi tahun ini** — nama singkat (*PPh Final 0,5%* / *PPh Badan (tarif efektif 11%)* / *PPh Badan (tarif 22%)*) + satu kalimat arti ("Bayar 0,5% dari omzet setiap bulan."). Ketuk → Pengaturan.
2. **Sekarang** — hanya SATU tugas paling mendesak, dengan tombol *Kerjakan*. Tugas lain disembunyikan di "Lihat n tugas lainnya". Bila kosong: "Semua pajak sudah beres".
3. **Utang pajak belum disetor** — satu angka + tombol *Setor*; rincian per pemilik pajak dilipat di "Lihat rincian".
4. **Empat tombol besar** (2×2), sesuai rezim:
   - PPh Final: *Hitung Pajak Bulanan · Setor Pajak · Riwayat · Pengaturan*
   - PPh Badan: *Cicilan Bulanan (PPh 25) · Pajak Tahunan (PPh Badan) · Setor Pajak · Riwayat* (+ tautan kecil *Pengaturan pajak*). Koreksi Fiskal tetap dapat dibuka dari layar PPh Badan dan dari daftar tugas.

Kartu PPh Badan tahun lalu, setoran terakhir, tiga angka kunci, dan daftar menu bertingkat dihapus dari halaman utama (datanya tetap ada di layar masing-masing & Riwayat).

**Pengaturan Pajak — hanya dua pertanyaan:**
- Kartu hasil: "Pajak koperasi tahun 2026: **PPh Final 0,5%** — Bayar 0,5% dari omzet setiap bulan." + "Ditentukan otomatis · *Mengapa?*" (alasan dilipat).
- ① *Apakah koperasi memakai PPh Final UMKM?* **Ya / Tidak** — ② *Tahun terdaftar NPWP koperasi* (petunjuk otomatis "PPh Final boleh dipakai sampai tahun …") — **Simpan**.
- **Detail untuk pengawas** (dilipat): angka penentu (bilah batas omzet), masa fasilitas, cara penetapan, versi kebijakan, nama rezim lengkap, dan penetapan manual berdokumen.

Tanda seru tetap ada di setiap blok, pertanyaan, tombol, dan item detail.

**File:** `pajakPolicy.ts` (+ `LABEL_REZIM_SINGKAT`, `ARTI_REZIM`), `PajakMenuScreen.tsx` & `PengaturanPajakScreen.tsx` (ditulis ulang), `MenuPajakUxRcS87_4.test.ts` (bagian test layar diganti ke desain baru; test service tidak berubah).

**Verifikasi:** `tsc --noEmit` 0 error; 20 suite terkait — 502/502 lulus; build Android sukses. Tidak ada perubahan perhitungan, jurnal, atau skema.

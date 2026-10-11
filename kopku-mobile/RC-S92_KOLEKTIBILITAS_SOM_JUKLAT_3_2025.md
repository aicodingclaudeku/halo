# RC-S92 — Kolektibilitas SOM Juklat 3/2025 + Fiskal PMK 74/2024

## Permintaan

Buat kolektibilitas sesuai Juklat SOM No. 3/2025 **sesuai naskah PDF resmi**
dan PMK 74, dengan UI/UX yang profesional & rapi.

Sesi ini menyelesaikan bagian yang RC-S89 tinggalkan (ambang bulan relatif
masa angsuran, kriteria kualitatif, aturan 21 bulan), lalu **dikoreksi
terhadap naskah resmi** setelah naskahnya tersedia.

## Sumber: naskah resmi, dikutip

Naskah `Petunjuk Pelaksanaan SOM_2025` (Deputi Bidang Pengawasan Koperasi
No. 3/2025) dibaca langsung. Dua bagian yang dipakai:

- **Angka 12.1 "Kriteria Pinjaman Bermasalah"** (hal. 42–43) — kriteria
  Kurang Lancar, Diragukan, Macet.
- **Angka 15 "Contoh Perhitungan Taksiran Piutang Tak Tertagih (Cadangan
  Risiko)"** (hal. 86) — persentase pencadangan.

Naskah HANYA mendefinisikan tiga kategori bermasalah; **Lancar** adalah
sisanya. Tidak ada kategori "Dalam Perhatian (Khusus)" — itu istilah
perbankan (POJK kualitas aset bank umum/BPR).

## TIGA KOREKSI TERHADAP IMPLEMENTASI SEBELUM NASKAH DIBACA

Implementasi awal sesi ini ditulis dari rumusan SOM KSP yang saya ingat,
karena `jdih.kop.go.id` diblokir kebijakan jaringan. Setelah naskahnya
dibaca, **tiga hal terbukti salah dan sudah diperbaiki**:

### 1. Persentase pencadangan — salah jauh

Naskah angka 15 memberi contoh perhitungan dengan persentase:

| Kategori      | SOM angka 15 | yang sebelumnya saya pakai | PMK 74/2024 (fiskal) |
|---------------|--------------|----------------------------|----------------------|
| Lancar        | **0%**       | 0,5%                       | 0,5%                 |
| Kurang Lancar | **50%**      | 10%                        | 10%                  |
| Diragukan     | **75%**      | 50%                        | 50%                  |
| Macet         | **100%**     | 100%                       | 100%                 |

Saya sebelumnya menyamakan persentase SOM dengan PMK 74. Itu keliru: SOM
mengatur **kehati-hatian pencadangan koperasi**, PMK 74 mengatur **batas
maksimum yang boleh dikurangkan dari penghasilan bruto untuk pajak**.
Cadangan SOM lazim jauh MELEBIHI batas fiskal, dan selisihnya adalah
koreksi fiskal positif di SPT Badan. Contoh naskah direproduksi persis oleh
test (`131.250.000` dari portofolio 300/100/75/25 juta).

Konsekuensi: pinjaman **Lancar tidak dicadangkan sama sekali** menurut SOM,
sementara cadangan pinjaman bermasalah **naik tajam** (Kurang Lancar 10% →
50%, Diragukan 50% → 75%).

### 2. Kriteria Diragukan — dua rasio berbeda, bukan satu

Naskah angka 12.1 butir 2) berbunyi:

> a. Pinjaman masih dapat diselamatkan dan **ANGSURANNYA** bernilai
>    sekurang-kurangnya **75%** dari utang peminjam **termasuk bunganya**;
>    atau
> b. Pinjaman tidak dapat diselamatkan tetapi **AGUNANNYA** masih bernilai
>    sekurang-kurangnya **100%** dari utang peminjam.

Saya sebelumnya menerapkan "agunan ≥ 75%" — menggabungkan dua kriteria yang
mengukur hal berbeda dan memakai ambang yang salah untuk agunan. Sekarang
keduanya dinilai terpisah, dan **salah satu** cukup:

- huruf a: angsuran pokok + bunga yang sudah **dibayar** ≥ 75% dari
  kewajiban **kontraktual** (pokok + bunga sepanjang jadwal). Rasio ini
  mengukur kemajuan pembayaran, jadi penyebutnya kewajiban penuh.
- huruf b: nilai agunan ≥ 100% dari **sisa** utang (pokok + jasa
  outstanding). Kecukupan agunan diukur terhadap eksposur yang masih ada.

Denda tidak ikut di kedua rasio: denda bukan bagian dari "utang peminjam
termasuk bunganya", dan memasukkannya justru mengecilkan rasio kemajuan
pembayaran pada pinjaman yang menunggak.

Ada test khusus yang mengunci koreksi ini: agunan 75% **tidak lagi** cukup
untuk Diragukan.

### 3. Kelompok masa angsuran — bunyi naskah berbeda

Naskah menulis kelompok tengah sebagai masa angsuran **"2 bulan sampai 3
bulan"**, bukan "bulanan, 2 bulanan atau 3 bulanan" seperti rumusan versi
sebelumnya yang saya pakai. Ini memunculkan celah naskah — lihat bagian
berikutnya.

## Kriteria yang diimplementasikan

**Kurang Lancar** — tunggakan POKOK (pinjaman dengan angsuran):

| Masa angsuran        | Kurang Lancar bila tunggakan pokok |
|----------------------|------------------------------------|
| kurang dari 1 bulan  | melampaui 1 s/d 2 bulan            |
| 2 bulan s/d 3 bulan  | melampaui 3 s/d 6 bulan            |
| 6 bulan atau lebih   | melampaui 6 s/d 12 bulan           |

Tunggakan BUNGA: melampaui 1 s/d 3 bulan (masa angsuran < 1 bulan), atau
melampaui 3 s/d 6 bulan (masa angsuran > 1 bulan). Pokok & bunga dinilai
terpisah, yang **terburuk** menentukan.

**Tanpa angsuran**: belum jatuh tempo → tunggakan bunga melampaui 3 s/d 6
bulan; sudah jatuh tempo & belum dibayar → belum melampaui 3 bulan.

**Diragukan**: melewati batas atas Kurang Lancar DAN memenuhi huruf a ATAU
huruf b di atas.

**Macet**: (1) tidak memenuhi kriteria Kurang Lancar maupun Diragukan; atau
(2) Diragukan yang berlanjut 21 bulan tanpa pelunasan; atau (3) diserahkan
ke Pengadilan Negeri / diajukan permohonan ganti rugi ke perusahaan
asuransi kredit.

## DUA CELAH NASKAH & KEPUTUSAN PENAFSIRANNYA

Kriteria tunggakan pokok menyebut "kurang dari 1 bulan", "2 bulan sampai 3
bulan", dan "6 bulan atau lebih". **Dua rentang tidak disebut sama sekali**:

1. masa angsuran **tepat 1 bulan** (pinjaman bulanan) — bentuk pinjaman
   paling umum di KSP, dan satuan tenor `BULAN` di aplikasi ini;
2. masa angsuran di atas 3 bulan tetapi di bawah 6 bulan.

Kriteria bunga punya celah yang sama pada masa angsuran tepat 1 bulan
("kurang dari 1 bulan" vs "lebih dari 1 bulan").

**Keputusan**: keduanya ditempatkan di kelompok `SATU_SAMPAI_3_BULAN`
(ambang 3/6 bulan). Alasan: membiarkan pinjaman bulanan tanpa ambang bukan
pilihan; menempatkannya di kelompok "kurang dari 1 bulan" (ambang 1/2 bulan)
akan memperlakukan pinjaman bulanan lebih keras daripada pinjaman 2-bulanan
yang jelas lebih jarang angsurannya — hasil yang tidak mungkin dimaksudkan;
dan rumusan SOM versi sebelumnya memang menyebut kelompok ini "bulanan, 2
bulanan atau 3 bulanan". Rentang 4–5 bulan diberi ambang yang lebih pendek
(3/6, bukan 6/12) sebagai bacaan konservatif.

**Ini penafsiran, bukan kutipan.** Kalau pengawas menghendaki penempatan
lain, yang perlu diubah hanya `kelompokMasaAngsuran()`, dan ada test yang
mengunci penempatan sekarang supaya tidak berubah tanpa sengaja.

## Satu lagi yang tidak dapat diotomatiskan

Naskah membungkus kedua kriteria Diragukan dengan penilaian kualitatif
"masih dapat diselamatkan" / "tidak dapat diselamatkan". Itu pertimbangan
pengurus dan tidak ada datanya di aplikasi, jadi yang diuji hanya bagian
**terukur** (rasio 75% dan 100%). Akibatnya penggolongan bisa lebih ringan
daripada penilaian pengurus yang menyimpulkan pinjaman tidak dapat
diselamatkan meski rasionya memenuhi. Karena itu `dasarPenggolongan`
menyebut rasio yang dipakai, supaya pengurus bisa menilai ulang.

## Dampak angka (disengaja, bukan regresi)

- Kategori "Dalam Perhatian" tidak ada lagi; pinjaman yang menunggak tetapi
  belum melampaui ambang bawah Kurang Lancar berstatus **Lancar**.
- Pencadangan: 0 / 50 / 75 / 100 (sebelumnya 0,5 / 5 / 15 / 50 / 100).
  Pinjaman Lancar tidak lagi dicadangkan; pinjaman bermasalah dicadangkan
  jauh lebih besar.
- Titik **non-accrual tidak bergeser** (tetap 90 hari): kebijakan itu sudah
  dinyatakan langsung dalam HARI di `accounting/NonAccrualPolicy.ts`.

## Keputusan desain

**Aturan 21 bulan diturunkan, tidak disimpan.** Tanggal "mulai digolongkan
Diragukan" = usia tunggakan dikurangi batas atas Kurang Lancar, karena
pinjaman melewati batas itu tepat saat usia tunggakannya menyentuhnya. Tanpa
tabel/kolom/migrasi baru. Bonus: kalau ada pelunasan yang menutup angsuran
tertua, usia tunggakan otomatis mengecil dan hitungan 21 bulan ikut mundur —
persis bunyi "belum ada pelunasan".

**Pola pengembalian diturunkan dari jumlah angsuran kontraktual** (baris
jadwal non-obsolete, TERMASUK yang sudah LUNAS). Satu baris = sekali bayar
di jatuh tempo. Menghitung hanya baris *current* akan salah mengenali
pinjaman 12 angsuran yang 11-nya sudah lunas sebagai pinjaman tanpa
angsuran, sehingga ambang yang dipakai ikut salah.

**Kriteria Macet angka 3** tidak ada kolomnya di basis data, jadi pemanggil
dari database selalu mengirim `false`. Parameternya tetap ada di mesin aturan
supaya kriteria peraturannya lengkap & teruji.

**Satu mesin, bukan dua.** `KolektibilitasSomService.ts` adalah mesin ATURAN
murni (tanpa import database — bisa diuji dengan angka, dan boleh dipakai
builder export yang tidak boleh menarik modul native).
`LoanImpairmentService.ts` tetap satu-satunya tempat aging & saldo dihitung
dari `angsuran_jadwal`, lalu memanggil mesin itu.

## Berkas baru

- **`src/services/KolektibilitasSomService.ts`** — mesin aturan SOM. Header
  memuat kutipan naskah angka 12.1 & 15 apa adanya, plus dokumentasi kedua
  celah naskah. Konstanta: `AMBANG_SOM`, `AMBANG_SOM_TANPA_ANGSURAN`,
  `PERSENTASE_PENYISIHAN_SOM`, `RASIO_ANGSURAN_MINIMUM_DIRAGUKAN` (75),
  `RASIO_AGUNAN_MINIMUM_DIRAGUKAN` (100),
  `BULAN_DIRAGUKAN_MENJADI_MACET` (21). Fungsi: `klasifikasikanSom()`,
  `bulanPenuhAntara()` (bulan KALENDER penuh, bukan hari dibagi 30),
  `hitungPenyisihanSom()`. Tiap hasil membawa `dasarPenggolongan` — kalimat
  yang menyebut kriteria SOM mana yang memicu kategorinya, lengkap dengan
  nomor butirnya.
- **`src/theme/kolektibilitas.ts`** — satu sumber warna kategori.
  Sebelumnya layar Kolektibilitas Piutang dan Detail Anggota punya peta
  warna masing-masing dengan hex berbeda untuk kategori yang SAMA.
- **`src/__tests__/KolektibilitasSomService.test.ts`** — 27 test, termasuk
  reproduksi persis contoh perhitungan naskah angka 15.

## Berkas diubah

- **`src/services/LoanImpairmentService.ts`** — penggolongan didelegasikan
  ke mesin SOM. Query aging diperluas dalam SATU perjalanan ke database:
  tunggakan pokok & bunga dipisah, jumlah angsuran kontraktual, satuan
  tenor, saldo jasa, angsuran terbayar, kewajiban kontraktual, dan nilai
  agunan (subquery berkorelasi — bukan JOIN kedua, yang akan mengalikan
  baris jadwal × baris agunan dan menggelembungkan seluruh SUM saldo).
  Tambahan `ringkasKualitasPinjaman()` (rasio pinjaman bermasalah).
  `klasifikasikanKolektibilitas()` dihapus.
- **`src/services/KolektibilitasFiskalService.ts`** —
  `PETA_KATEGORI_KE_FISKAL` menjadi identitas (kategori SOM & PMK 74 sama).
  Sekarang ada DUA sumber selisih buku vs fiskal: persentase (50% vs 10%
  dst.) dan dasar pengenaan (agunan sebagai pengurang fiskal).
- **`src/screens/Laporan/KolektibilitasPiutangScreen.tsx`** — dirancang
  ulang (lihat bagian UI/UX).
- **`src/export/ReportTableBuilders.ts`** — label/urutan kategori diimpor
  dari mesin aturan, tidak ditulis ulang. Kolom ditambah: pola
  pengembalian, tunggakan pokok & bunga (bulan), angsuran terbayar, rasio
  angsuran, nilai agunan, rasio agunan, dasar penggolongan. Ringkasan
  ditambah rasio pinjaman bermasalah & baris dasar peraturan bernomor butir.
- **`src/services/AccountingPolicyService.ts`** — daftar & urutan
  kolektibilitas mengikuti `KOLEKTIBILITAS_URUT`, bukan daftar literal kedua.
- **`src/screens/Anggota/AnggotaDetailScreen.tsx`** — peta warna lokal
  diganti `theme/kolektibilitas`.
- **`src/accounting/NonAccrualPolicy.ts`** — catatan bahwa skema 5 kategori
  yang diceritakan di bagian "MASALAH YANG DISELESAIKAN" sudah tidak ada,
  dan peralihan ke SOM tidak menggeser titik non-accrual.
- Test yang menyesuaikan: `LoanImpairmentService.test.ts` (+1 test:
  pinjaman berangsuran memakai ambang bulan, bukan ambang pinjaman tanpa
  angsuran), `KolektibilitasFiskalService.test.ts` (+1 test: agunan
  memperlebar selisih karena hanya mengurangi dasar fiskal),
  `KolektibilitasAnggota.test.ts`, `NonAccrualPolicy.test.ts`,
  `ReportTableBuilders.test.ts`.

## UI/UX layar Kolektibilitas Piutang

Disusun mengikuti urutan pertanyaan yang benar-benar dijawab pengurus:

1. **Periode & lingkup anggota** — segmented control satu wadah berbingkai,
   bukan tiga pil terpisah.
2. **Kartu Kualitas Portofolio** — outstanding + jumlah pinjaman; **Rasio
   Pinjaman Bermasalah** dengan meter terhadap acuan 5% (penanda acuan
   berupa garis tipis, sehingga posisinya tetap terlihat baik saat rasio di
   bawah maupun sudah melewatinya) + pil status; bar komposisi 4 kategori.
3. **Penggolongan SOM** — SELURUH 4 kategori selalu ditampilkan termasuk
   yang kosong (diredam warnanya): ini laporan pengawasan, "Macet: 0
   pinjaman" adalah informasi. Baris bisa ditekan untuk memfilter daftar;
   kategori kosong tidak bisa ditekan.
4. **Taksiran Piutang Tak Tertagih** — target (SOM angka 15) vs tercatat di
   buku besar, banner selisih, tombol Sesuaikan Penyisihan.
5. **Batasan fiskal PMK 74** — kartunya sendiri: total diakui fiskal, agunan
   sebagai pengurang, banner **arah koreksi fiskal** dengan kalimat penuh,
   dan tabel ringkas per kategori.
6. **Dasar Penggolongan & Pencadangan** — panel yang bisa dilipat, memuat
   kriteria SOM angka 12.1, persentase angka 15, dan batasan PMK 74; seluruh
   angkanya dibaca dari konstanta service, tidak ditulis ulang di layar.
7. **Rincian per pinjaman** — baris tetap bisa dipindai sekilas (nama, badge
   kategori + %, badge rasio agunan & rasio terbayar, saldo pokok,
   penyisihan); satu tap membuka panel rincian berisi `dasarPenggolongan`
   dan seluruh masukan SOM, termasuk kedua rasio kriteria Diragukan beserta
   ambangnya masing-masing.
8. **Empty state terpisah** untuk "belum ada piutang" dan "pencarian/filter
   tidak menemukan apa pun".

Angka ringkasan dihitung `ringkasKualitasPinjaman()` di service (di-`useMemo`),
bukan dijumlah ulang di layar — supaya angka kartu, daftar, dan export
mustahil berbeda.

## Verifikasi

Dijalankan dengan **Jest & TypeScript asli** (`npm install` berhasil di
lingkungan ini — bukan harness):

- `npx tsc --noEmit` — **0 error**.
- `npx jest` (SELURUH suite): **285 suite lulus / 292**, **5.476 test lulus**,
  5 gagal.
- 7 suite yang gagal **SELURUHNYA PRA-EKSIS** dan tidak satu pun menyentuh
  kolektibilitas: `KontrolAkhirRcS53`, `PolicyRegisterRcS53`,
  `PendapatanKoperasiRcS67`, `PendapatanBungaCoaRcS70_6`,
  `ImbalHasilTetapRcS67_6`, `ReleaseHardeningRcS57`, `TemporalIntegrityRcS58`.
  Semuanya test STRUKTURAL yang membaca dokumen markdown di root yang tidak
  ikut dalam arsip source (`POLICY_DECISION_RC-S53.md`,
  `POLICY_REGISTER_RC-S53.md`, `RC-S58_DEVICE_QA_CHECKLIST.md`,
  `RC-S57_AKRUAL_BUNGA_UTANG_ARCHITECTURE.md`) — daftar yang sama sudah
  dicatat RC-S89.
- Suite kolektibilitas: `KolektibilitasSomService` 27/27, ditambah
  `LoanImpairmentService`, `KolektibilitasFiskalService`,
  `KolektibilitasAnggota`, `NonAccrualPolicy`, `ReportTableBuilders` —
  95 test, semua lulus.

## Di luar cakupan (tidak dikerjakan)

- Kolom/flag "diserahkan ke Pengadilan Negeri / klaim asuransi kredit" di
  tabel `pinjaman` beserta form pengisiannya. Mesin aturannya sudah
  menerima & menguji kriteria ini; yang belum ada tempat menyimpannya.
- Penilaian kualitatif "dapat diselamatkan / tidak dapat diselamatkan" pada
  kriteria Diragukan — lihat bagian "Satu lagi yang tidak dapat
  diotomatiskan".
- Menyambungkan laporan cadangan fiskal ke modul Pajak Badan/SPT
  (`PajakBadanRcS87`) — masih layar terpisah untuk dibaca manual saat
  menyusun koreksi fiskal.
- Batas 5% pada meter rasio pinjaman bermasalah adalah acuan PENYAJIAN saja.
  Ia tidak memengaruhi penggolongan, pencadangan, atau jurnal apa pun, dan
  bukan skor penilaian kesehatan koperasi (naskah angka 13 memuat aspek
  penilaian kesehatan tersendiri yang tidak diimplementasikan sesi ini).

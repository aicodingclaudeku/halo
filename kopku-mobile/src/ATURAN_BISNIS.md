# Aturan Bisnis KOPKU — Dokumentasi Internal

Dokumen ini menjelaskan **mengapa** aturan berikut ada, bukan sekadar
apa isinya. Setiap kali sebuah aturan dipindahkan ke satu sumber
kebenaran, alasannya dicatat di sini supaya perubahan berikutnya tidak
mengembalikan duplikasi yang sudah dihapus.

Cakupan dokumen ini terbatas pada aturan yang **sudah** disentralisasi.
Status setiap temuan dikunci di **Lampiran B — Final Bug Status**; arti
tiap label ada di **Lampiran A**. Hal yang memang belum final ditandai
eksplisit di **§9**.

Dokumen ini adalah **snapshot final release candidate**, bukan histori
status lama. Bila satu section bertentangan dengan Lampiran B, Lampiran
B yang berlaku dan section-nya harus diperbaiki.

---

## 1. Siklus hidup koneksi database (BUG-01)

**Sumber kebenaran:** `src/database/db.ts` →
`configureDatabaseConnection()` dan `assertForeignKeysEnabled()`.

`PRAGMA foreign_keys` di SQLite adalah setting **per-koneksi** dengan
default OFF, bukan properti file database. Sebelum perbaikan, satu-satunya
tempat pragma itu muncul adalah di dalam `CREATE_TABLES_SQL`, yang:

1. hanya dieksekusi pada jalur fresh install (`currentVersion === 0`), dan
2. dijalankan di dalam transaksi, sehingga SQLite mengabaikannya.

Artinya FK enforcement praktis **tidak pernah aktif**, termasuk pada
launch pertama. Database produksi bisa menerima orphan record tanpa
penolakan.

**Aturan sekarang:** setiap koneksi wajib melewati
`configureDatabaseConnection()` sebelum dipakai. Assertion-nya sengaja
melempar error (bukan `console.warn`) karena FK OFF membatalkan seluruh
jaminan integritas referensial — itu kondisi yang harus menghentikan
aplikasi, bukan sekadar dicatat.

**Satu-satunya pengecualian:** blok migrasi legacy di `runMigrations()`.
Delapan migrasi memakai prosedur rebuild tabel resmi SQLite
(`CREATE ..._new` → `INSERT SELECT` → `DROP TABLE` → `RENAME`). Dengan FK
ON, `DROP TABLE` melakukan DELETE implisit yang **memicu ON DELETE
CASCADE** pada tabel anak — rebuild `angsuran_jadwal` akan menghapus
seluruh `angsuran_pembayaran`. Karena itu FK dimatikan hanya selama blok
tersebut, lalu dinyalakan kembali dan dibuktikan bersih dengan
`PRAGMA foreign_key_check`. Migrasi yang meninggalkan orphan record
menggagalkan `getDb()`, tidak dibiarkan lewat.

---

## 2. Siklus hidup jadwal angsuran (BUG-08, BUG-12)

**Sumber kebenaran:** `src/accounting/ScheduleLifecycle.ts`.

```
BELUM_BAYAR / SEBAGIAN / TERLAMBAT  -> CURRENT   (tagihan hidup)
LUNAS                               -> COMPLETED (selesai, sisa 0)
DIRESTRUKTURISASI / DIHAPUSBUKU     -> OBSOLETE  (tidak pernah dihitung lagi)
```

Baris OBSOLETE **sengaja tidak dihapus** dari database karena dibutuhkan
untuk jejak audit dan rekonsiliasi historis. Konsekuensinya:
pengecualiannya harus terjadi di setiap query, dan karena itulah aturannya
wajib berasal dari satu tempat.

**Kenapa aturan ini ada** *(temuan historis — sudah diperbaiki)*:
sebelum sentralisasi, lima modul menulis filternya sendiri dan dua di
antaranya (`LoanEligibilityService`, `AkrualJasaPinjamanService`) tidak
menyaring sama sekali. Satu pinjaman 12.000.000 yang direstrukturisasi
dua kali terbaca 12M → 24M → 38,88M karena jadwal lama dan penggantinya
dijumlahkan bersama. Itulah titik divergensi pertama antara subledger dan
GL: outstanding, aging, impairment, eligibility, akrual, dan LHU bisa
menghasilkan angka berbeda untuk data yang sama.

Paragraf di atas menjelaskan **asal-usul** aturan, bukan keadaan source
saat ini. Seluruh jalur sekarang memakai helper terpusat di bawah
(BUG-08/BUG-12 = FIXED, lihat Lampiran B).

**Bentuk yang dipakai:**

| Konteks | Helper | Alasan |
|---|---|---|
| Aging, tunggakan, kolektibilitas | `sqlJadwalCurrent()` | Baris LUNAS memang harus keluar |
| Penjumlahan saldo/outstanding | `sqlJadwalBukanObsolete()` | LUNAS menyumbang 0, aman ikut; total kontraktual tetap utuh |
| Sisa tagihan | `sqlJadwalMasihTertagih()` | Menggantikan pola lama `NOT IN ('LUNAS','DIHAPUSBUKU','DIRESTRUKTURISASI')` |

### Catatan `TERLAMBAT`

**Aturan berlaku:** `TERLAMBAT` sah menurut CHECK constraint
`angsuran_jadwal.status` meskipun aplikasi saat ini tidak pernah
menulisnya (keterlambatan diturunkan dari tanggal jatuh tempo); data
legacy/import bisa memilikinya. Ia dikategorikan **CURRENT** karena
merepresentasikan tagihan yang masih hidup.

`TERLAMBAT` **tidak** otomatis obsolete. Yang membuat sebuah baris
menjadi obsolete adalah **event**, bukan statusnya:

```
TERLAMBAT
  -> CURRENT selama belum ada event restrukturisasi/write-off
  -> ketika event tersebut terjadi, baris lama (termasuk yang
     TERLAMBAT) ditandai DIRESTRUKTURISASI / DIHAPUSBUKU oleh
     event itu — bukan dihapus, bukan di-reset menjadi LUNAS
```

**Temuan historis — sudah diperbaiki.** Pada implementasi lama,
`akadUlangPinjaman()` dan `hapusPiutangPinjaman()` memakai daftar status
hardcoded `('BELUM_BAYAR','SEBAGIAN')` yang melewatkan `TERLAMBAT`,
sehingga baris lama bisa tetap dianggap current sementara jadwal
pengganti sudah dibuat — persis mekanisme double-count di atas.

Sudah diperbaiki lewat aturan lifecycle terpusat:
`akadUlangPinjaman()` memakai
`ScheduleLifecycle.isScheduleObsoleteForRestructuring()`, dan
`hapusPiutangPinjaman()` memakai `sqlJadwalCurrent()`. Tidak ada lagi
daftar status yang diketik ulang di kedua fungsi itu. Regresinya dikunci
`RestrukturisasiSingleSourceOfTruth.test.ts` (§C), yang membuktikan
`TERLAMBAT` diperlakukan CURRENT, ditandai `DIRESTRUKTURISASI` saat
restrukturisasi, dan `DIHAPUSBUKU` saat write-off dengan outstanding
menjadi 0.

**Jangan membaca paragraf ini sebagai defect yang masih terbuka.**

---

## 3. Pelaporan historis vs akun aktif (BUG-04)

**Sumber kebenaran:** `src/reports/FinancialReports.ts` →
`getAkunKasBankUntukLaporan()`.

Ada dua pertanyaan berbeda yang sebelumnya dijawab satu kolom:

- *"Boleh dipakai untuk transaksi baru?"* → `is_active` / `aktif`.
  Tempatnya di picker transaksi (`resolveKasBankAccountId`).
- *"Pernah punya transaksi pada periode ini?"* → eksistensi
  `journal_entry` pada rentang tanggal. Tempatnya di laporan.

Menonaktifkan rekening bank sebelumnya menghapus seluruh histori kasnya
dari Arus Kas, **termasuk kas awal dan kas akhir**. Akibatnya laporan
periode lampau yang sudah dicetak berubah angkanya hari ini hanya karena
status rekening diubah, dan Arus Kas tidak lagi bisa direkonsiliasi
dengan Neraca Saldo.

**Aturan:** laporan historis tidak boleh membaca status aktif. Akun
nonaktif tetap muncul selama punya jurnal pada periode laporan.

---

## 4. Kompatibilitas backup (BUG-11)

**Sumber kebenaran:** `src/backup/BackupValidator.ts`.

```
schema backup <  aplikasi  -> DITERIMA (dimigrasikan setelah restore)
schema backup == aplikasi  -> DITERIMA
schema backup >  aplikasi  -> HARD REJECT
metadata versi hilang      -> HARD REJECT
pelanggaran foreign key    -> HARD REJECT
```

**Kenapa hard reject, bukan warning:** aplikasi versi lama tetap *bisa*
membuka database versi baru — membaca sebagian kolom dan menulis baris
tanpa mengisi kolom wajib yang belum dikenalnya. Hasilnya database yang
secara struktur valid tetapi secara akuntansi rusak, dan kerusakannya baru
ketahuan berbulan-bulan kemudian. Menolak restore jauh lebih murah
daripada memperbaiki buku besar yang sudah tercemar. Aturan yang sama
diterapkan di `runMigrations()` untuk database yang dibuka langsung.

`PRAGMA integrity_check` hanya menguji struktur B-tree, bukan konsistensi
referensi — karena itu `PRAGMA foreign_key_check` diperiksa terpisah.

---

## 5. Rekonsiliasi tidak boleh silent zero (BUG-14)

**Contoh yang diperbaiki:** `PenyusutanService.auditRekonsiliasiPenyusutan()`.

Pola `catch { return 0; }` pada fungsi rekonsiliasi berbahaya karena
fungsi itu justru dibuat untuk **mendeteksi** masalah. Kalau mapping COA
akumulasi penyusutan hilang, saldo GL dilaporkan 0; bila subledger
kebetulan juga 0, audit menyimpulkan `seimbang: true` padahal
konfigurasinya rusak total.

**Aturan pembeda:**

- *Legitimate empty* — tidak ada aset/subledger pada kategori tersebut
  (mis. koperasi tanpa aset tak berwujud). Mapping memang tidak relevan;
  saldo 0 adalah jawaban yang benar.
- *Configuration failure* — ada aktivitas tetapi mappingnya hilang.
  **Wajib gagal keras**, dengan pesan yang menyebut mapping mana, role
  apa, dan tindakan perbaikannya.

"Ada aktivitas" ditentukan dari subledger **maupun** daftar aset yang
seharusnya disusutkan, supaya kasus "jurnal tidak pernah terposting
karena mappingnya hilang" (subledger 0, aset ada) tetap terdeteksi.

---

## 6. Kueri saldo massal (BUG-15)

**Sumber kebenaran:** `src/accounting/AccountingEngine.ts` →
`getAccountBalancesBulk()`.

Semantiknya **wajib identik** dengan `getAccountBalance()` — termasuk
memasukkan jurnal `REVERSED` dan menghormati `normal_balance`. Kalau
keduanya berbeda, Arus Kas tidak akan pernah rekonsiliasi dengan Neraca
Saldo. Ada test yang mengunci kesetaraan ini per akun; jangan ubah salah
satu tanpa mengubah keduanya.

Kondisi status/tanggal ditaruh di klausa `ON`, bukan `WHERE`, supaya akun
tanpa jurnal tetap dikembalikan dengan saldo 0 alih-alih hilang dari
hasil. `SUM(CASE WHEN j.id IS NOT NULL ...)` diperlukan agar entri yang
jurnalnya tersaring (VOID / di luar tanggal) tidak ikut terjumlah.

---

## 7. Kebijakan non-accrual (Sesi 2)

**Sumber kebenaran:** `src/accounting/NonAccrualPolicy.ts` →
`getAccrualStatus()`.

Titik non-accrual sebelumnya adalah **efek samping** dari dua tabel
ambang yang berbeda: `klasifikasikanKolektibilitas()` (1/91/121/181
hari) dikombinasikan dengan boundary kategori (default `DIRAGUKAN`).
Hasilnya non-accrual efektif jatuh di **121 hari** — angka yang tidak
pernah tertulis di mana pun sebagai kebijakan.

Sekarang dinyatakan langsung dalam hari: **0–89 ACCRUAL, ≥90
NON_ACCRUAL**, dan tetap dapat dikonfigurasi admin
(`getNonAccrualMinHariTunggakan`, default 90).

**Ini perubahan kebijakan, bukan refactor.** Pinjaman menunggak 90–120
hari yang dulu masih mengakui pendapatan jasa sekarang berhenti
mengakuinya. Pendapatan periode berjalan untuk rentang itu turun.

Pemisahan yang dikunci: 91–120 hari adalah `KURANG_LANCAR` untuk
**pencadangan**, tetapi sudah `NON_ACCRUAL` untuk **pengakuan
pendapatan**. Dua keputusan bisnis berbeda, dua ambang berbeda.

---

## 8. Tanggal angsuran & maturity (BUG-13, Sesi 2)

**Sumber kebenaran:** `src/accounting/InstallmentDate.ts` →
`calculateInstallmentDate()` / `calculateMaturityDate()`.

Sebelumnya satu fungsi memakai dua algoritma sekaligus: header
(`origin + tenor`, sekali lompat) dan jadwal (`hasil sebelumnya + 1`,
iteratif). Untuk satuan BULAN keduanya berbeda karena clamping akhir
bulan menjadi basis langkah berikutnya:

```
iteratif : 31 Jan -> 28 Feb -> 28 Mar -> 28 Apr -> ... -> 28 Jan
benar    : 31 Jan -> 28 Feb -> 31 Mar -> 30 Apr -> ... -> 31 Jan
```

Akibatnya `pinjaman.tanggal_jatuh_tempo` bisa tidak sama dengan
`MAX(angsuran_jadwal.tanggal_jatuh_tempo)`, dan seluruh aging/denda
angsuran tengah bergeser beberapa hari.

**Konvensi:** end-of-month anchored — setiap tanggal dihitung relatif
terhadap tanggal akad + nomor angsuran, tidak pernah relatif terhadap
hasil sebelumnya. `tambahTenor()` dihapus.

**Invarian:** header maturity = angsuran terakhir jadwal **current**
(bukan MAX seluruh baris — jadwal obsolete hasil akad ulang lama punya
tanggal lebih jauh dan tidak boleh diikuti header).

---

## 9. Yang belum final

Section ini tetap ada dengan fungsi aslinya: menandai hal yang **memang
belum selesai**, supaya tidak disangka beres. Isinya sekarang berubah
karena seluruh BUG-01…BUG-15 dan GAP-CASHFLOW sudah punya implementasi
plus bukti regresi — daftar bug di sini sudah kosong (register lengkap
ada di **Lampiran B**).

Yang tersisa bukan lagi cacat source, melainkan **verifikasi operasional**
yang tidak dapat dijalankan di environment pengembangan. Bedanya penting:
source-nya sudah benar dan teruji, yang belum ada adalah pembuktian pada
environment sasaran.

### Verification yang masih tertunda

**1. Migrasi native `expo-sqlite`**

```
Status : NOT VERIFIED
Alasan : environment/sandbox tidak dapat menjalankan native Expo module.
```

`FullMigration.test.ts` menjalankan `runMigrations()` di atas **sql.js**
dengan `expo-sqlite` dan `expo-crypto` di-mock — itu membuktikan
*urutan dan isi* migrasinya konsisten, **bukan** perilakunya di driver
native. sql.js/sandbox **tidak dianggap pengganti** verifikasi native.

```
Release gate:
v1 -> schema saat ini WAJIB diuji pada environment Expo/native
sebelum migrasi boleh dinyatakan PASS.
```

Ini **bukan** pernyataan bahwa migrasi gagal. Statusnya NOT VERIFIED.

**2. Nilai `sumber_transaksi` historis di database produksi**

```
Status : NOT VERIFIED
Alasan : database produksi/release candidate belum tersedia untuk
         audit read-only.
```

Classifier-nya sendiri sudah VERIFIED (lihat §13). Yang belum diperiksa
adalah apakah baris `journal` lama di database produksi seluruhnya
memakai `sumber_transaksi` yang terdaftar di peta. Dua hal berbeda:
**klasifikasi source** vs **nilai data historis**.

## 10. Deferred income jasa futura (BUG-09) — TERIMPLEMENTASI

**Status: FIXED / IMPLEMENTED.** Ini status final; tidak ada bagian
dokumen ini yang boleh menyebutnya pending, TODO, atau open.

**Kebijakan: OPSI B.** Jasa futura tetap diakui sebagai liabilitas dan
dilepas menjadi pendapatan periode demi periode mengikuti tanggal jatuh
tempo jadwal aslinya.

**Sumber kebenaran subledger:** `angsuran_jadwal.jasa_dimuka`.
**Akun GL:** `2-1300` Pendapatan Diterima Dimuka.
**Mesin pelepasan:** `AkrualJasaPinjamanService`.

Arti ketiga kolom jasa pada satu baris jadwal berbeda:

```
jasa           = jasa kontraktual periode itu
jasa_terbayar  = berapa yang kasnya sudah diterima
jasa_dimuka    = bagian dari jasa_terbayar yang BELUM earned
```

Invarian: `0 <= jasa_dimuka <= jasa_terbayar <= jasa`.
`jasa_dimuka` berarti **kas sudah diterima tetapi jasa belum earned** —
bukan "jasa belum dibayar".

### Alur

```
pelunasan dipercepat
  -> Cr 2-1300 (GL) DAN jasa_dimuka += porsi future (subledger), PER BARIS
  -> tiap periode jatuh tempo: Dr 2-1300 / Cr Pendapatan Jasa
  -> jasa_dimuka berkurang, sampai 0 di akhir periode jasa
```

Dicatat **per baris jadwal**, bukan ditumpuk di satu baris, supaya
pelepasannya bisa mengikuti tanggal masing-masing angsuran.

`lunasiPinjaman()` membandingkan total yang ditulis ke subledger dengan
nominal yang dikreditkan ke 2-1300 dan **menggagalkan seluruh transaksi**
bila berbeda. Liabilitas yang tidak bisa direkonsiliasi tidak boleh
lahir sejak awal.

**Batas pelunasan:** pelunasan dipercepat memindahkan jasa futura ke
liabilitas, bukan mengakuinya. Ia tidak boleh melahirkan pendapatan di
luar deferred service yang memang sudah menjadi earned — pengakuannya
tetap menunggu tanggal jatuh tempo masing-masing baris jadwal.

**Bukan kebijakan non-accrual.** `jasa_dimuka` berarti *kas sudah
diterima, jasa belum earned*. Kebijakan non-accrual (§7, ≥90 hari)
menjawab pertanyaan berbeda: *boleh tidak mengakui jasa yang kasnya
BELUM diterima pada pinjaman menunggak*. Dua mekanisme terpisah — jangan
dicampur, dan deferred income yang sudah diterima kasnya tidak otomatis
sama dengan accrual interest.

### Penemuan pinjaman

**Root cause aslinya:** seluruh penemuan memakai `p.status = 'AKTIF'`.
Setelah pelunasan status menjadi `LUNAS` dan pinjaman tidak pernah
diproses lagi, sehingga saldo 2-1300 mengendap permanen.

Kriteria yang benar bukan status pinjaman melainkan "masih adakah
pekerjaan akuntansi tersisa" — lihat `SQL_PINJAMAN_PERLU_PROSES_JASA`:
pinjaman AKTIF **atau** punya `jasa_dimuka > 0`.

### Periode tertutup

Pelepasan menghasilkan jurnal, jadi tunduk pada guard periode di
`createJournal()`. Penolakannya bersuara (alasan tercatat di
`dilewati`), dan karena seluruh proses berada dalam satu transaksi,
`jasa_dimuka` tidak berkurang ketika jurnalnya gagal.

### JASA_TERUTANG

Pada metode ini jasa masa depan **dirabat** — tidak ada kas yang
diterima, jadi tidak boleh ada deferred income sama sekali.

---

## 11. Akun 2-1300 menampung DUA objek akuntansi (temuan Sesi 3)

**Sumber kebenaran rekonsiliasi:**
`src/accounting/DeferredIncomeReconciliation.ts`.

```
GL 2-1300 = contractual deferred + EIR deferred

contractual deferred = SUM(angsuran_jadwal.jasa_dimuka)        [A]
                       atas baris BUKAN obsolete (§2)
EIR deferred         = SUM(sisa fee integral belum diamortisasi) [B]
```

**Akun GL yang sama bukan berarti subledger yang sama.** A dan B berbagi
satu akun GL tetapi punya subledger dan mesin pelepasan sendiri-sendiri;
masing-masing direkonsiliasi terhadap komponennya, bukan terhadap saldo
GL secara utuh. Karena itu `SUM(jasa_dimuka) = saldo GL 2-1300` **bukan**
invarian yang berlaku umum — ia hanya kebetulan benar pada koperasi yang
tidak memakai fee integral.

| | A — Jasa kontraktual | B — Fee integral (EIR) |
|---|---|---|
| Masuk | `ANGSURAN_JASA/KREDIT_DIMUKA`, `PELUNASAN_JASA_FUTURE/KREDIT_DIMUKA` | `BIAYA_ADMIN_PINJAMAN/KREDIT_DIMUKA` |
| Subledger | `angsuran_jadwal.jasa_dimuka` | `pinjaman_akuntansi_jasa` |
| Dilepas oleh | `AkrualJasaPinjamanService` | `EirAccountingService` |

Keduanya **tidak** saling menggandakan: jalur masuk, subledger, dan
mesin pelepasannya terpisah penuh. Tetapi saldo GL-nya menyatu, sehingga
rekonsiliasi yang hanya membandingkan `SUM(jasa_dimuka)` terhadap saldo
2-1300 akan selalu melaporkan selisih pada koperasi yang memakai fee
integral — dan orang akan menyimpulkan ada bug padahal tidak ada.
Karena itu kedua komponen dinyatakan eksplisit.

---

## 12. Controlled account (BUG-02)

**Status: FIXED.**

`resolveAccountId(transaction_type, role)` adalah satu-satunya jalan
memperoleh akun untuk posting. Ia **gagal keras**:

- mapping tidak ada → `MissingAccountMappingError`
- akun sudah dinonaktifkan → `InactiveAccountError`
- rekening bank nonaktif → `InactiveBankAccountError`

Tidak ada fallback, tidak ada akun default, tidak ada "akun pertama yang
ketemu". `akun_lawan_id` pada transaksi kas/bank **bukan** fallback — itu
akun yang dipilih pengguna secara eksplisit di formulir.

Perbedaan yang wajib dijaga: akun nonaktif **ditolak untuk transaksi
baru** tetapi **tetap terbaca di laporan historis** (lihat §3).

---

## 13. Klasifikasi arus kas (GAP-CASHFLOW)

**Sumber kebenaran:** `src/accounting/CashFlowClassification.ts`.

Klasifikasi Operasi/Investasi/Pendanaan diturunkan dari
`journal.sumber_transaksi` — taksonomi yang sama dengan `AccountMapping`
— **bukan** dari nama akun.

**Kenapa ini pernah berbahaya:** `classifyTransaction()` dulu berakhir
dengan `return 'OPERASI'` untuk sumber yang tidak terdaftar. Laporan
Arus Kas tetap terlihat seimbang karena totalnya tidak berubah — yang
salah cuma kolomnya. Laporan yang salah kolom tetapi balance jauh lebih
berbahaya daripada laporan yang menolak dibuat, karena tidak ada yang
akan menyadarinya. Enam sumber produksi jatuh diam-diam ke sana.

**Aturan sekarang:** klasifikasi eksplisit, sumber tak dikenal **gagal
keras**.

```
sumber terdaftar          -> OPERASI / INVESTASI / PENDANAAN
sumber ditandai NON_KAS   -> NonCashSourceOnCashLineError
                             (muncul di baris kas = klasifikasi atau
                              jurnalnya keliru, harus diperiksa manusia)
sumber tidak terdaftar    -> UnknownCashFlowClassificationError
```

`NON_KAS` bukan kategori keempat arus kas. Ia pernyataan eksplisit bahwa
jenis transaksi itu **memang tidak pernah** menyentuh Kas/Bank (akrual,
penyusutan, penyisihan, amortisasi). Dulu semuanya didaftarkan sebagai
`OPERASI` "untuk jaga-jaga", yang membuat mustahil membedakan "sudah
dipikirkan dan memang non-kas" dari "kebetulan jatuh ke default".

`fallbackKategori` (`classifyByAccountKategori`) **tetap ada** tetapi
bukan tebakan: ia aturan terdokumentasi yang hanya berlaku bila pemanggil
menyerahkannya. `getArusKas()` memanggil **tanpa** argumen itu, jadi
jalur laporan tidak punya jalan keluar diam-diam.

**Batas klaim:** yang VERIFIED adalah klasifikasi di source. Nilai
`sumber_transaksi` historis pada database produksi masih NOT VERIFIED
(§9). Classifier tidak boleh disebut rusak hanya karena produksi belum
diperiksa.

---

## 14. Invarian fee integral EIR (BUG-03)

**Sumber kebenaran:** `src/accounting/EirFeeInvariant.ts`.

Fee integral punya siklus hidupnya sendiri di `pinjaman_akuntansi_jasa`:

```
FEE_INTEGRAL_AMORTISASI  fee awal, ditulis sekali, tidak pernah berubah
EIR_MONTHLY              amortisasi bulanan
EIR_DERECOGNITION        penyelesaian sisa saat pelunasan dipercepat
                         / hapus buku
```

**Invarian:**

```
feeAwal = amortisasi + derecognition + sisaFee
sisaFee     >= 0
totalDiakui <= feeAwal          (totalDiakui = amortisasi + derecognition)
```

**Kenapa modul terpisah:** `getEirTersimpan()` menghitung sisa dengan
`Math.max(0, ...)`, yang **menyembunyikan** over-amortisasi — kalau total
amortisasi melampaui fee awal, sisanya dilaporkan 0 dan tidak ada yang
tahu. Fungsi di modul ini sengaja menghitung nilai mentah, boleh negatif,
supaya pelanggarannya terlihat. Pola yang sama dengan §5: fungsi yang
tugasnya mendeteksi masalah tidak boleh mengembalikan angka yang menutupi
masalah itu.

Baris `EIR_DERECOGNITION` **wajib** ikut dikurangkan untuk rekonsiliasi
GL — jurnalnya sudah mendebit 2-1300 sampai nol, jadi subledger yang
mengabaikannya melaporkan selisih palsu (lihat §11 komponen B).

---

## 15. Tanggal & periode penyusutan (BUG-05, BUG-06)

**Sumber kebenaran:** `src/services/PenyusutanService.ts`,
`src/services/AsetService.ts`.

**Penyusutan masa depan ditolak.** Tanpa penjaga ini, memanggil dengan
periode `2030-01` membuat `getOrCreatePeriodeUntukTanggal` **membuat**
periode akuntansi 2030 berstatus OPEN dan jurnalnya benar-benar
terposting — beban periode mendatang muncul di buku hari ini. Batasnya
adalah periode yang **belum dimulai**; periode berjalan tetap boleh.

**Penyusutan ke periode tertutup ditolak** lewat guard terpusat di
`createJournal()` (§17), bukan lewat pemeriksaan kedua yang diketik
ulang di sini.

**Tanggal transaksi ≠ tanggal perolehan.** Dua tanggal, dua peran:

```
tanggal           -> jurnal & periode akuntansi
tanggalPerolehan  -> register aset & titik mulai penyusutan
```

Dengan invarian `tanggalPerolehan <= tanggal` — aset tidak dapat
dibukukan sebelum diperoleh. Divalidasi bersama validasi input lain,
sebelum resolusi COA dan pengambilan nomor urut, supaya penolakan tidak
terjadi setelah ada efek yang terlanjur berjalan.

---

## 16. Idempotensi transaksi kas manual (BUG-07)

**Sumber kebenaran:** `src/services/KasBankService.ts`.

`idempotency_key` benar-benar dipakai pada jalur transaksi kas/bank, dan
diperiksa **sebelum** nomor urut diambil dan jurnal dibuat — bukan
sesudahnya. Event duplikat mengembalikan efek akuntansi yang sudah ada,
tidak melahirkan efek kedua.

Kuncinya opsional. Pemanggil yang tidak menyerahkannya berperilaku
seperti sebelumnya; tidak ada jalur yang dipaksa berubah.

---

## 17. Guard periode tertutup (BUG-10)

**Sumber kebenaran:** `AccountingEngine.assertAccountingPeriodOpen()` /
`ClosedPeriodError`.

Periode CLOSED tidak boleh dimutasi. Seluruh jalur yang menghasilkan
jurnal sudah tunduk otomatis lewat `createJournal()`.

**Yang diperbaiki:** mutasi yang **tidak** membuat jurnal. Akad ulang
hanya memutasi subledger — menandai jadwal lama `DIRESTRUKTURISASI` dan
menyisipkan penggantinya. Tidak ada uang berpindah, jadi guard di
`createJournal()` tidak pernah tersentuh, dan restrukturisasi bisa
mengubah periode yang sudah ditutup. Itu tetap merusak: outstanding,
aging, kolektibilitas, dan dasar pencadangan periode tersebut ikut
berubah padahal laporannya sudah final dan dibagikan.

**"Tidak ada jurnal" tidak berarti "tidak ada dampak akuntansi".**
Guardnya karena itu dipanggil eksplisit di jalur tersebut, memakai
helper terpusat yang **sama** dengan `createJournal` — bukan salinan
aturan kedua.

Cakupan BUG-10 berhenti di sini. Verifikasi migrasi native dan data
produksi (§9) **bukan** bagian dari BUG-10.

---

## 18. Simpanan Berjangka — siklus hidup penuh (Sesi S13-S14) — TERIMPLEMENTASI

Simpanan Berjangka (deposito anggota) adalah **kewajiban** koperasi,
bukan ekuitas, bukan pendapatan. Domainnya **terpisah penuh** dari
Simpanan Pokok/Wajib/Sukarela dan dari EIR pinjaman.

### 18.1 Kenapa subledger terpisah

`simpanan_transaksi` adalah buku transaksi **arus** (SETOR/TARIK/
KOREKSI) tanpa konsep kontrak — tidak punya tenor, jatuh tempo, rate,
maupun status siklus hidup. Simpanan berjangka justru sebaliknya: satu
baris = satu **kontrak**. Memaksakan `BERJANGKA` ke dalam CHECK `jenis`
akan (a) memaksa kolom yang selalu NULL untuk tiga jenis lain, dan
(b) membuat setiap kueri saldo simpanan lama harus ingat
mengecualikannya — cara termudah menciptakan kebocoran saldo diam-diam.

CHECK `jenis` pada `simpanan_transaksi` karena itu **tidak diubah**.
Konsekuensi yang disengaja: saldo berjangka tidak pernah ikut terhitung
oleh `getSaldoSimpanan()` maupun `tarikSimpananSukarela()`.

Tabel: `simpanan_berjangka` (kontrak) dan `simpanan_berjangka_bunga`
(event akrual per periode, UNIQUE `(simpanan_berjangka_id,
nomor_periode)`).

### 18.2 Kebijakan bunga — bunga kontraktual sederhana, BUKAN EIR

```
total bunga kontrak = pokok x rate tahunan x (tenor bulan / 12)
```

`EirAccountingService` **tidak dipanggil** dari domain ini dan tidak
boleh dipanggil. EIR pinjaman mengukur **aset** pada biaya perolehan
diamortisasi termasuk biaya transaksi integral; simpanan berjangka
adalah **kewajiban** berbunga kontraktual sederhana tanpa biaya
transaksi. Memaksakan satu mesin ke keduanya salah di kedua sisi.

Rate bersifat **opsional**; kosong atau 0 berarti tanpa bunga dan tidak
menghasilkan jurnal bunga sama sekali. NaN/Infinity/negatif ditolak.
Unit rate selalu **per tahun**.

Alokasi per periode memakai pembagian integer dengan **residual pada
periode terakhir**, sehingga:

```
jumlah seluruh alokasi periode == total bunga kontrak
```

Tidak ada sisa yang tidak dapat dijelaskan (bandingkan §5: rekonsiliasi
tidak boleh silent zero).

### 18.3 Jurnal

| Tahap | Jurnal |
|---|---|
| Penempatan | Dr Kas/Bank · Cr 2-1210 sebesar **pokok saja** |
| Akrual bunga | Dr 5-1955 Beban Bunga Simpanan Berjangka · Cr 2-1710 Utang Bunga Simpanan Berjangka |
| Jatuh tempo | **tidak ada jurnal** — hanya transisi status |
| Pencairan | Dr 2-1210 (pokok) · Dr 2-1710 (bunga) · Cr Kas/Bank |

**Anti double-count:** bunga tidak pernah dikredit ke 2-1210 dan tidak
pernah menambah `nominal`. Pokok kontrak Rp10.000.000 dengan rate 12%
tetap Rp10.000.000, bukan Rp11.200.000. Beban bunga diakui **satu kali
saja**, yaitu pada akrual; pencairan hanya melunasi utang bunga dan
tidak pernah menghasilkan beban kedua.

### 18.4 Siklus hidup

```
SETOR -> AKTIF -> (akrual per periode) -> JATUH_TEMPO -> DICAIRKAN
```

Status memakai `AKTIF / JATUH_TEMPO / DICAIRKAN / DIBATALKAN`. Kata
`LUNAS` sengaja **tidak** dipakai karena ambigu dengan pinjaman.

Transisi otomatis hanya `AKTIF -> JATUH_TEMPO` ketika tanggal berjalan
sudah mencapai jatuh tempo; transisi ini **tidak membuat jurnal**.
Auto-maturity bukan auto-redemption: pencairan selalu memerlukan
tindakan pengguna lewat Pengeluaran &rsaquo; Tarik Simpanan Anggota.

Jatuh tempo dihitung dengan **bulan kalender** (clamping akhir bulan),
konvensi yang sama dengan §8 — bukan `tenor x 30 hari`.

### 18.5 Pencairan

Hanya kontrak berstatus `JATUH_TEMPO` yang boleh dicairkan. Kontrak
`AKTIF` yang belum jatuh tempo ditolak dengan pesan "Simpanan berjangka
belum jatuh tempo."

**Tidak ada kebijakan penarikan dini dan tidak ada penalti** — tidak ada
dasar kebijakan tertulis untuk itu, jadi tidak dikarang. Bila bisnis
menginginkannya, itu fitur terpisah dengan kebijakan tersendiri.

> **Pemutakhiran S21.** Mesin penarikan dini kini ADA (lihat §18.11),
> tetapi kalimat di atas tetap berlaku sebagai keadaan koperasi hari
> ini: belum ada satu pun angka kebijakan yang ditetapkan, sehingga
> status kebijakan adalah `POLICY_REQUIRED` dan kontrak `AKTIF` tetap
> ditolak. Yang berubah adalah aplikasi sudah siap menjalankan
> kebijakan begitu pengurus menerbitkannya — bukan bahwa kebijakannya
> sudah ada.

Pencairan bersifat atomic dan idempoten: validasi anggota, kontrak,
jatuh tempo, periode, COA, lalu jurnal + subledger + status dalam satu
transaksi. Tidak mungkin ada jurnal tanpa perubahan status, atau status
`DICAIRKAN` tanpa jurnal.

### 18.6 COA & arus kas

| Transaction type | Role | Akun |
|---|---|---|
| `SIMPANAN_BERJANGKA` | `KREDIT_DEFAULT` | 2-1210 |
| `SIMPANAN_BERJANGKA_BUNGA_AKRUAL` | `DEBIT_BEBAN` | 5-1955 |
| `SIMPANAN_BERJANGKA_BUNGA_AKRUAL` | `KREDIT_UTANG_BUNGA` | 2-1710 |
| `SIMPANAN_BERJANGKA_PENCAIRAN` | `DEBIT_POKOK` | 2-1210 |
| `SIMPANAN_BERJANGKA_PENCAIRAN` | `DEBIT_UTANG_BUNGA` | 2-1710 |

Tanpa fallback: mapping hilang menghasilkan `MissingAccountMappingError`
dan rollback penuh — konsisten dengan §12.

Arus kas (§13): setoran dan pencairan = `PENDANAAN`; akrual bunga =
`NON_KAS`.

### 18.7 Rekonsiliasi

Dua domain di `FullReconciliation`:

- **Savings berjangka (pokok)** — subledger `nominal` (status AKTIF/
  JATUH_TEMPO) vs GL 2-1210
- **Savings berjangka (utang bunga)** — subledger `bunga_terakru` vs
  GL 2-1710

Keduanya `variance = 0`; `TIDAK_BERLAKU` bila memang tidak ada kontrak.

### 18.8 Kontrak lama (migrasi v51 -> v52)

Kontrak yang dibuat pada v51 belum pernah punya akrual. Migrasi
**tidak menjurnal bunga retroaktif**: melakukannya berarti membuat beban
dan utang bunga pada periode yang mungkin sudah ditutup, tanpa kebijakan
tertulis yang mendasarinya. Mesin akrual akan mengakui periode yang
sudah earned lewat jalur normal yang tunduk pada guard periode (§17) —
bukan lewat migrasi.

### 18.9 Penjadwalan akrual otomatis (Sesi S15) — TERIMPLEMENTASI

Akrual dipicu dari **tiga** jalur yang semuanya memanggil SATU service
(`SimpananBerjangkaCatchUpService`):

1. **Background task OS** — `expo-task-manager` + `expo-background-task`
   (paket resmi SDK 54), task bernama `KOPKU_SIMPANAN_BERJANGKA_BUNGA`,
   didaftarkan idempoten lewat `isTaskRegisteredAsync()`.
2. **Catch-up saat startup** — di `StartupTasks.ts`, berurutan bersama
   pekerjaan latar lain (satu koneksi SQLite, transaksi tidak boleh
   tumpang-tindih).
3. **Catch-up saat layar difokuskan.**

**Kelayakan akrual tidak pernah ditentukan oleh kapan scheduler
berjalan**, melainkan oleh perbandingan tanggal berjalan dengan periode
yang belum punya event akrual. Aplikasi yang ditutup Januari–April akan
mengakru Februari, Maret, dan April — bukan hanya April. OS boleh
menunda atau tidak pernah menjalankan task sama sekali tanpa satu rupiah
bunga pun hilang.

**Tidak ada `setTimeout`/`setInterval`** sebagai penjadwal: timer
JavaScript mati bersama proses aplikasi.

Idempotensi berlapis: penjaga in-process, pengecekan event per periode,
dan `UNIQUE(simpanan_berjangka_id, nomor_periode)` di database sebagai
perlindungan terakhir yang tidak bisa ditembus race apa pun.

### 18.11 Mesin penarikan dini (S21) — arsitektur siap, angka belum ada

Enam kapabilitas yang diminta kebijakan penarikan dini kini punya
tempatnya masing-masing dan satu sumber kebenaran:

| Kapabilitas | Parameter kebijakan |
|---|---|
| Penalti | `jenis_penalti`, `nilai_penalti`, `basis_penalti`, `akun_penalti_id` |
| Bunga hangus | `jenis_forfeiture`, `nilai_forfeiture` |
| Biaya administrasi | `jenis_biaya_admin`, `nilai_biaya_admin`, `basis_biaya_admin`, `akun_biaya_admin_id` |
| Perubahan rate | `rate_dini`, `jenis_penyesuaian_rate`, `cakupan_penyesuaian_rate` |
| Perlakuan pokok | `perlakuan_pokok` |
| Perlakuan bunga | `perlakuan_bunga` |

Kebijakan disimpan BERVERSI di `simpanan_berjangka_kebijakan_dini`
(hanya satu baris `AKTIF` pada satu waktu). Tabel ini **kosong pada
instalasi baru maupun hasil migrasi** — tanpa baris di sana, status
kebijakan adalah `POLICY_REQUIRED` dan penarikan dini ditolak.

Seluruh angka berasal dari `calculateEarlyWithdrawalSettlement()`.
Preview UI, eksekusi, jurnal, subledger, dan riwayat memakai hasil
fungsi yang sama, sehingga angka di layar mustahil berbeda dari angka
yang dibukukan.

**Jurnalnya** (setiap komponen punya barisnya sendiri):

```
Dr 2-1210 Simpanan Anggota (Berjangka)     pokok bruto
Dr 2-1710 Utang Bunga Simpanan Berjangka   bunga terakru (rate kontrak)
Cr 5-1955 Beban Bunga Simpanan Berjangka   bunga hangus + pengurangan rate
Cr <akun penalti kebijakan>                penalti
Cr <akun biaya admin kebijakan>            biaya administrasi
Cr Kas / Bank                              net payout
```

Sisi debit SELALU pokok penuh + bunga terakru penuh: keduanya adalah
kewajiban yang tercatat di buku, dan keduanya harus menjadi NOL. Penalti
serta biaya admin diselesaikan sebagai **potongan pembayaran**, bukan
dengan mengurangi kewajiban — kalau tidak, 2-1210 akan menyisakan
phantom balance untuk kontrak yang sudah ditutup.

Bunga yang dibatalkan **membalik beban akrualnya**, bukan menjadi
pendapatan: bunga yang tidak pernah menjadi hak anggota berarti bebannya
tidak pernah benar-benar terjadi.

Penarikan dini **tidak pernah mengalahkan jatuh tempo normal**: pada atau
setelah tanggal jatuh tempo, dan untuk kontrak berstatus `JATUH_TEMPO`,
jalur dini ditolak dan pengguna diarahkan ke pencairan normal.

### 18.10 Penarikan sebelum jatuh tempo — **POLICY GAP**

**POLICY FOUND: NO.** Audit menyeluruh atas `src/`, `app/`, dan dokumen
ini tidak menemukan satu pun kebijakan penarikan dini untuk simpanan
berjangka. Seluruh temuan penalti/denda berasal dari domain PINJAMAN
(`4-1200 Pendapatan Denda`, `4-1150 Pendapatan Penalti Pelunasan`,
`PELUNASAN_PENALTI`, biaya administrasi pencairan pinjaman).

Status: **EARLY WITHDRAWAL ENGINE — IMPLEMENTED; POLICY MUST BE
ESTABLISHED BEFORE EXECUTION.** (diperbarui RC-S44)

Yang **sudah** tersedia sebagai kode:

| Lapisan | Berkas |
|---|---|
| Sumber kebijakan | `simpanan_berjangka_kebijakan_dini` (skema v55) |
| Evaluasi kebijakan | `accounting/EarlyWithdrawalPolicy.ts` |
| Perhitungan settlement | `accounting/EarlyWithdrawalCalculation.ts` |
| Eksekusi + jurnal + subledger | `services/SimpananBerjangkaEarlyWithdrawalService.ts` |
| Kelayakan kontrak | `services/SimpananBerjangkaLifecycleService.ts` |
| UI pencairan | `screens/Transaksi/TarikSimpananFormScreen.tsx` |
| UI penetapan kebijakan | `screens/Pengaturan/KebijakanPenarikanDiniScreen.tsx` (RC-S44) |

Versioning & audit trail: setiap penetapan kebijakan baru menonaktifkan
versi sebelumnya tanpa menghapusnya, dan setiap settlement menyimpan
`policy_versi` sehingga transaksi historis tetap dapat diaudit dengan
aturan yang berlaku saat itu. Penetapan menuntut izin `pengaturan:edit`
dan mencatat dasar penetapan serta penetapnya.

Accounting pipeline: UI → service → transaksi → settlement →
AccountingEngine/Ledger → jurnal & histori. Tidak ada perhitungan
maupun jurnal yang dibuat dari layar. Basis akuntansinya SAK EP, sama
dengan seluruh modul lain — tidak ada cabang akuntansi terpisah untuk
penarikan dini.

Yang **belum** tersedia adalah **angka kebijakannya**, dan itu keputusan
pengurus, bukan kekurangan implementasi. Selama kebijakan belum
ditetapkan atau belum lengkap, `getStatusKebijakanDini()` mengembalikan
status non-aktif dan pencairan dini ditolak. Sejak RC-S43 fiturnya tetap
TERLIHAT di UI beserta penjelasannya — menyembunyikannya membuat
pengguna mengira aplikasi tidak mendukungnya, padahal yang belum ada
adalah kebijakan koperasinya.

Yang sengaja **tidak** dikarang: persentase penalti, forfeiture bunga
terakru, biaya administrasi pencairan dini, perubahan rate. Masing-
masing menghasilkan jurnal dan saldo anggota yang berbeda; memilih salah
satunya tanpa kebijakan berarti mengarang aturan keuangan yang mengikat
anggota, dan jurnal yang sudah terposting tidak bisa ditarik diam-diam.

Diperlukan keputusan tertulis pengurus atas: (1) apakah diizinkan,
(2) perlakuan bunga yang sudah diakru beserta jurnal pembalikannya,
(3) ada/tidaknya penalti dan akun penampungnya, (4) status akhir.
Satu konstanta `KEBIJAKAN_PENARIKAN_DINI_TERSEDIA` yang berubah begitu
kebijakan ada.
- Klaim kepatuhan SAK EP **tidak** dibuat hanya karena fitur bunga ini
  ada. Statusnya: *contractual interest accrual for Simpanan
  Berjangka*, bukan audit kepatuhan penuh.

---

## 19. Pajak (RC-S84) — TERIMPLEMENTASI

Menu: Transaksi > Pengeluaran > Kewajiban > **Pajak**. Kode: `src/config/pajakPolicy.ts` (aturan murni), `src/services/PajakService.ts`, `src/screens/Pajak/`. Tes: `PajakRcS84.test.ts`.

**Dasar regulasi yang dicerminkan** (diverifikasi September 2026 — wajib dikonfirmasi ulang ke konsultan pajak sebelum angka diubah): PP 55/2022 jo. PP 20/2026. PPh Final 0,5% untuk koperasi dengan peredaran bruto tahun sebelumnya ≤ Rp4,8 miliar, paling lama 4 tahun pajak sejak terdaftar; bila jangka dasarnya berakhir 2024–2029, diperpanjang sampai tahun pajak 2029. Terdaftar sebelum 2018 dihitung mulai 2018.

**Pengaturan** (`app_config` key `pajak.pengaturan`): skema `FINAL_UMKM` atau `UMUM` + tahun terdaftar. Batas akhir fasilitas dihitung, tidak diketik.

**Akun** (disisipkan idempoten per kode saat transaksi pajak pertama; `is_system = 1`; tidak ada di `DEFAULT_ACCOUNTS`; tanpa migrasi skema):

| Kode | Nama | Kategori |
|---|---|---|
| 1-1410 | Pajak Dibayar Dimuka (PPh 25) | ASET / DEBIT |
| 2-1904 | Utang PPh Final | LIABILITAS / KREDIT |
| 2-1905 | Utang PPh Pasal 29 | LIABILITAS / KREDIT |

2-1901..2-1903 dicadangkan untuk pemotongan PPh 21/23/4(2). 2-1900 dan 5-2200 yang sudah ada tidak diubah.

**Jurnal**

| Transaksi | Jurnal | Sumber | Arus kas |
|---|---|---|---|
| PPh Final masa | Dr 5-2200 / Kr 2-1904 | `PAJAK_PENGAKUAN`, `sumber_id = PPH_FINAL:YYYY-MM` | NON_KAS |
| Angsuran PPh 25 | Dr 1-1410 / Kr Kas-Bank | `KAS/BANK_PENGELUARAN_LAIN`, idempotency `PAJAK:PPH25:YYYY-MM` | OPERASI |
| PPh Badan tahunan | Dr 5-2200 / Kr 1-1410 (kredit s.d. 31 Des) / Kr 2-1905 (kurang bayar) | `PAJAK_PENGAKUAN`, `sumber_id = PPH_BADAN:YYYY` | NON_KAS |
| Setor pajak | Dr 2-1904/2-1905/2-1900 / Kr Kas-Bank | lewat `bayarKewajibanCoa()` | OPERASI |

**Aturan**
- PPh Final = floor(omzet × 5 / 1000). Omzet = mutasi bersih kredit akun PENDAPATAN pada masa (jurnal POSTED/REVERSED), dihitung ulang di service; pengguna hanya bisa mengecualikan akun, tidak mengetik angka.
- Satu pengakuan per masa/tahun; satu angsuran PPh 25 per masa. Yang sudah dibatalkan boleh dicatat ulang.
- Setoran tidak boleh melebihi saldo utang (guard RC-S74 §9). Masa & NTPN disimpan di keterangan jurnal: `Setor <jenis> · Masa <bulan tahun> · NTPN <ntpn>`.
- Pembatalan pengakuan = `reverseJournal()` dari Riwayat Pajak; ditolak bila utang dari jurnal itu sudah disetor. Setoran/angsuran dibatalkan lewat History Transaksi.
- Skema salah, fasilitas lewat batas, dan PPh Badan lebih bayar DITOLAK KERAS.

**Keputusan kebijakan yang masih terbuka (belum diimplementasikan)**
- POLICY: penyajian PPh Final — saat ini 5-2200 (baris pajak LHU). Alternatif: akun beban final tersendiri.
- POLICY: lebih bayar PPh Badan — restitusi atau kompensasi.
- POLICY: pemotongan PPh 21/23. (PPh 4(2) bunga simpanan sudah DIPUTUSKAN — lihat §19.B RC-S127.)
- Batas omzet Rp4,8 miliar hanya DIPERINGATKAN (dihitung dari ledger tahun lalu), tidak memblokir, karena ledger bisa belum lengkap.

## Lampiran A — Legenda status dokumentasi

Dipakai konsisten di seluruh dokumen ini supaya status tidak ambigu:

| Status | Arti |
|---|---|
| **FIXED** | Implementasi source **dan** bukti regresi tersedia. |
| **NOT VERIFIED** | Belum dapat diuji pada environment yang diperlukan. Bukan berarti rusak. |
| **NOT IMPLEMENTED** | Fitur memang belum tersedia. |
| **TIDAK BERLAKU** | Domain tidak aktif pada skenario, sehingga tidak direkonsiliasi. Bukan berarti source rusak. |

`NOT VERIFIED` dan `FIXED` bisa berlaku bersamaan untuk hal yang
berbeda: source boleh FIXED sementara verifikasi operasionalnya masih
NOT VERIFIED. Itu bukan kontradiksi (lihat §13 vs §9).

---

## Lampiran B — Final Bug Status

Snapshot final release candidate. Bila satu ID muncul di section lain,
statusnya wajib sama dengan tabel ini.

| ID | Status | Section | Bukti regresi |
|---|---|---|---|
| BUG-01 | FIXED | §1 | `ForeignKeyEnforcement.test.ts` |
| BUG-02 | FIXED | §12 | `ControlledAccountGuard.test.ts` |
| BUG-03 | FIXED | §14 | `EirSettlementWriteOffIntegration.test.ts` |
| BUG-04 | FIXED | §3 | `BankNonaktifDanBulkSaldo.test.ts` |
| BUG-05 | FIXED | §15 | `PenyusutanRetroaktif.test.ts` |
| BUG-06 | FIXED | §15 | `PenyusutanRetroaktif.test.ts` |
| BUG-07 | FIXED | §16 | `CashIdempotency.test.ts` |
| BUG-08 | FIXED | §2 | `RestrukturisasiSingleSourceOfTruth.test.ts` |
| BUG-09 | FIXED / IMPLEMENTED | §10, §11 | `DeferredIncomeAfterSettlement.test.ts` |
| BUG-10 | FIXED | §17 | `ClosedPeriodSubledgerMutation.test.ts` |
| BUG-11 | FIXED | §4 | `BackupValidator.test.ts` |
| BUG-12 | FIXED | §2 | `PemisahanAngsuranAkadUlang.test.ts` |
| BUG-13 | FIXED | §8 | `InstallmentDate.test.ts` |
| BUG-14 | FIXED | §5 | `PenyusutanRetroaktif.test.ts`, `AccountMapping.test.ts` |
| BUG-15 | FIXED | §6 | `BankNonaktifDanBulkSaldo.test.ts` |
| GAP-CASHFLOW | FIXED | §13 | `CashFlowExhaustiveClassification.test.ts` |

**Kebijakan yang berlaku (bukan bug):**

| Kebijakan | Nilai | Section |
|---|---|---|
| Non-accrual | ≥ 90 hari | §7 |
| Deferred income jasa futura | Opsi B | §10 |
| Siklus hidup jadwal | CURRENT / COMPLETED / OBSOLETE | §2 |

**Masih tertunda — verifikasi operasional, bukan cacat source:**

| Item | Status | Section |
|---|---|---|
| Migrasi native `expo-sqlite` | NOT VERIFIED | §9 |
| `sumber_transaksi` historis produksi | NOT VERIFIED | §9, §13 |

## §19.A RC-S86/RC-S87 — Tax Engine

- **Rezim efektif per tahun pajak** dihitung `tentukanRezimPajak()` (pajakPolicy.ts): `FINAL_UMKM` ("PPh Final UMKM 0,5%"), `BADAN_31E` ("PPh Badan – Fasilitas Pasal 31E (tarif efektif 11%)"), `BADAN_UMUM` ("PPh Badan – Tarif Umum 22%"). 11% dan 22% adalah PPh Badan **non-final**. Operator hanya mengisi deklarasi (memakai PPh Final atau tidak) dan tahun terdaftar; penetapan manual hanya lewat override berdokumen.
- PPh Final berakhir bila: jangka waktu fasilitas habis, atau peredaran bruto suatu **tahun sebelumnya** > Rp4,8 M (tarif umum mulai tahun berikutnya, tidak kembali). Omzet tahun berjalan > Rp4,8 M hanya peringatan.
- Pasal 31E: peredaran bruto ≤ Rp50 M. PKP fasilitas = PKP (bruto ≤ Rp4,8 M) atau ⌊4,8 M × PKP / bruto⌋; PPh fasilitas = ⌊PKP fasilitas × 22% × 50%⌋; sisanya 22%. PKP dibulatkan ke bawah ribuan (Pasal 17(4)).
- PPh Badan: laba komersial (LHU, SHU sebelum pajak) + koreksi fiskal positif − negatif. Koreksi fiskal adalah data yang diinput & diaudit; tanpa pernyataan "rekonsiliasi lengkap" perhitungan tidak bisa dikunci.
- Kredit PPh 25 = angsuran sah tahun pajak (transaksi kas/bank `PAJAK:PPH25:<masa>` dengan jurnal POSTED), dibatasi saldo 1-1410. Kredit PPh 22/23/24 = bukti potong terdaftar (Dr 1-1411 / Cr akun lawan pilihan operator).
- Kunci perhitungan → snapshot immutabel (+ salinan kebijakan) + jurnal `PPH_BADAN:<tahun>` (sama dengan jalur legacy). Koreksi = pembatalan tercatat (reversal) lalu kunci ulang. Lebih bayar tetap ditolak (POLICY).
- PPh 4(2) bunga simpanan (2-1901) adalah pajak yang dipotong dari anggota — terpisah total dari PPh Badan.

## §19.B RC-S127 — PPh 4(2) Bunga Simpanan: Agregat Lintas Produk

**Keputusan pengurus (mnaz, RC-S127):** batas Rp240.000 dihitung secara **agregat per anggota per bulan** untuk SELURUH bunga simpanan yang dibayarkan koperasi kepada anggota tersebut (Simpanan Sukarela + Simpanan Berjangka), bukan per produk. Bila total bunga bulan itu melebihi Rp240.000, PPh Final Pasal 4 ayat (2) 10% dikenakan atas **seluruh** bruto bunga bulan tersebut.

- Rumus di policy layer: `hitungPphBungaSimpananAgregat(posisi, brutoBaru)` = PPh(total bulan sesudah pembayaran ini) − PPh yang sudah dipotong bulan itu.
- Posisi bulan = jumlah bruto & PPh dari `pajak_potong_bunga_simpanan` milik anggota pada masa itu yang jurnal pembayarannya POSTED (`getPosisiPphBungaBulananPadaDb`). Bukti potong yang jurnalnya dibalik tidak ikut.
- Titik potong tidak berubah (peristiwa pembayaran): akrual bunga Sukarela (akhir bulan), §B transfer bunga Berjangka ke Sukarela, pencairan Berjangka. Ketiganya memakai `buatPenghitungPphAgregat`.
- Masa pajak tetap bulan masa bunga (Berjangka: bulan tanggal akhir periode; Sukarela: bulan bunga). Bulan berbeda tidak digabung.
- **Susulan:** peristiwa yang membuat total bulan melewati batas memotong juga PPh atas bunga bulan itu yang sebelumnya dipotong 0%. Bila susulan melebihi bunga peristiwa itu, neto negatif ditarik dari Simpanan Sukarela anggota (jurnal Dr 2-1200, subledger TARIK).
- **Koreksi turun** (koreksi bunga Sukarela bulan lalu) yang membuat total kembali ≤ batas menghasilkan PPh negatif (pengembalian potongan, Dr 2-1901). Invarian: total PPh berlaku satu anggota satu bulan = PPh atas total bruto berlaku bulan itu.
- Batasan diketahui: bila peristiwa yang sudah memotong susulan kemudian dibalik sementara peristiwa lain bulan itu tidak, total potongan bisa kurang/lebih sampai ada pembayaran atau koreksi berikutnya di bulan itu. Tidak ada jurnal penyesuaian otomatis.
- Bunga bagian SHU tetap bukan objek mesin ini.
- Bukti: `src/__tests__/PphBungaAgregatLintasProdukRcS127.test.ts`.

## §19.C RC-S128 — Simpanan Berjangka — Kebijakan Produk dan Bunga Pasca Jatuh Tempo

Simpanan berjangka adalah simpanan yang penarikannya dilakukan pada waktu tertentu menurut perjanjian dengan koperasi. Apa yang terjadi **setelah** jatuh tempo adalah **ketentuan produk koperasi**, bukan hukum universal; karena itu seluruh perilakunya dibaca dari kebijakan produk berversi dan disimpan sebagai snapshot pada setiap kontrak.

**Kebijakan produk (tabel `simpanan_berjangka_kebijakan_produk`, policy layer `SimpananBerjangkaKebijakanProduk.ts`)**
- Berversi dan append-only: parameter tidak dapat diubah dan baris tidak dapat dihapus (dijaga trigger database). Perubahan = versi baru dengan `berlaku_mulai` baru. Versi yang belum dipakai kontrak dapat dicabut (DICABUT); yang sudah dipakai tidak.
- Satu kebijakan AKTIF per tanggal mulai berlaku. Kebijakan yang berlaku pada tanggal T = versi AKTIF dengan `berlaku_mulai` terbesar ≤ T (`pilihKebijakanUntukTanggal`).
- Instalasi baru TIDAK membawa kebijakan bawaan. Tanpa kebijakan yang berlaku pada tanggal penempatan, penempatan simpanan berjangka **ditolak**.
- Rekomendasi produk KOPKU (isian awal form, bukan nilai bawaan): `AUTO_RENEWAL = FALSE`, `POST_MATURITY_INTEREST = ENABLED`, `INTEREST_CREDIT_DESTINATION = SIMPANAN_SUKARELA`, `PRINCIPAL_REMAINS_IN_TERM_SAVINGS = TRUE`, `INTEREST_IS_CAPITALIZED_TO_PRINCIPAL = FALSE`.
- **Rate pasca jatuh tempo tidak pernah di-hard-code**: wajib diisi pengurus bila bunga pasca jatuh tempo diaktifkan, bersama dasar penetapan, pihak dan tanggal penetapan.
- `auto_renewal = TRUE` **ditolak** validasi: mesin perpanjangan otomatis belum ada, dan menerima pilihan itu lalu mengabaikannya diam-diam akan menyesatkan.
- Basis rate tahunan; periode = bulan kalender (konvensi `tambahBulanKalender`, sama dengan tenor & jadwal kontrak). Tidak ada prorata: periode yang belum genap satu bulan kalender tidak diakui.

**Snapshot pada kontrak**
- Saat penempatan, kebijakan yang berlaku disalin ke kontrak (`policy_id`, `policy_versi`, auto-renewal, bunga pasca aktif, rate pasca, basis, metode periode, tujuan kredit, kapitalisasi, pokok tetap; rate kontrak = `suku_bunga`). Snapshot tidak dapat diubah setelah terisi (trigger), dan kontrak hanya dapat memakai versi yang AKTIF (trigger).
- PDF Bukti Penempatan mencetak snapshot ini, bukan master kebijakan terkini.

**Lifecycle**
`SETOR → AKTIF → AKRUAL BUNGA KONTRAK → JATUH_TEMPO → AKRUAL BUNGA PASCA-JATUH-TEMPO selama belum dicairkan → TRANSFER BUNGA KE SIMPANAN SUKARELA → DICAIRKAN`
- **Jatuh tempo bukan pencairan otomatis** dan bukan perpanjangan otomatis — hanya perubahan status. Pokok tetap menjadi kewajiban koperasi (2-1210) sampai anggota mencairkan.
- **Bunga pasca jatuh tempo adalah hasil kebijakan produk, bukan asumsi hukum.** Bila snapshot mengaktifkannya: bunga per periode = pokok asli × rate pasca × 1/12 (dibulatkan ke rupiah). Periode ke-j berakhir pada `tambahBulanKalender(tanggal_mulai, tenor + j)` — periode pertama dimulai tepat pada tanggal jatuh tempo. Satu-satunya penentu periode: `periodePascaJatuhTempoEarned()`.
- Periode pasca jatuh tempo disimpan di `simpanan_berjangka_bunga` (jurnal Dr 5-1955 / Cr 2-1710, sama seperti akrual kontrak) dengan `jenis_periode = 'PASCA_JATUH_TEMPO'`, `rate_persen`, dan nomor periode lanjutan (tenor+1, …). UNIQUE(kontrak, nomor_periode) mencegah akrual ganda.
- **Pokok tidak pernah dikapitalisasi**: `nominal` tidak berubah seumur kontrak (trigger `trg_sb_pokok_tetap`).
- Catch-up memakai pemicu yang sudah ada (startup, foreground, background task OS) lewat `jalankanCatchUpAkrualSimpananBerjangka`; aplikasi yang tidak dibuka berbulan-bulan mengakui seluruh periode yang terlewat secara berurutan dan idempoten. Tidak ada `setTimeout`/`setInterval`.

**Bunga ke Simpanan Sukarela & pencairan**
- Bunga pasca jatuh tempo **dipindahkan ke Simpanan Sukarela** lewat mekanisme §B yang sama (`prosesTransferBungaKeSukarelaPadaDb`): Dr 2-1710 / Cr 2-1200, tanpa beban baru. Yang masuk saldo = bunga neto setelah PPh 4(2) agregat lintas produk (§19.B); bukti potong tercatat per periode, termasuk tarif 0%.
- **Pencairan normal (kontrak berkebijakan): POKOK → ANGGOTA, BUNGA → SIMPANAN SUKARELA.** `cairkanSimpananBerjangka()` (satu transaksi): catch-up akrual sampai tanggal pencairan → pindahkan seluruh periode earned yang belum dipindahkan → bayar tunai hanya sisa yang memang belum dipindahkan (untuk kontrak berkebijakan = 0) → Dr 2-1210 / Cr Kas/Bank sebesar pokok. Bunga yang sudah ada di Simpanan Sukarela tidak pernah dibayar lagi.
- Tanggal pencairan tidak boleh sebelum akhir periode bunga terakhir yang sudah diakui.
- Bila pencairan terjadi di tengah periode pasca jatuh tempo, periode berjalan tidak menimbulkan bunga (tanpa prorata); PDF Bukti Pencairan mencantumkan alasannya.

**Kontrak legacy (sebelum v79)**
- Otomatis berstatus `LEGACY_POLICY_REVIEW_REQUIRED`: tanpa rate pasca karangan dan tanpa backfill. Jalur pencairan lamanya tidak berubah.
- Penerapan kebijakan ke kontrak lama hanya lewat tindakan eksplisit (`terapkanKebijakanKeKontrakLegacy`) yang mencatat versi, tanggal efektif, pihak penetap, alasan, dan pengguna di `simpanan_berjangka_penerapan_kebijakan` (append-only). Periode pasca jatuh tempo yang dimulai sebelum tanggal efektif tidak pernah diakui. Status kontrak menjadi `LEGACY_POLICY_DITERAPKAN`.

**Rekonsiliasi — wajib variance 0**
- Saldo 2-1210 = Σ pokok kontrak AKTIF/JATUH_TEMPO.
- Saldo 2-1710 = Σ bunga diakui − Σ bunga dipindahkan − Σ bunga dibayar (`getTotalUtangBungaBerjangkaPadaDb`; sejak RC-S128 hanya menghitung debit akun utang bunga pada jurnal pemindahan).
- Saldo subledger Simpanan Sukarela = saldo 2-1200.
- Bukti: `SimpananBerjangkaPascaJatuhTempoRcS128.test.ts`, `MigrationV79KebijakanBerjangka.test.ts`, `SimpananBerjangkaDokumenRcS128.test.ts`.

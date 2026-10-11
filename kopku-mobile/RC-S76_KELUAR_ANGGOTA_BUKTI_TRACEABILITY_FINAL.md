# RC-S76 — KELUAR ANGGOTA
## FINAL IMPLEMENTATION REPORT

**FINAL STATUS: `RC-S76 — CLEAR`**

### 1. Baseline
`RC-S75 — KELOLA KELUAR ANGGOTA` — 262 suite / 4907 test
(4902 PASS, 5 FAIL environmental).

### 2. Scope
State machine lock, traceability dua arah pengajuan ↔ bukti, dan polish
UI. Tanpa perubahan accounting, schema, atau migrasi.

### 3. State Machine Before
```
DIAJUKAN  → DISETUJUI → DIBAYAR
DIAJUKAN  → DITOLAK
DISETUJUI → DITOLAK      ← DIIZINKAN (hanya DIBAYAR yang diblokir)
```
`tolakKeluarAnggota` hanya memblokir `DIBAYAR`. DISETUJUI bukan titik
keputusan melainkan keadaan sementara: persetujuan dapat dibatalkan
tanpa jejak selain berubahnya satu kolom status, padahal UI RC-S75
sudah menyebutnya "Siap Dibayar".

### 4. State Machine After
```
DIAJUKAN
   ├── DISETUJUI ── DIBAYAR   (final)
   └── DITOLAK               (final)
```
| Transisi | Hasil |
|---|---|
| DIAJUKAN → DISETUJUI | PASS |
| DIAJUKAN → DITOLAK | PASS |
| DISETUJUI → DIBAYAR | PASS |
| **DISETUJUI → DITOLAK** | **THROW** |
| DITOLAK → DIBAYAR | THROW |
| DIBAYAR → apa pun | THROW |
| DITOLAK → DITOLAK | idempotent (existing) |

### 5. Policy Decision
Persetujuan bersifat **final**. Pembatalan persetujuan tidak disediakan
lewat state `DITOLAK` dan tidak diganti state baru — keduanya mengubah
arti data historis yang sudah tersimpan. Tanpa tombol "Batalkan
Persetujuan", tanpa state `DIBATALKAN`, tanpa kolom baru.
Pesan: *"Pengajuan yang sudah disetujui tidak dapat ditolak."*

### 6. Bukti Keluar Anggota Architecture
Relasi authoritative, tanpa tabel/jurnal/snapshot baru:
```
keluar_anggota.id ──► journal.sumber_id
keluar_anggota.journal_id ──► journal.id
journal.sumber_transaksi = 'KELUAR_ANGGOTA'
```
`BuktiKeluarAnggotaRow` menambah **satu** field read-only: `sumberId`
(dari `journal.sumber_id`). Tautan balik **tidak pernah** dicocokkan
lewat nama/tanggal/nominal — diuji dengan dua anggota bernama sama,
tanggal sama, nominal sama.

Guard: `sumberId` hanya diteruskan bila
`sumber_transaksi === 'KELUAR_ANGGOTA'`. Jurnal lain yang menyentuh
`simpanan_transaksi` punya `sumber_id` ke tabel berbeda; meneruskannya
akan membuka pengajuan yang salah.

### 7. Navigation Architecture
`KeluarAnggotaDetail` milik **TransaksiStack**; `BuktiTransaksiDetail`
milik **LaporanStack** — sibling. Keduanya menavigasi lewat tab induk
(pola project), bukan route sibling polos:
```
Detail Pengajuan → navigate('Laporan',   { screen:'BuktiTransaksiDetail', initial:false,
                                            params:{ jenis:'KELUAR_ANGGOTA', id: row.journalId } })
Detail Bukti     → navigate('Transaksi', { screen:'KeluarAnggotaDetail', initial:false,
                                            params:{ keluarAnggotaId: sumberKeluarAnggotaId } })
```
Menu "Bukti Keluar Anggota" tetap route generic `BuktiTransaksiList`
dengan `jenis: 'KELUAR_ANGGOTA'`. Tanpa route/screen/service duplikat.

### 8. Files Changed
**Produksi (4):**
- `KeluarAnggotaService.ts` — lock `tolakKeluarAnggota`.
- `BuktiTransaksiService.ts` — READ-ONLY: `sumberId` + perbaikan query
  (lihat §9).
- `KeluarAnggotaDetailScreen.tsx` — section Bukti Transaksi + CTA +
  Catatan Kewajiban.
- `BuktiTransaksiDetailScreen.tsx` — section Sumber Transaksi + CTA balik.

**Tidak disentuh:** Ledger, AccountingEngine, FinancialReports,
ShuService, PinjamanService, LoanImpairmentService, PeriodCloseService,
StartupTasks, ReportTableBuilders, RootNavigator, BuktiTransaksiListScreen.

### 9. Service Changes
**Temuan pre-existing yang terpaksa diperbaiki untuk memenuhi §15.**

Ada DUA jalur yang menghasilkan jurnal `KELUAR_ANGGOTA`:
1. `keluarAnggota()` (jalur lama, bayar seketika) — **menulis** baris
   `simpanan_transaksi` TARIK per jenis simpanan.
2. `bayarKeluarAnggota()` (jalur persetujuan RC-S74/75) — hanya menulis
   jurnal + memperbarui `keluar_anggota`; **tidak ada**
   `simpanan_transaksi`.

Query bukti semula `JOIN simpanan_transaksi`, sehingga **seluruh
pembayaran lewat jalur persetujuan tidak pernah muncul sebagai bukti** —
uang keluar tanpa bukti yang dapat ditemukan pengurus. Test lama tidak
menangkapnya karena memakai jalur (1).

Perbaikan **murni cara membaca**: JOIN menjadi LEFT, nilai diambil dari
`keluar_anggota` bila `j.sumber_id` tersedia, dengan agregasi
`simpanan_transaksi` sebagai cadangan untuk baris historis jalur (1).
Tanpa kolom/tabel baru, tanpa migrasi, tanpa mutasi. Test lama
(`BuktiTransaksiService`) tetap PASS tanpa diubah.

### 10. UI/UX Changes
**Detail Pengajuan (DIBAYAR):** section *Bukti Transaksi* (Nomor Bukti,
Tanggal Pembayaran, Sumber Dana) + CTA *Lihat Bukti Keluar Anggota*.
CTA hanya muncul bila `statusPengajuan === 'DIBAYAR'` **dan**
`journalId != null`; bila tidak, ditampilkan keadaan aman. Nomor bukti
dibaca dari service, tidak pernah dirakit di layar.

**Catatan Kewajiban** muncul bila `saldoPinjaman > 0` — transparansi
saja (§20).

**Detail Bukti (KELUAR_ANGGOTA):** section *Sumber Transaksi* + CTA
*Lihat Detail Pengajuan*. Tanpa `sumberId` yang sah, CTA **tidak**
ditampilkan: *"Detail pengajuan asal tidak tersedia."* Export existing
tetap bekerja (builder tidak disentuh).

Tidak ada auto-redirect setelah pembayaran — detail tetap terbuka,
status menjadi "Selesai", bukti menjadi secondary action (§8).

### 11. Accounting Safety
- Keempat layar: **0** kemunculan `createJournal`, `INSERT INTO`,
  `UPDATE`, `DELETE FROM`, `withTransaction(`, `getDb(`.
- Baca detail 10× + bukti 10×: keempat tabel **byte-identical**.
- Navigasi bolak-balik detail↔bukti 5×: **byte-identical**.
- Setiap transisi yang ditolak (DISETUJUI→DITOLAK, DITOLAK→DIBAYAR,
  DIBAYAR→apa pun): **byte-identical** — tanpa efek samping.
- Pembayaran tetap satu jurnal; debit = kredit = 500.000.

### 12. Database Safety
**NO CHANGE.** Tanpa migrasi, ALTER TABLE, tabel/kolom/index baru.
SCHEMA_VERSION tidak disentuh. Hanya `keluar_anggota.journal_id`,
`journal.sumber_id`, `journal.sumber_transaksi` yang sudah ada.

### 13. Traceability Test
Round-trip diuji dengan **dua anggota bernama sama, tanggal sama,
nominal sama** — justru kondisi yang membuat pencocokan
nama/tanggal/nominal mustahil:
```
Pengajuan A → Jurnal J → Bukti J → sumberId → Pengajuan A  (bukan B)
```
`bukti.journalId === keluar_anggota.journal_id` dan
`bukti.sumberId === keluar_anggota.id`. Daftar bukti juga membawa
`sumberId` per baris.

### 14. State Machine Tests
TEST 1–8 seluruhnya PASS, masing-masing disertai potret database untuk
membuktikan transisi yang ditolak tidak meninggalkan efek samping.

### 15. TypeScript
`npx tsc --noEmit` → **0 error**.

### 16. Full Jest
| | Baseline | RC-S76 |
|---|---|---|
| Suite | 262 (255 PASS / 7 FAIL) | 263 (**256 PASS** / 7 FAIL) |
| Test | 4907 (4902 PASS / 5 FAIL) | 4935 (**4930 PASS** / 5 FAIL) |

**5 FAIL + 2 suite gagal-muat = ENVIRONMENTAL, PRE-EXISTING.**
`KontrolAkhirRcS53` & `PolicyRegisterRcS53` gagal dimuat karena dokumen
kebijakan `.md` di root tidak ikut ZIP repack. Himpunan nama test yang
gagal dibandingkan otomatis: **identik**.

**Tests added:** `KeluarAnggotaBuktiTraceabilityRcS76.test.ts` (28 test).
**Updated:** satu assertion di `KeluarAnggotaDetailRcS75` — dipertegas,
bukan dilonggarkan (`{row.journalId ?` adalah guard CTA, bukan
menampilkan id; assertion kini memeriksa id tidak DIRENDER sebagai teks).
Tidak ada test dihapus.

### 17. Regression
**0 regression baru.**

### 18. Device Verification
**NOT VERIFIED.** Tidak ada emulator/perangkat, dan renderer React
Native tidak tersedia di Jest repo ini. Klaim visual (hierarchy, safe
area, wrap teks panjang, tidak ada horizontal overflow) ditegakkan
source-level. Smoke test §32 perlu dijalankan di perangkat.

### 19. Open Findings

**TEMUAN 1 — OUTSTANDING LOAN (lanjutan RC-S75).**
RC ini **hanya menampilkan informasi transparansi** ("Saldo pinjaman
anggota masih tercatat sebagai piutang koperasi dan tidak dihapus oleh
proses keluar anggota"). **Tidak ada** workflow penagihan yang
diselesaikan, tidak ada perubahan loan collection policy, tidak ada
perubahan status pinjaman, tidak ada jurnal tambahan. Kebijakan
penagihan piutang eks-anggota masih menunggu keputusan terpisah.

**TEMUAN 2 — DUA JALUR PEMBAYARAN KELUAR ANGGOTA masih hidup
berdampingan.** `keluarAnggota()` (bayar seketika) dan
`bayarKeluarAnggota()` (alur persetujuan) sama-sama menghasilkan jurnal
`KELUAR_ANGGOTA`, tetapi menulis subledger yang berbeda: yang pertama
membuat baris `simpanan_transaksi`, yang kedua tidak. RC-S76 membuat
lapisan BACA menerima keduanya, tetapi **tidak menyatukan** kedua jalur.
Akibatnya laporan lain yang membaca `simpanan_transaksi` (mis. mutasi
simpanan per anggota) akan melihat pengembalian dari jalur persetujuan
sebagai TIDAK ADA. Ini menyentuh semantics subledger simpanan dan
berada di luar scope RC ini — perlu keputusan terpisah: apakah jalur
persetujuan seharusnya ikut menulis `simpanan_transaksi`, atau jalur
lama dipensiunkan.

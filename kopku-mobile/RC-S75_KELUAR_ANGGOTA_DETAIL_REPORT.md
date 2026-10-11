# RC-S75 — KELOLA KELUAR ANGGOTA
## FINAL IMPLEMENTATION REPORT

**FINAL STATUS: `RC-S75 — CLEAR`**

### 1. Baseline

`koperasi-finance_v108.8.3-RC-S74-KELUAR-ANGGOTA-HUB`
261 suite / 4877 test — 4872 PASS, 5 FAIL (environmental, lihat §13).

### 2. Root Cause / UX Problem

Struktur hub/pengajuan/daftar sudah ada dari RC sebelumnya, tetapi
seluruh aksi masih menempel pada tiap kartu di Daftar Pengajuan.
Dua masalah nyata:

1. **Satu layar gulir berisi banyak kartu, masing-masing membawa tombol
   yang mengeluarkan uang.** Tombol Bayar berjejer di samping Setujui
   dan Tolak, di layar yang dibuka untuk memantau.
2. **Pemilih Sumber Pembayaran berdiri SENDIRI di atas daftar** — satu
   kontrol Kas/Bank yang diam-diam berlaku untuk tombol Bayar kartu
   MANA PUN yang kebetulan ditekan. Pada layar berisi beberapa
   pengajuan, tidak ada yang menandakan pengajuan mana yang akan
   memakai sumber dana itu.

Selain itu kartu menampilkan field teknis (`journalId`) dan tiga baris
nominal sekaligus, sehingga status sulit dipindai.

### 3. Architecture Before

```
Keluar Anggota (hub)
 ├── Pengajuan  → form
 └── Daftar Pengajuan
        ├── [Sumber Pembayaran: Kas | Bank]   ← berlaku untuk kartu mana pun
        └── kartu × N
              ├── Total Hak / Total Pengurang / Nilai Pengembalian
              ├── Jurnal: <journalId>
              └── [Setujui] [Tolak] / [Bayar Rp…]
```

### 4. Architecture After

```
Keluar Anggota (hub)
 ├── Pengajuan  → form (hanya membuat)
 └── Daftar Pengajuan  (monitoring + navigasi saja)
        └── kartu × N  → tap seluruh kartu
               └── Detail Pengajuan
                     ├── status besar + penjelasan
                     ├── Anggota / Pengajuan / Ringkasan Hak / Pengurang
                     └── AKSI sesuai status
                          DIAJUKAN  → [Setujui] [Tolak]
                          DISETUJUI → [Sumber Pembayaran] + [Bayar Pengajuan]
                          DITOLAK   → final, tanpa aksi
                          DIBAYAR   → final + info pembayaran
```

### 5. Files Changed

**Produksi (5):**
- `KeluarAnggotaDetailScreen.tsx` — **BARU**, layar detail + aksi.
- `DaftarKeluarAnggotaScreen.tsx` — seluruh aksi & Sumber Pembayaran
  dihapus; kartu menjadi `Pressable` penuh dengan chevron dan press
  state; `journalId` dan baris nominal berlebih dibuang.
- `keluarAnggotaLabels.ts` — tambah `LABEL_STATUS_KELUAR` &
  `PENJELASAN_STATUS_KELUAR`.
- `KeluarAnggotaService.ts` — tambah **satu** fungsi READ-ONLY
  (`getKeluarAnggotaDetailById`) + tipe `KeluarAnggotaDetail`.
- `RootNavigator.tsx` — registrasi rute `KeluarAnggotaDetail`.

**Tidak disentuh:** `KeluarAnggotaMenuScreen.tsx`,
`KeluarAnggotaFormScreen.tsx`, `TransaksiPengeluaranScreen.tsx`,
Ledger, AccountingEngine, FinancialReports, ShuService, PinjamanService,
LoanImpairmentService, PeriodCloseService, StartupTasks.

### 6. Detail Screen

Hierarki: badge status + nominal besar + penjelasan status → Anggota →
Pengajuan → Ringkasan Hak → Pengurang → (Pembayaran, bila DIBAYAR) →
area aksi.

- Status memakai **badge + teks**, tidak pernah warna saja.
- Setiap mutasi didahului `Alert.alert` konfirmasi; Tolak memakai
  `style: 'destructive'`.
- Anti double-tap dua lapis: `disabled={sibuk}` pada tombol **dan**
  `if (sibuk) return;` di dalam helper `jalankanMutasi`.
- Setiap mutasi berhasil diikuti `muat()` — status yang terlihat selalu
  status database.
- Field teknis (`journalId`, `diajukanOleh`, `disetujuiOleh`, id
  internal) **tidak** dirender.

### 7. Navigation Flow

```
Transaksi → Keluar Anggota → Daftar Pengajuan → tap kartu → Detail
Back: Detail → Daftar → Keluar Anggota → Transaksi
Form berhasil → Keluar Anggota (hub)
```

Keempat rute (`KeluarAnggotaMenu`, `KeluarAnggotaForm`,
`DaftarKeluarAnggota`, `KeluarAnggotaDetail`) di `TransaksiStack` yang
sama, masing-masing terdaftar **tepat sekali**, tanpa nested navigator.
Params detail hanya `{ keluarAnggotaId }`; `navigate('…')` ditulis
literal agar pemindai keterjangkauan rute mengenalinya (bukan orphan —
diuji).

### 8. Service / Business Rule

`KeluarAnggotaService` tetap satu dan tetap penegak. Penambahan hanya
**satu fungsi SELECT**: `getKeluarAnggotaDetailById(id)` — memakai
`petakan()` yang sama dengan `listKeluarAnggota()` dan hanya menambah
`nomorAnggota`, satu-satunya field yang diminta detail tetapi tidak ada
di read-model daftar. Tanpa transaction write, tanpa jurnal, tanpa
perubahan status. Mengembalikan `null` bila id tidak ada.

State machine **tidak diubah**. Diuji bahwa service tetap menolak:
menyetujui yang sudah DISETUJUI, membayar yang DITOLAK, membayar dua
kali, dan menyetujui yang sudah DIBAYAR.

### 9. Accounting Safety

- Keempat layar Keluar Anggota: **0** kemunculan `createJournal`,
  `INSERT INTO`, `UPDATE`, `DELETE FROM`, `getDb(`, `withTransaction(`.
- Membaca detail 10× + daftar 10×: `journal`, `journal_entry`,
  `keluar_anggota`, `simpanan_transaksi` **byte-identical**.
- Bolak-balik daftar↔detail 5×: keempat tabel **byte-identical**.
- Percobaan bayar kedua ditolak service **dan tidak meninggalkan jejak**
  (potret sesudahnya identik).
- Alur DIAJUKAN→DISETUJUI→DIBAYAR: nilai tetap (total hak 500.000,
  pengurang 0, pengembalian 500.000); jurnal yang dibentuk service tetap
  seimbang (debit = kredit).

### 10. Database / Migration

**NO CHANGE.** Tanpa migration, tanpa `ALTER TABLE`, tanpa tabel baru,
tanpa field baru, tanpa index baru. SCHEMA_VERSION tidak disentuh.

### 11. Tests Added

`KeluarAnggotaDetailRcS75.test.ts` — **BARU, 31 test**: fungsi baca
read-only (4), alur status & anti double-payment (5), struktur layar
detail (10), daftar monitoring-saja (5), rute (5), gate akuntansi (2).

Diperbarui karena aksi memang berpindah berkas (bukan dilonggarkan):
`ImbalanKeluarAnggotaUiRcS53` (assertion diarahkan ke layar detail,
plus penegasan bahwa form DAN daftar kini bersih dari mutasi),
`KeluarAnggotaHubRestructure` (TEST 26 menjadi "daftar tanpa mutasi").
**Tidak ada test dihapus. Tidak ada expected accounting value diubah.**

### 12. TypeScript Result

`npx tsc --noEmit` → **0 error**.

### 13. Full Jest Result

| | Baseline | RC-S75 |
|---|---|---|
| Suite | 261 (254 PASS / 7 FAIL) | 262 (**255 PASS** / 7 FAIL) |
| Test | 4877 (4872 PASS / 5 FAIL) | 4907 (**4902 PASS** / 5 FAIL) |

**5 FAIL + 2 suite gagal-muat = ENVIRONMENTAL, PRE-EXISTING.**
`KontrolAkhirRcS53` & `PolicyRegisterRcS53` gagal dimuat karena dokumen
kebijakan `.md` di root tidak ikut ZIP repack. Himpunan nama test yang
gagal dibandingkan otomatis sebelum/sesudah: **identik**.

### 14. Regression Result

**0 regression baru.**

### 15. Device Verification Limitation

**DEVICE NOT VERIFIED.** Tidak ada emulator/perangkat Android di
lingkungan ini, dan renderer React Native tidak tersedia di Jest repo
ini. Klaim visual (hierarchy, tidak ada horizontal overflow, long text
tidak merusak layout, Safe Area) ditegakkan secara **source-level**,
bukan lewat pengukuran layout nyata. Smoke test §W perlu dijalankan di
perangkat.

### 16. Open Findings

**TEMUAN 1 — `tolakKeluarAnggota` mengizinkan DISETUJUI → DITOLAK.**
Audit service: `tolakKeluarAnggota` hanya memblokir status `DIBAYAR`
(dan mengembalikan baris apa adanya bila sudah `DITOLAK`). Artinya
pengajuan yang SUDAH DISETUJUI masih boleh ditolak menurut contract
service.

UI RC-S75 mengikuti spesifikasi tiket (§G/§I): pada status DISETUJUI
hanya tombol **Bayar** yang ditampilkan. Jadi **UI lebih sempit daripada
contract service** — pembatalan persetujuan tidak punya jalan masuk di
layar, meskipun service mengizinkannya.

Sesuai §M, tidak ada yang diubah di sisi mana pun. Perlu keputusan:
(a) tambahkan tombol Tolak pada status DISETUJUI agar UI sejalan dengan
service, atau (b) perketat service agar menolak transisi itu. Keduanya
adalah keputusan kebijakan, bukan bug.

**TEMUAN 2 — anggota keluar dengan pinjaman outstanding.**
`previewKeluarAnggota` memperhitungkan `saldoPinjaman` sebagai
pengurang, dan bila hak habis, sisa pinjaman **tetap tercatat sebagai
piutang koperasi** (dinyatakan di layar form). Tidak diaudit lebih jauh
dan tidak diubah dalam RC ini. Dicatat sebagai temuan terpisah sesuai §M.

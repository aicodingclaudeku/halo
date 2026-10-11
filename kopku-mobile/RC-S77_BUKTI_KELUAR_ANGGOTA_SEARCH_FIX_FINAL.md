# RC-S77 — FIX SEARCH BUKTI KELUAR ANGGOTA
## FINAL REPORT

**STATUS: `RC-S77 — CLEAR`**

### Root Cause

**Bug 1 — yang dilaporkan tiket (search jalur persetujuan gagal).**
Ada dua jalur yang menghasilkan jurnal `KELUAR_ANGGOTA`:

```
keluarAnggota()      → jurnal → simpanan_transaksi → anggota (alias a)
bayarKeluarAnggota() → jurnal → keluar_anggota     → anggota (alias ka_a)
                                 ↑ TIDAK ada simpanan_transaksi
```

RC-S76 sudah membuat kolom yang *ditampilkan* memakai
`COALESCE(ka_a.…, a.…)`, sehingga bukti jalur persetujuan muncul di
daftar. Tetapi **filter pencarian masih membaca `a.*` saja**. Untuk
jalur persetujuan seluruh alias `a` bernilai NULL, jadi barisnya ada di
daftar tetapi tidak pernah ditemukan saat dicari — persis yang
dilaporkan.

**Bug 2 — REGRESI YANG SAYA PERKENALKAN SENDIRI DI RC-S76.**
Audit menemukan bahwa perubahan filter RC-S76 sebenarnya **mendarat di
fungsi yang salah**. Skrip edit saat itu mengganti kemunculan PERTAMA
dari pola `filters.push('(a.nama_lengkap LIKE ? OR a.nomor_anggota LIKE ?)')`,
dan kemunculan pertama itu milik **`listBuktiBayarSimpanan`**, bukan
`listBuktiKeluarAnggota`.

`listBuktiBayarSimpanan` tidak punya alias `ka_a`. Akibatnya, mencari di
layar **Bukti Bayar Simpanan** akan melempar
`SQLITE_ERROR: no such column: ka_a.nama_lengkap` — bukan hasil kosong,
melainkan layar gagal. Tidak ada test yang menangkapnya karena tidak ada
test yang menjalankan pencarian pada jenis bukti itu.

Ini regresi nyata yang dikirim dalam ZIP RC-S76.

### Fix

Dua perubahan, keduanya di `listBuktiKeluarAnggota` / `listBuktiBayarSimpanan`
dan **murni cara membaca**:

1. **REVERT** filter `listBuktiBayarSimpanan` kembali ke bentuk semula
   (`a.nama_lengkap` / `a.nomor_anggota`).
2. **APPLY** filter COALESCE di dalam `listBuktiKeluarAnggota` saja —
   satu-satunya query yang memang punya alias `ka_a`:

```sql
(COALESCE(ka_a.nama_lengkap, a.nama_lengkap) LIKE ?
 OR COALESCE(ka_a.nomor_anggota, a.nomor_anggota) LIKE ?)
```

Urutan COALESCE **sama persis** dengan kolom yang ditampilkan
(`ka_a` lebih dulu), supaya yang dicari adalah yang terlihat.

Tetap parameterized, satu query (tanpa N+1), tanpa filter di JS.
`sumberId` tetap dari `journal.sumber_id` — pencarian tidak pernah
dipakai untuk menentukan tautan.

### Files Changed

| File | Alasan |
|---|---|
| `src/services/BuktiTransaksiService.ts` | revert Bug 2 + fix Bug 1 |
| `src/__tests__/KeluarAnggotaBuktiTraceabilityRcS76.test.ts` | +5 test |
| `RC-S77_BUKTI_KELUAR_ANGGOTA_SEARCH_FIX_FINAL.md` | report |

Diff diverifikasi terhadap ZIP RC-S76: **hanya** kedua file di atas yang
berubah. Tidak ada perubahan pada mutation/payment logic, UI, navigasi,
export, schema, atau service lain.

### Tests

**+5 test** (total suite: 33):

- **A** — jalur legacy `keluarAnggota()`: search nama & nomor → ketemu.
- **B** — jalur persetujuan `bayarKeluarAnggota()`: search nama & nomor →
  ketemu; disertai asersi prasyarat bahwa **tidak ada satu pun baris
  `simpanan_transaksi`** pada jurnal itu (kondisi yang membuat bug
  mungkin), dan `sumberId` tetap benar.
- **Anti false-match** — dua anggota **nama sama, nomor berbeda**:
  search nama → 2 baris (benar); search nomor → tepat 1 baris, dan yang
  benar (`journalId` + `sumberId` dicek).
- **Read-only** — list/search 10×: `journal`, `journal_entry`,
  `keluar_anggota`, `simpanan_transaksi` **byte-identical**.
- **REGRESI Bug 2** — pencarian pada `listBuktiBayarSimpanan`,
  `listBuktiTarikSimpanan`, `listBuktiBayarPiutang`, `listBuktiBayarUtang`
  tidak melempar.

Guard Bug 2 **diverifikasi benar-benar menangkap**: dengan bug
sengaja dikembalikan, test gagal dengan
`no such column: ka_a.nama_lengkap`; setelah dipulihkan, PASS.

Tidak ada test dihapus atau dilonggarkan.

### TypeScript
`npx tsc --noEmit` → **0 error**.

### Full Jest

| | RC-S76 | RC-S77 |
|---|---|---|
| Suite | 263 (256 PASS / 7 FAIL) | 263 (**256 PASS** / 7 FAIL) |
| Test | 4935 (4930 PASS / 5 FAIL) | 4940 (**4935 PASS** / 5 FAIL) |

5 FAIL + 2 suite gagal-muat = **ENVIRONMENTAL, PRE-EXISTING**
(`KontrolAkhirRcS53`, `PolicyRegisterRcS53` — dokumen kebijakan `.md`
di root tidak ikut ZIP repack). Himpunan nama test yang gagal
dibandingkan otomatis: **identik**.

### Regression
**0 regression baru.** Satu regresi LAMA (Bug 2, dikirim di RC-S76)
**diperbaiki** di RC ini.

### Accounting
**NO CHANGE.** Tidak ada `createJournal`, `INSERT INTO`, `UPDATE`,
`DELETE FROM`, `ALTER TABLE`, `CREATE TABLE` yang ditambahkan.
`keluarAnggota()`, `bayarKeluarAnggota()`, dan state machine tidak
disentuh.

### Database
**NO CHANGE.** Tanpa migrasi, tabel/kolom/index baru. SCHEMA_VERSION
tidak disentuh.

### Device
**NOT VERIFIED.** Tidak ada emulator/perangkat. Perbaikan ini murni
lapisan query dan terverifikasi lewat test SQLite nyata, tetapi
pencarian di layar perlu dicoba di perangkat.

### Open Findings (RC-S76, tetap berlaku)

**TEMUAN 1 — OUTSTANDING LOAN.** Detail pengajuan hanya menampilkan
informasi transparansi. Tidak ada workflow penagihan, tidak ada
perubahan loan collection policy, status pinjaman, atau jurnal tambahan.

**TEMUAN 2 — DUA JALUR PEMBAYARAN masih hidup berdampingan.**
`keluarAnggota()` menulis `simpanan_transaksi`; `bayarKeluarAnggota()`
tidak. RC-S76 membuat lapisan BACA menerima keduanya dan RC-S77
membuat PENCARIAN menerima keduanya, tetapi **jalurnya belum
disatukan**. Laporan lain yang membaca `simpanan_transaksi` (mis. mutasi
simpanan per anggota) masih akan melihat pengembalian dari jalur
persetujuan sebagai tidak ada. Tetap **OUT OF SCOPE** sesuai §3; perlu
keputusan terpisah.

**TEMUAN 3 — BARU.** Bug 2 lolos ke rilis karena **tidak ada satu pun
test yang menjalankan pencarian** pada jenis bukti selain Keluar
Anggota. RC-S77 menambahkan guard untuk keempat jenis lain, tetapi
hanya memastikan query tidak melempar — belum menguji kebenaran hasil
pencariannya. Cakupan test pencarian bukti secara umum masih tipis.

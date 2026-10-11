# RC-S81 — REKONSILIASI: STATUS TEMUAN & UX
## FINAL REPORT

**STATUS: `RC-S81 — CLEAR`**

### Root Cause

`catatRekonsiliasiDanTindakLanjut()` meneruskan **setiap** penyebab ke
`selesaikanDalamTransaksi()`, yang menulis
`status_penyelesaian = 'SELESAI'`. Akibatnya memilih "Transaksi Belum
Tercatat" **langsung menutup temuannya**: periode dapat ditutup walau
transaksinya belum pernah dicatat, dan selisihnya hilang dari
pengawasan. Hal yang sama berlaku untuk salah pencatatan, kesalahan
bank, dan penyebab lain — temuan ditutup atas dasar pengakuan operator,
bukan bukti.

### Fix

Jalur dipisah di service (tanpa service/screen/route baru):

- **TEMUAN → `simpanTemuanDraft()`** (baru, internal). Menjalankan
  validasi yang sama (perlakuan sah, larangan akun, catatan wajib), lalu
  menulis `penyebab` + `perlakuan` sambil **mempertahankan
  `status_penyelesaian = 'DRAFT'`** dan `journal_id = NULL`.
  `diselesaikan_oleh`/`diselesaikan_at` sengaja **tidak diisi** — belum
  ada yang menyelesaikan apa pun, dan mengisinya akan membuat baris
  DRAFT tampak sudah ditangani.
- **PENYELESAIAN FINAL → `selesaikanDalamTransaksi()`** (tidak berubah).

Pemisahnya eksplisit: `PENYEBAB_SELESAI_SEKETIKA` +
`penyebabTetapDraft()`.

### Before / After Flow
```
SEBELUM: pilih penyebab → SELESAI (semua penyebab)   ← temuan tertutup
SESUDAH: pilih penyebab
         ├─ temuan       → DRAFT   → tindak lanjut → rekonsiliasi ulang
         ├─ timing       → SELESAI (tanpa jurnal)
         └─ penyesuaian  → SELESAI + jurnal
```

### DRAFT Semantics
| Penyebab | status | penyelesaian | journal |
|---|---|---|---|
| TRANSAKSI_BELUM_TERCATAT | SELISIH | **DRAFT** | NULL |
| SELISIH_PENCATATAN | SELISIH | **DRAFT** | NULL |
| KESALAHAN_BANK | SELISIH | **DRAFT** | NULL |
| LAINNYA | SELISIH | **DRAFT** | NULL |
| TIMING_DIFFERENCE | SELISIH | SELESAI | NULL |
| BIAYA_ADMIN_BANK / JASA_GIRO / SELISIH_FISIK | SELISIH | SELESAI | ada |

Penyebab **tetap tersimpan** pada baris DRAFT — audit trail tidak
kehilangan apa pun.

### PeriodClose
Tidak diubah, tetapi kini benar-benar bergigi: temuan DRAFT memblokir
penutupan (diuji end-to-end lewat SQLite, bukan hanya unit helper).
Perbedaan waktu SELESAI dan penyesuaian berjurnal tetap ALLOW; scope
tetap periode yang ditutup.

### UI Wording
Sisa "Saldo Aktual"/"saldo aktual" di alur rekonsiliasi dihapus
(`RekonsiliasiScreen`, `PenyesuaianScreen`, `rekonsiliasiForm`) dan
diganti "saldo eksternal". Label kontekstual RC-S79 dipertahankan.
Kolom DB `saldo_fisik` tidak di-rename. (`ArusKasScreen` memakai istilah
itu untuk hal berbeda — di luar scope.)

### Tests
`RekonsiliasiRcS81.test.ts` — **15 test**, sebagian besar **SQLite
nyata** dan membaca status **langsung dari tabel**, bukan dari objek
yang dikembalikan service: keempat temuan → DRAFT tanpa jurnal dan tanpa
`diselesaikan_*`; timing → SELESAI; penyesuaian → SELESAI + jurnal
seimbang; PeriodClose memblokir DRAFT; rekonsiliasi ulang membuat row
baru tanpa menimpa histori; penolakan meninggalkan database
**byte-identical**.

Diperbarui (wording saja): `RekonsiliasiRcS67_9_2`,
`TransaksiRestructureRcS68`. **Tidak ada test dihapus atau dilonggarkan.**

### TypeScript
`npx tsc --noEmit` → **0 error**.

### Full Jest
| | RC-S80 | RC-S81 |
|---|---|---|
| Suite | 266 (259 PASS / 7 FAIL) | 267 (**260 PASS** / 7 FAIL) |
| Test | 5019 (5014 PASS / 5 FAIL) | 5034 (**5029 PASS** / 5 FAIL) |

5 FAIL + 2 suite gagal-muat = **ENVIRONMENTAL, PRE-EXISTING**
(`KontrolAkhirRcS53`, `PolicyRegisterRcS53` — dokumen kebijakan `.md` di
root tidak ikut ZIP repack). Himpunan nama test yang gagal dibandingkan
otomatis: **identik**.

### Accounting
**NO CHANGE.** AccountingEngine, Ledger, COA, SHU, cash-flow
classification, journal semantics, debit/kredit tidak disentuh. Tidak
ada jurnal generik; "Lainnya" tetap tidak pernah menjurnal.

### Database
**NO CHANGE.** Tanpa migrasi; SCHEMA_VERSION tetap 71.

### Regression
**0 regression baru.**

### Device
**NOT VERIFIED.** Tidak ada emulator/perangkat. Bug utama (DRAFT)
dibuktikan lewat **SQLite sungguhan**, tetapi CTA save-first tetap
ditegakkan lewat audit struktural sumber karena renderer RN tidak
tersedia di Jest repo ini. Smoke test masih diperlukan sebelum rilis.

### Open Findings (tetap — TIDAK diklaim selesai)
1. Dua jalur pembayaran Keluar Anggota / subledger berbeda (RC-S76/S77).
2. Outstanding loan anggota keluar (RC-S75/S76).
3. Cakupan test pencarian bukti (RC-S77).
4. Export rekonsiliasi belum ada (RC-S79 §2F).
5. Mapping akun khusus rekonsiliasi belum ada di COA (RC-S80).

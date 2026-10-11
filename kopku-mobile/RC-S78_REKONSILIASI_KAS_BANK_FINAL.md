# RC-S78 — REKONSILIASI KAS & BANK
## FINAL IMPLEMENTATION REPORT

**STATUS: `RC-S78 — CLEAR` (dengan batasan §18 dan temuan terbuka §19)**

### 1. Baseline
RC-S77 — 263 suite / 4940 test (4935 PASS, 5 FAIL environmental).

### 2. Root Cause
Rekonsiliasi lama memaksa hampir setiap selisih menjadi jurnal:

- **"Lainnya" menjadi jalur jurnal generik** — termasuk dipakai untuk
  jasa giro, sehingga pendapatan bank tercatat tanpa kategori sendiri.
- **"Transaksi Belum Tercatat" & "Salah Pencatatan" hanya MENGARAHKAN** —
  penyebabnya tidak disimpan sama sekali, jadi hilang dari audit trail.
- **Perbedaan Waktu & Jasa Giro sudah ada di service tetapi tidak pernah
  muncul di layar**; **Kesalahan Bank** tidak punya kategori sama sekali.
- **PeriodClose memblokir setiap `status === 'SELISIH'`** dengan pesan
  "rekonsiliasi ulang sampai cocok". Perbedaan waktu yang sudah
  diperiksa MEMANG membuat saldo buku dan rekening koran berbeda pada
  tanggal yang sama — dan tidak akan pernah cocok hanya karena diulang.
  Aturan itu mendorong orang menutup selisih dengan jurnal karangan
  supaya periode bisa ditutup.

### 3/4. Field Workflow Before → After
```
SEBELUM:  selisih → pilih dari 5 penyebab → (hampir selalu) jurnal → cocok
SESUDAH:  selisih → penyebab (8) → tindak lanjut sesuai penyebab
                                   ├─ transaksi asal / koreksi   (DRAFT)
                                   ├─ pihak bank                 (DRAFT)
                                   ├─ dijelaskan (perbedaan waktu) (SELESAI)
                                   └─ penyesuaian berdokumen      (SELESAI + jurnal)
```

### 5. Cause Taxonomy
**Bank (7):** Transaksi Belum Tercatat, Salah Pencatatan, Perbedaan
Waktu, Biaya Bank/Administrasi, Jasa Giro/Bunga Bank, Kesalahan Bank,
Penyebab Lain.
**Kas/Kas Kecil (4):** Transaksi Belum Tercatat, Salah Pencatatan,
Selisih Kas Fisik, Penyebab Lain.
Penyebab khas bank tidak muncul pada Kas dan sebaliknya (diuji).

### 6. Treatment Matrix (`PERLAKUAN_SAH`)
| Penyebab | Perlakuan | Status |
|---|---|---|
| TRANSAKSI_BELUM_TERCATAT | TIDAK_PERLU_JURNAL | DRAFT |
| SELISIH_PENCATATAN | TIDAK_PERLU_JURNAL | DRAFT |
| KESALAHAN_BANK | TIDAK_PERLU_JURNAL | DRAFT |
| LAINNYA | TIDAK_PERLU_JURNAL | DRAFT |
| TIMING_DIFFERENCE | TIDAK_PERLU_JURNAL | **SELESAI** |
| BIAYA_ADMIN_BANK | PERLU_JURNAL (hanya selisih KURANG) | SELESAI |
| JASA_GIRO | PERLU_JURNAL (hanya selisih LEBIH) | SELESAI |
| SELISIH_FISIK | PERLU_JURNAL (dua arah) | SELESAI |

Hanya tiga penyebab boleh menghasilkan jurnal — ketiganya transaksi
koperasi sendiri yang berdokumen.

### 7. Service Rules
`selesaikanRekonsiliasi` menolak: perlakuan yang tidak cocok dengan
penyebab, arah selisih yang salah, dan catatan kosong. Layar boleh
menyembunyikan pilihan; **service yang menolak** (diuji, termasuk bukti
bahwa penolakan tidak meninggalkan jejak di database).

### 8. UI/UX
8 penyebab dengan helper text; kartu **Tindak Lanjut** untuk setiap
penyebab; label & CTA berasal dari taksonomi (`ctaLabel`) sehingga tidak
bisa berbeda antar tempat; AccountPicker hanya untuk tiga penyebab
penyesuaian; catatan wajib. "Penyebab Lain" tidak punya AccountPicker
dan tidak pernah menghasilkan jurnal.

### 9. PeriodClose
`rekonsiliasiMenghalangiTutupPeriode()` memblokir **DRAFT** dan baris
**SELESAI yang tidak konsisten** (mengaku dijurnal tanpa jurnal, atau
sebaliknya, atau perlakuan tidak sah untuk penyebabnya). Pemeriksaan
terbaru per akun yang dibaca: DRAFT lama + COCOK baru → tidak memblokir,
dan histori lama tetap ada. Pesan diganti menjadi "belum ditindaklanjuti".

### 10. Migration v71
Rebuild `rekonsiliasi_kas_bank` mengikuti pola migrasi existing
(CREATE _new → INSERT SELECT → DROP → RENAME → recreate index), dibungkus
transaksi, di dalam blok FK-off yang sudah ada. Seluruh 17 kolom disalin
apa adanya. Fresh install memakai CHECK baru dari `CREATE_TABLES_SQL`.

### 11. Historical Preservation
Diuji: baris v70 **identik seluruh kolomnya** setelah upgrade (termasuk
`id`, `journal_id`, `diselesaikan_*`), idempoten, tabel sementara tidak
tertinggal, `foreign_key_check` kosong. Test juga membuktikan v70 memang
menolak enum baru — jadi migrasinya memang diperlukan.

### 12. Accounting Safety
Tidak ada perubahan pada AccountingEngine, Ledger, ShuService,
PinjamanService, LoanImpairmentService, StartupTasks, FinancialReports.
Jurnal tetap lewat `createJournal` dengan sumber `REKONSILIASI_KAS_BANK`,
seimbang, dan closed-period rejection tetap berlaku. Membaca daftar 10×
tidak mengubah database.

### 13. SQLite Scenarios
A biaya bank (Dr Beban/Cr Bank) · B jasa giro (Dr Bank/Cr Pendapatan) ·
C perbedaan waktu (SELESAI tanpa jurnal, histori tetap SELISIH) ·
D kesalahan bank (DRAFT tanpa jurnal) · E kas kurang (Dr Beban/Cr Kas) ·
F transaksi belum tercatat (DRAFT tanpa jurnal, penyebab tersimpan).

### 14. Tests
**Baru:** `RekonsiliasiRcS78.test.ts` — **29 test** (migrasi 5, matriks
10, skenario 7, PeriodClose 7).
**Diperbarui** karena taksonomi memang berubah: `RekonsiliasiRcS67_9`,
`_9_1`, `_9_2`, `PenyesuaianRakuRcS53`, `Fase9FinalisasiRcS53`,
`Fase10AuditFinalRcS53`, `PeriodCloseService`, + 24 berkas pin
SCHEMA_VERSION (70→71, guard `currentVersion < 71`→`< 72`), masing-masing
dengan catatan `DIPERBARUI RC-S78`.
**Tidak ada test dihapus. Tidak ada expected accounting value diubah.**

### 15. TypeScript
`npx tsc --noEmit` → **0 error**.

### 16. Full Jest
| | RC-S77 | RC-S78 |
|---|---|---|
| Suite | 263 (256 PASS / 7 FAIL) | 264 (**257 PASS** / 7 FAIL) |
| Test | 4940 (4935 PASS / 5 FAIL) | 4969 (**4964 PASS** / 5 FAIL) |

5 FAIL + 2 suite gagal-muat = **ENVIRONMENTAL, PRE-EXISTING**
(`KontrolAkhirRcS53`, `PolicyRegisterRcS53` — dokumen kebijakan `.md` di
root tidak ikut ZIP repack). Himpunan nama test yang gagal dibandingkan
otomatis: **identik**.

### 17. Regression
**0 regression baru.**

### 18. Device Verification — BATASAN PENTING
**NOT VERIFIED.** Tidak ada emulator dan tidak ada renderer RN.

Sebagian item UI §24 **belum dikerjakan** dan harus dianggap OUTSTANDING:
- label saldo eksternal kontekstual ("Saldo Menurut Rekening Koran" vs
  "Hasil Kas Opname") — layar masih memakai label lama;
- headline "Selisih Kurang/Lebih" pada layar (helper `labelSelisih`
  sudah benar, tetapi tampilannya belum diaudit ulang);
- riwayat menampilkan penyebab + resolusi (§17);
- kolom export rekonsiliasi (§27);
- navigasi CTA "Buka Transaksi"/"Buka Riwayat" sudah ada dari RC
  sebelumnya tetapi belum diuji ulang untuk label baru.

Karena itu klaim CLEAR di sini berlaku untuk **state machine, taksonomi,
service guard, migrasi, dan PeriodClose** — bukan untuk seluruh checklist
UI §24.

### 19. Open Findings

**TEMUAN 1 — mapping akun biaya bank / jasa giro belum diaudit (§7D/E).**
Tiket meminta: jika mapping khusus tersedia, pakai mapping itu; jika
belum, tampilkan "Akun ... belum ditetapkan" alih-alih membebaskan
seluruh akun kategori. **Belum dikerjakan** — AccountPicker masih
memfilter berdasarkan kategori (BEBAN/PENDAPATAN), bukan mapping. Perlu
audit `account_mapping` sebelum diputuskan.

**TEMUAN 2 — dua jalur pembayaran Keluar Anggota** (dari RC-S76/S77)
masih berlaku dan tetap di luar scope.

**TEMUAN 3 — cakupan test pencarian bukti** (dari RC-S77) masih tipis.

**CATATAN POSISI:** taksonomi ini adalah **desain kontrol internal
aplikasi**. Tidak ada klaim bahwa SAK EP mewajibkan daftar penyebab ini.
Rekonsiliasi dirancang untuk mendukung keandalan saldo Kas/Bank,
ketepatan pencatatan transaksi, serta dokumentasi penyelesaian
perbedaan.

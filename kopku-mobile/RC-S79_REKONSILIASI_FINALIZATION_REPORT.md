# RC-S79 — FINALISASI REKONSILIASI KAS & BANK
## FINAL REPORT

**STATUS: `RC-S79 — CLEAR`** (export §2F dinyatakan OUT OF SCOPE sesuai
instruksi tiket sendiri — lihat §3C)

### 1. Baseline
RC-S78 — 264 suite / 4969 test (4964 PASS, 5 FAIL environmental).

### 2. Remaining Findings RC-S78 yang ditutup RC ini
- UI label kontekstual (§2A) — **ditutup**
- headline selisih (§2B) — **ditutup**
- riwayat menampilkan penyebab (§2E) — **ditutup**
- guard akun di SERVICE (§3) — **ditutup**
- PeriodClose periode-spesifik (§4) — **ditutup**
- export rekonsiliasi (§2F) — **OUT OF SCOPE** (lihat §3C)

### 3. UI Fix

**A. Label saldo.** `labelSaldoEksternal()`: BANK → "Saldo Menurut
Rekening Koran", KAS/KAS_KECIL → "Hasil Kas Opname". **"Saldo Aktual"
kini 0 kemunculan di layar.** Kolom database tetap `saldo_fisik` —
tidak di-rename. Caption "SELISIH" → "HASIL REKONSILIASI", disertai
`penjelasanSelisih()` yang menyatakan arah selisih eksplisit
("Saldo eksternal lebih kecil dari saldo buku").

**B. Riwayat (§2E).** Tiap baris kini menampilkan label penyebab
(`labelPenyebabRiwayat`) di samping status penyelesaian, dan label saldo
eksternalnya mengikuti jenis rekening. Sebelumnya riwayat hanya berisi
angka + status, sehingga pemeriksa berikutnya tidak bisa tahu MENGAPA
ada selisih tanpa membuka ulang pemeriksaannya. Enum database
diterjemahkan (`TIMING_DIFFERENCE` → "Perbedaan Waktu").

**C. Export (§2F) — OUT OF SCOPE.** Audit `ReportTableBuilders.ts`
menunjukkan **tidak ada builder export rekonsiliasi**; yang ada hanya
baris ringkas "Rekonsiliasi" di dalam laporan kas/bank. Sesuai
instruksi §2F ("Jika export memang belum ada di source: JANGAN membuat
sistem export baru hanya untuk RC ini; dokumentasikan OUT OF SCOPE"),
tidak ada export baru yang dibuat.

### 4. Account Mapping Fix (§3)
Tiga penjaga baru, **semuanya di service** — UI hanya membantu memilih:

1. **Jenis rekening.** `BIAYA_ADMIN_BANK`, `JASA_GIRO`, `KESALAHAN_BANK`
   ditolak pada rekening kas; `SELISIH_FISIK` ditolak pada bank.
2. **Kategori akun lawan.** Selisih kurang wajib akun **BEBAN**, selisih
   lebih wajib **PENDAPATAN**. Akun nonaktif dan akun yang tidak ada
   ditolak. Akun di luar kategori itu (mis. aset) menghasilkan jurnal
   yang seimbang tetapi salah arti — kesalahan yang tidak terlihat dari
   neraca saldo.
3. **Akun pada penyebab non-jurnal.** Akun yang tertinggal dari pilihan
   sebelumnya ditolak; menyimpannya diam-diam membuat baris SELESAI
   tampak seperti penyesuaian yang tidak pernah dibukukan.

**KOREKSI TERHADAP DRAF SAYA SENDIRI:** guard jenis rekening semula juga
memblokir `TIMING_DIFFERENCE` pada kas. §3 tiket hanya menyebut tiga
penyebab sebagai invalid untuk kas. Pembatasan itu **salah secara
operasional** — setoran tunai yang belum masuk pembukuan kas juga
perbedaan waktu — dan sudah dipersempit ke tiga penyebab sesuai tiket.

### 5. PeriodClose Fix (§4)
`getStatusRekonsiliasiPeriode(db, periodeMulai, periodeSelesai)` membatasi
pencarian ke **rentang periode yang sedang ditutup**, mengambil
pemeriksaan **terakhir DI DALAM periode** (bukan terakhir dari seluruh
histori). Rekening wajib = kas/bank terdaftar & aktif, **digabung**
dengan rekening yang sudah punya baris pemeriksaan dalam periode itu
(supaya DRAFT menggantung tidak hilang dari pengawasan kalau mapping
berubah).

Hasil: Juli tidak menggantikan Agustus; September tidak memenuhi
Agustus; rekening yang belum pernah diperiksa pada periode itu
memblokir. Pesan sesuai §4 ("belum tersedia" / "belum ditindaklanjuti").

### 6/7. Field Workflow & Treatment Matrix
Tidak berubah dari RC-S78. Hanya 3 penyebab boleh menjurnal
(biaya bank, jasa giro, selisih kas fisik); perbedaan waktu SELESAI
tanpa jurnal dengan status tetap SELISIH.

### 8. Service Guards
Seluruh penolakan diuji **beserta potret database sebelum/sesudah** —
tidak ada mutasi yang tertinggal dari kombinasi yang ditolak.

### 9. Tests
**Baru:** `RekonsiliasiRcS79.test.ts` — **38 test** (17 service guard,
12 PeriodClose A–I, 9 UI termasuk §2E).
**Diperbarui** (karena perilakunya memang berubah, bukan dilonggarkan):
`RekonsiliasiRcS67_9`, `PenyesuaianRakuRcS53`, `Fase10AuditFinalRcS53`,
`ReleaseGateAkrualBungaUtangRcS71_1`.
Pada tiga berkas terakhir, rekening ujinya adalah KAS sementara fixture
memakai `BIAYA_ADMIN_BANK`/`JASA_GIRO` — diganti `SELISIH_FISIK`
(padanan kas, sama-sama PERLU_JURNAL, dua arah) sehingga **jurnal, arah
debit/kredit, dan seluruh nilai accounting yang diuji TIDAK berubah**.
`ReleaseGateAkrualBungaUtangRcS71_1` diberi helper rekonsiliasi agar
gerbang yang diuji tetap gerbang akrual, bukan gerbang rekonsiliasi baru.
**Tidak ada test dihapus. Tidak ada expected accounting value diubah.**

### 10. TypeScript
`npx tsc --noEmit` → **0 error**.

### 11. Full Jest
| | RC-S78 | RC-S79 |
|---|---|---|
| Suite | 264 (257 PASS / 7 FAIL) | 265 (**258 PASS** / 7 FAIL) |
| Test | 4969 (4964 PASS / 5 FAIL) | 5007 (**5002 PASS** / 5 FAIL) |

5 FAIL + 2 suite gagal-muat = **ENVIRONMENTAL, PRE-EXISTING**
(`KontrolAkhirRcS53`, `PolicyRegisterRcS53` — dokumen kebijakan `.md`
di root tidak ikut ZIP repack). Himpunan nama test yang gagal
dibandingkan otomatis: **identik**.

### 12. Accounting Safety
Tidak ada perubahan formula saldo/selisih, journal semantics,
debit/kredit, COA, SHU, cash flow classification, reversal, idempotency.
AccountingEngine/Ledger/ShuService/PinjamanService/LoanImpairmentService/
StartupTasks tidak disentuh. Jurnal tetap `REKONSILIASI_KAS_BANK`,
seimbang, closed-period guard utuh, penyelesaian kedua tetap ditolak.

### 13. Database Safety
**NO CHANGE.** Tidak ada migrasi baru — seluruh enum dan kolom yang
dibutuhkan sudah tersedia sejak v71 (RC-S78). SCHEMA_VERSION tetap 71.

### 14. Regression
**0 regression baru.**

### 15. Device Verification
**NOT VERIFIED.** Tidak ada emulator/perangkat, dan renderer RN tidak
tersedia di Jest repo ini. Klaim visual (hierarki, safe area, wrap teks
panjang, tidak ada horizontal overflow) ditegakkan **source-level**.
Smoke test di perangkat masih diperlukan sebelum rilis.

### 16. Open Findings (tetap — TIDAK diklaim selesai)

**TEMUAN 1 — dua jalur pembayaran Keluar Anggota / subledger berbeda**
(RC-S76/S77). `keluarAnggota()` menulis `simpanan_transaksi`,
`bayarKeluarAnggota()` tidak. Lapisan baca & pencarian sudah menerima
keduanya, tetapi jalurnya **belum disatukan**. Laporan yang membaca
`simpanan_transaksi` masih melihat pengembalian jalur persetujuan
sebagai tidak ada. **Tetap OUT OF SCOPE.**

**TEMUAN 2 — outstanding loan anggota keluar** (RC-S75/S76). Detail
pengajuan hanya menampilkan informasi transparansi; tidak ada workflow
penagihan dan tidak ada perubahan loan collection policy. **Belum
selesai.**

**TEMUAN 3 — cakupan test pencarian bukti** (RC-S77). Guard hanya
memastikan query keempat jenis bukti lain tidak melempar, belum menguji
kebenaran hasil pencariannya. **Belum selesai.**

**TEMUAN 4 — export rekonsiliasi belum ada** (§2F, baru). Tidak ada
builder export rekonsiliasi di source. Bila laporan rekonsiliasi
dibutuhkan, itu pekerjaan tersendiri.

**CATATAN POSISI:** taksonomi penyebab adalah **desain kontrol internal
aplikasi**. Tidak ada klaim bahwa SAK EP mewajibkan daftar ini.

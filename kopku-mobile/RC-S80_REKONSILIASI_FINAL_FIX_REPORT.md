# RC-S80 — REKONSILIASI FINAL FIX
## REPORT

**STATUS: `RC-S80 — CLEAR`**

### Root Cause

**BUG #1 — CTA berpindah tanpa menyimpan.** `jalankanCta` memanggil
`navigation.navigate(...)` langsung untuk `KE_TRANSAKSI`/`KE_RIWAYAT`,
tanpa menyentuh `simpan()`. Akibatnya "Simpan Temuan & Buka Transaksi"
tidak pernah menyimpan temuan apa pun: begitu pengguna berpindah dan
tidak jadi mengoreksi, penyebabnya hilang tanpa jejak — dan periode
dapat ditutup seolah tidak pernah ada selisih.

**BUG #2 — nominal palsu di PeriodClose.** `selisih: status === 'SELISIH' ? 1 : 0`
membuat ringkasan penutupan melaporkan "selisih Rp1" untuk kekurangan
kas berapa pun, tepat di layar yang dipakai untuk memutuskan apakah
periode boleh ditutup.

**BUG #3 — mapping akun khusus.** Audit `defaultCOA.ts`: **tidak ada**
`transaction_type` khusus untuk penyesuaian rekonsiliasi
(`REKONSILIASI`, `BIAYA_ADMIN_BANK`, `JASA_GIRO`, `SELISIH_FISIK`
semuanya tidak ada). Sesuai §4, karena mapping khusus tidak tersedia:
tidak boleh mengarang mapping, tidak boleh auto-select.

### Fix

1. **`simpan()` kini mengembalikan `Promise<boolean>`.** CTA menunggu
   hasilnya dan **berhenti bila gagal**; navigasi hanya terjadi setelah
   penyimpanan berhasil. Penolakan single-flight (`DIABAIKAN`),
   exception, dan guard form-belum-siap semuanya mengembalikan `false`.
   Tidak ada mutation baru — memakai `catatRekonsiliasiDanTindakLanjut`
   yang sudah ada.

2. **`getStatusRekonsiliasiPeriode` membawa `selisih` aktual** (bertanda),
   dan PeriodClose memakainya langsung. Penanda `? 1 : 0` dihapus.
   Semantik blokir **tidak berubah**: COCOK/TIMING+SELESAI/adjustment
   dengan jurnal valid → allow; DRAFT & baris SELESAI tak konsisten →
   block; scope tetap periode yang ditutup.

3. **Akun khusus: kebijakannya adalah "wajib eksplisit + divalidasi".**
   Karena tidak ada mapping khusus, service tetap menolak submission
   tanpa akun, dan memvalidasi kategori (kurang→BEBAN, lebih→PENDAPATAN),
   keaktifan, dan keberadaan akun. Diuji bahwa service **tidak punya
   fallback/auto-select** sama sekali.

### Files Changed
- `src/screens/Akuntansi/RekonsiliasiScreen.tsx` — save-first CTA.
- `src/services/CashReconciliationService.ts` — `selisih` pada read-model periode.
- `src/services/PeriodCloseService.ts` — pakai nominal aktual.
- `src/__tests__/RekonsiliasiRcS80.test.ts` — **BARU**.

Tidak ada perubahan pada AccountingEngine, Ledger, ShuService,
PinjamanService, LoanImpairmentService, StartupTasks, Keluar Anggota,
schema, atau navigasi.

### Tests
`RekonsiliasiRcS80.test.ts` — **12 test**: save-first (3), PeriodClose
nominal & scope (4), special mapping (5, termasuk audit COA dan bukti
tidak ada auto-select). Setiap penolakan diverifikasi **database
byte-identical**; pembacaan 10× juga byte-identical.
**Tidak ada test dihapus atau dilonggarkan.**

### TypeScript
`npx tsc --noEmit` → **0 error**.

### Full Jest
| | RC-S79 | RC-S80 |
|---|---|---|
| Suite | 265 (258 PASS / 7 FAIL) | 266 (**259 PASS** / 7 FAIL) |
| Test | 5007 (5002 PASS / 5 FAIL) | 5019 (**5014 PASS** / 5 FAIL) |

5 FAIL + 2 suite gagal-muat = **ENVIRONMENTAL, PRE-EXISTING**
(`KontrolAkhirRcS53`, `PolicyRegisterRcS53` — dokumen kebijakan `.md`
di root tidak ikut ZIP repack). Himpunan nama test yang gagal
dibandingkan otomatis: **identik**.

### Accounting
**NO CHANGE.** Formula saldo/selisih, journal semantics, debit/kredit,
COA, SHU, cash flow classification, reversal, idempotency tidak
disentuh. Jurnal tetap `REKONSILIASI_KAS_BANK` dan seimbang.

### Database
**NO CHANGE.** Tanpa migrasi; SCHEMA_VERSION tetap 71.

### Regression
**0 regression baru.**

### Device
**NOT VERIFIED.** Tidak ada emulator/perangkat, dan renderer RN tidak
tersedia di Jest repo ini. Perbaikan save-first ditegakkan lewat audit
struktural sumber (bentuk `await simpan()` → `if (!tersimpan) return;`
→ `navigate`), **bukan** lewat simulasi tap di perangkat. Smoke test
masih diperlukan sebelum rilis.

### Open Findings (tetap — TIDAK diklaim selesai)
1. **Dua jalur pembayaran Keluar Anggota / subledger berbeda**
   (RC-S76/S77) — belum disatukan. OUT OF SCOPE.
2. **Outstanding loan anggota keluar** (RC-S75/S76) — hanya
   transparansi, belum ada workflow penagihan.
3. **Cakupan test pencarian bukti** (RC-S77) — guard hanya memastikan
   query tidak melempar, belum menguji kebenaran hasilnya.
4. **Export rekonsiliasi belum ada** (RC-S79 §2F) — tidak ada builder
   export rekonsiliasi di source; pekerjaan tersendiri bila dibutuhkan.
5. **Mapping akun khusus rekonsiliasi belum ada di COA** (baru) —
   kebijakan saat ini "wajib pilih eksplisit + validasi kategori". Bila
   koperasi menginginkan akun biaya bank/jasa giro yang terkunci,
   itu keputusan kebijakan + penambahan mapping tersendiri.

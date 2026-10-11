# HOTFIX RC-S74 — Kewajiban / Utang Bunga: Estimasi Real-time + Sembunyikan Rp0 Basi

Basis: `koperasi-finance_v108.8.3-RC-S74-INTEREST-LOADING-FINAL` (repack). Bukan RC baru.

## 1. Ringkasan hasil

| Pemeriksaan | Sebelum | Sesudah |
|---|---|---|
| `tsc --noEmit` | 0 error | 0 error |
| Suite Jest | 255 (248 PASS / 7 FAIL) | 257 (250 PASS / 7 FAIL) |
| Test Jest | 4733 (4728 PASS / 5 FAIL) | 4771 (4766 PASS / 5 FAIL) |
| Kegagalan baru | — | **0** |
| Test dihapus | — | 0 (KewajibanRcS74: 123 → 123) |

Ketujuh suite yang gagal identik sebelum dan sesudah, dan semuanya **pre-existing
karena lingkungan**: dokumen root `POLICY_DECISION_RC-S53.md`, `POLICY_REGISTER_RC-S53.md`,
`RC-S58_DEVICE_QA_CHECKLIST.md`, `RC-S57_AKRUAL_BUNGA_UTANG_ARCHITECTURE.md` tidak ikut
di ZIP repack ini (ENOENT / `existsSync` false). Tidak ada yang terkait kode.

Lingkungan: `npm install --ignore-scripts --legacy-peer-deps`, Jest asli (bukan harness).

## 2. File yang berubah

Produksi (4):

- `src/services/StartupTasks.ts` — metadata runtime saja: `waktuMulaiTugas`, riwayat durasi
  aktual (maks 5), `getStatusTugasStartup()`, `MAKS_SAMPEL_DURASI_TUGAS`. Isi batch dipindah
  **apa adanya** ke `jalankanLangkahTugas()` (urutan langkah identik) agar pengukuran
  membungkusnya utuh. Tanpa timer, tanpa DB, tanpa persist.
- `src/screens/Transaksi/bayarUtangGate.ts` — tahap readiness baru `AKRUAL_GAGAL`;
  `akrualBungaGagalUntuk()`; `infoDariDetail(…, akrualGagal = false)`; `teksMemuatBunga(proses, berjalanMs)`
  + `hitungSisaEstimasiDetik()` menggantikan teks bertahap lama (ambang 3/8 detik dihapus bersih).
- `src/hooks/useDetikMemuat.ts` — parameter opsional `mulaiMs` (titik mulai proses nyata).
  Tetap hanya mengimpor `react`.
- `src/screens/Transaksi/BayarUtangFormScreen.tsx` — potret metadata sebelum gate, blok
  memuat baru (spinner + estimasi + penjelasan), blok "Perhitungan belum selesai".

Test (1 diubah, 2 baru):

- `src/__tests__/KewajibanRcS74.test.ts` — diperbarui (lihat §7).
- `src/__tests__/EstimasiAkrualRealtimeRcS74Hotfix.test.ts` — **baru**, 33 test.
- `src/__tests__/SkenarioBayarKewajibanRealtimeRcS74Hotfix.test.ts` — **baru**, 5 test (SQLite sungguhan).

**Tidak disentuh:** PinjamanService, LoanImpairmentService, AccountingEngine, Ledger,
FinancialReports, PeriodCloseService, UtangService, UtangBungaAccrualService, ShuService,
schema, migrasi, jurnal, mapping. Formula, rate, WHOLE_MONTH, catch-up, idempotensi,
reversal, PeriodClose: tidak berubah.

## 3. Root cause

Audit menunjukkan kode RC-S74 **sudah** menahan Rp0 selama StartupTasks berjalan (tahap
`MEMUAT` dipasang sebelum `tungguTugasStartupSelesai()`). "Rp0 + Perlu Perhatian" masih
bisa muncul lewat dua jalur lain:

**A. Mesin akrual gagal (DIPERBAIKI).** `jalankanAkrualBungaUtangJikaPerlu` menelan error
(`dijalankan: false`, atau `KEGAGALAN_TEKNIS` per utang). Gate tetap lolos, read-model
mengembalikan keadaan *sebelum* akrual (Rp0, `PERLU_PERHATIAN`), dan layar menampilkannya
sebagai `SIAP` — nilai basi diperlakukan sebagai hasil final. Dibuktikan nyata oleh
TEST 11 di test skenario (mapping akrual dirusak → mesin gagal → read-model Rp0).

**B. Request one-shot belum dikonsumsi (BELUM DIPERBAIKI — butuh keputusan).** Bila
pengguna menyimpan utang lalu ke Bayar Kewajiban lewat tab Transaksi tanpa membuka
Dashboard, tidak ada batch yang berjalan, gate lolos seketika, dan read-model basi
terbaca. Lihat §8.

## 4. State flow baru

Readiness (milik layar) tetap terpisah dari status accounting (milik service):

```
pilih utang
  └─ potret getStatusTugasStartup()  (variabel modul; bukan DB, bukan pemicu)
  └─ MEMUAT ──► await tungguTugasStartupSelesai()   ← satu-satunya penentu selesai
                 └─ getStatusBungaSemuaUtang()       ← dibaca SEKALI, setelah gate
                 └─ akrualBungaGagalUntuk(getHasilAkrualBungaUtangTerakhir())
                      ├─ read-model gagal/tidak ada  → TIDAK_TERSEDIA (—, terkunci)
                      ├─ mesin gagal untuk utang ini → AKRUAL_GAGAL   (—, terkunci)
                      └─ selain itu                  → SIAP (nilai + status accounting apa adanya)
```

- MEMUAT tidak pernah merender Rp, status, atau pesan periode.
- `SIAP` + Rp0 tetap tampil Rp0 (hasil accounting yang sah; TEST 10 skenario).
- Status `TERKENDALI / MENUNGGU_PERIODE / KONTRAK_BELUM_LENGKAP / PERLU_PERHATIAN` tetap
  dari service. Kondisi data (kontrak belum lengkap, periode tertutup, dibalik) **bukan**
  kegagalan.
- `AKRUAL_GAGAL`: "Perhitungan belum selesai — Gagal memperbarui akrual otomatis."
  + "Coba lagi" (pola existing: hanya membaca ulang; tidak ada pemicu akrual di layar).
  Akrual dicoba lagi oleh jalur existing (`app/index.tsx`, saat aplikasi aktif kembali).

## 5. Cara estimasi dihitung

1. Setiap batch StartupTasks mencatat `Date.now()` saat **benar-benar mulai** dieksekusi
   (batch berantai mencatat mulainya sendiri).
2. Batch yang selesai normal menyimpan durasi aktualnya; batch yang melempar tidak dicatat.
3. `estimasiMs` = rata-rata 5 durasi terakhir (rolling average, memori proses saja).
4. Layar: `sisa = max(0, ceil((estimasiMs − waktuBerjalanMs) / 1000))`, waktu berjalan
   diukur dari mulainya batch (bukan dari saat layar dibuka), diperbarui tiap detik
   oleh hook tampilan.

| Kondisi | Teks |
|---|---|
| Tidak ada proses latar (pembacaan singkat) | `Menghitung otomatis…` |
| Proses berjalan, belum ada riwayat | `Menghitung otomatis…` · `Estimasi beberapa detik` |
| Proses berjalan, sisa ≥ 1 detik | `Menghitung otomatis…` · `Estimasi selesai dalam ±N detik` |
| Estimasi terlampaui, belum selesai | `Menghitung otomatis…` · `Proses masih berjalan…` |

Contoh dari test: riwayat 8,7 / 9,2 / 8,9 dtk → 8,933 dtk → "±9", lalu ±8 … ±1, lalu
"Proses masih berjalan…". Angka tidak pernah negatif.

**Tidak ada "9" yang di-hardcode.** Dijaga test struktural terhadap `/±\s*9\b|\b9\s*detik|\b9000\b|\b9_000\b|estimasi\w*\s*=\s*\d/`
pada layar, helper, hook, dan StartupTasks.

**Estimasi bukan timeout** (dibuktikan test): estimasi terlampaui 60 detik → gate tetap
menunggu, task tidak dibatalkan, tidak ada batch kedua, hasil tidak dipaksa.

## 6. Pemetaan test wajib (§17/§18)

| # | Wajib | Bukti |
|---|---|---|
| 1–3 | Saat berjalan: bukan Rp0, bukan Perlu Perhatian, tampil "Menghitung otomatis…" | Skenario §18 test 1; Estimasi "TEST 1–3" |
| 4 | Estimasi dari durasi aktual | Estimasi "TEST 4", rolling average; Skenario test 2 (durasi terukur nyata) |
| 5 | Tanpa riwayat → "Estimasi beberapa detik" | Estimasi "TEST 5"; Skenario test 1 |
| 6 | Waktu berjalan → sisa turun | Estimasi "TEST 6" |
| 7 | Tidak pernah negatif | Estimasi "TEST 7" |
| 8 | Timer cleanup | Estimasi "TEST 8" (selesai, Coba lagi, unmount, tanpa interval ganda) |
| 9 | Setelah selesai → `getStatusBungaSemuaUtang()` | Estimasi "TEST 9/12" (urutan); Skenario test 1 |
| 10 | Rp0 accounting sah tetap tampil | Skenario "TEST 10"; Estimasi "TEST 10" |
| 11 | Task gagal → bukan Rp0 valid | Skenario "TEST 11" (kegagalan mesin nyata); Estimasi "TEST 11" |
| 12 | Tanpa polling DB per detik | Estimasi "TEST 12" (satu panggilan, di efek ber-dependensi `[utang?.id, muatUlangBunga]`) |
| §18 | Skenario pengguna persis | `SkenarioBayarKewajibanRealtimeRcS74Hotfix.test.ts` test 1 |

## 7. Test lama yang diperbarui — perlu sign-off

Aturan "tidak mengubah expected value supaya lulus" dijaga ketat. Perubahan di
`KewajibanRcS74.test.ts` terjadi karena **spesifikasi tiket ini membatalkan spesifikasi
sebelumnya secara eksplisit**. Setiap perubahan ditandai `DIPERBARUI HOTFIX RC-S74 (estimasi real-time)`.

- Test "perkiraan jujur … **tanpa countdown/ETA angka**" (ambang 3/8 dtk, "Waktu berjalan: N detik")
  → diganti "estimasi jujur": angka hanya dari durasi aktual, tanpa riwayat tetap kualitatif,
  lewat estimasi tanpa angka, tidak pernah negatif.
- Teks "Perkiraan beberapa detik" → "Estimasi beberapa detik" (3 tempat).
- Blok memuat: `{memuat.perkiraan ?` / `{memuat.berjalan ?` → `{memuat.estimasi ?` / `{memuat.penjelasan ?`.
- String sumber yang dicocokkan persis: baris impor StartupTasks, `teksMemuatBunga(...)`,
  `useDetikMemuat(...)`, dan `setInfoBunga(infoDariDetail(utangId, detail, akrualGagal))`
  (4 tempat; maksud test — hasil diterapkan hanya bila efek masih aktif — tetap).
- TEST 8 hook: ekspektasi teks mengikuti helper baru; assertion timer/cleanup tidak berubah.

Tidak ada test accounting (jurnal, saldo, akrual, idempotensi) yang diubah. Jumlah test
di suite ini tetap 123.

## 8. Temuan terbuka — butuh keputusan (jalur B)

`SkenarioBayarKewajibanRealtimeRcS74Hotfix.test.ts` › "BATAS YANG DIKETAHUI" mendokumentasikan
perilaku saat ini: utang disimpan → request one-shot aktif → Dashboard **tidak** dibuka →
Bayar Kewajiban menampilkan `SIAP / Rp0 / PERLU_PERHATIAN`.

Tidak diperbaiki karena setiap perbaikan menyentuh larangan tiket:

1. Layar mengonsumsi request lalu memanggil `jalankanTugasStartup()` — melanggar "jangan
   menjalankan akrual dari BayarUtangFormScreen" dan arsitektur one-shot via Dashboard.
2. Layar menampilkan "memproses" selama request tertunda — berbohong, karena tidak ada
   proses yang berjalan (dan tidak akan selesai sampai Dashboard dibuka).
3. Opsi yang jujur dan dalam batas: tahap readiness baru "Belum diperbarui — buka Dashboard
   untuk menghitung bunga", tombol terkunci. Ini keputusan UX/alur yang mengunci pembayaran,
   jadi menunggu persetujuan.

Opsi alternatif di luar layar: memindahkan konsumsi request ke titik yang pasti dilewati
(mis. navigator Transaksi saat fokus). Itu mengubah arsitektur RC-S74 dan juga butuh sign-off.

## 9. Batasan lain

- Render UI tetap tidak dapat diuji (tidak ada renderer RN di Jest repo ini). Layar
  diverifikasi lewat helper murni yang sama dengan yang dirender, harness hook, dan audit
  struktural sumber. Tampilan akhir (hierarki, spinner, pembungkusan teks panjang di kolom
  kanan) perlu dicek di perangkat.
- Riwayat durasi hanya di memori: setiap kali aplikasi dimatikan, estimasi kembali ke
  "beberapa detik" sampai satu batch selesai. Ini sesuai §6 (tanpa migrasi).
- Estimasi mewakili satu batch. Bila batch lain dirantai saat layar menunggu, teks akan
  beralih ke "Proses masih berjalan…" (tidak pernah angka palsu).
- Layar Bayar Kewajiban kini mengunci pembayaran pada `AKRUAL_GAGAL`, konsisten dengan
  penguncian `TIDAK_TERSEDIA` yang sudah ada (angka bunga yang terlihat tidak final).
  Dampak akuntansi dari membayar di atas akrual yang tertinggal TIDAK diaudit di sesi ini;
  penguncian dipilih sebagai sikap konservatif, bukan karena bug yang terbukti.


---

# ADDENDUM — HOTFIX RC-S74 (FINAL): GLOBAL STARTUP TASK COORDINATOR

Basis: `koperasi-finance_v108.8.3-RC-S74-HOTFIX-ESTIMASI-BUNGA` (sesi sebelumnya).
Tiket ini memperbaiki temuan terbuka §8 dari laporan di atas.

## 1. Ringkasan hasil

| Pemeriksaan | Sebelum (addendum ini) | Sesudah |
|---|---|---|
| `tsc --noEmit` | 0 error | 0 error |
| Suite Jest | 257 (250 PASS / 7 FAIL) | 257 (250 PASS / 7 FAIL) |
| Test Jest | 4771 (4766 PASS / 5 FAIL) | 4777 (4772 PASS / 5 FAIL) |
| Kegagalan baru | — | **0** (himpunan kegagalan identik persis) |

Ketujuh suite yang gagal tetap sama persis: dokumen `.md` root yang tidak ikut ZIP
repack (lingkungan, bukan kode). Regresi dijalankan penuh (bukan subset) dan
dibandingkan otomatis terhadap baseline sesi sebelumnya — himpunan nama test yang
gagal **identik** sebelum dan sesudah.

## 2. Root cause bug aktual

`requestStartupTask()` sebelumnya hanya dikonsumsi oleh `DashboardScreen` saat
fokus. Kalau pengguna menyimpan Utang Koperasi lalu **tidak pernah membuka
Dashboard** (mis. Penerimaan → Transaksi → Bayar Kewajiban langsung),
`startupTaskRequested` tetap `true` tanpa pernah dikonsumsi, `tugasBerjalan`
tetap `null`, `tungguTugasStartupSelesai()` di `BayarUtangFormScreen` resolve
seketika (tidak ada task berjalan), dan read-model lama (Rp0 + PERLU_PERHATIAN)
terbaca sebagai hasil final.

## 3. File produksi yang berubah

- **`app/index.tsx`** — komponen root aplikasi (`Index`), lifecycle root yang
  tetap mounted selama `phase === 'READY'` **terlepas layar mana yang
  difokuskan pengguna** (`RootNavigator` di bawahnya hanya menentukan tampilan;
  `Index` sendiri yang terus hidup dan hook-nya tetap aktif). Menambah:
  - 3 baris `useAppStore` baru: `currentUser`, `startupTaskRequested`, `consumeStartupTaskRequest`.
  - Satu `useEffect` baru (GLOBAL APPLICATION COORDINATOR), reactive terhadap
    perubahan `startupTaskRequested` — bukan polling, bukan dipanggil dari
    `useEffect` transisi READY/restore/auto-lock yang sudah ada:
    ```ts
    useEffect(() => {
      if (phase !== 'READY' || !startupTaskRequested || !currentUser) return;
      if (!consumeStartupTaskRequest()) return;
      jalankanTugasStartup(currentUser.id).catch(() => {});
    }, [phase, startupTaskRequested, currentUser, consumeStartupTaskRequest]);
    ```
  - Tidak ada baris existing yang diubah atau dihapus. Transisi ke READY
    (login/unlock/restore) tetap memanggil `jalankanTugasStartup(user.id)`
    apa adanya (dibuktikan test "TEST 14").
- **`src/screens/Dashboard/DashboardScreen.tsx`** — trigger lama dihapus:
  - Blok `if (currentUser && consumeStartupTaskRequest()) { jalankanTugasStartup(...) }`
    di dalam `useFocusRefresh` dihapus; `useFocusRefresh` sekarang hanya berisi
    `load()`, `muatStatusIdentitas()`, `muatStatusLisensi()`.
  - `currentUser`, `consumeStartupTaskRequest` (dari `useAppStore`) dan impor
    `jalankanTugasStartup` dihapus karena tidak lagi dipakai di layar ini.
  - Dashboard **tidak lagi mengimpor** `@/services/StartupTasks` sama sekali.

Tidak ada perubahan pada `src/store/useAppStore.ts` (API `requestStartupTask` /
`consumeStartupTaskRequest` / `startupTaskRequested` dipakai apa adanya, sama
seperti sebelumnya) dan tidak ada perubahan pada `src/services/StartupTasks.ts`,
`src/screens/Transaksi/UtangFormScreen.tsx`, atau `src/screens/Transaksi/BayarUtangFormScreen.tsx`.

## 4. Flow setelah patch

```
UtangFormScreen
  └─ terimaUtang() berhasil
  └─ requestStartupTask()          (menandai bendera one-shot di store)
       ↓ (store berubah)
GLOBAL APPLICATION COORDINATOR (app/index.tsx, selalu mounted saat READY)
  └─ useEffect bereaksi terhadap perubahan startupTaskRequested
  └─ consumeStartupTaskRequest()   (baca + matikan bendera, atomic)
  └─ jalankanTugasStartup(currentUser.id)   (TIDAK di-await; koordinator existing yang SAMA)
       ↓
StartupTasks.tugasBerjalan tetap gate tunggal (semantics tidak berubah)
       ↓
BayarUtangFormScreen (atau layar mana pun)
  └─ tungguTugasStartupSelesai()   (menunggu promise NYATA, bukan estimasi)
  └─ getStatusBungaSemuaUtang()    (dibaca setelah task benar-benar selesai)
```

Dashboard tidak lagi menjadi bagian dari alur ini sama sekali — request
dikonsumsi terlepas apakah Dashboard pernah difokuskan dalam sesi tersebut.

## 5. Mengapa Dashboard tidak lagi diperlukan

`app/index.tsx` (komponen `Index`) adalah satu-satunya komponen yang menentukan
`phase` aplikasi dan selalu dirender ketika `phase === 'READY'` — `RootNavigator`
(berisi Dashboard, Transaksi, dll.) hanya salah satu cabang `return` dari
komponen ini. Karena React tidak meng-unmount `Index` saat pengguna berpindah
tab/layar di dalam `RootNavigator`, hook-hook `Index` (termasuk `useEffect`
coordinator baru) tetap aktif dan bereaksi terhadap perubahan state store
`startupTaskRequested`, apa pun layar yang sedang dilihat pengguna. Dashboard
hanyalah salah satu dari banyak layar yang *mungkin* dikunjungi — tidak pernah
seharusnya menjadi syarat untuk proses latar accounting.

## 6. Pembuktian (structural + runtime, keduanya diuji)

- **BayarUtangFormScreen tidak memanggil koordinator apa pun** — assertion
  `not.toMatch(/jalankanAkrualBungaUtangJikaPerlu|jalankanTugasStartup|.../)`
  pada sumber layar (sudah ada dari sesi sebelumnya, tetap berlaku; tidak ada
  baris di layar itu yang diubah sesi ini).
- **Tidak ada polling DB** — assertion terhadap isi efek coordinator baru
  (`not.toMatch(/setInterval|setTimeout|AppState.addEventListener/)`) dan
  terhadap `useFocusRefresh` Dashboard yang sudah dipangkas.
- **Tidak ada hardcode 9 detik** — mekanisme estimasi dari sesi sebelumnya
  tidak disentuh; test struktural yang sudah ada tetap menjaga larangan ini di
  `app/index.tsx` secara implisit lewat cakupan `tanpaKomentar(baca(...))`
  yang sama.
- **Skenario SQLite nyata, tanpa Dashboard sama sekali** — test baru
  `'BUG AKTUAL DIPERBAIKI (HOTFIX final §11) — Dashboard TIDAK PERNAH dibuka: ...'`
  di `SkenarioBayarKewajibanRealtimeRcS74Hotfix.test.ts` menjalankan urutan
  persis dari tiket (simpan utang → request aktif → **coordinator global**
  mengonsumsi, direplikasi dari logika efek `app/index.tsx` yang sama persis →
  Bayar Kewajiban dibuka saat task berjalan) dan membuktikan:
  - `getStatusTugasStartup().berjalan` berubah dari `false` ke `true` **tanpa**
    DashboardScreen pernah diimpor/di-mount/di-fokuskan di test tersebut;
  - `startupTaskRequested` kembali `false` setelah satu konsumsi (one-shot);
  - tampilan: `"Menghitung otomatis…"` selama proses, lalu `"Rp208.333 | Terkendali"`
    setelah selesai — **tidak pernah** `Rp0` atau `Perlu Perhatian`.
- **Tidak ada batch paralel** — test baru `'perubahan startupTaskRequested
  berulang sebelum task selesai -> hanya SATU batch'` membuktikan panggilan
  kedua ke replika efek coordinator gagal meng-consume (bendera sudah habis)
  selama task pertama masih berjalan.

## 7. Test yang berubah/ditambah

`src/__tests__/KewajibanRcS74.test.ts` (123 → **127** test; 0 dihapus):
- Describe `'DashboardScreen: mengonsumsi request saat fokus, memanggil
  koordinator existing'` **diganti total** menjadi dua describe baru:
  - `'DashboardScreen: TIDAK LAGI mengonsumsi request — hanya pekerjaan
    Dashboard'` (2 test) — membuktikan Dashboard tidak lagi mengimpor/memanggil
    apa pun dari `StartupTasks`.
  - `'GLOBAL APPLICATION COORDINATOR (app/index.tsx): mengonsumsi request
    terlepas layar yang difokuskan'` (6 test, termasuk TEST 14) — membuktikan
    struktur efek baru di `app/index.tsx`: dua pembacaan store, guard urutan
    (phase → request → user → consume → panggil), tidak di-`await`, terpisah
    dari efek transisi phase lain, tanpa polling.
- Skenario device end-to-end: komentar & satu test baru (`'BUG AKTUAL YANG
  DIPERBAIKI: request tanpa Dashboard PERNAH dibuka -> coordinator TETAP
  mengonsumsi'`) ditambahkan; test lama di describe ini tidak diubah nilainya.

`src/__tests__/SkenarioBayarKewajibanRealtimeRcS74Hotfix.test.ts` (5 → **7** test):
- Helper `dashboardFokus()` diganti nama & isi menjadi `coordinatorGlobal()`,
  mereplikasi persis logika efek baru `app/index.tsx` (bukan lagi meniru
  Dashboard). Test lama yang memakainya (test 1 dan 2) tidak berubah maksud —
  hanya nama helper & komentar yang diperbarui, assertion tetap sama.
- Test `'BATAS YANG DIKETAHUI (belum diperbaiki, butuh keputusan)'` yang
  sebelumnya mendokumentasikan bug ini **dihapus dan digantikan** oleh test
  `'BUG AKTUAL DIPERBAIKI (HOTFIX final §11)'` yang membuktikan perilaku
  BENAR (bukan lagi batas yang diketahui). Ini bukan "mengubah expected value
  agar lulus" — ini mengganti dokumentasi bug yang telah diperbaiki dengan
  bukti perbaikannya, sesuai instruksi §10/§11 tiket.
- Satu test baru: `'perubahan startupTaskRequested berulang sebelum task
  selesai -> hanya SATU batch'`.
- Satu test baru: `'perubahan state TANPA request tertunda tidak pernah
  memicu StartupTasks'`.

Tidak ada test accounting yang diubah nilainya. `EstimasiAkrualRealtimeRcS74Hotfix.test.ts`
tidak disentuh sama sekali (33 test, tetap seperti sesi sebelumnya).

## 8. Larangan tiket — status

Tidak diubah: formula bunga, rate, WHOLE_MONTH, catch-up, idempotensi,
reversal, PeriodClose, jurnal, COA, database/schema/migration. Tidak ada
trigger akrual baru di `BayarUtangFormScreen` (tetap seperti sesi sebelumnya).
Tidak ada polling database. Dashboard tidak lagi menjalankan StartupTasks
sama sekali (dihapus, bukan dikondisikan ulang) — jadi tidak ada lagi
"StartupTasks dijalankan setiap Dashboard fokus" dalam bentuk apa pun. Tidak
ada timer palsu, tidak ada hardcode 9 detik, tidak ada countdown progress
palsu — mekanisme estimasi dari sesi sebelumnya tidak disentuh.

## 9. Acceptance criteria — terbukti

Skenario tiket (Simpan Utang → requestStartupTask() → **tanpa** membuka
Dashboard → buka Bayar Kewajiban → task berjalan → UI "Menghitung otomatis… /
Estimasi selesai dalam ±N detik" → task selesai → UI "Utang Bunga RpX / status
aktual", **tidak pernah** Rp0 + Perlu Perhatian sebagai hasil sementara)
dibuktikan end-to-end dengan SQLite dan mesin akrual asli di
`SkenarioBayarKewajibanRealtimeRcS74Hotfix.test.ts`.

## 10. Batasan yang masih sama

- Render UI tetap tidak dapat diuji langsung (tidak ada renderer RN di Jest
  repo ini) — diverifikasi lewat audit struktural sumber dan replikasi logika
  efek di level test, seperti sesi-sesi sebelumnya.
- `AppState` listener (auto-lock) dan coordinator baru berbagi komponen yang
  sama (`Index`) tetapi efeknya independen (dependency array terpisah) —
  tidak diverifikasi di perangkat fisik untuk interaksi auto-lock ↔ coordinator
  saat aplikasi kembali dari background dengan request tertunda; secara logis
  aman (coordinator hanya bergantung pada `phase === 'READY'` dan bendera
  store, keduanya tidak dipengaruhi oleh transisi lock/unlock kecuali fase
  berubah dari `READY`, yang berarti request tetap tertunda sampai kembali ke
  `READY` — tidak hilang, tidak dobel).


---

# ADDENDUM 2 — HARDENING RC-S74 (FINAL): TUTUP RACE WINDOW COORDINATOR

Basis: `koperasi-finance_v108.8.3-RC-S74-HOTFIX-GLOBAL-COORDINATOR`.

## J. Hasil (TypeScript / Jest / Regression / Device)

| Pemeriksaan | Sebelum addendum ini | Sesudah |
|---|---|---|
| `tsc --noEmit` | 0 error | **0 error** |
| Suite Jest | 257 (250 PASS / 7 FAIL) | 258 (251 PASS / 7 FAIL) |
| Test Jest | 4777 (4772 PASS / 5 FAIL) | 4792 (**4787 PASS** / 5 FAIL) |
| Kegagalan baru | — | **0** |

**CODE PASS.** Himpunan nama test yang gagal dibandingkan otomatis
sebelum/sesudah: **identik byte-per-byte** (5 test, 2 suite gagal-muat).

**ENVIRONMENT FAILURE** (bukan kode, sama persis seperti sesi-sesi
sebelumnya): 5 test gagal + 2 suite gagal dimuat
(`KontrolAkhirRcS53.test.ts`, `PolicyRegisterRcS53.test.ts`) karena dokumen
kebijakan `.md` di root (`POLICY_DECISION_RC-S53.md`,
`POLICY_REGISTER_RC-S53.md`, dll.) tidak ikut dalam ZIP repack.

**DEVICE NOT VERIFIED.** Tidak ada emulator/perangkat Android di lingkungan
ini. UI realtime (spinner, teks estimasi) **belum** diverifikasi secara
fisik. Yang dilakukan: audit sumber, helper test, scenario test SQLite,
TypeScript, Jest penuh.

## A. Root cause final — race window secara konkret

Implementasi sebelumnya memakai `useEffect` berdependensi:

```ts
useEffect(() => { ...consume...; jalankanTugasStartup(...) },
          [phase, startupTaskRequested, currentUser, consumeStartupTaskRequest]);
```

`requestStartupTask()` → `set({ startupTaskRequested: true })` → Zustand
memanggil listener-nya **SINKRON** (`listeners.forEach(...)` di dalam
`setState`, lihat `node_modules/zustand/vanilla.js`). Tetapi binding React
(`useAppStore((s) => s.xxx)`) hanya **menjadwalkan re-render**; `useEffect`
baru berjalan **setelah commit** — asinkron. Jendela nyata:

```
requestStartupTask()            // state true, SINKRON
  ↓  [JENDELA: render+commit React belum jalan]
user membuka Bayar Kewajiban
  ↓
getStatusTugasStartup()         // berjalan: FALSE  ← masih kosong
tungguTugasStartupSelesai()     // resolve SEKETIKA
getStatusBungaSemuaUtang()      // read-model LAMA → Rp0 + PERLU_PERHATIAN
```

Masalahnya bukan lagi "Dashboard tidak dibuka", melainkan **scheduling
effect React**.

## B. File produksi yang berubah (1 file)

- **`app/index.tsx`**:
  - `useRef` ditambahkan ke impor React.
  - `phaseRef` (di badan komponen, `phaseRef.current = phase` setiap
    render — bukan di dalam efek) agar listener sinkron selalu membaca
    `phase` terbaru tanpa stale closure.
  - `useEffect(..., [])` baru berisi `useAppStore.subscribe(...)`: langganan
    **mentah** ke store, didaftarkan sekali, di-unsubscribe saat unmount.
  - Efek lama tetap ada, kini berperan sebagai **fallback READY**.

Tidak ada file produksi lain yang berubah. `useAppStore.ts`,
`StartupTasks.ts`, `UtangFormScreen.tsx`, `BayarUtangFormScreen.tsx`,
`DashboardScreen.tsx` semuanya **tidak disentuh** di addendum ini.

## C. Arsitektur final

```
requestStartupTask()                       [SINKRON — set() Zustand]
   ↓ listeners.forEach(...)                [SINKRON — di dalam set()]
useAppStore.subscribe(...) di app/index.tsx
   ↓ rising edge + phaseRef READY + currentUser
consumeStartupTaskRequest()                [SINKRON — atomic]
   ↓
jalankanTugasStartup(currentUser.id)       [tugasBerjalan diset SINKRON]
   ↓
BayarUtangFormScreen: getStatusTugasStartup() → berjalan: TRUE
   ↓ tungguTugasStartupSelesai()           [menunggu Promise NYATA]
getStatusBungaSemuaUtang()                 [hasil aktual]
```

## D. Mengapa race sudah tidak mungkin pada jalur READY

Seluruh rantai dari `requestStartupTask()` sampai `tugasBerjalan` terpasang
berjalan dalam **satu call stack sinkron**, tanpa satu pun `await`, timer,
atau siklus render React. Dibuktikan `TEST A`:

```ts
useAppStore.getState().requestStartupTask();
expect(getStatusTugasStartup().berjalan).toBe(true);   // TANPA await apa pun
```

Sesuai §30 tiket, bukti ini **bukan** `await waitFor(...)`.

**Batas yang didokumentasikan jujur (bukan bug):** pada instan sinkron itu
`getStatusTugasStartup().mulaiMs` masih `null` — `waktuMulaiTugas` baru
ditetapkan di dalam body batch, satu microtask kemudian. Gate sudah
terpasang; hanya stempel waktunya menyusul. Layar sudah menanganinya apa
adanya (`proses.mulaiMs ?? Date.now()`), selisih <1 ms, angka estimasi
identik. Sengaja **tidak** diubah karena memindahkan penetapan
`waktuMulaiTugas` keluar dari body batch akan mengubah arti "durasi batch
aktual" yang menjadi dasar rolling average. Dikunci test `CASE 2/29`.

## E. Request aman bila phase belum READY

Listener sinkron **sengaja tidak mengonsumsi** bila `phaseRef.current !==
'READY'` atau `currentUser` kosong — bendera tetap `true`, tidak hilang
(test `CASE 5/29`). Begitu `phase` menjadi `READY`, efek fallback
berdependensi mengonsumsinya **tepat satu kali**; panggilan berikutnya
mengembalikan `false` dan tidak membuat batch kedua.

## F. Pencegahan duplicate batch

1. **Rising edge**: listener hanya bertindak pada `false → true`. Penting,
   karena listener Zustand tanpa selector terpanggil untuk perubahan field
   **apa pun** (lisensi, restore, lock) — dan juga agar tidak bereaksi pada
   `set({ startupTaskRequested: false })` dari consume-nya sendiri.
2. **Consume atomic**: siapa pun lebih dulu (listener atau fallback)
   menang; yang lain dapat `false`.
3. **Single-flight `tugasBerjalan`**: semantics `StartupTasks` tidak
   diubah.

**Catatan jujur:** dua permintaan yang benar-benar berbeda (dua utang
disimpan sebelum batch pertama selesai) tetap memicu dua
`jalankanTugasStartup()`. Itu **benar**: batch pertama mulai sebelum utang
kedua ada, jadi tidak bisa mengakrualnya. Yang dicegah adalah **paralel** —
dibuktikan test yang memeriksa urutan `mulai → selesai → mulai → selesai`,
tidak pernah tumpang tindih.

## G/H. BayarUtangFormScreen & Dashboard

- `BayarUtangFormScreen.tsx` **tidak mengandung** `jalankanTugasStartup`
  maupun `jalankanAkrualBungaUtangJikaPerlu` (TEST 21). Ia hanya membaca
  metadata, menampilkan loading, menunggu Promise, membaca read-model.
- `DashboardScreen.tsx` **tidak mengimpor `@/services/StartupTasks` sama
  sekali** (TEST 20), hanya `load()` / `muatStatusIdentitas()` /
  `muatStatusLisensi()`.

## I. Estimasi tetap dari durasi aktual

`getStatusTugasStartup()` dan rolling average durasi batch **tidak
disentuh**. Test struktural memastikan tidak ada `±9`/`9 detik`/`9000`
hardcoded dan tidak ada `setTimeout`/`setInterval` di coordinator (TEST 22).

## Test yang ditambah/diubah

- **BARU** `RaceConditionCoordinatorRcS74Hardening.test.ts` — **12 test**:
  TEST A (sinkron tanpa await), CASE 2/29, rising edge, larangan paralel,
  CASE 5/29, fallback satu kali, anti-dobel, TEST 19, TEST 20/21/22.
- `KewajibanRcS74.test.ts`: 127 → **129** (2 test struktural baru untuk
  listener sinkron & `phaseRef`; hitungan `jalankanTugasStartup(` 2 → 3).
- `SkenarioBayarKewajibanRealtimeRcS74Hotfix.test.ts`: 7 → **8** (§15:
  listener sinkron produksi + mesin akrual ASLI di SQLite).

Tidak ada test dihapus. **Tidak ada expected value accounting yang diubah.**

---

# FITUR — DETAIL SIMPANAN (READ-ONLY + NAVIGATION)

Basis: `koperasi-finance_v108.8.3-RC-S74-HOTFIX-RACE-HARDENING`.

## 7/8/9. Hasil TypeScript / Jest / Device

| Pemeriksaan | Sebelum | Sesudah |
|---|---|---|
| `tsc --noEmit` | 0 error | **0 error** |
| Suite Jest | 258 (251 PASS / 7 FAIL) | 259 (**252 PASS** / 7 FAIL) |
| Test Jest | 4792 (4787 PASS / 5 FAIL) | 4813 (**4808 PASS** / 5 FAIL) |
| Test baru | — | **+21** (semua PASS) |
| Kegagalan baru | — | **0** |

**CODE PASS.** Himpunan nama test yang gagal dibandingkan otomatis:
**identik** (5 test, 2 suite gagal-muat).

**ENVIRONMENT FAILURE** (sama seperti sesi sebelumnya, bukan kode):
`KontrolAkhirRcS53.test.ts` dan `PolicyRegisterRcS53.test.ts` gagal dimuat
karena dokumen kebijakan `.md` di root tidak ikut dalam ZIP repack.

**DEVICE NOT VERIFIED.** Tidak ada emulator/perangkat Android di
lingkungan ini, jadi smoke test §27 (tap baris → detail terbuka, cek
layout/overflow/teks terpotong) **belum** dilakukan secara fisik.

## 1. Root cause UX

`SimpananHistoriScreen` merender tiap transaksi sebagai `<View>` biasa —
tidak ada handler tekan sama sekali, sehingga daftar "Setor Simpanan"
adalah jalan buntu. Akibatnya `periode`, `sumber_dana`, dan terutama
**status koreksi** (`reversal_of_id`) tidak dapat dilihat di mana pun,
padahal `getSaldoSimpanan` sudah mengecualikan transaksi yang dikoreksi.
Pengguna bisa melihat sebuah setoran di daftar tanpa cara apa pun untuk
tahu bahwa setoran itu sudah dibatalkan.

## 2. File produksi yang berubah (4)

- **`src/services/SimpananService.ts`** — HANYA penambahan, dua fungsi baca:
  - `getSimpananDetailById(simpananId)` → `SimpananDetailRow | null`.
    Satu `SELECT` + `LEFT JOIN anggota` (bukan INNER, agar transaksi dengan
    anggota hilang tetap terbuka) + dua self-join yang menerjemahkan
    `reversal_of_id` dua arah menjadi `koreksiDariNomorTransaksi` dan
    `dikoreksiOlehNomorTransaksi`. Definisi "sudah dikoreksi" disamakan
    persis dengan `SIMPANAN_TIDAK_DIKOREKSI_CLAUSE` milik `getSaldoSimpanan`.
  - `getRingkasanSaldoSimpananAnggota(anggotaId)` — memanggil
    `getSaldoSimpanan` yang sama dengan seluruh aplikasi untuk
    Pokok/Wajib/Sukarela + total. Simpanan Berjangka **tidak** disertakan.

  `listSimpananHistori` sengaja tidak diperluas: layar histori memuat
  100.000 baris sekaligus, jadi menambah kolom yang hanya dipakai detail
  akan membebani setiap baris daftar.

- **`src/screens/Simpanan/SimpananDetailScreen.tsx`** — **BARU**. Hero
  (jenis → tipe → nominal besar), banner status koreksi dua arah, section
  Anggota / Detail Transaksi / Saldo Simpanan Saat Ini. `useFocusRefresh`
  (konvensi proyek), bukan polling.

- **`src/screens/Simpanan/SimpananHistoriScreen.tsx`** — baris `<View>`
  menjadi `<Pressable>` dengan `accessibilityRole="button"`, label
  bermakna, pressed state halus, dan chevron. Seluruh informasi dan fitur
  existing (tab, export, FAB, loading, empty) tidak berubah.

- **`src/navigation/RootNavigator.tsx`** — impor + satu
  `<TransaksiStack.Screen name="SimpananDetail">`.

## 3. File test (1 baru)

`src/__tests__/SimpananDetailScreen.test.ts` — **21 test**, dua lapis:
perilaku di SQLite sungguhan (SETOR/TARIK/KOREKSI, saldo, id tidak dikenal,
anggota hilang) dan audit struktural (larangan impor mutasi, label mapping,
formatter, rute, accessibility, fitur histori tidak hilang). Tidak ada test
existing yang diubah atau dihapus.

## 4. Route baru

`SimpananDetail` → `SimpananDetailScreen`, judul "Detail Simpanan",
terdaftar **tepat sekali**, di `TransaksiStack` — stack yang sama dengan
`SimpananHistori` (satu-satunya pemanggilnya), jadi tanpa nested navigator.
Parameter: **hanya** `{ simpananId }`; objek transaksi tidak pernah dikirim
lewat params (anti data basi). `AnggotaDetailScreen` sengaja tidak dipakai.

## 5. Service read-only yang dipakai

`getSimpananDetailById()` (baru), `getRingkasanSaldoSimpananAnggota()`
(baru, membungkus `getSaldoSimpanan` existing). Tidak ada service lain
yang dipanggil dari layar detail.

## 6. Struktur UI final

```
Simpanan Wajib                     ← jenis
Setoran                            ← status, teks (bukan hanya warna)
+Rp500.000                         ← hierarki visual utama

[banner koreksi bila ada]

ANGGOTA            Nama · Nomor Anggota
DETAIL TRANSAKSI   Nomor · Tanggal · Jenis · Tipe · Nominal ·
                   Sumber Dana · Periode · Keterangan
SALDO SIMPANAN SAAT INI
                   Pokok · Wajib · Sukarela · Total
```

Tanda nominal: `+` untuk SETOR, `-` untuk TARIK, netral untuk KOREKSI.
`journal_id`/`created_by`/id internal **tidak** ditampilkan — terlalu
teknis, dan tiket tidak memintanya.

## 10. Konfirmasi

- **Accounting tidak berubah** — hanya penambahan dua fungsi `SELECT`;
  `koreksiSimpanan`, `getSaldoSimpanan`, dan klausa exclusion tidak
  disentuh (dijaga test).
- **Schema tidak berubah, tidak ada migration, tidak ada tabel baru** —
  seluruh kolom yang dibaca sudah ada sejak sebelumnya.
- **Journal & reversal semantics tidak berubah** — layar detail tidak
  mengimpor `createJournal`, `reverseJournal`, `setorSimpanan`,
  `tarikSimpananSukarela`, maupun `koreksiSimpanan` (dijaga test).
- **Tidak ada polling** — `useFocusRefresh`, tanpa `setInterval`/`setTimeout`.
- **Tidak ada mutasi dari layar detail** — dibuktikan dengan potret
  `simpanan_transaksi` + `journal` + `journal_entry` sebelum/sesudah
  membuka detail tiga kali: **byte-identik**.

## Batasan

- Render UI tidak dapat diuji (tidak ada renderer RN di Jest repo ini) —
  tampilan diverifikasi lewat audit sumber, bukan render nyata.
- Sumber dana BANK ditampilkan sebagai "Bank" saja. Baris historis hanya
  menyimpan `bank_account_id` tanpa snapshot nama rekening, jadi
  menampilkan nama dari master bank saat ini akan menyajikan data
  sekarang sebagai fakta historis.
- Bagian saldo adalah posisi **terkini** anggota, bukan posisi pada
  tanggal transaksi — dinyatakan eksplisit di layar agar tidak menyesatkan.

---

# RESTRUKTURISASI — NAVIGASI DATA + ASAL PERSONEL (ANGGOTA / PIHAK LUAR)

Basis: `koperasi-finance_v108.8.3-RC-S74-DETAIL-SIMPANAN`.

## 10/11/12. TypeScript / Jest / Device

| Pemeriksaan | Sebelum | Sesudah |
|---|---|---|
| `tsc --noEmit` | 0 error | **0 error** |
| Suite Jest | 259 (252 PASS / 7 FAIL) | 260 (**253 PASS** / 7 FAIL) |
| Test Jest | 4813 (4808 PASS / 5 FAIL) | 4852 (**4847 PASS** / 5 FAIL) |
| Test baru | — | **+38** (semua PASS) |
| Kegagalan baru | — | **0** |

**CODE PASS.** Himpunan nama test yang gagal dibandingkan otomatis:
**identik** (5 test, 2 suite gagal-muat).

**ENVIRONMENT FAILURE** (bukan kode, konsisten sejak awal sesi):
`KontrolAkhirRcS53` & `PolicyRegisterRcS53` gagal dimuat karena dokumen
kebijakan `.md` di root tidak ikut ZIP repack.

**DEVICE NOT VERIFIED.** Tidak ada emulator/perangkat Android; smoke test
§39 belum dijalankan secara fisik.

## 1. ROOT CAUSE struktur lama

Master data koperasi terbelah di dua tempat yang tidak berhubungan.
Sebagian ada di hub Data; enam lainnya (Pengurus, Pengawas,
Pengelola/Karyawan/Pekerja, Perizinan, Unit Usaha, Peraturan Internal)
tersembunyi sebagai daftar pintasan DI DALAM form "Identitas Koperasi" —
layar yang namanya menjanjikan data koperasi (nama, alamat, NPWP), bukan
daftar orang. Untuk membuka Pengurus pengguna harus menebak jalurnya.

Selain itu `koperasi_personel` tidak punya relasi apa pun ke `anggota`,
sehingga pengurus yang juga anggota harus diketik ulang identitasnya.

## 2/3. File yang berubah

**Produksi (6):**
- `src/database/schema.ts` — SCHEMA_VERSION 69 → **70**; dua kolom
  ADITIF pada `koperasi_personel`: `sumber_data` (CHECK `ANGGOTA`/`LUAR`,
  default `LUAR`) dan `anggota_id` NULLABLE + `idx_personel_anggota`.
- `src/database/db.ts` — **`migrasiV70`** (migration baru).
- `src/services/KoperasiMasterService.ts` — tipe `SumberDataPersonel`,
  `LABEL_SUMBER_DATA`, validasi dua arah, dan logika SNAPSHOT identitas.
- `src/screens/Pengaturan/InputDataHubScreen.tsx` — tiga section.
- `src/screens/Pengaturan/IdentitasKoperasiScreen.tsx` — enam pintasan
  dihapus (data di database TIDAK disentuh).
- `src/navigation/RootNavigator.tsx` — empat master pindah ke
  AnggotaStack; rute RootStack & `DataKlasifikasiAset` dihapus.
- `src/screens/Pengaturan/MasterKoperasiScreens.tsx` — selector sumber
  data, `AnggotaPicker` existing, identitas read-only pada mode ANGGOTA.

**Test:** 1 baru (`RestrukturisasiDataPersonel.test.ts`, 38 test) +
2 diperbarui karena strukturnya memang berubah
(`IdentitasRuteIndependenRcS49b`, `MasterKoperasiUiRcS53`) +
**31 berkas** penyesuaian pin versi schema (lihat §PERINGATAN di bawah).

## 4. ROUTE sebelum/sesudah

| Rute | Sebelum | Sesudah |
|---|---|---|
| `PersonelKoperasi` | RootStack | **AnggotaStack** |
| `PerizinanKoperasi` | RootStack | **AnggotaStack** |
| `UnitUsahaKoperasi` | RootStack | **AnggotaStack** |
| `PeraturanInternal` | RootStack | **AnggotaStack** |
| `DataKlasifikasiAset` | AnggotaStack + TransaksiStack | **dihapus (2×)** |
| `InputDataHub` (judul) | "Input Data" | **"Data"** |

Masing-masing terdaftar TEPAT SEKALI. Karena kini sestack dengan hub
pemanggilnya, tombol Back kembali ke **Data**, bukan ke Identitas Koperasi.

## 5. Struktur menu Data final

```
KEANGGOTAAN & PERSONEL   Anggota · Pengurus · Pengawas ·
                         Pengelola / Karyawan / Pekerja
KELEMBAGAAN KOPERASI     Perizinan yang Dimiliki · Unit Usaha ·
                         Peraturan Internal · Pelaksanaan RAT
REFERENSI & AKUNTANSI    Akun · Saldo Awal · Data Bank · Data Pemasok ·
                         Data Pemberi Pinjaman ·
                         Data Bank Pemberi Pinjaman · Data Beban Lain
```
Tanpa "Data Klasifikasi Aset".

## 6/7. Flow personel & snapshot

**Mode ANGGOTA:** pilih anggota lewat `AnggotaPicker` existing →
identitas (nama, NIK, jenis kelamin, telepon, alamat) **DISALIN** ke baris
personel saat disimpan. Jabatan & masa jabatan tetap diedit manual.

**Mode LUAR:** identitas diketik manual, `anggota_id = NULL`. Tidak ada
anggota dummy yang dibuat.

**Perpindahan mode:** ANGGOTA→LUAR memutus tautan (`anggota_id = NULL`,
snapshot menjadi data manual); LUAR→ANGGOTA mewajibkan pilih anggota dan
memperbarui snapshot. Tidak ada `anggota_id` basi yang tertinggal —
dijaga validasi DUA ARAH di service.

**Mengapa snapshot, bukan JOIN:** memperbarui master Anggota TIDAK boleh
menulis ulang histori jabatan. Susunan pengurus periode lalu harus tetap
menunjukkan data sebagaimana tercatat saat itu; memperbaiki alamat
seorang anggota hari ini tidak boleh diam-diam mengubah dokumen
kepengurusan. Menautkan ulang secara eksplisit adalah satu-satunya cara
snapshot diperbarui (keduanya diuji).

**Dua domain berbeda yang TIDAK disamakan diam-diam:**
`anggota.jenis_kelamin` = `LAKI_LAKI`/`PEREMPUAN`, sedangkan
`koperasi_personel.jenis_kelamin` = `L`/`P` (CHECK). Diterjemahkan
eksplisit; nilai di luar keduanya tetap NULL, bukan ditebak. Kolom
teleponnya pun berbeda nama (`nomor_hp` vs `nomor_telepon`).

**Personel lama:** `sumber_data = 'LUAR'`, `anggota_id = NULL`. Itu BUKAN
klaim mereka orang luar, melainkan satu-satunya pernyataan yang jujur —
schema sebelum v70 tidak pernah menyimpan hubungan itu. Pencocokan
otomatis berdasarkan nama/NIK/telepon SENGAJA TIDAK dilakukan; diuji
dengan anggota ber-NIK identik yang tetap tidak ditautkan.

## 8. Bukti klasifikasi aset tetap bekerja

Menu & kedua rutenya hilang, tetapi `AsetKlasifikasiService.ts` dan
`config/defaultAsetKlasifikasi.ts` tetap ada dan tetap diimpor oleh
`PembelianAsetFormScreen`, `ModalFormScreen`, dan `AsetEditFormScreen`
(diuji). `DataKlasifikasiAsetScreen.tsx` sengaja tidak dihapus dari repo,
mengikuti pola `AsetListScreen`. **HAPUS MENU ≠ HAPUS FITUR.**

## 9. Bukti accounting tidak berubah

- Migrasi v70 **tidak menyentuh jurnal**: `journal` & `journal_entry`
  dibandingkan sebelum/sesudah — identik. `foreign_key_check` kosong.
- Baris personel lama byte-identik pada ke-13 kolom existing; `id` tidak
  berubah, sehingga `personel_id` transaksi historis tetap valid.
- Membuat/mengedit/menonaktifkan personel **tidak membuat jurnal**:
  potret `journal` + `journal_entry` byte-identik.
- Migrasi idempoten (dijalankan 2×, hasil identik).
- Tidak ada perubahan pada AccountingEngine, Ledger, ShuService,
  PinjamanService, UtangService, PeriodCloseService, ImbalanKerjaService.

## PERINGATAN — 31 berkas test disesuaikan (perlu sign-off)

Bump v69 → v70 memicu **21 kegagalan** di test lama. Semuanya satu pola:
assertion yang mengunci nomor versi secara ABSOLUT —
`expect(SCHEMA_VERSION).toBe(69)`, `not.toMatch(/currentVersion < 70/)`,
dan satu `schema_meta.version === 69`.

Yang dijaga assertion itu sebenarnya adalah **"tahap ini tidak menambah
migrasi sendiri"** — invarian yang TIDAK berubah. Yang rapuh adalah
encoding-nya: setiap bump versi di masa depan akan memecahkannya.

Disesuaikan: 22 pin konstanta → 70, 8 guard blok berikutnya → 71, 1 versi
akhir DB → 70. Masing-masing diberi catatan `DIPERBARUI RESTRUKTURISASI
DATA` yang menyatakan migrasi v70 milik pekerjaan ini, bukan tahap yang
diuji. Ini mengikuti preseden repo (RC-S54, RC-S55 melakukan hal sama).

**Tidak ada expected value accounting** (jurnal, saldo, mapping,
reversal, bunga) yang diubah. Tidak ada test yang dihapus.

## KEPUTUSAN VALIDASI (perlu sign-off)

`nama` kini wajib **hanya pada mode LUAR**. Pada mode ANGGOTA nama selalu
ditimpa snapshot, jadi mewajibkannya menuntut data yang dijamin dibuang.
Identitas tetap dijaga dua lapis: `anggotaId` wajib, dan
`ambilSnapshotAnggota()` melempar bila anggotanya tidak ada — tidak ada
jalur yang menghasilkan personel tanpa nama (diuji).

## Perbaikan test flaky (sesi ini)

`SkenarioBayarKewajibanRealtimeRcS74Hotfix` — satu assertion milik sesi
hotfix sebelumnya gagal intermiten ketika batch sebelumnya selesai <1 ms
(durasi terukur 0). Perilaku produksi BENAR (estimasi <= 0 → teks
kualitatif); assertion test-nya yang tidak mengakomodasi nilai 0.
Diperbaiki di test, bukan di produksi.

## Batasan

- Render UI tidak dapat diuji (tanpa renderer RN); layar diverifikasi
  lewat audit sumber.
- CHECK constraint `sumber_data` hanya hadir pada instalasi BARU.
  `ALTER TABLE ADD COLUMN` di SQLite tidak dapat membawa CHECK, dan
  rebuild tabel sengaja dihindari karena `koperasi_personel` dirujuk
  `personel_id` transaksi historis. Pada database hasil upgrade,
  batasannya ditegakkan di layer service (`validasiPersonel`).

---

# RESTRUKTURISASI UI/UX — KELUAR ANGGOTA SEBAGAI HUB

Basis: `koperasi-finance_v108.8.3-RC-S74-DATA-PERSONEL`.

## 9/10/11. TypeScript / Jest / Device

| Pemeriksaan | Sebelum | Sesudah |
|---|---|---|
| `tsc --noEmit` | 0 error | **0 error** |
| Suite Jest | 260 (253 PASS / 7 FAIL) | 261 (**254 PASS** / 7 FAIL) |
| Test Jest | 4852 (4847 PASS / 5 FAIL) | 4877 (**4872 PASS** / 5 FAIL) |
| Test baru | — | **+25** (semua PASS) |
| Kegagalan baru | — | **0** |

**CODE PASS.** Himpunan nama test yang gagal dibandingkan otomatis:
**identik** (5 test, 2 suite gagal-muat).

**ENVIRONMENT FAILURE** (konsisten sejak awal sesi, bukan kode):
`KontrolAkhirRcS53` & `PolicyRegisterRcS53` gagal dimuat karena dokumen
kebijakan `.md` di root tidak ikut ZIP repack.

**DEVICE NOT VERIFIED.** Tidak ada emulator/perangkat; smoke test §35
belum dijalankan secara fisik.

## 1. Root cause UI lama

Rute `KeluarAnggotaForm` memuat SATU layar panjang berisi dua pekerjaan
yang berbeda sifatnya: membuat pengajuan (input) dan
menyetujui/menolak/membayar (monitoring + aksi uang keluar). Keduanya
hanya dipisahkan sebuah judul di tengah, sehingga "Daftar Pengajuan"
baru terlihat setelah pengurus menggulir melewati seluruh form,
ringkasan hak, dan tombol Ajukan.

Yang membuatnya berisiko — bukan sekadar tidak rapi — kontrol **Sumber
Pembayaran (KAS/BANK)** berdiri di tengah layar yang sama, padahal ia
HANYA dipakai tombol Bayar. Kontrol yang menentukan dari mana uang
keluar dipajang pada layar yang dibuka orang untuk mengetik pengajuan.

## 2. File produksi yang berubah (5)

- **`KeluarAnggotaMenuScreen.tsx`** — **BARU**. Hub dua tile. Murni
  navigasi: tanpa state, tanpa service, tanpa `ScrollView`.
- **`DaftarKeluarAnggotaScreen.tsx`** — **BARU**. Daftar + filter status +
  aksi Setujui/Tolak/Bayar + Sumber Pembayaran. Logic **dipindah**, bukan
  disalin.
- **`keluarAnggotaLabels.ts`** — **BARU**. `LABEL_ALASAN_KELUAR` diangkat
  ke modul bersama; form dan daftar sama-sama merendernya, dan menyalin
  `Record` itu ke dua berkas berarti alasan baru bisa diterjemahkan di
  satu layar tapi tidak di layar lain.
- **`KeluarAnggotaFormScreen.tsx`** — dipersempit ke pengajuan saja
  (526 → 290 baris). Style yang menjadi mati ikut dibuang.
- **`RootNavigator.tsx`** + **`TransaksiPengeluaranScreen.tsx`** — rute
  baru; menu Pengeluaran menunjuk hub.

## 3. File test

`KeluarAnggotaHubRestructure.test.ts` (**BARU**, 25 test) + 3 test lama
diperbarui karena navigasinya memang berubah
(`ImbalanKeluarAnggotaUiRcS53`, `ExpenseIconRcS70_1`, `RuteTerjangkau`).
Tidak ada test dihapus; tidak ada expected value accounting diubah.

## 4. Route sebelum/sesudah

| | Sebelum | Sesudah |
|---|---|---|
| Menu Pengeluaran | → `KeluarAnggotaForm` | → **`KeluarAnggotaMenu`** |
| `KeluarAnggotaMenu` | — | **baru**, judul "Keluar Anggota" |
| `KeluarAnggotaForm` | form + daftar | pengajuan saja, judul "Pengajuan Keluar Anggota" |
| `DaftarKeluarAnggota` | — | **baru**, judul "Daftar Pengajuan" |

Ketiganya di `TransaksiStack` yang sama, masing-masing terdaftar tepat
sekali, tanpa nested navigator. Back: Pengajuan/Daftar → hub → Transaksi.

## 5/6. Struktur menu final & pemisahannya

```
Transaksi → Keluar Anggota (HUB)
   ┌──────────────────┐  ┌──────────────────┐
   │ Pengajuan        │  │ Daftar Pengajuan │
   │ Buat pengajuan   │  │ Lihat dan kelola │
   │ keluar anggota   │  │ pengajuan        │
   └──────────────────┘  └──────────────────┘
```

**Pengajuan** = input: pilih anggota, alasan, tanggal, ringkasan hak
(read-only dari `previewKeluarAnggota`), keterangan, tombol Ajukan.
Setelah berhasil → `goBack()` ke hub; pengguna memilih sendiri langkah
berikutnya (layar daftar memuat ulang saat difokuskan, jadi baris baru
pasti terlihat).

**Daftar Pengajuan** = monitoring + aksi: filter status (presentasi
saja — `listKeluarAnggota()` dipanggil sekali, chip tidak memicu query),
Sumber Pembayaran, dan aksi sesuai status database.

## 7. Service tetap satu

Keduanya memanggil `KeluarAnggotaService` yang sama. Tidak ada
`ServiceV2`/`Manager`/`Controller`. Form tidak lagi mengimpor
`listKeluarAnggota`, `setujuiKeluarAnggota`, `tolakKeluarAnggota`,
maupun `bayarKeluarAnggota`; layar daftar tidak mengimpor
`ajukanKeluarAnggota`/`previewKeluarAnggota` (keduanya diuji).

## 8. Accounting tidak berubah

- `KeluarAnggotaService.ts` **tidak disentuh sama sekali**.
- Alur DIAJUKAN → DISETUJUI → DIBAYAR diuji end-to-end di SQLite
  sungguhan; nilai berasal dari service, bukan dihitung layar.
- Jalur TOLAK final: membayar pengajuan yang ditolak tetap gagal —
  service tetap penegak, bukan penyembunyian tombol.
- Navigasi bolak-balik hub↔daftar (4×) dibandingkan byte-per-byte pada
  `journal`, `journal_entry`, `keluar_anggota`, `simpanan_transaksi`:
  **identik**. Tidak ada SQL/jurnal di ketiga layar.

## Temuan saat audit

Versi pertama hub menavigasi lewat `navigate(m.rute)` (nama rute
disimpan di field). Test keterjangkauan rute proyek menangkapnya:
pemindai statis hanya mengenali `navigate('X')` literal, sehingga
`DaftarKeluarAnggota` terbaca sebagai **rute yatim** — terdaftar tetapi
tampak tanpa jalan masuk. Diubah ke pola literal seperti hub-hub lain.
Test yang menangkap ini tidak dilonggarkan.

## Batasan

- Render UI tidak dapat diuji (tanpa renderer RN di Jest repo ini);
  klaim "hub muat dalam satu layar tanpa scroll" ditegakkan secara
  struktural (tanpa `ScrollView`, tile `flex: 1` + `minWidth`), bukan
  lewat pengukuran layout nyata.

# RC-S86 — Tax Engine Otomatis: PPh Pasal 4(2) atas Bunga Simpanan

## Ringkasan

Audit + pengembangan modul Pajak existing (RC-S84) menjadi tax engine
semi-otomatis, dengan **PRIORITAS UTAMA** pada PPh Pasal 4(2) atas bunga
simpanan anggota (PP 15/2009). Modul Pajak lama (`pajakPolicy.ts`,
`PajakService.ts`, layar `src/screens/Pajak/*`, mekanisme jurnal/COA/
idempotensi/reversal/periode-tutup, `RiwayatPajakScreen`) **dipertahankan
sepenuhnya** — tidak ada yang dibongkar ulang, hanya diperluas secara aditif.
PPh 25/PPh 29/dashboard-lengkap dari instruksi awal **belum** dikerjakan di
sesi ini (lihat "Belum dikerjakan" di bawah) — sesi ini fokus tuntas pada
item prioritas utama sesuai arahan bertahap pengguna.

## Audit alur existing (sebelum coding)

Bunga simpanan anggota **hanya** ada di Simpanan Berjangka (Simpanan Pokok/
Wajib/Sukarela tidak punya mekanisme bunga sama sekali). `UtangBungaAccrualService`
adalah bunga atas **utang koperasi ke pihak lain** — bukan bunga simpanan
anggota — sengaja **tidak disentuh**.

Siklus bunga simpanan berjangka punya **dua** titik "menjadi hak anggota":

```
AKRUAL (Dr Beban / Cr 2-1710 Utang Bunga)      <- BELUM tersedia bagi anggota, BUKAN titik pajak
        |
        ├── §B TRANSFER ke Simpanan Sukarela   <- SUDAH bisa dipakai/ditarik anggota -> TITIK PAJAK
        |   (SimpananBerjangkaLifecycleService.prosesTransferBungaKeSukarelaPadaDb)
        |
        └── PENCAIRAN — sisa bunga yang BELUM pernah   <- TITIK PAJAK (hanya bagian yang belum dibayar)
            ditransfer, dibayar tunai saat kontrak cair
            (cairkanSimpananBerjangka)
```

Keputusan pengguna (dikonfirmasi eksplisit): pajak dipotong mengikuti
**peristiwa pembayaran**, bukan nama prosesnya — jadi dipasang di KEDUA
titik itu, TIDAK di akrual.

## File yang diubah/dibuat

| File | Perubahan |
|---|---|
| `src/config/pajakPolicy.ts` | + `KODE_UTANG_PPH_BUNGA_SIMPANAN` (2-1901) masuk `AKUN_PAJAK_BARU`/`KODE_UTANG_PAJAK_SETORAN`/`KODE_AKUN_RIWAYAT_PAJAK`; + `hitungPphBungaSimpanan()`, `hitungPphBungaSimpananPeriode()` (per bulan masa bunga) |
| `src/services/PphPotongService.ts` **(baru)** | Tabel aditif `pajak_potong_bunga_simpanan` (self-heal idempoten); `catatBuktiPotongBungaSimpananPadaDb()`; `listBuktiPotongPphBungaSimpanan()`; `getRingkasanPphBungaSimpananBulanIni()` |
| `src/services/SimpananBerjangkaLifecycleService.ts` | Hook di §B transfer & pencairan — jurnal pembayaran memisahkan bruto/PPh/netto dalam SATU jurnal; `simpanan_transaksi.nominal` untuk Sukarela = NETTO |
| `src/services/PajakService.ts` | + `idAkunUtangPphBungaSimpanan()` (akun 2-1901, pola sama `pastikanAkunPajak()`); `RingkasanPajak` + `pphBungaSimpananBulanIni`; `listRiwayatPajak` mengklasifikasi jenis baru `PPH_BUNGA_SIMPANAN` |
| `src/screens/Pajak/PajakMenuScreen.tsx` | Kartu ringkasan bulan berjalan PPh 4(2) Bunga Simpanan (jumlah bukti potong + total pajak) |
| `src/screens/Pajak/RiwayatPajakScreen.tsx` | Ikon & label jenis riwayat baru; catatan pembatalan diarahkan ke layar Simpanan Berjangka |
| `src/__tests__/PphBungaSimpananRcS86.test.ts` **(baru)** | 17 test — lihat di bawah |
| `src/__tests__/CashFlowClassificationRcS54.test.ts` | 1 assertion diperbarui — regex source-code lama mengunci bentuk literal §B (2 baris tetap) yang memang berubah bentuk (kredit ke Sukarela kini `netto`, bukan `p.bunga`) |

## Migrasi database

**TANPA menaikkan `SCHEMA_VERSION`** (pola sama RC-S84). Tabel baru
`pajak_potong_bunga_simpanan` dibuat idempoten (`CREATE TABLE IF NOT
EXISTS`) di dalam transaksi pencatatan pertama — sama seperti akun pajak
existing. Kolom: `simpanan_berjangka_id, bunga_periode_id, nomor_periode,
anggota_id, masa_pajak, bruto, pajak, netto, peristiwa, journal_id,
nomor_bukti_potong (UNIQUE), tanggal, created_by, created_at`. Status
dibatalkan/tidak **diturunkan** dari `journal.status` jurnal
pembayarannya (bukan kolom flag terpisah yang bisa tidak sinkron).

Akun baru: **2-1901 "Utang PPh Pasal 4(2) Bunga Simpanan"** — LIABILITAS,
muncul di COA hanya setelah transaksi pajak pertama benar-benar terjadi
(kontrak dengan bunga di atas Rp240.000/bulan), sama seperti 1-1410/
2-1904/2-1905 di RC-S84.

## Cara idempotensi & reversal bekerja (desain kunci)

Pajak **tidak** dibuatkan jurnal terpisah — ia menumpang di JURNAL
PEMBAYARAN YANG SAMA (§B atau pencairan):

```
§B (per periode):
  Dr 2-1710 Utang Bunga Simpanan Berjangka     bruto
  Cr 2-1901 Utang PPh Ps.4(2) Bunga Simpanan   pajak (hanya bila > 0)
  Cr 2-1200 Simpanan Sukarela Anggota          netto

Pencairan (sisa periode yang belum pernah dibayar):
  Dr 2-1210 Simpanan Berjangka                 pokok
  Dr 2-1710 Utang Bunga Simpanan Berjangka     bruto sisa
  Cr 2-1901 Utang PPh Ps.4(2) Bunga Simpanan   total pajak sisa (hanya bila > 0)
  Cr Kas/Bank                                  pokok + bruto sisa − total pajak
```

Konsekuensi:
- **Tidak mungkin dipotong dua kali** — idempotensi §B/pencairan yang SUDAH
  ADA (tidak diubah) otomatis mencegah dua jurnal pembayaran untuk periode
  yang sama, jadi otomatis mencegah dua pemotongan pajak juga.
- **Reversal otomatis rekonsiliasi** — membalik jurnal pembayaran (lewat
  `reverseJournal()` generik yang sudah ada) membalik SELURUH baris
  sekaligus (bunga *dan* pajak), tanpa jurnal pajak terpisah yang bisa
  tertinggal tidak sinkron. (Perilaku §B existing yang **tidak diubah**:
  jurnal reversal mewarisi `sumber_transaksi`/`sumber_id` yang sama dan
  berstatus POSTED, sehingga periode yang sudah dibalik **tidak**
  diproses ulang otomatis — butuh tindakan baru yang disengaja, bukan
  catch-up diam-diam. Ini konsisten dengan desain §B lama, bukan
  perubahan RC-S86.)
- **Bukti potong WAJIB terbit, termasuk tarif 0%** — dicatat di jurnal
  pembayaran yang sama, terlepas dari nilai pajaknya.

## Contoh perhitungan (dari test)

| Kasus | Bruto | PPh | Netto |
|---|---|---|---|
| Rp240.000 (tepat batas) | 240.000 | **0** | 240.000 |
| Rp240.001 | 240.001 | **24.000** (floor 10%) | 216.001 |
| Rp300.000 | 300.000 | **30.000** | 270.000 |
| Jan Rp250.000 (dibayar April, bersama Feb+Mar) | 250.000 | **25.000** | 225.000 |
| Feb Rp150.000 (dibayar bersamaan) | 150.000 | **0** | 150.000 |
| Mar Rp100.000 (dibayar bersamaan) | 100.000 | **0** | 100.000 |
| **Total 3 bulan digabung** | 500.000 | **25.000** (bukan 10% × 500.000 = 50.000) | 475.000 |

## Test (17 baru, semua lulus)

`src/__tests__/PphBungaSimpananRcS86.test.ts`:
- §A (murni, tanpa DB): 6 test — tarif, pembulatan, dan perhitungan multi-bulan per periode.
- §B1: jurnal §B di atas batas — Dr 2-1710 bruto / Cr 2-1901 pajak / Cr 2-1200 netto, bukti potong tercatat.
- §B2: di bawah/pas batas — tidak ada baris 2-1901 sama sekali (akun tidak dibuat), bukti potong tetap terbit (pajak Rp0).
- §B3: akrual saja (belum dibayar) → nol bukti potong.
- §B4: periode yang sudah ditransfer §B tidak dipotong lagi saat pencairan; kontrak bebas pajak pencairan tanpa transfer sebelumnya.
- §B5: multi-bulan tertunggak (250rb/150rb/100rb) dibayar sekaligus saat pencairan → PPh hanya dari periode pertama.
- §B6: reversal jurnal §B membalik 2-1901 & 2-1200 sekaligus; tidak pernah dipotong dua kali setelahnya.
- §B7: dipanggil 3× berturut-turut untuk periode yang sama → tetap 1 bukti potong.
- §B8: jurnal SHU_DISTRIBUSI (dibuat langsung, di luar SimpananBerjangkaLifecycleService) tidak pernah menghasilkan baris pajak_potong_bunga_simpanan — membuktikan isolasi dari SHU.

## Hasil regresi penuh

| | Sebelum | Sesudah |
|---|---|---|
| `tsc --noEmit` | 0 error | 0 error |
| Modul Pajak + SimpananBerjangka (8 suite inti) | 223/223 | 223/223 (tidak berubah — seluruh fixture existing memakai bunga ≤ Rp240.000/periode, jadi pajak = 0 dan output identik) |
| Suite baru RC-S86 | — | 17/17 |
| Seluruh suite lain (~274 file, dijalankan penuh dalam beberapa batch) | 7 gagal (dok. kebijakan tidak ikut ZIP) | **7 gagal — IDENTIK**: `PendapatanKoperasiRcS67`, `PendapatanBungaCoaRcS70_6`, `TemporalIntegrityRcS58`, `ReleaseHardeningRcS57`, `ImbalHasilTetapRcS67_6`, `KontrolAkhirRcS53`, `PolicyRegisterRcS53` — bukan regresi |
| 1 test struktural diperbarui | — | `CashFlowClassificationRcS54.test.ts` (regex source §B, perubahan bisnis disengaja, dijelaskan di atas) |

**Tidak ada regresi.** Karena tax hook hanya aktif saat bunga per periode
> Rp240.000, dan seluruh fixture existing berada di bawah batas itu,
perilaku lama 100% identik tanpa perubahan output di mana pun kecuali di
kontrak yang benar-benar melewati ambang pajak.

## Belum dikerjakan (di luar prioritas utama sesi ini)

Sesuai instruksi awal pengguna tapi belum disentuh — menunggu giliran
sesi berikutnya:
- `Pph25CalculationService` (dasar angsuran tahunan, bukan hitung dari laba bulanan).
- Traceability tambahan PPh Badan/29 (`sumberPerhitungan`, `nomorSPT`, dst.).
- Audit ulang PPh Final RC-S84 (cakupan omzet per skema).
- Layar terpisah "Bukti Potong PPh 4(2)" (backend `listBuktiPotongPphBungaSimpanan()` sudah siap, hanya kartu ringkasan bulan berjalan yang sudah disambungkan ke `PajakMenuScreen`; daftar bukti potong 0% belum punya layar sendiri — saat ini hanya bisa dibaca lewat riwayat ledger untuk yang pajak > 0).

## Batasan & keputusan kebijakan terbuka

- Tarif & ambang Rp240.000, serta prosedur administrasi setor/lapor
  (PMK 81/2024 mencabut PMK 112/PMK.03/2010), **wajib dikonfirmasi ulang**
  ke konsultan pajak sebelum go-live — komentar di `pajakPolicy.ts` sudah
  mencatat ini eksplisit.
- Reversal §B/pencairan saat ini hanya bisa dipanggil lewat
  `reverseJournal()` langsung (AccountingEngine) — belum ada tombol UI
  khusus untuk membatalkan transfer/pencairan Simpanan Berjangka
  (di luar cakupan RC-S86; perilaku existing yang tidak diubah).

# RC-S84 — Menu Pajak (Pengeluaran > Kewajiban > Pajak)

## Ringkasan
Menu Pajak baru untuk koperasi: PPh Final 0,5% (PP 55/2022 jo. PP 20/2026), angsuran PPh 25, PPh Badan akhir tahun (29), Setor Pajak, Riwayat Pajak, dan Pengaturan Pajak. Tanpa migrasi skema, tanpa perubahan rumus akuntansi existing, tanpa perubahan COA default.

## Hasil tes
| | Baseline (sebelum) | Sesudah |
|---|---|---|
| Suite | 278 (271 lulus, 7 gagal) | 279 (272 lulus, 7 gagal) |
| Tes | 5.270 (5.265 lulus, 5 gagal) | 5.301 (5.296 lulus, 5 gagal) |
| `tsc --noEmit` | 0 error | 0 error |

Tujuh suite yang gagal IDENTIK di baseline dan sesudah — seluruhnya karena dokumen kebijakan yang tidak ikut di ZIP (`POLICY_REGISTER_RC-S53.md`, `POLICY_DECISION_RC-S53.md`, dokumen arsitektur/QA): PendapatanKoperasiRcS67, PendapatanBungaCoaRcS70_6, TemporalIntegrityRcS58, ReleaseHardeningRcS57, ImbalHasilTetapRcS67_6, KontrolAkhirRcS53, PolicyRegisterRcS53. Bukan regresi.

Catatan jujur: run penuh sesudah perubahan sempat menemukan 1 regresi (UiInputStandardizationRcS54 — FlatList di Riwayat Pajak tanpa `keyboardShouldPersistTaps` pada layar ber-Modal + input). Diperbaiki, lalu suite itu dan 9 suite terkait (323 tes) dijalankan ulang: semua lulus. Suite penuh tidak diulang setelah perbaikan satu atribut JSX tersebut.

Lingkungan: 1 CPU, `jest --runInBand`. Dependensi dipasang dari `package-lock.json` (`npm ci --ignore-scripts`).

## Berkas
Baru:
- `src/config/pajakPolicy.ts` — aturan murni (tarif, pembulatan, batas fasilitas, lebih bayar, NTPN, masa).
- `src/services/PajakService.ts`
- `src/screens/Pajak/` — PajakUi (komponen bersama), PajakMenu, PengaturanPajak, PphFinalForm, AngsuranPph25Form, PphBadanForm, SetorPajakForm, RiwayatPajak.
- `src/__tests__/PajakRcS84.test.ts` — 31 tes.

Diubah (aditif):
- `CashFlowClassification.ts` — `PAJAK_PENGAKUAN: 'NON_KAS'`.
- `HistoryTransaksiService.ts` — label `PAJAK_PENGAKUAN`.
- `RootNavigator.tsx` — 7 rute baru di TransaksiStack.
- `TransaksiPengeluaranScreen.tsx` — kartu "Pajak" di grup KEWAJIBAN.
- `TransaksiUiRcS68_1.test.ts` — jumlah item Pengeluaran 11 -> 12 (menu baru atas instruksi pengguna; dianotasi DIPERBARUI, pola sama RC-S70.3/RC-S71). Daftar grup tidak berubah.
- `ATURAN_BISNIS.md` — §19 Pajak.

## Keputusan arsitektur
1. **Tanpa migrasi skema.** Menaikkan SCHEMA_VERSION mematahkan ~22 tes yang mematok 72. Pengaturan di `app_config`; masa di `journal.sumber_id`; NTPN & masa setoran di keterangan jurnal.
2. **Akun baru disisipkan idempoten per kode** (1-1410, 2-1904, 2-1905; `is_system = 1`) di dalam transaksi pencatatan pertama, bukan di DEFAULT_ACCOUNTS. Konsekuensi: akun muncul di COA setelah transaksi pajak pertama.
3. **Kartu di grup Kewajiban**, bukan grup baru — daftar grup dikunci tes, dan secara makna pajak adalah kewajiban koperasi.
4. **Reuse mesin yang ada**: setoran -> `bayarKewajibanCoa()` (tolak melebihi saldo); PPh 25 -> `catatPengeluaran()` (cek saldo kas, idempotensi); pengakuan -> `createJournal()`; pembatalan -> `reverseJournal()`.
5. Identitas akun pajak berdasarkan **kode** (pola sama dengan 5-2200 di LHU), bukan mapping, supaya tidak menambah transaction_type ke registry.

## UI/UX
- Semua warna/spasi/tipografi dari token existing; tidak ada hex baru (dikunci tes). Aksen merah Pengeluaran seperti sub-menu lain.
- Hub: ringkasan "Utang pajak belum disetor" di atas, menu per langkah kerja (Pencatatan, Pembayaran, Lainnya). Menu pencatatan mengikuti skema — pengguna tidak ditawari transaksi yang tidak berlaku.
- Setiap form menampilkan **Pratinjau jurnal** sebelum simpan.
- Omzet PPh Final tidak bisa diketik; pengguna hanya menyalakan/mematikan akun pendapatan (dapat ditelusuri ke buku besar).
- Setelah PPh Final / PPh Badan tercatat: tombol langsung "Setor sekarang" / "Setor PPh 29".
- Status kelayakan, masa sudah dicatat, masa berjalan, dan omzet > Rp4,8 miliar tampil sebagai catatan bernada (info/peringatan/galat).

## Temuan audit statis
- Lebih bayar pada Bayar Kewajiban SUDAH diblokir sejak RC-S74 §9, jadi Setor Pajak otomatis aman.
- Jurnal reversal memakai `sumber_id` yang sama; pemeriksaan duplikat wajib `reversal_of_id IS NULL` (sudah).
- Idempotensi BUG-07 akan mengembalikan efek lama untuk kunci yang sama walau jurnalnya sudah dibalik; angsuran PPh 25 yang dicatat ulang setelah dibatalkan memakai kunci bernomor (`PAJAK:PPH25:<masa>:<n>`). Dikunci tes.
- `RekeningPicker` di Setor Pajak dibatasi KAS/BANK karena `bayarKewajibanCoa` tidak menerima Kas Kecil.

## Keterbatasan & keputusan kebijakan terbuka
- POLICY: penyajian PPh Final (sementara ke 5-2200 / baris pajak LHU).
- POLICY: lebih bayar PPh Badan (ditolak keras).
- POLICY: pemotongan PPh 21/23/4(2) belum dibuat (menyentuh Beban, Imbalan Kerja, Simpanan Berjangka). Kode 2-1901..2-1903 dicadangkan.
- Batas omzet Rp4,8 miliar hanya peringatan.
- "Beban Pajak Penghasilan" masih ada di form Beban umum (tidak dihapus agar tidak mengubah alur lain).
- Tarif & batas waktu wajib dikonfirmasi ke konsultan pajak.
- Render UI tidak bisa diuji di lingkungan ini (tanpa RN testing library); perlu dicek di perangkat.

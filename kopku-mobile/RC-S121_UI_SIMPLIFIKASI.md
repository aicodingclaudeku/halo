# RC-S121 — UI Simplification: Pendapatan Diterima Dimuka, Splash, Menu Keamanan

Baseline: `KOPKU-terbaru12.zip`. Prinsip: **UI simplification only**. Tidak ada perubahan service, jurnal, COA, database, schema, migration, laporan, atau dependency.

## 1. Temuan audit

Akun **2-1300 Pendapatan Diterima Dimuka** dipakai oleh dua mekanisme yang berbeda:

| Mekanisme | Sumber | Tabel register |
|---|---|---|
| **Otomatis** (inti) | `PinjamanService` (fee integral, jasa dimuka angsuran/pelunasan) → `EirAccountingService` (amortisasi) → `AkrualJasaPinjamanService` (pengakuan jasa) | tidak memakai `pendapatan_diterima_dimuka` |
| **Manual** (legacy) | `PendapatanDimukaFormScreen` → `terimaPendapatanDimuka()` | satu-satunya pengisi `pendapatan_diterima_dimuka` |

Data register manual lama tetap diakui bertahap lewat **Status Periode Penyusutan** (`jalankanPengakuanPeriode`).

Koreksi atas komentar lama di kode: pengakuan tersebut **tidak** dipanggil otomatis oleh `PeriodCloseService`. Pengakuan hanya terjadi lewat tombol di Status Periode. Perilaku ini tidak diubah.

## 2. Perubahan

**Pendapatan Diterima Dimuka (UI saja)**

- Entri menu Transaksi › Penerimaan › Pendapatan Diterima Dimuka dihapus.
- Rute `PendapatanDimukaForm` dilepas dari navigator, termasuk import-nya.
- Berkas `PendapatanDimukaFormScreen.tsx` dibiarkan tanpa diimpor, mengikuti pola `JurnalPengakuanDimukaScreen`.
- Chip kategori "Pendapatan Diterima Dimuka" disembunyikan di form Kas & Bank. Konstanta `KATEGORI_PENERIMAAN` tidak diubah, sehingga data lama tetap terbaca.
- *Daftar Pendapatan Dimuka* (read-only, untuk monitoring) dipertahankan. Hanya teks keadaan kosongnya yang diperbarui, karena sebelumnya menunjuk menu yang sudah dihapus.

**Splash**

- Teks "by Kopku" diganti menjadi "by Alqizani".
- Teks "© Kopku" dan merek "Kopku Finance" tidak diubah.

**Pengaturan › Keamanan**

- Layar baru `KeamananScreen` (rute `Keamanan`).
- Pengaturan "Gunakan PIN" dan "Login dengan Biometric" dipindah ke layar ini **apa adanya**: SecurityService, `aturPinKunciAplikasi`, dan `setBiometricEnabled` beserta verifikasinya tetap sama.
- Kartu Keamanan di Pengaturan tidak digerbangi permission, sama seperti sebelumnya.

**Dark mode**

- Tidak ada di level aplikasi: `app.json` diset `userInterfaceStyle: "light"`, dan sekitar 165 layar memakai token warna statis. Hanya palet splash yang memiliki varian gelap.
- Karena itu menu dark mode **tidak dibuat**. Membuatnya memerlukan refactor tema menyeluruh, di luar scope RC ini.

## 3. Verifikasi (HARNESS-VERIFIED, bukan JEST-VERIFIED)

**TypeScript**

- Typecheck seluruh `src` + `app` menghasilkan 2983 error sebelum patch dan 2983 sesudah patch.
- Tidak ada error baru. Error lingkungan (tidak ada `node_modules`) untuk `Switch` dan `expo-local-authentication` hanya berpindah dari `PengaturanScreen` ke `KeamananScreen`, bersama kode yang dipindahkan.

**Test struktural**

- 20 suite, 498/498 lulus, dijalankan dengan mini-runner offline.
- Suite yang dijalankan termasuk: `RuteTerjangkau`, `KeyboardFormRcS120`, `IdentitasRuteIndependenRcS49b`, `TransaksiUiRcS68_1`, `SplashIntroRcS85`, `PickerAnggotaRcS118`, `RiwayatMenuTransaksi`, dan suite baru `UiSimplifikasiRcS121`.

**Test yang disesuaikan**

| Test | Perubahan |
|---|---|
| `TransaksiUiRcS68_1` | jumlah item Penerimaan 10 → 9 |
| `KeyboardFormRcS120` | layar ber-PinInput kini `KeamananScreen` |
| `IdentitasRuteIndependenRcS49b` | `Keamanan` ditambahkan ke daftar rute PengaturanStack |
| `SplashIntroRcS85` | teks atribusi menjadi `by Alqizani` |

**Wajib dijalankan lokal:** `npm run typecheck && npm test`.

## 4. Catatan terbuka

- Form Kas & Bank generik (FAB di Riwayat Kas & Bank) masih mengizinkan pemilihan akun 2-1300 lewat `AccountPicker`. Membatasinya berarti mengubah komponen bersama, sehingga diserahkan ke keputusan pemilik produk.

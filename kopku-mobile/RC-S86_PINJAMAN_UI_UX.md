# RC-S86 — UI/UX Menu Pinjaman & Ajukan Pinjaman

## Ringkasan
1. **Daftar Pinjaman** (`PinjamanListScreen`)
   - Tombol **Export** dipindah ke header, sejajar judul "Pinjaman" (pola sama dengan Simpanan). Data export tidak berubah: `buildPinjamanExport` atas daftar yang sedang tampil (hasil search/filter).
   - Setiap pinjaman tampil sebagai **kartu**: nama anggota + nomor pinjaman, **nomor urut di kanan atas**, Plafon & Sisa Piutang, badge status berwarna, tenor, dan tanggal jatuh tempo.
   - Nomor urut = posisi pada daftar yang tampil (`index + 1`), ikut menyesuaikan search/filter — bukan ID/nomor pinjaman (sama dengan daftar Anggota).
   - Baris ringkas di atas daftar: jumlah pinjaman & total sisa piutang (Aktif + Macet).
   - FAB memakai ikon `add` + label aksesibilitas.
2. **Ajukan / Edit Pinjaman** (`PinjamanFormScreen`)
   - Form dibagi menjadi 6 kartu bernomor: Anggota & Tanggal, Tujuan, Rincian Pinjaman, Biaya & Denda, Agunan, Catatan.
   - Tanggal memakai `DatePicker` (nilai tetap ISO `YYYY-MM-DD`).
   - Satuan tenor, metode jasa, biaya admin, denda, dan agunan memakai kontrol segmen; handler lama (`pilihMetodeJasa`, `pilihBiayaAdminTipe`) tetap dipanggil sehingga modal FLAT & modal klasifikasi biaya admin tetap muncul.
   - Kartu **Ringkasan Pengajuan** sebelum tombol kirim: anggota, jumlah, tenor, metode & persentase jasa, biaya admin, kas diterima anggota (rumus `previewBiayaAdmin`, identik dengan `cairkanPinjaman()`).
3. **Perbaikan bug**: pengajuan **baru** sebelumnya tidak mengirim tujuan pinjaman & agunan ke `ajukanPinjaman()` (hanya jalur edit), sehingga isian itu hilang. Sekarang ikut terkirim; validasinya tetap di service.
4. `ExportButton` mendapat prop opsional `variant: 'default' | 'header'`. Pemanggil lain tidak berubah.

## Berkas
- `src/screens/Pinjaman/PinjamanListScreen.tsx`
- `src/screens/Pinjaman/PinjamanFormScreen.tsx`
- `src/components/ExportButton.tsx`
- `src/__tests__/PinjamanUiRcS86.test.ts` (baru, 9 tes)

## Keterbatasan
- Tampilan belum dilihat di perangkat/emulator (tidak ada renderer RN di lingkungan ini). Perlu dicek di dev build.

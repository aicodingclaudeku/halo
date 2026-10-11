# Akad: Meterai Teks, Tanpa DRAF, Konfirmasi Tanda Tangan Sebelum Pencairan

## Perubahan
1. **PDF perjanjian (akad awal & akad ulang)** — kotak meterai dihapus. Di ruang tanda
   tangan anggota hanya tercetak teks *Meterai Rp10.000*, rata kiri (tidak di tengah),
   tinggi ruang sama dengan kolom Ketua sehingga garis tanda tangan sejajar.
2. **Akad awal tanpa DRAF** — sebelum pencairan, perjanjian dicetak utuh (tanpa banner
   DRAF) karena dokumen inilah yang ditandatangani sebelum dana cair. Status di kartu
   Detail Pinjaman: `SIAP DITANDATANGANI`.
3. **Cairkan Pinjaman** — kini 2 langkah:
   - Langkah 1: *Konfirmasi Tanda Tangan Akad* (ringkasan no. pinjaman, no. perjanjian,
     peminjam, jumlah; daftar periksa; tombol cetak perjanjian; centang pernyataan).
     Tombol "Sudah, Lanjutkan" aktif hanya setelah dicentang.
   - Langkah 2: form pencairan yang sama seperti sebelumnya (pilih rekening → Cairkan).

## Tidak berubah
Service pencairan (`cairkanPinjaman`), jurnal, jadwal, isi pasal perjanjian, izin export.
Konfirmasi tanda tangan adalah gerbang UI (tidak menambah kolom database).

## File
`src/export/DokumenKontrakHtml.ts`, `src/export/DasarHukumAkad.ts`,
`src/export/AkadAwalDocumentBuilder.ts`, `src/export/AkadAwalHtmlBuilder.ts`,
`src/services/AkadUlangPresentasi.ts`, `src/screens/Pinjaman/PinjamanDetailScreen.tsx`,
test: `AkadUlangRcS82.test.ts` (disesuaikan), `AkadTtdMeteraiPencairan.test.ts` (baru).

## Uji
Typecheck bersih. Suite akad/pinjaman terkait lulus. Full suite: 11 suite gagal yang sama
persis dengan sebelum perubahan (kegagalan lama: migration V18/V24/V25/Full, RC-S53,
RC-S57, RC-S58, RC-S67, RC-S70); tidak ada kegagalan baru.

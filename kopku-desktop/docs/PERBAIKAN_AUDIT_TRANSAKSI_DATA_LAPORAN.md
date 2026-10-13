# Perbaikan temuan audit Transaksi · Data · Laporan (Koperasi DAMY, data simulasi)

Berlaku untuk **KOPKU RC-S133.6.6** dan **KOPKU Desktop Windows 1.0.21**. Nomor versi, skema database (**v82**), dan aturan bisnis TIDAK diubah. Saldo awal, data awal, dan jurnal tidak disentuh untuk meloloskan uji.

Sumber temuan: paket `KOPKU-AUDIT-TEST-DAMY.zip` (982 kasus uji, 146 pemeriksaan layar, perbandingan input manual vs impor template resmi sampai Rp0).

## Ringkasan

- 21 temuan **diperbaiki** (hanya yang terbukti, masing-masing dengan uji yang gagal sebelum perbaikan dan lulus sesudahnya).
- 8 temuan **sengaja tidak diubah** karena butuh keputusan bisnis / di luar lingkup perubahan kecil (daftar di bawah).
- 2 temuan hanya informasi (F1 akrual jasa bergantung tanggal dijalankan; F3 atribut non-finansial tidak ikut impor).

## Yang diperbaiki

### F4 · SEDANG · Simpanan berjangka boleh bertanggal sebelum anggota bergabung

- Area: Transaksi › Simpanan Berjangka
- Akar masalah: Aturan tanggal ≥ tanggal bergabung ada pada simpanan lain, tidak pada berjangka.
- Perbaikan: SimpananBerjangkaService: tolak tanggal penempatan sebelum tanggal bergabung.

### F8 · SEDANG · NIK ganda menampilkan galat mentah mesin DB

- Area: Data › Anggota (+ Import)
- Akar masalah: Tidak ada pemeriksaan sebelum INSERT; hanya constraint DB.
- Perbaikan: AnggotaRepository: pastikanNikBelumDipakai (juga saat edit); EksekusiImportDataAwal mengenali pesan baru. Constraint DB tetap jaring terakhir.

### F9 · SEDANG · Hapus anggota yang punya data berjangka/SHU/personel: galat kunci asing mentah

- Area: Data › Anggota
- Akar masalah: Hanya sebagian tabel acuan diperiksa sebelum DELETE.
- Perbaikan: AnggotaRepository: periksa 6 tabel acuan (berjangka, pendapatan dimuka, SHU, bunga sukarela, personel, keluar anggota) dan tolak dengan pesan bisnis.

### F11 · SEDANG · Validasi dasar tidak ada di lapisan layanan Utang dan Aset

- Area: Transaksi › Utang; Pembelian Aset
- Akar masalah: Aturan hanya di form.
- Perbaikan: UtangService dan AsetService: validasi nilai, nama, bunga di layanan.

### F12 · SEDANG · Pendapatan diterima dimuka: jangka waktu 0/negatif/pecahan diterima

- Area: Transaksi › Pendapatan Dimuka
- Akar masalah: Tidak ada validasi bentuk di layanan.
- Perbaikan: PendapatanDimukaService: jumlah bulat > 0 dan jangka bulat ≥ 1.

### F13 · SEDANG · Pengakuan pendapatan dimuka bisa diposting ke periode yang belum berjalan

- Area: Transaksi › Pendapatan Dimuka
- Akar masalah: Penjaga yang ada pada penyusutan aset tidak ada di sini.
- Perbaikan: PendapatanDimukaService: tolak periode > periode berjalan.

### F14 · SEDANG · Penyusutan aset: sisa pembulatan tidak pernah diakui, nilai buku tidak mencapai residu

- Area: Transaksi › Pembelian Aset (Penyusutan)
- Akar masalah: Hanya kelebihan yang dipotong (Math.min); kekurangan akibat pembulatan nilai bulanan dibiarkan.
- Perbaikan: PenyusutanService: bulan terakhir masa manfaat mengakui seluruh sisa dasar, dikurangi bagian reguler bulan yang belum diposting bila periode diproses tidak berurutan.

### F15 · SEDANG · Pendapatan dimuka: sisa pembulatan tidak habis / saldo 2-1300 negatif

- Area: Transaksi › Pendapatan Dimuka
- Akar masalah: Nilai bulanan dibulatkan tanpa penyesuaian bulan terakhir.
- Perbaikan: PendapatanDimukaService: bulan terakhir mengakui sisa sehingga Σ pengakuan = jumlah.

### F16a · TINGGI · Keluar anggota: buku pembantu simpanan tidak turun setelah pengembalian

- Area: Transaksi › Keluar Anggota
- Akar masalah: Jalur keluar anggota yang baru hanya menjurnal; baris TARIK simpanan_transaksi tidak ditulis.
- Perbaikan: KeluarAnggotaService menulis baris TARIK per jenis; satu uji lama (KeluarAnggotaBuktiTraceabilityRcS76) diselaraskan karena mengunci perilaku lama ("0 baris").

### F17 · RENDAH · Rekonsiliasi kas/bank menerima tanggal yang tidak ada di kalender

- Area: Transaksi › Rekonsiliasi Kas/Bank
- Akar masalah: Pola YYYY-MM-DD saja.
- Perbaikan: CashReconciliationService: wajib tanggal kalender nyata.

### F18 · SEDANG · SHU: persentase komponen negatif dan nominal pecahan diterima

- Area: Transaksi › SHU
- Akar masalah: Hanya TOTAL persen dan nominal > 0 yang diperiksa.
- Perbaikan: ShuCalculator: tiap komponen 0–100. ShuService: nominal diajukan dan disahkan harus rupiah utuh.

### F19 · SEDANG · Penyusutan properti investasi: sisa pembulatan tidak diakui

- Area: Transaksi › Penyusutan Properti Investasi
- Akar masalah: Sama dengan F14.
- Perbaikan: PenyusutanPropertiInvestasiService: bulan terakhir mengakui sisa.

### F20 · RENDAH · Data master (Pengurus/Pengawas/Perizinan/Peraturan/RAT/COA): tanggal dan status tak sah diterima

- Area: Data › Personel, Perizinan, Peraturan, RAT, COA
- Akar masalah: Validasi hanya di form.
- Perbaikan: KoperasiMasterService dan RATService: validasi di lapisan data (isTanggalKalender, himpunan status).

### F21 · SEDANG · Data Bank/Referensi: nama kosong, rekening ganda, edit data fiktif "berhasil", nama bank tidak memperbarui akun COA

- Area: Data › Data Bank, Pemasok, Pemberi Pinjaman, Beban Lain
- Akar masalah: Jalur edit tidak memakai validasi jalur tambah.
- Perbaikan: KasBankService dan DataReferensiService: validasi sama pada tambah dan edit; larangan nama ganda (tidak peka huruf besar/kecil); nama akun buku besar mengikuti nama bank.

### F24 · SEDANG · LPEA: setoran sukarela yang sudah dikoreksi tetap dihitung dalam basis tabungan

- Area: Laporan › LPEA
- Akar masalah: Kueri basis tidak mengecualikan transaksi yang telah direversal dan baris koreksinya.
- Perbaikan: LpeaRepository: kecualikan baris reversal dan baris yang sudah direversal (reversal_of_id).

### F25 · SEDANG · Pembayaran sebagian berulang pada angsuran yang sama memakai nomor bukti identik

- Area: Transaksi › Bayar Piutang Anggota; Laporan › Bukti
- Akar masalah: Nomor referensi dibentuk dari nomor angsuran saja.
- Perbaikan: PinjamanService: pembayaran pertama tetap `<pinjaman>/AGS-<n>`; berikutnya diberi akhiran `-<urutan>`.

### F26 · SEDANG · Rincian bukti pembayaran tidak berjumlah sama dengan total pada pelunasan dengan penalti/administrasi

- Area: Laporan › Bukti Transaksi
- Akar masalah: Rincian hanya menampilkan pokok/jasa/denda.
- Perbaikan: BuktiTransaksiService menghitung porsiBiayaPelunasan sebagai sisa; BuktiTransaksiDetailScreen dan ReportTableBuilders menampilkannya.

### F27 · TINGGI · Penutupan periode yang ditolak meninggalkan jurnal penyusutan bulan mendatang

- Area: Laporan › Tutup Periode
- Akar masalah: Gerbang "periode belum berakhir" untuk akrual bunga dievaluasi di STEP 3b, setelah penyusutan otomatis.
- Perbaikan: PeriodCloseService: pemeriksaan read-only yang sama (pesan sama) dilakukan pada pra-penutupan, sebelum perubahan apa pun.

### F28 · SEDANG · Pratinjau import menyatakan "siap diimpor" walau sheet Anggota tidak ada

- Area: Import Data Awal
- Akar masalah: Ketergantungan baris → sheet Anggota tidak diperiksa di pratinjau.
- Perbaikan: ExcelDataAwalParser: galat umum bila ada baris bergantung tanpa sheet Anggota terbaca.

### F30 · SEDANG · Import Saldo Lama menolak akun pajak bawaan (mis. 2-1901) pada database baru

- Area: Import Data Awal › Sheet 7
- Akar masalah: Akun pajak bawaan baru dibuat saat transaksi pajak pertama.
- Perbaikan: EksekusiImportDataAwal: memakai pastikanAkunPajak (mekanisme menu Pajak, idempoten) bila kode termasuk akun pajak bawaan.

### F31 · SEDANG · Pinjaman CUSTOM dapat dicairkan tanpa jadwal angsuran

- Area: Transaksi › Pemberian Pinjaman (Jadwal Custom)
- Akar masalah: cairkanPinjamanDb tidak memeriksa jadwal.
- Perbaikan: PinjamanService.cairkanPinjamanDb: tolak bila COUNT(angsuran_jadwal)=0 dengan pesan arahan ke Jadwal Custom.

## Yang belum diubah (butuh keputusan)

- **F2** (RENDAH) Tanggal masa depan diterima di lapisan layanan (Setor Simpanan, Saldo Awal) — TIDAK DIUBAH (keputusan desain yang terdokumentasi). Rekomendasi: validasi di layanan dengan pengecualian eksplisit untuk jalur sinkron.
- **F6** (SEDANG) Tidak ada kunci idempotensi di layanan: dua panggilan identik = dua transaksi — TIDAK DIUBAH — butuh kunci idempotensi + perubahan skema (v83), di luar batas perbaikan kecil.
- **F7** (RENDAH) 7 suite uji bawaan gagal karena dokumen kebijakan tidak ikut paket — TIDAK DIUBAH (bukan cacat aplikasi). Sertakan dokumen kebijakan dalam paket sumber.
- **F10** (RENDAH) Suku bunga berjangka tanpa batas atas (600%/tahun diterima) — TIDAK DIUBAH — batas adalah keputusan kebijakan pengurus. Rekomendasi: peringatan di atas ambang yang ditetapkan.
- **F16b** (TINGGI) Keluar anggota yang masih punya pinjaman: buku pembantu pinjaman tidak dikompensasi — TIDAK DIUBAH — memerlukan keputusan bisnis (bagaimana jadwal dan pembayaran ditandai: pelunasan oleh kompensasi simpanan) dan tabel/status baru; bukan perbaikan kecil.
- **F22** (RENDAH) Neraca Saldo menerima tanggal tak valid ("bukan-tanggal", 2026-02-30) — TIDAK DIUBAH (kebijakan sama dengan F2).
- **F23** (RENDAH) CALK: narasi kebijakan penyusutan "manual" padahal mode aplikasi OTOMATIS — TIDAK DIUBAH — narasi kebijakan adalah keputusan akuntan koperasi.
- **F29** (SEDANG) LHU periode sesudah cut-off memuat pendapatan/beban Jan–Jun dari sheet 7 (saldo awal akun) — TIDAK DIUBAH — mengubah perlakuan saldo awal akun laba-rugi adalah perubahan aturan bisnis. Rekomendasi: gunakan LHU kumulatif sejak awal tahun buku atau posting saldo awal laba-rugi ke ekuitas.

## Cara memakai (Windows 1.0.21)

- Bundle renderer `renderer/_expo/static/js/web/entry-*.js` sudah **ditambal** agar memuat perbaikan di atas: 23 modul diganti (daftar + id di `docs/laporan-tambal-perbaikan-audit.json`). Cara penambalan: `scripts/tambal-renderer-rc-s133.6.6-perbaikan-audit.js` (pola sama dengan tambalan 1.0.x sebelumnya).
- Cara resmi tetap membangun renderer dari source RC yang diperbaiki: `node scripts/build-renderer.js` (paket `KOPKU-Source-RC-S133.6.6-DIPERBAIKI`). *(Diperbaiki di 1.0.22: dulu tertulis `npm run build:renderer`, skrip yang tidak ada di package.json paket ini.)*
- Nomor versi tetap 1.0.21 (dinaikkan ke 1.0.22 pada RC-S133.6.7), skema tetap v82. Kode Electron (main/preload/LAN/server) tidak diubah.
- `test/lan/baseline-manifest.json` diperbarui (hash bundle baru) mengikuti kebiasaan tiap rilis tambalan; `npm run test:lan` 77/77 lulus, `npm run test:keamanan` 14/14 lulus.
- Uji layar di Chromium pada bundle baru (data simulasi DAMY, input manual dan impor): 72/72 angka layar cocok dengan SQLite, 46/46 interaksi (cari/filter) lulus.
- Belum diuji: aplikasi Electron terpasang (installer .exe) di Windows sungguhan — build installer dan uji manual perlu dilakukan di mesin Windows.

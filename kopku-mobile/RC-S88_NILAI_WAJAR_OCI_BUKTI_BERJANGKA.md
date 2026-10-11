# RC-S88 — Nilai Wajar & Revaluasi (SAK EP), OCI di LHU, Bukti Tarik Berjangka, Kebijakan Penarikan Dini

## 1. Penyesuaian Nilai Wajar — rekomendasi SAK EP (diaktifkan)
Menggantikan POLICY 03 (model biaya, posting dimatikan). Satu register, dua objek:

| Objek | Model (SAK EP) | Selisih diakui di | Jurnal |
|---|---|---|---|
| Properti Investasi | Nilai wajar (Bab 16) | **Laba rugi** — Pendapatan/Beban Lain | naik: Dr 1-1665 / Cr 4-2100 · turun: Dr 5-5000 / Cr 1-1665 |
| Aset Tetap (berwujud) | Revaluasi (Bab 17) | **OCI** (surplus revaluasi, ekuitas) | naik: Dr 1-1520 / Cr 4-2200 (pemulihan rugi lalu) + Cr 3-6000 · turun: Dr 3-6000 (s.d. surplus aset tsb) + Dr 5-5100 / Cr 1-1520 |

- Alur **Draft → Tinjau & Posting → Diposting** (atau Dibatalkan). Posting butuh izin `kas_bank:approve`; penilaian yang sudah diposting bersifat final — koreksi dengan penilaian baru.
- Pratinjau dan posting memakai satu penyusun (`susunRencanaPosting`): layar menampilkan persis jurnal yang akan dibentuk, pembagian laba rugi/OCI, serta hambatan.
- Gerbang posting: bukti wajib, objek aktif, urutan tanggal, tidak ada transaksi sesudah tanggal penilaian, penyusutan s.d. tanggal penilaian sudah lengkap, periode terbuka.
- Properti investasi: sejak penilaian pertama diposting **tidak lagi disusutkan**.
- Aset tetap: penyusutan berikutnya **prospektif** dari nilai revaluasi atas sisa masa manfaat. Aset yang sudah direvaluasi tidak dapat dihapus sebagai koreksi salah input dan nilai strukturalnya terkunci.
- Pelepasan aset tetap/investasi ikut membersihkan akun penyesuai (1-1520 / 1-1665). Surplus revaluasi tetap di ekuitas (SAK EP mengizinkan, tidak mewajibkan, pemindahan ke saldo laba).
- Akun baru (self-heal COA): 1-1520, 1-1665, 3-6000, 4-2200, 5-5100. Skema v73: rebuild `penyesuaian_nilai_wajar` (objek, aset_tetap_id, status DIPOSTING, pembagian laba rugi/OCI, jejak posting); baris lama tersalin utuh.
- UI baru: segmen objek, kartu kebijakan, ringkasan (draft/diposting/ke laba rugi/ke OCI), formulir 3 langkah, panel hasil + tabel jurnal, riwayat berfilter status dengan rincian, lembar konfirmasi posting.

## 2. OCI di Laporan Hasil Usaha
- Setelah **SHU Neto**: seksi **Penghasilan Komprehensif Lain** (pos tidak/akan direklasifikasi) dan **Total Penghasilan Komprehensif**, mode tunggal & komparatif, termasuk export.
- OCI dibaca dari mutasi akun cadangan OCI (3-6000) yang bersumber dari jurnal OCI (`REVALUASI_ASET_TETAP`) — saldo awal/koreksi tidak dihitung. SHU Neto tidak berubah (OCI bukan bagian SHU).
- CALK §7 (aset tetap) & §19 (OCI) serta narasi kebijakan akuntansi diperbarui.

## 3. Bukti Tarik Simpanan Anggota — simpanan berjangka
- Daftar kini memuat pencairan **simpanan berjangka** (jatuh tempo & penarikan dini) selain penarikan sukarela.
- Detail & export: nomor kontrak, jenis pencairan, tenor, suku bunga, kebijakan dini, pokok, bunga, PPh 4(2), penalti, biaya administrasi, bunga hangus, dan **Total Diterima Anggota** (uang yang benar-benar keluar). Pencarian juga menurut nomor kontrak.

## 4. Kebijakan Penarikan Dini
- Input nominal rupiah kini berpemisah ribuan saat diketik (10000 → 10.000).
- Akun **terkunci**: penalti → **4-1150 Pendapatan Penalti Pelunasan**, biaya administrasi → **4-1100 Pendapatan Administrasi**. Ditampilkan read-only dan **ditegakkan service** (`simpanKebijakanDini`). Versi lama dengan akun lain tetap berlaku sampai versi baru ditetapkan (ada pemberitahuan).

## Tes
- Baru: `RcS88NilaiWajarOci.test.ts` (11), `RcS88BuktiTarikBerjangka.test.ts` (6); `PenyesuaianNilaiWajarRcS54.test.ts` ditulis ulang untuk kebijakan baru.
- Test lama yang mengunci "nilai wajar tidak boleh diposting" / SCHEMA_VERSION 72 diperbarui dengan catatan `DIPERBARUI RC-S88`.

## Keterbatasan
- Tampilan belum dilihat di perangkat/emulator (tidak ada renderer RN di lingkungan ini).
- Keuntungan nilai wajar yang belum terealisasi belum otomatis dikoreksi fiskal di modul pajak.

# Audit & Perbaikan Kolektibilitas Piutang Pinjaman — KOPKU Desktop 1.0.33

Tanggal audit: 14 Oktober 2026. Ruang lingkup: penentuan kategori kolektibilitas, umur tunggakan, batas kategori,
penyisihan piutang tak tertagih (buku/SOM) dan batasan fiskal, serta konsistensinya dengan saldo piutang, laporan
keuangan, dan jurnal.

## 1. Ringkasan temuan

| # | Temuan | Status |
|---|---|---|
| 1 | Batas **"melampaui N bulan"** dibandingkan dengan **bulan penuh yang dibulatkan ke bawah**. Tunggakan 3 bulan + 1…30 hari tetap dihitung "3 bulan" → **Lancar** (dan batas atas 6/12 bulan ikut terlambat 1 bulan). | **TERBUKTI — DIPERBAIKI** |
| 2 | Umur tunggakan dihitung dari jatuh tempo angsuran tertua yang **masih outstanding** (pokok & jasa terpisah; angsuran sebagian tetap terhitung; angsuran lunas tidak). | Benar — tidak diubah |
| 3 | Persentase penyisihan SOM 0/50/75/100% atas saldo pokok; batas fiskal 0,5/10/50/100% (agunan dikurangkan kecuali Lancar). | Tidak diubah (lihat §3 tentang verifikasi) |
| 4 | Pinjaman masa angsuran **1 bulan** ditempatkan di kelompok ambang "3 bulan" (naskah tidak menyebut masa angsuran 1 bulan). | Keputusan kebijakan lama, **belum dikonfirmasi** (docs/RC-S133.6.3 §F.2) — tidak diubah, lihat §8 |
| 5 | "Penyisihan tercatat Rp0": buku besar hanya berubah lewat prosedur **Sesuaikan Penyisihan** (jurnal PSH). Karena semua pinjaman dianggap Lancar (0%), targetnya Rp0. | Akibat temuan 1 — target kini benar; jurnal tetap lewat prosedur resmi |

## 2. Akar masalah (fungsi & baris)

Kode bisnis ada di bundle renderer `renderer/_expo/static/js/web/entry-15353e1719ccf374e65fdb58e3482a5d.js`:

- **Modul `KolektibilitasSomService`** (Metro #925) — `klasifikasikanSom()`:
  `const bulanPokok = Math.max(0, Math.floor(input.bulanTunggakanPokok));` lalu `tingkatTunggakan(bulan, 3, 6)` dengan
  `if (bulan <= lewatBulan) return 0` → bulan **3** (dari 3 bulan 9 hari) dianggap *belum melampaui 3 bulan*.
  Pola yang sama di cabang bunga, pinjaman tanpa angsuran (`bulan <= 3 ? 1 : 2`), dan hitungan 21 bulan.
- **Modul `LoanImpairmentService`** (Metro #965) — `getKlasifikasiPinjamanAktif()` memberi masukan
  `bulanPenuhAntara(jatuh_tempo_pokok_tertua, tanggalLaporan)` (bulan penuh, dibulatkan ke bawah).

Bukti reproduksi (kode asli + SQLite, sebelum perbaikan), per 14-10-2026, angsuran bulanan:

| Jatuh tempo tertua | Hari | `bulanPenuhAntara` | Hasil lama | 3 bulan kalender tercapai | Seharusnya |
|---|---|---|---|---|---|
| 20 Jul | 86 | 2 | Lancar | 20 Okt | Lancar |
| 16 Jul | 90 | 2 | Lancar | 16 Okt | Lancar |
| 14 Jul | 92 | 3 | Lancar | 14 Okt (tepat) | Lancar |
| 11 Jul | 95 | 3 | **Lancar** | 11 Okt | **Kurang Lancar** |
| 5 Jul | 101 | 3 | **Lancar** | 5 Okt | **Kurang Lancar** |

Total penyisihan SOM lama Rp0 → kini Rp6.000.000 (2 × 50% × Rp6.000.000) pada data uji.

## 3. Dasar regulasi & status verifikasi

- **Juklak Deputi Bidang Pengawasan Koperasi No. 3 Tahun 2025** tentang Standar Operasional Manajemen Usaha Simpan
  Pinjam oleh Koperasi (SOM), angka 12.1 (kriteria pinjaman bermasalah) dan angka 15 (taksiran piutang tak tertagih).
  Sumber resmi: JDIH Kemenkop (`jdih.kop.go.id`, berkas *Petunjuk Pelaksanaan SOM_2025*).
- **PMK 74 Tahun 2024** (batasan biaya cadangan piutang tak tertagih untuk PPh, Koperasi Simpan Pinjam).
  Sumber resmi: JDIH Kemenkeu (`jdih.kemenkeu.go.id`, *2024pmkeuangan074.pdf*).

**Keterbatasan verifikasi:** dari lingkungan audit ini kedua situs JDIH **tidak dapat diunduh** (proxy menolak / DNS).
Hasil pencarian mengonfirmasi keberadaan dan judul kedua dokumen, tetapi teks pasal tidak dapat dibaca langsung.
Karena itu **tidak ada ambang atau persentase yang diubah**. Nilai yang dipakai adalah nilai yang sudah ada di aplikasi,
dengan kutipan naskah di komentar kode (angka 12.1 & 15 hal. 86). Perbaikan hanya menyangkut **cara membaca kata
"melampaui"** secara harfiah (tanggal kalender), yang tidak bergantung pada angka mana pun. Pengurus disarankan
mencocokkan tabel di §4 dengan naskah resmi.

## 4. Rumus yang diterapkan

**Umur tunggakan (bulan kalender)** — `bulanTunggakanTepat(jatuhTempo, tanggalLaporan)`:
N = jumlah bulan kalender penuh (tanggal yang sama; bila tanggal itu tidak ada di bulan tujuan → hari terakhir bulan);
bila tanggal laporan melewati batas itu, ditambah pecahan (0,001–0,999). Maka:
- *melampaui X bulan* ⇔ umur > X; *belum melampaui Y bulan* ⇔ umur ≤ Y.
- Jatuh tempo dihitung dari angsuran **tertua yang masih outstanding** (pokok dan jasa terpisah); angsuran lunas
  tidak dihitung, angsuran dibayar sebagian tetap dihitung.

**Ambang Kurang Lancar (SOM 12.1, tidak diubah):**

| Masa angsuran | Pokok: KL bila | Bunga: KL bila |
|---|---|---|
| < 1 bulan (harian/mingguan) | > 1 dan ≤ 2 bulan | > 1 dan ≤ 3 bulan |
| 1–5 bulan (1 & 4–5 bulan: penafsiran lama) | > 3 dan ≤ 6 bulan | > 3 dan ≤ 6 bulan |
| ≥ 6 bulan | > 6 dan ≤ 12 bulan | > 3 dan ≤ 6 bulan |
| Tanpa angsuran, belum jatuh tempo | — | > 3 dan ≤ 6 bulan |
| Tanpa angsuran, sudah jatuh tempo | lewat jatuh tempo ≤ 3 bulan | — |

Kategori: dimensi terburuk (pokok/bunga). Di bawah batas → **Lancar**; di dalam rentang → **Kurang Lancar**; melewati
batas atas → **Diragukan** bila angsuran terbayar ≥ 75% kewajiban kontraktual (pokok+bunga) **atau** agunan ≥ 100%
sisa utang, selain itu **Macet**; Diragukan ≥ 21 bulan penuh → **Macet**; diserahkan ke pengadilan/asuransi → **Macet**.

**Penyisihan buku (SOM angka 15):** `round(saldo pokok × p%)`, p = Lancar 0, KL 50, Diragukan 75, Macet 100.
**Batas fiskal (PMK 74/2024, KSP):** Lancar 0,5% × saldo pokok; KL 10%, Diragukan 50%, Macet 100% × (saldo pokok −
agunan, min 0). Kategori fiskal = kategori SOM.
**Jurnal:** tetap hanya lewat `sesuaikanPenyisihanPiutang` (Dr Beban Penyisihan / Cr Penyisihan Piutang sebesar
selisih target − saldo buku; nomor PSH; butuh izin Pinjaman › Edit).

## 5. File yang diubah

| File | Perubahan |
|---|---|
| `scripts/tambal-kolektibilitas-1.0.33.js` (baru) | Tambalan idempoten, 10 penggantian berjangkar (masing-masing wajib tepat 1×, sintaks diperiksa sebelum ditulis) |
| `renderer/_expo/static/js/web/entry-*.js` | Hasil tambalan — hanya modul #925 & #965 (`docs/perubahan-1.0.33-kolektibilitas-bundle.diff`) |
| `test/kolektibilitas/kolektibilitas.test.js` (baru) | 10 uji (lihat §6); `npm run test:kolektibilitas` |
| `test/lan/baseline-manifest.json`, `test/lan/regresi.test.js` | Hash bundle & versi diperbarui dengan catatan DIPERBARUI 1.0.33 |
| `package.json`, `package-lock.json`, `installer/kopku-setup.nsi` | Versi 1.0.33; skrip `test:kolektibilitas` |

Tidak ada perubahan skema/migrasi database (tetap v82), tidak ada perubahan ambang/persentase, akuntansi, jurnal,
simpanan, SHU, atau laporan keuangan lain.

## 6. Hasil pengujian

| Uji | Hasil |
|---|---|
| `test:kolektibilitas` (baru, kode & SQLite asli) | **10/10** |
| Uji yang sama pada bundle **sebelum** perbaikan (bukti uji mendeteksi bug) | 2/10 — gagal tepat pada batas, data 14-10-2026, pembayaran sebagian, konsistensi penyisihan |
| `test:mcp` (Asisten AI — termasuk alat `kolektibilitas_pinjaman`) | 47/47 |
| `test:lan` (regresi, hash bundle) | 81/81 |
| `test:keamanan` | 15/15 |
| Layar Chromium / Electron nyata | 53/53 / 27/27 |

Isi uji kolektibilitas: usia kalender (tepat N, lewat sehari, akhir bulan, kabisat); setiap kategori × setiap kelompok
masa angsuran × pokok/bunga, termasuk batas tepat dan lewat; rasio 75% / 100% (tepat dan di bawahnya); 21 bulan;
pengadilan/asuransi; pinjaman tanpa angsuran; penyisihan SOM & fiskal (pembulatan, agunan > pokok); skenario lima
pinjaman 86–101 hari per 14-10-2026; angsuran lunas; pembayaran sebagian; Σ saldo pokok = akun 1-1200 Piutang Pinjaman;
jurnal penyesuaian resmi = target, idempoten, jurnal lama tidak berubah, neraca seimbang.

## 7. Dampak terhadap data lama

- **Tidak ada data yang diubah** oleh pembaruan ini: tidak ada migrasi, tidak ada jurnal otomatis, saldo historis dan
  jurnal yang sudah diposting tetap. Klasifikasi dihitung ulang saat layar/laporan dibuka (tidak disimpan).
- Setelah pembaruan, pinjaman yang tunggakannya melampaui batas kalender akan tampil **Kurang Lancar** (atau lebih
  berat), sehingga layar Kolektibilitas menunjukkan **"Penyesuaian yang diperlukan"** > 0.
- Untuk membukukannya, Bendahara/Admin menjalankan **Sesuaikan Penyisihan** per tanggal laporan. Ini membuat satu jurnal
  PSH baru yang dapat diaudit; jurnal lama tidak disentuh. Disarankan membuat **backup** (menu Backup) sebelum menjalankannya.
- Laporan periode lalu yang dicetak sebelum pembaruan dapat berbeda bila dicetak ulang (klasifikasi dihitung ulang);
  bila laporan itu sudah disahkan, perbedaannya dicatat sebagai koreksi periode berjalan, bukan mengubah jurnal lama.

## 8. Risiko yang masih tersisa

1. **Naskah resmi belum dicocokkan langsung** (JDIH tidak terjangkau dari lingkungan audit). Angka ambang dan persentase
   mengikuti kutipan di kode; perlu dicocokkan pengurus dengan naskah.
2. **Masa angsuran 1 bulan** (pinjaman bulanan, paling umum) memakai ambang "melampaui 3 bulan". Bila naskah dimaknai
   lebih ketat (mis. ambang 1 bulan), tunggakan 86–92 hari juga akan Kurang Lancar. Ini keputusan kebijakan yang
   harus dikonfirmasi pengurus/pengawas sebelum diubah.
3. Kriteria kualitatif ("masih dapat/tidak dapat diselamatkan") tidak ada datanya; penggolongan Diragukan/Macet hanya
   memakai rasio terukur (75% / 100%).
4. Pengujian dengan **database koperasi Anda per 14-10-2026** belum dilakukan (data tidak tersedia di lingkungan audit);
   skenario lima pinjaman 86–101 hari direka ulang dengan service asli. Kategori akhir pinjaman nyata bergantung pada
   tanggal jatuh tempo angsuran tertuanya, bukan hanya jumlah hari.
5. Installer Windows belum diuji di Windows (lingkungan build Linux).

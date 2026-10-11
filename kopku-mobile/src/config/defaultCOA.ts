/**
 * COA default yang di-seed saat setup awal koperasi (PRD §18).
 * Ini HANYA titik awal — admin dapat menambah/mengubah akun lewat
 * Pengaturan > Chart of Accounts. Basis akuntansi: SAK EP (§5)
 * memakai struktur akun dasar yang sama; perbedaan utama ada di
 * kebijakan penyajian & mapping laporan (§6), bukan dua COA terpisah.
 */

export type AccountKategori = 'ASET' | 'LIABILITAS' | 'EKUITAS' | 'PENDAPATAN' | 'BEBAN';
export type NormalBalance = 'DEBIT' | 'KREDIT';

/**
 * Klasifikasi LHU (Laporan Hasil Usaha) — Revisi LHU KOPKU. Menentukan
 * posisi OTOMATIS akun Pendapatan/Beban di LHU (lihat
 * FinancialReports.getLHU). 'Pendapatan Jasa Pinjaman' (4-1000) &
 * 'Beban Pajak Penghasilan' (5-2200) SENGAJA tidak diklasifikasikan
 * (undefined) — keduanya baris tersendiri di LHU, dibaca langsung by
 * kode, bukan lewat klasifikasi ini. RC-S98: 'Beban Perkoperasian'
 * (5-1900) menyusul dengan alasan yang SAMA — Juklat SOM 3/2025
 * Lampiran 1 menyajikannya sebagai baris baku SETELAH Hasil Investasi,
 * bukan sebagai bagian "Jumlah beban usaha" (lihat
 * FinancialReports.LhuResult.bebanPerkoperasian).
 */
export type LhuKlasifikasi =
  | 'PENDAPATAN_USAHA_LAIN'
  | 'HASIL_INVESTASI'
  | 'PENDAPATAN_LAIN'
  | 'BEBAN_USAHA'
  | 'BEBAN_LAIN';

export interface DefaultAccountSeed {
  kode: string;
  nama: string;
  kategori: AccountKategori;
  normalBalance: NormalBalance;
  isSystem: boolean; // dipakai langsung oleh account_mapping bawaan
  lhuKlasifikasi?: LhuKlasifikasi;
}

export const DEFAULT_ACCOUNTS: DefaultAccountSeed[] = [
  // ASET
  { kode: '1-1000', nama: 'Kas', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  // 1-1001 (Kas Kecil) TIDAK LAGI di-seed pada instalasi baru (permintaan
  // pengguna Phase 18 §4). Instalasi lama yang sudah punya akun ini
  // dinonaktifkan lewat migration v18 (is_active = 0), tidak dihapus
  // fisik — histori jurnal lama yang sudah memakai akun ini tetap valid.
  { kode: '1-1100', nama: 'Bank', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  { kode: '1-1200', nama: 'Piutang Pinjaman Anggota', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  // PHASE 1 (fondasi akrual jasa/bunga pinjaman, permintaan pengguna
  // bagian F): akun ASET baru "Piutang Jasa Pinjaman" — menampung jasa
  // yang SUDAH diakui secara akuntansi (satu periode berjalan) tapi
  // belum diterima kasnya, TERPISAH dari 1-1200 (yang hanya
  // mencerminkan pokok). Kode 1-1205 dipilih supaya urut nomor akun
  // sesuai likuiditas (setelah Piutang Pokok, sebelum akun kontra
  // Penyisihan 1-1210) — diaudit dulu, kode ini belum pernah dipakai.
  // Dipetakan lewat AccountMapping (bukan hardcode) supaya
  // AccountingEngine/Trial Balance/FinancialReports otomatis bisa
  // membacanya begitu dipakai oleh mekanisme akrual jasa di PHASE 2.
  // TIDAK dipakai jurnal apa pun pada Phase 1 ini — murni menyiapkan
  // akun & mapping-nya saja.
  { kode: '1-1205', nama: 'Piutang Jasa Pinjaman', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  { kode: '1-1210', nama: 'Penyisihan Piutang', kategori: 'ASET', normalBalance: 'KREDIT', isSystem: false },
  // ==========================================================================
  // RC-S53 KEPUTUSAN 01-A — PIUTANG HASIL INVESTASI
  // ==========================================================================
  // Tiga akun ASET/DEBIT baru: sisi PIUTANG atas hasil investasi yang sudah
  // menjadi hak koperasi tetapi kasnya belum diterima.
  //
  // KENAPA AKUN PIUTANG TERPISAH, BUKAN AKUN PENDAPATAN. Akun pendapatan
  // (4-1300/4-1600/4-1700) adalah sisi KREDIT pengakuan; memakainya sebagai
  // penampung piutang akan mencampur nominal dan beban dua sisi jurnal pada
  // satu akun. Pola yang diikuti SAMA PERSIS dengan pasangan yang sudah ada
  // di COA ini: 1-1205 "Piutang Jasa Pinjaman" <-> 4-1000 "Pendapatan Jasa
  // Pinjaman".
  //
  // NUMBERING. Blok 1-12xx adalah kelompok PIUTANG (existing: 1-1200,
  // 1-1205, 1-1210). Konvensi langkah 10 untuk sub-akun dalam satu kelompok
  // sudah dipakai COA ini (1-1200/1-1205/1-1210; 2-1200/2-1210;
  // 2-1800..2-1850). Ketiga kode di bawah diaudit dulu — 1-1220, 1-1240, dan
  // 1-1250 BELUM PERNAH dipakai, dan tidak menimpa akun mana pun.
  //
  // 1-1230 SENGAJA DIKOSONGKAN. Slot itu milik usulan "Piutang Dividen",
  // yang TIDAK dibuat: menurut KEPUTUSAN 01-B yang sudah terkunci, dividen
  // diakui pada akun pendapatan 4-1300 "Pendapatan Hasil Investasi" — jadi
  // sisi piutangnya adalah 1-1220 di bawah ini, bukan akun keempat dengan
  // fungsi identik. Kodenya dibiarkan kosong supaya penomoran tetap sejajar
  // satu-satu dengan urutan requirement aslinya.
  //
  // BELUM DIPETAKAN & BELUM DIPAKAI JURNAL MANA PUN. Tidak ada entri di
  // DEFAULT_ACCOUNT_MAPPING untuk ketiganya, karena transactionType/role-nya
  // menentukan peristiwa pengakuan — itu isi POLICY 04/05/06 yang masih
  // POLICY_REQUIRED. Pola "akun disiapkan lebih dulu, mekanismenya menyusul"
  // ini sama dengan 1-1205 pada PHASE 1 dan 1-1700/1-1710/2-1600 pada
  // Phase 18 §1.
  //
  // isSystem: true mengikuti akun piutang lain di blok ini (1-1200, 1-1205)
  // — akun cadangan untuk mekanisme akrual otomatis, bukan akun bebas yang
  // boleh diubah/dihapus admin lewat menu COA.
  { kode: '1-1220', nama: 'Piutang Pendapatan Investasi', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  { kode: '1-1240', nama: 'Piutang Bagi Hasil', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  { kode: '1-1250', nama: 'Piutang Pendapatan Sewa', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  // 1-1300 (Persediaan) TIDAK LAGI di-seed pada instalasi baru (audit
  // ulang §2, permintaan pengguna) — koperasi simpan pinjam pada
  // aplikasi ini tidak punya alur transaksi persediaan barang dagang.
  // Instalasi lama yang sudah punya akun ini: kalau BELUM PERNAH
  // dipakai (tidak ada jurnal/saldo awal/transaksi/referensi),
  // migration menghapusnya fisik; kalau SUDAH PERNAH dipakai,
  // migration hanya menonaktifkan (is_active = 0) — TIDAK dihapus
  // fisik, supaya histori jurnal lama tetap valid. Lihat migration v28
  // di db.ts. Baris ini SENGAJA dihapus dari daftar seed (bukan cuma
  // ditandai isSystem:false), pola yang sama dengan 1-1001/1-1600 di
  // Phase 18 §2/§4 — TIDAK dibuat akun pengganti bernama "Persediaan".
  { kode: '1-1400', nama: 'Biaya Dibayar Dimuka', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  { kode: '1-1500', nama: 'Aset Tetap', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: false },
  { kode: '1-1510', nama: 'Akumulasi Penyusutan Aset Tetap', kategori: 'ASET', normalBalance: 'KREDIT', isSystem: false },
  // RC-S88 — REVALUASI ASET TETAP (SAK EP Bab 17, model revaluasi).
  // Akun PENYESUAI (adjunct) di samping 1-1500: menampung selisih antara
  // nilai revaluasi dan nilai buku. Dipisah dari 1-1500 supaya register
  // biaya perolehan tetap cocok dengan buku besar 1-1500 (rekonsiliasi
  // "Asset gross"), dan pembaca laporan melihat porsi revaluasi secara
  // eksplisit. Saldonya boleh bertanda negatif (nilai revaluasi di bawah
  // biaya perolehan) — tampil sebagai pengurang di Posisi Keuangan.
  { kode: '1-1520', nama: 'Selisih Revaluasi Aset Tetap', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  // 1-1600 (Penyertaan pada Unit Usaha) TIDAK LAGI di-seed pada instalasi
  // baru (permintaan pengguna Phase 18 §4 — jenis investasi UNIT_USAHA
  // dihapus dari transaksi baru). Baris ini SENGAJA dihapus dari daftar
  // seed, bukan cuma ditandai isSystem:false — instalasi lama yang sudah
  // punya akun ini dinonaktifkan lewat migration v18 (lihat db.ts),
  // BUKAN dihapus fisik, supaya histori jurnal lama tetap valid.
  { kode: '1-1610', nama: 'Penyertaan pada Koperasi Lain', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  // Audit ulang (permintaan pengguna §2/§3/§4): 5 jenis investasi baru
  // — kode diaudit dulu (1-1620..1-1660 kosong, blok 1-16xx sebelumnya
  // hanya dipakai 1-1600 [dinonaktifkan] & 1-1610), tidak menimpa akun
  // apa pun yang sudah ada. Semua ASET/DEBIT, isSystem mengikuti pola
  // 1-1610 di atas (akun investasi existing).
  { kode: '1-1620', nama: 'Investasi pada Usaha Lain', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  { kode: '1-1630', nama: 'Tabungan pada Bank Umum', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  { kode: '1-1640', nama: 'Giro pada Bank Umum', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  { kode: '1-1650', nama: 'Deposito Berjangka (> 3 Bulan)', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  { kode: '1-1660', nama: 'Properti Investasi', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  // RC-S53 corrective — AKUMULASI PENYUSUTAN PROPERTI INVESTASI.
  //
  // POLICY 03 = MODEL BIAYA, sehingga nilai tercatat properti investasi
  // adalah biaya perolehan dikurangi akumulasi penyusutan dan akumulasi
  // penurunan nilai. Akumulasi penyusutannya TIDAK BOLEH masuk ke
  // `1-1510` Akumulasi Penyusutan Aset Tetap: properti investasi bukan
  // aset tetap, dan mengkreditkannya ke sana akan mengurangi Aset Tetap
  // di Posisi Keuangan — angka laporan yang salah.
  //
  // NUMBERING. Pasangan akun-induk/kontra dalam COA ini selalu
  // berdampingan dengan langkah 10: `1-1500`/`1-1510` (aset tetap) dan
  // `1-1700`/`1-1710` (aset tak berwujud). `1-1670` adalah kode berikutnya
  // yang belum dipakai tepat setelah `1-1660`, mengikuti pola yang sama.
  //
  // Sisi BEBAN memakai akun yang sudah ada — `5-1300` Beban Penyusutan,
  // yang namanya generik dan barisnya di LHU memang sama. Tidak ada akun
  // beban baru yang dibuat.
  { kode: '1-1670', nama: 'Akumulasi Penyusutan Properti Investasi', kategori: 'ASET', normalBalance: 'KREDIT', isSystem: false },
  // RC-S88 — MODEL NILAI WAJAR PROPERTI INVESTASI (SAK EP Bab 16).
  // Akun penyesuai di samping 1-1660: akumulasi kenaikan/(penurunan)
  // nilai wajar. Biaya perolehan di 1-1660 tidak pernah diubah, sehingga
  // register investasi tetap cocok dengan buku besar.
  { kode: '1-1665', nama: 'Penyesuaian Nilai Wajar Properti Investasi', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  // Phase 18 §1: Aset Tak Berwujud & akumulasi amortisasinya — kode
  // mengikuti pola Aset Tetap (1-1500/1-1510) satu blok di atasnya,
  // nomor 1-1700/1-1710 dipilih karena kosong & konsisten (blok 1-16xx
  // dipakai Penyertaan).
  { kode: '1-1700', nama: 'Aset Tak Berwujud', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: false },
  { kode: '1-1710', nama: 'Akumulasi Amortisasi Aset Tak Berwujud', kategori: 'ASET', normalBalance: 'KREDIT', isSystem: false },
  // Phase 18 §3: RAK (Rekening Antar Kantor) — dana keluar ke unit/
  // kantor lain, dicatat sebagai ASET (penempatan), bukan beban.
  // Poin 10 — label tampilan RAKU. Kode & mapping 1-1800 TIDAK berubah;
  // instalasi lama yang namanya masih bawaan diperbarui migrasi v77.
  { kode: '1-1800', nama: 'Rekening Antar Kantor/Unit (RAKU)', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: true },
  // Phase 17 §8 (Investment Impairment): 1-1900 kosong & konsisten
  // (blok 1-1xxx = aset lainnya). Akun KONTRA (mengurangi Investasi di
  // Posisi Keuangan, pola SAMA PERSIS dengan 1-1210 Penyisihan Piutang
  // — kategori ASET tapi normal_balance KREDIT).
  { kode: '1-1900', nama: 'Penyisihan Penurunan Nilai Investasi', kategori: 'ASET', normalBalance: 'KREDIT', isSystem: false },

  // LIABILITAS
  { kode: '2-1000', nama: 'Utang Usaha', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: false },
  { kode: '2-1100', nama: 'Kewajiban Lainnya', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: false },
  // Simpanan sukarela anggota diklasifikasikan sebagai LIABILITAS (bukan
  // Ekuitas): berbeda dari simpanan pokok/wajib, simpanan sukarela bisa
  // ditarik kapan saja oleh anggota (lihat tarikSimpananSukarela di
  // SimpananService.ts) sehingga secara substansi merupakan kewajiban
  // koperasi ke anggota, sama seperti tabungan pada umumnya — bukan
  // bagian dari modal/ekuitas koperasi. Ini juga yang membuatnya tampil
  // di bagian Liabilitas pada Laporan Posisi Keuangan.
  { kode: '2-1200', nama: 'Simpanan Sukarela Anggota', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: true },
  // REQUIREMENT 1 (permintaan pengguna): "Simpanan Anggota (Berjangka)"
  // — LIABILITAS, alasannya SAMA PERSIS dengan Simpanan Sukarela
  // (2-1200) di atas: simpanan berjangka adalah dana anggota yang wajib
  // dikembalikan koperasi pada saat jatuh tempo, jadi secara substansi
  // kewajiban ke anggota — BUKAN modal/ekuitas seperti Simpanan Pokok
  // (3-1000)/Wajib (3-1100).
  //
  // KODE 2-1210 dipilih SETELAH mengaudit seluruh blok liabilitas
  // existing (2-1000, 2-1100, 2-1200, 2-1300, 2-1400, 2-1500, 2-1600,
  // 2-1700, 2-1800..2-1850, 2-1900) — 2-1210 BELUM PERNAH dipakai.
  // Konvensi numbering yang diikuti: langkah 10 untuk SUB-akun dalam
  // satu kelompok (pola yang SUDAH ada di COA ini: 1-1200/1-1205/1-1210
  // untuk kelompok piutang, dan 2-1800..2-1850 untuk kelompok Dana SHU).
  // Menempatkannya tepat di bawah 2-1200 membuat kedua akun simpanan
  // anggota berkelompok di Posisi Keuangan, BUKAN membuat blok baru
  // yang dikarang (mis. 2-2000) padahal pola existing sudah menyediakan.
  //
  // PEMUTAKHIRAN: modul Simpanan Berjangka kini SUDAH ADA
  // (SimpananBerjangkaService), sehingga akun ini sekarang punya entri
  // di DEFAULT_ACCOUNT_MAPPING (`SIMPANAN_BERJANGKA` / KREDIT_DEFAULT)
  // — komentar lama yang menyatakan "TIDAK ADA entri mapping" sudah
  // tidak berlaku dan diganti.
  //
  // `isSystem: false` DIPERTAHANKAN apa adanya (tidak diubah menjadi
  // true) supaya instalasi lama tidak perlu migrasi kolom hanya untuk
  // flag ini. Akun tetap terlindungi: `updateAccount`/penghapusan sudah
  // menolak akun yang sedang dipakai (`isAccountInUse`), dan hilangnya
  // mapping menghasilkan error keras, bukan fallback diam-diam.
  // isSystem:false juga membuatnya langsung bisa
  // dipakai lewat jalur COA-driven yang SUDAH ADA:
  // `getAccountsUntukKewajiban()` (menu Bayar Kewajiban) & Saldo Awal
  // Akun — keduanya memfilter kategori LIABILITAS + is_active, bukan
  // daftar kode hardcode. Otomatis muncul juga di Daftar Akun, Buku
  // Besar, Neraca Saldo, dan bagian LIABILITAS Laporan Posisi Keuangan
  // karena semuanya membaca tabel `account` yang sama.
  { kode: '2-1210', nama: 'Simpanan Anggota (Berjangka)', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: false },
  { kode: '2-1300', nama: 'Pendapatan Diterima Dimuka', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: false },
  { kode: '2-1400', nama: 'Utang Bank', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: true },
  { kode: '2-1500', nama: 'Utang Pihak Lain', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: true },
  // Phase 18 §1: Utang Imbalan Kerja — kode lanjutan blok liabilitas
  // 2-1xxx yang masih kosong.
  { kode: '2-1600', nama: 'Utang Imbalan Kerja', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: false },
  // 2-1700 kosong & konsisten (blok 2-1xxx = liabilitas jangka pendek
  // lainnya) — Prioritas 10/L (Biaya Pinjaman): akrual bunga utang
  // yang sudah menjadi kewajiban tapi belum dibayar (mis. jatuh tempo
  // pembayaran bunga kuartalan tapi periode akuntansi sudah tutup
  // duluan) — supaya beban bunga diakui di periode terjadinya, bukan
  // baru diakui saat kas benar-benar keluar. Sejak RC-S55 akun ini diisi
  // OTOMATIS oleh UtangBungaAccrualService (WHOLE_MONTH); jalur manual
  // (UtangService.penyesuaianManualBungaUtang) hanya untuk pengecualian.
  // Lihat RC-S57_AKRUAL_BUNGA_UTANG_ARCHITECTURE.md.
  { kode: '2-1700', nama: 'Utang Bunga', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: false },
  // UTANG BUNGA SIMPANAN BERJANGKA — akun TERPISAH dari 2-1700 di atas.
  //
  // Kenapa TIDAK memakai ulang 2-1700 "Utang Bunga": akun itu SUDAH
  // dimiliki domain lain — `UtangService` memetakannya lewat
  // `UTANG_BUNGA/KREDIT_AKRUAL` untuk bunga atas UTANG KOPERASI kepada
  // bank/pihak lain. Kalau bunga simpanan anggota ikut masuk ke sana,
  // saldo GL 2-1700 menjadi campuran dua domain, dan rekonsiliasi
  // "Interest payable" simpanan berjangka TIDAK AKAN PERNAH bisa
  // dibuktikan variance = 0 tanpa mengurangkan angka domain lain
  // secara manual — persis jenis kompromi yang membuat rekonsiliasi
  // berhenti bermakna.
  //
  // Kode 2-1710 mengikuti konvensi sub-akun langkah 10 yang SUDAH
  // dipakai COA ini (2-1200 -> 2-1210 untuk pasangan simpanan), dan
  // diverifikasi belum pernah terpakai.
  { kode: '2-1710', nama: 'Utang Bunga Simpanan Berjangka', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: false },
  // Audit ulang §3/§4 (permintaan pengguna): 6 akun Dana SHU sebagai
  // LIABILITAS (bukan lagi dilebur ke 3-3000 Ekuitas Lainnya seperti
  // sebelumnya lewat mapping KREDIT_DANA_LAINNYA) — masing-masing dana
  // punya akun sendiri supaya bisa dilacak & muncul terpisah di
  // Laporan Posisi Keuangan bagian Liabilitas. Kode 2-1800..2-1850
  // melanjutkan blok liabilitas jangka pendek 2-1xxx yang sudah ada
  // (2-1700 Utang Bunga adalah kode tertinggi sebelumnya di blok ini).
  { kode: '2-1800', nama: 'Dana Pendidikan', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: true },
  { kode: '2-1810', nama: 'Dana Sosial', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: true },
  { kode: '2-1820', nama: 'Dana Pengurus', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: true },
  { kode: '2-1830', nama: 'Dana Pengawas', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: true },
  { kode: '2-1840', nama: 'Dana Karyawan', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: true },
  { kode: '2-1850', nama: 'Dana Pembangunan Daerah Kerja', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: true },
  // Revisi KOPKU (integrasi Utang Koperasi ke COA Liabilitas, Bagian
  // 3B): "Utang Pajak" — SENGAJA dipisah dari "Kewajiban Lainnya"
  // (2-1100, generik) & DIBEDAKAN TEGAS dari "Beban Pajak Penghasilan"
  // (5-2200, BEBAN — pengakuan beban pajak periode berjalan). Akun ini
  // adalah LIABILITAS: pajak yang sudah diakui tapi belum dibayar
  // (Dr Beban Pajak Penghasilan / Kr Utang Pajak saat diakui; Dr Utang
  // Pajak / Kr Kas-Bank saat dibayar). Kode 2-1900 dipilih SETELAH
  // audit blok liabilitas jangka pendek 2-1xxx (2-1850 adalah kode
  // tertinggi sebelumnya) — tidak menimpa akun apa pun yang sudah ada.
  // isSystem: true supaya tidak bisa dihapus/diganti kategori oleh
  // admin lewat COA, sama pola dengan akun-akun Dana SHU di atasnya —
  // akun ini disiapkan untuk dipakai picker Utang Koperasi COA-driven
  // (Bagian 2 audit ini, dikerjakan menyusul).
  { kode: '2-1900', nama: 'Utang Pajak', kategori: 'LIABILITAS', normalBalance: 'KREDIT', isSystem: true },

  // EKUITAS
  { kode: '3-1000', nama: 'Simpanan Pokok', kategori: 'EKUITAS', normalBalance: 'KREDIT', isSystem: true },
  { kode: '3-1100', nama: 'Simpanan Wajib', kategori: 'EKUITAS', normalBalance: 'KREDIT', isSystem: true },
  // Audit ulang (permintaan pengguna, target §8): dua akun EKUITAS baru
  // "Modal Tetap" (3-1200) dan "Modal Tambahan" (3-1300) — kode dipilih
  // mengikuti urutan blok 3-1xxx yang sudah ada (3-1000/3-1100), belum
  // pernah dipakai sebelumnya. Otomatis tersedia untuk instalasi lama
  // lewat blok self-heal COA generik di db.ts (lihat migration v37) —
  // pola sama persis dengan v27/v28/v30/v31/v34/v36. TIDAK ada akun
  // lain yang ditambahkan/diubah.
  { kode: '3-1200', nama: 'Modal Tetap', kategori: 'EKUITAS', normalBalance: 'KREDIT', isSystem: true },
  { kode: '3-1300', nama: 'Modal Tambahan', kategori: 'EKUITAS', normalBalance: 'KREDIT', isSystem: true },
  // Audit ulang (permintaan pengguna §12): nama akun berubah dari
  // "Cadangan" menjadi "Cadangan Umum" — kode (3-2000) TIDAK berubah,
  // TIDAK ada akun baru dibuat, histori jurnal lama tetap menunjuk ke
  // account_id yang sama persis (lihat migration di db.ts, UPDATE nama
  // saja bukan INSERT). Field internal `persenCadangan`/`cadangan`
  // (ShuCalculator.ts/ShuService.ts) SENGAJA TIDAK di-rename — hanya
  // label yang tampil ke pengguna yang berubah, supaya kolom database
  // (`persen_cadangan`) & konfigurasi existing tidak perlu migrasi
  // rename yang berisiko.
  { kode: '3-2000', nama: 'Cadangan Umum', kategori: 'EKUITAS', normalBalance: 'KREDIT', isSystem: false },
  // Audit ulang (permintaan pengguna §13/§14): komponen distribusi SHU
  // baru "Cadangan Risiko" — akun EKUITAS terpisah dari Cadangan Umum
  // (3-2000). Kode 3-2100 dipilih SETELAH mengaudit blok 3-2xxx (hanya
  // 3-2000 yang terpakai sebelumnya, lihat baris di atas) — tidak
  // menimpa akun apa pun yang sudah ada.
  { kode: '3-2100', nama: 'Cadangan Risiko', kategori: 'EKUITAS', normalBalance: 'KREDIT', isSystem: true },
  { kode: '3-3000', nama: 'Ekuitas Lainnya', kategori: 'EKUITAS', normalBalance: 'KREDIT', isSystem: false },
  { kode: '3-4000', nama: 'SHU Tahun Berjalan', kategori: 'EKUITAS', normalBalance: 'KREDIT', isSystem: false },
  // RC-S88 — PENGHASILAN KOMPREHENSIF LAIN (OCI). Akumulasi surplus
  // revaluasi aset tetap di ekuitas. Mutasinya dalam periode dari jurnal
  // revaluasi = pos OCI "tidak akan direklasifikasi ke laba rugi" pada
  // Laporan Hasil Usaha (lihat src/config/ociPolicy.ts). Bukan bagian
  // SHU: tidak ikut dibagikan dan tidak pernah melewati akun pendapatan.
  { kode: '3-6000', nama: 'Surplus Revaluasi Aset Tetap', kategori: 'EKUITAS', normalBalance: 'KREDIT', isSystem: true },
  // Phase 18 §9: akun kliring TEKNIS khusus untuk KOREKSI saldo awal
  // yang sudah diposting (BUKAN untuk posting saldo awal awal itu
  // sendiri — posting utama TIDAK butuh akun kontra sama sekali,
  // lihat SaldoAwalAkunService.postingSaldoAwal, karena satu jurnal
  // pembukaan sudah otomatis balance dari seluruh baris akun
  // sekaligus). Dipakai HANYA oleh SaldoAwalAkunService.koreksiSaldoAwal
  // untuk mengoreksi SATU akun setelah saldo awal ter-posting —
  // saldonya harus kembali Rp0 setelah seluruh koreksi terkait
  // selesai (ditampilkan sebagai peringatan di layar Saldo Awal kalau
  // tidak nol). BUKAN Ekuitas Lainnya (3-3000) — dipisah tegas sesuai
  // instruksi eksplisit.
  { kode: '3-5000', nama: 'Saldo Awal Belum Sesuai (Opening Balance Clearing)', kategori: 'EKUITAS', normalBalance: 'KREDIT', isSystem: true },

  // PENDAPATAN
  { kode: '4-1000', nama: 'Pendapatan Jasa Pinjaman', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: true },
  { kode: '4-1100', nama: 'Pendapatan Administrasi', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: true, lhuKlasifikasi: 'PENDAPATAN_USAHA_LAIN' },
  // PHASE 1 (fondasi pelunasan dipercepat, permintaan pengguna bagian
  // N): DUA akun PENDAPATAN baru untuk penalti & administrasi
  // pelunasan — SENGAJA terpisah dari 4-1000 (Pendapatan Jasa
  // Pinjaman, angsuran normal) dan dari 4-1100 (Pendapatan
  // Administrasi, biaya admin PENCAIRAN) supaya ketiganya bisa
  // direkonsiliasi/dilaporkan terpisah, bukan dicampur. Kode 4-1150/
  // 4-1160 dipilih setelah audit blok 4-1xxx (4-1100 kode existing
  // tertinggi di bawah 4-1200 — belum pernah dipakai). Mapping/logika
  // penghitungan pelunasan itu sendiri BELUM diimplementasikan pada
  // Phase 1 ini (murni menyiapkan akun & mapping untuk Phase 2/N).
  { kode: '4-1150', nama: 'Pendapatan Penalti Pelunasan', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: true, lhuKlasifikasi: 'PENDAPATAN_USAHA_LAIN' },
  { kode: '4-1160', nama: 'Pendapatan Administrasi Pelunasan', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: true, lhuKlasifikasi: 'PENDAPATAN_USAHA_LAIN' },
  { kode: '4-1200', nama: 'Pendapatan Denda', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: true, lhuKlasifikasi: 'PENDAPATAN_USAHA_LAIN' },
  // Revisi KOPKU (Bagian 3A): "Pendapatan Hasil Investasi" — mengisi
  // klasifikasi LHU 'HASIL_INVESTASI' yang SUDAH ADA di type
  // LhuKlasifikasi/FinancialReports.getLHU sejak Revisi LHU KOPKU,
  // tapi SEBELUMNYA belum ada satu akun pun yang memakainya (baris
  // Hasil Investasi di LHU akan selalu Rp0). Dipakai untuk bunga
  // bank/deposito, hasil investasi, dst — dipilih manual lewat menu
  // "Pendapatan Lainnya" existing (PendapatanLainnyaService, akun
  // PENDAPATAN mana pun yang sudah punya lhu_klasifikasi otomatis
  // tampil di sana), TIDAK butuh layar/service baru. Kode 4-1300
  // dipilih SETELAH audit blok 4-1xxx (4-1200 kode tertinggi
  // sebelumnya) — tidak menimpa akun apa pun.
  { kode: '4-1300', nama: 'Pendapatan Hasil Investasi', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: true, lhuKlasifikasi: 'HASIL_INVESTASI' },
  { kode: '4-2000', nama: 'Pendapatan Usaha Lain', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'PENDAPATAN_USAHA_LAIN' },
  { kode: '4-3000', nama: 'Pendapatan Lainnya', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'PENDAPATAN_LAIN' },
  // Akun nominal pendapatan 4-1400..4-1800 (terdaftar sejak migrasi v36)
  // supaya ketiga kelompok LHU pendapatan (PENDAPATAN_USAHA_LAIN/
  // HASIL_INVESTASI/PENDAPATAN_LAIN) masing2 punya baris rinci. Kode
  // melanjutkan urutan 4-1xxx — TIDAK menimpa kode akun lama mana pun.
  // `isSystem: false` (sama seperti 4-2000/4-3000): akun2 ini TIDAK
  // dipetakan dari transaksi otomatis (angsuran/dsb).
  //
  // Jalur posting saat ini:
  //   4-1400 Pendapatan Unit Usaha -> HANYA menu dedicated Pendapatan
  //          Unit Usaha (PendapatanUnitUsahaService); disembunyikan dari
  //          & ditolak oleh jalur generik Pendapatan Lainnya
  //          (AKUN_PENDAPATAN_KHUSUS_MENU_DEDICATED).
  //   akun lain -> leaf Pendapatan Koperasi masing-masing atau menu
  //          Pendapatan Lainnya generik (Dr Kas/Bank, Kr akun terpilih).
  { kode: '4-1400', nama: 'Pendapatan Unit Usaha', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'PENDAPATAN_USAHA_LAIN' },
  // Poin 6 — klasifikasi LHU 4-1500 = Pendapatan Usaha Lain (sebelumnya
  // Hasil Investasi). Kode, nama akun, jurnal, dan saldo TIDAK berubah;
  // instalasi lama diperbarui migrasi v77 (hanya kolom lhu_klasifikasi).
  { kode: '4-1500', nama: 'Pendapatan Bunga', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'PENDAPATAN_USAHA_LAIN' },
  { kode: '4-1600', nama: 'Pendapatan Sewa', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'HASIL_INVESTASI' },
  { kode: '4-1700', nama: 'Pendapatan Bagi Hasil', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'HASIL_INVESTASI' },
  { kode: '4-1800', nama: 'Pendapatan Penjualan Aset', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'PENDAPATAN_LAIN' },

  // BEBAN
  { kode: '5-1000', nama: 'Beban Operasional', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false, lhuKlasifikasi: 'BEBAN_USAHA' },
  { kode: '5-1050', nama: 'Beban Imbalan Kerja', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: true, lhuKlasifikasi: 'BEBAN_USAHA' },
  { kode: '5-1100', nama: 'Beban Gaji', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false, lhuKlasifikasi: 'BEBAN_USAHA' },
  { kode: '5-1200', nama: 'Beban Administrasi dan Umum', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: true, lhuKlasifikasi: 'BEBAN_USAHA' },
  { kode: '5-1300', nama: 'Beban Penyusutan', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false, lhuKlasifikasi: 'BEBAN_USAHA' },
  // Phase 18 §1: Beban Amortisasi — kode langsung di bawah Beban
  // Penyusutan (5-1300) karena kelompok yang mirip (alokasi biaya aset
  // nonmoneter berumur panjang), 5-1310 kosong & konsisten.
  { kode: '5-1310', nama: 'Beban Amortisasi', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false, lhuKlasifikasi: 'BEBAN_USAHA' },
  { kode: '5-1400', nama: 'Beban Sewa', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: true, lhuKlasifikasi: 'BEBAN_USAHA' },
  { kode: '5-1500', nama: 'Beban Transportasi', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: true, lhuKlasifikasi: 'BEBAN_USAHA' },
  { kode: '5-1600', nama: 'Beban BBM', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: true, lhuKlasifikasi: 'BEBAN_USAHA' },
  { kode: '5-1700', nama: 'Beban Listrik', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: true, lhuKlasifikasi: 'BEBAN_USAHA' },
  { kode: '5-1800', nama: 'Beban Telepon', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: true, lhuKlasifikasi: 'BEBAN_USAHA' },
  // RC-S98 — `lhuKlasifikasi` SENGAJA dikosongkan: akun ini dibaca
  // langsung by kode oleh getLHU() sebagai baris baku "Beban
  // perkoperasian" (Juklat SOM 3/2025 Lampiran 1), persis seperti
  // 4-1000 & 5-2200. Nilai lama 'BEBAN_USAHA' pada database yang sudah
  // terpasang TIDAK perlu dimigrasikan — dan memang TIDAK dimigrasikan:
  // getLHU() mengeluarkan akun ini SEBELUM membaca klasifikasi, jadi
  // nilai apa pun di sana tidak berpengaruh pada penyajian. Kedua
  // keadaan database (NULL pada pemasangan baru, 'BEBAN_USAHA' pada
  // pemasangan lama) diuji di LhuUrutanJuklatRcS98.test.ts.
  { kode: '5-1900', nama: 'Beban Perkoperasian', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: true },
  { kode: '5-1950', nama: 'Beban Bunga', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: true, lhuKlasifikasi: 'BEBAN_USAHA' },
  // BEBAN BUNGA SIMPANAN BERJANGKA — terpisah dari 5-1950 dengan alasan
  // yang SAMA seperti 2-1710 di atas: 5-1950 sudah dipetakan
  // `UTANG_BUNGA/DEBIT_BEBAN` untuk bunga utang koperasi. Memisahkannya
  // juga membuat Laporan Laba Rugi menunjukkan berapa yang benar-benar
  // dibayarkan koperasi kepada ANGGOTA atas simpanan berjangka —
  // informasi yang hilang kalau digabung dengan bunga pinjaman bank.
  // lhuKlasifikasi 'BEBAN_USAHA' sama dengan 5-1950 supaya penyajian
  // LHU tidak berubah bentuk.
  { kode: '5-1955', nama: 'Beban Bunga Simpanan Berjangka', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false, lhuKlasifikasi: 'BEBAN_USAHA' },
  // BEBAN BUNGA SIMPANAN SUKARELA (kebijakan bunga tabungan, Juklat SOM 2025
  // hlm. 30–31). Terpisah dari 5-1955 supaya LHU menunjukkan bunga yang
  // dibayarkan atas tabungan anggota. Instalasi lama memperoleh akun ini
  // lewat BungaSukarelaService saat bunga pertama dibukukan.
  { kode: '5-1956', nama: 'Beban Bunga Simpanan Sukarela', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false, lhuKlasifikasi: 'BEBAN_USAHA' },
  // Revisi KOPKU (Bagian 3C): permintaan pengguna adalah akun "Beban
  // Usaha Lainnya" (kategori BEBAN, lhuKlasifikasi BEBAN_USAHA).
  // SENGAJA TIDAK dibuat sebagai akun baru — "Beban Lainnya" di bawah
  // ini SUDAH PERSIS akun dengan fungsi yang sama (kategori BEBAN,
  // lhuKlasifikasi BEBAN_USAHA sejak migration v33, dipilih manual
  // lewat BebanFormScreen sebagai "beban lain-lain di luar kategori
  // baku"). Membuat akun kedua dengan fungsi identik akan melanggar
  // instruksi eksplisit audit ini ("Jangan membuat duplikasi jika akun
  // existing dengan fungsi yang sama sudah tersedia"). Kalau nama
  // "Beban Usaha Lainnya" secara spesifik diperlukan (mis. istilah
  // baku laporan), opsi paling aman adalah RENAME akun ini (kode TETAP
  // 5-2000, pola sama dengan rename "Cadangan" -> "Cadangan Umum" di
  // migration v30) — TIDAK dilakukan di sini karena berisiko
  // memengaruhi seluruh histori transaksi "Beban Lainnya" tanpa
  // konfirmasi eksplisit; lihat laporan akhir audit ini.
  { kode: '5-2000', nama: 'Beban Lainnya', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false, lhuKlasifikasi: 'BEBAN_USAHA' },
  // REQUIREMENT 3 (permintaan pengguna): nama akun berubah dari "Beban
  // Penyisihan Piutang Tak Tertagih" menjadi "Beban Penyisihan
  // Pinjaman". KODE TETAP 5-2100 — TIDAK berubah sama sekali, jadi:
  //  - `account.id` yang sama tetap dipakai seluruh jurnal historis;
  //  - `account_mapping` PENYISIHAN_PIUTANG/DEBIT_BEBAN (di bawah)
  //    tetap menunjuk kode yang sama;
  //  - Laba Rugi/LHU/Buku Besar/Neraca Saldo/export ikut berubah
  //    label OTOMATIS karena semuanya membaca `account.nama` dari
  //    tabel yang sama (tidak ada satu pun string nama akun ini yang
  //    di-hardcode di service/report — sudah diverifikasi lewat
  //    pencarian global "Beban Penyisihan Piutang Tak Tertagih").
  // Instalasi LAMA: di-rename lewat migration v50 (db.ts), pola SAMA
  // PERSIS dengan rename "Cadangan" -> "Cadangan Umum" di v30 (UPDATE
  // nama saja, BUKAN INSERT akun baru).
  { kode: '5-2100', nama: 'Beban Penyisihan Pinjaman', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: true, lhuKlasifikasi: 'BEBAN_USAHA' },
  // Phase 17 §8: 5-2150 kosong & konsisten (blok 5-21xx = beban
  // penyisihan/penurunan nilai).
  { kode: '5-2150', nama: 'Beban Penurunan Nilai Investasi', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false, lhuKlasifikasi: 'BEBAN_LAIN' },
  // RC-S54 TAHAP 16 (#20, keputusan COA pengguna): rugi pelepasan investasi.
  // Kode diaudit dulu (5-2160 belum dipakai di COA, registry, maupun kode).
  // BEBAN_LAIN (non-operasional), terpisah dari penurunan nilai (5-2150) dan
  // dari Beban Lainnya operasional (5-2000). Disalurkan ke perangkat lama lewat
  // self-heal saat kenaikan SCHEMA_VERSION ke 66.
  // RC-S54 TAHAP 16 GAP 6 (keputusan pengguna): rugi pelepasan ASET TETAP. Audit COA:
  // tidak ada akun khusus existing (5-2000 = BEBAN_USAHA, 5-2150 = penurunan nilai,
  // 5-2160 = khusus investasi). Disalurkan ke perangkat lama lewat self-heal v67.
  { kode: '5-2170', nama: 'Kerugian Pelepasan Aset Tetap', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false, lhuKlasifikasi: 'BEBAN_LAIN' },
  // ===========================================================================
  // RC-S54 POST-CLOSURE #14 (keputusan pengguna) — AKUN DENGAN KODE PERSIS
  // YANG DIMINTA. DEFINED / NOT ACTIVELY POSTED: akun-akun ini TERSEDIA di COA
  // dan dapat dipilih manual, tetapi TIDAK ada mapping otomatis ke sini.
  // Policy final RC-S54 tidak berubah: properti investasi tetap diposting ke
  // 1-1660/1-1670 (KEPUTUSAN 02), bagian SHU tetap Dr 1-1220 / Cr 4-1300
  // (KEPUTUSAN 04-A), dan nilai wajar tetap digated POLICY 03 = MODEL BIAYA.
  // Tidak ada jurnal historis yang dipindahkan.
  // ===========================================================================
  { kode: '1-220', nama: 'Piutang Pendapatan Investasi', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: false },
  { kode: '1-230', nama: 'Piutang Dividen', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: false },
  { kode: '1-240', nama: 'Piutang Bagi Hasil', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: false },
  { kode: '1-250', nama: 'Piutang Pendapatan Sewa', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: false },
  { kode: '1-660', nama: 'Tanah Properti Investasi', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: false },
  { kode: '1-661', nama: 'Bangunan Properti Investasi', kategori: 'ASET', normalBalance: 'DEBIT', isSystem: false },
  { kode: '4-1510', nama: 'Pendapatan Bunga Deposito', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'HASIL_INVESTASI' },
  { kode: '4-1520', nama: 'Pendapatan Bunga Investasi', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'HASIL_INVESTASI' },
  { kode: '4-1530', nama: 'Pendapatan Dividen', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'HASIL_INVESTASI' },
  { kode: '4-1540', nama: 'Pendapatan Jasa (Bagian SHU)', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'HASIL_INVESTASI' },
  // RC-S88: 4-2100 & 5-5000 kini DIPOSTING OTOMATIS oleh Penyesuaian Nilai
  // Wajar properti investasi (mapping NILAI_WAJAR_PROPERTI_INVESTASI).
  { kode: '4-2100', nama: 'Keuntungan Perubahan Nilai Wajar Properti Investasi', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'PENDAPATAN_LAIN' },
  { kode: '5-5000', nama: 'Kerugian Nilai Wajar Properti Investasi', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false, lhuKlasifikasi: 'BEBAN_LAIN' },
  // RC-S88 — revaluasi aset tetap yang MASUK LABA RUGI (SAK EP Bab 17):
  //  - penurunan yang melebihi surplus revaluasi aset tsb -> 5-5100;
  //  - kenaikan yang MEMULIHKAN penurunan yang dulu dibebankan ke laba
  //    rugi -> 4-2200 (sebesar penurunan itu saja; sisanya ke OCI).
  { kode: '4-2200', nama: 'Pemulihan Kerugian Revaluasi Aset Tetap', kategori: 'PENDAPATAN', normalBalance: 'KREDIT', isSystem: false, lhuKlasifikasi: 'PENDAPATAN_LAIN' },
  { kode: '5-5100', nama: 'Kerugian Revaluasi Aset Tetap', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false, lhuKlasifikasi: 'BEBAN_LAIN' },
  { kode: '5-2160', nama: 'Kerugian Pelepasan Investasi', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false, lhuKlasifikasi: 'BEBAN_LAIN' },
  // Update pasca-Phase 18/19 (permintaan pengguna §O.20): akun baru,
  // kode diaudit dulu (5-2200 belum dipakai) — TIDAK otomatis dipetakan
  // ke transaksi tertentu (tidak ada fitur khusus yang eksplisit
  // diminta), dipilih manual lewat AccountPicker saat mencatat beban,
  // pola yang sama dengan "Beban Lainnya" (5-2000) di atasnya.
  { kode: '5-2200', nama: 'Beban Pajak Penghasilan', kategori: 'BEBAN', normalBalance: 'DEBIT', isSystem: false },
];

/**
 * Mapping transaksi otomatis -> kode akun default (dipakai saat seed awal).
 * Sesuai konsep di AccountMapping.ts: transaction_type + role -> account_id.
 */
export const DEFAULT_ACCOUNT_MAPPING: Array<{
  transactionType: string;
  role: string;
  accountKode: string;
}> = [
  { transactionType: 'KAS_UMUM', role: 'DEFAULT', accountKode: '1-1000' },
  // KAS_KECIL TIDAK LAGI dipetakan (Phase 18 §4) — akun 1-1001
  // dinonaktifkan, instalasi baru tidak lagi punya jalur Kas Kecil.
  // Instalasi lama: mapping ini dihapus oleh migration v18 (db.ts).
  { transactionType: 'SIMPANAN_POKOK', role: 'KREDIT_DEFAULT', accountKode: '3-1000' },
  { transactionType: 'SIMPANAN_WAJIB', role: 'KREDIT_DEFAULT', accountKode: '3-1100' },
  { transactionType: 'SIMPANAN_SUKARELA', role: 'KREDIT_DEFAULT', accountKode: '2-1200' },
  // SIMPANAN BERJANGKA — deposito anggota. Pola SAMA PERSIS dengan tiga
  // mapping simpanan di atas: satu transactionType, satu role
  // KREDIT_DEFAULT, satu akun eksplisit. Sisi debit (Kas/Bank)
  // ditentukan `resolveKasBankAccountId()` seperti setoran simpanan
  // lain, bukan dari mapping ini.
  //
  // TIDAK ADA fallback: kalau baris ini hilang dari `account_mapping`,
  // `resolveAccountId()` melempar MissingAccountMappingError dan
  // seluruh transaksi di-rollback — BUKAN memilih akun liabilitas
  // pertama yang ditemukan.
  { transactionType: 'SIMPANAN_BERJANGKA', role: 'KREDIT_DEFAULT', accountKode: '2-1210' },
  // Akrual bunga kontraktual simpanan berjangka:
  //   Dr 5-1955 Beban Bunga Simpanan Berjangka
  //   Cr 2-1710 Utang Bunga Simpanan Berjangka
  // Pokok (2-1210) TIDAK disentuh sama sekali oleh akrual bunga.
  { transactionType: 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL', role: 'DEBIT_BEBAN', accountKode: '5-1955' },
  { transactionType: 'SIMPANAN_SUKARELA_BUNGA', role: 'DEBIT_BEBAN', accountKode: '5-1956' },
  { transactionType: 'SIMPANAN_BERJANGKA_BUNGA_AKRUAL', role: 'KREDIT_UTANG_BUNGA', accountKode: '2-1710' },
  // Pencairan saat jatuh tempo:
  //   Dr 2-1210 (pokok)  Dr 2-1710 (bunga terutang)  Cr Kas/Bank
  // Sisi kredit Kas/Bank ditentukan `resolveKasBankAccountId()`, bukan
  // mapping ini — pola sama dengan seluruh transaksi kas lain.
  { transactionType: 'SIMPANAN_BERJANGKA_PENCAIRAN', role: 'DEBIT_POKOK', accountKode: '2-1210' },
  { transactionType: 'SIMPANAN_BERJANGKA_PENCAIRAN', role: 'DEBIT_UTANG_BUNGA', accountKode: '2-1710' },
  { transactionType: 'UTANG_BANK', role: 'KREDIT_DEFAULT', accountKode: '2-1400' },
  { transactionType: 'UTANG_PIHAK_LAIN', role: 'KREDIT_DEFAULT', accountKode: '2-1500' },
  // Utang usaha (accounts payable) — dipakai pembelian aset metode KREDIT
  // (AsetService.beliAset) supaya resolusi akunnya lewat mapping yang
  // sama seperti transaksi otomatis lain (AccountMapping.ts), bukan
  // query nama akun hard-code langsung di service.
  { transactionType: 'UTANG_USAHA', role: 'KREDIT_DEFAULT', accountKode: '2-1000' },
  // INVESTASI_UNIT_USAHA TIDAK LAGI dipetakan (Phase 18 §2) — jenis
  // investasi UNIT_USAHA dihapus dari transaksi BARU, akun 1-1600
  // dinonaktifkan. Instalasi lama: mapping ini dihapus oleh migration
  // v18 (db.ts). Data investasi UNIT_USAHA lama tetap terbaca dari
  // tabel `investasi` & jurnal historisnya, hanya tidak bisa dibuat lagi.
  { transactionType: 'INVESTASI_KOPERASI_LAIN', role: 'DEBIT_ASET', accountKode: '1-1610' },
  // Audit ulang (permintaan pengguna §2/§3/§4): mapping untuk 5 jenis
  // investasi baru — masing-masing transactionType TERPISAH (mengikuti
  // pola INVESTASI_KOPERASI_LAIN di atas), BUKAN satu akun generik.
  { transactionType: 'INVESTASI_USAHA_LAIN', role: 'DEBIT_ASET', accountKode: '1-1620' },
  { transactionType: 'INVESTASI_TABUNGAN_BANK_UMUM', role: 'DEBIT_ASET', accountKode: '1-1630' },
  { transactionType: 'INVESTASI_GIRO_BANK_UMUM', role: 'DEBIT_ASET', accountKode: '1-1640' },
  { transactionType: 'INVESTASI_DEPOSITO_BANK_UMUM', role: 'DEBIT_ASET', accountKode: '1-1650' },
  { transactionType: 'INVESTASI_PROPERTI_INVESTASI', role: 'DEBIT_ASET', accountKode: '1-1660' },
  // Phase 18 §1: kesiapan struktur akun Aset Tak Berwujud, Utang
  // Imbalan Kerja & amortisasinya — belum ada fitur transaksi khusus
  // (sesuai permintaan pengguna, "minimal COA & struktur akun siap
  // digunakan"), tapi mapping-nya sudah disiapkan supaya fitur
  // berikutnya tinggal memakai resolveAccountId() seperti pola lain.
  { transactionType: 'ASET_TAK_BERWUJUD', role: 'DEBIT_ASET', accountKode: '1-1700' },
  { transactionType: 'AMORTISASI_ASET_TAK_BERWUJUD', role: 'DEBIT_BEBAN', accountKode: '5-1310' },
  { transactionType: 'AMORTISASI_ASET_TAK_BERWUJUD', role: 'KREDIT_AKUMULASI', accountKode: '1-1710' },
  { transactionType: 'UTANG_IMBALAN_KERJA', role: 'KREDIT_DEFAULT', accountKode: '2-1600' },
  // Prioritas 9/K (Imbalan Kerja) — role BARU untuk sisi Beban akrual
  // (DEBIT Beban Imbalan Kerja / KREDIT Utang Imbalan Kerja). Akun
  // 5-1050 sendiri sudah ada sejak lama (dipakai juga sebagai kategori
  // "Beban Imbalan Kerja" langsung tunai di BebanFormScreen) — role
  // mapping ini KHUSUS untuk sisi akrual (kewajiban belum dibayar),
  // dipakai ImbalanKerjaService.ts.
  { transactionType: 'UTANG_IMBALAN_KERJA', role: 'DEBIT_BEBAN', accountKode: '5-1050' },
  // Phase 18 §3: RAK — satu transactionType untuk kedua jenis_rak
  // (PENYALURAN_DANA/SETORAN_DANA), keduanya sama-sama DEBIT akun RAK.
  { transactionType: 'RAK', role: 'DEBIT_ASET', accountKode: '1-1800' },
  // LEGACY — "Pemberian Pinjaman untuk Koperasi" (koperasi memberikan
  // pinjaman ke pihak/koperasi lain). Fitur runtime-nya DIHAPUS di
  // RC-S70.2; mapping ini SENGAJA DIPERTAHANKAN karena jurnal historis
  // bersumber `PEMBERIAN_PINJAMAN_KOPERASI` masih harus dapat di-resolve
  // (lihat juga CashFlowClassification.ts). DEBIT Piutang Pinjaman.
  // Reuse akun 1-1200 "Piutang Pinjaman Anggota" yang SUDAH ADA (instruksi
  // eksplisit: jangan membuat COA baru secara otomatis) — TIDAK ada akun
  // "Piutang" lain di COA default yang lebih cocok. CATATAN DESAIN
  // PENTING (didokumentasikan supaya jelas, bukan bug): akun ini sekarang
  // menampung DUA sub-piutang berbeda — piutang pinjaman ANGGOTA (dikelola
  // PinjamanService, tabel `pinjaman`/`angsuran_jadwal`) dan piutang
  // pinjaman ke KOPERASI/PIHAK LAIN (fitur legacy yang dihapus, tabel
  // `pinjaman_koperasi`) — SALDO akun 1-1200 di Neraca adalah GABUNGAN
  // keduanya. Laporan per-anggota (Detail Anggota, dsb.) TIDAK terpengaruh
  // karena semuanya membaca langsung dari tabel `pinjaman`/`angsuran_jadwal`
  // (bukan dari saldo akun), jadi tidak ada regresi angka pinjaman
  // anggota. Kalau nanti dibutuhkan akun terpisah, admin bisa menambah
  // COA baru & mapping baru lewat Pengaturan > Chart of Accounts.
  { transactionType: 'PEMBERIAN_PINJAMAN_KOPERASI', role: 'DEBIT_ASET', accountKode: '1-1200' },
  { transactionType: 'UTANG_BUNGA', role: 'DEBIT_BEBAN', accountKode: '5-1950' },
  // Prioritas 10/L — role BARU untuk akrual bunga (KREDIT Utang
  // Bunga, kewajiban yang belum dibayar).
  { transactionType: 'UTANG_BUNGA', role: 'KREDIT_AKRUAL', accountKode: '2-1700' },
  { transactionType: 'PENDAPATAN_DITERIMA_DIMUKA', role: 'KREDIT_DEFAULT', accountKode: '2-1300' },
  { transactionType: 'ASET_TETAP', role: 'DEBIT_ASET', accountKode: '1-1500' },
  { transactionType: 'PENYUSUTAN_ASET', role: 'DEBIT_BEBAN', accountKode: '5-1300' },
  { transactionType: 'PENYUSUTAN_ASET', role: 'KREDIT_AKUMULASI', accountKode: '1-1510' },
  // RC-S53 corrective — penyusutan properti investasi memakai beban yang
  // sama (`5-1300`) tetapi akumulasi TERSENDIRI (`1-1670`), supaya Posisi
  // Keuangan menetralkannya terhadap Properti Investasi, bukan terhadap
  // Aset Tetap.
  { transactionType: 'PENYUSUTAN_PROPERTI_INVESTASI', role: 'DEBIT_BEBAN', accountKode: '5-1300' },
  { transactionType: 'PENYUSUTAN_PROPERTI_INVESTASI', role: 'KREDIT_AKUMULASI', accountKode: '1-1670' },
  { transactionType: 'PENGAKUAN_PENDAPATAN_DIMUKA', role: 'DEBIT_DIMUKA', accountKode: '2-1300' },
  { transactionType: 'PENGAKUAN_PENDAPATAN_DIMUKA', role: 'KREDIT_PENDAPATAN', accountKode: '4-3000' },
  { transactionType: 'PENYISIHAN_PIUTANG', role: 'DEBIT_BEBAN', accountKode: '5-2100' },
  // Phase 17 §8: mapping untuk impairment investasi.
  { transactionType: 'IMPAIRMENT_INVESTASI', role: 'DEBIT_BEBAN', accountKode: '5-2150' },
  { transactionType: 'IMPAIRMENT_INVESTASI', role: 'KREDIT_PENYISIHAN', accountKode: '1-1900' },
  // RC-S54 TAHAP 16 (#20) — pelepasan investasi. Laba: reuse akun existing 4-1800
  // "Pendapatan Penjualan Aset" (PENDAPATAN_LAIN, non-operasional). Rugi: akun baru
  // 5-2160 "Kerugian Pelepasan Investasi" (BEBAN_LAIN) — keputusan COA pengguna,
  // disalurkan ke perangkat lama lewat self-heal v66.
  { transactionType: 'PELEPASAN_INVESTASI', role: 'KREDIT_LABA', accountKode: '4-1800' },
  { transactionType: 'PELEPASAN_INVESTASI', role: 'DEBIT_RUGI', accountKode: '5-2160' },
  // RC-S88 — PENYESUAIAN NILAI WAJAR (lihat PenyesuaianNilaiWajarService).
  // Properti investasi, model nilai wajar melalui laba rugi (SAK EP 16):
  //   naik : Dr 1-1665 / Cr 4-2100      turun: Dr 5-5000 / Cr 1-1665
  { transactionType: 'NILAI_WAJAR_PROPERTI_INVESTASI', role: 'PENYESUAIAN_ASET', accountKode: '1-1665' },
  { transactionType: 'NILAI_WAJAR_PROPERTI_INVESTASI', role: 'KREDIT_KEUNTUNGAN', accountKode: '4-2100' },
  { transactionType: 'NILAI_WAJAR_PROPERTI_INVESTASI', role: 'DEBIT_KERUGIAN', accountKode: '5-5000' },
  // Aset tetap, model revaluasi (SAK EP 17):
  //   naik : Dr 1-1520 / Cr 4-2200 (pemulihan rugi lalu) + Cr 3-6000 (OCI)
  //   turun: Dr 3-6000 (OCI, s.d. surplus aset tsb) + Dr 5-5100 / Cr 1-1520
  { transactionType: 'REVALUASI_ASET_TETAP', role: 'PENYESUAIAN_ASET', accountKode: '1-1520' },
  { transactionType: 'REVALUASI_ASET_TETAP', role: 'SURPLUS_OCI', accountKode: '3-6000' },
  { transactionType: 'REVALUASI_ASET_TETAP', role: 'KREDIT_PEMULIHAN', accountKode: '4-2200' },
  { transactionType: 'REVALUASI_ASET_TETAP', role: 'DEBIT_KERUGIAN', accountKode: '5-5100' },
  // RC-S54 TAHAP 16 GAP 6 — pelepasan aset tetap: laba 4-1800 (existing), rugi 5-2170 (v67).
  { transactionType: 'PELEPASAN_ASET_TETAP', role: 'KREDIT_LABA', accountKode: '4-1800' },
  { transactionType: 'PELEPASAN_ASET_TETAP', role: 'DEBIT_RUGI', accountKode: '5-2170' },
  { transactionType: 'PENYISIHAN_PIUTANG', role: 'KREDIT_PENYISIHAN', accountKode: '1-1210' },
  { transactionType: 'BIAYA_DIBAYAR_DIMUKA', role: 'DEBIT_DIMUKA', accountKode: '1-1400' },
  { transactionType: 'MODAL_LAINNYA', role: 'KREDIT_DEFAULT', accountKode: '3-3000' },
  { transactionType: 'PENCAIRAN_PINJAMAN', role: 'DEBIT_PIUTANG', accountKode: '1-1200' },
  { transactionType: 'ANGSURAN_JASA', role: 'KREDIT_PENDAPATAN', accountKode: '4-1000' },
  { transactionType: 'ANGSURAN_DENDA', role: 'KREDIT_PENDAPATAN', accountKode: '4-1200' },
  { transactionType: 'BIAYA_ADMIN_PINJAMAN', role: 'KREDIT_PENDAPATAN', accountKode: '4-1100' },
  // PHASE 2 (§12/§13, permintaan pengguna) — sisi Kredit BARU untuk
  // biaya admin pencairan yang diklasifikasikan
  // INTEGRAL_FINANCIAL_INSTRUMENT (lihat pinjaman.biaya_admin_klasifikasi,
  // migration v43): fee TIDAK diakui sebagai pendapatan langsung
  // (masih memerlukan pengukuran EIR/effective yield penuh, di luar
  // scope Phase 2 — "jangan membuat EIR palsu"), dibukukan sementara
  // sebagai liabilitas "Pendapatan Diterima Dimuka" (akun 2-1300 yang
  // SUDAH ADA, reuse — TIDAK membuat akun baru) sampai Phase EIR
  // membangun amortisasi yang sesungguhnya.
  { transactionType: 'BIAYA_ADMIN_PINJAMAN', role: 'KREDIT_DIMUKA', accountKode: '2-1300' },
  // PHASE 7 (permintaan pengguna §E/§K): amortisasi fee integral lewat
  // EIR — mengurangi liabilitas Pendapatan Diterima Dimuka (akun 2-1300
  // EXISTING, reuse) dan mengakuinya ke akun Pendapatan Jasa Pinjaman
  // YANG SAMA (4-1000, SAMA PERSIS dengan ANGSURAN_JASA/
  // AKRUAL_JASA_PINJAMAN) — SENGAJA satu akun income yang sama, BUKAN
  // "Pendapatan Fee Amortisasi" terpisah, supaya presentasi laporan
  // tetap SATU baris "Pendapatan Jasa Pinjaman" (§K: "jangan
  // menjadikan Pendapatan Jasa + Fee Amortization sebagai dua income
  // terpisah"). Lihat EirAccountingService.ts.
  { transactionType: 'EIR_FEE_AMORTIZATION', role: 'DEBIT_DIMUKA', accountKode: '2-1300' },
  { transactionType: 'EIR_FEE_AMORTIZATION', role: 'KREDIT_PENDAPATAN', accountKode: '4-1000' },
  // PHASE 4 KOREKSI FINAL (permintaan pengguna) — reuse akun 2-1300
  // YANG SAMA (bukan akun baru) untuk kasus BERBEDA: jasa kontraktual
  // MASA DEPAN (belum jatuh tempo) yang tetap ditagih saat pelunasan
  // dipercepat (kontrak FLAT tanpa rabat). Ini BUKAN penalti (4-1150)
  // — pengguna secara eksplisit menolak reklasifikasi itu — dan BUKAN
  // pendapatan jasa biasa (belum ada waktu berlalu untuk diakui).
  // TransactionType TERPISAH dari BIAYA_ADMIN_PINJAMAN di atas supaya
  // audit trail tetap jelas (dua sumber berbeda, satu akun GL yang
  // sama), pola SAMA seperti AKRUAL_JASA_PINJAMAN vs
  // PEMBAYARAN_JASA_PINJAMAN yang berbagi 1-1205. Lihat
  // PinjamanService.lunasiPinjaman() — TIDAK ADA EIR yang dihitung di
  // sini, murni deferral yang jujur (Dr Kas / Cr liabilitas) sampai
  // Phase EIR menentukan pengakuan yang benar.
  { transactionType: 'PELUNASAN_JASA_FUTURE', role: 'KREDIT_DIMUKA', accountKode: '2-1300' },
  // PHASE 1 (fondasi, permintaan pengguna bagian F/N) — mapping
  // disiapkan sekarang supaya PHASE 2 tinggal memanggil
  // resolveAccountId() seperti pola lain (bukan hardcode akun), TAPI
  // BELUM dipakai oleh service mana pun pada Phase 1 ini:
  //  - PIUTANG_JASA_PINJAMAN/DEBIT_PIUTANG_JASA: sisi Debit saat jasa
  //    periode berjalan diakui sebagai piutang (Dr Piutang Jasa),
  //    dipakai mekanisme akrual bulanan PHASE 2.
  //  - PELUNASAN_PENALTI/PELUNASAN_ADMINISTRASI KREDIT_PENDAPATAN:
  //    sisi Kredit saat penalti/administrasi pelunasan dipercepat
  //    diakui sebagai pendapatan (lihat Bagian N).
  { transactionType: 'PIUTANG_JASA_PINJAMAN', role: 'DEBIT_PIUTANG_JASA', accountKode: '1-1205' },
  { transactionType: 'PELUNASAN_PENALTI', role: 'KREDIT_PENDAPATAN', accountKode: '4-1150' },
  { transactionType: 'PELUNASAN_ADMINISTRASI', role: 'KREDIT_PENDAPATAN', accountKode: '4-1160' },
  // PHASE 2 (§17, permintaan pengguna) — transactionType TERPISAH
  // untuk akrual vs pembayaran jasa (audit trail jelas, TIDAK memakai
  // transactionType pembayaran untuk akrual atau sebaliknya):
  //  - AKRUAL_JASA_PINJAMAN: Dr Piutang Jasa (1-1205) / Cr Pendapatan
  //    Jasa Pinjaman (4-1000, akun YANG SAMA dipakai ANGSURAN_JASA —
  //    satu akun pendapatan jasa, bukan dua) — dipakai
  //    AkrualJasaPinjamanService.prosesAkrualJasaPinjaman().
  //  - PEMBAYARAN_JASA_PINJAMAN: Kr Piutang Jasa (1-1205) saat kas
  //    diterima untuk jasa yang SUDAH diakru — dipakai
  //    PinjamanService.bayarAngsuran()/lunasiPinjaman() untuk porsi
  //    jasa yang sudah pernah diakru (porsi yang BELUM diakru tetap
  //    lewat mapping ANGSURAN_JASA/KREDIT_PENDAPATAN existing seperti
  //    sebelum Phase 2, lihat §5/§6 & AkrualJasaPinjamanService).
  { transactionType: 'AKRUAL_JASA_PINJAMAN', role: 'DEBIT_PIUTANG_JASA', accountKode: '1-1205' },
  { transactionType: 'AKRUAL_JASA_PINJAMAN', role: 'KREDIT_PENDAPATAN', accountKode: '4-1000' },
  { transactionType: 'PEMBAYARAN_JASA_PINJAMAN', role: 'KREDIT_PIUTANG_JASA', accountKode: '1-1205' },
  // FINAL FIX AKRUAL JASA (permintaan pengguna BUG 4/5/7) — dua role
  // BARU, tetapi menunjuk akun 2-1300 "Pendapatan Diterima Dimuka"
  // yang SUDAH ADA (reuse mekanisme existing yang SAMA dipakai fee
  // integral pencairan & jasa future pelunasan — TIDAK ada akun baru,
  // TIDAK ada mekanisme akuntansi kedua):
  //  - ANGSURAN_JASA/KREDIT_DIMUKA: kas jasa diterima SEBELUM tanggal
  //    jatuh tempo periodenya. Kas sungguhan masuk (Dr Kas), tetapi
  //    jasa BELUM earned menurut kebijakan akrual yang dipakai modul
  //    ini (pengakuan berbasis periode yang sudah berjalan), jadi
  //    dikreditkan ke liabilitas, BUKAN ke Pendapatan Jasa.
  //  - AKRUAL_JASA_PINJAMAN/DEBIT_DIMUKA: sisi Debit saat periode itu
  //    akhirnya jatuh tempo — liabilitas dilepas dan pendapatan diakui
  //    (Dr Pendapatan Diterima Dimuka / Cr Pendapatan Jasa), pola
  //    IDENTIK dengan EIR_FEE_AMORTIZATION/DEBIT_DIMUKA di atas.
  { transactionType: 'ANGSURAN_JASA', role: 'KREDIT_DIMUKA', accountKode: '2-1300' },
  { transactionType: 'AKRUAL_JASA_PINJAMAN', role: 'DEBIT_DIMUKA', accountKode: '2-1300' },
  // Distribusi SHU (PRD §29). Audit ulang §4/§9 (permintaan pengguna):
  // dana Pendidikan/Sosial/Pengurus/Pengawas/Karyawan/Pembangunan
  // Daerah Kerja SEKARANG masing-masing punya akun LIABILITAS sendiri
  // (2-1800..2-1850) — ShuService.ts (bagikanSHU) TIDAK LAGI memakai
  // role gabungan `KREDIT_DANA_LAINNYA` untuk memposting dana-dana ini.
  // Role `KREDIT_DANA_LAINNYA` (-> 3-3000 Ekuitas Lainnya) TETAP
  // DIPERTAHANKAN di sini — TIDAK dihapus — karena dipakai ulang oleh
  // fitur LAIN yang TIDAK BOLEH diubah oleh audit ini (KasBankService.
  // tambahRekeningBank/catatSaldoAwalKas dan AsetService, untuk
  // menjurnal SALDO AWAL rekening bank/kas/aset ke akun "Ekuitas
  // Lainnya"). Menghapus role ini akan membuat fitur Saldo Awal gagal
  // total (MissingAccountMappingError) — di luar scope 4 permintaan
  // utama audit ini. SHU Anggota/Simpanan Sukarela TETAP memakai
  // mapping SIMPANAN_SUKARELA/KREDIT_DEFAULT yang sudah ada di atas
  // (2-1200), TIDAK diubah.
  { transactionType: 'SHU_DISTRIBUSI', role: 'DEBIT_SHU_BERJALAN', accountKode: '3-4000' },
  { transactionType: 'SHU_DISTRIBUSI', role: 'KREDIT_CADANGAN', accountKode: '3-2000' },
  // Audit ulang §13/§14/§15 (permintaan pengguna): komponen distribusi
  // SHU baru "Cadangan Risiko" — akun EKUITAS terpisah (3-2100),
  // BUKAN dilebur ke Cadangan Umum (role KREDIT_CADANGAN di atas).
  { transactionType: 'SHU_DISTRIBUSI', role: 'KREDIT_CADANGAN_RISIKO', accountKode: '3-2100' },
  { transactionType: 'SHU_DISTRIBUSI', role: 'KREDIT_DANA_LAINNYA', accountKode: '3-3000' },
  { transactionType: 'SHU_DISTRIBUSI', role: 'KREDIT_DANA_PENDIDIKAN', accountKode: '2-1800' },
  { transactionType: 'SHU_DISTRIBUSI', role: 'KREDIT_DANA_SOSIAL', accountKode: '2-1810' },
  { transactionType: 'SHU_DISTRIBUSI', role: 'KREDIT_DANA_PENGURUS', accountKode: '2-1820' },
  { transactionType: 'SHU_DISTRIBUSI', role: 'KREDIT_DANA_PENGAWAS', accountKode: '2-1830' },
  { transactionType: 'SHU_DISTRIBUSI', role: 'KREDIT_DANA_KARYAWAN', accountKode: '2-1840' },
  { transactionType: 'SHU_DISTRIBUSI', role: 'KREDIT_DANA_PEMBANGUNAN_DAERAH_KERJA', accountKode: '2-1850' },
  { transactionType: 'KOREKSI_SALDO_AWAL', role: 'KLIRING', accountKode: '3-5000' },
  // RC-S53 KEPUTUSAN 04-A — BAGIAN SHU DARI INVESTASI.
  //
  // Akun yang dipakai SELURUHNYA akun yang sudah diputuskan, bukan akun
  // baru: piutangnya `1-1220` (KEPUTUSAN 01-A) dan pendapatannya
  // `4-1300` (KEPUTUSAN 01-B, yang memetakan dividen/hasil investasi ke
  // akun ini). TIDAK ada akun pendapatan duplikat dan TIDAK ada akun
  // fallback.
  //
  //   pengakuan  : Dr 1-1220 / Cr 4-1300
  //   penerimaan : Dr Kas-Bank / Cr 1-1220
  //
  // Sisi Kas/Bank pada penerimaan ditentukan `resolveKasBankAccountId()`
  // seperti seluruh transaksi kas lain, jadi tidak dipetakan di sini.
  //
  // `1-1240` dan `1-1250` SENGAJA belum dipetakan: keduanya menunggu
  // jenis hasil yang policy-nya belum turun (imbal hasil tetap dan
  // pendapatan sewa properti investasi). Memetakan akun tanpa aturan
  // pengakuan justru menyiratkan mekanisme yang belum ada.
  { transactionType: 'BAGIAN_SHU_INVESTASI', role: 'DEBIT_PIUTANG', accountKode: '1-1220' },
  { transactionType: 'BAGIAN_SHU_INVESTASI', role: 'KREDIT_PENDAPATAN', accountKode: '4-1300' },
  { transactionType: 'BAGIAN_SHU_PENERIMAAN', role: 'KREDIT_PIUTANG', accountKode: '1-1220' },
];

/**
 * Standar akuntansi Kopku.
 *
 * RC-S39 — SAK EP adalah SATU-SATUNYA standar aktif. Anggota
 * `'SAK_EMKM'` dihapus dari tipe ini, sehingga compiler menolak setiap
 * kode baru yang mencoba memilihnya. Nilai legacy di database lama
 * dinormalisasi menjadi 'SAK_EP' oleh migrasi skema v56.
 */
export type StandarAkuntansi = 'SAK_EP';

/**
 * Standar akuntansi DEFAULT aplikasi (§9/§10/§29 permintaan pengguna).
 *
 * Setup awal TIDAK LAGI meminta pengguna memilih standar akuntansi —
 * aplikasi selalu memakai SAK EP. Konstanta ini adalah SATU-SATUNYA
 * tempat nilai default itu ditulis, supaya tidak ada literal 'SAK_EP'
 * yang tersebar dan berpotensi menyimpang (setup baru, restore,
 * konfigurasi lama yang kosong — semuanya membaca dari sini).
 *
 * Nilainya memakai anggota enum `StandarAkuntansi` YANG SUDAH ADA —
 * bukan string baru — dan CHECK constraint kolom
 * `koperasi.standar_akuntansi` kini hanya menerima 'SAK_EP' (skema v56).
 *
 * KOMPATIBILITAS: nilai ini HANYA dipakai kalau standar belum terisi.
 * Database existing yang standarnya sudah tersimpan (termasuk nilai legacy
 * dari wizard versi lama) TETAP dipertahankan apa adanya — lihat
 * `SetupService.getStandarAkuntansiEfektif()`.
 */
export const STANDAR_AKUNTANSI_DEFAULT: StandarAkuntansi = 'SAK_EP';

/**
 * Nama standar akuntansi sebagaimana DITAMPILKAN kepada pengguna dan
 * dicetak di laporan.
 *
 * RC-S39 follow-up. Sebelumnya narasi CALK dibangun dengan
 * `namaStandar.replace('_', ' ')` atas nilai yang dibaca langsung dari
 * kolom `koperasi.standar_akuntansi`. Artinya laporan mencetak APA PUN
 * yang kebetulan tersimpan di sana — instalasi lama dengan 'SAK_EMKM'
 * menghasilkan kalimat "disusun berdasarkan SAK EMKM" di Catatan atas
 * Laporan Keuangan. Itu keluaran laporan yang aktif dan salah, bukan
 * sekadar label internal.
 *
 * Sekarang teksnya konstan. Tidak ada nilai database yang dapat
 * mengubah nama standar di laporan.
 */
export const NAMA_STANDAR_AKUNTANSI = 'SAK Entitas Privat (SAK EP)';

/**
/**
 * Istilah penyajian laporan SAK EP.
 *
 * RC-S39 — blok `SAK_EMKM` dihapus. Bersamanya ikut dihapus
 * `wajibArusKas` dan `wajibCALK`: audit menunjukkan KEDUA field itu
 * tidak pernah dibaca di mana pun dalam aplikasi. Satu-satunya nilai
 * yang benar-benar dipakai adalah `labelLabaRugi`
 * (`LabaRugiScreen.tsx`).
 *
 * Field mati berbahaya justru karena terlihat berarti: `wajibArusKas:
 * false` pada blok EMKM tampak seperti "laporan arus kas dimatikan",
 * padahal tidak pernah ada kode yang membacanya. Mempertahankannya
 * hanya mengundang orang mengira ada perilaku yang sebenarnya tidak
 * ada.
 */
export const ACCOUNTING_POLICY: Record<
  StandarAkuntansi,
  { labelLabaRugi: string; labelPosisiKeuangan: string }
> = {
  SAK_EP: {
    // Poin 17 — judul tampilan (layar, export, header PDF). Rute internal tetap `LabaRugi`.
    labelLabaRugi: 'Laporan Perhitungan Hasil Usaha',
    labelPosisiKeuangan: 'Laporan Posisi Keuangan',
  },
};

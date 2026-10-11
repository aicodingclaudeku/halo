/**
 * Klasifikasi aktivitas kas (Operasi/Investasi/Pendanaan) untuk Laporan
 * Arus Kas (PRD §27). Diklasifikasikan berdasarkan `sumber_transaksi`
 * pada tabel `journal` — taksonomi yang SAMA dengan yang dipakai
 * AccountMapping.ts — BUKAN berdasarkan nama akun, supaya konsisten
 * dengan prinsip PRD §18 ("laporan tidak boleh bergantung pada nama
 * akun secara hard-code").
 *
 * Untuk koperasi simpan pinjam: pemberian & penerimaan pinjaman anggota
 * adalah aktivitas usaha inti (OPERASI), simpanan anggota adalah
 * pendanaan modal koperasi (PENDANAAN).
 */

export type AktivitasKas = 'OPERASI' | 'INVESTASI' | 'PENDANAAN';

/**
 * GAP-CASHFLOW — kategori LENGKAP untuk `sumber_transaksi`.
 *
 * `NON_KAS` bukan "kategori keempat arus kas"; ia adalah pernyataan
 * eksplisit bahwa jenis transaksi tersebut MEMANG TIDAK PERNAH
 * menyentuh akun Kas/Bank (akrual, penyusutan, penyisihan, amortisasi,
 * reklasifikasi). Dulu jenis-jenis ini didaftarkan sebagai 'OPERASI'
 * "untuk jaga-jaga" — yang membuat mustahil membedakan
 * "sudah dipikirkan dan memang non-kas" dari "kebetulan jatuh ke
 * default OPERASI".
 */
export type KlasifikasiArusKas = AktivitasKas | 'NON_KAS';

/**
 * Dilempar ketika sebuah `sumber_transaksi` belum punya klasifikasi.
 *
 * WHY melempar, bukan diam-diam OPERASI:
 * Fallback lama membuat Laporan Arus Kas tetap terlihat "balance" —
 * totalnya benar — tetapi transaksi INVESTASI/PENDANAAN masuk ke kolom
 * OPERASI tanpa jejak apa pun. Laporan yang salah kolom tetapi
 * seimbang jauh lebih berbahaya daripada laporan yang menolak dibuat,
 * karena tidak ada yang akan menyadarinya.
 */
export class UnknownCashFlowClassificationError extends Error {
  constructor(sumberTransaksi: string) {
    super(
      `Jenis transaksi "${sumberTransaksi}" belum memiliki klasifikasi arus kas ` +
        `(OPERASI / INVESTASI / PENDANAAN / NON_KAS). Laporan Arus Kas tidak dapat dibuat ` +
        `sampai klasifikasinya ditambahkan di src/accounting/CashFlowClassification.ts. ` +
        `Klasifikasi TIDAK boleh ditebak — salah kolom pada laporan arus kas tidak terlihat ` +
        `karena totalnya tetap seimbang.`
    );
    this.name = 'UnknownCashFlowClassificationError';
  }
}

/**
 * Dilempar ketika sebuah jenis transaksi yang dinyatakan NON_KAS
 * ternyata muncul pada baris jurnal akun Kas/Bank. Itu berarti salah
 * satu dari dua hal SALAH: klasifikasinya, atau jurnalnya. Keduanya
 * harus diperiksa manusia, bukan ditebak laporan.
 */
export class NonCashSourceOnCashLineError extends Error {
  constructor(sumberTransaksi: string) {
    super(
      `Jenis transaksi "${sumberTransaksi}" diklasifikasikan NON_KAS tetapi ditemukan pada ` +
        `baris jurnal akun Kas/Bank. Periksa klasifikasi di CashFlowClassification.ts atau ` +
        `jurnal yang membukukannya — salah satunya keliru.`
    );
    this.name = 'NonCashSourceOnCashLineError';
  }
}

export const CASH_FLOW_CLASSIFICATION: Record<string, KlasifikasiArusKas> = {
  SIMPANAN_POKOK: 'PENDANAAN',
  SIMPANAN_WAJIB: 'PENDANAAN',
  // DIUBAH RC-S104 — SIMPANAN SUKARELA & BERJANGKA: PENDANAAN -> OPERASI.
  //
  // Simpanan pokok & wajib di atas adalah MODAL anggota, jadi tetap
  // PENDANAAN. Simpanan sukarela dan simpanan berjangka berbeda
  // sifatnya: itulah dana yang diputar koperasi menjadi pinjaman dan
  // menghasilkan jasa — yaitu "aktivitas penghasil utama pendapatan"
  // pada definisi butir 5.7(4)(d) Juklat SOM No. 3/2025. Contoh resmi
  // pada naskah yang sama (hlm. 73) juga menempatkan "Penerimaan
  // simpanan anggota dan koperasi lain" pada KEGIATAN OPERASI, dan
  // hanya simpanan pokok/wajib pada KEGIATAN PENDANAAN sebagai
  // "Penambahan modal"/"Pengurangan modal".
  //
  // Definisi dan contoh resminya SEPAKAT di sini — berbeda dari kasus
  // utang bank/pihak lain, yang contohnya bertentangan dengan
  // definisinya sendiri dan karena itu TIDAK ikut dipindah (lihat
  // UTANG_BANK di bawah & CATATAN_PENYAJIAN di ArusKasJuklat.ts).
  //
  // Yang berubah HANYA kolom penyajian: kas awal, kas akhir, dan
  // rekonsiliasinya tidak tersentuh sama sekali.
  SIMPANAN_SUKARELA: 'OPERASI',
  SIMPANAN_BERJANGKA: 'OPERASI',
  // Pencairan simpanan berjangka: Dr liabilitas, Cr Kas -> cerminan
  // dari setorannya, jadi mengikuti ke OPERASI.
  SIMPANAN_BERJANGKA_PENCAIRAN: 'OPERASI',
  // Pencairan DINI (S21) — secara arus kas identik dengan pencairan
  // normal: koperasi mengembalikan dana anggota, jadi PENDANAAN.
  //
  // Penalti & biaya administrasi TIDAK dipisahkan menjadi arus OPERASI
  // tersendiri karena keduanya tidak pernah menjadi pergerakan kas
  // sendiri — keduanya diselesaikan dengan MEMOTONG pembayaran, jadi
  // yang benar-benar bergerak di kas hanyalah satu angka: net payout.
  // Memecahnya menjadi dua arus akan menciptakan kas masuk yang tidak
  // pernah terjadi. Pengakuan pendapatannya tetap muncul utuh di Laba
  // Rugi lewat baris jurnalnya masing-masing.
  SIMPANAN_BERJANGKA_PENCAIRAN_DINI: 'OPERASI',
  PENCAIRAN_PINJAMAN: 'OPERASI',
  ANGSURAN_POKOK: 'OPERASI',
  ANGSURAN_JASA: 'OPERASI',
  ANGSURAN_DENDA: 'OPERASI',
  BIAYA_ADMIN_PINJAMAN: 'OPERASI',
  // Kas & Bank (Fase 7) — penerimaan/pengeluaran umum koperasi
  // dianggap OPERASI (sifatnya operasional harian, bukan investasi
  // aset tetap atau pendanaan modal). Transfer antar rekening SENGAJA
  // diberi kategori yang SAMA untuk kedua sisi (debit & kredit) —
  // karena keduanya sama besar & berlawanan tanda, transfer otomatis
  // netral (net 0) terhadap total arus kas, sesuai prinsip akuntansi
  // (perpindahan uang antar kas/bank milik sendiri bukan arus kas
  // masuk/keluar yang sesungguhnya).
  KAS_PENERIMAAN_LAIN: 'OPERASI',
  KAS_PENGELUARAN_LAIN: 'OPERASI',
  BANK_PENERIMAAN_LAIN: 'OPERASI',
  BANK_PENGELUARAN_LAIN: 'OPERASI',
  TRANSFER_BANK: 'OPERASI',
  SALDO_AWAL_REKENING: 'PENDANAAN',
  // Investasi (penyertaan pada unit usaha/koperasi lain) — aktivitas
  // INVESTASI yang sesungguhnya di Laporan Arus Kas (SAK), berbeda
  // dari operasional harian. Dua jenis (Bagian E) sama-sama aktivitas
  // investasi, cuma akun GL-nya yang beda (lihat AccountMapping).
  INVESTASI_UNIT_USAHA: 'INVESTASI',
  INVESTASI_KOPERASI_LAIN: 'INVESTASI',
  // ============================================================
  // GAP-CASHFLOW (RC-S17) — LIMA jenis investasi yang HILANG dari peta.
  // ============================================================
  // `InvestasiService` TIDAK menulis literal string; ia memakai
  // `JENIS_TRANSACTION_TYPE[input.jenisInvestasi]` (Record konstanta),
  // sehingga pemindai pada CashFlowExhaustiveClassification.test.ts —
  // yang hanya mencocokkan literal string pada properti sumber transaksi
  // — tidak pernah melihatnya. Peta ini cuma punya dua dari ENAM nilai
  // yang benar-benar diproduksi Record tersebut; lima sisanya di bawah
  // ini akan menjatuhkan getArusKas() dengan
  // UnknownCashFlowClassificationError begitu koperasi mencatat
  // investasi selain KOPERASI_LAIN.
  //
  // Jurnalnya (InvestasiService.catatInvestasi & koreksinya) identik
  // untuk keenam jenis: Dr akun investasi (1-1620..1-1660) / Cr Kas atau
  // Bank — penempatan dana ke entitas/aset lain, kas benar-benar keluar.
  // Sama persis dengan INVESTASI_KOPERASI_LAIN & INVESTASI_UNIT_USAHA di
  // atas, jadi klasifikasinya SAMA: INVESTASI. Akun GL-nya saja yang
  // berbeda per jenis (lihat defaultCOA.ts), bukan sifat arus kasnya.
  INVESTASI_USAHA_LAIN: 'INVESTASI',
  INVESTASI_TABUNGAN_BANK_UMUM: 'INVESTASI',
  INVESTASI_GIRO_BANK_UMUM: 'INVESTASI',
  INVESTASI_DEPOSITO_BANK_UMUM: 'INVESTASI',
  INVESTASI_PROPERTI_INVESTASI: 'INVESTASI',

  // ============================================================
  // BUG FIX (Prioritas 6/P — audit Arus Kas): sumber_transaksi berikut
  // SEBELUMNYA TIDAK ADA di peta ini sama sekali. `classifyTransaction()`
  // dipanggil dari `getArusKas()` TANPA fallbackKategori (lihat
  // getArusKas di FinancialReports.ts), sehingga SETIAP transaksi kas
  // dari sumber_transaksi yang tidak terdaftar otomatis jatuh ke
  // fallback TERAKHIR: 'OPERASI' — walau sebagian di antaranya secara
  // akuntansi SEHARUSNYA aktivitas INVESTASI atau PENDANAAN. Ini
  // membuat Laporan Arus Kas tetap "balance"/terekonsiliasi (karena
  // totalnya tidak berubah, cuma SALAH KOLOM) tapi klasifikasi
  // Operasi/Investasi/Pendanaan-nya keliru — persis kelas bug
  // "REPORTING GAP" yang diminta ditelusuri.
  // ============================================================

  // Perolehan aset tetap dibayar tunai — aktivitas INVESTASI klasik.
  ASET_TETAP: 'INVESTASI',
  // Perolehan aset tak berwujud (Prioritas 8/J) — sama sifatnya dengan
  // aset tetap: pengeluaran untuk aset berumur panjang, aktivitas
  // INVESTASI, bukan operasi harian.
  ASET_TAK_BERWUJUD: 'INVESTASI',
  // RAK dicatat sebagai ASET (penempatan dana ke kantor/unit lain,
  // pola SAMA dengan InvestasiService — lihat komentar RAKService.ts:
  // "sama persis pola InvestasiService.catatInvestasi") -> INVESTASI,
  // konsisten dengan INVESTASI_KOPERASI_LAIN di atas.
  RAK: 'INVESTASI',

  // Pencairan/pembayaran utang (bank/pihak lain/usaha) — pinjaman yang
  // DITERIMA/DIBAYAR koperasi (bukan piutang yang disalurkan ke
  // anggota) adalah aktivitas PENDANAAN, bukan operasi.
  // RC-S104 — TETAP PENDANAAN, dengan sengaja. Contoh pada Juklat
  // No. 3/2025 menaruh utang kepada pihak lain di Kegiatan Operasi,
  // tetapi butir 5.7(4)(f) pada naskah yang SAMA mendefinisikan
  // aktivitas pendanaan sebagai "aktivitas yang mengakibatkan
  // perubahan dalam jumlah serta komposisi modal dan PINJAMAN
  // perusahaan" — yang persis menggambarkan utang koperasi ini.
  // Definisi dipakai, contohnya tidak; perbedaannya dinyatakan terbuka
  // di CATATAN_PENYAJIAN, bukan didiamkan.
  UTANG_BANK: 'PENDANAAN',
  UTANG_PIHAK_LAIN: 'PENDANAAN',
  UTANG_USAHA: 'PENDANAAN',
  // Setoran modal tunai anggota — sama seperti Simpanan Pokok/Wajib,
  // ini pendanaan modal koperasi.
  MODAL_UANG: 'PENDANAAN',
  MODAL_BARANG: 'PENDANAAN', // in-kind, biasanya tidak menyentuh kas — didaftarkan untuk konsistensi & jaga-jaga.
  // Pengembalian simpanan anggota yang keluar — pola sama dengan
  // Simpanan Pokok/Wajib/Sukarela (semuanya PENDANAAN), hanya arah
  // kasnya terbalik (keluar, bukan masuk).
  KELUAR_ANGGOTA: 'PENDANAAN',
  // Saldo awal akun generik (SaldoAwalAkunService, Bagian H) — bukan
  // aktivitas periode berjalan yang sesungguhnya, tapi konsisten
  // dengan SALDO_AWAL_REKENING di atas (sudah PENDANAAN) supaya semua
  // jenis "saldo awal" diperlakukan sama.
  SALDO_AWAL_AKUN: 'PENDANAAN',
  // Phase 18: koreksi saldo awal (jarang menyentuh kas/bank — hanya
  // kalau akun yang dikoreksi kebetulan akun kas/bank itu sendiri) —
  // diklasifikasikan sama dengan SALDO_AWAL_AKUN (PENDANAAN), bukan
  // dibiarkan jatuh ke default OPERASI (pola bug yang sama seperti
  // yang diperbaiki Prioritas 6/P).
  KOREKSI_SALDO_AWAL: 'PENDANAAN',
  // Distribusi SHU — reklasifikasi ekuitas/liabilitas murni, TIDAK
  // PERNAH menyentuh akun Kas/Bank secara langsung (lihat
  // ShuService.bagikanSHU), jadi baris ini secara praktik tidak akan
  // pernah muncul di query getArusKas (yang hanya membaca journal_entry
  // pada akun Kas/Bank) — didaftarkan eksplisit sebagai PENDANAAN untuk
  // jaga-jaga/dokumentasi, bukan karena pernah teramati salah.
  SHU_DISTRIBUSI: 'NON_KAS',
  // Bunga simpanan sukarela dikreditkan ke saldo simpanan (dan Utang PPh):
  // tidak ada kas yang bergerak.
  SIMPANAN_SUKARELA_BUNGA: 'NON_KAS',
  // Biaya dibayar dimuka & pendapatan diterima dimuka — pembayaran/
  // penerimaan tunainya bersifat operasional (bukan investasi aset
  // tetap atau pendanaan modal), begitu juga pengakuan periodiknya
  // (walau keduanya tidak menyentuh kas sama sekali — non-kas).
  BIAYA_DIBAYAR_DIMUKA: 'OPERASI',
  PENGAKUAN_BIAYA_DIMUKA: 'NON_KAS',
  PENDAPATAN_DITERIMA_DIMUKA: 'OPERASI',
  PENGAKUAN_PENDAPATAN_DIMUKA: 'NON_KAS',
  // Non-kas (tidak pernah menyentuh akun Kas/Bank) — didaftarkan
  // eksplisit sebagai OPERASI untuk kelengkapan dokumentasi, bukan
  // karena pernah teramati salah (getArusKas hanya membaca baris kas/
  // bank, jadi baris-baris ini tidak akan pernah muncul di sana).
  PENYUSUTAN_ASET: 'NON_KAS',
  PENYISIHAN_PIUTANG: 'NON_KAS',
  PENGHAPUSAN_PIUTANG: 'NON_KAS',
  // Amortisasi aset tak berwujud — non-kas (tidak menyentuh Kas/Bank
  // sama sekali, sama seperti PENYUSUTAN_ASET di atas).
  AMORTISASI_ASET_TAK_BERWUJUD: 'NON_KAS',
  // RC-S88 — penyesuaian nilai wajar properti investasi (Dr/Cr 1-1665 vs
  // 4-2100/5-5000) & revaluasi aset tetap (Dr/Cr 1-1520 vs 3-6000/4-2200/
  // 5-5100). Pengukuran ulang murni — tidak pernah menyentuh Kas/Bank.
  PENYESUAIAN_NILAI_WAJAR: 'NON_KAS',
  REVALUASI_ASET_TETAP: 'NON_KAS',
  // Akrual bunga utang (Prioritas 10/L) — non-kas (tidak menyentuh
  // Kas/Bank sama sekali; pelunasannya lewat sumber_transaksi
  // UTANG_BANK/UTANG_PIHAK_LAIN yang sudah PENDANAAN di atas).
  UTANG_BUNGA: 'NON_KAS',
  // Akrual bunga simpanan berjangka: Dr Beban, Cr Utang Bunga — tidak
  // ada kas yang bergerak. Pola SAMA dengan UTANG_BUNGA di atas.
  // Arus kasnya baru muncul saat PENCAIRAN (klasifikasi PENDANAAN).
  SIMPANAN_BERJANGKA_BUNGA_AKRUAL: 'NON_KAS',

  // ============================================================
  // GAP-CASHFLOW (Sesi 4) — ENAM sumber transaksi PRODUKSI yang
  // sebelumnya TIDAK ADA di peta ini sama sekali, sehingga semuanya
  // jatuh ke fallback diam-diam 'OPERASI'.
  // ============================================================

  // Pemberian pinjaman kepada koperasi/pihak lain: Dr Piutang / Cr Kas.
  // Ini ARUS KAS KELUAR SUNGGUHAN yang selama ini masuk kolom OPERASI.
  // Secara ekonomi identik dengan INVESTASI_KOPERASI_LAIN (penempatan
  // dana ke entitas lain), jadi diklasifikasikan sama: INVESTASI.
  // LEGACY (fitur dihapus di RC-S70.2) — klasifikasi tetap ada supaya
  // jurnal historis dengan sumber ini tidak jatuh ke kategori tak dikenal.
  PEMBERIAN_PINJAMAN_KOPERASI: 'INVESTASI',

  // Input data awal simpanan anggota (migrasi pembukuan manual).
  // Pola sama dengan SIMPANAN_POKOK/WAJIB/SUKARELA dan SALDO_AWAL_AKUN.
  SIMPANAN_DATA_AWAL: 'PENDANAAN',

  // Akrual jasa pinjaman: Dr Piutang Jasa / Pendapatan Diterima Dimuka,
  // Cr Pendapatan Jasa. Tidak pernah menyentuh Kas/Bank.
  AKRUAL_JASA_PINJAMAN: 'NON_KAS',

  // Amortisasi fee integral (EIR): Dr Pendapatan Diterima Dimuka /
  // Cr Pendapatan. Tidak pernah menyentuh Kas/Bank.
  EIR_FEE_AMORTIZATION: 'NON_KAS',

  // ============================================================
  // RC-S54 TAHAP 16 — ITEM #21: BAGIAN SHU DARI INVESTASI.
  // ============================================================
  // Pengakuan hak (BagianShuService.catatBagianShuInvestasi): Dr 1-1220 /
  // Cr 4-1300 — tidak ada baris Kas/Bank sama sekali -> NON_KAS, pola sama
  // dengan AKRUAL_JASA_PINJAMAN / UTANG_BUNGA.
  BAGIAN_SHU_INVESTASI: 'NON_KAS',
  // Penerimaan kas (catatPenerimaanBagianShu): Dr Kas/Bank / Cr 1-1220.
  // OPERASI, karena penerimaan kas atas pendapatan kelompok LHU yang SAMA
  // (HASIL_INVESTASI: 4-1500 bunga, 4-1600 sewa, 4-1700 bagi hasil) sudah
  // diklasifikasikan OPERASI oleh proyek ini: dicatat lewat menu Pendapatan
  // Lainnya -> KAS_PENERIMAAN_LAIN / BANK_PENERIMAAN_LAIN -> OPERASI. Arus kas yang
  // identik secara ekonomi tidak boleh berpindah kolom hanya karena jalur
  // pencatatannya (akrual-lalu-terima vs langsung). Klasifikasi arus kas
  // di sini berbasis sumber transaksi (ATURAN_BISNIS §13), sehingga INVESTASI
  // untuk jalur ini akan memecah satu jenis penerimaan ke dua kolom.
  // Penempatan/pencairan POKOK investasi tetap INVESTASI (INVESTASI_*).
  BAGIAN_SHU_PENERIMAAN: 'OPERASI',

  // RC-S54 TAHAP 16 — ITEM #20: hasil pelepasan investasi (Dr Kas/Bank).
  // INVESTASI — pasangan keluar dari penempatan INVESTASI_* (INVESTASI).
  // Pelepasan tanpa hasil (H = 0) tidak menyentuh kas, tidak diklasifikasi.
  PELEPASAN_INVESTASI: 'INVESTASI',
  // RC-S54 TAHAP 16 GAP 6: hasil pelepasan aset tetap (Dr Kas/Bank) = INVESTASI
  // (pasangan pembelian aset BELI_ASET/INVESTASI). H = 0 tidak menyentuh kas.
  PELEPASAN_ASET_TETAP: 'INVESTASI',
  // Pengembalian RAKU (pokok RAK dari unit usaha): Dr Kas/Bank /
  // Cr 1-1800 (RAKUService lewat KasBankService.catatPemasukan, jalur
  // khusus). INVESTASI — pasangan masuk dari penyaluran `RAK` (INVESTASI),
  // pola yang sama dengan PELEPASAN_INVESTASI terhadap INVESTASI_*.
  RAK_PENGEMBALIAN_KAS: 'INVESTASI',
  RAK_PENGEMBALIAN_BANK: 'INVESTASI',

  // ============================================================
  // RC-S54 TAHAP 16 — GAP 4: EMPAT SUMBER PRODUKSI YANG BELUM TERKLASIFIKASI.
  // ============================================================
  // Diaudit dari jurnal yang benar-benar dibuat service-nya, bukan dari nama.
  //
  // PenyusutanPropertiInvestasiService: Dr 5-1300 Beban Penyusutan / Cr 1-1670
  // Akumulasi Penyusutan PI — tidak ada baris Kas/Bank. Pola PENYUSUTAN_ASET.
  PENYUSUTAN_PROPERTI_INVESTASI: 'NON_KAS',
  // SimpananBerjangkaLifecycleService (TRANSAKSI_BUNGA_TRANSFER): Dr utang bunga
  // simpanan berjangka / Cr simpanan sukarela anggota — pemindahan antar
  // liabilitas, tanpa Kas/Bank. Pola SIMPANAN_BERJANGKA_BUNGA_AKRUAL.
  SIMPANAN_BERJANGKA_BUNGA_TRANSFER: 'NON_KAS',
  // ImbalanKerjaService.bayarImbalanKerja: Dr Utang Imbalan Kerja / Cr Kas/Bank —
  // pelunasan kas atas beban karyawan yang diakui lewat UTANG_IMBALAN_KERJA
  // (NON_KAS). Pembayaran kas beban operasional = OPERASI.
  UTANG_IMBALAN_KERJA_BAYAR: 'OPERASI',
  // CashReconciliationService (perlakuan PERLU_JURNAL): Dr/Cr rekening Kas/Bank
  // yang direkonsiliasi vs akun lawan pilihan pengguna; penyebab: biaya admin
  // bank, jasa giro, selisih pencatatan/fisik, lainnya. Strukturnya sama dengan
  // KAS_/BANK_PENERIMAAN_LAIN & KAS_/BANK_PENGELUARAN_LAIN (akun lawan dipilih
  // pengguna) yang sudah OPERASI; seluruh penyebab yang didukung bersifat
  // operasional. Klasifikasi berbasis sumber (ATURAN_BISNIS §13).
  REKONSILIASI_KAS_BANK: 'OPERASI',

  // Penurunan nilai investasi — estimasi akuntansi, bukan pergerakan kas.
  IMPAIRMENT_INVESTASI: 'NON_KAS',

  // Akrual imbalan kerja: Dr Beban / Cr Utang Imbalan Kerja.
  // Pembayarannya nanti lewat sumber transaksi kas/bank tersendiri.
  UTANG_IMBALAN_KERJA: 'NON_KAS',
  // RC-S84 — pengakuan pajak (PPh Final 0,5% masa / PPh Badan akhir tahun):
  // Dr Beban Pajak / Kr Utang PPh (dan Kr Pajak Dibayar Dimuka untuk kredit
  // PPh 25). Murni akrual, TIDAK pernah menyentuh Kas/Bank — pembayarannya
  // lewat Setor Pajak (bayarKewajibanCoa -> KAS/BANK_PENGELUARAN_LAIN, OPERASI).
  PAJAK_PENGAKUAN: 'NON_KAS',

  // ============================================================
  // KOMPATIBILITAS DATA HISTORIS (RC-S17) — BUKAN sumber kanonik.
  // ============================================================
  // `ANGSURAN_PINJAMAN` TIDAK diproduksi oleh satu baris pun source
  // RC-S16 (diverifikasi: `grep -rn "ANGSURAN_PINJAMAN" src app` nihil).
  // Sumber KANONIK untuk pembayaran angsuran anggota adalah
  // `ANGSURAN_POKOK` (PinjamanService.bayarAngsuran & jalur
  // pelunasannya) — satu jurnal GABUNGAN: Dr Kas/Bank sebesar
  // pokok+jasa+denda, Cr Piutang Pokok, Cr Piutang Jasa / Pendapatan
  // Jasa / Pendapatan Diterima Dimuka, Cr Pendapatan Denda.
  //
  // Nilai ini hanya bisa berasal dari basis data yang ditulis versi
  // aplikasi TERDAHULU (atau hasil restore backup lama). Karena
  // `getArusKas()` HANYA membaca baris jurnal pada akun Kas/Bank,
  // munculnya nilai ini di sana MEMBUKTIKAN jurnalnya memang
  // menggerakkan Kas/Bank — jadi NON_KAS mustahil benar untuknya.
  //
  // Klasifikasinya mengikuti KEBIJAKAN KOPKU yang sudah berlaku, bukan
  // tebakan textbook: seluruh arus pinjaman ANGGOTA adalah usaha inti
  // koperasi simpan pinjam dan sudah diklasifikasikan OPERASI di peta
  // ini (PENCAIRAN_PINJAMAN, ANGSURAN_POKOK, ANGSURAN_JASA,
  // ANGSURAN_DENDA). Konsistensi itu yang dipertahankan di sini.
  //
  // Didaftarkan sebagai ALIAS EKSPLISIT — BUKAN alias baru yang dibuat
  // sekarang, melainkan pengakuan atas nilai yang sudah terlanjur ada
  // di database produksi. Polanya SAMA PERSIS dengan
  // `INVESTASI_UNIT_USAHA` di atas: jenis yang tidak bisa dibuat lagi
  // tetapi jurnal historisnya sah dan wajib tetap terbaca laporan.
  // Tidak ada source baru yang boleh menulis nilai ini.
  ANGSURAN_PINJAMAN: 'OPERASI',
};

/**
 * Klasifikasi ekshaustif untuk SATU sumber transaksi.
 * Melempar bila tidak terdaftar — tidak ada tebakan.
 */
export function classifyTransactionSource(sumberTransaksi: string): KlasifikasiArusKas {
  const hasil = CASH_FLOW_CLASSIFICATION[sumberTransaksi];
  if (!hasil) throw new UnknownCashFlowClassificationError(sumberTransaksi);
  return hasil;
}

/** Daftar seluruh sumber transaksi yang sudah punya klasifikasi. */
export function daftarSumberTransaksiTerklasifikasi(): string[] {
  return Object.keys(CASH_FLOW_CLASSIFICATION).sort();
}

/**
 * Fallback untuk transaksi kas manual (KAS_MANUAL, BANK_MANUAL, dll. —
 * belum ada modulnya di fase ini) berdasarkan kategori akun lawan,
 * dipakai jika sumber_transaksi tidak ada di peta di atas.
 */
export function classifyByAccountKategori(kategori: string): AktivitasKas {
  if (kategori === 'PENDAPATAN' || kategori === 'BEBAN') return 'OPERASI';
  if (kategori === 'EKUITAS' || kategori === 'LIABILITAS') return 'PENDANAAN';
  return 'INVESTASI'; // ASET non-kas lainnya (mis. aset tetap) dianggap investasi
}

/**
 * Klasifikasi untuk baris jurnal yang BENAR-BENAR menyentuh Kas/Bank
 * (dipanggil dari `getArusKas`).
 *
 * PERUBAHAN GAP-CASHFLOW: fallback diam-diam `return 'OPERASI'` DIHAPUS.
 * Sumber transaksi yang tidak terdaftar sekarang melempar
 * `UnknownCashFlowClassificationError`, dan sumber yang dinyatakan
 * NON_KAS tetapi muncul di baris kas melempar
 * `NonCashSourceOnCashLineError`.
 *
 * `fallbackKategori` (kategori akun lawan) TETAP dipertahankan sebagai
 * jalan keluar yang EKSPLISIT untuk pemanggil yang memang punya
 * informasi tersebut — itu bukan tebakan, melainkan aturan
 * `classifyByAccountKategori` yang terdokumentasi.
 */
export function classifyTransaction(sumberTransaksi: string, fallbackKategori?: string): AktivitasKas {
  const hasil = CASH_FLOW_CLASSIFICATION[sumberTransaksi];
  if (hasil === 'NON_KAS') {
    throw new NonCashSourceOnCashLineError(sumberTransaksi);
  }
  if (hasil) return hasil;
  if (fallbackKategori) return classifyByAccountKategori(fallbackKategori);
  throw new UnknownCashFlowClassificationError(sumberTransaksi);
}

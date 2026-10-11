/**
 * RC-S128 — SNAPSHOT SCHEMA v78 (baseline RC-S127), HANYA untuk test migrasi v79.
 * Salinan apa adanya; jangan diubah. Bukan bagian aplikasi.
 */
/**
 * SKEMA DATABASE SQLITE — KOPERASI FINANCE
 * ------------------------------------------------------------
 * Semua data utama disimpan di sini (PRD §3).
 * SecureStore HANYA untuk PIN/secret/session (lihat security/).
 *
 * Catatan uang (PRD §40): semua nominal disimpan sebagai INTEGER
 * (satuan Rupiah penuh, tanpa desimal/floating point).
 */

// RC-S54 TAHAP 16 (#20): v66 = TANPA DDL. Kenaikan versi hanya memicu blok
// self-heal COA/mapping generik di runMigrations untuk perangkat v65 existing:
// akun 5-2160 Kerugian Pelepasan Investasi + mapping PELEPASAN_INVESTASI
// (KREDIT_LABA -> 4-1800, DEBIT_RUGI -> 5-2160). Lihat db.ts blok `< 66`.
// RC-S54 TAHAP 16 GAP 6: v67 = TANPA DDL. Self-heal akun 5-2170 Kerugian Pelepasan Aset
// Tetap + mapping PELEPASAN_ASET_TETAP (KREDIT_LABA -> 4-1800, DEBIT_RUGI -> 5-2170).
// RC-S54 POST-CLOSURE #14: v68 = TANPA DDL. Self-heal 12 akun COA dengan kode
// persis yang diminta (1-220/1-230/1-240/1-250/1-660/1-661/4-1510/4-1520/
// 4-1530/4-1540/4-2100/5-5000). Tanpa mapping baru, tanpa perubahan jurnal.
// RC-S55 §9 — v69 = AUTOMATIC ACCRUAL BUNGA UTANG. Dua perubahan, keduanya
// ADITIF: (a) kolom `utang.basis_bunga` (NULL-able, 'TAHUNAN'|'BULANAN') —
// basis kontraktual suku bunga yang SELAMA INI TIDAK PERNAH DISIMPAN, dan
// (b) tabel `utang_bunga_akrual` sebagai subledger + defense terakhir
// idempotensi (UNIQUE utang+periode+tipe). TIDAK ADA backfill: baris lama
// tetap `basis_bunga IS NULL` dan karena itu berstatus MANUAL_REVIEW_REQUIRED
// (derived, bukan kolom baru — lihat UtangBungaAccrualService).
// RC-S88 — v73 = PENYESUAIAN NILAI WAJAR DAPAT DIPOSTING & REVALUASI ASET
// TETAP (OCI). Rebuild `penyesuaian_nilai_wajar`: kolom objek/aset_tetap_id,
// status DIPOSTING, pembagian laba-rugi/OCI, jejak posting. Akun & mapping
// baru (1-1520, 1-1665, 3-6000, 4-2200, 5-5100) lewat self-heal COA generik.
// v74 (RC-S100) — RIWAYAT IMPORT DATA AWAL: dua tabel BARU
// (`import_data_awal_riwayat`, `import_data_awal_log`). Migrasi aditif
// murni: tidak ada tabel/kolom lama yang diubah, tidak ada data yang
// ditulis ulang, dan instalasi lama hanya mendapat dua tabel kosong.
// RC-S98 — "Beban Perkoperasian" (5-1900) menjadi BARIS BAKU LHU sesuai
// Juklat SOM 3/2025 Lampiran 1 (bukan bagian "Jumlah beban usaha").
// TANPA MIGRASI & TANPA kenaikan versi: `getLHU()` mengenali akun itu
// dari KODE-nya sebelum `lhu_klasifikasi` dibaca, jadi nilai lama
// 'BEBAN_USAHA' pada database yang sudah terpasang tidak lagi
// berpengaruh, dan CHECK kolomnya tidak perlu diubah (lihat
// FinancialReports.LhuResult.bebanPerkoperasian).
export const SCHEMA_VERSION_V78 = 78;

export const CREATE_TABLES_SQL_V78 = `
PRAGMA foreign_keys = ON;

-- ============================================================
-- 1. KOPERASI (identitas & konfigurasi, PRD §4-6)
-- ============================================================
CREATE TABLE IF NOT EXISTS koperasi (
  id TEXT PRIMARY KEY,
  nama TEXT NOT NULL,
  -- v60: DIPERTAHANKAN sebagai kolom kompatibilitas. Kode lama
  -- (SetupService, FinancialReports, layar identitas) masih membacanya,
  -- dan menghapusnya akan memutus laporan yang sudah berjalan.
  -- nomor_ahu di bawah adalah sumber baca yang baru; keduanya ditulis
  -- SERENTAK oleh SetupService supaya mustahil divergen.
  nomor_badan_hukum TEXT,
  -- v60: Nomor Administrasi Hukum Umum (AHU).
  nomor_ahu TEXT,
  -- v60: Nomor Induk Koperasi (NIK KOPERASI) — BUKAN NIK perorangan.
  nomor_induk_koperasi TEXT,
  npwp TEXT,
  alamat TEXT,
  telepon TEXT,
  email TEXT,
  logo_uri TEXT,
  tanggal_berdiri TEXT,
  tahun_buku_aktif INTEGER NOT NULL,
  standar_akuntansi TEXT NOT NULL CHECK (standar_akuntansi IN ('SAK_EP')),
  setup_selesai INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================
-- 1b. MASTER DATA IDENTITAS KOPERASI (v60)
-- ============================================================
-- Empat master yang sebelumnya tidak punya tempat terstruktur.
-- SENGAJA relasional dan bukan JSON di dalam koperasi: fase
-- berikutnya (Imbalan Kerja, RAKU) perlu menunjuk baris-baris ini
-- lewat foreign key, dan foreign key ke dalam blob JSON tidak ada.
--
-- TIDAK ADA hard delete di seluruh master ini. Begitu sebuah baris
-- pernah dirujuk transaksi, menghapusnya akan meninggalkan referensi
-- yatim; yang dipakai adalah kolom status.

-- Personel koperasi — SATU tabel generik untuk lima jenis.
-- Lima tabel terpisah hanya akan menduplikasi kolom yang sama persis
-- dan memaksa setiap pembaca menyatukannya kembali.
CREATE TABLE IF NOT EXISTS koperasi_personel (
  id TEXT PRIMARY KEY,
  nama TEXT NOT NULL,
  jenis_kelamin TEXT CHECK (jenis_kelamin IN ('L','P')),
  jabatan TEXT,
  tanggal_mulai_jabatan TEXT,
  -- NULL = jabatan masih berjalan / tidak dibatasi waktu.
  tanggal_berakhir_jabatan TEXT,
  -- NIK PERORANGAN (KTP). Berbeda sama sekali dari
  -- koperasi.nomor_induk_koperasi.
  nik TEXT,
  nomor_telepon TEXT,
  alamat TEXT,
  jenis_personel TEXT NOT NULL CHECK (jenis_personel IN
    ('PENGURUS','PENGAWAS','PENGELOLA','KARYAWAN','PEKERJA')),
  -- v70 — ASAL ORANGNYA, bukan jenis jabatannya.
  --   ANGGOTA = orang ini anggota koperasi; anggota_id menunjuk barisnya.
  --   LUAR    = pihak luar; anggota_id WAJIB NULL.
  -- Default 'LUAR' dipilih untuk baris lama karena schema sebelum v70
  -- TIDAK menyimpan hubungan apa pun ke anggota: menandainya 'ANGGOTA'
  -- berarti mengarang relasi yang tidak pernah ada datanya.
  sumber_data TEXT NOT NULL DEFAULT 'LUAR' CHECK (sumber_data IN ('ANGGOTA','LUAR')),
  -- NULLABLE dan memang harus: pihak luar tidak punya baris anggota.
  -- Kolom identitas di atas (nama/nik/jenis_kelamin/nomor_telepon/alamat)
  -- TETAP diisi walau personel berasal dari anggota (lihat SNAPSHOT
  -- di KoperasiMasterService): perubahan master anggota tidak boleh
  -- diam-diam menulis ulang histori jabatan.
  anggota_id TEXT REFERENCES anggota(id),
  -- Pola INTEGER 0/1 mengikuti app_user.aktif & bank_account.aktif.
  status_aktif INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personel_jenis ON koperasi_personel(jenis_personel, status_aktif);
CREATE INDEX IF NOT EXISTS idx_personel_nama ON koperasi_personel(nama);
CREATE INDEX IF NOT EXISTS idx_personel_anggota ON koperasi_personel(anggota_id);

CREATE TABLE IF NOT EXISTS koperasi_perizinan (
  id TEXT PRIMARY KEY,
  nama_izin TEXT NOT NULL,
  nomor_izin TEXT,
  tanggal_terbit TEXT,
  berlaku_sampai TEXT,
  instansi_penerbit TEXT,
  status TEXT NOT NULL DEFAULT 'AKTIF' CHECK (status IN ('AKTIF','KEDALUWARSA','DICABUT')),
  catatan TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perizinan_status ON koperasi_perizinan(status);
CREATE INDEX IF NOT EXISTS idx_perizinan_berlaku ON koperasi_perizinan(berlaku_sampai);

-- Unit usaha. id di sini adalah id_unit_usaha yang akan dipakai
-- RAKU sebagai foreign key pada fase berikutnya — IMMUTABLE, tidak
-- pernah diturunkan dari nama usaha (nama boleh berubah).
CREATE TABLE IF NOT EXISTS koperasi_unit_usaha (
  id TEXT PRIMARY KEY,
  nama_usaha TEXT NOT NULL,
  jenis_usaha TEXT,
  alamat TEXT,
  status TEXT NOT NULL DEFAULT 'AKTIF' CHECK (status IN ('AKTIF','NONAKTIF')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unit_usaha_status ON koperasi_unit_usaha(status);

CREATE TABLE IF NOT EXISTS koperasi_peraturan_internal (
  id TEXT PRIMARY KEY,
  nama_dokumen TEXT NOT NULL,
  jenis_dokumen TEXT,
  nomor TEXT,
  yang_menetapkan TEXT,
  status TEXT NOT NULL DEFAULT 'BERLAKU' CHECK (status IN ('BERLAKU','DICABUT','DIGANTI')),
  catatan TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_peraturan_status ON koperasi_peraturan_internal(status);

-- ============================================================
-- 1c. IMBALAN KERJA & KELUAR ANGGOTA (v61)
-- ============================================================

-- Register imbalan kerja per PERSONEL dan per PERIODE.
--
-- Sebelum v61, imbalan kerja hanya berupa jurnal akrual lepas tanpa
-- penerima, tanpa periode, dan tanpa jejak pembayaran. Akibatnya
-- pertanyaan paling dasar tidak terjawab: honorarium bulan ini sudah
-- dibayar belum, dan kepada siapa.
--
-- UNIQUE(personel_id, period_key, jenis_imbalan) ADALAH mekanisme
-- idempotensinya. Tidak perlu kolom idempotency tambahan: satu orang,
-- satu periode, satu jenis imbalan hanya boleh punya SATU baris, dan
-- database yang menegakkannya.
CREATE TABLE IF NOT EXISTS imbalan_kerja (
  id TEXT PRIMARY KEY,
  personel_id TEXT NOT NULL REFERENCES koperasi_personel(id),
  period_key TEXT NOT NULL,
  jenis_imbalan TEXT NOT NULL DEFAULT 'HONORARIUM',
  -- Snapshot jenis & jabatan SAAT PENGAKUAN. Jabatan personel dapat
  -- berubah; bukti imbalan harus tetap menunjukkan jabatan yang berlaku
  -- ketika imbalan itu diakui.
  jenis_personel TEXT NOT NULL,
  jabatan TEXT,
  dasar_perhitungan INTEGER NOT NULL DEFAULT 0,
  nilai_imbalan INTEGER NOT NULL,
  tanggal_pengakuan TEXT NOT NULL,
  tanggal_jatuh_tempo TEXT NOT NULL,
  keterangan TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','PAID')),
  journal_id TEXT NOT NULL REFERENCES journal(id),
  journal_bayar_id TEXT REFERENCES journal(id),
  tanggal_pembayaran TEXT,
  sumber_dana TEXT CHECK (sumber_dana IN ('KAS','BANK')),
  bank_account_id TEXT REFERENCES bank_account(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_imbalan_identitas
  ON imbalan_kerja(personel_id, period_key, jenis_imbalan);
CREATE INDEX IF NOT EXISTS idx_imbalan_status ON imbalan_kerja(status, tanggal_jatuh_tempo);

-- Pengajuan keluar anggota dengan alur persetujuan.
--
-- Seluruh saldo DISIMPAN sebagai snapshot saat pengajuan dibuat, bukan
-- dihitung ulang saat pembayaran: nilai yang disetujui pengurus harus
-- sama persis dengan nilai yang dibayarkan. Kalau saldo bergerak di
-- antara persetujuan dan pembayaran, service menolak dan meminta
-- pengajuan disegarkan -- bukan diam-diam membayar angka lain.
--
-- Indeks unik parsial mencegah SATU anggota punya dua pengajuan yang
-- masih hidup, dan itulah yang membuat pembayaran ganda mustahil.
CREATE TABLE IF NOT EXISTS keluar_anggota (
  id TEXT PRIMARY KEY,
  anggota_id TEXT NOT NULL REFERENCES anggota(id),
  alasan_keluar TEXT NOT NULL CHECK (alasan_keluar IN
    ('MENGUNDURKAN_DIRI','DIBERHENTIKAN','MENINGGAL','LAINNYA')),
  tanggal_pengajuan TEXT NOT NULL,
  tanggal_efektif_keluar TEXT NOT NULL,
  saldo_simpanan_pokok INTEGER NOT NULL DEFAULT 0,
  saldo_simpanan_wajib INTEGER NOT NULL DEFAULT 0,
  saldo_simpanan_sukarela INTEGER NOT NULL DEFAULT 0,
  shu_hak_anggota INTEGER NOT NULL DEFAULT 0,
  total_hak INTEGER NOT NULL DEFAULT 0,
  saldo_pinjaman INTEGER NOT NULL DEFAULT 0,
  kewajiban_lain INTEGER NOT NULL DEFAULT 0,
  total_pengurang INTEGER NOT NULL DEFAULT 0,
  nilai_pengembalian INTEGER NOT NULL DEFAULT 0,
  sumber_pembayaran TEXT CHECK (sumber_pembayaran IN ('KAS','BANK')),
  bank_account_id TEXT REFERENCES bank_account(id),
  status_pengajuan TEXT NOT NULL DEFAULT 'DIAJUKAN' CHECK (status_pengajuan IN
    ('DIAJUKAN','DISETUJUI','DIBAYAR','DITOLAK')),
  diajukan_oleh TEXT NOT NULL,
  disetujui_oleh TEXT,
  tanggal_persetujuan TEXT,
  dibayar_oleh TEXT,
  tanggal_pembayaran TEXT,
  journal_id TEXT REFERENCES journal(id),
  keterangan TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_keluar_anggota_hidup
  ON keluar_anggota(anggota_id)
  WHERE status_pengajuan IN ('DIAJUKAN','DISETUJUI','DIBAYAR');
CREATE INDEX IF NOT EXISTS idx_keluar_anggota_status ON keluar_anggota(status_pengajuan);

-- Riwayat perubahan standar akuntansi (PRD §41) — wajib diaudit
CREATE TABLE IF NOT EXISTS standar_akuntansi_log (
  id TEXT PRIMARY KEY,
  standar_lama TEXT NOT NULL,
  standar_baru TEXT NOT NULL,
  tanggal_perubahan TEXT NOT NULL,
  backup_file TEXT,
  user_id TEXT NOT NULL,
  keterangan TEXT,
  created_at TEXT NOT NULL
);

-- ============================================================
-- 2. USER & ROLE (PRD §31-32)
-- ============================================================
CREATE TABLE IF NOT EXISTS app_user (
  id TEXT PRIMARY KEY,
  nama TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','PENGURUS','BENDAHARA','PETUGAS','ANGGOTA')),
  pin_hash TEXT NOT NULL,          -- hashed, never plaintext
  pin_salt TEXT NOT NULL,
  -- RC-S114: versi algoritma hash PIN. 1 = SHA-256 satu putaran
  -- (warisan, lemah); 2 = scrypt. Baris lama tetap bisa login dan
  -- dinaikkan diam-diam ke 2 pada login berikutnya yang berhasil.
  -- Lihat security/pinHash.ts.
  pin_hash_versi INTEGER NOT NULL DEFAULT 1,
  -- RC-S117: PASSWORD untuk MASUK, terpisah dari PIN yang hanya untuk
  -- membuka kunci aplikasi. Nullable karena baris hasil migrasi diisi
  -- belakangan (lihat migrasiV76) — bukan karena boleh kosong: setiap
  -- jalur pembuatan user mengisinya.
  password_hash TEXT,
  password_salt TEXT,
  password_hash_versi INTEGER NOT NULL DEFAULT 2,
  biometric_enabled INTEGER NOT NULL DEFAULT 0,
  aktif INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permission (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  resource TEXT NOT NULL,           -- e.g. 'pinjaman', 'jurnal', 'laporan'
  can_view INTEGER NOT NULL DEFAULT 0,
  can_create INTEGER NOT NULL DEFAULT 0,
  can_edit INTEGER NOT NULL DEFAULT 0,
  can_approve INTEGER NOT NULL DEFAULT 0,
  can_export INTEGER NOT NULL DEFAULT 0,
  UNIQUE(role, resource)
);

-- ============================================================
-- 3. ANGGOTA (PRD §7)
-- ============================================================
CREATE TABLE IF NOT EXISTS anggota (
  id TEXT PRIMARY KEY,
  nomor_anggota TEXT NOT NULL UNIQUE,
  nik TEXT UNIQUE,
  nama_lengkap TEXT NOT NULL,
  -- Permintaan pengguna §8: Jenis Kelamin, nullable (data anggota lama
  -- tanpa nilai TIDAK dianggap invalid — ditangani sebagai "belum
  -- diisi" di layer aplikasi, bukan default yang dipaksakan).
  jenis_kelamin TEXT CHECK (jenis_kelamin IN ('LAKI_LAKI','PEREMPUAN')),
  tempat_lahir TEXT,
  tanggal_lahir TEXT,
  alamat TEXT,
  nomor_hp TEXT,
  pekerjaan TEXT,
  tanggal_bergabung TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('AKTIF','TIDAK_AKTIF','KELUAR','MENINGGAL')) DEFAULT 'AKTIF',
  foto_uri TEXT,
  catatan TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anggota_nama ON anggota(nama_lengkap);
CREATE INDEX IF NOT EXISTS idx_anggota_nik ON anggota(nik);
CREATE INDEX IF NOT EXISTS idx_anggota_status ON anggota(status);

-- ============================================================
-- 4. CHART OF ACCOUNTS — configurable (PRD §18)
-- ============================================================
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  kode TEXT NOT NULL UNIQUE,
  nama TEXT NOT NULL,
  kategori TEXT NOT NULL CHECK (kategori IN ('ASET','LIABILITAS','EKUITAS','PENDAPATAN','BEBAN')),
  sub_kategori TEXT,
  parent_id TEXT REFERENCES account(id),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DEBIT','KREDIT')),
  is_active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,   -- akun inti yang dipakai account_mapping
  -- Revisi LHU (Laporan Hasil Usaha): klasifikasi akun Pendapatan/Beban
  -- untuk menentukan posisi OTOMATIS di LHU (PARTISIPASI ANGGOTA/BEBAN
  -- USAHA/HASIL INVESTASI/PENDAPATAN & BEBAN LAIN). NULLABLE — akun
  -- 'Pendapatan Jasa Pinjaman' (4-1000) & 'Beban Pajak Penghasilan'
  -- (5-2200) SENGAJA dibiarkan NULL karena keduanya baris tersendiri di
  -- LHU (bukan bagian klasifikasi manapun), lihat FinancialReports.getLHU.
  -- Klasifikasi ini TIDAK PERNAH mengubah jurnal (Bagian M) — murni
  -- menentukan penyajian laporan.
  lhu_klasifikasi TEXT CHECK (lhu_klasifikasi IN (
    'PENDAPATAN_USAHA_LAIN','HASIL_INVESTASI','PENDAPATAN_LAIN','BEBAN_USAHA','BEBAN_LAIN'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_kategori ON account(kategori);

-- Mapping akun untuk transaksi otomatis (PRD §18, §21) — laporan TIDAK
-- boleh hard-code nama akun, semua lewat mapping ini.
CREATE TABLE IF NOT EXISTS account_mapping (
  id TEXT PRIMARY KEY,
  transaction_type TEXT NOT NULL,   -- e.g. 'SIMPANAN_POKOK', 'PENCAIRAN_PINJAMAN', 'ANGSURAN_POKOK'
  role TEXT NOT NULL,               -- e.g. 'DEBIT_DEFAULT', 'KREDIT_DEFAULT'
  account_id TEXT NOT NULL REFERENCES account(id),
  UNIQUE(transaction_type, role)
);

-- ============================================================
-- 5. PERIODE AKUNTANSI (PRD §20)
-- ============================================================
CREATE TABLE IF NOT EXISTS accounting_period (
  id TEXT PRIMARY KEY,
  tahun_buku INTEGER NOT NULL,
  periode_mulai TEXT NOT NULL,
  periode_selesai TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')) DEFAULT 'OPEN',
  closed_at TEXT,
  closed_by TEXT
);

-- ============================================================
-- 6. JURNAL — DOUBLE ENTRY (PRD §19)
-- ============================================================
CREATE TABLE IF NOT EXISTS journal (
  id TEXT PRIMARY KEY,
  nomor_jurnal TEXT NOT NULL UNIQUE,
  tanggal TEXT NOT NULL,
  period_id TEXT NOT NULL REFERENCES accounting_period(id),
  nomor_referensi TEXT,
  sumber_transaksi TEXT NOT NULL,     -- e.g. 'SIMPANAN_POKOK', 'ANGSURAN', 'KAS_MANUAL'
  sumber_id TEXT,                     -- id transaksi asal
  deskripsi TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','POSTED','VOID','REVERSED')) DEFAULT 'DRAFT',
  reversal_of_id TEXT REFERENCES journal(id),
  reversed_by_id TEXT REFERENCES journal(id),
  created_by TEXT NOT NULL,
  posted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_tanggal ON journal(tanggal);
CREATE INDEX IF NOT EXISTS idx_journal_status ON journal(status);
CREATE INDEX IF NOT EXISTS idx_journal_sumber ON journal(sumber_transaksi, sumber_id);

CREATE TABLE IF NOT EXISTS journal_entry (
  id TEXT PRIMARY KEY,
  journal_id TEXT NOT NULL REFERENCES journal(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id),
  debit INTEGER NOT NULL DEFAULT 0,
  kredit INTEGER NOT NULL DEFAULT 0,
  keterangan TEXT,
  urutan INTEGER NOT NULL DEFAULT 0,
  CHECK (debit >= 0 AND kredit >= 0),
  CHECK (NOT (debit > 0 AND kredit > 0))
);
CREATE INDEX IF NOT EXISTS idx_journal_entry_journal ON journal_entry(journal_id);
CREATE INDEX IF NOT EXISTS idx_journal_entry_account ON journal_entry(account_id);

-- ============================================================
-- 7. SIMPANAN (PRD §8-10)
-- ============================================================
CREATE TABLE IF NOT EXISTS simpanan_transaksi (
  id TEXT PRIMARY KEY,
  anggota_id TEXT NOT NULL REFERENCES anggota(id),
  jenis TEXT NOT NULL CHECK (jenis IN ('POKOK','WAJIB','SUKARELA')),
  tipe TEXT NOT NULL CHECK (tipe IN ('SETOR','TARIK','KOREKSI')),
  tanggal TEXT NOT NULL,
  periode TEXT,                       -- untuk simpanan wajib (YYYY-MM)
  nominal INTEGER NOT NULL,
  sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
  bank_account_id TEXT REFERENCES bank_account(id),
  nomor_transaksi TEXT NOT NULL UNIQUE,
  keterangan TEXT,
  journal_id TEXT REFERENCES journal(id),
  reversal_of_id TEXT REFERENCES simpanan_transaksi(id),
  idempotency_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_simpanan_anggota ON simpanan_transaksi(anggota_id, jenis);
CREATE UNIQUE INDEX IF NOT EXISTS idx_simpanan_idempotency ON simpanan_transaksi(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_simpanan_tanggal ON simpanan_transaksi(tanggal);

-- ============================================================
-- 7b. SIMPANAN BERJANGKA (deposito anggota)
-- ============================================================
-- SUBLEDGER TERPISAH, BUKAN perluasan simpanan_transaksi di atas.
--
-- Alasannya struktural, bukan preferensi: simpanan_transaksi adalah
-- buku transaksi ARUS (SETOR/TARIK/KOREKSI) tanpa konsep kontrak —
-- tidak punya tenor, tanggal jatuh tempo, suku bunga, maupun status
-- siklus hidup. Simpanan berjangka justru sebaliknya: satu baris = satu
-- KONTRAK yang hidup dari penempatan sampai pencairan. Memaksakan
-- 'BERJANGKA' ke dalam CHECK jenis akan (a) memaksa 4 kolom baru yang
-- selalu NULL untuk POKOK/WAJIB/SUKARELA, dan (b) membuat setiap query
-- saldo simpanan existing harus ingat mengecualikan BERJANGKA — cara
-- paling mudah menciptakan kebocoran saldo diam-diam. CHECK jenis
-- pada simpanan_transaksi karena itu TIDAK DIUBAH.
--
-- Konsekuensi yang disengaja: saldo simpanan berjangka TIDAK PERNAH
-- ikut terhitung oleh getSaldoSimpanan()/tarikSimpananSukarela()
-- yang membaca simpanan_transaksi — persis yang diminta.
CREATE TABLE IF NOT EXISTS simpanan_berjangka (
  id TEXT PRIMARY KEY,
  anggota_id TEXT NOT NULL REFERENCES anggota(id),
  nomor_transaksi TEXT NOT NULL UNIQUE,
  tanggal_mulai TEXT NOT NULL,
  tanggal_jatuh_tempo TEXT NOT NULL,
  nominal INTEGER NOT NULL,
  -- Tenor dibatasi 3/6/12 bulan di level database DAN di service.
  tenor_bulan INTEGER NOT NULL CHECK (tenor_bulan IN (3, 6, 12)),
  -- Suku bunga KONTRAKTUAL per tahun (persen), mis. 6 = 6%/tahun.
  -- Disimpan sebagai REAL karena rate lazim berdesimal (8.5%); ini
  -- BUKAN nominal uang, jadi tidak tunduk pada invarian Rupiah bulat.
  -- NOT NULL DEFAULT 0: rate opsional di UI, tetapi nilai tersimpan
  -- selalu terdefinisi — tidak ada NULL yang harus ditebak pembacanya.
  suku_bunga REAL NOT NULL DEFAULT 0 CHECK (suku_bunga >= 0),
  status TEXT NOT NULL CHECK (status IN ('AKTIF','JATUH_TEMPO','DICAIRKAN','DIBATALKAN')),
  sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
  bank_account_id TEXT REFERENCES bank_account(id),
  keterangan TEXT,
  journal_id TEXT REFERENCES journal(id),
  idempotency_key TEXT,
  -- Turunan yang di-maintain bersamaan dengan tabel event
  -- simpanan_berjangka_bunga (lihat di bawah). Pokok TIDAK PERNAH
  -- ditambah bunga: nominal tetap pokok asli seumur kontrak.
  bunga_terakru INTEGER NOT NULL DEFAULT 0,
  bunga_dibayar INTEGER NOT NULL DEFAULT 0,
  tanggal_pencairan TEXT,
  journal_pencairan_id TEXT REFERENCES journal(id),
  idempotency_key_pencairan TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_simpanan_berjangka_idem_cair ON simpanan_berjangka(idempotency_key_pencairan) WHERE idempotency_key_pencairan IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_simpanan_berjangka_anggota ON simpanan_berjangka(anggota_id, status);
CREATE INDEX IF NOT EXISTS idx_simpanan_berjangka_jatuh_tempo ON simpanan_berjangka(tanggal_jatuh_tempo);
CREATE INDEX IF NOT EXISTS idx_simpanan_berjangka_tanggal ON simpanan_berjangka(tanggal_mulai);
-- Idempotency: pola SAMA PERSIS dengan idx_simpanan_idempotency di atas
-- (unique partial index, NULL diabaikan). Identitas bisnis TIDAK PERNAH
-- diturunkan dari nominal+tanggal — dua penempatan sah dengan nominal &
-- tanggal sama harus tetap bisa dicatat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_simpanan_berjangka_idempotency ON simpanan_berjangka(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- 7c. AKRUAL BUNGA SIMPANAN BERJANGKA (event per periode)
-- ============================================================
-- SATU BARIS = SATU PERIODE BUNGA yang sudah diakui, dengan jurnalnya.
--
-- Kenapa tabel event, bukan sekadar kolom akumulatif pada
-- simpanan_berjangka: kolom akumulatif tidak bisa menjawab "periode
-- mana yang sudah diakru" tanpa menebak dari tanggal, dan tebakan itu
-- akan salah begitu ada periode yang terlewat/tertunda. Tabel event
-- membuat idempotency menjadi fakta struktural, bukan perhitungan:
-- UNIQUE(simpanan_berjangka_id, nomor_periode) membuat akrual ganda
-- MUSTAHIL walau engine dijalankan berkali-kali atau bersamaan.
--
-- Kolom akumulatif pada simpanan_berjangka TETAP ADA sebagai turunan
-- yang di-maintain di transaksi yang sama, murni untuk pembacaan cepat
-- di UI; tabel ini yang otoritatif.
CREATE TABLE IF NOT EXISTS simpanan_berjangka_bunga (
  id TEXT PRIMARY KEY,
  simpanan_berjangka_id TEXT NOT NULL REFERENCES simpanan_berjangka(id),
  nomor_periode INTEGER NOT NULL,
  tanggal_akhir_periode TEXT NOT NULL,
  bunga INTEGER NOT NULL,
  journal_id TEXT REFERENCES journal(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sb_bunga_periode ON simpanan_berjangka_bunga(simpanan_berjangka_id, nomor_periode);
CREATE INDEX IF NOT EXISTS idx_sb_bunga_kontrak ON simpanan_berjangka_bunga(simpanan_berjangka_id);

-- ============================================================
-- 7d. KEBIJAKAN PENARIKAN DINI SIMPANAN BERJANGKA (S21)
-- ============================================================
-- SATU BARIS = SATU VERSI KEBIJAKAN yang ditetapkan pengurus.
--
-- Tabel ini SENGAJA KOSONG pada instalasi baru. Aplikasi TIDAK
-- mengapalkan kebijakan bawaan: tanpa baris di sini status kebijakan
-- adalah POLICY_REQUIRED dan penarikan dini ditolak. Angka penalti,
-- porsi bunga hangus, biaya administrasi, dan rate penarikan dini
-- hanya boleh berasal dari keputusan tertulis koperasi.
--
-- KENAPA TABEL SENDIRI, BUKAN KOLOM DI simpanan_berjangka: kebijakan
-- berlaku untuk SELURUH kontrak dan BERVERSI. Menempelkannya sebagai
-- kolom kontrak akan menduplikasi aturan yang sama ke setiap baris dan
-- membuat "kebijakan mana yang dipakai" mustahil ditelusuri setelah
-- pengurus mengubahnya.
--
-- Akun penalti & biaya admin adalah REFERENSI ke account: keduanya
-- pendapatan sungguhan yang tidak dapat diturunkan dari transaksi mana
-- pun, jadi harus ditunjuk kebijakan. Bunga hangus TIDAK punya kolom
-- akun karena tujuannya diturunkan: pembalikan akun beban akrualnya
-- sendiri (lihat TUJUAN_AKUNTANSI_FORFEITURE).
CREATE TABLE IF NOT EXISTS simpanan_berjangka_kebijakan_dini (
  id TEXT PRIMARY KEY,
  versi TEXT NOT NULL UNIQUE,
  berlaku_mulai TEXT NOT NULL,
  diizinkan INTEGER NOT NULL DEFAULT 0,
  jenis_penalti TEXT CHECK (jenis_penalti IS NULL OR jenis_penalti IN ('TIDAK_ADA','NOMINAL_TETAP','PERSENTASE')),
  nilai_penalti REAL,
  basis_penalti TEXT CHECK (basis_penalti IS NULL OR basis_penalti IN ('POKOK','BUNGA_BRUTO','TOTAL_SEBELUM_PENALTI')),
  akun_penalti_id TEXT REFERENCES account(id),
  jenis_forfeiture TEXT CHECK (jenis_forfeiture IS NULL OR jenis_forfeiture IN ('TIDAK_ADA','SELURUH_BUNGA','PERSENTASE_BUNGA','NOMINAL_TETAP')),
  nilai_forfeiture REAL,
  jenis_biaya_admin TEXT CHECK (jenis_biaya_admin IS NULL OR jenis_biaya_admin IN ('TIDAK_ADA','NOMINAL_TETAP','PERSENTASE')),
  nilai_biaya_admin REAL,
  basis_biaya_admin TEXT CHECK (basis_biaya_admin IS NULL OR basis_biaya_admin IN ('POKOK','BUNGA_BRUTO')),
  akun_biaya_admin_id TEXT REFERENCES account(id),
  rate_dini REAL,
  jenis_penyesuaian_rate TEXT CHECK (jenis_penyesuaian_rate IS NULL OR jenis_penyesuaian_rate IN ('TIDAK_ADA','RATE_DINI')),
  cakupan_penyesuaian_rate TEXT CHECK (cakupan_penyesuaian_rate IS NULL OR cakupan_penyesuaian_rate IN ('SEJAK_PENEMPATAN','PERIODE_BERJALAN_SAJA')),
  perlakuan_pokok TEXT CHECK (perlakuan_pokok IS NULL OR perlakuan_pokok IN ('PENUH','DIKURANGI_PENALTI','DIKURANGI_BIAYA_ADMIN','DIKURANGI_PENALTI_DAN_BIAYA')),
  perlakuan_bunga TEXT CHECK (perlakuan_bunga IS NULL OR perlakuan_bunga IN ('BAYAR_SETELAH_FORFEITURE','TIDAK_DIBAYAR')),
  dasar_penetapan TEXT,
  ditetapkan_oleh TEXT,
  -- 'DRAFT' (RC-S44c): kebijakan yang sudah tersimpan tetapi BELUM
  -- lengkap, sehingga belum boleh menggantikan kebijakan yang berlaku.
  -- Statusnya murni siklus hidup versi — bukan aturan akuntansi, dan
  -- tidak pernah masuk perhitungan mana pun. DEFAULT tetap 'AKTIF'
  -- supaya baris lama tidak berubah maknanya.
  status TEXT NOT NULL CHECK (status IN ('DRAFT','AKTIF','NONAKTIF')) DEFAULT 'AKTIF',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Hanya SATU kebijakan berstatus AKTIF pada satu waktu: "kebijakan mana
-- yang berlaku" harus punya jawaban tunggal, bukan hasil ORDER BY.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sb_kebijakan_dini_aktif ON simpanan_berjangka_kebijakan_dini(status) WHERE status = 'AKTIF';

-- ============================================================
-- 7e. SETTLEMENT PENARIKAN DINI (event, S21)
-- ============================================================
-- SATU BARIS = SATU pencairan dini yang benar-benar terjadi, lengkap
-- dengan SELURUH komponen perhitungannya. Kolom-kolom ini BUKAN
-- duplikasi hitungan: mereka adalah jejak audit atas angka yang
-- dipakai saat itu, yang tidak dapat direkonstruksi ulang setelah
-- pengurus mengganti versi kebijakan.
--
-- UNIQUE(simpanan_berjangka_id) membuat DOUBLE SETTLEMENT mustahil
-- secara struktural — bukan sekadar dicegah pemeriksaan aplikasi.
CREATE TABLE IF NOT EXISTS simpanan_berjangka_pencairan_dini (
  id TEXT PRIMARY KEY,
  simpanan_berjangka_id TEXT NOT NULL REFERENCES simpanan_berjangka(id),
  tanggal_pencairan TEXT NOT NULL,
  policy_versi TEXT NOT NULL,
  pokok_bruto INTEGER NOT NULL,
  bunga_akrual_kontrak INTEGER NOT NULL,
  penyesuaian_rate INTEGER NOT NULL DEFAULT 0,
  bunga_bruto INTEGER NOT NULL,
  bunga_hangus INTEGER NOT NULL DEFAULT 0,
  penalti INTEGER NOT NULL DEFAULT 0,
  biaya_admin INTEGER NOT NULL DEFAULT 0,
  penyesuaian_pokok INTEGER NOT NULL DEFAULT 0,
  penyesuaian_bunga INTEGER NOT NULL DEFAULT 0,
  pokok_dibayar INTEGER NOT NULL,
  bunga_dibayar INTEGER NOT NULL,
  total_payout INTEGER NOT NULL,
  rate_kontrak REAL NOT NULL,
  rate_efektif REAL NOT NULL,
  alasan TEXT,
  journal_id TEXT REFERENCES journal(id),
  idempotency_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sb_dini_kontrak ON simpanan_berjangka_pencairan_dini(simpanan_berjangka_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sb_dini_idempotency ON simpanan_berjangka_pencairan_dini(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- 8. PINJAMAN (PRD §11-15)
-- ============================================================
CREATE TABLE IF NOT EXISTS pinjaman (
  id TEXT PRIMARY KEY,
  nomor_pinjaman TEXT NOT NULL UNIQUE,
  anggota_id TEXT NOT NULL REFERENCES anggota(id),
  tanggal TEXT NOT NULL,
  jumlah_pinjaman INTEGER NOT NULL,
  tenor INTEGER NOT NULL,
  satuan_tenor TEXT NOT NULL CHECK (satuan_tenor IN ('HARI','MINGGU','BULAN')),
  metode_jasa TEXT NOT NULL CHECK (metode_jasa IN ('FLAT','EFEKTIF','MENURUN','CUSTOM')),
  persentase_jasa REAL NOT NULL DEFAULT 0,
  biaya_admin_tipe TEXT NOT NULL CHECK (biaya_admin_tipe IN ('NOMINAL','PERSENTASE','TIDAK_ADA')) DEFAULT 'TIDAK_ADA',
  biaya_admin_nilai INTEGER NOT NULL DEFAULT 0,
  denda_aktif INTEGER NOT NULL DEFAULT 0,
  denda_tipe TEXT CHECK (denda_tipe IN ('NOMINAL','PERSENTASE','PER_HARI','PER_PERIODE','CUSTOM')),
  denda_nilai INTEGER NOT NULL DEFAULT 0,
  tanggal_jatuh_tempo TEXT,
  status TEXT NOT NULL CHECK (status IN ('DIAJUKAN','DISETUJUI','AKTIF','LUNAS','MACET','DITOLAK')) DEFAULT 'DIAJUKAN',
  keterangan TEXT,
  -- RC-S54 item 24 (v65) — TUJUAN PINJAMAN.
  -- NULLABLE tanpa default: pinjaman lama memang tidak pernah punya
  -- tujuan, dan mengisinya dengan tebakan akan mengarang data. Form baru
  -- mewajibkannya; data lama tetap terbaca apa adanya.
  -- tujuan_detail HANYA diisi saat tujuan = 'LAINNYA'.
  tujuan_pinjaman TEXT CHECK (tujuan_pinjaman IN ('MODAL_KERJA','INVESTASI','KONSUMTIF','LAINNYA')),
  tujuan_detail TEXT,
  pencairan_journal_id TEXT REFERENCES journal(id),
  approved_by TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- PHASE 2 (§12/§13, permintaan pengguna) — klasifikasi biaya admin
  -- pencairan: INTEGRAL_FINANCIAL_INSTRUMENT (bagian dari pengukuran/
  -- effective yield, TIDAK diakui sebagai pendapatan langsung — lihat
  -- cairkanPinjaman) vs SEPARATE_SERVICE (jasa administrasi terpisah,
  -- diakui langsung seperti SEBELUM Phase 2). DEFAULT 'SEPARATE_SERVICE'
  -- SENGAJA dipilih supaya SELURUH pinjaman existing/baru yang tidak
  -- eksplisit diisi (ajukanPinjaman() TIDAK menyertakan kolom ini di
  -- INSERT-nya, murni mengandalkan default) berperilaku PERSIS SAMA
  -- dengan sebelum Phase 2 — TIDAK ADA regresi/perubahan perilaku pada
  -- pinjaman existing.
  biaya_admin_klasifikasi TEXT NOT NULL CHECK (biaya_admin_klasifikasi IN (
    'INTEGRAL_FINANCIAL_INSTRUMENT','SEPARATE_SERVICE'
  )) DEFAULT 'SEPARATE_SERVICE',
  -- PHASE 7 (permintaan pengguna §AE): status pengukuran EIR per
  -- pinjaman — 'EIR_NOT_MIGRATED' (DEFAULT, aman untuk SELURUH
  -- pinjaman existing sebelum Phase 7 — TIDAK ADA backfill otomatis),
  -- 'NOT_APPLICABLE' (biaya_admin_klasifikasi='SEPARATE_SERVICE' atau
  -- tanpa fee integral — secara desain tidak memerlukan pengukuran
  -- biaya perolehan diamortisasi penuh, tetap pakai model akrual
  -- Phase 2), 'MEASURED' (EIR sudah dihitung & schedule EIR_MONTHLY
  -- tersimpan), 'PENDING_RESTRUCTURING_EIR_REVIEW' (§S), 'DERECOGNIZED'
  -- (§R/§T, instrumen sudah dihentikan/dilunasi/dihapusbukukan).
  eir_measurement_status TEXT NOT NULL CHECK (eir_measurement_status IN (
    'EIR_NOT_MIGRATED','NOT_APPLICABLE','MEASURED','PENDING_RESTRUCTURING_EIR_REVIEW','DERECOGNIZED'
  )) DEFAULT 'EIR_NOT_MIGRATED'
);

-- ============================================================
-- RC-S54 item 25 (v65) — AGUNAN / JAMINAN PINJAMAN.
--
--     TABEL ANAK, bukan kolom JSON: project ini sudah memakai pola
--     master/detail relasional di mana-mana (angsuran, penyusutan,
--     penerimaan bagian SHU), dan menyimpan agunan sebagai satu string
--     JSON akan membuat nilainya tidak bisa dijumlahkan maupun diaudit.
--
--     SATU BARIS PER AGUNAN. Strukturnya memang memungkinkan lebih dari
--     satu agunan per pinjaman, tetapi form dan service sengaja
--     mengelola SATU agunan saja — item 25 tidak meminta multi-agunan,
--     dan memperluasnya sekarang berarti menambah requirement sendiri.
--
--     Pinjaman TANPA agunan TIDAK punya baris di sini sama sekali —
--     bukan baris kosong dengan nilai 0. Ketiadaan baris ITULAH yang
--     berarti "Tidak Ada".
-- ============================================================
CREATE TABLE IF NOT EXISTS pinjaman_agunan (
  id TEXT PRIMARY KEY,
  pinjaman_id TEXT NOT NULL REFERENCES pinjaman(id),
  jenis_agunan TEXT NOT NULL CHECK (jenis_agunan IN (
    'TANAH','TANAH_DAN_BANGUNAN','KENDARAAN','DEPOSITO','TABUNGAN','BARANG_BERGERAK_LAINNYA'
  )),
  pemilik TEXT NOT NULL,
  nomor_dokumen TEXT NOT NULL,
  nilai_agunan INTEGER NOT NULL CHECK (nilai_agunan >= 0),
  keterangan TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pinjaman_agunan_pinjaman ON pinjaman_agunan(pinjaman_id);
CREATE INDEX IF NOT EXISTS idx_pinjaman_anggota ON pinjaman(anggota_id);
CREATE INDEX IF NOT EXISTS idx_pinjaman_status ON pinjaman(status);

-- Jadwal angsuran (PRD §12)
CREATE TABLE IF NOT EXISTS angsuran_jadwal (
  id TEXT PRIMARY KEY,
  pinjaman_id TEXT NOT NULL REFERENCES pinjaman(id) ON DELETE CASCADE,
  nomor_angsuran INTEGER NOT NULL,
  tanggal_jatuh_tempo TEXT NOT NULL,
  pokok INTEGER NOT NULL,
  jasa INTEGER NOT NULL,
  denda INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  pokok_terbayar INTEGER NOT NULL DEFAULT 0,
  jasa_terbayar INTEGER NOT NULL DEFAULT 0,
  denda_terbayar INTEGER NOT NULL DEFAULT 0,
  -- FINAL FIX AKRUAL (permintaan pengguna BUG 4/5/7): porsi jasa baris
  -- ini yang KASNYA SUDAH DITERIMA tapi periodenya BELUM jatuh tempo
  -- pada saat pembayaran, sehingga BELUM boleh diakui sebagai
  -- Pendapatan Jasa. Kas tsb dibukukan ke akun EXISTING "Pendapatan
  -- Diterima Dimuka" (2-1300, mekanisme yang SAMA dipakai fee integral
  -- pencairan & jasa future pelunasan — TIDAK ada akun/mekanisme
  -- akuntansi baru). Kolom ini adalah subledger-nya: saat periode
  -- benar-benar jatuh tempo, AkrualJasaPinjamanService mengakui saldo
  -- ini (Dr Pendapatan Diterima Dimuka / Cr Pendapatan Jasa) lalu
  -- mengembalikannya ke 0. SELALU <= jasa_terbayar.
  jasa_dimuka INTEGER NOT NULL DEFAULT 0,
  -- PHASE 3 (permintaan pengguna §I/§K): 'DIHAPUSBUKU' (write-off —
  -- lihat hapusPiutangPinjaman) & 'DIRESTRUKTURISASI' (akad ulang —
  -- lihat akadUlangPinjaman) DITAMBAHKAN, BUKAN menggantikan status
  -- lama. Baris dengan status ini TIDAK PERNAH dihapus — histori
  -- tetap ada untuk audit, hanya statusnya berubah.
  status TEXT NOT NULL CHECK (status IN ('BELUM_BAYAR','SEBAGIAN','LUNAS','TERLAMBAT','DIHAPUSBUKU','DIRESTRUKTURISASI')) DEFAULT 'BELUM_BAYAR',
  -- PHASE 3 (permintaan pengguna §L/§M): traceability BIDIRECTIONAL
  -- "old schedule -> restructuring -> new schedule" — diisi
  -- akadUlangPinjaman(). Baris LAMA yang digantikan diberi
  -- "digantikan_oleh_akad_ulang_id" (menunjuk event akad ulang yang
  -- menggantikannya); baris BARU hasil akad ulang diberi
  -- "dibuat_dari_akad_ulang_id" (menunjuk event yang membuatnya).
  -- Keduanya NULL untuk baris normal yang tidak pernah tersentuh akad
  -- ulang. FK ke pinjaman_akad_ulang aman meski tabel itu didefinisikan
  -- setelah tabel ini di file yang sama — SQLite tidak mewajibkan
  -- urutan definisi untuk forward reference (hanya dicek saat DML,
  -- dan foreign_keys enforcement OFF secara default untuk instalasi
  -- lama, lihat db.ts).
  digantikan_oleh_akad_ulang_id TEXT REFERENCES pinjaman_akad_ulang(id),
  dibuat_dari_akad_ulang_id TEXT REFERENCES pinjaman_akad_ulang(id),
  UNIQUE(pinjaman_id, nomor_angsuran)
);
CREATE INDEX IF NOT EXISTS idx_angsuran_pinjaman ON angsuran_jadwal(pinjaman_id);
CREATE INDEX IF NOT EXISTS idx_angsuran_jatuh_tempo ON angsuran_jadwal(tanggal_jatuh_tempo);

-- Pembayaran angsuran (PRD §13)
CREATE TABLE IF NOT EXISTS angsuran_pembayaran (
  id TEXT PRIMARY KEY,
  pinjaman_id TEXT NOT NULL REFERENCES pinjaman(id),
  jadwal_id TEXT REFERENCES angsuran_jadwal(id),
  tanggal TEXT NOT NULL,
  nominal INTEGER NOT NULL,
  porsi_pokok INTEGER NOT NULL,
  porsi_jasa INTEGER NOT NULL,
  porsi_denda INTEGER NOT NULL DEFAULT 0,
  sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
  bank_account_id TEXT REFERENCES bank_account(id),
  journal_id TEXT REFERENCES journal(id),
  reversal_of_id TEXT REFERENCES angsuran_pembayaran(id),
  idempotency_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- REQUIREMENT 9 (permintaan pengguna) — metode perhitungan jasa yang
  -- DIPILIH petugas saat PELUNASAN dipercepat:
  --   'JASA_KONTRAKTUAL' = seluruh sisa jasa sesuai kontrak ditagih
  --      (PERILAKU LAMA, satu-satunya perilaku sebelum requirement ini);
  --   'JASA_TERUTANG'    = hanya jasa yang periodenya SUDAH jatuh tempo
  --      per tanggal pelunasan yang ditagih; sisa jasa kontraktual masa
  --      depan DIRABAT (tidak ditagih).
  -- NULL untuk SELURUH baris historis & untuk pembayaran ANGSURAN biasa
  -- (kolom ini hanya relevan pada transaksi pelunasan) — TIDAK ADA
  -- backfill/asumsi retroaktif atas data lama.
  metode_jasa_pelunasan TEXT CHECK (metode_jasa_pelunasan IN ('JASA_TERUTANG','JASA_KONTRAKTUAL')),
  -- Nominal jasa kontraktual yang DIRABAT (tidak ditagih) akibat pilihan
  -- 'JASA_TERUTANG'. 0 untuk metode kontraktual & seluruh baris lama.
  -- Murni jejak audit: nominal ini TIDAK PERNAH dijurnal (jasa masa
  -- depan memang belum pernah diakui sebagai pendapatan maupun piutang
  -- di GL), jadi merabatnya tidak menimbulkan entri akuntansi apa pun.
  rabat_jasa_pelunasan INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_angsuran_bayar_idempotency ON angsuran_pembayaran(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_angsuran_bayar_pinjaman ON angsuran_pembayaran(pinjaman_id);

-- Riwayat Akad Ulang pinjaman (target §9, permintaan pengguna) — dibuat
-- di migration v37 (db.ts) untuk instalasi lama, dan di sini untuk
-- instalasi baru supaya skemanya identik sejak awal.
CREATE TABLE IF NOT EXISTS pinjaman_akad_ulang (
  id TEXT PRIMARY KEY,
  pinjaman_id TEXT NOT NULL REFERENCES pinjaman(id),
  tanggal TEXT NOT NULL,
  tenor_lama INTEGER NOT NULL,
  satuan_tenor_lama TEXT NOT NULL,
  metode_jasa_lama TEXT NOT NULL,
  persentase_jasa_lama REAL NOT NULL,
  tenor_baru INTEGER NOT NULL,
  satuan_tenor_baru TEXT NOT NULL,
  metode_jasa_baru TEXT NOT NULL,
  persentase_jasa_baru REAL NOT NULL,
  sisa_pokok INTEGER NOT NULL,
  keterangan TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- PHASE 3 (permintaan pengguna §L/§N): snapshot Piutang Jasa yang
  -- SUDAH DIAKUI pada saat akad ulang (hitungOutstandingPiutangJasa)
  -- — murni untuk audit trail/rekonsiliasi historis ("berapa Piutang
  -- Jasa yang ada tepat sebelum restrukturisasi ini"), TIDAK
  -- mempengaruhi perhitungan apa pun (Piutang Jasa yang sesungguhnya
  -- tetap dihitung live dari pinjaman_akuntansi_jasa, angka ini cuma
  -- potret/snapshot). status DEFAULT 'SELESAI' — akad ulang di
  -- aplikasi ini adalah aksi langsung/atomic (tidak ada alur
  -- persetujuan bertahap seperti pengajuan pinjaman), jadi setiap
  -- baris yang berhasil tersimpan otomatis berstatus selesai.
  outstanding_piutang_jasa INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'SELESAI'
);
CREATE INDEX IF NOT EXISTS idx_akad_ulang_pinjaman ON pinjaman_akad_ulang(pinjaman_id);

-- PHASE 1 (fondasi model akuntansi akrual jasa/bunga pinjaman,
-- permintaan pengguna bagian B/C/G/X): mencatat SATU baris per
-- pengakuan akuntansi jasa/fee per periode per pinjaman — TERPISAH
-- dari angsuran_jadwal (yang murni jadwal KONTRAKTUAL). Tabel ini
-- BELUM diisi oleh service mana pun pada Phase 1 (fondasi saja,
-- mekanisme pengisian/posting jurnalnya adalah scope PHASE 2) — dibuat
-- di sini untuk instalasi baru, dan di migration v42 (db.ts) untuk
-- instalasi lama, mengikuti pola pinjaman_akad_ulang di atas.
-- UNIQUE(pinjaman_id, periode_akuntansi, tipe_pengakuan) mencegah
-- pengakuan ganda untuk kombinasi pinjaman+periode+tipe yang sama
-- (idempotency guard sesuai Bagian G/X), idempotency_key sebagai
-- kunci tambahan yang dipakai lapisan service saat posting.
CREATE TABLE IF NOT EXISTS pinjaman_akuntansi_jasa (
  id TEXT PRIMARY KEY,
  pinjaman_id TEXT NOT NULL REFERENCES pinjaman(id),
  jadwal_id TEXT REFERENCES angsuran_jadwal(id),
  periode_akuntansi TEXT NOT NULL,
  tipe_pengakuan TEXT NOT NULL CHECK (tipe_pengakuan IN (
    'JASA_AKRUAL','FEE_INTEGRAL_AMORTISASI','FEE_SEPARATE_SERVICE','EIR_MONTHLY','EIR_DERECOGNITION'
  )) DEFAULT 'JASA_AKRUAL',
  saldo_awal_carrying INTEGER NOT NULL DEFAULT 0,
  pendapatan_akuntansi INTEGER NOT NULL DEFAULT 0,
  kas_diterima INTEGER NOT NULL DEFAULT 0,
  amortisasi_fee INTEGER NOT NULL DEFAULT 0,
  saldo_akhir_carrying INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('DIAKUI','DIBATALKAN')) DEFAULT 'DIAKUI',
  journal_id TEXT REFERENCES journal(id),
  idempotency_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- PHASE 2 KOREKSI (permintaan pengguna §2): status lifecycle KHUSUS
  -- untuk baris tipe_pengakuan='FEE_INTEGRAL_AMORTISASI' (fee integral
  -- yang dibukukan ke Pendapatan Diterima Dimuka saat pencairan,
  -- BELUM diakui sebagai pendapatan) — supaya statusnya eksplisit
  -- dapat dilacak sampai Phase EIR menghitung amortisasi
  -- sesungguhnya. NULL untuk baris tipe_pengakuan='JASA_AKRUAL' (tidak
  -- relevan). TIDAK ADA jurnal amortisasi/EIR dibuat di Phase 2 — nilai
  -- 'DEFERRED_PENDING_EIR' murni penanda status/schedule.
  --
  -- PHASE 7 (permintaan pengguna §F/§R/§S): 3 nilai baru ditambahkan
  -- ke enum yang SAMA (bukan kolom status terpisah) — 'AMORTIZED'
  -- sudah ada sejak Phase 2 (dipakai baris FEE_INTEGRAL_AMORTISASI
  -- setelah diamortisasi penuh via EIR_MONTHLY), 'RECOGNIZED' juga
  -- sudah ada. BARU: 'PENDING_RESTRUCTURING_EIR_REVIEW' (§S — akad
  -- ulang pada pinjaman ber-EIR, modification accounting belum bisa
  -- ditentukan otomatis tanpa policy tambahan, ditandai eksplisit
  -- daripada menghitung yang salah) dan 'DERECOGNIZED' (§R/§T — saldo
  -- fee integral yang belum teramortisasi diselesaikan saat
  -- pelunasan dipercepat/write-off, TIDAK dibiarkan
  -- DEFERRED_PENDING_EIR selamanya).
  fee_lifecycle_status TEXT CHECK (fee_lifecycle_status IN (
    'DEFERRED_PENDING_EIR','AMORTIZED','RECOGNIZED','PENDING_RESTRUCTURING_EIR_REVIEW','DERECOGNIZED'
  )),
  -- PHASE 3 (permintaan pengguna §D): jumlah yang DIHAPUSBUKUKAN
  -- (write-off) dari baris ini — TERPISAH dari kas_diterima (kas
  -- sungguhan) supaya reconciliation formula §D tetap eksplisit:
  -- outstanding = pendapatan_akuntansi - kas_diterima - writeoff_amount.
  -- Lihat AkrualJasaPinjamanService.terapkanWriteOffKePiutangJasa.
  writeoff_amount INTEGER NOT NULL DEFAULT 0,
  -- PHASE 7 (permintaan pengguna §F): dua kolom BARU khusus baris
  -- tipe_pengakuan='EIR_MONTHLY' (jadwal pengakuan bulanan effective
  -- interest) — NULL untuk tipe_pengakuan lain (tidak relevan).
  -- "effective_interest_rate" adalah rate TAHUNAN hasil solver NYATA
  -- (EffectiveInterestRateService), DISIMPAN sekali per pinjaman saat
  -- initial recognition (§AD: "jangan hitung ulang EIR setiap render
  -- UI... cache/persist schedule") — SAMA di seluruh baris EIR_MONTHLY
  -- milik pinjaman yang sama. "remaining_term_bulan" = sisa jumlah
  -- periode pengakuan pada baris tsb (untuk audit/tampilan read-only,
  -- §AF).
  effective_interest_rate REAL,
  remaining_term_bulan INTEGER,
  -- PHASE 7 (permintaan pengguna §F): komponen pokok dari cash flow
  -- periode ini (kas_diterima - porsi bunga efektif) — HANYA memo/
  -- disclosure untuk baris EIR_MONTHLY, TIDAK mempengaruhi
  -- saldo_akhir_carrying (yang dihitung dari pendapatan_akuntansi &
  -- kas_diterima langsung, lihat komentar di EffectiveInterestRateService.ts).
  principal_component INTEGER,
  UNIQUE(pinjaman_id, periode_akuntansi, tipe_pengakuan)
);
CREATE INDEX IF NOT EXISTS idx_pinjaman_akuntansi_jasa_pinjaman ON pinjaman_akuntansi_jasa(pinjaman_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pinjaman_akuntansi_jasa_idempotency ON pinjaman_akuntansi_jasa(idempotency_key);

-- ============================================================
-- 9. KAS & BANK (PRD §16-17)
-- ============================================================
CREATE TABLE IF NOT EXISTS bank_account (
  id TEXT PRIMARY KEY,
  nama_bank TEXT NOT NULL,
  nomor_rekening TEXT NOT NULL,
  nama_pemilik TEXT NOT NULL,
  saldo_awal INTEGER NOT NULL DEFAULT 0,
  account_id TEXT NOT NULL REFERENCES account(id),  -- COA link
  aktif INTEGER NOT NULL DEFAULT 1,
  -- Target §10 (permintaan pengguna): "Jenis Simpanan" (Tabungan/
  -- Giro/Deposito) — nullable, TANPA CHECK (nilai divalidasi di layer
  -- aplikasi terhadap bank_jenis_simpanan.kode yang aktif) supaya
  -- rekening lama tetap kompatibel apa adanya (fallback null = belum
  -- diisi, bukan dipaksa ke salah satu nilai).
  jenis_simpanan TEXT,
  created_at TEXT NOT NULL
);

-- Referensi jenis simpanan bank, bisa di-ON/OFF-kan per jenis tanpa
-- menghapus data rekening yang sudah memakainya (target §10).
CREATE TABLE IF NOT EXISTS bank_jenis_simpanan (
  id TEXT PRIMARY KEY,
  kode TEXT NOT NULL UNIQUE,
  nama TEXT NOT NULL,
  aktif INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kas_transaksi (
  id TEXT PRIMARY KEY,
  jenis_kas TEXT NOT NULL CHECK (jenis_kas IN ('KAS','KAS_KECIL')),
  tipe TEXT NOT NULL CHECK (tipe IN ('PENERIMAAN','PENGELUARAN','TRANSFER','KOREKSI')),
  -- S19/P2 — ARAH TRANSFER ANTAR REKENING.
  -- tipe = 'TRANSFER' dipakai untuk KEDUA kaki transfer (rekening
  -- sumber dan rekening tujuan) dengan nominal sama-sama POSITIF,
  -- sehingga arahnya tidak dapat diketahui dari tipe saja. Akibatnya
  -- rekonsiliasi Kas/Bank menghitung baris transfer sebagai NOL di sisi
  -- subledger, sementara sisi GL tetap memasukkan jurnalnya — selisih
  -- palsu sebesar transfer neto (temuan P2 audit S18).
  -- Kolom ini menyimpan arah DI SUBLEDGER, sehingga rekonsiliasi tidak
  -- perlu membaca GL yang justru sedang diverifikasi (non-sirkular).
  -- NULL = baris non-transfer, ATAU baris transfer lama yang arahnya
  -- tidak dapat direkonstruksi (lihat migrasi v53 di db.ts).
  arah_transfer TEXT CHECK (arah_transfer IS NULL OR arah_transfer IN ('MASUK','KELUAR')),
  tanggal TEXT NOT NULL,
  nominal INTEGER NOT NULL,
  akun_lawan_id TEXT REFERENCES account(id),
  kategori TEXT,
  keterangan TEXT,
  nomor_transaksi TEXT NOT NULL UNIQUE,
  journal_id TEXT REFERENCES journal(id),
  reversal_of_id TEXT REFERENCES kas_transaksi(id),
  idempotency_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- v77 (Poin 5) — referensi master unit usaha untuk Pendapatan Unit Usaha.
  -- NULLABLE: hanya diisi transaksi PENDAPATAN_UNIT_USAHA baru; baris lama
  -- dan transaksi kas lain tetap NULL (tidak ditebak).
  unit_usaha_id TEXT REFERENCES koperasi_unit_usaha(id)
);
CREATE INDEX IF NOT EXISTS idx_kas_tanggal ON kas_transaksi(tanggal);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kas_idempotency ON kas_transaksi(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS bank_transaksi (
  id TEXT PRIMARY KEY,
  bank_account_id TEXT NOT NULL REFERENCES bank_account(id),
  -- S20/P1 — 'KOREKSI' WAJIB ada di sini, sama seperti kas_transaksi.
  -- koreksiTransaksiKasBank() (KasBankService.ts) menulis
  -- tipe: 'KOREKSI' untuk KEDUA jenis rekening lewat SATU fungsi
  -- insertBarisTransaksi(), dan tipe TS TipeTransaksiKasBank
  -- memang memuat 'KOREKSI'. Tanpa nilai ini di CHECK, koreksi
  -- transaksi BANK selalu gagal dengan "CHECK constraint failed"
  -- (kas berhasil, bank tidak) — jadi transaksi bank yang salah TIDAK
  -- BISA dikoreksi sama sekali. Asimetri ini murni kelalaian skema,
  -- bukan kebijakan: tidak ada satu pun aturan bisnis, guard service,
  -- atau test yang membedakan hak koreksi kas vs bank.
  tipe TEXT NOT NULL CHECK (tipe IN ('PENERIMAAN','PENGELUARAN','TRANSFER','KOREKSI')),
  -- S19/P2 — ARAH TRANSFER ANTAR REKENING.
  -- tipe = 'TRANSFER' dipakai untuk KEDUA kaki transfer (rekening
  -- sumber dan rekening tujuan) dengan nominal sama-sama POSITIF,
  -- sehingga arahnya tidak dapat diketahui dari tipe saja. Akibatnya
  -- rekonsiliasi Kas/Bank menghitung baris transfer sebagai NOL di sisi
  -- subledger, sementara sisi GL tetap memasukkan jurnalnya — selisih
  -- palsu sebesar transfer neto (temuan P2 audit S18).
  -- Kolom ini menyimpan arah DI SUBLEDGER, sehingga rekonsiliasi tidak
  -- perlu membaca GL yang justru sedang diverifikasi (non-sirkular).
  -- NULL = baris non-transfer, ATAU baris transfer lama yang arahnya
  -- tidak dapat direkonstruksi (lihat migrasi v53 di db.ts).
  arah_transfer TEXT CHECK (arah_transfer IS NULL OR arah_transfer IN ('MASUK','KELUAR')),
  tanggal TEXT NOT NULL,
  nominal INTEGER NOT NULL,
  akun_lawan_id TEXT REFERENCES account(id),
  kategori TEXT,
  keterangan TEXT,
  nomor_transaksi TEXT NOT NULL UNIQUE,
  journal_id TEXT REFERENCES journal(id),
  reversal_of_id TEXT REFERENCES bank_transaksi(id),
  idempotency_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- v77 (Poin 5) — lihat kas_transaksi.unit_usaha_id.
  unit_usaha_id TEXT REFERENCES koperasi_unit_usaha(id)
);
CREATE INDEX IF NOT EXISTS idx_bank_tanggal ON bank_transaksi(tanggal);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_idempotency ON bank_transaksi(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- 9b. UTANG (kewajiban koperasi ke pihak luar — bank/pihak lain
--     yang MEMBERI pinjaman TUNAI ke koperasi, kebalikan dari tabel
--     'pinjaman' yang berisi pinjaman yang DIBERIKAN ke anggota, DAN
--     utang usaha non-kas dari pembelian aset tetap metode KREDIT
--     lihat AsetService.beliAset). Sub-fitur "Utang" (Penerimaan,
--     khusus jenis BANK/PIHAK_LAIN) & "Kewajiban" (Pengeluaran,
--     pelunasan — semua jenis) di menu Transaksi.
--
--     jenis_pemberi UTANG_USAHA = timbul otomatis dari pembelian aset
--     kredit (bukan diinput manual lewat sub-fitur "Utang"), makanya
--     sumber_dana NULLABLE (tidak ada uang kas/bank yang diterima saat
--     utang usaha timbul — beda dari BANK/PIHAK_LAIN yang selalu
--     mencairkan kas/bank). "sumber" membedakan asal baris (LANGSUNG =
--     dari sub-fitur "Utang", PEMBELIAN_ASET = otomatis dari beliAset),
--     "aset_tetap_id" menaut ke aset yang dibeli untuk jenis itu saja.
-- ============================================================
CREATE TABLE IF NOT EXISTS utang (
  id TEXT PRIMARY KEY,
  nomor_utang TEXT NOT NULL UNIQUE,
  nama_pemberi TEXT NOT NULL,       -- nama bank / pihak lain / pemasok
  jenis_pemberi TEXT NOT NULL CHECK (jenis_pemberi IN ('BANK','PIHAK_LAIN','UTANG_USAHA')),
  pokok_pinjaman INTEGER NOT NULL,
  persen_bunga REAL NOT NULL DEFAULT 0,
  jenis_bunga TEXT NOT NULL CHECK (jenis_bunga IN ('FLAT','EFEKTIF','LAINNYA')) DEFAULT 'FLAT',
  -- RC-S55 §2: BASIS KONTRAKTUAL suku bunga. NULL = belum ditentukan
  -- (seluruh baris warisan v<=68). Mesin akrual otomatis WAJIB melewati
  -- baris ber-NULL dan melaporkannya sebagai "Basis bunga belum
  -- ditentukan" — tidak ada default tahunan/bulanan yang diasumsikan.
  basis_bunga TEXT CHECK (basis_bunga IN ('TAHUNAN','BULANAN')),
  basis_bunga_diisi_oleh TEXT,
  basis_bunga_diisi_pada TEXT,
  tanggal TEXT NOT NULL,
  sumber_dana TEXT CHECK (sumber_dana IN ('KAS','BANK')),
  bank_account_id TEXT REFERENCES bank_account(id),
  sumber TEXT NOT NULL CHECK (sumber IN ('LANGSUNG','PEMBELIAN_ASET')) DEFAULT 'LANGSUNG',
  aset_tetap_id TEXT REFERENCES aset_tetap(id),
  status TEXT NOT NULL CHECK (status IN ('AKTIF','LUNAS')) DEFAULT 'AKTIF',
  keterangan TEXT,
  journal_id TEXT REFERENCES journal(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_utang_status ON utang(status);
CREATE INDEX IF NOT EXISTS idx_utang_aset_tetap ON utang(aset_tetap_id);

-- Pembayaran/pelunasan utang (sub-fitur "Kewajiban") — pokok & bunga
-- dipisah sesuai permintaan (angsuran pokok + angsuran bunga input
-- manual, bukan jadwal otomatis seperti Pinjaman ke anggota).
CREATE TABLE IF NOT EXISTS utang_pembayaran (
  id TEXT PRIMARY KEY,
  utang_id TEXT NOT NULL REFERENCES utang(id),
  tanggal TEXT NOT NULL,
  pokok INTEGER NOT NULL,
  bunga INTEGER NOT NULL,
  sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
  bank_account_id TEXT REFERENCES bank_account(id),
  nomor_transaksi TEXT NOT NULL UNIQUE,
  journal_id TEXT REFERENCES journal(id),
  idempotency_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_utang_bayar_utang ON utang_pembayaran(utang_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_utang_bayar_idempotency ON utang_pembayaran(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- 9b-bis. SUBLEDGER AKRUAL BUNGA UTANG (RC-S55 §12)
-- ============================================================
-- SATU baris per (utang, periode YYYY-MM, tipe akrual). Ia BUKAN sumber
-- kebenaran saldo — saldo tetap di buku besar; baris ini adalah CATATAN
-- EKSEKUSI + AUDIT TRAIL mesin otomatis, dan UNIQUE di bawah adalah
-- lapis pertahanan TERAKHIR terhadap jurnal ganda (lapis pertama tetap
-- gap control RC-S53/S54 yang membaca jurnal).
--
-- nominal_target   = bunga kontraktual periode itu menurut mesin;
-- nominal_dibukukan= yang benar-benar dijurnal SEKARANG (bisa 0 kalau
--                      periode itu sudah tertutup gap-nya oleh akrual
--                      manual sebelumnya — periode tetap ditandai
--                      "sudah diproses" supaya tidak dihitung ulang).
-- journal_id NULL sah: artinya tidak ada yang perlu dibukukan.
CREATE TABLE IF NOT EXISTS utang_bunga_akrual (
  id TEXT PRIMARY KEY,
  utang_id TEXT NOT NULL REFERENCES utang(id),
  periode TEXT NOT NULL,
  tipe_akrual TEXT NOT NULL CHECK (tipe_akrual IN ('BUNGA_BULANAN')) DEFAULT 'BUNGA_BULANAN',
  mode TEXT NOT NULL CHECK (mode IN ('AUTO','MANUAL_ADJUSTMENT')) DEFAULT 'AUTO',
  basis_bunga TEXT NOT NULL,
  jenis_bunga TEXT NOT NULL,
  persen_bunga REAL NOT NULL,
  dasar_perhitungan INTEGER NOT NULL,
  nominal_target INTEGER NOT NULL,
  nominal_dibukukan INTEGER NOT NULL DEFAULT 0,
  tanggal_jurnal TEXT NOT NULL,
  journal_id TEXT REFERENCES journal(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  keterangan TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(utang_id, periode, tipe_akrual)
);
CREATE INDEX IF NOT EXISTS idx_utang_bunga_akrual_utang ON utang_bunga_akrual(utang_id, periode);

-- ============================================================
-- 9c. ASET TETAP — register aset (sub-fitur "Pembelian Aset" &
--     "Modal" barang). Nilai perolehan + masa manfaat dicatat untuk
--     dasar penyusutan (SAK), TAPI jurnal penyusutan bulanan belum
--     otomatis dibuat di sini — itu perhitungan terpisah yang bisa
--     ditambahkan kemudian, register ini baru mencatat perolehannya.
-- ============================================================
CREATE TABLE IF NOT EXISTS aset_tetap (
  id TEXT PRIMARY KEY,
  nomor_aset TEXT NOT NULL UNIQUE,
  nama_aset TEXT NOT NULL,
  nilai_perolehan INTEGER NOT NULL,
  nilai_residu INTEGER NOT NULL DEFAULT 0,
  masa_manfaat_bulan INTEGER NOT NULL,
  tanggal_perolehan TEXT NOT NULL,
  metode_pembayaran TEXT NOT NULL CHECK (metode_pembayaran IN ('TUNAI','KREDIT')),
  sumber TEXT NOT NULL CHECK (sumber IN ('PEMBELIAN','MODAL_BARANG')),
  keterangan TEXT,
  journal_id TEXT REFERENCES journal(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Bagian G (permintaan pengguna): NULLABLE — aset lama sebelum
  -- migrasi v15 tetap terbaca apa adanya (fallback "Belum
  -- Diklasifikasikan" di layar, tidak ada data yang hilang/dipaksa).
  kelompok_aset TEXT,
  sub_kelompok_aset TEXT,
  -- Update pasca-Phase 18 §9/§10 (permintaan pengguna): status
  -- soft-delete ('AKTIF'/'DIHAPUS') — DELETE fisik TIDAK PERNAH
  -- dilakukan (histori jurnal/penyusutan harus tetap valid), lihat
  -- AsetService.hapusAset(). updated_at NULLABLE (baris lama sebelum
  -- kolom ini ada tidak pernah diedit, jadi wajar NULL).
  status TEXT NOT NULL DEFAULT 'AKTIF',
  updated_at TEXT,
  -- Prioritas 8/J (Aset Tak Berwujud): diskriminator jenis aset —
  -- REUSE tabel aset_tetap & aset_penyusutan yang sudah ada (bukan
  -- tabel baru), sesuai instruksi "gunakan pola existing aset tetap
  -- sebanyak mungkin, jangan bikin tabel baru kalau bisa dipakai
  -- dengan aman". DEFAULT 'TETAP' aman untuk seluruh baris lama.
  jenis_aset TEXT NOT NULL DEFAULT 'TETAP' CHECK (jenis_aset IN ('TETAP','TAK_BERWUJUD')),
  -- PHASE 5 (permintaan pengguna §G): hubungan NYATA (FK) ke
  -- aset_klasifikasi — SEBELUMNYA kelompok_aset/sub_kelompok_aset di
  -- atas HANYA teks bebas (tidak divalidasi terhadap master data).
  -- Kolom ini nullable & TIDAK menggantikan dua kolom teks di atas
  -- (tetap dipertahankan untuk kompatibilitas mundur & sebagai
  -- snapshot historis yang stabil meski nama klasifikasi berubah) —
  -- diisi OTOMATIS oleh AsetService lewat pencarian
  -- kelompok+sub_kelompok ke aset_klasifikasi (UNIQUE(kelompok,
  -- sub_kelompok) sudah ada), TIDAK memerlukan perubahan kontrak UI
  -- pada form Pembelian Aset yang sudah benar (§F/§G).
  aset_klasifikasi_id TEXT REFERENCES aset_klasifikasi(id)
);

-- ============================================================
-- 9c-quater. ASET KLASIFIKASI — master data kelompok/sub-kelompok
--     aset tetap + masa manfaat default (Bagian G permintaan
--     pengguna). SENGAJA kosong tanpa data bawaan (bukan tabel
--     kebijakan angka SAK yang "dikarang" — lihat catatan di
--     AsetKlasifikasiService.ts) — admin yang mengisi lewat layar
--     "Data Klasifikasi Aset" (hub Input Data) sesuai kebutuhan
--     koperasi masing-masing, dipakai form Pembelian Aset supaya
--     Kelompok -> Sub Kelompok -> Masa Manfaat terisi otomatis
--     begitu Sub Kelompok dipilih (tetap bisa diedit manual).
-- ============================================================
CREATE TABLE IF NOT EXISTS aset_klasifikasi (
  id TEXT PRIMARY KEY,
  kelompok TEXT NOT NULL,
  sub_kelompok TEXT NOT NULL,
  -- Audit ulang (permintaan pengguna §18): SEKARANG nullable — dulu
  -- NOT NULL. Kelompok 5 "Lainnya" tidak punya masa manfaat pasti;
  -- NULL berarti "belum ditentukan", form aset akan meminta input
  -- manual (lihat AsetKlasifikasiService.ts/defaultAsetKlasifikasi.ts).
  -- Untuk instalasi LAMA yang tabelnya sudah terlanjur NOT NULL, lihat
  -- migration v29 di db.ts (rebuild tabel, data existing tidak berubah).
  masa_manfaat_bulan_default INTEGER,
  aktif INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(kelompok, sub_kelompok)
);
CREATE INDEX IF NOT EXISTS idx_aset_klasifikasi_kelompok ON aset_klasifikasi(kelompok);

-- ============================================================
-- 9c-quinque. SALDO AWAL AKUN — Bagian H (permintaan pengguna):
--     saldo awal untuk AKUN APA PUN (bukan cuma Kas Umum/Kas Kecil
--     seperti "catatSaldoAwalKas" di KasBankService.ts yang sudah
--     ada — fungsi itu TETAP ADA & TIDAK diubah untuk kompatibilitas
--     mundur, tapi menu "Saldo Awal" di hub Input Data sekarang
--     mengarah ke fitur yang lebih umum ini). SATU baris per akun
--     (UNIQUE(account_id)) — untuk mengganti nilai, pakai Edit
--     (reversal jurnal lama + jurnal baru, BUKAN mengedit jurnal
--     yang sudah posted langsung — prinsip yang sama dipakai
--     koreksiTransaksiKasBank/koreksiSimpanan).
-- ============================================================
CREATE TABLE IF NOT EXISTS saldo_awal_akun (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  tanggal TEXT NOT NULL,
  saldo INTEGER NOT NULL,
  journal_id TEXT REFERENCES journal(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id)
);

-- ============================================================
-- 9c-bis. INVESTASI — penyertaan/investasi koperasi pada unit usaha
--     sendiri (mis. unit usaha toko/simpan pinjam yang dikelola
--     terpisah) atau koperasi lain. Sub-fitur "Investasi" (menu
--     Pengeluaran, dikelompokkan dengan Kewajiban) — uang KELUAR dari
--     kas/bank koperasi, dicatat sebagai ASET (penyertaan), BUKAN
--     beban — karena koperasi berhak atas nilai/hasil investasi itu
--     di masa depan (persis seperti membeli aset, cuma bentuknya
--     penyertaan modal, bukan barang fisik).
-- ============================================================
CREATE TABLE IF NOT EXISTS investasi (
  id TEXT PRIMARY KEY,
  nomor_investasi TEXT NOT NULL UNIQUE,
  -- Audit ulang (permintaan pengguna §2/§3/§4): 5 jenis investasi baru
  -- ditambahkan ke CHECK constraint — 'UNIT_USAHA' TETAP ada di daftar
  -- HANYA untuk kompatibilitas mundur (histori lama, TIDAK bisa dipilih
  -- untuk transaksi baru lagi sejak Phase 18 §2 — lihat InvestasiService.ts).
  jenis_investasi TEXT NOT NULL CHECK (jenis_investasi IN (
    'UNIT_USAHA','KOPERASI_LAIN','USAHA_LAIN',
    'TABUNGAN_BANK_UMUM','GIRO_BANK_UMUM','DEPOSITO_BANK_UMUM','PROPERTI_INVESTASI'
  )),
  nama_tujuan TEXT NOT NULL,          -- nama unit usaha / koperasi lain / usaha lain / bank / properti tujuan investasi
  jumlah INTEGER NOT NULL,
  tanggal TEXT NOT NULL,
  sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
  bank_account_id TEXT REFERENCES bank_account(id),
  -- Revisi KOPKU (Bagian 1): nama bank TUJUAN investasi (hanya relevan
  -- untuk jenis Bank Umum — TABUNGAN/GIRO/DEPOSITO_BANK_UMUM) — HARUS
  -- dipilih dari "Data Bank" (bank_account, layar RekeningListScreen),
  -- BUKAN teks bebas. SENGAJA kolom TERPISAH dari bank_account_id di
  -- atas — bank_account_id adalah SUMBER DANA (rekening asal, hanya
  -- terisi kalau sumber_dana = 'BANK'), sedangkan bank_tujuan_id ini
  -- adalah bank TUJUAN investasi (Data Bank mana investasi ini
  -- ditempatkan) — dua konsep berbeda yang KEBETULAN sama-sama
  -- menunjuk ke tabel bank_account yang sama (tidak ada tabel bank
  -- kedua, sesuai instruksi eksplisit audit ini). NULL untuk jenis
  -- investasi selain Bank Umum.
  bank_tujuan_id TEXT REFERENCES bank_account(id),
  keterangan TEXT,
  -- Audit ulang §5: field OPSIONAL, relevan HANYA untuk jenis tertentu
  -- (nomor_rekening_investasi -> Bank Umum; lokasi_properti -> Properti
  -- Investasi) — NULL untuk jenis lain, TIDAK memengaruhi jenis lama.
  nomor_rekening_investasi TEXT,
  lokasi_properti TEXT,
  journal_id TEXT REFERENCES journal(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Update pasca-Phase 18 §11 (permintaan pengguna): Edit/Delete —
  -- pola SAMA PERSIS dengan rak_transaksi (status AKTIF/DIBATALKAN +
  -- reversal_of_id untuk audit trail edit, updated_at).
  status TEXT NOT NULL DEFAULT 'AKTIF',
  reversal_of_id TEXT REFERENCES investasi(id),
  -- RC-S53 corrective (v64) — parameter penyusutan properti investasi.
  -- SELURUHNYA NULLABLE dan TANPA nilai bawaan: service menolak
  -- memproses penyusutan selama salah satunya kosong.
  jenis_objek_properti TEXT CHECK (jenis_objek_properti IN ('TANAH','BANGUNAN','TANAH_DAN_BANGUNAN')),
  nilai_dapat_disusutkan INTEGER,
  nilai_residu_properti INTEGER,
  masa_manfaat_bulan_properti INTEGER,
  tanggal_mulai_penyusutan TEXT,
  updated_at TEXT,
  -- v72 — tanggal jatuh tempo (relevan untuk Deposito Berjangka). NULL = tidak dicatat.
  tanggal_jatuh_tempo TEXT
);
CREATE INDEX IF NOT EXISTS idx_investasi_tanggal ON investasi(tanggal);

-- ============================================================
-- v72 — PENARIKAN DANA INVESTASI (sebagian & terakhir)
-- ============================================================
-- Satu baris per transaksi penarikan yang diposting lewat
-- PenarikanInvestasiService. Aturan (keputusan pengguna):
--   SEBAGIAN   : nilai tercatat berkurang SEBESAR dana ditarik
--                (Dr Kas/Bank, Cr akun investasi), tanpa untung/rugi.
--   SELURUHNYA : sisa nilai tercatat dihentikan pengakuannya; selisih
--                dana diterima vs sisa nilai tercatat = untung/rugi
--                (mapping PELEPASAN_INVESTASI existing).
-- Bunga deposito (opsional) dicatat pada transaksi DB yang sama lewat
-- jalur Pendapatan Bunga Deposito existing (journal_bunga_id).
CREATE TABLE IF NOT EXISTS investasi_penarikan (
  id TEXT PRIMARY KEY,
  investasi_id TEXT NOT NULL REFERENCES investasi(id),
  tanggal TEXT NOT NULL,
  jenis TEXT NOT NULL CHECK (jenis IN ('SEBAGIAN','SELURUHNYA')),
  pokok_ditarik INTEGER NOT NULL,
  dana_diterima INTEGER NOT NULL,
  selisih INTEGER NOT NULL DEFAULT 0,
  bunga_diterima INTEGER NOT NULL DEFAULT 0,
  sumber_dana TEXT CHECK (sumber_dana IN ('KAS','BANK')),
  bank_account_id TEXT REFERENCES bank_account(id),
  journal_id TEXT NOT NULL REFERENCES journal(id),
  journal_bunga_id TEXT REFERENCES journal(id),
  keterangan TEXT,
  idempotency_key TEXT UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_investasi_penarikan_investasi ON investasi_penarikan(investasi_id);

-- ============================================================
-- 9c-sexies. IMPAIRMENT INVESTASI (Phase 17 §8) — register per
--     evaluasi (BEDA dengan pola Penyisihan Piutang yang murni
--     dihitung ulang dari aging & tidak punya tabel register sendiri):
--     nilai impairment investasi TIDAK BISA dihitung otomatis dari
--     rumus/skedul apa pun (investasi di sini semuanya penyertaan
--     tidak likuid tanpa harga pasar) — jadi setiap evaluasi adalah
--     KEPUTUSAN/JUDGEMENT pengurus yang didokumentasikan (indikasi,
--     dasar penilaian, nilai), bukan angka hasil kalkulasi. Register
--     inilah yang menyimpan histori keputusan tsb per investasi.
--     TIDAK REVERSIBLE by design (lihat AccountingPolicyService.ts) —
--     kolom untuk reversal SENGAJA tidak ada, konsisten dengan
--     kebijakan "impairment investasi bersifat permanen".
-- ============================================================
CREATE TABLE IF NOT EXISTS investasi_impairment (
  id TEXT PRIMARY KEY,
  investasi_id TEXT NOT NULL REFERENCES investasi(id),
  tanggal TEXT NOT NULL,
  nilai_tercatat_sebelum INTEGER NOT NULL, -- nilai tercatat investasi sebelum evaluasi ini (dari ledger, snapshot)
  indikasi_penurunan_nilai TEXT NOT NULL,  -- indikator SAK EP yang dipilih pengurus (checklist, digabung jadi teks)
  dasar_penilaian TEXT NOT NULL,           -- narasi dasar penentuan nilai yang dapat dipulihkan
  nilai_impairment INTEGER NOT NULL CHECK (nilai_impairment > 0),
  alasan TEXT NOT NULL,
  journal_id TEXT NOT NULL REFERENCES journal(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_investasi_impairment_investasi ON investasi_impairment(investasi_id);
CREATE INDEX IF NOT EXISTS idx_investasi_impairment_tanggal ON investasi_impairment(tanggal);

-- ============================================================
-- 9c-septies. BAGIAN SHU DARI INVESTASI (RC-S53, KEPUTUSAN 04-A &
--     KEPUTUSAN 05 — schema v63).
--
--     Register pengakuan hak koperasi atas bagian SHU dari koperasi
--     lain tempat dana ditempatkan. SATU BARIS = SATU PERISTIWA HAK
--     yang sudah dibuktikan dokumen, BUKAN estimasi dan BUKAN
--     informasi informal.
--
--     KENAPA REGISTER TERSENDIRI, BUKAN KOLOM DI investasi. Satu
--     penempatan investasi menghasilkan bagian SHU BERULANG (sekali
--     per tahun buku investee). Menyimpannya sebagai kolom hanya
--     memuat satu peristiwa dan menimpa yang sebelumnya — jejak
--     pengakuan periode lalu hilang. Pola register ini sama persis
--     dengan investasi_impairment di atas.
--
--     ARAH JURNAL (KEPUTUSAN 04-A):
--       pengakuan  : Dr 1-1220 Piutang Pendapatan Investasi
--                    Cr 4-1300 Pendapatan Hasil Investasi
--       penerimaan : Dr Kas/Bank
--                    Cr 1-1220 Piutang Pendapatan Investasi
--     Penerimaan kas HANYA menutup piutang — ia TIDAK pernah
--     mengakui pendapatan kedua kali.
--
--     IDEMPOTENCY. Indeks unik di bawah adalah identity yang
--     ditetapkan KEPUTUSAN 04-A: investasi + tanggal hak + jenis
--     hasil + nomor dokumen bukti. Submit ganda dan retry ditolak
--     oleh database, bukan oleh pengecekan di layer aplikasi saja.
--
--     jenis_hasil sengaja memakai CHECK berisi SATU nilai. Jenis hasil
--     imbal hasil tetap TIDAK dimasukkan karena KEPUTUSAN 06 menyatakan
--     hak kontraktualnya belum tersedia pada baseline ini — menambahkan
--     nilainya sekarang berarti menyiratkan mekanisme yang memang tidak
--     ada.
-- ============================================================
CREATE TABLE IF NOT EXISTS investasi_bagian_shu (
  id TEXT PRIMARY KEY,
  investasi_id TEXT NOT NULL REFERENCES investasi(id),
  jenis_hasil TEXT NOT NULL DEFAULT 'BAGIAN_SHU' CHECK (jenis_hasil IN ('BAGIAN_SHU')),
  tanggal_hak TEXT NOT NULL,             -- tanggal peristiwa hak (pengesahan/penetapan pembagian oleh investee)
  jumlah INTEGER NOT NULL CHECK (jumlah > 0),
  jenis_dokumen TEXT NOT NULL,           -- mis. 'Berita Acara RAT', 'Keputusan Pembagian SHU'
  nomor_dokumen TEXT NOT NULL,           -- referensi bukti hak; bagian dari identity idempotensi
  tanggal_dokumen TEXT NOT NULL,
  keterangan TEXT,
  journal_id TEXT NOT NULL REFERENCES journal(id),
  jumlah_diterima INTEGER NOT NULL DEFAULT 0 CHECK (jumlah_diterima >= 0),
  status TEXT NOT NULL DEFAULT 'DIAKUI' CHECK (status IN ('DIAKUI','LUNAS')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bagian_shu_identity
  ON investasi_bagian_shu(investasi_id, tanggal_hak, jenis_hasil, nomor_dokumen);
CREATE INDEX IF NOT EXISTS idx_bagian_shu_investasi ON investasi_bagian_shu(investasi_id);
CREATE INDEX IF NOT EXISTS idx_bagian_shu_status ON investasi_bagian_shu(status);

-- Penerimaan kas atas bagian SHU yang SUDAH diakui. Tabel anak supaya
-- penerimaan bertahap tetap terlacak satu per satu, dan supaya
-- rekonsiliasi piutang dapat dibuktikan baris per baris.
CREATE TABLE IF NOT EXISTS investasi_bagian_shu_penerimaan (
  id TEXT PRIMARY KEY,
  bagian_shu_id TEXT NOT NULL REFERENCES investasi_bagian_shu(id),
  tanggal TEXT NOT NULL,
  jumlah INTEGER NOT NULL CHECK (jumlah > 0),
  sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
  bank_account_id TEXT REFERENCES bank_account(id),
  nomor_referensi TEXT NOT NULL,
  journal_id TEXT NOT NULL REFERENCES journal(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bagian_shu_penerimaan_identity
  ON investasi_bagian_shu_penerimaan(bagian_shu_id, nomor_referensi);
CREATE INDEX IF NOT EXISTS idx_bagian_shu_penerimaan_tanggal ON investasi_bagian_shu_penerimaan(tanggal);

-- ============================================================
-- 9c-octies. PENYUSUTAN PROPERTI INVESTASI (RC-S53 corrective,
--     schema v64).
--
--     KENAPA ADA. POLICY 03 menetapkan MODEL BIAYA. Di bawah model
--     biaya, properti investasi dicatat sebesar biaya perolehan
--     DIKURANGI akumulasi penyusutan DAN akumulasi penurunan nilai.
--     Sampai v63 aplikasi ini hanya punya akumulasi penurunan nilai;
--     tidak ada satu pun jalur yang menyusutkan akun investasi
--     (PenyusutanService bekerja atas aset_tetap). Register di bawah
--     menutup celah itu.
--
--     KENAPA PARAMETERNYA DISIMPAN DI investasi, BUKAN DIKARANG.
--     Sifat objek, nilai yang dapat disusutkan, nilai residu, masa
--     manfaat, dan tanggal mulai penyusutan adalah FAKTA tentang
--     properti koperasi. Tidak ada satu pun yang boleh punya nilai
--     bawaan: seluruh kolom di bawah NULLABLE, dan service menolak
--     memproses penyusutan selama salah satunya masih kosong. Pola
--     yang sama dipakai aset_klasifikasi, yang juga sengaja dibiarkan
--     kosong tanpa angka SAK bawaan.
--
--     TANAH TIDAK DISUSUTKAN. jenis_objek_properti memisahkan tanah
--     dari bangunan TANPA memecah akun COA — POLICY 02 (OPTION A)
--     tetap berlaku, 1-1660 tetap satu akun. Yang dipisahkan di
--     sini adalah DATA, bukan struktur akun.
--
--     OBJEK CAMPURAN. Untuk 'TANAH_DAN_BANGUNAN', nilai bangunan
--     wajib dinyatakan sendiri di nilai_dapat_disusutkan. Bila
--     kosong, service menolak dan melaporkannya sebagai DATA GAP —
--     tidak ada estimasi otomatis, karena menebak porsi bangunan
--     berarti menghasilkan penyusutan yang salah.
-- ============================================================
CREATE TABLE IF NOT EXISTS investasi_penyusutan (
  id TEXT PRIMARY KEY,
  investasi_id TEXT NOT NULL REFERENCES investasi(id),
  periode TEXT NOT NULL,                 -- 'YYYY-MM'
  tanggal TEXT NOT NULL,                 -- selalu tanggal akhir periode
  nilai_penyusutan INTEGER NOT NULL CHECK (nilai_penyusutan > 0),
  journal_id TEXT NOT NULL REFERENCES journal(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (investasi_id, periode)
);
CREATE INDEX IF NOT EXISTS idx_investasi_penyusutan_investasi
  ON investasi_penyusutan(investasi_id);
CREATE INDEX IF NOT EXISTS idx_investasi_penyusutan_periode
  ON investasi_penyusutan(periode);

-- ============================================================
-- 9c-quinquies. RAK — REKENING ANTAR KANTOR (Phase 18 §3, permintaan
--     pengguna). Menu Transaksi -> Pengeluaran, tepat di atas Investasi.
--     Dana KELUAR dari kas/bank koperasi ke unit/kantor lain — dicatat
--     sebagai ASET (piutang/penempatan antar kantor, akun 1-1800),
--     BUKAN beban — persis pola yang sama dengan Investasi (koperasi
--     tetap punya klaim atas dana tsb). 'jenis_rak' murni kategorisasi
--     pelaporan (dua-duanya sama-sama DEBIT RAK/KREDIT Kas-Bank secara
--     akuntansi) — app ini tidak punya master data "kantor/unit" lain
--     untuk membangun buku besar antar-kantor timbal-balik sungguhan,
--     jadi sengaja TIDAK dibuat pura-pura reciprocal ledger yang malah
--     bisa salah/tidak konsisten dengan struktur akuntansi existing.
--     'status'+'reversal_of_id' mengikuti pola koreksi
--     KasBankService.koreksiTransaksiKasBank (reversal jurnal, bukan
--     hapus/replace fisik baris lama).
-- ============================================================
CREATE TABLE IF NOT EXISTS rak_transaksi (
  id TEXT PRIMARY KEY,
  nomor_rak TEXT NOT NULL UNIQUE,
  jenis_rak TEXT NOT NULL CHECK (jenis_rak IN ('PENYALURAN_DANA','SETORAN_DANA')),
  nama_unit TEXT NOT NULL,
  -- v62 (RAKU): referensi ke master unit usaha. NULLABLE karena baris
  -- lama hanya punya nama_unit berupa teks bebas dan tidak dapat
  -- dipetakan ulang secara otomatis tanpa menebak.
  unit_usaha_id TEXT REFERENCES koperasi_unit_usaha(id),
  -- v62 (RAKU): jenis alokasi. NULL untuk baris lama.
  jenis_alokasi TEXT CHECK (jenis_alokasi IN ('MODAL_TETAP','MODAL_TAMBAHAN','OPERASIONAL')),
  jumlah INTEGER NOT NULL,
  tanggal TEXT NOT NULL,
  sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
  bank_account_id TEXT REFERENCES bank_account(id),
  keterangan TEXT,
  status TEXT NOT NULL CHECK (status IN ('AKTIF','DIBATALKAN')) DEFAULT 'AKTIF',
  journal_id TEXT REFERENCES journal(id),
  reversal_of_id TEXT REFERENCES rak_transaksi(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rak_tanggal ON rak_transaksi(tanggal);
CREATE INDEX IF NOT EXISTS idx_rak_status ON rak_transaksi(status);

-- ============================================================
-- 9c-ter. DATA REFERENSI — master data ringan untuk hub "Input Data"
--     (sebelumnya nav "Kas & Bank" di menu Transaksi): Pemasok
--     (dipakai form Pembelian Aset kredit), Pemberi Pinjaman Bank/
--     Pihak Lain (dipakai form Utang), Beban Lain (referensi
--     nama/deskripsi beban lain-lain). SENGAJA satu tabel generik
--     (bukan 4 tabel terpisah) — semuanya sama-sama "nama + keterangan
--     + aktif", tidak ada field yang beda per jenis. Bukan pengganti
--     "account"/"utang"/"aset_tetap" — murni referensi nama supaya
--     tidak perlu mengetik ulang nama yang sama di form transaksi
--     setiap kali (dan bisa dinonaktifkan tanpa menghapus histori
--     transaksi lama yang sudah memakai nama itu sebagai teks bebas).
-- ============================================================
CREATE TABLE IF NOT EXISTS data_referensi (
  id TEXT PRIMARY KEY,
  jenis TEXT NOT NULL CHECK (jenis IN ('PEMASOK','PEMBERI_PINJAMAN_BANK','PEMBERI_PINJAMAN_PIHAK_LAIN','BEBAN_LAIN')),
  nama TEXT NOT NULL,
  keterangan TEXT,
  alamat TEXT,
  aktif INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_data_referensi_jenis ON data_referensi(jenis);



-- Register jurnal penyusutan bulanan (garis lurus) per aset. UNIQUE
-- (aset_id, periode) adalah pengaman UTAMA anti-duplikasi di level
-- database — proses penyusutan bulan yang sama untuk aset yang sama
-- akan ditolak oleh constraint ini walau ada bug di level aplikasi.
CREATE TABLE IF NOT EXISTS aset_penyusutan (
  id TEXT PRIMARY KEY,
  aset_id TEXT NOT NULL REFERENCES aset_tetap(id),
  periode TEXT NOT NULL,              -- format 'YYYY-MM'
  tanggal TEXT NOT NULL,               -- tanggal jurnal (akhir bulan periode)
  nilai_penyusutan INTEGER NOT NULL,
  journal_id TEXT NOT NULL REFERENCES journal(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(aset_id, periode)
);
CREATE INDEX IF NOT EXISTS idx_aset_penyusutan_aset ON aset_penyusutan(aset_id);
CREATE INDEX IF NOT EXISTS idx_aset_penyusutan_periode ON aset_penyusutan(periode);

-- ============================================================
-- 9d. PENDAPATAN DITERIMA DIMUKA — register per anggota + jangka
--     waktu (sub-fitur Penerimaan). Sama seperti aset_tetap: baru
--     mencatat penerimaannya; pengakuan pendapatan bertahap tiap
--     bulan adalah perhitungan terpisah yang bisa ditambahkan
--     kemudian, bukan bagian dari pencatatan penerimaan ini.
-- ============================================================
CREATE TABLE IF NOT EXISTS pendapatan_diterima_dimuka (
  id TEXT PRIMARY KEY,
  nomor_transaksi TEXT NOT NULL UNIQUE,
  anggota_id TEXT NOT NULL REFERENCES anggota(id),
  jumlah INTEGER NOT NULL,
  jangka_waktu_bulan INTEGER NOT NULL,
  tanggal TEXT NOT NULL,
  sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
  bank_account_id TEXT REFERENCES bank_account(id),
  status TEXT NOT NULL CHECK (status IN ('AKTIF','SELESAI')) DEFAULT 'AKTIF',
  journal_id TEXT REFERENCES journal(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pendapatan_dimuka_anggota ON pendapatan_diterima_dimuka(anggota_id);

-- Register jurnal pengakuan pendapatan bulanan per baris pendapatan
-- diterima dimuka. UNIQUE(pendapatan_dimuka_id, periode) adalah
-- pengaman anti-duplikasi di level database, sama seperti
-- aset_penyusutan di atas.
CREATE TABLE IF NOT EXISTS pendapatan_dimuka_pengakuan (
  id TEXT PRIMARY KEY,
  pendapatan_dimuka_id TEXT NOT NULL REFERENCES pendapatan_diterima_dimuka(id),
  periode TEXT NOT NULL,              -- format 'YYYY-MM'
  urutan_bulan INTEGER NOT NULL,       -- ke berapa dari jangka_waktu_bulan (1..N)
  tanggal TEXT NOT NULL,
  nilai_pengakuan INTEGER NOT NULL,
  journal_id TEXT NOT NULL REFERENCES journal(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(pendapatan_dimuka_id, periode)
);
CREATE INDEX IF NOT EXISTS idx_dimuka_pengakuan_dimuka ON pendapatan_dimuka_pengakuan(pendapatan_dimuka_id);
CREATE INDEX IF NOT EXISTS idx_dimuka_pengakuan_periode ON pendapatan_dimuka_pengakuan(periode);

-- ============================================================
-- 9e. BIAYA DIBAYAR DIMUKA (Phase 10) — kebalikan simetris dari
--     Pendapatan Diterima Dimuka di atas: alih-alih menerima uang
--     untuk kewajiban masa depan (liabilitas), ini MEMBAYAR uang
--     untuk manfaat masa depan (aset). Pola & anti-duplikasi persis
--     sama (register + tabel pengakuan terpisah dengan
--     UNIQUE(entity_id, periode)).
-- ============================================================
CREATE TABLE IF NOT EXISTS biaya_dibayar_dimuka (
  id TEXT PRIMARY KEY,
  nomor_transaksi TEXT NOT NULL UNIQUE,
  nama_biaya TEXT NOT NULL,           -- deskripsi bebas, mis. "Sewa Gedung 2026", "Premi Asuransi"
  akun_beban_id TEXT NOT NULL REFERENCES account(id), -- akun Beban yang diakui bertahap tiap bulan
  jumlah INTEGER NOT NULL,
  jangka_waktu_bulan INTEGER NOT NULL,
  tanggal TEXT NOT NULL,
  sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
  bank_account_id TEXT REFERENCES bank_account(id),
  status TEXT NOT NULL CHECK (status IN ('AKTIF','SELESAI')) DEFAULT 'AKTIF',
  journal_id TEXT REFERENCES journal(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS biaya_dimuka_pengakuan (
  id TEXT PRIMARY KEY,
  biaya_dimuka_id TEXT NOT NULL REFERENCES biaya_dibayar_dimuka(id),
  periode TEXT NOT NULL,
  urutan_bulan INTEGER NOT NULL,
  tanggal TEXT NOT NULL,
  nilai_pengakuan INTEGER NOT NULL,
  journal_id TEXT NOT NULL REFERENCES journal(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(biaya_dimuka_id, periode)
);
CREATE INDEX IF NOT EXISTS idx_biaya_dimuka_pengakuan_biaya ON biaya_dimuka_pengakuan(biaya_dimuka_id);
CREATE INDEX IF NOT EXISTS idx_biaya_dimuka_pengakuan_periode ON biaya_dimuka_pengakuan(periode);

-- ============================================================
-- 9f. REKONSILIASI KAS/BANK (Phase 11) — dasar syarat sebelum
--     periode boleh ditutup ("reconciliation mismatch → period close
--     ditolak"). saldo_buku dihitung otomatis dari jurnal (getAccountBalance)
--     saat rekonsiliasi dicatat; saldo_fisik diinput manual oleh user
--     (hasil hitung uang tunai sungguhan / saldo di rekening koran bank).
-- ============================================================
CREATE TABLE IF NOT EXISTS rekonsiliasi_kas_bank (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  nama_rekening TEXT NOT NULL,        -- label tampilan, mis. "Kas", "Bank BCA - 12345"
  tanggal TEXT NOT NULL,
  saldo_buku INTEGER NOT NULL,        -- hasil getAccountBalance saat dicatat
  saldo_fisik INTEGER NOT NULL,       -- input manual user
  selisih INTEGER NOT NULL,           -- saldo_fisik - saldo_buku
  status TEXT NOT NULL CHECK (status IN ('COCOK','SELISIH')),
  -- v62: kolom PENYELESAIAN. status di atas TIDAK diubah — ia
  -- mengklasifikasikan SELISIHNYA (cocok/tidak), sedangkan kolom di
  -- bawah menyatakan apakah selisih itu sudah DITINDAKLANJUTI.
  -- Dipisah supaya CHECK lama tidak perlu dibongkar; membongkarnya
  -- berarti rebuild tabel yang sudah berisi histori.
  status_penyelesaian TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status_penyelesaian IN ('DRAFT','SELESAI')),
  -- v71: dua penyebab baru. Sebelumnya "transaksi koperasi belum
  -- dicatat" dan "bank yang salah mencatat" tidak punya kategori, jadi
  -- keduanya hanya bisa disimpan sebagai LAINNYA + catatan bebas —
  -- penyebabnya hilang dari audit trail, dan keduanya punya tindak
  -- lanjut yang sama sekali berbeda (catat transaksi vs hubungi bank).
  penyebab TEXT CHECK (penyebab IN
    ('TRANSAKSI_BELUM_TERCATAT','TIMING_DIFFERENCE','BIAYA_ADMIN_BANK','JASA_GIRO',
     'SELISIH_PENCATATAN','SELISIH_FISIK','KESALAHAN_BANK','LAINNYA')),
  perlakuan TEXT CHECK (perlakuan IN ('TIDAK_PERLU_JURNAL','PERLU_JURNAL')),
  journal_id TEXT REFERENCES journal(id),
  diselesaikan_oleh TEXT,
  diselesaikan_at TEXT,
  keterangan TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rekonsiliasi_account ON rekonsiliasi_kas_bank(account_id);
CREATE INDEX IF NOT EXISTS idx_rekonsiliasi_penyelesaian ON rekonsiliasi_kas_bank(status_penyelesaian);

-- ============================================================
-- 9e. PENYESUAIAN NILAI WAJAR & REVALUASI (v62, diperluas v73/RC-S88)
-- ============================================================
-- Satu register untuk dua objek pengukuran SAK EP:
--   PROPERTI_INVESTASI -> model nilai wajar, selisih ke LABA RUGI
--                         (Bab 16; 4-2100 / 5-5000, penyesuai 1-1665)
--   ASET_TETAP         -> model revaluasi, kenaikan ke OCI/ekuitas
--                         (Bab 17; 3-6000, rugi 5-5100, pemulihan 4-2200,
--                          penyesuai 1-1520)
-- Tepat satu dari investasi_id / aset_tetap_id terisi, sesuai objek.
--
-- Siklus: DRAFT -> DIPOSTING (jurnal terbentuk, final) atau
-- DRAFT -> DIBATALKAN. Baris tidak pernah dihapus. Penilaian yang sudah
-- diposting dikoreksi dengan penilaian BARU, bukan diedit.
--
-- jumlah_laba_rugi / jumlah_oci: pembagian selisih yang DIPOSTING
-- (bertanda: + menambah laba/ekuitas, − mengurangi). Diisi saat posting,
-- 0 selama DRAFT. Jumlah keduanya = selisih.
CREATE TABLE IF NOT EXISTS penyesuaian_nilai_wajar (
  id TEXT PRIMARY KEY,
  objek TEXT NOT NULL DEFAULT 'PROPERTI_INVESTASI' CHECK (objek IN ('PROPERTI_INVESTASI','ASET_TETAP')),
  investasi_id TEXT REFERENCES investasi(id),
  aset_tetap_id TEXT REFERENCES aset_tetap(id),
  tanggal TEXT NOT NULL,
  nilai_tercatat_sebelum INTEGER NOT NULL,
  nilai_wajar INTEGER NOT NULL,
  selisih INTEGER NOT NULL,
  arah_perubahan TEXT NOT NULL CHECK (arah_perubahan IN ('KENAIKAN','PENURUNAN','TIDAK_BERUBAH')),
  dasar_penilaian TEXT,
  referensi_bukti TEXT,
  penilai TEXT,
  catatan TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','DIPOSTING','DIBATALKAN')),
  jumlah_laba_rugi INTEGER NOT NULL DEFAULT 0,
  jumlah_oci INTEGER NOT NULL DEFAULT 0,
  journal_id TEXT REFERENCES journal(id),
  diposting_oleh TEXT,
  diposting_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((objek = 'PROPERTI_INVESTASI' AND investasi_id IS NOT NULL AND aset_tetap_id IS NULL)
      OR (objek = 'ASET_TETAP' AND aset_tetap_id IS NOT NULL AND investasi_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_nilai_wajar_investasi ON penyesuaian_nilai_wajar(investasi_id);
CREATE INDEX IF NOT EXISTS idx_nilai_wajar_aset ON penyesuaian_nilai_wajar(aset_tetap_id);
CREATE INDEX IF NOT EXISTS idx_nilai_wajar_status ON penyesuaian_nilai_wajar(status);
CREATE INDEX IF NOT EXISTS idx_rekonsiliasi_tanggal ON rekonsiliasi_kas_bank(tanggal);

-- ============================================================
-- 10. SHU (PRD §29)
-- ============================================================
CREATE TABLE IF NOT EXISTS shu_konfigurasi (
  id TEXT PRIMARY KEY,
  tahun_buku INTEGER NOT NULL UNIQUE,
  persen_cadangan REAL NOT NULL DEFAULT 0,
  persen_jasa_modal REAL NOT NULL DEFAULT 0,
  persen_jasa_usaha REAL NOT NULL DEFAULT 0,
  persen_pendidikan REAL NOT NULL DEFAULT 0,
  persen_sosial REAL NOT NULL DEFAULT 0,
  persen_pengurus REAL NOT NULL DEFAULT 0,
  persen_pengawas REAL NOT NULL DEFAULT 0,
  -- Update pasca-Phase 18/19 (permintaan pengguna §U): 2 komponen
  -- distribusi baru — Karyawan & Pembangunan Daerah Kerja. Default 0
  -- aman untuk instalasi lama (lihat migration v24 di db.ts) — total
  -- 100% tetap tervalidasi karena kolom lama tidak berubah nilainya.
  persen_karyawan REAL NOT NULL DEFAULT 0,
  persen_pembangunan_daerah_kerja REAL NOT NULL DEFAULT 0,
  -- Audit ulang (permintaan pengguna §13/§16): komponen distribusi baru
  -- "Cadangan Risiko" — DEFAULT 0 aman untuk instalasi lama (lihat
  -- migration v30 di db.ts, ADD COLUMN dengan DEFAULT 0 — TIDAK
  -- mengubah nilai persentase komponen lain yang sudah tersimpan).
  -- Total 100% tetap tervalidasi karena kolom lama tidak berubah.
  persen_cadangan_risiko REAL NOT NULL DEFAULT 0,
  -- "persen_lainnya"/"Lainnya (%)" DIHAPUS dari skema instalasi BARU
  -- (audit ulang §5/§6/§7, permintaan pengguna) — bukan lagi komponen
  -- distribusi SHU. Instalasi LAMA yang sudah punya kolom ini (dibuat
  -- sebelum perubahan ini) TETAP menyimpannya secara fisik untuk
  -- kompatibilitas skema (tidak di-DROP oleh migration — lihat db.ts),
  -- tapi kolom ini TIDAK dibaca/ditulis lagi oleh logic SHU baru
  -- (ShuCalculator.ts/ShuService.ts) maupun ditampilkan di UI.
  total_shu INTEGER,
  -- ============================================================
  -- Audit ulang (permintaan pengguna, request baru — pemisahan SHU
  -- akrual/RAT/dibagikan): "total_shu" di atas TETAP berarti "SHU
  -- Laporan Keuangan" (basis AKRUAL, dari getLabaRugi — TIDAK PERNAH
  -- diubah oleh apa pun di bawah ini, termasuk keputusan RAT). Kolom
  -- baru berikut menyimpan TIGA nilai SHU tambahan yang harus tetap
  -- TERPISAH dari total_shu (§1 permintaan pengguna):
  --   shu_informasi_rat   -> "Informasi SHU RAT" (basis KAS/realisasi,
  --                          dihitung dari jurnal kas/bank yang sama,
  --                          BUKAN transaksi baru — lihat
  --                          FinancialReports.getInformasiShuRAT()).
  --   shu_diajukan_rat    -> nominal yang diajukan ke RAT untuk
  --                          diputuskan (admin bisa menyesuaikan dari
  --                          shu_informasi_rat sebelum diajukan).
  --   shu_disahkan_rat    -> nominal FINAL yang disahkan RAT — SATU-
  --                          SATUNYA sumber nominal untuk distribusi &
  --                          jurnal pembagian SHU (lihat bagikanSHU()
  --                          di ShuService.ts) — BUKAN total_shu, BUKAN
  --                          shu_informasi_rat.
  -- Semuanya NULLABLE (default belum ada nilai) untuk kompatibilitas
  -- mundur — baris SHU lama (termasuk yang sudah DIBAGIKAN sebelum
  -- fitur ini ada) tetap valid & tetap terbaca apa adanya.
  shu_informasi_rat INTEGER,
  shu_diajukan_rat INTEGER,
  shu_disahkan_rat INTEGER,
  -- Referensi ke keputusan RAT yang menyahkan nominal di atas (tabel
  -- "rat" sudah ada, UNIQUE(tahun_buku) — dipakai apa adanya, TIDAK
  -- membuat tabel RAT baru sesuai instruksi eksplisit §8/§12).
  rat_id TEXT REFERENCES rat(id),
  catatan_keputusan_rat TEXT,
  -- Status DIPERLUAS (§7 permintaan pengguna) — alur baru:
  --   DRAFT          : konfigurasi persentase tersimpan, belum dihitung.
  --   DIHITUNG       : SHU akrual & Informasi SHU RAT (kas) sudah
  --                    dihitung (tahap "INFORMASI RAT" pada §7).
  --   DIAJUKAN_RAT   : nominal SHU sudah diajukan untuk diputuskan RAT.
  --   DISAHKAN_RAT   : RAT sudah menetapkan nominal final
  --                    (shu_disahkan_rat terisi) — status ini SEKALIGUS
  --                    berarti "SIAP DIBAGIKAN" (§7 — tidak perlu
  --                    status DB terpisah, ditampilkan sebagai label
  --                    UI: DISAHKAN_RAT + belum DIBAGIKAN = "Siap
  --                    Dibagikan").
  --   DIBAGIKAN      : sudah diposting ke jurnal (final, seperti sebelumnya).
  -- Nilai LAMA ('DRAFT','DIHITUNG','DIBAGIKAN') semuanya TETAP ada di
  -- enum ini (superset) — baris existing dengan status tersebut TETAP
  -- valid tanpa migrasi data apa pun.
  status TEXT NOT NULL CHECK (status IN ('DRAFT','DIHITUNG','DIAJUKAN_RAT','DISAHKAN_RAT','DIBAGIKAN')) DEFAULT 'DRAFT',
  journal_id TEXT REFERENCES journal(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- v78 — SNAPSHOT kebijakan "Simpanan Sukarela sebagai Basis Jasa Modal
  -- SHU" untuk tahun buku ini (1 ikut, 0 tidak). Diisi saat SHU pertama
  -- kali dihitung; hitung ulang & pengesahan memakai nilai ini, sehingga
  -- perubahan kebijakan sesudahnya tidak mengubah tahun buku ini.
  sukarela_basis_jasa_modal INTEGER
);

CREATE TABLE IF NOT EXISTS shu_anggota (
  id TEXT PRIMARY KEY,
  shu_konfigurasi_id TEXT NOT NULL REFERENCES shu_konfigurasi(id) ON DELETE CASCADE,
  anggota_id TEXT NOT NULL REFERENCES anggota(id),
  basis_simpanan INTEGER NOT NULL DEFAULT 0,
  basis_partisipasi_usaha INTEGER NOT NULL DEFAULT 0,
  jasa_modal INTEGER NOT NULL DEFAULT 0,
  jasa_usaha INTEGER NOT NULL DEFAULT 0,
  total_shu_anggota INTEGER NOT NULL DEFAULT 0,
  UNIQUE(shu_konfigurasi_id, anggota_id)
);

-- ============================================================
-- 10b. RAT — RAPAT ANGGOTA TAHUNAN (update pasca-Phase 18 §12/§13,
--     permintaan pengguna). Satu RAT per tahun buku (UNIQUE) — dipakai
--     sebagai syarat BAGIKAN SHU (§12, ShuService.ts) dan syarat
--     PENGHAPUSAN PIUTANG (§19, PinjamanService.hapusPiutangPinjaman)
--     untuk tahun buku yang sama. tahun_buku INTEGER polos (BUKAN
--     foreign key ke accounting_period) — konsisten dengan pola
--     shu_konfigurasi.tahun_buku yang sudah ada, bukan tabel/relasi
--     baru yang terpisah dari pola existing.
-- ============================================================
CREATE TABLE IF NOT EXISTS rat (
  id TEXT PRIMARY KEY,
  tahun_buku INTEGER NOT NULL UNIQUE,
  tanggal_rat TEXT NOT NULL,
  nomor_rat TEXT,
  keterangan TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================
-- 10c. SALDO AWAL LOCK — update pasca-Phase 18/19 (permintaan
--     pengguna §H). Tabel singleton (id selalu 1) — begitu terisi,
--     seluruh saldo awal (akun & aset tetap) TERKUNCI PERMANEN, tidak
--     ada mekanisme unlock di aplikasi (sesuai instruksi eksplisit
--     "Tidak boleh ada tombol Unlock"). TERPISAH dari app_config
--     (tabel key-value generik yang SUDAH ADA sejak awal, dipakai
--     AccountingPolicyService) karena butuh audit trail eksplisit
--     siapa & kapan mengunci, bukan cuma satu nilai konfigurasi.
--     (§F — mode penyusutan otomatis/manual TIDAK butuh tabel baru:
--     dipakaikan ke app_config yang sudah ada, lihat
--     PenyusutanService.getModePenyusutan()/setModePenyusutan() —
--     audit menemukan app_config adalah persis "struktur setting
--     existing" yang instruksi minta dicek dulu sebelum bikin tabel
--     baru.)
-- ============================================================
CREATE TABLE IF NOT EXISTS saldo_awal_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  locked_at TEXT NOT NULL,
  locked_by TEXT NOT NULL
);

-- ============================================================
-- 11. AUDIT LOG (PRD §33)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tanggal TEXT NOT NULL,
  waktu TEXT NOT NULL,
  action TEXT NOT NULL,             -- CREATE, UPDATE, DELETE, POST, REVERSE, VOID, LOGIN, RESTORE, ...
  entity TEXT NOT NULL,             -- nama tabel/entitas
  entity_id TEXT,
  data_sebelum TEXT,                -- JSON snapshot
  data_sesudah TEXT,                -- JSON snapshot
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_tanggal ON audit_log(tanggal);

-- ============================================================
-- 12. CATATAN ATAS LAPORAN KEUANGAN — CALK (PRD §28)
-- ============================================================
CREATE TABLE IF NOT EXISTS calk_note (
  id TEXT PRIMARY KEY,
  period_id TEXT NOT NULL REFERENCES accounting_period(id),
  section_key TEXT NOT NULL,         -- e.g. 'informasi_umum', 'kebijakan_akuntansi', 'kas'
  konten TEXT NOT NULL,              -- markdown/plain text, auto-generated lalu editable
  is_manual_edit INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(period_id, section_key)
);

-- ============================================================
-- 13. APP CONFIG (kunci-nilai umum, non-sensitif)
-- ============================================================
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================
-- 14. NOMOR URUT DOKUMEN (untuk nomor_jurnal, nomor_transaksi, dst)
-- ============================================================
CREATE TABLE IF NOT EXISTS sequence_counter (
  seq_key TEXT PRIMARY KEY,     -- e.g. 'JURNAL-2026', 'SP-2026', 'PJ-2026'
  last_value INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- 15. PEMBERIAN PINJAMAN UNTUK KOPERASI (permintaan pengguna §8) —
-- koperasi memberikan pinjaman ke koperasi/pihak lain (BUKAN pinjaman
-- anggota, yang tetap dikelola tabel pinjaman). DEBIT Piutang
-- Pinjaman (akun 1-1200, reuse existing — lihat catatan desain di
-- defaultCOA.ts DEFAULT_ACCOUNT_MAPPING), KREDIT Kas/Bank sumber dana.
-- LEGACY: fitur runtime-nya DIHAPUS di RC-S70.2 (tidak ada menu, rute,
-- layar, atau service aktif). Definisi tabel ini DIPERTAHANKAN semata
-- untuk kompatibilitas data historis; tidak ada kode aplikasi yang
-- menulis ke sini lagi.
-- ============================================================
CREATE TABLE IF NOT EXISTS pinjaman_koperasi (
  id TEXT PRIMARY KEY,
  nomor_pinjaman TEXT NOT NULL UNIQUE,
  nama_penerima TEXT NOT NULL,        -- nama koperasi/pihak penerima pinjaman (teks bebas — belum ada master koperasi/pihak eksternal di aplikasi ini)
  nominal_pinjaman INTEGER NOT NULL,
  tanggal TEXT NOT NULL,
  sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
  bank_account_id TEXT REFERENCES bank_account(id),
  keterangan TEXT,
  status TEXT NOT NULL DEFAULT 'AKTIF' CHECK (status IN ('AKTIF','DIBATALKAN')),
  reversal_of_id TEXT REFERENCES pinjaman_koperasi(id),
  journal_id TEXT REFERENCES journal(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pinjaman_koperasi_status ON pinjaman_koperasi(status);

-- ============================================================
-- 40. RIWAYAT IMPORT DATA AWAL (RC-S100, permintaan pengguna:
--     "riwayat hasil import data awal menampilkan log berhasil dan
--     error").
--
-- Sebelum ini hasil import HANYA tampil di layar sesaat setelah proses
-- selesai: begitu layar ditinggalkan, daftar baris yang gagal beserta
-- alasannya HILANG — padahal justru itulah yang dibutuhkan untuk
-- memperbaiki berkas Excel-nya. Dua tabel: satu baris ringkasan per
-- sekali import, dan satu baris log per baris Excel yang diproses.
--
-- Kolom dijalankan_oleh SENGAJA TIDAK ber-foreign key ke app_user,
-- mengikuti pola audit_log.user_id: riwayat adalah catatan peristiwa yang harus
-- tetap terbaca apa adanya walau user-nya kemudian dinonaktifkan atau
-- dihapus.
-- ============================================================
CREATE TABLE IF NOT EXISTS import_data_awal_riwayat (
  id TEXT PRIMARY KEY,
  dijalankan_pada TEXT NOT NULL,      -- ISO, jam ASLI (bukan jam simulasi) — lihat ImportRiwayatService
  dijalankan_oleh TEXT NOT NULL,
  nama_berkas TEXT,
  status TEXT NOT NULL CHECK (status IN ('BERHASIL','SEBAGIAN','GAGAL')),
  total_baris INTEGER NOT NULL,
  total_berhasil INTEGER NOT NULL,
  total_gagal INTEGER NOT NULL,
  ringkasan_json TEXT,                -- JSON HasilPerSheet[]: jumlah berhasil/gagal per sheet
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_riwayat_waktu ON import_data_awal_riwayat(dijalankan_pada DESC);

CREATE TABLE IF NOT EXISTS import_data_awal_log (
  id TEXT PRIMARY KEY,
  riwayat_id TEXT NOT NULL REFERENCES import_data_awal_riwayat(id),
  jenis_sheet TEXT NOT NULL CHECK (jenis_sheet IN ('ANGGOTA','SIMPANAN','PINJAMAN','BERJANGKA')),
  baris INTEGER NOT NULL,             -- nomor baris pada berkas Excel, supaya bisa langsung dicari di sana
  keterangan TEXT NOT NULL,           -- kode/nama baris agar pengguna tahu baris mana yang dimaksud
  status TEXT NOT NULL CHECK (status IN ('BERHASIL','GAGAL')),
  pesan TEXT,                         -- alasan kegagalan; NULL untuk baris berhasil
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_log_riwayat ON import_data_awal_log(riwayat_id, status);

-- ============================================================
-- v78 — BUNGA HARIAN SIMPANAN SUKARELA & KEBIJAKAN BASIS JASA MODAL
-- ============================================================
-- Seluruhnya ADITIF. Lihat BungaSukarelaService.ts.
--
-- Versi kebijakan bunga — APPEND-ONLY. Kebijakan yang berlaku untuk
-- bulan M = versi dengan berlaku_mulai terbesar <= M. Versi baru hanya
-- boleh berlaku mulai bulan berikutnya, sehingga bulan yang sudah lewat
-- tidak pernah berubah tarifnya.
CREATE TABLE IF NOT EXISTS bunga_sukarela_kebijakan (
  id TEXT PRIMARY KEY,
  berlaku_mulai TEXT NOT NULL,          -- 'YYYY-MM'
  aktif INTEGER NOT NULL CHECK (aktif IN (0,1)),
  tarif_persen REAL NOT NULL DEFAULT 0,  -- per tahun, basis 365 hari
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bunga_skr_kebijakan ON bunga_sukarela_kebijakan(berlaku_mulai);
-- Satu proses akrual per bulan (satu jurnal). Idempoten lewat indeks unik
-- parsial: hanya satu proses POSTED per periode.
CREATE TABLE IF NOT EXISTS bunga_sukarela_proses (
  id TEXT PRIMARY KEY,
  periode TEXT NOT NULL,                -- 'YYYY-MM'
  tanggal TEXT NOT NULL,                -- akhir bulan (tanggal jurnal)
  tarif_persen REAL NOT NULL,
  jumlah_anggota INTEGER NOT NULL DEFAULT 0,
  total_bruto INTEGER NOT NULL DEFAULT 0,
  total_pajak INTEGER NOT NULL DEFAULT 0,
  total_netto INTEGER NOT NULL DEFAULT 0,
  total_koreksi_bruto INTEGER NOT NULL DEFAULT 0,
  journal_id TEXT REFERENCES journal(id),
  status TEXT NOT NULL CHECK (status IN ('POSTED','DIBATALKAN')),
  alasan_batal TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dibatalkan_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bunga_skr_proses_aktif ON bunga_sukarela_proses(periode) WHERE status = 'POSTED';
-- Audit trail per anggota per bulan bunga. jenis BUNGA = bunga bulan
-- proses; KOREKSI = selisih bunga bulan lalu akibat transaksi bertanggal
-- mundur / koreksi / pembatalan (dibukukan di proses berikutnya).
-- ruas_saldo = JSON [{dari,sampai,hari,saldo}] — dasar audit per hari.
CREATE TABLE IF NOT EXISTS bunga_sukarela_rincian (
  id TEXT PRIMARY KEY,
  proses_id TEXT NOT NULL REFERENCES bunga_sukarela_proses(id),
  anggota_id TEXT NOT NULL REFERENCES anggota(id),
  periode_bunga TEXT NOT NULL,          -- bulan yang bunganya dihitung
  jenis TEXT NOT NULL CHECK (jenis IN ('BUNGA','KOREKSI')),
  tarif_persen REAL NOT NULL,
  jumlah_hari INTEGER NOT NULL,
  saldo_hari REAL NOT NULL,             -- jumlah (saldo berbunga x hari)
  saldo_awal INTEGER NOT NULL,
  saldo_akhir INTEGER NOT NULL,
  bruto INTEGER NOT NULL,
  pajak INTEGER NOT NULL,
  netto INTEGER NOT NULL,
  ruas_saldo TEXT NOT NULL,
  simpanan_transaksi_id TEXT REFERENCES simpanan_transaksi(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bunga_skr_rincian_proses ON bunga_sukarela_rincian(proses_id);
CREATE INDEX IF NOT EXISTS idx_bunga_skr_rincian_anggota ON bunga_sukarela_rincian(anggota_id, periode_bunga);
-- Versi kebijakan "Simpanan Sukarela sebagai Basis Jasa Modal SHU" —
-- APPEND-ONLY, per tahun buku. Tidak ada baris = OFF (instalasi baru,
-- mengikuti Juklat). Migrasi v78 menulis baris (0, 1) untuk instalasi
-- lama sehingga perilaku sebelumnya (sukarela ikut basis) dipertahankan.
CREATE TABLE IF NOT EXISTS kebijakan_basis_jasa_modal (
  id TEXT PRIMARY KEY,
  berlaku_mulai_tahun INTEGER NOT NULL,
  sukarela_ikut INTEGER NOT NULL CHECK (sukarela_ikut IN (0,1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

`;

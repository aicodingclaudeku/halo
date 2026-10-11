import { withTransaction, getDb } from '@/database/db';
import { newId } from '@/utils/id';
import {
  DEFAULT_ACCOUNTS,
  DEFAULT_ACCOUNT_MAPPING,
  StandarAkuntansi,
  STANDAR_AKUNTANSI_DEFAULT,
} from '@/config/defaultCOA';
import { DEFAULT_ASET_KLASIFIKASI } from '@/config/defaultAsetKlasifikasi';
import { hashPin, generateSalt } from '@/security/pin';
// Konstanta versi diambil LANGSUNG dari modul murninya, bukan lewat
// `@/security/pin`: modul itu di-mock sebagian di banyak suite, dan
// konstanta yang hilang dari mock akan terkirim ke SQLite sebagai
// undefined — gagal saat bind, bukan saat kompilasi.
import { VERSI_HASH_PIN_SEKARANG } from '@/security/pinHash';
import { periksaPassword, rapikanPassword } from '@/security/kebijakanPassword';
import { periksaUsername, rapikanUsername } from '@/security/kebijakanUsername';
import {
  setPinEnabledPadaDb,
  tandaiPinBelumDitetapkanPadaDb,
} from '@/services/SecurityService';

/**
 * Setup wizard (PRD §4-6). Dijalankan SEKALI saat aplikasi pertama kali
 * dipakai. Membuat:
 *  1. Baris `koperasi` (identitas + standar akuntansi terpilih)
 *  2. Periode akuntansi tahun berjalan (WAJIB agar AccountingEngine bisa
 *     membuat jurnal — tanpa ini semua transaksi akan REJECT)
 *  3. Chart of Accounts default + account_mapping (WAJIB agar
 *     resolveAccountId() tidak error saat transaksi pertama)
 *  4. User admin pertama dengan PIN (agar ada createdBy/audit yang valid
 *     dan fitur keamanan PIN yang sudah ada benar-benar terpakai)
 */

export interface SetupKoperasiInput {
  /** WAJIB. Satu dari hanya DUA field yang diminta setup awal (§8/§11). */
  nama: string;
  /** WAJIB. Field kedua & terakhir yang diminta setup awal (§8/§11). */
  tahunBuku: number;

  // ----------------------------------------------------------------
  // Semua field di bawah OPSIONAL sejak setup awal disederhanakan.
  // Identitas lengkap diisi belakangan lewat Dashboard -> Identitas
  // Koperasi (§19-§24). Tanda tangan fungsi ini SENGAJA tidak diubah
  // menjadi tipe lain: pemanggil lama yang masih mengirim seluruh field
  // (termasuk test yang sudah ada) TETAP bekerja persis seperti dulu.
  // ----------------------------------------------------------------
  nomorBadanHukum?: string;
  npwp?: string;
  alamat?: string;
  telepon?: string;
  email?: string;
  logoUri?: string;
  tanggalBerdiri?: string; // ISO date
  /*
   * RC-S39 — parameter `standarAkuntansi` DIHAPUS.
   *
   * Aplikasi hanya mengenal SAK EP, jadi tidak ada yang bisa dipilih.
   * Menyisakan parameter yang nilainya selalu sama hanya menyiratkan
   * ada pilihan yang sebenarnya tidak ada — dan mengundang seseorang
   * menghidupkannya kembali suatu saat.
   */
  adminNama?: string;
  adminUsername?: string;
  /**
   * §14: PIN OPSIONAL. Kalau diisi (6 digit, divalidasi di form),
   * app-lock PIN langsung AKTIF memakai PIN itu. Kalau TIDAK diisi
   * (jalur setup minimal yang baru), app-lock PIN NONAKTIF dan user
   * tidak pernah dipaksa membuat PIN. Kolom `app_user.pin_hash`/
   * `pin_salt` tetap terisi (NOT NULL di skema) memakai PIN ACAK yang
   * tidak pernah ditampilkan & tidak bisa dipakai login — BUKAN PIN
   * default yang bisa ditebak. Lihat SecurityService.ts.
   */
  adminPin?: string;
  /**
   * RC-S119: PASSWORD ADMIN PERTAMA — satu-satunya cara masuk lewat
   * layar Masuk, dan sejak RC-S117 perannya terpisah dari PIN.
   *
   * Sebelum ini wizard tidak pernah memintanya, dan kolom password
   * admin diisi CERMIN dari hash PIN. Pada jalur setup minimal (yang
   * juga tidak meminta PIN) yang tercermin itu adalah PIN acak yang
   * memang dibuat supaya tidak dapat dipakai siapa pun — sehingga
   * admin pertama tidak punya password yang bisa diketik sama sekali.
   * Selama sesi terbuka sendiri hal itu tak terlihat, tetapi sekali
   * pengguna menyalakan PIN lalu menekan "Keluar" di layar kunci,
   * layar Masuk meminta password yang tidak pernah ada — dan tidak ada
   * jalan kembali.
   *
   * Karena itu wizard sekarang memintanya, dan password di-hash dengan
   * salt-nya SENDIRI, bukan meminjam milik PIN.
   */
  adminPassword?: string;
}

/** Nama & username admin default untuk jalur setup minimal (§8). */
const ADMIN_DEFAULT_NAMA = 'Administrator';
const ADMIN_DEFAULT_USERNAME = 'admin';

/**
 * PIN acak yang TIDAK PERNAH dipublikasikan ke user mana pun — dipakai
 * hanya untuk memenuhi NOT NULL pada `app_user.pin_hash`/`pin_salt`
 * ketika setup minimal tidak meminta PIN. Karena tidak pernah
 * ditampilkan, tidak ada yang bisa login dengannya; dan karena PIN
 * dalam kondisi ini juga DINONAKTIFKAN, tidak ada layar yang memintanya.
 * Begitu user menyalakan PIN di Pengaturan -> Keamanan, hash/salt ini
 * DITIMPA oleh PIN pilihan user.
 */
function pinAcakTidakDapatDipakai(): string {
  const bytes = generateSalt(); // 32 hex char dari expo-crypto getRandomBytes
  return `nopin:${bytes}`;
}

export interface SetupResult {
  koperasiId: string;
  adminUserId: string;
}

export async function isSetupComplete(): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ setup_selesai: number }>(
    `SELECT setup_selesai FROM koperasi ORDER BY created_at DESC LIMIT 1`
  );
  return !!row && row.setup_selesai === 1;
}

export async function getActiveKoperasi() {
  const db = await getDb();
  return db.getFirstAsync<{
    id: string;
    nama: string;
    standar_akuntansi: StandarAkuntansi;
    tahun_buku_aktif: number;
    logo_uri: string | null;
  }>(`SELECT id, nama, standar_akuntansi, tahun_buku_aktif, logo_uri FROM koperasi ORDER BY created_at DESC LIMIT 1`);
}

export async function setupKoperasi(input: SetupKoperasiInput): Promise<SetupResult> {
  if (await isSetupComplete()) {
    throw new Error('Setup sudah pernah diselesaikan. Gunakan Pengaturan untuk mengubah konfigurasi.');
  }

  return withTransaction(async (db) => {
    const now = new Date().toISOString();
    const koperasiId = newId();

    // §9/§10/§29 — standar akuntansi TIDAK LAGI ditanyakan di wizard.
    // Kalau pemanggil mengirim nilai eksplisit, nilai itu dipakai apa
    // adanya (kompatibilitas penuh dengan wizard/test lama); kalau tidak,
    // default kanonik SAK_EP. TIDAK PERNAH tersimpan NULL/undefined —
    // kolomnya NOT NULL + CHECK, dan nilai di sini selalu anggota enum.
    const standarAkuntansiEfektif: StandarAkuntansi = STANDAR_AKUNTANSI_DEFAULT;

    // §14 — PIN opsional. Ditentukan SEKALI di sini, dipakai konsisten
    // untuk pembuatan user admin & penulisan konfigurasi keamanan.
    const pinDiminta = typeof input.adminPin === 'string' && input.adminPin.length > 0;
    const pinUntukHash = pinDiminta ? (input.adminPin as string) : pinAcakTidakDapatDipakai();

    /*
     * RC-S119 — VALIDASI AKUN ADMIN DI SINI, BUKAN HANYA DI WIZARD.
     *
     * Wizard sudah memvalidasi sebelum tombol aktif, tetapi validasi
     * layar hanya menjaga satu pintu. Fungsi ini juga dipanggil dari
     * jalur lain, dan username yang tersimpan adalah yang harus
     * diketik ulang setiap kali masuk: menyimpan yang tidak sah berarti
     * membuat akun yang tidak bisa dipakai masuk, dan itu baru
     * ketahuan saat sudah terlambat.
     */
    const usernameAdmin = rapikanUsername(input.adminUsername ?? ADMIN_DEFAULT_USERNAME);
    const periksaNama = periksaUsername(usernameAdmin);
    if (!periksaNama.sah) throw new Error(periksaNama.pesan ?? 'Username admin tidak sah.');

    const passwordDiminta = typeof input.adminPassword === 'string' && input.adminPassword.length > 0;
    if (passwordDiminta) {
      const hasil = periksaPassword({ password: input.adminPassword as string, username: usernameAdmin });
      if (!hasil.sah) throw new Error(hasil.pesan ?? 'Password admin tidak sah.');
    }

    await db.runAsync(
      `INSERT INTO koperasi
        (id, nama, nomor_badan_hukum, npwp, alamat, telepon, email, logo_uri,
         tanggal_berdiri, tahun_buku_aktif, standar_akuntansi, setup_selesai, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      koperasiId,
      input.nama,
      input.nomorBadanHukum ?? null,
      input.npwp ?? null,
      input.alamat ?? null,
      input.telepon ?? null,
      input.email ?? null,
      input.logoUri ?? null,
      input.tanggalBerdiri ?? null,
      input.tahunBuku,
      standarAkuntansiEfektif,
      now,
      now
    );

    // 2. Periode akuntansi tahun berjalan — wajib agar jurnal bisa dibuat.
    await db.runAsync(
      `INSERT INTO accounting_period (id, tahun_buku, periode_mulai, periode_selesai, status)
       VALUES (?,?,?,?,'OPEN')`,
      newId(),
      input.tahunBuku,
      `${input.tahunBuku}-01-01`,
      `${input.tahunBuku}-12-31`
    );

    // 3. Seed Chart of Accounts default.
    //
    // BUG FIX (dilaporkan pengguna: "Gagal menyimpan setup — UNIQUE
    // constraint failed: account.kode"): loop ini SEBELUMNYA meng-
    // INSERT setiap akun TANPA mengecek dulu apakah kode-nya sudah
    // ada — beda dengan blok self-heal COA di db.ts yang sudah benar
    // (cek existence dulu). Kalau tabel `account` ternyata SUDAH ada
    // isinya sebelum wizard ini selesai (mis. migrasi/self-heal COA
    // sempat berjalan lebih dulu di database yang sama — bisa terjadi
    // kalau file database lama/sisa pengujian ikut terbawa, atau ada
    // upaya submit setup yang gagal di tengah jalan sebelumnya),
    // INSERT akan gagal begitu menemui kode yang sudah ada, dan
    // seluruh transaksi setup batal (termasuk baris `koperasi` yang
    // baru saja dibuat, ikut di-rollback) — itulah pesan error yang
    // muncul. Fix: SELALU cek existing dulu per kode, reuse id yang
    // sudah ada kalau ketemu (persis pola self-heal), baru INSERT
    // kalau memang belum ada.
    const existingAccounts = await db.getAllAsync<{ kode: string; id: string }>(`SELECT kode, id FROM account`);
    const accountIdByKode = new Map<string, string>(existingAccounts.map((a) => [a.kode, a.id]));
    for (const acc of DEFAULT_ACCOUNTS) {
      if (accountIdByKode.has(acc.kode)) continue; // sudah ada (mis. dari self-heal COA) — reuse, jangan insert dobel
      const accountId = newId();
      accountIdByKode.set(acc.kode, accountId);
      await db.runAsync(
        `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, lhu_klasifikasi, created_at, updated_at)
         VALUES (?,?,?,?,?,1,?,?,?,?)`,
        accountId,
        acc.kode,
        acc.nama,
        acc.kategori,
        acc.normalBalance,
        acc.isSystem ? 1 : 0,
        acc.lhuKlasifikasi ?? null,
        now,
        now
      );
    }

    // 4. Seed account_mapping default (transaksi otomatis -> akun).
    // Sama seperti di atas: cek existing (transaction_type, role)
    // dulu supaya idempoten kalau mapping sudah pernah ter-seed.
    const existingMappings = await db.getAllAsync<{ transaction_type: string; role: string }>(
      `SELECT transaction_type, role FROM account_mapping`
    );
    const existingMappingKeys = new Set(existingMappings.map((m) => `${m.transaction_type}::${m.role}`));
    for (const mapping of DEFAULT_ACCOUNT_MAPPING) {
      if (existingMappingKeys.has(`${mapping.transactionType}::${mapping.role}`)) continue;
      const accountId = accountIdByKode.get(mapping.accountKode);
      if (!accountId) {
        throw new Error(`Kode akun default "${mapping.accountKode}" tidak ditemukan saat seeding mapping.`);
      }
      await db.runAsync(
        `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
        newId(),
        mapping.transactionType,
        mapping.role,
        accountId
      );
    }

    // 4b. Seed master Kelompok/Sub Kelompok Aset Tetap default (Phase
    // 18 §14-19) — supaya "Data Klasifikasi Aset" & form Pembelian
    // Aset langsung punya Kelompok 1-4 siap pakai pada instalasi baru,
    // bukan mulai dari daftar kosong. Idempoten juga (sama alasannya
    // dengan fix akun/mapping di atas — UNIQUE(kelompok, sub_kelompok)).
    const existingKlasifikasi = await db.getAllAsync<{ kelompok: string; sub_kelompok: string }>(
      `SELECT kelompok, sub_kelompok FROM aset_klasifikasi`
    );
    const existingKlasifikasiKeys = new Set(existingKlasifikasi.map((k) => `${k.kelompok}::${k.sub_kelompok}`));
    for (const k of DEFAULT_ASET_KLASIFIKASI) {
      if (existingKlasifikasiKeys.has(`${k.kelompok}::${k.subKelompok}`)) continue;
      await db.runAsync(
        `INSERT INTO aset_klasifikasi (id, kelompok, sub_kelompok, masa_manfaat_bulan_default, aktif, created_at, updated_at)
         VALUES (?,?,?,?,1,?,?)`,
        newId(),
        k.kelompok,
        k.subKelompok,
        k.masaManfaatBulanDefault,
        now,
        now
      );
    }

    // 4c. Seed referensi Jenis Simpanan Bank default (target §10,
    // permintaan pengguna) — Tabungan/Giro/Deposito, semua aktif=1
    // secara default, supaya instalasi baru langsung punya pilihan
    // siap pakai di form Data Bank. Idempoten (cek kode dulu, sama
    // pola dengan seed lain di atas).
    const existingJenisSimpanan = await db.getAllAsync<{ kode: string }>(`SELECT kode FROM bank_jenis_simpanan`);
    const existingJenisSimpananKodes = new Set(existingJenisSimpanan.map((r) => r.kode));
    for (const j of [
      { kode: 'TABUNGAN', nama: 'Tabungan' },
      { kode: 'GIRO', nama: 'Giro' },
      { kode: 'DEPOSITO', nama: 'Deposito' },
    ]) {
      if (existingJenisSimpananKodes.has(j.kode)) continue;
      await db.runAsync(
        `INSERT INTO bank_jenis_simpanan (id, kode, nama, aktif, created_at, updated_at) VALUES (?,?,?,1,?,?)`,
        newId(),
        j.kode,
        j.nama,
        now,
        now
      );
    }

    // 5. User admin pertama (PIN & password di-hash, tidak plaintext — PRD §31-32).
    const adminUserId = newId();
    const salt = generateSalt();
    const pinHash = await hashPin(pinUntukHash, salt);

    /*
     * RC-S119 — PASSWORD PUNYA SALT SENDIRI.
     *
     * Sebelumnya kolom password diisi `pinHash`/`salt` yang sama persis
     * dengan PIN. Dua rahasia yang berbeda peran tidak boleh berbagi
     * satu hash: mengganti salah satunya akan diam-diam mengubah yang
     * lain, dan pada jalur setup minimal yang tersalin adalah PIN acak
     * yang memang dirancang tidak dapat dipakai — meninggalkan admin
     * tanpa password sama sekali.
     *
     * Bila password TIDAK diminta (pemanggil non-wizard), perilaku lama
     * dipertahankan supaya tidak ada jalur yang berubah diam-diam:
     * kolomnya mencerminkan hash PIN seperti semula.
     */
    const saltPassword = passwordDiminta ? generateSalt() : salt;
    const passwordHash = passwordDiminta
      ? await hashPin(rapikanPassword(input.adminPassword as string), saltPassword)
      : pinHash;

    await db.runAsync(
      `INSERT INTO app_user
        (id, nama, username, role, pin_hash, pin_salt, pin_hash_versi,
         password_hash, password_salt, password_hash_versi, biometric_enabled, aktif, created_at, updated_at)
       VALUES (?,?,?,'ADMIN',?,?,?,?,?,?,0,1,?,?)`,
      adminUserId,
      input.adminNama ?? ADMIN_DEFAULT_NAMA,
      usernameAdmin,
      pinHash,
      salt,
      VERSI_HASH_PIN_SEKARANG,
      passwordHash,
      saltPassword,
      VERSI_HASH_PIN_SEKARANG,
      now,
      now
    );

    // §14/§18 — tulis status app-lock PIN SECARA EKSPLISIT saat setup
    // selesai. Karena key ini selalu ada sesudah setup, pembacaan status
    // PIN tidak pernah bergantung pada tebakan. Instalasi LAMA (yang
    // tidak punya key ini sama sekali) tetap dianggap PIN AKTIF — lihat
    // SecurityService.isPinEnabledPadaDb().
    await setPinEnabledPadaDb(db, pinDiminta);
    await tandaiPinBelumDitetapkanPadaDb(db, !pinDiminta);

    await db.runAsync(
      `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sesudah, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      newId(),
      adminUserId,
      now.slice(0, 10),
      now.slice(11, 19),
      'CREATE',
      'koperasi',
      koperasiId,
      JSON.stringify({ nama: input.nama, standarAkuntansi: standarAkuntansiEfektif }),
      now
    );

    return { koperasiId, adminUserId };
  });
}

// ============================================================
// IDENTITAS KOPERASI (§19-§28 permintaan pengguna)
// ============================================================
//
// PEMISAHAN YANG DISENGAJA: setup awal hanya meminta Nama Koperasi &
// Tahun Buku (§8). Identitas LENGKAP diisi belakangan lewat Dashboard ->
// "Lengkapi Identitas Koperasi", dan TIDAK PERNAH menghalangi transaksi
// (§22).
//
// FIELD YANG DIDUKUNG — hasil audit skema (§20/§21: "Gunakan field yang
// memang sudah didukung schema/source", "JANGAN membuat database column
// baru hanya berdasarkan asumsi"). Seluruh field di bawah SUDAH ADA di
// tabel `koperasi` sejak CREATE_TABLES_SQL — TIDAK ADA kolom baru, TIDAK
// ADA kenaikan SCHEMA_VERSION, TIDAK ADA migrasi:
//
//   Informasi Dasar : nama, tahun_buku_aktif, tanggal_berdiri
//   Alamat          : alamat
//   Kontak          : telepon, email
//   Administratif   : nomor_badan_hukum, npwp
//   Branding        : logo_uri
//
// NOT IMPLEMENTED (sengaja TIDAK ditambahkan — tidak ada kolomnya dan
// tidak ada laporan yang membutuhkannya): kabupaten/kota, provinsi, kode
// pos, faksimile, situs web, nomor induk koperasi (NIK Koperasi),
// jenis koperasi. Kalau suatu saat dibutuhkan, itu perlu migrasi skema
// tersendiri — bukan dikarang di layer ini.

export interface IdentitasKoperasiInput {
  nama: string;
  tanggalBerdiri?: string | null;
  alamat?: string | null;
  telepon?: string | null;
  email?: string | null;
  /**
   * v60 — Nomor Administrasi Hukum Umum (AHU).
   *
   * `nomorBadanHukum` DIPERTAHANKAN sebagai alias masukan supaya
   * pemanggil lama tidak putus. Keduanya merujuk dokumen yang SAMA; bila
   * keduanya diisi, `nomorAhu` menang.
   */
  nomorAhu?: string | null;
  /** v60 — Nomor Induk Koperasi (NIK KOPERASI), bukan NIK perorangan. */
  nomorIndukKoperasi?: string | null;
  nomorBadanHukum?: string | null;
  npwp?: string | null;
  logoUri?: string | null;
}

export interface IdentitasKoperasiRow {
  id: string;
  nama: string;
  tahunBukuAktif: number;
  tanggalBerdiri: string | null;
  alamat: string | null;
  telepon: string | null;
  email: string | null;
  nomorBadanHukum: string | null;
  /** v60 — sama nilainya dengan `nomorBadanHukum`; lihat catatan di updateIdentitasKoperasi(). */
  nomorAhu: string | null;
  nomorIndukKoperasi: string | null;
  npwp: string | null;
  logoUri: string | null;
  standarAkuntansi: StandarAkuntansi;
}

/**
 * §29 — standar akuntansi yang BERLAKU untuk sebuah database.
 *
 * Dipakai oleh pemanggil yang butuh nilai valid tanpa peduli asal-usul
 * datanya (setup baru, restore, konfigurasi lama yang kosong). Nilai
 * yang SUDAH tersimpan SELALU dipertahankan — default hanya dipakai
 * kalau kolomnya benar-benar kosong/NULL/tidak dikenal, sehingga
 * "Backup restore tidak boleh menghapus standard menjadi NULL"
 * terpenuhi tanpa pernah menimpa konfigurasi historis siapa pun.
 */
export function normalisasiStandarAkuntansi(nilai: unknown): StandarAkuntansi {
  /**
   * RC-S39 — SELALU mengembalikan 'SAK_EP'.
   *
   * Fungsi ini dipertahankan (bukan dihapus) karena ia dipanggil saat
   * MEMBACA baris `koperasi` dari database. Instalasi lama dapat berisi
   * 'SAK_EMKM' sampai migrasi v56 dijalankan, dan pembacaan itu harus
   * tetap menghasilkan nilai yang sah bagi tipe `StandarAkuntansi`
   * yang kini hanya punya satu anggota.
   *
   * Nilai apa pun — 'SAK_EMKM', NULL, atau string asing — dinormalisasi
   * menjadi 'SAK_EP'. Tidak ada masukan yang dapat menghasilkan mode
   * akuntansi lain, karena mode lain sudah tidak ada.
   */
  void nilai;
  return STANDAR_AKUNTANSI_DEFAULT;
}

export async function getStandarAkuntansiEfektif(): Promise<StandarAkuntansi> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ standar_akuntansi: string | null }>(
    `SELECT standar_akuntansi FROM koperasi ORDER BY created_at DESC LIMIT 1`
  );
  return normalisasiStandarAkuntansi(row?.standar_akuntansi);
}

export async function getIdentitasKoperasi(): Promise<IdentitasKoperasiRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    id: string;
    nama: string;
    tahun_buku_aktif: number;
    tanggal_berdiri: string | null;
    alamat: string | null;
    telepon: string | null;
    email: string | null;
    nomor_badan_hukum: string | null;
    nomor_ahu: string | null;
    nomor_induk_koperasi: string | null;
    npwp: string | null;
    logo_uri: string | null;
    standar_akuntansi: string | null;
  }>(
    `SELECT id, nama, tahun_buku_aktif, tanggal_berdiri, alamat, telepon, email,
            nomor_badan_hukum, nomor_ahu, nomor_induk_koperasi, npwp, logo_uri, standar_akuntansi
     FROM koperasi ORDER BY created_at DESC LIMIT 1`
  );
  if (!row) return null;
  return {
    id: row.id,
    nama: row.nama,
    tahunBukuAktif: row.tahun_buku_aktif,
    tanggalBerdiri: row.tanggal_berdiri,
    alamat: row.alamat,
    telepon: row.telepon,
    email: row.email,
    nomorBadanHukum: row.nomor_badan_hukum,
    // Fallback ke kolom warisan HANYA untuk database yang backfill v60-nya
    // belum sempat berjalan; setelah migrasi keduanya selalu sama.
    nomorAhu: row.nomor_ahu ?? row.nomor_badan_hukum,
    nomorIndukKoperasi: row.nomor_induk_koperasi,
    npwp: row.npwp,
    logoUri: row.logo_uri,
    standarAkuntansi: normalisasiStandarAkuntansi(row.standar_akuntansi),
  };
}

/**
 * §24/§26/§34 — simpan identitas koperasi.
 *
 * ATOMIC: satu UPDATE tunggal di dalam satu transaksi, jadi tidak
 * mungkin menghasilkan partial state kalau gagal di tengah.
 *
 * TIDAK ADA EFEK SAMPING AKUNTANSI (§26/§34): fungsi ini HANYA menyentuh
 * tabel `koperasi` (configuration data). Tidak membuat journal,
 * journal_entry, pinjaman, simpanan, aset, liabilitas, pendapatan, atau
 * beban apa pun — dan TIDAK menyentuh `tahun_buku_aktif` sama sekali
 * (lihat gantiTahunBuku() untuk aturan ketatnya, §27/§28).
 */
export async function updateIdentitasKoperasi(input: IdentitasKoperasiInput): Promise<void> {
  const nama = input.nama.trim();
  if (nama.length < 3) throw new Error('Nama koperasi minimal 3 karakter.');

  return withTransaction(async (db) => {
    const koperasi = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM koperasi ORDER BY created_at DESC LIMIT 1`
    );
    if (!koperasi) throw new Error('Data koperasi belum ada — selesaikan setup awal terlebih dahulu.');

    const bersih = (v: string | null | undefined): string | null => {
      if (v === null || v === undefined) return null;
      const t = v.trim();
      return t === '' ? null : t;
    };

    /**
     * v60 — AHU DITULIS KE DUA KOLOM SEKALIGUS.
     *
     * `nomor_badan_hukum` masih dibaca kode lama (FinancialReports,
     * layar identitas), sementara `nomor_ahu` adalah nama resmi yang
     * baru. Keduanya merujuk dokumen yang sama.
     *
     * Menulis keduanya dari SATU nilai, dalam SATU pernyataan UPDATE,
     * membuat divergensi mustahil secara struktur — bukan sekadar
     * "diharapkan tidak terjadi". Tidak ada jalur di mana salah satu
     * berubah tanpa yang lain.
     */
    const nilaiAhu = bersih(input.nomorAhu ?? input.nomorBadanHukum);

    await db.runAsync(
      `UPDATE koperasi
         SET nama = ?, tanggal_berdiri = ?, alamat = ?, telepon = ?, email = ?,
             nomor_badan_hukum = ?, nomor_ahu = ?, nomor_induk_koperasi = ?,
             npwp = ?, logo_uri = ?, updated_at = ?
       WHERE id = ?`,
      nama,
      bersih(input.tanggalBerdiri),
      bersih(input.alamat),
      bersih(input.telepon),
      bersih(input.email),
      nilaiAhu,
      nilaiAhu,
      bersih(input.nomorIndukKoperasi),
      bersih(input.npwp),
      bersih(input.logoUri),
      new Date().toISOString(),
      koperasi.id
    );
  });
}

/**
 * §23 — SATU helper terpusat untuk status kelengkapan identitas.
 *
 * Dashboard (§22) dan layar Identitas (§20) WAJIB memakai fungsi ini —
 * jangan menghitung kondisi "lengkap" secara terpisah di dua tempat,
 * karena itu persis bagaimana dua layar mulai menampilkan status yang
 * bertentangan.
 */
export type IdentityCompletionStatus = 'BASIC_COMPLETE' | 'DETAIL_PARTIAL' | 'COMPLETE';

export interface IdentityCompletion {
  status: IdentityCompletionStatus;
  /** Field detail yang masih kosong — dipakai UI untuk memandu pengisian. */
  fieldBelumTerisi: string[];
}

/**
 * Field DETAIL yang menentukan "lengkap". Nama & tahun buku TIDAK
 * termasuk di sini karena keduanya sudah dijamin terisi oleh setup awal
 * (itulah arti BASIC_COMPLETE). `logo_uri` SENGAJA TIDAK diwajibkan —
 * tidak ada laporan yang gagal tanpa logo (§20: "Jangan memaksa semua
 * field menjadi mandatory jika laporan tidak membutuhkannya").
 */
const FIELD_DETAIL_IDENTITAS: { kunci: keyof IdentitasKoperasiRow; label: string }[] = [
  { kunci: 'alamat', label: 'Alamat' },
  { kunci: 'telepon', label: 'Nomor Telepon' },
  { kunci: 'email', label: 'Email' },
  { kunci: 'nomorBadanHukum', label: 'Nomor Badan Hukum' },
  { kunci: 'npwp', label: 'NPWP' },
];

export function hitungIdentityCompletion(identitas: IdentitasKoperasiRow | null): IdentityCompletion {
  if (!identitas || !identitas.nama.trim()) {
    return { status: 'BASIC_COMPLETE', fieldBelumTerisi: FIELD_DETAIL_IDENTITAS.map((f) => f.label) };
  }
  const kosong = FIELD_DETAIL_IDENTITAS.filter((f) => {
    const nilai = identitas[f.kunci];
    return nilai === null || nilai === undefined || String(nilai).trim() === '';
  }).map((f) => f.label);

  if (kosong.length === 0) return { status: 'COMPLETE', fieldBelumTerisi: [] };
  if (kosong.length === FIELD_DETAIL_IDENTITAS.length) {
    return { status: 'BASIC_COMPLETE', fieldBelumTerisi: kosong };
  }
  return { status: 'DETAIL_PARTIAL', fieldBelumTerisi: kosong };
}

export async function getIdentityCompletionStatus(): Promise<IdentityCompletion> {
  return hitungIdentityCompletion(await getIdentitasKoperasi());
}

/**
 * §27/§28 — apakah TAHUN BUKU masih boleh diubah?
 *
 * Tahun buku ikut menentukan periode akuntansi, cakupan laporan, dan
 * titik potong SHU. Mengubahnya setelah ada data akuntansi akan
 * menggeser laporan historis tanpa jurnal apa pun yang mencatatnya —
 * karena itu dikunci. Sumber jawabannya adalah DATA NYATA (ada jurnal /
 * ada periode tertutup), bukan flag terpisah yang bisa lepas sinkron.
 */
export async function bolehGantiTahunBuku(): Promise<{ boleh: boolean; alasan: string | null }> {
  const db = await getDb();
  const jurnal = await db.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
  if ((jurnal?.cnt ?? 0) > 0) {
    return { boleh: false, alasan: 'Sudah ada jurnal/transaksi tercatat — tahun buku dikunci agar laporan historis tidak berubah.' };
  }
  const periodeTertutup = await db.getFirstAsync<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM accounting_period WHERE status = 'CLOSED'`
  );
  if ((periodeTertutup?.cnt ?? 0) > 0) {
    return { boleh: false, alasan: 'Sudah ada periode akuntansi yang ditutup — tahun buku dikunci.' };
  }
  return { boleh: true, alasan: null };
}

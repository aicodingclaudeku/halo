import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy'; // SDK 54: API lama (documentDirectory, getInfoAsync, dst.) sekarang di path /legacy
import { CREATE_TABLES_SQL, SCHEMA_VERSION } from './schema';
import { DEFAULT_ACCOUNTS, DEFAULT_ACCOUNT_MAPPING } from '@/config/defaultCOA';
import { DEFAULT_ASET_KLASIFIKASI } from '@/config/defaultAsetKlasifikasi';
import { newId } from '@/utils/id';
import { sekaliJalan } from '@/utils/sekaliJalan';

/**
 * Satu koneksi database SQLite yang dipakai di seluruh app.
 * Semua akses SQL harus lewat repositories/ — JANGAN taruh SQL
 * langsung di component UI (PRD §44).
 */

export const DATABASE_NAME = 'koperasi.db';

let dbInstance: SQLite.SQLiteDatabase | null = null;

/** Folder tempat expo-sqlite menyimpan file database di perangkat. */
export function getSqliteDirectory(): string {
  return `${FileSystem.documentDirectory}SQLite/`;
}

/** Path lengkap file database utama — dipakai modul backup (fase 5). */
export function getDatabaseFilePath(): string {
  return `${getSqliteDirectory()}${DATABASE_NAME}`;
}

/**
 * Self-heal (fase 5 §9 "Proteksi agar database tidak rusak jika restore
 * gagal"): jika proses restore terhenti di tengah jalan (mis. aplikasi
 * ditutup paksa tepat saat file database sedang ditukar), file database
 * utama bisa hilang sementara salinan LAMA masih ada sebagai file
 * `.previous` (lihat BackupService.restoreBackup). Jika ini terjadi,
 * kembalikan file lama tersebut supaya aplikasi tetap bisa dibuka
 * dengan data terakhir yang valid, bukan gagal total.
 */
async function pulihkanJikaRestoreTerputus(): Promise<void> {
  const liveDbPath = getDatabaseFilePath();
  const previousPath = `${liveDbPath}.previous`;

  const liveInfo = await FileSystem.getInfoAsync(liveDbPath);
  if (liveInfo.exists) return; // kondisi normal, tidak ada yang perlu dipulihkan

  const previousInfo = await FileSystem.getInfoAsync(previousPath);
  if (previousInfo.exists) {
    await FileSystem.moveAsync({ from: previousPath, to: liveDbPath });
  }
}

/**
 * BUG-01 — INVARIAN FOREIGN KEY ENFORCEMENT.
 *
 * `PRAGMA foreign_keys` di SQLite adalah setting PER-KONEKSI, bukan
 * properti file database, dan defaultnya OFF. Sebelum perbaikan ini
 * satu-satunya tempat pragma tersebut muncul adalah di dalam
 * `CREATE_TABLES_SQL` (schema.ts) — yang HANYA dieksekusi pada jalur
 * fresh install (`currentVersion === 0`), dan bahkan di sana pun
 * dijalankan DI DALAM transaksi sehingga menjadi no-op (SQLite
 * mengabaikan `PRAGMA foreign_keys` di tengah transaksi aktif).
 *
 * Akibatnya: launch kedua dan seterusnya (kasus paling umum) berjalan
 * dengan FK enforcement MATI, sehingga database produksi bisa menerima
 * orphan record tanpa penolakan apa pun.
 *
 * Helper ini adalah SATU-SATUNYA tempat konfigurasi koneksi ditetapkan,
 * dan wajib dipanggil untuk SETIAP koneksi yang dibuka (first launch,
 * launch berikutnya, setelah restore, setelah migrasi, setelah reopen).
 */
export async function configureDatabaseConnection(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync('PRAGMA foreign_keys = ON;');
  await assertForeignKeysEnabled(db, 'configureDatabaseConnection');
}

/**
 * Runtime assertion: pastikan `PRAGMA foreign_keys` benar-benar bernilai
 * 1 pada koneksi ini. Dibuat fail-loud (bukan warning) karena FK OFF
 * berarti seluruh jaminan integritas referensial database tidak berlaku
 * — persis kelas kesalahan yang BUG-01 timbulkan.
 */
export async function assertForeignKeysEnabled(
  db: SQLite.SQLiteDatabase,
  konteks: string
): Promise<void> {
  const row = await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys');
  const aktif = Number(row?.foreign_keys ?? 0) === 1;
  if (!aktif) {
    throw new Error(
      `[DatabaseIntegrity] PRAGMA foreign_keys tidak aktif pada koneksi ini (konteks: ${konteks}). ` +
        `Foreign key enforcement wajib ON untuk semua koneksi produksi — lihat configureDatabaseConnection().`
    );
  }
}

/**
 * RC-S115 — PEMBUKAAN DATABASE DIJAGA DARI BALAPAN.
 *
 * ============================================================
 * BUG YANG DIPERBAIKI (dilaporkan pengguna setelah build EAS)
 * ============================================================
 * Gejalanya: "Gagal menyimpan setup — Call to function
 * 'NativeDatabase.prepareAsync' has been rejected. Caused by:
 * java.lang.NullPointerException".
 *
 * NPE itu berasal dari `prepareStatement()` di expo-sqlite
 * (SQLiteModule.kt): ia memanggil `database.ref.sqlite3_prepare_v2(...)`
 * pada `ref` yang sudah NULL — artinya pegangan native database itu
 * sudah dilepas, bukan sekadar ditutup (database yang ditutup melempar
 * AccessClosedResourceException, bukan NPE).
 *
 * Penyebabnya BALAPAN pada fungsi ini. Bentuk lamanya:
 *
 *     if (dbInstance) return dbInstance;
 *     await pulihkanJikaRestoreTerputus();      // <- titik tunggu 1
 *     dbInstance = await SQLite.openDatabaseAsync(...);  // <- 2
 *     await configureDatabaseConnection(dbInstance);     // <- 3
 *     await runMigrations(dbInstance);                   // <- 4
 *
 * Ada EMPAT titik tunggu antara penjaga `if` dan penugasan
 * `dbInstance`. Dua pemanggil yang masuk berdekatan sama-sama melewati
 * penjaga itu selagi `dbInstance` masih null, lalu KEDUANYA membuka
 * database native sendiri-sendiri atas berkas yang sama. Yang selesai
 * belakangan menimpa `dbInstance`; objek JS milik yang pertama menjadi
 * tak terjangkau, dikumpulkan sampah, dan pegangan native-nya DILEPAS.
 *
 * Pemanggil yang sempat memegang objek pertama (`const db = await
 * getDb()`) baru memakainya beberapa saat kemudian — persis pola layar
 * Setup: `db` diambil saat layar dibuka, dipakai saat tombol "Mulai"
 * ditekan. Pada saat itu `ref`-nya sudah null.
 *
 * Kenapa baru muncul setelah build EAS: di build rilis waktunya rapat
 * (bundel sudah dipaket, tanpa jeda dev server) sehingga dua pemanggil
 * jauh lebih mungkin berhimpit, dan pengumpulan sampah Hermes benar-
 * benar berjalan. Di mode pengembangan balapannya ada juga, hanya
 * jarang menang.
 *
 * ============================================================
 * PERBAIKANNYA
 * ============================================================
 * Yang disimpan sekarang bukan hanya HASIL pembukaan, melainkan
 * JANJINYA. Pemanggil kedua yang datang saat pembukaan masih berjalan
 * menunggu janji yang SAMA, bukan memulai pembukaan kedua. Dengan
 * begitu `openDatabaseAsync` dijamin dipanggil tepat sekali, dan hanya
 * ada satu pegangan native yang hidup.
 *
 * Kegagalan membuang janjinya kembali (`pembukaan = null`) supaya
 * percobaan berikutnya benar-benar mencoba lagi — bukan mengulang
 * kegagalan yang sama selamanya dari janji yang sudah ditolak.
 */
const pembukaanDb = sekaliJalan<SQLite.SQLiteDatabase>(async () => {
  await pulihkanJikaRestoreTerputus();
  const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
  // BUG-01: konfigurasi koneksi (termasuk FK ON) SEBELUM migrasi, dan
  // dipastikan kembali ON setelah migrasi selesai (runMigrations sempat
  // mematikannya sementara untuk rebuild tabel — lihat di sana).
  await configureDatabaseConnection(db);
  await runMigrations(db);
  await assertForeignKeysEnabled(db, 'getDb (setelah migrasi)');
  // `dbInstance` tetap dipertahankan karena dipakai `closeDb()` dan
  // beberapa pemeriksaan lain; ia ditugaskan PALING AKHIR supaya tidak
  // pernah menunjuk koneksi yang belum dikonfigurasi/dimigrasi.
  dbInstance = db;
  return db;
});

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  return pembukaanDb();
}

/** Tutup koneksi database aktif — dipakai BackupService sebelum menukar file (fase 5). */
export async function closeDb(): Promise<void> {
  // RC-S115 — penjaga pembukaan ikut di-reset. Kalau tidak, `getDb()`
  // berikutnya akan mengembalikan koneksi yang baru saja ditutup —
  // persis kelas kesalahan yang diperbaiki di atas.
  pembukaanDb.reset();
  if (dbInstance) {
    await dbInstance.closeAsync();
    dbInstance = null;
  }
}

export async function runMigrations(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
  `);

  const row = await db.getFirstAsync<{ version: number }>(
    'SELECT version FROM schema_meta WHERE id = 1'
  );
  const currentVersion = row?.version ?? 0;

  // BUG-11 — HARD REJECT database dengan skema LEBIH BARU dari aplikasi.
  //
  // Kenapa hard reject dan bukan warning: aplikasi versi lama tidak
  // mengenal kolom/tabel/constraint yang ditambahkan versi berikutnya.
  // Menjalankannya tetap akan menghasilkan pembacaan parsial (kolom
  // baru diabaikan) dan penulisan yang secara struktur valid tetapi
  // secara akuntansi rusak — mis. jurnal yang ditulis tanpa mengisi
  // kolom wajib versi baru. Kerusakan seperti itu tidak terdeteksi
  // sampai berbulan-bulan kemudian. Menolak membuka database jauh lebih
  // aman daripada merusaknya secara diam-diam.
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      'Database dibuat menggunakan schema yang lebih baru dan tidak kompatibel dengan versi aplikasi ini. ' +
        'Silakan gunakan versi aplikasi yang sama atau lebih baru. ' +
        `(schema database: v${currentVersion}, schema aplikasi: v${SCHEMA_VERSION})`
    );
  }

  if (currentVersion === 0) {
    // Fresh install: buat seluruh skema dalam satu transaksi.
    await db.withTransactionAsync(async () => {
      await db.execAsync(CREATE_TABLES_SQL);
      await db.runAsync(
        'INSERT OR REPLACE INTO schema_meta (id, version) VALUES (1, ?)',
        SCHEMA_VERSION
      );
    });
    // CRITICAL FIX §8: tetap lewat pengecekan integritas schema di
    // bawah sebelum dianggap ready (satu jalur "database ready" yang
    // konsisten untuk fresh install maupun existing install) — bukan
    // return langsung seperti sebelumnya. CREATE_TABLES_SQL seharusnya
    // sudah lengkap jadi ini murni no-op cepat untuk fresh install,
    // tapi konsisten dengan urutan yang diminta.
    await pastikanIntegritasSchemaWajib(db);
    return;
  }

  if (currentVersion < SCHEMA_VERSION) {
    // RC-S133.6.2 — SALINAN PENGAMAN SEBELUM MIGRASI.
    //
    // Sebelum satu pun DDL migrasi dijalankan, seluruh database disalin
    // (VACUUM INTO — salinan konsisten termasuk isi WAL) ke folder yang sama
    // dengan nama pra-migrasi-v<lama>-ke-v<baru>-<waktu>.db. Bila salinan
    // GAGAL dibuat, migrasi DIHENTIKAN: versi skema tidak dinaikkan, tidak
    // ada tabel yang disentuh, dan percobaan berikutnya mengulang dari awal.
    // Database di memori / tanpa berkas (uji) tidak punya berkas untuk
    // disalin, jadi dilewati.
    await cadangkanSebelumMigrasi(db, currentVersion, SCHEMA_VERSION);

    // BUG-01 — SATU-SATUNYA tempat FK enforcement boleh dimatikan.
    //
    // Beberapa migrasi di bawah memakai prosedur rebuild tabel resmi
    // SQLite (CREATE ..._new -> INSERT SELECT -> DROP TABLE lama ->
    // RENAME), mis. app_user (v3), anggota (v4), utang (v11),
    // aset_klasifikasi (v29), investasi (v31), shu_konfigurasi (v32),
    // angsuran_jadwal (v45), pinjaman_akuntansi_jasa (v47 & v49).
    // Dengan `foreign_keys = ON`, `DROP TABLE` melakukan DELETE implisit
    // yang MEMICU ON DELETE CASCADE pada tabel anak — mis. seluruh
    // `angsuran_pembayaran` akan ikut terhapus saat rebuild
    // `angsuran_jadwal`. Itu silent data loss. Dokumentasi SQLite
    // secara eksplisit mensyaratkan FK dimatikan selama prosedur ini.
    //
    // Karena itu FK dimatikan HANYA selama blok migrasi legacy, lalu
    // WAJIB dinyalakan kembali dan diverifikasi dengan
    // `PRAGMA foreign_key_check` di akhir blok (lihat bawah).
    //
    // Catatan: PRAGMA ini no-op jika dipanggil di tengah transaksi
    // aktif — di titik ini kita memang berada di luar transaksi (setiap
    // langkah migrasi membuka transaksinya sendiri).
    await db.execAsync('PRAGMA foreign_keys = OFF;');

    // ============================================================
    // RC-S51 §2B — FK WAJIB PULIH WALAU MIGRASI GAGAL
    // ============================================================
    // TEMUAN AUDIT. Baris `PRAGMA foreign_keys = ON` yang memulihkan
    // invarian ini berada di AKHIR blok, pada jalur sukses. Kalau salah
    // satu migrasi di bawah melempar exception, baris itu TIDAK PERNAH
    // dieksekusi — dan karena PRAGMA ini adalah setting PER-KONEKSI,
    // koneksi tersebut tetap berjalan dengan FK MATI selama sisa hidup
    // proses. Sejak titik itu, setiap INSERT/DELETE aplikasi berjalan
    // tanpa penegakan foreign key sama sekali.
    //
    // `try/finally` memindahkan pemulihan itu ke jalur yang SELALU
    // dilalui. Ia TIDAK menelan error: exception aslinya tetap naik ke
    // pemanggil, dan `schema_meta.version` tetap tidak dinaikkan.
    //
    // CATATAN GAYA: isi blok di bawah SENGAJA TIDAK di-reindent.
    // Menambah satu tingkat indentasi pada ~2.400 baris migrasi akan
    // menghasilkan diff yang menutupi perubahan sesungguhnya dan
    // menyulitkan review — sementara JavaScript tidak peduli pada
    // indentasi. Yang berubah hanyalah dua baris penanda blok ini.
    try {

    // Migrasi bertahap. Setiap kenaikan versi ditangani idempoten (aman
    // dijalankan ulang) supaya instalasi lama otomatis menyusul skema
    // terbaru tanpa perlu setup ulang dari nol.
    //
    // Helper dipakai lintas versi (bukan cuma v2) — SQLite tidak punya
    // "ADD COLUMN IF NOT EXISTS", jadi dibungkus try/catch: aman
    // dijalankan ulang kalau kolomnya sudah ada (mis. dari instalasi
    // fresh yang skemanya sudah termasuk kolom ini sejak awal).
    const tambahKolomJikaBelumAda = async (tabel: string, kolom: string, tipe: string) => {
      try {
        await db.execAsync(`ALTER TABLE ${tabel} ADD COLUMN ${kolom} ${tipe};`);
      } catch {
        // Kolom sudah ada — abaikan.
      }
    };

    if (currentVersion < 2) {
      // Fase 7 (Kas & Bank): tambah kolom kategori transaksi.
      await tambahKolomJikaBelumAda('kas_transaksi', 'kategori', 'TEXT');
      await tambahKolomJikaBelumAda('bank_transaksi', 'kategori', 'TEXT');
    }
    if (currentVersion < 3) {
      // Fase 8 (User & Role Permission): app_user.role tadinya hanya
      // ('ADMIN','BENDAHARA','PENGAWAS'), sekarang 5 role
      // ('ADMIN','PENGURUS','BENDAHARA','PETUGAS','ANGGOTA'). SQLite tidak
      // bisa ALTER CHECK constraint langsung — tabel dibangun ulang
      // dengan CHECK baru, data lama disalin apa adanya (dibungkus
      // transaksi supaya aman jika terhenti di tengah jalan).
      await db.withTransactionAsync(async () => {
        const tableInfo = await db.getFirstAsync<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='app_user'`
        );
        if (tableInfo) {
          await db.execAsync(`
            CREATE TABLE IF NOT EXISTS app_user_new (
              id TEXT PRIMARY KEY,
              nama TEXT NOT NULL,
              username TEXT NOT NULL UNIQUE,
              role TEXT NOT NULL CHECK (role IN ('ADMIN','PENGURUS','BENDAHARA','PETUGAS','ANGGOTA')),
              pin_hash TEXT NOT NULL,
              pin_salt TEXT NOT NULL,
              biometric_enabled INTEGER NOT NULL DEFAULT 0,
              aktif INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
          `);
          await db.execAsync(`
            INSERT INTO app_user_new (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
            SELECT id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at FROM app_user;
          `);
          await db.execAsync(`DROP TABLE app_user;`);
          await db.execAsync(`ALTER TABLE app_user_new RENAME TO app_user;`);
        }
      });
    }
    if (currentVersion < 4) {
      // Fitur "NIK bisa on/off": kolom nik tadinya NOT NULL, sekarang
      // boleh kosong (anggota bisa didaftarkan dulu, NIK menyusul).
      // SQLite tidak bisa ALTER COLUMN untuk hapus NOT NULL langsung —
      // tabel dibangun ulang, data lama disalin apa adanya, dibungkus
      // transaksi supaya aman jika terhenti di tengah jalan. UNIQUE
      // tetap dipertahankan: SQLite mengizinkan banyak baris NULL pada
      // kolom UNIQUE tanpa dianggap bentrok, jadi anggota tanpa NIK
      // tidak akan saling tabrakan.
      await db.withTransactionAsync(async () => {
        const tableInfo = await db.getFirstAsync<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='anggota'`
        );
        if (tableInfo) {
          await db.execAsync(`
            CREATE TABLE IF NOT EXISTS anggota_new (
              id TEXT PRIMARY KEY,
              nomor_anggota TEXT NOT NULL UNIQUE,
              nik TEXT UNIQUE,
              nama_lengkap TEXT NOT NULL,
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
          `);
          await db.execAsync(`
            INSERT INTO anggota_new (id, nomor_anggota, nik, nama_lengkap, tempat_lahir, tanggal_lahir,
              alamat, nomor_hp, pekerjaan, tanggal_bergabung, status, foto_uri, catatan, created_at, updated_at)
            SELECT id, nomor_anggota, nik, nama_lengkap, tempat_lahir, tanggal_lahir,
              alamat, nomor_hp, pekerjaan, tanggal_bergabung, status, foto_uri, catatan, created_at, updated_at
            FROM anggota;
          `);
          await db.execAsync(`DROP TABLE anggota;`);
          await db.execAsync(`ALTER TABLE anggota_new RENAME TO anggota;`);
          await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_anggota_nama ON anggota(nama_lengkap);`);
          await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_anggota_nik ON anggota(nik);`);
          await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_anggota_status ON anggota(status);`);
        }
      });
    }
    if (currentVersion < 5) {
      // Fitur Transaksi Penerimaan/Pengeluaran lanjutan: Utang (pinjaman
      // diterima), Aset Tetap, Pendapatan Diterima Dimuka — tabel baru,
      // aman dibuat dengan CREATE TABLE IF NOT EXISTS (idempoten, sama
      // seperti fresh-install lewat CREATE_TABLES_SQL).
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS utang (
          id TEXT PRIMARY KEY,
          nomor_utang TEXT NOT NULL UNIQUE,
          nama_pemberi TEXT NOT NULL,
          jenis_pemberi TEXT NOT NULL CHECK (jenis_pemberi IN ('BANK','PIHAK_LAIN')),
          pokok_pinjaman INTEGER NOT NULL,
          persen_bunga REAL NOT NULL DEFAULT 0,
          jenis_bunga TEXT NOT NULL CHECK (jenis_bunga IN ('FLAT','EFEKTIF','LAINNYA')) DEFAULT 'FLAT',
          tanggal TEXT NOT NULL,
          sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
          bank_account_id TEXT REFERENCES bank_account(id),
          status TEXT NOT NULL CHECK (status IN ('AKTIF','LUNAS')) DEFAULT 'AKTIF',
          keterangan TEXT,
          journal_id TEXT REFERENCES journal(id),
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_utang_status ON utang(status);

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
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_utang_bayar_utang ON utang_pembayaran(utang_id);

        CREATE TABLE IF NOT EXISTS aset_tetap (
          id TEXT PRIMARY KEY,
          nomor_aset TEXT NOT NULL UNIQUE,
          nama_aset TEXT NOT NULL,
          nilai_perolehan INTEGER NOT NULL,
          masa_manfaat_bulan INTEGER NOT NULL,
          tanggal_perolehan TEXT NOT NULL,
          metode_pembayaran TEXT NOT NULL CHECK (metode_pembayaran IN ('TUNAI','KREDIT')),
          sumber TEXT NOT NULL CHECK (sumber IN ('PEMBELIAN','MODAL_BARANG')),
          keterangan TEXT,
          journal_id TEXT REFERENCES journal(id),
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

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
      `);
    }
    if (currentVersion < 6) {
      // Fitur Penyusutan Aset & Pengakuan Pendapatan Dimuka (garis
      // lurus, otomatis per bulan). Tabel register baru + kolom
      // nilai_residu di aset_tetap (default 0 untuk baris lama —
      // "harga perolehan - 0 = harga perolehan penuh disusutkan",
      // perilaku standar kalau residu tidak pernah diisi).
      await tambahKolomJikaBelumAda('aset_tetap', 'nilai_residu', 'INTEGER NOT NULL DEFAULT 0');

      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS aset_penyusutan (
          id TEXT PRIMARY KEY,
          aset_id TEXT NOT NULL REFERENCES aset_tetap(id),
          periode TEXT NOT NULL,
          tanggal TEXT NOT NULL,
          nilai_penyusutan INTEGER NOT NULL,
          journal_id TEXT NOT NULL REFERENCES journal(id),
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(aset_id, periode)
        );
        CREATE INDEX IF NOT EXISTS idx_aset_penyusutan_aset ON aset_penyusutan(aset_id);
        CREATE INDEX IF NOT EXISTS idx_aset_penyusutan_periode ON aset_penyusutan(periode);

        CREATE TABLE IF NOT EXISTS pendapatan_dimuka_pengakuan (
          id TEXT PRIMARY KEY,
          pendapatan_dimuka_id TEXT NOT NULL REFERENCES pendapatan_diterima_dimuka(id),
          periode TEXT NOT NULL,
          urutan_bulan INTEGER NOT NULL,
          tanggal TEXT NOT NULL,
          nilai_pengakuan INTEGER NOT NULL,
          journal_id TEXT NOT NULL REFERENCES journal(id),
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(pendapatan_dimuka_id, periode)
        );
        CREATE INDEX IF NOT EXISTS idx_dimuka_pengakuan_dimuka ON pendapatan_dimuka_pengakuan(pendapatan_dimuka_id);
        CREATE INDEX IF NOT EXISTS idx_dimuka_pengakuan_periode ON pendapatan_dimuka_pengakuan(periode);
      `);
    }
    if (currentVersion < 7) {
      // Phase 2 (AUDIT_INTERNAL.md): kolom idempotency_key nullable di
      // tabel transaksi finansial utama yang sebelumnya tidak punya
      // proteksi duplikasi selain nomor_transaksi (yang selalu unik
      // sendiri karena di-generate otomatis, jadi TIDAK mencegah
      // double-submit dari UI — dua submit identik tetap dapat nomor
      // beda-beda). Kolom ini nullable & UNIQUE INDEX-nya cuma berlaku
      // untuk baris yang benar-benar mengisi idempotency_key (partial
      // index `WHERE idempotency_key IS NOT NULL`) — jadi data lama
      // (semua NULL) sama sekali tidak terpengaruh, dan pemanggil yang
      // belum diupdate untuk mengirim key (phase berikutnya) tetap
      // berjalan seperti biasa.
      const tambahIdempotencyKey = async (tabel: string, indexName: string) => {
        await tambahKolomJikaBelumAda(tabel, 'idempotency_key', 'TEXT');
        await db.execAsync(
          `CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${tabel}(idempotency_key) WHERE idempotency_key IS NOT NULL;`
        );
      };
      await tambahIdempotencyKey('simpanan_transaksi', 'idx_simpanan_idempotency');
      await tambahIdempotencyKey('angsuran_pembayaran', 'idx_angsuran_bayar_idempotency');
      await tambahIdempotencyKey('kas_transaksi', 'idx_kas_idempotency');
      await tambahIdempotencyKey('bank_transaksi', 'idx_bank_idempotency');
      await tambahIdempotencyKey('utang_pembayaran', 'idx_utang_bayar_idempotency');
    }
    if (currentVersion < 9) {
      // Phase 10 (AUDIT_INTERNAL.md): fitur Biaya Dibayar Dimuka —
      // kebalikan simetris dari Pendapatan Diterima Dimuka (v6).
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS biaya_dibayar_dimuka (
          id TEXT PRIMARY KEY,
          nomor_transaksi TEXT NOT NULL UNIQUE,
          nama_biaya TEXT NOT NULL,
          akun_beban_id TEXT NOT NULL REFERENCES account(id),
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
      `);
    }
    if (currentVersion < 10) {
      // Phase 11 (AUDIT_INTERNAL.md): rekonsiliasi kas/bank — dasar
      // syarat sebelum periode boleh ditutup. Kolom closed_at/closed_by
      // di accounting_period SUDAH ADA sejak skema awal (belum pernah
      // dipakai) — tidak perlu ALTER TABLE untuk itu.
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS rekonsiliasi_kas_bank (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES account(id),
          nama_rekening TEXT NOT NULL,
          tanggal TEXT NOT NULL,
          saldo_buku INTEGER NOT NULL,
          saldo_fisik INTEGER NOT NULL,
          selisih INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('COCOK','SELISIH')),
          keterangan TEXT,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rekonsiliasi_account ON rekonsiliasi_kas_bank(account_id);
        CREATE INDEX IF NOT EXISTS idx_rekonsiliasi_tanggal ON rekonsiliasi_kas_bank(tanggal);
      `);
    }
    if (currentVersion < 11) {
      // Fitur "Kewajiban" (Pengeluaran) sebelumnya TIDAK PERNAH bisa
      // melunasi utang usaha yang timbul dari pembelian aset metode
      // KREDIT (AsetService.beliAset menjurnal langsung ke akun "Utang
      // Usaha" tanpa membuat baris apa pun di tabel `utang` — jadi
      // tidak pernah muncul di UtangPicker/listUtang). Tabel `utang`
      // dibangun ulang (SQLite tidak bisa ALTER CHECK constraint
      // langsung, sama seperti migrasi v3) supaya:
      //  - jenis_pemberi bisa 'UTANG_USAHA' (baris otomatis dari
      //    pembelian aset kredit, bukan input manual "Utang")
      //  - sumber_dana jadi NULLABLE (utang usaha timbul non-kas, tidak
      //    ada kas/bank yang diterima saat itu — beda dari BANK/
      //    PIHAK_LAIN yang selalu mencairkan kas/bank)
      //  - kolom baru `sumber` (LANGSUNG/PEMBELIAN_ASET) & `aset_tetap_id`
      //    untuk menaut ke aset yang dibeli.
      // Data lama (semua dari sub-fitur "Utang" manual) disalin apa
      // adanya dengan sumber='LANGSUNG', aset_tetap_id=NULL.
      await db.withTransactionAsync(async () => {
        const tableInfo = await db.getFirstAsync<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='utang'`
        );
        if (tableInfo) {
          await db.execAsync(`
            CREATE TABLE IF NOT EXISTS utang_new (
              id TEXT PRIMARY KEY,
              nomor_utang TEXT NOT NULL UNIQUE,
              nama_pemberi TEXT NOT NULL,
              jenis_pemberi TEXT NOT NULL CHECK (jenis_pemberi IN ('BANK','PIHAK_LAIN','UTANG_USAHA')),
              pokok_pinjaman INTEGER NOT NULL,
              persen_bunga REAL NOT NULL DEFAULT 0,
              jenis_bunga TEXT NOT NULL CHECK (jenis_bunga IN ('FLAT','EFEKTIF','LAINNYA')) DEFAULT 'FLAT',
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
          `);
          await db.execAsync(`
            INSERT INTO utang_new (id, nomor_utang, nama_pemberi, jenis_pemberi, pokok_pinjaman,
              persen_bunga, jenis_bunga, tanggal, sumber_dana, bank_account_id, sumber, aset_tetap_id,
              status, keterangan, journal_id, created_by, created_at, updated_at)
            SELECT id, nomor_utang, nama_pemberi, jenis_pemberi, pokok_pinjaman,
              persen_bunga, jenis_bunga, tanggal, sumber_dana, bank_account_id, 'LANGSUNG', NULL,
              status, keterangan, journal_id, created_by, created_at, updated_at FROM utang;
          `);
          await db.execAsync(`DROP TABLE utang;`);
          await db.execAsync(`ALTER TABLE utang_new RENAME TO utang;`);
          await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_utang_status ON utang(status);`);
          await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_utang_aset_tetap ON utang(aset_tetap_id);`);
        }
      });
    }
    if (currentVersion < 12) {
      // Fitur "Investasi" (Pengeluaran, dikelompokkan dengan Kewajiban)
      // — penyertaan koperasi pada unit usaha sendiri/koperasi lain.
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS investasi (
          id TEXT PRIMARY KEY,
          nomor_investasi TEXT NOT NULL UNIQUE,
          jenis_investasi TEXT NOT NULL CHECK (jenis_investasi IN ('UNIT_USAHA','KOPERASI_LAIN')),
          nama_tujuan TEXT NOT NULL,
          jumlah INTEGER NOT NULL,
          tanggal TEXT NOT NULL,
          sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
          bank_account_id TEXT REFERENCES bank_account(id),
          keterangan TEXT,
          journal_id TEXT REFERENCES journal(id),
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_investasi_tanggal ON investasi(tanggal);
      `);
    }
    if (currentVersion < 13) {
      // Hub "Input Data" (rename dari "Kas & Bank" di menu Transaksi) —
      // master data ringan: Pemasok, Pemberi Pinjaman Bank/Pihak Lain,
      // Beban Lain. Lihat komentar lengkap di schema.ts §9c-ter.
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS data_referensi (
          id TEXT PRIMARY KEY,
          jenis TEXT NOT NULL CHECK (jenis IN ('PEMASOK','PEMBERI_PINJAMAN_BANK','PEMBERI_PINJAMAN_PIHAK_LAIN','BEBAN_LAIN')),
          nama TEXT NOT NULL,
          keterangan TEXT,
          aktif INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_data_referensi_jenis ON data_referensi(jenis);
      `);
    }
    if (currentVersion < 14) {
      // Bagian E (permintaan pengguna): akun "Penyertaan pada Unit
      // Usaha & Koperasi Lain" (1-1600, dibuat sesi sebelumnya)
      // dipecah jadi 2 akun terpisah — 1-1600 tetap dipakai TAPI
      // di-rename khusus "Penyertaan pada Unit Usaha", dan 1-1610
      // BARU untuk "Penyertaan pada Koperasi Lain" (ditambahkan
      // otomatis oleh blok self-heal COA di bawah, karena sudah ada
      // di DEFAULT_ACCOUNTS). Rename di-guard hanya kalau nama akun
      // MASIH PERSIS nama gabungan default lama — supaya tidak
      // menimpa kalau admin sudah mengubah nama akun ini secara
      // manual lewat Pengaturan.
      //
      // CATATAN JUJUR: jurnal LAMA yang sudah terlanjur dibuat ke
      // akun 1-1600 SEBELUM migrasi ini (baik untuk investasi jenis
      // UNIT_USAHA maupun KOPERASI_LAIN, karena dulu akunnya memang
      // digabung) TETAP menunjuk ke 1-1600 apa adanya — TIDAK
      // dipindah/direkonstruksi (prinsip "jangan mengubah histori
      // jurnal"). Baris `investasi.jenis_investasi` tetap menyimpan
      // jenis yang benar untuk keperluan pelaporan/rincian, hanya
      // GL/Neraca Saldo historis dari sebelum migrasi ini yang masih
      // menampilkan gabungan di bawah label baru "Penyertaan pada
      // Unit Usaha" walau sebagian sebenarnya KOPERASI_LAIN.
      await db.runAsync(
        `UPDATE account SET nama = 'Penyertaan pada Unit Usaha', updated_at = ?
         WHERE kode = '1-1600' AND nama = 'Penyertaan pada Unit Usaha & Koperasi Lain'`,
        new Date().toISOString()
      );
    }
    if (currentVersion < 15) {
      // Bagian G (permintaan pengguna): kelompok/sub-kelompok aset —
      // kolom NULLABLE ditambahkan ke aset_tetap (aset lama tetap
      // terbaca apa adanya, fallback "Belum Diklasifikasikan" di
      // layar). Tabel aset_klasifikasi (master data, lihat schema.ts
      // §9c-quater) dibuat lewat CREATE TABLE IF NOT EXISTS langsung
      // (bukan lewat tambahKolomJikaBelumAda — itu untuk ALTER TABLE
      // kolom, bukan tabel baru).
      await tambahKolomJikaBelumAda('aset_tetap', 'kelompok_aset', 'TEXT');
      await tambahKolomJikaBelumAda('aset_tetap', 'sub_kelompok_aset', 'TEXT');
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS aset_klasifikasi (
          id TEXT PRIMARY KEY,
          kelompok TEXT NOT NULL,
          sub_kelompok TEXT NOT NULL,
          masa_manfaat_bulan_default INTEGER,
          aktif INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(kelompok, sub_kelompok)
        );
        CREATE INDEX IF NOT EXISTS idx_aset_klasifikasi_kelompok ON aset_klasifikasi(kelompok);
      `);
    }
    if (currentVersion < 16) {
      // Bagian H (permintaan pengguna): Saldo Awal untuk akun apa pun.
      await db.execAsync(`
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
      `);
    }

    if (currentVersion < 17) {
      // Phase 17 §U/§V: Data Pemasok & Data Pemberi Pinjaman butuh
      // field Alamat (sebelumnya cuma nama+keterangan). Kolom
      // ditambahkan ke `data_referensi` yang sudah ada (bukan tabel
      // baru) — NULLABLE supaya data lama tetap valid tanpa perlu
      // diisi ulang, dan jenis PEMBERI_PINJAMAN_BANK/BEBAN_LAIN yang
      // tidak butuh alamat cukup membiarkannya kosong.
      await tambahKolomJikaBelumAda('data_referensi', 'alamat', 'TEXT');
    }

    if (currentVersion < 18) {
      // Phase 18 §2/§4 (permintaan pengguna): akun Kas Kecil (1-1001)
      // dan Penyertaan pada Unit Usaha (1-1600) dinonaktifkan — BUKAN
      // dihapus fisik, supaya jurnal lama yang sudah menunjuk akun ini
      // tetap valid & tetap ikut terhitung di Laporan Posisi Keuangan
      // (FinancialReports.getStatementOfFinancialPosition query akun
      // TANPA filter is_active, lihat komentar di sana). Mapping
      // transaksi otomatis yang menunjuk keduanya juga dihapus supaya
      // resolveAccountId() menolak transaksi BARU yang mencoba
      // memakainya (MissingAccountMappingError) — listRekening() &
      // getTotalSaldoKas() sudah ditulis ulang supaya ini tidak
      // menyebabkan error, cukup diperlakukan sebagai "tidak
      // tersedia"/0, bukan gagal total.
      await db.runAsync(
        `UPDATE account SET is_active = 0, updated_at = ? WHERE kode IN ('1-1001','1-1600') AND is_active = 1`,
        new Date().toISOString()
      );
      await db.execAsync(
        `DELETE FROM account_mapping WHERE transaction_type IN ('KAS_KECIL','INVESTASI_UNIT_USAHA');`
      );
    }

    if (currentVersion < 19) {
      // Phase 18 §3 (permintaan pengguna): tabel RAK (Rekening Antar
      // Kantor) — idempotent lewat CREATE TABLE IF NOT EXISTS, sama
      // seperti tabel baru versi-versi sebelumnya (investasi di v12,
      // dst). Lihat schema.ts §9c-quinquies untuk penjelasan desain.
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS rak_transaksi (
          id TEXT PRIMARY KEY,
          nomor_rak TEXT NOT NULL UNIQUE,
          jenis_rak TEXT NOT NULL CHECK (jenis_rak IN ('PENYALURAN_DANA','SETORAN_DANA')),
          nama_unit TEXT NOT NULL,
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
      `);
    }

    if (currentVersion < 20) {
      // Phase 18 §14-19 (permintaan pengguna): master Kelompok/Sub
      // Kelompok Aset default (Kelompok 1-4) — sebelumnya
      // `aset_klasifikasi` sengaja kosong di instalasi manapun, sekarang
      // diisi untuk instalasi LAMA juga (self-heal, sama pola dengan
      // self-heal COA di bawah) — cek existence per (kelompok,
      // sub_kelompok) [UNIQUE constraint tabel ini], tidak menyentuh
      // baris yang admin sudah ubah/tambah sendiri. Instalasi baru
      // sudah diisi lewat SetupService.setupKoperasi() saat setup
      // pertama kali (pola yang sama dengan DEFAULT_ACCOUNTS).
      const now = new Date().toISOString();
      const existingKlasifikasi = await db.getAllAsync<{ kelompok: string; sub_kelompok: string }>(
        `SELECT kelompok, sub_kelompok FROM aset_klasifikasi`
      );
      const existingKeys = new Set(
        existingKlasifikasi.map((k) => `${k.kelompok.toLowerCase()}::${k.sub_kelompok.toLowerCase()}`)
      );
      for (const k of DEFAULT_ASET_KLASIFIKASI) {
        // Audit ulang (permintaan pengguna §18): entri dengan
        // `masaManfaatBulanDefault === null` (Kelompok 5 "Lainnya")
        // SENGAJA DILEWATI di sini — kolomnya bisa saja masih
        // NOT NULL di titik migrasi ini (belum tentu migration v29
        // sudah menjalankan rebuild tabel nullable). Entri null
        // di-seed belakangan oleh migration v29 SETELAH tabel
        // dipastikan nullable, supaya tidak pernah mencoba INSERT NULL
        // ke kolom yang masih NOT NULL.
        if (k.masaManfaatBulanDefault === null) continue;
        const key = `${k.kelompok.toLowerCase()}::${k.subKelompok.toLowerCase()}`;
        if (existingKeys.has(key)) continue;
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
    }

    if (currentVersion < 21) {
      // Update pasca-Phase 18 §12/§13 (permintaan pengguna): tabel
      // `rat` (Rapat Anggota Tahunan) — idempotent lewat CREATE TABLE
      // IF NOT EXISTS, sama seperti tabel baru versi-versi sebelumnya.
      await db.execAsync(`
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
      `);
    }

    if (currentVersion < 22) {
      // Update pasca-Phase 18 §9/§10 (permintaan pengguna): status
      // soft-delete + updated_at pada aset_tetap (Edit/Delete aset).
      await tambahKolomJikaBelumAda('aset_tetap', 'status', `TEXT NOT NULL DEFAULT 'AKTIF'`);
      await tambahKolomJikaBelumAda('aset_tetap', 'updated_at', 'TEXT');
    }

    if (currentVersion < 23) {
      // Update pasca-Phase 18 §11 (permintaan pengguna): Edit/Delete
      // Investasi — kolom status/reversal_of_id/updated_at, pola SAMA
      // PERSIS dengan rak_transaksi (Batch 2).
      await tambahKolomJikaBelumAda('investasi', 'status', `TEXT NOT NULL DEFAULT 'AKTIF'`);
      await tambahKolomJikaBelumAda('investasi', 'reversal_of_id', 'TEXT');
      await tambahKolomJikaBelumAda('investasi', 'updated_at', 'TEXT');
    }

    if (currentVersion < 24) {
      // Update pasca-Phase 18/19 (permintaan pengguna §N/§O): rename 3
      // akun existing — HANYA kalau nama SAAT INI masih persis nama
      // lama (kalau admin sudah mengubah namanya sendiri, JANGAN
      // ditimpa — instruksi eksplisit "migration/self-heal harus
      // mengubah nama hanya jika nama lama masih 'Modal Lainnya'").
      // Kode akun (3-3000/5-1050/5-1900) TIDAK berubah, histori jurnal
      // sama sekali tidak tersentuh (jurnal merujuk account_id, bukan
      // nama).
      const now = new Date().toISOString();
      const renameJikaBelumDiubah = async (kode: string, namaLama: string, namaBaru: string) => {
        await db.runAsync(
          `UPDATE account SET nama = ?, updated_at = ? WHERE kode = ? AND nama = ?`,
          namaBaru,
          now,
          kode,
          namaLama
        );
      };
      await renameJikaBelumDiubah('3-3000', 'Modal Lainnya', 'Ekuitas Lainnya');
      await renameJikaBelumDiubah('5-1050', 'Beban Tenaga Kerja', 'Beban Imbalan Kerja');
      await renameJikaBelumDiubah('5-1900', 'Beban RAT', 'Beban Perkoperasian');
      // Akun baru "Beban Pajak Penghasilan" (5-2200, §O.20) TIDAK
      // perlu migrasi khusus di sini — sudah otomatis dibuat lewat
      // blok self-heal COA generik di bawah (baru di DEFAULT_ACCOUNTS,
      // belum ada kode-nya di database lama).

      // Update pasca-Phase 18/19 (permintaan pengguna §U): 2 kolom
      // persentase baru di shu_konfigurasi — DEFAULT 0 aman untuk data
      // lama (konfigurasi SHU existing tetap total 100% tanpa
      // perubahan apa pun pada nilai kolom lainnya).
      await tambahKolomJikaBelumAda('shu_konfigurasi', 'persen_karyawan', 'REAL NOT NULL DEFAULT 0');
      await tambahKolomJikaBelumAda('shu_konfigurasi', 'persen_pembangunan_daerah_kerja', 'REAL NOT NULL DEFAULT 0');

      // Update pasca-Phase 18/19 (permintaan pengguna §H): lock saldo
      // awal permanen — tabel singleton TERPISAH (bukan baris di
      // app_config) karena butuh menyimpan SIAPA & KAPAN mengunci
      // (audit trail eksplisit), bukan cuma satu nilai konfigurasi.
      // (§F — mode penyusutan otomatis/manual TIDAK butuh tabel baru:
      // audit menemukan `app_config` — tabel key-value generik yang
      // SUDAH ADA sejak awal, dipakai `AccountingPolicyService` —
      // adalah persis "struktur setting existing" yang instruksi minta
      // dicek dulu sebelum bikin tabel baru. Dipakai ulang lewat
      // `PenyusutanService.getModePenyusutan()`/`setModePenyusutan()`.)
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS saldo_awal_lock (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          locked_at TEXT NOT NULL,
          locked_by TEXT NOT NULL
        );
      `);
    }

    if (currentVersion < 25) {
      // Prioritas 8/J (Aset Tak Berwujud & Amortisasi): akun COA
      // (1-1700, 1-1710, 5-1310) dan mapping (ASET_TAK_BERWUJUD,
      // AMORTISASI_ASET_TAK_BERWUJUD) SUDAH ADA di defaultCOA.ts sejak
      // sebelumnya (sudah otomatis tersedia untuk instalasi lama lewat
      // blok self-heal COA generik di bawah — tidak perlu diulang di
      // sini). Yang BELUM ada & baru ditambahkan sekarang: kolom
      // diskriminator `jenis_aset` di tabel `aset_tetap` (REUSE tabel
      // existing, bukan tabel baru — lihat komentar di schema.ts),
      // supaya AsetService/PenyusutanService bisa membedakan aset
      // tetap vs aset tak berwujud memakai satu mekanisme yang sama.
      // DEFAULT 'TETAP' otomatis aman untuk seluruh baris lama (semua
      // aset yang sudah tercatat sebelum ini memang aset tetap).
      await tambahKolomJikaBelumAda('aset_tetap', 'jenis_aset', "TEXT NOT NULL DEFAULT 'TETAP'");
    }

    if (currentVersion < 26) {
      // Phase 17 §8/§12 (Investment Impairment): akun & mapping COA
      // (1-1900, 5-2150, IMPAIRMENT_INVESTASI) sudah didaftarkan di
      // defaultCOA.ts — otomatis tersedia untuk instalasi lama lewat
      // blok self-heal COA generik di bawah (tidak perlu diulang di
      // sini). Yang benar-benar baru: tabel register
      // `investasi_impairment` (additive, CREATE TABLE IF NOT EXISTS,
      // tidak menyentuh tabel/data manapun yang sudah ada).
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS investasi_impairment (
          id TEXT PRIMARY KEY,
          investasi_id TEXT NOT NULL REFERENCES investasi(id),
          tanggal TEXT NOT NULL,
          nilai_tercatat_sebelum INTEGER NOT NULL,
          indikasi_penurunan_nilai TEXT NOT NULL,
          dasar_penilaian TEXT NOT NULL,
          nilai_impairment INTEGER NOT NULL CHECK (nilai_impairment > 0),
          alasan TEXT NOT NULL,
          journal_id TEXT NOT NULL REFERENCES journal(id),
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_investasi_impairment_investasi ON investasi_impairment(investasi_id);`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_investasi_impairment_tanggal ON investasi_impairment(tanggal);`);
    }

    if (currentVersion < 27) {
      // Phase 18 (Refactor Saldo Awal): SENGAJA tidak ada blok migrasi
      // skema di sini — akun baru (3-5000 "Saldo Awal Belum Sesuai")
      // dan mapping (`KOREKSI_SALDO_AWAL`) sudah didaftarkan di
      // defaultCOA.ts, otomatis tersedia lewat blok self-heal COA
      // generik di bawah (yang HANYA jalan kalau ada upgrade versi —
      // makanya versi tetap perlu dinaikkan, pola sama persis dengan
      // v8/Phase 8 untuk PENYISIHAN_PIUTANG, lihat komentar self-heal
      // COA). Tabel `saldo_awal_akun`/`saldo_awal_lock` yang sudah ada
      // TIDAK perlu kolom baru — `journal_id` yang sudah nullable
      // sejak awal itulah yang membedakan DRAFT (NULL) vs POSTED
      // (terisi), tanpa perlu kolom status terpisah.
    }

    if (currentVersion < 28) {
      // Audit ulang §2/§3/§4 (permintaan pengguna): akun Persediaan
      // (1-1300) dihapus dari daftar seed instalasi baru (lihat
      // defaultCOA.ts). Untuk instalasi LAMA yang mungkin sudah punya
      // akun ini: kalau BELUM PERNAH dipakai sama sekali (tidak ada
      // jurnal/saldo awal/transaksi/mapping/referensi apa pun) —
      // dihapus fisik. Kalau SUDAH PERNAH dipakai — HANYA dinonaktifkan
      // (is_active = 0), TIDAK dihapus, supaya histori jurnal/laporan
      // lama yang sudah menunjuk akun ini tetap valid (pola sama
      // persis dengan 1-1001/1-1600 di migration v18). Akun dana SHU
      // baru (2-1800..2-1850) TIDAK perlu blok migrasi khusus di sini —
      // sudah otomatis dibuat & dipetakan lewat blok self-heal COA
      // generik di bawah (sudah ada di DEFAULT_ACCOUNTS/DEFAULT_ACCOUNT_MAPPING
      // sejak sebelumnya, pola yang sama dengan v8/v25/v26/v27).
      const persediaan = await db.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = '1-1300'`);
      if (persediaan) {
        const accId = persediaan.id;
        const referensi = await db.getFirstAsync<{ cnt: number }>(
          `SELECT (
             (SELECT COUNT(*) FROM journal_entry WHERE account_id = ?) +
             (SELECT COUNT(*) FROM saldo_awal_akun WHERE account_id = ?) +
             (SELECT COUNT(*) FROM account_mapping WHERE account_id = ?) +
             (SELECT COUNT(*) FROM bank_account WHERE account_id = ?) +
             (SELECT COUNT(*) FROM kas_transaksi WHERE akun_lawan_id = ?) +
             (SELECT COUNT(*) FROM bank_transaksi WHERE akun_lawan_id = ?) +
             (SELECT COUNT(*) FROM biaya_dibayar_dimuka WHERE akun_beban_id = ?) +
             (SELECT COUNT(*) FROM rekonsiliasi_kas_bank WHERE account_id = ?) +
             (SELECT COUNT(*) FROM account WHERE parent_id = ?)
           ) as cnt`,
          accId, accId, accId, accId, accId, accId, accId, accId, accId
        );
        if ((referensi?.cnt ?? 0) === 0) {
          await db.runAsync(`DELETE FROM account WHERE id = ?`, accId);
        } else {
          await db.runAsync(
            `UPDATE account SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1`,
            new Date().toISOString(),
            accId
          );
        }
      }

      // Audit ulang §5/§9 (permintaan pengguna): mapping SHU_DISTRIBUSI
      // lama untuk role gabungan `KREDIT_DANA_LAINNYA` (-> 3-3000)
      // TIDAK dipakai lagi oleh ShuService.ts (6 dana sekarang
      // masing-masing punya role/akun sendiri, lihat DEFAULT_ACCOUNT_MAPPING).
      // Baris account_mapping ini TETAP DIPERTAHANKAN apa adanya (TIDAK
      // dihapus, dan TETAP di-self-heal lewat blok generik di bawah) —
      // role ini masih dipakai AKTIF oleh fitur LAIN yang di luar scope
      // audit ini (KasBankService.tambahRekeningBank/catatSaldoAwalKas,
      // AsetService — saldo awal ke akun "Ekuitas Lainnya"). Menghapus
      // baris ini akan membuat fitur tersebut gagal total.
    }

    if (currentVersion < 29) {
      // ============================================================
      // RC-S51 §2A — REBUILD DIBUNGKUS SATU TRANSAKSI
      // ============================================================
      // TEMUAN AUDIT P1. Prosedur rebuild tabel resmi SQLite terdiri
      // dari empat langkah yang HARUS berhasil bersama:
      //
      //     CREATE TABLE ..._new -> INSERT SELECT -> DROP TABLE lama
      //     -> ALTER TABLE ..._new RENAME TO lama
      //
      // Sebelum RC ini blok ini dijalankan TANPA transaksi, sehingga
      // setiap langkah auto-commit sendiri. Exception (atau proses yang
      // mati) di antara langkah 3 dan 4 meninggalkan database dalam
      // keadaan tabel lama SUDAH HILANG sementara penggantinya masih
      // bernama `..._new` — skema separuh jadi yang tidak bisa dipakai
      // dan tidak bisa diulang dengan aman.
      //
      // `withTransactionAsync` membuat keempatnya atomik: kalau salah
      // satu gagal, SQLite me-rollback seluruhnya dan database kembali
      // ke keadaan sebelum blok ini berjalan. `schema_meta.version`
      // baru dinaikkan setelah SELURUH blok migrasi selesai (lihat
      // akhir fungsi), jadi percobaan berikutnya mengulang dari versi
      // yang sama — bukan melanjutkan dari tengah.
      //
      // Isi blok TIDAK diubah sama sekali: hanya dipindahkan ke dalam
      // callback transaksi. Tidak ada satu pun kolom, DDL, atau baris
      // data yang berbeda dari sebelumnya.
      await db.withTransactionAsync(async () => {
        // Audit ulang (permintaan pengguna §18/§29C): kolom
        // `masa_manfaat_bulan_default` di `aset_klasifikasi` harus boleh
        // NULL (Kelompok 5 "Lainnya" tidak punya masa manfaat pasti).
        // SQLite tidak mendukung ALTER COLUMN DROP NOT NULL secara
        // langsung — rebuild tabel pakai pola standar SQLite (buat tabel
        // baru dengan skema benar, salin SELURUH data apa adanya, hapus
        // tabel lama, ganti nama). Dicek dulu lewat PRAGMA supaya
        // idempotent (aman dijalankan berkali-kali / pada instalasi yang
        // tabelnya sudah nullable dari awal via CREATE_TABLES_SQL/v15
        // yang sudah diperbarui). Data existing (termasuk yang sudah
        // punya masa manfaat) TIDAK diubah nilainya sama sekali.
        const kolomInfo = await db.getAllAsync<{ name: string; notnull: number }>(
          `PRAGMA table_info(aset_klasifikasi)`
        );
        const kolomMasaManfaat = kolomInfo.find((c) => c.name === 'masa_manfaat_bulan_default');
        if (kolomMasaManfaat && kolomMasaManfaat.notnull === 1) {
          await db.execAsync(`
            CREATE TABLE aset_klasifikasi_v29new (
              id TEXT PRIMARY KEY,
              kelompok TEXT NOT NULL,
              sub_kelompok TEXT NOT NULL,
              masa_manfaat_bulan_default INTEGER,
              aktif INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(kelompok, sub_kelompok)
            );
            INSERT INTO aset_klasifikasi_v29new (id, kelompok, sub_kelompok, masa_manfaat_bulan_default, aktif, created_at, updated_at)
              SELECT id, kelompok, sub_kelompok, masa_manfaat_bulan_default, aktif, created_at, updated_at FROM aset_klasifikasi;
            DROP TABLE aset_klasifikasi;
            ALTER TABLE aset_klasifikasi_v29new RENAME TO aset_klasifikasi;
            CREATE INDEX IF NOT EXISTS idx_aset_klasifikasi_kelompok ON aset_klasifikasi(kelompok);
          `);
        }

        // Audit ulang §17/§18: seed sub-kelompok Kelompok 3 yang baru
        // (menggantikan placeholder "Sub Kelompok Lainnya...", yang TETAP
        // DIBIARKAN di database lama — tidak dihapus, cuma tidak dipakai
        // lagi sebagai default) & Kelompok 5 "Lainnya" (masa manfaat
        // null). Self-heal — sama pola persis dengan migration v20 di
        // atas (cek existing key dulu, tidak menimpa data admin), TAPI
        // dijalankan SETELAH tabel dipastikan nullable di atas, jadi
        // AMAN meng-insert entri dengan masa_manfaat_bulan_default NULL.
        // Cakupan penuh atas DEFAULT_ASET_KLASIFIKASI (bukan cuma yang
        // di-skip migration v20) supaya idempotent untuk SEMUA jalur
        // (instalasi lama di versi berapa pun, termasuk yang sudah lewat
        // v20 sebelumnya dan tidak pernah melihat entri baru ini).
        const nowKlasifikasi = new Date().toISOString();
        const existingKlasifikasiV29 = await db.getAllAsync<{ kelompok: string; sub_kelompok: string }>(
          `SELECT kelompok, sub_kelompok FROM aset_klasifikasi`
        );
        const existingKeysV29 = new Set(
          existingKlasifikasiV29.map((k) => `${k.kelompok.toLowerCase()}::${k.sub_kelompok.toLowerCase()}`)
        );
        for (const k of DEFAULT_ASET_KLASIFIKASI) {
          const key = `${k.kelompok.toLowerCase()}::${k.subKelompok.toLowerCase()}`;
          if (existingKeysV29.has(key)) continue;
          await db.runAsync(
            `INSERT INTO aset_klasifikasi (id, kelompok, sub_kelompok, masa_manfaat_bulan_default, aktif, created_at, updated_at)
             VALUES (?,?,?,?,1,?,?)`,
            newId(),
            k.kelompok,
            k.subKelompok,
            k.masaManfaatBulanDefault,
            nowKlasifikasi,
            nowKlasifikasi
          );
        }
    });
    }

    if (currentVersion < 30) {
      // Audit ulang (permintaan pengguna §12): rename akun "Cadangan"
      // (3-2000) menjadi "Cadangan Umum" — HANYA UPDATE nama, kode
      // TIDAK berubah, jurnal historis tetap menunjuk ke account_id
      // yang sama persis. Filter `nama = 'Cadangan'` (bukan hanya
      // `kode = '3-2000'`) supaya TIDAK menimpa kalau admin sudah
      // pernah mengganti nama akun ini sendiri secara manual sebelum
      // update ini — pola yang sama dengan migration v14 (rename akun
      // 1-1600) di atas.
      await db.runAsync(
        `UPDATE account SET nama = 'Cadangan Umum', updated_at = ? WHERE kode = '3-2000' AND nama = 'Cadangan'`,
        new Date().toISOString()
      );

      // Audit ulang §13/§16: kolom `persen_cadangan_risiko` untuk
      // instalasi LAMA yang tabelnya dibuat sebelum kolom ini ada di
      // skema. DEFAULT 0 (lihat komentar di schema.ts) — TIDAK
      // mengubah nilai persentase komponen lain yang sudah tersimpan,
      // dan TIDAK melakukan normalisasi otomatis supaya total tetap
      // 100% (kalau sebelumnya sudah 100%, sekarang jadi belum 100%
      // karena ada komponen baru bernilai 0% — admin perlu menyesuaikan
      // sendiri lewat Form SHU, sesuai instruksi eksplisit: "jangan
      // menormalisasi otomatis").
      await tambahKolomJikaBelumAda('shu_konfigurasi', 'persen_cadangan_risiko', 'REAL NOT NULL DEFAULT 0');

      // Akun "Cadangan Risiko" (3-2100) & mapping SHU_DISTRIBUSI/
      // KREDIT_CADANGAN_RISIKO otomatis tersedia lewat self-heal COA
      // generik di bawah (sudah ada di DEFAULT_ACCOUNTS/
      // DEFAULT_ACCOUNT_MAPPING sejak update ini) — TIDAK perlu blok
      // migrasi khusus di sini, pola yang sama dengan v27/v28/v29.
    }

    if (currentVersion < 31) {
      // ============================================================
      // RC-S51 §2A — REBUILD DIBUNGKUS SATU TRANSAKSI
      // ============================================================
      // TEMUAN AUDIT P1. Prosedur rebuild tabel resmi SQLite terdiri
      // dari empat langkah yang HARUS berhasil bersama:
      //
      //     CREATE TABLE ..._new -> INSERT SELECT -> DROP TABLE lama
      //     -> ALTER TABLE ..._new RENAME TO lama
      //
      // Sebelum RC ini blok ini dijalankan TANPA transaksi, sehingga
      // setiap langkah auto-commit sendiri. Exception (atau proses yang
      // mati) di antara langkah 3 dan 4 meninggalkan database dalam
      // keadaan tabel lama SUDAH HILANG sementara penggantinya masih
      // bernama `..._new` — skema separuh jadi yang tidak bisa dipakai
      // dan tidak bisa diulang dengan aman.
      //
      // `withTransactionAsync` membuat keempatnya atomik: kalau salah
      // satu gagal, SQLite me-rollback seluruhnya dan database kembali
      // ke keadaan sebelum blok ini berjalan. `schema_meta.version`
      // baru dinaikkan setelah SELURUH blok migrasi selesai (lihat
      // akhir fungsi), jadi percobaan berikutnya mengulang dari versi
      // yang sama — bukan melanjutkan dari tengah.
      //
      // Isi blok TIDAK diubah sama sekali: hanya dipindahkan ke dalam
      // callback transaksi. Tidak ada satu pun kolom, DDL, atau baris
      // data yang berbeda dari sebelumnya.
      await db.withTransactionAsync(async () => {
        // Audit ulang (permintaan pengguna §2/§3/§4/§29A): 5 jenis
        // investasi baru (Usaha Lain, Tabungan/Giro/Deposito Bank Umum,
        // Properti Investasi) + 2 kolom OPSIONAL baru (nomor rekening
        // untuk Bank Umum, lokasi untuk Properti Investasi).
        //
        // 1) Kolom baru — ALTER TABLE ADD COLUMN biasa cukup (nullable,
        //    tidak perlu rebuild tabel).
        await tambahKolomJikaBelumAda('investasi', 'nomor_rekening_investasi', 'TEXT');
        await tambahKolomJikaBelumAda('investasi', 'lokasi_properti', 'TEXT');

        // 2) CHECK constraint pada `jenis_investasi` SEBELUMNYA hanya
        //    mengizinkan ('UNIT_USAHA','KOPERASI_LAIN') — SQLite tidak
        //    mendukung ALTER TABLE untuk mengubah CHECK constraint secara
        //    langsung, jadi tabel di-rebuild (pola SAMA PERSIS dengan
        //    migration v29 untuk aset_klasifikasi): buat tabel baru dengan
        //    CHECK yang sudah diperluas, salin SELURUH data & kolom apa
        //    adanya (termasuk 2 kolom baru di atas yang mungkin baru saja
        //    ditambahkan), hapus tabel lama, ganti nama. Dicek dulu lewat
        //    sql_master supaya idempotent & tidak rebuild kalau tabel
        //    sudah punya CHECK yang benar (mis. instalasi baru yang
        //    schema-nya sudah lewat CREATE_TABLES_SQL terbaru). Data
        //    existing (termasuk histori UNIT_USAHA lama) TIDAK berubah.
        const investasiDdl = await db.getFirstAsync<{ sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'investasi'`
        );
        const perluRebuildInvestasi = !!investasiDdl?.sql && !investasiDdl.sql.includes('USAHA_LAIN');
        if (perluRebuildInvestasi) {
          await db.execAsync(`
            CREATE TABLE investasi_v31new (
              id TEXT PRIMARY KEY,
              nomor_investasi TEXT NOT NULL UNIQUE,
              jenis_investasi TEXT NOT NULL CHECK (jenis_investasi IN (
                'UNIT_USAHA','KOPERASI_LAIN','USAHA_LAIN',
                'TABUNGAN_BANK_UMUM','GIRO_BANK_UMUM','DEPOSITO_BANK_UMUM','PROPERTI_INVESTASI'
              )),
              nama_tujuan TEXT NOT NULL,
              jumlah INTEGER NOT NULL,
              tanggal TEXT NOT NULL,
              sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
              bank_account_id TEXT REFERENCES bank_account(id),
              keterangan TEXT,
              nomor_rekening_investasi TEXT,
              lokasi_properti TEXT,
              journal_id TEXT REFERENCES journal(id),
              created_by TEXT NOT NULL,
              created_at TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'AKTIF',
              reversal_of_id TEXT REFERENCES investasi(id),
              updated_at TEXT
            );
            INSERT INTO investasi_v31new
              (id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal, sumber_dana,
               bank_account_id, keterangan, nomor_rekening_investasi, lokasi_properti, journal_id,
               created_by, created_at, status, reversal_of_id, updated_at)
              SELECT id, nomor_investasi, jenis_investasi, nama_tujuan, jumlah, tanggal, sumber_dana,
                     bank_account_id, keterangan, nomor_rekening_investasi, lokasi_properti, journal_id,
                     created_by, created_at, status, reversal_of_id, updated_at
              FROM investasi;
            DROP TABLE investasi;
            ALTER TABLE investasi_v31new RENAME TO investasi;
            CREATE INDEX IF NOT EXISTS idx_investasi_tanggal ON investasi(tanggal);
          `);
        }

        // Akun 5 jenis investasi baru (1-1620..1-1660) & mapping
        // INVESTASI_USAHA_LAIN/INVESTASI_TABUNGAN_BANK_UMUM/dst otomatis
        // tersedia lewat self-heal COA generik di bawah — TIDAK perlu
        // blok migrasi khusus di sini, pola yang sama dengan v27/v28/v29/v30.
    });
    }

    if (currentVersion < 32) {
      // ============================================================
      // RC-S51 §2A — REBUILD DIBUNGKUS SATU TRANSAKSI
      // ============================================================
      // TEMUAN AUDIT P1. Prosedur rebuild tabel resmi SQLite terdiri
      // dari empat langkah yang HARUS berhasil bersama:
      //
      //     CREATE TABLE ..._new -> INSERT SELECT -> DROP TABLE lama
      //     -> ALTER TABLE ..._new RENAME TO lama
      //
      // Sebelum RC ini blok ini dijalankan TANPA transaksi, sehingga
      // setiap langkah auto-commit sendiri. Exception (atau proses yang
      // mati) di antara langkah 3 dan 4 meninggalkan database dalam
      // keadaan tabel lama SUDAH HILANG sementara penggantinya masih
      // bernama `..._new` — skema separuh jadi yang tidak bisa dipakai
      // dan tidak bisa diulang dengan aman.
      //
      // `withTransactionAsync` membuat keempatnya atomik: kalau salah
      // satu gagal, SQLite me-rollback seluruhnya dan database kembali
      // ke keadaan sebelum blok ini berjalan. `schema_meta.version`
      // baru dinaikkan setelah SELURUH blok migrasi selesai (lihat
      // akhir fungsi), jadi percobaan berikutnya mengulang dari versi
      // yang sama — bukan melanjutkan dari tengah.
      //
      // Isi blok TIDAK diubah sama sekali: hanya dipindahkan ke dalam
      // callback transaksi. Tidak ada satu pun kolom, DDL, atau baris
      // data yang berbeda dari sebelumnya.
      await db.withTransactionAsync(async () => {
        // Audit ulang (permintaan pengguna, request baru — pemisahan SHU
        // akrual/RAT/dibagikan §1/§4/§7/§12): 5 kolom baru pada
        // shu_konfigurasi (semua NULLABLE, aman untuk baris lama) + CHECK
        // constraint status diperluas dengan 2 nilai baru
        // (DIAJUKAN_RAT/DISAHKAN_RAT).
        //
        // 1) Kolom baru — ALTER TABLE ADD COLUMN biasa cukup (nullable).
        await tambahKolomJikaBelumAda('shu_konfigurasi', 'shu_informasi_rat', 'INTEGER');
        await tambahKolomJikaBelumAda('shu_konfigurasi', 'shu_diajukan_rat', 'INTEGER');
        await tambahKolomJikaBelumAda('shu_konfigurasi', 'shu_disahkan_rat', 'INTEGER');
        await tambahKolomJikaBelumAda('shu_konfigurasi', 'rat_id', 'TEXT REFERENCES rat(id)');
        await tambahKolomJikaBelumAda('shu_konfigurasi', 'catatan_keputusan_rat', 'TEXT');

        // 2) CHECK constraint pada `status` SEBELUMNYA hanya mengizinkan
        //    ('DRAFT','DIHITUNG','DIBAGIKAN') — SQLite tidak mendukung
        //    ALTER TABLE untuk mengubah CHECK constraint secara langsung,
        //    jadi tabel di-rebuild (pola SAMA PERSIS dengan migration v29
        //    aset_klasifikasi / v31 investasi): buat tabel baru dengan
        //    CHECK yang sudah diperluas, salin SELURUH data & kolom apa
        //    adanya (termasuk 5 kolom baru di atas), hapus tabel lama,
        //    ganti nama. Dicek dulu lewat sqlite_master supaya idempotent.
        //    Data existing (termasuk baris SHU yang sudah DIBAGIKAN
        //    sebelum fitur ini ada) TIDAK berubah nilainya sama sekali —
        //    status 'DRAFT'/'DIHITUNG'/'DIBAGIKAN' lama tetap valid persis
        //    seperti sebelumnya karena SEMUA nilai lama tetap ada di
        //    dalam CHECK yang baru (superset, bukan pengganti).
        const shuDdl = await db.getFirstAsync<{ sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'shu_konfigurasi'`
        );
        const perluRebuildShu = !!shuDdl?.sql && !shuDdl.sql.includes('DIAJUKAN_RAT');
        if (perluRebuildShu) {
          // Bug fix (ditemukan lewat pengujian): rebuild di bawah SEBELUMNYA
          // tidak menyertakan kolom `persen_lainnya` sama sekali di tabel
          // baru maupun di SELECT/INSERT penyalinan data — padahal komentar
          // di schema.ts (bagian shu_konfigurasi) secara eksplisit
          // menjanjikan kolom itu "TETAP menyimpannya secara fisik untuk
          // kompatibilitas skema (tidak di-DROP oleh migration)" untuk
          // instalasi LAMA yang masih punya kolom ini. Rebuild tabel (CREATE
          // baru + INSERT SELECT + DROP + RENAME) yang tidak menyertakan
          // kolom itu di kedua sisi akan MENGHAPUS datanya secara diam-diam
          // begitu instalasi lama itu melewati migrasi v32 — bertentangan
          // dengan janji tersebut. Instalasi BARU (dibuat setelah kolom ini
          // dihapus dari CREATE_TABLES_SQL) TIDAK PERNAH punya kolom ini
          // sama sekali, jadi menyertakannya secara tanpa syarat akan
          // menggagalkan migrasi mereka dengan "no such column" — makanya
          // dicek dulu lewat PRAGMA table_info (pola sama seperti rebuild
          // aset_klasifikasi di migrasi v29 di atas) sebelum menyertakannya.
          const kolomShuLama = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(shu_konfigurasi)`);
          const punyaPersenLainnya = kolomShuLama.some((c) => c.name === 'persen_lainnya');
          const kolomLainnyaDdl = punyaPersenLainnya ? ', persen_lainnya REAL' : '';
          const kolomLainnyaNama = punyaPersenLainnya ? ', persen_lainnya' : '';
          await db.execAsync(`
            CREATE TABLE shu_konfigurasi_v32new (
              id TEXT PRIMARY KEY,
              tahun_buku INTEGER NOT NULL UNIQUE,
              persen_cadangan REAL NOT NULL DEFAULT 0,
              persen_jasa_modal REAL NOT NULL DEFAULT 0,
              persen_jasa_usaha REAL NOT NULL DEFAULT 0,
              persen_pendidikan REAL NOT NULL DEFAULT 0,
              persen_sosial REAL NOT NULL DEFAULT 0,
              persen_pengurus REAL NOT NULL DEFAULT 0,
              persen_pengawas REAL NOT NULL DEFAULT 0,
              persen_karyawan REAL NOT NULL DEFAULT 0,
              persen_pembangunan_daerah_kerja REAL NOT NULL DEFAULT 0,
              persen_cadangan_risiko REAL NOT NULL DEFAULT 0,
              total_shu INTEGER,
              shu_informasi_rat INTEGER,
              shu_diajukan_rat INTEGER,
              shu_disahkan_rat INTEGER,
              rat_id TEXT REFERENCES rat(id),
              catatan_keputusan_rat TEXT,
              status TEXT NOT NULL CHECK (status IN ('DRAFT','DIHITUNG','DIAJUKAN_RAT','DISAHKAN_RAT','DIBAGIKAN')) DEFAULT 'DRAFT',
              journal_id TEXT REFERENCES journal(id),
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL${kolomLainnyaDdl}
            );
            INSERT INTO shu_konfigurasi_v32new
              (id, tahun_buku, persen_cadangan, persen_jasa_modal, persen_jasa_usaha, persen_pendidikan,
               persen_sosial, persen_pengurus, persen_pengawas, persen_karyawan, persen_pembangunan_daerah_kerja,
               persen_cadangan_risiko, total_shu, shu_informasi_rat, shu_diajukan_rat, shu_disahkan_rat,
               rat_id, catatan_keputusan_rat, status, journal_id, created_at, updated_at${kolomLainnyaNama})
              SELECT id, tahun_buku, persen_cadangan, persen_jasa_modal, persen_jasa_usaha, persen_pendidikan,
                     persen_sosial, persen_pengurus, persen_pengawas, persen_karyawan, persen_pembangunan_daerah_kerja,
                     persen_cadangan_risiko, total_shu, shu_informasi_rat, shu_diajukan_rat, shu_disahkan_rat,
                     rat_id, catatan_keputusan_rat, status, journal_id, created_at, updated_at${kolomLainnyaNama}
              FROM shu_konfigurasi;
            DROP TABLE shu_konfigurasi;
            ALTER TABLE shu_konfigurasi_v32new RENAME TO shu_konfigurasi;
          `);
        }
    });
    }

    if (currentVersion < 33) {
      // Revisi LHU KOPKU (permintaan pengguna): kolom baru
      // `lhu_klasifikasi` di `account` (nullable) — menentukan posisi
      // OTOMATIS akun Pendapatan/Beban di LHU (Laporan Hasil Usaha).
      // Instalasi BARU sudah mendapat nilai ini langsung dari
      // DEFAULT_ACCOUNTS/SetupService (lihat defaultCOA.ts) — blok di
      // bawah HANYA untuk instalasi LAMA yang akunnya sudah ada tanpa
      // kolom ini terisi. Idempoten (`WHERE lhu_klasifikasi IS NULL`),
      // TIDAK PERNAH menimpa klasifikasi yang admin sudah atur sendiri
      // lewat Input Akun (Bagian H — "jangan meminta user memilih ulang").
      await tambahKolomJikaBelumAda('account', 'lhu_klasifikasi', 'TEXT');

      const now33 = new Date().toISOString();
      // Bagian I: Pendapatan Administrasi & Denda berasal dari aktivitas
      // pinjaman -> Pendapatan Usaha Lain (akun COA tetap terpisah).
      // "Pendapatan Usaha Lain" (4-2000) diklasifikasikan sesuai namanya.
      await db.runAsync(
        `UPDATE account SET lhu_klasifikasi = 'PENDAPATAN_USAHA_LAIN', updated_at = ?
         WHERE kode IN ('4-1100','4-1200','4-2000') AND lhu_klasifikasi IS NULL`,
        now33
      );
      // "Pendapatan Lainnya" (4-3000, akun umum yang sudah dipakai jalur
      // Penerimaan > Penghasilan Lain sejak sebelumnya) -> Pendapatan Lain.
      await db.runAsync(
        `UPDATE account SET lhu_klasifikasi = 'PENDAPATAN_LAIN', updated_at = ?
         WHERE kode = '4-3000' AND lhu_klasifikasi IS NULL`,
        now33
      );
      // Bagian R: kerugian terkait investasi -> Beban Lain (BUKAN Beban
      // Usaha) — dikecualikan dari default BEBAN_USAHA di bawah.
      await db.runAsync(
        `UPDATE account SET lhu_klasifikasi = 'BEBAN_LAIN', updated_at = ?
         WHERE kode = '5-2150' AND lhu_klasifikasi IS NULL`,
        now33
      );
      // Bagian O: seluruh akun Beban lain (kecuali 5-2150 Beban Lain di
      // atas & 5-2200 Beban Pajak Penghasilan — baris tersendiri di LHU,
      // Bagian T, SENGAJA dibiarkan NULL) -> Beban Usaha.
      await db.runAsync(
        `UPDATE account SET lhu_klasifikasi = 'BEBAN_USAHA', updated_at = ?
         WHERE kategori = 'BEBAN' AND kode NOT IN ('5-2150','5-2200') AND lhu_klasifikasi IS NULL`,
        now33
      );
      // 4-1000 (Pendapatan Jasa Pinjaman) & 5-2200 (Beban Pajak
      // Penghasilan) SENGAJA TIDAK disentuh — baris tersendiri di LHU,
      // dibaca langsung by kode (lihat FinancialReports.getLHU).
    }

    if (currentVersion < 34) {
      // Revisi KOPKU (Bagian 3A/3B, integrasi Data Bank/Utang
      // Koperasi/COA Pendapatan-Pajak-Beban): SENGAJA tidak ada blok
      // migrasi skema di sini — akun baru "Pendapatan Hasil Investasi"
      // (4-1300, lhuKlasifikasi HASIL_INVESTASI) dan "Utang Pajak"
      // (2-1900, LIABILITAS) sudah didaftarkan di DEFAULT_ACCOUNTS
      // (defaultCOA.ts), otomatis tersedia untuk instalasi lama lewat
      // blok self-heal COA generik di bawah — pola sama persis dengan
      // v27/v28/v29/v30/v31. "Beban Usaha Lainnya" SENGAJA TIDAK
      // ditambahkan sebagai akun baru — lihat komentar di defaultCOA.ts
      // (5-2000 "Beban Lainnya" sudah punya fungsi identik).
    }

    if (currentVersion < 35) {
      // Revisi KOPKU (Bagian 1): kolom baru `bank_tujuan_id` di
      // `investasi` — nama bank TUJUAN investasi Bank Umum HARUS
      // dipilih dari Data Bank (bank_account), bukan teks bebas lagi.
      // Nullable & tanpa default — ALTER TABLE ADD COLUMN biasa cukup
      // (tidak perlu rebuild tabel, tidak ada CHECK constraint yang
      // berubah). Investasi Bank Umum LAMA yang sudah tercatat sebelum
      // kolom ini ada TETAP terbaca apa adanya (nama_tujuan lama tetap
      // tampil persis seperti sebelumnya — lihat komentar
      // InvestasiFormScreen/InvestasiService: histori lama TIDAK
      // dipaksa migrasi ke bank_tujuan_id, hanya transaksi BARU yang
      // wajib memilih dari Data Bank).
      await tambahKolomJikaBelumAda('investasi', 'bank_tujuan_id', 'TEXT REFERENCES bank_account(id)');
    }

    if (currentVersion < 36) {
      // Revisi "Daftar Pendapatan" (audit menu Daftar Pendapatan):
      // SENGAJA tidak ada blok migrasi skema di sini — akun nominal
      // pendapatan ("Pendapatan Unit Usaha" 4-1400, "Pendapatan Bunga"
      // 4-1500, "Pendapatan Sewa" 4-1600, "Pendapatan Bagi Hasil"
      // 4-1700, "Pendapatan Penjualan Aset" 4-1800) terdaftar di
      // DEFAULT_ACCOUNTS (defaultCOA.ts) dan tersedia untuk instalasi
      // lama lewat blok self-heal COA generik di bawah —
      // pola sama persis dengan v27/v28/v30/v31/v34. Akun2 lama
      // (4-1000/4-1100/4-1200/4-1300/4-2000/4-3000) TIDAK diubah kode
      // maupun namanya sama sekali.
    }

    if (currentVersion < 37) {
      // Audit ulang (permintaan pengguna, request PERBAIKAN §8/§9/§10):
      // (1) COA baru "Modal Tetap" (3-1200) & "Modal Tambahan" (3-1300)
      //     sudah didaftarkan di DEFAULT_ACCOUNTS (defaultCOA.ts) — SENGAJA
      //     tidak ada blok INSERT manual di sini, otomatis tersedia untuk
      //     instalasi lama lewat blok self-heal COA generik di bawah,
      //     pola sama persis dengan v27/v28/v30/v31/v34/v36.
      // (2) §10: kolom `jenis_simpanan` (Tabungan/Giro/Deposito) di
      //     `bank_account` — nullable, TANPA CHECK constraint (SQLite
      //     tidak bisa ADD COLUMN dengan CHECK, dan tabel tidak perlu
      //     di-rebuild untuk field opsional ini) supaya rekening lama
      //     tetap terbaca apa adanya (fallback null = "belum diisi",
      //     ditangani di layer aplikasi, BUKAN nilai default yang
      //     dipaksakan). Tabel referensi `bank_jenis_simpanan` dibuat
      //     terpisah supaya admin bisa ON/OFF-kan tiap jenis (§10:
      //     "field ini harus dapat di-ON/OFF-kan") tanpa menghapus data
      //     rekening yang sudah memakainya — OFF hanya menyembunyikan
      //     dari picker, TIDAK mengubah data rekening existing.
      // (3) §9: tabel riwayat `pinjaman_akad_ulang` — mencatat setiap
      //     akad ulang (restrukturisasi tenor/metode/persentase jasa)
      //     supaya bisa ditelusuri terpisah dari `audit_log` generik
      //     (detail sebelum/sesudah spesifik pinjaman, dipakai UI
      //     riwayat akad di PinjamanDetailScreen). TIDAK mengubah
      //     tabel `pinjaman`/`angsuran_jadwal` yang sudah ada.
      await tambahKolomJikaBelumAda('bank_account', 'jenis_simpanan', 'TEXT');

      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS bank_jenis_simpanan (
          id TEXT PRIMARY KEY,
          kode TEXT NOT NULL UNIQUE,
          nama TEXT NOT NULL,
          aktif INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const existingJenis = await db.getAllAsync<{ kode: string }>(`SELECT kode FROM bank_jenis_simpanan`);
      const existingJenisSet = new Set(existingJenis.map((r) => r.kode));
      const nowJenis = new Date().toISOString();
      for (const j of [
        { kode: 'TABUNGAN', nama: 'Tabungan' },
        { kode: 'GIRO', nama: 'Giro' },
        { kode: 'DEPOSITO', nama: 'Deposito' },
      ]) {
        if (existingJenisSet.has(j.kode)) continue;
        await db.runAsync(
          `INSERT INTO bank_jenis_simpanan (id, kode, nama, aktif, created_at, updated_at) VALUES (?,?,?,1,?,?)`,
          newId(),
          j.kode,
          j.nama,
          nowJenis,
          nowJenis
        );
      }

      await db.execAsync(`
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
          created_at TEXT NOT NULL
        );
      `);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_akad_ulang_pinjaman ON pinjaman_akad_ulang(pinjaman_id);`);
    }

    if (currentVersion < 38) {
      // Permintaan pengguna §8: Jenis Kelamin pada data anggota — kolom
      // nullable TANPA CHECK constraint di sini (SQLite tidak bisa ADD
      // COLUMN dengan CHECK; instalasi lama akan punya kolom ini tanpa
      // CHECK, instalasi BARU dari schema.ts di atas punya CHECK sejak
      // awal — beda ini tidak masalah karena validasi nilai yang benar
      // (LAKI_LAKI/PEREMPUAN) tetap dilakukan di AnggotaRepository.ts,
      // bukan hanya mengandalkan DB). Anggota lama otomatis NULL
      // ("belum diisi") — TIDAK ada data anggota yang hilang/berubah.
      await tambahKolomJikaBelumAda('anggota', 'jenis_kelamin', 'TEXT');
    }

    if (currentVersion < 39) {
      // Tabel `pinjaman_koperasi` — milik fitur LEGACY "Pemberian
      // Pinjaman untuk Koperasi" yang DIHAPUS dari runtime di RC-S70.2
      // (tidak ada menu, rute, layar, atau service aktif lagi). Migrasi
      // ini DIPERTAHANKAN apa adanya supaya instalasi lama yang sudah
      // punya data historis tetap dapat dibuka dan jurnalnya tetap
      // terbaca — JANGAN dibuat destruktif. Mapping akun
      // (PEMBERIAN_PINJAMAN_KOPERASI -> 1-1200, reuse akun existing,
      // lihat komentar defaultCOA.ts) otomatis tersedia untuk instalasi
      // lama lewat blok self-heal COA generik di bawah — tidak perlu
      // INSERT manual di sini.
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS pinjaman_koperasi (
          id TEXT PRIMARY KEY,
          nomor_pinjaman TEXT NOT NULL UNIQUE,
          nama_penerima TEXT NOT NULL,
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
      `);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_pinjaman_koperasi_status ON pinjaman_koperasi(status);`);
    }

    // v40/v41 (Laporan Pertanggungjawaban Pengurus & Pengawas + integrasi
    // RKA/RAPB) dihapus sepenuhnya atas permintaan pengguna — fitur ini
    // tidak pernah dirilis ke instalasi produksi, jadi blok migrasinya
    // dibuang langsung (bukan no-op) alih-alih dibiarkan sebagai dead
    // code. SCHEMA_VERSION tetap berjalan lurus ke versi berikutnya;
    // instalasi lama yang currentVersion-nya < versi berikutnya cukup
    // lewat sini tanpa membuat tabel lpj_*/rka_*/rapb_* apa pun.

    if (currentVersion < 42) {
      // PHASE 1 (fondasi model akuntansi akrual jasa/bunga pinjaman,
      // permintaan pengguna bagian B/C/G/X): buat tabel
      // pinjaman_akuntansi_jasa untuk instalasi LAMA — definisi PERSIS
      // sama dengan yang ada di CREATE_TABLES_SQL (schema.ts) untuk
      // instalasi baru. CREATE TABLE/INDEX IF NOT EXISTS -> aman
      // dijalankan ulang (idempotent), tidak menyentuh tabel lain,
      // tidak menghapus/mengubah data existing mana pun. Tabel ini
      // BELUM diisi oleh service mana pun pada Phase 1 (murni
      // fondasi skema untuk PHASE 2).
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS pinjaman_akuntansi_jasa (
          id TEXT PRIMARY KEY,
          pinjaman_id TEXT NOT NULL REFERENCES pinjaman(id),
          jadwal_id TEXT REFERENCES angsuran_jadwal(id),
          periode_akuntansi TEXT NOT NULL,
          tipe_pengakuan TEXT NOT NULL CHECK (tipe_pengakuan IN (
            'JASA_AKRUAL','FEE_INTEGRAL_AMORTISASI','FEE_SEPARATE_SERVICE'
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
          UNIQUE(pinjaman_id, periode_akuntansi, tipe_pengakuan)
        );
        CREATE INDEX IF NOT EXISTS idx_pinjaman_akuntansi_jasa_pinjaman ON pinjaman_akuntansi_jasa(pinjaman_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pinjaman_akuntansi_jasa_idempotency ON pinjaman_akuntansi_jasa(idempotency_key);
      `);
    }

    if (currentVersion < 43) {
      // PHASE 2 (§12/§13, permintaan pengguna) — kolom klasifikasi fee
      // admin pencairan untuk instalasi LAMA. Tidak ada CHECK di ALTER
      // (SQLite ADD COLUMN tidak mendukungnya dengan aman di sini) —
      // pola SAMA dengan bank_account.jenis_simpanan (v37): divalidasi
      // di application layer, bukan di level kolom, untuk instalasi
      // lama. DEFAULT 'SEPARATE_SERVICE' -> seluruh pinjaman existing
      // otomatis berperilaku SAMA seperti sebelum Phase 2 (lihat
      // komentar di schema.ts).
      await tambahKolomJikaBelumAda('pinjaman', 'biaya_admin_klasifikasi', "TEXT NOT NULL DEFAULT 'SEPARATE_SERVICE'");
    }

    if (currentVersion < 44) {
      // PHASE 2 KOREKSI (permintaan pengguna §2) — kolom lifecycle fee
      // integral untuk instalasi LAMA. Tidak ada CHECK di ALTER (pola
      // sama dengan biaya_admin_klasifikasi/jenis_simpanan), nullable,
      // divalidasi di application layer (AkrualJasaPinjamanService).
      await tambahKolomJikaBelumAda('pinjaman_akuntansi_jasa', 'fee_lifecycle_status', 'TEXT');
    }

    if (currentVersion < 45) {
      // PHASE 3 (permintaan pengguna §A/§I/§K/§L/§M) — tiga perubahan:
      //
      // 1. angsuran_jadwal.status: SQLite tidak bisa ALTER CHECK
      //    constraint langsung — tabel dibangun ulang (pola SAMA
      //    PERSIS dengan app_user di migration v3 di atas), CHECK baru
      //    menambahkan 'DIHAPUSBUKU' (write-off) & 'DIRESTRUKTURISASI'
      //    (akad ulang), data lama disalin apa adanya. DUA kolom FK
      //    baru (nullable) untuk traceability bidirectional
      //    old-schedule -> restructuring -> new-schedule. DROP TABLE
      //    aman meski ada FK dari angsuran_pembayaran.jadwal_id &
      //    pinjaman_akuntansi_jasa.jadwal_id — foreign_keys
      //    enforcement OFF secara default untuk instalasi lama (tidak
      //    pernah di-`PRAGMA foreign_keys = ON` eksplisit di luar
      //    CREATE_TABLES_SQL fresh-install), pola yang sama terbukti
      //    aman di migration v3 (app_user, direferensikan created_by
      //    di banyak tabel).
      await db.withTransactionAsync(async () => {
        const tableInfo = await db.getFirstAsync<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='angsuran_jadwal'`
        );
        if (tableInfo) {
          await db.execAsync(`
            CREATE TABLE IF NOT EXISTS angsuran_jadwal_new (
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
              status TEXT NOT NULL CHECK (status IN ('BELUM_BAYAR','SEBAGIAN','LUNAS','TERLAMBAT','DIHAPUSBUKU','DIRESTRUKTURISASI')) DEFAULT 'BELUM_BAYAR',
              digantikan_oleh_akad_ulang_id TEXT REFERENCES pinjaman_akad_ulang(id),
              dibuat_dari_akad_ulang_id TEXT REFERENCES pinjaman_akad_ulang(id),
              UNIQUE(pinjaman_id, nomor_angsuran)
            );
          `);
          await db.execAsync(`
            INSERT INTO angsuran_jadwal_new
              (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total,
               pokok_terbayar, jasa_terbayar, denda_terbayar, status)
            SELECT id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total,
                   pokok_terbayar, jasa_terbayar, denda_terbayar, status
            FROM angsuran_jadwal;
          `);
          await db.execAsync(`DROP TABLE angsuran_jadwal;`);
          await db.execAsync(`ALTER TABLE angsuran_jadwal_new RENAME TO angsuran_jadwal;`);
          await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_angsuran_pinjaman ON angsuran_jadwal(pinjaman_id);`);
          await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_angsuran_jatuh_tempo ON angsuran_jadwal(tanggal_jatuh_tempo);`);
        }
      });

      // 2. pinjaman_akuntansi_jasa.writeoff_amount (§D) — kolom baru,
      //    ADD COLUMN biasa cukup (tidak perlu rebuild).
      await tambahKolomJikaBelumAda('pinjaman_akuntansi_jasa', 'writeoff_amount', 'INTEGER NOT NULL DEFAULT 0');

      // 3. pinjaman_akad_ulang: dua kolom baru untuk audit trail
      //    restrukturisasi (§L/§N) — sama, ADD COLUMN biasa.
      await tambahKolomJikaBelumAda('pinjaman_akad_ulang', 'outstanding_piutang_jasa', 'INTEGER NOT NULL DEFAULT 0');
      await tambahKolomJikaBelumAda('pinjaman_akad_ulang', 'status', "TEXT NOT NULL DEFAULT 'SELESAI'");
    }

    if (currentVersion < 46) {
      // PHASE 5 (permintaan pengguna §G) — FK nullable dari aset_tetap
      // ke aset_klasifikasi, ADD COLUMN biasa (tidak ada CHECK, tidak
      // perlu rebuild tabel). TIDAK ada backfill massal untuk baris
      // lama (§R: "jangan melakukan mass backfill classification
      // tanpa alasan") — baris existing tetap NULL di kolom ini,
      // kelompok_aset/sub_kelompok_aset (teks) tetap seperti semula.
      await tambahKolomJikaBelumAda('aset_tetap', 'aset_klasifikasi_id', 'TEXT REFERENCES aset_klasifikasi(id)');
    }

    if (currentVersion < 47) {
      // PHASE 7 (permintaan pengguna §F/§Z) — rebuild pinjaman_akuntansi_jasa
      // untuk instalasi LAMA: CHECK tipe_pengakuan +'EIR_MONTHLY',
      // CHECK fee_lifecycle_status +'PENDING_RESTRUCTURING_EIR_REVIEW'/
      // 'DERECOGNIZED', + 2 kolom baru (effective_interest_rate,
      // remaining_term_bulan) — pola SAMA PERSIS dengan rebuild
      // angsuran_jadwal di migration v45 (SQLite tidak bisa ALTER
      // CHECK langsung). Data lama disalin APA ADANYA, TIDAK ADA
      // backfill nilai EIR untuk baris lama (§AE/§Z: additive,
      // backward compatible, tidak mengubah historical data).
      await db.withTransactionAsync(async () => {
        const tableInfo = await db.getFirstAsync<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='pinjaman_akuntansi_jasa'`
        );
        if (tableInfo) {
          await db.execAsync(`
            CREATE TABLE IF NOT EXISTS pinjaman_akuntansi_jasa_new (
              id TEXT PRIMARY KEY,
              pinjaman_id TEXT NOT NULL REFERENCES pinjaman(id),
              jadwal_id TEXT REFERENCES angsuran_jadwal(id),
              periode_akuntansi TEXT NOT NULL,
              tipe_pengakuan TEXT NOT NULL CHECK (tipe_pengakuan IN (
                'JASA_AKRUAL','FEE_INTEGRAL_AMORTISASI','FEE_SEPARATE_SERVICE','EIR_MONTHLY'
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
              fee_lifecycle_status TEXT CHECK (fee_lifecycle_status IN (
                'DEFERRED_PENDING_EIR','AMORTIZED','RECOGNIZED','PENDING_RESTRUCTURING_EIR_REVIEW','DERECOGNIZED'
              )),
              writeoff_amount INTEGER NOT NULL DEFAULT 0,
              effective_interest_rate REAL,
              remaining_term_bulan INTEGER,
              principal_component INTEGER,
              UNIQUE(pinjaman_id, periode_akuntansi, tipe_pengakuan)
            );
          `);
          await db.execAsync(`
            INSERT INTO pinjaman_akuntansi_jasa_new
              (id, pinjaman_id, jadwal_id, periode_akuntansi, tipe_pengakuan, saldo_awal_carrying,
               pendapatan_akuntansi, kas_diterima, amortisasi_fee, saldo_akhir_carrying, status,
               journal_id, idempotency_key, created_by, created_at, updated_at, fee_lifecycle_status,
               writeoff_amount)
            SELECT id, pinjaman_id, jadwal_id, periode_akuntansi, tipe_pengakuan, saldo_awal_carrying,
                   pendapatan_akuntansi, kas_diterima, amortisasi_fee, saldo_akhir_carrying, status,
                   journal_id, idempotency_key, created_by, created_at, updated_at, fee_lifecycle_status,
                   writeoff_amount
            FROM pinjaman_akuntansi_jasa;
          `);
          await db.execAsync(`DROP TABLE pinjaman_akuntansi_jasa;`);
          await db.execAsync(`ALTER TABLE pinjaman_akuntansi_jasa_new RENAME TO pinjaman_akuntansi_jasa;`);
          await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_pinjaman_akuntansi_jasa_pinjaman ON pinjaman_akuntansi_jasa(pinjaman_id);`);
          await db.execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pinjaman_akuntansi_jasa_idempotency ON pinjaman_akuntansi_jasa(idempotency_key);`);
        }
      });

      // PHASE 7 (permintaan pengguna §AE) — status pengukuran EIR per
      // pinjaman, ADD COLUMN biasa (tidak ada CHECK di ALTER untuk
      // instalasi lama, pola sama dengan biaya_admin_klasifikasi/
      // jenis_simpanan, divalidasi di application layer). DEFAULT
      // 'EIR_NOT_MIGRATED' -> seluruh pinjaman existing otomatis
      // ditandai belum bermigrasi, TIDAK ADA backfill nilai EIR.
      await tambahKolomJikaBelumAda('pinjaman', 'eir_measurement_status', "TEXT NOT NULL DEFAULT 'EIR_NOT_MIGRATED'");
    }

    if (currentVersion < 48) {
      // FINAL FIX AKRUAL JASA (permintaan pengguna BUG 4/5/7) —
      // subledger "kas jasa diterima tapi periodenya BELUM jatuh tempo"
      // per baris jadwal. ADD COLUMN biasa (additive, nullable-safe
      // lewat DEFAULT 0), idempoten via tambahKolomJikaBelumAda —
      // instalasi lama otomatis dapat kolom ini dengan nilai 0 untuk
      // SELURUH baris historis, jadi perilaku data lama TIDAK berubah
      // sama sekali (0 = tidak ada porsi diterima dimuka, persis
      // asumsi implisit sebelum perbaikan ini). TIDAK ADA backfill/
      // reklasifikasi jurnal historis: pembayaran lama yang terlanjur
      // diakui sebagai pendapatan tetap apa adanya (histori akuntansi
      // tidak boleh ditulis ulang), perlakuan baru hanya berlaku untuk
      // pembayaran SETELAH upgrade ini.
      await tambahKolomJikaBelumAda('angsuran_jadwal', 'jasa_dimuka', 'INTEGER NOT NULL DEFAULT 0');
    }

    if (currentVersion < 49) {
      // §AB FIX (permintaan pengguna) — derecognition sisa fee integral
      // (pelunasan dipercepat/write-off) SEBELUMNYA ditulis memakai
      // tipe_pengakuan='EIR_MONTHLY', sehingga menabrak
      // UNIQUE(pinjaman_id, periode_akuntansi, tipe_pengakuan) kalau
      // amortisasi bulanan periode yang SAMA sudah pernah diakui
      // (contoh nyata: prosesEirBulanan periode 2026-04, lalu settlement
      // 2026-04-20). Derecognition memang PERISTIWA AKUNTANSI YANG
      // BERBEDA dari amortisasi bulanan, jadi diberi tipe sendiri:
      // 'EIR_DERECOGNITION'. UNIQUE constraint TIDAK dihapus (justru
      // tetap melindungi kedua tipe secara terpisah), histori
      // EIR_MONTHLY TIDAK disentuh, dan TIDAK ADA data lama yang
      // diubah/dihapus.
      //
      // Rebuild tabel memakai pola yang SAMA PERSIS dengan v47 di atas
      // (SQLite tidak bisa ALTER CHECK). Baris lama disalin APA ADANYA —
      // termasuk baris derecognition lama yang terlanjur bertipe
      // 'EIR_MONTHLY': SENGAJA TIDAK direklasifikasi, karena histori
      // akuntansi tidak boleh ditulis ulang dan nilainya tetap benar
      // (jumlah pendapatan fee yang diakui tidak berubah sama sekali).
      await db.withTransactionAsync(async () => {
        const tableInfo = await db.getFirstAsync<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='pinjaman_akuntansi_jasa'`
        );
        if (tableInfo) {
          await db.execAsync(`DROP TABLE IF EXISTS pinjaman_akuntansi_jasa_v49;`);
          await db.execAsync(`
            CREATE TABLE pinjaman_akuntansi_jasa_v49 (
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
              fee_lifecycle_status TEXT CHECK (fee_lifecycle_status IN (
                'DEFERRED_PENDING_EIR','AMORTIZED','RECOGNIZED','PENDING_RESTRUCTURING_EIR_REVIEW','DERECOGNIZED'
              )),
              writeoff_amount INTEGER NOT NULL DEFAULT 0,
              effective_interest_rate REAL,
              remaining_term_bulan INTEGER,
              principal_component INTEGER,
              UNIQUE(pinjaman_id, periode_akuntansi, tipe_pengakuan)
            );
          `);
          await db.execAsync(`
            INSERT INTO pinjaman_akuntansi_jasa_v49
              (id, pinjaman_id, jadwal_id, periode_akuntansi, tipe_pengakuan, saldo_awal_carrying,
               pendapatan_akuntansi, kas_diterima, amortisasi_fee, saldo_akhir_carrying, status,
               journal_id, idempotency_key, created_by, created_at, updated_at, fee_lifecycle_status,
               writeoff_amount, effective_interest_rate, remaining_term_bulan, principal_component)
            SELECT id, pinjaman_id, jadwal_id, periode_akuntansi, tipe_pengakuan, saldo_awal_carrying,
                   pendapatan_akuntansi, kas_diterima, amortisasi_fee, saldo_akhir_carrying, status,
                   journal_id, idempotency_key, created_by, created_at, updated_at, fee_lifecycle_status,
                   writeoff_amount, effective_interest_rate, remaining_term_bulan, principal_component
            FROM pinjaman_akuntansi_jasa;
          `);
          await db.execAsync(`DROP TABLE pinjaman_akuntansi_jasa;`);
          await db.execAsync(`ALTER TABLE pinjaman_akuntansi_jasa_v49 RENAME TO pinjaman_akuntansi_jasa;`);
          await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_pinjaman_akuntansi_jasa_pinjaman ON pinjaman_akuntansi_jasa(pinjaman_id);`);
          await db.execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pinjaman_akuntansi_jasa_idempotency ON pinjaman_akuntansi_jasa(idempotency_key);`);
        }
      });
    }

    if (currentVersion < 50) {
      // ============================================================
      // REQUIREMENT 3 — RENAME akun 5-2100 (KODE TIDAK BERUBAH)
      // ============================================================
      // Pola SAMA PERSIS dengan migration v30 (rename "Cadangan" ->
      // "Cadangan Umum") dan v14 (rename akun 1-1600): UPDATE `nama`
      // SAJA. `account.id`, `kode`, `kategori`, `normal_balance`,
      // `lhu_klasifikasi` TIDAK disentuh — seluruh `journal_entry`,
      // `account_mapping`, `saldo_awal_akun` historis tetap menunjuk
      // baris yang sama persis, jadi TIDAK ADA saldo/laporan lama yang
      // berubah nilainya (hanya labelnya).
      //
      // Filter `nama = 'Beban Penyisihan Piutang Tak Tertagih'` (bukan
      // hanya `kode = '5-2100'`) DISENGAJA: kalau admin sudah pernah
      // mengganti nama akun ini sendiri lewat Input Akun, migrasi ini
      // TIDAK menimpanya.
      await db.runAsync(
        `UPDATE account SET nama = 'Beban Penyisihan Pinjaman', updated_at = ?
         WHERE kode = '5-2100' AND nama = 'Beban Penyisihan Piutang Tak Tertagih'`,
        new Date().toISOString()
      );

      // ============================================================
      // REQUIREMENT 9 — jejak audit metode jasa pada pelunasan
      // ============================================================
      // ADD COLUMN additive & idempoten (tambahKolomJikaBelumAda).
      // Instalasi lama: seluruh baris `angsuran_pembayaran` historis
      // mendapat NULL / 0 — TIDAK ADA backfill, TIDAK ADA reklasifikasi
      // jurnal lama. Perilaku pembayaran lama tetap apa adanya; kolom
      // ini hanya diisi oleh transaksi pelunasan SETELAH upgrade ini.
      // CHECK constraint tidak ikut lewat ALTER (batasan SQLite, pola
      // sama dengan biaya_admin_klasifikasi/eir_measurement_status di
      // v43/v47) — divalidasi di application layer (PinjamanService).
      await tambahKolomJikaBelumAda('angsuran_pembayaran', 'metode_jasa_pelunasan', 'TEXT');
      await tambahKolomJikaBelumAda('angsuran_pembayaran', 'rabat_jasa_pelunasan', 'INTEGER NOT NULL DEFAULT 0');

      // ============================================================
      // REQUIREMENT 1 — akun 2-1210 "Simpanan Anggota (Berjangka)"
      // ============================================================
      // TIDAK perlu blok INSERT khusus di sini: akun sudah terdaftar di
      // DEFAULT_ACCOUNTS dan blok self-heal COA generik di bawah akan
      // membuatnya untuk instalasi lama (cek existence per kode, tidak
      // pernah duplikat) — pola SAMA dengan v27/v28/v30/v31/v34/v36/v37.
      // Kenaikan nomor versi inilah yang memastikan instalasi lama
      // melewati blok self-heal tersebut sekali lagi.
    }

    if (currentVersion < 51) {
      // ============================================================
      // SIMPANAN BERJANGKA — tabel subledger baru `simpanan_berjangka`
      // ============================================================
      // ADITIF MURNI. TIDAK ADA tabel existing yang di-rebuild,
      // di-ALTER, atau disentuh: `simpanan_transaksi` (POKOK/WAJIB/
      // SUKARELA) beserta CHECK `jenis`-nya tetap apa adanya, sehingga
      // seluruh saldo, histori, dan jurnal simpanan lama TIDAK mungkin
      // berubah oleh migrasi ini.
      //
      // Idempoten lewat `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF
      // NOT EXISTS` — aman dijalankan berulang, dan aman untuk
      // instalasi yang skemanya sudah lengkap.
      //
      // Rollback safety: seluruh blok migrasi berjalan di dalam
      // transaksi pemanggil; kegagalan di sini membatalkan pembuatan
      // tabel tanpa meninggalkan skema separuh jadi.
      //
      // Mapping COA `SIMPANAN_BERJANGKA -> KREDIT_DEFAULT -> 2-1210`
      // TIDAK perlu blok INSERT khusus: entri sudah terdaftar di
      // DEFAULT_ACCOUNT_MAPPING dan blok self-heal COA generik di bawah
      // yang membuatnya untuk instalasi lama (cek existence per
      // transaction_type+role, tidak pernah duplikat) — pola sama
      // dengan v27/v28/v30/v31/v34/v36/v37/v50. Akun 2-1210 sendiri
      // sudah dibuat sejak v50.
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS simpanan_berjangka (
          id TEXT PRIMARY KEY,
          anggota_id TEXT NOT NULL REFERENCES anggota(id),
          nomor_transaksi TEXT NOT NULL UNIQUE,
          tanggal_mulai TEXT NOT NULL,
          tanggal_jatuh_tempo TEXT NOT NULL,
          nominal INTEGER NOT NULL,
          tenor_bulan INTEGER NOT NULL CHECK (tenor_bulan IN (3, 6, 12)),
          suku_bunga REAL NOT NULL DEFAULT 0 CHECK (suku_bunga >= 0),
          status TEXT NOT NULL CHECK (status IN ('AKTIF','JATUH_TEMPO','DICAIRKAN','DIBATALKAN')),
          sumber_dana TEXT NOT NULL CHECK (sumber_dana IN ('KAS','BANK')),
          bank_account_id TEXT REFERENCES bank_account(id),
          keterangan TEXT,
          journal_id TEXT REFERENCES journal(id),
          idempotency_key TEXT,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_simpanan_berjangka_anggota ON simpanan_berjangka(anggota_id, status);
        CREATE INDEX IF NOT EXISTS idx_simpanan_berjangka_jatuh_tempo ON simpanan_berjangka(tanggal_jatuh_tempo);
        CREATE INDEX IF NOT EXISTS idx_simpanan_berjangka_tanggal ON simpanan_berjangka(tanggal_mulai);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_simpanan_berjangka_idempotency ON simpanan_berjangka(idempotency_key) WHERE idempotency_key IS NOT NULL;
      `);
    }

    if (currentVersion < 52) {
      // ============================================================
      // SIMPANAN BERJANGKA — LIFECYCLE BUNGA & PENCAIRAN
      // ============================================================
      // ADITIF MURNI. Tidak ada tabel yang di-rebuild atau di-DROP.
      //
      // 1) Kolom turunan & jejak pencairan pada `simpanan_berjangka`.
      //    Semua NULLABLE atau NOT NULL DEFAULT 0, jadi kontrak lama
      //    hasil v51 tetap valid apa adanya: bunga_terakru = 0,
      //    bunga_dibayar = 0, belum dicairkan.
      await tambahKolomJikaBelumAda('simpanan_berjangka', 'bunga_terakru', 'INTEGER NOT NULL DEFAULT 0');
      await tambahKolomJikaBelumAda('simpanan_berjangka', 'bunga_dibayar', 'INTEGER NOT NULL DEFAULT 0');
      await tambahKolomJikaBelumAda('simpanan_berjangka', 'tanggal_pencairan', 'TEXT');
      await tambahKolomJikaBelumAda('simpanan_berjangka', 'journal_pencairan_id', 'TEXT');
      await tambahKolomJikaBelumAda('simpanan_berjangka', 'idempotency_key_pencairan', 'TEXT');

      // 2) Tabel event akrual bunga per periode.
      await db.execAsync(`
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
        CREATE UNIQUE INDEX IF NOT EXISTS idx_simpanan_berjangka_idem_cair ON simpanan_berjangka(idempotency_key_pencairan) WHERE idempotency_key_pencairan IS NOT NULL;
      `);

      // 3) TIDAK ADA BUNGA RETROAKTIF yang dibuat di sini — DISENGAJA.
      //    Kontrak yang dibuat pada v51 memang belum pernah punya
      //    akrual. Menjurnal bunga historis untuk kontrak-kontrak itu
      //    berarti membuat beban & utang bunga pada periode yang
      //    barangkali SUDAH DITUTUP, tanpa satu pun kebijakan tertulis
      //    yang mendasarinya. Mesin akrual akan mengakui periode yang
      //    sudah earned saat dijalankan berikutnya, lewat jalur normal
      //    yang tunduk pada guard periode — bukan lewat migrasi.
      //
      //    Akun 2-1710/5-1955 & mapping SIMPANAN_BERJANGKA_BUNGA_AKRUAL
      //    / SIMPANAN_BERJANGKA_PENCAIRAN dibuat oleh blok self-heal COA
      //    generik di bawah (pola sama dengan v50/v51).
    }

    if (currentVersion < 53) {
      // ============================================================
      // S19/P2 — ARAH TRANSFER DI SUBLEDGER KAS & BANK
      // ============================================================
      // MASALAH YANG DIPERBAIKI (temuan P2 audit S18):
      // `transferAntarRekening()` menulis DUA baris subledger dengan
      // `tipe = 'TRANSFER'` dan `nominal` sama-sama POSITIF — arahnya
      // tidak tersimpan di mana pun pada baris itu. Rekonsiliasi Kas &
      // Bank karena itu menghitung baris transfer sebagai NOL di sisi
      // subledger (`CASE ... ELSE 0`), sementara sisi GL tetap
      // memasukkan jurnal transfernya. Hasilnya selisih PALSU sebesar
      // transfer neto, berlawanan tanda di Kas dan Bank.
      //
      // KENAPA KOLOM BARU, BUKAN MEMBACA JURNAL:
      // arah bisa saja disimpulkan dari jurnal (kaki debit/kredit),
      // tetapi sisi subledger pada rekonsiliasi TIDAK BOLEH dihitung
      // dari GL yang justru sedang diverifikasi — itu membuat cek
      // selalu seimbang karena membandingkan angka dengan dirinya
      // sendiri. Arah karena itu disimpan di subledger.
      //
      // ADITIF MURNI: dua ALTER TABLE ADD COLUMN, tidak ada tabel yang
      // di-rebuild/di-DROP, tidak ada baris jurnal yang disentuh.
      await tambahKolomJikaBelumAda(
        'kas_transaksi',
        'arah_transfer',
        "TEXT CHECK (arah_transfer IS NULL OR arah_transfer IN ('MASUK','KELUAR'))"
      );
      await tambahKolomJikaBelumAda(
        'bank_transaksi',
        'arah_transfer',
        "TEXT CHECK (arah_transfer IS NULL OR arah_transfer IN ('MASUK','KELUAR'))"
      );

      // BACKFILL DETERMINISTIK untuk data lama.
      // Sumbernya BUKAN tebakan: `transferAntarRekening()` sejak awal
      // mengambil nomor transaksi dari `nextSequence(db,
      // 'TRANSFER_KELUAR'|'TRANSFER_MASUK', tahun)`, sehingga
      // `nomor_transaksi` setiap baris transfer SUDAH memuat arahnya
      // secara harfiah ('TRANSFER_KELUAR-2026-000001'). Nilai itu
      // tersimpan DI SUBLEDGER, bukan di GL — jadi rekonstruksi ini
      // tetap non-sirkular.
      for (const tabel of ['kas_transaksi', 'bank_transaksi']) {
        // Instalasi yang sangat lama (dan fixture migrasi versi awal)
        // bisa belum punya tabel subledger ini sama sekali. Backfill
        // dilewati alih-alih menggagalkan seluruh rantai migrasi;
        // tabelnya nanti dibuat lengkap dengan kolom `arah_transfer`
        // oleh CREATE_TABLES_SQL.
        const ada = await db.getFirstAsync<{ n: number }>(
          `SELECT COUNT(*) as n FROM sqlite_master WHERE type = 'table' AND name = ?`,
          tabel
        );
        if (!ada?.n) continue;
        await db.runAsync(
          `UPDATE ${tabel}
              SET arah_transfer = CASE
                    WHEN nomor_transaksi LIKE 'TRANSFER_MASUK-%' THEN 'MASUK'
                    WHEN nomor_transaksi LIKE 'TRANSFER_KELUAR-%' THEN 'KELUAR'
                    ELSE NULL
                  END
            WHERE tipe = 'TRANSFER' AND arah_transfer IS NULL`
        );
      }

      // Baris transfer yang polanya TIDAK cocok (mis. ditulis versi
      // aplikasi yang jauh lebih lama, atau hasil restore backup asing)
      // SENGAJA dibiarkan NULL — arahnya tidak dapat dibuktikan dari
      // data, dan menebaknya berarti mengarang mutasi kas. Rekonsiliasi
      // melaporkan baris seperti itu secara EKSPLISIT sebagai tidak
      // dapat direkonsiliasi, bukan diam-diam menghitungnya nol.
    }

    if (currentVersion < 54) {
      // ============================================================
      // S20/P1 — bank_transaksi.tipe HARUS menerima 'KOREKSI'
      // ============================================================
      // MASALAH YANG DIPERBAIKI (temuan sampingan audit S19,
      // direproduksi di S20 §C):
      // `koreksiTransaksiKasBank()` menulis `tipe: 'KOREKSI'` untuk
      // KEDUA jenis rekening melalui SATU fungsi
      // `insertBarisTransaksi()`. `kas_transaksi.tipe` memuat
      // 'KOREKSI' di CHECK-nya, `bank_transaksi.tipe` TIDAK. Akibatnya
      // setiap koreksi transaksi BANK gagal dengan
      //   "CHECK constraint failed: tipe IN
      //    ('PENERIMAAN','PENGELUARAN','TRANSFER')"
      // sehingga transaksi bank yang salah tidak dapat dikoreksi sama
      // sekali. Tipe TypeScript `TipeTransaksiKasBank` memuat
      // 'KOREKSI', jadi `tsc` tidak pernah bisa menangkap ini —
      // kegagalannya murni runtime SQLite.
      //
      // KENAPA REBUILD, BUKAN ADD COLUMN:
      // SQLite tidak punya ALTER TABLE ... DROP/ALTER CONSTRAINT.
      // Satu-satunya cara mengubah CHECK adalah prosedur rebuild resmi
      // (CREATE ..._new -> INSERT SELECT -> DROP lama -> RENAME),
      // persis pola yang sudah dipakai v3 (app_user.role) dan v11
      // (utang). FK sudah dimatikan di awal blok migrasi ini dan
      // dinyalakan + diverifikasi `PRAGMA foreign_key_check` di
      // akhirnya.
      //
      // TIDAK ADA DATA YANG DIUBAH: seluruh kolom disalin apa adanya,
      // termasuk `arah_transfer` dari v53. journal & journal_entry
      // TIDAK disentuh sama sekali.
      await db.withTransactionAsync(async () => {
        const tabelAda = await db.getFirstAsync<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='bank_transaksi'`
        );
        if (!tabelAda) return;

        // Idempotensi: kalau CHECK-nya sudah memuat 'KOREKSI' (fresh
        // install v54, atau migrasi ini pernah jalan), rebuild
        // dilewati — bukan diulang.
        const ddl = await db.getFirstAsync<{ sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='bank_transaksi'`
        );
        if (ddl?.sql?.includes("'KOREKSI'")) return;

        // Instalasi lama bisa belum punya sebagian kolom yang
        // ditambahkan versi-versi berikutnya (`kategori` v2,
        // `arah_transfer` v53, dan pada database v3-era bahkan
        // `akun_lawan_id`/`journal_id`/`reversal_of_id`/
        // `idempotency_key`). Daftar kolom karena itu dibangun dari
        // `PRAGMA table_info` yang SEBENARNYA, bukan diasumsikan —
        // kolom yang tidak ada disalin sebagai NULL. Ketiganya nanti
        // tetap terisi oleh blok migrasi masing-masing.
        const kolom = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(bank_transaksi)`);
        const ada = new Set(kolom.map((k) => k.name));
        const salin = (nama: string) => (ada.has(nama) ? nama : 'NULL');

        await db.execAsync(`
          CREATE TABLE bank_transaksi_new (
            id TEXT PRIMARY KEY,
            bank_account_id TEXT NOT NULL REFERENCES bank_account(id),
            tipe TEXT NOT NULL CHECK (tipe IN ('PENERIMAAN','PENGELUARAN','TRANSFER','KOREKSI')),
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
            created_at TEXT NOT NULL
          );
        `);
        await db.execAsync(`
          INSERT INTO bank_transaksi_new
            (id, bank_account_id, tipe, arah_transfer, tanggal, nominal, akun_lawan_id,
             kategori, keterangan, nomor_transaksi, journal_id, reversal_of_id,
             idempotency_key, created_by, created_at)
          SELECT id, bank_account_id, tipe, ${salin('arah_transfer')}, tanggal, nominal,
                 ${salin('akun_lawan_id')}, ${salin('kategori')}, ${salin('keterangan')},
                 nomor_transaksi, ${salin('journal_id')}, ${salin('reversal_of_id')},
                 ${salin('idempotency_key')}, created_by, created_at
          FROM bank_transaksi;
        `);
        await db.execAsync(`DROP TABLE bank_transaksi;`);
        await db.execAsync(`ALTER TABLE bank_transaksi_new RENAME TO bank_transaksi;`);
        // Indeks IKUT TERHAPUS bersama tabel lama — harus dibuat ulang,
        // kalau tidak `idx_bank_idempotency` (UNIQUE) hilang dan guard
        // idempotensi kas/bank diam-diam berhenti bekerja.
        await db.execAsync(`
          CREATE INDEX IF NOT EXISTS idx_bank_tanggal ON bank_transaksi(tanggal);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_idempotency ON bank_transaksi(idempotency_key) WHERE idempotency_key IS NOT NULL;
        `);
      });
    }

    if (currentVersion < 55) {
      // ============================================================
      // S21 — PENARIKAN DINI SIMPANAN BERJANGKA (dua tabel BARU)
      // ============================================================
      // MIGRASI MINIMAL, sesuai §M: TIDAK ADA kolom baru pada
      // `simpanan_berjangka` maupun `simpanan_berjangka_bunga`, TIDAK
      // ADA rebuild tabel, TIDAK ADA data yang disentuh. Hanya dua
      // tabel baru yang sebelumnya belum ada.
      //
      // Keduanya dibuat KOSONG dan tetap kosong sampai pengurus
      // menetapkan kebijakan: instalasi lama yang naik ke v55 TIDAK
      // mendadak mengizinkan penarikan dini. Tanpa baris kebijakan,
      // status tetap POLICY_REQUIRED dan perilaku aplikasi identik
      // dengan sebelum migrasi.
      //
      // DDL di bawah SALINAN PERSIS blok 7d/7e pada schema.ts supaya
      // instalasi hasil migrasi dan instalasi baru punya struktur yang
      // sama persis (pola yang sama dipakai self-heal di bawah).
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS simpanan_berjangka_kebijakan_dini (
          id TEXT PRIMARY KEY,
          versi TEXT NOT NULL UNIQUE,
          berlaku_mulai TEXT NOT NULL,
          diizinkan INTEGER NOT NULL DEFAULT 0,
          jenis_penalti TEXT NOT NULL CHECK (jenis_penalti IN ('TIDAK_ADA','NOMINAL_TETAP','PERSENTASE')),
          nilai_penalti REAL,
          basis_penalti TEXT CHECK (basis_penalti IS NULL OR basis_penalti IN ('POKOK','BUNGA_BRUTO','TOTAL_SEBELUM_PENALTI')),
          akun_penalti_id TEXT REFERENCES account(id),
          jenis_forfeiture TEXT NOT NULL CHECK (jenis_forfeiture IN ('TIDAK_ADA','SELURUH_BUNGA','PERSENTASE_BUNGA','NOMINAL_TETAP')),
          nilai_forfeiture REAL,
          jenis_biaya_admin TEXT NOT NULL CHECK (jenis_biaya_admin IN ('TIDAK_ADA','NOMINAL_TETAP','PERSENTASE')),
          nilai_biaya_admin REAL,
          basis_biaya_admin TEXT CHECK (basis_biaya_admin IS NULL OR basis_biaya_admin IN ('POKOK','BUNGA_BRUTO')),
          akun_biaya_admin_id TEXT REFERENCES account(id),
          rate_dini REAL,
          jenis_penyesuaian_rate TEXT NOT NULL CHECK (jenis_penyesuaian_rate IN ('TIDAK_ADA','RATE_DINI')),
          cakupan_penyesuaian_rate TEXT CHECK (cakupan_penyesuaian_rate IS NULL OR cakupan_penyesuaian_rate IN ('SEJAK_PENEMPATAN','PERIODE_BERJALAN_SAJA')),
          perlakuan_pokok TEXT NOT NULL CHECK (perlakuan_pokok IN ('PENUH','DIKURANGI_PENALTI','DIKURANGI_BIAYA_ADMIN','DIKURANGI_PENALTI_DAN_BIAYA')),
          perlakuan_bunga TEXT NOT NULL CHECK (perlakuan_bunga IN ('BAYAR_SETELAH_FORFEITURE','TIDAK_DIBAYAR')),
          dasar_penetapan TEXT,
          ditetapkan_oleh TEXT,
          status TEXT NOT NULL CHECK (status IN ('AKTIF','NONAKTIF')) DEFAULT 'AKTIF',
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sb_kebijakan_dini_aktif ON simpanan_berjangka_kebijakan_dini(status) WHERE status = 'AKTIF';

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
      `);
    }

    // Self-heal COA (sama seperti pola self-heal role_permission di
    // PermissionService) — dijalankan SETIAP kali ada upgrade versi
    // berapa pun asalnya (bukan cuma dari <5), supaya akun/mapping
    // baru yang ditambahkan di versi manapun (termasuk mapping
    // PENYUSUTAN_ASET & PENGAKUAN_PENDAPATAN_DIMUKA di v6, dan
    // PENYISIHAN_PIUTANG di v8/Phase 8 — v8 SENGAJA tidak punya blok
    // migrasi skema sendiri, cuma menaikkan nomor versi supaya
    // instalasi yang sudah di v7 ikut lewat blok self-heal ini sekali
    // lagi) otomatis tersedia untuk instalasi lama. Idempoten lewat
    // cek existence per kode/transaction_type+role, tidak menyentuh
    // akun yang sudah ada. Instalasi baru tidak butuh ini karena
    // SetupService.setupKoperasi() sudah seed dari daftar terbaru
    // saat setup pertama kali.
    {
      const now = new Date().toISOString();
      const existingAccounts = await db.getAllAsync<{ kode: string; id: string }>(`SELECT kode, id FROM account`);
      const accountIdByKode = new Map(existingAccounts.map((a) => [a.kode, a.id]));

      for (const acc of DEFAULT_ACCOUNTS) {
        if (accountIdByKode.has(acc.kode)) continue;
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

      const existingMappings = await db.getAllAsync<{ transaction_type: string; role: string }>(
        `SELECT transaction_type, role FROM account_mapping`
      );
      const mappingExists = new Set(existingMappings.map((m) => `${m.transaction_type}::${m.role}`));

      for (const mapping of DEFAULT_ACCOUNT_MAPPING) {
        const key = `${mapping.transactionType}::${mapping.role}`;
        if (mappingExists.has(key)) continue;
        const accountId = accountIdByKode.get(mapping.accountKode);
        if (!accountId) continue; // seharusnya tidak terjadi, tapi jangan sampai migrasi gagal total
        await db.runAsync(
          `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES (?,?,?,?)`,
          newId(),
          mapping.transactionType,
          mapping.role,
          accountId
        );
      }
    }
    if (currentVersion < 56) {
      // ============================================================
      // RC-S51 §2A — REBUILD DIBUNGKUS SATU TRANSAKSI
      // ============================================================
      // TEMUAN AUDIT P1. Prosedur rebuild tabel resmi SQLite terdiri
      // dari empat langkah yang HARUS berhasil bersama:
      //
      //     CREATE TABLE ..._new -> INSERT SELECT -> DROP TABLE lama
      //     -> ALTER TABLE ..._new RENAME TO lama
      //
      // Sebelum RC ini blok ini dijalankan TANPA transaksi, sehingga
      // setiap langkah auto-commit sendiri. Exception (atau proses yang
      // mati) di antara langkah 3 dan 4 meninggalkan database dalam
      // keadaan tabel lama SUDAH HILANG sementara penggantinya masih
      // bernama `..._new` — skema separuh jadi yang tidak bisa dipakai
      // dan tidak bisa diulang dengan aman.
      //
      // `withTransactionAsync` membuat keempatnya atomik: kalau salah
      // satu gagal, SQLite me-rollback seluruhnya dan database kembali
      // ke keadaan sebelum blok ini berjalan. `schema_meta.version`
      // baru dinaikkan setelah SELURUH blok migrasi selesai (lihat
      // akhir fungsi), jadi percobaan berikutnya mengulang dari versi
      // yang sama — bukan melanjutkan dari tengah.
      //
      // Isi blok TIDAK diubah sama sekali: hanya dipindahkan ke dalam
      // callback transaksi. Tidak ada satu pun kolom, DDL, atau baris
      // data yang berbeda dari sebelumnya.
      await db.withTransactionAsync(async () => {
        // RC-S51 §2B — pasangan `PRAGMA foreign_keys = OFF/ON` yang dulu
        // ada di dalam blok ini DIHAPUS.
        //
        // Dua alasan. (1) REDUNDAN: seluruh blok migrasi legacy sudah
        // berjalan dengan FK OFF (lihat satu-satunya `PRAGMA
        // foreign_keys = OFF` di atas), jadi mematikannya lagi di sini
        // tidak mengubah apa pun. (2) BERBAHAYA: `PRAGMA foreign_keys =
        // ON` di akhir blok ini menyalakan kembali FK di TENGAH rangkaian
        // migrasi, sehingga rebuild pada blok versi BERIKUTNYA berjalan
        // dengan FK aktif — dan di sana `DROP TABLE` memicu ON DELETE
        // CASCADE pada tabel anak. Itu silent data loss yang hanya tidak
        // terjadi karena setiap blok kebetulan mematikannya sendiri lagi.
        //
        // FK tetap dinyalakan kembali dan diverifikasi `PRAGMA
        // foreign_key_check` SEKALI di akhir seluruh blok migrasi — satu
        // tempat, sesuai invarian yang sudah ditulis di atas.
        //
        // Catatan: PRAGMA ini juga akan menjadi no-op begitu blok
        // dibungkus transaksi (SQLite mengabaikannya di dalam transaksi
        // aktif), jadi membiarkannya hanya akan menyesatkan pembaca.

        // ============================================================
        // S39 — SAK EP SEBAGAI SATU-SATUNYA STANDAR AKUNTANSI
        // ============================================================
        // Migrasi ini HANYA menyentuh METADATA standar akuntansi. Tidak
        // ada tabel yang di-drop, tidak ada kolom yang dihapus, tidak ada
        // transaksi/saldo/jurnal yang disentuh. Nominal, tanggal, dan
        // seluruh data bisnis tidak berubah sama sekali.
        //
        // URUTANNYA WAJIB, dan tidak boleh dibalik:
        //
        //   1. normalisasi DATA lebih dulu (SAK_EMKM -> SAK_EP)
        //   2. verifikasi tidak ada sisa
        //   3. BARU rebuild tabel dengan CHECK yang dipersempit
        //
        // Membalik urutannya membuat rebuild GAGAL pada instalasi lama:
        // baris ber-'SAK_EMKM' akan melanggar CHECK baru saat disalin,
        // dan seluruh migrasi batal — pengguna terjebak dengan database
        // yang tidak dapat dibuka.

        // --- Langkah 1: audit sebelum ---------------------------------
        const sebelum = await db.getAllAsync<{ standar_akuntansi: string; jumlah: number }>(
          `SELECT standar_akuntansi, COUNT(*) AS jumlah FROM koperasi
           GROUP BY standar_akuntansi ORDER BY standar_akuntansi`
        );
        console.log('[v56] standar_akuntansi sebelum migrasi:', JSON.stringify(sebelum));

        // --- Langkah 2: normalisasi (idempoten) -----------------------
        // Dijalankan tanpa syarat: bila tidak ada baris SAK_EMKM,
        // pernyataan ini tidak mengubah apa pun.
        await db.runAsync(
          `UPDATE koperasi SET standar_akuntansi = 'SAK_EP', updated_at = ?
           WHERE standar_akuntansi <> 'SAK_EP'`,
          new Date().toISOString()
        );

        // --- Langkah 3: verifikasi sebelum menyentuh skema ------------
        const tersisa = await db.getFirstAsync<{ jumlah: number }>(
          `SELECT COUNT(*) AS jumlah FROM koperasi WHERE standar_akuntansi <> 'SAK_EP'`
        );
        if ((tersisa?.jumlah ?? 0) > 0) {
          // Fail-closed: lebih baik migrasi berhenti dengan pesan jelas
          // daripada rebuild gagal separuh jalan.
          throw new Error(
            `Migrasi v56 dibatalkan: masih ada ${tersisa?.jumlah} baris koperasi ` +
              `dengan standar_akuntansi selain SAK_EP.`
          );
        }

        // --- Langkah 4: rebuild tabel dengan CHECK baru ---------------
        // SQLite tidak mendukung ALTER TABLE untuk mengubah CHECK, jadi
        // pola rebuild yang sudah dipakai migrasi v54 diikuti apa adanya.
        await db.execAsync(`
          CREATE TABLE koperasi_v56 (
            id TEXT PRIMARY KEY,
            nama TEXT NOT NULL,
            nomor_badan_hukum TEXT,
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
        `);
        await db.execAsync(`
          INSERT INTO koperasi_v56 (
            id, nama, nomor_badan_hukum, npwp, alamat, telepon, email, logo_uri,
            tanggal_berdiri, tahun_buku_aktif, standar_akuntansi, setup_selesai,
            created_at, updated_at
          )
          SELECT
            id, nama, nomor_badan_hukum, npwp, alamat, telepon, email, logo_uri,
            tanggal_berdiri, tahun_buku_aktif, standar_akuntansi, setup_selesai,
            created_at, updated_at
          FROM koperasi;
        `);
        await db.execAsync('DROP TABLE koperasi;');
        await db.execAsync('ALTER TABLE koperasi_v56 RENAME TO koperasi;');

        // --- Langkah 5: verifikasi sesudah ---------------------------
        const sesudah = await db.getAllAsync<{ standar_akuntansi: string; jumlah: number }>(
          `SELECT standar_akuntansi, COUNT(*) AS jumlah FROM koperasi
           GROUP BY standar_akuntansi ORDER BY standar_akuntansi`
        );
        console.log('[v56] standar_akuntansi sesudah migrasi:', JSON.stringify(sesudah));

        const totalSebelum = sebelum.reduce((n, r) => n + r.jumlah, 0);
        const totalSesudah = sesudah.reduce((n, r) => n + r.jumlah, 0);
        if (totalSebelum !== totalSesudah) {
          throw new Error(
            `Migrasi v56: jumlah baris koperasi berubah (${totalSebelum} -> ${totalSesudah}).`
          );
        }
    });
    }

    if (currentVersion < 57) {
      // ============================================================
      // RC-S51 §2A — REBUILD DIBUNGKUS SATU TRANSAKSI
      // ============================================================
      // TEMUAN AUDIT P1. Prosedur rebuild tabel resmi SQLite terdiri
      // dari empat langkah yang HARUS berhasil bersama:
      //
      //     CREATE TABLE ..._new -> INSERT SELECT -> DROP TABLE lama
      //     -> ALTER TABLE ..._new RENAME TO lama
      //
      // Sebelum RC ini blok ini dijalankan TANPA transaksi, sehingga
      // setiap langkah auto-commit sendiri. Exception (atau proses yang
      // mati) di antara langkah 3 dan 4 meninggalkan database dalam
      // keadaan tabel lama SUDAH HILANG sementara penggantinya masih
      // bernama `..._new` — skema separuh jadi yang tidak bisa dipakai
      // dan tidak bisa diulang dengan aman.
      //
      // `withTransactionAsync` membuat keempatnya atomik: kalau salah
      // satu gagal, SQLite me-rollback seluruhnya dan database kembali
      // ke keadaan sebelum blok ini berjalan. `schema_meta.version`
      // baru dinaikkan setelah SELURUH blok migrasi selesai (lihat
      // akhir fungsi), jadi percobaan berikutnya mengulang dari versi
      // yang sama — bukan melanjutkan dari tengah.
      //
      // Isi blok TIDAK diubah sama sekali: hanya dipindahkan ke dalam
      // callback transaksi. Tidak ada satu pun kolom, DDL, atau baris
      // data yang berbeda dari sebelumnya.
      await db.withTransactionAsync(async () => {
        // RC-S51 §2B — pasangan `PRAGMA foreign_keys = OFF/ON` yang dulu
        // ada di dalam blok ini DIHAPUS.
        //
        // Dua alasan. (1) REDUNDAN: seluruh blok migrasi legacy sudah
        // berjalan dengan FK OFF (lihat satu-satunya `PRAGMA
        // foreign_keys = OFF` di atas), jadi mematikannya lagi di sini
        // tidak mengubah apa pun. (2) BERBAHAYA: `PRAGMA foreign_keys =
        // ON` di akhir blok ini menyalakan kembali FK di TENGAH rangkaian
        // migrasi, sehingga rebuild pada blok versi BERIKUTNYA berjalan
        // dengan FK aktif — dan di sana `DROP TABLE` memicu ON DELETE
        // CASCADE pada tabel anak. Itu silent data loss yang hanya tidak
        // terjadi karena setiap blok kebetulan mematikannya sendiri lagi.
        //
        // FK tetap dinyalakan kembali dan diverifikasi `PRAGMA
        // foreign_key_check` SEKALI di akhir seluruh blok migrasi — satu
        // tempat, sesuai invarian yang sudah ditulis di atas.
        //
        // Catatan: PRAGMA ini juga akan menjadi no-op begitu blok
        // dibungkus transaksi (SQLite mengabaikannya di dalam transaksi
        // aktif), jadi membiarkannya hanya akan menyesatkan pembaca.

        // ============================================================
        // S44b — NULL ≠ KEPUTUSAN PADA KEBIJAKAN PENARIKAN DINI
        // ============================================================
        // Enam kolom keputusan dulu NOT NULL, sehingga menyimpan
        // "pengurus belum memutuskan" mustahil — layar penetapan terpaksa
        // mengisi 'TIDAK_ADA'/'PENUH'/'BAYAR_SETELAH_FORFEITURE'. Nilai
        // itu menghasilkan perhitungan yang sama dengan tanpa keputusan,
        // jadi kekeliruannya tidak terlihat dari angka mana pun — yang
        // berbeda hanya siapa yang bertanggung jawab atas aturannya.
        //
        // Migrasi ini melonggarkan CHECK menjadi `IS NULL OR IN (...)`.
        // Ia TIDAK mengubah satu pun baris kebijakan yang sudah ada:
        // kebijakan lama tetap membawa keputusan eksplisitnya, dan itu
        // memang keputusan yang sah.
        //
        // Tidak ada tabel bisnis lain yang tersentuh.
        const jml = await db.getFirstAsync<{ c: number }>(
          'SELECT COUNT(*) AS c FROM simpanan_berjangka_kebijakan_dini'
        );
        console.log('[v57] baris kebijakan penarikan dini:', jml?.c ?? 0);

        await db.execAsync(`
          CREATE TABLE sbkd_v57 (
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
            status TEXT NOT NULL CHECK (status IN ('AKTIF','NONAKTIF')) DEFAULT 'AKTIF',
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `);
        await db.execAsync('INSERT INTO sbkd_v57 SELECT * FROM simpanan_berjangka_kebijakan_dini;');
        await db.execAsync('DROP TABLE simpanan_berjangka_kebijakan_dini;');
        await db.execAsync('ALTER TABLE sbkd_v57 RENAME TO simpanan_berjangka_kebijakan_dini;');

        const sesudah = await db.getFirstAsync<{ c: number }>(
          'SELECT COUNT(*) AS c FROM simpanan_berjangka_kebijakan_dini'
        );
        if ((jml?.c ?? 0) !== (sesudah?.c ?? 0)) {
          throw new Error('Migrasi v57: jumlah baris kebijakan berubah.');
        }
    });
    }

    if (currentVersion < 58) {
      // ============================================================
      // RC-S51 §2A — REBUILD DIBUNGKUS SATU TRANSAKSI
      // ============================================================
      // TEMUAN AUDIT P1. Prosedur rebuild tabel resmi SQLite terdiri
      // dari empat langkah yang HARUS berhasil bersama:
      //
      //     CREATE TABLE ..._new -> INSERT SELECT -> DROP TABLE lama
      //     -> ALTER TABLE ..._new RENAME TO lama
      //
      // Sebelum RC ini blok ini dijalankan TANPA transaksi, sehingga
      // setiap langkah auto-commit sendiri. Exception (atau proses yang
      // mati) di antara langkah 3 dan 4 meninggalkan database dalam
      // keadaan tabel lama SUDAH HILANG sementara penggantinya masih
      // bernama `..._new` — skema separuh jadi yang tidak bisa dipakai
      // dan tidak bisa diulang dengan aman.
      //
      // `withTransactionAsync` membuat keempatnya atomik: kalau salah
      // satu gagal, SQLite me-rollback seluruhnya dan database kembali
      // ke keadaan sebelum blok ini berjalan. `schema_meta.version`
      // baru dinaikkan setelah SELURUH blok migrasi selesai (lihat
      // akhir fungsi), jadi percobaan berikutnya mengulang dari versi
      // yang sama — bukan melanjutkan dari tengah.
      //
      // Isi blok TIDAK diubah sama sekali: hanya dipindahkan ke dalam
      // callback transaksi. Tidak ada satu pun kolom, DDL, atau baris
      // data yang berbeda dari sebelumnya.
      await db.withTransactionAsync(async () => {
        // RC-S51 §2B — pasangan `PRAGMA foreign_keys = OFF/ON` yang dulu
        // ada di dalam blok ini DIHAPUS.
        //
        // Dua alasan. (1) REDUNDAN: seluruh blok migrasi legacy sudah
        // berjalan dengan FK OFF (lihat satu-satunya `PRAGMA
        // foreign_keys = OFF` di atas), jadi mematikannya lagi di sini
        // tidak mengubah apa pun. (2) BERBAHAYA: `PRAGMA foreign_keys =
        // ON` di akhir blok ini menyalakan kembali FK di TENGAH rangkaian
        // migrasi, sehingga rebuild pada blok versi BERIKUTNYA berjalan
        // dengan FK aktif — dan di sana `DROP TABLE` memicu ON DELETE
        // CASCADE pada tabel anak. Itu silent data loss yang hanya tidak
        // terjadi karena setiap blok kebetulan mematikannya sendiri lagi.
        //
        // FK tetap dinyalakan kembali dan diverifikasi `PRAGMA
        // foreign_key_check` SEKALI di akhir seluruh blok migrasi — satu
        // tempat, sesuai invarian yang sudah ditulis di atas.
        //
        // Catatan: PRAGMA ini juga akan menjadi no-op begitu blok
        // dibungkus transaksi (SQLite mengabaikannya di dalam transaksi
        // aktif), jadi membiarkannya hanya akan menyesatkan pembaca.

        // ============================================================
        // S44c — STATUS 'DRAFT' UNTUK KEBIJAKAN PENARIKAN DINI
        // ============================================================
        // Kebijakan boleh disimpan bertahap sejak S44b, tetapi CHECK
        // status hanya mengizinkan AKTIF/NONAKTIF — sehingga kebijakan
        // yang belum lengkap terpaksa masuk sebagai AKTIF dan langsung
        // menggantikan kebijakan yang sedang berlaku.
        //
        // Migrasi ini HANYA melonggarkan CHECK. Tidak ada baris yang
        // diubah statusnya: kebijakan AKTIF tetap AKTIF, NONAKTIF tetap
        // NONAKTIF. Indeks unik parsial dibuat ulang agar jaminan
        // "maksimum satu kebijakan AKTIF" tetap berlaku.
        const sebelum = await db.getAllAsync<{ status: string; c: number }>(
          `SELECT status, COUNT(*) AS c FROM simpanan_berjangka_kebijakan_dini GROUP BY status`
        );
        console.log('[v58] status kebijakan sebelum:', JSON.stringify(sebelum));

        await db.execAsync(`
          CREATE TABLE sbkd_v58 (
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
            status TEXT NOT NULL CHECK (status IN ('DRAFT','AKTIF','NONAKTIF')) DEFAULT 'AKTIF',
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `);
        await db.execAsync('INSERT INTO sbkd_v58 SELECT * FROM simpanan_berjangka_kebijakan_dini;');
        await db.execAsync('DROP TABLE simpanan_berjangka_kebijakan_dini;');
        await db.execAsync('ALTER TABLE sbkd_v58 RENAME TO simpanan_berjangka_kebijakan_dini;');
        await db.execAsync(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_sb_kebijakan_dini_aktif
             ON simpanan_berjangka_kebijakan_dini(status) WHERE status = 'AKTIF';`
        );

        const sesudah = await db.getAllAsync<{ status: string; c: number }>(
          `SELECT status, COUNT(*) AS c FROM simpanan_berjangka_kebijakan_dini GROUP BY status`
        );
        console.log('[v58] status kebijakan sesudah:', JSON.stringify(sesudah));
        const totalSebelum = sebelum.reduce((n, r) => n + r.c, 0);
        const totalSesudah = sesudah.reduce((n, r) => n + r.c, 0);
        if (totalSebelum !== totalSesudah) {
          throw new Error('Migrasi v58: jumlah baris kebijakan berubah.');
        }
    });
    }

    if (currentVersion < 59) {
      // ============================================================
      // RC-S50 §4 — RENAME akun 1-1210 (KODE TIDAK BERUBAH)
      // ============================================================
      // KENAPA MIGRASI DIPERLUKAN, BUKAN CUKUP defaultCOA.ts.
      // Blok self-heal COA generik hanya INSERT akun yang belum ada
      // (cek existence per `kode`); ia TIDAK PERNAH meng-UPDATE `nama`
      // baris yang sudah ada. Jadi mengubah DEFAULT_ACCOUNTS saja
      // hanya berdampak pada instalasi BARU — instalasi existing akan
      // terus menampilkan "Penyisihan Piutang Tak Tertagih" di Daftar
      // Akun, tepat variasi nama yang diminta untuk dihilangkan.
      //
      // Ini UPDATE DATA, bukan perubahan skema: tidak ada DDL, tidak
      // ada kolom/tabel/indeks yang berubah. Pola SAMA PERSIS dengan
      // migrasi v50 (rename 5-2100), v30 (rename "Cadangan" ->
      // "Cadangan Umum") dan v14 (rename akun 1-1600).
      //
      // `account.id`, `kode`, `kategori`, `normal_balance`,
      // `lhu_klasifikasi`, dan `account_mapping` TIDAK disentuh —
      // seluruh `journal_entry` & `saldo_awal_akun` historis tetap
      // menunjuk baris yang sama, jadi TIDAK ADA saldo atau laporan
      // yang berubah nilainya. Hanya labelnya.
      //
      // Filter `nama = 'Penyisihan Piutang Tak Tertagih'` (bukan hanya
      // `kode = '1-1210'`) DISENGAJA: kalau admin sudah pernah
      // mengganti nama akun ini sendiri lewat Input Akun, migrasi ini
      // TIDAK menimpanya.
      await db.runAsync(
        `UPDATE account SET nama = 'Penyisihan Piutang', updated_at = ?
         WHERE kode = '1-1210' AND nama = 'Penyisihan Piutang Tak Tertagih'`,
        new Date().toISOString()
      );
    }

    if (currentVersion < 60) {
      await migrasiV60(db, tambahKolomJikaBelumAda);
    }

    if (currentVersion < 61) {
      await migrasiV61(db);
    }

    if (currentVersion < 62) {
      await migrasiV62(db, tambahKolomJikaBelumAda);
    }

    if (currentVersion < 63) {
      await migrasiV63(db);
    }

    if (currentVersion < 64) {
      await migrasiV64(db, tambahKolomJikaBelumAda);
    }

    if (currentVersion < 65) {
      await migrasiV65(db, tambahKolomJikaBelumAda);
    }

    if (currentVersion < 66) {
      // RC-S54 TAHAP 16 — ITEM #20 (keputusan COA pengguna): SENGAJA tanpa
      // DDL dan tanpa INSERT manual di sini. Akun baru 5-2160 "Kerugian
      // Pelepasan Investasi" (BEBAN_LAIN) serta mapping PELEPASAN_INVESTASI
      // (KREDIT_LABA -> 4-1800, DEBIT_RUGI -> 5-2160) sudah didaftarkan di
      // DEFAULT_ACCOUNTS / DEFAULT_ACCOUNT_MAPPING dan disisipkan oleh blok
      // self-heal COA generik di atas (cek existence per kode dan per
      // transaction_type::role — idempoten, tidak menimpa mapping yang sudah
      // diubah pengguna). Pola sama dengan v36/v37. Tidak ada jurnal, saldo,
      // atau baris histori yang disentuh.
    }

    if (currentVersion < 67) {
      // RC-S54 TAHAP 16 — GAP 6 (keputusan pengguna): SENGAJA tanpa DDL dan
      // tanpa INSERT manual. Akun 5-2170 "Kerugian Pelepasan Aset Tetap"
      // (BEBAN_LAIN) serta mapping PELEPASAN_ASET_TETAP (KREDIT_LABA -> 4-1800,
      // DEBIT_RUGI -> 5-2170) didaftarkan di DEFAULT_ACCOUNTS /
      // DEFAULT_ACCOUNT_MAPPING dan disisipkan blok self-heal COA generik
      // (idempoten, tidak menimpa mapping kustom). Jurnal & saldo tidak disentuh.
    }

    if (currentVersion < 68) {
      // RC-S54 POST-CLOSURE #14 (keputusan pengguna): SENGAJA tanpa DDL dan
      // tanpa INSERT manual. 12 akun dengan kode persis yang diminta sudah
      // didaftarkan di DEFAULT_ACCOUNTS dan disisipkan blok self-heal COA
      // generik di atas (cek per kode -> idempoten, tidak menimpa akun/mapping
      // yang sudah ada). DEFINED / NOT ACTIVELY POSTED: tidak ada mapping
      // otomatis, tidak ada jurnal historis yang dipindahkan, policy final
      // (KEPUTUSAN 02/04-A, POLICY 03 MODEL BIAYA) tidak berubah.
    }

    if (currentVersion < 69) {
      await migrasiV69(db, tambahKolomJikaBelumAda);
    }

    if (currentVersion < 70) {
      await migrasiV70(db, tambahKolomJikaBelumAda);
    }

    if (currentVersion < 71) {
      await migrasiV71(db);
    }

    if (currentVersion < 72) {
      await migrasiV72(db, tambahKolomJikaBelumAda);
    }

    if (currentVersion < 73) {
      await migrasiV73(db);
    }

    if (currentVersion < 74) {
      await migrasiV74(db);
    }

    if (currentVersion < 75) {
      await migrasiV75(db);
    }

    if (currentVersion < 76) {
      await migrasiV76(db);
    }

    if (currentVersion < 77) {
      await migrasiV77(db, tambahKolomJikaBelumAda);
    }

    if (currentVersion < 78) {
      await migrasiV78(db, tambahKolomJikaBelumAda);
    }

    if (currentVersion < 79) {
      await migrasiV79(db);
    }

    if (currentVersion < 80) {
      await migrasiV80(db);
    }

    if (currentVersion < 81) {
      await migrasiV81(db, tambahKolomJikaBelumAda);
    }

    if (currentVersion < 82) {
      await migrasiV82(db, tambahKolomJikaBelumAda);
    }

    // PHASE 2E — versi HANYA dinaikkan di sini, yaitu setelah SELURUH
    // blok migrasi di atas selesai tanpa exception. Kalau ada satu saja
    // yang melempar, baris ini tidak pernah dijalankan: percobaan
    // berikutnya membaca `currentVersion` yang sama dan mengulang
    // migrasi dari titik yang sama. Itulah sebabnya setiap blok wajib
    // idempoten (rebuild dilewati kalau DDL-nya sudah memuat bentuk
    // baru, ADD COLUMN dibungkus try/catch, INSERT memakai
    // INSERT OR REPLACE / cek existence).
    await db.runAsync('UPDATE schema_meta SET version = ?', SCHEMA_VERSION);
    } finally {
      // BUG-01 — kembalikan invarian: FK WAJIB ON lagi setelah migrasi,
      // sukses maupun gagal.
      //
      // Kegagalan PRAGMA ini sendiri di-log, TIDAK dilempar: melempar
      // dari `finally` akan MENGGANTIKAN exception migrasi yang asli
      // dan menghilangkan satu-satunya petunjuk penyebab kegagalan.
      // Pada jalur sukses, `assertForeignKeysEnabled` di bawah tetap
      // memverifikasinya dan gagal keras kalau FK ternyata tidak aktif.
      try {
        await db.execAsync('PRAGMA foreign_keys = ON;');
      } catch (e) {
        console.error('[runMigrations] gagal mengaktifkan kembali PRAGMA foreign_keys:', e);
      }
    }

    // Buktikan bahwa rebuild tabel di atas tidak meninggalkan orphan
    // record. `PRAGMA foreign_key_check` memeriksa SELURUH database
    // terhadap definisi FK saat ini dan mengembalikan satu baris per
    // pelanggaran (kosong = bersih). Hanya dijalankan pada jalur
    // sukses — pada jalur gagal, exception migrasi yang relevan.
    await assertForeignKeysEnabled(db, 'runMigrations (setelah blok migrasi legacy)');

    const pelanggaranFk = await db.getAllAsync<{ table: string; rowid: number; parent: string }>(
      'PRAGMA foreign_key_check'
    );
    if (pelanggaranFk.length > 0) {
      // Fail loud: migrasi yang menghasilkan orphan record adalah cacat
      // integritas data, bukan sesuatu yang boleh dibiarkan lewat.
      const ringkasan = pelanggaranFk
        .slice(0, 10)
        .map((p) => `${p.table}(rowid=${p.rowid}) -> ${p.parent}`)
        .join(', ');
      throw new Error(
        `[DatabaseIntegrity] Migrasi menghasilkan ${pelanggaranFk.length} pelanggaran foreign key. ` +
          `Contoh: ${ringkasan}. Database TIDAK dianggap siap dipakai.`
      );
    }
  }

  // CRITICAL FIX (bug ditemukan di perangkat pengguna, Android): lihat
  // komentar lengkap di pastikanIntegritasSchemaWajib() di bawah.
  // Ditempatkan DI LUAR blok `if (currentVersion < SCHEMA_VERSION)` di
  // atas SENGAJA — device dengan schema_meta.version SUDAH SAMA dengan
  // SCHEMA_VERSION (kasus paling umum, setiap getDb() normal) TIDAK
  // PERNAH masuk blok itu sama sekali, jadi pengecekan integritas objek
  // schema wajib harus jalan di sini, tanpa syarat version apa pun,
  // supaya device yang schema_meta-nya sudah "47" tapi kehilangan tabel
  // wajib secara fisik tetap bisa self-heal setiap kali getDb() dibuka
  // (§8 tiket: "schema integrity/self-heal check" adalah tahap sendiri
  // sebelum database dianggap ready, bukan bagian dari migrasi versi).
  await pastikanIntegritasSchemaWajib(db);
}

/**
 * CRITICAL FIX — schema self-heal berbasis EXISTENCE OBJEK, BUKAN cuma
 * schema_meta.version.
 *
 * Root cause bug (perangkat Android pengguna): setiap blok migrasi versi
 * di atas (`if (currentVersion < N)`) HANYA dijalankan sekali seumur
 * hidup device — begitu schema_meta.version sudah >= N, blok itu tidak
 * pernah dieksekusi ulang. Kalau objek yang seharusnya blok itu buat
 * (`pinjaman_akuntansi_jasa` di v42) hilang secara FISIK dari database
 * SETELAH migrasi v42 pernah berhasil — rebuild v47 di atas pun cuma
 * bertindak `if (tableInfo)`, jadi kalau tabel sudah hilang duluan
 * sebelum rebuild sempat jalan, itu jadi no-op permanen juga — device
 * tsb SELAMANYA gagal "no such table: pinjaman_akuntansi_jasa" begitu
 * membuka Akad Ulang, karena `currentVersion < SCHEMA_VERSION` (47 < 47)
 * selalu false sehingga tidak ada blok migrasi manapun yang tersentuh
 * lagi.
 *
 * Fix: pengecekan EXISTENCE + STRUKTUR (kolom Phase 2/7) yang berjalan
 * TANPA SYARAT version, dipanggil TANPA SYARAT di akhir runMigrations()
 * — murah (beberapa query sqlite_master/PRAGMA), aman dijalankan setiap
 * getDb(). TIDAK PERNAH DROP TABLE, TIDAK menghapus/mengarang data,
 * TIDAK mengubah schema_meta.version (bukan naik atau turun — ini
 * perbaikan struktur, bukan migrasi versi). Kalau tabel sudah ada &
 * lengkap (kondisi normal), fungsi ini hanya baca, tidak menulis apa
 * pun — idempoten sepenuhnya (test #4 tiket: dijalankan dua kali tidak
 * duplicate/error).
 *
 * Scope SENGAJA dibatasi ke `pinjaman_akuntansi_jasa` — tabel yang
 * dilaporkan bermasalah — bukan audit ulang seluruh tabel yang dibuat
 * lewat blok version-gated serupa (permintaan pengguna eksplisit:
 * "jangan membuat daftar baru secara sembarangan").
 */
async function pastikanIntegritasSchemaWajib(db: SQLite.SQLiteDatabase): Promise<void> {
  const tableInfo = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='pinjaman_akuntansi_jasa'`
  );

  if (!tableInfo) {
    // §6 tiket: log internal bahwa schema dipulihkan — TIDAK mengarang
    // data historis, TIDAK backfill EIR, murni struktur kosong (sama
    // seperti tabel baru pada fresh install).
    console.warn(
      '[SchemaIntegrity] Tabel pinjaman_akuntansi_jasa tidak ditemukan padahal schema_meta.version sudah ' +
        SCHEMA_VERSION +
        ' — memulihkan struktur schema (data historis TIDAK di-backfill, hanya struktur yang dipulihkan).'
    );
    // Definisi PERSIS sama dengan CREATE_TABLES_SQL (schema.ts) & hasil
    // akhir rebuild v47 di atas — TIDAK memakai definisi v42 yang lama
    // (belum ada kolom Phase 2/7), sesuai §1 tiket ("gunakan definisi
    // final yang sesuai dengan schema.ts").
    await db.execAsync(`
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
        fee_lifecycle_status TEXT CHECK (fee_lifecycle_status IN (
          'DEFERRED_PENDING_EIR','AMORTIZED','RECOGNIZED','PENDING_RESTRUCTURING_EIR_REVIEW','DERECOGNIZED'
        )),
        writeoff_amount INTEGER NOT NULL DEFAULT 0,
        effective_interest_rate REAL,
        remaining_term_bulan INTEGER,
        principal_component INTEGER,
        UNIQUE(pinjaman_id, periode_akuntansi, tipe_pengakuan)
      );
      CREATE INDEX IF NOT EXISTS idx_pinjaman_akuntansi_jasa_pinjaman ON pinjaman_akuntansi_jasa(pinjaman_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pinjaman_akuntansi_jasa_idempotency ON pinjaman_akuntansi_jasa(idempotency_key);
    `);
    return; // Baru dibuat dengan kolom final lengkap — tidak perlu cek kolom di bawah.
  }

  // §2 tiket: tabel ADA bukan jaminan strukturnya lengkap — cek kolom
  // Phase 2/7 satu per satu, ADD COLUMN kalau memang belum ada. SQLite
  // tidak punya "ADD COLUMN IF NOT EXISTS", jadi dibungkus try/catch —
  // pola SAMA dengan tambahKolomJikaBelumAda() di atas.
  const kolomWajib: { nama: string; tipe: string }[] = [
    { nama: 'fee_lifecycle_status', tipe: 'TEXT' },
    { nama: 'writeoff_amount', tipe: 'INTEGER NOT NULL DEFAULT 0' },
    { nama: 'effective_interest_rate', tipe: 'REAL' },
    { nama: 'remaining_term_bulan', tipe: 'INTEGER' },
    { nama: 'principal_component', tipe: 'INTEGER' },
  ];
  const existingColumns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(pinjaman_akuntansi_jasa)`);
  const existingColumnNames = new Set(existingColumns.map((c) => c.name));
  for (const kolom of kolomWajib) {
    if (existingColumnNames.has(kolom.nama)) continue;
    console.warn(`[SchemaIntegrity] Kolom pinjaman_akuntansi_jasa.${kolom.nama} tidak ditemukan — menambahkan.`);
    try {
      await db.execAsync(`ALTER TABLE pinjaman_akuntansi_jasa ADD COLUMN ${kolom.nama} ${kolom.tipe};`);
    } catch {
      // Kolom sudah ada (race/edge case) — abaikan, sama seperti tambahKolomJikaBelumAda().
    }
  }

  // Index juga idempoten lewat IF NOT EXISTS — aman kalau entah
  // bagaimana hilang bersamaan dengan skenario di atas.
  await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_pinjaman_akuntansi_jasa_pinjaman ON pinjaman_akuntansi_jasa(pinjaman_id);`);
  try {
    await db.execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pinjaman_akuntansi_jasa_idempotency ON pinjaman_akuntansi_jasa(idempotency_key);`);
  } catch {
    // Kalau ada baris idempotency_key duplikat/NULL dari kondisi data
    // yang tidak terduga, jangan sampai self-heal ini membuat seluruh
    // getDb() gagal — index unik ini best-effort, bukan syarat utama
    // (constraint yang sama juga sudah ada sejak CREATE_TABLES_SQL).
  }
}

/** Helper transaksi generik untuk repositories/services. */

/**
 * MIGRASI v60 — MASTER DATA IDENTITAS KOPERASI.
 *
 * DIEKSTRAK dari blok migrasi supaya dapat DIJALANKAN LANGSUNG oleh
 * integration test terhadap database SQLite sungguhan. Migrasi yang
 * hanya bisa dibaca tetapi tidak bisa dieksekusi tidak pernah benar-
 * benar terbukti; ini satu-satunya alasan pemisahannya.
 *
 * Isinya TIDAK berubah sedikit pun dari bentuk in-line sebelumnya, dan
 * pemanggilnya tetap blok `if (currentVersion < 60)` yang sama — tidak
 * ada jalur migrasi kedua.
 *
 * `tambahKolom` disuntikkan, bukan diimpor, karena helper aslinya
 * adalah closure di dalam runner migrasi.
 */
export async function migrasiV60(
  db: SQLite.SQLiteDatabase,
  tambahKolom: (tabel: string, kolom: string, tipe: string) => Promise<void>
): Promise<void> {
      // ============================================================
      // v60 — MASTER DATA IDENTITAS KOPERASI
      // ============================================================
      // SELURUHNYA ADITIF: dua kolom baru pada `koperasi` dan empat
      // tabel baru. Tidak ada DROP, tidak ada rebuild tabel, tidak ada
      // UPDATE terhadap jurnal/ledger/COA. Angka laporan mana pun
      // tidak bergerak karena migrasi ini.
      //
      // Idempoten: ADD COLUMN dibungkus helper try/catch yang sudah
      // dipakai lintas versi, dan seluruh DDL memakai
      // CREATE TABLE/INDEX IF NOT EXISTS. Aman dijalankan ulang bila
      // migrasi berikutnya sempat gagal.

      await tambahKolom('koperasi', 'nomor_ahu', 'TEXT');
      await tambahKolom('koperasi', 'nomor_induk_koperasi', 'TEXT');

      // BACKFILL AHU dari kolom warisan.
      //
      // `nomor_badan_hukum` dan `nomor_ahu` merujuk dokumen yang SAMA —
      // penamaannya yang berubah mengikuti istilah resmi. Karena itu
      // nilainya disalin, bukan dikosongkan.
      //
      // Syarat `nomor_ahu IS NULL` membuat backfill ini aman diulang:
      // begitu pengguna mengisi AHU sendiri, migrasi tidak akan
      // menimpanya dengan nilai lama.
      await db.runAsync(
        `UPDATE koperasi
            SET nomor_ahu = nomor_badan_hukum
          WHERE nomor_ahu IS NULL
            AND nomor_badan_hukum IS NOT NULL
            AND TRIM(nomor_badan_hukum) <> ''`
      );

      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS koperasi_personel (
          id TEXT PRIMARY KEY,
          nama TEXT NOT NULL,
          jenis_kelamin TEXT CHECK (jenis_kelamin IN ('L','P')),
          jabatan TEXT,
          tanggal_mulai_jabatan TEXT,
          tanggal_berakhir_jabatan TEXT,
          nik TEXT,
          nomor_telepon TEXT,
          alamat TEXT,
          jenis_personel TEXT NOT NULL CHECK (jenis_personel IN
            ('PENGURUS','PENGAWAS','PENGELOLA','KARYAWAN','PEKERJA')),
          status_aktif INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_personel_jenis ON koperasi_personel(jenis_personel, status_aktif);
        CREATE INDEX IF NOT EXISTS idx_personel_nama ON koperasi_personel(nama);

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
      `);
    }


/**
 * MIGRASI v61 — IMBALAN KERJA & KELUAR ANGGOTA.
 *
 * ADITIF SEPENUHNYA: dua tabel baru beserta indeksnya. Tidak ada kolom
 * yang diubah, tidak ada tabel yang di-rebuild, tidak ada UPDATE
 * terhadap jurnal/ledger/COA. Tidak ada akun COA baru — 2-1600 Utang
 * Imbalan Kerja dan 5-1050 Beban Imbalan Kerja sudah ada sejak lama.
 *
 * KENAPA TABEL BARU MEMANG DIPERLUKAN (bukan kenyamanan):
 *   - `imbalan_kerja`: sebelum ini imbalan hanya berupa jurnal akrual
 *     lepas tanpa penerima, periode, maupun jejak pembayaran. Tidak ada
 *     satu pun kolom existing yang dapat menampung personel_id +
 *     period_key + jenis imbalan, sehingga idempotensi per periode
 *     mustahil ditegakkan dari data yang ada.
 *   - `keluar_anggota`: alur lama membayar seketika tanpa status.
 *     DIAJUKAN/DISETUJUI/DIBAYAR/DITOLAK, penyetuju, dan snapshot saldo
 *     yang disetujui tidak punya tempat di skema mana pun.
 *
 * Idempoten lewat CREATE TABLE/INDEX IF NOT EXISTS — aman dijalankan
 * ulang bila migrasi berikutnya sempat gagal. Diekstrak sebagai fungsi
 * dengan alasan yang sama seperti `migrasiV60`: agar dapat dieksekusi
 * sungguhan oleh integration test, bukan hanya dibaca.
 */
export async function migrasiV61(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS imbalan_kerja (
      id TEXT PRIMARY KEY,
      personel_id TEXT NOT NULL REFERENCES koperasi_personel(id),
      period_key TEXT NOT NULL,
      jenis_imbalan TEXT NOT NULL DEFAULT 'HONORARIUM',
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
  `);
}


/**
 * MIGRASI v62 — PENYESUAIAN (rekonsiliasi, nilai wajar) & RAKU.
 *
 * ADITIF SEPENUHNYA. Tidak ada tabel yang dibongkar, tidak ada CHECK
 * lama yang diubah, tidak ada jurnal/ledger yang disentuh.
 *
 * Catatan penting soal `rekonsiliasi_kas_bank.status`: CHECK-nya
 * ('COCOK','SELISIH') TIDAK diperluas. Memperluas CHECK di SQLite
 * menuntut rebuild tabel, dan tabel ini sudah berisi histori. Karena
 * itu penyelesaian rekonsiliasi diletakkan di kolom TERPISAH
 * (`status_penyelesaian`) — dua pertanyaan yang memang berbeda:
 * "apakah selisihnya ada" dan "apakah selisihnya sudah ditindaklanjuti".
 *
 * `unit_usaha_id` dan `jenis_alokasi` pada `rak_transaksi` NULLABLE:
 * baris RAK lama hanya punya `nama_unit` berupa teks bebas dan tidak
 * dapat dipetakan ke master tanpa menebak. Menebaknya akan menghasilkan
 * relasi yang tampak rapi tetapi salah.
 */
/**
 * MIGRASI v63 — RC-S53: register BAGIAN SHU DARI INVESTASI.
 *
 * Dibuat karena KEPUTUSAN 04-A membutuhkan tempat penyimpanan yang
 * memang BELUM ADA: peristiwa hak atas bagian SHU beserta dokumen
 * buktinya, dan penerimaan kasnya. Bukan migrasi untuk flag policy,
 * bukan migrasi untuk COA — keduanya sudah ditangani mekanisme lain.
 *
 * Hanya CREATE TABLE/INDEX IF NOT EXISTS: idempoten, tidak menyentuh
 * satu baris pun data lama, tidak menulis ulang tabel mana pun,
 * backward-compatible (instalasi lama yang belum punya tabel ini tetap
 * berjalan — tidak ada kode lama yang membacanya).
 *
 * PEMULIHAN BILA TERHENTI DI TENGAH. Blok migrasi di `initDatabase`
 * TIDAK dibungkus satu transaksi global; yang dibungkus transaksi hanya
 * migrasi yang membangun ulang tabel. Migrasi ini tidak membangun ulang
 * apa pun, jadi jaminannya bukan rollback melainkan MAJU-ULANG: setiap
 * pernyataannya idempoten, dan `schema_meta` baru naik setelah seluruh
 * blok selesai — kalau proses mati di tengah, versi belum naik dan
 * menjalankannya lagi melanjutkan tanpa menduplikasi apa pun.
 *
 * Akun `1-1220` dan mapping `BAGIAN_SHU_INVESTASI` TIDAK disisipkan di
 * sini: blok self-heal COA generik di atas sudah menyisipkan akun dan
 * mapping yang belum ada, dan blok itu berjalan pada kenaikan versi ini
 * juga. Menduplikasinya di sini hanya akan membuat dua sumber kebenaran.
 */
/**
 * MIGRASI v64 — RC-S53 corrective: penyusutan properti investasi.
 *
 * POLICY 03 menetapkan MODEL BIAYA, yang berarti nilai tercatat properti
 * investasi harus dikurangi akumulasi penyusutan. Sampai v63 tidak ada
 * satu pun jalur yang menyusutkan akun investasi. Migrasi ini menambah
 * tempat penyimpanannya — BUKAN angkanya.
 *
 * Lima kolom parameter ditambahkan ke `investasi`, SELURUHNYA nullable
 * dan tanpa nilai bawaan. Baris lama tetap terbaca apa adanya dan tidak
 * tiba-tiba ikut disusutkan: service menolak memproses selama parameter
 * belum diisi pengurus. Tidak ada satu pun UPDATE terhadap data lama.
 *
 * Register `investasi_penyusutan` memakai UNIQUE(investasi_id, periode)
 * — identity idempotensi ditegakkan database, bukan hanya aplikasi.
 *
 * Akun `1-1670` dan mapping `PENYUSUTAN_PROPERTI_INVESTASI` tidak
 * disisipkan di sini: blok self-heal COA generik sudah menangani akun
 * dan mapping yang belum ada, dan blok itu berjalan pada kenaikan versi
 * ini juga.
 *
 * Aditif, idempoten, FK-safe, backward-compatible, nol data loss.
 * Jaminan bila terhenti di tengah sama dengan v63: maju-ulang, bukan
 * rollback — lihat catatan di `migrasiV63` di bawah.
 */
/**
 * MIGRASI v65 — RC-S54 item 24 & 25: tujuan pinjaman dan agunan.
 *
 * Dua kolom nullable pada `pinjaman` dan satu tabel anak
 * `pinjaman_agunan`. Pinjaman lama tetap terbaca apa adanya: tujuannya
 * NULL (memang tidak pernah diisi, dan menebaknya berarti mengarang
 * data), dan ketiadaan baris agunan berarti "Tidak Ada" — bukan baris
 * kosong bernilai 0.
 *
 * Aditif dan idempoten: `ADD COLUMN` lewat helper yang memeriksa
 * keberadaan kolom lebih dulu, dan `CREATE TABLE/INDEX IF NOT EXISTS`.
 * Nol UPDATE terhadap baris pinjaman mana pun, nol perubahan pada
 * pencairan, angsuran, restrukturisasi, write-off, maupun impairment.
 *
 * Jaminan bila terhenti di tengah sama dengan v63/v64: maju-ulang,
 * bukan rollback — `schema_meta` baru naik setelah seluruh blok selesai.
 */
/**
 * RC-S55 §9 — AUTOMATIC ACCRUAL BUNGA UTANG (murni aditif).
 *
 * YANG DILAKUKAN:
 *   a. `utang.basis_bunga` + dua kolom jejak audit pengisiannya. ALTER
 *      TABLE ADD COLUMN sengaja TANPA klausa CHECK: SQLite tidak
 *      mengizinkan penambahan constraint lewat ADD COLUMN tanpa rebuild
 *      tabel, dan rebuild `utang` di sini berarti DROP TABLE pada tabel
 *      yang punya anak (`utang_pembayaran`) — risiko yang tidak sebanding
 *      untuk sebuah enum. CHECK-nya tetap ada di CREATE_TABLES_SQL
 *      (instalasi baru), dan penegakan nilainya dilakukan di lapisan
 *      service (`UtangBungaAccrualService`/`UtangService`) untuk SEMUA
 *      instalasi. Ini pola yang sama dengan kolom enum aditif lain
 *      (mis. `aset_tetap.status` v-lama).
 *   b. Tabel subledger `utang_bunga_akrual` — definisi PERSIS sama dengan
 *      schema.ts, termasuk UNIQUE(utang_id, periode, tipe_akrual) dan
 *      UNIQUE(idempotency_key) yang menjadi pertahanan terakhir idempotensi.
 *
 * YANG SENGAJA TIDAK DILAKUKAN (keputusan kebijakan pengguna, RC-S55 §1/§9):
 * TIDAK ada backfill `basis_bunga`, TIDAK ada default 'TAHUNAN' maupun
 * 'BULANAN', TIDAK ada akrual retroaktif, TIDAK ada jurnal yang ditulis
 * atau diubah. Seluruh baris `utang` warisan keluar dari migrasi ini
 * dengan `basis_bunga IS NULL` — dan itulah yang membuatnya berstatus
 * MANUAL_REVIEW_REQUIRED sampai pengurus melengkapinya secara sadar.
 *
 * Idempoten: ADD COLUMN dibungkus try/catch oleh helper, CREATE TABLE/INDEX
 * memakai IF NOT EXISTS.
 */
/**
 * v71 — DUA PENYEBAB SELISIH REKONSILIASI BARU.
 *
 * Menambah `TRANSAKSI_BELUM_TERCATAT` dan `KESALAHAN_BANK` ke CHECK
 * kolom `penyebab`. Tanpa keduanya, dua kejadian lapangan yang paling
 * sering justru tidak punya kategori: transaksi koperasi yang belum
 * dicatat, dan bank yang salah mendebit. Keduanya terpaksa disimpan
 * sebagai `LAINNYA` + catatan bebas — penyebabnya hilang dari audit
 * trail, padahal tindak lanjutnya berlawanan (catat transaksi sendiri
 * vs hubungi bank).
 *
 * SQLite tidak dapat mengubah CHECK lewat ALTER, jadi tabelnya
 * di-rebuild mengikuti pola migrasi existing (CREATE _new -> INSERT
 * SELECT -> DROP -> RENAME -> recreate index).
 *
 * SELURUH baris dan SELURUH kolom disalin apa adanya, termasuk `id`,
 * `journal_id`, dan `diselesaikan_*` — histori rekonsiliasi adalah
 * bukti pemeriksaan, bukan data yang boleh disusun ulang. Tidak ada
 * nilai yang ditulis ulang atau ditebak.
 *
 * Idempoten: dijaga `IF NOT EXISTS` + pemeriksaan keberadaan tabel,
 * dan dijalankan di dalam `withMigrationTransaction` yang sama dengan
 * migrasi rebuild lain (FK dimatikan sementara oleh mekanisme itu,
 * lalu dinyalakan kembali dan diverifikasi `foreign_key_check`).
 */
/**
 * v72 — PENARIKAN DANA INVESTASI (sebagian/terakhir) & JATUH TEMPO DEPOSITO.
 *
 * PURELY ADDITIVE & IDEMPOTEN: satu kolom nullable baru pada `investasi`
 * (ADD COLUMN dibungkus `tambahKolom`), satu tabel baru + indeks
 * (`IF NOT EXISTS`). Tidak ada baris lama yang diubah atau dihapus.
 */
export async function migrasiV72(
  db: SQLite.SQLiteDatabase,
  tambahKolom: (tabel: string, kolom: string, tipe: string) => Promise<void>
): Promise<void> {
  await tambahKolom('investasi', 'tanggal_jatuh_tempo', 'TEXT');
  await db.execAsync(`
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
  `);
}

/**
 * v73 (RC-S88) — PENYESUAIAN NILAI WAJAR DAPAT DIPOSTING + REVALUASI ASET TETAP.
 *
 * SQLite tidak dapat mengubah CHECK/NOT NULL lewat ALTER, jadi
 * `penyesuaian_nilai_wajar` di-rebuild (pola v71): `investasi_id` menjadi
 * nullable, kolom baru `objek`, `aset_tetap_id`, `penilai`,
 * `jumlah_laba_rugi`, `jumlah_oci`, `journal_id`, `diposting_oleh`,
 * `diposting_at`, dan status `DIPOSTING`.
 *
 * SELURUH baris lama disalin apa adanya sebagai objek PROPERTI_INVESTASI
 * dengan status semula (DRAFT/DIBATALKAN) — sebelum v73 posting memang
 * dinonaktifkan, jadi tidak ada baris yang pernah terposting dan tidak
 * ada nilai yang ditebak. Akun & mapping baru masuk lewat self-heal COA.
 *
 * Idempoten: dilewati bila tabel sudah memiliki kolom `objek`.
 */
export async function migrasiV73(db: SQLite.SQLiteDatabase): Promise<void> {
  const ada = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='penyesuaian_nilai_wajar'`
  );
  if (!ada) return;
  const kolom = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(penyesuaian_nilai_wajar)`);
  if (kolom.some((k) => k.name === 'objek')) return;

  await db.withTransactionAsync(async () => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS penyesuaian_nilai_wajar_new (
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
    `);
    await db.execAsync(`
      INSERT INTO penyesuaian_nilai_wajar_new
        (id, objek, investasi_id, aset_tetap_id, tanggal, nilai_tercatat_sebelum, nilai_wajar, selisih,
         arah_perubahan, dasar_penilaian, referensi_bukti, catatan, status, created_by, created_at, updated_at)
      SELECT id, 'PROPERTI_INVESTASI', investasi_id, NULL, tanggal, nilai_tercatat_sebelum, nilai_wajar, selisih,
             arah_perubahan, dasar_penilaian, referensi_bukti, catatan, status, created_by, created_at, updated_at
        FROM penyesuaian_nilai_wajar;
    `);
    await db.execAsync(`DROP TABLE penyesuaian_nilai_wajar;`);
    await db.execAsync(`ALTER TABLE penyesuaian_nilai_wajar_new RENAME TO penyesuaian_nilai_wajar;`);
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_nilai_wajar_investasi ON penyesuaian_nilai_wajar(investasi_id);
      CREATE INDEX IF NOT EXISTS idx_nilai_wajar_aset ON penyesuaian_nilai_wajar(aset_tetap_id);
      CREATE INDEX IF NOT EXISTS idx_nilai_wajar_status ON penyesuaian_nilai_wajar(status);
    `);
  });
}

export async function migrasiV71(db: SQLite.SQLiteDatabase): Promise<void> {
  const ada = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='rekonsiliasi_kas_bank'`
  );
  if (!ada) return; // instalasi baru sudah memakai CHECK v71 dari CREATE_TABLES_SQL

  // Dibungkus transaksi seperti rebuild v3/v4/v11: kalau terhenti di
  // tengah, tidak boleh menyisakan tabel setengah jadi.
  await db.withTransactionAsync(async () => {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS rekonsiliasi_kas_bank_new (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES account(id),
      nama_rekening TEXT NOT NULL,
      tanggal TEXT NOT NULL,
      saldo_buku INTEGER NOT NULL,
      saldo_fisik INTEGER NOT NULL,
      selisih INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('COCOK','SELISIH')),
      status_penyelesaian TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status_penyelesaian IN ('DRAFT','SELESAI')),
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
  `);
  await db.execAsync(`
    INSERT INTO rekonsiliasi_kas_bank_new
      (id, account_id, nama_rekening, tanggal, saldo_buku, saldo_fisik, selisih, status,
       status_penyelesaian, penyebab, perlakuan, journal_id, diselesaikan_oleh,
       diselesaikan_at, keterangan, created_by, created_at)
    SELECT id, account_id, nama_rekening, tanggal, saldo_buku, saldo_fisik, selisih, status,
           status_penyelesaian, penyebab, perlakuan, journal_id, diselesaikan_oleh,
           diselesaikan_at, keterangan, created_by, created_at
      FROM rekonsiliasi_kas_bank;
  `);
  await db.execAsync(`DROP TABLE rekonsiliasi_kas_bank;`);
  await db.execAsync(`ALTER TABLE rekonsiliasi_kas_bank_new RENAME TO rekonsiliasi_kas_bank;`);
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_rekonsiliasi_account ON rekonsiliasi_kas_bank(account_id);
    CREATE INDEX IF NOT EXISTS idx_rekonsiliasi_penyelesaian ON rekonsiliasi_kas_bank(status_penyelesaian);
  `);
  });
}

/**
 * v70 — ASAL PERSONEL (anggota koperasi vs pihak luar).
 *
 * PURELY ADDITIVE: dua kolom baru pada `koperasi_personel`, tidak ada
 * tabel di-DROP, tidak ada baris dihapus, tidak ada `id` yang berubah.
 * `personel_id` pada transaksi existing (mis. Imbalan Kerja) tetap
 * menunjuk baris yang sama.
 *
 * BARIS LAMA menjadi `sumber_data = 'LUAR'`, `anggota_id = NULL`.
 * Itu BUKAN klaim bahwa mereka benar-benar orang luar — melainkan
 * satu-satunya pernyataan yang jujur: schema sebelum v70 tidak pernah
 * menyimpan hubungan ke anggota, jadi hubungan itu tidak diketahui.
 * Mencocokkan otomatis berdasarkan nama/NIK/telepon SENGAJA TIDAK
 * dilakukan — kemiripan bukan bukti identitas, dan salah tautan pada
 * data jabatan jauh lebih merugikan daripada NULL yang jujur.
 * Pengguna dapat menautkannya secara eksplisit lewat form Personel.
 *
 * Idempoten: `ALTER TABLE ... ADD COLUMN` dibungkus `tambahKolom`
 * (menelan error "duplicate column"), `CREATE INDEX IF NOT EXISTS`,
 * dan `UPDATE` hanya menyentuh baris yang nilainya masih NULL.
 *
 * CATATAN CHECK CONSTRAINT: `ADD COLUMN` di SQLite tidak dapat
 * membawa CHECK, jadi batasan `('ANGGOTA','LUAR')` pada database yang
 * di-UPGRADE hanya ditegakkan di layer service
 * (`validasiPersonel`). Instalasi BARU mendapatkannya dari
 * `CREATE_TABLES_SQL`. Rebuild tabel sengaja dihindari: menyalin ulang
 * `koperasi_personel` berarti menyentuh baris yang direferensikan
 * `personel_id` transaksi historis, risiko yang tidak sebanding dengan
 * manfaat satu CHECK constraint.
 */
export async function migrasiV70(
  db: SQLite.SQLiteDatabase,
  tambahKolom: (tabel: string, kolom: string, tipe: string) => Promise<void>
): Promise<void> {
  await tambahKolom('koperasi_personel', 'sumber_data', "TEXT NOT NULL DEFAULT 'LUAR'");
  await tambahKolom('koperasi_personel', 'anggota_id', 'TEXT REFERENCES anggota(id)');

  // Jaring pengaman untuk database yang kolomnya sempat dibuat nullable
  // oleh jalur lain: isi hanya yang masih kosong, jangan timpa nilai
  // yang sudah ditentukan pengguna.
  await db.runAsync(
    `UPDATE koperasi_personel SET sumber_data = 'LUAR' WHERE sumber_data IS NULL OR TRIM(sumber_data) = ''`
  );

  await db.execAsync(
    `CREATE INDEX IF NOT EXISTS idx_personel_anggota ON koperasi_personel(anggota_id);`
  );
}

export async function migrasiV69(
  db: SQLite.SQLiteDatabase,
  tambahKolom: (tabel: string, kolom: string, tipe: string) => Promise<void>
): Promise<void> {
  await tambahKolom('utang', 'basis_bunga', 'TEXT');
  await tambahKolom('utang', 'basis_bunga_diisi_oleh', 'TEXT');
  await tambahKolom('utang', 'basis_bunga_diisi_pada', 'TEXT');

  await db.execAsync(`
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
  `);
}

export async function migrasiV65(
  db: SQLite.SQLiteDatabase,
  tambahKolom: (tabel: string, kolom: string, tipe: string) => Promise<void>
): Promise<void> {
  await tambahKolom('pinjaman', 'tujuan_pinjaman', 'TEXT');
  await tambahKolom('pinjaman', 'tujuan_detail', 'TEXT');

  await db.execAsync(`
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
  `);
}

export async function migrasiV64(
  db: SQLite.SQLiteDatabase,
  tambahKolom: (tabel: string, kolom: string, tipe: string) => Promise<void>
): Promise<void> {
  await tambahKolom('investasi', 'jenis_objek_properti', 'TEXT');
  await tambahKolom('investasi', 'nilai_dapat_disusutkan', 'INTEGER');
  await tambahKolom('investasi', 'nilai_residu_properti', 'INTEGER');
  await tambahKolom('investasi', 'masa_manfaat_bulan_properti', 'INTEGER');
  await tambahKolom('investasi', 'tanggal_mulai_penyusutan', 'TEXT');

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS investasi_penyusutan (
      id TEXT PRIMARY KEY,
      investasi_id TEXT NOT NULL REFERENCES investasi(id),
      periode TEXT NOT NULL,
      tanggal TEXT NOT NULL,
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
  `);
}

export async function migrasiV63(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS investasi_bagian_shu (
      id TEXT PRIMARY KEY,
      investasi_id TEXT NOT NULL REFERENCES investasi(id),
      jenis_hasil TEXT NOT NULL DEFAULT 'BAGIAN_SHU' CHECK (jenis_hasil IN ('BAGIAN_SHU')),
      tanggal_hak TEXT NOT NULL,
      jumlah INTEGER NOT NULL CHECK (jumlah > 0),
      jenis_dokumen TEXT NOT NULL,
      nomor_dokumen TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_bagian_shu_penerimaan_tanggal
      ON investasi_bagian_shu_penerimaan(tanggal);
  `);
}

export async function migrasiV62(
  db: SQLite.SQLiteDatabase,
  tambahKolom: (tabel: string, kolom: string, tipe: string) => Promise<void>
): Promise<void> {
  await tambahKolom('rak_transaksi', 'unit_usaha_id', 'TEXT REFERENCES koperasi_unit_usaha(id)');
  await tambahKolom('rak_transaksi', 'jenis_alokasi', 'TEXT');

  await tambahKolom(
    'rekonsiliasi_kas_bank',
    'status_penyelesaian',
    "TEXT NOT NULL DEFAULT 'DRAFT'"
  );
  await tambahKolom('rekonsiliasi_kas_bank', 'penyebab', 'TEXT');
  await tambahKolom('rekonsiliasi_kas_bank', 'perlakuan', 'TEXT');
  await tambahKolom('rekonsiliasi_kas_bank', 'journal_id', 'TEXT REFERENCES journal(id)');
  await tambahKolom('rekonsiliasi_kas_bank', 'diselesaikan_oleh', 'TEXT');
  await tambahKolom('rekonsiliasi_kas_bank', 'diselesaikan_at', 'TEXT');

  // Baris rekonsiliasi lama yang saldonya COCOK memang tidak punya
  // selisih untuk ditindaklanjuti — ditandai SELESAI supaya tidak
  // muncul sebagai pekerjaan tertunda yang tidak pernah ada.
  await db.runAsync(
    `UPDATE rekonsiliasi_kas_bank
        SET status_penyelesaian = 'SELESAI'
      WHERE status = 'COCOK' AND status_penyelesaian = 'DRAFT'`
  );

  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_rekonsiliasi_penyelesaian
      ON rekonsiliasi_kas_bank(status_penyelesaian);

    CREATE TABLE IF NOT EXISTS penyesuaian_nilai_wajar (
      id TEXT PRIMARY KEY,
      investasi_id TEXT NOT NULL REFERENCES investasi(id),
      tanggal TEXT NOT NULL,
      nilai_tercatat_sebelum INTEGER NOT NULL,
      nilai_wajar INTEGER NOT NULL,
      selisih INTEGER NOT NULL,
      arah_perubahan TEXT NOT NULL CHECK (arah_perubahan IN ('KENAIKAN','PENURUNAN','TIDAK_BERUBAH')),
      dasar_penilaian TEXT,
      referensi_bukti TEXT,
      catatan TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','DIBATALKAN')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nilai_wajar_investasi ON penyesuaian_nilai_wajar(investasi_id);
    CREATE INDEX IF NOT EXISTS idx_nilai_wajar_status ON penyesuaian_nilai_wajar(status);
  `);
}

export async function withTransaction<T>(
  fn: (db: SQLite.SQLiteDatabase) => Promise<T>
): Promise<T> {
  const db = await getDb();
  let result: T;
  let caughtError: unknown = null;
  try {
    await db.withTransactionAsync(async () => {
      result = await fn(db);
    });
  } catch (err) {
    caughtError = err;
  }
  if (caughtError) throw caughtError;
  // @ts-expect-error assigned inside callback
  return result;
}

/**
 * v74 (RC-S100) — RIWAYAT IMPORT DATA AWAL.
 *
 * Menambahkan dua tabel BARU: `import_data_awal_riwayat` (satu baris per
 * sekali import) dan `import_data_awal_log` (satu baris per baris Excel
 * yang diproses, berhasil maupun gagal). Lihat komentar bagian 40 di
 * schema.ts untuk alasannya.
 *
 * ADITIF MURNI & IDEMPOTEN: hanya `CREATE TABLE IF NOT EXISTS` —
 * tidak ada DDL pada tabel lama, tidak ada kolom yang berubah, tidak ada
 * baris yang ditulis ulang, dan tidak ada nilai yang ditebak. Instalasi
 * lama hanya mendapat dua tabel kosong; riwayat mulai terisi dari import
 * berikutnya (import yang sudah terjadi sebelum versi ini memang tidak
 * pernah dicatat, dan TIDAK direkonstruksi — mengarang riwayat lebih
 * buruk daripada tidak punya riwayat).
 *
 * DDL-nya diambil dari `CREATE_TABLES_SQL` yang sama dengan instalasi
 * baru, bukan disalin ulang di sini, supaya bentuk tabel pada instalasi
 * lama dan baru mustahil divergen.
 */
/**
 * RC-S114 — VERSI ALGORITMA HASH PIN.
 *
 * Menambahkan `app_user.pin_hash_versi`. Baris yang sudah ada mendapat
 * nilai 1 (SHA-256 satu putaran) karena memang itulah yang dipakai
 * membuat hash mereka — BUKAN 2, meskipun 2 yang dipakai sejak
 * sekarang. Menandai hash lama sebagai v2 akan membuat seluruh PIN yang
 * ada gagal diverifikasi dan mengunci pengurus di luar aplikasinya
 * sendiri.
 *
 * Kenaikan ke v2 terjadi di AuthService, pada login berikutnya yang
 * berhasil — saat PIN-nya memang sedang ada di tangan sehingga tidak
 * perlu ditanyakan ulang.
 *
 * Idempoten: ADD COLUMN dibungkus try/catch seperti blok migrasi lain
 * di berkas ini, karena migrasi bisa diulang bila blok setelahnya
 * gagal.
 */
/**
 * RC-S117 — PASSWORD MASUK DIPISAH DARI PIN KUNCI APLIKASI.
 *
 * Sampai RC-S116, PIN 6 digit merangkap kredensial masuk DAN kunci
 * layar aplikasi. Sejak sekarang keduanya berdiri sendiri.
 *
 * ============================================================
 * KENAPA NILAI LAMA DISALIN, BUKAN DIKOSONGKAN
 * ============================================================
 * Pengurus yang sudah memakai aplikasi ini tidak punya password —
 * yang mereka punya hanya PIN. Mengosongkan kolom password berarti
 * SELURUH pengurus terkunci di luar aplikasinya sendiri pada pembaruan
 * berikutnya, tanpa jalan masuk untuk memperbaikinya (admin pun ikut
 * terkunci). Karena itu hash PIN yang ada disalin apa adanya menjadi
 * password awal: apa yang selama ini mereka ketik sebagai PIN tetap
 * bekerja sebagai password, sampai mereka menggantinya.
 *
 * Konsekuensinya diakui terus terang: password awal itu masih 6 digit
 * dan TIDAK memenuhi kebijakan password baru. Kebijakan itu berlaku
 * untuk password yang DITETAPKAN mulai sekarang; yang lama dibiarkan
 * bekerja supaya tidak ada yang terkunci, dan layar Manajemen User
 * menandainya supaya admin tahu mana yang masih perlu diganti.
 *
 * Idempoten: ADD COLUMN dibungkus try/catch, dan penyalinannya dibatasi
 * pada baris yang password-nya masih kosong.
 */
/**
 * v77 — dua perubahan ADITIF/KLASIFIKASI, tanpa rebuild tabel:
 *
 *  1. Poin 5 — kolom `unit_usaha_id` (nullable, FK ke master
 *     `koperasi_unit_usaha`) pada `kas_transaksi` & `bank_transaksi`.
 *     Dibuktikan perlu: kedua tabel itu sebelumnya tidak punya tempat
 *     menyimpan unit usaha, sehingga transaksi Pendapatan Unit Usaha
 *     tidak dapat ditelusuri ke unitnya. Baris lama tetap NULL — tidak
 *     ada pemetaan tebakan dari teks keterangan.
 *  2. Poin 6 — klasifikasi LHU akun 4-1500 menjadi PENDAPATAN_USAHA_LAIN.
 *     (Poin 10 — nama tampilan akun 1-1800 menjadi "Rekening Antar
 *     Kantor/Unit (RAKU)" bila masih nama bawaan; lihat di bawah.)
 *     HANYA bila masih bernilai bawaan lama (HASIL_INVESTASI); klasifikasi
 *     yang sudah diubah sendiri oleh admin tidak ditimpa. Jurnal, saldo,
 *     kode, dan nama akun TIDAK disentuh.
 *
 * Idempoten: ADD COLUMN dibungkus helper, UPDATE bersyarat.
 */
export async function migrasiV77(
  db: SQLite.SQLiteDatabase,
  tambahKolom: (tabel: string, kolom: string, tipe: string) => Promise<void>
): Promise<void> {
  await tambahKolom('kas_transaksi', 'unit_usaha_id', 'TEXT REFERENCES koperasi_unit_usaha(id)');
  await tambahKolom('bank_transaksi', 'unit_usaha_id', 'TEXT REFERENCES koperasi_unit_usaha(id)');
  const akun = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account'`
  );
  if (!akun) return;
  await db.runAsync(
    `UPDATE account SET lhu_klasifikasi = 'PENDAPATAN_USAHA_LAIN', updated_at = ?
      WHERE kode = '4-1500' AND lhu_klasifikasi = 'HASIL_INVESTASI'`,
    new Date().toISOString()
  );
  // Poin 10 — label tampilan akun 1-1800 menjadi "Rekening Antar
  // Kantor/Unit (RAKU)" HANYA bila namanya masih nama bawaan lama
  // (nama yang sudah diubah admin tidak ditimpa). Kode, saldo, jurnal,
  // dan mapping RAK tidak disentuh.
  await db.runAsync(
    `UPDATE account SET nama = 'Rekening Antar Kantor/Unit (RAKU)', updated_at = ?
      WHERE kode = '1-1800' AND nama IN ('Rekening Antar Kantor (RAK)', 'Rekening Antar Kantor')`,
    new Date().toISOString()
  );
}

/**
 * v78 — Bunga Harian Simpanan Sukarela & kebijakan basis jasa modal SHU.
 * ADITIF, tanpa rebuild dan tanpa mengubah data historis:
 *  1. Tabel baru bunga_sukarela_* dan kebijakan_basis_jasa_modal.
 *     Kebijakan bunga TIDAK ditulis -> fitur OFF (perilaku identik).
 *  2. Kolom snapshot shu_konfigurasi.sukarela_basis_jasa_modal. Baris SHU
 *     yang SUDAH PERNAH DIHITUNG/DIPROSES diisi 1 — persis cara aplikasi
 *     sebelum v78 menghitung basis jasa modal (pokok + wajib + sukarela) —
 *     sehingga hitung ulang tahun buku itu menghasilkan angka yang sama.
 *     Baris DRAFT yang belum pernah dihitung tetap NULL (lihat query).
 *  3. Kebijakan basis jasa modal instalasi lama: satu versi (berlaku sejak
 *     awal, sukarela ikut). Perubahan ke OFF hanya berlaku ke depan lewat
 *     versi baru. Instalasi baru (tanpa migrasi) tidak punya baris -> OFF.
 * Idempoten: CREATE IF NOT EXISTS, ADD COLUMN lewat helper, INSERT bersyarat.
 * Akun 5-1956 & pemetaannya disiapkan blok self-heal COA (berjalan di
 * setiap kenaikan versi).
 */
export async function migrasiV78(
  db: SQLite.SQLiteDatabase,
  tambahKolom: (tabel: string, kolom: string, tipe: string) => Promise<void>
): Promise<void> {
  const ddl = CREATE_TABLES_SQL.slice(CREATE_TABLES_SQL.indexOf('-- v78 — BUNGA HARIAN SIMPANAN SUKARELA'));
  await db.execAsync(ddl);
  await tambahKolom('shu_konfigurasi', 'sukarela_basis_jasa_modal', 'INTEGER');
  // HOTFIX snapshot DRAFT: hanya tahun buku yang SUDAH PERNAH DIHITUNG/
  // DIPROSES dengan mekanisme lama yang dikunci ON (cara hitung pra-v78:
  // pokok + wajib + sukarela). Tahun buku yang masih DRAFT dan belum pernah
  // dihitung dibiarkan NULL = "belum ditentukan": snapshot dibuat saat SHU
  // tahun itu PERTAMA kali dihitung (tentukanSnapshotBasisJasaModal),
  // memakai kebijakan yang berlaku saat itu.
  //
  // Bukti "sudah pernah dihitung" (salah satu cukup):
  //   - status selain DRAFT (DIHITUNG/DIAJUKAN_RAT/DISAHKAN_RAT/DIBAGIKAN);
  //   - total_shu atau shu_anggota masih ada;
  //   - shu_informasi_rat / shu_diajukan_rat / shu_disahkan_rat / journal_id
  //     terisi. Kolom-kolom ini TIDAK dikosongkan saat konfigurasi disimpan
  //     ulang (simpanKonfigurasiShu mengembalikan status ke DRAFT dan
  //     menghapus total_shu & shu_anggota), sehingga tahun yang pernah
  //     dihitung lalu disimpan ulang tetap terdeteksi.
  await db.runAsync(
    `UPDATE shu_konfigurasi SET sukarela_basis_jasa_modal = 1
      WHERE sukarela_basis_jasa_modal IS NULL
        AND (status <> 'DRAFT'
             OR total_shu IS NOT NULL
             OR shu_informasi_rat IS NOT NULL
             OR shu_diajukan_rat IS NOT NULL
             OR shu_disahkan_rat IS NOT NULL
             OR journal_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM shu_anggota sa WHERE sa.shu_konfigurasi_id = shu_konfigurasi.id))`
  );
  const ada = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM kebijakan_basis_jasa_modal`);
  if (!ada || ada.n === 0) {
    await db.runAsync(
      `INSERT INTO kebijakan_basis_jasa_modal (id, berlaku_mulai_tahun, sukarela_ikut, created_by, created_at)
       VALUES (?, 0, 1, 'MIGRASI_V78', ?)`,
      newId(),
      new Date().toISOString()
    );
  }
}

/**
 * RC-S132 — v80: tautan user ber-role ANGGOTA ke data anggota.
 *
 * Aditif & idempoten: kolom `app_user.anggota_id` (nullable, REFERENCES
 * anggota) ditambah hanya bila belum ada (PRAGMA table_info, tanpa
 * try/catch supaya kegagalan DDL sungguhan gagal keras), lalu indeks unik
 * parsial — satu anggota paling banyak ditautkan ke satu user. Tidak ada
 * data yang diubah: user ANGGOTA lama tetap tanpa tautan sampai Admin
 * memilihkan anggotanya di User Management.
 */
export async function migrasiV80(db: SQLite.SQLiteDatabase): Promise<void> {
  const tabel = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_user'`
  );
  if (!tabel) return;
  const kolom = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(app_user)`);
  if (!kolom.some((k) => k.name === 'anggota_id')) {
    await db.execAsync(`ALTER TABLE app_user ADD COLUMN anggota_id TEXT REFERENCES anggota(id);`);
  }
  await db.execAsync(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_anggota ON app_user(anggota_id) WHERE anggota_id IS NOT NULL;`
  );
}

/**
 * v79 (RC-S128) — Kebijakan produk Simpanan Berjangka & bunga pasca jatuh tempo.
 * ADITIF, idempoten, tanpa rebuild dan tanpa mengubah angka historis:
 *  1. Kolom snapshot kebijakan pada `simpanan_berjangka`. Kontrak yang
 *     sudah ada otomatis berstatus LEGACY_POLICY_REVIEW_REQUIRED (DEFAULT
 *     kolom) — TIDAK diberi rate pasca jatuh tempo karangan dan TIDAK
 *     di-backfill bunga apa pun.
 *  2. Kolom `jenis_periode` (DEFAULT 'KONTRAK') & `rate_persen` pada
 *     `simpanan_berjangka_bunga`. Baris lama = periode kontrak.
 *     `rate_persen` baris lama diisi dari `suku_bunga` kontraknya —
 *     itulah satu-satunya rate yang pernah dipakai baris tersebut.
 *  3. Tabel kebijakan produk & penerapan kebijakan (KOSONG — kebijakan
 *     hanya boleh berasal dari keputusan koperasi), plus trigger
 *     append-only dan penjaga snapshot/pokok.
 * ADD COLUMN diperiksa lewat PRAGMA table_info lalu dijalankan TANPA
 * try/catch: kegagalan DDL yang sungguhan harus gagal keras, bukan
 * tertelan seperti kolom yang sudah ada.
 */
export async function migrasiV79(db: SQLite.SQLiteDatabase): Promise<void> {
  const tabelKontrak = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'simpanan_berjangka'`
  );
  if (!tabelKontrak) return;
  const tambah = async (tabel: string, kolom: string, tipe: string) => {
    const kolomAda = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${tabel})`);
    if (kolomAda.some((k) => k.name === kolom)) return;
    await db.execAsync(`ALTER TABLE ${tabel} ADD COLUMN ${kolom} ${tipe};`);
  };
  // Tabel kebijakan dibuat lebih dulu (kolom policy_id mereferensikannya).
  const awal = CREATE_TABLES_SQL.indexOf('-- v79 — KEBIJAKAN PRODUK SIMPANAN BERJANGKA');
  const akhir = CREATE_TABLES_SQL.indexOf('-- akhir v79');
  if (awal === -1 || akhir === -1) throw new Error('[migrasi v79] blok DDL kebijakan produk tidak ditemukan.');
  const blok = CREATE_TABLES_SQL.slice(awal, akhir);
  const pisah = blok.indexOf('-- Snapshot kebijakan pada kontrak tidak boleh berubah');
  await db.execAsync(blok.slice(0, pisah));

  await tambah('simpanan_berjangka', 'policy_id', 'TEXT REFERENCES simpanan_berjangka_kebijakan_produk(id)');
  await tambah('simpanan_berjangka', 'policy_versi', 'TEXT');
  await tambah('simpanan_berjangka', 'policy_auto_renewal', 'INTEGER CHECK (policy_auto_renewal IS NULL OR policy_auto_renewal IN (0,1))');
  await tambah('simpanan_berjangka', 'policy_bunga_pasca_aktif', 'INTEGER CHECK (policy_bunga_pasca_aktif IS NULL OR policy_bunga_pasca_aktif IN (0,1))');
  await tambah('simpanan_berjangka', 'policy_rate_pasca_jatuh_tempo', 'REAL CHECK (policy_rate_pasca_jatuh_tempo IS NULL OR policy_rate_pasca_jatuh_tempo >= 0)');
  await tambah('simpanan_berjangka', 'policy_basis_rate', 'TEXT');
  await tambah('simpanan_berjangka', 'policy_metode_periode', 'TEXT');
  await tambah('simpanan_berjangka', 'policy_bunga_dikreditkan_ke', 'TEXT');
  await tambah('simpanan_berjangka', 'policy_kapitalisasi_bunga', 'INTEGER CHECK (policy_kapitalisasi_bunga IS NULL OR policy_kapitalisasi_bunga IN (0,1))');
  await tambah('simpanan_berjangka', 'policy_pokok_tetap', 'INTEGER CHECK (policy_pokok_tetap IS NULL OR policy_pokok_tetap IN (0,1))');
  await tambah('simpanan_berjangka', 'policy_pasca_mulai_efektif', 'TEXT');
  await tambah(
    'simpanan_berjangka',
    'status_policy',
    `TEXT NOT NULL DEFAULT 'LEGACY_POLICY_REVIEW_REQUIRED' CHECK (status_policy IN ('POLICY_SNAPSHOT','LEGACY_POLICY_REVIEW_REQUIRED','LEGACY_POLICY_DITERAPKAN'))`
  );

  const tabelBunga = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'simpanan_berjangka_bunga'`
  );
  if (tabelBunga) {
    await tambah(
      'simpanan_berjangka_bunga',
      'jenis_periode',
      `TEXT NOT NULL DEFAULT 'KONTRAK' CHECK (jenis_periode IN ('KONTRAK','PASCA_JATUH_TEMPO'))`
    );
    await tambah('simpanan_berjangka_bunga', 'rate_persen', 'REAL');
    await db.runAsync(
      `UPDATE simpanan_berjangka_bunga
          SET rate_persen = (SELECT sb.suku_bunga FROM simpanan_berjangka sb WHERE sb.id = simpanan_berjangka_bunga.simpanan_berjangka_id)
        WHERE rate_persen IS NULL AND jenis_periode = 'KONTRAK'`
    );
  }
  // Trigger penjaga snapshot & pokok — sesudah kolomnya ada.
  await db.execAsync(blok.slice(pisah));
}

export async function migrasiV76(db: SQLite.SQLiteDatabase): Promise<void> {
  // Sebagian jalur upgrade dari versi sangat lama (dan fixture migrasi
  // di suite test) berjalan pada database yang belum punya `app_user`.
  // Ketiadaannya BUKAN kesalahan — tidak ada baris untuk dimigrasikan.
  // Diperiksa secara tegas, bukan dengan membungkus UPDATE dalam
  // try/catch kosong: menelan kesalahan UPDATE akan ikut menelan
  // kegagalan nyata pada database yang tabelnya memang ada.
  const tabel = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_user'`
  );
  if (!tabel) return;

  for (const ddl of [
    'ALTER TABLE app_user ADD COLUMN password_hash TEXT',
    'ALTER TABLE app_user ADD COLUMN password_salt TEXT',
    'ALTER TABLE app_user ADD COLUMN password_hash_versi INTEGER NOT NULL DEFAULT 2',
  ]) {
    try {
      await db.execAsync(ddl);
    } catch {
      // Kolom sudah ada (migrasi diulang) — bukan kondisi kesalahan.
    }
  }

  await db.runAsync(
    `UPDATE app_user
        SET password_hash = pin_hash,
            password_salt = pin_salt,
            password_hash_versi = pin_hash_versi
      WHERE password_hash IS NULL OR password_hash = ''`
  );
}

export async function migrasiV75(db: SQLite.SQLiteDatabase): Promise<void> {
  try {
    await db.execAsync('ALTER TABLE app_user ADD COLUMN pin_hash_versi INTEGER NOT NULL DEFAULT 1');
  } catch {
    // Kolom sudah ada (migrasi diulang) — bukan kondisi kesalahan.
  }
}

/**
 * RC-S133.6.2 — salinan pengaman database sebelum migrasi versi.
 *
 * Mengembalikan path salinan, atau null bila database tidak berbasis berkas
 * (in-memory/temp). Melempar galat yang jelas bila salinan gagal dibuat —
 * pemanggil (runMigrations) TIDAK melanjutkan migrasi.
 */
export async function cadangkanSebelumMigrasi(
  db: SQLite.SQLiteDatabase,
  dariVersi: number,
  keVersi: number
): Promise<string | null> {
  let berkas = '';
  try {
    const daftar = await db.getAllAsync<{ name: string; file: string | null }>('PRAGMA database_list');
    berkas = String(daftar.find((d) => d.name === 'main')?.file ?? '');
  } catch {
    berkas = '';
  }
  if (!berkas || berkas === ':memory:') return null;
  const target = namaSalinanPraMigrasi(berkas, dariVersi, keVersi, new Date());
  try {
    await db.execAsync(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (e) {
    throw new Error(
      `Pembaruan database v${dariVersi} ke v${keVersi} dihentikan: salinan pengaman sebelum migrasi tidak dapat dibuat ` +
        `(${e instanceof Error ? e.message : String(e)}). Data tidak diubah. Pastikan ruang penyimpanan cukup lalu buka aplikasi lagi.`
    );
  }
  return target;
}

/** Nama berkas salinan pra-migrasi, di folder yang sama dengan database. Murni — diuji langsung. */
export function namaSalinanPraMigrasi(berkasDb: string, dariVersi: number, keVersi: number, waktu: Date): string {
  const potong = Math.max(berkasDb.lastIndexOf('/'), berkasDb.lastIndexOf('\\'));
  const folder = potong >= 0 ? berkasDb.slice(0, potong + 1) : '';
  const stempel = waktu.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${folder}pra-migrasi-v${dariVersi}-ke-v${keVersi}-${stempel}.db`;
}

/**
 * v81 (RC-S133.6.2) — sidik isi baris import data awal & jejak koreksi
 * transaksi. ADITIF MURNI & IDEMPOTEN:
 *  1. Tabel BARU import_data_awal_sidik dan koreksi_transaksi (DDL diambil
 *     dari CREATE_TABLES_SQL — satu sumber untuk instalasi baru & upgrade),
 *     beserta indeksnya (termasuk indeks UNIQUE, yang tidak dipotong oleh
 *     potongDdlTabel).
 *  2. Kolom riwayat sidik_berkas (NULL) dan total_dilewati (DEFAULT 0).
 * Tidak ada baris lama yang diubah; sidik TIDAK direkonstruksi untuk import
 * sebelum v81 (pratinjau memakai pemeriksaan kemiripan anggota untuk itu).
 */
export async function migrasiV81(
  db: SQLite.SQLiteDatabase,
  tambahKolom: (tabel: string, kolom: string, tipe: string) => Promise<void>
): Promise<void> {
  await db.execAsync(potongDdlTabel(CREATE_TABLES_SQL, ['import_data_awal_sidik', 'koreksi_transaksi']));
  for (const baris of CREATE_TABLES_SQL.split('\n')) {
    const t = baris.trim();
    if (t.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS') && / ON (import_data_awal_sidik|koreksi_transaksi)\(/.test(t)) {
      await db.execAsync(t);
    }
  }
  const riwayat = await db.getFirstAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'import_data_awal_riwayat'`
  );
  if (riwayat) {
    await tambahKolom('import_data_awal_riwayat', 'sidik_berkas', 'TEXT');
    await tambahKolom('import_data_awal_riwayat', 'total_dilewati', 'INTEGER NOT NULL DEFAULT 0');
  }
}

/**
 * v82 (RC-S133.6.4) — pencatatan penyelesaian pinjaman ke Pengadilan Negeri /
 * klaim asuransi (kriteria Macet angka 3 SOM 12.1). ADITIF MURNI & IDEMPOTEN:
 * enam kolom `penyelesaian_*` pada `pinjaman`, semuanya NULL. Tidak ada baris
 * yang diubah, tidak ada tabel dibangun ulang, tidak ada jurnal. Salinan
 * database dibuat lebih dulu oleh `cadangkanSebelumMigrasi`.
 */
export const KOLOM_PENYELESAIAN_V82: readonly { nama: string; tipe: string }[] = [
  { nama: 'penyelesaian_jalur', tipe: "TEXT CHECK (penyelesaian_jalur IN ('PENGADILAN','ASURANSI'))" },
  { nama: 'penyelesaian_tanggal', tipe: 'TEXT' },
  { nama: 'penyelesaian_nomor', tipe: 'TEXT' },
  { nama: 'penyelesaian_dokumen', tipe: 'TEXT' },
  { nama: 'penyelesaian_alasan', tipe: 'TEXT' },
  { nama: 'penyelesaian_oleh', tipe: 'TEXT' },
];

export async function migrasiV82(
  db: SQLite.SQLiteDatabase,
  tambahKolom: (tabel: string, kolom: string, tipe: string) => Promise<void>
): Promise<void> {
  for (const k of KOLOM_PENYELESAIAN_V82) {
    await tambahKolom('pinjaman', k.nama, k.tipe);
  }
  // `tambahKolom` menelan galat (agar aman diulang). Karena versi skema baru
  // dinaikkan setelah blok ini, pastikan keenam kolom benar-benar ada —
  // kalau tidak, gagal keras supaya percobaan berikutnya mengulang.
  const ada = new Set((await db.getAllAsync<{ name: string }>(`PRAGMA table_info(pinjaman)`)).map((c) => c.name));
  const hilang = KOLOM_PENYELESAIAN_V82.filter((k) => !ada.has(k.nama)).map((k) => k.nama);
  if (hilang.length > 0) {
    throw new Error(`[migrasi v82] kolom pinjaman belum lengkap: ${hilang.join(', ')}.`);
  }
}

export async function migrasiV74(db: SQLite.SQLiteDatabase): Promise<void> {
  const ddl = potongDdlTabel(CREATE_TABLES_SQL, [
    'import_data_awal_riwayat',
    'import_data_awal_log',
  ]);
  await db.execAsync(ddl);
}

/**
 * Ambil pernyataan DDL untuk tabel tertentu (beserta indeksnya) dari
 * `CREATE_TABLES_SQL`. Dipakai migrasi aditif supaya definisi tabel
 * TIDAK pernah ditulis dua kali — satu sumber untuk instalasi baru dan
 * untuk upgrade. Melempar bila sebuah tabel tidak ditemukan: itu berarti
 * nama tabelnya salah tulis, dan migrasi yang diam-diam tidak membuat
 * apa pun jauh lebih sulit dilacak daripada yang gagal keras.
 */
function potongDdlTabel(sql: string, namaTabel: string[]): string {
  const bagian: string[] = [];
  for (const nama of namaTabel) {
    const awal = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${nama} (`);
    if (awal === -1) {
      throw new Error(`[migrasi] DDL tabel '${nama}' tidak ditemukan di CREATE_TABLES_SQL.`);
    }
    const akhir = sql.indexOf('\n);', awal);
    if (akhir === -1) {
      throw new Error(`[migrasi] DDL tabel '${nama}' tidak diakhiri dengan ');'.`);
    }
    bagian.push(sql.slice(awal, akhir + 3));
    // Indeks milik tabel ini (baris CREATE INDEX yang menyebut namanya).
    for (const baris of sql.split('\n')) {
      if (baris.startsWith('CREATE INDEX') && baris.includes(` ON ${nama}(`)) {
        bagian.push(baris.trim());
      }
    }
  }
  return bagian.join('\n');
}

/**
 * Logika VALIDASI file backup (murni, tanpa I/O file/SQLite sungguhan).
 * Dipisahkan dari BackupService.ts (yang melakukan operasi file/SQLite
 * nyata) supaya keputusan "valid/tidak valid" bisa diuji tanpa native
 * module — pola yang sama dengan PinjamanCalculator.ts vs
 * PinjamanService.ts, dan ShuCalculator.ts vs ShuService.ts.
 */

/** Tabel inti yang WAJIB ada supaya file dianggap backup Koperasi Finance asli. */
export const TABEL_WAJIB_BACKUP = [
  'koperasi',
  'account',
  'journal',
  'journal_entry',
  'anggota',
  'simpanan_transaksi',
  'pinjaman',
  'shu_konfigurasi',
  'audit_log',
  // BUG-11: metadata versi skema adalah bagian WAJIB dari sebuah backup.
  // Tanpa tabel ini kita tidak bisa tahu backup dibuat oleh aplikasi
  // versi berapa, sehingga tidak bisa memutuskan apakah restore aman.
  'schema_meta',
] as const;

/** Fakta mentah yang sudah dibaca dari file kandidat (hasil query SQLite). */
export interface FaktaBackup {
  integrityCheckResult: string | null; // hasil PRAGMA integrity_check, null jika gagal dibaca
  tabelYangAda: string[]; // daftar nama tabel dari sqlite_master
  /**
   * BUG-11 — versi skema file backup, dibaca dari `schema_meta.version`.
   * `null` berarti metadata tidak ada / tidak terbaca.
   */
  schemaVersionBackup: number | null;
  /** Versi skema aplikasi yang sedang berjalan (SCHEMA_VERSION). */
  schemaVersionAplikasi: number;
  /**
   * BUG-01/§22 — hasil `PRAGMA foreign_key_check` pada file kandidat.
   * Jumlah pelanggaran FK; > 0 berarti file secara struktur bisa dibuka
   * tetapi referensinya sudah rusak.
   */
  jumlahPelanggaranForeignKey: number;
  totalDebitJurnalPosted: number;
  totalKreditJurnalPosted: number;
  namaKoperasi: string | null;
  jumlahAnggota: number;
  jumlahJurnal: number;
  tanggalJurnalTerakhir: string | null;
}

export interface RingkasanBackup {
  schemaVersion: number | null;
  namaKoperasi: string | null;
  jumlahAnggota: number;
  jumlahJurnal: number;
  tanggalJurnalTerakhir: string | null;
}

export interface HasilValidasiBackup {
  valid: boolean;
  errors: string[];
  ringkasan?: RingkasanBackup;
  /**
   * RC-S116 — true bila berkasnya SAH tetapi tidak dapat dibuka dengan
   * kunci perangkat ini, sehingga butuh Kode Pemulihan.
   *
   * Dibedakan dari kegagalan lain dengan sengaja: "berkas rusak" adalah
   * jalan buntu, sedangkan ini keadaan yang MASIH BISA diselesaikan
   * pengguna. Layar memakai penanda ini untuk menampilkan kotak isian
   * kode, bukan sekadar pesan kesalahan.
   */
  butuhKodePemulihan?: boolean;
}

/**
 * Evaluasi murni: dari fakta yang sudah dibaca, tentukan file backup
 * valid atau tidak (PRD §35: "validasi schema, cek debit/kredit, cek
 * integritas data"; fase 5 §7: "Validasi file backup sebelum restore").
 */
export function evaluasiValidasiBackup(fakta: FaktaBackup): HasilValidasiBackup {
  const errors: string[] = [];

  if (fakta.integrityCheckResult !== 'ok') {
    errors.push('File backup tidak lolos pemeriksaan integritas SQLite (kemungkinan rusak/korup).');
  }

  const tabelSet = new Set(fakta.tabelYangAda);
  for (const wajib of TABEL_WAJIB_BACKUP) {
    if (!tabelSet.has(wajib)) {
      errors.push(`Tabel wajib "${wajib}" tidak ditemukan — file ini kemungkinan bukan backup Koperasi Finance.`);
    }
  }

  // ============================================================
  // BUG-11 — KOMPATIBILITAS VERSI SKEMA
  // ============================================================
  // WHY hard reject, bukan warning:
  // Backup yang dibuat aplikasi versi LEBIH BARU bisa memuat tabel,
  // kolom, dan constraint yang belum dikenal versi ini. Aplikasi lama
  // tetap "bisa" membukanya — membaca sebagian kolom dan menulis baris
  // baru tanpa mengisi kolom wajib versi baru. Hasilnya database yang
  // secara struktur valid tetapi secara akuntansi rusak, dan
  // kerusakannya baru ketahuan berbulan-bulan kemudian. Menolak restore
  // jauh lebih murah daripada memperbaiki buku besar yang sudah tercemar.
  if (tabelSet.has('schema_meta')) {
    if (fakta.schemaVersionBackup === null) {
      errors.push(
        'Metadata versi skema tidak ditemukan di dalam file backup — kompatibilitas tidak dapat dipastikan, restore dibatalkan.'
      );
    } else if (fakta.schemaVersionBackup > fakta.schemaVersionAplikasi) {
      errors.push(
        'Backup dibuat menggunakan schema yang lebih baru dan tidak kompatibel dengan versi aplikasi ini. ' +
          'Silakan gunakan versi aplikasi yang sama atau lebih baru. ' +
          `(schema backup: v${fakta.schemaVersionBackup}, schema aplikasi: v${fakta.schemaVersionAplikasi})`
      );
    }
    // schemaVersionBackup < aplikasi  -> BOLEH: runMigrations() akan
    // menaikkannya setelah restore.
    // schemaVersionBackup === aplikasi -> BOLEH: restore langsung.
  }

  // §22 — file yang lolos integrity_check pun masih bisa punya referensi
  // rusak. Ini diperiksa terpisah karena integrity_check hanya menguji
  // struktur B-tree, bukan konsistensi foreign key.
  if (fakta.jumlahPelanggaranForeignKey > 0) {
    errors.push(
      `File backup memiliki ${fakta.jumlahPelanggaranForeignKey} pelanggaran foreign key (orphan record) — restore dibatalkan.`
    );
  }

  // Cek debit=kredit (aturan inti AccountingEngine, PRD §19) hanya jika
  // struktur tabel sudah dipastikan lengkap — kalau tabel wajib hilang,
  // query jurnal di atasnya tidak bermakna.
  if (errors.length === 0 && fakta.totalDebitJurnalPosted !== fakta.totalKreditJurnalPosted) {
    errors.push(
      `Data jurnal pada file backup tidak balance (debit ${fakta.totalDebitJurnalPosted} != kredit ${fakta.totalKreditJurnalPosted}).`
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    ringkasan: {
      schemaVersion: fakta.schemaVersionBackup,
      namaKoperasi: fakta.namaKoperasi,
      jumlahAnggota: fakta.jumlahAnggota,
      jumlahJurnal: fakta.jumlahJurnal,
      tanggalJurnalTerakhir: fakta.tanggalJurnalTerakhir,
    },
  };
}

/** Nama file backup dengan timestamp (PRD §34: "simpan dengan nama dan timestamp"). */
export function formatNamaFileBackup(tanggal: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp = `${tanggal.getFullYear()}-${pad(tanggal.getMonth() + 1)}-${pad(tanggal.getDate())}_${pad(
    tanggal.getHours()
  )}${pad(tanggal.getMinutes())}${pad(tanggal.getSeconds())}`;
  return `koperasi_backup_${stamp}.kdb`;
}

/**
 * ============================================================
 * RC-S51 §3 — NAMA FILE BACKUP YANG SAH
 * ============================================================
 *
 * TEMUAN AUDIT (LOW). `BackupService.deleteBackup(fileName)` dulu
 * menempelkan argumennya langsung ke `BACKUP_DIR` dan menghapus
 * hasilnya. Karena URI digabung sebagai STRING, `'../..'` di dalam
 * `fileName` tidak ditolak oleh apa pun — ia hanya menghasilkan URI
 * lain yang tetap valid, di luar folder backup.
 *
 * Pemanggil satu-satunya saat ini adalah UI Backup & Restore, yang
 * meneruskan nama dari `listBackups()`. Jadi ini BUKAN kerentanan yang
 * dapat dieksploitasi hari ini — ia adalah batas yang tidak dijaga di
 * boundary service, dan pemanggil berikutnya (deep link, restore
 * otomatis, housekeeping) tidak punya cara mengetahuinya.
 *
 * KENAPA DI BERKAS INI. `formatNamaFileBackup()` di atas adalah
 * SATU-SATUNYA tempat nama file backup dibuat. Menaruh validatornya
 * bersebelahan dengan pembuatnya membuat keduanya mustahil menyimpang —
 * dan berkas ini murni (tanpa FileSystem/Sharing), sehingga dapat diuji
 * langsung.
 *
 * PENDEKATANNYA ALLOW-LIST, BUKAN BLOCK-LIST. Menolak daftar pola
 * berbahaya (`../`, `..\\`, `/`, `C:`) selalu tertinggal satu langkah
 * dari encoding berikutnya. Yang diizinkan hanyalah nama yang PERSIS
 * mengikuti pola yang dihasilkan aplikasi sendiri:
 *
 *     koperasi_backup_YYYY-MM-DD_HHMMSS.kdb   (createBackup)
 *     sebelum-restore_YYYY-MM-DD_HHMMSS.kdb   (salinan otomatis
 *                                              sebelum restore)
 *
 * Pola itu secara struktural tidak dapat memuat pemisah path, titik
 * ganda, drive letter, null byte, maupun karakter di luar `[0-9-_]` —
 * jadi traversal tidak perlu "dideteksi", ia sekadar tidak cocok.
 */
export const POLA_NAMA_FILE_BACKUP = /^(?:koperasi_backup|sebelum-restore)_\d{4}-\d{2}-\d{2}_\d{6}\.kdb$/;

/**
 * Lempar bila `fileName` bukan nama file backup yang dihasilkan
 * aplikasi ini. MURNI: tidak menyentuh filesystem sama sekali.
 */
export function assertNamaFileBackupSah(fileName: string): void {
  if (typeof fileName !== 'string' || fileName.length === 0 || !POLA_NAMA_FILE_BACKUP.test(fileName)) {
    throw new Error(
      `Nama file backup tidak valid: "${fileName}". ` +
        'Hanya file backup yang dibuat aplikasi ini yang dapat dihapus.'
    );
  }
}

/** Format ukuran file yang mudah dibaca untuk UI riwayat backup. */
export function formatUkuranFile(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

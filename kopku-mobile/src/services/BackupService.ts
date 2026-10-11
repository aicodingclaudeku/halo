import * as FileSystem from 'expo-file-system/legacy'; // SDK 54: API lama (documentDirectory, getInfoAsync, dst.) sekarang di path /legacy
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import * as SQLite from 'expo-sqlite';
import { getDb, closeDb, getDatabaseFilePath, getSqliteDirectory } from '@/database/db';
import { logout } from '@/services/AuthService';
import { requirePermission } from '@/services/PermissionService';
import { useAppStore } from '@/store/useAppStore';
import { newId } from '@/utils/id';
import {
  evaluasiValidasiBackup,
  formatNamaFileBackup,
  assertNamaFileBackupSah,
  TABEL_WAJIB_BACKUP,
  HasilValidasiBackup,
} from '@/backup/BackupValidator';
import { SCHEMA_VERSION } from '@/database/schema';
import {
  tulisBackupTerenkripsi,
  dekripsiBackupKeBerkas,
  periksaBerkasBackup,
  CaraBuka,
  InfoBerkasBackup,
} from '@/backup/BerkasBackupIO';
import { getKunciPerangkat, pastikanKodePemulihan, getIdInstalasi } from '@/security/backupKeyStore';

/**
 * Backup & Restore database SQLite (PRD §34-35, fase 5).
 *
 * CATATAN KEAMANAN — DIKOREKSI DI RC-S114.
 *
 * Sampai RC-S113 berkas backup adalah SALINAN MENTAH database SQLite,
 * dan catatan di tempat ini dulu menyimpulkan bahwa itu "tidak menambah
 * risiko baru" karena kolom PIN sudah ter-hash. Kesimpulan itu keliru:
 * yang terbuka bukan hanya PIN, melainkan `anggota.nik`, tanggal lahir,
 * alamat, nomor HP, serta seluruh saldo simpanan dan pinjaman setiap
 * anggota — dan berkas itu justru DIRANCANG untuk keluar dari perangkat
 * lewat tombol Bagikan, ke WhatsApp atau Drive, tempat tidak ada lagi
 * perlindungan sistem operasi. NIK adalah data pribadi spesifik menurut
 * UU PDP No. 27/2022.
 *
 * SEKARANG: berkas backup dienkripsi XChaCha20-Poly1305 per segmen
 * dengan konstruksi STREAM (lihat backup/FormatBackupTerenkripsi.ts dan
 * backup/MesinKriptoBackup.ts). Kunci berkas acak per backup, dibungkus
 * dua kali: oleh kunci perangkat di SecureStore/AndroidKeyStore, dan
 * oleh kode pemulihan — yang menjadi satu-satunya jalan pulang saat
 * perangkat hilang, karena kunci AndroidKeyStore tidak dapat diekspor.
 *
 * Berkas backup LAMA (SQLite polos) tetap dapat dipulihkan; pengguna
 * punya arsip berbulan-bulan yang tidak boleh mendadak tidak terbaca.
 *
 * Perlindungan yang sudah ada sebelumnya dipertahankan:
 * (1) backup/restore hanya bisa dipicu dari UI yang sudah ada di balik
 * autentikasi PIN/biometric (Pengaturan hanya bisa diakses saat
 * `phase === 'READY'`, lihat App.tsx), (2) setiap aksi dicatat ke
 * `audit_log` yang sudah ada, (3) setelah restore, sesi PIN aktif
 * DIPAKSA logout lewat AuthService.logout() (bukan mekanisme baru)
 * karena user yang sedang login belum tentu ada di database yang baru.
 *
 * CATATAN IZIN ANDROID (fase 5 §12): backup disimpan di folder privat
 * aplikasi (`FileSystem.documentDirectory`) — TIDAK butuh permission
 * WRITE_EXTERNAL_STORAGE/READ_EXTERNAL_STORAGE sama sekali. Berbagi
 * file keluar aplikasi memakai `expo-sharing` (share sheet Android
 * bawaan) dan impor file dari luar memakai `expo-document-picker`
 * (Storage Access Framework) — keduanya TIDAK perlu dialog permission
 * runtime, ini pola yang direkomendasikan Android modern dibanding
 * meminta permission storage yang luas.
 *
 * KEPUTUSAN SADAR soal app.json: `expo-file-system` punya config plugin
 * (`app.plugin.js`) yang — jika didaftarkan di `app.json > plugins` —
 * akan menambahkan permission READ_EXTERNAL_STORAGE, WRITE_EXTERNAL_
 * STORAGE, dan INTERNET ke AndroidManifest.xml TANPA opsi untuk memilih
 * sebagian. Karena seluruh kode di file ini SENGAJA didesain untuk tidak
 * membutuhkan permission tersebut (lihat paragraf di atas), plugin ini
 * TIDAK didaftarkan — supaya aplikasi tidak meminta izin storage yang
 * luas tanpa alasan. `expo-document-picker` juga punya config plugin,
 * tapi isinya hanya konfigurasi iCloud iOS (tidak relevan untuk project
 * Android-only ini), jadi juga aman tidak didaftarkan. `expo-sharing`
 * tidak punya config plugin sama sekali.
 */

/**
 * RC-S99 — diekspor (dulu private): `ResetDataService` menyimpan salinan
 * pengaman sebelum reset ke folder yang SAMA dengan backup manual,
 * supaya pengguna menemukannya di daftar backup yang sudah ia kenal dan
 * bisa memulihkannya lewat layar Backup & Restore yang sudah ada.
 * Folder ini terpisah dari berkas database, jadi isinya selamat bahkan
 * saat reset total menghapus database.
 */
export const BACKUP_DIR = `${FileSystem.documentDirectory}backups/`;
const VALIDATE_DB_NAME = 'koperasi_validate_temp.db';

export interface BackupFileInfo {
  fileName: string;
  uri: string;
  sizeBytes: number;
  createdAt: string; // ISO
  /**
   * RC-S114 — false berarti berkas lama (SQLite polos, sebelum
   * enkripsi). Ditampilkan apa adanya di daftar supaya pengguna tahu
   * berkas mana yang masih terbuka, bukan disembunyikan.
   */
  terenkripsi: boolean;
  /** Berkas terenkripsi yang dibungkus kunci perangkat LAIN butuh Kode Pemulihan. */
  butuhKodePemulihan: boolean;
}

export type BackupProgressStage = 'MEMPERSIAPKAN' | 'MENYALIN' | 'SELESAI';

async function ensureDirectoryExists(dir: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

async function writeAuditLog(userId: string, action: string, keterangan?: string): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await db.runAsync(
    `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, data_sesudah, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    newId(),
    userId,
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    action,
    'database',
    keterangan ? JSON.stringify({ keterangan }) : null,
    now.toISOString()
  );
}

/**
 * Buat backup manual seluruh database SQLite (fase 5 §1-4). Sebelum
 * menyalin, WAL di-checkpoint penuh dulu supaya file utama .db
 * benar-benar berisi SELURUH data yang sudah ter-commit (mode WAL bisa
 * menyimpan sebagian data di file -wal terpisah).
 */
export async function createBackup(
  userId: string,
  onProgress?: (stage: BackupProgressStage) => void
): Promise<BackupFileInfo> {
  const db = await getDb();
  await requirePermission(db, userId, 'backup', 'create');

  onProgress?.('MEMPERSIAPKAN');
  await ensureDirectoryExists(BACKUP_DIR);

  await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');

  // RC-S95 — SENGAJA jam ASLI, bukan jam aplikasi (Mode Pengujian Waktu).
  // Nama file inilah yang mengurutkan backup saat memilih titik restore;
  // kalau memakai jam simulasi, backup yang lebih BARU bisa tampak lebih
  // LAMA dan yang ter-restore bisa backup yang salah.
  const fileName = formatNamaFileBackup(new Date());
  const destUri = `${BACKUP_DIR}${fileName}`;

  onProgress?.('MENYALIN');

  // RC-S114 — database TIDAK lagi disalin apa adanya. Ia dienkripsi
  // per segmen langsung dari berkas sumber ke berkas tujuan, sehingga
  // puncak pemakaian memori tetap sebesar satu segmen berapa pun besar
  // databasenya.
  //
  // Kunci perangkat dan kode pemulihan dibuat MALAS di sini (saat
  // backup pertama), bukan saat aplikasi pertama dijalankan: dengan
  // begitu keystore yang bermasalah hanya menggagalkan fitur backup,
  // bukan membuat aplikasi gagal dibuka sama sekali.
  const [kunciPerangkat, kodePemulihan, idInstalasi] = await Promise.all([
    getKunciPerangkat(),
    pastikanKodePemulihan(),
    getIdInstalasi(),
  ]);

  await tulisBackupTerenkripsi({
    sumberUri: getDatabaseFilePath(),
    tujuanUri: destUri,
    kunciPerangkat,
    kodePemulihan,
    idInstalasi,
    skema: SCHEMA_VERSION,
  });

  const info = await FileSystem.getInfoAsync(destUri);
  await writeAuditLog(userId, 'BACKUP', fileName);

  onProgress?.('SELESAI');
  return {
    fileName,
    uri: destUri,
    sizeBytes: info.exists ? info.size : 0,
    createdAt: new Date().toISOString(),
    terenkripsi: true,
    butuhKodePemulihan: false,
  };
}

/** Riwayat backup (fase 5 §11) — dibaca langsung dari folder backup privat aplikasi. */
export async function listBackups(): Promise<BackupFileInfo[]> {
  await ensureDirectoryExists(BACKUP_DIR);
  const files = await FileSystem.readDirectoryAsync(BACKUP_DIR);
  const infos: BackupFileInfo[] = [];
  const idInstalasi = await getIdInstalasi();

  for (const fileName of files) {
    if (!fileName.endsWith('.kdb')) continue; // abaikan file lain yang mungkin nyasar ke folder ini
    const uri = `${BACKUP_DIR}${fileName}`;
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) continue;
    let terenkripsi = false;
    let butuhKodePemulihan = false;
    try {
      const periksa = periksaBerkasBackup(uri, idInstalasi);
      terenkripsi = periksa.jenis === 'TERENKRIPSI';
      butuhKodePemulihan = terenkripsi && periksa.dariPerangkatIni === false;
    } catch {
      // Berkas yang tidak terbaca tetap ditampilkan sebagai "tidak
      // terenkripsi" daripada menghilang dari daftar tanpa penjelasan.
    }

    infos.push({
      fileName,
      uri,
      sizeBytes: info.size,
      createdAt: new Date(info.modificationTime * 1000).toISOString(),
      terenkripsi,
      butuhKodePemulihan,
    });
  }

  return infos.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // terbaru dulu
}

/**
 * Validasi nama file backup dan kembalikan URI absolutnya di dalam
 * `BACKUP_DIR` (RC-S51 §3).
 *
 * Dua lapis, dan keduanya memang perlu:
 *
 *  1. `assertNamaFileBackupSah()` — allow-list nama, tinggal di
 *     `BackupValidator` bersebelahan dengan `formatNamaFileBackup()`
 *     yang membuat nama itu. Ini yang menutup traversal, absolute
 *     path, dan drive letter sekaligus: semuanya mengandung karakter
 *     yang tidak ada di dalam pola.
 *  2. Invarian LOKASI pada URI hasil gabungan: harus berada di dalam
 *     `BACKUP_DIR`, tanpa segmen `..`, dan tanpa pemisah path tambahan
 *     setelah prefiks direktori. Lapis ini redundan terhadap lapis 1
 *     dan memang disengaja — ia menjaga invarian "target selalu di
 *     dalam BACKUP_DIR" tetap benar bila suatu saat polanya
 *     dilonggarkan.
 *
 * BATAS YANG JUJUR: React Native/Expo tidak menyediakan `realpath`,
 * jadi ini validasi pada tingkat STRING URI — bukan resolusi canonical
 * filesystem. Symlink di dalam folder backup privat aplikasi karena itu
 * tidak terdeteksi. Folder itu dibuat dan diisi hanya oleh aplikasi ini
 * di `FileSystem.documentDirectory`, sehingga symlink di sana berarti
 * perangkat sudah dikompromikan pada tingkat yang jauh melampaui apa
 * pun yang dapat dijaga service ini.
 */
export function resolveUriBackupYangSah(fileName: string): string {
  assertNamaFileBackupSah(fileName);

  const uri = `${BACKUP_DIR}${fileName}`;
  if (!uri.startsWith(BACKUP_DIR) || uri.includes('..') || uri.slice(BACKUP_DIR.length).includes('/')) {
    throw new Error(`Nama file backup tidak valid: "${fileName}".`);
  }
  return uri;
}

/**
 * Hapus satu file backup dari riwayat (housekeeping — tidak memengaruhi
 * database aktif).
 *
 * `idempotent: true` dipertahankan: menghapus file yang sudah tidak ada
 * BUKAN error (dua tap pada tombol hapus tidak boleh menampilkan
 * kegagalan). Yang berubah hanya bahwa nama filenya sekarang wajib sah
 * lebih dulu — nama yang tidak sah melempar SEBELUM `deleteAsync`
 * dipanggil, sehingga tidak ada file apa pun yang tersentuh.
 */
export async function deleteBackup(fileName: string): Promise<void> {
  const uri = resolveUriBackupYangSah(fileName);
  await FileSystem.deleteAsync(uri, { idempotent: true });
}

/**
 * RC-S114 — enkripsi ulang satu berkas backup LAMA (SQLite polos).
 *
 * Dipanggil per berkas dari layar Backup & Restore, atas permintaan
 * pengguna — BUKAN otomatis saat layar dibuka. Mengubah berkas milik
 * pengguna tanpa diminta, apalagi berkas cadangan yang justru ada untuk
 * keadaan darurat, bukan keputusan yang boleh diambil aplikasi sendiri.
 *
 * Polanya sama dengan restore: tulis ke berkas SEMENTARA lebih dulu,
 * buktikan hasilnya bisa dibuka kembali, baru gantikan yang lama. Kalau
 * gagal di tengah, berkas lama tidak tersentuh sama sekali.
 */
export async function enkripsiUlangBackupLama(fileName: string, userId: string): Promise<void> {
  const db = await getDb();
  await requirePermission(db, userId, 'backup', 'create');

  const uri = resolveUriBackupYangSah(fileName);
  const idInstalasi = await getIdInstalasi();
  const periksa = periksaBerkasBackup(uri, idInstalasi);
  if (periksa.jenis === 'TERENKRIPSI') return; // sudah terenkripsi — tidak ada yang perlu dikerjakan
  if (periksa.jenis !== 'SQLITE_LAMA') {
    throw new Error('Berkas ini bukan backup Koperasi Finance.');
  }

  const [kunciPerangkat, kodePemulihan] = await Promise.all([getKunciPerangkat(), pastikanKodePemulihan()]);
  const sementara = `${uri}.enkripsi.tmp`;
  await FileSystem.deleteAsync(sementara, { idempotent: true });

  try {
    await tulisBackupTerenkripsi({
      sumberUri: uri,
      tujuanUri: sementara,
      kunciPerangkat,
      kodePemulihan,
      idInstalasi,
      skema: null, // versi skema berkas lama tidak dibaca ulang di sini; validasi saat restore yang menentukan
    });

    // Buktikan hasilnya benar-benar bisa dibuka SEBELUM berkas asli
    // ditimpa. Tanpa langkah ini, kesalahan apa pun di jalur enkripsi
    // akan menghancurkan cadangan yang tadinya masih terbaca.
    const uji = `${FileSystem.cacheDirectory}kopku_uji_enkripsi.tmp`;
    await FileSystem.deleteAsync(uji, { idempotent: true });
    await dekripsiBackupKeBerkas({
      sumberUri: sementara,
      tujuanUri: uji,
      cara: { jenis: 'PERANGKAT', kunciPerangkat },
    });
    await FileSystem.deleteAsync(uji, { idempotent: true });

    await FileSystem.deleteAsync(uri, { idempotent: true });
    await FileSystem.moveAsync({ from: sementara, to: uri });
  } catch (e) {
    await FileSystem.deleteAsync(sementara, { idempotent: true });
    throw e;
  }

  await writeAuditLog(userId, 'BACKUP', `Enkripsi ulang backup lama: ${fileName}`);
}

/** Bagikan file backup lewat share sheet Android/iOS bawaan (fase 5 §12). */
export async function shareBackup(uri: string): Promise<void> {
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error('Fitur berbagi file tidak tersedia di perangkat ini.');
  }
  await Sharing.shareAsync(uri, {
    mimeType: 'application/octet-stream',
    dialogTitle: 'Bagikan Backup Koperasi Finance',
  });
}

/**
 * Pilih file backup dari luar aplikasi (mis. hasil unduhan dari Google
 * Drive) lewat Storage Access Framework Android — tidak perlu izin
 * runtime (fase 5 §5, §12). File dipilih disalin ke cache aplikasi.
 */
export async function pilihFileBackupEksternal(): Promise<{ uri: string; nama: string } | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  // RC-S116 — nama berkasnya ikut dikembalikan supaya dialog pemulihan
  // menyebut berkas yang benar-benar dipilih, bukan "File yang dipilih"
  // yang tidak membantu pengguna memastikan ia memilih berkas yang tepat.
  const aset = result.assets[0];
  return { uri: aset.uri, nama: aset.name ?? 'Berkas dipilih' };
}

/**
 * Validasi file backup sebelum restore (fase 5 §7). File kandidat
 * disalin ke folder internal SQLite dengan nama sementara supaya bisa
 * dibuka langsung oleh expo-sqlite (yang hanya bisa membuka database
 * dari folder tersebut), diperiksa, lalu dibersihkan lagi — database
 * AKTIF sama sekali tidak disentuh pada tahap ini.
 */
export async function validasiFileBackup(
  fileUri: string,
  cara?: CaraBuka
): Promise<HasilValidasiBackup> {
  const info = await FileSystem.getInfoAsync(fileUri);
  if (!info.exists) {
    return { valid: false, errors: ['File backup tidak ditemukan.'] };
  }

  // RC-S114 — berkas terenkripsi dibuka lebih dulu ke berkas SEMENTARA.
  // Berkas lama (SQLite polos) dilewatkan apa adanya supaya arsip
  // pengguna tetap bisa dipulihkan.
  let uriUntukDiperiksa = fileUri;
  let uriSementara: string | null = null;
  try {
    const hasilSiap = await siapkanBerkasSqlite(fileUri, cara);
    uriUntukDiperiksa = hasilSiap.uri;
    uriSementara = hasilSiap.uriSementara;
  } catch (e) {
    if (e instanceof GagalBukaKunciPerangkat) {
      return {
        valid: false,
        errors: [e.message],
        butuhKodePemulihan: true,
      };
    }
    return { valid: false, errors: [e instanceof Error ? e.message : 'Berkas backup tidak dapat dibuka.'] };
  }

  try {
    return await validasiBerkasSqlite(uriUntukDiperiksa);
  } finally {
    if (uriSementara) await FileSystem.deleteAsync(uriSementara, { idempotent: true });
  }
}

/**
 * RC-S116 — kegagalan yang MASIH BISA diselesaikan pengguna.
 *
 * Dipisahkan sebagai kelas tersendiri, bukan dibedakan dari teks
 * pesannya: mencocokkan pesan adalah cara tercepat membuat penanganan
 * ini diam-diam berhenti bekerja begitu kalimatnya diperhalus.
 */
export class GagalBukaKunciPerangkat extends Error {
  readonly butuhKodePemulihan = true;
  constructor(pesan: string) {
    super(pesan);
    this.name = 'GagalBukaKunciPerangkat';
  }
}

/** Berkas SQLite siap-periksa: `.kdb` terenkripsi dibuka dulu ke berkas sementara. */
const SUFIKS_DEKRIPSI = '.dekripsi.tmp';

async function siapkanBerkasSqlite(
  fileUri: string,
  cara?: CaraBuka
): Promise<{ uri: string; uriSementara: string | null }> {
  const idInstalasi = await getIdInstalasi();
  const periksa = periksaBerkasBackup(fileUri, idInstalasi);

  if (periksa.jenis === 'SQLITE_LAMA') return { uri: fileUri, uriSementara: null };
  if (periksa.jenis === 'TIDAK_DIKENAL') {
    throw new Error('Berkas ini bukan backup Koperasi Finance.');
  }

  const caraDipakai = cara ?? { jenis: 'PERANGKAT' as const, kunciPerangkat: await getKunciPerangkat() };
  const tujuan = `${FileSystem.cacheDirectory}kopku_restore${SUFIKS_DEKRIPSI}`;
  try {
    await dekripsiBackupKeBerkas({ sumberUri: fileUri, tujuanUri: tujuan, cara: caraDipakai });
  } catch (e) {
    await FileSystem.deleteAsync(tujuan, { idempotent: true });
    if (caraDipakai.jenis === 'KODE_PEMULIHAN') {
      // Kode yang bentuknya sah tetapi BUKAN kode berkas ini. Ini juga
      // keadaan yang masih bisa diselesaikan — pengurus mungkin
      // memegang beberapa kode dari beberapa perangkat — jadi kotak
      // isiannya harus tetap terbuka, bukan berubah jadi jalan buntu
      // "berkas rusak".
      throw new GagalBukaKunciPerangkat(
        'Kode Pemulihan ini tidak cocok dengan backup tersebut. Periksa kembali catatan kodenya.'
      );
    }
    if (caraDipakai.jenis === 'PERANGKAT') {
      // RC-S116 — SETIAP kegagalan membuka dengan kunci perangkat
      // diperlakukan sebagai "butuh Kode Pemulihan", bukan hanya saat
      // penanda instalasinya berbeda.
      //
      // Alasannya: kunci perangkat juga hilang ketika pengguna mencopot
      // lalu memasang ulang aplikasi, atau ketika AndroidKeyStore
      // menganggap kuncinya tidak sah lagi (mis. kunci layar diganti).
      // Dalam keadaan itu penanda instalasi bisa saja cocok, tetapi
      // kuncinya tetap tidak ada. Memperlakukannya sebagai "berkas
      // rusak" akan membuat pengguna membuang backup yang sebenarnya
      // masih utuh dan masih bisa dibuka dengan kodenya.
      throw new GagalBukaKunciPerangkat(
        periksa.dariPerangkatIni === false
          ? 'Backup ini dibuat di perangkat lain, jadi kunci perangkat ini tidak cocok.'
          : 'Backup ini tidak dapat dibuka dengan kunci perangkat ini — kuncinya mungkin hilang karena aplikasi pernah dipasang ulang.'
      );
    }
    throw e;
  }
  return { uri: tujuan, uriSementara: tujuan };
}

async function validasiBerkasSqlite(fileUri: string): Promise<HasilValidasiBackup> {
  await ensureDirectoryExists(getSqliteDirectory());
  const validateDbPath = `${getSqliteDirectory()}${VALIDATE_DB_NAME}`;

  const bersihkanFileValidasi = async () => {
    await FileSystem.deleteAsync(validateDbPath, { idempotent: true });
    await FileSystem.deleteAsync(`${validateDbPath}-wal`, { idempotent: true });
    await FileSystem.deleteAsync(`${validateDbPath}-shm`, { idempotent: true });
  };

  await bersihkanFileValidasi();
  await FileSystem.copyAsync({ from: fileUri, to: validateDbPath });

  let testDb: SQLite.SQLiteDatabase | null = null;
  try {
    testDb = await SQLite.openDatabaseAsync(VALIDATE_DB_NAME);

    const integrity = await testDb.getFirstAsync<{ integrity_check: string }>('PRAGMA integrity_check;');
    const tables = await testDb.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`);
    const tabelYangAda = tables.map((t) => t.name);

    // Query jurnal hanya bermakna jika struktur tabelnya ada — kalau
    // tidak, biarkan hasilnya 0/0 (evaluasiValidasiBackup tetap akan
    // menandai tabel yang hilang sebagai error terlebih dahulu).
    let totalDebit = 0;
    let totalKredit = 0;
    let namaKoperasi: string | null = null;
    let jumlahAnggota = 0;
    let jumlahJurnal = 0;
    let tanggalJurnalTerakhir: string | null = null;

    // BUG-11 — versi skema dibaca TERPISAH dari blok "tabel wajib
    // lengkap" di bawah, karena justru file yang strukturnya tidak
    // lengkap pun perlu dilaporkan versinya bila ada.
    let schemaVersionBackup: number | null = null;
    if (tabelYangAda.includes('schema_meta')) {
      const metaRow = await testDb.getFirstAsync<{ version: number }>(
        'SELECT version FROM schema_meta WHERE id = 1'
      );
      schemaVersionBackup = metaRow?.version ?? null;
    }

    // §22 — pemeriksaan referensial. `PRAGMA foreign_key_check` bekerja
    // terlepas dari nilai `PRAGMA foreign_keys` pada koneksi ini.
    const pelanggaranFk = await testDb.getAllAsync<{ table: string }>('PRAGMA foreign_key_check');

    if (TABEL_WAJIB_BACKUP.every((t) => tabelYangAda.includes(t))) {
      const balance = await testDb.getFirstAsync<{ d: number; k: number }>(
        `SELECT COALESCE(SUM(je.debit),0) as d, COALESCE(SUM(je.kredit),0) as k
         FROM journal_entry je JOIN journal j ON j.id = je.journal_id
         WHERE j.status = 'POSTED'`
      );
      totalDebit = balance?.d ?? 0;
      totalKredit = balance?.k ?? 0;

      const koperasi = await testDb.getFirstAsync<{ nama: string }>(
        `SELECT nama FROM koperasi ORDER BY created_at DESC LIMIT 1`
      );
      namaKoperasi = koperasi?.nama ?? null;

      const anggotaRow = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM anggota`);
      jumlahAnggota = anggotaRow?.cnt ?? 0;

      const jurnalRow = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM journal`);
      jumlahJurnal = jurnalRow?.cnt ?? 0;

      const tanggalRow = await testDb.getFirstAsync<{ tanggal: string }>(
        `SELECT tanggal FROM journal ORDER BY tanggal DESC LIMIT 1`
      );
      tanggalJurnalTerakhir = tanggalRow?.tanggal ?? null;
    }

    return evaluasiValidasiBackup({
      integrityCheckResult: integrity?.integrity_check ?? null,
      tabelYangAda,
      schemaVersionBackup,
      schemaVersionAplikasi: SCHEMA_VERSION,
      jumlahPelanggaranForeignKey: pelanggaranFk.length,
      totalDebitJurnalPosted: totalDebit,
      totalKreditJurnalPosted: totalKredit,
      namaKoperasi,
      jumlahAnggota,
      jumlahJurnal,
      tanggalJurnalTerakhir,
    });
  } catch (e) {
    return {
      valid: false,
      errors: [
        e instanceof Error ? `File backup tidak valid: ${e.message}` : 'File backup tidak valid atau bukan file SQLite.',
      ],
    };
  } finally {
    if (testDb) {
      await testDb.closeAsync();
    }
    await bersihkanFileValidasi();
  }
}

export interface RestoreResult {
  safetyBackupFileName: string;
}

/**
 * Restore database dari file backup (fase 5 §6, §8-10). Alur aman:
 *  1. Validasi file TERLEBIH DAHULU — database aktif belum disentuh
 *     sama sekali di tahap ini, jadi jika tidak valid, tidak ada risiko.
 *  2. Buat backup otomatis dari kondisi SEKARANG sebelum ditimpa —
 *     jaring pengaman, data lama tidak pernah hilang.
 *  3. Tutup koneksi aktif, tukar file dengan pola AMAN: file lama
 *     di-rename dulu jadi `.previous` (bukan langsung dihapus), file
 *     baru dipindah ke posisi utama, baru file `.previous` dihapus.
 *     Kalau proses terhenti di tengah jalan, `getDb()` (database/db.ts)
 *     akan otomatis memulihkan `.previous` saat aplikasi dibuka lagi.
 *  4. Buka koneksi baru (migrasi otomatis jalan lagi jika perlu) dan
 *     PAKSA logout — sesi PIN lama belum tentu valid di database baru.
 */
export async function restoreBackup(fileUri: string, userId: string, cara?: CaraBuka): Promise<RestoreResult> {
  const dbAwal = await getDb();
  await requirePermission(dbAwal, userId, 'backup', 'approve'); // restore = tindakan paling berisiko, level tertinggi

  const validasi = await validasiFileBackup(fileUri, cara);
  if (!validasi.valid) {
    throw new Error(`File backup tidak valid:\n${validasi.errors.join('\n')}`);
  }

  // Jaring pengaman: backup kondisi SEKARANG sebelum ditimpa (fase 5 §9).
  const safetyBackup = await createBackup(userId);
  const safetyFileName = safetyBackup.fileName.replace('koperasi_backup_', 'sebelum-restore_');
  await FileSystem.moveAsync({ from: safetyBackup.uri, to: `${BACKUP_DIR}${safetyFileName}` });

  const liveDbPath = getDatabaseFilePath();
  const previousPath = `${liveDbPath}.previous`;
  const tmpPath = `${liveDbPath}.restoring.tmp`;

  await FileSystem.deleteAsync(tmpPath, { idempotent: true });
  // RC-S114 — berkas terenkripsi dibuka ke `tmpPath`; berkas lama
  // (SQLite polos) disalin apa adanya. Keduanya sudah lolos validasi
  // di atas, dan database AKTIF belum disentuh sama sekali sampai
  // titik ini.
  const siap = await siapkanBerkasSqlite(fileUri, cara);
  await FileSystem.copyAsync({ from: siap.uri, to: tmpPath });
  if (siap.uriSementara) await FileSystem.deleteAsync(siap.uriSementara, { idempotent: true });

  // Tutup koneksi SEBELUM menyentuh file — wajib di Android, file yang
  // masih dibuka native module tidak boleh ditukar sembarangan.
  await closeDb();

  await FileSystem.deleteAsync(previousPath, { idempotent: true }); // bersihkan sisa proses sebelumnya jika ada
  const liveInfo = await FileSystem.getInfoAsync(liveDbPath);
  if (liveInfo.exists) {
    await FileSystem.moveAsync({ from: liveDbPath, to: previousPath });
  }
  // Bersihkan sidecar WAL/SHM lama supaya tidak konflik dengan file baru.
  await FileSystem.deleteAsync(`${liveDbPath}-wal`, { idempotent: true });
  await FileSystem.deleteAsync(`${liveDbPath}-shm`, { idempotent: true });

  await FileSystem.moveAsync({ from: tmpPath, to: liveDbPath }); // titik penukaran

  // ============================================================
  // RC-S114 — URUTAN PENGHAPUSAN `.previous` DIPERBAIKI
  // ============================================================
  // Sebelumnya `.previous` dihapus TEPAT SETELAH penukaran berkas,
  // yaitu SEBELUM `getDb()` membuktikan bahwa database baru benar-benar
  // bisa dibuka. Kalau pembukaan gagal (migrasi menolak, berkas lolos
  // validasi tetapi tidak dapat dibuka expo-sqlite), database lama
  // sudah lenyap dan `pulihkanJikaRestoreTerputus()` di db.ts tidak
  // punya apa pun untuk dipulihkan — aplikasi bisa gagal dibuka sama
  // sekali.
  //
  // Sekarang `.previous` baru dihapus SETELAH koneksi baru terbukti
  // hidup. Bila gagal, berkas lama dikembalikan ke tempatnya dan
  // kesalahannya dilempar apa adanya: pengguna kembali ke keadaan
  // sebelum restore, bukan ke aplikasi yang tidak bisa dibuka.
  try {
    await getDb(); // buka koneksi baru — migrasi (db.ts) otomatis jalan lagi jika perlu
  } catch (e) {
    await closeDb();
    await FileSystem.deleteAsync(liveDbPath, { idempotent: true });
    await FileSystem.deleteAsync(`${liveDbPath}-wal`, { idempotent: true });
    await FileSystem.deleteAsync(`${liveDbPath}-shm`, { idempotent: true });
    const infoPrevious = await FileSystem.getInfoAsync(previousPath);
    if (infoPrevious.exists) {
      await FileSystem.moveAsync({ from: previousPath, to: liveDbPath });
    }
    throw new Error(
      'Restore dibatalkan: database hasil pemulihan tidak dapat dibuka. ' +
        `Data sebelum restore sudah dikembalikan. Rincian: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // Berhasil dibuka -> berkas lama tidak diperlukan lagi.
  await FileSystem.deleteAsync(previousPath, { idempotent: true });

  await writeAuditLog(userId, 'RESTORE', `Restore dari backup. Salinan sebelum restore: ${safetyFileName}`);

  // Paksa logout — sesi PIN yang sedang aktif belum tentu valid lagi
  // untuk data koperasi yang baru saja dipulihkan.
  await logout();

  // Beri sinyal ke App.tsx supaya seluruh state aplikasi (koperasi aktif,
  // status sesi) dievaluasi ulang dari database yang baru (fase 5 §10).
  useAppStore.getState().triggerRestoreReload();

  return { safetyBackupFileName: safetyFileName };
}

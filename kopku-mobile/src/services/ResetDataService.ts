import * as FileSystem from 'expo-file-system/legacy'; // SDK 54: API lama ada di path /legacy
import { getDb, closeDb, getDatabaseFilePath } from '@/database/db';
import { newId } from '@/utils/id';
import { Role } from '@/config/defaultPermissions';
import { createBackup, BACKUP_DIR } from './BackupService';
import { logout } from './AuthService';
import { ModeResetData, LABEL_MODE } from './ResetDataPlan';
import {
  hitungRingkasanDataTransaksi,
  resetDataTransaksiPadaDb,
  KelompokRingkasanData,
} from './ResetDataTransaksi';

/**
 * RC-S99 — RESET DATA (lapisan aplikasi).
 *
 * Mengurus hal-hal yang TIDAK bisa diuji di Node: izin, berkas database,
 * dan sesi. Seluruh aturan "apa yang dihapus" ada di `ResetDataPlan.ts`
 * dan eksekusi SQL-nya di `ResetDataTransaksi.ts` — keduanya modul yang
 * diuji langsung.
 */

export class HanyaAdminResetError extends Error {
  constructor() {
    super('Hanya Admin yang dapat melakukan reset data.');
    this.name = 'HanyaAdminResetError';
  }
}

/**
 * ADMIN-ONLY di-hardcode di sini, TIDAK bergantung pada matrix
 * `role_permission`. Alasannya sama dengan `UserManagementService`
 * ("pertahanan berlapis"), tapi dengan taruhan yang lebih tinggi: matrix
 * itu bisa diedit admin lewat layar Permission Matrix, dan salah edit
 * yang membuat role lain bisa menghapus seluruh data koperasi adalah
 * kesalahan yang tidak bisa dibatalkan. Aturan "hanya Admin" untuk
 * tindakan ini karena itu tidak boleh bersumber dari data yang bisa
 * salah dikonfigurasi.
 */
async function pastikanAdmin(userId: string): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ role: Role; aktif: number }>(
    `SELECT role, aktif FROM app_user WHERE id = ?`,
    userId
  );
  if (!row || !row.aktif || row.role !== 'ADMIN') throw new HanyaAdminResetError();
}

/** Ringkasan jumlah baris yang akan hilang — dibaca layar konfirmasi. */
export async function hitungRingkasanDataUntukReset(): Promise<KelompokRingkasanData[]> {
  const db = await getDb();
  return hitungRingkasanDataTransaksi(db);
}

export interface HasilReset {
  mode: ModeResetData;
  totalBarisTerhapus: number;
  /** Nama berkas salinan pengaman internal, atau null bila gagal dibuat. */
  salinanPengaman: string | null;
  /** Diisi bila salinan pengaman gagal — ditampilkan apa adanya, tidak disembunyikan. */
  peringatanSalinanPengaman?: string;
  /** TOTAL: sesi dipaksa berakhir & aplikasi harus kembali ke setup awal. */
  perluSetupUlang: boolean;
}

/**
 * SALINAN PENGAMAN INTERNAL — selalu dicoba, di luar backup manual yang
 * dibuat pengguna di layar.
 *
 * Disimpan di `BACKUP_DIR`, folder yang TERPISAH dari berkas database,
 * sehingga ia selamat bahkan pada mode TOTAL yang menghapus berkas
 * database itu sendiri.
 *
 * BEST EFFORT, tidak menggagalkan reset. Pengguna sudah melewati gerbang
 * backup di layar (membuat backup ATAU sengaja melewatkannya), jadi
 * membatalkan reset karena penyimpanan penuh akan mengubah kebijakan
 * "wajib salah satu" menjadi "wajib backup tanpa jalan pintas" — bukan
 * yang diminta. Kegagalannya DILAPORKAN ke pemanggil, tidak ditelan.
 */
async function buatSalinanPengaman(
  userId: string,
  mode: ModeResetData
): Promise<{ nama: string | null; peringatan?: string }> {
  try {
    const backup = await createBackup(userId);
    const nama = backup.fileName.replace('koperasi_backup_', `sebelum-reset-${mode.toLowerCase()}_`);
    await FileSystem.moveAsync({ from: backup.uri, to: `${BACKUP_DIR}${nama}` });
    return { nama };
  } catch (e) {
    return {
      nama: null,
      peringatan: `Salinan pengaman otomatis gagal dibuat: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

async function catatAuditReset(userId: string, keterangan: string): Promise<void> {
  const db = await getDb();
  const now = new Date(); // SENGAJA jam asli: jejak audit tidak boleh ikut jam simulasi
  await db.runAsync(
    `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, data_sesudah, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    newId(),
    userId,
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    'RESET_DATA',
    'database',
    JSON.stringify({ keterangan }),
    now.toISOString()
  );
}

/**
 * MODE TRANSAKSI — kosongkan data operasional, pertahankan konfigurasi.
 *
 * `audit_log` termasuk yang DIPERTAHANKAN, dan reset ini justru dicatat
 * di sana SETELAH penghapusan berhasil: reset data adalah tindakan yang
 * paling perlu terlacak, jadi ia tidak boleh menghapus jejaknya sendiri.
 */
export async function resetDataTransaksi(actingUserId: string): Promise<HasilReset> {
  await pastikanAdmin(actingUserId);

  const pengaman = await buatSalinanPengaman(actingUserId, 'TRANSAKSI');

  const db = await getDb();
  const hasil = await resetDataTransaksiPadaDb(db);

  await catatAuditReset(
    actingUserId,
    `${LABEL_MODE.TRANSAKSI}: ${hasil.totalBarisTerhapus} baris dihapus dari ${
      Object.keys(hasil.terhapus).length
    } tabel. Salinan pengaman: ${pengaman.nama ?? 'GAGAL DIBUAT'}.`
  );

  return {
    mode: 'TRANSAKSI',
    totalBarisTerhapus: hasil.totalBarisTerhapus,
    salinanPengaman: pengaman.nama,
    peringatanSalinanPengaman: pengaman.peringatan,
    perluSetupUlang: false,
  };
}

/**
 * MODE TOTAL — hapus berkas database, aplikasi kembali seperti baru dipasang.
 *
 * Penukaran berkasnya memakai pola yang SAMA PERSIS dengan
 * `restoreBackup`: koneksi ditutup lebih dulu (wajib di Android), berkas
 * database di-rename menjadi `.previous` (BUKAN langsung dihapus), lalu
 * `.previous` baru dihapus di akhir. Konsekuensi yang disengaja: kalau
 * proses terhenti di antara dua langkah itu, `getDb()` akan MEMULIHKAN
 * `.previous` saat aplikasi dibuka lagi — artinya kegagalan selalu
 * mengarah ke "data kembali utuh, reset perlu diulang", bukan ke
 * "database rusak setengah jalan".
 *
 * Audit log TIDAK bisa dicatat di database baru (isinya kosong dan
 * user-nya pun sudah tidak ada). Karena itu jejaknya dicatat di database
 * LAMA sebelum berkasnya dilepas — jejak itu ikut tersimpan di dalam
 * salinan pengaman, satu-satunya tempat yang masih bisa dibaca setelah
 * reset total.
 */
export async function resetTotal(actingUserId: string): Promise<HasilReset> {
  await pastikanAdmin(actingUserId);

  const pengaman = await buatSalinanPengaman(actingUserId, 'TOTAL');

  await catatAuditReset(
    actingUserId,
    `${LABEL_MODE.TOTAL}: seluruh berkas database dihapus. Salinan pengaman: ${
      pengaman.nama ?? 'GAGAL DIBUAT'
    }.`
  );

  const liveDbPath = getDatabaseFilePath();
  const previousPath = `${liveDbPath}.previous`;

  await closeDb();

  await FileSystem.deleteAsync(previousPath, { idempotent: true }); // sisa proses sebelumnya, bila ada
  const liveInfo = await FileSystem.getInfoAsync(liveDbPath);
  if (liveInfo.exists) {
    await FileSystem.moveAsync({ from: liveDbPath, to: previousPath });
  }
  await FileSystem.deleteAsync(`${liveDbPath}-wal`, { idempotent: true });
  await FileSystem.deleteAsync(`${liveDbPath}-shm`, { idempotent: true });

  // TITIK TIDAK BISA KEMBALI: sebelum baris ini, gangguan apa pun akan
  // dipulihkan oleh getDb(); sesudahnya, database lama benar-benar hilang.
  await FileSystem.deleteAsync(previousPath, { idempotent: true });

  // Buka koneksi baru — `getDb()` membuat skema kosong & menjalankan
  // seed/migrasi seperti pada pemasangan pertama.
  await getDb();

  // Sesi lama menunjuk user yang sudah tidak ada lagi.
  await logout();

  return {
    mode: 'TOTAL',
    totalBarisTerhapus: 0, // seluruh berkas dilepas, bukan dihitung per baris
    salinanPengaman: pengaman.nama,
    peringatanSalinanPengaman: pengaman.peringatan,
    perluSetupUlang: true,
  };
}

/** Titik masuk tunggal yang dipakai layar — memilih jalur berdasarkan mode. */
export async function jalankanResetData(actingUserId: string, mode: ModeResetData): Promise<HasilReset> {
  return mode === 'TOTAL' ? resetTotal(actingUserId) : resetDataTransaksi(actingUserId);
}

import * as SQLite from 'expo-sqlite';
import { TABEL_RESET_TRANSAKSI, TABEL_DIPERTAHANKAN_TRANSAKSI } from './ResetDataPlan';

/**
 * RC-S99 — EKSEKUSI SQL "Hapus Data Transaksi".
 *
 * Dipisah dari `ResetDataService.ts` DENGAN SENGAJA: berkas ini hanya
 * menerima `db` sebagai parameter dan tidak menyentuh berkas, izin, atau
 * state aplikasi, sehingga penghapusan yang KONSEKUENSINYA PERMANEN bisa
 * dijalankan sungguhan di dalam test terhadap SQLite nyata — bukan cuma
 * dibaca dan diyakini benar. Konvensi yang sama dipakai
 * `EksekusiImportDataAwal` vs `ImportDataAwalService` dan
 * `BackupValidator` vs `BackupService`.
 */

/** Satu kelompok data yang dilaporkan ke pengguna sebelum ia memutuskan. */
export interface KelompokRingkasanData {
  label: string;
  /** Tabel yang jumlah barisnya dijumlahkan untuk kelompok ini. */
  tabel: string[];
  jumlah: number;
}

/**
 * Kelompok yang DITAMPILKAN di layar konfirmasi. Sengaja memakai istilah
 * yang dikenal pengurus koperasi, bukan nama tabel — tapi `tabel`-nya
 * tetap disebutkan supaya angka yang muncul di layar bisa dilacak ke
 * sumbernya, dan supaya test bisa memastikan tidak ada kelompok yang
 * menghitung tabel di luar daftar hapus.
 */
export const KELOMPOK_RINGKASAN: readonly { label: string; tabel: string[] }[] = [
  { label: 'Anggota', tabel: ['anggota'] },
  { label: 'Transaksi simpanan', tabel: ['simpanan_transaksi'] },
  { label: 'Simpanan berjangka', tabel: ['simpanan_berjangka'] },
  { label: 'Pinjaman', tabel: ['pinjaman'] },
  { label: 'Pembayaran angsuran', tabel: ['angsuran_pembayaran'] },
  { label: 'Transaksi kas, bank & RAK', tabel: ['kas_transaksi', 'bank_transaksi', 'rak_transaksi'] },
  { label: 'Aset tetap', tabel: ['aset_tetap'] },
  { label: 'Investasi', tabel: ['investasi'] },
  { label: 'Utang koperasi', tabel: ['utang', 'pinjaman_koperasi'] },
  { label: 'Jurnal (beserta barisnya)', tabel: ['journal'] },
  { label: 'Perhitungan & pembagian SHU', tabel: ['shu_konfigurasi', 'shu_anggota'] },
  { label: 'Saldo awal akun', tabel: ['saldo_awal_akun'] },
];

async function hitungBaris(db: SQLite.SQLiteDatabase, tabel: string): Promise<number> {
  // Nama tabel BUKAN berasal dari input pengguna — seluruhnya konstanta
  // di `ResetDataPlan`/`KELOMPOK_RINGKASAN`, dan nama tabel memang tidak
  // bisa di-bind sebagai parameter SQL. `pastikanTabelTerdaftar` di bawah
  // menjadi penjaga tambahan supaya tidak ada nama sembarangan yang
  // pernah sampai ke sini.
  pastikanTabelTerdaftar(tabel);
  const row = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tabel}`);
  return Number(row?.n ?? 0);
}

/**
 * Penjaga terakhir sebelum sebuah nama tabel masuk ke string SQL. Hanya
 * tabel yang terdaftar di `ResetDataPlan` (salah satu dari dua daftar)
 * yang boleh lewat. Melempar, bukan mengembalikan false: ini kondisi
 * "tidak mungkin terjadi" yang kalau terjadi berarti ada bug, dan bug
 * pada fitur penghapusan harus berhenti keras.
 */
export function pastikanTabelTerdaftar(tabel: string): void {
  const dikenal =
    TABEL_RESET_TRANSAKSI.includes(tabel) || TABEL_DIPERTAHANKAN_TRANSAKSI.includes(tabel);
  if (!dikenal) {
    throw new Error(
      `[ResetData] Tabel '${tabel}' tidak terdaftar di ResetDataPlan. ` +
        `Setiap tabel wajib diklasifikasikan eksplisit sebagai dihapus atau dipertahankan.`
    );
  }
}

/** Jumlah baris per kelompok — dipakai layar konfirmasi supaya dampaknya konkret, bukan abstrak. */
export async function hitungRingkasanDataTransaksi(
  db: SQLite.SQLiteDatabase
): Promise<KelompokRingkasanData[]> {
  const hasil: KelompokRingkasanData[] = [];
  for (const kelompok of KELOMPOK_RINGKASAN) {
    let jumlah = 0;
    for (const tabel of kelompok.tabel) jumlah += await hitungBaris(db, tabel);
    hasil.push({ label: kelompok.label, tabel: kelompok.tabel, jumlah });
  }
  return hasil;
}

export interface HasilResetTransaksi {
  /** Jumlah baris terhapus per tabel — hanya tabel yang memang ada isinya. */
  terhapus: Record<string, number>;
  totalBarisTerhapus: number;
}

/**
 * Kosongkan seluruh tabel data operasional DALAM SATU TRANSAKSI.
 *
 * Tiga hal yang membuat ini tidak bisa meninggalkan database setengah
 * terhapus:
 *
 *  1. SATU transaksi. Kalau ada satu DELETE yang gagal, seluruhnya
 *     di-rollback — tidak ada keadaan "anggota sudah hilang tapi
 *     jurnalnya masih ada".
 *  2. `PRAGMA foreign_key_check` dijalankan SEBELUM commit. Kalau urutan
 *     penghapusan di `TABEL_RESET_TRANSAKSI` suatu saat menjadi salah
 *     karena ada relasi baru, pemeriksaan ini menemukan orphan-nya dan
 *     transaksinya dibatalkan. Foreign key TIDAK pernah dimatikan di
 *     sini — invarian aplikasi ini adalah FK selalu ON
 *     (lihat `assertForeignKeysEnabled` di database/db.ts).
 *  3. Tabel yang dipertahankan TIDAK pernah disebut dalam satu pun
 *     perintah DELETE — daftarnya terpisah dan `pastikanTabelTerdaftar`
 *     menjaga tidak ada nama lain yang menyelip.
 *
 * `withTransaction` TIDAK dipakai di sini supaya berkas ini tetap bebas
 * dari `@/database/db` (yang menarik expo-file-system); transaksinya
 * dikelola langsung, termasuk ROLLBACK pada jalur gagal.
 */
export async function resetDataTransaksiPadaDb(
  db: SQLite.SQLiteDatabase
): Promise<HasilResetTransaksi> {
  const terhapus: Record<string, number> = {};
  let totalBarisTerhapus = 0;

  await db.execAsync('BEGIN');
  try {
    // RC-S132 — app_user dipertahankan, tetapi anggota dihapus: tautan
    // user ANGGOTA -> anggota (v80) diputus lebih dulu supaya tidak ada
    // referensi menggantung. Akunnya tetap ada; Admin dapat menautkannya
    // lagi ke anggota baru di User Management.
    const kolomUser = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(app_user)`);
    if (kolomUser.some((k) => k.name === 'anggota_id')) {
      await db.runAsync(`UPDATE app_user SET anggota_id = NULL WHERE anggota_id IS NOT NULL`);
    }
    for (const tabel of TABEL_RESET_TRANSAKSI) {
      pastikanTabelTerdaftar(tabel);
      const sebelum = await hitungBaris(db, tabel);
      if (sebelum === 0) continue;
      await db.execAsync(`DELETE FROM ${tabel}`);
      terhapus[tabel] = sebelum;
      totalBarisTerhapus += sebelum;
    }

    const orphan = await db.getAllAsync<Record<string, unknown>>('PRAGMA foreign_key_check');
    if (orphan.length > 0) {
      throw new Error(
        `[ResetData] Penghapusan dibatalkan: ${orphan.length} referensi menggantung terdeteksi. ` +
          `Urutan TABEL_RESET_TRANSAKSI perlu diperbarui untuk relasi baru pada skema.`
      );
    }

    await db.execAsync('COMMIT');
  } catch (e) {
    // Rollback dibungkus try sendiri: kalau rollback juga gagal, yang
    // dilempar harus tetap kesalahan ASLINYA, bukan kesalahan rollback
    // yang menutupi penyebabnya.
    try {
      await db.execAsync('ROLLBACK');
    } catch {
      /* diabaikan — lihat alasan di atas */
    }
    throw e;
  }

  return { terhapus, totalBarisTerhapus };
}

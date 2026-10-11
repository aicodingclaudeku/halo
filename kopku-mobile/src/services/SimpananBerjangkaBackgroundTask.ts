import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import { bolehMenjalankanTugasOtomatis } from '@/sync/SyncKebijakan';
import { jalankanCatchUpAkrualSimpananBerjangka } from '@/services/SimpananBerjangkaCatchUpService';

/**
 * ============================================================
 * BACKGROUND TASK — AKRUAL BUNGA SIMPANAN BERJANGKA
 * ============================================================
 *
 * API: `expo-task-manager` + `expo-background-task` (paket resmi Expo
 * untuk SDK 54, pengganti `expo-background-fetch` yang sudah usang).
 * Versi Expo TIDAK dinaikkan untuk fitur ini.
 *
 * PERAN TASK INI SANGAT TERBATAS — DAN ITU DISENGAJA:
 * ia hanya MEMICU `jalankanCatchUpAkrualSimpananBerjangka()`. Ia tidak
 * menghitung bunga, tidak menentukan periode, dan tidak membuat jurnal
 * sendiri. Seluruh kelayakan akrual ditentukan dari tanggal berjalan
 * dibandingkan periode yang belum terakru (§44), sehingga:
 *
 *   - kalau OS menunda task berhari-hari, tidak ada bunga yang hilang;
 *   - kalau OS tidak pernah menjalankannya sama sekali, catch-up saat
 *     startup/fokus layar tetap menutupinya;
 *   - kalau task berjalan dua kali, tidak ada akrual ganda.
 *
 * Artinya ketepatan akuntansi TIDAK PERNAH bergantung pada ketepatan
 * waktu scheduler. Background task murni optimasi kenyamanan.
 *
 * TIDAK ADA setTimeout/setInterval di sini (§45): timer JavaScript mati
 * bersama proses aplikasi dan tidak pernah bisa menjadi penjadwal
 * akuntansi.
 */

export const NAMA_TASK_AKRUAL_BERJANGKA = 'KOPKU_SIMPANAN_BERJANGKA_BUNGA';

/**
 * Interval minimum yang DIMINTA ke OS (menit). OS bebas mengabaikannya
 * — iOS khususnya menjadwalkan berdasarkan pola pemakaian, bukan angka
 * ini. Nilainya sengaja harian: bunga diakru per periode BULANAN, jadi
 * frekuensi lebih rapat tidak menambah ketepatan apa pun.
 */
const INTERVAL_MINIMUM_MENIT = 60 * 24;

/**
 * User yang tercatat sebagai pembuat jurnal akrual dari jalur latar.
 * Diisi saat registrasi (dari sesi aktif) supaya jurnal latar tetap
 * punya `created_by` yang valid untuk audit trail — bukan identitas
 * yang dikarang di dalam task.
 */
let userIdUntukTaskLatar: string | null = null;

/**
 * Definisi task didaftarkan pada level modul, seperti disyaratkan
 * TaskManager: definisi harus sudah ada saat JS bundle dimuat, sebelum
 * OS berpotensi membangunkan aplikasi.
 *
 * Dibungkus try/catch karena `defineTask` melempar pada lingkungan yang
 * tidak punya modul native (mis. Expo Go tanpa dev build, atau
 * lingkungan test). Kegagalan di sini TIDAK BOLEH menjatuhkan aplikasi —
 * catch-up foreground tetap bekerja tanpa background task.
 */
try {
  if (!TaskManager.isTaskDefined(NAMA_TASK_AKRUAL_BERJANGKA)) {
    TaskManager.defineTask(NAMA_TASK_AKRUAL_BERJANGKA, async () => {
      if (!userIdUntukTaskLatar) {
        // Belum ada sesi yang mendaftarkan identitas — jangan menjurnal
        // atas nama siapa pun. Foreground catch-up akan menutupinya.
        return BackgroundTask.BackgroundTaskResult.Success;
      }
      // Sinkron HP⇄Desktop: perangkat pendamping tidak menjurnal otomatis
      // (selalu lolos bila perangkat tidak pernah dipasangkan).
      if (!(await bolehMenjalankanTugasOtomatis())) return BackgroundTask.BackgroundTaskResult.Success;
      await jalankanCatchUpAkrualSimpananBerjangka(userIdUntukTaskLatar);
      // Selalu Success: "tidak ada pekerjaan" bukan kegagalan, dan
      // kegagalan per kontrak sudah dikumpulkan di dalam catch-up tanpa
      // dilempar. Melaporkan Failed akan membuat OS menurunkan prioritas
      // penjadwalan tanpa alasan.
      return BackgroundTask.BackgroundTaskResult.Success;
    });
  }
} catch {
  // Lingkungan tanpa modul native — diabaikan dengan sengaja.
}

/**
 * Mendaftarkan task ke OS. Aman dipanggil setiap kali aplikasi masuk
 * fase READY.
 *
 * §42 — TIDAK PERNAH mendaftarkan duplikat: `isTaskRegisteredAsync()`
 * diperiksa lebih dulu, jadi membuka aplikasi sepuluh kali tetap
 * menghasilkan SATU task terdaftar.
 *
 * Tidak pernah melempar: perangkat/lingkungan yang tidak mendukung
 * background task (Expo Go, emulator tertentu, pengguna yang mematikan
 * Background App Refresh) harus tetap bisa memakai aplikasi — akrual
 * mereka ditangani catch-up foreground.
 */
export async function daftarkanTaskAkrualBerjangka(userId: string): Promise<boolean> {
  userIdUntukTaskLatar = userId;
  try {
    if (!TaskManager.isTaskDefined(NAMA_TASK_AKRUAL_BERJANGKA)) return false;

    const sudahTerdaftar = await TaskManager.isTaskRegisteredAsync(NAMA_TASK_AKRUAL_BERJANGKA);
    if (sudahTerdaftar) return true;

    await BackgroundTask.registerTaskAsync(NAMA_TASK_AKRUAL_BERJANGKA, {
      minimumInterval: INTERVAL_MINIMUM_MENIT,
    });
    return true;
  } catch {
    return false;
  }
}

/** Melepas registrasi task. Dipakai saat logout / reset aplikasi. */
export async function batalkanTaskAkrualBerjangka(): Promise<void> {
  userIdUntukTaskLatar = null;
  try {
    if (await TaskManager.isTaskRegisteredAsync(NAMA_TASK_AKRUAL_BERJANGKA)) {
      await BackgroundTask.unregisterTaskAsync(NAMA_TASK_AKRUAL_BERJANGKA);
    }
  } catch {
    // Diabaikan — pelepasan registrasi bukan operasi kritis.
  }
}

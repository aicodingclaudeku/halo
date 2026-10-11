/**
 * WAKTU TEPERCAYA & DETEKSI CLOCK ROLLBACK (§9)
 * =========================================================================
 *
 * Masalahnya sederhana: seluruh kebijakan lisensi bergantung pada waktu
 * (kedaluwarsa trial, umur grace period), sedangkan `Date.now()` di
 * perangkat sepenuhnya dikendalikan pengguna. Memundurkan jam adalah
 * cara paling murah untuk memperpanjang trial atau grace period tanpa
 * menyentuh kode sama sekali.
 *
 * ---------------------------------------------------------------------
 * MEKANISME: HIGH-WATER MARK MONOTONIK
 * ---------------------------------------------------------------------
 * Kita menyimpan `clockHighWater` = waktu TERTINGGI yang pernah kita
 * yakini benar. Nilai itu naik dari dua sumber:
 *   - waktu server pada setiap verifikasi yang berhasil (sumber terkuat);
 *   - jam perangkat sendiri, setiap kali ia melampaui high-water.
 *
 * Waktu efektif yang dipakai SEMUA keputusan lisensi adalah:
 *
 *     effectiveNow = max(Date.now(), clockHighWater)
 *
 * Konsekuensinya, memundurkan jam TIDAK menghasilkan apa pun:
 *   - trial tidak jadi lebih panjang (perbandingan tetap pakai nilai
 *     tertinggi yang pernah tercatat);
 *   - grace period tidak ter-reset (umurnya dihitung dari effectiveNow).
 * Memajukan jam juga tidak menguntungkan — ia hanya MEMPERCEPAT
 * kedaluwarsa dan memaksa verifikasi lebih awal.
 *
 * ---------------------------------------------------------------------
 * KENAPA `Date.now()` TETAP DIPAKAI SEBAGAI SALAH SATU MASUKAN
 * ---------------------------------------------------------------------
 * React Native tidak menyediakan monotonic clock yang bertahan melewati
 * reboot. `performance.now()` di-reset setiap proses dimulai, jadi ia
 * tidak bisa membedakan "aplikasi baru dibuka" dari "jam dimundurkan".
 * Jadi jam perangkat memang satu-satunya sumber waktu lokal yang ada —
 * yang bisa kita lakukan adalah memastikan ia hanya boleh membuat
 * keputusan LEBIH KETAT, tidak pernah lebih longgar. Itulah yang
 * dilakukan `max()` di atas.
 *
 * BATASAN JUJUR: pengguna yang menghapus data aplikasi ikut menghapus
 * high-water mark. Tetapi itu juga menghapus token lisensinya, jadi
 * hasil akhirnya adalah layar aktivasi — bukan trial yang diperpanjang.
 */

import { LICENSE_CLOCK_ROLLBACK_TOLERANCE_MS } from '@/config/license';
import {
  readClockHighWater,
  readClockSuspicious,
  writeClockHighWater,
  writeClockSuspicious,
} from './licenseStore';

export interface TrustedTime {
  /** Waktu yang harus dipakai untuk SEMUA keputusan lisensi (epoch ms). */
  readonly effectiveNowMs: number;
  /** Jam mentah perangkat, hanya untuk diagnostik/tampilan. */
  readonly deviceNowMs: number;
  /** Nilai tertinggi yang pernah tercatat sebelum panggilan ini. */
  readonly highWaterMs: number | null;
  /** `true` bila jam perangkat mundur melewati toleransi. */
  readonly rollbackDetected: boolean;
}

/**
 * Baca waktu tepercaya dan perbarui high-water mark.
 *
 * Efek samping (menulis high-water) disengaja ada di sini, bukan di
 * pemanggil: kalau pembaruan itu opsional, cepat atau lambat ada jalur
 * kode yang lupa memanggilnya dan diam-diam melemahkan proteksi.
 */
export async function getTrustedNow(): Promise<TrustedTime> {
  const deviceNowMs = Date.now();
  const highWaterMs = await readClockHighWater();
  const previouslySuspicious = await readClockSuspicious();

  if (highWaterMs === null) {
    await writeClockHighWater(deviceNowMs);
    return {
      effectiveNowMs: deviceNowMs,
      deviceNowMs,
      highWaterMs: null,
      rollbackDetected: previouslySuspicious,
    };
  }

  const rollbackNow = deviceNowMs < highWaterMs - LICENSE_CLOCK_ROLLBACK_TOLERANCE_MS;
  let suspicious = previouslySuspicious;

  if (rollbackNow && !previouslySuspicious) {
    await writeClockSuspicious(true);
    suspicious = true;
  }

  if (deviceNowMs > highWaterMs) {
    await writeClockHighWater(deviceNowMs);
    // Jam sudah melampaui catatan tertinggi lagi — perangkat ini tidak
    // lagi berada di masa lalu, jadi penandaannya dilepas. Penandaan itu
    // memang bukan hukuman; ia hanya sinyal untuk UI & kebijakan
    // verifikasi.
    //
    // `suspicious` ikut diperbarui, BUKAN hanya nilai di penyimpanan.
    // Sebelumnya nilai balik masih memakai `previouslySuspicious`,
    // sehingga panggilan yang BARU SAJA membersihkan penandaan tetap
    // melaporkan `rollbackDetected: true` — dan pemanggil melihat
    // jawaban yang bertentangan dengan isi penyimpanan.
    if (previouslySuspicious) {
      await writeClockSuspicious(false);
      suspicious = false;
    }
  }

  return {
    effectiveNowMs: Math.max(deviceNowMs, highWaterMs),
    deviceNowMs,
    highWaterMs,
    rollbackDetected: rollbackNow || suspicious,
  };
}

/**
 * Helper yang diminta §9 secara eksplisit. Read-only: TIDAK mengubah
 * high-water, supaya bisa dipanggil dari UI kapan saja tanpa efek samping.
 */
export async function isClockRollbackDetected(): Promise<boolean> {
  const highWaterMs = await readClockHighWater();
  if (highWaterMs === null) {
    return readClockSuspicious();
  }
  if (Date.now() < highWaterMs - LICENSE_CLOCK_ROLLBACK_TOLERANCE_MS) {
    return true;
  }
  return readClockSuspicious();
}

/**
 * Naikkan high-water mark memakai waktu dari server. Dipanggil setiap
 * kali server menjawab (valid maupun tidak) — header `Date` server tetap
 * bukti waktu yang lebih baik daripada jam perangkat.
 *
 * HANYA MAJU, tidak pernah mundur: server yang jamnya keliru ke belakang
 * tidak boleh membuka kembali trial yang sudah lewat.
 *
 * CATATAN — kenapa fungsi ini TIDAK membersihkan penandaan "jam
 * mencurigakan". Versi pertama melakukannya, dengan alasan "waktu
 * server lebih tepercaya daripada jam lokal". Alasan itu keliru arah:
 * waktu server yang jauh di depan jam perangkat justru MEMBUKTIKAN jam
 * perangkat salah, bukan membersihkannya. Penandaan hanya boleh
 * dilepas oleh `getTrustedNow()`, saat jam perangkat sendiri benar-
 * benar melampaui high-water — yaitu saat perangkat memang sudah tidak
 * berada di masa lalu lagi.
 */
export async function recordServerTime(serverTimeMs: number): Promise<void> {
  if (!Number.isFinite(serverTimeMs) || serverTimeMs <= 0) return;
  const current = await readClockHighWater();
  if (current === null || serverTimeMs > current) {
    await writeClockHighWater(serverTimeMs);
  }
}

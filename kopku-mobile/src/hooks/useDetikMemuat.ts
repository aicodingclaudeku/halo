import { useLayoutEffect, useState } from 'react';

/**
 * RC-S74 — FINAL INTEREST CALCULATION LOADING UX.
 *
 * Penghitung WAKTU BERJALAN (elapsed time) untuk TAMPILAN loading saja.
 *
 * YANG DILAKUKAN:
 *  - mencatat saat loading dimulai, lalu setiap detik menghitung ulang
 *    selisih `Date.now() - mulai` (waktu nyata, bukan jumlah tik — tik yang
 *    tertunda tidak membuat angkanya bergeser);
 *  - berhenti (clearInterval) ketika loading selesai, gagal, kunci berganti
 *    (utang lain / "Coba lagi"), atau layar di-unmount.
 *
 * YANG SENGAJA TIDAK DILAKUKAN:
 *  - bukan scheduler/polling/retry/trigger: timer ini tidak memanggil service,
 *    database, mesin akrual, atau tugas startup apa pun — ia TIDAK menentukan
 *    kapan data siap. Kesiapan data tetap ditentukan promise nyata
 *    `tungguTugasStartupSelesai()` -> `getStatusBungaSemuaUtang()` di layar;
 *  - hook ini sendiri tidak menghitung ETA. Sejak hotfix RC-S74 (estimasi
 *    real-time) ia boleh diberi TITIK MULAI nyata (`mulaiMs` = saat batch
 *    StartupTasks mulai), sehingga waktu berjalan diukur dari proses yang
 *    sebenarnya, bukan dari saat layar dibuka. Sisa estimasi dihitung helper
 *    murni `teksMemuatBunga` di `bayarUtangGate.ts`.
 *
 * Modul ini sengaja hanya mengimpor `react` (diverifikasi test RC-S74).
 */

/** Detik penuh yang sudah berlalu sejak `mulaiMs` (tidak pernah negatif). */
export function hitungDetikBerjalan(mulaiMs: number, sekarangMs: number): number {
  return Math.max(0, Math.floor((sekarangMs - mulaiMs) / 1000));
}

export interface PenghitungDetik {
  /** Menghentikan interval. Aman dipanggil berulang. */
  berhenti(): void;
}

/**
 * Mulai menghitung waktu berjalan: nilai aktual segera (0 bila `mulaiMs`
 * tidak diberikan), lalu nilai aktual tiap detik. Satu interval per
 * pemanggilan; `berhenti()` membersihkannya. `mulaiMs` = titik mulai proses
 * yang sebenarnya (boleh lebih awal dari saat penghitung dipasang).
 */
export function mulaiPenghitungDetik(
  onDetik: (detik: number) => void,
  sekarang: () => number = Date.now,
  mulaiMs: number = sekarang()
): PenghitungDetik {
  onDetik(hitungDetikBerjalan(mulaiMs, sekarang()));
  let id: ReturnType<typeof setInterval> | null = setInterval(() => onDetik(hitungDetikBerjalan(mulaiMs, sekarang())), 1000);
  return {
    berhenti() {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    },
  };
}

/**
 * Detik berjalan selama `aktif` (mis. tahap MEMUAT). Kembali ke 0 dan
 * berhenti saat `aktif` false. `kunci` memulai hitungan baru untuk
 * pemuatan baru (utang lain / muat ulang manual). `mulaiMs` (opsional) =
 * saat proses latar yang ditunggu benar-benar mulai; null = saat efek aktif.
 *
 * `useLayoutEffect` (bukan `useEffect`) supaya nilai lama dari pemuatan
 * sebelumnya tidak sempat tergambar satu frame sebelum direset.
 */
export function useDetikMemuat(aktif: boolean, kunci: string, mulaiMs: number | null = null): number {
  const [detik, setDetik] = useState(0);
  useLayoutEffect(() => {
    if (!aktif) {
      setDetik(0);
      return;
    }
    const penghitung = mulaiMs === null ? mulaiPenghitungDetik(setDetik) : mulaiPenghitungDetik(setDetik, Date.now, mulaiMs);
    return () => penghitung.berhenti();
  }, [aktif, kunci, mulaiMs]);
  return detik;
}

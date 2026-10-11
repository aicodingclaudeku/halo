/**
 * TANGGAL KALENDER LOKAL — KOPKU
 * ------------------------------------------------------------
 * Satu-satunya sumber "hari ini" untuk keperluan AKUNTANSI.
 *
 * MASALAH YANG DIPERBAIKI (permintaan pengguna, fix timezone):
 * `new Date().toISOString().slice(0, 10)` SELALU menghasilkan tanggal
 * menurut UTC, sedangkan koperasi bekerja dengan kalender LOKAL.
 * Indonesia berada di UTC+7 (WIB), UTC+8 (WITA), dan UTC+9 (WIT) —
 * seluruhnya DI DEPAN UTC. Akibatnya, setiap hari antara tengah malam
 * lokal dan pukul 07:00/08:00/09:00 pagi lokal, `toISOString()` masih
 * mengembalikan tanggal KEMARIN.
 *
 * Contoh nyata (WIB, UTC+7):
 *   waktu lokal : 2026-09-02 00:05
 *   UTC         : 2026-09-01 17:05
 *   toISOString().slice(0,10) -> '2026-09-01'   <-- SALAH, mundur 1 hari
 *   getTanggalLokalHariIni()  -> '2026-09-02'   <-- BENAR
 *
 * Untuk akrual jasa pinjaman, selisih satu hari itu berarti angsuran
 * yang jatuh tempo 2026-09-02 TIDAK diakru sepanjang pagi hari tanggal
 * 2 September — persis bug yang dilaporkan.
 *
 * CATATAN PENTING:
 *  - Offset zona waktu TIDAK di-hardcode (+07:00 dst). Fungsi di sini
 *    memakai getFullYear()/getMonth()/getDate() yang otomatis mengikuti
 *    zona waktu runtime/perangkat, jadi benar untuk WIB, WITA, maupun
 *    WIT tanpa konfigurasi apa pun.
 *  - Helper ini HANYA untuk CALENDAR DATE ('YYYY-MM-DD'). Timestamp
 *    audit (`created_at`, kolom audit_log `tanggal` + `waktu` yang
 *    berpasangan) SENGAJA tetap memakai `toISOString()` UTC — mengubah
 *    salah satunya saja justru akan membuat pasangan tanggal/waktu itu
 *    tidak konsisten.
 *  - `date-fns` `format(tanggal, 'yyyy-MM-dd')` SUDAH berbasis waktu
 *    lokal, jadi call site yang memakainya TIDAK bermasalah dan TIDAK
 *    diubah.
 *
 * MODE PENGUJIAN WAKTU (menu Developer, dikunci password): fungsi di
 * bawah memakai `getWaktuSekarang()` dari `DevClockService`, BUKAN
 * `new Date()` langsung. Secara default (mode pengujian mati) itu
 * PERSIS `new Date()` — tidak ada perubahan perilaku sampai seorang
 * developer secara eksplisit menyalakan simulasi waktu. Lihat
 * `services/DevClockService.ts` untuk detail & alasan kenapa timestamp
 * audit (`created_at` dst.) SENGAJA TIDAK ikut disimulasikan.
 */

import { getWaktuSekarang } from '@/services/DevClockService';

/** Format sebuah `Date` menjadi tanggal kalender LOKAL 'YYYY-MM-DD'. */
export function toTanggalLokal(tanggal: Date): string {
  const tahun = tanggal.getFullYear();
  const bulan = String(tanggal.getMonth() + 1).padStart(2, '0');
  const hari = String(tanggal.getDate()).padStart(2, '0');
  return `${tahun}-${bulan}-${hari}`;
}

/** Tanggal kalender LOKAL hari ini, 'YYYY-MM-DD'. Pengganti `new Date().toISOString().slice(0, 10)`. */
export function getTanggalLokalHariIni(): string {
  return toTanggalLokal(getWaktuSekarang());
}

/** Periode akuntansi LOKAL bulan berjalan, 'YYYY-MM'. */
export function getPeriodeLokalSekarang(): string {
  return getTanggalLokalHariIni().slice(0, 7);
}

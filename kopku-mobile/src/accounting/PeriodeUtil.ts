/**
 * Helper periode bulanan format 'YYYY-MM', dipakai bersama oleh
 * penyusutan aset & pengakuan pendapatan diterima dimuka (keduanya
 * sama-sama proses "alokasi bertahap per bulan" — logika periodenya
 * identik, jadi disatukan di sini alih-alih diduplikasi).
 */

import { getPeriodeLokalSekarang } from '@/utils/tanggal';

/** Ambil 'YYYY-MM' dari tanggal ISO 'YYYY-MM-DD' (atau timestamp ISO lengkap). */
export function toPeriode(tanggalIso: string): string {
  return tanggalIso.slice(0, 7);
}

/** Validasi format periode 'YYYY-MM'. */
export function isValidPeriode(periode: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(periode);
}

/** Tanggal terakhir bulan pada periode 'YYYY-MM' → 'YYYY-MM-DD'. Dipakai sebagai tanggal jurnal (akhir bulan, praktik umum jurnal penyesuaian bulanan). */
export function tanggalAkhirPeriode(periode: string): string {
  const [tahun, bulan] = periode.split('-').map(Number);
  const hariTerakhir = new Date(tahun, bulan, 0).getDate(); // hari ke-0 bulan berikutnya = hari terakhir bulan ini
  return `${periode}-${String(hariTerakhir).padStart(2, '0')}`;
}

/** Tambah N bulan ke periode 'YYYY-MM', hasil tetap format 'YYYY-MM'. */
export function tambahBulan(periode: string, n: number): string {
  const [tahun, bulan] = periode.split('-').map(Number);
  const total = tahun * 12 + (bulan - 1) + n;
  const tahunBaru = Math.floor(total / 12);
  const bulanBaru = (total % 12) + 1;
  return `${tahunBaru}-${String(bulanBaru).padStart(2, '0')}`;
}

/** Selisih bulan antara dua periode 'YYYY-MM' (b - a). */
export function selisihBulan(a: string, b: string): number {
  const [ta, ma] = a.split('-').map(Number);
  const [tb, mb] = b.split('-').map(Number);
  return (tb * 12 + mb) - (ta * 12 + ma);
}

/**
 * Periode berjalan saat ini ('YYYY-MM') berdasarkan KALENDER LOKAL
 * perangkat. Sebelumnya memakai `new Date().toISOString()` (UTC) —
 * pada dini hari WIB/WITA/WIT itu bisa mengembalikan periode BULAN
 * SEBELUMNYA di tanggal 1 (mis. 2026-10-01 pukul 00:05 WIB dianggap
 * masih '2026-09'). Lihat src/utils/tanggal.ts.
 */
export function periodeSekarang(): string {
  return getPeriodeLokalSekarang();
}

/**
 * SIKLUS HIDUP JADWAL ANGSURAN — SATU SUMBER KEBENARAN.
 * ============================================================
 *
 * BUG-08 / BUG-12 (root cause)
 * ---------------------------
 * Sebelum modul ini ada, setiap service menulis filter status jadwalnya
 * SENDIRI-SENDIRI:
 *
 *   PinjamanService      : status NOT IN ('LUNAS','DIHAPUSBUKU','DIRESTRUKTURISASI')
 *   LoanEligibilityService: (tidak ada filter status sama sekali)
 *   LoanImpairmentService : (tidak ada filter untuk saldo; `!= 'LUNAS'` untuk aging)
 *   DashboardScreen       : `!= 'LUNAS'` untuk tunggakan, tanpa filter untuk piutang
 *   AkrualJasaPinjamanService : (tidak ada filter status sama sekali)
 *
 * Akibatnya, setelah akad ulang (restrukturisasi) baris jadwal LAMA yang
 * sudah ditandai `DIRESTRUKTURISASI` tetap ikut dijumlahkan di
 * outstanding, aging, impairment, eligibility, dan akrual — sementara
 * jadwal BARU juga dihitung. Satu pinjaman 12.000.000 yang direstruktur
 * dua kali bisa terbaca 12M -> 24M -> 38,88M karena baris obsolete
 * bertumpuk. Ini adalah "first divergence" antara subledger dan GL.
 *
 * WHY: lifecycle jadwal adalah aturan BISNIS, bukan detail query.
 * Selama aturan itu diketik ulang di tiap SQL, setiap penambahan status
 * baru (mis. 'DIHAPUSBUKU' di v45) otomatis melewatkan sebagian
 * pemanggil dan menghasilkan angka yang berbeda antar layar untuk data
 * yang sama. Modul ini memaksa SEMUA pemanggil memakai definisi yang
 * sama.
 *
 * DEFINISI (sesuai CHECK constraint `angsuran_jadwal.status` di schema.ts)
 * ----------------------------------------------------------------------
 *   BELUM_BAYAR / SEBAGIAN / TERLAMBAT -> CURRENT  (masih tagihan hidup)
 *   LUNAS                              -> COMPLETED (selesai, sisa = 0)
 *   DIRESTRUKTURISASI / DIHAPUSBUKU    -> OBSOLETE  (tidak pernah dihitung lagi)
 *
 * Baris OBSOLETE sengaja TIDAK dihapus dari database — dibutuhkan untuk
 * jejak audit & rekonsiliasi historis. Karena itu pengecualiannya harus
 * terjadi di level query, konsisten di seluruh aplikasi.
 */

/** Seluruh status yang sah untuk `angsuran_jadwal.status`. */
export type StatusJadwalAngsuran =
  | 'BELUM_BAYAR'
  | 'SEBAGIAN'
  | 'TERLAMBAT'
  | 'LUNAS'
  | 'DIHAPUSBUKU'
  | 'DIRESTRUKTURISASI';

/** Jadwal yang masih menjadi tagihan hidup (punya sisa yang bisa ditagih). */
export const CURRENT_SCHEDULE_STATUSES: readonly StatusJadwalAngsuran[] = [
  'BELUM_BAYAR',
  'SEBAGIAN',
  'TERLAMBAT',
];

/** Jadwal yang sudah selesai dibayar penuh. */
export const COMPLETED_SCHEDULE_STATUSES: readonly StatusJadwalAngsuran[] = ['LUNAS'];

/**
 * Jadwal yang sudah tidak berlaku dan TIDAK BOLEH ikut perhitungan apa
 * pun (outstanding, aging, impairment, eligibility, akrual, LHU).
 */
export const OBSOLETE_SCHEDULE_STATUSES: readonly StatusJadwalAngsuran[] = [
  'DIRESTRUKTURISASI',
  'DIHAPUSBUKU',
];

/** TRUE bila jadwal masih menjadi tagihan hidup. */
export function isCurrentRepaymentSchedule(status: string | null | undefined): boolean {
  return CURRENT_SCHEDULE_STATUSES.includes(status as StatusJadwalAngsuran);
}

/** TRUE bila jadwal sudah selesai dibayar penuh. */
export function isCompletedRepaymentSchedule(status: string | null | undefined): boolean {
  return COMPLETED_SCHEDULE_STATUSES.includes(status as StatusJadwalAngsuran);
}

/** TRUE bila jadwal sudah tidak berlaku (digantikan akad ulang / dihapusbukukan). */
export function isObsoleteRepaymentSchedule(status: string | null | undefined): boolean {
  return OBSOLETE_SCHEDULE_STATUSES.includes(status as StatusJadwalAngsuran);
}

/**
 * TRUE bila jadwal ini WAJIB ditandai obsolete ketika terjadi akad ulang
 * (restrukturisasi) atau hapus buku (write-off).
 *
 * WHY fungsi terpisah walau isinya sama dengan `isCurrentRepaymentSchedule`:
 * yang ditanyakan di sini adalah pertanyaan BISNIS yang berbeda —
 * "baris mana yang digantikan oleh jadwal baru", bukan "baris mana yang
 * masih menjadi tagihan hidup". Kebetulan jawabannya sama (setiap
 * tagihan hidup digantikan), tetapi memberinya nama sendiri membuat
 * pemanggil di `akadUlangPinjaman()` / `hapusPiutangPinjaman()` tidak
 * tergoda mengetik ulang daftar status.
 *
 * PENTING — perlakuan 'TERLAMBAT':
 * Status ini sah menurut CHECK constraint `angsuran_jadwal.status`
 * meskipun aplikasi saat ini tidak pernah menulisnya (keterlambatan
 * diturunkan dari tanggal jatuh tempo). Data legacy / import bisa
 * memilikinya. Daftar hardcoded lama `('BELUM_BAYAR','SEBAGIAN')`
 * MELEWATKAN baris seperti itu: jadwal pengganti tetap dibuat sementara
 * baris TERLAMBAT tidak pernah ditandai obsolete, sehingga keduanya
 * dijumlahkan selamanya (double count).
 *
 * Yang benar: baris TERLAMBAT DITANDAI obsolete saat restrukturisasi —
 * BUKAN dihapus, dan BUKAN di-reset menjadi LUNAS. Histori wajib utuh
 * karena dibutuhkan untuk jejak audit dan rekonsiliasi.
 */
export function isScheduleObsoleteForRestructuring(status: string | null | undefined): boolean {
  return isCurrentRepaymentSchedule(status);
}

function daftarSql(statuses: readonly string[]): string {
  return statuses.map((s) => `'${s}'`).join(',');
}

/**
 * Fragmen SQL: jadwal yang masih menjadi tagihan hidup.
 * Dipakai untuk aging/tunggakan/kolektibilitas — di sana baris LUNAS
 * memang harus keluar dari perhitungan.
 */
export function sqlJadwalCurrent(alias = 'aj'): string {
  return `${alias}.status IN (${daftarSql(CURRENT_SCHEDULE_STATUSES)})`;
}

/**
 * Fragmen SQL: jadwal yang BUKAN obsolete (current + completed).
 *
 * Dipakai untuk penjumlahan saldo/outstanding: baris LUNAS menyumbang 0
 * sehingga aman ikut, dan menyertakannya membuat total kontraktual
 * (mis. `SUM(pokok)`) tetap utuh. Yang WAJIB dikeluarkan hanyalah baris
 * obsolete, karena baris itulah yang menyebabkan double count.
 */
export function sqlJadwalBukanObsolete(alias = 'aj'): string {
  return `${alias}.status NOT IN (${daftarSql(OBSOLETE_SCHEDULE_STATUSES)})`;
}

/**
 * Fragmen SQL: jadwal yang masih punya sisa tagihan.
 * Ekuivalen dengan pola lama `status NOT IN ('LUNAS','DIHAPUSBUKU','DIRESTRUKTURISASI')`
 * yang tersebar di PinjamanService — sekarang berasal dari satu tempat.
 */
export function sqlJadwalMasihTertagih(alias = 'aj'): string {
  return `${alias}.status NOT IN (${daftarSql([
    ...COMPLETED_SCHEDULE_STATUSES,
    ...OBSOLETE_SCHEDULE_STATUSES,
  ])})`;
}

/**
 * KEBIJAKAN NON-ACCRUAL — SATU SUMBER KEBENARAN.
 * ============================================================
 *
 * MASALAH YANG DISELESAIKAN
 * -------------------------
 * Sebelum modul ini, keputusan "boleh akru atau tidak" diambil DUA
 * lapis sekaligus:
 *
 *   1. `LoanImpairmentService.klasifikasikanKolektibilitas()` mengubah
 *      hari tunggakan menjadi kategori (LANCAR / DALAM_PERHATIAN /
 *      KURANG_LANCAR / DIRAGUKAN / MACET) dengan ambang 1/91/121/181.
 *   2. `AccountingPolicyService.getNonAccrualMinKolektibilitas()`
 *      membandingkan kategori itu terhadap boundary (default
 *      'DIRAGUKAN').
 *
 * Akibatnya titik non-accrual efektif jatuh di **121 hari**, dan angka
 * itu tidak pernah tertulis di mana pun sebagai kebijakan — ia muncul
 * sebagai efek samping dari dua tabel ambang yang berbeda. Menggeser
 * satu ambang kolektibilitas (keputusan pencadangan) diam-diam
 * menggeser titik non-accrual (keputusan pengakuan pendapatan), padahal
 * keduanya adalah keputusan bisnis yang berbeda.
 *
 * KEPUTUSAN
 * ---------
 * Non-accrual sekarang dinyatakan LANGSUNG dalam HARI TUNGGAKAN:
 *
 *     0–89 hari  -> ACCRUAL
 *     >= 90 hari -> NON_ACCRUAL
 *
 * WHY berbasis hari, bukan kategori: pengakuan pendapatan bergantung
 * pada berapa lama kas belum diterima, bukan pada persentase
 * pencadangan. Menyatakannya dalam hari membuat kebijakannya terbaca
 * apa adanya dan bisa diuji tepat di batasnya (89/90/91).
 *
 * CATATAN PENTING — INI PERUBAHAN KEBIJAKAN, BUKAN SEKADAR REFACTOR.
 * Titik non-accrual bergeser dari 121 hari menjadi 90 hari. Pinjaman
 * yang menunggak 90–120 hari yang SEBELUMNYA masih mengakui pendapatan
 * jasa sekarang BERHENTI mengakuinya. Ini menurunkan pendapatan yang
 * diakui pada periode berjalan untuk pinjaman di rentang tersebut.
 * Perubahan ini diminta eksplisit ("jangan gunakan 121 hari").
 *
 * CATATAN (pasca-peralihan ke SOM Juklat 3/2025): skema 5 kategori yang
 * diceritakan di bagian "MASALAH YANG DISELESAIKAN" di atas sudah tidak
 * ada lagi — penggolongan kolektibilitas sekarang memakai 4 kategori SOM
 * (lihat `@/services/KolektibilitasSomService`). Justru KARENA kebijakan
 * non-accrual sudah dinyatakan langsung dalam HARI di modul ini,
 * peralihan itu TIDAK menggeser titik non-accrual sama sekali. Itulah
 * bukti bahwa pemisahan di modul ini bekerja seperti yang dimaksud.
 *
 * Ambangnya tetap DAPAT DIKONFIGURASI (lihat AccountingPolicyService)
 * karena ini kebijakan koperasi, bukan aturan baku yang boleh diklaim
 * berasal langsung dari standar akuntansi.
 */

/** Ambang default: tunggakan >= 90 hari menghentikan akrual. */
export const HARI_MINIMUM_NON_ACCRUAL_DEFAULT = 90;

export type AccrualStatus = 'ACCRUAL' | 'NON_ACCRUAL';

/**
 * Keputusan tunggal non-accrual. SELURUH modul (akrual jasa, EIR,
 * impairment, LHU, collection, eligibility) wajib memakai fungsi ini —
 * tidak boleh ada perbandingan hari tunggakan terhadap angka literal
 * di tempat lain.
 *
 * @param hariTunggakan  Hari keterlambatan angsuran TERTUA yang masih
 *                       outstanding, dihitung HANYA dari jadwal current
 *                       (lihat ScheduleLifecycle) — setelah akad ulang,
 *                       aging dihitung dari jadwal pengganti, bukan dari
 *                       jadwal lama yang sudah obsolete.
 * @param ambangHari     Ambang kebijakan koperasi. Default 90.
 */
export function getAccrualStatus(
  hariTunggakan: number,
  ambangHari: number = HARI_MINIMUM_NON_ACCRUAL_DEFAULT
): AccrualStatus {
  const hari = Number.isFinite(hariTunggakan) ? Math.floor(hariTunggakan) : 0;
  return hari >= ambangHari ? 'NON_ACCRUAL' : 'ACCRUAL';
}

/** Bentuk boolean dari `getAccrualStatus` untuk pemakaian di percabangan. */
export function isNonAccrual(
  hariTunggakan: number,
  ambangHari: number = HARI_MINIMUM_NON_ACCRUAL_DEFAULT
): boolean {
  return getAccrualStatus(hariTunggakan, ambangHari) === 'NON_ACCRUAL';
}

/** Kalimat alasan yang seragam untuk log/UI, supaya pesan tidak beda-beda antar modul. */
export function alasanNonAccrual(hariTunggakan: number, ambangHari: number): string {
  return (
    `Non-accrual (kebijakan koperasi: tunggakan >= ${ambangHari} hari) — ` +
    `tunggakan ${Math.floor(hariTunggakan)} hari, jasa periode ini tidak diakui sebagai pendapatan.`
  );
}

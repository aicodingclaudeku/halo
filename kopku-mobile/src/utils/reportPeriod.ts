/**
 * Logika MURNI (tanpa I/O/UI) resolusi periode laporan dari SATU
 * tanggal terpilih (update pasca-Phase 18/19, permintaan pengguna
 * §J/§S — sebelumnya 3 mode Tahun/Bulan/Tanggal, SEKARANG hanya satu
 * tanggal). Dipisah dari `components/ReportPeriodPicker.tsx` (yang
 * berisi JSX, tidak bisa di-import langsung oleh test Jest proyek ini
 * — lihat jest.config.js: tidak ada transformer React Native) — pola
 * yang sama dengan PinjamanCalculator.ts/ShuCalculator.ts.
 *
 * Semantik: tanggal yang dipilih user adalah tanggal AS-OF/cutoff.
 * `mulai` dihitung OTOMATIS = awal tahun buku (accounting_period) yang
 * memuat tanggal itu (fallback 1 Januari tahun kalender tanggal itu
 * kalau tidak ada accounting_period yang cocok, mis. instalasi baru
 * belum setup periode) — BUKAN pilihan user secara terpisah. `selesai`
 * = tanggal yang dipilih persis. Ini menjaga laporan (Laba Rugi,
 * Perubahan Ekuitas, Arus Kas, CALK) tetap berupa akumulasi
 * tahun-berjalan-sampai-tanggal-X (year-to-date), TANPA field
 * "Dari"/"Sampai" bebas yang bisa lepas dari tahun buku.
 */

export const NAMA_BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

export interface ResolvedReportPeriod {
  mulai: string;
  selesai: string;
  /** Format Indonesia dari `selesai`, mis. "17 Agustus 2026" — dipakai kartu "UNTUK PERIODE" & export. */
  label: string;
}

export interface AccountingPeriodLike {
  tahunBuku: number;
  periodeMulai: string;
  periodeSelesai: string;
}

export function lastDayOfMonth(tahun: number, bulan1to12: number): number {
  return new Date(tahun, bulan1to12, 0).getDate();
}

const BULAN_NAMA_ID = NAMA_BULAN;

/** Format tanggal ISO (YYYY-MM-DD) ke "D NamaBulan YYYY" — duplikat kecil dari DatePicker.formatTanggalIndonesia supaya file ini bebas import JSX/React Native. */
export function formatTanggalIndonesia(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${BULAN_NAMA_ID[m - 1]} ${y}`;
}

/**
 * Resolusi periode laporan dari SATU tanggal terpilih. `periods`
 * adalah daftar accounting_period existing (dari
 * `PeriodeRepository.listAccountingPeriods()`, TIDAK ada tabel/query
 * baru) — dipakai untuk menentukan awal tahun buku yang memuat
 * tanggal tsb.
 */
export function resolveReportPeriodFromDate(tanggal: string, periods: AccountingPeriodLike[]): ResolvedReportPeriod {
  const match = periods.find((p) => tanggal >= p.periodeMulai && tanggal <= p.periodeSelesai);
  const mulai = match ? match.periodeMulai : `${tanggal.slice(0, 4)}-01-01`;
  return { mulai, selesai: tanggal, label: formatTanggalIndonesia(tanggal) };
}

/**
 * Phase 17 §5/§6/§7 — default periode PEMBANDING untuk mode
 * komparatif: geser mulai & selesai persis setahun ke belakang
 * (BUKAN full-year tahun lalu kalau periode berjalan sendiri bukan
 * full-year — supaya "01-01-2026 → 30-06-2026" dibandingkan ke
 * "01-01-2025 → 30-06-2025", bukan "01-01-2025 → 31-12-2025" yang
 * menyesatkan, sesuai instruksi §5).
 *
 * Kasus 29 Februari (tahun kabisat): digeser ke 28 Februari kalau
 * tahun pembanding bukan kabisat (satu-satunya cara aman menggeser
 * tanggal yang tidak selalu ada tiap tahun) — didokumentasikan di
 * sini, bukan silent bug.
 */
export function geserPeriodeSetahunKeBelakang(periode: { mulai: string; selesai: string }): {
  mulai: string;
  selesai: string;
} {
  const geser = (iso: string): string => {
    const [y, m, d] = iso.split('-').map(Number);
    const tahunBaru = y - 1;
    const hariMaksTahunBaru = lastDayOfMonth(tahunBaru, m);
    const hariAman = Math.min(d, hariMaksTahunBaru); // 29 Feb -> 28 Feb kalau tahun pembanding bukan kabisat
    return `${tahunBaru}-${String(m).padStart(2, '0')}-${String(hariAman).padStart(2, '0')}`;
  };
  return { mulai: geser(periode.mulai), selesai: geser(periode.selesai) };
}

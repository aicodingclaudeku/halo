import Decimal from 'decimal.js';

/**
 * Semua nominal uang disimpan & dihitung sebagai INTEGER Rupiah
 * (PRD §40) — tidak pernah floating point langsung.
 *
 * Untuk perhitungan yang melibatkan persentase (jasa, denda, SHU),
 * gunakan Decimal lalu BULATKAN ke integer Rupiah di titik akhir
 * dengan `roundToRupiah`.
 */

export type Rupiah = number; // integer, no decimals

export function roundToRupiah(value: Decimal | number): Rupiah {
  const d = value instanceof Decimal ? value : new Decimal(value);
  return d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

export function percentageOf(amount: Rupiah, percent: number): Rupiah {
  return roundToRupiah(new Decimal(amount).mul(percent).div(100));
}

export function sum(values: Rupiah[]): Rupiah {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * BUG FIX (permintaan pengguna — "format Rupiah negatif"): SEBELUMNYA
 * `'Rp' + value.toLocaleString('id-ID')` untuk nilai negatif
 * menghasilkan "Rp-5.000.000" (minus SETELAH "Rp", tidak salah secara
 * matematis — tandanya tetap ada, tidak hilang — tapi tidak konsisten
 * dengan konvensi format Rupiah negatif yang lazim "-Rp5.000.000",
 * minus DI DEPAN). Fix: pisahkan tanda dari nilai absolut, taruh minus
 * di depan "Rp". Nilai 0/positif TIDAK berubah sama sekali (backward
 * compatible penuh) — HANYA nilai negatif yang formatnya disesuaikan.
 * Tanda MINUS TIDAK PERNAH hilang di kedua versi — perbaikan ini murni
 * kosmetik penempatan tanda, bukan perbaikan "data negatif hilang"
 * (itu ada di lapisan lain, lihat Ledger.ts getTrialBalance).
 */
export function formatRupiah(value: Rupiah): string {
  const formatted = 'Rp' + Math.abs(value).toLocaleString('id-ID');
  return value < 0 ? '-' + formatted : formatted;
}

/**
 * RC-S98 — nominal PENGURANG bergaya laporan keuangan resmi: "(Rp1.000)".
 *
 * Juklat SOM No. 3/2025 Lampiran 1 menulis setiap beban di dalam tanda
 * kurung — "(4.700.000)" — bukan dengan tanda minus. Tanda kuranglah yang
 * menyatakan "dikurangkan", sehingga `value` yang masuk ke sini TETAP
 * magnitudo positif seperti yang dikembalikan `getLHU()`; pemanggil TIDAK
 * perlu membalik tanda dan angka TIDAK berubah warna menjadi merah
 * (merah di aplikasi ini berarti "nilai negatif", arti yang berbeda).
 *
 * Dua kasus batas yang disengaja:
 * - 0 -> "Rp0" (bukan "(Rp0)"): nol bukan pengurangan, dan "(Rp0)" hanya
 *   membingungkan.
 * - value < 0 -> "Rp<abs>" tanpa kurung: pengurang yang bernilai negatif
 *   (mis. pembalikan beban melebihi bebannya) sebenarnya MENAMBAH hasil
 *   usaha, jadi menyajikannya di dalam kurung akan menyesatkan.
 */
export function formatRupiahPengurang(value: Rupiah): string {
  if (value <= 0) return formatRupiah(-value);
  return `(${formatRupiah(value)})`;
}

export function isBalanced(totalDebit: Rupiah, totalKredit: Rupiah): boolean {
  return totalDebit === totalKredit;
}

/**
 * PHASE 6 §B/§O (permintaan pengguna) — persentase perubahan untuk
 * laporan komparatif (Posisi Keuangan & Hasil Usaha). Kalau saldo
 * pembanding = 0, JANGAN menghasilkan Infinity/NaN — kembalikan `—`
 * (dash) supaya UI tinggal menampilkan apa adanya, tidak perlu
 * penanganan khusus di setiap layar.
 */
export function formatPersentasePerubahan(sekarang: Rupiah, pembanding: Rupiah): string {
  if (pembanding === 0) return '—';
  const persen = ((sekarang - pembanding) / Math.abs(pembanding)) * 100;
  const bulat = Math.round(persen * 10) / 10; // 1 desimal
  const tanda = bulat > 0 ? '+' : '';
  return `${tanda}${bulat.toFixed(1)}%`;
}

// ============================================================
// REQUIREMENT 8 (hardening) — logika ketik nominal Rupiah.
//
// Dua fungsi MURNI di bawah SEBELUMNYA tertanam sebagai closure di
// dalam komponen <CurrencyInput/> (file .tsx), sehingga perilakunya
// mustahil diuji otomatis tanpa react-test-renderer. Isinya DIPINDAHKAN
// APA ADANYA — tidak ada perubahan aturan format/parse — supaya
// stabilitas input saat mengetik dapat dibuktikan lewat test, bukan
// hanya diklaim.
// ============================================================

/**
 * Tampilan nominal saat diketik: angka murni -> string berpemisah titik.
 * String kosong berarti "belum diisi" (BUKAN 0) — dibedakan supaya
 * placeholder tetap muncul dan validasi "wajib diisi" tetap bekerja.
 */
export function formatNominalInput(value: Rupiah | ''): string {
  if (value === '') return '';
  return Math.trunc(value).toLocaleString('id-ID');
}

/**
 * Parse apa pun yang diketik/di-paste user menjadi nominal Rupiah murni.
 * Karakter non-digit (titik pemisah, spasi, "Rp", koma) dibuang, dan
 * leading zero berlebih dinormalisasi ("0050" -> 50) sambil tetap
 * mengizinkan "0" tunggal.
 */
export function parseNominalInput(text: string): Rupiah | '' {
  const digitsOnly = text.replace(/[^0-9]/g, '');
  if (digitsOnly === '') return '';
  const normalized = digitsOnly.replace(/^0+(?=\d)/, '');
  return parseInt(normalized, 10);
}

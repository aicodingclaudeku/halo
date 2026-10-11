/**
 * RC-S82 — TERBILANG (angka -> kata, Bahasa Indonesia). MURNI.
 * Dipakai dokumen perjanjian: "Rp12.000.000 (dua belas juta rupiah)".
 * Hanya bilangan bulat >= 0 (Rupiah di aplikasi ini integer-only).
 */
const SATUAN = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];

function kata(n: number): string {
  if (n < 12) return SATUAN[n];
  if (n < 20) return `${kata(n - 10)} belas`;
  if (n < 100) return `${kata(Math.floor(n / 10))} puluh ${kata(n % 10)}`;
  if (n < 200) return `seratus ${kata(n - 100)}`;
  if (n < 1000) return `${kata(Math.floor(n / 100))} ratus ${kata(n % 100)}`;
  if (n < 2000) return `seribu ${kata(n - 1000)}`;
  if (n < 1_000_000) return `${kata(Math.floor(n / 1000))} ribu ${kata(n % 1000)}`;
  if (n < 1_000_000_000) return `${kata(Math.floor(n / 1_000_000))} juta ${kata(n % 1_000_000)}`;
  if (n < 1_000_000_000_000) return `${kata(Math.floor(n / 1_000_000_000))} miliar ${kata(n % 1_000_000_000)}`;
  return `${kata(Math.floor(n / 1_000_000_000_000))} triliun ${kata(n % 1_000_000_000_000)}`;
}

export function terbilang(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Terbilang hanya untuk bilangan bulat tidak negatif: ${n}`);
  if (n === 0) return 'nol';
  return kata(n).replace(/\s+/g, ' ').trim();
}

/** "dua belas juta rupiah". */
export function terbilangRupiah(n: number): string {
  return `${terbilang(n)} rupiah`;
}

const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

/**
 * Nama hari dari 'YYYY-MM-DD'. Tanggal-saja diparse sebagai UTC tengah
 * malam (ECMAScript), dan hari dibaca dengan getUTCDay — tidak
 * terpengaruh zona waktu WIB/WITA/WIT.
 */
export function namaHari(tanggal: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(tanggal ?? '');
  if (!m) return '-';
  return HARI[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
}

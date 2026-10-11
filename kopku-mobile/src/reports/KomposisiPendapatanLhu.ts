import { Rupiah } from '@/utils/money';

/**
 * RC-S98 — KOMPOSISI PENDAPATAN pada Laporan Hasil Usaha.
 *
 * Juklat SOM No. 3/2025, Lampiran "CONTOH PERHITUNGAN HASIL USAHA UNTUK
 * KSP", menutup contohnya dengan DUA perhitungan persentase (dikutip apa
 * adanya untuk tahun 2021):
 *
 *   1. Rp 88.375.000 / Rp (85.375.000 + 3.000.000 + 12.500.000) x 100% = 87,6%
 *   2. Rp 12.500.000 / Rp (85.375.000 + 3.000.000 + 12.500.000) x 100% = 12,4%
 *
 * Pembilang (1) adalah "Jumlah partisipasi anggota" dan pembilang (2)
 * adalah "Hasil investasi"; penyebut keduanya SAMA, yaitu pendapatan
 * bunga + pendapatan usaha lain + hasil investasi — yang dalam istilah
 * `LhuResult` persis `jumlahPartisipasiAnggota + totalHasilInvestasi`.
 * Jadi rasio ini menyatakan berapa bagian pendapatan koperasi yang
 * berasal dari pelayanan kepada ANGGOTA dan berapa dari INVESTASI.
 *
 * CATATAN KEJUJURAN SUMBER: naskah menampilkan kedua perhitungan ini
 * TANPA memberi nama resmi. Karena itu label di UI/export dibuat
 * deskriptif ("Komposisi Pendapatan") dan TIDAK mengklaim sebuah nama
 * peraturan yang tidak ada di naskah. Rumus & penyebutnya-lah yang
 * mengikuti naskah, dan itulah yang diuji.
 *
 * MODUL MURNI (tanpa import database/native) supaya dapat diuji langsung
 * dan dipakai bersama oleh layar maupun builder export — mengikuti
 * konvensi yang sama dengan `KolektibilitasSomService`/`PinjamanCalculator`.
 */
export interface KomposisiPendapatanLhu {
  /** jumlahPartisipasiAnggota + totalHasilInvestasi — penyebut kedua rasio. */
  totalPendapatanDasar: Rupiah;
  /** Persentase partisipasi anggota, 1 desimal. `null` bila penyebut tidak bermakna. */
  persenPartisipasiAnggota: number | null;
  /** Persentase hasil investasi, 1 desimal. `null` bila penyebut tidak bermakna. */
  persenHasilInvestasi: number | null;
}

/**
 * Penyebut 0 (belum ada pendapatan) maupun penyebut NEGATIF (mis. hasil
 * investasi rugi lebih besar daripada partisipasi) TIDAK menghasilkan
 * angka: keduanya dikembalikan `null` supaya pemanggil menampilkan "—"
 * alih-alih persentase yang menyesatkan (pola yang sama dengan
 * `formatPersentasePerubahan` di utils/money.ts). Tidak ada pembagian
 * dengan nol dan tidak pernah mengembalikan Infinity/NaN.
 */
export function hitungKomposisiPendapatanLhu(
  jumlahPartisipasiAnggota: Rupiah,
  totalHasilInvestasi: Rupiah
): KomposisiPendapatanLhu {
  const totalPendapatanDasar = jumlahPartisipasiAnggota + totalHasilInvestasi;
  if (totalPendapatanDasar <= 0) {
    return { totalPendapatanDasar, persenPartisipasiAnggota: null, persenHasilInvestasi: null };
  }
  const bulatkan = (nilai: Rupiah) => Math.round((nilai / totalPendapatanDasar) * 1000) / 10;
  return {
    totalPendapatanDasar,
    persenPartisipasiAnggota: bulatkan(jumlahPartisipasiAnggota),
    persenHasilInvestasi: bulatkan(totalHasilInvestasi),
  };
}

/** Format tampilan satu rasio: "87,6%" (koma desimal Indonesia) atau "—" bila tidak bermakna. */
export function formatPersenKomposisi(persen: number | null): string {
  if (persen === null) return '—';
  return `${persen.toFixed(1).replace('.', ',')}%`;
}

import { formatTanggalIndonesia } from '@/utils/reportPeriod';

/**
 * RENTANG HISTORI TRANSAKSI untuk export Detail Anggota.
 *
 * "N bulan terakhir" dihitung mundur dari TANGGAL CETAK (tanggal aplikasi),
 * inklusif di kedua ujung: 5 Okt 2026, 3 bulan -> 5 Jul 2026 s.d. 5 Okt 2026.
 * Bila tanggal yang sama tidak ada di bulan tujuan, dipakai hari terakhir
 * bulan itu (31 Mei - 3 bulan = 28/29 Feb). Murni string YYYY-MM-DD —
 * tanpa objek Date, sehingga bebas pergeseran zona waktu.
 */
export type RentangHistori = '3_BULAN' | '6_BULAN' | '12_BULAN' | 'SEMUA';

export const OPSI_RENTANG_HISTORI: readonly { kunci: RentangHistori; label: string }[] = [
  { kunci: '3_BULAN', label: '3 Bulan' },
  { kunci: '6_BULAN', label: '6 Bulan' },
  { kunci: '12_BULAN', label: '12 Bulan' },
  { kunci: 'SEMUA', label: 'Semua' },
];

const JUMLAH_BULAN: Record<Exclude<RentangHistori, 'SEMUA'>, number> = { '3_BULAN': 3, '6_BULAN': 6, '12_BULAN': 12 };

/** Tanggal awal rentang (inklusif), atau null untuk SEMUA. */
export function tanggalMulaiRentang(rentang: RentangHistori, tanggalAcuan: string): string | null {
  if (rentang === 'SEMUA') return null;
  const [y, m, d] = tanggalAcuan.split('-').map(Number);
  const indeks = y * 12 + (m - 1) - JUMLAH_BULAN[rentang];
  const ty = Math.floor(indeks / 12);
  const tm = (indeks % 12) + 1;
  const hariMaks = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const dua = (n: number) => String(n).padStart(2, '0');
  return `${ty}-${dua(tm)}-${dua(Math.min(d, hariMaks))}`;
}

/** Saring baris bertanggal ke rentang [mulai, tanggalAcuan]. SEMUA = tanpa saring. */
export function saringHistoriPerRentang<T extends { tanggal: string }>(rows: readonly T[], rentang: RentangHistori, tanggalAcuan: string): T[] {
  const mulai = tanggalMulaiRentang(rentang, tanggalAcuan);
  if (mulai === null) return [...rows];
  return rows.filter((r) => r.tanggal.slice(0, 10) >= mulai && r.tanggal.slice(0, 10) <= tanggalAcuan);
}

/** Judul singkat: "3 Bulan Terakhir" / "Keseluruhan". */
export function judulRentangHistori(rentang: RentangHistori): string {
  return rentang === 'SEMUA' ? 'Keseluruhan' : `${JUMLAH_BULAN[rentang]} Bulan Terakhir`;
}

/** Keterangan periode lengkap: "5 Juli 2026 s.d. 5 Oktober 2026" / "Seluruh transaksi". */
export function periodeRentangHistori(rentang: RentangHistori, tanggalAcuan: string): string {
  const mulai = tanggalMulaiRentang(rentang, tanggalAcuan);
  return mulai === null ? 'Seluruh transaksi' : `${formatTanggalIndonesia(mulai)} s.d. ${formatTanggalIndonesia(tanggalAcuan)}`;
}

import { addMonths, format } from 'date-fns';

/**
 * ============================================================
 * TENOR & JATUH TEMPO SIMPANAN BERJANGKA
 * ============================================================
 *
 * Modul terpisah dari `InstallmentDate.ts` DENGAN SENGAJA.
 * `calculateInstallmentDate()` menjawab pertanyaan yang berbeda —
 * "tanggal angsuran ke-N dari sebuah jadwal cicilan" — dan menerima
 * satuan HARI/MINGGU/BULAN. Simpanan berjangka tidak punya jadwal: ia
 * punya SATU tanggal jatuh tempo, dan tenornya selalu dalam bulan
 * kalender. Memakai ulang helper pinjaman akan menyeret semantik
 * angsuran (nomor angsuran 1-based, satuan tenor) ke domain yang tidak
 * memilikinya.
 *
 * Yang DIPAKAI ULANG adalah hal yang memang sama: `addMonths` dari
 * date-fns, yaitu aritmetika bulan kalender dengan clamping akhir
 * bulan — konvensi yang persis sama dengan yang dipakai
 * `InstallmentDate.ts`, jadi tidak ada dua definisi "tambah bulan" yang
 * berbeda di dalam basis kode ini.
 *
 * KENAPA BUKAN `tenor * 30 hari`:
 * pendekatan itu salah untuk hampir semua bulan. 3 bulan = 90 hari
 * hanya benar bila ketiga bulannya kebetulan 30 hari. Dari 4 September
 * 2026, +90 hari jatuh di 3 Desember, sedangkan jatuh tempo yang benar
 * secara kalender adalah 4 Desember. Selisih satu hari itu langsung
 * salah dalam kontrak yang mengikat anggota.
 *
 * KONVENSI CLAMPING AKHIR BULAN (perilaku `addMonths`):
 *   31 Jan + 3 bulan  -> 30 Apr  (April tidak punya tanggal 31)
 *   30 Nov + 3 bulan  -> 28/29 Feb sesuai tahun kabisat
 *   29 Feb 2028 + 12 bulan -> 28 Feb 2029 (2029 bukan kabisat)
 * Ini konvensi yang sama dengan jadwal angsuran, sehingga anggota &
 * pengurus tidak menghadapi dua aturan tanggal yang berbeda.
 */

/**
 * Tenor yang diizinkan. Union type ini adalah SATU-SATUNYA definisi
 * tenor sah — UI, service, dan CHECK constraint database semuanya
 * merujuk daftar yang sama, jadi tidak mungkin ada tenor yang lolos di
 * satu lapisan tetapi ditolak di lapisan lain.
 */
export type TenorSimpananBerjangka = 3 | 6 | 12;

/** Daftar tenor sah — dipakai UI untuk merender pilihan. */
export const TENOR_SIMPANAN_BERJANGKA: readonly TenorSimpananBerjangka[] = [3, 6, 12] as const;

/**
 * Type guard tenor. Dipakai di service (bukan hanya di UI) supaya
 * pemanggilan langsung ke service dengan tenor 1/2/4/9/24 tetap ditolak.
 */
export function isTenorSimpananBerjangkaValid(tenor: unknown): tenor is TenorSimpananBerjangka {
  return tenor === 3 || tenor === 6 || tenor === 12;
}

/**
 * Penambahan bulan KALENDER generik — SATU-SATUNYA implementasi
 * aritmetika bulan untuk domain simpanan berjangka.
 *
 * Dipakai oleh `hitungTanggalJatuhTempo()` (tenor 3/6/12) DAN oleh
 * penjadwalan akrual bunga di `SimpananBerjangkaBunga.ts` (lompatan per
 * bulan 1..n). Sebelumnya ada dua implementasi terpisah dengan konvensi
 * yang sama; disatukan di sini supaya mustahil keduanya menyimpang —
 * tanggal jatuh tempo dan tanggal akhir periode akrual WAJIB memakai
 * aturan yang identik, kalau tidak periode terakhir bisa jatuh sebelum
 * atau sesudah jatuh tempo.
 *
 * Konvensi clamping akhir bulan (perilaku `addMonths` date-fns, sama
 * dengan `InstallmentDate.ts`): anchored ke tanggal asal, sehingga
 * 31 Jan -> 28/29 Feb -> KEMBALI ke 31 Mar, bukan terjebak di 28.
 */
export function tambahBulanKalender(tanggal: string, jumlahBulan: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) {
    throw new Error(`Tanggal harus berformat YYYY-MM-DD, diterima "${tanggal}".`);
  }
  // Parsing komponen lokal (BUKAN `new Date('YYYY-MM-DD')` yang
  // menghasilkan UTC midnight) supaya hasilnya tidak bergeser satu hari
  // di zona WIB/WITA/WIT — pola yang sama dipakai di utils/tanggal.ts.
  const [tahun, bulan, hari] = tanggal.split('-').map((x) => parseInt(x, 10));
  return format(addMonths(new Date(tahun, bulan - 1, hari), jumlahBulan), 'yyyy-MM-dd');
}

/**
 * Tanggal jatuh tempo = tanggal mulai + tenor bulan KALENDER.
 *
 * @param tanggalMulai 'YYYY-MM-DD'
 * @param tenorBulan   3 | 6 | 12
 * @returns            'YYYY-MM-DD'
 */
export function hitungTanggalJatuhTempo(
  tanggalMulai: string,
  tenorBulan: TenorSimpananBerjangka
): string {
  if (!isTenorSimpananBerjangkaValid(tenorBulan)) {
    throw new Error(`Tenor simpanan berjangka hanya 3, 6, atau 12 bulan — diterima ${tenorBulan}.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggalMulai)) {
    throw new Error(`Tanggal mulai harus berformat YYYY-MM-DD, diterima "${tanggalMulai}".`);
  }
  return tambahBulanKalender(tanggalMulai, tenorBulan);
}

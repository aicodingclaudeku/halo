/**
 * SHIM `date-fns` UNTUK HARNESS
 * =========================================================================
 *
 * `date-fns` adalah dependency PRODUKSI, tetapi `node_modules` tidak
 * tersedia di lingkungan ini. Berkas ini menyediakan LIMA fungsi yang
 * benar-benar dipakai kode produksi:
 *
 *     addDays, addWeeks, addMonths, format, differenceInCalendarDays
 *
 * Tidak lebih. Menambah fungsi yang tidak dipakai hanya memperbesar
 * permukaan yang harus dijamin benar.
 *
 * KENAPA INI BUKAN MOCK. Perilakunya ditiru PERSIS, termasuk detail yang
 * paling mudah salah dan paling merusak bila salah:
 *
 *   - `addMonths` MENJEPIT akhir bulan. 31 Januari + 1 bulan = 28/29
 *     Februari, bukan 2/3 Maret. Kalau ini keliru, tanggal jatuh tempo
 *     simpanan berjangka dan tanggal angsuran ikut melenceng, dan
 *     test akan "hijau" di atas tanggal yang salah.
 *   - `differenceInCalendarDays` menghitung selisih HARI KALENDER
 *     (tengah malam ke tengah malam), bukan selisih milidetik dibagi
 *     86.400.000 — keduanya berbeda saat melewati pergantian hari.
 *   - `format` hanya mendukung token yang benar-benar dipakai, dan
 *     MELEMPAR untuk token yang tidak dikenal. Diam-diam mengembalikan
 *     string yang salah jauh lebih berbahaya daripada gagal keras.
 *
 * Berkas ini berada di `.harness/` dan TIDAK PERNAH ikut ter-bundle.
 */

function salin(tanggal: Date): Date {
  return new Date(tanggal.getTime());
}

export function addDays(tanggal: Date, jumlah: number): Date {
  const hasil = salin(tanggal);
  hasil.setDate(hasil.getDate() + jumlah);
  return hasil;
}

export function addWeeks(tanggal: Date, jumlah: number): Date {
  return addDays(tanggal, jumlah * 7);
}

/**
 * Tambah bulan dengan penjepitan akhir bulan, seperti `date-fns`.
 *
 * `Date.setMonth()` bawaan JavaScript MELUAP: 31 Jan + 1 bulan menjadi
 * 3 Maret. Itu perilaku yang salah untuk jatuh tempo kontrak.
 */
export function addMonths(tanggal: Date, jumlah: number): Date {
  const hasil = salin(tanggal);
  const tanggalAsli = hasil.getDate();

  // Pindah bulan dengan tanggal disetel ke 1 dulu, sehingga tidak ada
  // peluang meluap ke bulan berikutnya di tengah proses.
  hasil.setDate(1);
  hasil.setMonth(hasil.getMonth() + jumlah);

  const hariTerakhirBulanTujuan = new Date(
    hasil.getFullYear(),
    hasil.getMonth() + 1,
    0
  ).getDate();
  hasil.setDate(Math.min(tanggalAsli, hariTerakhirBulanTujuan));
  return hasil;
}

/** Selisih HARI KALENDER — jam/menit/detik diabaikan pada kedua sisi. */
export function differenceInCalendarDays(akhir: Date, awal: Date): number {
  const a = new Date(akhir.getFullYear(), akhir.getMonth(), akhir.getDate()).getTime();
  const b = new Date(awal.getFullYear(), awal.getMonth(), awal.getDate()).getTime();
  return Math.round((a - b) / 86_400_000);
}

const PAD = (nilai: number, lebar: number): string => String(nilai).padStart(lebar, '0');

/**
 * Subset `format()`. Token yang tidak dikenal MELEMPAR — lihat catatan
 * di kepala berkas.
 */
export function format(tanggal: Date, pola: string): string {
  const token = /yyyy|yy|MM|dd|HH|mm|ss/g;
  const DIKENAL = new Set(['yyyy', 'yy', 'MM', 'dd', 'HH', 'mm', 'ss']);

  // Validasi per-RUN huruf, bukan per-sisa-string.
  //
  // Versi pertama membuang seluruh token lalu memeriksa apakah masih ada
  // huruf tersisa. Cara itu MELEWATKAN 'MMMM': ia tercerna sebagai dua
  // 'MM' berturut-turut, sisanya kosong, dan pola yang salah lolos
  // diam-diam menghasilkan "09" + "09". Sekarang setiap deretan huruf
  // harus SAMA PERSIS dengan satu token yang dikenal.
  for (const run of pola.match(/[A-Za-z]+/g) ?? []) {
    if (!DIKENAL.has(run)) {
      throw new Error(
        `harness date-fns shim: token format '${run}' belum didukung (pola: ${pola})`
      );
    }
  }

  return pola.replace(token, (t) => {
    switch (t) {
      case 'yyyy':
        return PAD(tanggal.getFullYear(), 4);
      case 'yy':
        return PAD(tanggal.getFullYear() % 100, 2);
      case 'MM':
        return PAD(tanggal.getMonth() + 1, 2);
      case 'dd':
        return PAD(tanggal.getDate(), 2);
      case 'HH':
        return PAD(tanggal.getHours(), 2);
      case 'mm':
        return PAD(tanggal.getMinutes(), 2);
      case 'ss':
        return PAD(tanggal.getSeconds(), 2);
      default:
        throw new Error(`harness date-fns shim: token '${t}' tidak tertangani`);
    }
  });
}

import { Rupiah, roundToRupiah } from '@/utils/money';
import {
  TenorSimpananBerjangka,
  isTenorSimpananBerjangkaValid,
  tambahBulanKalender,
} from '@/accounting/SimpananBerjangkaTenor';

/**
 * ============================================================
 * BUNGA KONTRAKTUAL SIMPANAN BERJANGKA — SIMPLE INTEREST
 * ============================================================
 *
 * BUKAN EIR. `EirAccountingService` TIDAK dipanggil dari modul ini dan
 * tidak boleh dipanggil: EIR pinjaman mengukur ASET pada biaya
 * perolehan diamortisasi termasuk biaya transaksi integral. Simpanan
 * berjangka adalah KEWAJIBAN berbunga kontraktual sederhana tanpa biaya
 * transaksi — dua domain akuntansi yang berbeda. Memaksakan satu mesin
 * ke keduanya akan salah di kedua sisi.
 *
 * FORMULA (persis seperti yang ditetapkan requirement):
 *
 *     total bunga kontrak = pokok x rate tahunan x (tenor bulan / 12)
 *
 *     10.000.000 x 12% x 12/12 = 1.200.000
 *     10.000.000 x 12% x  6/12 =   600.000
 *     10.000.000 x 12% x  3/12 =   300.000
 *     rate 0                   =         0
 *
 * SEMUA hasil dibulatkan ke Rupiah bulat lewat `roundToRupiah()` —
 * helper yang sudah dipakai seluruh basis kode. Tidak pernah ada
 * nominal pecahan yang sampai ke jurnal (`validateLines` juga akan
 * menolaknya).
 *
 * ALOKASI PER PERIODE & RESIDU
 * ----------------------------
 * Bunga diakru per BULAN kalender kontrak. Pembagian rata hampir selalu
 * menyisakan sisa:
 *
 *     1.000.000 / 12 = 83.333,33 -> 12 x 83.333 = 999.996  (kurang 4)
 *
 * Membiarkan selisih 4 rupiah itu berarti utang bunga tidak akan pernah
 * nol saat pencairan. Karena itu:
 *
 *     periode 1..n-1 : floor(total / n)
 *     periode n      : total - (n-1) x floor(total / n)   <- RESIDU
 *
 * sehingga SELALU berlaku, tanpa toleransi apa pun:
 *
 *     jumlah seluruh alokasi === total bunga kontrak
 *
 * Residu ditempatkan di periode TERAKHIR (bukan pertama) supaya jumlah
 * yang diakru pada periode berjalan tidak pernah melebihi porsi
 * proporsionalnya — akrual tidak boleh mendahului waktu.
 */

export interface PeriodeBungaSimpananBerjangka {
  /** 1-based, 1..tenorBulan. */
  nomorPeriode: number;
  /** Tanggal akhir periode = tanggal saat bunga periode ini earned. */
  tanggalAkhirPeriode: string;
  /** Bunga yang menjadi hak anggota untuk periode ini (Rupiah bulat). */
  bunga: Rupiah;
}

/**
 * Total bunga kontraktual seumur kontrak.
 *
 * @param pokok        Rupiah bulat > 0
 * @param ratePerTahun Persen per tahun (mis. 12 = 12%). 0 = tanpa bunga.
 * @param tenorBulan   3 | 6 | 12
 */
export function hitungTotalBungaKontrak(
  pokok: Rupiah,
  ratePerTahun: number,
  tenorBulan: TenorSimpananBerjangka
): Rupiah {
  if (!Number.isInteger(pokok) || pokok <= 0) {
    throw new Error('Pokok simpanan berjangka harus bilangan bulat Rupiah lebih besar dari 0.');
  }
  if (!Number.isFinite(ratePerTahun) || ratePerTahun < 0) {
    throw new Error('Suku bunga tidak valid.');
  }
  if (!isTenorSimpananBerjangkaValid(tenorBulan)) {
    throw new Error(`Tenor simpanan berjangka hanya 3, 6, atau 12 bulan — diterima ${tenorBulan}.`);
  }
  if (ratePerTahun === 0) return 0;

  return roundToRupiah((pokok * (ratePerTahun / 100) * tenorBulan) / 12);
}

/**
 * Jadwal akrual bunga per bulan kontrak, lengkap dengan tanggal akhir
 * tiap periode dan penanganan residu di periode terakhir.
 *
 * Tanggal akhir periode ke-k dihitung sebagai `tanggalMulai + k bulan`
 * memakai helper bulan kalender TERPUSAT yang SAMA dengan perhitungan
 * jatuh tempo (`hitungTanggalJatuhTempo`). Konsekuensinya periode
 * terakhir selalu jatuh PERSIS pada tanggal jatuh tempo kontrak — tidak
 * ada dua definisi tanggal yang bisa berselisih.
 */
export function buatJadwalBungaSimpananBerjangka(
  pokok: Rupiah,
  ratePerTahun: number,
  tenorBulan: TenorSimpananBerjangka,
  tanggalMulai: string
): PeriodeBungaSimpananBerjangka[] {
  const total = hitungTotalBungaKontrak(pokok, ratePerTahun, tenorBulan);

  const jadwal: PeriodeBungaSimpananBerjangka[] = [];
  const perPeriode = Math.floor(total / tenorBulan);

  for (let k = 1; k <= tenorBulan; k++) {
    const bunga =
      k < tenorBulan
        ? perPeriode
        : // RESIDU: sisa seluruhnya masuk ke periode terakhir supaya
          // total alokasi === total bunga kontrak, persis.
          total - perPeriode * (tenorBulan - 1);
    jadwal.push({
      nomorPeriode: k,
      // Lompatan k bulan (bukan tenor penuh), memakai konvensi clamping
      // akhir bulan yang SAMA dengan `hitungTanggalJatuhTempo`. Untuk
      // k === tenorBulan hasilnya identik dengan tanggal jatuh tempo
      // kontrak — diuji eksplisit, sehingga tidak ada dua definisi
      // tanggal yang bisa berselisih.
      tanggalAkhirPeriode: tambahBulanKalender(tanggalMulai, k),
      bunga,
    });
  }

  return jadwal;
}

// Aritmetika bulan kalender TIDAK diimplementasikan ulang di sini.
// Satu-satunya implementasi ada di `SimpananBerjangkaTenor.ts` dan
// dipakai bersama oleh jatuh tempo maupun jadwal akrual, supaya
// keduanya mustahil menyimpang. Di-re-export agar pemanggil lama tetap
// bekerja tanpa perubahan.
export { tambahBulanKalender } from '@/accounting/SimpananBerjangkaTenor';

/**
 * Periode yang bunganya SUDAH earned pada `sampaiTanggal` (inklusif).
 * Dipakai mesin akrual untuk menentukan apa yang boleh dijurnal —
 * akrual tidak pernah boleh mendahului tanggal berjalan.
 */
export function periodeYangSudahEarned(
  jadwal: PeriodeBungaSimpananBerjangka[],
  sampaiTanggal: string
): PeriodeBungaSimpananBerjangka[] {
  return jadwal.filter((p) => p.tanggalAkhirPeriode <= sampaiTanggal);
}

// ============================================================
// RC-S128 — BUNGA PASCA JATUH TEMPO (hasil kebijakan produk)
// ============================================================

/**
 * Satu periode bunga pasca jatuh tempo. Penomoran MELANJUTKAN periode
 * kontrak (tenor+1, tenor+2, ...) sehingga UNIQUE(simpanan_berjangka_id,
 * nomor_periode) yang sudah ada tetap menjadi penjaga idempotensi.
 */
export interface PeriodeBungaPascaJatuhTempo extends PeriodeBungaSimpananBerjangka {
  /** Urutan periode sesudah jatuh tempo, 1-based. */
  urutanPasca: number;
  tanggalAwalPeriode: string;
  ratePersen: number;
}

/**
 * Bunga SATU periode pasca jatuh tempo = pokok x rate tahunan x 1/12,
 * dibulatkan ke Rupiah. Rumus yang sama dengan bunga kontrak
 * (pokok x rate x bulan/12) untuk satu bulan; pokok yang dipakai adalah
 * POKOK KONTRAK ASLI — bunga tidak pernah dikapitalisasi.
 */
export function hitungBungaPascaJatuhTempoSatuPeriode(pokok: Rupiah, ratePascaPerTahun: number): Rupiah {
  if (!Number.isInteger(pokok) || pokok <= 0) {
    throw new Error('Pokok simpanan berjangka harus bilangan bulat Rupiah lebih besar dari 0.');
  }
  if (!Number.isFinite(ratePascaPerTahun) || ratePascaPerTahun < 0) {
    throw new Error('Rate pasca jatuh tempo tidak valid.');
  }
  return roundToRupiah((pokok * (ratePascaPerTahun / 100)) / 12);
}

/** Batas pengaman iterasi (100 tahun) — mencegah loop tak berujung pada tanggal rusak. */
const MAKS_PERIODE_PASCA = 1200;

/**
 * Periode pasca jatuh tempo yang SUDAH EARNED pada `sampaiTanggal`
 * (inklusif). SATU-SATUNYA penentu periode pasca jatuh tempo — mesin
 * akrual, layar, dan dokumen memanggil fungsi ini, tidak menyalin
 * algoritma tanggalnya.
 *
 * Tanggal akhir periode ke-j = tambahBulanKalender(tanggalMulai, tenor+j),
 * yaitu kelanjutan PERSIS dari jadwal kontrak (yang memakai
 * tambahBulanKalender(tanggalMulai, k)). Periode pertama dimulai tepat
 * pada tanggal jatuh tempo dan berakhir satu bulan kalender kemudian;
 * anchor ke tanggal mulai membuat clamping akhir bulan konsisten
 * (31 Jan -> 28 Feb -> 31 Mar), tidak "terjebak" di tanggal 28.
 *
 * Periode yang belum genap satu bulan kalender pada `sampaiTanggal`
 * TIDAK diakui (tanpa prorata). `mulaiEfektif` (untuk kontrak legacy
 * yang diberi kebijakan belakangan) membuang periode yang tanggal
 * awalnya sebelum tanggal itu — tidak ada backfill.
 */
export function periodePascaJatuhTempoEarned(p: {
  pokok: Rupiah;
  tenorBulan: TenorSimpananBerjangka;
  tanggalMulai: string;
  ratePascaPerTahun: number;
  sampaiTanggal: string;
  mulaiEfektif?: string | null;
}): PeriodeBungaPascaJatuhTempo[] {
  if (!isTenorSimpananBerjangkaValid(p.tenorBulan)) {
    throw new Error(`Tenor simpanan berjangka hanya 3, 6, atau 12 bulan — diterima ${p.tenorBulan}.`);
  }
  if (!(p.ratePascaPerTahun > 0)) return [];
  const bunga = hitungBungaPascaJatuhTempoSatuPeriode(p.pokok, p.ratePascaPerTahun);
  const hasil: PeriodeBungaPascaJatuhTempo[] = [];
  for (let j = 1; j <= MAKS_PERIODE_PASCA; j++) {
    const akhir = tambahBulanKalender(p.tanggalMulai, p.tenorBulan + j);
    if (akhir > p.sampaiTanggal) break;
    const awal = tambahBulanKalender(p.tanggalMulai, p.tenorBulan + j - 1);
    if (p.mulaiEfektif && awal < p.mulaiEfektif) continue;
    hasil.push({
      nomorPeriode: p.tenorBulan + j,
      urutanPasca: j,
      tanggalAwalPeriode: awal,
      tanggalAkhirPeriode: akhir,
      bunga,
      ratePersen: p.ratePascaPerTahun,
    });
  }
  return hasil;
}

/** Periode pasca jatuh tempo BERIKUTNYA yang belum earned (informasi layar). */
export function periodePascaJatuhTempoBerikutnya(p: {
  pokok: Rupiah;
  tenorBulan: TenorSimpananBerjangka;
  tanggalMulai: string;
  ratePascaPerTahun: number;
  sampaiTanggal: string;
  mulaiEfektif?: string | null;
}): PeriodeBungaPascaJatuhTempo | null {
  if (!(p.ratePascaPerTahun > 0)) return null;
  for (let j = 1; j <= MAKS_PERIODE_PASCA; j++) {
    const akhir = tambahBulanKalender(p.tanggalMulai, p.tenorBulan + j);
    const awal = tambahBulanKalender(p.tanggalMulai, p.tenorBulan + j - 1);
    if (p.mulaiEfektif && awal < p.mulaiEfektif) continue;
    if (akhir > p.sampaiTanggal) {
      return {
        nomorPeriode: p.tenorBulan + j,
        urutanPasca: j,
        tanggalAwalPeriode: awal,
        tanggalAkhirPeriode: akhir,
        bunga: hitungBungaPascaJatuhTempoSatuPeriode(p.pokok, p.ratePascaPerTahun),
        ratePersen: p.ratePascaPerTahun,
      };
    }
  }
  return null;
}

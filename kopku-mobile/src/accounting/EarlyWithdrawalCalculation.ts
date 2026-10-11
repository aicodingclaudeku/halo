import { Rupiah, percentageOf, sum } from '@/utils/money';
import {
  TenorSimpananBerjangka,
  isTenorSimpananBerjangkaValid,
} from '@/accounting/SimpananBerjangkaTenor';
import {
  buatJadwalBungaSimpananBerjangka,
  periodeYangSudahEarned,
} from '@/accounting/SimpananBerjangkaBunga';
import {
  KebijakanEarlyWithdrawal,
  KebijakanEarlyWithdrawalError,
  evaluasiKebijakanEarlyWithdrawal,
  targetPotongan,
} from '@/accounting/EarlyWithdrawalPolicy';

/**
 * ============================================================
 * MESIN PERHITUNGAN SETTLEMENT PENARIKAN DINI (§J)
 * ============================================================
 *
 * SATU fungsi menghasilkan SELURUH angka penarikan dini:
 * `calculateEarlyWithdrawalSettlement()`. Preview UI, eksekusi service,
 * jurnal, subledger, dan riwayat anggota memakai hasil fungsi ini —
 * tidak ada satu pun dari mereka yang menghitung ulang sendiri.
 * Karena itu "preview ≠ eksekusi" mustahil terjadi karena beda logika.
 *
 * URUTAN PERHITUNGAN — sengaja ditetapkan sekali dan didokumentasikan,
 * karena urutannya mengubah hasil:
 *
 *   1. bunga akrual kontrak (A)      : dari subledger, rate KONTRAK
 *   2. penyesuaian rate               : B = bunga pada rate kebijakan
 *   3. bunga hangus (F)               : dihitung atas B, bukan atas A
 *   4. bunga setelah forfeiture       : B - F
 *   5. penalti (P)                    : basis sesuai kebijakan
 *   6. biaya admin (FEE)              : basis sesuai kebijakan
 *   7. arah potongan                  : P & FEE dipotong dari POKOK atau
 *                                       dari BUNGA — tidak pernah dari
 *                                       keduanya (lihat targetPotongan)
 *   8. pokok dibayar, bunga dibayar, total payout
 *
 * INVARIAN YANG DIJAGA:
 *   bungaHangus + bungaSetelahForfeiture === bungaBruto
 *   penyesuaianPokok + penyesuaianBunga === penalti + biayaAdmin
 *   pokokDibayar + bungaDibayar === totalPayout
 *   pokokDibayar >= 0 dan bungaDibayar >= 0
 *
 * Tidak ada clamping diam-diam: kebijakan yang memotong lebih besar
 * dari komponen yang tersedia DITOLAK, bukan dipangkas menjadi nol.
 */

export class SettlementDiniTidakDapatDihitungError extends Error {
  constructor(pesan: string) {
    super(pesan);
    this.name = 'SettlementDiniTidakDapatDihitungError';
  }
}

export interface InputSettlementDini {
  pokok: Rupiah;
  tanggalMulai: string;
  tanggalJatuhTempo: string;
  /** Tanggal BISNIS pencairan (bukan tanggal input UI). */
  tanggalPencairan: string;
  tenorBulan: TenorSimpananBerjangka;
  /** Rate kontrak (persen/tahun) sebagaimana tersimpan di kontrak. */
  rateKontrak: number;
  /** Bunga yang SUDAH diakru menurut subledger pada tanggal pencairan. */
  bungaAkrual: Rupiah;
  /**
   * POLICY EW-BUNGA-01 — bunga periode yang SUDAH dipindahkan ke
   * Simpanan Sukarela. Bunga itu sudah direalisasikan menjadi hak
   * anggota, jadi ia BUKAN lagi utang bunga yang outstanding: aturan
   * penarikan dini (penyesuaian rate, bunga hangus, penalti) hanya
   * berlaku atas sisanya. Nilainya WAJIB berasal dari jurnal di
   * database, bukan dari jadwal atau status layar.
   *
   * Opsional demi pemanggil lama; 0 berarti belum ada yang dipindahkan.
   */
  bungaSudahDitransfer?: Rupiah;
  kebijakan: KebijakanEarlyWithdrawal;
}

export interface HasilSettlementDini {
  policyVersi: string;

  /** Pokok kontrak sebelum potongan apa pun. */
  pokokBruto: Rupiah;

  /** Seluruh bunga yang sudah earned pada rate kontrak, sebelum apa pun dikurangkan. */
  totalBungaEarned: Rupiah;
  /** Bagian yang sudah dipindahkan ke Simpanan Sukarela — hak yang sudah direalisasikan. */
  bungaSudahDitransfer: Rupiah;
  /**
   * Bunga yang MASIH terutang di 2-1710 dan menjadi dasar seluruh
   * aturan penarikan dini: `max(totalBungaEarned - bungaSudahDitransfer, 0)`.
   * Inilah batas atas debit 2-1710 pada settlement.
   */
  bungaMasihTerutang: Rupiah;
  /** Bunga terakru yang diselesaikan settlement ini (= `bungaMasihTerutang`). */
  bungaAkrualKontrak: Rupiah;
  /** Selisih akibat rate penarikan dini. Negatif = bunga berkurang. */
  penyesuaianRate: number;
  /** Bunga bruto setelah penyesuaian rate (basis forfeiture & persentase). */
  bungaBruto: Rupiah;
  bungaHangus: Rupiah;
  bungaSetelahForfeiture: Rupiah;

  penalti: Rupiah;
  biayaAdmin: Rupiah;

  penyesuaianPokok: Rupiah;
  penyesuaianBunga: Rupiah;

  pokokDibayar: Rupiah;
  bungaDibayar: Rupiah;
  totalPayout: Rupiah;

  rateKontrak: number;
  /** Rate implisit atas bunga bruto terhadap masa berjalan (audit §G). */
  rateEfektif: number;
  /** Jumlah periode bunga yang sudah earned pada tanggal pencairan. */
  periodeBerjalan: number;
}

function bulatkanRate(nilai: number): number {
  return Math.round(nilai * 1_000_000) / 1_000_000;
}

/**
 * Bunga earned sampai `sampaiTanggal` pada rate tertentu, memakai
 * jadwal & pembulatan residu yang SAMA dengan mesin akrual. Tidak ada
 * rumus kedua: kalau jadwal akrual berubah, perhitungan dini ikut
 * berubah secara otomatis.
 */
function bungaEarnedPadaRate(
  pokok: Rupiah,
  rate: number,
  tenorBulan: TenorSimpananBerjangka,
  tanggalMulai: string,
  sampaiTanggal: string
): { total: Rupiah; jumlahPeriode: number; bungaPeriodeTerakhir: Rupiah } {
  if (rate <= 0) return { total: 0, jumlahPeriode: 0, bungaPeriodeTerakhir: 0 };
  const jadwal = buatJadwalBungaSimpananBerjangka(pokok, rate, tenorBulan, tanggalMulai);
  const earned = periodeYangSudahEarned(jadwal, sampaiTanggal);
  return {
    total: sum(earned.map((p) => p.bunga)),
    jumlahPeriode: earned.length,
    bungaPeriodeTerakhir: earned.length > 0 ? earned[earned.length - 1].bunga : 0,
  };
}

export function calculateEarlyWithdrawalSettlement(
  input: InputSettlementDini
): HasilSettlementDini {
  const { pokok, rateKontrak, tenorBulan, tanggalMulai, tanggalPencairan, kebijakan } = input;

  // ---- Kebijakan wajib lengkap & berlaku (§AL) ----
  const evaluasi = evaluasiKebijakanEarlyWithdrawal(kebijakan);
  if (evaluasi.status !== 'AKTIF') throw new KebijakanEarlyWithdrawalError(evaluasi);

  // ---- Validasi bentuk input ----
  if (!Number.isInteger(pokok) || pokok <= 0) {
    throw new SettlementDiniTidakDapatDihitungError(
      'Pokok kontrak harus bilangan bulat Rupiah lebih besar dari 0.'
    );
  }
  if (!isTenorSimpananBerjangkaValid(tenorBulan)) {
    throw new SettlementDiniTidakDapatDihitungError(
      `Tenor simpanan berjangka hanya 3, 6, atau 12 bulan — diterima ${tenorBulan}.`
    );
  }
  if (!Number.isInteger(input.bungaAkrual) || input.bungaAkrual < 0) {
    throw new SettlementDiniTidakDapatDihitungError('Bunga terakru harus bilangan bulat Rupiah >= 0.');
  }
  if (tanggalPencairan < tanggalMulai) {
    throw new SettlementDiniTidakDapatDihitungError(
      'Tanggal pencairan tidak boleh mendahului tanggal penempatan.'
    );
  }

  // ---- 1. Bunga akrual pada rate kontrak ----
  const kontrak = bungaEarnedPadaRate(pokok, rateKontrak, tenorBulan, tanggalMulai, tanggalPencairan);
  // Angka di buku HARUS sama dengan yang seharusnya earned. Kalau tidak,
  // akrual belum lengkap (mis. ada periode yang gagal dijurnal) —
  // menolak lebih benar daripada membayar angka yang tidak dapat
  // direkonsiliasi dengan 2-1710.
  if (input.bungaAkrual !== kontrak.total) {
    throw new SettlementDiniTidakDapatDihitungError(
      `Bunga simpanan berjangka belum lengkap diakui pada tanggal pencairan ` +
        `(terakru ${input.bungaAkrual}, seharusnya ${kontrak.total}). ` +
        'Selesaikan akrual bunga terlebih dahulu sebelum pencairan dini.'
    );
  }
  const totalBungaEarned = kontrak.total;

  // ---- 1b. POLICY EW-BUNGA-01 — keluarkan bunga yang sudah direalisasikan ----
  //
  // Bunga yang sudah dipindahkan ke Simpanan Sukarela sudah menjadi hak
  // anggota dan sudah keluar dari 2-1710. Ia TIDAK boleh dihitung ulang
  // di sini: tidak sebagai utang bunga, tidak sebagai bunga hangus, dan
  // tidak sebagai pembayaran tunai kedua. Transfernya juga tidak
  // dibalik hanya karena anggota menarik dini.
  const bungaSudahDitransfer = input.bungaSudahDitransfer ?? 0;
  if (bungaSudahDitransfer < 0) {
    throw new SettlementDiniTidakDapatDihitungError(
      'Bunga yang sudah dipindahkan ke Simpanan Sukarela tidak boleh negatif.'
    );
  }
  if (bungaSudahDitransfer > totalBungaEarned) {
    throw new SettlementDiniTidakDapatDihitungError(
      `Bunga yang sudah dipindahkan ke Simpanan Sukarela (${bungaSudahDitransfer}) ` +
        `melebihi bunga yang sudah earned (${totalBungaEarned}) — angkanya tidak dapat direkonsiliasi.`
    );
  }
  const bungaMasihTerutang = Math.max(totalBungaEarned - bungaSudahDitransfer, 0);
  const bungaAkrualKontrak = bungaMasihTerutang;

  // ---- 2. Penyesuaian rate (§G) ----
  let bungaBruto = bungaAkrualKontrak;
  if (kebijakan.jenisPenyesuaianRate === 'RATE_DINI') {
    const rateDini = kebijakan.rateDini ?? 0;
    if (kebijakan.cakupanPenyesuaianRate === 'SEJAK_PENEMPATAN') {
      // Seluruh periode berjalan dihitung ulang pada rate dini.
      // Basisnya tetap seluruh masa berjalan, lalu bagian yang sudah
      // direalisasikan dikeluarkan — bunga di Simpanan Sukarela tidak
      // dihitung ulang pada rate dini.
      bungaBruto = Math.max(
        bungaEarnedPadaRate(pokok, rateDini, tenorBulan, tanggalMulai, tanggalPencairan).total -
          bungaSudahDitransfer,
        0
      );
    } else {
      // PERIODE_BERJALAN_SAJA — periode sebelumnya TETAP pada rate
      // kontrak; hanya periode earned terakhir yang memakai rate dini.
      // Bunga historis tidak dihitung ulang diam-diam (§G).
      const dini = bungaEarnedPadaRate(pokok, rateDini, tenorBulan, tanggalMulai, tanggalPencairan);
      bungaBruto = Math.max(
        totalBungaEarned - kontrak.bungaPeriodeTerakhir + dini.bungaPeriodeTerakhir -
          bungaSudahDitransfer,
        0
      );
    }
  }
  const penyesuaianRate = bungaBruto - bungaAkrualKontrak;
  if (bungaBruto < 0) {
    throw new SettlementDiniTidakDapatDihitungError(
      'Penyesuaian rate menghasilkan bunga bruto negatif — kebijakan rate tidak dapat diterapkan.'
    );
  }

  // ---- 3. Bunga hangus (§E) ----
  let bungaHangus: Rupiah;
  if (kebijakan.perlakuanBunga === 'TIDAK_DIBAYAR') {
    bungaHangus = bungaBruto;
  } else {
    switch (kebijakan.jenisForfeiture) {
      case 'TIDAK_ADA':
        bungaHangus = 0;
        break;
      case 'SELURUH_BUNGA':
        bungaHangus = bungaBruto;
        break;
      case 'PERSENTASE_BUNGA':
        bungaHangus = percentageOf(bungaBruto, kebijakan.nilaiForfeiture ?? 0);
        break;
      case 'NOMINAL_TETAP':
        bungaHangus = kebijakan.nilaiForfeiture ?? 0;
        break;
    }
  }
  if (bungaHangus > bungaBruto) {
    throw new SettlementDiniTidakDapatDihitungError(
      `Bunga hangus menurut kebijakan (${bungaHangus}) melebihi bunga bruto (${bungaBruto}). ` +
        'Perhitungan dihentikan — nilainya tidak dipangkas diam-diam.'
    );
  }
  const bungaSetelahForfeiture = bungaBruto - bungaHangus;

  // ---- 4. Penalti (§D) ----
  let penalti: Rupiah = 0;
  if (kebijakan.jenisPenalti === 'NOMINAL_TETAP') {
    penalti = kebijakan.nilaiPenalti ?? 0;
  } else if (kebijakan.jenisPenalti === 'PERSENTASE') {
    const persen = kebijakan.nilaiPenalti ?? 0;
    switch (kebijakan.basisPenalti) {
      case 'POKOK':
        penalti = percentageOf(pokok, persen);
        break;
      case 'BUNGA_BRUTO':
        penalti = percentageOf(bungaBruto, persen);
        break;
      case 'TOTAL_SEBELUM_PENALTI':
        penalti = percentageOf(pokok + bungaSetelahForfeiture, persen);
        break;
      default:
        // Sudah dicegah evaluasi kebijakan; dijaga ulang supaya basis
        // tidak pernah diasumsikan bila jalur ini tercapai.
        throw new SettlementDiniTidakDapatDihitungError(
          'Basis perhitungan penalti belum ditetapkan kebijakan.'
        );
    }
  }

  // ---- 5. Biaya admin (§F) ----
  let biayaAdmin: Rupiah = 0;
  if (kebijakan.jenisBiayaAdmin === 'NOMINAL_TETAP') {
    biayaAdmin = kebijakan.nilaiBiayaAdmin ?? 0;
  } else if (kebijakan.jenisBiayaAdmin === 'PERSENTASE') {
    const persen = kebijakan.nilaiBiayaAdmin ?? 0;
    switch (kebijakan.basisBiayaAdmin) {
      case 'POKOK':
        biayaAdmin = percentageOf(pokok, persen);
        break;
      case 'BUNGA_BRUTO':
        biayaAdmin = percentageOf(bungaBruto, persen);
        break;
      default:
        throw new SettlementDiniTidakDapatDihitungError(
          'Basis perhitungan biaya administrasi belum ditetapkan kebijakan.'
        );
    }
  }

  // ---- 6. Arah potongan — satu komponen, satu arah (§D/§H) ----
  const { penaltiDariPokok, biayaDariPokok } = targetPotongan(kebijakan.perlakuanPokok);
  const penyesuaianPokok = (penaltiDariPokok ? penalti : 0) + (biayaDariPokok ? biayaAdmin : 0);
  const penyesuaianBunga = (penaltiDariPokok ? 0 : penalti) + (biayaDariPokok ? 0 : biayaAdmin);

  const pokokDibayar = pokok - penyesuaianPokok;
  const bungaDibayar = bungaSetelahForfeiture - penyesuaianBunga;

  if (pokokDibayar < 0) {
    throw new SettlementDiniTidakDapatDihitungError(
      `Potongan terhadap pokok (${penyesuaianPokok}) melebihi pokok kontrak (${pokok}). ` +
        'Pokok tidak dipotong melebihi nilainya tanpa kebijakan yang menyatakannya.'
    );
  }
  if (bungaDibayar < 0) {
    throw new SettlementDiniTidakDapatDihitungError(
      `Potongan terhadap bunga (${penyesuaianBunga}) melebihi bunga yang tersedia ` +
        `(${bungaSetelahForfeiture}). Perhitungan dihentikan, bukan dipangkas ke nol.`
    );
  }

  const totalPayout = pokokDibayar + bungaDibayar;

  const rateEfektif =
    kontrak.jumlahPeriode > 0
      ? bulatkanRate((bungaBruto * 12 * 100) / (pokok * kontrak.jumlahPeriode))
      : 0;

  return {
    policyVersi: kebijakan.versi,
    pokokBruto: pokok,
    totalBungaEarned,
    bungaSudahDitransfer,
    bungaMasihTerutang,
    bungaAkrualKontrak,
    penyesuaianRate,
    bungaBruto,
    bungaHangus,
    bungaSetelahForfeiture,
    penalti,
    biayaAdmin,
    penyesuaianPokok,
    penyesuaianBunga,
    pokokDibayar,
    bungaDibayar,
    totalPayout,
    rateKontrak,
    rateEfektif,
    periodeBerjalan: kontrak.jumlahPeriode,
  };
}

/**
 * Baris-baris breakdown siap tampil (§I: dilarang hanya satu total).
 * UI & riwayat anggota memakai daftar ini apa adanya sehingga urutan
 * dan label komponennya identik di mana pun ditampilkan.
 */
export function breakdownSettlement(
  h: HasilSettlementDini
): { label: string; nilai: number; tanda: '+' | '-' | '=' }[] {
  return [
    { label: 'Pokok bruto', nilai: h.pokokBruto, tanda: '+' },
    { label: 'Bunga terakru (rate kontrak)', nilai: h.bungaAkrualKontrak, tanda: '+' },
    { label: 'Penyesuaian rate', nilai: h.penyesuaianRate, tanda: h.penyesuaianRate < 0 ? '-' : '+' },
    { label: 'Bunga bruto', nilai: h.bungaBruto, tanda: '=' },
    { label: 'Bunga hangus', nilai: h.bungaHangus, tanda: '-' },
    { label: 'Penalti', nilai: h.penalti, tanda: '-' },
    { label: 'Biaya administrasi', nilai: h.biayaAdmin, tanda: '-' },
    { label: 'Potongan atas pokok', nilai: h.penyesuaianPokok, tanda: '-' },
    { label: 'Potongan atas bunga', nilai: h.penyesuaianBunga, tanda: '-' },
    { label: 'Pokok dibayar', nilai: h.pokokDibayar, tanda: '=' },
    { label: 'Bunga dibayar', nilai: h.bungaDibayar, tanda: '=' },
    { label: 'Total diterima anggota', nilai: h.totalPayout, tanda: '=' },
  ];
}

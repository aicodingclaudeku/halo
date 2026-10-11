import type { HasilEvaluasiKebijakan } from '@/accounting/EarlyWithdrawalPolicy';
import type { StatusSimpananBerjangka } from '@/services/SimpananBerjangkaService';

/**
 * ============================================================
 * STATE TOMBOL "TARIK SEBELUM JATUH TEMPO" (RC-S47 §F/§I/§J/§U)
 * ============================================================
 *
 * KENAPA BERKAS INI ADA, DAN KENAPA IA BUKAN BAGIAN DARI LAYAR.
 *
 * §U melarang UI menyimpulkan kelayakan dari `policy != null`: objek
 * kebijakan bisa ADA tetapi dievaluasi POLICY_REQUIRED, POLICY_CONFLICT,
 * atau DILARANG. Satu-satunya jawaban yang sah datang dari evaluator
 * domain (`evaluasiKebijakanEarlyWithdrawal`, dibawa ke layar lewat
 * `previewPencairanDini().statusKebijakan`) DAN dari pemeriksaan
 * kelayakan kontrak (`alasanTidakBoleh`).
 *
 * Selama pemetaan itu ditulis di dalam `.tsx`, ia tidak dapat diuji:
 * suite proyek ini berjalan di Node tanpa renderer React Native, jadi
 * layar hanya bisa diperiksa lewat regex — dan regex tidak bisa
 * membuktikan bahwa kombinasi status tertentu menghasilkan tombol MATI.
 * Karena itu pemetaannya diangkat ke fungsi murni di sini: dipakai
 * layar detail DAN layar Tarik Simpanan, dan diuji langsung terhadap
 * keluaran service yang sebenarnya (lihat
 * BerjangkaDetailAksiRcS47.test.ts).
 *
 * FUNGSI INI TIDAK MENGHITUNG APA PUN. Ia tidak tahu angka penalti,
 * rate, atau forfeiture — dan tidak boleh tahu. Ia hanya menerjemahkan
 * keputusan yang SUDAH diambil domain menjadi badge, alasan, dan satu
 * boolean `ctaAktif`.
 */

/** Badge yang ditampilkan di kepala seksi (§I). */
export type BadgePencairanDini =
  /** Kebijakan lengkap, kontrak layak — CTA hidup. */
  | 'TERSEDIA'
  /** Kebijakan belum lengkap / bertentangan, atau kontrak tidak layak. */
  | 'BELUM SIAP'
  /** Pengurus secara eksplisit melarang. */
  | 'TIDAK DIIZINKAN';

export interface AksiPencairanDini {
  /**
   * false berarti seksi pencairan dini TIDAK dirender sama sekali —
   * dipakai untuk kontrak yang sudah jatuh tempo/cair/batal (§J).
   */
  tampilkanSeksi: boolean;
  badge: BadgePencairanDini;
  /** Judul singkat, mis. "Belum dapat diproses". */
  judul: string;
  /** Kalimat pendek versi §F/§I. */
  ringkasAlasan: string;
  /**
   * Penjelasan lengkap APA ADANYA dari domain (`evaluasi.pesan` atau
   * `alasanTidakBoleh`). Tidak pernah dikarang di sini.
   */
  detailAlasan: string | null;
  ctaLabel: string;
  ctaAktif: boolean;
}

export const LABEL_CTA_DINI = 'Tarik Sebelum Jatuh Tempo';

/** Alasan versi §F.1 — dipakai apa adanya, tanpa menyebut angka. */
export const RINGKAS_BELUM_LENGKAP = 'Kebijakan penarikan dini belum ditetapkan lengkap.';
export const RINGKAS_DILARANG = 'Penarikan sebelum jatuh tempo tidak diperbolehkan.';
export const RINGKAS_TERSEDIA =
  'Kebijakan penarikan dini sudah ditetapkan. Rincian potongan ditampilkan sebelum transaksi disimpan.';

export interface InputAksiPencairanDini {
  statusKontrak: StatusSimpananBerjangka;
  /** Dari `previewPencairanDini().sudahJatuhTempo` — bukan hitungan UI. */
  sudahJatuhTempo: boolean;
  /** Dari `previewPencairanDini().statusKebijakan`. null = belum terbaca. */
  evaluasi: HasilEvaluasiKebijakan | null;
  /** Dari `previewPencairanDini().alasanTidakBoleh`. */
  alasanTidakBoleh: string | null;
  /** Dari `previewPencairanDini().settlement != null`. */
  adaSettlement: boolean;
}

/**
 * Satu-satunya tempat yang boleh memutuskan tombol pencairan dini
 * hidup atau mati.
 *
 * URUTAN PEMERIKSAAN MENENTUKAN KEAMANAN — jangan dibalik:
 *   1. kontrak yang bukan AKTIF, atau sudah lewat jatuh tempo, tidak
 *      punya seksi pencairan dini sama sekali (§J);
 *   2. evaluasi yang belum terbaca diperlakukan BELUM SIAP, bukan
 *      diasumsikan aman;
 *   3. DILARANG lebih kuat daripada apa pun di bawahnya;
 *   4. CTA hanya hidup bila evaluasi AKTIF, tidak ada alasan
 *      penolakan, DAN settlement benar-benar berhasil dihitung.
 */
export function tentukanAksiPencairanDini(input: InputAksiPencairanDini): AksiPencairanDini {
  const { statusKontrak, sudahJatuhTempo, evaluasi, alasanTidakBoleh, adaSettlement } = input;

  // (1) §J — jatuh tempo memakai pencairan normal. Jangan sampai
  // pengguna mengira pencairan jatuh tempo adalah pencairan dini.
  if (statusKontrak !== 'AKTIF' || sudahJatuhTempo) {
    return {
      tampilkanSeksi: false,
      badge: 'BELUM SIAP',
      judul: 'Tidak berlaku',
      ringkasAlasan: 'Kontrak ini tidak berada pada masa sebelum jatuh tempo.',
      detailAlasan: null,
      ctaLabel: LABEL_CTA_DINI,
      ctaAktif: false,
    };
  }

  const dasar = {
    tampilkanSeksi: true as const,
    ctaLabel: LABEL_CTA_DINI,
  };

  // (2) Belum terbaca -> fail-closed.
  if (!evaluasi) {
    return {
      ...dasar,
      badge: 'BELUM SIAP',
      judul: 'Belum dapat diproses',
      ringkasAlasan: RINGKAS_BELUM_LENGKAP,
      detailAlasan: null,
      ctaAktif: false,
    };
  }

  // (3) Larangan eksplisit pengurus.
  if (evaluasi.status === 'DILARANG') {
    return {
      ...dasar,
      badge: 'TIDAK DIIZINKAN',
      judul: 'Penarikan dini tidak diizinkan',
      ringkasAlasan: RINGKAS_DILARANG,
      detailAlasan: evaluasi.pesan,
      ctaAktif: false,
    };
  }

  if (evaluasi.status !== 'AKTIF') {
    // POLICY_REQUIRED & POLICY_CONFLICT sama-sama berarti keputusan
    // pengurus belum dapat dijalankan.
    return {
      ...dasar,
      badge: 'BELUM SIAP',
      judul: 'Belum dapat diproses',
      ringkasAlasan: RINGKAS_BELUM_LENGKAP,
      detailAlasan: evaluasi.pesan,
      ctaAktif: false,
    };
  }

  // (4) Kebijakan AKTIF, tetapi kontraknya sendiri bisa tetap tidak
  // layak (sudah pernah dicairkan dini, jurnal penempatan dibalik,
  // tanggal tidak sah). Ini BUKAN masalah kebijakan.
  if (alasanTidakBoleh || !adaSettlement) {
    return {
      ...dasar,
      badge: 'BELUM SIAP',
      judul: 'Belum dapat diproses',
      ringkasAlasan: 'Kontrak ini belum dapat dicairkan sebelum jatuh tempo.',
      detailAlasan: alasanTidakBoleh,
      ctaAktif: false,
    };
  }

  return {
    ...dasar,
    badge: 'TERSEDIA',
    judul: 'Pencairan sebelum jatuh tempo tersedia',
    ringkasAlasan: RINGKAS_TERSEDIA,
    detailAlasan: null,
    ctaAktif: true,
  };
}

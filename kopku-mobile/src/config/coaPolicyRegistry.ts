/**
 * ============================================================
 * REGISTER KONFLIK COA — RC-S54 TAHAP 12 (ITEM #14)
 * ============================================================
 *
 * Dua belas kode akun pernah DIMINTA oleh requirement item #14. Seluruhnya
 * sudah diputuskan oleh RC-S53 (POLICY_DECISION_RC-S53.md) dan TIDAK ADA
 * satu pun yang dibuat. Berkas ini adalah matriks konflik itu dalam bentuk
 * data, ditambah satu guard: pembuatan/perubahan akun manual lewat menu
 * COA tidak boleh diam-diam menghidupkan kode yang keputusannya menolak.
 *
 * BERKAS INI TIDAK MENGUBAH KEBIJAKAN APA PUN. Ia hanya mencerminkan
 * keputusan yang sudah ada:
 *   - KEPUTUSAN 01-A : 1-1220 / 1-1240 / 1-1250; piutang dividen diserap 1-1220
 *   - KEPUTUSAN 01-B : 4-1530 -> 4-1300, 4-1540 -> 4-1700 (baris 4-1540
 *                      digantikan 04-A, lihat di bawah). Baris lama
 *                      "4-1510/4-1520 -> 4-1500" DEPRECATED sejak RC-S70.6:
 *                      4-1510 = Pendapatan Bunga Deposito dan 4-1520 =
 *                      Pendapatan Bunga Investasi adalah akun posting aktif
 *                      (lihat pendapatanKoperasiPolicy.ts,
 *                      AKUN_WAJIB_PENDAPATAN_BUNGA). Jurnal historis di 4-1500
 *                      tidak dipindahkan.
 *   - KEPUTUSAN 02   : OPTION A — 1-1660 satu akun, tanpa pemecahan
 *   - KEPUTUSAN 03   : MODEL BIAYA — akun gain/loss nilai wajar tidak aktif
 *                      (DIGANTI RC-S88: model nilai wajar SAK EP 16, 4-2100/5-5000 aktif)
 *
 * RC-S54 TAHAP 15 — FINALISASI (evidence-based, tanpa perubahan akun/mapping):
 *   - 1-660 / 1-661 : KEPUTUSAN 02 ditinjau ulang karena syarat pembukaannya
 *     terpenuhi (model biaya + bangunan disusutkan). Hasil: OPTION A
 *     DITEGASKAN — pemisahan tanah/bangunan ada di DATA (jenis_objek_properti,
 *     nilai_dapat_disusutkan), akumulasi di kontra 1-1670, register per
 *     properti. Akun terpisah tidak menambah informasi yang dibutuhkan
 *     penyusutan, penurunan nilai, maupun laporan.
 *   - 4-1540        : KEPUTUSAN 04-A (income account 4-1300) berlaku; baris
 *     "4-1540 -> 4-1700" pada 01-B digantikan. Dasar: 01-A memasangkan
 *     1-1220 <-> 4-1300 (piutang yang dipakai 04-A/05), 1-1240/4-1700
 *     dicadangkan untuk imbal hasil tetap (KEPUTUSAN 06), dan 01-B sendiri
 *     memetakan dividen (padanan bagian SHU) ke 4-1300.
 *   Tidak ada akun, mapping, jurnal, atau skema yang berubah karena ini.
 *
 * Membatalkan salah satu keputusan itu adalah keputusan kebijakan. Saat itu
 * terjadi, entri terkait di sini diubah BERSAMA migration & rencana
 * reklasifikasinya — bukan sebelumnya.
 *
 * Tidak ada akun, mapping, jurnal, atau skema yang dibuat/diubah oleh
 * berkas ini. Tidak ada kode akun existing yang di-rename/re-number.
 */

export const KODE_POLICY_CONFLICT = 'POLICY_CONFLICT' as const;

export type KeputusanKodeDiminta =
  /** RC-S54 POST-CLOSURE #14: kode diminta kini ADA di COA (akun terdefinisi). */
  | 'DITAMBAHKAN'
  | 'KEEP_EXISTING'
  | 'NO_CHANGE'
  | 'POLICY_DECISION_REQUIRED';

export interface EntriKodeCoaDiminta {
  /** Kode yang diminta requirement item #14. */
  readonly kode: string;
  readonly nama: string;
  /** Akun existing yang menjalankan fungsi itu (kosong = tidak ada akun, sengaja). */
  readonly akunExisting: readonly string[];
  /** Keputusan RC-S53 yang berlaku. */
  readonly policy: string;
  readonly keputusan: KeputusanKodeDiminta;
  /** Alasan singkat — dipakai pesan galat & laporan. */
  readonly alasan: string;
}

export const KODE_COA_DIMINTA_ITEM_14: readonly EntriKodeCoaDiminta[] = [
  {
    kode: '1-660',
    nama: 'Tanah Properti Investasi',
    akunExisting: ['1-1660'],
    policy: 'KEPUTUSAN 02 (OPTION A — TANPA PEMECAHAN, DITEGASKAN RC-S54 T15)',
    keputusan: 'DITAMBAHKAN',
    alasan:
      'Properti investasi tetap satu akun 1-1660; pemisahan tanah/bangunan dilakukan di DATA (jenis_objek_properti), bukan akun.',
  },
  {
    kode: '1-661',
    nama: 'Bangunan Properti Investasi',
    akunExisting: ['1-1660'],
    policy: 'KEPUTUSAN 02 (OPTION A — TANPA PEMECAHAN, DITEGASKAN RC-S54 T15)',
    keputusan: 'DITAMBAHKAN',
    alasan:
      'Properti investasi tetap satu akun 1-1660; penyusutan bangunan memakai kontra-akun 1-1670.',
  },
  {
    kode: '1-220',
    nama: 'Piutang Pendapatan Investasi',
    akunExisting: ['1-1220'],
    policy: 'KEPUTUSAN 01-A',
    keputusan: 'DITAMBAHKAN',
    alasan: 'Sudah ada sebagai 1-1220 (format X-NNNN); tidak di-renumber.',
  },
  {
    kode: '1-230',
    nama: 'Piutang Dividen',
    akunExisting: ['1-1220'],
    policy: 'KEPUTUSAN 01-A (TIDAK DIPERLUKAN — diserap 1-1220)',
    keputusan: 'DITAMBAHKAN',
    alasan: 'Dividen diakui pada 4-1300; sisi piutangnya 1-1220. Akun keempat berfungsi identik.',
  },
  {
    kode: '1-240',
    nama: 'Piutang Bagi Hasil',
    akunExisting: ['1-1240'],
    policy: 'KEPUTUSAN 01-A',
    keputusan: 'DITAMBAHKAN',
    alasan: 'Sudah ada sebagai 1-1240; tidak di-renumber.',
  },
  {
    kode: '1-250',
    nama: 'Piutang Pendapatan Sewa',
    akunExisting: ['1-1250'],
    policy: 'KEPUTUSAN 01-A',
    keputusan: 'DITAMBAHKAN',
    alasan: 'Sudah ada sebagai 1-1250; tidak di-renumber.',
  },
  {
    kode: '4-1510',
    nama: 'Pendapatan Bunga Deposito',
    // RC-S70.6 — akun ini sendiri yang menjalankan fungsinya (bukan lagi 4-1500).
    akunExisting: ['4-1510'],
    policy: 'KEPUTUSAN 01-B DIREVISI RC-S70.6 (AKUN SPESIFIK — Deposito Berjangka)',
    keputusan: 'DITAMBAHKAN',
    alasan:
      'Pendapatan bunga Deposito Berjangka (BUNGA_DEPOSITO) diposting ke 4-1510; 4-1500 bukan target transaksi baru. Jurnal historis 4-1500 tidak dipindahkan.',
  },
  {
    kode: '4-1520',
    nama: 'Pendapatan Bunga Investasi',
    // RC-S70.6 — akun ini sendiri yang menjalankan fungsinya (bukan lagi 4-1500).
    akunExisting: ['4-1520'],
    policy: 'KEPUTUSAN 01-B DIREVISI RC-S70.6 (AKUN SPESIFIK — Usaha Lain)',
    keputusan: 'DITAMBAHKAN',
    alasan:
      'Pendapatan bunga investasi Usaha Lain (BUNGA_USAHA_LAIN) diposting ke 4-1520; 4-1500 bukan target transaksi baru. Jurnal historis 4-1500 tidak dipindahkan.',
  },
  {
    kode: '4-1530',
    nama: 'Pendapatan Dividen',
    akunExisting: ['4-1300'],
    policy: 'KEPUTUSAN 01-B (USE EXISTING)',
    keputusan: 'DITAMBAHKAN',
    alasan: 'Dividen/hasil investasi memakai 4-1300; baris LHU identik (HASIL_INVESTASI).',
  },
  {
    kode: '4-1540',
    nama: 'Pendapatan Jasa (Bagian SHU)',
    akunExisting: ['4-1300'],
    policy: 'KEPUTUSAN 04-A (income account 4-1300; menggantikan baris 4-1540 -> 4-1700 pada 01-B, RC-S54 T15)',
    keputusan: 'DITAMBAHKAN',
    alasan:
      'Bagian SHU diakui Dr 1-1220 / Cr 4-1300 (hasil investasi atas penyertaan); 1-1240/4-1700 dicadangkan untuk imbal hasil tetap.',
  },
  {
    kode: '4-2100',
    nama: 'Keuntungan Perubahan Nilai Wajar Properti Investasi',
    akunExisting: [],
    policy: 'RC-S88 (MODEL NILAI WAJAR SAK EP 16 — menggantikan KEPUTUSAN 03 model biaya)',
    keputusan: 'DITAMBAHKAN',
    alasan: 'Keuntungan perubahan nilai wajar properti investasi (mapping NILAI_WAJAR_PROPERTI_INVESTASI/KREDIT_KEUNTUNGAN).',
  },
  {
    kode: '5-5000',
    nama: 'Kerugian Nilai Wajar Properti Investasi',
    akunExisting: [],
    policy: 'RC-S88 (MODEL NILAI WAJAR SAK EP 16 — menggantikan KEPUTUSAN 03 model biaya)',
    keputusan: 'DITAMBAHKAN',
    alasan: 'Kerugian perubahan nilai wajar properti investasi (mapping NILAI_WAJAR_PROPERTI_INVESTASI/DEBIT_KERUGIAN).',
  },
];

export class CoaPolicyConflictError extends Error {
  readonly kode = KODE_POLICY_CONFLICT;
  readonly kodeAkun: string;
  readonly policy: string;

  constructor(entri: EntriKodeCoaDiminta) {
    const pengganti =
      entri.akunExisting.length > 0 ? ` Gunakan akun existing: ${entri.akunExisting.join(' / ')}.` : '';
    super(
      `${KODE_POLICY_CONFLICT}: kode akun "${entri.kode}" (${entri.nama}) bertentangan dengan ${entri.policy}. ` +
        `${entri.alasan}${pengganti} Perubahan memerlukan keputusan kebijakan.`
    );
    this.name = 'CoaPolicyConflictError';
    this.kodeAkun = entri.kode;
    this.policy = entri.policy;
  }
}

/** Entri register untuk sebuah kode, atau null bila kode tidak berkonflik. */
export function cariKonflikKodeAkun(kode: string): EntriKodeCoaDiminta | null {
  const k = kode.trim();
  // RC-S54 POST-CLOSURE #14 (keputusan pengguna): ke-12 kode diminta DITAMBAHKAN
  // ke COA dengan kode persis. Entri yang sudah berstatus 'DITAMBAHKAN' karena itu
  // BUKAN lagi konflik — akunnya memang ada. Entri lain (bila kelak ada) tetap
  // diblokir. Registry ini tetap menjadi dokumentasi: kode diminta -> akun
  // semantik existing -> status posting.
  const entri = KODE_COA_DIMINTA_ITEM_14.find((e) => e.kode === k) ?? null;
  return entri && entri.keputusan !== 'DITAMBAHKAN' ? entri : null;
}

/** Melempar `CoaPolicyConflictError` bila kode akun bertentangan dengan keputusan COA yang berlaku. */
export function assertKodeAkunTidakKonflikPolicy(kode: string): void {
  const entri = cariKonflikKodeAkun(kode);
  if (entri) throw new CoaPolicyConflictError(entri);
}

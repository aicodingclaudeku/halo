import type {
  BasisBiayaAdmin,
  BasisPenalti,
  CakupanPenyesuaianRate,
  JenisBiayaAdmin,
  JenisForfeiture,
  JenisPenalti,
  JenisPenyesuaianRate,
  KebijakanEarlyWithdrawalDraft,
  PerlakuanBunga,
  PerlakuanPokok,
} from '@/accounting/EarlyWithdrawalPolicy';

/**
 * FORMULIR KEBIJAKAN PENARIKAN DINI YANG DISEDERHANAKAN — PEMETAAN MURNI.
 *
 * Pengurus hanya memutuskan TIGA hal:
 *   1. Penalti            : Tidak Ada / Persentase dari Pokok / Nominal Tetap
 *   2. Bunga              : Bunga Hangus / Bunga Tetap Dibayarkan
 *   3. Biaya Administrasi : Tidak Ada / Nominal Tetap / Persentase dari Pokok
 *
 * Ketiganya diterjemahkan ke parameter kebijakan YANG SUDAH ADA
 * (`KebijakanEarlyWithdrawalDraft`), memakai nilai enum yang sudah ada —
 * tidak ada tipe, kolom, rumus, atau angka baru. Model data, evaluator
 * (`evaluasiKebijakanEarlyWithdrawal`), mesin perhitungan, service,
 * jurnal, dan database TIDAK berubah; opsi lanjutan (penyesuaian rate,
 * persentase bunga hangus, basis lain, biaya persentase) hanya tidak lagi
 * ditawarkan di formulir.
 *
 * ATURAN "BELUM MEMUTUSKAN = NULL" TETAP BERLAKU. Setiap parameter
 * turunan bernilai `null` selama keputusan asalnya belum dipilih, sehingga
 * evaluator tetap melaporkan POLICY_REQUIRED dan pencairan tetap ditolak.
 * Tidak ada nilai bawaan yang diputuskan atas nama pengurus.
 *
 * TERJEMAHAN (dan alasannya):
 *   Bunga Hangus          -> jenisForfeiture 'SELURUH_BUNGA' + perlakuanBunga 'TIDAK_DIBAYAR'
 *   Bunga Tetap Dibayarkan-> jenisForfeiture 'TIDAK_ADA'     + perlakuanBunga 'BAYAR_SETELAH_FORFEITURE'
 *     (dua pasangan yang dinyatakan KONSISTEN oleh evaluator; pasangan lain = POLICY_CONFLICT)
 *   Penyesuaian rate      -> 'TIDAK_ADA' begitu keputusan bunga diambil
 *     (formulir sederhana tidak menawarkan rate penarikan dini; bunga
 *      mengikuti rate kontrak)
 *   Perlakuan pokok       -> diturunkan dari penalti & biaya: potongan
 *     diambil dari dana pokok yang dikembalikan. Ini satu-satunya arah
 *     yang selalu dapat dihitung untuk kedua pilihan bunga — bila bunga
 *     hangus, bunga dibayar 0 sehingga potongan dari bunga pasti ditolak
 *     mesin perhitungan (`bungaDibayar < 0`).
 */

export type PilihanPenalti = 'TIDAK_ADA' | 'PERSEN_POKOK' | 'NOMINAL_TETAP';
export type PilihanBunga = 'HANGUS' | 'DIBAYAR';
/**
 * Biaya administrasi persentase memakai basis POKOK — basis yang sama
 * dengan penalti persentase, dan salah satu basis yang sudah didukung
 * `EarlyWithdrawalCalculation` (`percentageOf(pokok, persen)`).
 */
export type PilihanBiaya = 'TIDAK_ADA' | 'NOMINAL_TETAP' | 'PERSEN_POKOK';

export interface KeputusanSederhana {
  penalti: PilihanPenalti | null;
  bunga: PilihanBunga | null;
  biaya: PilihanBiaya | null;
}

export interface ParameterTurunan {
  jenisPenalti: JenisPenalti | null;
  basisPenalti: BasisPenalti | null;
  jenisForfeiture: JenisForfeiture | null;
  nilaiForfeiture: number | null;
  perlakuanBunga: PerlakuanBunga | null;
  jenisBiayaAdmin: JenisBiayaAdmin | null;
  basisBiayaAdmin: BasisBiayaAdmin | null;
  rateDini: number | null;
  jenisPenyesuaianRate: JenisPenyesuaianRate | null;
  cakupanPenyesuaianRate: CakupanPenyesuaianRate | null;
  perlakuanPokok: PerlakuanPokok | null;
}

export const LABEL_PENALTI: Record<PilihanPenalti, string> = {
  TIDAK_ADA: 'Tidak Ada',
  PERSEN_POKOK: 'Persentase dari Pokok',
  NOMINAL_TETAP: 'Nominal Tetap',
};
export const LABEL_BUNGA: Record<PilihanBunga, string> = {
  HANGUS: 'Bunga Hangus',
  DIBAYAR: 'Bunga Tetap Dibayarkan',
};
export const LABEL_BIAYA: Record<PilihanBiaya, string> = {
  TIDAK_ADA: 'Tidak Ada',
  NOMINAL_TETAP: 'Nominal Tetap',
  PERSEN_POKOK: 'Persentase dari Pokok',
};

function jenisPenaltiDari(p: PilihanPenalti | null): JenisPenalti | null {
  if (p === null) return null;
  if (p === 'TIDAK_ADA') return 'TIDAK_ADA';
  return p === 'PERSEN_POKOK' ? 'PERSENTASE' : 'NOMINAL_TETAP';
}

function perlakuanPokokDari(p: PilihanPenalti | null, b: PilihanBiaya | null): PerlakuanPokok | null {
  if (p === null || b === null) return null;
  const adaPenalti = p !== 'TIDAK_ADA';
  const adaBiaya = b !== 'TIDAK_ADA';
  if (adaPenalti && adaBiaya) return 'DIKURANGI_PENALTI_DAN_BIAYA';
  if (adaPenalti) return 'DIKURANGI_PENALTI';
  if (adaBiaya) return 'DIKURANGI_BIAYA_ADMIN';
  return 'PENUH';
}

/** Tiga keputusan -> parameter kebijakan existing. `null` masuk, `null` keluar. */
export function keParameterKebijakan(k: KeputusanSederhana): ParameterTurunan {
  const bungaDipilih = k.bunga !== null;
  return {
    jenisPenalti: jenisPenaltiDari(k.penalti),
    basisPenalti: k.penalti === 'PERSEN_POKOK' ? 'POKOK' : null,
    jenisForfeiture: k.bunga === null ? null : k.bunga === 'HANGUS' ? 'SELURUH_BUNGA' : 'TIDAK_ADA',
    nilaiForfeiture: null,
    perlakuanBunga: k.bunga === null ? null : k.bunga === 'HANGUS' ? 'TIDAK_DIBAYAR' : 'BAYAR_SETELAH_FORFEITURE',
    jenisBiayaAdmin: k.biaya === null ? null : k.biaya === 'PERSEN_POKOK' ? 'PERSENTASE' : k.biaya,
    basisBiayaAdmin: k.biaya === 'PERSEN_POKOK' ? 'POKOK' : null,
    rateDini: null,
    jenisPenyesuaianRate: bungaDipilih ? 'TIDAK_ADA' : null,
    cakupanPenyesuaianRate: null,
    perlakuanPokok: perlakuanPokokDari(k.penalti, k.biaya),
  };
}

export type BacaKebijakan =
  | { jenis: 'KOSONG' }
  | {
      jenis: 'SEDERHANA';
      keputusan: KeputusanSederhana;
      nilaiPenalti: number | null;
      nilaiBiayaAdmin: number | null;
      akunPenaltiId: string | null;
      akunBiayaAdminId: string | null;
    }
  /** Kebijakan tersimpan memakai opsi lanjutan yang tidak ada di formulir sederhana. */
  | { jenis: 'LANJUTAN' };

/**
 * Kebijakan tersimpan -> tiga keputusan (untuk mengisi ulang formulir).
 * Hanya bila kebijakan itu PERSIS dapat dinyatakan ulang oleh formulir
 * sederhana (hasil `keParameterKebijakan` sama); selain itu `LANJUTAN` —
 * kebijakan tetap berlaku apa adanya, formulir tidak berpura-pura
 * menampilkannya.
 */
export function bacaKebijakanSederhana(k: KebijakanEarlyWithdrawalDraft | null): BacaKebijakan {
  if (!k) return { jenis: 'KOSONG' };
  if (!k.diizinkan) return { jenis: 'KOSONG' };

  const penalti: PilihanPenalti | null =
    k.jenisPenalti === null
      ? null
      : k.jenisPenalti === 'TIDAK_ADA'
        ? 'TIDAK_ADA'
        : k.jenisPenalti === 'NOMINAL_TETAP'
          ? 'NOMINAL_TETAP'
          : k.basisPenalti === 'POKOK'
            ? 'PERSEN_POKOK'
            : null;
  if (k.jenisPenalti === 'PERSENTASE' && penalti === null) return { jenis: 'LANJUTAN' };

  const bunga: PilihanBunga | null =
    k.jenisForfeiture === 'SELURUH_BUNGA' ? 'HANGUS' : k.jenisForfeiture === 'TIDAK_ADA' ? 'DIBAYAR' : null;
  if (k.jenisForfeiture !== null && bunga === null) return { jenis: 'LANJUTAN' };

  const biaya: PilihanBiaya | null =
    k.jenisBiayaAdmin === 'TIDAK_ADA'
      ? 'TIDAK_ADA'
      : k.jenisBiayaAdmin === 'NOMINAL_TETAP'
        ? 'NOMINAL_TETAP'
        : k.jenisBiayaAdmin === 'PERSENTASE' && k.basisBiayaAdmin === 'POKOK'
          ? 'PERSEN_POKOK'
          : null;
  if (k.jenisBiayaAdmin !== null && biaya === null) return { jenis: 'LANJUTAN' };

  const keputusan: KeputusanSederhana = { penalti, bunga, biaya };
  const t = keParameterKebijakan(keputusan);
  const cocok =
    t.jenisPenalti === k.jenisPenalti &&
    (t.basisPenalti === k.basisPenalti || k.jenisPenalti !== 'PERSENTASE') &&
    t.jenisForfeiture === k.jenisForfeiture &&
    t.perlakuanBunga === k.perlakuanBunga &&
    t.jenisBiayaAdmin === k.jenisBiayaAdmin &&
    (t.basisBiayaAdmin === k.basisBiayaAdmin || k.jenisBiayaAdmin !== 'PERSENTASE') &&
    (k.jenisPenyesuaianRate === null || k.jenisPenyesuaianRate === 'TIDAK_ADA') &&
    t.perlakuanPokok === k.perlakuanPokok;
  if (!cocok) return { jenis: 'LANJUTAN' };

  return {
    jenis: 'SEDERHANA',
    keputusan,
    nilaiPenalti: k.nilaiPenalti,
    nilaiBiayaAdmin: k.nilaiBiayaAdmin,
    akunPenaltiId: k.akunPenaltiId,
    akunBiayaAdminId: k.akunBiayaAdminId,
  };
}

const BASIS_LABEL: Record<string, string> = {
  POKOK: 'pokok',
  BUNGA_BRUTO: 'bunga',
  TOTAL_SEBELUM_PENALTI: 'total sebelum penalti',
};

function angkaId(n: number | null): string {
  return n === null ? '-' : String(n).replace('.', ',');
}

function rupiahId(n: number | null): string {
  return n === null ? '-' : 'Rp' + Math.round(n).toLocaleString('id-ID');
}

/**
 * Deskripsi SIAP BACA untuk kebijakan tersimpan apa pun — termasuk versi
 * lama yang memakai opsi lanjutan — dalam bahasa sederhana. Murni
 * tampilan: tidak menghitung, tidak mengubah kebijakan.
 */
export function deskripsiKebijakan(k: KebijakanEarlyWithdrawalDraft): { label: string; nilai: string }[] {
  if (!k.diizinkan) return [{ label: 'Penarikan dini', nilai: 'Tidak diizinkan' }];

  const penalti =
    k.jenisPenalti === null
      ? 'Belum ditetapkan'
      : k.jenisPenalti === 'TIDAK_ADA'
        ? 'Tidak ada'
        : k.jenisPenalti === 'NOMINAL_TETAP'
          ? rupiahId(k.nilaiPenalti)
          : `${angkaId(k.nilaiPenalti)}% dari ${BASIS_LABEL[k.basisPenalti ?? ''] ?? '-'}`;

  const bunga =
    k.jenisForfeiture === null
      ? 'Belum ditetapkan'
      : k.jenisForfeiture === 'SELURUH_BUNGA'
        ? 'Bunga hangus'
        : k.jenisForfeiture === 'TIDAK_ADA'
          ? 'Bunga tetap dibayarkan'
          : k.jenisForfeiture === 'PERSENTASE_BUNGA'
            ? `${angkaId(k.nilaiForfeiture)}% bunga hangus`
            : `${rupiahId(k.nilaiForfeiture)} bunga hangus`;

  const biaya =
    k.jenisBiayaAdmin === null
      ? 'Belum ditetapkan'
      : k.jenisBiayaAdmin === 'TIDAK_ADA'
        ? 'Tidak ada'
        : k.jenisBiayaAdmin === 'NOMINAL_TETAP'
          ? rupiahId(k.nilaiBiayaAdmin)
          : `${angkaId(k.nilaiBiayaAdmin)}% dari ${BASIS_LABEL[k.basisBiayaAdmin ?? ''] ?? '-'}`;

  const baris = [
    { label: 'Penalti', nilai: penalti },
    { label: 'Bunga', nilai: bunga },
    { label: 'Biaya administrasi', nilai: biaya },
  ];
  if (k.jenisPenyesuaianRate === 'RATE_DINI') {
    baris.push({ label: 'Bunga penarikan dini', nilai: `${angkaId(k.rateDini)}% per tahun` });
  }
  return baris;
}

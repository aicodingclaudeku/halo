/**
 * ============================================================
 * KEBIJAKAN PRODUK SIMPANAN BERJANGKA — POLICY LAYER (MURNI, RC-S128)
 * ============================================================
 *
 * Simpanan berjangka adalah simpanan yang penarikannya dilakukan pada
 * waktu tertentu menurut perjanjian dengan koperasi. Apa yang terjadi
 * SETELAH jatuh tempo — pokok tetap di koperasi atau tidak, berbunga
 * atau tidak, berapa rate-nya, diperpanjang otomatis atau tidak — adalah
 * KETENTUAN PRODUK koperasi, bukan hukum universal. Karena itu seluruh
 * perilaku pasca jatuh tempo dibaca dari kebijakan berversi di sini,
 * dan kontrak menyimpan SNAPSHOT-nya saat penempatan.
 *
 * Modul ini murni (tanpa database): tipe, validasi, pemilihan versi yang
 * berlaku pada suatu tanggal, dan pembentukan snapshot. Penyimpanan ada
 * di `SimpananBerjangkaKebijakanProdukService.ts`.
 *
 * YANG SENGAJA TIDAK ADA DI SINI:
 *  - angka rate pasca jatuh tempo. Tidak ada default; nilainya wajib
 *    diisi pengurus saat menetapkan kebijakan.
 *  - mesin perpanjangan otomatis. `auto_renewal = TRUE` DITOLAK validasi
 *    (bukan diterima lalu diam-diam diabaikan) sampai ada keputusan
 *    tertulis dan mesin perpanjangan yang diuji.
 *  - kapitalisasi bunga ke pokok dan bunga prorata periode parsial.
 *    Keduanya bukan pilihan yang tersedia: bunga selalu dikreditkan ke
 *    Simpanan Sukarela, pokok tidak pernah bertambah, dan periode yang
 *    belum genap satu bulan kalender tidak diakui.
 */

export type StatusKebijakanProduk = 'AKTIF' | 'DICABUT';
export type BasisRateKebijakan = 'TAHUNAN';
export type MetodePeriodeKebijakan = 'BULAN_KALENDER';
export type TujuanKreditBunga = 'SIMPANAN_SUKARELA';
export type StatusPolicyKontrak = 'POLICY_SNAPSHOT' | 'LEGACY_POLICY_REVIEW_REQUIRED' | 'LEGACY_POLICY_DITERAPKAN';

export interface KebijakanProdukBerjangka {
  id: string;
  versi: string;
  berlakuMulai: string;
  status: StatusKebijakanProduk;
  autoRenewal: boolean;
  bungaPascaJatuhTempoAktif: boolean;
  /** Persen per tahun; null bila bunga pasca jatuh tempo tidak aktif. */
  ratePascaJatuhTempo: number | null;
  basisRate: BasisRateKebijakan;
  metodePeriode: MetodePeriodeKebijakan;
  bungaDikreditkanKe: TujuanKreditBunga;
  kapitalisasiBunga: false;
  pokokTetapDiBerjangka: true;
  dasarPenetapan: string;
  ditetapkanOleh: string;
  ditetapkanPada: string;
  catatan: string | null;
  dicabutOleh: string | null;
  dicabutPada: string | null;
  alasanDicabut: string | null;
  createdBy: string;
  createdAt: string;
}

/** Isian pengurus untuk versi baru. */
export interface DrafKebijakanProduk {
  versi: string;
  berlakuMulai: string;
  autoRenewal: boolean;
  bungaPascaJatuhTempoAktif: boolean;
  ratePascaJatuhTempo: number | null;
  dasarPenetapan: string;
  ditetapkanOleh: string;
  ditetapkanPada: string;
  catatan?: string | null;
}

/**
 * Rekomendasi kebijakan untuk produk KOPKU — DIPAKAI SEBAGAI ISIAN AWAL
 * FORM, bukan kebijakan yang berlaku. Rate pasca jatuh tempo sengaja
 * TIDAK diisi: itu keputusan produk koperasi.
 */
export const REKOMENDASI_KEBIJAKAN_PRODUK = {
  AUTO_RENEWAL: false,
  POST_MATURITY_INTEREST: true,
  INTEREST_CREDIT_DESTINATION: 'SIMPANAN_SUKARELA' as TujuanKreditBunga,
  PRINCIPAL_REMAINS_IN_TERM_SAVINGS: true,
  INTEREST_IS_CAPITALIZED_TO_PRINCIPAL: false,
} as const;

/** Snapshot yang disalin ke kontrak saat penempatan. */
export interface SnapshotKebijakanKontrak {
  policyId: string;
  policyVersi: string;
  autoRenewal: boolean;
  bungaPascaAktif: boolean;
  ratePascaJatuhTempo: number | null;
  basisRate: BasisRateKebijakan;
  metodePeriode: MetodePeriodeKebijakan;
  bungaDikreditkanKe: TujuanKreditBunga;
  kapitalisasiBunga: false;
  pokokTetap: true;
}

const POLA_TANGGAL = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const PESAN_KEBIJAKAN_PRODUK_BELUM_ADA =
  'Kebijakan produk Simpanan Berjangka yang berlaku pada tanggal penempatan belum ditetapkan. ' +
  'Pengurus perlu menetapkannya lebih dulu (Simpanan › Kebijakan Produk Simpanan Berjangka).';

/** Daftar kesalahan; kosong = draf boleh disimpan. */
export function validasiDrafKebijakanProduk(d: DrafKebijakanProduk): string[] {
  const e: string[] = [];
  if (!d.versi || !d.versi.trim()) e.push('Nomor versi kebijakan wajib diisi.');
  if (!POLA_TANGGAL.test(d.berlakuMulai)) e.push('Tanggal mulai berlaku harus berformat YYYY-MM-DD.');
  if (!POLA_TANGGAL.test(d.ditetapkanPada)) e.push('Tanggal penetapan harus berformat YYYY-MM-DD.');
  if (!d.dasarPenetapan || !d.dasarPenetapan.trim()) e.push('Dasar penetapan (mis. nomor keputusan pengurus/RAT) wajib diisi.');
  if (!d.ditetapkanOleh || !d.ditetapkanOleh.trim()) e.push('Pihak yang menetapkan wajib diisi.');
  if (d.autoRenewal) {
    e.push(
      'Perpanjangan otomatis belum didukung mesin KOPKU. Tetapkan "tanpa perpanjangan otomatis"; ' +
        'kontrak yang jatuh tempo tetap tersimpan sampai anggota mencairkannya.'
    );
  }
  if (d.bungaPascaJatuhTempoAktif) {
    if (d.ratePascaJatuhTempo === null || d.ratePascaJatuhTempo === undefined || !Number.isFinite(d.ratePascaJatuhTempo)) {
      e.push('Rate bunga pasca jatuh tempo wajib diisi bila bunga pasca jatuh tempo diaktifkan.');
    } else if (d.ratePascaJatuhTempo <= 0) {
      e.push('Rate bunga pasca jatuh tempo harus lebih dari 0% per tahun. Matikan bunga pasca jatuh tempo bila rate-nya 0.');
    }
  } else if (d.ratePascaJatuhTempo !== null && d.ratePascaJatuhTempo !== undefined && d.ratePascaJatuhTempo !== 0) {
    e.push('Rate pasca jatuh tempo hanya diisi bila bunga pasca jatuh tempo diaktifkan.');
  }
  return e;
}

/**
 * Kebijakan yang BERLAKU pada `tanggal`: versi AKTIF dengan
 * `berlaku_mulai` terbesar yang <= tanggal. SATU-SATUNYA aturan
 * pemilihan versi — service & UI memanggil fungsi ini.
 */
export function pilihKebijakanUntukTanggal(
  daftar: readonly KebijakanProdukBerjangka[],
  tanggal: string
): KebijakanProdukBerjangka | null {
  let hasil: KebijakanProdukBerjangka | null = null;
  for (const k of daftar) {
    if (k.status !== 'AKTIF' || k.berlakuMulai > tanggal) continue;
    if (!hasil || k.berlakuMulai > hasil.berlakuMulai) hasil = k;
  }
  return hasil;
}

/** Validasi ulang kebijakan tersimpan sebelum dipakai kontrak (pertahanan berlapis). */
export function alasanKebijakanTidakLayak(k: KebijakanProdukBerjangka | null): string | null {
  if (!k) return PESAN_KEBIJAKAN_PRODUK_BELUM_ADA;
  if (k.status !== 'AKTIF') return `Kebijakan produk versi ${k.versi} sudah dicabut.`;
  const galat = validasiDrafKebijakanProduk({
    versi: k.versi,
    berlakuMulai: k.berlakuMulai,
    autoRenewal: k.autoRenewal,
    bungaPascaJatuhTempoAktif: k.bungaPascaJatuhTempoAktif,
    ratePascaJatuhTempo: k.ratePascaJatuhTempo,
    dasarPenetapan: k.dasarPenetapan,
    ditetapkanOleh: k.ditetapkanOleh,
    ditetapkanPada: k.ditetapkanPada,
  });
  return galat.length ? `Kebijakan produk versi ${k.versi} tidak lengkap: ${galat[0]}` : null;
}

export function snapshotDariKebijakan(k: KebijakanProdukBerjangka): SnapshotKebijakanKontrak {
  return {
    policyId: k.id,
    policyVersi: k.versi,
    autoRenewal: k.autoRenewal,
    bungaPascaAktif: k.bungaPascaJatuhTempoAktif,
    ratePascaJatuhTempo: k.bungaPascaJatuhTempoAktif ? k.ratePascaJatuhTempo : null,
    basisRate: k.basisRate,
    metodePeriode: k.metodePeriode,
    bungaDikreditkanKe: k.bungaDikreditkanKe,
    kapitalisasiBunga: false,
    pokokTetap: true,
  };
}

/** Pemetaan baris tabel -> objek domain. */
export function petakanKebijakanProduk(r: Record<string, any>): KebijakanProdukBerjangka {
  return {
    id: r.id,
    versi: r.versi,
    berlakuMulai: r.berlaku_mulai,
    status: r.status,
    autoRenewal: r.auto_renewal === 1,
    bungaPascaJatuhTempoAktif: r.bunga_pasca_jatuh_tempo_aktif === 1,
    ratePascaJatuhTempo: r.rate_pasca_jatuh_tempo ?? null,
    basisRate: r.basis_rate,
    metodePeriode: r.metode_periode,
    bungaDikreditkanKe: r.bunga_dikreditkan_ke,
    kapitalisasiBunga: false,
    pokokTetapDiBerjangka: true,
    dasarPenetapan: r.dasar_penetapan,
    ditetapkanOleh: r.ditetapkan_oleh,
    ditetapkanPada: r.ditetapkan_pada,
    catatan: r.catatan ?? null,
    dicabutOleh: r.dicabut_oleh ?? null,
    dicabutPada: r.dicabut_pada ?? null,
    alasanDicabut: r.alasan_dicabut ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/** Ringkasan satu kalimat — dipakai layar & dokumen (tanpa menghitung apa pun). */
export function ringkasanPerlakuanPascaJatuhTempo(s: {
  autoRenewal: boolean;
  bungaPascaAktif: boolean;
  ratePascaJatuhTempo: number | null;
}): string {
  const perpanjangan = s.autoRenewal ? 'diperpanjang otomatis' : 'tidak diperpanjang otomatis';
  const bunga = s.bungaPascaAktif && s.ratePascaJatuhTempo
    ? `pokok tetap disimpan dan memperoleh bunga ${formatPersen(s.ratePascaJatuhTempo)} per tahun per bulan kalender penuh sampai dicairkan`
    : 'pokok tetap disimpan tanpa bunga sampai dicairkan';
  return `Setelah jatuh tempo kontrak ${perpanjangan}; ${bunga}.`;
}

export function formatPersen(n: number): string {
  return `${n.toLocaleString('id-ID', { maximumFractionDigits: 4 })}%`;
}

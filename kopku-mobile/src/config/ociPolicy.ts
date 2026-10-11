/**
 * ============================================================
 * PENGHASILAN KOMPREHENSIF LAIN (OCI) — KEBIJAKAN PENYAJIAN (RC-S88)
 * ============================================================
 *
 * SAK EP (efektif 1 Januari 2025) menyajikan laba rugi dan penghasilan
 * komprehensif lain dalam SATU laporan: setelah SHU Neto (laba rugi),
 * laporan dilanjutkan dengan pos OCI dan diakhiri TOTAL PENGHASILAN
 * KOMPREHENSIF. Pos OCI dikelompokkan menjadi:
 *
 *   1. pos yang TIDAK AKAN direklasifikasi ke laba rugi
 *      (mis. surplus revaluasi aset tetap — saat aset dilepas, surplus
 *      dipindahkan langsung ke saldo laba, tidak lewat laba rugi);
 *   2. pos yang AKAN direklasifikasi ke laba rugi (mis. selisih kurs
 *      penjabaran kegiatan usaha luar negeri) — tidak ada sumbernya di
 *      koperasi ini, kelompok ini tetap disiapkan agar strukturnya
 *      sesuai standar dan tampil "tidak ada" secara jujur.
 *
 * SUMBER ANGKA. OCI tidak pernah melewati akun pendapatan/beban.
 * Ia DIBACA dari mutasi akun EKUITAS cadangan OCI di bawah, HANYA dari
 * jurnal yang sumbernya transaksi OCI (`SUMBER_JURNAL_OCI`) — saldo awal,
 * koreksi, atau pemindahan surplus ke saldo laba bukan OCI periode
 * berjalan dan karena itu tidak ikut dihitung.
 *
 * SHU. Pos OCI bukan bagian SHU: tidak dibagikan kepada anggota dan
 * tidak memengaruhi dasar perhitungan SHU maupun pajak penghasilan.
 */

export type KelompokOci = 'TIDAK_DIREKLASIFIKASI' | 'DIREKLASIFIKASI';

export interface AkunOci {
  /** Kode akun EKUITAS tempat OCI diakumulasikan. */
  readonly kode: string;
  /** Label pos OCI pada laporan (bila berbeda dari nama akun). */
  readonly labelLaporan: string;
  readonly kelompok: KelompokOci;
}

/** Sumber jurnal yang merupakan transaksi OCI. */
export const SUMBER_JURNAL_REVALUASI_ASET_TETAP = 'REVALUASI_ASET_TETAP';

export const SUMBER_JURNAL_OCI: readonly string[] = [SUMBER_JURNAL_REVALUASI_ASET_TETAP];

export const KODE_AKUN_SURPLUS_REVALUASI = '3-6000';

export const AKUN_OCI: readonly AkunOci[] = [
  {
    kode: KODE_AKUN_SURPLUS_REVALUASI,
    labelLaporan: 'Surplus revaluasi aset tetap',
    kelompok: 'TIDAK_DIREKLASIFIKASI',
  },
];

export const LABEL_KELOMPOK_OCI: Record<KelompokOci, string> = {
  TIDAK_DIREKLASIFIKASI: 'Pos yang tidak akan direklasifikasi ke laba rugi',
  DIREKLASIFIKASI: 'Pos yang akan direklasifikasi ke laba rugi',
};

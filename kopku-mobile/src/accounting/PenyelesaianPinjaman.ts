/**
 * RC-S133.6.4 (v82) — ATURAN MURNI PENCATATAN PENYELESAIAN PINJAMAN KE
 * PENGADILAN NEGERI / KLAIM ASURANSI (kriteria Macet angka 3, SOM 12.1).
 *
 * Tanpa import database maupun modul native, supaya validasi dan labelnya
 * dipakai bersama service, layar, dan export, dan bisa diuji langsung.
 *
 * Mengapa dicatat MANUAL: nomor perkara / nomor klaim dan dokumennya hanya
 * diketahui manusia (Admin/Pengurus); tidak ada yang dapat ditebak otomatis
 * dari data pinjaman.
 */

export type JalurPenyelesaian = 'PENGADILAN' | 'ASURANSI';

export const DAFTAR_JALUR_PENYELESAIAN: readonly JalurPenyelesaian[] = ['PENGADILAN', 'ASURANSI'];

export const LABEL_JALUR_PENYELESAIAN: Record<JalurPenyelesaian, string> = {
  PENGADILAN: 'Diserahkan ke Pengadilan Negeri',
  ASURANSI: 'Klaim ganti rugi ke perusahaan asuransi kredit',
};

/** Label kolom nomor menurut jalur. */
export const LABEL_NOMOR_PENYELESAIAN: Record<JalurPenyelesaian, string> = {
  PENGADILAN: 'Nomor perkara',
  ASURANSI: 'Nomor klaim',
};

export const LABEL_TANGGAL_PENYELESAIAN: Record<JalurPenyelesaian, string> = {
  PENGADILAN: 'Tanggal diserahkan ke Pengadilan Negeri',
  ASURANSI: 'Tanggal klaim diajukan',
};

export const BATAS_PANJANG_PENYELESAIAN = { nomor: 100, dokumen: 200, alasan: 500 } as const;

export interface InputPenyelesaian {
  jalur: string;
  tanggal: string;
  nomor: string;
  dokumen: string;
  alasan?: string | null;
}

export interface PenyelesaianTernormalisasi {
  jalur: JalurPenyelesaian;
  tanggal: string;
  nomor: string;
  dokumen: string;
  alasan: string | null;
}

export type HasilValidasiPenyelesaian =
  | { valid: true; nilai: PenyelesaianTernormalisasi }
  | { valid: false; galat: string[] };

/** True untuk YYYY-MM-DD yang benar-benar ada di kalender (2026-02-30 ditolak). */
export function tanggalIsoValid(t: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const [y, m, d] = t.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Validasi isian pencatatan. `hariIni` (YYYY-MM-DD, jam aplikasi) membatasi
 * tanggal: penyerahan ke pengadilan / pengajuan klaim yang belum terjadi tidak
 * boleh dicatat. `tanggalPinjaman` (opsional) menolak tanggal sebelum akad.
 */
export function validasiPenyelesaian(
  input: InputPenyelesaian,
  hariIni: string,
  tanggalPinjaman?: string | null
): HasilValidasiPenyelesaian {
  const galat: string[] = [];
  const jalur = DAFTAR_JALUR_PENYELESAIAN.find((j) => j === input.jalur);
  if (!jalur) galat.push('Jalur penyelesaian wajib dipilih: Pengadilan Negeri atau Klaim Asuransi.');

  const tanggal = (input.tanggal ?? '').trim();
  if (!tanggalIsoValid(tanggal)) {
    galat.push('Tanggal wajib diisi dengan format YYYY-MM-DD yang valid.');
  } else if (tanggal > hariIni) {
    galat.push('Tanggal tidak boleh di masa depan: hanya penyelesaian yang sudah diserahkan/diajukan yang boleh dicatat.');
  } else if (tanggalPinjaman && tanggal < tanggalPinjaman) {
    galat.push(`Tanggal tidak boleh sebelum tanggal akad pinjaman (${tanggalPinjaman}).`);
  }

  const nomor = (input.nomor ?? '').trim();
  const labelNomor = jalur ? LABEL_NOMOR_PENYELESAIAN[jalur] : 'Nomor perkara / klaim';
  if (!nomor) galat.push(`${labelNomor} wajib diisi.`);
  else if (nomor.length > BATAS_PANJANG_PENYELESAIAN.nomor) {
    galat.push(`${labelNomor} maksimal ${BATAS_PANJANG_PENYELESAIAN.nomor} karakter.`);
  }

  const dokumen = (input.dokumen ?? '').trim();
  if (!dokumen) galat.push('Dokumen bukti wajib diisi (mis. nomor/nama surat gugatan atau surat pengajuan klaim).');
  else if (dokumen.length > BATAS_PANJANG_PENYELESAIAN.dokumen) {
    galat.push(`Dokumen bukti maksimal ${BATAS_PANJANG_PENYELESAIAN.dokumen} karakter.`);
  }

  const alasan = (input.alasan ?? '').trim();
  if (alasan.length > BATAS_PANJANG_PENYELESAIAN.alasan) {
    galat.push(`Keterangan maksimal ${BATAS_PANJANG_PENYELESAIAN.alasan} karakter.`);
  }

  if (galat.length > 0 || !jalur) return { valid: false, galat };
  return { valid: true, nilai: { jalur, tanggal, nomor, dokumen, alasan: alasan || null } };
}

/** Kalimat ringkas untuk layar/export: "Pengadilan Negeri no. 123/Pdt.G/2026, tercatat 2026-09-01". */
export function ringkasPenyelesaian(p: {
  jalur: JalurPenyelesaian;
  nomor?: string | null;
  tanggal?: string | null;
}): string {
  const dasar = p.jalur === 'PENGADILAN' ? 'Pengadilan Negeri' : 'Klaim asuransi kredit';
  return `${dasar}${p.nomor ? ` no. ${p.nomor}` : ''}${p.tanggal ? `, tercatat ${p.tanggal}` : ''}`;
}

export interface PenyelesaianPinjaman {
  pinjamanId: string;
  jalur: JalurPenyelesaian;
  tanggal: string;
  nomor: string;
  dokumen: string;
  alasan: string | null;
  /** app_user.id pencatat terakhir. */
  dicatatOleh: string | null;
}

export interface BarisPenyelesaian {
  penyelesaian_jalur: string | null;
  penyelesaian_tanggal: string | null;
  penyelesaian_nomor: string | null;
  penyelesaian_dokumen: string | null;
  penyelesaian_alasan: string | null;
  penyelesaian_oleh: string | null;
}

/** Ubah kolom `pinjaman.penyelesaian_*` menjadi objek; null bila tidak ada pencatatan. */
export function bacaPenyelesaianDariRow(
  pinjamanId: string,
  row: Partial<BarisPenyelesaian> | null | undefined
): PenyelesaianPinjaman | null {
  if (!row || (row.penyelesaian_jalur !== 'PENGADILAN' && row.penyelesaian_jalur !== 'ASURANSI')) return null;
  return {
    pinjamanId,
    jalur: row.penyelesaian_jalur,
    tanggal: row.penyelesaian_tanggal ?? '',
    nomor: row.penyelesaian_nomor ?? '',
    dokumen: row.penyelesaian_dokumen ?? '',
    alasan: row.penyelesaian_alasan ?? null,
    dicatatOleh: row.penyelesaian_oleh ?? null,
  };
}

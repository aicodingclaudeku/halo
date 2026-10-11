/**
 * RC-S82 (lanjutan) — PENGURUS INTI: KETUA, SEKRETARIS, BENDAHARA (MURNI).
 * ============================================================
 * Tidak ada tabel baru: pengurus tetap baris `koperasi_personel` dengan
 * `jenis_personel = 'PENGURUS'`. Modul ini hanya menetapkan SATU cara
 * mengenali tiga jabatan inti dari kolom `jabatan` (teks bebas pada data
 * lama) dan memilih pemegang jabatan pada suatu tanggal.
 *
 * Dasar: UU No. 25 Tahun 1992 tentang Perkoperasian Pasal 30 ayat (2)
 * huruf a — Pengurus berwenang mewakili Koperasi di dalam dan di luar
 * pengadilan. Karena itu dokumen perjanjian pinjaman ditandatangani
 * Ketua atas nama Koperasi, diketahui Sekretaris dan Bendahara.
 */

export type JabatanPengurusInti = 'KETUA' | 'SEKRETARIS' | 'BENDAHARA';

export const JABATAN_PENGURUS_INTI: readonly JabatanPengurusInti[] = ['KETUA', 'SEKRETARIS', 'BENDAHARA'];

/** Teks jabatan KANONIK yang disimpan ke kolom `jabatan`. */
export const LABEL_JABATAN_PENGURUS: Record<JabatanPengurusInti, string> = {
  KETUA: 'Ketua',
  SEKRETARIS: 'Sekretaris',
  BENDAHARA: 'Bendahara',
};

/**
 * Kenali jabatan inti dari teks bebas. KETAT: hanya kecocokan penuh
 * setelah normalisasi — "Wakil Ketua" BUKAN Ketua, "Ketua Pengawas"
 * BUKAN Ketua Pengurus. Ejaan "Sekertaris" (salah eja umum) diterima.
 */
export function kenaliJabatanPengurusInti(jabatan: string | null | undefined): JabatanPengurusInti | null {
  const t = (jabatan ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/ (pengurus|koperasi)$/, '');
  if (t === 'ketua') return 'KETUA';
  if (t === 'sekretaris' || t === 'sekertaris') return 'SEKRETARIS';
  if (t === 'bendahara') return 'BENDAHARA';
  return null;
}

export interface KandidatPengurus {
  id: string;
  nama: string;
  jabatan: string | null;
  jenisPersonel: string;
  statusAktif: boolean;
  tanggalMulaiJabatan: string | null;
  tanggalBerakhirJabatan: string | null;
  updatedAt: string;
}

export interface PejabatPengurus {
  id: string;
  nama: string;
  jabatan: JabatanPengurusInti;
  tanggalMulaiJabatan: string | null;
  tanggalBerakhirJabatan: string | null;
}

export type SusunanPengurusInti = Record<JabatanPengurusInti, PejabatPengurus | null>;

/** Masa jabatan mencakup tanggal? Tanggal mulai/berakhir NULL = tidak dibatasi pada sisi itu. */
export function menjabatPada(k: Pick<KandidatPengurus, 'tanggalMulaiJabatan' | 'tanggalBerakhirJabatan'>, tanggal: string): boolean {
  if (k.tanggalMulaiJabatan && k.tanggalMulaiJabatan > tanggal) return false;
  if (k.tanggalBerakhirJabatan && k.tanggalBerakhirJabatan < tanggal) return false;
  return true;
}

/**
 * Pemegang tiap jabatan inti PADA `tanggal` (mis. tanggal akad — dokumen
 * historis memakai pengurus yang menjabat saat akad, bukan pengurus hari
 * ini). Hanya personel PENGURUS yang aktif. Bila data lama memuat lebih
 * dari satu kandidat, dipilih yang mulai menjabat paling akhir, lalu yang
 * terakhir diperbarui — deterministik.
 */
export function pilihSusunanPengurusInti(kandidat: readonly KandidatPengurus[], tanggal: string): SusunanPengurusInti {
  const hasil: SusunanPengurusInti = { KETUA: null, SEKRETARIS: null, BENDAHARA: null };
  const terbaik: Partial<Record<JabatanPengurusInti, KandidatPengurus>> = {};
  for (const k of kandidat) {
    if (k.jenisPersonel !== 'PENGURUS' || !k.statusAktif) continue;
    const j = kenaliJabatanPengurusInti(k.jabatan);
    if (!j || !menjabatPada(k, tanggal)) continue;
    const kini = terbaik[j];
    const mulaiK = k.tanggalMulaiJabatan ?? '';
    const mulaiKini = kini?.tanggalMulaiJabatan ?? '';
    if (!kini || mulaiK > mulaiKini || (mulaiK === mulaiKini && k.updatedAt > kini.updatedAt)) terbaik[j] = k;
  }
  for (const j of JABATAN_PENGURUS_INTI) {
    const k = terbaik[j];
    if (k) {
      hasil[j] = {
        id: k.id,
        nama: k.nama,
        jabatan: j,
        tanggalMulaiJabatan: k.tanggalMulaiJabatan,
        tanggalBerakhirJabatan: k.tanggalBerakhirJabatan,
      };
    }
  }
  return hasil;
}

/** Jabatan inti yang belum terisi (untuk peringatan UI sebelum mencetak perjanjian). */
export function jabatanIntiKosong(s: SusunanPengurusInti): JabatanPengurusInti[] {
  return JABATAN_PENGURUS_INTI.filter((j) => !s[j]);
}

/** Dua masa jabatan tumpang-tindih? (NULL = terbuka.) */
export function masaJabatanTumpangTindih(
  a: Pick<KandidatPengurus, 'tanggalMulaiJabatan' | 'tanggalBerakhirJabatan'>,
  b: Pick<KandidatPengurus, 'tanggalMulaiJabatan' | 'tanggalBerakhirJabatan'>
): boolean {
  const aMulai = a.tanggalMulaiJabatan ?? '0000-00-00';
  const aAkhir = a.tanggalBerakhirJabatan ?? '9999-99-99';
  const bMulai = b.tanggalMulaiJabatan ?? '0000-00-00';
  const bAkhir = b.tanggalBerakhirJabatan ?? '9999-99-99';
  return aMulai <= bAkhir && bMulai <= aAkhir;
}

import type { SimpananBerjangkaDaftarRow, StatusSimpananBerjangka } from '@/services/SimpananBerjangkaService';

/**
 * ============================================================
 * RC-S129 — PENCARIAN, FILTER & URUTAN DAFTAR SIMPANAN BERJANGKA
 * ============================================================
 *
 * Murni presentasi: menyaring dan mengurutkan baris yang SUDAH dibaca dari
 * subledger (`listSimpananBerjangkaDaftar`). Tidak ada angka keuangan yang
 * dihitung, dan tidak ada aritmetika tanggal — "jatuh tempo bulan ini"
 * cukup membandingkan awalan YYYY-MM.
 */

export type FilterStatusBerjangka = 'SEMUA' | StatusSimpananBerjangka;
export type UrutanBerjangka = 'TERBARU' | 'JATUH_TEMPO_TERDEKAT' | 'NOMINAL_TERBESAR';

export interface KriteriaDaftarBerjangka {
  /** Teks bebas: nama anggota, nomor anggota, nomor kontrak, keterangan, versi kebijakan, atau angka nominal. */
  cari: string;
  status: FilterStatusBerjangka;
  urutan: UrutanBerjangka;
  /** Hanya kontrak berjalan yang jatuh tempo pada bulan `hariIni`. */
  jatuhTempoBulanIni: boolean;
  /** Hanya kontrak lama yang kebijakan produknya perlu ditinjau pengurus. */
  perluDitinjau: boolean;
  /** YYYY-MM-DD (tanggal lokal perangkat / jam pengujian). */
  hariIni: string;
}

export const KRITERIA_AWAL: Omit<KriteriaDaftarBerjangka, 'hariIni'> = {
  cari: '',
  status: 'SEMUA',
  urutan: 'TERBARU',
  jatuhTempoBulanIni: false,
  perluDitinjau: false,
};

export const LABEL_URUTAN: Record<UrutanBerjangka, string> = {
  TERBARU: 'Terbaru',
  JATUH_TEMPO_TERDEKAT: 'Jatuh tempo terdekat',
  NOMINAL_TERBESAR: 'Pokok terbesar',
};

/** Status yang masih menjadi kewajiban koperasi (pokok belum dicairkan). */
const BERJALAN: readonly StatusSimpananBerjangka[] = ['AKTIF', 'JATUH_TEMPO'];

export function kontrakBerjalan(r: Pick<SimpananBerjangkaDaftarRow, 'status'>): boolean {
  return BERJALAN.includes(r.status);
}

export function jatuhTempoPadaBulan(r: Pick<SimpananBerjangkaDaftarRow, 'status' | 'tanggalJatuhTempo'>, hariIni: string): boolean {
  return kontrakBerjalan(r) && r.tanggalJatuhTempo.slice(0, 7) === hariIni.slice(0, 7);
}

export function perluDitinjauPengurus(r: Pick<SimpananBerjangkaDaftarRow, 'status' | 'statusPolicy'>): boolean {
  return kontrakBerjalan(r) && r.statusPolicy === 'LEGACY_POLICY_REVIEW_REQUIRED';
}

const normal = (s: string) => s.toLocaleLowerCase('id-ID').replace(/\s+/g, ' ').trim();

/** Satu baris cocok dengan teks pencarian? Kosong = selalu cocok. */
export function cocokPencarianBerjangka(r: SimpananBerjangkaDaftarRow, cari: string): boolean {
  const q = normal(cari);
  if (!q) return true;
  const teks = normal(
    [r.namaAnggota, r.nomorAnggota, r.nomorTransaksi, r.keterangan, r.policyVersi].filter(Boolean).join(' | ')
  );
  // Setiap kata kunci harus ditemukan (urutan bebas): "siti 2026" cocok dengan "Siti Aminah · SPB-2026-000001".
  if (q.split(' ').every((kata) => teks.includes(kata))) return true;
  // Pencarian angka nominal: "10.000.000", "Rp10000000", atau awalan "10000" -> cocok bila pokok DIAWALI digit itu
  // (bukan sekadar memuatnya, supaya "5.000.000" tidak ikut menemukan 25.000.000).
  const digit = cari.replace(/\D/g, '');
  return digit.length >= 4 && String(r.nominal).startsWith(digit);
}

function bandingkan(urutan: UrutanBerjangka) {
  return (a: SimpananBerjangkaDaftarRow, b: SimpananBerjangkaDaftarRow): number => {
    if (urutan === 'JATUH_TEMPO_TERDEKAT') {
      // Kontrak berjalan dulu (yang perlu tindakan), lalu yang sudah selesai.
      const ka = kontrakBerjalan(a) ? 0 : 1;
      const kb = kontrakBerjalan(b) ? 0 : 1;
      if (ka !== kb) return ka - kb;
      return a.tanggalJatuhTempo.localeCompare(b.tanggalJatuhTempo);
    }
    if (urutan === 'NOMINAL_TERBESAR') {
      if (a.nominal !== b.nominal) return a.nominal > b.nominal ? -1 : 1;
      return b.tanggalMulai.localeCompare(a.tanggalMulai);
    }
    const t = b.tanggalMulai.localeCompare(a.tanggalMulai);
    return t !== 0 ? t : b.createdAt.localeCompare(a.createdAt);
  };
}

/** Terapkan seluruh kriteria. Mengembalikan array BARU; input tidak diubah. */
export function saringDaftarBerjangka(
  rows: readonly SimpananBerjangkaDaftarRow[],
  k: KriteriaDaftarBerjangka
): SimpananBerjangkaDaftarRow[] {
  return rows
    .filter((r) => k.status === 'SEMUA' || r.status === k.status)
    .filter((r) => !k.jatuhTempoBulanIni || jatuhTempoPadaBulan(r, k.hariIni))
    .filter((r) => !k.perluDitinjau || perluDitinjauPengurus(r))
    .filter((r) => cocokPencarianBerjangka(r, k.cari))
    .sort(bandingkan(k.urutan));
}

/** Ada kriteria selain bawaan yang sedang aktif? (untuk tombol "Reset"). */
export function adaFilterAktif(k: KriteriaDaftarBerjangka): boolean {
  return (
    k.cari.trim() !== '' ||
    k.status !== KRITERIA_AWAL.status ||
    k.urutan !== KRITERIA_AWAL.urutan ||
    k.jatuhTempoBulanIni ||
    k.perluDitinjau
  );
}

/** Jumlah kontrak per status — fakta tentang DAFTAR, bukan nilai uang. */
export function hitungPerStatus(rows: readonly SimpananBerjangkaDaftarRow[]): Record<FilterStatusBerjangka, number> {
  const n: Record<FilterStatusBerjangka, number> = { SEMUA: rows.length, AKTIF: 0, JATUH_TEMPO: 0, DICAIRKAN: 0, DIBATALKAN: 0 };
  for (const r of rows) n[r.status] += 1;
  return n;
}

/** Inisial untuk avatar (maks. 2 huruf). */
export function inisialNama(nama: string | null | undefined): string {
  const kata = (nama ?? '').trim().split(/\s+/).filter(Boolean);
  if (kata.length === 0) return '?';
  return (kata[0][0] + (kata.length > 1 ? kata[kata.length - 1][0] : '')).toUpperCase();
}

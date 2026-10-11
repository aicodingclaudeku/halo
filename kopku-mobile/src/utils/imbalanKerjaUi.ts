import { LABEL_JENIS_IMBALAN, type JenisImbalan, type ImbalanKerjaRow } from '@/services/ImbalanKerjaService';

/**
 * Logika tampilan MURNI layar Imbalan Kerja. Tidak menghitung apa pun
 * yang dijurnal — hanya label dan ringkasan daftar yang sudah dimuat.
 */

export function labelJenisImbalan(j: JenisImbalan | string): string {
  return LABEL_JENIS_IMBALAN[j as JenisImbalan] ?? j;
}

export function labelStatusImbalan(s: 'POSTED' | 'PAID' | string): string {
  return s === 'PAID' ? 'Sudah Dibayar' : s === 'POSTED' ? 'Belum Dibayar' : s;
}

/** 'PENGURUS' -> 'Pengurus'. */
export function labelJenisPersonel(j: string | null | undefined): string {
  if (!j) return '-';
  return j
    .toLowerCase()
    .split('_')
    .map((k) => (k ? k[0].toUpperCase() + k.slice(1) : k))
    .join(' ');
}

const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** 'YYYY-MM-DD' -> '5 Sep 2026' (tampilan). */
export function tanggalPendek(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return iso ?? '-';
  return `${parseInt(m[3], 10)} ${BULAN[parseInt(m[2], 10) - 1] ?? m[2]} ${m[1]}`;
}

export type FilterImbalan = 'BELUM' | 'SUDAH' | 'SEMUA';

export function saringImbalan(daftar: readonly ImbalanKerjaRow[], f: FilterImbalan): ImbalanKerjaRow[] {
  if (f === 'BELUM') return daftar.filter((r) => r.status === 'POSTED');
  if (f === 'SUDAH') return daftar.filter((r) => r.status === 'PAID');
  return [...daftar];
}

/** Ringkasan jumlah baris per status (untuk kartu atas & tab). Bukan saldo akuntansi. */
export function ringkasanDaftarImbalan(daftar: readonly ImbalanKerjaRow[]): {
  jumlahBelum: number;
  nilaiBelum: number;
  jumlahSudah: number;
} {
  let jumlahBelum = 0;
  let nilaiBelum = 0;
  let jumlahSudah = 0;
  for (const r of daftar) {
    if (r.status === 'POSTED') {
      jumlahBelum += 1;
      nilaiBelum += r.nilaiImbalan;
    } else if (r.status === 'PAID') {
      jumlahSudah += 1;
    }
  }
  return { jumlahBelum, nilaiBelum, jumlahSudah };
}

// ===========================================================================
// Poin 19 — PENGELOMPOKAN JENIS IMBALAN (TAMPILAN SAJA)
// ===========================================================================
// Membedakan komponen TETAP (berulang mengikuti struktur gaji), VARIABEL,
// dan HONORARIUM (imbalan jasa yang tidak mengikuti struktur gaji tetap).
// Murni pengelompokan layar: jenis yang dikirim ke service tetap enum
// existing, perlakuan akuntansinya sama (Dr Beban / Cr Utang Imbalan Kerja).

export type KelompokImbalan = 'TETAP' | 'VARIABEL' | 'HONORARIUM';

export const KELOMPOK_JENIS_IMBALAN: readonly {
  kelompok: KelompokImbalan;
  judul: string;
  keterangan: string;
  jenis: readonly JenisImbalan[];
}[] = [
  {
    kelompok: 'TETAP',
    judul: 'Komponen Tetap',
    keterangan: 'Berulang tiap periode, mengikuti struktur gaji.',
    jenis: ['GAJI', 'TUNJANGAN'],
  },
  {
    kelompok: 'VARIABEL',
    judul: 'Komponen Variabel',
    keterangan: 'Tidak tetap, mis. bonus atau insentif.',
    jenis: ['BONUS', 'LAINNYA'],
  },
  {
    kelompok: 'HONORARIUM',
    judul: 'Honorarium',
    keterangan: 'Imbalan jasa yang tidak mengikuti struktur gaji tetap (mis. pengurus/pengawas).',
    jenis: ['HONORARIUM'],
  },
];

export function kelompokJenisImbalan(j: JenisImbalan): KelompokImbalan {
  return KELOMPOK_JENIS_IMBALAN.find((k) => k.jenis.includes(j))?.kelompok ?? 'VARIABEL';
}

function isoKeUtc(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

/** Selisih hari kalender `akhir - awal` (0 bila tidak valid / negatif). */
export function selisihHariKalender(awal: string, akhir: string): number {
  const a = isoKeUtc(awal);
  const b = isoKeUtc(akhir);
  if (a === null || b === null || b < a) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** 'YYYY-MM-DD' + n hari kalender -> 'YYYY-MM-DD' (berbasis UTC, tanpa geser zona waktu). */
export function tambahHariKalender(iso: string, n: number): string {
  const a = isoKeUtc(iso);
  if (a === null) return iso;
  const d = new Date(a + n * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

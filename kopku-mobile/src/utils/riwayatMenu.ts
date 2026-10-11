/**
 * RIWAYAT PER MENU TRANSAKSI — KONFIGURASI MURNI.
 * ============================================================
 * Setiap menu transaksi menampilkan beberapa transaksi terakhir dari
 * jenisnya sendiri. Mengetuk satu baris membuka Detail History Transaksi —
 * SATU-SATUNYA pintu koreksi/pembatalan (HistoryTransaksiService:
 * cek periode tertutup, izin, jurnal pembalik, jejak audit). Komponen
 * riwayat TIDAK punya aksi koreksi sendiri, jadi aturan akuntansi tidak
 * pernah tersalin ke banyak layar.
 *
 * `jenis` = nilai `journal.sumber_transaksi` yang benar-benar ditulis
 * service tiap menu (diaudit dari service, bukan ditebak dari label).
 * `kataKunci` (opsional) menyaring deskripsi jurnal untuk menu yang
 * berbagi sumber dengan menu lain (mis. Pendapatan Unit Usaha memakai
 * KAS/BANK_PENERIMAAN_LAIN yang sama dengan penerimaan lain).
 */

import type { HistoryTransaksiRow } from '@/services/HistoryTransaksiService';

export interface KonfigurasiRiwayatMenu {
  judul: string;
  /** Label tab form di pemisah "<labelBaru> | Riwayat" menu itu. */
  labelBaru: string;
  jenis: readonly string[];
  kataKunci?: string;
}

export const RIWAYAT_MENU = {
  SIMPANAN_SETOR: {
    judul: 'Riwayat Simpanan', labelBaru: 'Setor Simpanan',
    jenis: ['SIMPANAN_POKOK', 'SIMPANAN_WAJIB', 'SIMPANAN_SUKARELA', 'SIMPANAN_DATA_AWAL'],
  },
  SIMPANAN_BERJANGKA: { judul: 'Riwayat Penempatan Simpanan Berjangka', labelBaru: 'Penempatan Baru', jenis: ['SIMPANAN_BERJANGKA'] },
  SIMPANAN_TARIK: { judul: 'Riwayat Simpanan Sukarela', labelBaru: 'Penarikan', jenis: ['SIMPANAN_SUKARELA'] },
  ANGSURAN: { judul: 'Riwayat Angsuran', labelBaru: 'Bayar Angsuran', jenis: ['ANGSURAN_POKOK'] },
  BEBAN: { judul: 'Riwayat Pengeluaran Kas/Bank', labelBaru: 'Catat Beban', jenis: ['KAS_PENGELUARAN_LAIN', 'BANK_PENGELUARAN_LAIN', 'BEBAN_LAINNYA'] },
  PENERIMAAN_LAIN: { judul: 'Riwayat Penerimaan Kas/Bank', labelBaru: 'Catat Pendapatan', jenis: ['KAS_PENERIMAAN_LAIN', 'BANK_PENERIMAAN_LAIN'] },
  PENDAPATAN_UNIT_USAHA: {
    judul: 'Riwayat Pendapatan Unit Usaha', labelBaru: 'Catat Pendapatan',
    jenis: ['KAS_PENERIMAAN_LAIN', 'BANK_PENERIMAAN_LAIN'],
    kataKunci: 'Pendapatan Unit Usaha',
  },
  UTANG: { judul: 'Riwayat Utang', labelBaru: 'Catat Utang', jenis: ['UTANG_BANK', 'UTANG_PIHAK_LAIN', 'UTANG_USAHA'] },
  MODAL: { judul: 'Riwayat Modal', labelBaru: 'Catat Modal', jenis: ['MODAL_UANG', 'MODAL_BARANG'] },
  PEMBELIAN_ASET: { judul: 'Riwayat Pembelian Aset', labelBaru: 'Pembelian Aset', jenis: ['ASET_TETAP', 'ASET_TAK_BERWUJUD'] },
  PELEPASAN_ASET: { judul: 'Riwayat Pelepasan Aset', labelBaru: 'Pelepasan Aset', jenis: ['PELEPASAN_ASET_TETAP'] },
  PEMINDAHAN_SALDO: { judul: 'Riwayat Pemindahan Saldo', labelBaru: 'Pemindahan Saldo', jenis: ['TRANSFER_BANK'] },
  PENGHAPUSAN_PIUTANG: { judul: 'Riwayat Penghapusan Piutang', labelBaru: 'Pengajuan Penghapusan', jenis: ['PENGHAPUSAN_PIUTANG'] },
  RAKU: { judul: 'Riwayat RAKU', labelBaru: 'Catat RAKU', jenis: ['RAK'] },
  PENGEMBALIAN_RAKU: { judul: 'Riwayat Pengembalian RAKU', labelBaru: 'Catat Pengembalian', jenis: ['RAK_PENGEMBALIAN_KAS', 'RAK_PENGEMBALIAN_BANK'] },
  INVESTASI: {
    judul: 'Riwayat Penempatan Investasi', labelBaru: 'Penempatan Baru',
    jenis: [
      'INVESTASI_KOPERASI_LAIN',
      'INVESTASI_USAHA_LAIN',
      'INVESTASI_TABUNGAN_BANK_UMUM',
      'INVESTASI_GIRO_BANK_UMUM',
      'INVESTASI_DEPOSITO_BANK_UMUM',
      'INVESTASI_PROPERTI_INVESTASI',
    ],
  },
  PENDAPATAN_DIMUKA: { judul: 'Riwayat Pendapatan Diterima Dimuka', labelBaru: 'Catat Penerimaan', jenis: ['PENDAPATAN_DITERIMA_DIMUKA'] },
} as const satisfies Record<string, KonfigurasiRiwayatMenu>;

export type KunciRiwayatMenu = keyof typeof RIWAYAT_MENU;

export type StatusTampilRiwayat = 'AKTIF' | 'DIBATALKAN' | 'PEMBALIK' | 'DRAF';

/**
 * Status yang dipahami operator:
 *  - DIBATALKAN : jurnal sudah dibalik (status REVERSED/VOID).
 *  - PEMBALIK   : jurnal ini sendiri adalah pembalik/koreksi.
 *  - DRAF       : belum diposting.
 *  - AKTIF      : selain itu.
 */
export function statusTampilRiwayat(row: Pick<HistoryTransaksiRow, 'status' | 'reversalOfId'>): StatusTampilRiwayat {
  if (row.status === 'REVERSED' || row.status === 'VOID') return 'DIBATALKAN';
  if (row.reversalOfId) return 'PEMBALIK';
  if (row.status === 'DRAFT') return 'DRAF';
  return 'AKTIF';
}

export const LABEL_STATUS_RIWAYAT: Record<StatusTampilRiwayat, string> = {
  AKTIF: 'Aktif',
  DIBATALKAN: 'Dibatalkan',
  PEMBALIK: 'Koreksi',
  DRAF: 'Draf',
};

// ===========================================================================
// PANEL RIWAYAT PENUH (tab "Riwayat") — logika tampilan MURNI
// ===========================================================================

export type PeriodeRiwayat = 'BULAN_INI' | 'TIGA_BULAN' | 'TAHUN_INI' | 'SEMUA';

export const LABEL_PERIODE_RIWAYAT: Record<PeriodeRiwayat, string> = {
  BULAN_INI: 'Bulan ini',
  TIGA_BULAN: '3 bulan',
  TAHUN_INI: 'Tahun ini',
  SEMUA: 'Semua',
};

/** Tanggal awal filter periode (inklusif), dihitung dari tanggal hari ini 'YYYY-MM-DD'. */
export function tanggalMulaiPeriodeRiwayat(periode: PeriodeRiwayat, hariIni: string): string | undefined {
  const th = Number(hariIni.slice(0, 4));
  const bl = Number(hariIni.slice(5, 7));
  if (periode === 'SEMUA') return undefined;
  if (periode === 'TAHUN_INI') return `${th}-01-01`;
  if (periode === 'BULAN_INI') return `${hariIni.slice(0, 7)}-01`;
  // TIGA_BULAN: awal bulan, dua bulan sebelum bulan berjalan.
  const indeks = th * 12 + (bl - 1) - 2;
  const t = Math.floor(indeks / 12);
  const b = (indeks % 12) + 1;
  return `${t}-${String(b).padStart(2, '0')}-01`;
}

export type FilterStatusRiwayat = 'SEMUA' | 'AKTIF' | 'DIBATALKAN';

export function saringStatusRiwayat<T extends Pick<HistoryTransaksiRow, 'status' | 'reversalOfId'>>(
  rows: readonly T[],
  f: FilterStatusRiwayat
): T[] {
  if (f === 'SEMUA') return [...rows];
  if (f === 'DIBATALKAN') return rows.filter((r) => statusTampilRiwayat(r) === 'DIBATALKAN');
  return rows.filter((r) => statusTampilRiwayat(r) !== 'DIBATALKAN');
}

/**
 * Ringkasan baris yang SEDANG DITAMPILKAN (bukan saldo akuntansi):
 * jumlah transaksi, total nominal transaksi asli yang masih aktif
 * (pembalik & yang dibatalkan tidak dijumlah), dan jumlah dibatalkan.
 */
export function ringkasRiwayat(rows: readonly Pick<HistoryTransaksiRow, 'status' | 'reversalOfId' | 'nominal'>[]): {
  jumlah: number;
  totalAktif: number;
  jumlahDibatalkan: number;
} {
  let totalAktif = 0;
  let jumlahDibatalkan = 0;
  for (const r of rows) {
    const s = statusTampilRiwayat(r);
    if (s === 'AKTIF') totalAktif += r.nominal;
    if (s === 'DIBATALKAN') jumlahDibatalkan += 1;
  }
  return { jumlah: rows.length, totalAktif, jumlahDibatalkan };
}

const NAMA_BULAN_RIWAYAT = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

/** Kelompokkan baris (sudah terurut terbaru dulu) per bulan: [{ judul: 'Oktober 2026', baris }]. */
export function kelompokkanRiwayatPerBulan<T extends Pick<HistoryTransaksiRow, 'tanggal'>>(
  rows: readonly T[]
): { kunci: string; judul: string; baris: T[] }[] {
  const hasil: { kunci: string; judul: string; baris: T[] }[] = [];
  for (const r of rows) {
    const kunci = r.tanggal.slice(0, 7);
    let g = hasil[hasil.length - 1];
    if (!g || g.kunci !== kunci) {
      const bl = Number(kunci.slice(5, 7));
      g = { kunci, judul: `${NAMA_BULAN_RIWAYAT[bl - 1] ?? kunci} ${kunci.slice(0, 4)}`, baris: [] };
      hasil.push(g);
    }
    g.baris.push(r);
  }
  return hasil;
}

/** Ukuran halaman awal & tambahan ("Muat lebih banyak"). */
export const HALAMAN_RIWAYAT = 30;

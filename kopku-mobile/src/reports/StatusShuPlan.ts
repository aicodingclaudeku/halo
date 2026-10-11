/**
 * RC-S109 — TAHAPAN PEMBAGIAN SISA HASIL USAHA (MODUL MURNI).
 *
 * Status SHU sudah lama ada di `shu_konfigurasi.status`, tetapi
 * URUTANNYA hanya tersirat: layar menampilkan satu lencana status tanpa
 * memberi tahu pengguna tahap keberapa itu dari keseluruhan proses,
 * dan apa yang harus dikerjakan berikutnya. Untuk pengurus yang setahun
 * sekali membuka menu ini, lencana "DIAJUKAN_RAT" saja tidak cukup.
 *
 * Modul ini menetapkan urutan tahapan, labelnya dalam istilah yang
 * dipakai koperasi, dan tindakan berikutnya pada tiap tahap. MURNI
 * (tanpa React/database) supaya urutannya dapat diuji — termasuk
 * penjaga bahwa setiap status punya tahap, sehingga status baru tidak
 * bisa lolos tanpa tempat.
 */

export type StatusShu = 'DRAFT' | 'DIHITUNG' | 'DIAJUKAN_RAT' | 'DISAHKAN_RAT' | 'DIBAGIKAN';

/** Urutan tahapan, dari awal sampai selesai. */
export const URUTAN_STATUS_SHU: readonly StatusShu[] = [
  'DRAFT',
  'DIHITUNG',
  'DIAJUKAN_RAT',
  'DISAHKAN_RAT',
  'DIBAGIKAN',
];

export interface TahapShu {
  status: StatusShu;
  /** Nomor tahap, 1..5 — dipakai "Tahap 3 dari 5". */
  nomor: number;
  /** Label pendek untuk lencana. */
  label: string;
  /** Label sangat pendek untuk penanda langkah. */
  labelPendek: string;
  /** Apa yang perlu dikerjakan pengurus pada tahap ini. */
  tindakan: string;
  /** Tahap terakhir — tidak ada tindakan lanjutan. */
  selesai: boolean;
}

const TAHAP: Record<StatusShu, Omit<TahapShu, 'nomor'>> = {
  DRAFT: {
    status: 'DRAFT',
    label: 'Draft',
    labelPendek: 'Draft',
    tindakan: 'Lengkapi persentase pembagian, lalu hitung SHU tahun buku ini.',
    selesai: false,
  },
  DIHITUNG: {
    status: 'DIHITUNG',
    label: 'Sudah Dihitung',
    labelPendek: 'Dihitung',
    tindakan: 'Periksa rincian per anggota, lalu ajukan ke Rapat Anggota Tahunan.',
    selesai: false,
  },
  DIAJUKAN_RAT: {
    status: 'DIAJUKAN_RAT',
    label: 'Diajukan ke RAT',
    labelPendek: 'Diajukan',
    tindakan: 'Isi tanggal pelaksanaan RAT, lalu catat nominal yang disahkan rapat.',
    selesai: false,
  },
  DISAHKAN_RAT: {
    status: 'DISAHKAN_RAT',
    label: 'Disahkan RAT',
    labelPendek: 'Disahkan',
    tindakan: 'Siap dibagikan. Pembagian baru dapat dijalankan setelah tanggal RAT terlampaui.',
    selesai: false,
  },
  DIBAGIKAN: {
    status: 'DIBAGIKAN',
    label: 'Sudah Dibagikan',
    labelPendek: 'Dibagikan',
    tindakan: 'Selesai. SHU sudah dijurnal dan masuk ke simpanan sukarela anggota.',
    selesai: true,
  },
};

/** Tahapan sebuah status, lengkap dengan nomor urutnya. */
export function tahapShu(status: StatusShu): TahapShu {
  const dasar = TAHAP[status];
  return { ...dasar, nomor: URUTAN_STATUS_SHU.indexOf(status) + 1 };
}

export const JUMLAH_TAHAP_SHU = URUTAN_STATUS_SHU.length;

/**
 * Apakah tahap `a` sudah dilewati bila status sekarang `sekarang`?
 * Dipakai penanda langkah: tahap yang sudah lewat ditandai penuh.
 */
export function tahapSudahDilewati(a: StatusShu, sekarang: StatusShu): boolean {
  return URUTAN_STATUS_SHU.indexOf(a) <= URUTAN_STATUS_SHU.indexOf(sekarang);
}

/**
 * Boleh diubah/dihapus? DIBAGIKAN final — SHU-nya sudah dijurnal dan
 * masuk ke simpanan anggota, membatalkannya berarti membalik jurnal
 * yang sudah sah. Aturan ini SUDAH berlaku di `simpanKonfigurasiShu()`;
 * di sini hanya dinyatakan sekali supaya layar tidak menuliskannya
 * ulang dengan daftar status yang bisa tertinggal.
 */
export function bolehDiubah(status: StatusShu): boolean {
  return status !== 'DIBAGIKAN';
}

/** Istilah resmi modul ini — dipakai judul layar, menu, dan export. */
export const JUDUL_MODUL_SHU = 'Pembagian Sisa Hasil Usaha';

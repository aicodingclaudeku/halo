import type { StatusSimpananBerjangka } from '@/services/SimpananBerjangkaService';
import { formatPersen } from '@/accounting/SimpananBerjangkaKebijakanProduk';
import { colors } from '@/theme/colors';

/**
 * ============================================================
 * RC-S129 — BAHASA & WARNA TAMPILAN SIMPANAN BERJANGKA
 * ============================================================
 *
 * Satu sumber label status, warna, dan kalimat penjelasan untuk layar
 * daftar dan detail, supaya kedua layar memakai istilah yang sama.
 * Murni presentasi: tidak membaca database dan tidak menghitung uang.
 */

export interface GayaStatus {
  /** Label singkat di lencana. */
  label: string;
  /** Kalimat "apa yang bisa dilakukan sekarang". */
  arti: string;
  warna: string;
  latar: string;
  ikon: 'hourglass-outline' | 'alarm-outline' | 'checkmark-done-outline' | 'close-circle-outline';
}

export const WARNA_BERJANGKA = {
  berjalan: colors.primary,
  berjalanLatar: colors.primaryLight,
  jatuhTempo: '#E65100',
  jatuhTempoLatar: '#FFF3E0',
  selesai: colors.textMuted,
  selesaiLatar: '#EEF1EE',
  batal: colors.danger,
  batalLatar: colors.dangerBg,
  bungaTenor: '#1565C0',
  bungaPasca: '#6A1B9A',
};

export const GAYA_STATUS_BERJANGKA: Record<StatusSimpananBerjangka, GayaStatus> = {
  AKTIF: {
    label: 'Berjalan',
    arti: 'Belum jatuh tempo',
    warna: WARNA_BERJANGKA.berjalan,
    latar: WARNA_BERJANGKA.berjalanLatar,
    ikon: 'hourglass-outline',
  },
  JATUH_TEMPO: {
    label: 'Jatuh tempo',
    arti: 'Siap dicairkan',
    warna: WARNA_BERJANGKA.jatuhTempo,
    latar: WARNA_BERJANGKA.jatuhTempoLatar,
    ikon: 'alarm-outline',
  },
  DICAIRKAN: {
    label: 'Selesai',
    arti: 'Sudah dicairkan',
    warna: WARNA_BERJANGKA.selesai,
    latar: WARNA_BERJANGKA.selesaiLatar,
    ikon: 'checkmark-done-outline',
  },
  DIBATALKAN: {
    label: 'Dibatalkan',
    arti: 'Kontrak dibatalkan',
    warna: WARNA_BERJANGKA.batal,
    latar: WARNA_BERJANGKA.batalLatar,
    ikon: 'close-circle-outline',
  },
};

const BULAN_PENDEK = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** "2027-01-15" -> "15 Jan 2027". Teks lain dikembalikan apa adanya. */
export function tanggalPendek(iso: string | null | undefined): string {
  if (!iso) return '-';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const bulan = BULAN_PENDEK[Number(m[2]) - 1];
  return bulan ? `${Number(m[3])} ${bulan} ${m[1]}` : iso;
}

/** "6% per tahun" / "Tanpa bunga". */
export function teksSukuBunga(ratePerTahun: number): string {
  return ratePerTahun > 0 ? `${formatPersen(ratePerTahun)} per tahun` : 'Tanpa bunga';
}

/** Versi ringkas untuk sel sempit: "5,5%/th" / "Tanpa bunga". */
export function teksSukuBungaPendek(ratePerTahun: number): string {
  return ratePerTahun > 0 ? `${formatPersen(ratePerTahun)}/th` : 'Tanpa bunga';
}

/**
 * Tahap siklus hidup untuk penunjuk langkah:
 * 0 Ditempatkan · 1 Berjalan · 2 Jatuh tempo · 3 Dicairkan.
 * DIBATALKAN -> -1 (penunjuk tidak ditampilkan).
 */
export function tahapKontrak(status: StatusSimpananBerjangka, sudahJatuhTempo: boolean): number {
  if (status === 'DIBATALKAN') return -1;
  if (status === 'DICAIRKAN') return 3;
  if (status === 'JATUH_TEMPO' || sudahJatuhTempo) return 2;
  return 1;
}

export const LANGKAH_KONTRAK = ['Ditempatkan', 'Berjalan', 'Jatuh tempo', 'Dicairkan'] as const;

export interface InfoPenjelasanKontrak {
  status: StatusSimpananBerjangka;
  sudahJatuhTempo: boolean;
  tanggalJatuhTempo: string;
  tanggalPencairan: string | null;
  ratePerTahun: number;
  /** Snapshot kontrak; null = kontrak lama yang kebijakannya belum ditinjau. */
  bungaPascaAktif: boolean | null | undefined;
  ratePasca: number | null | undefined;
}

/**
 * Penjelasan satu-dua kalimat dalam bahasa sehari-hari: apa yang sedang
 * terjadi pada kontrak ini dan apa langkah berikutnya.
 */
export function penjelasanKontrak(k: InfoPenjelasanKontrak): { judul: string; isi: string } {
  const jt = tanggalPendek(k.tanggalJatuhTempo);
  if (k.status === 'DIBATALKAN') {
    return { judul: 'Kontrak dibatalkan', isi: 'Kontrak ini tidak berlaku lagi. Tidak ada bunga maupun pencairan yang diproses.' };
  }
  if (k.status === 'DICAIRKAN') {
    return {
      judul: 'Kontrak selesai',
      isi:
        `Pokok sudah dibayarkan kepada anggota pada ${tanggalPendek(k.tanggalPencairan)}. ` +
        'Bunga tidak dibayar lagi saat pencairan karena sudah dimasukkan ke Simpanan Sukarela anggota setiap bulan.',
    };
  }
  if (k.status === 'JATUH_TEMPO' || k.sudahJatuhTempo) {
    const pasca =
      k.bungaPascaAktif && k.ratePasca
        ? `Selama belum diambil, pokok tetap berbunga ${formatPersen(k.ratePasca)} per tahun, dihitung per bulan penuh.`
        : k.bungaPascaAktif == null
          ? 'Kontrak lama: setelah jatuh tempo pokok tidak berbunga sampai pengurus menerapkan kebijakan produk.'
          : 'Setelah jatuh tempo pokok tidak berbunga lagi.';
    return {
      judul: 'Sudah jatuh tempo — siap dicairkan',
      isi: `Jatuh tempo ${jt}. Pokok masih disimpan koperasi sampai anggota datang mencairkan; tidak dicairkan atau diperpanjang otomatis. ${pasca}`,
    };
  }
  return {
    judul: 'Simpanan sedang berjalan',
    isi:
      k.ratePerTahun > 0
        ? `Bunga dihitung otomatis setiap genap satu bulan dan dimasukkan ke Simpanan Sukarela anggota (setelah PPh). Pokok dapat dicairkan mulai ${jt}.`
        : `Kontrak ini tanpa bunga. Pokok dapat dicairkan mulai ${jt}.`,
  };
}

/** Poin "Cara kerja" — dipakai daftar, form, dan detail supaya isinya sama. */
export const CARA_KERJA_BERJANGKA: readonly { ikon: string; judul: string; isi: string }[] = [
  {
    ikon: 'wallet-outline',
    judul: 'Pokok disimpan untuk jangka waktu tertentu',
    isi: 'Anggota menempatkan dana untuk 3, 6, atau 12 bulan. Pokok tidak bisa bertambah dan tidak dicampur dengan bunga.',
  },
  {
    ikon: 'calendar-outline',
    judul: 'Bunga dihitung otomatis tiap bulan',
    isi: 'Setiap genap satu bulan kalender, sistem mengakui bunga satu bulan (± pokok × suku bunga per tahun ÷ 12). Tidak ada tombol yang perlu ditekan.',
  },
  {
    ikon: 'swap-horizontal-outline',
    judul: 'Bunga masuk ke Simpanan Sukarela',
    isi: 'Bunga bulan itu langsung dipindahkan ke Simpanan Sukarela anggota setelah dipotong PPh final bila ada, sehingga bisa ditarik kapan saja.',
  },
  {
    ikon: 'alarm-outline',
    judul: 'Jatuh tempo = siap dicairkan',
    isi: 'Saat jatuh tempo kontrak tidak dicairkan atau diperpanjang otomatis. Bila kebijakan produk mengizinkan, pokok tetap berbunga sampai diambil.',
  },
  {
    ikon: 'cash-outline',
    judul: 'Pencairan hanya pokok',
    isi: 'Saat anggota mencairkan, uang yang keluar dari kas hanya sebesar pokok — bunganya sudah lebih dulu ada di Simpanan Sukarela.',
  },
];

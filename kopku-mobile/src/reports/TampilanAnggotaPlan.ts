/**
 * RC-S111 — TAMPILAN ANGGOTA & SIMPANAN (MODUL MURNI).
 *
 * ============================================================
 * KENAPA MODUL TERPISAH
 * ============================================================
 * Layar Anggota dan Simpanan mengimpor komponen yang rantai impornya
 * menyentuh paket ESM native, sehingga berkas test apa pun yang
 * memuatnya gagal dimuat ts-jest. Semua yang BISA salah secara logis —
 * label status, nada warnanya, inisial avatar, ringkasan hitungan —
 * dipindahkan ke sini supaya benar-benar teruji.
 *
 * ============================================================
 * SATU BATAS YANG DIJAGA
 * ============================================================
 * Modul ini PRESENTASI MURNI. Ia tidak pernah memutuskan siapa boleh
 * bertransaksi, tidak pernah menghitung saldo, dan tidak pernah
 * menyentuh nominal. Status "AKTIF" di sini hanya menentukan warna
 * lencana; kelayakan anggota untuk menabung atau meminjam tetap
 * diputuskan service masing-masing, yang memang sudah memeriksanya
 * sendiri. Kalau modul ini suatu saat dipakai untuk memutuskan boleh
 * atau tidaknya sebuah transaksi, pemeriksaan itu jadi ADA DI DUA
 * TEMPAT dan cepat atau lambat keduanya akan berbeda.
 */

export type StatusAnggotaTampil = 'AKTIF' | 'TIDAK_AKTIF' | 'KELUAR' | 'MENINGGAL';

/** Nada lencana — layar memetakannya ke warna tema. */
export type NadaLencana = 'aktif' | 'netral' | 'peringatan' | 'berhenti';

/**
 * Label yang dibaca pengguna. Nilai mentahnya memakai garis bawah
 * ("TIDAK_AKTIF") karena itu bentuk enum di basis data; menampilkannya
 * apa adanya di daftar membuat layar terlihat seperti dump tabel.
 */
export const LABEL_STATUS_ANGGOTA: Record<StatusAnggotaTampil, string> = {
  AKTIF: 'Aktif',
  TIDAK_AKTIF: 'Tidak Aktif',
  KELUAR: 'Keluar',
  MENINGGAL: 'Meninggal',
};

export const NADA_STATUS_ANGGOTA: Record<StatusAnggotaTampil, NadaLencana> = {
  AKTIF: 'aktif',
  TIDAK_AKTIF: 'netral',
  KELUAR: 'peringatan',
  MENINGGAL: 'berhenti',
};

/**
 * Status yang tidak dikenal TIDAK disembunyikan dan TIDAK membuat
 * layar kosong: ia ditampilkan apa adanya dengan nada netral. Data
 * lama hasil migrasi bisa saja membawa nilai di luar keempat ini, dan
 * anggota yang "hilang dari daftar" jauh lebih berbahaya daripada
 * anggota berlencana aneh.
 */
export function labelStatusAnggota(status: string): string {
  return LABEL_STATUS_ANGGOTA[status as StatusAnggotaTampil] ?? status;
}

export function nadaStatusAnggota(status: string): NadaLencana {
  return NADA_STATUS_ANGGOTA[status as StatusAnggotaTampil] ?? 'netral';
}

/**
 * Inisial untuk avatar huruf. Maksimal dua huruf: satu terasa kurang
 * membedakan, tiga membuat lingkaran avatar harus melebar dan kolom
 * nama ikut bergeser antar-baris.
 *
 * Gelar dan sapaan yang lazim di data keanggotaan koperasi dibuang
 * supaya "H. Ahmad Subekti" tidak berinisial "HA" — huruf pertamanya
 * jadi milik gelar, bukan orangnya.
 */
const KATA_BUKAN_NAMA = new Set(['h', 'hj', 'ir', 'drs', 'dra', 'dr', 'prof', 'st', 'se', 'spd', 'mm', 'msi', 'bpk', 'bapak', 'ibu', 'sdr', 'sdri']);

export function inisialNama(nama: string): string {
  const kata = (nama ?? '')
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter((k) => k.length > 0)
    .filter((k) => !KATA_BUKAN_NAMA.has(k.toLowerCase()));
  if (kata.length === 0) return '?';
  if (kata.length === 1) return kata[0].slice(0, 2).toUpperCase();
  return (kata[0][0] + kata[kata.length - 1][0]).toUpperCase();
}

export interface RingkasanDaftarAnggota {
  total: number;
  aktif: number;
  teks: string;
}

/**
 * Ringkasan hitungan untuk kop daftar. HITUNGAN ORANG, bukan nominal:
 * modul ini tidak pernah menerima saldo apa pun sebagai parameter.
 */
export function ringkasDaftarAnggota(status: string[]): RingkasanDaftarAnggota {
  const total = status.length;
  const aktif = status.filter((s) => s === 'AKTIF').length;
  return {
    total,
    aktif,
    teks: total === 0 ? 'Belum ada anggota' : `${total} anggota ditampilkan · ${aktif} aktif`,
  };
}

export const JUDUL_MODUL_ANGGOTA = 'DAFTAR ANGGOTA';
export const SUBJUDUL_MODUL_ANGGOTA =
  'Data keanggotaan koperasi. Ketuk satu baris untuk melihat simpanan, pinjaman, dan riwayatnya.';

/**
 * ============================================================
 * TAMPILAN SIMPANAN
 * ============================================================
 * Sama seperti status anggota: nilai enum basis data ("SUKARELA",
 * "SETOR") ditampilkan apa adanya di daftar membuat layar terlihat
 * seperti dump tabel. Pemetaan labelnya ditaruh di sini, satu tempat,
 * supaya daftar / detail / histori tidak masing-masing menulis
 * `j.charAt(0) + j.slice(1).toLowerCase()` yang tersebar dan gampang
 * berbeda satu sama lain.
 *
 * Batas yang sama berlaku: ini PRESENTASI. Modul ini tidak menentukan
 * jenis simpanan mana yang boleh ditarik — aturan itu milik
 * SimpananService dan KebijakanPenarikanDini, yang memang sudah
 * memeriksanya sendiri.
 */
export type JenisSimpananTampil = 'POKOK' | 'WAJIB' | 'SUKARELA';
export type TipeTransaksiSimpanan = 'SETOR' | 'TARIK' | 'KOREKSI';

export const LABEL_JENIS_SIMPANAN: Record<JenisSimpananTampil, string> = {
  POKOK: 'Pokok',
  WAJIB: 'Wajib',
  SUKARELA: 'Sukarela',
};

export const LABEL_TIPE_SIMPANAN: Record<TipeTransaksiSimpanan, string> = {
  SETOR: 'Setoran',
  TARIK: 'Penarikan',
  KOREKSI: 'Koreksi',
};

export function labelJenisSimpanan(jenis: string): string {
  return LABEL_JENIS_SIMPANAN[jenis as JenisSimpananTampil] ?? jenis;
}

export function labelTipeSimpanan(tipe: string): string {
  return LABEL_TIPE_SIMPANAN[tipe as TipeTransaksiSimpanan] ?? tipe;
}

/**
 * Tanda aritmetika di depan nominal.
 *
 * KOREKSI sengaja TIDAK diberi tanda. Koreksi bisa menambah maupun
 * mengurangi saldo, dan tandanya tidak bisa disimpulkan dari tipe
 * transaksi saja — memberi '+' pada koreksi yang sebenarnya mengurangi
 * saldo adalah kebohongan yang terlihat meyakinkan. Lebih baik tanpa
 * tanda daripada tanda yang salah.
 */
export function tandaTipeSimpanan(tipe: string): '+' | '-' | '' {
  if (tipe === 'SETOR') return '+';
  if (tipe === 'TARIK') return '-';
  return '';
}

/** Nada warna nominal, mengikuti tanda di atas. */
export function nadaTipeSimpanan(tipe: string): 'masuk' | 'keluar' | 'netral' {
  if (tipe === 'SETOR') return 'masuk';
  if (tipe === 'TARIK') return 'keluar';
  return 'netral';
}

export const IKON_TIPE_SIMPANAN: Record<TipeTransaksiSimpanan, string> = {
  SETOR: 'arrow-down-circle',
  TARIK: 'arrow-up-circle',
  KOREKSI: 'swap-horizontal',
};

export function ikonTipeSimpanan(tipe: string): string {
  return IKON_TIPE_SIMPANAN[tipe as TipeTransaksiSimpanan] ?? 'ellipse-outline';
}

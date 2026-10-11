import Decimal from 'decimal.js';
import { Rupiah, roundToRupiah } from '@/utils/money';
import type { SatuanTenor } from '@/accounting/PinjamanCalculator';

/**
 * RC-S101 — LAPORAN PROMOSI EKONOMI ANGGOTA (LPEA): MESIN PERHITUNGAN MURNI.
 *
 * ============================================================
 * DASAR NASKAH — DIVERIFIKASI, BUKAN DIKARANG
 * ============================================================
 * Seluruh rumus & struktur di berkas ini dibaca langsung dari naskah
 * Petunjuk Pelaksanaan SOM Nomor 3 Tahun 2025:
 *
 *  - Butir 5.8 "Laporan Promosi Ekonomi Anggota":
 *      (1) laporan yang memperlihatkan manfaat ekonomi yang diperoleh
 *          anggota Koperasi selama 1 tahun tertentu;
 *      (2) mencakup (a) manfaat ekonomi dari kegiatan simpan dan pinjam
 *          lewat Koperasi, dan (b) manfaat ekonomi dalam bentuk
 *          pembagian SHU;
 *      (4) bentuk promosi ekonomi anggota, yang menegaskan bahwa
 *          manfaatnya adalah SELISIH terhadap tarif di luar Koperasi:
 *            a. bunga tabungan di Koperasi LEBIH TINGGI daripada di luar
 *               ("efektivitas tabungan");
 *            b. bunga pinjaman ke Koperasi LEBIH RENDAH daripada di luar
 *               ("efisiensi penarikan kredit").
 *
 *  - Lampiran butir 7 "CONTOH LAPORAN PROMOSI EKONOMI ANGGOTA UNTUK KSP"
 *    — susunan baris & subtotalnya.
 *
 *  - Lampiran butir 9 "CONTOH BUKU PEMBANTU PROMOSI EKONOMI ANGGOTA
 *    (PEA)" huruf A–D — RUMUS dan kolomnya, yang dikutip apa adanya:
 *
 *      A. PARTISIPASI JASA PINJAMAN        PEA = (c − b) × a
 *      B. PARTISIPASI JASA PROVISI          PEA = (c − b) × a
 *      C. PARTISIPASI TABUNGAN              PEA = (b − c) × a
 *      D. PARTISIPASI SIMPANAN BERJANGKA    PEA = (b − c) × a
 *
 *    dengan  a = basis (saldo pokok pinjaman / saldo tabungan / saldo
 *                simpanan berjangka),
 *            b = tarif DI KOPERASI per bulan,
 *            c = tarif rata-rata DI LEMBAGA KEUANGAN LAIN per bulan.
 *
 * PERHATIKAN PEMBALIKAN TANDA antara A/B dan C/D: ia bukan salah tulis.
 * Untuk pinjaman, anggota untung bila tarif luar LEBIH TINGGI (c − b);
 * untuk simpanan, anggota untung bila tarif koperasi LEBIH TINGGI
 * (b − c). Keduanya sama-sama berarti "manfaat bagi anggota".
 *
 * ============================================================
 * KONSEKUENSI PENTING: RUMUS RESMI MENUNTUT DATA DARI LUAR APLIKASI
 * ============================================================
 * Variabel `c` — tarif rata-rata di lembaga keuangan lain — MUSTAHIL
 * diketahui aplikasi ini. Ia bukan hasil transaksi koperasi, melainkan
 * fakta pasar yang harus ditetapkan koperasi sendiri. Karena itu:
 *
 *   - `c` (dan `b` untuk komponen yang memang tidak dicatat aplikasi,
 *     lihat di bawah) adalah PARAMETER yang DIISI pengguna per tahun
 *     buku, disimpan, dan ditampilkan di laporan sebagai asumsi terbuka;
 *   - selama parameter sebuah komponen BELUM diisi, komponen itu TIDAK
 *     dihitung, TIDAK dianggap nol, dan TIDAK ikut ke dalam total —
 *     statusnya 'BELUM_DAPAT_DIHITUNG' dan laporan menyatakannya.
 *
 * Menganggap `c = 0` akan menghasilkan angka yang tampak sah tetapi
 * sepenuhnya karangan, dan itulah yang paling berbahaya pada laporan
 * yang dipakai untuk menilai kinerja koperasi.
 *
 * Modul ini MURNI: tanpa import database/native, sehingga setiap rumus
 * dapat diuji langsung terhadap angka contoh naskah.
 */

// ===========================================================================
// KOMPONEN
// ===========================================================================

/** Empat komponen manfaat simpan pinjam, sesuai huruf A–D buku pembantu. */
export type KomponenPea = 'JASA_PINJAMAN' | 'JASA_PROVISI' | 'TABUNGAN' | 'SIMPANAN_BERJANGKA';

export const URUTAN_KOMPONEN_PEA: readonly KomponenPea[] = [
  'JASA_PINJAMAN',
  'JASA_PROVISI',
  'TABUNGAN',
  'SIMPANAN_BERJANGKA',
];

/** Label sesuai naskah — dipakai layar maupun export supaya tidak divergen. */
export const LABEL_KOMPONEN_PEA: Record<KomponenPea, string> = {
  JASA_PINJAMAN: 'Partisipasi jasa pinjaman',
  JASA_PROVISI: 'Partisipasi jasa provisi',
  TABUNGAN: 'Partisipasi tabungan',
  SIMPANAN_BERJANGKA: 'Partisipasi simpanan berjangka',
};

/** Huruf buku pembantu PEA pada naskah (Lampiran butir 9). */
export const HURUF_BUKU_PEMBANTU: Record<KomponenPea, 'A' | 'B' | 'C' | 'D'> = {
  JASA_PINJAMAN: 'A',
  JASA_PROVISI: 'B',
  TABUNGAN: 'C',
  SIMPANAN_BERJANGKA: 'D',
};

/**
 * Dua kelompok penyajian pada naskah. "Penghematan Beban Pinjaman
 * Anggota" memuat A & B; "Kelebihan Balas Jasa Simpanan Anggota" memuat
 * C & D.
 */
export type KelompokPea = 'PENGHEMATAN_BEBAN_PINJAMAN' | 'KELEBIHAN_BALAS_JASA_SIMPANAN';

export const LABEL_KELOMPOK_PEA: Record<KelompokPea, string> = {
  PENGHEMATAN_BEBAN_PINJAMAN: 'Penghematan Beban Pinjaman Anggota',
  KELEBIHAN_BALAS_JASA_SIMPANAN: 'Kelebihan Balas Jasa Simpanan Anggota',
};

export const KELOMPOK_DARI_KOMPONEN: Record<KomponenPea, KelompokPea> = {
  JASA_PINJAMAN: 'PENGHEMATAN_BEBAN_PINJAMAN',
  JASA_PROVISI: 'PENGHEMATAN_BEBAN_PINJAMAN',
  TABUNGAN: 'KELEBIHAN_BALAS_JASA_SIMPANAN',
  SIMPANAN_BERJANGKA: 'KELEBIHAN_BALAS_JASA_SIMPANAN',
};

/**
 * Arah selisih per komponen, mengikuti rumus naskah apa adanya.
 * 'LUAR_MINUS_KOPERASI' = (c − b) untuk A & B;
 * 'KOPERASI_MINUS_LUAR' = (b − c) untuk C & D.
 */
export const ARAH_SELISIH: Record<KomponenPea, 'LUAR_MINUS_KOPERASI' | 'KOPERASI_MINUS_LUAR'> = {
  JASA_PINJAMAN: 'LUAR_MINUS_KOPERASI',
  JASA_PROVISI: 'LUAR_MINUS_KOPERASI',
  TABUNGAN: 'KOPERASI_MINUS_LUAR',
  SIMPANAN_BERJANGKA: 'KOPERASI_MINUS_LUAR',
};

// ===========================================================================
// RUMUS INTI
// ===========================================================================

/**
 * Satu baris buku pembantu PEA.
 *
 * `hariProrata` mengakomodasi kasus terakhir pada buku pembantu huruf D:
 * simpanan berjangka yang belum berumur genap sebulan dihitung
 * proporsional hari — naskah menuliskannya
 * `(2,5% − 1%) × 50.000.000 × 9/30 = 225.000`. Bila `hariProrata`
 * kosong, basisnya dihitung penuh satu bulan (kasus baris-baris lain).
 */
export interface BarisPea {
  /** a — basis rupiah (saldo pokok pinjaman / saldo tabungan / nominal berjangka). */
  basis: Rupiah;
  /** b — tarif di koperasi, PERSEN PER BULAN. */
  tarifKoperasiPersenPerBulan: number;
  /** c — tarif rata-rata di lembaga keuangan lain, PERSEN PER BULAN. */
  tarifLuarPersenPerBulan: number;
  /** Umur dalam hari bila belum genap sebulan; dibagi 30 sesuai naskah. */
  hariProrata?: number;
  /** Keterangan baris (nomor anggota/nama) — untuk rincian, tidak memengaruhi angka. */
  keterangan?: string;
}

/** Pembagi hari yang dipakai naskah pada buku pembantu huruf D (x/30). */
export const HARI_PER_BULAN_PRORATA = 30;

/**
 * Hitung PEA satu baris, PERSIS rumus naskah.
 *
 * Pembulatan SENGAJA ditahan sampai akhir (`Decimal`, lalu
 * `roundToRupiah` di titik agregasi) — baris pertama buku pembantu huruf
 * A menghasilkan (166.666,67), pecahan yang kalau dibulatkan per baris
 * akan membuat jumlahnya menyimpang dari 1.155.000 pada naskah.
 */
export function hitungPeaBaris(komponen: KomponenPea, baris: BarisPea): Decimal {
  const b = new Decimal(baris.tarifKoperasiPersenPerBulan);
  const c = new Decimal(baris.tarifLuarPersenPerBulan);
  const selisihPersen =
    ARAH_SELISIH[komponen] === 'LUAR_MINUS_KOPERASI' ? c.minus(b) : b.minus(c);

  let nilai = selisihPersen.div(100).mul(baris.basis);
  if (baris.hariProrata !== undefined) {
    nilai = nilai.mul(baris.hariProrata).div(HARI_PER_BULAN_PRORATA);
  }
  return nilai;
}

/** Jumlah PEA satu komponen (satu buku pembantu), dibulatkan di titik akhir. */
export function hitungPeaKomponen(komponen: KomponenPea, baris: BarisPea[]): Rupiah {
  const total = baris.reduce((t, b) => t.plus(hitungPeaBaris(komponen, b)), new Decimal(0));
  return roundToRupiah(total);
}

// ===========================================================================
// KONVERSI TARIF KE PER BULAN
// ===========================================================================

/**
 * Naskah memakai tarif PER BULAN di seluruh buku pembantu, sedangkan
 * aplikasi menyimpan:
 *   - `pinjaman.persentase_jasa` per PERIODE TENOR (HARI/MINGGU/BULAN —
 *     lihat PinjamanCalculator.HitungAngsuranInput), dan
 *   - `simpanan_berjangka.suku_bunga` per TAHUN.
 *
 * Konversinya dibuat eksplisit di sini, bukan tersebar di kueri, supaya
 * satu-satunya tempat yang perlu diperiksa saat angka terasa aneh.
 * Faktor hari/minggu memakai 30 hari dan 4 minggu per bulan — pembagi
 * yang SAMA dengan `HARI_PER_BULAN_PRORATA` di atas agar tidak ada dua
 * definisi "sebulan" di dalam satu laporan.
 */
export const MINGGU_PER_BULAN_PRORATA = 4;

export function tarifPinjamanKePerBulan(persentasePerPeriode: number, satuan: SatuanTenor): number {
  switch (satuan) {
    case 'BULAN':
      return persentasePerPeriode;
    case 'MINGGU':
      return persentasePerPeriode * MINGGU_PER_BULAN_PRORATA;
    case 'HARI':
      return persentasePerPeriode * HARI_PER_BULAN_PRORATA;
    default: {
      // Satuan baru wajib diputuskan sadar, bukan diperlakukan sebagai bulan.
      const tidakTertangani: never = satuan;
      throw new Error(`[LPEA] Satuan tenor '${tidakTertangani}' belum punya konversi ke per bulan.`);
    }
  }
}

/** Tarif per tahun -> per bulan (simpanan berjangka). */
export function tarifTahunanKePerBulan(persentasePerTahun: number): number {
  return persentasePerTahun / 12;
}

// ===========================================================================
// PARAMETER YANG WAJIB DIISI KOPERASI
// ===========================================================================

/**
 * Parameter per tahun buku. Semua bersatuan PERSEN PER BULAN, dan semua
 * boleh `null` yang berarti BELUM DIISI (bukan nol).
 *
 * `tarifKoperasi*` hanya ada untuk komponen yang TIDAK dicatat aplikasi:
 *  - provisi: aplikasi ini tidak memungut provisi pinjaman sama sekali
 *    (tidak ada kolom/aliran provisi di seluruh skema), jadi tarif
 *    koperasinya tidak bisa dibaca dari data;
 *  - tabungan: `simpanan_transaksi` tidak punya kolom suku bunga —
 *    simpanan pokok/wajib/sukarela di aplikasi ini tidak berbunga.
 * Keduanya TIDAK di-default 0: koperasi bisa saja memberlakukannya di
 * luar aplikasi, dan menebak untuk koperasi lain adalah karangan.
 *
 * Untuk jasa pinjaman & simpanan berjangka, tarif koperasi (b) DIBACA
 * dari data per transaksi dan tidak pernah diminta di sini.
 */
export interface ParameterLpea {
  tahunBuku: number;
  tarifLuarJasaPinjaman: number | null;
  tarifLuarJasaProvisi: number | null;
  tarifLuarTabungan: number | null;
  tarifLuarSimpananBerjangka: number | null;
  tarifKoperasiJasaProvisi: number | null;
  tarifKoperasiTabungan: number | null;
  /** Sumber acuan tarif luar (mis. "SBDK bank X, Januari 2026") — dicetak di laporan. */
  sumberAcuan?: string | null;
  diperbaruiPada?: string | null;
}

export function parameterLpeaKosong(tahunBuku: number): ParameterLpea {
  return {
    tahunBuku,
    tarifLuarJasaPinjaman: null,
    tarifLuarJasaProvisi: null,
    tarifLuarTabungan: null,
    tarifLuarSimpananBerjangka: null,
    tarifKoperasiJasaProvisi: null,
    tarifKoperasiTabungan: null,
    sumberAcuan: null,
    diperbaruiPada: null,
  };
}

/** Parameter yang dibutuhkan tiap komponen agar dapat dihitung. */
export const PARAMETER_DIBUTUHKAN: Record<KomponenPea, (keyof ParameterLpea)[]> = {
  JASA_PINJAMAN: ['tarifLuarJasaPinjaman'],
  JASA_PROVISI: ['tarifLuarJasaProvisi', 'tarifKoperasiJasaProvisi'],
  TABUNGAN: ['tarifLuarTabungan', 'tarifKoperasiTabungan'],
  SIMPANAN_BERJANGKA: ['tarifLuarSimpananBerjangka'],
};

export const LABEL_PARAMETER_LPEA: Partial<Record<keyof ParameterLpea, string>> = {
  tarifLuarJasaPinjaman: 'Jasa pinjaman rata-rata di lembaga keuangan lain',
  tarifLuarJasaProvisi: 'Provisi rata-rata di lembaga keuangan lain',
  tarifLuarTabungan: 'Bunga tabungan rata-rata di lembaga keuangan lain',
  tarifLuarSimpananBerjangka: 'Bunga simpanan berjangka rata-rata di lembaga keuangan lain',
  tarifKoperasiJasaProvisi: 'Provisi yang dipungut koperasi',
  tarifKoperasiTabungan: 'Bunga tabungan yang diberikan koperasi',
};

export function parameterKurang(komponen: KomponenPea, parameter: ParameterLpea): (keyof ParameterLpea)[] {
  return PARAMETER_DIBUTUHKAN[komponen].filter((k) => {
    const v = parameter[k];
    return v === null || v === undefined || !Number.isFinite(v as number);
  });
}

// ===========================================================================
// HASIL PER KOMPONEN & LAPORAN
// ===========================================================================

export type StatusKomponenPea =
  /** Dihitung dari data aktual + parameter yang sudah diisi. */
  | 'DIHITUNG'
  /** Parameter wajibnya belum diisi — TIDAK dianggap nol, TIDAK masuk total. */
  | 'BELUM_DAPAT_DIHITUNG'
  /** Parameter lengkap, tetapi memang tidak ada transaksi pada periode ini. */
  | 'TIDAK_ADA_TRANSAKSI';

export interface HasilKomponenPea {
  komponen: KomponenPea;
  huruf: 'A' | 'B' | 'C' | 'D';
  label: string;
  kelompok: KelompokPea;
  status: StatusKomponenPea;
  /** Nilai PEA; hanya bermakna bila status 'DIHITUNG'. */
  nilai: Rupiah;
  /** Total basis (a) yang dipakai — untuk rekonsiliasi ke sumber transaksi. */
  totalBasis: Rupiah;
  jumlahBaris: number;
  parameterKurang: (keyof ParameterLpea)[];
  /** Tarif yang dipakai, dicetak di laporan supaya angkanya dapat ditelusuri. */
  tarifLuarPersenPerBulan: number | null;
  /** Untuk komponen yang tarif koperasinya seragam (provisi/tabungan); null bila per transaksi. */
  tarifKoperasiPersenPerBulan: number | null;
}

/**
 * Susun hasil satu komponen. Gerbangnya berurutan dan sengaja:
 * parameter kurang diperiksa LEBIH DULU daripada ada/tidaknya transaksi,
 * supaya komponen tanpa parameter tidak pernah dilaporkan sebagai
 * "tidak ada transaksi" (yang menyiratkan angkanya benar nol).
 */
export function susunHasilKomponen(
  komponen: KomponenPea,
  baris: BarisPea[],
  parameter: ParameterLpea,
  tarifKoperasiSeragam: number | null
): HasilKomponenPea {
  const kurang = parameterKurang(komponen, parameter);
  const totalBasis = roundToRupiah(baris.reduce((t, b) => t.plus(b.basis), new Decimal(0)));
  const dasar: Omit<HasilKomponenPea, 'status' | 'nilai'> = {
    komponen,
    huruf: HURUF_BUKU_PEMBANTU[komponen],
    label: LABEL_KOMPONEN_PEA[komponen],
    kelompok: KELOMPOK_DARI_KOMPONEN[komponen],
    totalBasis,
    jumlahBaris: baris.length,
    parameterKurang: kurang,
    tarifLuarPersenPerBulan: tarifLuarUntuk(komponen, parameter),
    tarifKoperasiPersenPerBulan: tarifKoperasiSeragam,
  };

  if (kurang.length > 0) return { ...dasar, status: 'BELUM_DAPAT_DIHITUNG', nilai: 0 };
  if (baris.length === 0) return { ...dasar, status: 'TIDAK_ADA_TRANSAKSI', nilai: 0 };
  return { ...dasar, status: 'DIHITUNG', nilai: hitungPeaKomponen(komponen, baris) };
}

export function tarifLuarUntuk(komponen: KomponenPea, p: ParameterLpea): number | null {
  switch (komponen) {
    case 'JASA_PINJAMAN':
      return p.tarifLuarJasaPinjaman;
    case 'JASA_PROVISI':
      return p.tarifLuarJasaProvisi;
    case 'TABUNGAN':
      return p.tarifLuarTabungan;
    case 'SIMPANAN_BERJANGKA':
      return p.tarifLuarSimpananBerjangka;
  }
}

/** Bagian SHU — HANYA dari pembagian yang sudah benar-benar diproses. */
export interface BagianShuLpea {
  /** Tahun buku SHU yang dibagikan. */
  tahunBuku: number;
  /** true HANYA bila `shu_konfigurasi.status = 'DIBAGIKAN'` (hasil bagikanSHU()). */
  sudahDibagikan: boolean;
  /** Total SHU bagian anggota yang dibagikan; 0 bila belum dibagikan. */
  totalBagianAnggota: Rupiah;
  jumlahAnggotaPenerima: number;
  /** Nominal yang disahkan RAT — untuk rekonsiliasi, bukan untuk ditotal. */
  shuDisahkanRat: Rupiah | null;
}

export interface LaporanLpea {
  tahunBuku: number;
  tanggalMulai: string;
  tanggalSelesai: string;
  parameter: ParameterLpea;
  komponen: HasilKomponenPea[];
  /** Subtotal per kelompok — hanya komponen berstatus DIHITUNG yang dijumlahkan. */
  subtotalPenghematanBebanPinjaman: Rupiah;
  subtotalKelebihanBalasJasaSimpanan: Rupiah;
  /** "Jumlah promosi ekonomi dari transaksi penyediaan jasa untuk anggota". */
  jumlahPeaPelayanan: Rupiah;
  bagianShu: BagianShuLpea;
  /** "Jumlah Promosi Ekonomi Anggota" = PEA pelayanan + pembagian SHU. */
  jumlahPeaAnggota: Rupiah;
  /** true bila ADA komponen berstatus BELUM_DAPAT_DIHITUNG -> total belum lengkap. */
  totalBelumLengkap: boolean;
  /** Daftar keterbatasan untuk ditampilkan apa adanya, bukan disembunyikan. */
  keterbatasan: string[];
}

/**
 * Rakit laporan akhir dari hasil per komponen + bagian SHU.
 *
 * ATURAN TOTAL: komponen berstatus 'BELUM_DAPAT_DIHITUNG' TIDAK
 * dijumlahkan dan menandai `totalBelumLengkap`. Menjumlahkannya sebagai
 * nol akan menghasilkan total yang terlihat final padahal separuh
 * datanya belum ada — tepat jenis angka yang tidak boleh keluar dari
 * laporan resmi.
 */
export function rakitLaporanLpea(input: {
  tahunBuku: number;
  tanggalMulai: string;
  tanggalSelesai: string;
  parameter: ParameterLpea;
  komponen: HasilKomponenPea[];
  bagianShu: BagianShuLpea;
}): LaporanLpea {
  const { komponen, bagianShu } = input;
  const jumlahKelompok = (kel: KelompokPea) =>
    komponen
      .filter((k) => k.kelompok === kel && k.status === 'DIHITUNG')
      .reduce((t, k) => t + k.nilai, 0);

  const subtotalPinjaman = jumlahKelompok('PENGHEMATAN_BEBAN_PINJAMAN');
  const subtotalSimpanan = jumlahKelompok('KELEBIHAN_BALAS_JASA_SIMPANAN');
  const jumlahPeaPelayanan = subtotalPinjaman + subtotalSimpanan;
  const totalBagianShu = bagianShu.sudahDibagikan ? bagianShu.totalBagianAnggota : 0;

  const belum = komponen.filter((k) => k.status === 'BELUM_DAPAT_DIHITUNG');
  const keterbatasan: string[] = [];
  for (const k of belum) {
    const nama = k.parameterKurang.map((p) => LABEL_PARAMETER_LPEA[p] ?? String(p)).join(', ');
    keterbatasan.push(
      `${k.label} (buku pembantu ${k.huruf}) belum dapat dihitung — parameter belum diisi: ${nama}.`
    );
  }
  if (!bagianShu.sudahDibagikan) {
    keterbatasan.push(
      `Pembagian SHU tahun buku ${bagianShu.tahunBuku} belum diproses, sehingga belum ada manfaat pembagian SHU yang boleh dilaporkan. ` +
        `SHU yang baru dihitung atau baru disahkan RAT TIDAK dihitung sebagai manfaat ekonomi anggota.`
    );
  }

  return {
    ...input,
    subtotalPenghematanBebanPinjaman: subtotalPinjaman,
    subtotalKelebihanBalasJasaSimpanan: subtotalSimpanan,
    jumlahPeaPelayanan,
    jumlahPeaAnggota: jumlahPeaPelayanan + totalBagianShu,
    totalBelumLengkap: belum.length > 0,
    keterbatasan,
  };
}

export const LABEL_STATUS_KOMPONEN: Record<StatusKomponenPea, string> = {
  DIHITUNG: 'Dihitung',
  BELUM_DAPAT_DIHITUNG: 'Belum dapat dihitung',
  TIDAK_ADA_TRANSAKSI: 'Tidak ada transaksi',
};

/**
 * Catatan keterbatasan STRUKTURAL aplikasi ini terhadap naskah — bukan
 * soal parameter yang belum diisi, melainkan hal yang memang belum
 * dicatat aplikasi. Ditampilkan di laporan supaya pembaca tahu batas
 * keberlakuannya.
 */
export const KETERBATASAN_STRUKTURAL: string[] = [
  'Aplikasi tidak memungut provisi pinjaman, sehingga tarif provisi koperasi harus diisi manual bila koperasi memungutnya di luar aplikasi.',
  'Simpanan pokok/wajib/sukarela pada aplikasi ini tidak berbunga, sehingga bunga tabungan yang diberikan koperasi harus diisi manual bila koperasi memberikannya.',
  'Basis tabungan memakai saldo simpanan sukarela pada akhir periode; naskah memakai metode saldo terendah, yang memerlukan pencatatan saldo harian.',
  'Manfaat lain menurut butir 5.8 angka 4 huruf d (mis. biaya transaksi kredit yang murah, persyaratan kredit yang ringan) bersifat kualitatif dan tidak dikuantifikasi di laporan ini.',
];

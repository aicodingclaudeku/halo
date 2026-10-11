import { Rupiah, roundToRupiah } from '@/utils/money';

/**
 * KolektibilitasSomService — MESIN PENGGOLONGAN KUALITAS PINJAMAN
 * menurut Petunjuk Pelaksanaan Standar Operasional Manajemen (SOM)
 * Koperasi Simpan Pinjam, Deputi Bidang Pengawasan Koperasi,
 * Nomor 3 Tahun 2025.
 *
 * ============================================================
 * SUMBER — DIKUTIP LANGSUNG DARI NASKAH
 * ============================================================
 * Seluruh angka & kriteria di berkas ini berasal dari naskah resmi
 * Juklat SOM 2025 (`Petunjuk Pelaksanaan SOM_2025`), pada:
 *
 *   - Angka 12.1 "Kriteria Pinjaman Bermasalah" (hal. 42-43) — kriteria
 *     Kurang Lancar, Diragukan, dan Macet.
 *   - Angka 15 "Contoh Perhitungan Taksiran Piutang Tak Tertagih
 *     (Cadangan Risiko)" (hal. 86) — persentase taksiran piutang tak
 *     tertagih per kategori.
 *
 * Naskah HANYA mendefinisikan tiga kategori bermasalah (Kurang Lancar,
 * Diragukan, Macet); "Lancar" adalah sisanya — pinjaman yang tidak
 * memenuhi kriteria ketiganya. TIDAK ADA kategori "Dalam Perhatian
 * (Khusus)" dalam SOM: itu istilah PERBANKAN (POJK kualitas aset bank
 * umum/BPR), bukan istilah KSP.
 *
 * ============================================================
 * KUTIPAN KRITERIA (Angka 12.1)
 * ============================================================
 * 1) KURANG LANCAR — apabila memenuhi kriteria:
 *    1. Pengembalian pinjaman DENGAN SISTEM ANGSURAN:
 *       a. Terdapat tunggakan angsuran POKOK:
 *          - "Tunggakan melampaui 1 bulan tetapi belum melampaui 2
 *            bulan bagi pinjaman dengan masa angsuran KURANG DARI 1
 *            BULAN"; atau
 *          - "Melampaui 3 bulan tetapi belum melampaui 6 bulan bagi
 *            pinjaman yang masa angsurannya ditetapkan 2 BULAN SAMPAI
 *            3 BULAN"; atau
 *          - "Melampaui 6 bulan tetapi belum melampaui 12 bulan bagi
 *            pinjaman yang masa angsurannya ditetapkan 6 BULAN ATAU
 *            LEBIH"; atau
 *       b. Terdapat tunggakan BUNGA:
 *          - "Tunggakan melampaui 1 bulan tetapi belum melampaui 3
 *            bulan bagi pinjaman dengan masa angsuran kurang dari 1
 *            bulan"; atau
 *          - "Melampaui 3 bulan, tetapi belum melampaui 6 bulan bagi
 *            pinjaman yang masa angsurannya LEBIH DARI 1 BULAN".
 *    2. Pengembalian pinjaman TANPA ANGSURAN:
 *       a. "Pinjaman belum jatuh tempo — terdapat tunggakan bunga yang
 *          melampaui 3 bulan tetapi belum melampaui 6 bulan."
 *       b. "Pinjaman telah jatuh tempo dan belum dibayar tetapi belum
 *          melampaui 3 bulan."
 *
 * 2) DIRAGUKAN — "apabila pinjaman yang bersangkutan tidak memenuhi
 *    kriteria kurang lancar tetapi berdasarkan penilaian dapat
 *    disimpulkan bahwa:
 *      a. Pinjaman masih dapat diselamatkan dan ANGSURANNYA bernilai
 *         sekurang-kurangnya 75% dari utang peminjam TERMASUK BUNGANYA;
 *         atau
 *      b. Pinjaman tidak dapat diselamatkan tetapi AGUNANNYA masih
 *         bernilai sekurang-kurangnya 100% dari utang peminjam."
 *
 * 3) MACET — "apabila:
 *      1. Tidak memenuhi kriteria kurang lancar dan diragukan; atau
 *      2. Memenuhi kriteria diragukan tetapi dalam jangka waktu 21
 *         bulan sejak digolongkan diragukan belum ada pelunasan atau
 *         usaha penyelamatan pinjaman;
 *      3. Pinjaman tersebut penyelesaiannya telah diserahkan kepada
 *         Pengadilan Negeri atau telah diajukan permohonan ganti rugi
 *         kepada perusahaan asuransi kredit."
 *
 * PERHATIKAN kriteria Diragukan huruf a: naskah menulis "ANGSURANNYA",
 * bukan "agunannya" — dua kriteria Diragukan itu memang mengukur DUA
 * hal yang berbeda (kemajuan pembayaran 75%, dan nilai agunan 100%).
 * Penulisan itu dipertahankan apa adanya di sini, TIDAK ditafsirkan
 * ulang menjadi "agunan 75%": mengubah bunyi kriteria peraturan bukan
 * wewenang kode.
 *
 * ============================================================
 * DUA CELAH NASKAH & KEPUTUSANNYA (WAJIB DIBACA)
 * ============================================================
 * Kriteria tunggakan POKOK menyebut tiga kelompok masa angsuran:
 * "kurang dari 1 bulan", "2 bulan sampai 3 bulan", dan "6 bulan atau
 * lebih". Dua rentang TIDAK disebut sama sekali:
 *
 *   (1) masa angsuran TEPAT 1 BULAN (pinjaman bulanan) — tidak masuk
 *       "kurang dari 1 bulan", tidak masuk "2 sampai 3 bulan";
 *   (2) masa angsuran di atas 3 bulan tetapi di bawah 6 bulan.
 *
 * Kriteria tunggakan BUNGA punya celah yang sama pada masa angsuran
 * tepat 1 bulan ("kurang dari 1 bulan" vs "lebih dari 1 bulan").
 *
 * KEPUTUSAN: keduanya dimasukkan ke kelompok `SATU_SAMPAI_3_BULAN`
 * (ambang 3/6 bulan untuk pokok, 3/6 untuk bunga). Alasannya:
 *   - Pinjaman BULANAN adalah bentuk pinjaman yang paling umum di KSP;
 *     membiarkannya tanpa ambang bukan pilihan.
 *   - Memasukkannya ke kelompok "kurang dari 1 bulan" (ambang 1/2 bulan)
 *     akan memperlakukan pinjaman bulanan LEBIH KERAS daripada pinjaman
 *     2-bulanan yang jelas lebih jarang angsurannya — hasil yang tidak
 *     mungkin dimaksudkan naskah.
 *   - Rumusan SOM KSP versi sebelumnya menyebut kelompok ini sebagai
 *     "bulanan, 2 bulanan atau 3 bulanan", sehingga penempatan ini
 *     mengikuti maksud yang sama.
 *   - Rentang 4-5 bulan diberi ambang yang lebih PENDEK (3/6, bukan
 *     6/12) — bacaan konservatif untuk rentang yang tidak diatur.
 *
 * Ini KEPUTUSAN PENAFSIRAN, bukan kutipan. Kalau pengawas koperasi
 * menghendaki penempatan lain, yang perlu diubah HANYA
 * `kelompokMasaAngsuran()` di bawah.
 *
 * ============================================================
 * BERKAS INI MURNI FUNGSI (tanpa akses database)
 * ============================================================
 * SENGAJA tidak ada satu pun import ke `@/database/db` atau
 * `expo-sqlite`: mesin aturan harus bisa diuji langsung dengan angka,
 * dan builder export (`@/export/ReportTableBuilders`) harus bisa
 * memakai label/konstantanya tanpa menarik masuk modul native. Yang
 * MENGAMBIL data & MEMANGGIL mesin ini adalah
 * `LoanImpairmentService.getKlasifikasiPinjamanAktif()` — SATU-SATUNYA
 * tempat aging & saldo pinjaman dihitung di aplikasi ini.
 */

export type KolektibilitasSom = 'LANCAR' | 'KURANG_LANCAR' | 'DIRAGUKAN' | 'MACET';

export const KOLEKTIBILITAS_SOM_URUT: KolektibilitasSom[] = [
  'LANCAR',
  'KURANG_LANCAR',
  'DIRAGUKAN',
  'MACET',
];

export const LABEL_KOLEKTIBILITAS_SOM: Record<KolektibilitasSom, string> = {
  LANCAR: 'Lancar',
  KURANG_LANCAR: 'Kurang Lancar',
  DIRAGUKAN: 'Diragukan',
  MACET: 'Macet',
};

/**
 * Kategori PINJAMAN BERMASALAH menurut SOM. Naskah angka 12.2 A.1.a
 * menyebutnya eksplisit: "menggolongkan pinjaman bermasalah sesuai
 * dengan tingkat kolektibilitasnya yaitu: pinjaman kurang lancar,
 * pinjaman diragukan dan pinjaman macet". Tidak ada kategori antara
 * Lancar dan Kurang Lancar, jadi batas bermasalah jatuh tepat di
 * Kurang Lancar.
 */
export const KATEGORI_BERMASALAH_SOM: KolektibilitasSom[] = ['KURANG_LANCAR', 'DIRAGUKAN', 'MACET'];

export function isPinjamanBermasalah(kategori: KolektibilitasSom): boolean {
  return KATEGORI_BERMASALAH_SOM.includes(kategori);
}

/**
 * Persentase taksiran piutang tak tertagih (cadangan risiko) per
 * kategori — Juklat SOM 2025 angka 15, hal. 86.
 *
 * Naskah memberi contoh perhitungan dengan persentase berikut:
 *   Pinjaman lancar          0%   x Rp300.000.000 = Rp0
 *   Pinjaman kurang lancar  50%   x Rp100.000.000 = Rp50.000.000
 *   Pinjaman diragukan      75%   x Rp 75.000.000 = Rp56.250.000
 *   Pinjaman macet         100%   x Rp 25.000.000 = Rp25.000.000
 *
 * ANGKA INI JAUH BERBEDA dari batasan FISKAL PMK 74/2024 baris Koperasi
 * Simpan Pinjam (0,5% / 10% / 50% / 100%) — dan perbedaan itu WAJAR
 * serta memang dimaksudkan: SOM mengatur kehati-hatian PENCADANGAN
 * KOPERASI, sedangkan PMK 74 mengatur BATAS MAKSIMUM yang boleh
 * dikurangkan dari penghasilan bruto untuk tujuan PAJAK. Cadangan buku
 * SOM lazim jauh MELEBIHI batas fiskal, dan selisihnya adalah koreksi
 * fiskal positif di SPT Badan. Lihat `KolektibilitasFiskalService.ts`.
 *
 * Lancar 0% BERARTI tidak ada pencadangan atas pinjaman lancar menurut
 * SOM. Ini disengaja mengikuti naskah, dan merupakan perbedaan penting
 * dari PMK 74 yang tetap mengakui 0,5% untuk kategori Lancar.
 */
export const PERSENTASE_PENYISIHAN_SOM: Record<KolektibilitasSom, number> = {
  LANCAR: 0,
  KURANG_LANCAR: 50,
  DIRAGUKAN: 75,
  MACET: 100,
};

/**
 * Kriteria Diragukan huruf a — "angsurannya bernilai sekurang-kurangnya
 * 75% dari utang peminjam termasuk bunganya".
 */
export const RASIO_ANGSURAN_MINIMUM_DIRAGUKAN = 75;

/**
 * Kriteria Diragukan huruf b — "agunannya masih bernilai
 * sekurang-kurangnya 100% dari utang peminjam".
 */
export const RASIO_AGUNAN_MINIMUM_DIRAGUKAN = 100;

/** Kriteria Macet angka 2 — "dalam jangka waktu 21 bulan sejak digolongkan diragukan". */
export const BULAN_DIRAGUKAN_MENJADI_MACET = 21;

export type PolaPengembalian = 'ANGSURAN' | 'TANPA_ANGSURAN';

/**
 * Kelompok masa angsuran menurut kriteria tunggakan pokok SOM. Nama
 * kelompok mengikuti bunyi naskah, kecuali kelompok tengah yang juga
 * memuat masa angsuran 1 bulan & 4-5 bulan (celah naskah — lihat
 * komentar header "DUA CELAH NASKAH").
 */
export type KelompokMasaAngsuran = 'KURANG_DARI_1_BULAN' | 'SATU_SAMPAI_3_BULAN' | 'ENAM_BULAN_ATAU_LEBIH';

export interface AmbangKurangLancar {
  /** Tunggakan POKOK: "melampaui X bulan" — di ATAS nilai ini baru Kurang Lancar. */
  pokokLewatBulan: number;
  /** Tunggakan POKOK: "belum melampaui Y bulan" — di ATAS nilai ini sudah melewati Kurang Lancar. */
  pokokBatasAtasBulan: number;
  jasaLewatBulan: number;
  jasaBatasAtasBulan: number;
}

/**
 * Tabel ambang Kurang Lancar per kelompok masa angsuran — Juklat SOM
 * 2025 angka 12.1 butir 1). SATU-SATUNYA tempat angka ambang ini
 * ditulis di seluruh aplikasi.
 */
export const AMBANG_SOM: Record<KelompokMasaAngsuran, AmbangKurangLancar> = {
  KURANG_DARI_1_BULAN: {
    // Pokok: melampaui 1 bulan, belum melampaui 2 bulan.
    pokokLewatBulan: 1,
    pokokBatasAtasBulan: 2,
    // Bunga: melampaui 1 bulan, belum melampaui 3 bulan.
    jasaLewatBulan: 1,
    jasaBatasAtasBulan: 3,
  },
  SATU_SAMPAI_3_BULAN: {
    // Pokok: melampaui 3 bulan, belum melampaui 6 bulan.
    pokokLewatBulan: 3,
    pokokBatasAtasBulan: 6,
    // Bunga: melampaui 3 bulan, belum melampaui 6 bulan (kelompok
    // "masa angsuran lebih dari 1 bulan").
    jasaLewatBulan: 3,
    jasaBatasAtasBulan: 6,
  },
  ENAM_BULAN_ATAU_LEBIH: {
    // Pokok: melampaui 6 bulan, belum melampaui 12 bulan.
    pokokLewatBulan: 6,
    pokokBatasAtasBulan: 12,
    // Kriteria bunga SOM hanya membedakan masa angsuran "kurang dari 1
    // bulan" vs "lebih dari 1 bulan" — tidak ada baris tersendiri untuk
    // 6 bulanan, jadi ambang bunganya sama dengan kelompok di atas.
    jasaLewatBulan: 3,
    jasaBatasAtasBulan: 6,
  },
};

/** Ambang Kurang Lancar untuk pinjaman TANPA ANGSURAN — angka 12.1 butir 1) sub 2. */
export const AMBANG_SOM_TANPA_ANGSURAN = {
  /** Belum jatuh tempo — tunggakan bunga: melampaui 3 bulan, belum melampaui 6 bulan. */
  jasaLewatBulan: 3,
  jasaBatasAtasBulan: 6,
  /** Sudah jatuh tempo & belum dibayar — belum melampaui 3 bulan. */
  setelahJatuhTempoBatasAtasBulan: 3,
};

/**
 * Kelompok masa angsuran dari panjang interval antar angsuran (bulan).
 *
 * Masa angsuran 1 bulan dan 4-5 bulan tidak disebut naskah dan
 * ditempatkan di kelompok `SATU_SAMPAI_3_BULAN` — lihat komentar header
 * "DUA CELAH NASKAH & KEPUTUSANNYA" untuk alasan lengkapnya. INI
 * SATU-SATUNYA tempat penempatan itu diputuskan.
 */
export function kelompokMasaAngsuran(masaAngsuranBulan: number): KelompokMasaAngsuran {
  if (masaAngsuranBulan < 1) return 'KURANG_DARI_1_BULAN';
  if (masaAngsuranBulan >= 6) return 'ENAM_BULAN_ATAU_LEBIH';
  return 'SATU_SAMPAI_3_BULAN';
}

/**
 * Panjang interval antar angsuran dalam BULAN, dari satuan tenor
 * pinjaman. Jadwal angsuran aplikasi ini dibuat dengan interval TEPAT
 * 1 satuan tenor per angsuran (lihat `calculateInstallmentDate` di
 * `@/accounting/InstallmentDate`), jadi satuan tenor ADALAH masa
 * angsurannya — tidak perlu diterka dari selisih tanggal jadwal.
 *
 * Nilai pecahan dipakai apa adanya (tidak dibulatkan ke 0 atau 1):
 * yang dibutuhkan `kelompokMasaAngsuran` hanya "kurang dari 1 bulan"
 * atau tidak, dan 1/30 serta 7/30 keduanya jelas kurang dari 1.
 */
export function masaAngsuranBulanDariSatuanTenor(satuanTenor: string): number {
  if (satuanTenor === 'HARI') return 1 / 30;
  if (satuanTenor === 'MINGGU') return 7 / 30;
  return 1; // 'BULAN'
}

/**
 * Jumlah BULAN PENUH yang sudah terlewati antara dua tanggal ISO
 * (yyyy-MM-dd). Ditulis di sini, bukan memakai `date-fns`, supaya
 * berkas ini tetap bebas dependency (lihat komentar header).
 *
 * "Bulan penuh" berarti tanggal harinya diperhitungkan: 15 Jan -> 14
 * Feb = 0 bulan, 15 Jan -> 15 Feb = 1 bulan. Inilah bacaan yang benar
 * untuk kalimat "melampaui 3 bulan" — yang dimaksud tunggakan yang
 * usianya lebih dari 3 bulan KALENDER, bukan 90 hari.
 */
export function bulanPenuhAntara(dariIso: string, keIso: string): number {
  const dari = new Date(`${dariIso}T00:00:00`);
  const ke = new Date(`${keIso}T00:00:00`);
  if (Number.isNaN(dari.getTime()) || Number.isNaN(ke.getTime())) return 0;
  if (ke <= dari) return 0;

  let bulan = (ke.getFullYear() - dari.getFullYear()) * 12 + (ke.getMonth() - dari.getMonth());
  // Belum sampai tanggal yang sama di bulan tujuan -> bulan terakhir belum penuh.
  if (ke.getDate() < dari.getDate()) bulan -= 1;
  return Math.max(0, bulan);
}

export interface InputKlasifikasiSom {
  polaPengembalian: PolaPengembalian;
  /** Interval antar angsuran dalam bulan — lihat `masaAngsuranBulanDariSatuanTenor`. */
  masaAngsuranBulan: number;
  /** Usia tunggakan angsuran POKOK tertua yang masih outstanding, dalam bulan penuh. */
  bulanTunggakanPokok: number;
  /** Usia tunggakan angsuran BUNGA/JASA tertua yang masih outstanding, dalam bulan penuh. */
  bulanTunggakanJasa: number;
  /** TANPA_ANGSURAN: apakah tanggal jatuh tempo pinjaman sudah LEWAT pada tanggal laporan. */
  sudahJatuhTempo: boolean;
  /** TANPA_ANGSURAN: bulan penuh sejak tanggal jatuh tempo pinjaman. */
  bulanSejakJatuhTempo: number;

  // ---- Kriteria Diragukan (dua ukuran BERBEDA, lihat kutipan di header) ----
  /**
   * Kriteria huruf a — jumlah angsuran yang SUDAH DIBAYAR peminjam
   * (pokok + bunga), pembilang rasio 75%.
   */
  angsuranTerbayar: Rupiah;
  /**
   * Kriteria huruf a — "utang peminjam termasuk bunganya", penyebut
   * rasio 75%. Yaitu seluruh kewajiban KONTRAKTUAL pinjaman (pokok +
   * bunga sepanjang jadwal), bukan sisa utangnya: rasio ini mengukur
   * KEMAJUAN PEMBAYARAN, dan kemajuan hanya punya arti terhadap
   * kewajiban penuh.
   */
  totalKewajibanKontraktual: Rupiah;
  /** Kriteria huruf b — nilai agunan, pembilang rasio 100%. */
  nilaiAgunan: Rupiah;
  /**
   * Kriteria huruf b — "utang peminjam", penyebut rasio 100%. Yaitu
   * SISA utang (pokok + jasa outstanding) pada tanggal laporan:
   * kecukupan agunan diukur terhadap eksposur yang masih ada, bukan
   * terhadap nilai pinjaman yang sebagian sudah dilunasi.
   */
  sisaUtang: Rupiah;

  /**
   * Kriteria Macet angka 3 — penyelesaian sudah diserahkan ke Pengadilan
   * Negeri atau diajukan permohonan ganti rugi ke perusahaan asuransi
   * kredit. TIDAK ADA kolomnya di basis data aplikasi ini, jadi
   * pemanggil dari database selalu mengirim `false`; parameternya tetap
   * ada supaya kriteria peraturannya lengkap & teruji, dan supaya
   * penambahan kolomnya nanti tidak perlu mengubah mesin aturan.
   */
  diserahkanKePengadilanAtauAsuransi?: boolean;
}

/** Tingkat keparahan satu dimensi tunggakan terhadap ambang Kurang Lancar. */
type TingkatTunggakan = 0 | 1 | 2; // 0 = belum Kurang Lancar, 1 = Kurang Lancar, 2 = melewati Kurang Lancar

export interface HasilKlasifikasiSom {
  kategori: KolektibilitasSom;
  persentasePenyisihan: number;
  kelompokMasaAngsuran: KelompokMasaAngsuran;
  /** Angsuran terbayar sebagai persen dari kewajiban kontraktual (kriteria Diragukan huruf a). */
  rasioAngsuranPersen: number;
  /** Nilai agunan sebagai persen dari sisa utang (kriteria Diragukan huruf b). */
  rasioAgunanPersen: number;
  /**
   * Bulan yang sudah terlewati sejak pinjaman melampaui batas atas
   * Kurang Lancar — yaitu sejak ia mulai layak digolongkan Diragukan.
   * 0 kalau belum pernah melampaui batas itu. Dasar aturan 21 bulan.
   */
  bulanSejakDiragukan: number;
  /** Kalimat siap-tampil yang menyebut kriteria SOM mana yang memicu kategori ini. */
  dasarPenggolongan: string;
}

function tingkatTunggakan(bulan: number, lewatBulan: number, batasAtasBulan: number): TingkatTunggakan {
  // "melampaui X bulan" = bulan > X. "belum melampaui Y bulan" = bulan <= Y.
  if (bulan <= lewatBulan) return 0;
  if (bulan <= batasAtasBulan) return 1;
  return 2;
}

/**
 * Penggolongan kualitas pinjaman menurut Juklat SOM 3/2025 angka 12.1.
 *
 * URUTAN PENILAIAN mengikuti struktur naskahnya, bukan urutan yang
 * paling mudah ditulis:
 *   1. Kriteria Macet angka 3 (pengadilan/asuransi kredit) —
 *      mengesampingkan seluruh penilaian tunggakan, angsuran & agunan.
 *   2. Tingkat tunggakan terhadap ambang Kurang Lancar, diambil yang
 *      TERBURUK di antara dimensi pokok & bunga (pinjaman tidak menjadi
 *      lebih sehat karena salah satu komponennya tertagih).
 *   3. Belum melampaui batas bawah -> LANCAR. Di dalam rentang ->
 *      KURANG_LANCAR.
 *   4. Melewati batas atas Kurang Lancar -> DIRAGUKAN bila SALAH SATU
 *      kriteria Diragukan terpenuhi (angsuran terbayar >= 75% kewajiban
 *      kontraktual, ATAU agunan >= 100% sisa utang); selain itu MACET
 *      (kriteria Macet angka 1).
 *   5. DIRAGUKAN yang sudah >= 21 bulan -> MACET (kriteria Macet angka 2).
 *
 * CATATAN PENAFSIRAN: naskah membungkus kedua kriteria Diragukan dengan
 * penilaian kualitatif "masih dapat diselamatkan" / "tidak dapat
 * diselamatkan". Penilaian itu adalah pertimbangan pengurus dan TIDAK
 * ADA datanya di aplikasi, jadi yang diuji di sini hanya bagian yang
 * TERUKUR: rasio 75% angsuran dan rasio 100% agunan. Akibatnya
 * penggolongan ini bisa lebih ringan daripada penilaian pengurus yang
 * menyimpulkan pinjaman tidak dapat diselamatkan meski rasionya
 * memenuhi — itu keputusan yang memang harus dibuat manusia, dan
 * `dasarPenggolongan` di bawah menyebutkan rasionya supaya pengurus
 * bisa menilai ulang.
 */
export function klasifikasikanSom(input: InputKlasifikasiSom): HasilKlasifikasiSom {
  const kelompok = kelompokMasaAngsuran(input.masaAngsuranBulan);

  const angsuranTerbayar = Math.max(0, input.angsuranTerbayar);
  const totalKewajiban = Math.max(0, input.totalKewajibanKontraktual);
  const nilaiAgunan = Math.max(0, input.nilaiAgunan);
  const sisaUtang = Math.max(0, input.sisaUtang);

  // Penyebut 0 -> rasio 0, BUKAN NaN atau Infinity.
  const rasioAngsuranPersen = totalKewajiban > 0 ? (angsuranTerbayar / totalKewajiban) * 100 : 0;
  const rasioAgunanPersen = sisaUtang > 0 ? (nilaiAgunan / sisaUtang) * 100 : 0;

  const hasil = (
    kategori: KolektibilitasSom,
    dasarPenggolongan: string,
    bulanSejakDiragukan = 0
  ): HasilKlasifikasiSom => ({
    kategori,
    persentasePenyisihan: PERSENTASE_PENYISIHAN_SOM[kategori],
    kelompokMasaAngsuran: kelompok,
    rasioAngsuranPersen,
    rasioAgunanPersen,
    bulanSejakDiragukan,
    dasarPenggolongan,
  });

  if (input.diserahkanKePengadilanAtauAsuransi) {
    return hasil(
      'MACET',
      'Macet — penyelesaian sudah diserahkan ke Pengadilan Negeri atau diajukan permohonan ganti rugi ke perusahaan asuransi kredit (SOM 12.1 kriteria Macet angka 3).'
    );
  }

  // ---- Tingkat tunggakan & batas atas Kurang Lancar yang berlaku ----
  let tingkat: TingkatTunggakan;
  let batasAtasBulan: number;
  let uraianTunggakan: string;

  if (input.polaPengembalian === 'TANPA_ANGSURAN') {
    if (input.sudahJatuhTempo) {
      const bulan = Math.max(0, Math.floor(input.bulanSejakJatuhTempo));
      batasAtasBulan = AMBANG_SOM_TANPA_ANGSURAN.setelahJatuhTempoBatasAtasBulan;
      // "telah jatuh tempo dan belum dibayar tetapi belum melampaui 3
      // bulan" — jatuh tempo yang baru terlewati (0 bulan) sudah masuk
      // Kurang Lancar, karena pinjamannya memang sudah harus lunas.
      tingkat = bulan <= batasAtasBulan ? 1 : 2;
      uraianTunggakan = `pinjaman tanpa angsuran sudah jatuh tempo ${bulan} bulan dan belum dibayar`;
    } else {
      const bulan = Math.max(0, Math.floor(input.bulanTunggakanJasa));
      batasAtasBulan = AMBANG_SOM_TANPA_ANGSURAN.jasaBatasAtasBulan;
      tingkat = tingkatTunggakan(bulan, AMBANG_SOM_TANPA_ANGSURAN.jasaLewatBulan, batasAtasBulan);
      uraianTunggakan = `pinjaman tanpa angsuran belum jatuh tempo, tunggakan bunga ${bulan} bulan`;
    }
  } else {
    const ambang = AMBANG_SOM[kelompok];
    const bulanPokok = Math.max(0, Math.floor(input.bulanTunggakanPokok));
    const bulanJasa = Math.max(0, Math.floor(input.bulanTunggakanJasa));
    const tingkatPokok = tingkatTunggakan(bulanPokok, ambang.pokokLewatBulan, ambang.pokokBatasAtasBulan);
    const tingkatJasa = tingkatTunggakan(bulanJasa, ambang.jasaLewatBulan, ambang.jasaBatasAtasBulan);

    // Dimensi TERBURUK yang menentukan. Saat seri, pokok dipakai sebagai
    // penjelasannya — pokok adalah eksposur yang dicadangkan.
    if (tingkatJasa > tingkatPokok) {
      tingkat = tingkatJasa;
      batasAtasBulan = ambang.jasaBatasAtasBulan;
      uraianTunggakan = `tunggakan bunga ${bulanJasa} bulan`;
    } else {
      tingkat = tingkatPokok;
      batasAtasBulan = ambang.pokokBatasAtasBulan;
      uraianTunggakan = `tunggakan pokok ${bulanPokok} bulan`;
    }
  }

  if (tingkat === 0) {
    return hasil('LANCAR', `Lancar — ${uraianTunggakan}, belum melampaui ambang Kurang Lancar.`);
  }

  if (tingkat === 1) {
    return hasil(
      'KURANG_LANCAR',
      `Kurang Lancar — ${uraianTunggakan} (ambang Kurang Lancar SOM untuk masa angsuran ini).`
    );
  }

  // ---- Melewati batas atas Kurang Lancar: Diragukan atau Macet ----
  //
  // Lama "sudah digolongkan Diragukan" DITURUNKAN, tidak disimpan:
  // tunggakan melewati batas atas Kurang Lancar tepat pada saat usia
  // tunggakan = batasAtasBulan, jadi lamanya = usia tunggakan sekarang
  // dikurangi batas atas itu. Kalau ada pembayaran yang melunasi
  // angsuran tertua, usia tunggakan otomatis mengecil (yang dihitung
  // adalah angsuran tertua yang MASIH outstanding) dan hitungan 21
  // bulan ikut mundur — persis bunyi "belum ada pelunasan".
  const usiaTunggakan =
    input.polaPengembalian === 'TANPA_ANGSURAN' && input.sudahJatuhTempo
      ? Math.max(0, Math.floor(input.bulanSejakJatuhTempo))
      : Math.max(
          Math.floor(Math.max(0, input.bulanTunggakanPokok)),
          Math.floor(Math.max(0, input.bulanTunggakanJasa))
        );
  const bulanSejakDiragukan = Math.max(0, usiaTunggakan - batasAtasBulan);

  const angsuranMemenuhi = rasioAngsuranPersen >= RASIO_ANGSURAN_MINIMUM_DIRAGUKAN;
  const agunanMemenuhi = rasioAgunanPersen >= RASIO_AGUNAN_MINIMUM_DIRAGUKAN;

  if (!angsuranMemenuhi && !agunanMemenuhi) {
    return hasil(
      'MACET',
      `Macet — ${uraianTunggakan} (melewati ambang Kurang Lancar); angsuran terbayar baru ${rasioAngsuranPersen.toFixed(
        1
      )}% dari kewajiban (minimal ${RASIO_ANGSURAN_MINIMUM_DIRAGUKAN}%) dan agunan hanya ${rasioAgunanPersen.toFixed(
        1
      )}% dari sisa utang (minimal ${RASIO_AGUNAN_MINIMUM_DIRAGUKAN}%) — tidak memenuhi kriteria Diragukan (SOM 12.1 kriteria Macet angka 1).`,
      bulanSejakDiragukan
    );
  }

  if (bulanSejakDiragukan >= BULAN_DIRAGUKAN_MENJADI_MACET) {
    return hasil(
      'MACET',
      `Macet — sudah ${bulanSejakDiragukan} bulan digolongkan Diragukan tanpa pelunasan, melampaui ${BULAN_DIRAGUKAN_MENJADI_MACET} bulan (SOM 12.1 kriteria Macet angka 2).`,
      bulanSejakDiragukan
    );
  }

  const alasanDiragukan = angsuranMemenuhi
    ? `angsuran terbayar ${rasioAngsuranPersen.toFixed(1)}% dari kewajiban, minimal ${RASIO_ANGSURAN_MINIMUM_DIRAGUKAN}% (SOM 12.1 kriteria Diragukan huruf a)`
    : `agunan bernilai ${rasioAgunanPersen.toFixed(1)}% dari sisa utang, minimal ${RASIO_AGUNAN_MINIMUM_DIRAGUKAN}% (SOM 12.1 kriteria Diragukan huruf b)`;

  return hasil(
    'DIRAGUKAN',
    `Diragukan — ${uraianTunggakan} (melewati ambang Kurang Lancar) namun ${alasanDiragukan}.`,
    bulanSejakDiragukan
  );
}

/**
 * Taksiran piutang tak tertagih (cadangan risiko) BUKU atas satu
 * pinjaman = saldo POKOK outstanding x persentase kategori SOM.
 *
 * Dasarnya saldo POKOK (bukan pokok + bunga): pencadangan adalah
 * estimasi kerugian atas EKSPOSUR yang sudah dikeluarkan koperasi,
 * sementara bunga yang belum tertagih belum pernah menjadi kas —
 * mencadangkannya berarti mencadangkan pendapatan yang belum diakui.
 * Keputusan ini sudah berlaku sebelum peralihan ke SOM dan TIDAK
 * berubah. Contoh angka 15 naskah pun memakai nilai pinjaman per
 * kategori, bukan pinjaman ditambah bunga.
 *
 * Agunan TIDAK dikurangkan di sini: pengurangan agunan adalah aturan
 * FISKAL PMK 74/2024, bukan aturan pencadangan SOM. Lihat
 * `KolektibilitasFiskalService.hitungCadanganFiskal()`.
 */
export function hitungPenyisihanSom(saldoPokok: Rupiah, kategori: KolektibilitasSom): Rupiah {
  return roundToRupiah((Math.max(0, saldoPokok) * PERSENTASE_PENYISIHAN_SOM[kategori]) / 100);
}

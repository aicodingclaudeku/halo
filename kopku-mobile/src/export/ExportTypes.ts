import type { TampilanJuklat } from './JuklatPdf';
/**
 * Tipe data generik untuk export laporan (PRD §36, fase 6). Semua
 * builder laporan (ReportTableBuilders.ts) menghasilkan struktur yang
 * SAMA ini — supaya satu pipeline render (CSV/Excel/PDF) bisa dipakai
 * untuk seluruh 12 jenis laporan, tanpa duplikasi kode per format.
 */

export type FormatExport = 'PDF' | 'EXCEL' | 'CSV';

export interface BarisRingkasan {
  label: string;
  nilai: string;
}

/**
 * RC-S98 — TINGKAT BARIS pada tabel export (OPSIONAL, ADDITIVE).
 *
 * Tanpa penanda ini, renderer hanya bisa menebak hierarki dari bentuk
 * datanya: `HtmlReportBuilder` menebalkan baris yang kolom keduanya
 * kosong (band judul), sehingga SUBTOTAL dan TOTAL — yang punya nominal —
 * tampil PERSIS seperti baris rincian biasa. Pada laporan berlapis
 * seperti LHU akibatnya "Jumlah Beban Usaha", "Sisa Hasil Usaha Bruto",
 * dan satu baris akun tidak bisa dibedakan sama sekali di PDF.
 *
 *   JUDUL    — band kelompok, biasanya tanpa nominal
 *   RINCIAN  — baris akun di bawah sebuah JUDUL (diberi indentasi)
 *   SUBTOTAL — "Jumlah ..." di kaki satu kelompok
 *   TOTAL    — angka antara/akhir laporan (SHU Bruto, SHU Neto, dst)
 *
 * Laporan yang TIDAK mengisi `tingkatBaris` dirender PERSIS seperti
 * sebelumnya (renderer jatuh ke tebakan lama), jadi 30+ builder lain
 * tidak perlu disentuh.
 */
export type TingkatBarisLaporan = 'JUDUL' | 'RINCIAN' | 'SUBTOTAL' | 'TOTAL';

export interface DataLaporanExport {
  /** Judul laporan, mis. "Neraca Saldo", "Daftar Anggota". */
  judulLaporan: string;
  /** Nama file dasar (tanpa ekstensi & tanpa timestamp) — fase 6: "nama file otomatis dengan tanggal/periode". */
  namaFileDasar: string;
  namaKoperasi: string;
  alamatKoperasi?: string;
  standarAkuntansi?: string;
  /** Label periode/tanggal laporan, mis. "Per 31 Desember 2026" atau "1 Jan 2026 - 31 Des 2026". */
  periodeLabel: string;
  kolom: string[];
  baris: (string | number)[][];
  /** Indeks kolom (0-based) yang berisi nominal Rupiah — diformat khusus saat render (fase 6: "format angka Rupiah"). */
  kolomAngka: number[];
  /** Baris ringkasan/total di akhir laporan (opsional), mis. "Total Debit: Rp1.000.000". */
  ringkasan?: BarisRingkasan[];
  /**
   * RC-S83 — DOKUMEN BERSEKSI (OPSIONAL, ADDITIVE).
   *
   * Bila diisi, ketiga renderer (PDF/Excel/CSV) menyusun dokumen dari
   * seksi-seksi ini — tiap seksi berjudul, berupa daftar label/nilai
   * atau tabel dengan baris total — alih-alih satu tabel datar +
   * ringkasan di bawahnya. Dipakai laporan satu-subjek yang isinya
   * multi-bagian (mis. Detail Anggota: identitas, simpanan, simpanan
   * berjangka, pinjaman, histori).
   *
   * `kolom`/`baris`/`ringkasan` TETAP wajib diisi builder supaya
   * konsumen lama & test yang membaca struktur datar tidak berubah.
   * Laporan yang tidak mengisi `seksi` dirender PERSIS seperti sebelumnya.
   */
  seksi?: SeksiLaporan[];
  /** Nomor/kode dokumen yang dicetak di kaki setiap halaman PDF berseksi (opsional). */
  nomorDokumen?: string;
  /**
   * RC-S98 — tingkat tiap baris `baris`, SEJAJAR INDEKS dengannya
   * (`tingkatBaris[i]` menjelaskan `baris[i]`). Boleh lebih pendek atau
   * memuat `undefined`: baris tanpa tingkat diperlakukan seperti
   * sebelumnya. Lihat `TingkatBarisLaporan`.
   */
  tingkatBaris?: (TingkatBarisLaporan | undefined)[];
  /**
   * RC-S104 — CATATAN KAKI LAPORAN (OPSIONAL, ADDITIVE).
   *
   * Paragraf bernomor yang dicetak di bawah ringkasan. Dipakai Laporan
   * Arus Kas untuk menyatakan dasar penempatan pos yang berbeda dari
   * contoh naskah Juklat — keterangan yang HARUS ikut tercetak, bukan
   * hanya tampil di layar, karena berkas export itulah yang dibawa ke
   * RAT dan ke pengawas. Laporan yang tidak mengisinya dirender PERSIS
   * seperti sebelumnya.
   */
  catatanKaki?: string[];
  /**
   * RC-S100 — logo koperasi untuk KOP PDF, sebagai `data:` URI base64.
   *
   * SENGAJA data URI, bukan path berkas: HTML laporan dirender
   * `expo-print` di dalam WebView yang tidak punya akses ke `file://`
   * milik aplikasi, sehingga `<img src="file://...">` akan tampil kosong.
   * Diisi `ExportService` (satu-satunya lapisan yang boleh menyentuh
   * berkas) dari `koperasi.logo_uri`, BUKAN oleh builder — builder tetap
   * murni tanpa I/O. Kosong/undefined berarti kop dicetak tanpa logo.
   */
  logoDataUri?: string;
  /**
   * Poin 13/14/15 — PENANDA LAPORAN KEUANGAN POKOK (OPSIONAL, ADDITIVE).
   *
   * Diisi builder LPK, LPHU, LPE, LAK, CALK (tunggal & komparatif). Bila
   * ada, renderer PDF memakai gaya formal laporan keuangan dan mencetak
   * blok tanda tangan Ketua/Sekretaris/Bendahara.
   *
   * Builder tetap MURNI: ia hanya menulis `tanggalAcuan` (akhir periode
   * laporan). Nama pejabat diisi `ExportService` (lapisan I/O) dari data
   * Pengurus yang menjabat pada tanggal itu. Nama kosong -> garis
   * titik-titik untuk diisi tangan, tidak pernah nama karangan.
   * Excel/CSV tidak terpengaruh.
   */
  laporanKeuangan?: {
    tanggalAcuan: string;
    penandaTangan?: PenandaTanganLaporan[];
    /**
     * Tampilan PDF menurut format Lampiran Juklat SOM 2025 (kop di dalam
     * tabel bergaris, kolom tahun lama → baru, angka tanpa "Rp" dengan
     * kurung untuk pengurang). Bila ada, renderer PDF memakai ini
     * sebagai pengganti `kolom`/`baris`; Excel/CSV tetap memakai
     * `kolom`/`baris` yang lengkap. Disusun `src/export/JuklatPdf.ts`.
     */
    juklat?: TampilanJuklat;
    /**
     * Tampilan PDF yang dipilih pengguna di lembar Export (hanya untuk
     * 5 laporan keuangan pokok: LPK, LPHU, LPE, LAK, CALK):
     *  - 'STANDAR' (bawaan, juga bila kosong) — kop di tengah, tabel
     *    bergaris tipis, ringkasan, angka Rp;
     *  - 'JUKLAT' — contoh laporan menurut Lampiran Juklat SOM 2025 (`juklat`).
     * Keduanya mencetak blok tanda tangan pengurus. Excel/CSV tidak terpengaruh.
     */
    gayaPdf?: GayaPdfLaporanKeuangan;
  };
}

export type GayaPdfLaporanKeuangan = 'STANDAR' | 'JUKLAT';

export interface PenandaTanganLaporan {
  jabatan: string;
  nama: string | null;
}

export interface SeksiKv {
  jenis: 'KV';
  judul: string;
  baris: BarisRingkasan[];
  /** Label yang barisnya ditebalkan (mis. total). */
  labelTebal?: string[];
  catatan?: string;
}

export interface SeksiTabel {
  jenis: 'TABEL';
  judul: string;
  kolom: string[];
  baris: (string | number)[][];
  /** Indeks kolom nominal Rupiah (rata kanan, format Rupiah). */
  kolomAngka: number[];
  /** Baris total di kaki tabel (opsional), panjang sama dengan `kolom`. */
  barisTotal?: (string | number)[];
  /** Teks saat tabel kosong. */
  teksKosong?: string;
  catatan?: string;
}

export type SeksiLaporan = SeksiKv | SeksiTabel;

/**
 * RC-S106 — GAYA BERKAS EXCEL (MODUL MURNI).
 *
 * ============================================================
 * MASALAH YANG DIPERBAIKI
 * ============================================================
 * Seluruh berkas Excel yang dihasilkan aplikasi — template Import Data
 * Awal maupun export laporan — keluar tanpa gaya sama sekali: judul
 * kolom sama persis dengan baris data, nominal rata kiri tanpa pemisah
 * ribuan, tidak ada garis pemisah. Berkas yang dibawa ke RAT dan ke
 * pengawas terlihat seperti tempelan, bukan dokumen koperasi.
 *
 * Sebabnya pustaka: `xlsx` (SheetJS community) MEMBUANG properti gaya
 * sel saat menulis. Diverifikasi langsung dari XML mentah hasil tulis —
 * `styles.xml` hanya berisi font bawaan. Karena itu penulisnya diganti
 * ke `xlsx-js-style`, fork dari SheetJS 0.18.5 yang API bacanya SAMA
 * PERSIS (sehingga pembacaan berkas pengguna tidak berubah sedikit pun)
 * tetapi menulis font, fill, border, perataan, dan format angka.
 *
 * ============================================================
 * YANG TETAP TIDAK BISA
 * ============================================================
 * Diverifikasi juga, supaya tidak dijanjikan:
 *   - BEKU BARIS JUDUL (freeze pane) — tidak ditulis, baik oleh `xlsx`
 *     maupun oleh fork ini.
 *   - DROPDOWN PILIHAN (data validation) — tidak didukung keduanya.
 * Keduanya butuh SheetJS Pro atau pustaka lain; belum sepadan.
 *
 * ============================================================
 * KENAPA MODUL TERSENDIRI
 * ============================================================
 * Murni data (tanpa import pustaka apa pun), sehingga:
 *   - dapat diuji langsung tanpa menulis berkas;
 *   - satu sumber warna & tebal untuk template DAN export laporan,
 *     jadi kedua berkas terlihat sebagai satu keluarga dokumen;
 *   - warnanya sengaja MENGIKUTI warna aplikasi (hijau primer
 *     `colors.primary` #1B5E20), bukan palet baru.
 */

/** Warna dalam format ARGB yang dipakai xlsx-js-style. */
export const WARNA = {
  /** Hijau primer aplikasi — bar judul tabel. */
  primer: 'FF1B5E20',
  /** Hijau muda — baris belang & kop. */
  primerMuda: 'FFE8F3E9',
  putih: 'FFFFFFFF',
  teks: 'FF1F1F1F',
  teksRedup: 'FF6B6B6B',
  garis: 'FFBFBFBF',
  garisHalus: 'FFE0E0E0',
  /** Kuning lembut — baris contoh yang harus dihapus. */
  peringatan: 'FFFFF6D9',
  peringatanTeks: 'FF8A5300',
} as const;

export interface GayaSel {
  font?: { bold?: boolean; italic?: boolean; sz?: number; color?: { rgb: string }; name?: string };
  fill?: { fgColor: { rgb: string }; patternType?: string };
  alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean; indent?: number };
  border?: Record<string, { style: string; color: { rgb: string } }>;
  numFmt?: string;
}

const garis = (warna: string) => ({ style: 'thin', color: { rgb: warna } });

/** Judul dokumen di baris teratas sheet. */
export const GAYA_JUDUL_DOKUMEN: GayaSel = {
  font: { bold: true, sz: 14, color: { rgb: WARNA.primer } },
  alignment: { horizontal: 'left', vertical: 'center' },
};

/** Judul bagian di dalam sheet Petunjuk (mis. "LANGKAH PENGISIAN"). */
export const GAYA_JUDUL_BAGIAN: GayaSel = {
  font: { bold: true, sz: 11, color: { rgb: WARNA.primer } },
  alignment: { horizontal: 'left', vertical: 'center' },
};

/** Anak judul / keterangan di bawah judul dokumen. */
export const GAYA_SUBJUDUL: GayaSel = {
  font: { sz: 10, color: { rgb: WARNA.teksRedup } },
  alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
};

/** Bar judul kolom tabel — hijau, teks putih tebal. */
export const GAYA_JUDUL_KOLOM: GayaSel = {
  font: { bold: true, sz: 10, color: { rgb: WARNA.putih } },
  fill: { fgColor: { rgb: WARNA.primer }, patternType: 'solid' },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  border: { top: garis(WARNA.primer), bottom: garis(WARNA.primer), left: garis(WARNA.putih), right: garis(WARNA.putih) },
};

/** Sel data biasa. */
export function gayaSel(opsi: { angka?: boolean; belang?: boolean; numFmt?: string } = {}): GayaSel {
  const g: GayaSel = {
    font: { sz: 10, color: { rgb: WARNA.teks } },
    alignment: { horizontal: opsi.angka ? 'right' : 'left', vertical: 'center' },
    border: { bottom: garis(WARNA.garisHalus), left: garis(WARNA.garisHalus), right: garis(WARNA.garisHalus) },
  };
  if (opsi.belang) g.fill = { fgColor: { rgb: WARNA.primerMuda }, patternType: 'solid' };
  if (opsi.numFmt) g.numFmt = opsi.numFmt;
  return g;
}

/** Baris contoh yang harus dihapus pengguna — kuning lembut, miring. */
export function gayaBarisContoh(angka = false): GayaSel {
  return {
    font: { italic: true, sz: 10, color: { rgb: WARNA.peringatanTeks } },
    fill: { fgColor: { rgb: WARNA.peringatan }, patternType: 'solid' },
    alignment: { horizontal: angka ? 'right' : 'left', vertical: 'center' },
    border: { bottom: garis(WARNA.garis), left: garis(WARNA.garisHalus), right: garis(WARNA.garisHalus) },
  };
}

/** Baris subtotal/total pada laporan. */
export function gayaTotal(angka = false): GayaSel {
  return {
    font: { bold: true, sz: 10, color: { rgb: WARNA.teks } },
    fill: { fgColor: { rgb: WARNA.primerMuda }, patternType: 'solid' },
    alignment: { horizontal: angka ? 'right' : 'left', vertical: 'center' },
    border: { top: garis(WARNA.primer), bottom: garis(WARNA.primer) },
  };
}

/**
 * Format angka Excel untuk nominal rupiah. Memakai pemisah ribuan dan
 * menampilkan nilai negatif dalam kurung, sesuai lazimnya laporan
 * keuangan — bukan tanda minus di depan.
 */
export const FORMAT_RUPIAH = '#,##0;(#,##0)';
export const FORMAT_PERSEN = '0.00';
export const FORMAT_TANGGAL = 'yyyy-mm-dd';

/**
 * Tebak format angka dari nama kolom. Dipakai template & export supaya
 * kolom nominal tidak perlu didaftarkan dua kali.
 *
 * Disengaja berbasis KATA, bukan daftar nama kolom yang harus
 * dipelihara: kolom baru bernama "Saldo ..." otomatis ikut terformat.
 */
export function formatUntukKolom(judulKolom: string): string | undefined {
  const j = judulKolom.toLowerCase();
  // KOLOM TEKS DIPERIKSA LEBIH DULU. Tanpa ini "Metode Jasa" dan
  // "Satuan Tenor" ikut tertangkap kata "jasa"/"tenor" dan diberi format
  // ribuan — sel teks berformat angka memang tidak merusak nilainya,
  // tetapi membuat kolom pilihan tampil rata kanan seperti nominal.
  // Ditemukan oleh test, bukan oleh mata.
  if (/kode|nama|alamat|metode|satuan|sumber|jenis|status|keterangan|pekerjaan|kelamin|tempat|no hp|nik|nomor/.test(j)) {
    return undefined;
  }
  if (/tanggal|tgl/.test(j)) return FORMAT_TANGGAL;
  if (/persen|%|suku bunga/.test(j)) return FORMAT_PERSEN;
  if (/jumlah|nominal|saldo|pokok|jasa|simpanan|tunggakan|piutang|nilai|biaya|setoran/.test(j)) return FORMAT_RUPIAH;
  return undefined;
}

/** Apakah kolom ini berisi angka yang harus rata kanan. */
export function kolomAngka(judulKolom: string): boolean {
  const f = formatUntukKolom(judulKolom);
  return f === FORMAT_RUPIAH || f === FORMAT_PERSEN;
}

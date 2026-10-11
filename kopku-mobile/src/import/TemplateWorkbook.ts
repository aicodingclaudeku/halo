import * as XLSX from 'xlsx-js-style';
import {
  BARIS_PETUNJUK,
  BARIS_PETUNJUK_TRANSAKSI_BARU,
  LEBAR_KOLOM_PETUNJUK,
  NAMA_SHEET_PETUNJUK,
  NAMA_SHEET_DAFTAR_AKUN,
  NAMA_SHEET_PANDUAN_KOLOM,
  SHEET_SALDO_AWAL_AKUN,
  barisPanduanKolom,
  catatanJudulKolom,
  legendaSheetData,
  SHEET_TEMPLATE_TRANSAKSI_BARU,
  barisDaftarAkun,
  judulKolomExcel,
  sheetTemplateUrutTampilan,
  type JenisTemplateDataAwal,
  type KolomTemplate,
} from '@/import/TemplateDataAwal';
import {
  GAYA_JUDUL_DOKUMEN,
  GAYA_JUDUL_BAGIAN,
  GAYA_JUDUL_KOLOM,
  GAYA_SUBJUDUL,
  WARNA,
  gayaBarisContoh,
  gayaSel,
  formatUntukKolom,
  kolomAngka,
  FORMAT_TANGGAL,
} from '@/export/GayaExcel';

/**
 * RC-S106 — PENYUSUN WORKBOOK TEMPLATE, DIPISAH DARI SERVICE.
 *
 * Sebelumnya fungsi ini tinggal di `ImportDataAwalService`, yang
 * mengimpor `expo-file-system`/`expo-document-picker`/`expo-sharing` —
 * modul native yang tidak dapat dimuat ts-jest. Akibatnya SELURUH hasil
 * penyusunan template, termasuk gayanya, mustahil diuji: satu-satunya
 * cara memeriksanya adalah membuka berkasnya dengan mata.
 *
 * Berkas ini hanya menyentuh `xlsx-js-style` (JavaScript murni) dan dua
 * modul data, sehingga test dapat membangun workbook dan memeriksa
 * warna, ketebalan, format angka, serta autofilternya secara langsung.
 * Pola yang SAMA dengan pemisahan `EksekusiImportDataAwal` vs
 * `ImportDataAwalService` yang sudah ada.
 */
/**
 * RC-S133.4.6 — DUA TEMPLATE.
 *   SALDO_LAMA (bawaan, tanpa argumen = perilaku & isi lama + sheet 7 &
 *   "Daftar Akun") untuk koperasi yang sudah berjalan;
 *   TRANSAKSI_BARU hanya sheet 1–4 dengan kolom inti, untuk koperasi baru /
 *   transaksi yang uangnya bergerak lewat kas.
 */
export function bangunWorkbookTemplate(jenis: JenisTemplateDataAwal = 'SALDO_LAMA'): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const petunjuk = jenis === 'TRANSAKSI_BARU' ? BARIS_PETUNJUK_TRANSAKSI_BARU : BARIS_PETUNJUK;

  // ---- Sheet Petunjuk ----
  const wsPetunjuk = XLSX.utils.aoa_to_sheet(petunjuk);
  wsPetunjuk['!cols'] = LEBAR_KOLOM_PETUNJUK.map((wch) => ({ wch }));
  // RC-S106 — judul dokumen dibedakan, dan setiap BARIS JUDUL BAGIAN
  // (baris ber-satu-sel yang seluruhnya huruf besar) ditebalkan. Dikenali
  // dari bentuk barisnya, bukan dari daftar nomor baris yang harus
  // ikut berubah setiap kali petunjuknya disunting.
  //
  // RC-S133.4.7 — TATA LETAK PETUNJUK DIPERBAIKI. Baris satu-sel dulu
  // berada di kolom A selebar 4 karakter DENGAN wrapText, sehingga di
  // Excel kalimatnya terlipat per 3–4 huruf menjadi baris yang sangat
  // tinggi. Sekarang baris satu-sel digabung A:B (lebar penuh), judul
  // bagian diberi latar, dan baris berpoin menulis teksnya di kolom B.
  const merges: XLSX.Range[] = [];
  const tinggi: XLSX.RowInfo[] = [];
  const lebarTeks = LEBAR_KOLOM_PETUNJUK.reduce((t, w) => t + w, 0);
  petunjuk.forEach((baris, r) => {
    const alamat = XLSX.utils.encode_cell({ r, c: 0 });
    const sel = wsPetunjuk[alamat];
    const selB = wsPetunjuk[XLSX.utils.encode_cell({ r, c: 1 })];
    if (selB && typeof selB.v === 'string' && selB.v.trim() !== '') {
      selB.s = GAYA_TEKS_PETUNJUK;
      tinggi[r] = { hpt: tinggiBaris(selB.v, LEBAR_KOLOM_PETUNJUK[1]) };
    }
    if (!sel || typeof sel.v !== 'string' || sel.v.trim() === '') return;
    if (r === 0) {
      sel.s = GAYA_JUDUL_DOKUMEN;
      tinggi[r] = { hpt: 24 };
    } else if (baris.length === 1 && sel.v === sel.v.toUpperCase()) {
      sel.s = GAYA_BAGIAN_PETUNJUK;
      merges.push({ s: { r, c: 0 }, e: { r, c: 1 } });
      tinggi[r] = { hpt: 20 };
    } else if (baris.length === 1) {
      sel.s = GAYA_TEKS_PETUNJUK;
      merges.push({ s: { r, c: 0 }, e: { r, c: 1 } });
      tinggi[r] = { hpt: tinggiBaris(sel.v, lebarTeks) };
    } else {
      // Kolom A berisi nomor/poin.
      sel.s = sel.v.trim() === '×' ? GAYA_POIN_SALAH : GAYA_POIN_PETUNJUK;
    }
  });
  merges.push({ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(1, LEBAR_KOLOM_PETUNJUK.length - 1) } });
  wsPetunjuk['!merges'] = merges;
  wsPetunjuk['!rows'] = tinggi;
  XLSX.utils.book_append_sheet(wb, wsPetunjuk, NAMA_SHEET_PETUNJUK);

  // ---- RC-S133.4.7: sheet "Panduan Kolom" (setiap kolom: wajib?, cara isi, contoh) ----
  // Hanya pada Template Saldo Lama: susunan sheet Template Transaksi Baru
  // dikunci test RC-S133.4.6 — panduan kolomnya ada di sheet Petunjuk.
  const daftar = jenis === 'TRANSAKSI_BARU' ? SHEET_TEMPLATE_TRANSAKSI_BARU : sheetTemplateUrutTampilan();
  if (jenis === 'SALDO_LAMA') tambahSheetPanduanKolom(wb, [...daftar, SHEET_SALDO_AWAL_AKUN]);

  // ---- Sheet data ----
  for (const sheet of daftar) tambahSheetData(wb, sheet, jenis);
  if (jenis === 'SALDO_LAMA') {
    tambahSheetData(wb, SHEET_SALDO_AWAL_AKUN, jenis);
    const wsAkun = XLSX.utils.aoa_to_sheet(barisDaftarAkun());
    wsAkun['!cols'] = [{ wch: 12 }, { wch: 52 }, { wch: 13 }, { wch: 13 }, { wch: 40 }];
    const j = wsAkun[XLSX.utils.encode_cell({ r: 0, c: 0 })];
    if (j) j.s = GAYA_SUBJUDUL;
    for (let c = 0; c < 5; c++) {
      const sel = wsAkun[XLSX.utils.encode_cell({ r: 2, c })];
      if (sel) sel.s = GAYA_JUDUL_KOLOM;
    }
    XLSX.utils.book_append_sheet(wb, wsAkun, NAMA_SHEET_DAFTAR_AKUN);
  }
  return wb;
}

/** RC-S133.4.7 — gaya sheet Petunjuk. */
const GAYA_BAGIAN_PETUNJUK = {
  font: { bold: true, sz: 11, color: { rgb: WARNA.primer } },
  fill: { fgColor: { rgb: WARNA.primerMuda }, patternType: 'solid' },
  alignment: { horizontal: 'left', vertical: 'center', indent: 1 },
  border: { bottom: { style: 'thin', color: { rgb: WARNA.primer } } },
};
const GAYA_TEKS_PETUNJUK = {
  font: { sz: 10, color: { rgb: WARNA.teks } },
  alignment: { horizontal: 'left', vertical: 'top', wrapText: true },
};
const GAYA_POIN_PETUNJUK = {
  font: { bold: true, sz: 10, color: { rgb: WARNA.primer } },
  alignment: { horizontal: 'right', vertical: 'top' },
};
const GAYA_POIN_SALAH = {
  font: { bold: true, sz: 10, color: { rgb: 'FFC62828' } },
  alignment: { horizontal: 'right', vertical: 'top' },
};

/** Perkiraan tinggi baris (pt) untuk teks terbungkus pada lebar kolom `lebar` karakter. */
export function tinggiBaris(teks: string, lebar: number): number {
  // Huruf proporsional: rata-rata ±1,2 huruf per satuan lebar kolom.
  const baris = Math.max(1, Math.ceil(teks.length / (Math.max(8, lebar) * 1.2)));
  return Math.max(15, baris * 13 + 2);
}

function tambahSheetPanduanKolom(wb: XLSX.WorkBook, sheets: { nama: string; keterangan: string; kolom: KolomTemplate[] }[]): void {
  const aoaPanduan = barisPanduanKolom(sheets);
  const wsPanduan = XLSX.utils.aoa_to_sheet(aoaPanduan);
  wsPanduan['!cols'] = [{ wch: 22 }, { wch: 24 }, { wch: 9 }, { wch: 78 }, { wch: 18 }];
  wsPanduan['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } }];
  aoaPanduan.forEach((baris, r) => {
    for (let c = 0; c < 5; c++) {
      const sel = wsPanduan[XLSX.utils.encode_cell({ r, c })];
      if (!sel) continue;
      if (r === 0) sel.s = GAYA_JUDUL_DOKUMEN;
      else if (r === 1) sel.s = GAYA_SUBJUDUL;
      else if (r === 3) sel.s = GAYA_JUDUL_KOLOM;
      else if (r > 3) {
        const g = gayaSel({ belang: baris[0] !== '' && r % 2 === 0 });
        g.alignment = { horizontal: c === 2 ? 'center' : 'left', vertical: 'top', wrapText: true };
        if (c === 0 && baris[0] !== '') g.font = { bold: true, sz: 10, color: { rgb: 'FF1B5E20' } };
        if (c === 2 && baris[2] === 'WAJIB') g.font = { bold: true, sz: 10, color: { rgb: 'FFC62828' } };
        sel.s = g;
      }
    }
  });
  XLSX.utils.book_append_sheet(wb, wsPanduan, NAMA_SHEET_PANDUAN_KOLOM);
}

/** Banyaknya baris isian kosong yang diberi garis & format di bawah baris contoh. */
export const BARIS_ISIAN_SIAP = 200;

/**
 * Format sel isian per kolom.
 *  - Kode/NIK/No HP/nomor/rekening: TEKS ('@') — tanpa ini NIK 16 digit dibulatkan
 *    Excel menjadi 15 digit angka penting (digit terakhir jadi 0) dan
 *    "001" berubah menjadi 1.
 *  - Tanggal: tampil yyyy-mm-dd, sehingga tanggal yang tertukar hari/bulan
 *    oleh setelan Excel (01/02 dibaca 2 Januari) langsung terlihat.
 *  - Nominal: pemisah ribuan.
 * Nilai yang diketik pengguna TIDAK berubah; parser membaca isi sel.
 */
export function formatIsianKolom(label: string): string | undefined {
  const j = label.toLowerCase();
  if (/^kode|nik|no hp|nomor|rekening/.test(j)) return '@';
  const f = formatUntukKolom(label);
  if (f === FORMAT_TANGGAL) return FORMAT_TANGGAL;
  return f;
}

function tambahSheetData(
  wb: XLSX.WorkBook,
  sheet: { nama: string; keterangan: string; kolom: KolomTemplate[] },
  jenis: JenisTemplateDataAwal
): void {
  {
    const judulKolom = sheet.kolom.map(judulKolomExcel);
    const aoa: (string | number)[][] = [
      [sheet.keterangan],
      // RC-S133.4.7 — baris legenda (dulu kosong). Satu sel teks; tidak
      // pernah memuat seluruh nama kolom wajib sehingga tidak mungkin
      // terbaca sebagai baris judul oleh `cariBarisHeader`.
      [legendaSheetData(jenis)],
      judulKolom,
      sheet.kolom.map((k) => k.contoh),
      // RC-S133.4.7 — area isian bergaris. Sel berisi teks kosong ('')
      // dibaca parser sebagai sel kosong, sehingga barisnya dilewati.
      ...Array.from({ length: BARIS_ISIAN_SIAP }, () => sheet.kolom.map(() => '')),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = sheet.kolom.map((k) => ({ wch: k.lebar }));

    // RC-S106 — GAYA. Tiga baris pertama punya peran berbeda dan
    // sekarang terlihat berbeda: keterangan sheet, bar judul kolom
    // hijau, lalu baris contoh berlatar kuning supaya jelas harus
    // dihapus (sebelumnya baris contoh tampil persis seperti data
    // sungguhan, dan itu memang pernah membingungkan).
    const selKeterangan = ws[XLSX.utils.encode_cell({ r: 0, c: 0 })];
    if (selKeterangan) selKeterangan.s = GAYA_SUBJUDUL;
    const selLegenda = ws[XLSX.utils.encode_cell({ r: 1, c: 0 })];
    if (selLegenda) selLegenda.s = { font: { italic: true, sz: 9, color: { rgb: 'FF8A5300' } }, alignment: { horizontal: 'left', vertical: 'center', wrapText: true } };
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(1, judulKolom.length - 1) } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: Math.max(1, judulKolom.length - 1) } },
    ];
    const lebarTotal = sheet.kolom.reduce((t, k) => t + k.lebar, 0);
    ws['!rows'] = [
      { hpt: tinggiBaris(sheet.keterangan, lebarTotal) },
      { hpt: tinggiBaris(legendaSheetData(jenis), lebarTotal * 1.1) },
      { hpt: 32 },
    ];

    judulKolom.forEach((judul, c) => {
      const sel = ws[XLSX.utils.encode_cell({ r: 2, c })];
      if (sel) {
        sel.s = GAYA_JUDUL_KOLOM;
        // RC-S133.4.7 — catatan (comment) di judul kolom: arahkan kursor
        // ke judul untuk membaca cara mengisinya tanpa pindah sheet.
        const catatan = catatanJudulKolom(sheet.kolom[c]);
        if (catatan) {
          const komentar: any = [{ a: 'KOPKU', t: catatan }];
          komentar.hidden = true;
          (sel as any).c = komentar;
        }
      }
      const selContoh = ws[XLSX.utils.encode_cell({ r: 3, c })];
      if (selContoh) {
        selContoh.s = gayaBarisContoh(kolomAngka(judul));
        const fmt = formatUntukKolom(judul);
        if (fmt && typeof selContoh.v === 'number') selContoh.z = fmt;
      }
      const fmtIsian = formatIsianKolom(sheet.kolom[c].label);
      for (let r = 4; r < 4 + BARIS_ISIAN_SIAP; r++) {
        const sl = ws[XLSX.utils.encode_cell({ r, c })];
        if (!sl) continue;
        sl.s = gayaSel({ angka: kolomAngka(judul), belang: r % 2 === 1, numFmt: fmtIsian });
      }
    });

    // Autofilter di baris judul — satu-satunya bantuan navigasi yang
    // benar-benar ditulis pustaka ini (beku baris judul TIDAK didukung,
    // lihat GayaExcel.ts).
    ws['!autofilter'] = {
      ref: `${XLSX.utils.encode_cell({ r: 2, c: 0 })}:${XLSX.utils.encode_cell({ r: 2, c: judulKolom.length - 1 })}`,
    };

    XLSX.utils.book_append_sheet(wb, ws, sheet.nama);
  }
}

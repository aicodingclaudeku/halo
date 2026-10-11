import { TEKS_IDENTITAS_CETAK } from './IdentitasCetak';
import type { DataLaporanExport, TingkatBarisLaporan } from './ExportTypes';
import { FORMAT_RUPIAH, WARNA, type GayaSel } from './GayaExcel';
import type { SheetSeksi } from './ExcelSeksiBuilder';

/**
 * TATA LETAK EXCEL LAPORAN (MODUL MURNI — tanpa pustaka, tanpa I/O).
 * ============================================================
 * Menyusun isi + gaya setiap sel export Excel laporan supaya rapi dan
 * profesional, memakai palet `GayaExcel` yang sama dengan template
 * Import Data Awal (hijau primer aplikasi). `ExportService` hanya
 * menerjemahkan hasil ini ke worksheet `xlsx-js-style`.
 *
 *   - Kop: nama koperasi (besar, hijau), alamat, judul laporan, periode,
 *     dan keterangan "Nilai dalam Rupiah" — masing-masing digabung
 *     selebar tabel, dengan garis hijau pemisah kop.
 *   - Bar judul kolom hijau, teks putih tebal, rata tengah.
 *   - Nominal ditulis sebagai ANGKA (bisa dijumlah/diolah), format
 *     ribuan dengan kurung untuk negatif, rata kanan.
 *   - Hierarki laporan keuangan: band kelompok berlatar hijau muda,
 *     rincian menjorok, subtotal tebal bergaris atas, total tebal
 *     bergaris ganda. Laporan daftar biasa: baris belang lembut dan
 *     filter otomatis di bar judul kolom.
 *   - Ringkasan & catatan penyajian dalam blok tersendiri; jejak cetak
 *     di baris terakhir.
 *
 * Isi/angka TIDAK berubah dari `DataLaporanExport`; yang berubah hanya
 * bentuknya (dan nominal kini angka sungguhan, bukan teks "Rp…").
 */

export interface SelExcel {
  v: string | number;
  s?: GayaSel;
  z?: string;
}

export interface GabungSel {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

export interface SheetExcelLaporan {
  namaSheet: string;
  /** Baris × kolom; `null` = sel tanpa isi & tanpa gaya. */
  sel: (SelExcel | null)[][];
  merges: GabungSel[];
  lebarKolom: number[];
  tinggiBaris: ({ hpt: number } | null)[];
  autofilter?: string;
}

const garis = (warna: string, style = 'thin') => ({ style, color: { rgb: warna } });
const FONT = 'Calibri';

const G = {
  namaKoperasi: { font: { name: FONT, bold: true, sz: 15, color: { rgb: WARNA.primer } }, alignment: { horizontal: 'left', vertical: 'center' } },
  alamat: { font: { name: FONT, sz: 9, color: { rgb: WARNA.teksRedup } }, alignment: { horizontal: 'left', vertical: 'center' } },
  judul: { font: { name: FONT, bold: true, sz: 13, color: { rgb: WARNA.teks } }, alignment: { horizontal: 'left', vertical: 'center' } },
  periode: { font: { name: FONT, sz: 10, color: { rgb: WARNA.teksRedup } }, alignment: { horizontal: 'left', vertical: 'center' } },
  satuan: { font: { name: FONT, italic: true, sz: 9, color: { rgb: WARNA.teksRedup } }, alignment: { horizontal: 'left', vertical: 'center' } },
  garisKop: { border: { bottom: garis(WARNA.primer, 'medium') } },
} satisfies Record<string, GayaSel>;

function gayaKepalaKolom(angka: boolean, pertama: boolean, terakhir: boolean): GayaSel {
  return {
    font: { name: FONT, bold: true, sz: 10, color: { rgb: WARNA.putih } },
    fill: { fgColor: { rgb: WARNA.primer }, patternType: 'solid' },
    // Judul kolom rata mengikuti isinya: teks kiri, nominal kanan.
    alignment: { horizontal: angka ? 'right' : 'left', vertical: 'center', wrapText: true, indent: pertama ? 1 : 0 },
    border: {
      top: garis(WARNA.primer),
      bottom: garis(WARNA.primer),
      left: garis(pertama ? WARNA.primer : WARNA.putih),
      right: garis(terakhir ? WARNA.primer : WARNA.putih),
    },
  };
}

type Peran = TingkatBarisLaporan | 'BIASA';

function gayaData(peran: Peran, angka: boolean, kolomPertama: boolean, belang: boolean, teksDiKolomAngka: boolean): GayaSel {
  const tepi = { left: garis(WARNA.garisHalus), right: garis(WARNA.garisHalus) };
  const rata = angka ? 'right' : 'left';
  switch (peran) {
    case 'JUDUL':
      return {
        font: { name: FONT, bold: true, sz: 10, color: { rgb: WARNA.primer } },
        fill: { fgColor: { rgb: WARNA.primerMuda }, patternType: 'solid' },
        alignment: { horizontal: rata, vertical: 'center', indent: kolomPertama ? 1 : 0 },
        border: { ...tepi, top: garis(WARNA.garisHalus), bottom: garis(WARNA.garisHalus) },
      };
    case 'SUBTOTAL':
      return {
        font: { name: FONT, bold: true, sz: 10, color: { rgb: WARNA.teks } },
        alignment: { horizontal: rata, vertical: 'center', indent: kolomPertama ? 1 : 0 },
        border: { ...tepi, top: garis(WARNA.garis), bottom: garis(WARNA.garisHalus) },
        ...(angka ? { numFmt: FORMAT_RUPIAH } : {}),
      };
    case 'TOTAL':
      return {
        font: { name: FONT, bold: true, sz: 10.5, color: { rgb: WARNA.teks } },
        fill: { fgColor: { rgb: WARNA.primerMuda }, patternType: 'solid' },
        alignment: { horizontal: rata, vertical: 'center', indent: kolomPertama ? 1 : 0 },
        border: { ...tepi, top: garis(WARNA.primer), bottom: garis(WARNA.primer, 'double') },
        ...(angka ? { numFmt: FORMAT_RUPIAH } : {}),
      };
    case 'RINCIAN':
    case 'BIASA':
    default: {
      const g: GayaSel = {
        font: {
          name: FONT,
          sz: 10,
          italic: teksDiKolomAngka || undefined,
          color: { rgb: teksDiKolomAngka ? WARNA.teksRedup : WARNA.teks },
        },
        alignment: {
          horizontal: rata,
          vertical: 'center',
          indent: kolomPertama ? (peran === 'RINCIAN' ? 2 : 1) : 0,
          wrapText: !angka,
        },
        border: { ...tepi, bottom: garis(WARNA.garisHalus) },
      };
      if (belang) g.fill = { fgColor: { rgb: 'FFF6FAF6' }, patternType: 'solid' };
      if (angka && !teksDiKolomAngka) g.numFmt = FORMAT_RUPIAH;
      return g;
    }
  }
}

/** Alamat sel A1 dari indeks 0-based (tanpa bergantung pada pustaka). */
export function alamatSel(r: number, c: number): string {
  let kolom = '';
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    kolom = String.fromCharCode(65 + m) + kolom;
    n = Math.floor((n - 1) / 26);
  }
  return `${kolom}${r + 1}`;
}

/** Nama sheet Excel: tanpa karakter terlarang, maksimal 31 karakter. */
export function namaSheetAman(judul: string): string {
  const bersih = judul.replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim();
  return (bersih || 'Laporan').slice(0, 31);
}

function panjangTampil(v: string | number | undefined, angka: boolean): number {
  if (v === undefined || v === '') return 0;
  if (typeof v === 'number') return String(Math.round(Math.abs(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ',').length + (v < 0 ? 2 : 0) + 2;
  // Teks panjang di kolom teks dibungkus — lebar dibatasi oleh batas atas.
  return angka ? v.length + 2 : v.length + 2;
}

export function bangunSheetLaporan(data: DataLaporanExport, tanggalCetak?: string): SheetExcelLaporan {
  const nKolom = Math.max(data.kolom.length, 1);
  const sel: (SelExcel | null)[][] = [];
  const merges: GabungSel[] = [];
  const tinggi: ({ hpt: number } | null)[] = [];
  const barisPenuh = (sel0: SelExcel, hpt?: number, gayaSisa?: GayaSel) => {
    const r = sel.length;
    const row: (SelExcel | null)[] = [sel0];
    for (let c = 1; c < nKolom; c++) row.push(gayaSisa ? { v: '', s: gayaSisa } : null);
    sel.push(row);
    if (nKolom > 1) merges.push({ s: { r, c: 0 }, e: { r, c: nKolom - 1 } });
    tinggi[r] = hpt ? { hpt } : null;
  };
  const kosong = (hpt = 8) => {
    sel.push([]);
    tinggi[sel.length - 1] = { hpt };
  };

  // ---- KOP
  barisPenuh({ v: data.namaKoperasi, s: G.namaKoperasi }, 24);
  if (data.alamatKoperasi) barisPenuh({ v: data.alamatKoperasi, s: G.alamat }, 14);
  barisPenuh({ v: data.judulLaporan, s: G.judul }, 20);
  barisPenuh({ v: data.periodeLabel, s: G.periode }, 15);
  if (data.kolomAngka.length > 0) barisPenuh({ v: 'Nilai dalam Rupiah', s: G.satuan }, 13);
  // Garis hijau pemisah kop.
  {
    const r = sel.length;
    sel.push(Array.from({ length: nKolom }, () => ({ v: '', s: G.garisKop })));
    tinggi[r] = { hpt: 6 };
  }
  kosong(8);

  // ---- JUDUL KOLOM
  const barisKepala = sel.length;
  sel.push(
    data.kolom.map((k, c) => ({ v: k, s: gayaKepalaKolom(data.kolomAngka.includes(c), c === 0, c === data.kolom.length - 1) }))
  );
  tinggi[barisKepala] = { hpt: 22 };

  // ---- DATA
  const adaHierarki = !!data.tingkatBaris && data.tingkatBaris.some(Boolean);
  let indeksBelang = 0;
  if (data.baris.length === 0) {
    barisPenuh({ v: 'Tidak ada data', s: { font: { name: FONT, italic: true, sz: 10, color: { rgb: WARNA.teksRedup } }, alignment: { horizontal: 'center', vertical: 'center' } } }, 20);
  }
  data.baris.forEach((row, i) => {
    const tingkat = data.tingkatBaris?.[i];
    // Tebakan lama untuk laporan tanpa tingkat: kolom kedua kosong = band judul.
    const tebakJudul = !adaHierarki && row.length > 1 && row[1] === '' && typeof row[0] === 'string' && row.slice(1).every((v) => v === '');
    const peran: Peran = tingkat ?? (tebakJudul ? 'JUDUL' : 'BIASA');
    const belang = peran === 'BIASA' && indeksBelang++ % 2 === 1;
    if (peran === 'JUDUL') indeksBelang = 0;
    const r = sel.length;
    const isi: (SelExcel | null)[] = [];
    for (let c = 0; c < nKolom; c++) {
      const v = row[c] ?? '';
      const angka = data.kolomAngka.includes(c);
      const teksDiKolomAngka = angka && typeof v === 'string' && v !== '';
      const s = gayaData(peran, angka, c === 0, belang, teksDiKolomAngka);
      isi.push(angka && typeof v === 'number' ? { v, s, z: FORMAT_RUPIAH } : { v, s });
    }
    sel.push(isi);
    tinggi[r] = { hpt: peran === 'TOTAL' || peran === 'JUDUL' ? 18 : 16 };
  });
  const barisAkhirData = sel.length - 1;

  // ---- RINGKASAN
  if (data.ringkasan?.length) {
    kosong(10);
    barisPenuh(
      { v: 'RINGKASAN', s: { font: { name: FONT, bold: true, sz: 10, color: { rgb: WARNA.primer } }, border: { bottom: garis(WARNA.primer) } } },
      18,
      { border: { bottom: garis(WARNA.primer) } }
    );
    for (const rk of data.ringkasan) {
      const r = sel.length;
      const row: (SelExcel | null)[] = [
        { v: rk.label, s: { font: { name: FONT, sz: 10, color: { rgb: WARNA.teksRedup } }, alignment: { vertical: 'center', indent: 1, wrapText: true }, border: { bottom: garis(WARNA.garisHalus) } } },
      ];
      const nilai: SelExcel = {
        v: rk.nilai,
        s: { font: { name: FONT, bold: true, sz: 10, color: { rgb: WARNA.teks } }, alignment: { horizontal: 'right', vertical: 'center', wrapText: true }, border: { bottom: garis(WARNA.garisHalus) } },
      };
      if (nKolom > 1) {
        for (let c = 1; c < nKolom - 1; c++) row.push({ v: '', s: { border: { bottom: garis(WARNA.garisHalus) } } });
        row.push(nilai);
        if (nKolom > 2) merges.push({ s: { r, c: 0 }, e: { r, c: nKolom - 2 } });
      } else {
        row[0] = { v: `${rk.label}: ${rk.nilai}`, s: row[0]!.s };
      }
      sel.push(row);
      tinggi[r] = { hpt: 16 };
    }
  }

  // ---- CATATAN PENYAJIAN
  if (data.catatanKaki?.length) {
    kosong(10);
    barisPenuh({ v: 'Catatan Penyajian', s: { font: { name: FONT, bold: true, sz: 10, color: { rgb: WARNA.primer } } } }, 16);
    data.catatanKaki.forEach((c, i) => {
      const teks = `${i + 1}. ${c}`;
      // Perkiraan tinggi baris dari panjang teks (sel digabung selebar tabel).
      const lebarTotal = Math.max(40, data.kolom.length * 18);
      const baris = Math.max(1, Math.ceil(teks.length / lebarTotal));
      barisPenuh(
        { v: teks, s: { font: { name: FONT, italic: true, sz: 9, color: { rgb: WARNA.teksRedup } }, alignment: { vertical: 'top', wrapText: true } } },
        Math.min(14 * baris, 120)
      );
    });
  }

  // ---- JEJAK CETAK
  if (tanggalCetak) {
    kosong(8);
    barisPenuh({ v: `Dicetak pada ${tanggalCetak}`, s: { font: { name: FONT, italic: true, sz: 8, color: { rgb: WARNA.teksRedup } } } }, 12);
    barisPenuh({ v: TEKS_IDENTITAS_CETAK, s: { font: { name: FONT, bold: true, sz: 8, color: { rgb: WARNA.teksRedup } } } }, 12);
  }

  // ---- LEBAR KOLOM (dari isi tabel saja; kop & catatan digabung sehingga tidak ikut)
  const lebar: number[] = [];
  for (let c = 0; c < nKolom; c++) {
    const angka = data.kolomAngka.includes(c);
    let maks = panjangTampil(data.kolom[c], false) + 2;
    for (const row of data.baris) maks = Math.max(maks, panjangTampil(row[c], angka) + (c === 0 ? 4 : 0));
    lebar[c] = c === 0 ? Math.min(Math.max(maks, 28), 60) : angka ? Math.min(Math.max(maks, 16), 24) : Math.min(Math.max(maks, 12), 40);
  }

  // Filter otomatis hanya untuk laporan daftar (tanpa hierarki laporan keuangan).
  const autofilter =
    !adaHierarki && !data.laporanKeuangan && data.baris.length > 0 && data.kolom.length > 1
      ? `${alamatSel(barisKepala, 0)}:${alamatSel(barisAkhirData, data.kolom.length - 1)}`
      : undefined;

  return { namaSheet: namaSheetAman(data.judulLaporan), sel, merges, lebarKolom: lebar, tinggiBaris: tinggi, autofilter };
}

// ------------------------------------------------------------------
// Dokumen berseksi (mis. Detail Anggota) — gaya yang sama
// ------------------------------------------------------------------


/**
 * Beri gaya pada sheet dokumen berseksi hasil `buildSheetSeksi` tanpa
 * mengubah isi maupun posisi barisnya (indeks `selRupiah` tetap berlaku).
 */
export function gayaiSheetSeksi(sheet: SheetSeksi, judul: string, tanggalCetak?: string): SheetExcelLaporan {
  const nKolom = Math.max(2, ...sheet.aoa.map((r) => r.length));
  const rupiah = new Set(sheet.selRupiah.map(([r, c]) => `${r}:${c}`));
  const sel: (SelExcel | null)[][] = [];
  const merges: GabungSel[] = [];
  const tinggi: ({ hpt: number } | null)[] = [];
  const indeksMetaTerakhir = sheet.peran.findIndex((p) => p === 'KOSONG') - 1;
  let belang = 0;
  // RC-S133.6.3 — teks panjang (dasar penggolongan, catatan) dibungkus dan
  // baris ditinggikan, bukan terpotong di tinggi tetap 16. Lebar sama dengan
  // lebar akhir kolom di bawah.
  const lebarAkhir = (c: number) => (c === 0 ? Math.max(sheet.lebarKolom[c] ?? 14, 24) : Math.max(sheet.lebarKolom[c] ?? 14, 14));
  // Teks yang muat di lebar kolom tetap satu baris (mis. "PJ-2025-000005"
  // tidak dibungkus); perkiraan 1,1 hanya untuk teks yang memang lebih panjang.
  const jumlahBaris = (teks: unknown, lebar: number) =>
    typeof teks !== 'string' || teks.length <= lebar - 2 ? 1 : Math.max(1, Math.ceil((teks.length * 1.1) / Math.max(8, lebar - 2)));
  // Baris DATA/TOTAL milik tabel yang dimulai di baris kepala r (berhenti di
  // seksi berikutnya — dulu memindai seluruh sisa lembar sehingga judul
  // kolom ikut rata kanan karena kolom Rupiah di TABEL LAIN).
  const barisTabel = (r: number): number[] => {
    const out: number[] = [];
    for (let i = r + 1; i < sheet.aoa.length && (sheet.peran[i] === 'DATA' || sheet.peran[i] === 'TOTAL'); i++) out.push(i);
    return out;
  };
  const TINGGI_PER_BARIS = 14;

  sheet.aoa.forEach((row, r) => {
    const peran = sheet.peran[r] ?? 'DATA';
    const gabung = () => nKolom > 1 && merges.push({ s: { r, c: 0 }, e: { r, c: nKolom - 1 } });
    const isi: (SelExcel | null)[] = [];
    const garisKop = r === indeksMetaTerakhir ? { border: { bottom: garis(WARNA.primer, 'medium') } } : {};
    switch (peran) {
      case 'NAMA':
      case 'JUDUL':
      case 'META': {
        const s = peran === 'NAMA' ? G.namaKoperasi : peran === 'JUDUL' ? G.judul : G.periode;
        isi.push({ v: row[0] ?? '', s: { ...s, ...garisKop } });
        for (let c = 1; c < nKolom; c++) isi.push({ v: '', s: garisKop });
        gabung();
        tinggi[r] = { hpt: peran === 'NAMA' ? 24 : peran === 'JUDUL' ? 20 : 15 };
        break;
      }
      case 'KOSONG':
        tinggi[r] = { hpt: 10 };
        break;
      case 'SEKSI': {
        const s: GayaSel = {
          font: { name: FONT, bold: true, sz: 10.5, color: { rgb: WARNA.primer } },
          fill: { fgColor: { rgb: WARNA.primerMuda }, patternType: 'solid' },
          alignment: { vertical: 'center', indent: 1 },
          border: { bottom: garis(WARNA.primer) },
        };
        isi.push({ v: row[0] ?? '', s });
        for (let c = 1; c < nKolom; c++) isi.push({ v: '', s });
        gabung();
        tinggi[r] = { hpt: 20 };
        belang = 0;
        break;
      }
      case 'KV': {
        isi.push({
          v: row[0] ?? '',
          s: { font: { name: FONT, sz: 10, color: { rgb: WARNA.teksRedup } }, alignment: { vertical: 'center', indent: 1 }, border: { bottom: garis(WARNA.garisHalus) } },
        });
        const v = row[1] ?? '';
        const angka = typeof v === 'number';
        isi.push({
          v,
          s: {
            font: { name: FONT, bold: true, sz: 10, color: { rgb: WARNA.teks } },
            alignment: { horizontal: angka ? 'right' : 'left', vertical: 'center', wrapText: true },
            border: { bottom: garis(WARNA.garisHalus) },
            ...(angka ? { numFmt: FORMAT_RUPIAH } : {}),
          },
          ...(angka ? { z: FORMAT_RUPIAH } : {}),
        });
        for (let c = 2; c < nKolom; c++) isi.push({ v: '', s: { border: { bottom: garis(WARNA.garisHalus) } } });
        if (nKolom > 2) merges.push({ s: { r, c: 1 }, e: { r, c: nKolom - 1 } });
        let lebarNilai = 0;
        for (let c = 1; c < nKolom; c++) lebarNilai += lebarAkhir(c);
        tinggi[r] = { hpt: Math.min(Math.max(16, TINGGI_PER_BARIS * jumlahBaris(v, lebarNilai) + 2), 120) };
        break;
      }
      case 'KEPALA': {
        const n = row.length;
        const isiTabel = barisTabel(r);
        row.forEach((v, c) => {
          // rata kanan bila kolom ini berisi nominal Rupiah atau bilangan (jumlah, hari)
          const angka = isiTabel.some((i) => rupiah.has(`${i}:${c}`) || (sheet.peran[i] === 'DATA' && typeof sheet.aoa[i][c] === 'number'));
          isi.push({ v, s: gayaKepalaKolom(angka, c === 0, c === n - 1) });
        });
        tinggi[r] = { hpt: 20 };
        belang = 0;
        break;
      }
      case 'TOTAL':
      case 'DATA': {
        const zebra = peran === 'DATA' && belang++ % 2 === 1;
        let barisTeks = 1;
        row.forEach((v, c) => {
          const angka = rupiah.has(`${r}:${c}`);
          const dasar = gayaData(peran === 'TOTAL' ? 'TOTAL' : 'BIASA', angka, c === 0, zebra, false);
          const n = angka ? 1 : jumlahBaris(v, lebarAkhir(c));
          barisTeks = Math.max(barisTeks, n);
          // bilangan bukan Rupiah (jumlah pinjaman, hari) rata kanan seperti judul kolomnya
          const rata = !angka && typeof v === 'number' ? { horizontal: 'right' as const } : {};
          const s =
            n > 1
              ? { ...dasar, alignment: { ...(dasar.alignment ?? {}), ...rata, vertical: 'top' as const, wrapText: true } }
              : { ...dasar, alignment: { ...(dasar.alignment ?? {}), ...rata } };
          isi.push(angka ? { v, s, z: FORMAT_RUPIAH } : { v, s });
        });
        tinggi[r] = { hpt: barisTeks > 1 ? Math.min(TINGGI_PER_BARIS * barisTeks + 2, 120) : 16 };
        break;
      }
      case 'CATATAN':
      default:
        isi.push({ v: row[0] ?? '', s: { font: { name: FONT, italic: true, sz: 9, color: { rgb: WARNA.teksRedup } }, alignment: { vertical: 'top', wrapText: true } } });
        for (let c = 1; c < nKolom; c++) isi.push(null);
        gabung();
        tinggi[r] = { hpt: Math.min(14 * Math.max(1, Math.ceil(String(row[0] ?? '').length / 70)), 90) };
    }
    sel.push(isi);
  });

  if (tanggalCetak) {
    sel.push([]);
    const r = sel.length;
    sel.push([{ v: `Dicetak pada ${tanggalCetak}`, s: { font: { name: FONT, italic: true, sz: 8, color: { rgb: WARNA.teksRedup } } } }]);
    if (nKolom > 1) merges.push({ s: { r, c: 0 }, e: { r, c: nKolom - 1 } });
    sel.push([{ v: TEKS_IDENTITAS_CETAK, s: { font: { name: FONT, bold: true, sz: 8, color: { rgb: WARNA.teksRedup } } } }]);
    if (nKolom > 1) merges.push({ s: { r: r + 1, c: 0 }, e: { r: r + 1, c: nKolom - 1 } });
  }

  const lebar = sheet.lebarKolom.slice(0, nKolom).map((w, c) => (c === 0 ? Math.max(w, 24) : Math.max(w, 14)));
  while (lebar.length < nKolom) lebar.push(14);
  return { namaSheet: namaSheetAman(judul), sel, merges, lebarKolom: lebar, tinggiBaris: tinggi };
}

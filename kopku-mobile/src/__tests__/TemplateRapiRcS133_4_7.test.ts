import * as XLSX from 'xlsx-js-style';
import { bangunWorkbookTemplate, BARIS_ISIAN_SIAP, formatIsianKolom } from '@/import/TemplateWorkbook';
import {
  BARIS_PETUNJUK,
  BARIS_PETUNJUK_TRANSAKSI_BARU,
  NAMA_SHEET_PANDUAN_KOLOM,
  SHEET_SALDO_AWAL_AKUN,
  SHEET_TEMPLATE,
  SHEET_TEMPLATE_TRANSAKSI_BARU,
  catatanJudulKolom,
} from '@/import/TemplateDataAwal';
import {
  cocokkanJenisSheet,
  cocokkanSheetSaldoAwalAkun,
  parseBerkasDataAwal,
  type SheetMentah,
} from '@/import/ExcelDataAwalParser';

/**
 * RC-S133.4.7 — template Excel yang lebih rapi:
 *   - catatan (comment) di setiap judul kolom,
 *   - area isian bergaris & berformat (teks untuk kode/NIK, tanggal yyyy-mm-dd),
 *   - sheet "Panduan Kolom" (Saldo Lama),
 *   - baris legenda di atas judul kolom.
 * Semua itu TIDAK boleh mengubah hasil pembacaan berkas.
 */

/** Tulis lalu baca ulang — persis seperti berkas yang diunduh & dipilih kembali. */
function bolakBalik(wb: XLSX.WorkBook): SheetMentah {
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const baca = XLSX.read(buf, { type: 'array' });
  const hasil: SheetMentah = {};
  for (const nama of baca.SheetNames) {
    if (cocokkanSheetSaldoAwalAkun(nama)) {
      hasil.SALDO_AWAL_AKUN = XLSX.utils.sheet_to_json<unknown[]>(baca.Sheets[nama], { header: 1, raw: true, defval: null });
      continue;
    }
    const jenis = cocokkanJenisSheet(nama);
    if (!jenis || hasil[jenis]) continue;
    hasil[jenis] = XLSX.utils.sheet_to_json<unknown[]>(baca.Sheets[nama], { header: 1, raw: true, defval: null });
  }
  return hasil;
}

describe('RC-S133.4.7 — template rapi tetap terbaca sama', () => {
  test('Saldo Lama: setelah ditulis & dibaca ulang, setiap sheet hanya berisi 1 baris (baris contoh) — area isian kosong dilewati', () => {
    const r = parseBerkasDataAwal(bolakBalik(bangunWorkbookTemplate('SALDO_LAMA')));
    for (const k of ['anggota', 'simpanan', 'pinjaman', 'berjangka', 'aset', 'jasa'] as const) {
      expect(r.hasil[k].terbaca).toBe(true);
      expect(r.hasil[k].galat).toEqual([]);
      expect(r.hasil[k].baris).toHaveLength(1);
    }
    // Sheet 7: satu-satunya baris adalah baris contoh, yang memang ditolak parser.
    expect(r.hasil.saldoAwalAkun?.baris).toHaveLength(0);
    expect(r.hasil.saldoAwalAkun?.galat).toHaveLength(1);
  });

  test('Transaksi Baru: sheet 1–4 terbaca, masing-masing 1 baris contoh', () => {
    const r = parseBerkasDataAwal(bolakBalik(bangunWorkbookTemplate('TRANSAKSI_BARU')));
    for (const k of ['anggota', 'simpanan', 'pinjaman', 'berjangka'] as const) {
      expect(r.hasil[k].galat).toEqual([]);
      expect(r.hasil[k].baris).toHaveLength(1);
    }
    expect(r.hasil.saldoAwalAkun).toBeUndefined();
  });

  test('"Panduan Kolom" hanya di Saldo Lama, diabaikan pembaca berkas, dan memuat SETIAP kolom', () => {
    const wb = bangunWorkbookTemplate('SALDO_LAMA');
    expect(wb.SheetNames[1]).toBe(NAMA_SHEET_PANDUAN_KOLOM);
    expect(cocokkanJenisSheet(NAMA_SHEET_PANDUAN_KOLOM)).toBeNull();
    expect(cocokkanSheetSaldoAwalAkun(NAMA_SHEET_PANDUAN_KOLOM)).toBe(false);
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[NAMA_SHEET_PANDUAN_KOLOM], { header: 1, defval: '' });
    const kolomDiPanduan = aoa.slice(4).map((b) => String(b[1]));
    for (const sh of [...SHEET_TEMPLATE, SHEET_SALDO_AWAL_AKUN]) for (const k of sh.kolom) expect(kolomDiPanduan).toContain(k.label);
    expect(bangunWorkbookTemplate('TRANSAKSI_BARU').SheetNames).not.toContain(NAMA_SHEET_PANDUAN_KOLOM);
  });

  test('setiap judul kolom punya catatan (comment) yang menyebut wajib/opsional', () => {
    const wb = bangunWorkbookTemplate('SALDO_LAMA');
    for (const sh of SHEET_TEMPLATE) {
      sh.kolom.forEach((k, c) => {
        const sel: any = wb.Sheets[sh.nama][XLSX.utils.encode_cell({ r: 2, c })];
        expect(sel.c?.[0]?.t).toBe(catatanJudulKolom(k));
        expect(sel.c[0].t).toMatch(k.wajib ? /^WAJIB/ : /^Opsional/);
      });
    }
  });

  test('area isian: kode & NIK berformat teks, tanggal yyyy-mm-dd, nominal ribuan', () => {
    expect(formatIsianKolom('Kode Anggota')).toBe('@');
    expect(formatIsianKolom('NIK')).toBe('@');
    expect(formatIsianKolom('Kode Akun')).toBe('@');
    expect(formatIsianKolom('Tanggal Bergabung')).toBe('yyyy-mm-dd');
    expect(formatIsianKolom('Jumlah Pinjaman')).toBe('#,##0;(#,##0)');
    const wb = bangunWorkbookTemplate('SALDO_LAMA');
    const ws = wb.Sheets['1. Anggota'];
    const nik = SHEET_TEMPLATE[0].kolom.findIndex((k) => k.label === 'NIK');
    expect((ws[XLSX.utils.encode_cell({ r: 4, c: nik })] as any).s.numFmt).toBe('@');
    expect(ws[XLSX.utils.encode_cell({ r: 3 + BARIS_ISIAN_SIAP, c: 0 })]).toBeDefined();
  });

  test('catatan kolom pinjaman lama tidak lagi berbunyi WAJIB (sudah diturunkan otomatis) & contoh konsisten', () => {
    const p = SHEET_TEMPLATE.find((s) => s.jenis === 'PINJAMAN')!;
    const ambil = (l: string) => p.kolom.find((k) => k.label === l)!;
    for (const l of ['Nomor Pinjaman Lama', 'Sisa Pokok', 'Angsuran Tersisa']) expect(ambil(l).catatan).not.toMatch(/^WAJIB/);
    const jumlah = Number(ambil('Jumlah Pinjaman').contoh);
    const tenor = Number(ambil('Tenor').contoh);
    const dibayar = Number(ambil('Angsuran Sudah Dibayar').contoh);
    expect(Number(ambil('Sisa Pokok').contoh)).toBe(jumlah - dibayar * (jumlah / tenor));
    expect(Number(ambil('Angsuran Tersisa').contoh)).toBe(tenor - dibayar);
  });

  test('petunjuk memuat bagian Sebelum Mulai & Kesalahan yang Sering Terjadi; Transaksi Baru tetap tanpa kata cut-off', () => {
    const lama = BARIS_PETUNJUK.flat().join(' ');
    expect(lama).toContain('SEBELUM MULAI');
    expect(lama).toContain('KESALAHAN YANG SERING TERJADI');
    const baru = BARIS_PETUNJUK_TRANSAKSI_BARU.flat().join(' ');
    expect(baru).not.toMatch(/cut-off/);
    expect(baru).toContain('PANDUAN KOLOM');
    for (const sh of SHEET_TEMPLATE_TRANSAKSI_BARU) for (const k of sh.kolom) expect(k.catatan ?? '').not.toMatch(/cut-off/);
  });
});

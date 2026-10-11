import { bangunWorkbookTemplate } from '@/import/TemplateWorkbook';
import {
  WARNA,
  GAYA_JUDUL_KOLOM,
  gayaSel,
  gayaBarisContoh,
  gayaTotal,
  formatUntukKolom,
  kolomAngka,
  FORMAT_RUPIAH,
  FORMAT_PERSEN,
  FORMAT_TANGGAL,
} from '@/export/GayaExcel';
import { sheetTemplateUrutTampilan, judulKolomExcel, KODE_CONTOH } from '@/import/TemplateDataAwal';

/**
 * RC-S106 — GAYA BERKAS EXCEL.
 *
 * Yang dikunci: judul kolom benar-benar BERGAYA (bukan sekadar teks),
 * baris contoh terlihat berbeda dari data, nominal berformat ribuan,
 * dan warnanya mengikuti warna aplikasi — bukan palet lepas.
 */

describe('RC-S106 §A — tebakan format kolom', () => {
  test('kolom nominal diformat ribuan', () => {
    for (const j of ['Jumlah Pinjaman', 'Simpanan Pokok', 'Sisa Pokok', 'Tunggakan Pokok', 'Piutang Jasa', 'Nominal']) {
      expect(formatUntukKolom(j)).toBe(FORMAT_RUPIAH);
      expect(kolomAngka(j)).toBe(true);
    }
  });

  test('kolom tanggal diformat tanggal, bukan ribuan', () => {
    for (const j of ['Tanggal Bergabung', 'Tanggal Pencairan', 'Tgl Akad']) {
      expect(formatUntukKolom(j)).toBe(FORMAT_TANGGAL);
      // Tanggal BUKAN kolom angka: rata kanan tidak berlaku.
      expect(kolomAngka(j)).toBe(false);
    }
  });

  test('kolom persen diformat dua desimal', () => {
    expect(formatUntukKolom('Jasa Persen')).toBe(FORMAT_PERSEN);
    expect(formatUntukKolom('Suku Bunga Per Tahun')).toBe(FORMAT_PERSEN);
  });

  test('kolom teks tidak diberi format angka', () => {
    // "Metode Jasa" & "Satuan Tenor" sengaja ikut diuji: keduanya
    // mengandung kata yang dipakai aturan nominal, dan versi pertama
    // memang salah menandainya sebagai kolom uang.
    for (const j of ['Kode Anggota', 'Nama Lengkap', 'Alamat', 'Sumber Dana', 'Metode Jasa', 'Satuan Tenor', 'Nomor Pinjaman Lama']) {
      expect(formatUntukKolom(j)).toBeUndefined();
      expect(kolomAngka(j)).toBe(false);
    }
  });

  test('nominal negatif ditulis dalam kurung, bukan tanda minus', () => {
    expect(FORMAT_RUPIAH).toContain('(#,##0)');
  });
});

describe('RC-S106 §B — gaya memakai warna aplikasi', () => {
  test('bar judul kolom memakai hijau primer aplikasi', () => {
    expect(WARNA.primer).toBe('FF1B5E20'); // colors.primary
    expect(GAYA_JUDUL_KOLOM.fill?.fgColor.rgb).toBe(WARNA.primer);
    expect(GAYA_JUDUL_KOLOM.font?.bold).toBe(true);
    expect(GAYA_JUDUL_KOLOM.font?.color?.rgb).toBe(WARNA.putih);
  });

  test('baris contoh dibedakan dari data sungguhan', () => {
    const contoh = gayaBarisContoh();
    const biasa = gayaSel();
    expect(contoh.fill?.fgColor.rgb).toBe(WARNA.peringatan);
    expect(contoh.font?.italic).toBe(true);
    expect(biasa.fill).toBeUndefined();
  });

  test('kolom angka rata kanan, kolom teks rata kiri', () => {
    expect(gayaSel({ angka: true }).alignment?.horizontal).toBe('right');
    expect(gayaSel().alignment?.horizontal).toBe('left');
    expect(gayaTotal(true).alignment?.horizontal).toBe('right');
  });

  test('baris total ditebalkan dan bergaris atas', () => {
    const t = gayaTotal();
    expect(t.font?.bold).toBe(true);
    expect(t.border?.top).toBeDefined();
  });
});

describe('RC-S106 §C — template yang dihasilkan benar-benar bergaya', () => {
  const wb = bangunWorkbookTemplate();
  const sheetData = sheetTemplateUrutTampilan();

  test('seluruh sheet template ada', () => {
    expect(wb.SheetNames[0]).toBe('Petunjuk');
    for (const s of sheetData) expect(wb.SheetNames).toContain(s.nama);
  });

  test('SETIAP judul kolom di SETIAP sheet punya gaya bar hijau', () => {
    for (const s of sheetData) {
      const ws = wb.Sheets[s.nama];
      s.kolom.forEach((_k, c) => {
        const sel = ws[require('xlsx-js-style').utils.encode_cell({ r: 2, c })];
        expect(sel).toBeDefined();
        expect(sel.s?.fill?.fgColor?.rgb).toBe(WARNA.primer);
        expect(sel.s?.font?.bold).toBe(true);
      });
    }
  });

  test('baris contoh berlatar kuning di seluruh sheet', () => {
    for (const s of sheetData) {
      const ws = wb.Sheets[s.nama];
      const sel = ws[require('xlsx-js-style').utils.encode_cell({ r: 3, c: 0 })];
      expect(sel.s?.fill?.fgColor?.rgb).toBe(WARNA.peringatan);
    }
  });

  test('baris contoh tetap ditandai KODE_CONTOH — penanda lama tidak hilang', () => {
    const ws = wb.Sheets[sheetData[0].nama];
    expect(String(ws['A4'].v)).toContain(KODE_CONTOH);
  });

  test('kolom nominal pada baris contoh memakai format ribuan', () => {
    const X = require('xlsx-js-style');
    let diperiksa = 0;
    for (const s of sheetData) {
      const ws = wb.Sheets[s.nama];
      s.kolom.forEach((k, c) => {
        const judul = judulKolomExcel(k);
        const sel = ws[X.utils.encode_cell({ r: 3, c })];
        if (formatUntukKolom(judul) === FORMAT_RUPIAH && typeof sel?.v === 'number') {
          expect(sel.z).toBe(FORMAT_RUPIAH);
          diperiksa += 1;
        }
      });
    }
    // Penjaga: kalau tidak ada satu pun yang diperiksa, test ini palsu.
    expect(diperiksa).toBeGreaterThan(0);
  });

  test('setiap sheet data punya autofilter di baris judul', () => {
    for (const s of sheetData) {
      const ref = wb.Sheets[s.nama]['!autofilter']?.ref;
      expect(ref).toMatch(/^A3:[A-Z]+3$/);
    }
  });

  test('lebar kolom tetap diterapkan', () => {
    for (const s of sheetData) {
      expect(wb.Sheets[s.nama]['!cols']).toHaveLength(s.kolom.length);
    }
  });

  test('sheet Petunjuk: judul dokumen bergaya besar & berwarna', () => {
    const a1 = wb.Sheets['Petunjuk']['A1'];
    expect(a1.s?.font?.bold).toBe(true);
    expect(a1.s?.font?.color?.rgb).toBe(WARNA.primer);
    expect((a1.s?.font?.sz ?? 0)).toBeGreaterThan(11);
  });
});

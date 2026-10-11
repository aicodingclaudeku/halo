import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S86 — UI/UX menu Pinjaman (daftar) & Ajukan Pinjaman (form).
 *
 *   1. Export dipasang di header navigasi, sejajar judul "Pinjaman".
 *   2. Setiap kartu pinjaman punya nomor urut di kanan atas, diambil dari
 *      index daftar yang sedang tampil (bukan ID/nomor pinjaman).
 *   3. Form Ajukan Pinjaman disusun per bagian bernomor + ringkasan,
 *      tanpa mengubah state/validasi/service.
 *   4. Pengajuan BARU ikut mengirim tujuan & agunan (sebelumnya hanya
 *      jalur edit yang mengirimnya).
 *
 * JENIS TEST: STATIC.
 */

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}

const LIST = baca('src/screens/Pinjaman/PinjamanListScreen.tsx');
const FORM = baca('src/screens/Pinjaman/PinjamanFormScreen.tsx');
const EXPORT_BTN = baca('src/components/ExportButton.tsx');

describe('RC-S86 — daftar Pinjaman', () => {
  it('Export dipasang lewat headerRight, bukan di badan layar', () => {
    expect(LIST).toMatch(/useLayoutEffect\(/);
    expect(LIST).toMatch(/headerRight: \(\) => <ExportButton variant="header"/);
    const badan = LIST.slice(LIST.indexOf('  return (\n    <View style={styles.container}>'));
    expect(badan).not.toMatch(/<ExportButton/);
  });

  it('data export tetap dibangun dengan buildPinjamanExport atas daftar yang tampil', () => {
    expect(LIST).toMatch(/buildPinjamanExport\(/);
    expect(LIST).toMatch(/\[koperasi, data\]/);
  });

  it('nomor urut berasal dari index tampilan dan berada di baris atas kartu', () => {
    expect(LIST).toMatch(/renderItem=\{\(\{ item, index \}\)/);
    const atas = LIST.slice(LIST.indexOf('styles.cardTop'), LIST.indexOf('styles.cardDivider'));
    expect(atas).toMatch(/styles\.nomorUrut/);
    expect(atas).toMatch(/\{index \+ 1\}/);
    // Nomor urut ditempatkan SETELAH identitas → sisi kanan baris flex.
    expect(atas.indexOf('styles.cardIdentitas')).toBeLessThan(atas.indexOf('styles.nomorUrut'));
  });

  it('ExportButton punya varian header tanpa mengubah logika export', () => {
    expect(EXPORT_BTN).toMatch(/variant\?: 'default' \| 'header'/);
    expect(EXPORT_BTN.match(/exportLaporan\(/g)?.length).toBe(1);
  });
});

describe('RC-S86 — form Ajukan Pinjaman', () => {
  it('disusun per bagian bernomor 1–6', () => {
    const nomor = [...FORM.matchAll(/<Section nomor=\{(\d+)\}/g)].map((m) => Number(m[1]));
    expect(nomor).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('memakai DatePicker untuk tanggal pengajuan', () => {
    expect(FORM).toMatch(/<DatePicker value=\{tanggal\} onChange=\{setTanggal\} \/>/);
  });

  it('ringkasan memakai previewBiayaAdmin yang sama dengan modal biaya admin', () => {
    expect(FORM).toMatch(/const ringkasanBiaya = previewBiayaAdmin\(biayaAdminTipe, biayaAdminNilai, jumlahPinjaman\)/);
  });

  it('pengajuan baru mengirim tujuan & agunan ke ajukanPinjaman', () => {
    const blok = FORM.slice(FORM.indexOf('await ajukanPinjaman({'), FORM.indexOf('createdBy: currentUser.id'));
    expect(blok).toMatch(/tujuanPinjaman: tujuanPinjaman \?\? undefined/);
    expect(blok).toMatch(/agunan:/);
  });

  it('pilihan metode jasa & biaya admin tetap lewat handler lama (modal FLAT & klasifikasi)', () => {
    expect(FORM).toMatch(/onChange=\{\(v\) => pilihMetodeJasa\(v\)\}/);
    expect(FORM).toMatch(/onChange=\{\(v\) => pilihBiayaAdminTipe\(v\)\}/);
  });
});

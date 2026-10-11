import { readFileSync } from 'fs';
import { join } from 'path';
import { htmlPengesahanDanFooter } from '@/export/DokumenKontrakHtml';
import { LABEL_METERAI } from '@/export/DasarHukumAkad';

/**
 * Tanda tangan akad & pencairan:
 *  - Meterai dicetak sebagai TEKS saja (tanpa kotak), rata kiri pada
 *    ruang tanda tangan anggota.
 *  - Tombol "Cairkan Pinjaman" membuka konfirmasi tanda tangan akad dulu;
 *    form pencairan baru terbuka setelah pernyataan dicentang.
 */
const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('meterai pada blok tanda tangan', () => {
  const html = htmlPengesahanDanFooter({
    nomorBab: null,
    pernyataan: null,
    anggota: { peran: 'PIHAK KEDUA', nama: 'Andi' },
    koperasi: { peran: 'PIHAK PERTAMA', namaKoperasi: 'Koperasi X', pengurus: {} as never },
    footer: { nomorPinjaman: 'PJ-1', labelNomorDokumen: 'No.', nomorDokumen: 'AK/PJ-1', tanggalCetak: 'X', catatan: 'c' },
  });
  const css = baca('src/export/DokumenKontrakHtml.ts');

  it('hanya teks "Meterai Rp10.000", tidak ada kotak', () => {
    expect(html).toContain(`<span class="meterai">${LABEL_METERAI}</span>`);
    const aturan = css.match(/\.meterai \{[^}]*\}/)![0];
    expect(aturan).not.toMatch(/border|width|height/);
  });

  it('teks meterai digeser ke kiri, tidak di tengah', () => {
    const ruang = css.match(/\.ttd-ruang-meterai \{[^}]*\}/)![0];
    expect(ruang).toContain('justify-content: flex-start');
    expect(ruang).toMatch(/padding-left: \d+px/);
    expect(ruang).toContain('height: 78px'); // sejajar dengan ruang tanda tangan Ketua
  });
});

describe('pencairan didahului konfirmasi tanda tangan akad', () => {
  const layar = baca('src/screens/Pinjaman/PinjamanDetailScreen.tsx');

  it('tombol Cairkan membuka konfirmasi akad, bukan langsung form pencairan', () => {
    const buka = layar.slice(layar.indexOf('const bukaCairkanBaru'), layar.indexOf('const lanjutCairkanSetelahAkad'));
    expect(buka).toContain('setKonfirmasiAkadOpen(true)');
    expect(buka).not.toContain('setCairkanModalOpen(true)');
  });

  it('form pencairan hanya terbuka setelah pernyataan tanda tangan dicentang', () => {
    const lanjut = layar.slice(layar.indexOf('const lanjutCairkanSetelahAkad'), layar.indexOf('const bukaEditPencairan'));
    expect(lanjut).toMatch(/if \(!akadDitandatangani\) return;/);
    expect(lanjut).toContain('setCairkanModalOpen(true)');
    expect(layar).toContain('Konfirmasi Tanda Tangan Akad');
    expect(layar).toContain('disabled={!akadDitandatangani}');
  });

  it('kartu akad awal tidak lagi menampilkan DRAF', () => {
    expect(layar).not.toMatch(/dicetak sebagai DRAF|'DRAF'/);
    expect(layar).toContain("'SIAP DITANDATANGANI'");
  });
});

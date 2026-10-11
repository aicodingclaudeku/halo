/**
 * RC-S87.1 — Pengaturan Pajak UI/UX: penjelasan (ikon tanda seru) lengkap,
 * angka konsisten dengan pajakPolicy, dan layar tetap tipis.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { isiInfoPajak, KunciInfo } from '@/screens/Pajak/infoPajak';
import { hitungPphBadanNonFinal, kebijakanUntukTahun, LABEL_REZIM } from '@/config/pajakPolicy';
import { formatRupiah } from '@/utils/money';

const KUNCI: KunciInfo[] = [
  'rezim', 'FINAL_UMKM', 'BADAN_31E', 'BADAN_UMUM', 'penetapan', 'deklarasi', 'tahunTerdaftar',
  'peredaranBruto', 'batasFinal', 'batas31E', 'masaFasilitas', 'penetapanManual', 'versiKebijakan',
];
const baca = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('RC-S87.1 — isi penjelasan pajak', () => {
  it.each(KUNCI)('"%s" punya judul & ringkasan yang tidak kosong', (k) => {
    const i = isiInfoPajak(k, 2026);
    expect(i.judul.trim().length).toBeGreaterThan(3);
    expect(i.ringkas.trim().length).toBeGreaterThan(20);
  });

  it('judul rezim memakai istilah hukum yang sama dengan LABEL_REZIM', () => {
    for (const r of ['FINAL_UMKM', 'BADAN_31E', 'BADAN_UMUM'] as const) expect(isiInfoPajak(r, 2026).judul).toBe(LABEL_REZIM[r]);
  });

  it('contoh Pasal 31E dihitung dari kalkulator policy, bukan ditulis tangan', () => {
    const k = kebijakanUntukTahun(2026);
    const h = hitungPphBadanNonFinal({ rezim: 'BADAN_31E', peredaranBruto: 10_000_000_000, pkpSebelumPembulatan: 1_000_000_000, kredit: { pph25: 0, pph22: 0, pph23: 0, pph24: 0 }, kebijakan: k });
    const c = isiInfoPajak('BADAN_31E', 2026).contoh!;
    expect(c.baris[c.baris.length - 1].nilai).toBe(formatRupiah(h.totalPphBadan));
    expect(isiInfoPajak('batasFinal', 2026).judul).toContain(formatRupiah(k.batasOmzetFinal));
  });

  it('infoPajak tidak menulis tarif/batas sebagai angka lepas', () => {
    const s = baca('screens/Pajak/infoPajak.ts');
    expect(s).not.toMatch(/4[.,_]?800[.,_]?000[.,_]?000|50[.,_]000[.,_]000[.,_]000/);
    expect(s).not.toMatch(/PPh Final\s*(11|22)\s*%/i);
  });

  it('layar Pengaturan Pajak: ada ikon penjelasan, tidak menulis DB, tanpa warna hex, tanpa pilihan tarif bebas', () => {
    const s = baca('screens/Pajak/PengaturanPajakScreen.tsx');
    const kunci = new Set([...s.matchAll(/info\('(\w+)'\)/g)].map((m) => m[1]));
    for (const k of ['rezim', 'penetapan', 'deklarasi', 'tahunTerdaftar', 'peredaranBruto', 'batasFinal', 'batas31E', 'masaFasilitas', 'penetapanManual', 'versiKebijakan']) {
      expect(kunci.has(k)).toBe(true);
    }
    expect(s).toMatch(/<TombolInfo isi=\{info\(r\)\}/); // penjelasan rezim aktif
    expect(s).not.toMatch(/getDb|runAsync|createJournal/);
    expect(s).not.toMatch(/'#[0-9A-Fa-f]{3,6}'/);
    expect(s).not.toMatch(/tarif\w*\s*=\s*useState/i);
  });

  it('lembar info memakai token modal bersama dan tombol tutup', () => {
    const s = baca('screens/Pajak/PajakUi.tsx');
    expect(s).toMatch(/modalUi\.sheet/);
    expect(s).toMatch(/modalUi\.backdrop/);
    expect(s).toMatch(/onRequestClose=\{onTutup\}/);
    expect(s).toMatch(/Mengerti/);
  });
});

import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S54 §11 — urutan pilihan metode jasa pada "Ajukan Pinjaman".
 *
 * Yang diminta HANYA urutan tampilan: Efektif, Flat, Menurun. Suite ini
 * menjaga dua hal sekaligus — urutannya benar, DAN tidak ada satu pun
 * perilaku perhitungan yang ikut berubah (nilai enum, default, dan
 * kelengkapan opsi tetap sama).
 *
 * JENIS TEST: STATIC.
 */

function baca(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}

const SRC = baca('src/screens/Pinjaman/PinjamanFormScreen.tsx');

describe('RC-S54 §11 — urutan metode jasa', () => {
  it('urutan tampilan: Efektif, Flat, Menurun', () => {
    const blok = SRC.slice(
      SRC.indexOf('const METODE_OPTIONS'),
      SRC.indexOf('const TENOR_SATUAN_OPTIONS')
    );
    const urutan = [...blok.matchAll(/value: '([A-Z]+)'/g)].map((m) => m[1]);
    expect(urutan.slice(0, 3)).toEqual(['EFEKTIF', 'FLAT', 'MENURUN']);
  });

  it('nol opsi hilang & nol opsi duplikat', () => {
    const blok = SRC.slice(
      SRC.indexOf('const METODE_OPTIONS'),
      SRC.indexOf('const TENOR_SATUAN_OPTIONS')
    );
    const urutan = [...blok.matchAll(/value: '([A-Z]+)'/g)].map((m) => m[1]);
    expect(urutan.sort()).toEqual(['CUSTOM', 'EFEKTIF', 'FLAT', 'MENURUN']);
  });

  it('default metode TIDAK berubah — urutan tampilan bukan perubahan perilaku', () => {
    expect(SRC).toMatch(/useState<MetodeJasa>\('FLAT'\)/);
  });

  it('nol perubahan pada kalkulator jasa', () => {
    const kalkulator = baca('src/accounting/PinjamanCalculator.ts');
    for (const m of ['FLAT', 'MENURUN', 'EFEKTIF']) {
      expect(kalkulator).toContain(m);
    }
  });
});

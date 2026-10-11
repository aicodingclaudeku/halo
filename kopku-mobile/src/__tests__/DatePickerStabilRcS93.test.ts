import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * RC-S93 — BUG: kalender "melompat kembali" di layar Developer.
 *
 * Laporan pengguna: pada "Tetapkan Tanggal & Jam", kalender yang digeser
 * dari November ke Desember kembali sendiri ke November.
 *
 * Akar masalah (dua lapis):
 *   1. `@react-native-community/datetimepicker` di Android membuka ULANG
 *      dialognya — ke tanggal `value` — setiap kali identitas `onChange`
 *      berubah (efek ber-deps `[onChange, valueTimestamp, mode]`).
 *   2. `DatePicker` membuat `handleChange` baru di setiap render, dan
 *      `DeveloperScreen` me-render ulang SETIAP DETIK untuk jam berjalan.
 *
 * Repo ini tidak memiliki renderer React untuk test perilaku komponen,
 * jadi — mengikuti pola test struktural yang sudah ada — test di bawah
 * mengunci sifat source yang menjadi perbaikannya, ditambah kontrak
 * library yang menjadi alasan perbaikan itu diperlukan.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('RC-S93 — kontrak library yang memicu bug', () => {
  const lib = 'node_modules/@react-native-community/datetimepicker/src/datetimepicker.android.js';

  (existsSync(join(ROOT, lib)) ? it : it.skip)(
    'dialog Android dibuka ulang saat identitas onChange berubah (alasan onChange harus stabil)',
    () => {
      // Kalau test ini gagal setelah upgrade library, alasan perbaikan
      // mungkin sudah tidak berlaku — perbaikannya tetap aman, tetapi
      // komentar di DatePicker.tsx perlu ditinjau ulang.
      expect(tanpaKomentar(read(lib))).toMatch(/\[onChange,\s*valueTimestamp,\s*mode\]/);
    }
  );
});

describe('RC-S93 — DatePicker stabil terhadap render ulang induk', () => {
  const src = tanpaKomentar(read('src/components/DatePicker.tsx'));

  it('handleChange dibuat SEKALI (useCallback tanpa deps), bukan fungsi baru tiap render', () => {
    expect(src).toMatch(/const handleChange = useCallback\([\s\S]*?\},\s*\[\]\);/);
  });

  it('onChange terbaru dibaca lewat ref, sehingga handler stabil tetap memanggil callback terkini', () => {
    expect(src).toMatch(/const onChangeRef = useRef\(onChange\)/);
    expect(src).toMatch(/onChangeRef\.current = onChange/);
    expect(src).toMatch(/onChangeRef\.current\(toIso\(selected\)\)/);
  });

  it('objek Date di-memo pada nilai ISO, bukan dibuat baru di setiap render', () => {
    expect(src).toMatch(/const nilaiTanggal = useMemo\(\(\) => fromIso\(value\), \[value\]\)/);
    expect(src).toMatch(/value=\{nilaiTanggal\}/);
    expect(src).not.toMatch(/value=\{fromIso\(value\)\}/);
  });
});

describe('RC-S93 — DeveloperScreen tidak me-render ulang form setiap detik', () => {
  const src = tanpaKomentar(read('src/screens/Pengaturan/DeveloperScreen.tsx'));

  /** Isi fungsi komponen bernama `nama` (dari deklarasinya sampai deklarasi fungsi top-level berikutnya). */
  function badanFungsi(nama: string): string {
    const mulai = src.search(new RegExp(`function ${nama}\\(`));
    expect(mulai).toBeGreaterThanOrEqual(0);
    const sisa = src.slice(mulai + 1);
    const berikut = sisa.search(/\n(export default )?function [A-Z]/);
    return berikut < 0 ? sisa : sisa.slice(0, berikut);
  }

  it('setInterval jam berjalan TIDAK berada di komponen layar utama', () => {
    expect(badanFungsi('DeveloperScreen')).not.toMatch(/setInterval\(/);
  });

  it('setInterval jam berjalan terkurung di komponen KartuJam', () => {
    expect(badanFungsi('KartuJam')).toMatch(/setInterval\(/);
    expect(badanFungsi('KartuJam')).toMatch(/clearInterval\(/);
  });

  it('layar utama merender KartuJam (jam tetap tampil)', () => {
    expect(badanFungsi('DeveloperScreen')).toMatch(/<KartuJam/);
  });
});

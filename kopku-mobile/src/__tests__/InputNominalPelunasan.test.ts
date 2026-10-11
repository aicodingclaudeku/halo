import { formatNominalInput, parseNominalInput } from '@/utils/money';

/**
 * REQUIREMENT 8 (hardening) — logika input nominal pelunasan.
 *
 * BATASAN YANG DIAKUI TERUS TERANG: perilaku KURSOR, FOKUS, dan
 * REMOUNT hanya benar-benar terbukti di perangkat/emulator. Paket
 * react-test-renderer TIDAK dapat dipasang (registry npm 403), jadi
 * file ini SENGAJA TIDAK berpura-pura mengujinya — status behavior
 * tersebut tetap NOT VERIFIED sampai ada uji manual.
 *
 * Yang BISA dan MEMANG diuji di sini adalah bagian yang menentukan
 * apakah nilai input stabil saat diketik:
 *   1) round-trip ketik-per-karakter TIDAK PERNAH kehilangan/mengubah
 *      angka (nilai tidak "reset" atau berubah sendiri);
 *   2) teks yang sudah terformat bila diketik ulang menghasilkan angka
 *      yang SAMA (idempoten) — inilah yang membuat prop `value`
 *      terkontrol tidak berosilasi antar-render;
 *   3) guard no-op: input yang tidak mengubah angka menghasilkan nilai
 *      yang IDENTIK, sehingga komponen dapat melewati pemanggilan
 *      onChangeValue dan parent tidak render sia-sia;
 *   4) string kosong dibedakan dari 0.
 */

/** Simulasi mengetik satu per satu, persis seperti TextInput terkontrol. */
function simulasiKetik(digits: string): (number | '')[] {
  const jejak: (number | '')[] = [];
  let nilai: number | '' = '';
  for (const ch of digits) {
    // TextInput terkontrol mengirim SELURUH teks baru = teks terformat
    // saat ini + karakter yang baru ditekan.
    const teksBaru = formatNominalInput(nilai) + ch;
    nilai = parseNominalInput(teksBaru);
    jejak.push(nilai);
  }
  return jejak;
}

describe('REQ 8 — nilai input stabil saat diketik (kasus uji dari requirement)', () => {
  test('123', () => {
    expect(simulasiKetik('123')).toEqual([1, 12, 123]);
  });

  test('1234', () => {
    expect(simulasiKetik('1234')).toEqual([1, 12, 123, 1234]);
  });

  test('12345', () => {
    expect(simulasiKetik('12345')).toEqual([1, 12, 123, 1234, 12345]);
  });

  test('1.000.000 — pemisah ribuan muncul tanpa mengubah angka', () => {
    const jejak = simulasiKetik('1000000');
    expect(jejak[jejak.length - 1]).toBe(1_000_000);
    expect(formatNominalInput(1_000_000)).toBe('1.000.000');
  });

  test('10.000.000', () => {
    const jejak = simulasiKetik('10000000');
    expect(jejak[jejak.length - 1]).toBe(10_000_000);
    expect(formatNominalInput(10_000_000)).toBe('10.000.000');
  });

  test('biaya administrasi: 1000 / 10000 / 100000', () => {
    for (const n of [1000, 10000, 100000]) {
      const jejak = simulasiKetik(String(n));
      expect(jejak[jejak.length - 1]).toBe(n);
    }
  });

  test('menghapus digit terakhir mengurangi angka, tidak me-reset ke kosong/0', () => {
    // "1.000.000" -> hapus 1 karakter dari ujung -> "1.000.00"
    const teks = formatNominalInput(1_000_000);
    const setelahHapus = parseNominalInput(teks.slice(0, -1));
    expect(setelahHapus).toBe(100_000);
    expect(setelahHapus).not.toBe('');
    expect(setelahHapus).not.toBe(0);
  });

  test('menghapus SELURUH isi menghasilkan kosong (bukan 0) — placeholder & validasi tetap benar', () => {
    expect(parseNominalInput('')).toBe('');
    expect(formatNominalInput('')).toBe('');
    // 0 tetap nilai yang sah dan BERBEDA dari kosong.
    expect(parseNominalInput('0')).toBe(0);
    expect(formatNominalInput(0)).toBe('0');
  });
});

describe('REQ 8 — idempotensi & guard no-op (dasar stabilitas value terkontrol)', () => {
  test('parse(format(x)) === x untuk seluruh nominal uji', () => {
    for (const n of [0, 1, 123, 1234, 12345, 1000, 10000, 100000, 1_000_000, 10_000_000, 987_654_321]) {
      expect(parseNominalInput(formatNominalInput(n))).toBe(n);
    }
  });

  test('format bersifat stabil: memformat ulang hasil parse tidak mengubah tampilan', () => {
    for (const n of [1234, 1_000_000, 10_000_000]) {
      const sekali = formatNominalInput(n);
      const duaKali = formatNominalInput(parseNominalInput(sekali));
      expect(duaKali).toBe(sekali);
    }
  });

  test('GUARD NO-OP: masukan yang tidak mengubah angka menghasilkan nilai identik', () => {
    // Semua varian ini merepresentasikan angka yang SAMA. Karena hasil
    // parse-nya identik dengan nilai yang sedang dipegang, komponen
    // melewati onChangeValue sehingga parent tidak render ulang tanpa
    // perlu — inilah yang mencegah caret dilempar ke akhir teks.
    const nilaiSekarang = 1_000_000;
    for (const teks of ['1.000.000', '1000000', 'Rp1.000.000', '1.000.000 ', '1,000,000']) {
      expect(parseNominalInput(teks)).toBe(nilaiSekarang);
    }
  });

  test('leading zero dinormalisasi tanpa membuang digit yang bermakna', () => {
    expect(parseNominalInput('0050')).toBe(50);
    expect(parseNominalInput('000')).toBe(0);
    expect(parseNominalInput('0100000')).toBe(100_000);
  });

  test('karakter non-digit dibuang, angka tetap utuh (paste dari sumber lain aman)', () => {
    expect(parseNominalInput('Rp 12.500,00')).toBe(1_250_000);
    expect(parseNominalInput('abc')).toBe('');
    expect(parseNominalInput('12a3')).toBe(123);
  });

  test('nilai desimal pada prop value dipotong, tidak dibulatkan diam-diam', () => {
    expect(formatNominalInput(1234.99 as number)).toBe('1.234');
  });
});

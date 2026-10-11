import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * ============================================================
 * RC-S110 — PAPAN KETIK TIDAK BOLEH MENUTUPI INPUT
 * ============================================================
 *
 * BATAS YANG DIJAGA SUITE INI.
 *
 * Sebelum RC-S110 aplikasi ini TERLIHAT sudah menangani papan ketik:
 * ada 27 pemakaian `KeyboardAvoidingView` di 19 layar. Semuanya
 * ditulis `behavior={Platform.OS === 'ios' ? 'padding' : undefined}`.
 * `behavior === undefined` membuat `KeyboardAvoidingView` tidak
 * melakukan apa-apa, jadi di Android — satu-satunya platform yang
 * dibangun (`app.json` -> platforms: ["android"]) — 27 perlindungan
 * itu tidak pernah aktif sedetik pun.
 *
 * Bahaya terbesar bukan papan ketik yang menutupi input; itu terlihat
 * dalam sepuluh detik. Bahayanya adalah perlindungan yang KEMBALI
 * menjadi hiasan: seseorang menulis layar baru, menyalin pola lama,
 * dan cacatnya kembali tanpa satu pun test merah. Karena itu suite ini
 * tidak menguji tampilan, melainkan INVARIAN SUMBER:
 *
 *   1. tidak ada layar yang memakai `KeyboardAvoidingView` langsung;
 *   2. komponen bersama benar-benar memberi Android `behavior`;
 *   3. setiap pemanggil menyatakan `varian` secara eksplisit;
 *   4. `varian` cocok dengan konteksnya — dialog di dalam <Modal>,
 *      layar di luar;
 *   5. setiap <Modal> berisi input dibungkus komponen ini;
 *   6. setiap ScrollView di layar berinput memakai prop papan ketik.
 *
 * KENAPA STRUKTURAL. `testEnvironment: 'node'` tanpa renderer React
 * Native: perilaku `KeyboardAvoidingView` yang sebenarnya hanya
 * muncul di perangkat. Yang bisa dijaga di sini justru yang paling
 * sering rusak — polanya.
 *
 * SATU KETERBATASAN YANG DIAKUI. Assertion di bawah membaca sumber
 * sebagai teks. Supaya prosa dokumentasi tidak pernah "lulus"
 * menggantikan kode, setiap pembacaan melewati `tanpaKomentar()`
 * lebih dulu.
 */

const AKAR = join(__dirname, '..');
const BERKAS_KOMPONEN = join(AKAR, 'components', 'AreaAmanKeyboard.tsx');

function tanpaKomentar(teks: string): string {
  return teks.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function berkasLayar(): string[] {
  const hasil: string[] = [];
  const jelajah = (dir: string) => {
    for (const nama of readdirSync(dir)) {
      const penuh = join(dir, nama);
      if (statSync(penuh).isDirectory()) jelajah(penuh);
      else if (nama.endsWith('.tsx')) hasil.push(penuh);
    }
  };
  jelajah(join(AKAR, 'screens'));
  return hasil;
}

const LAYAR = berkasLayar();
const SUMBER = new Map(LAYAR.map((f) => [f, tanpaKomentar(readFileSync(f, 'utf8'))]));

/** Penanda input teks yang dipakai di aplikasi ini. */
const PENANDA_INPUT = ['TextInput', 'CurrencyInput'];

function berisiInput(teks: string): boolean {
  return PENANDA_INPUT.some((p) => teks.includes(p));
}

/** Isi setiap <Modal ...> sampai </Modal> pasangannya. */
function blokModal(teks: string): { baris: number; isi: string }[] {
  const blok: { baris: number; isi: string }[] = [];
  const re = /<Modal\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(teks))) {
    const tutup = teks.indexOf('</Modal>', m.index);
    if (tutup < 0) continue;
    blok.push({ baris: teks.slice(0, m.index).split('\n').length, isi: teks.slice(m.index, tutup) });
  }
  return blok;
}

/** Tag pembuka <ScrollView ...> lengkap, sampai '>' penutupnya. */
function tagScrollView(teks: string): { baris: number; tag: string }[] {
  const hasil: { baris: number; tag: string }[] = [];
  const re = /<ScrollView\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(teks))) {
    const tutup = teks.indexOf('>', m.index);
    if (tutup < 0) continue;
    hasil.push({ baris: teks.slice(0, m.index).split('\n').length, tag: teks.slice(m.index, tutup) });
  }
  return hasil;
}

describe('RC-S110 — komponen bersama AreaAmanKeyboard', () => {
  const komponen = tanpaKomentar(readFileSync(BERKAS_KOMPONEN, 'utf8'));

  test('sisip dihitung di KOORDINAT JENDELA, bukan relatif induk', () => {
    // KOREKSI ATAS RC-S110. Diagnosis lamanya — "layar biasa aman
    // karena adjustResize" — SALAH untuk aplikasi ini: Expo SDK 54
    // menyalakan edge-to-edge sebagai bawaan, dan dalam mode itu
    // jendela TIDAK menyusut saat papan ketik muncul, jadi
    // adjustResize kehilangan efeknya. Karena itu masalahnya tersebar
    // di banyak layar, bukan hanya di dalam Modal.
    //
    // `KeyboardAvoidingView` bawaan juga tidak dipakai lagi: ia
    // menghitung `frame.y + frame.height - keyboardY` dengan `frame`
    // dari onLayout (RELATIF INDUK) dibanding `keyboardY` (koordinat
    // LAYAR) — dua sumbu berbeda, sehingga hasilnya kurang sebesar
    // tinggi header dan harus ditambal `keyboardVerticalOffset` manual
    // per layar.
    expect(komponen).toContain('measureInWindow');
    expect(komponen).toContain('e.endCoordinates.screenY');
    expect(komponen).toContain('const tumpang = y + tinggi - atasKeyboard;');
    // Pola lama yang inert di Android tidak boleh kembali.
    expect(komponen).not.toMatch(/behavior=\{Platform\.OS === 'ios' \? 'padding' : undefined\}/);
    expect(komponen).not.toContain('<KeyboardAvoidingView');
  });

  test('tumpang-tindih negatif tidak pernah jadi padding', () => {
    // Kalau jendela TERNYATA menyusut (tanpa edge-to-edge), tepi bawah
    // komponen sudah di atas papan ketik dan selisihnya negatif.
    // Memasangnya apa adanya akan menarik isi ke atas dua kali.
    // RC-S120: nilainya kini dibulatkan ke dp utuh (lihat komponen);
    // aturan "negatif -> 0" tidak berubah.
    expect(komponen).toContain('setSisipBawah(tumpang > 0 ? Math.round(tumpang + offsetVertikal) : 0)');
  });

  test('pengukuran yang belum siap diabaikan, bukan dipakai', () => {
    // measureInWindow bisa menjawab 0/NaN saat komponen belum
    // ter-layout; padding raksasa jauh lebih buruk daripada tidak ada.
    expect(komponen).toContain('if (!Number.isFinite(y) || !Number.isFinite(tinggi) || tinggi <= 0) return;');
  });

  test('nama event papan ketik dipilih per platform', () => {
    // 'keyboardWillShow' tidak pernah terpicu di Android; memakainya
    // di sana berarti komponen ini diam saja.
    expect(komponen).toContain("Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'");
    expect(komponen).toContain("Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'");
  });

  test('semua listener dilepas saat komponen dilepas', () => {
    // 67 layar memakai komponen ini; listener yang tertinggal
    // menumpuk setiap kali layar dibuka-tutup.
    for (const l of ['muncul.remove()', 'berubah.remove()', 'hilang.remove()']) {
      expect(komponen).toContain(l);
    }
  });

  test('varian wajib, tanpa nilai bawaan yang bisa ditebak salah', () => {
    // `varian` tanpa tanda tanya => TypeScript menolak pemanggil yang
    // tidak menyatakan konteksnya. Itu yang mencegah pilihan perilaku
    // ditebak dari bentuk pohon komponen.
    expect(komponen).toMatch(/varian:\s*VarianAreaKeyboard;/);
    expect(komponen).not.toMatch(/varian\?\s*:/);
    expect(komponen).toMatch(/export type VarianAreaKeyboard = 'dialog' \| 'layar';/);
  });

  test('prop ScrollView disediakan sebagai objek, bukan sekadar anjuran', () => {
    expect(komponen).toContain("keyboardShouldPersistTaps: 'handled'");
    expect(komponen).toContain("keyboardDismissMode: 'on-drag'");
    expect(komponen).toContain('automaticallyAdjustKeyboardInsets: true');
    expect(komponen).toMatch(/export const PROP_SCROLL_FORM = \{/);
  });
});

describe('RC-S110 — invarian di seluruh layar', () => {
  test('tidak ada layar yang memakai KeyboardAvoidingView langsung', () => {
    const pelanggar = [...SUMBER].filter(([, t]) => t.includes('KeyboardAvoidingView')).map(([f]) => f);
    expect(pelanggar).toEqual([]);
  });

  test('komponen bersama benar-benar dipakai, bukan cuma ada', () => {
    const pemakai = [...SUMBER].filter(([, t]) => t.includes('<AreaAmanKeyboard')).map(([f]) => f);
    // Sisi kebalikannya: assertion di atas juga lulus kalau seluruh
    // pemakaian DIHAPUS. Karena itu jumlah pemakai dijaga tidak susut.
    // RC-S113: seluruh layar berinput dibungkus, bukan hanya yang
    // kebetulan sudah memakai KeyboardAvoidingView dulu.
    expect(pemakai.length).toBeGreaterThanOrEqual(67);
  });

  test('setiap pemakaian menyatakan varian secara eksplisit', () => {
    const tanpaVarian: string[] = [];
    for (const [f, t] of SUMBER) {
      const re = /<AreaAmanKeyboard\b/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(t))) {
        const tag = t.slice(m.index, t.indexOf('>', m.index));
        if (!/varian="(dialog|layar)"/.test(tag)) tanpaVarian.push(`${f}:${t.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(tanpaVarian).toEqual([]);
  });

  test('varian cocok dengan konteksnya: dialog di dalam Modal, layar di luar', () => {
    const salah: string[] = [];
    for (const [f, t] of SUMBER) {
      const dalamModal = new Set<number>();
      for (const { isi, baris } of blokModal(t)) {
        const re = /<AreaAmanKeyboard\b/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(isi))) dalamModal.add(baris + isi.slice(0, m.index).split('\n').length - 1);
      }
      const re = /<AreaAmanKeyboard\b/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(t))) {
        const baris = t.slice(0, m.index).split('\n').length;
        const tag = t.slice(m.index, t.indexOf('>', m.index));
        const diharapkan = dalamModal.has(baris) ? 'dialog' : 'layar';
        if (!tag.includes(`varian="${diharapkan}"`)) salah.push(`${f}:${baris} seharusnya ${diharapkan}`);
      }
    }
    expect(salah).toEqual([]);
  });

  test('setiap Modal berisi input dibungkus AreaAmanKeyboard', () => {
    // Justru di sini cacatnya paling nyata: <Modal> dirender di jendela
    // terpisah yang TIDAK ikut adjustResize, jadi input di dalamnya
    // tidak bisa digulir sama sekali saat tertutup.
    const telanjang: string[] = [];
    for (const [f, t] of SUMBER) {
      for (const { isi, baris } of blokModal(t)) {
        if (!berisiInput(isi)) continue;
        if (!isi.includes('<AreaAmanKeyboard')) telanjang.push(`${f}:${baris}`);
      }
    }
    expect(telanjang).toEqual([]);
  });

  test('setiap ScrollView di layar berinput memakai prop papan ketik', () => {
    // Tanpa keyboardShouldPersistTaps, menekan Simpan saat papan ketik
    // terbuka hanya menutup papan ketik — tombolnya harus ditekan dua
    // kali, keluhan yang mudah disalahartikan sebagai tombol rusak.
    const kurang: string[] = [];
    for (const [f, t] of SUMBER) {
      if (!berisiInput(t)) continue;
      for (const { tag, baris } of tagScrollView(t)) {
        if (!tag.includes('keyboardShouldPersistTaps') && !tag.includes('PROP_SCROLL_FORM')) {
          kurang.push(`${f}:${baris}`);
        }
      }
    }
    expect(kurang).toEqual([]);
  });
});

describe('RC-S113 — SETIAP layar berinput dibungkus, bukan sebagian', () => {
  /**
   * Ini invarian terpenting dari seluruh berkas ini.
   *
   * RC-S110 hanya membungkus 19 layar — yang kebetulan sudah memakai
   * `KeyboardAvoidingView` sebelumnya. Dasarnya keliru: saya
   * menganggap layar lain aman karena `adjustResize`. Dalam mode
   * edge-to-edge (bawaan Expo SDK 54) jendela tidak menyusut sama
   * sekali, jadi layar yang tidak dibungkus TIDAK punya perlindungan
   * apa pun — persis yang dilaporkan pengguna di Tarik Simpanan
   * Anggota.
   *
   * Karena itu yang dijaga di sini bukan "ada 19 layar terbungkus",
   * melainkan "TIDAK ADA satu pun layar berinput yang tertinggal".
   * Layar baru yang lupa dibungkus langsung membuat test ini merah.
   */
  const PENANDA_INPUT = ['TextInput', 'CurrencyInput'];

  const layarBerinput = [...SUMBER].filter(([, t]) => PENANDA_INPUT.some((p) => t.includes(p)));

  test('daftar layar berinput tidak kosong (penjaga bagi penjaganya)', () => {
    // Kalau pendeteksiannya rusak, larik kosong akan membuat test di
    // bawah lulus tanpa memeriksa apa pun.
    expect(layarBerinput.length).toBeGreaterThanOrEqual(60);
  });

  test('tidak ada layar berinput tanpa AreaAmanKeyboard', () => {
    const telanjang = layarBerinput.filter(([, t]) => !t.includes('<AreaAmanKeyboard')).map(([f]) => f);
    expect(telanjang).toEqual([]);
  });

  test('pembungkus layar memberi tinggi penuh, kalau tidak padding tak berefek', () => {
    // `paddingBottom` pada wadah yang tingginya mengikuti isi tidak
    // menggeser apa pun. Wadahnya harus mengambil tinggi penuh.
    const kurang: string[] = [];
    for (const [f, t] of layarBerinput) {
      for (const m of t.matchAll(/<AreaAmanKeyboard varian="layar"([^>]*)>/g)) {
        if (!/style=/.test(m[1])) kurang.push(f);
      }
    }
    expect(kurang).toEqual([]);
  });
});

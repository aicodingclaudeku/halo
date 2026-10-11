/**
 * ============================================================
 * RC-S120 — AUDIT PAPAN KETIK MENUTUPI FORM
 * ============================================================
 *
 * Temuan audit yang dijaga suite ini (semuanya terbukti dari sumber,
 * bukan dugaan):
 *
 *  1. Menyusutkan ScrollView saja tidak menggulir input yang difokuskan
 *     ke atas papan ketik. `AreaAmanKeyboard` kini menggulirnya sendiri,
 *     dihitung dari posisi nyata (§1, §2).
 *
 *  2. Dialog yang kartunya `maxHeight` TANPA ScrollView di dalamnya
 *     (Terima Pembayaran di Bagian SHU, dll.) meluberkan isi ke belakang
 *     papan ketik — tombol Simpan tidak dapat dijangkau sama sekali (§4).
 *
 *  3. Sensus RC-S113 hanya mencari teks `TextInput`/`CurrencyInput`,
 *     sehingga LockScreen dan Pengaturan (PinInput) serta picker bersama
 *     (SearchField, di components/) lolos tanpa perlindungan (§3).
 *
 *  4. `SafeAreaView edges={['bottom']}` di DALAM pembungkus menambah
 *     tinggi bilah navigasi dua kali saat papan ketik terbuka (§5).
 *
 * Seperti suite RC-S110, pembacaan sumber melewati `tanpaKomentar()`
 * supaya prosa dokumentasi tidak pernah "lulus" menggantikan kode.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  hitungGeserGulir,
  hitungTujuanGulir,
  JARAK_LEGA_INPUT,
  JEDA_LEPAS_PADDING_MS,
  JEDA_UKUR_ULANG_MS,
} from '@/components/hitungAreaKeyboard';

const AKAR = join(__dirname, '..');

function tanpaKomentar(teks: string): string {
  return teks.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function berkasTsx(dir: string): string[] {
  const hasil: string[] = [];
  const jelajah = (d: string) => {
    for (const nama of readdirSync(d)) {
      const penuh = join(d, nama);
      if (statSync(penuh).isDirectory()) jelajah(penuh);
      else if (nama.endsWith('.tsx')) hasil.push(penuh);
    }
  };
  jelajah(dir);
  return hasil;
}

const KOMPONEN = tanpaKomentar(readFileSync(join(AKAR, 'components', 'AreaAmanKeyboard.tsx'), 'utf8'));
const LAYAR = new Map(berkasTsx(join(AKAR, 'screens')).map((f) => [f, tanpaKomentar(readFileSync(f, 'utf8'))]));
const KOMPONEN_LAIN = new Map(
  berkasTsx(join(AKAR, 'components'))
    .filter((f) => !f.endsWith('AreaAmanKeyboard.tsx'))
    .map((f) => [f, tanpaKomentar(readFileSync(f, 'utf8'))]),
);
const SEMUA = new Map([...LAYAR, ...KOMPONEN_LAIN]);
const nama = (f: string) => relative(AKAR, f);

/**
 * Sisa komentar JSX setelah `tanpaKomentar()`: `{/* ... *\/}` menjadi `{}`.
 * Pola yang mencocokkan dua tag berurutan harus mengizinkannya, kalau
 * tidak, menambah satu komentar penjelas saja sudah memerahkan test.
 */
const SELA = String.raw`\s*(?:\{\s*\}\s*)*`;

/** Semua penanda input yang ada di aplikasi ini — bukan hanya dua. */
const PENANDA_INPUT = /<(TextInput|CurrencyInput|PinInput|SearchField|AppTextInput|FocusTextInput)\b/;

/** Isi setiap blok <Tag ...> ... </Tag> dengan pasangan penutup yang benar (bersarang). */
function blok(teks: string, tag: string): { baris: number; buka: string; isi: string }[] {
  const hasil: { baris: number; buka: string; isi: string }[] = [];
  const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'g');
  const tumpukan: { mulai: number; akhirBuka: number; buka: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(teks))) {
    if (m[1]) {
      const b = tumpukan.pop();
      if (b) {
        hasil.push({
          baris: teks.slice(0, b.mulai).split('\n').length,
          buka: b.buka,
          isi: teks.slice(b.akhirBuka, m.index),
        });
      }
    } else if (!m[2]) {
      tumpukan.push({ mulai: m.index, akhirBuka: m.index + m[0].length, buka: m[0] });
    }
  }
  return hasil;
}

// ============================================================
// §1 — MATEMATIKA GULIR (nilai sungguhan)
// ============================================================
describe('RC-S120 §1 — hitungGeserGulir', () => {
  // Skenario: layar 800 dp, header 80 dp, papan ketik 300 dp (atas di 500).
  const wadahSudahSusut = { y: 80, tinggi: 420 }; // bawah = 500 = atas papan ketik

  test('input yang sudah terlihat tidak digulir', () => {
    expect(hitungGeserGulir({ input: { y: 200, tinggi: 48 }, wadah: wadahSudahSusut, atasKeyboard: 500 })).toBe(0);
  });

  test('input di bawah tepi terlihat digulir tepat secukupnya + jarak lega', () => {
    // Bawah input 620; batas terlihat 500 - 16 = 484 -> geser 136.
    expect(hitungGeserGulir({ input: { y: 572, tinggi: 48 }, wadah: wadahSudahSusut, atasKeyboard: 500 })).toBe(
      572 + 48 - (500 - JARAK_LEGA_INPUT),
    );
  });

  test('batas terlihat adalah yang LEBIH TINGGI dari tepi wadah dan tepi papan ketik', () => {
    // Padding belum terpasang: wadah masih sampai 800, papan ketik di 500.
    const wadahBelumSusut = { y: 80, tinggi: 720 };
    expect(hitungGeserGulir({ input: { y: 460, tinggi: 48 }, wadah: wadahBelumSusut, atasKeyboard: 500 })).toBe(
      460 + 48 - (500 - JARAK_LEGA_INPUT),
    );
    // Sebaliknya: wadah pendek (dialog), papan ketik jauh di bawah.
    const wadahPendek = { y: 100, tinggi: 200 }; // bawah 300
    expect(hitungGeserGulir({ input: { y: 280, tinggi: 40 }, wadah: wadahPendek, atasKeyboard: 700 })).toBe(
      280 + 40 - (300 - JARAK_LEGA_INPUT),
    );
  });

  test('input bertingkat yang lebih tinggi dari ruang: awal teksnya yang dipertahankan', () => {
    // Input 300 dp dimulai di y 150; ruang atas hanya 150 - (80 + 16) = 54.
    const geser = hitungGeserGulir({ input: { y: 150, tinggi: 300 }, wadah: wadahSudahSusut, atasKeyboard: 400 });
    expect(geser).toBe(150 - (80 + JARAK_LEGA_INPUT));
  });

  test('pengukuran yang belum siap tidak pernah menghasilkan gulir', () => {
    for (const input of [
      { y: NaN, tinggi: 48 },
      { y: 600, tinggi: 0 },
      { y: 600, tinggi: NaN },
    ]) {
      expect(hitungGeserGulir({ input, wadah: wadahSudahSusut, atasKeyboard: 500 })).toBe(0);
    }
    expect(hitungGeserGulir({ input: { y: 600, tinggi: 48 }, wadah: { y: 0, tinggi: 0 }, atasKeyboard: 500 })).toBe(0);
    expect(hitungGeserGulir({ input: { y: 600, tinggi: 48 }, wadah: wadahSudahSusut, atasKeyboard: NaN })).toBe(0);
  });
});

describe('RC-S120 §1 — hitungTujuanGulir', () => {
  test('tujuan = posisi gulir sekarang + geser, diturunkan tanpa membaca offset', () => {
    // Input di y 572 jendela, wadah mulai 80 -> 492 dari atas wadah.
    // Di dalam isi ia di 692 -> isi sudah tergulir 200.
    expect(
      hitungTujuanGulir({ yDalamIsi: 692, input: { y: 572, tinggi: 48 }, wadah: { y: 80, tinggi: 420 }, geser: 136 }),
    ).toBe(200 + 136);
  });

  test('tanpa geser tidak ada tujuan, dan tujuan tidak pernah negatif', () => {
    expect(hitungTujuanGulir({ yDalamIsi: 100, input: { y: 180, tinggi: 40 }, wadah: { y: 80, tinggi: 400 }, geser: 0 })).toBeNull();
    expect(
      hitungTujuanGulir({ yDalamIsi: 0, input: { y: 500, tinggi: 40 }, wadah: { y: 80, tinggi: 400 }, geser: 10 }),
    ).toBe(0);
  });
});

describe('RC-S120 §1 — jeda anti-loncat masuk akal', () => {
  test('jeda cukup pendek untuk tidak terasa, cukup panjang untuk menyerap buka-tutup cepat', () => {
    expect(JEDA_LEPAS_PADDING_MS).toBeGreaterThanOrEqual(50);
    expect(JEDA_LEPAS_PADDING_MS).toBeLessThanOrEqual(250);
    expect(JEDA_UKUR_ULANG_MS).toBeGreaterThan(0);
    expect(JEDA_UKUR_ULANG_MS).toBeLessThanOrEqual(400);
  });
});

// ============================================================
// §2 — KOMPONEN BERSAMA
// ============================================================
describe('RC-S120 §2 — AreaAmanKeyboard menggulir ke input yang difokuskan', () => {
  test('input yang fokus diukur dan ScrollView pemiliknya digulir', () => {
    expect(KOMPONEN).toContain('currentlyFocusedInput');
    expect(KOMPONEN).toMatch(/input\.measureLayout\(\s*isi,/);
    expect(KOMPONEN).toContain('getInnerViewRef');
    expect(KOMPONEN).toContain('getNativeScrollRef');
    expect(KOMPONEN).toMatch(/hitungGeserGulir\(\{ input: kotakInput, wadah: kotakWadah, atasKeyboard \}\)/);
    expect(KOMPONEN).toMatch(/sv\.scrollTo\(\{ y: tujuan, animated: true \}\)/);
  });

  test('gulir dijadwalkan SETELAH padding terpasang, lalu diulang sekali', () => {
    expect(KOMPONEN).toMatch(/terapkanSisip\(atasKeyboard, \(\) => \{[\s\S]*?requestAnimationFrame\(gulirKeInputFokus\)/);
    expect(KOMPONEN).toMatch(/setTimeout\([\s\S]*?terapkanSisip\(atasKeyboardRef\.current, gulirKeInputFokus\)[\s\S]*?JEDA_UKUR_ULANG_MS\)/);
  });

  test('FlatList/SectionList diturunkan ke ScrollView di dalamnya', () => {
    expect(KOMPONEN).toContain("typeof wadah.getScrollResponder === 'function' ? wadah.getScrollResponder() : wadah");
    expect(KOMPONEN).toMatch(/new Set<unknown>\(\[ScrollView, FlatList, SectionList\]\)/);
  });

  test('ref milik pemanggil tetap diteruskan, dan callback ref stabil per urutan', () => {
    expect(KOMPONEN).toContain('teruskanRef(refAsli.current[urutan], instans)');
    expect(KOMPONEN).toMatch(/if \(!pemasang\.current\[urutan\]\)/);
    expect(KOMPONEN).toContain('refUntuk(urutanWadah++, el.props?.ref)');
  });

  test('komponen menyambungkan jenis wadah dan pengecualian yang benar ke penelusur', () => {
    expect(KOMPONEN).toContain('const adalahWadah = (jenis: unknown) => JENIS_WADAH_GULIR.has(jenis);');
    expect(KOMPONEN).toContain('const lewati = (jenis: unknown) => jenis === Modal || jenis === AreaAmanKeyboard;');
    expect(KOMPONEN).toMatch(/sematkanWadahGulir\(children, \{\s*adalahWadah,\s*lewati,/);
  });

  test('padding dibulatkan ke dp utuh supaya pengukuran ulang tidak me-render tanpa akhir', () => {
    expect(KOMPONEN).toContain('Math.round(tumpang + offsetVertikal)');
  });
});

// ============================================================
// §2b — PENELUSUR WADAH GULIR, DIUJI DENGAN ELEMEN REACT SUNGGUHAN
// ============================================================
describe('RC-S120 §2b — sematkanWadahGulir (perilaku)', () => {
  // `require` supaya berkas test ini tetap .ts tanpa JSX.
  const React = require('react') as typeof import('react');
  const { sematkanWadahGulir } = require('@/components/telusuriWadahGulir') as typeof import('@/components/telusuriWadahGulir');
  const h = React.createElement;

  const Gulir = (_p: any) => null;
  const Modal = (_p: any) => null;
  const Kotak = (_p: any) => null;
  const Teks = (_p: any) => null;

  function jalankan(node: any) {
    const dipasang: any[] = [];
    const hasil = sematkanWadahGulir(node, {
      adalahWadah: (t) => t === Gulir,
      lewati: (t) => t === Modal,
      pasang: (el) => {
        dipasang.push(el);
        return React.cloneElement(el, { 'data-tersemat': true } as any);
      },
    });
    return { hasil: hasil as any, dipasang };
  }

  test('pohon tanpa wadah dikembalikan sebagai objek yang SAMA', () => {
    const pohon = h(Kotak, null, h(Teks, null, 'a'), h(Teks, null, 'b'));
    const { hasil, dipasang } = jalankan(pohon);
    expect(hasil).toBe(pohon);
    expect(dipasang).toHaveLength(0);
  });

  test('wadah bersarang ditemukan; saudara-saudaranya tetap objek yang sama', () => {
    const kepala = h(Teks, null, 'kepala');
    const kaki = h(Teks, null, 'kaki');
    const pohon = h(Kotak, null, kepala, h(Gulir, null, h(Teks, null, 'isi')), kaki);
    const { hasil, dipasang } = jalankan(pohon);
    expect(dipasang).toHaveLength(1);
    const anak = hasil.props.children;
    expect(Array.isArray(anak)).toBe(true);
    expect(anak).toHaveLength(3);
    expect(anak[0]).toBe(kepala);
    expect(anak[2]).toBe(kaki);
    expect(anak[1].props['data-tersemat']).toBe(true);
  });

  test('salinan di dalam larik diberi key per posisi; key yang sudah ada dipertahankan', () => {
    const tanpaKey = jalankan(h(Kotak, null, h(Teks, null), h(Gulir, null))).hasil.props.children;
    expect(tanpaKey[1].key).toBe('wadah-gulir-1');
    expect(tanpaKey[0].key).toBeNull();
    const berKey = jalankan(h(Kotak, null, h(Teks, null), h(Gulir, { key: 'milikku' }))).hasil.props.children;
    expect(berKey[1].key).toBe('milikku');
  });

  test('anak tunggal tetap anak tunggal, bukan larik', () => {
    const { hasil } = jalankan(h(Kotak, null, h(Gulir, null)));
    expect(Array.isArray(hasil.props.children)).toBe(false);
    expect(hasil.props.children.props['data-tersemat']).toBe(true);
  });

  test('Modal tidak ditelusuri', () => {
    const pohon = h(Kotak, null, h(Modal, null, h(Gulir, null)));
    const { hasil, dipasang } = jalankan(pohon);
    expect(dipasang).toHaveLength(0);
    expect(hasil).toBe(pohon);
  });

  test('ScrollView horizontal dilewati, dan isi wadah tidak ditelusuri', () => {
    expect(jalankan(h(Gulir, { horizontal: true }, h(Gulir, null))).dipasang).toHaveLength(0);
    // Wadah di dalam wadah: hanya yang terluar.
    expect(jalankan(h(Gulir, null, h(Gulir, null))).dipasang).toHaveLength(1);
  });

  test('beberapa wadah bersaudara semuanya ditemukan, berurutan', () => {
    const { dipasang } = jalankan(h(Kotak, null, h(Gulir, { id: 1 }), h(Kotak, null, h(Gulir, { id: 2 }))));
    expect(dipasang.map((e) => e.props.id)).toEqual([1, 2]);
  });

  test('anak berupa fungsi (render prop) tidak disentuh', () => {
    const fn = () => null;
    const pohon = h(Kotak, null, fn as any);
    expect(jalankan(pohon).hasil).toBe(pohon);
  });

  test('React 19: ref pemanggil terbaca di el.props.ref — asumsi yang dipakai komponen', () => {
    const r = { current: null };
    const { dipasang } = jalankan(h(Kotak, null, h(Gulir, { ref: r })));
    expect(dipasang[0].props.ref).toBe(r);
  });
});

describe('RC-S120 §2 — modul penelusur tetap murni dan tanpa Children.map', () => {
  const PENELUSUR = tanpaKomentar(readFileSync(join(AKAR, 'components', 'telusuriWadahGulir.ts'), 'utf8'));
  test('tidak mengimpor react-native, dan tidak memakai Children.map', () => {
    expect(PENELUSUR).not.toMatch(/from 'react-native'/);
    expect(PENELUSUR).not.toContain('Children.map');
  });
});

describe('RC-S120 §2 — tanpa loncatan dan tanpa padding ganda', () => {
  test('padding dilepas dengan jeda, dan jeda itu batal kalau papan ketik muncul lagi', () => {
    expect(KOMPONEN).toMatch(/Keyboard\.addListener\(namaHilang, \(\) => \{[\s\S]*?setTimeout\([\s\S]*?setSisipBawah\(0\)[\s\S]*?JEDA_LEPAS_PADDING_MS\)/);
    // ukurDanGulir membersihkan timer -> jeda lepas yang tertunda batal.
    expect(KOMPONEN).toMatch(/const ukurDanGulir = useCallback\([\s\S]*?bersihkanTimer\(\);/);
    expect(KOMPONEN).toContain('if (timerLepas.current) clearTimeout(timerLepas.current);');
  });

  test('seluruh timer & frame dibersihkan saat komponen dilepas', () => {
    expect(KOMPONEN).toMatch(/hilang\.remove\(\);\s*bersihkanTimer\(\);/);
    expect(KOMPONEN).toContain('cancelAnimationFrame(bingkai.current)');
  });

  test('papan ketik yang SUDAH terbuka saat dipasang tetap ditangani', () => {
    expect(KOMPONEN).toMatch(/const saatLayout = useCallback\([\s\S]*?Keyboard\.isVisible\(\)[\s\S]*?Keyboard\.metrics\(\)/);
    expect(KOMPONEN).toContain('onLayout={saatLayout}');
  });

  test('layar di belakang dialog yang terbuka tidak ikut menambah padding', () => {
    expect(KOMPONEN).toContain("varian === 'dialog' || jumlahDialogTerpasang === 0");
    expect(KOMPONEN).toMatch(/if \(varian !== 'dialog'\) return;\s*jumlahDialogTerpasang \+= 1;/);
    expect(KOMPONEN).toContain('jumlahDialogTerpasang -= 1;');
    expect(KOMPONEN).toMatch(/const hitungSisip = useCallback\([\s\S]*?if \(!bolehBereaksi\(\)\) return;/);
  });

  test('SafeAreaBawahAman melepas inset bawah selama papan ketik terbuka', () => {
    expect(KOMPONEN).toContain("edges={sisipBawah > 0 ? [] : ['bottom']}");
    expect(KOMPONEN).toMatch(/export function SafeAreaBawahAman/);
  });

  test('API lama tidak berubah', () => {
    expect(KOMPONEN).toMatch(/export default function AreaAmanKeyboard\(\{\s*varian,\s*style,\s*offsetVertikal = 0,\s*children,\s*\}: AreaAmanKeyboardProps\)/);
    expect(KOMPONEN).toMatch(/export const PROP_SCROLL_FORM = \{/);
    expect(KOMPONEN).toMatch(/export const RUANG_BAWAH_FORM = 120;/);
  });
});

// ============================================================
// §3 — SENSUS YANG TIDAK BOLONG
// ============================================================
describe('RC-S120 §3 — setiap input terlindungi, termasuk PinInput dan picker bersama', () => {
  test('setiap Modal berinput — di screens/ DAN components/ — dibungkus', () => {
    const telanjang: string[] = [];
    for (const [f, t] of SEMUA) {
      for (const { isi, baris } of blok(t, 'Modal')) {
        if (PENANDA_INPUT.test(isi) && !isi.includes('<AreaAmanKeyboard')) telanjang.push(`${nama(f)}:${baris}`);
      }
    }
    expect(telanjang).toEqual([]);
  });

  test('setiap layar ber-PinInput dibungkus', () => {
    const berPin = [...LAYAR].filter(([, t]) => /<PinInput\b/.test(t));
    // Penjaga bagi penjaganya: LockScreen dan Keamanan (dulu Pengaturan) harus terdeteksi.
    expect(berPin.map(([f]) => nama(f)).sort()).toEqual(
      // RC-S121 — PinInput pindah dari PengaturanScreen ke KeamananScreen.
      ['screens/Pengaturan/KeamananScreen.tsx', 'screens/Setup/LockScreen.tsx'].sort(),
    );
    expect(berPin.filter(([, t]) => !t.includes('<AreaAmanKeyboard')).map(([f]) => nama(f))).toEqual([]);
  });

  test('LockScreen: tombol di bawah PIN dapat digulir ke atas papan ketik', () => {
    const t = LAYAR.get(join(AKAR, 'screens', 'Setup', 'LockScreen.tsx'))!;
    expect(t).toMatch(/<AreaAmanKeyboard varian="layar" style=\{styles\.flex\}>\s*<ScrollView \{\.\.\.PROP_SCROLL_FORM\}/);
    // Tata letak tengah pindah ke isi gulir, bukan lagi di kontainer.
    expect(t).toMatch(/isi: \{ flexGrow: 1, justifyContent: 'center'/);
    expect(t).not.toMatch(/container: \{[^}]*justifyContent/);
  });

  test('lima picker bersama berinput membungkus isi Modal-nya', () => {
    const picker = ['AnggotaPicker', 'AnggotaPiutangPicker', 'PinjamanPicker', 'DataReferensiPicker', 'AccountPicker'];
    for (const p of picker) {
      const t = KOMPONEN_LAIN.get(join(AKAR, 'components', `${p}.tsx`))!;
      // Di DALAM SafeAreaView: tepi bawahnya sudah di atas bilah navigasi.
      const pola = new RegExp(`<SafeAreaView[^>]*>${SELA}<AreaAmanKeyboard varian="dialog" style=\\{\\{ flex: 1 \\}\\}>`);
      expect({ p, ok: pola.test(t) }).toEqual({ p, ok: true });
    }
  });

  test('jumlah layar terbungkus tidak susut', () => {
    const pemakai = [...LAYAR].filter(([, t]) => t.includes('<AreaAmanKeyboard'));
    expect(pemakai.length).toBeGreaterThanOrEqual(70);
  });
});

// ============================================================
// §4 — DIALOG BERINPUT HARUS PUNYA WADAH GULIR
// ============================================================
describe('RC-S120 §4 — dialog berinput selalu dapat digulir', () => {
  test('setiap AreaAmanKeyboard dialog berinput memuat ScrollView/FlatList', () => {
    // Tanpa wadah gulir, padding hanya MENDORONG kartu; kartu ber-maxHeight
    // lalu meluberkan isinya ke belakang papan ketik tanpa jalan kembali.
    // Kasus nyata: "Terima Pembayaran" di Bagian SHU.
    const tanpaGulir: string[] = [];
    for (const [f, t] of SEMUA) {
      for (const { buka, isi, baris } of blok(t, 'AreaAmanKeyboard')) {
        if (!buka.includes('varian="dialog"')) continue;
        if (!PENANDA_INPUT.test(isi) && !/\{children\}/.test(isi)) continue;
        if (!/<(ScrollView|FlatList|SectionList)\b/.test(isi)) tanpaGulir.push(`${nama(f)}:${baris}`);
      }
    }
    expect(tanpaGulir).toEqual([]);
  });

  test('kasus yang ditemukan audit memang sudah diberi ScrollView di dalam kartunya', () => {
    const KARTU = String.raw`<View style=\{styles\.modalCard\}>`;
    const kartu: [string, string][] = [
      ['screens/Transaksi/BagianShuFormScreen.tsx', String.raw`${KARTU}${SELA}<ScrollView keyboardShouldPersistTaps="handled">${SELA}<Text style=\{styles\.modalJudul\}>Terima Pembayaran`],
      ['screens/Transaksi/InvestasiFormScreen.tsx', String.raw`${KARTU}${SELA}<ScrollView keyboardShouldPersistTaps="handled">${SELA}<Text style=\{styles\.modalTitle\}>Konfirmasi Perubahan Investasi`],
      ['screens/Pengaturan/BackupRestoreScreen.tsx', String.raw`${KARTU}${SELA}<ScrollView \{\.\.\.PROP_SCROLL_FORM\}>`],
      ['screens/Pajak/RiwayatPajakScreen.tsx', String.raw`<ScrollView keyboardShouldPersistTaps="handled">${SELA}<View style=\{styles\.lembarIsi\}>`],
    ];
    for (const [f, pola] of kartu) {
      expect({ f, ok: new RegExp(pola).test(SEMUA.get(join(AKAR, f))!) }).toEqual({ f, ok: true });
    }
  });
});

// ============================================================
// §5 — TIDAK ADA INSET BAWAH GANDA
// ============================================================
describe('RC-S120 §5 — inset bawah tidak dihitung dua kali', () => {
  test('tidak ada SafeAreaView ber-inset bawah di DALAM AreaAmanKeyboard', () => {
    // Padding AreaAmanKeyboard sudah mencakup area bilah navigasi (papan
    // ketik duduk di atasnya). Inset bawah di dalamnya = celah ganda.
    //
    // <Modal> yang BERSARANG di dalam pembungkus dikecualikan: isinya
    // dirender di jendela dialog tersendiri, sehingga padding pembungkus
    // di luarnya sama sekali tidak berlaku padanya.
    const ganda: string[] = [];
    for (const [f, t] of SEMUA) {
      for (const { isi, baris } of blok(t, 'AreaAmanKeyboard')) {
        let tanpaModal = isi;
        for (const m of blok(isi, 'Modal')) tanpaModal = tanpaModal.replace(m.isi, '');
        if (/<SafeAreaView\b[^>]*edges=\{\[[^\]]*'bottom'/.test(tanpaModal)) ganda.push(`${nama(f)}:${baris}`);
      }
    }
    expect(ganda).toEqual([]);
  });

  test('penjaga bagi penjaganya: pola inset ganda memang terdeteksi bila ada', () => {
    const contoh = `<AreaAmanKeyboard varian="dialog" style={s}><View><SafeAreaView edges={['bottom']} style={x}></SafeAreaView></View></AreaAmanKeyboard>`;
    const [b] = blok(contoh, 'AreaAmanKeyboard');
    expect(/<SafeAreaView\b[^>]*edges=\{\[[^\]]*'bottom'/.test(b.isi)).toBe(true);
  });

  test('lembar Riwayat Pajak memakai SafeAreaBawahAman dan tidak melebihi ruang di atas papan ketik', () => {
    const t = LAYAR.get(join(AKAR, 'screens', 'Pajak', 'RiwayatPajakScreen.tsx'))!;
    expect(t).toContain('<SafeAreaBawahAman style={styles.lembar}>');
    expect(t).toMatch(/lembar: \{[^}]*maxHeight: '100%'/);
  });
});

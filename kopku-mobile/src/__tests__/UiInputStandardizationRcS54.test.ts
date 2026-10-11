import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * UI/UX INPUT STANDARDIZATION — KONTRAK STATIK PRESENTASI.
 *
 * Menutup gap terakhir UI_UX_FINAL_POLISH: 110 `<TextInput>` polos di
 * 54 berkas yang belum punya focus state. Seluruh assertion di sini
 * HANYA tentang tampilan input (fokus, nonaktif, error, multiline,
 * pencarian) dan tentang komponen presentasi yang TIDAK mengambil alih
 * perilaku. Tidak ada assertion akuntansi, jurnal, skema, atau lisensi.
 *
 * Statik (membaca sumber, bukan me-render) karena environment test tidak
 * punya react-native testing library — keterbatasan yang sama dengan
 * suite UI sebelumnya.
 */
const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (s: string) =>
  s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');

function berkasTsx(dir: string, hasil: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === '__tests__' || e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) berkasTsx(p, hasil);
    else if (e.endsWith('.tsx')) hasil.push(p);
  }
  return hasil;
}
const rel = (p: string) => p.slice(ROOT.length + 1);
const LAYAR = berkasTsx(join(ROOT, 'src/screens'));
const KOMPONEN = berkasTsx(join(ROOT, 'src/components'));
const SEMUA_UI = [...LAYAR, ...KOMPONEN];

/** Komponen yang BOLEH merender `<TextInput>` mentah — semuanya ber-focus state. */
const PEMBUNGKUS_INPUT = [
  'src/components/AppTextInput.tsx',
  'src/components/CurrencyInput.tsx',
  'src/components/FocusTextInput.tsx',
  'src/components/SearchField.tsx',
  'src/components/PinInput.tsx',
];

/** Ambil seluruh elemen `<Tag ... />` (self-closing) dari sumber. */
function elemen(s: string, tag: string): string[] {
  const hasil: string[] = [];
  const re = new RegExp(`<${tag}\\b([\\s\\S]*?)/>`, 'g');
  for (const m of s.matchAll(re)) hasil.push(m[1]);
  return hasil;
}

// ---------------------------------------------------------------------
// 1. CAKUPAN — tidak ada lagi TextInput polos
// ---------------------------------------------------------------------
describe('Cakupan — setiap input memakai komponen ber-focus state', () => {
  it('tidak ada <TextInput> mentah di layar mana pun', () => {
    const pelanggar = LAYAR.filter((p) => /<TextInput\b/.test(strip(readFileSync(p, 'utf8')))).map(rel);
    expect(pelanggar).toEqual([]);
  });

  it('di src/components, <TextInput> mentah hanya ada di dalam pembungkus input', () => {
    const pelanggar = KOMPONEN.filter((p) => /<TextInput\b/.test(strip(readFileSync(p, 'utf8'))))
      .map(rel)
      .filter((r) => !PEMBUNGKUS_INPUT.includes(r));
    expect(pelanggar).toEqual([]);
  });

  it.each(PEMBUNGKUS_INPUT.map((f) => [f]))('%s punya status fokus visual', (f) => {
    const s = strip(baca(f));
    expect(s).toMatch(/const \[fokus, setFokus\] = useState\(false\)/);
    expect(s).toMatch(/setFokus\(true\)/);
    expect(s).toMatch(/setFokus\(false\)/);
  });

  it('jumlah input yang dimigrasikan tidak menyusut diam-diam (90 FocusTextInput + 20 SearchField)', () => {
    let focus = 0;
    let search = 0;
    for (const p of SEMUA_UI) {
      const s = strip(readFileSync(p, 'utf8'));
      focus += (s.match(/<FocusTextInput\b/g) || []).length;
      search += (s.match(/<SearchField\b/g) || []).length;
    }
    /*
     * RC-S55: 90 -> 89. AkruiBungaUtangFormScreen TIDAK lagi memuat
     * FocusTextInput karena ia bukan form manual lagi — layar itu berubah
     * menjadi monitoring & kontrol akrual otomatis, sehingga field
     * "Keterangan" (satu-satunya FocusTextInput di sana) memang hilang
     * bersama form-nya. Ini BUKAN input yang menyusut diam-diam kembali ke
     * komponen tanpa focus state — yang persis dijaga test ini — melainkan
     * satu input yang dihapus sepenuhnya beserta alur manualnya.
     */
    // RC-S64: 89 -> 88. Input teks bebas "Nama Unit/Kantor Tujuan" di
    // RAKFormScreen DIHAPUS karena nama unit kini diturunkan dari master
    // `koperasi_unit_usaha`. Ini perubahan kontrak yang disengaja, bukan
    // penyusutan diam-diam: sensus diturunkan satu, bukan guard-nya dilonggarkan.
    // RC-S67: 88 -> 89. Layar BARU PendapatanInvestasiFormScreen memuat satu
    // input "Keterangan" yang langsung memakai FocusTextInput (komponen
    // standar ber-focus state). Sensus naik karena input baru ditambahkan,
    // bukan karena guard dilonggarkan — kesamaan persis tetap dipertahankan.
    // RC-S67.4.2: 89 -> 91. Layar BARU PengembalianRAKFormScreen memuat dua
    // input standar ber-focus state (Nomor Dokumen, Keterangan).
    // RC-S67.6: 91 -> 92. Field "Nomor Dokumen" (wajib untuk Imbal Hasil
    // Tetap) di PendapatanInvestasiFormScreen memakai FocusTextInput standar.
    // RC-S67.7: 92 -> 94. Layar BARU PelepasanAsetFormScreen memuat dua input
    // standar ber-focus state (Nomor Dokumen, Keterangan).
    // RC-S67.9: 94 -> 95. Field "Catatan" di RekonsiliasiScreen yang
    // disederhanakan memakai FocusTextInput standar.
    // RC-S70.2: 95 -> 92. Sensus TURUN karena BERKASNYA DIHAPUS, bukan
    // karena ada input yang dikembalikan ke TextInput mentah: fitur legacy
    // "Pemberian Pinjaman untuk Koperasi" dihapus beserta
    // PemberianPinjamanKoperasiFormScreen & DaftarPinjamanKoperasiScreen,
    // dan input ber-focus state di dalamnya ikut hilang. Guard-nya TIDAK
    // dilonggarkan — kesamaan persis tetap dipertahankan.
    // RC-S70.3: 92 -> 94. Layar BARU PendapatanUnitUsahaFormScreen memuat dua
    // FocusTextInput (Nomor Dokumen, Keterangan) — keduanya komponen ber-focus
    // state standar, bukan TextInput mentah. Guard kesamaan persis tetap.
    // DIPERBARUI (penyederhanaan Kebijakan Penarikan Dini, instruksi pengguna):
    // 94 -> 91. Sensus TURUN karena field konfigurasi lanjutan DIHAPUS dari
    // formulir (nilai bunga hangus, rate penarikan dini) dan dua input nominal
    // kini memakai satu komponen `InputSatuan` (satu tag FocusTextInput).
    // Tidak ada input yang dikembalikan ke TextInput mentah — guard kesamaan
    // persis tetap dipertahankan.
    // DIPERBARUI (modul Penarikan Dana Investasi): 91 -> 92. Layar BARU
    // PenarikanInvestasiFormScreen memuat satu input "Keterangan" memakai
    // FocusTextInput standar. Sensus naik karena input baru, bukan guard dilonggarkan.
    // DIPERBARUI Tahap B: 92 -> 93 — isian baru "Nomor Deposito" pada
    // penempatan Deposito Berjangka (InvestasiFormScreen), FocusTextInput standar.
    // DIPERBARUI RC-S88: 93 -> 94 — isian baru "Penilai" (opsional) pada
    // Penyesuaian Nilai Wajar, FocusTextInput standar.
    // DIPERBARUI Poin 5: 95 -> 94 — field "Nomor Dokumen" (FocusTextInput) di
    // PendapatanUnitUsahaFormScreen DIHAPUS dan diganti UnitUsahaPicker master;
    // input dihapus beserta fungsinya, bukan dikembalikan ke TextInput mentah.
    // DIPERBARUI (bunga simpanan sukarela): +2 FocusTextInput — tarif bunga dan
    // alasan pembatalan di BungaSimpananSukarelaScreen, keduanya FocusTextInput.
    // DIPERBARUI RC-S128: +8 FocusTextInput — layar Kebijakan Produk Simpanan
    // Berjangka (versi, rate pasca jatuh tempo, dasar, ditetapkan oleh, catatan,
    // alasan cabut, dan dua isian penerapan ke kontrak lama), semuanya FocusTextInput.
    // DIPERBARUI RC-S133.4: 104 -> 105 — kotak "Kode pemasangan" (tempel teks
    // KOPKU1:...) di panel Sinkron Desktop HP kini memakai FocusTextInput
    // standar, sebelumnya <TextInput> mentah.
    expect(focus).toBe(105); // DIPERBARUI RC-S114: +1 FocusTextInput (kotak Kode Pemulihan di Backup & Restore)
    // DIPERBARUI RC-S129: 21 -> 22 — kolom pencarian BARU di daftar Simpanan
    // Berjangka (nama, nomor anggota, nomor kontrak, nominal), memakai
    // SearchField standar ber-focus state. Sensus naik karena input baru.
    expect(search).toBe(23); // DIPERBARUI riwayat per menu: +1 SearchField (pencarian di tab Riwayat, komponen RiwayatTransaksiMenu); DIPERBARUI RC-S133.5: +1 SearchField (cari user di User Management)
  });
});

// ---------------------------------------------------------------------
// 2. FocusTextInput — presentasi, bukan perilaku
// ---------------------------------------------------------------------
describe('FocusTextInput — kontrak presentasi', () => {
  const kode = strip(baca('src/components/FocusTextInput.tsx'));

  it('handler onFocus/onBlur pemanggil TETAP dipanggil', () => {
    expect(kode).toMatch(/setFokus\(true\);\s*onFocus\?\.\(e\);/);
    expect(kode).toMatch(/setFokus\(false\);\s*onBlur\?\.\(e\);/);
  });

  it('tidak punya onChangeText/value sendiri; semua prop diteruskan lewat ...rest', () => {
    expect(kode).not.toMatch(/onChangeText=\{/);
    expect(kode).not.toMatch(/\bvalue=\{/);
    expect(kode).toMatch(/\{\.\.\.rest\}/);
    expect(kode).not.toMatch(/defaultValue=/);
  });

  it('nonaktif dibaca dari editable pemanggil, tidak pernah disetel sendiri', () => {
    expect(kode).toMatch(/const nonaktif = rest\.editable === false/);
    expect(kode).not.toMatch(/editable=\{/);
    expect(kode).toMatch(/nonaktif && styles\.inputDisabled/);
  });

  it('urutan style: pemanggil → nonaktif → fokus → error (error menang)', () => {
    expect(kode).toMatch(
      /style,\s*nonaktif && styles\.inputDisabled,\s*fokus && !nonaktif && styles\.inputFocused,\s*!!invalid && styles\.inputError,/,
    );
  });

  it('memakai token bersama, bukan warna lepas', () => {
    expect(kode).toMatch(/inputFocused: \{ \.\.\.formUi\.inputFocused \}/);
    expect(kode).toMatch(/inputDisabled: \{ \.\.\.formUi\.inputDisabled \}/);
    expect(kode).toMatch(/inputError: \{ \.\.\.formUi\.inputError \}/);
    expect(kode).not.toMatch(/'#[0-9A-Fa-f]{3,6}'/);
  });
});

// ---------------------------------------------------------------------
// 3. SearchField — fokus di wadah, perilaku pencarian tak tersentuh
// ---------------------------------------------------------------------
describe('SearchField — kolom pencarian bersama (§15)', () => {
  const kode = strip(baca('src/components/SearchField.tsx'));

  it('ikon search, batas wadah, dan focus state ada di wadah', () => {
    expect(kode).toMatch(/inputTypeIcon\.search/);
    expect(kode).toMatch(/styles\.wrap, wrapStyle, fokus && styles\.wrapFocused/);
    expect(kode).toMatch(/wrap: \{ \.\.\.formUi\.searchWrap \}/);
    expect(kode).toMatch(/wrapFocused: \{ \.\.\.formUi\.searchWrapFocused \}/);
  });

  it('tidak ada logika filter/debounce/trim; handler pemanggil diteruskan', () => {
    expect(kode).not.toMatch(/onChangeText=\{/);
    expect(kode).not.toMatch(/setTimeout|debounce|\.trim\(|toLowerCase/);
    expect(kode).toMatch(/\{\.\.\.rest\}/);
    expect(kode).toMatch(/setFokus\(true\);\s*onFocus\?\.\(e\);/);
    expect(kode).toMatch(/setFokus\(false\);\s*onBlur\?\.\(e\);/);
  });

  it.each(['AccountPicker', 'AnggotaPicker', 'AnggotaPiutangPicker', 'DataReferensiPicker', 'PinjamanPicker'].map((n) => [n]))(
    '%s memakai SearchField',
    (n) => {
      const s = strip(baca(`src/components/${n}.tsx`));
      expect(s).toMatch(/<SearchField\b/);
      expect(s).toMatch(/onChangeText=\{setQuery\}/);
    },
  );

  it('wrapStyle layar hanya berisi penempatan, bukan batas/warna tandingan', () => {
    const pelanggar: string[] = [];
    for (const p of SEMUA_UI) {
      const s = strip(readFileSync(p, 'utf8'));
      for (const m of s.matchAll(/<SearchField\b[\s\S]*?wrapStyle=\{styles\.(\w+)\}/g)) {
        const def = s.match(new RegExp(`\\n\\s*${m[1]}: \\{([^{}]*)\\}`));
        if (!def) continue;
        if (/border|backgroundColor|padding|borderRadius/.test(def[1])) pelanggar.push(`${rel(p)}:${m[1]}`);
      }
    }
    expect(pelanggar).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// 4. SATU DEFINISI FOKUS — tidak menggeser layout (§7, §8)
// ---------------------------------------------------------------------
describe('Token fokus bersama', () => {
  const form = baca('src/theme/form.ts');

  it('FOKUS hanya warna — tidak ada lebar border/padding', () => {
    const m = form.match(/const FOKUS = \{([\s\S]*?)\} as const;/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/borderColor: colors\.borderFocus/);
    expect(m![1]).toMatch(/backgroundColor: colors\.focusBg/);
    expect(m![1]).not.toMatch(/borderWidth|padding|height|margin/);
  });

  it('AppTextInput, input tanpa wadah, dan pencarian memakai FOKUS yang sama', () => {
    expect(form).toMatch(/inputWrapFocus: \{ \.\.\.FOKUS \}/);
    expect(form).toMatch(/inputFocused: \{ \.\.\.FOKUS \}/);
    expect(form).toMatch(/searchWrapFocused: \{ \.\.\.FOKUS \}/);
  });

  it('CurrencyInput tidak lagi menebalkan border saat fokus', () => {
    const ci = strip(baca('src/components/CurrencyInput.tsx'));
    expect(ci).toMatch(/wrapFocus: \{ \.\.\.formUi\.inputWrapFocus \}/);
    expect(ci).not.toMatch(/borderWidth: 2/);
    expect(ci).toMatch(/minHeight: touchTarget/);
  });

  it('tidak ada style fokus lokal di layar (satu warna fokus untuk seluruh aplikasi)', () => {
    const pelanggar = LAYAR.filter((p) =>
      /(Focus|Focused|Fokus)\w*:\s*\{[^{}]*borderColor/.test(strip(readFileSync(p, 'utf8'))),
    ).map(rel);
    expect(pelanggar).toEqual([]);
  });

  it('warna focusBg tersedia sebagai token', () => {
    expect(baca('src/theme/colors.ts')).toMatch(/focusBg: '#[0-9A-Fa-f]{6}'/);
  });
});

// ---------------------------------------------------------------------
// 5. MULTILINE — tumbuh, tidak terpotong
// ---------------------------------------------------------------------
describe('Multiline (§13)', () => {
  it('setiap FocusTextInput multiline memakai style ber-minHeight + rata atas, tanpa height tetap', () => {
    const pelanggar: string[] = [];
    for (const p of LAYAR) {
      const s = strip(readFileSync(p, 'utf8'));
      for (const e of elemen(s, 'FocusTextInput')) {
        if (!/^\s*multiline\s*$/m.test(e)) continue;
        const nama = [...(e.match(/style=\{([^\n]*)\}/)?.[1] ?? '').matchAll(/styles\.(\w+)/g)].map((m) => m[1]);
        const defs = nama.map((n) => s.match(new RegExp(`\\n\\s*${n}: \\{([^{}]*)\\}`))?.[1] ?? '').join(' ');
        const aman =
          /inputStandaloneMultiline|minHeight: \d+/.test(defs) && /inputStandaloneMultiline|textAlignVertical: 'top'/.test(defs);
        if (!aman || /[^n]height: \d/.test(defs)) pelanggar.push(`${rel(p)}:${nama.join('+')}`);
      }
    }
    expect(pelanggar).toEqual([]);
  });

  it('input satu baris tidak lagi memakai style multiline setinggi 88 dp', () => {
    for (const f of ['src/screens/Akuntansi/DaftarAsetTetapScreen.tsx', 'src/screens/Akuntansi/DaftarInvestasiScreen.tsx']) {
      const s = strip(baca(f));
      for (const e of elemen(s, 'FocusTextInput')) {
        if (/^\s*multiline\s*$/m.test(e)) continue;
        expect(e).not.toMatch(/style=\{styles\.modalInput\}/);
      }
      expect(s).toMatch(/modalInputSingle: \{ \.\.\.formUi\.inputStandalone \}/);
    }
  });
});

// ---------------------------------------------------------------------
// 6. ERROR — presentasi sama dengan AppTextInput, kondisi tak berubah
// ---------------------------------------------------------------------
describe('Error presentation (§11)', () => {
  it('FieldError: ikon + teks, dan TIDAK memutuskan kapan tampil', () => {
    const fe = strip(baca('src/components/FieldError.tsx'));
    expect(fe).toMatch(/name="alert-circle-outline"/);
    expect(fe).toMatch(/\{message\}/);
    expect(fe).not.toMatch(/if \(|\?\s*null|return null/);
  });

  it('setiap invalid={!!X} diikuti {X && <FieldError message={X} />} — kondisi pemanggil utuh', () => {
    let jumlah = 0;
    const pelanggar: string[] = [];
    for (const p of LAYAR) {
      const s = strip(readFileSync(p, 'utf8'));
      for (const m of s.matchAll(/invalid=\{!!([\w.]+)\}\s*\/>\s*\{([\w.]+) && <FieldError message=\{([\w.]+)\} \/>\}/g)) {
        jumlah += 1;
        if (!(m[1] === m[2] && m[2] === m[3])) pelanggar.push(rel(p));
      }
      const invalid = (s.match(/invalid=\{/g) || []).length;
      const berpasangan = (s.match(/invalid=\{!![\w.]+\}\s*\/>\s*\{[\w.]+ && <FieldError/g) || []).length;
      if (invalid !== berpasangan) pelanggar.push(`${rel(p)} (invalid tanpa FieldError)`);
    }
    expect(pelanggar).toEqual([]);
    // RC-S64: 21 -> 20, mengikuti dihapusnya field teks bebas nama unit di
    // RAKFormScreen (pasangan invalid={!!X} + FieldError-nya ikut hilang
    // bersama field-nya). Guard-nya TIDAK dilonggarkan — hanya sensusnya
    // diturunkan satu, sesuai perubahan kontrak RC-S64 §3.
    // RC-S70.2: 20 -> 19, karena PemberianPinjamanKoperasiFormScreen
    // (satu pasangan invalid + FieldError) DIHAPUS bersama fitur legacy-nya.
    // RC-S116: 19 -> 20, mengikuti kotak isian Kode Pemulihan di dialog
    // pemulihan Backup & Restore. Pasangan invalid={!!X} + FieldError-nya
    // MENGIKUTI kontrak yang sama, jadi guard-nya tidak dilonggarkan —
    // hanya sensusnya naik satu, sesuai field yang benar-benar bertambah.
    expect(jumlah).toBe(20);
  });

  it('tidak ada error per-field yang masih berupa teks polos tepat di bawah input', () => {
    const pelanggar: string[] = [];
    for (const p of LAYAR) {
      const s = strip(readFileSync(p, 'utf8'));
      // Batas elemen = `/>` PERTAMA setelah tag (atribut tidak memuat `/>`),
      // lalu periksa hanya teks yang langsung menempel sesudahnya.
      for (const m of s.matchAll(/<FocusTextInput\b[^]*?\/>/g)) {
        const sesudah = s.slice(m.index! + m[0].length).trimStart();
        const t = sesudah.match(/^\{((?:errors|terimaErrors)\.\w+) && <Text style=\{styles\.errorText\}>/);
        if (t) pelanggar.push(`${rel(p)}:${t[1]}`);
      }
    }
    expect(pelanggar).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// 7. PLACEHOLDER, PIN, MODAL
// ---------------------------------------------------------------------
describe('Placeholder, PinInput, modal', () => {
  it('placeholder memakai satu warna token', () => {
    const pelanggar: string[] = [];
    for (const p of LAYAR) {
      const s = strip(readFileSync(p, 'utf8'));
      for (const tag of ['FocusTextInput', 'SearchField']) {
        for (const e of elemen(s, tag)) {
          const m = e.match(/placeholderTextColor=\{([^}]*)\}/);
          if (m && m[1] !== 'colors.placeholder') pelanggar.push(`${rel(p)}:${m[1]}`);
        }
      }
    }
    expect(pelanggar).toEqual([]);
  });

  it('PinInput: sorotan kotak aktif hanya saat fokus; filter angka tetap', () => {
    const s = strip(baca('src/components/PinInput.tsx'));
    expect(s).toMatch(/const active = fokus && i === digits\.length/);
    expect(s).toMatch(/onChangeText=\{\(t\) => onChangeText\(t\.replace\(\/\[\^0-9\]\/g, ''\)\.slice\(0, length\)\)\}/);
    expect(s).toMatch(/ref=\{inputRef\}/);
  });

  it('berkas ber-Modal + input (termasuk komponen input bersama) tetap meneruskan ketukan saat keyboard terbuka', () => {
    // Pengganti cakupan: dua kontrak lama mendeteksi berkas lewat /<TextInput/,
    // dan setelah migrasi berkas-berkas itu memakai FocusTextInput/SearchField.
    const pelanggar: string[] = [];
    for (const p of SEMUA_UI) {
      const s = strip(readFileSync(p, 'utf8'));
      if (!/<Modal/.test(s) || !/<(TextInput|FocusTextInput|SearchField|AppTextInput|CurrencyInput)\b/.test(s)) continue;
      for (const m of s.matchAll(/<(ScrollView|FlatList)\b[\s\S]*?>/g)) {
      // RC-S110: prop papan ketik sekarang boleh datang lewat spread
      // {...PROP_SCROLL_FORM} (src/components/AreaAmanKeyboard.tsx),
      // yang memuat keyboardShouldPersistTaps: 'handled' PLUS
      // keyboardDismissMode dan automaticallyAdjustKeyboardInsets.
      // Kontraknya tidak dilonggarkan — satu-satunya sumber spread itu
      // adalah konstanta yang isinya sendiri diuji di
      // AreaAmanKeyboardRcS110.test.ts, jadi cakupannya justru lebih
      // luas daripada prop yang ditulis tangan per layar.
        if (!/keyboardShouldPersistTaps|PROP_SCROLL_FORM/.test(m[0])) pelanggar.push(rel(p));
      }
    }
    expect(pelanggar).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// 8. TIDAK ADA LOGIKA BARU
// ---------------------------------------------------------------------
describe('Komponen presentasi bebas logika bisnis', () => {
  const BARU = ['src/components/FocusTextInput.tsx', 'src/components/SearchField.tsx', 'src/components/FieldError.tsx'];

  it.each(BARU.map((f) => [f]))('%s tidak mengimpor service/database/store/validator/utils', (f) => {
    const s = baca(f);
    expect(s).not.toMatch(/from '@\/(services|database|accounting|repositories|models|store|utils|hooks|security|validators|config)\//);
    expect(s).not.toMatch(/useEffect|fetch\(|await /);
  });
});

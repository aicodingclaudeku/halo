import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * UI/UX FINAL POLISH — KONTRAK STATIK PRESENTASI.
 *
 * Seluruh assertion di berkas ini HANYA tentang tampilan: hierarki
 * layar, token bersama, batas & focus state input, layout modal,
 * affordance, ikon, dan area sentuh. Tidak ada satu pun assertion
 * tentang akuntansi, jurnal, skema, atau lisensi — perilaku itu
 * dikunci suite existing masing-masing dan TIDAK disentuh pass ini.
 *
 * Alasan kontraknya statik (membaca sumber, bukan me-render): environment
 * test ini tidak punya react-native testing library, jadi komponen RN
 * tidak dapat di-render. Keterbatasan ini sudah tercatat sejak
 * sesi-sesi sebelumnya dan tidak berubah.
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

const SEMUA_UI = [...berkasTsx(join(ROOT, 'src/screens')), ...berkasTsx(join(ROOT, 'src/components'))];
const rel = (p: string) => p.slice(ROOT.length + 1);

// ---------------------------------------------------------------------
// 1. LICENSE — hierarki tampilan
// ---------------------------------------------------------------------
describe('License UI — hierarki status / masa berlaku / informasi / aksi', () => {
  const info = strip(baca('src/screens/License/LicenseInfoScreen.tsx'));

  it('keempat section label ada dan berurutan', () => {
    const urutan = ['Status Lisensi', 'Masa Berlaku', 'Informasi', 'Aksi'];
    let posisi = -1;
    for (const label of urutan) {
      const p = info.indexOf(`>${label}<`);
      expect(p).toBeGreaterThan(posisi);
      posisi = p;
    }
  });

  it('status utama memakai ikon shield, masa berlaku memakai ikon kalender', () => {
    expect(info).toMatch(/name="shield-checkmark"/);
    expect(info).toMatch(/name="calendar-outline"/);
  });

  it('masa berlaku ditonjolkan (bobot tebal), bukan sebaris dengan detail lain', () => {
    expect(info).toMatch(/expiryValue: \{[^}]*fontWeight: '700'/);
  });

  it('aksi verifikasi & diagnostik terlihat dapat ditekan dan punya label aksesibilitas', () => {
    expect(info).toMatch(/accessibilityLabel="Verifikasi lisensi sekarang"/);
    expect(info).toMatch(/accessibilityLabel="Buka diagnostik keamanan"/);
    expect(info).toMatch(/name="chevron-forward"/);
  });

  it('memakai bar judul bersama, tanpa membuat header kedua', () => {
    expect(info).toMatch(/from '@\/theme\/ui'/);
    expect(info).toMatch(/gateHeader\.bar/);
    expect(info).not.toMatch(/AppHeader/);
  });

  it('teks & sumber data lisensi tidak berubah: formatGrace/formatDate tetap ada', () => {
    expect(info).toMatch(/function formatDate\(/);
    expect(info).toMatch(/function formatGrace\(/);
    expect(info).toMatch(/verifyLicense\(\)/);
    // Tidak ada aksi yang mengubah ikatan lisensi dari layar ini (RC-S37).
    expect(info).not.toMatch(/deactivateLicense/);
  });

  it('layar aktivasi memakai input bersama, bukan TextInput polos', () => {
    const akt = strip(baca('src/screens/License/LicenseActivationScreen.tsx'));
    expect(akt).toMatch(/from '@\/components\/AppTextInput'/);
    expect(akt).not.toMatch(/<TextInput/);
    expect(akt).toMatch(/inputType="key"/);
    expect(akt).toMatch(/inputType="business"/);
    // Dua aksi RC-S52 tetap terpisah dan utuh.
    expect(akt).toMatch(/activateLicense\(/);
    expect(akt).toMatch(/verifyLicense\(\)/);
  });
});

// ---------------------------------------------------------------------
// 2. SETUP — hierarki & keyboard
// ---------------------------------------------------------------------
describe('Setup UI — header, deskripsi, grup form, aksi utama', () => {
  const wizard = strip(baca('src/screens/Setup/SetupWizardScreen.tsx'));

  it('urutan HEADER -> DESCRIPTION -> FORM GROUP -> PRIMARY ACTION', () => {
    const judul = wizard.indexOf('Selamat Datang di KOPKU');
    const grup = wizard.indexOf('styles.groupLabel');
    const aksi = wizard.indexOf('styles.submitButton');
    expect(judul).toBeGreaterThan(-1);
    expect(grup).toBeGreaterThan(judul);
    expect(aksi).toBeGreaterThan(grup);
  });

  it('keyboard-safe: KeyboardAvoidingView + tap tembus keyboard', () => {
    // RC-S110: pola lama `behavior={Platform.OS === 'ios' ? 'padding'
    // : undefined}` DIHAPUS dari seluruh aplikasi karena `behavior`
    // undefined membuat KeyboardAvoidingView tidak melakukan apa-apa di
    // Android — satu-satunya platform yang dibangun. Perlindungannya
    // sekarang lewat <AreaAmanKeyboard varian="...">, yang memberi
    // Android behavior 'height' untuk dialog. Assertion ini diperbarui
    // ke komponen barunya; yang dijaga tetap sama — layar ini WAJIB
    // punya perlindungan papan ketik, bukan sekadar mengimpornya.
    expect(wizard).toMatch(/<AreaAmanKeyboard varian="(dialog|layar)"/);
    expect(wizard).toMatch(/keyboardShouldPersistTaps="handled"/);
  });

  it('field wizard memakai input bersama; tiga pertanyaan setup tidak berubah', () => {
    expect(wizard).toMatch(/from '@\/components\/AppTextInput'/);
    expect(wizard).not.toMatch(/<TextInput/);
    expect(wizard).toMatch(/name="nama"/);
    expect(wizard).toMatch(/name="tahunBuku"/);
    expect(wizard).toMatch(/name="licenseKey"/);
    // Urutan transaksi first run (aktivasi -> setupKoperasi) tetap.
    expect(wizard).toMatch(/activateLicense\([\s\S]{0,400}setupKoperasi\(/);
  });

  it('login dapat di-scroll sehingga tombol tidak tertutup keyboard', () => {
    const login = strip(baca('src/screens/Setup/LoginScreen.tsx'));
    expect(login).toMatch(/ScrollView/);
    expect(login).toMatch(/keyboardShouldPersistTaps="handled"/);
    expect(login).toMatch(/from '@\/components\/AppTextInput'/);
    expect(login).toMatch(/accessibilityLabel="Masuk"/);
  });

  it('lock screen: aksi utama & biometrik punya area sentuh dan label', () => {
    const lock = strip(baca('src/screens/Setup/LockScreen.tsx'));
    expect(lock).toMatch(/accessibilityLabel="Buka kunci"/);
    expect(lock).toMatch(/accessibilityLabel="Gunakan biometrik"/);
    expect(lock).toMatch(/minHeight: touchTarget/);
  });
});

// ---------------------------------------------------------------------
// 3. INPUT BERSAMA — focus, error, disabled, multiline
// ---------------------------------------------------------------------
describe('AppTextInput — presentasi, bukan perilaku', () => {
  const src = baca('src/components/AppTextInput.tsx');
  const kode = strip(src);

  it('focus state hanya mengubah tampilan dan tetap memanggil handler pemanggil', () => {
    expect(kode).toMatch(/inputWrapFocus/);
    expect(kode).toMatch(/setFokus\(true\);\s*onFocus\?\.\(e\);/);
    expect(kode).toMatch(/setFokus\(false\);\s*onBlur\?\.\(e\);/);
  });

  it('tidak punya onChangeText sendiri: nilai diteruskan apa adanya', () => {
    expect(kode).not.toMatch(/onChangeText=\{/);
    expect(kode).toMatch(/\{\.\.\.rest\}/);
  });

  it('error ditampilkan dengan ikon + teks, bukan warna saja', () => {
    expect(kode).toMatch(/name="alert-circle-outline"/);
    expect(kode).toMatch(/styles\.errorText/);
  });

  it('punya state disabled dan label', () => {
    expect(kode).toMatch(/inputWrapDisabled/);
    expect(kode).toMatch(/styles\.label/);
  });

  it('multiline memakai minHeight, bukan height tetap', () => {
    const form = baca('src/theme/form.ts');
    expect(form).toMatch(/inputMultiline: \{\s*minHeight: 88/);
    expect(form).toMatch(/inputStandaloneMultiline: \{\s*minHeight: 88/);
    expect(form).toMatch(/textAlignVertical: 'top'/);
    expect(form).not.toMatch(/\n    height: \d/);
  });

  it('ikon dibedakan per tipe input (§8)', () => {
    const form = baca('src/theme/form.ts');
    expect(form).toMatch(/date: 'calendar-outline'/);
    expect(form).toMatch(/search: 'search-outline'/);
    expect(form).toMatch(/currency: 'cash-outline'/);
    expect(form).toMatch(/multiline: 'document-text-outline'/);
    expect(form).toMatch(/key: 'key-outline'/);
    // Tidak ada ikon orang untuk konsep data/akun.
    expect(form).not.toMatch(/account: 'people/);
  });
});

// ---------------------------------------------------------------------
// 4. TIDAK ADA TINGGI TETAP PADA INPUT
// ---------------------------------------------------------------------
describe('Overflow — input tidak memakai tinggi tetap', () => {
  it('tidak ada style input/textarea ber-height angka di seluruh UI', () => {
    const pelanggar: string[] = [];
    for (const p of SEMUA_UI) {
      const s = strip(readFileSync(p, 'utf8'));
      const re = /(input|textArea|multiline)[A-Za-z]*:\s*\{[^{}]*?[^n]height: \d+/gi;
      if (re.test(s)) pelanggar.push(rel(p));
      if (/style=\{\[[^\]]*\{\s*height: \d+,\s*textAlignVertical/.test(s)) pelanggar.push(rel(p));
    }
    expect(pelanggar).toEqual([]);
  });

  it('isian alasan di detail pinjaman tumbuh, tidak terpotong', () => {
    const s = strip(baca('src/screens/Pinjaman/PinjamanDetailScreen.tsx'));
    expect(s).toMatch(/modalInputMultiline/);
    expect(s).not.toMatch(/height: 60/);
  });
});

// ---------------------------------------------------------------------
// 5. MODAL — satu bahasa visual
// ---------------------------------------------------------------------
describe('Modal — kontrak layout bersama', () => {
  const modal = baca('src/theme/modal.ts');

  it('kartu modal punya batas tinggi supaya tombol tidak terdorong keluar layar', () => {
    expect(modal).toMatch(/card: \{[\s\S]*?maxHeight: '90%'/);
    expect(modal).toMatch(/sheet: \{[\s\S]*?maxHeight: '90%'/);
  });

  it('tinggi tombol seragam dan setara area sentuh aksesibilitas', () => {
    for (const k of ['primaryButton', 'secondaryButton', 'destructiveButton']) {
      expect(modal).toMatch(new RegExp(`${k}: \\{[\\s\\S]*?minHeight: touchTarget`));
    }
  });

  it('baris aksi membungkus, jadi label panjang tidak terpotong', () => {
    expect(modal).toMatch(/actions: \{[\s\S]*?flexWrap: 'wrap'/);
  });

  it('konten modal dapat di-scroll saat lebih tinggi dari layar', () => {
    expect(modal).toMatch(/scrollContent: \{[\s\S]*?flexGrow: 1/);
  });

  it('tidak ada lagi opasitas backdrop yang ditulis lepas per layar', () => {
    const pelanggar: string[] = [];
    for (const p of SEMUA_UI) {
      const s = strip(readFileSync(p, 'utf8'));
      if (!s.includes('<Modal')) continue;
      if (/(modalBackdrop|modalOverlay):\s*\{[^{}]*rgba\(/.test(s)) pelanggar.push(rel(p));
    }
    expect(pelanggar).toEqual([]);
  });

  it('berkas ber-Modal memakai token bersama untuk kartu & judulnya', () => {
    const tanpaToken: string[] = [];
    for (const p of SEMUA_UI) {
      const s = strip(readFileSync(p, 'utf8'));
      if (!s.includes('<Modal')) continue;
      const punyaStyleModal = /(modalCard|modalTitle|modalBackdrop|modalOverlay):/.test(s);
      if (punyaStyleModal && !s.includes("from '@/theme/modal'")) tanpaToken.push(rel(p));
    }
    expect(tanpaToken).toEqual([]);
  });

  it('tap tembus keyboard tetap terjaga di berkas ber-Modal (kontrak Tahap 2)', () => {
    for (const p of SEMUA_UI) {
      const s = strip(readFileSync(p, 'utf8'));
      if (!s.includes('<Modal') || !s.includes('<TextInput')) continue;
      if (/<(ScrollView|FlatList)/.test(s)) {
        // RC-S110: prop papan ketik sekarang boleh datang lewat spread
        // {...PROP_SCROLL_FORM} (src/components/AreaAmanKeyboard.tsx),
        // yang memuat keyboardShouldPersistTaps: 'handled' PLUS
        // keyboardDismissMode dan automaticallyAdjustKeyboardInsets.
        // Kontraknya tidak dilonggarkan — satu-satunya sumber spread itu
        // adalah konstanta yang isinya sendiri diuji di
        // AreaAmanKeyboardRcS110.test.ts, jadi cakupannya justru lebih
        // luas daripada prop yang ditulis tangan per layar.
        expect(s).toMatch(/keyboardShouldPersistTaps|PROP_SCROLL_FORM/);
      }
    }
  });
});

// ---------------------------------------------------------------------
// 6. PICKER & AFFORDANCE
// ---------------------------------------------------------------------
describe('Picker & clickable affordance', () => {
  const PICKER = [
    'AccountPicker',
    'AnggotaPicker',
    'AnggotaPiutangPicker',
    'DataReferensiPicker',
    'InvestasiPicker',
    'KewajibanAkunPicker',
    'PinjamanPicker',
    'RekeningPicker',
    'UtangPicker',
  ];

  it.each(PICKER.map((n) => [n]))('%s terlihat dapat dibuka (ikon + chevron)', (n) => {
    const s = strip(baca(`src/components/${n}.tsx`));
    expect(s).toMatch(/name="chevron-down"/);
    expect(s).toMatch(/accessibilityRole="button"/);
  });

  it('DatePicker memakai ikon kalender dan chevron (§14)', () => {
    const s = strip(baca('src/components/DatePicker.tsx'));
    expect(s).toMatch(/calendar/);
    expect(s).toMatch(/chevron-down/);
  });

  it('tombol tutup modal picker punya area sentuh, bukan padding 4', () => {
    for (const n of PICKER) {
      const s = baca(`src/components/${n}.tsx`);
      if (!s.includes('closeIcon:')) continue;
      expect(s).not.toMatch(/closeIcon: \{ padding: 4 \}/);
    }
  });

  it('kolom pencarian picker memakai token bersama', () => {
    for (const n of PICKER) {
      const s = baca(`src/components/${n}.tsx`);
      if (!/searchWrap:/.test(s)) continue;
      expect(s).toMatch(/formUi\.searchWrap/);
    }
  });
});

// ---------------------------------------------------------------------
// 7. IKON — semantik, tanpa emoji / glyph Unicode
// ---------------------------------------------------------------------
describe('Icon audit global (§17, §18)', () => {
  const GLYPH = /[\u2139\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\u26A0]|[\u{1F300}-\u{1FAFF}]/u;

  it('tidak ada emoji atau glyph Unicode sebagai ikon di layar target', () => {
    const TARGET = [
      'src/screens/License/LicenseInfoScreen.tsx',
      'src/screens/License/LicenseActivationScreen.tsx',
      'src/screens/License/LicenseDiagnosticScreen.tsx',
      'src/screens/Setup/SetupWizardScreen.tsx',
      'src/screens/Setup/LoginScreen.tsx',
      'src/screens/Setup/LockScreen.tsx',
      'src/screens/Pengaturan/BackupRestoreScreen.tsx',
      'src/screens/Pengaturan/SaldoAwalAkunListScreen.tsx',
      'src/screens/Transaksi/ImpairmentInvestasiFormScreen.tsx',
    ];
    for (const t of TARGET) {
      expect(strip(baca(t))).not.toMatch(GLYPH);
    }
  });

  it('badge & banner yang dulu berglyph sekarang memakai Ionicons berlabel', () => {
    const backup = strip(baca('src/screens/Pengaturan/BackupRestoreScreen.tsx'));
    expect(backup).toMatch(/name="checkmark-circle"/);
    // DIPERBARUI RC-S116: "File" -> "Berkas" di dialog pemulihan,
    // menyeragamkan istilah dengan sisa layar. Kontraknya tidak
    // berubah: teks status tetap dirender di samping ikonnya, jadi
    // informasinya tidak hanya bergantung pada ikon.
    expect(backup).toMatch(/Berkas backup valid</);

    const saldo = strip(baca('src/screens/Pengaturan/SaldoAwalAkunListScreen.tsx'));
    expect(saldo).toMatch(/name="information-circle-outline"/);
    // RC-S110 lanjutan: peringatan akun kliring 3-5000 dipindahkan
    // dari banner di dalam daftar ke kop yang tidak ikut tergulir,
    // dan ikonnya dinaikkan dari "warning-outline" (garis) ke
    // "alert-circle" (padat) karena di kop ia bersaing dengan chip
    // status dan bar kemajuan. Kontraknya tidak berubah: tetap
    // Ionicons, tetap berlabel — lihat accessibilityLabel di bawah.
    expect(saldo).toMatch(/name="alert-circle"/);
    // RC-S111: barisnya kini sebuah tombol (ketuk untuk membuka
    // penjelasan), jadi labelnya pindah dari ikon ke tombolnya dan
    // berisi kalimat utuh — nama peringatan, nominalnya, dan apa
    // yang terjadi kalau diketuk. Label pada ikon di dalam tombol
    // justru akan dibacakan dua kali oleh screen reader.
    expect(saldo).toMatch(/accessibilityLabel=\{`\$\{JUDUL_PERINGATAN_KLIRING\}/);
    expect(saldo).toMatch(/accessibilityState=\{\{ expanded: peringatanTerbuka \}\}/);
    // Teks statusnya tetap ada: ikon bukan satu-satunya informasi.
    // RC-S110: dua badge terpisah ("SALDO AWAL SUDAH DIKUNCI PERMANEN"
    // dan "SALDO AWAL AKTIF (belum dikunci permanen)") digabung menjadi
    // SATU chip status bernada tiga, karena statusnya selalu tepat satu
    // dari tiga. Labelnya sekarang dari `LABEL_STATUS_SALDO_AWAL` di
    // modul murni `@/reports/StatusSaldoAwalPlan` — teksnya diuji di
    // SaldoAwalTampilanRcS110.test.ts. Yang dijaga di sini tetap sama:
    // ikon tidak boleh menjadi satu-satunya pembawa informasi, jadi
    // label teks status WAJIB dirender di samping ikonnya.
    expect(saldo).toMatch(/LABEL_STATUS_SALDO_AWAL\[status\]/);
    expect(saldo).toMatch(/IKON_STATUS_SALDO_AWAL\[status\]/);

    const imp = strip(baca('src/screens/Transaksi/ImpairmentInvestasiFormScreen.tsx'));
    expect(imp).toMatch(/name="checkmark"/);
    expect(imp).toMatch(/accessibilityRole="checkbox"/);
  });

  it('elemen navigasi tidak memakai panah teks sebagai affordance', () => {
    const s = strip(baca('src/screens/Transaksi/ImbalanKerjaFormScreen.tsx'));
    expect(s).toMatch(/name="chevron-forward"/);
    expect(s).not.toMatch(/Buku Besar →/);
  });

  it('tidak ada ikon orang dipakai untuk konsep data/server', () => {
    const nav = strip(baca('src/navigation/RootNavigator.tsx'));
    expect(nav).toMatch(/server/);
    expect(nav).not.toMatch(/name="people[^"]*"[\s\S]{0,80}Data/);
  });
});

// ---------------------------------------------------------------------
// 8. HEADER & SAFE AREA (kontrak Tahap 1 tetap utuh)
// ---------------------------------------------------------------------
describe('Header & safe area', () => {
  it('AppHeader tetap compact, inset dinamis, tanpa absolute', () => {
    const s = strip(baca('src/components/AppHeader.tsx'));
    expect(s).toMatch(/useSafeAreaInsets\(\)/);
    expect(s).toMatch(/paddingTop: insets\.top/);
    expect(s).toMatch(/minHeight: 56/);
    expect(s).not.toMatch(/position: 'absolute'/);
    expect(s).toMatch(/numberOfLines=\{2\}/);
  });

  it('tidak ada offset negatif untuk mengakali status bar / header', () => {
    /*
     * Cakupan sengaja DIBATASI pada style yang memang berperan sebagai
     * wadah layar / bar judul. Offset negatif pada elemen kecil yang
     * memang menempel di sudut induknya (mis. badge jumlah filter di
     * HistoryTransaksiScreen: `top: -4, right: -4`) adalah pemakaian yang
     * benar dan bukan yang dilarang §20 — yang dilarang adalah menggeser
     * layar/header ke atas untuk "mengakali" status bar.
     */
    const WADAH = /^\s*(header|headerBar|topBar|appBar|safe|safeArea|statusBar|container|screen|wrap|content)[A-Za-z]*:\s*\{[^{}]*?(top|marginTop): -\d/gim;
    const pelanggar: string[] = [];
    for (const p of SEMUA_UI) {
      const s = strip(readFileSync(p, 'utf8'));
      if (new RegExp(WADAH.source, 'im').test(s)) pelanggar.push(rel(p));
    }
    expect(pelanggar).toEqual([]);
  });

  it('bar judul layar di luar navigator menyalin ukuran AppHeader', () => {
    const ui = baca('src/theme/ui.ts');
    expect(ui).toMatch(/gateHeader = \{/);
    expect(ui).toMatch(/minHeight: 56/);
  });

  it('layar lisensi tidak membuat header kedua maupun inset ganda', () => {
    for (const n of ['LicenseInfoScreen', 'LicenseActivationScreen', 'LicenseDiagnosticScreen']) {
      const s = strip(baca(`src/screens/License/${n}.tsx`));
      expect(s.match(/<SafeAreaView/g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------
// 9. TOKEN — tidak ada angka warna / spasi acak baru
// ---------------------------------------------------------------------
describe('Token global', () => {
  it('latar peringatan sudah jadi token, tidak ditulis hex per layar', () => {
    expect(baca('src/theme/colors.ts')).toMatch(/warningBg: '#FFF7E0'/);
    const pelanggar: string[] = [];
    for (const p of SEMUA_UI) {
      if (/'#FFF7E0'/.test(readFileSync(p, 'utf8'))) pelanggar.push(rel(p));
    }
    expect(pelanggar).toEqual([]);
  });

  it('spacing token tetap 4/8/12/16/24/32', () => {
    const s = baca('src/theme/colors.ts');
    expect(s).toMatch(/xs: 4/);
    expect(s).toMatch(/sm: 8/);
    expect(s).toMatch(/md: 12/);
    expect(s).toMatch(/lg: 16/);
    expect(s).toMatch(/xl: 24/);
  });

  it('theme/form.ts & theme/modal.ts tidak mengimpor react-native', () => {
    expect(baca('src/theme/form.ts')).not.toMatch(/from 'react-native'/);
    expect(baca('src/theme/modal.ts')).not.toMatch(/from 'react-native'/);
  });
});

// ---------------------------------------------------------------------
// 10. TAHAP 1 & 2 TETAP UTUH
// ---------------------------------------------------------------------
describe('Pekerjaan pass sebelumnya tidak dirusak', () => {
  // RC-S68: Penyesuaian kini kategori utama root Transaksi (keputusan pengguna).
  it('root Transaksi: Penerimaan, Pengeluaran & Penyesuaian', () => {
    const s = strip(baca('src/screens/Transaksi/TransaksiScreen.tsx'));
    expect(s).toMatch(/Penerimaan/);
    expect(s).toMatch(/Pengeluaran/);
    expect(s).toMatch(/navigate\('Penyesuaian'\)/);
  });

  it('CurrencyInput tetap punya focus & error presentation', () => {
    const s = strip(baca('src/components/CurrencyInput.tsx'));
    expect(s).toMatch(/wrapFocus/);
    expect(s).toMatch(/name="alert-circle-outline"/);
    expect(s).toMatch(/onChangeValue\(nilaiBaru\)/);
  });

  it('kartu menu hub tetap memakai token ui.menuCard', () => {
    const s = baca('src/theme/ui.ts');
    expect(s).toMatch(/menuCard: \{/);
    expect(s).toMatch(/minHeight: touchTarget \+ spacing\.lg/);
  });
});

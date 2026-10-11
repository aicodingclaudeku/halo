import { colors, radius, spacing, touchTarget, typography } from './colors';

/**
 * UI/UX FINAL POLISH — BAHASA VISUAL BERSAMA UNTUK INPUT.
 *
 * Sebelum berkas ini, setiap layar form punya definisi `styles.input`,
 * `styles.label`, dan `styles.inputWrap` sendiri: nilainya mirip tapi
 * tidak pernah persis sama (paddingVertical 10 vs 12 vs 14, radius sm vs
 * md, background surface vs background, dan sama sekali tidak ada
 * focus state). Akibatnya input di layar yang berbeda terlihat berasal
 * dari aplikasi yang berbeda.
 *
 * Seperti `theme/ui.ts`, ini objek style BIASA (bukan StyleSheet)
 * supaya berkas tidak bergantung pada react-native saat di-typecheck;
 * dipakai lewat spread di StyleSheet.create() masing-masing layar, atau
 * lewat komponen presentasi `components/AppTextInput.tsx`.
 *
 * MURNI PRESENTASI. Tidak ada satu pun nilai di sini yang menyentuh
 * value input, parsing, validasi, atau handler.
 *
 * Struktur satu field:
 *   LABEL
 *   [ikon]  teks input                        <- inputWrap (border)
 *   [ikon error]  pesan error                 <- errorRow (bila ada)
 *   catatan bantuan                           <- hint (bila ada)
 */
/**
 * UI/UX INPUT STANDARDIZATION — SATU-SATUNYA DEFINISI FOKUS.
 *
 * Dipakai oleh `inputWrapFocus` (AppTextInput), `inputFocused`
 * (FocusTextInput / input tanpa wadah), `searchWrapFocused` (SearchField)
 * dan `wrapFocus` CurrencyInput, sehingga seluruh input aplikasi punya
 * satu warna & satu bentuk fokus.
 *
 * HANYA warna yang berubah — border primary + tint latar halus. Lebar
 * border SENGAJA tidak disentuh: sebelumnya fokus menebalkan border
 * 1 → 2 dp. Padding horizontal memang dikompensasi, tetapi padding
 * vertikal tidak, sehingga CurrencyInput (tanpa minHeight) dan
 * AppTextInput multiline "meloncat" 2 dp setiap kali fokus berpindah.
 * Perubahan warna saja tidak pernah menggeser layout.
 */
const FOKUS = {
  borderColor: colors.borderFocus,
  backgroundColor: colors.focusBg,
} as const;

/** Tampilan nonaktif (editable={false}) — sama untuk semua input. */
const NONAKTIF = {
  backgroundColor: colors.background,
  borderColor: colors.border,
} as const;

/** Tampilan error — sama untuk semua input. */
const SALAH = {
  borderColor: colors.danger,
  backgroundColor: colors.dangerBg,
} as const;

export const formUi = {
  /** Jarak antar-field dalam satu grup form. */
  field: { marginBottom: spacing.md },

  /** Label di atas input. Selalu ada — input tanpa label dilarang. */
  label: {
    fontSize: typography.subtitle,
    fontWeight: '600' as const,
    color: colors.text,
    marginBottom: spacing.sm,
  },

  /** Label section di dalam form panjang (mis. "IDENTITAS", "NOMINAL"). */
  groupLabel: {
    fontSize: typography.caption,
    fontWeight: '700' as const,
    color: colors.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    marginBottom: spacing.sm,
  },

  /**
   * Wadah input: border + background ada DI SINI, bukan di TextInput,
   * supaya ikon kiri ikut berada di dalam batas yang sama dan focus
   * state cukup mengubah satu style.
   */
  inputWrap: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    minHeight: touchTarget,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
  },
  /** Fokus: lihat `FOKUS` di atas — warna saja, lebar border tetap 1 dp. */
  inputWrapFocus: { ...FOKUS },
  inputWrapError: { ...SALAH },
  inputWrapDisabled: { ...NONAKTIF, opacity: 0.85 },
  /** Multiline: ikon & teks rata atas, bukan tengah. */
  inputWrapMultiline: {
    alignItems: 'flex-start' as const,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },

  inputIcon: { marginRight: spacing.sm, flexShrink: 0 },
  /** Ikon multiline sejajar baris pertama teks. */
  inputIconMultiline: { marginTop: 2 },

  input: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
  },
  /**
   * minHeight, BUKAN height: teks panjang menambah tinggi sendiri dan
   * tidak terpotong. 88 ≈ 4 baris pada skala font normal — cukup lega
   * tanpa memakan layar kecil.
   */
  inputMultiline: {
    minHeight: 88,
    maxHeight: 176,
    paddingTop: 2,
    textAlignVertical: 'top' as const,
  },

  /**
   * INPUT TANPA WADAH — untuk layar yang meletakkan border langsung di
   * `<TextInput>` (pola mayoritas layar form Transaksi/Akuntansi, tanpa
   * ikon kiri). Nilainya identik dengan `inputWrap` + `input` di atas,
   * digabung menjadi satu style, supaya layar-layar itu bisa memakai
   * ukuran & batas yang sama tanpa harus diubah struktur JSX-nya.
   *
   * Focus/disabled/error untuk input tanpa wadah diberikan komponen
   * `components/FocusTextInput.tsx` lewat tiga token di bawah.
   */
  inputStandalone: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    minHeight: touchTarget,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
  },
  /** Varian multiline: tumbuh sampai 176 dp lalu isinya yang di-scroll. */
  inputStandaloneMultiline: {
    minHeight: 88,
    maxHeight: 176,
    paddingTop: spacing.sm,
    textAlignVertical: 'top' as const,
  },
  /**
   * Varian ringkas untuk sel tabel (mis. baris jadwal angsuran custom),
   * tempat tiga input berdampingan dalam satu baris. Radius, warna, dan
   * border SAMA dengan `inputStandalone`; yang berbeda hanya padding &
   * ukuran huruf. Tanpa minHeight 44 karena sel berada di dalam baris
   * tabel, bukan field mandiri.
   */
  inputCompact: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    fontSize: 13,
    color: colors.text,
  },

  /** Input tanpa wadah — fokus (diterapkan FocusTextInput). */
  inputFocused: { ...FOKUS },
  /** Input tanpa wadah — nonaktif. Teks ikut diredam. */
  inputDisabled: { ...NONAKTIF, color: colors.textMuted },
  /** Input tanpa wadah — error dari pemanggil (hanya tampilan). */
  inputError: { ...SALAH },

  errorRow: {
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  errorText: {
    flex: 1,
    minWidth: 0,
    color: colors.danger,
    fontSize: typography.caption,
    lineHeight: 16,
  },
  hint: {
    fontSize: 11,
    color: colors.textMuted,
    lineHeight: 16,
    marginTop: spacing.xs,
  },

  /** Kolom pencarian (picker & layar daftar). */
  searchWrap: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    minHeight: touchTarget,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
  },
  /** Fokus kolom pencarian — definisi yang sama dengan input lain. */
  searchWrapFocused: { ...FOKUS },
  searchIcon: { marginRight: spacing.sm, flexShrink: 0 },
  searchInput: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
  },
} as const;

/**
 * IKON PER TIPE INPUT (§8) — satu tipe, satu makna, satu ikon. Semua
 * nama diambil dari set Ionicons yang sudah dipakai aplikasi; tidak ada
 * dependency baru dan tidak ada emoji/simbol Unicode sebagai ikon.
 */
export const inputTypeIcon = {
  text: 'text-outline',
  number: 'calculator-outline',
  currency: 'cash-outline',
  percent: 'stats-chart-outline',
  date: 'calendar-outline',
  multiline: 'document-text-outline',
  search: 'search-outline',
  account: 'wallet-outline',
  picker: 'chevron-down',
  key: 'key-outline',
  business: 'business-outline',
  person: 'person-outline',
  phone: 'call-outline',
  email: 'mail-outline',
  location: 'location-outline',
  code: 'barcode-outline',
} as const;

export type InputTypeName = keyof typeof inputTypeIcon;

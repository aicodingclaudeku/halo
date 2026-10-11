import { colors, elevation, iconSize, radius, semantic, spacing, touchTarget, typography } from './colors';

/**
 * UI/UX REDESIGN — BAHASA VISUAL BERSAMA untuk kartu menu, subjudul layar,
 * dan label section. Objek style biasa (bukan StyleSheet) supaya berkas ini
 * tidak bergantung pada react-native saat di-typecheck; dipakai lewat spread
 * di StyleSheet.create() masing-masing layar.
 *
 * Struktur kartu menu:  [ICON]  Judul / Subjudul  [CHEVRON]
 *   - seluruh kartu adalah area sentuh (minHeight = touchTarget + ruang teks)
 *   - chevron punya ruang sendiri (flexShrink 0) sehingga teks panjang
 *     membungkus, tidak menabrak chevron
 *   - border + elevasi halus = affordance "bisa dibuka"
 */
export const ui = {
  screenContent: { padding: spacing.lg, paddingBottom: spacing.xl },
  screenIntro: {
    fontSize: typography.subtitle,
    lineHeight: 18,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  sectionLabel: {
    fontSize: typography.caption,
    fontWeight: '700' as const,
    color: colors.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  menuCard: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.md,
    minHeight: touchTarget + spacing.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    ...elevation.card,
  },
  menuIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.primaryLight,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    flexShrink: 0,
  },
  menuIconDanger: { backgroundColor: colors.dangerBg },
  /**
   * RC-S70.1 — VARIAN WADAH IKON KHUSUS PENGELUARAN.
   *
   * `menuIcon` (latar `primaryLight`) TETAP default untuk seluruh modul
   * lain — tidak diubah. Varian ini di-spread SETELAH `menuIcon` hanya
   * pada layar/kartu yang memang milik Pengeluaran, sehingga ikon merah
   * duduk di atas tint merah yang halus, bukan tint hijau brand.
   * Bentuk, ukuran, dan radius sengaja identik dengan `menuIcon` supaya
   * tidak ada pergeseran layout.
   */
  menuIconExpense: { backgroundColor: semantic.expenseIconBackground },
  menuIconExpensePressed: { backgroundColor: semantic.expensePressed },
  menuBody: { flex: 1, minWidth: 0 },
  menuTitle: { fontSize: typography.sectionTitle, fontWeight: '600' as const, color: colors.text, lineHeight: 20 },
  menuSub: { fontSize: typography.caption, lineHeight: 17, color: colors.textMuted, marginTop: 2 },
  chevron: { flexShrink: 0 },
};

export const menuIconSize = iconSize.md;

/**
 * UI/UX FINAL POLISH — BAR JUDUL UNTUK LAYAR DI LUAR NAVIGATOR (§19).
 *
 * `AppHeader` hanya dapat dipakai oleh layar yang punya `navigation`,
 * `route`, dan `options` dari native-stack. Layar lisensi & setup
 * dirender LANGSUNG oleh `LicenseGate`/`FirstRunSetup`, di luar pohon
 * navigasi, jadi mereka tidak punya prop itu — dan justru karena itu
 * tidak ada header kedua: di layar-layar tersebut memang belum ada
 * header sama sekali.
 *
 * Token di bawah menyalin TAMPILAN `AppHeader` (permukaan putih, garis
 * bawah 1 dp, bar `minHeight` 56, judul 17 sp, ikon `arrow-back`) supaya
 * layar-layar itu terlihat satu keluarga dengan sisa aplikasi. Inset
 * atas TETAP disediakan `SafeAreaView edges={['top']}` milik layar itu
 * sendiri — tidak ada inset kedua dan tidak ada `position: 'absolute'`.
 */
export const gateHeader = {
  wrap: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bar: {
    minHeight: 56,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: spacing.xs,
  },
  backBtn: {
    width: touchTarget + spacing.xs,
    height: touchTarget + spacing.xs,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    flexShrink: 0,
  },
  title: {
    flex: 1,
    fontSize: typography.screenTitle,
    lineHeight: 22,
    fontWeight: '700' as const,
    color: colors.text,
    paddingVertical: spacing.sm,
    marginLeft: spacing.xs,
  },
  titleNoBack: { marginLeft: spacing.md },
};

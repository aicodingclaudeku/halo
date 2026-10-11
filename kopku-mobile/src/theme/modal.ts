import { colors, radius, spacing, touchTarget, typography } from './colors';

/**
 * UI/UX FINAL POLISH — SATU BAHASA VISUAL UNTUK MODAL (§11, §12).
 *
 * Audit menemukan 38 berkas ber-Modal dengan struktur yang sudah mirip
 * (backdrop -> ScrollView -> kartu -> judul -> deskripsi -> isi ->
 * aksi), tetapi nilainya berbeda-beda: opasitas backdrop 0.4 / 0.45 /
 * 0.5, radius kartu md di satu layar dan lg di layar lain, tinggi tombol
 * 10 / 12 / 14 dp, dan sebagian kartu tanpa `maxHeight` sama sekali
 * sehingga isi yang panjang bisa mendorong tombol keluar layar.
 *
 * Token di bawah TIDAK mengubah struktur JSX, urutan aksi, maupun
 * handler mana pun. Hanya angka tampilan yang disatukan.
 *
 * Urutan baku (§11):
 *   TITLE -> DESCRIPTION -> CONTENT -> SECONDARY ACTION -> PRIMARY ACTION
 *
 * Objek style biasa (bukan StyleSheet), sama seperti `theme/ui.ts` &
 * `theme/form.ts`, dipakai lewat spread di StyleSheet.create().
 */
export const modalUi = {
  /** Latar gelap di belakang kartu. Satu opasitas untuk seluruh aplikasi. */
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },

  /**
   * Isi ScrollView pembungkus kartu. `flexGrow: 1` + center membuat
   * kartu tetap di tengah saat pendek, dan bisa di-scroll saat konten
   * atau keyboard membuatnya lebih tinggi dari layar.
   */
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    padding: spacing.lg,
  },

  /**
   * Kartu modal. `maxHeight: '90%'` adalah pengaman terakhir: pada
   * layar kecil atau font scale besar, kartu berhenti tumbuh dan
   * isinya yang di-scroll — tombol tidak pernah terdorong keluar layar.
   */
  card: {
    width: '100%' as const,
    maxHeight: '90%' as const,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },

  /** Modal yang menempel di bawah layar (bottom sheet). */
  sheet: {
    width: '100%' as const,
    maxHeight: '90%' as const,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
  },

  title: {
    fontSize: 16,
    fontWeight: '700' as const,
    color: colors.text,
    lineHeight: 22,
    flexShrink: 1,
    minWidth: 0,
  },
  description: {
    fontSize: typography.caption,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
  },

  /** Baris judul + tombol tutup. */
  headerRow: {
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    justifyContent: 'space-between' as const,
    gap: spacing.md,
  },
  closeIcon: {
    width: touchTarget - 8,
    height: touchTarget - 8,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    flexShrink: 0,
  },

  /**
   * Baris aksi. `flexWrap` supaya label panjang / font scale besar
   * membuat tombol turun baris, bukan terpotong.
   */
  actions: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    justifyContent: 'flex-end' as const,
    alignItems: 'center' as const,
    gap: spacing.sm,
    marginTop: spacing.lg,
  },

  /** Tinggi tombol seragam ≈ area sentuh aksesibilitas. */
  primaryButton: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: spacing.sm,
    minHeight: touchTarget,
    minWidth: 96,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
  primaryText: { color: colors.white, fontWeight: '700' as const, fontSize: 14 },

  secondaryButton: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: spacing.sm,
    minHeight: touchTarget,
    minWidth: 96,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  secondaryText: { color: colors.text, fontWeight: '600' as const, fontSize: 14 },

  destructiveButton: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: spacing.sm,
    minHeight: touchTarget,
    minWidth: 96,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.danger,
  },
  destructiveText: { color: colors.white, fontWeight: '700' as const, fontSize: 14 },

  disabled: { opacity: 0.55 },
} as const;

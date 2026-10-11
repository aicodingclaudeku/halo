/**
 * KOPKU DESKTOP — token layar menu/hub untuk jendela lebar.
 * Hanya tampilan; isi menu, urutan, izin, dan tujuan navigasi tetap.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dasar: typeof import('./ui') = require('./ui.ts');
import { colors, radius } from './colors';

export const ui = {
  ...dasar.ui,
  screenContent: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 40 },
  screenIntro: { ...dasar.ui.screenIntro, fontSize: 13.5, lineHeight: 20, marginBottom: 20, maxWidth: 760 },
  sectionLabel: { ...dasar.ui.sectionLabel, fontSize: 11.5, letterSpacing: 0.8, marginTop: 14, marginBottom: 10, color: '#667085' },
  menuCard: {
    ...dasar.ui.menuCard,
    minHeight: 60,
    borderRadius: radius.md,
    borderColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  menuIcon: { ...dasar.ui.menuIcon, width: 36, height: 36, borderRadius: radius.md },
  menuTitle: { ...dasar.ui.menuTitle, fontSize: 14.5 },
  menuSub: { ...dasar.ui.menuSub, fontSize: 12.5 },
} as unknown as typeof dasar.ui;

export const menuIconSize = dasar.menuIconSize;
export const gateHeader = dasar.gateHeader;

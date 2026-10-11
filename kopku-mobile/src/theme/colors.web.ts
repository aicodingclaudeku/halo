/**
 * KOPKU DESKTOP — TOKEN DESAIN VERSI DESKTOP (Windows & macOS).
 *
 * Berkas `.web.ts` hanya dipakai bundel desktop (Metro platform "web");
 * aplikasi Android tetap memakai `colors.ts` apa adanya. Semua nama ekspor
 * SAMA dengan `colors.ts` sehingga seluruh layar, komponen, dan token
 * turunan (`ui.ts`, `form.ts`, `modal.ts`, `navigation.ts`) otomatis
 * memakai tampilan desktop TANPA satu pun layar diubah — fungsi, aturan
 * bisnis, dan alur tidak tersentuh, hanya tampilan.
 *
 * Arah desain desktop (sengaja berbeda dari versi HP):
 *  - latar abu-abu dingin seperti aplikasi kantor, kartu putih bergaris
 *    tipis, bayangan sangat halus;
 *  - hijau brand lebih dalam & tegas (emerald), teks slate berkontras
 *    tinggi untuk layar lebar;
 *  - kepadatan desktop: tinggi kontrol 38 px (mouse/keyboard, bukan jari),
 *    sudut lebih kecil (6/8/12), tipografi sedikit lebih besar untuk judul.
 *
 * Nilai dasar diimpor dengan ekstensi eksplisit (`./colors.ts`) supaya
 * Metro tidak me-resolve ke berkas ini sendiri.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dasar: typeof import('./colors') = require('./colors.ts');

export const colors: typeof dasar.colors = {
  ...dasar.colors,
  primary: '#146C3C',
  primaryDark: '#0D4A29',
  primaryLight: '#E6F2EA',
  accent: '#1F8A4F',

  background: '#F1F3F6',
  surface: '#FFFFFF',
  border: '#E1E5EB',
  borderFocus: '#146C3C',
  focusBg: '#FBFDFC',

  text: '#141A22',
  textMuted: '#5A6474',
  textFaint: '#9099A8',
  placeholder: '#A1A9B6',

  danger: '#C2312E',
  dangerBg: '#FCEDEC',
  success: '#1F8A4F',
  warning: '#B7791F',
  warningBg: '#FFF8E6',
  warningBorder: '#F1DFAE',

  white: '#FFFFFF',
  disabled: '#9DC2AB',
};

export const semantic: typeof dasar.semantic = {
  incomeIcon: colors.success,
  incomeIconBackground: colors.primaryLight,
  incomePressed: '#D3E8DA',

  expenseIcon: colors.danger,
  expenseIconBackground: colors.dangerBg,
  expensePressed: '#F7D9D7',

  adjustmentIcon: colors.primary,
  adjustmentIconBackground: colors.primaryLight,
  adjustmentPressed: '#D3E8DA',
};

export const spacing: typeof dasar.spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 20,
  xl: 28,
  xxl: 36,
};

export const radius: typeof dasar.radius = {
  sm: 6,
  md: 8,
  lg: 12,
  pill: 999,
};

export const iconSize: typeof dasar.iconSize = {
  sm: 16,
  md: 18,
  lg: 20,
  xl: 24,
};

/** Desktop: kontrol untuk mouse & keyboard. */
export const touchTarget = 38 as unknown as typeof dasar.touchTarget;

export const elevation: typeof dasar.elevation = {
  card: {
    elevation: 0,
    shadowColor: '#101828',
    shadowOpacity: 0.05,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
};

export const typography: typeof dasar.typography = {
  screenTitle: 20,
  sectionTitle: 15,
  body: 14,
  subtitle: 13,
  caption: 12,
};

export const splashColors = dasar.splashColors;
export const splashTema = dasar.splashTema;
export type PaletSplash = import('./colors').PaletSplash;

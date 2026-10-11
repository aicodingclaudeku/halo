/**
 * Design tokens warna — dipakai di seluruh layar supaya konsisten
 * (sebelumnya tiap layar punya angka hex sendiri-sendiri yang mirip
 * tapi tidak persis sama, mis. '#1B5E20' vs '#1b5e20', border '#DDD'
 * vs '#E0E0E0', dst).
 */
export const colors = {
  primary: '#1B5E20',
  primaryDark: '#12401A',
  primaryLight: '#E8F3E9',
  accent: '#2E7D32',

  background: '#F6F8F6',
  surface: '#FFFFFF',
  border: '#E1E5E1',
  borderFocus: '#1B5E20',
  /**
   * UI/UX INPUT STANDARDIZATION — tint latar input yang sedang fokus.
   * Sengaja jauh lebih pucat daripada `primaryLight` (yang dipakai
   * chip/kotak PIN terisi) supaya fokus terbaca sebagai "sorotan halus",
   * bukan status terpilih.
   */
  focusBg: '#F5FAF5',

  text: '#1C1F1C',
  textMuted: '#6B756B',
  textFaint: '#9AA39A',
  placeholder: '#A9B2A9',

  danger: '#C62828',
  dangerBg: '#FDECEC',
  success: '#2E7D32',
  warning: '#B8860B',
  /**
   * UI/UX FINAL POLISH — latar & garis untuk kotak peringatan. Nilainya
   * adalah hex yang sudah dipakai layar lisensi/setup secara lepas
   * ('#FFF7E0'), dipindahkan ke token supaya tidak ada lagi angka warna
   * yang ditulis ulang per layar.
   */
  warningBg: '#FFF7E0',
  warningBorder: '#EFDFAF',

  white: '#FFFFFF',
  disabled: '#A5C2A6',
};

/**
 * RC-S68.2 — TOKEN SEMANTIK ARUS KAS (lapisan UI saja).
 *
 * Tidak ada palet baru: nilainya diturunkan dari token yang sudah ada
 * (`success`, `danger`, `dangerBg`, `primary`, `primaryLight`). Hanya dua
 * nilai tekan (pressed) yang baru — tint satu tingkat lebih pekat dari
 * latar ikon normal, supaya umpan balik tekan terasa tanpa menyilaukan.
 *
 *   income     → uang masuk  (Penerimaan)
 *   expense    → uang keluar (Pengeluaran)
 *   adjustment → koreksi/penyesuaian (netral, warna brand)
 *
 * Dipakai untuk AKSEN saja (ikon + latar wadah ikon). Permukaan kartu,
 * judul, dan subjudul tetap netral — bukan kartu merah penuh.
 *
 * RC-S70.1 — token yang sama dipakai ulang untuk SELURUH ikon di dalam
 * menu Pengeluaran (bukan hanya kartu hub). SENGAJA TIDAK ada token
 * merah baru: state ditekan/aktif diberi umpan balik lewat latar
 * `expensePressed` yang sudah ada, dan state nonaktif — bila nanti
 * diperlukan — harus memakai opacity di atas `expenseIcon`, bukan hex
 * merah tambahan. Satu merah saja untuk Pengeluaran.
 */
export const semantic = {
  incomeIcon: colors.success,
  incomeIconBackground: colors.primaryLight,
  incomePressed: '#D6E9D8',

  expenseIcon: colors.danger,
  expenseIconBackground: colors.dangerBg,
  expensePressed: '#F9DADA',

  adjustmentIcon: colors.primary,
  adjustmentIconBackground: colors.primaryLight,
  adjustmentPressed: '#D6E9D8',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
};

/**
 * UI/UX POLISH — token ukuran ikon (Ionicons). Satu sumber supaya ikon
 * menu, ikon kartu, dan ikon tab tidak memakai angka acak per layar.
 *   sm  — ikon aksi kecil/inline (Edit, Pelepasan, chevron toggle)
 *   md  — ikon di dalam wadah kartu sub-menu / section
 *   lg  — ikon tab bawah
 *   xl  — ikon kartu kategori utama (hub Transaksi)
 */
export const iconSize = {
  sm: 16,
  md: 20,
  lg: 22,
  xl: 28,
};

/** Tinggi minimum area sentuh (≈ 44–48 dp, pedoman aksesibilitas). */
export const touchTarget = 44;

/**
 * UI/UX REDESIGN — elevasi halus. Satu tingkat saja untuk kartu yang bisa
 * ditekan: cukup untuk memberi kesan "terangkat" tanpa bayangan besar.
 */
export const elevation = {
  card: {
    elevation: 1,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
};

/** UI/UX REDESIGN — skala tipografi (sp). */
export const typography = {
  screenTitle: 17,
  sectionTitle: 15,
  body: 14,
  subtitle: 13,
  caption: 12,
};

/**
 * RC-S85 — TOKEN LAYAR PEMBUKA (SplashIntro).
 *
 * Diambil langsung dari logo `assets/img/logo-kopku.png` (navy tile, cincin
 * hijau-biru, figur toska) supaya layar pembuka menyatu dengan logonya.
 * HANYA dipakai `components/SplashIntro.tsx`; palet aplikasi (hijau brand
 * di atas) tidak berubah.
 */
export const splashColors = {
  background: '#061429',
  backgroundGlow: '#0B2A52',
  cyan: '#00B8C6',
  green: '#7ED321',
  title: '#FFFFFF',
  subtitle: '#9FB3CF',
  track: '#16305A',
};

/**
 * Palet SplashIntro per mode tampilan perangkat (terang = siang, gelap =
 * malam). `background` WAJIB sama dengan warna native splash Android di
 * app.json (`android.splash.backgroundColor` / `.dark.backgroundColor`)
 * supaya peralihan native splash -> SplashIntro tanpa kedip (dikunci tes).
 */
export interface PaletSplash {
  background: string;
  auraA: string;
  auraB: string;
  auraOpacity: number;
  cyan: string;
  green: string;
  title: string;
  accent: string;
  subtitle: string;
  muted: string;
  track: string;
  ring: string;
  logoShadow: string;
  statusBar: 'light' | 'dark';
}

export const splashTema: { terang: PaletSplash; gelap: PaletSplash } = {
  terang: {
    background: '#F5F8FC',
    auraA: '#BFEFF3',
    auraB: '#DDF3C6',
    auraOpacity: 0.55,
    cyan: '#00A3B0',
    green: '#5DB51A',
    title: '#0B1F3A',
    accent: '#0090A0',
    subtitle: '#4E6280',
    muted: '#8A9AB0',
    track: '#E1E8F1',
    ring: '#D4E2EE',
    logoShadow: '#0B2A52',
    statusBar: 'dark',
  },
  gelap: {
    background: splashColors.background,
    auraA: '#0E3A63',
    auraB: '#123A2E',
    auraOpacity: 0.6,
    cyan: splashColors.cyan,
    green: splashColors.green,
    title: splashColors.title,
    accent: '#3FD3DF',
    subtitle: splashColors.subtitle,
    muted: '#6F86A8',
    track: splashColors.track,
    ring: '#173763',
    logoShadow: splashColors.cyan,
    statusBar: 'light',
  },
};

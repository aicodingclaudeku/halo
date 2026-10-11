/**
 * KOPKU DESKTOP — modal sebagai DIALOG di tengah jendela.
 *
 * Di HP kartu modal selebar layar dan "sheet" menempel di bawah. Di
 * jendela desktop yang lebar itu tampak janggal, jadi di sini kartu &
 * sheet dibatasi lebarnya, dipusatkan, diberi bayangan dialog, dan
 * backdrop sedikit lebih terang. Struktur JSX, urutan aksi, dan handler
 * semua modal TIDAK berubah — hanya token tampilan.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dasar: typeof import('./modal') = require('./modal.ts');
import { colors, radius, spacing } from './colors';

const bayanganDialog = {
  shadowColor: '#0B1220',
  shadowOpacity: 0.18,
  shadowRadius: 24,
  shadowOffset: { width: 0, height: 12 },
};

export const modalUi = {
  ...dasar.modalUi,
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,32,0.42)' },
  scrollContent: { ...dasar.modalUi.scrollContent, padding: spacing.xl },
  card: {
    ...dasar.modalUi.card,
    maxWidth: 620,
    alignSelf: 'center' as const,
    borderRadius: radius.lg,
    padding: spacing.xl,
    borderColor: colors.border,
    ...bayanganDialog,
  },
  sheet: {
    ...dasar.modalUi.sheet,
    maxWidth: 720,
    alignSelf: 'center' as const,
    borderRadius: radius.lg,
    marginBottom: spacing.xl,
    padding: spacing.xl,
    ...bayanganDialog,
  },
  title: { ...dasar.modalUi.title, fontSize: 18, lineHeight: 24 },
  description: { ...dasar.modalUi.description, fontSize: 13, lineHeight: 19 },
} as unknown as typeof dasar.modalUi;

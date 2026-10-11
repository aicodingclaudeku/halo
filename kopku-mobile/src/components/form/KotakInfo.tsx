import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing, touchTarget, typography } from '@/theme/colors';

type Nada = 'info' | 'peringatan' | 'bahaya' | 'netral';

const GAYA: Record<Nada, { bg: string; batas: string; teks: string; ikon: keyof typeof Ionicons.glyphMap; warnaIkon: string }> = {
  info: { bg: colors.primaryLight, batas: colors.primaryLight, teks: colors.primaryDark, ikon: 'information-circle-outline', warnaIkon: colors.primary },
  peringatan: { bg: colors.warningBg, batas: colors.warningBorder, teks: colors.text, ikon: 'alert-circle-outline', warnaIkon: colors.warning },
  bahaya: { bg: colors.dangerBg, batas: colors.dangerBg, teks: colors.danger, ikon: 'alert-circle', warnaIkon: colors.danger },
  netral: { bg: colors.background, batas: colors.border, teks: colors.textMuted, ikon: 'information-circle-outline', warnaIkon: colors.textMuted },
};

/**
 * RC-S122 — KOTAK INFORMASI (presentasi murni).
 *
 * Penjelasan atau peringatan di dalam form. Ikon + teks selalu tampil
 * bersama (warna bukan satu-satunya penanda). Bila ada `aksi`, kotak
 * memberi jalan keluar langsung — mis. "Buka Pelaksanaan RAT" — alih-alih
 * hanya memberi tahu apa yang salah.
 */
export default function KotakInfo({
  nada = 'info',
  judul,
  children,
  aksi,
}: {
  nada?: Nada;
  judul?: string;
  children: React.ReactNode;
  aksi?: { label: string; onPress: () => void };
}) {
  const g = GAYA[nada];
  return (
    <View style={[styles.kotak, { backgroundColor: g.bg, borderColor: g.batas }]}>
      <Ionicons name={g.ikon} size={18} color={g.warnaIkon} style={styles.ikon} />
      <View style={styles.isi}>
        {judul ? <Text style={[styles.judul, { color: g.teks }]}>{judul}</Text> : null}
        {typeof children === 'string' ? <Text style={[styles.teks, { color: g.teks }]}>{children}</Text> : children}
        {aksi ? (
          <TouchableOpacity style={styles.aksi} onPress={aksi.onPress} accessibilityRole="button" accessibilityLabel={aksi.label}>
            <Text style={[styles.aksiTeks, { color: g.warnaIkon }]}>{aksi.label}</Text>
            <Ionicons name="chevron-forward" size={16} color={g.warnaIkon} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  kotak: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  ikon: { marginTop: 1, flexShrink: 0 },
  isi: { flex: 1, minWidth: 0 },
  judul: { fontSize: typography.subtitle, fontWeight: '700', marginBottom: 2 },
  teks: { fontSize: typography.caption, lineHeight: 18 },
  aksi: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: touchTarget - 8, alignSelf: 'flex-start', marginTop: spacing.xs },
  aksiTeks: { fontSize: typography.caption, fontWeight: '700' },
});

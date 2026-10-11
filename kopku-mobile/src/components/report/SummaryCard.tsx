import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';

/**
 * Kartu ringkasan menonjol (Revisi UI/UX §7 — SHU Neto sebagai visual
 * focal point). Dipakai HANYA untuk angka yang paling penting di
 * sebuah laporan (SHU Neto, Total Aset, dst) — bukan setiap baris,
 * sesuai §22 ("jangan membuat setiap baris menjadi card").
 */
export default function SummaryCard({
  label,
  value,
  caption,
}: {
  label: string;
  value: number;
  caption?: string;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, value < 0 && styles.valueNegative]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
        {formatRupiah(value)}
      </Text>
      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.primaryLight,
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    marginVertical: spacing.lg,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  value: {
    fontSize: 24,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    color: colors.primary,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  valueNegative: { color: colors.danger },
  caption: { fontSize: 12, color: colors.textMuted, marginTop: spacing.xs, textAlign: 'center' },
});

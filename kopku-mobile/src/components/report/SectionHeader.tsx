import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing } from '@/theme/colors';

/**
 * Header seksi laporan (Revisi UI/UX §6 — LEVEL 2: PARTISIPASI
 * ANGGOTA/BEBAN USAHA/HASIL INVESTASI/dst). REUSE di seluruh layar
 * laporan supaya hierarchy visual konsisten.
 */
export default function SectionHeader({ title }: { title: string }) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // UI/UX REDESIGN T2 — garis bawah tipis memisahkan section dari barisnya.
  wrap: {
    marginBottom: spacing.sm,
    marginTop: spacing.md,
    paddingBottom: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.primary,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
});

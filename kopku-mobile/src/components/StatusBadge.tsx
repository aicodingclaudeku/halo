import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { radius, spacing } from '@/theme/colors';

/**
 * Badge status generik (Revisi UI/UX §11 — "gunakan badge/status chip
 * yang konsisten"). Domain masing-masing (SHU DRAFT/DIAJUKAN/dst, dll)
 * tetap memetakan label & warnanya sendiri — komponen ini murni
 * presentasi, supaya REUSE lintas layar tanpa perlu tahu domain apa
 * pun.
 */
export default function StatusBadge({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return <Text style={[styles.badge, { backgroundColor: bg, color: fg }]}>{label}</Text>;
}

const styles = StyleSheet.create({
  badge: {
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    overflow: 'hidden',
    alignSelf: 'flex-start',
  },
});

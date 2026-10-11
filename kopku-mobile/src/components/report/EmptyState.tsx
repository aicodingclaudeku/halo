import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, iconSize, spacing } from '@/theme/colors';

/**
 * Empty state bersama untuk layar laporan.
 *
 * UI/UX REDESIGN — diberi ikon semantik (default: baki kosong) supaya
 * keadaan kosong terlihat disengaja, bukan layar yang gagal dimuat.
 * Prop `message` & pemakaian existing tidak berubah; `icon` & `title`
 * opsional.
 */
export default function EmptyState({
  message,
  title,
  icon = 'file-tray-outline',
}: {
  message: string;
  title?: string;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <View style={styles.wrap} accessibilityRole="text">
      <Ionicons name={icon} size={iconSize.xl} color={colors.textFaint} />
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingVertical: spacing.xxl, paddingHorizontal: spacing.lg, alignItems: 'center', gap: spacing.sm },
  title: { color: colors.text, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  text: { color: colors.textMuted, fontSize: 13, lineHeight: 18, textAlign: 'center' },
});

import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '@/theme/colors';

/**
 * Tombol Edit ikon+label (Revisi UI/UX §9/§10/§15): mudah ditemukan
 * tanpa mendominasi layar — kategori "tertiary button" (outline, bukan
 * warna solid primary/danger). REUSE di seluruh layar yang butuh
 * tombol Edit (SHU, dst) alih-alih tombol teks polos atau ikon tanpa
 * label.
 */
export default function EditButton({
  onPress,
  disabled,
  label = 'Edit',
}: {
  onPress: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.button, disabled && styles.disabled]}
      onPress={onPress}
      disabled={disabled}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Ionicons name="create-outline" size={15} color={colors.primary} />
      <Text style={styles.text}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  disabled: { opacity: 0.5 },
  text: { fontSize: 12, fontWeight: '700', color: colors.primary },
});

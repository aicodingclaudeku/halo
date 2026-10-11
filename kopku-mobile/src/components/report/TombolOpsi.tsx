import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '@/theme/colors';

/**
 * Tombol opsi laporan (on/off) — pengganti checkbox kecil. PRESENTASI
 * SAJA: `onPress` memanggil setter state yang sama seperti checkbox lama.
 */
export default function TombolOpsi({
  label,
  keterangan,
  ikon,
  aktif,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  keterangan?: string;
  ikon: keyof typeof Ionicons.glyphMap;
  aktif: boolean;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="switch"
      accessibilityState={{ checked: aktif, disabled: !!disabled }}
      accessibilityLabel={label}
      style={[styles.tombol, aktif && styles.tombolAktif, disabled && styles.tombolNonaktif]}
      onPress={onPress}
      disabled={disabled}
    >
      <Ionicons name={ikon} size={16} color={aktif ? colors.white : colors.primary} style={styles.ikon} />
      {/* Poin 16 — label boleh dua baris (tidak lagi terpotong "Mode Kompa…"
          di layar sempit); ikon tidak menyusut sehingga tidak menutupi teks. */}
      <View style={styles.teks}>
        <Text style={[styles.label, aktif && styles.labelAktif]} numberOfLines={2}>
          {label}
        </Text>
        {keterangan ? (
          <Text style={[styles.keterangan, aktif && styles.keteranganAktif]} numberOfLines={2}>
            {keterangan}
          </Text>
        ) : null}
      </View>
      <Ionicons
        name={aktif ? 'checkmark-circle' : 'ellipse-outline'}
        size={16}
        color={aktif ? colors.white : colors.textFaint}
        style={styles.ikon}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  tombol: {
    // Poin 16 — dua tombol berbagi lebar secara adil; bila layar terlalu
    // sempit (< ~2 x 140px) tombol turun ke baris berikutnya (opsiRow
    // flexWrap) alih-alih memotong teks.
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 140,
    minWidth: 140,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    minHeight: 52,
  },
  tombolAktif: { backgroundColor: colors.primary, borderColor: colors.primary },
  tombolNonaktif: { opacity: 0.45 },
  ikon: { flexShrink: 0 },
  teks: { flex: 1, minWidth: 0 },
  label: { fontSize: 13, fontWeight: '700', color: colors.text, lineHeight: 17 },
  labelAktif: { color: colors.white },
  keterangan: { fontSize: 10.5, color: colors.textMuted, marginTop: 1 },
  keteranganAktif: { color: colors.primaryLight },
});

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing, touchTarget, typography } from '@/theme/colors';

export interface OpsiPilihan<T extends string> {
  nilai: T;
  label: string;
  ikon?: keyof typeof Ionicons.glyphMap;
  /** Satu kalimat pendek: apa akibat memilih opsi ini. */
  keterangan?: string;
}

/**
 * RC-S122 — PILIHAN OPSI (pilihan tunggal, presentasi murni).
 *
 * Ubin bersisian dengan lebar sama. Opsi terpilih ditandai TIGA cara
 * sekaligus — warna batas, latar, dan ikon centang — supaya warna bukan
 * satu-satunya penanda. Lebar batas tidak berubah saat terpilih, jadi
 * tata letak tidak meloncat.
 *
 * `onChange` hanya menerima nilai opsi; keputusan apa pun tetap milik
 * layar pemanggil.
 */
export default function PilihanOpsi<T extends string>({
  opsi,
  nilai,
  onChange,
  labelAksesibilitas,
}: {
  opsi: readonly OpsiPilihan<T>[];
  nilai: T;
  onChange: (v: T) => void;
  labelAksesibilitas?: string;
}) {
  return (
    <View style={styles.baris} accessibilityRole="radiogroup" accessibilityLabel={labelAksesibilitas}>
      {opsi.map((o) => (
        <UbinOpsi
          key={o.nilai}
          label={o.label}
          ikon={o.ikon}
          keterangan={o.keterangan}
          aktif={o.nilai === nilai}
          onPress={() => onChange(o.nilai)}
        />
      ))}
    </View>
  );
}

/** Satu ubin — diekspor supaya layar yang punya pemetaan sendiri bisa memakainya langsung. */
export function UbinOpsi({
  label,
  ikon,
  keterangan,
  aktif,
  onPress,
}: {
  label: string;
  ikon?: keyof typeof Ionicons.glyphMap;
  keterangan?: string;
  aktif: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.ubin, aktif && styles.ubinAktif]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityRole="radio"
      accessibilityState={{ selected: aktif, checked: aktif }}
      accessibilityLabel={keterangan ? `${label}. ${keterangan}` : label}
    >
      <View style={styles.ubinKepala}>
        {ikon ? <Ionicons name={ikon} size={18} color={aktif ? colors.primary : colors.textMuted} /> : null}
        <Text style={[styles.ubinLabel, aktif && styles.ubinLabelAktif]} numberOfLines={2}>
          {label}
        </Text>
        <Ionicons
          name={aktif ? 'checkmark-circle' : 'ellipse-outline'}
          size={18}
          color={aktif ? colors.primary : colors.border}
        />
      </View>
      {keterangan ? <Text style={styles.ubinKeterangan}>{keterangan}</Text> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  baris: { flexDirection: 'row', gap: spacing.sm },
  ubin: {
    flex: 1,
    minWidth: 0,
    minHeight: touchTarget + 4,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  ubinAktif: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  ubinKepala: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  ubinLabel: { flex: 1, minWidth: 0, fontSize: typography.body, fontWeight: '600', color: colors.text },
  ubinLabelAktif: { color: colors.primaryDark },
  ubinKeterangan: { fontSize: 11.5, color: colors.textMuted, lineHeight: 16, marginTop: spacing.xs },
});

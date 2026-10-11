import React from 'react';
import { Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, elevation, radius, spacing } from '@/theme/colors';

/**
 * RC-S122 — TOMBOL AKSI UTAMA FORM (presentasi murni).
 *
 * Satu tombol penuh-lebar di akhir form. Saat `memuat`, label diganti
 * indikator dan tombol tidak dapat ditekan; saat `nonaktif`, tombol
 * diredam dan tidak dapat ditekan. Validasi tetap milik pemanggil —
 * `nonaktif` hanya untuk kondisi yang memang pasti ditolak (mis. saldo
 * sumber tidak cukup), bukan pengganti pesan error.
 *
 * `nada="bahaya"` untuk aksi yang menghapus/mengeluarkan nilai.
 */
export default function TombolUtama({
  label,
  ikon,
  onPress,
  memuat = false,
  nonaktif = false,
  nada = 'utama',
}: {
  label: string;
  ikon?: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  memuat?: boolean;
  nonaktif?: boolean;
  nada?: 'utama' | 'bahaya';
}) {
  const tidakAktif = memuat || nonaktif;
  return (
    <TouchableOpacity
      style={[styles.tombol, nada === 'bahaya' && styles.tombolBahaya, tidakAktif && styles.redup]}
      onPress={onPress}
      disabled={tidakAktif}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: tidakAktif, busy: memuat }}
    >
      {memuat ? (
        <ActivityIndicator color={colors.white} />
      ) : (
        <>
          {ikon ? <Ionicons name={ikon} size={18} color={colors.white} /> : null}
          <Text style={styles.teks}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  tombol: {
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 52,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xl,
    ...elevation.card,
  },
  tombolBahaya: { backgroundColor: colors.danger },
  redup: { opacity: 0.55 },
  teks: { color: colors.white, fontWeight: '700', fontSize: 15 },
});

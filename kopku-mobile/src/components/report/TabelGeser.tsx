import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, LayoutChangeEvent, TextStyle, StyleProp } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '@/theme/colors';

/**
 * TABEL LAPORAN YANG DAPAT DIGESER KE KANAN — PRESENTASI SAJA.
 *
 * Masalah yang diperbaiki: kolom nominal ber-`flex: 1` pada layar
 * ponsel terlalu sempit untuk angka ratusan juta/miliar, sehingga
 * "Rp123.456.789" terpotong dan sisa angka nolnya turun ke baris
 * berikutnya. Di sini setiap kolom nominal diberi LEBAR TETAP dan
 * teksnya satu baris; bila total lebar tabel melebihi layar, tabel
 * dapat digeser ke kanan. Bila layar cukup lebar, kolom akun melebar
 * mengisi sisa ruang sehingga tabel tetap penuh selebar kartu.
 *
 * Tidak ada data, urutan, atau nilai yang diubah — komponen ini hanya
 * membungkus baris yang dirender layar pemanggil.
 */

import { LEBAR_KOLOM_AKUN, LEBAR_KOLOM_NILAI, lebarTabel } from './tabelGeserUkuran';

export { LEBAR_KOLOM_AKUN, LEBAR_KOLOM_NILAI, lebarTabel };

export default function TabelGeser({
  lebarMinimum,
  children,
  geser = true,
}: {
  lebarMinimum: number;
  children: React.ReactNode;
  /**
   * `false` = tabel TIDAK dapat digeser: selebar kartu, kolom akun
   * menyusut/membungkus teks. Dipakai tabel dengan satu kolom nominal
   * (mis. Posisi Keuangan mode tunggal) yang selalu muat di layar.
   */
  geser?: boolean;
}) {
  const [lebarWadah, setLebarWadah] = useState(0);
  if (!geser) {
    return <View style={styles.kartu}>{children}</View>;
  }
  const onLayout = (e: LayoutChangeEvent) => setLebarWadah(Math.round(e.nativeEvent.layout.width));
  const perluGeser = lebarWadah > 0 && lebarMinimum > lebarWadah;

  return (
    <View style={styles.kartu} onLayout={onLayout}>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator={perluGeser}
        bounces={false}
      >
        <View style={{ width: Math.max(lebarMinimum, lebarWadah) }}>{children}</View>
      </ScrollView>
      {perluGeser ? (
        <View style={styles.petunjuk}>
          <Ionicons name="swap-horizontal-outline" size={13} color={colors.textMuted} />
          <Text style={styles.petunjukText}>Geser tabel ke kanan untuk melihat semua kolom</Text>
        </View>
      ) : null}
    </View>
  );
}

/** Sel nominal: lebar tetap, rata kanan, satu baris, angka tabular. */
export function SelNilai({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return (
    <Text style={[styles.selNilai, style]} numberOfLines={1}>
      {children}
    </Text>
  );
}

export const tabelUi = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    backgroundColor: colors.primaryLight,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  th: { fontSize: 10.5, fontWeight: '700', color: colors.primary, letterSpacing: 0.4, textTransform: 'uppercase' },
  thNilai: { width: LEBAR_KOLOM_NILAI, textAlign: 'right' },
  kolomAkun: { flex: 1, minWidth: LEBAR_KOLOM_AKUN - spacing.md * 2, paddingRight: spacing.sm },
  baris: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  barisGenap: { backgroundColor: colors.background },
  seksi: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  seksiText: { fontSize: 11.5, fontWeight: '700', color: colors.primary, letterSpacing: 0.5, textTransform: 'uppercase' },
  subtotal: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.text,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  total: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    backgroundColor: colors.primaryLight,
    borderTopWidth: 2,
    borderTopColor: colors.primary,
  },
  label: { fontSize: 13, color: colors.text },
  labelTebal: { fontSize: 13, fontWeight: '700', color: colors.text },
  nilaiTebal: { fontWeight: '700' },
  nilaiUtama: { fontWeight: '700', color: colors.primary },
  nilaiNegatif: { color: colors.danger },
  nilaiRedup: { color: colors.textMuted },
});

const styles = StyleSheet.create({
  kartu: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    marginTop: spacing.md,
  },
  selNilai: {
    width: LEBAR_KOLOM_NILAI,
    textAlign: 'right',
    fontSize: 13,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  petunjuk: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  petunjukText: { fontSize: 11, color: colors.textMuted },
});

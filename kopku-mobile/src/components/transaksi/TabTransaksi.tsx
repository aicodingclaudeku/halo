import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '@/theme/colors';
import { RIWAYAT_MENU, type KunciRiwayatMenu } from '@/utils/riwayatMenu';

export type TabTransaksiNilai = 'BARU' | 'RIWAYAT';

/**
 * Pemisah bagian di atas setiap menu transaksi: "Transaksi Baru | Riwayat"
 * (pola sama seperti Pengajuan | Daftar di menu Keluar Anggota). Murni
 * tampilan: hanya mengganti bagian yang ditampilkan layar pemanggil.
 */
export default function TabTransaksi({
  value,
  onChange,
  menu,
  labelBaru,
}: {
  value: TabTransaksiNilai;
  onChange: (v: TabTransaksiNilai) => void;
  /** Menu pemanggil — menentukan label tab form ("Setor Simpanan", "Bayar Angsuran", …). */
  menu?: KunciRiwayatMenu;
  /** Penimpa label (mis. "Bayar Utang" pada menu yang berbagi riwayat Utang). */
  labelBaru?: string;
}) {
  const label = labelBaru ?? (menu ? RIWAYAT_MENU[menu].labelBaru : 'Transaksi Baru');
  const item = (v: TabTransaksiNilai, label: string, ikon: keyof typeof Ionicons.glyphMap) => {
    const aktif = value === v;
    return (
      <TouchableOpacity
        key={v}
        accessibilityRole="tab"
        accessibilityState={{ selected: aktif }}
        accessibilityLabel={label}
        activeOpacity={0.8}
        style={[styles.item, aktif && styles.itemAktif]}
        onPress={() => onChange(v)}
      >
        <Ionicons name={ikon} size={16} color={aktif ? colors.white : colors.textMuted} />
        <Text style={[styles.text, aktif && styles.textAktif]} numberOfLines={1}>
          {label}
        </Text>
      </TouchableOpacity>
    );
  };
  return (
    <View style={styles.wadah} accessibilityRole="tablist">
      {item('BARU', label, 'create-outline')}
      {item('RIWAYAT', 'Riwayat', 'time-outline')}
    </View>
  );
}

const styles = StyleSheet.create({
  wadah: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 4,
    marginBottom: spacing.lg,
  },
  item: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 40,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
  },
  itemAktif: { backgroundColor: colors.primary },
  text: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  textAktif: { color: colors.white },
});

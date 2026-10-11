import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, elevation, iconSize, radius, semantic, spacing, touchTarget, typography } from '@/theme/colors';
import { ui } from '@/theme/ui';

/**
 * Hub Transaksi — TIGA kategori utama yang setara:
 *   Penerimaan  = uang yang diterima koperasi
 *   Pengeluaran = uang yang dikeluarkan koperasi
 *   Penyesuaian = koreksi & penyesuaian (RC-S68: kategori utama, tidak lagi
 *                 di bawah Pengeluaran)
 *
 * RC-S68.1 — redesign visual: satu gaya kartu untuk ketiga kategori
 * (wadah ikon persegi-bulat yang sama, judul kuat + deskripsi singkat,
 * chevron kecil sebagai affordance, umpan balik tekan, label & hint
 * aksesibilitas). Judul layar "Transaksi" berasal dari header navigator
 * (tanpa judul ganda).
 *
 * RC-S68.2 — POLISH SEMANTIK. Bentuk kartu TIDAK berubah (ukuran wadah
 * ikon, radius, padding, tipografi, chevron, tinggi kartu tetap sama);
 * yang membedakan hanya aksen warna + ikon:
 *
 *   Penerimaan  → aksen hijau  (semantic.income*)     dompet + panah MASUK
 *   Pengeluaran → aksen merah  (semantic.expense*)    dompet + panah KELUAR
 *   Penyesuaian → aksen netral (semantic.adjustment*) ikon penyetelan
 *
 * Ikon dompet + lencana panah dipakai sebagai PASANGAN: Ionicons tidak
 * punya glyph tunggal "wallet-arrow-up"/"cash-out", jadi arah arus kas
 * dibentuk dari dua glyph yang sudah tersedia di set yang sama (tidak ada
 * pustaka ikon baru). Warna merah hanya menyentuh ikon dan latar wadah
 * ikon — permukaan kartu, judul, dan subjudul tetap netral.
 *
 * Seluruh sub-fitur tetap di layar kategorinya masing-masing; rute tidak
 * berubah. Pintasan "Input Data" berada di tab Data.
 */

const KATEGORI: {
  route: 'TransaksiPenerimaan' | 'TransaksiPengeluaran' | 'Penyesuaian';
  icon: keyof typeof Ionicons.glyphMap;
  badge?: keyof typeof Ionicons.glyphMap;
  judul: string;
  deskripsi: string;
  hint: string;
}[] = [
  {
    route: 'TransaksiPenerimaan',
    icon: 'wallet',
    badge: 'arrow-down-circle',
    judul: 'Penerimaan',
    deskripsi: 'Mencatat uang yang diterima koperasi',
    hint: 'Buka transaksi penerimaan koperasi',
  },
  {
    route: 'TransaksiPengeluaran',
    icon: 'wallet',
    badge: 'arrow-up-circle',
    judul: 'Pengeluaran',
    deskripsi: 'Mencatat uang yang dikeluarkan koperasi',
    hint: 'Buka transaksi pengeluaran koperasi',
  },
  {
    route: 'Penyesuaian',
    icon: 'options',
    judul: 'Penyesuaian',
    deskripsi: 'Koreksi dan penyesuaian transaksi',
    hint: 'Buka koreksi dan penyesuaian transaksi',
  },
];

export default function TransaksiScreen() {
  const navigation = useNavigation<any>();
  // Satu state untuk ketiga kartu: rute yang sedang ditekan. Dipakai hanya
  // untuk menguatkan tint latar wadah ikon saat ditekan.
  const [ditekan, setDitekan] = useState<string | null>(null);

  return (
    <ScrollView style={styles.container} contentContainerStyle={ui.screenContent}>
      <Text style={styles.subtitle}>Kelola aktivitas transaksi koperasi.</Text>

      <TouchableOpacity
        style={styles.mainCard}
        accessibilityRole="button"
        accessibilityLabel="Penerimaan"
        accessibilityHint={KATEGORI[0].hint}
        activeOpacity={0.7}
        onPressIn={() => setDitekan('TransaksiPenerimaan')}
        onPressOut={() => setDitekan(null)}
        onPress={() => navigation.navigate('TransaksiPenerimaan')}
      >
        <View
          style={[
            styles.mainIcon,
            {
              backgroundColor:
                ditekan === 'TransaksiPenerimaan' ? semantic.incomePressed : semantic.incomeIconBackground,
            },
          ]}
        >
          <Ionicons name="wallet" size={iconSize.lg} color={semantic.incomeIcon} />
          <View style={styles.badge}>
            <Ionicons name="arrow-down-circle" size={iconSize.sm} color={semantic.incomeIcon} />
          </View>
        </View>
        <View style={styles.teks}>
          <Text style={styles.mainCardTitle}>Penerimaan</Text>
          <Text style={styles.mainCardSub}>{KATEGORI[0].deskripsi}</Text>
        </View>
        <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={ui.chevron} />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.mainCard}
        accessibilityRole="button"
        accessibilityLabel="Pengeluaran"
        accessibilityHint={KATEGORI[1].hint}
        activeOpacity={0.7}
        onPressIn={() => setDitekan('TransaksiPengeluaran')}
        onPressOut={() => setDitekan(null)}
        onPress={() => navigation.navigate('TransaksiPengeluaran')}
      >
        <View
          style={[
            styles.mainIcon,
            {
              backgroundColor:
                ditekan === 'TransaksiPengeluaran' ? semantic.expensePressed : semantic.expenseIconBackground,
            },
          ]}
        >
          <Ionicons name="wallet" size={iconSize.lg} color={semantic.expenseIcon} />
          <View style={styles.badge}>
            <Ionicons name="arrow-up-circle" size={iconSize.sm} color={semantic.expenseIcon} />
          </View>
        </View>
        <View style={styles.teks}>
          <Text style={styles.mainCardTitle}>Pengeluaran</Text>
          <Text style={styles.mainCardSub}>{KATEGORI[1].deskripsi}</Text>
        </View>
        <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={ui.chevron} />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.mainCard}
        accessibilityRole="button"
        accessibilityLabel="Penyesuaian"
        accessibilityHint={KATEGORI[2].hint}
        activeOpacity={0.7}
        onPressIn={() => setDitekan('Penyesuaian')}
        onPressOut={() => setDitekan(null)}
        onPress={() => navigation.navigate('Penyesuaian')}
      >
        <View
          style={[
            styles.mainIcon,
            {
              backgroundColor:
                ditekan === 'Penyesuaian' ? semantic.adjustmentPressed : semantic.adjustmentIconBackground,
            },
          ]}
        >
          <Ionicons name="options" size={iconSize.lg} color={semantic.adjustmentIcon} />
        </View>
        <View style={styles.teks}>
          <Text style={styles.mainCardTitle}>Penyesuaian</Text>
          <Text style={styles.mainCardSub}>Koreksi dan penyesuaian transaksi</Text>
        </View>
        <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={ui.chevron} />
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  subtitle: { ...ui.screenIntro },
  // Kartu kategori: bahasa visual sama dengan ui.menuCard, sedikit lebih
  // lapang karena ini tingkat navigasi teratas. Permukaan kartu SELALU
  // netral — warna semantik hanya pada wadah ikon (RC-S68.2).
  mainCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
    minHeight: touchTarget + spacing.xl,
    ...elevation.card,
  },
  // Wadah ikon seragam (persegi-bulat) — ukuran, radius, dan posisi sama
  // untuk ketiga kategori; hanya `backgroundColor` yang semantik dan
  // diberikan per kartu.
  mainIcon: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Lencana arah arus kas (panah masuk/keluar) di sudut wadah ikon.
  // Diberi cincin warna permukaan supaya panah tetap terbaca di atas tint.
  badge: {
    position: 'absolute',
    right: 1,
    bottom: 1,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  teks: { flex: 1, minWidth: 0 },
  mainCardTitle: { fontSize: typography.screenTitle, lineHeight: 22, fontWeight: '700', color: colors.text },
  mainCardSub: { fontSize: typography.caption, lineHeight: 18, color: colors.textMuted, marginTop: 2 },
});

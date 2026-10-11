import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, iconSize, spacing, touchTarget, typography } from '@/theme/colors';

/**
 * UI/UX REDESIGN — HEADER APLIKASI COMPACT (pengganti tampilan header
 * native `native-stack`, BUKAN pengganti navigasinya).
 *
 * Susunan vertikal:
 *   [ inset status bar  = insets.top dari safe-area-context, dinamis ]
 *   [ bar header        = minHeight 56 dp: back · judul · headerRight ]
 *   [ konten layar ]
 *
 * - Inset diambil dari `useSafeAreaInsets()` — tidak ada angka tetap, tidak
 * ada `position: 'absolute'`, tidak membaca tinggi status bar secara manual. Judul dan
 *   tombol tidak pernah berada di zona jam/sinyal/baterai.
 * - Satu-satunya inset atas untuk layar ber-stack; layar di bawahnya TIDAK
 *   boleh memakai SafeAreaView top lagi (menghindari inset ganda).
 * - `minHeight` (bukan `height`) supaya judul 2 baris / font scale besar
 *   membuat bar tumbuh, bukan terpotong.
 * - Perilaku: back = `navigation.goBack()` (sama dengan tombol back bawaan),
 *   judul = `options.title` (termasuk yang di-set lewat setOptions), dan
 *   `options.headerRight` dirender apa adanya (Export/Refresh existing).
 */
type Props = {
  navigation: { goBack: () => void };
  route: { name: string };
  options: {
    title?: string;
    headerTitle?: unknown;
    headerRight?: (p: { tintColor?: string; canGoBack: boolean }) => React.ReactNode;
  };
  back?: unknown;
};

export default function AppHeader({ navigation, route, options, back }: Props) {
  const insets = useSafeAreaInsets();
  const judul = typeof options.headerTitle === 'string' ? options.headerTitle : options.title ?? route.name;
  const kanan = options.headerRight ? options.headerRight({ tintColor: colors.primary, canGoBack: !!back }) : null;

  return (
    <View style={[styles.wrap, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        {back ? (
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Kembali"
          >
            <Ionicons name="arrow-back" size={iconSize.lg} color={colors.text} />
          </TouchableOpacity>
        ) : null}
        <Text style={[styles.title, !back && styles.titleNoBack]} numberOfLines={2} accessibilityRole="header">
          {judul}
        </Text>
        {kanan ? <View style={styles.right}>{kanan}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bar: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
  },
  backBtn: {
    width: touchTarget + spacing.xs,
    height: touchTarget + spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  title: {
    flex: 1,
    fontSize: typography.screenTitle,
    lineHeight: 22,
    fontWeight: '700',
    color: colors.text,
    paddingVertical: spacing.sm,
    marginLeft: spacing.xs,
  },
  titleNoBack: { marginLeft: spacing.md },
  right: { flexShrink: 0, paddingRight: spacing.sm, flexDirection: 'row', alignItems: 'center' },
});

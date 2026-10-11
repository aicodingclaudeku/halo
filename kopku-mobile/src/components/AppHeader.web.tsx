import React, { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';
import { GRUP_TAB } from '@/desktop/katalogMenu';

/**
 * KOPKU DESKTOP — HEADER HALAMAN.
 *
 * Pengganti tampilan `AppHeader` HP khusus desktop: jejak lokasi
 * (breadcrumb: Tab › layar sebelumnya), judul halaman besar, tombol
 * "Kembali" yang jelas, dan aksi `headerRight` layar di kanan. Perilaku
 * SAMA dengan AppHeader HP: kembali = `navigation.goBack()`, judul =
 * `options.title`/`headerTitle`, `headerRight` dirender apa adanya.
 * Tambahan desktop: Alt+← juga kembali (hanya untuk layar yang fokus).
 */
type Props = {
  navigation: { goBack: () => void; isFocused?: () => boolean; getParent?: () => any };
  route: { name: string };
  options: {
    title?: string;
    headerTitle?: unknown;
    headerRight?: (p: { tintColor?: string; canGoBack: boolean }) => React.ReactNode;
  };
  back?: { title?: string } | unknown;
};

function labelTab(navigation: Props['navigation']): string | null {
  try {
    const induk = navigation.getParent?.();
    const st = induk?.getState?.();
    const nama = st?.routes?.[st.index]?.name;
    if (!nama) return 'Koperasi';
    return GRUP_TAB.find((g) => g.tab === nama)?.label ?? null;
  } catch {
    return null;
  }
}

export default function AppHeader({ navigation, route, options, back }: Props) {
  const judul = typeof options.headerTitle === 'string' ? options.headerTitle : options.title ?? route.name;
  const kanan = options.headerRight ? options.headerRight({ tintColor: colors.primary, canGoBack: !!back }) : null;
  const sebelum = back && typeof back === 'object' ? (back as { title?: string }).title : undefined;
  const tab = labelTab(navigation);

  useEffect(() => {
    if (!back) return;
    const tombol = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft' && (navigation.isFocused?.() ?? false)) {
        e.preventDefault();
        navigation.goBack();
      }
    };
    globalThis.addEventListener?.('keydown', tombol as any);
    return () => globalThis.removeEventListener?.('keydown', tombol as any);
  }, [back, navigation]);

  return (
    <View style={s.wrap}>
      <View style={s.bar}>
        {back ? (
          <Pressable
            onPress={() => navigation.goBack()}
            style={({ hovered }: any) => [s.kembali, hovered && s.kembaliHover]}
            accessibilityRole="button"
            accessibilityLabel="Kembali (Alt+←)"
          >
            <Ionicons name="arrow-back" size={18} color={colors.text} />
          </Pressable>
        ) : null}
        <View style={s.teks}>
          <View style={s.jejak}>
            {!!tab && <Text style={s.jejakTeks}>{tab}</Text>}
            {!!sebelum && sebelum !== tab && sebelum !== judul && (
              <>
                <Ionicons name="chevron-forward" size={11} color={colors.textFaint} />
                <Text style={s.jejakTeks} numberOfLines={1}>
                  {sebelum}
                </Text>
              </>
            )}
            {judul !== tab && (
              <>
                {(!!tab || !!sebelum) && <Ionicons name="chevron-forward" size={11} color={colors.textFaint} />}
                <Text style={[s.jejakTeks, s.jejakKini]} numberOfLines={1}>
                  {judul}
                </Text>
              </>
            )}
          </View>
          <Text style={s.judul} numberOfLines={2} accessibilityRole="header">
            {judul}
          </Text>
        </View>
        {kanan ? <View style={s.kanan}>{kanan}</View> : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { backgroundColor: colors.background, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 4 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 52 },
  kembali: {
    width: 36,
    height: 36,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  kembaliHover: { borderColor: '#C3CBD5', backgroundColor: '#FAFBFC' },
  teks: { flex: 1, minWidth: 0 },
  jejak: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 },
  jejakTeks: { fontSize: 12, color: colors.textFaint, maxWidth: 260 },
  jejakKini: { color: colors.textMuted, fontWeight: '600' },
  judul: { fontSize: 22, lineHeight: 28, fontWeight: '800', color: colors.text, letterSpacing: -0.2 },
  kanan: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 6,
    minHeight: 40,
  },
});

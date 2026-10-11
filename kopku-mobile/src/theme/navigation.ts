import { colors } from './colors';

/**
 * UI/UX POLISH + REDESIGN — PRESENTASI HEADER & TAB BAR SAJA.
 *
 * Header: tampilannya digambar `AppHeader` (lihat RootNavigator —
 * `stackScreenOptions` menambahkan `header` di sana karena berkas .ts ini
 * tidak boleh berisi JSX). `AppHeader` memakai `useSafeAreaInsets()` untuk
 * inset status bar, sehingga di sini TIDAK ADA:
 *   - `position: 'absolute'` / `top: 0`,
 *   - `paddingTop` / tinggi angka tetap,
 *   - `headerTransparent` / `statusBarTranslucent`,
 *   - SafeAreaView kedua di dalam layar ber-header (inset ganda).
 *
 * Objek biasa (literal `as const`), tanpa import tipe @react-navigation/*:
 * tetap assignable ke `screenOptions` navigator, dan berkas ini bisa
 * di-typecheck oleh konfigurasi yang tidak memuat node_modules.
 */
export const stackPresentationOptions = {
  headerStyle: { backgroundColor: colors.surface },
  headerTintColor: colors.primary,
  headerTitleStyle: { fontSize: 17, fontWeight: '700' as const, color: colors.text },
  headerTitleAlign: 'left' as const,
  contentStyle: { backgroundColor: colors.background },
};

/**
 * Tab bar bawah: HANYA warna, garis atas, tipografi label, dan
 * menyembunyikan tab bar saat keyboard terbuka (supaya tab bar tidak
 * menutupi field/tombol form di Android). `height`/`paddingBottom` SENGAJA
 * TIDAK diset — bottom-tabs v7 menambah inset navigation bar Android sendiri
 * lewat safe-area-context; tinggi tetap akan memotong label di perangkat
 * dengan navigation bar tinggi.
 */
export const tabBarPresentationOptions = {
  tabBarActiveTintColor: colors.primary,
  tabBarInactiveTintColor: colors.textFaint,
  tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, borderTopWidth: 1 },
  tabBarLabelStyle: { fontSize: 11, fontWeight: '600' as const },
  tabBarHideOnKeyboard: true,
};

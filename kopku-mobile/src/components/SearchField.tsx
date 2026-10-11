import React, { useState } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, iconSize } from '@/theme/colors';
import { formUi, inputTypeIcon } from '@/theme/form';

/**
 * ================================================================
 * KOLOM PENCARIAN BERSAMA — MURNI PRESENTASI (§15)
 * ================================================================
 *
 * Sebelum komponen ini ada 20 kolom pencarian dengan 6 bentuk berbeda:
 * sebagian ber-ikon di dalam wadah (gap 6 vs marginRight 8, padding
 * vertikal 0 vs 8), sebagian border langsung di input TANPA ikon, dan
 * tidak satu pun punya focus state. Karena border ada di WADAH, focus
 * state harus diterapkan ke wadah — hal yang tidak bisa dilakukan dari
 * dalam `<TextInput>` itu sendiri.
 *
 * Struktur:  [search-outline]  teks pencarian        <- searchWrap
 *
 * TIDAK mengubah perilaku pencarian: value, onChangeText, autoFocus,
 * placeholder, dan prop TextInput lain diteruskan apa adanya lewat
 * `...rest`. Tidak ada debounce, filter, atau trim di sini. `onFocus`
 * dan `onBlur` pemanggil tetap dipanggil.
 *
 * `wrapStyle` HANYA untuk penempatan (margin, flex) — batas, radius,
 * dan tinggi datang dari `formUi.searchWrap`.
 */
export interface SearchFieldProps extends TextInputProps {
  readonly wrapStyle?: StyleProp<ViewStyle>;
}

export default function SearchField({ wrapStyle, style, onFocus, onBlur, ...rest }: SearchFieldProps) {
  const [fokus, setFokus] = useState(false);

  return (
    <View style={[styles.wrap, wrapStyle, fokus && styles.wrapFocused]}>
      <Ionicons
        name={inputTypeIcon.search as keyof typeof Ionicons.glyphMap}
        size={iconSize.sm}
        color={fokus ? colors.primary : colors.textMuted}
        style={styles.icon}
        // Ikon dekoratif — pembaca layar cukup membaca kolom input.
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <TextInput
        {...rest}
        placeholderTextColor={rest.placeholderTextColor ?? colors.placeholder}
        style={[styles.input, style]}
        onFocus={(e) => {
          setFokus(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFokus(false);
          onBlur?.(e);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { ...formUi.searchWrap },
  wrapFocused: { ...formUi.searchWrapFocused },
  icon: { ...formUi.searchIcon },
  input: { ...formUi.searchInput },
});

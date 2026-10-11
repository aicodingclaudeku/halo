import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, iconSize } from '@/theme/colors';
import { formUi, inputTypeIcon, type InputTypeName } from '@/theme/form';

/**
 * ================================================================
 * INPUT TEKS BERSAMA — MURNI PRESENTASI (§6, §7, §9, §10)
 * ================================================================
 *
 * KENAPA KOMPONEN INI ADA
 * Aplikasi punya 127 `<TextInput>` di 65 berkas. Tidak satu pun punya
 * focus state, dan masing-masing membawa definisi border/padding
 * sendiri. Satu-satunya cara memberi focus state ke semuanya tanpa
 * menyalin `useState` ke 65 layar adalah memusatkannya di satu tempat.
 *
 * APA YANG TIDAK DILAKUKAN KOMPONEN INI — penting, karena inilah yang
 * membuatnya aman dipakai di layar akuntansi:
 *   - TIDAK menyimpan, mengubah, memformat, atau mem-parse value;
 *   - TIDAK punya `onChangeText` sendiri — prop diteruskan apa adanya;
 *   - TIDAK memutuskan kapan error muncul; `error` hanya DITAMPILKAN
 *     bila pemanggil sudah mengirimkannya;
 *   - TIDAK menelan `onFocus`/`onBlur` pemanggil: keduanya tetap
 *     dipanggil (mis. `onBlur` milik react-hook-form), state lokal
 *     hanya ditambahkan untuk warna border.
 *
 * Seluruh prop TextInput lain (keyboardType, editable, autoCapitalize,
 * maxLength, returnKeyType, dst.) diteruskan lewat `...rest`, jadi
 * mengganti `<TextInput>` dengan `<AppTextInput>` tidak menghilangkan
 * perilaku apa pun.
 *
 * TIPE INPUT (§8). `inputType` HANYA memilih ikon default; ia tidak
 * menyetel keyboardType maupun validasi apa pun — itu tetap keputusan
 * layar pemanggil. Untuk nominal Rupiah gunakan `CurrencyInput` yang
 * sudah ada, bukan komponen ini.
 */
export interface AppTextInputProps extends TextInputProps {
  /** Label di atas input. Setiap input wajib punya label (§6). */
  readonly label?: string;
  /** Tanda bahwa field wajib diisi — hanya tampilan, bukan validasi. */
  readonly required?: boolean;
  /**
   * Pesan error yang SUDAH ditentukan pemanggil. Komponen ini tidak
   * pernah membuat, menunda, atau menyembunyikan error sendiri.
   */
  readonly error?: string;
  /** Catatan bantuan di bawah input. */
  readonly hint?: string;
  /** Ikon Ionicons eksplisit; menang atas ikon default `inputType`. */
  readonly icon?: keyof typeof Ionicons.glyphMap;
  /** Tipe visual input — memilih ikon default (§8). */
  readonly inputType?: InputTypeName;
  /** Sembunyikan ikon kiri sepenuhnya. */
  readonly noIcon?: boolean;
  readonly containerStyle?: StyleProp<ViewStyle>;
  readonly wrapStyle?: StyleProp<ViewStyle>;
}

export default function AppTextInput({
  label,
  required,
  error,
  hint,
  icon,
  inputType,
  noIcon,
  containerStyle,
  wrapStyle,
  style,
  onFocus,
  onBlur,
  editable = true,
  multiline,
  ...rest
}: AppTextInputProps) {
  // Status fokus MURNI visual. Tidak memengaruhi nilai maupun handler.
  const [fokus, setFokus] = useState(false);

  const namaIkon: keyof typeof Ionicons.glyphMap | undefined = noIcon
    ? undefined
    : icon ??
      (inputType
        ? (inputTypeIcon[inputType] as keyof typeof Ionicons.glyphMap)
        : multiline
          ? (inputTypeIcon.multiline as keyof typeof Ionicons.glyphMap)
          : undefined);

  const warnaIkon = error ? colors.danger : fokus ? colors.primary : colors.textMuted;

  return (
    <View style={[styles.field, containerStyle]}>
      {label !== undefined && (
        <Text style={styles.label}>
          {label}
          {required ? ' *' : ''}
        </Text>
      )}

      <View
        style={[
          styles.inputWrap,
          multiline && styles.inputWrapMultiline,
          fokus && styles.inputWrapFocus,
          !!error && styles.inputWrapError,
          !editable && styles.inputWrapDisabled,
          wrapStyle,
        ]}
      >
        {namaIkon && (
          <Ionicons
            name={namaIkon}
            size={iconSize.md - 2}
            color={warnaIkon}
            style={[styles.inputIcon, multiline && styles.inputIconMultiline]}
          />
        )}
        <TextInput
          {...rest}
          multiline={multiline}
          editable={editable}
          placeholderTextColor={rest.placeholderTextColor ?? colors.placeholder}
          style={[styles.input, multiline && styles.inputMultiline, style]}
          // Handler pemanggil TETAP dipanggil; state lokal hanya untuk border.
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

      {!!error && (
        <View style={styles.errorRow}>
          <Ionicons name="alert-circle-outline" size={iconSize.sm - 2} color={colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      {!error && !!hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { ...formUi.field },
  label: { ...formUi.label },
  inputWrap: { ...formUi.inputWrap },
  inputWrapFocus: { ...formUi.inputWrapFocus },
  inputWrapError: { ...formUi.inputWrapError },
  inputWrapDisabled: { ...formUi.inputWrapDisabled },
  inputWrapMultiline: { ...formUi.inputWrapMultiline },
  inputIcon: { ...formUi.inputIcon },
  inputIconMultiline: { ...formUi.inputIconMultiline },
  input: { ...formUi.input },
  inputMultiline: { ...formUi.inputMultiline },
  errorRow: { ...formUi.errorRow },
  errorText: { ...formUi.errorText },
  hint: { ...formUi.hint },
});

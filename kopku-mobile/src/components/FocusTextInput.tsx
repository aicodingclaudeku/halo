import React, { useState } from 'react';
import { StyleSheet, TextInput, type TextInputProps } from 'react-native';
import { colors } from '@/theme/colors';
import { formUi } from '@/theme/form';

/**
 * ================================================================
 * INPUT TANPA WADAH + FOCUS STATE — MURNI PRESENTASI
 * ================================================================
 *
 * Pengganti drop-in untuk `<TextInput>` polos yang meletakkan border
 * langsung di input (style `formUi.inputStandalone` dan turunannya).
 * `AppTextInput` tidak cocok untuk pola ini karena ia membawa label,
 * wadah, dan jarak vertikalnya sendiri; memaksakannya ke layar yang
 * labelnya berupa `<Text>` terpisah akan mengubah ritme spasi layar.
 *
 * KONTRAKNYA SAMA DENGAN AppTextInput:
 *   - TIDAK menyimpan, mengubah, memformat, atau mem-parse value;
 *   - TIDAK punya `onChangeText` sendiri — seluruh prop diteruskan
 *     apa adanya lewat `...rest` (value, onChangeText, keyboardType,
 *     multiline, editable, autoFocus, maxLength, onSubmitEditing, dst.);
 *   - TIDAK menelan `onFocus`/`onBlur` pemanggil: keduanya tetap
 *     dipanggil, state lokal hanya menambah satu style;
 *   - TIDAK memutuskan kapan error muncul: `invalid` hanya DITAMPILKAN
 *     bila pemanggil sudah punya error untuk field itu.
 *
 * Urutan style: style pemanggil → nonaktif → fokus → error. Error
 * menang atas fokus (sama seperti AppTextInput), jadi field yang salah
 * tetap merah walau sedang diketik.
 *
 * `ref` (React 19: prop biasa pada function component) ikut diteruskan
 * lewat `...rest`. Saat pass ini tidak ada pemanggil yang memakainya.
 */
export interface FocusTextInputProps extends TextInputProps {
  /** Tampilkan border error. Hanya presentasi; tidak memvalidasi apa pun. */
  readonly invalid?: boolean;
}

export default function FocusTextInput({
  style,
  onFocus,
  onBlur,
  invalid,
  ...rest
}: FocusTextInputProps) {
  // Status fokus MURNI visual. Tidak memengaruhi nilai maupun handler.
  const [fokus, setFokus] = useState(false);
  const nonaktif = rest.editable === false;

  return (
    <TextInput
      {...rest}
      placeholderTextColor={rest.placeholderTextColor ?? colors.placeholder}
      style={[
        style,
        nonaktif && styles.inputDisabled,
        fokus && !nonaktif && styles.inputFocused,
        !!invalid && styles.inputError,
      ]}
      // Handler pemanggil TETAP dipanggil; state lokal hanya untuk style.
      onFocus={(e) => {
        setFokus(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFokus(false);
        onBlur?.(e);
      }}
    />
  );
}

const styles = StyleSheet.create({
  inputFocused: { ...formUi.inputFocused },
  inputDisabled: { ...formUi.inputDisabled },
  inputError: { ...formUi.inputError },
});

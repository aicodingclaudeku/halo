import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, iconSize } from '@/theme/colors';
import { formUi } from '@/theme/form';

/**
 * PESAN ERROR FIELD — presentasi yang sama dengan AppTextInput &
 * CurrencyInput: ikon `alert-circle-outline` + teks, bukan warna saja.
 *
 * MURNI PRESENTASI. Komponen ini tidak pernah memutuskan KAPAN error
 * muncul: pemanggil tetap menulis kondisinya sendiri
 * (`{errors.x && <FieldError message={errors.x} />}`), persis seperti
 * `<Text>` yang digantikannya, sehingga logika validasi tidak tersentuh.
 */
export default function FieldError({ message }: { message: string }) {
  return (
    <View style={styles.row}>
      <Ionicons name="alert-circle-outline" size={iconSize.sm - 2} color={colors.danger} />
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { ...formUi.errorRow },
  text: { ...formUi.errorText },
});

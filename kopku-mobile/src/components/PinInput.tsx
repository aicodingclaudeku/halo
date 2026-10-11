import React, { useRef, useState } from 'react';
import { View, Text, TextInput, TouchableWithoutFeedback, StyleSheet } from 'react-native';
import { colors, radius } from '@/theme/colors';

/**
 * Input PIN 6 digit bergaya kotak-kotak (seperti OTP), menggantikan
 * <TextInput secureTextEntry keyboardType="number-pad" /> bawaan.
 *
 * BUG YANG DIPERBAIKI: di Android (khususnya dengan New Architecture RN
 * 0.81 yang dipakai proyek ini), kombinasi `secureTextEntry` +
 * `keyboardType="number-pad"` sering membuat titik/bullet mask sama
 * sekali TIDAK muncul saat mengetik — kotak input terlihat kosong terus
 * walau PIN sudah terisi (persis keluhan "tidak ada tulisan seperti
 * hidden"). ini bug lama & dikenal di React Native, bukan sesuatu yang
 * bisa diperbaiki lewat prop TextInput manapun.
 *
 * Solusinya: TextInput asli disembunyikan total (dipakai cuma untuk
 * menangkap ketikan & memunculkan keyboard angka), dan yang benar-benar
 * dirender ke layar adalah kotak-kotak ini — titik muncul begitu
 * `value.length` bertambah, jadi selalu terlihat progres PIN-nya tanpa
 * bergantung pada rendering native yang bermasalah itu.
 */
export default function PinInput({
  value,
  onChangeText,
  length = 6,
  autoFocus = false,
  error,
  onFokusBerubah,
}: {
  value: string;
  onChangeText: (v: string) => void;
  length?: number;
  autoFocus?: boolean;
  error?: string;
  /** RC-S130 — memberi tahu pemanggil saat papan ketik PIN aktif/nonaktif (mis. untuk petunjuk "ketuk kotak"). */
  onFokusBerubah?: (fokus: boolean) => void;
}) {
  const inputRef = useRef<TextInput>(null);
  // INPUT STANDARDIZATION — status fokus MURNI visual: kotak berikutnya
  // hanya disorot selama keyboard PIN benar-benar aktif. Sebelumnya sorotan
  // tampil terus walau input sudah blur, sehingga tidak ada penanda bahwa
  // area ini perlu disentuh lagi. Nilai, filter angka, dan maxLength tidak
  // berubah.
  const [fokus, setFokus] = useState(false);
  const digits = value.split('');

  return (
    <TouchableWithoutFeedback onPress={() => inputRef.current?.focus()}>
      <View>
        <View style={[styles.boxRow, error && styles.boxRowError]}>
          {Array.from({ length }).map((_, i) => {
            const filled = i < digits.length;
            const active = fokus && i === digits.length;
            return (
              <View
                key={i}
                style={[
                  styles.box,
                  filled && styles.boxFilled,
                  active && styles.boxActive,
                  !!error && !filled && styles.boxError,
                ]}
              >
                {filled && <View style={styles.dot} />}
              </View>
            );
          })}
        </View>
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={(t) => onChangeText(t.replace(/[^0-9]/g, '').slice(0, length))}
          keyboardType="number-pad"
          maxLength={length}
          autoFocus={autoFocus}
          style={styles.hiddenInput}
          // Tidak pakai secureTextEntry sama sekali — masking dikerjakan
          // sendiri lewat kotak-kotak di atas, jadi tidak kena bug native.
          caretHidden
          onFocus={() => {
            setFokus(true);
            onFokusBerubah?.(true);
          }}
          onBlur={() => {
            setFokus(false);
            onFokusBerubah?.(false);
          }}
        />
      </View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  boxRow: { flexDirection: 'row', justifyContent: 'space-between' },
  boxRowError: {},
  box: {
    width: 44,
    height: 52,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxFilled: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
  },
  boxActive: {
    borderColor: colors.primary,
    borderWidth: 2,
  },
  boxError: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerBg,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.primary,
  },
  hiddenInput: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    opacity: 0,
  },
});

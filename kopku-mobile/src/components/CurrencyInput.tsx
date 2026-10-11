import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, iconSize, radius, spacing, touchTarget } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { formatNominalInput, parseNominalInput } from '@/utils/money';

/**
 * Input nominal Rupiah dengan pemisah ribuan (titik) otomatis saat
 * mengetik — mis. ketik "150000" langsung tampil "150.000". Menggantikan
 * <TextInput keyboardType="number-pad" /> polos yang dipakai di form
 * simpanan/pinjaman/kas-bank, yang sebelumnya tidak ada format sama
 * sekali sehingga nominal besar sulit dibaca & rawan salah ketik jumlah
 * nol.
 *
 * Value yang dikembalikan lewat onChangeValue selalu angka murni
 * (Rupiah, integer) — pemisah titik cuma tampilan, bukan bagian dari
 * data yang disimpan/dihitung.
 */
function CurrencyInputBase({
  value,
  onChangeValue,
  error,
  placeholder = '0',
  autoFocus,
  editable = true,
}: {
  /** Nilai murni dalam Rupiah (integer), atau string kosong saat belum diisi. */
  value: number | '';
  onChangeValue: (v: number | '') => void;
  error?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Update pasca-6-perbaikan §6: false untuk field "Nominal" mode Pelunasan — total dihitung otomatis oleh sistem, tidak boleh diubah bebas oleh user. */
  editable?: boolean;
}) {
  // Format & parse dipindahkan ke utils/money.ts (fungsi murni) supaya
  // perilakunya dapat diuji otomatis — aturannya TIDAK berubah.
  const formatted = formatNominalInput(value);
  // UI/UX REDESIGN T2 — status fokus MURNI visual (warna border). Tidak
  // memengaruhi nilai, parse, maupun onChangeValue.
  const [fokus, setFokus] = useState(false);

  const handleChange = (text: string) => {
    const nilaiBaru = parseNominalInput(text);
    // REQUIREMENT 8 (hardening) — GUARD NO-OP.
    // Kalau hasil parse SAMA dengan nilai yang sedang dipegang parent,
    // jangan panggil onChangeValue sama sekali. Tanpa guard ini,
    // mengetik karakter yang tidak mengubah angka (mis. titik pemisah
    // dari keypad tertentu, atau paste "Rp1.000.000" yang identik)
    // tetap memicu setState di parent -> parent render ulang -> prop
    // `value` di-assign ulang ke TextInput terkontrol -> pada React
    // Native caret bisa dilempar ke akhir teks.
    // Ini MURNI pencegahan render sia-sia; nilai yang benar-benar
    // berubah tetap diteruskan apa adanya.
    if (nilaiBaru === value) return;
    onChangeValue(nilaiBaru);
  };

  return (
    <View>
      <View style={[styles.wrap, fokus && styles.wrapFocus, error && styles.wrapError, !editable && styles.wrapDisabled]}>
        <Text style={styles.prefix}>Rp</Text>
        <TextInput
          style={styles.input}
          value={formatted}
          onChangeText={handleChange}
          keyboardType="number-pad"
          placeholder={placeholder}
          placeholderTextColor={colors.placeholder}
          autoFocus={autoFocus}
          editable={editable}
          onFocus={() => setFokus(true)}
          onBlur={() => setFokus(false)}
        />
      </View>
      {error && (
        <View style={styles.errorRow}>
          <Ionicons name="alert-circle-outline" size={iconSize.sm - 2} color={colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
    </View>
  );
}

/**
 * REQUIREMENT 8 (hardening) — dibungkus React.memo.
 *
 * Layar "Bayar Piutang Anggota" memicu render ulang cukup sering
 * (pemilihan metode pelunasan, rincian selesai dimuat, indikator
 * loading). Tanpa memo, SETIAP render induk ikut me-render ulang input
 * yang sedang diketik walau tidak ada prop-nya yang berubah.
 *
 * Ini AMAN karena seluruh prop komponen ini primitif atau referensi
 * stabil: `onChangeValue` pada layar tersebut sudah dibungkus
 * useCallback (handlePenaltiChange/handleAdministrasiChange) dan `noop`
 * adalah konstanta level-modul. Perbandingan dangkal bawaan React.memo
 * karena itu memang bekerja — bukan optimasi semu.
 *
 * CATATAN JUJUR: memo mengurangi render ulang, TAPI render ulang bukan
 * remount — memo saja tidak pernah menjadi penyebab maupun obat
 * hilangnya fokus. Penyebab sesungguhnya (input di-unmount oleh
 * conditional loading) sudah diperbaiki secara struktural di
 * BayarAngsuranFormScreen.
 */
const CurrencyInput = React.memo(CurrencyInputBase);
CurrencyInput.displayName = 'CurrencyInput';
export default CurrencyInput;

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    // INPUT STANDARDIZATION — tinggi sama dengan input lain (44 dp).
    minHeight: touchTarget,
  },
  // Satu definisi fokus/error/nonaktif untuk semua input (theme/form.ts).
  // Sebelumnya fokus menebalkan border 1 → 2 dp tanpa kompensasi padding
  // vertikal, sehingga kotak nominal memanjang 2 dp setiap kali disentuh.
  wrapFocus: { ...formUi.inputWrapFocus },
  wrapError: { ...formUi.inputWrapError },
  wrapDisabled: { ...formUi.inputWrapDisabled },
  prefix: { fontSize: 15, color: colors.textMuted, fontWeight: '600', marginRight: 6 },
  input: { flex: 1, paddingVertical: 10, fontSize: 16, color: colors.text, fontWeight: '600' },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  errorText: { flex: 1, color: colors.danger, fontSize: 12 },
});

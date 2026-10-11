import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { getAccountsForPenerimaanPenghasilanLain } from '@/repositories/AccountRepository';
import { AccountItem } from '@/repositories/AccountRepository';
import { colors, radius, spacing, iconSize } from '@/theme/colors';

interface PenerimaanPenghasilanLainAccountPickerProps {
  value: AccountItem | null;
  onChange: (account: AccountItem) => void;
  error?: string;
}

/**
 * Picker akun khusus untuk Transaksi > Penerimaan > Penghasilan Lain
 * (permintaan pengguna, update pasca-Phase 18 §1) — HANYA menampilkan
 * `4-2000 Pendapatan Usaha Lain` dan `4-3000 Pendapatan Lainnya`,
 * TIDAK PERNAH seluruh COA. Sumber datanya
 * `getAccountsForPenerimaanPenghasilanLain()` (AccountRepository.ts)
 * yang MEMFILTER DI QUERY SQL (`WHERE kode IN (...)`) — bukan cuma
 * menyembunyikan opsi lain dari daftar tampilan, jadi akun lain
 * mustahil terpilih walau state komponen ini dimanipulasi (tidak
 * pernah ada di dalam `results` sama sekali).
 *
 * Komponen TERPISAH dari `AccountPicker.tsx` (picker global dipakai
 * Buku Besar/History Transaksi/Penghapusan Piutang/Saldo Awal Akun) —
 * SENGAJA tidak menambah parameter filter ke situ supaya picker global
 * tidak berubah perilakunya sama sekali untuk pemakai lain.
 *
 * Hanya 2 pilihan tetap → chip inline, bukan modal+search penuh
 * seperti AccountPicker (proporsional untuk daftar sependek ini).
 */
export default function PenerimaanPenghasilanLainAccountPicker({
  value,
  onChange,
  error,
}: PenerimaanPenghasilanLainAccountPickerProps) {
  const [options, setOptions] = useState<AccountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setOptions(await getAccountsForPenerimaanPenghasilanLain());
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : 'Gagal memuat daftar akun.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <View style={styles.field}>
      <Text style={styles.label}>Rekening/Akun *</Text>
      {loading && <ActivityIndicator size="small" color={colors.primary} />}
      {!loading && loadError && <Text style={styles.errorText}>{loadError}</Text>}
      {!loading && !loadError && (
        <View style={styles.chipRow}>
          {options.map((opt) => (
            <TouchableOpacity
              key={opt.id}
              accessibilityRole="button"
              accessibilityState={{ selected: value?.id === opt.id }}
              style={[styles.chip, value?.id === opt.id && styles.chipActive]}
              onPress={() => onChange(opt)}
            >
              {value?.id === opt.id ? (
                <Ionicons name="checkmark-circle" size={iconSize.sm} color={colors.primary} style={styles.chipCheck} />
              ) : null}
              <Text style={[styles.chipKode, value?.id === opt.id && styles.chipTextActive]}>{opt.kode}</Text>
              <Text style={[styles.chipNama, value?.id === opt.id && styles.chipTextActive]}>{opt.nama}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      {error && <Text style={styles.errorText}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: spacing.md },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    flexGrow: 1,
    minWidth: '45%',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  chipActive: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
  // UI/UX REDESIGN T2 — penanda terpilih selain warna.
  chipCheck: { position: 'absolute', top: spacing.sm, right: spacing.sm },
  chipKode: { fontSize: 11, color: colors.primary, fontWeight: '700' },
  chipNama: { fontSize: 13, color: colors.text, fontWeight: '600', marginTop: 2, paddingRight: spacing.lg },
  chipTextActive: { color: colors.primaryDark },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
});

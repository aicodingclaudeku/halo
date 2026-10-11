import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, iconSize, radius, spacing, touchTarget } from '@/theme/colors';
import { listAccountingPeriods, AccountingPeriodItem } from '@/repositories/PeriodeRepository';

interface PeriodPickerProps {
  onSelect: (period: AccountingPeriodItem) => void;
  selectedPeriodId?: string;
}

/** Chip pilih periode akuntansi (PRD §20), dipakai semua layar Laporan. */
export default function PeriodPicker({ onSelect, selectedPeriodId }: PeriodPickerProps) {
  const [periods, setPeriods] = useState<AccountingPeriodItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const rows = await listAccountingPeriods();
        setPeriods(rows);
        if (rows.length > 0 && !selectedPeriodId) {
          onSelect(rows[0]);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Gagal memuat periode akuntansi.');
      }
    })();
  }, []);

  if (error) {
    return <Text style={styles.errorText}>{error}</Text>;
  }

  if (periods.length === 0) {
    return <Text style={styles.emptyText}>Belum ada periode akuntansi.</Text>;
  }

  return (
    <View style={styles.row}>
      {periods.map((p) => (
        <TouchableOpacity
          key={p.id}
          accessibilityRole="button"
          accessibilityState={{ selected: selectedPeriodId === p.id }}
          style={[styles.chip, selectedPeriodId === p.id && styles.chipActive]}
          onPress={() => onSelect(p)}
        >
          {selectedPeriodId === p.id ? <Ionicons name="checkmark" size={iconSize.sm} color={colors.white} /> : null}
          <Text style={[styles.chipText, selectedPeriodId === p.id && styles.chipTextActive]}>
            {p.tahunBuku} {p.status === 'CLOSED' ? '(Ditutup)' : ''}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // UI/UX REDESIGN T2 — warna dari token tema (sebelumnya hex lepas), area
  // sentuh ≥ 36 dp, dan chip terpilih diberi ikon centang (bukan warna saja).
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: touchTarget - spacing.sm,
    paddingHorizontal: 14,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white, fontWeight: '600' },
  emptyText: { color: colors.textMuted, fontSize: 12, marginBottom: spacing.sm },
  errorText: { color: colors.danger, fontSize: 12, marginBottom: spacing.sm },
});

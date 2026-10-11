import React, { useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import { catatSaldoAwalKas } from '@/services/KasBankService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * Sub-fitur "Saldo Awal" (hub Input Data) — Kas Umum sebelumnya TIDAK
 * punya jalan resmi diberi saldo awal (beda dari rekening bank yang
 * sudah punya field "Saldo Awal" saat membuat rekening baru, lihat
 * RekeningFormScreen). Lihat KasBankService.catatSaldoAwalKas untuk
 * penjelasan jurnalnya. Rekening BANK tetap diberi saldo awal lewat
 * "Data Bank" (tambah rekening baru), bukan di sini — supaya tidak ada
 * dua jalan berbeda untuk hal yang sama.
 *
 * Phase 18 §4: pilihan "Kas Kecil" DIHAPUS dari form ini — akun Kas
 * Kecil (1-1001) sudah dinonaktifkan, tidak boleh lagi menerima saldo
 * awal baru (lihat migration v18 & SaldoAwalAkunService yang menolak
 * akun nonaktif).
 */
export default function SaldoAwalFormScreen() {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const jenisKas: 'KAS_UMUM' = 'KAS_UMUM';
  const [saldoAwal, setSaldoAwal] = useState<number | ''>('');
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (saldoAwal === '' || saldoAwal <= 0) e.saldoAwal = 'Saldo awal harus lebih dari 0';
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate() || !currentUser || saldoAwal === '') return;
    setSubmitting(true);
    try {
      await catatSaldoAwalKas({ jenisKas, saldoAwal, tanggal, createdBy: currentUser.id });
      notify('Berhasil', 'Saldo awal berhasil dicatat.', [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        <View style={styles.infoBox}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
          <Text style={styles.infoText}>
            Hanya untuk Kas Umum, dan hanya bisa dicatat SATU KALI. Saldo awal rekening bank diisi saat menambah
            rekening baru lewat "Data Bank".
          </Text>
        </View>

        <Text style={styles.sectionLabel}>Akun</Text>
        <View style={styles.chipRow}>
          <Chip label="Kas Umum" active onPress={() => {}} />
        </View>

        <Text style={styles.label}>Saldo Awal (Rp) *</Text>
        <CurrencyInput value={saldoAwal} onChangeValue={setSaldoAwal} error={errors.saldoAwal} />

        <Text style={styles.label}>Tanggal *</Text>
        <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />

        <TouchableOpacity style={[styles.submitButton, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
          {submitting ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Ionicons name="save-outline" size={18} color={colors.white} />
              <Text style={styles.submitText}>Simpan Saldo Awal</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.chip, active && styles.chipActive]} onPress={onPress}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: spacing.sm, marginBottom: spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing.md },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  infoBox: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  infoText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  submitButton: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
    marginBottom: 40,
  },
  disabled: { opacity: 0.6 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
});

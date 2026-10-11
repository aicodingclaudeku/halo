import React, { useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import AnggotaPicker from '@/components/AnggotaPicker';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import FieldError from '@/components/FieldError';
import { Anggota } from '@/repositories/AnggotaRepository';
import { RekeningItem } from '@/services/KasBankService';
import { terimaPendapatanDimuka } from '@/services/PendapatanDimukaService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

/**
 * Sub-fitur "Pendapatan Diterima Dimuka" (Penerimaan) — terhubung ke data anggota.
 *
 * RC-S121 — TIDAK LAGI TERDAFTAR DI NAVIGATOR dan tidak punya entri menu.
 * Pendapatan diterima dimuka dibentuk otomatis oleh sistem, sehingga input
 * manual dari layar ini berisiko mencatat ganda. Berkas dibiarkan (tidak
 * diimpor siapa pun) agar riwayat keputusan tetap terbaca; jangan
 * didaftarkan ulang tanpa keputusan akuntansi baru.
 */
export default function PendapatanDimukaFormScreen() {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [anggota, setAnggota] = useState<Anggota | null>(null);
  const [jumlah, setJumlah] = useState<number | ''>('');
  const [jangkaWaktu, setJangkaWaktu] = useState('');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!anggota) e.anggota = 'Anggota wajib dipilih';
    if (jumlah === '' || jumlah <= 0) e.jumlah = 'Jumlah harus lebih dari 0';
    const bulanNum = parseInt(jangkaWaktu, 10);
    if (!jangkaWaktu || isNaN(bulanNum) || bulanNum <= 0) e.jangkaWaktu = 'Jangka waktu (bulan) harus lebih dari 0';
    if (!rekening) e.rekening = 'Rekening penerima dana wajib dipilih';
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate() || !anggota || !rekening || !currentUser || jumlah === '') return;
    setSubmitting(true);
    try {
      await terimaPendapatanDimuka({
        anggotaId: anggota.id,
        jumlah,
        jangkaWaktuBulan: parseInt(jangkaWaktu, 10),
        tanggal,
        sumberDana: rekening.jenis === 'BANK' ? 'BANK' : 'KAS',
        bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
        createdBy: currentUser.id,
      });
      notify('Berhasil', 'Pendapatan diterima dimuka berhasil dicatat.', [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
            lewat Detail History Transaksi (satu pintu). */}
        <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="PENDAPATAN_DIMUKA" />
        {tabMenu === 'RIWAYAT' ? (
          <RiwayatTransaksiMenu menu="PENDAPATAN_DIMUKA" />
        ) : (
        <>
        <AnggotaPicker value={anggota} onChange={setAnggota} error={errors.anggota} />

        <Text style={styles.label}>Jumlah Uang *</Text>
        <CurrencyInput value={jumlah} onChangeValue={setJumlah} error={errors.jumlah} />

        <Text style={[styles.label, { marginTop: spacing.md }]}>Jangka Waktu (bulan) *</Text>
        <FocusTextInput
          style={styles.input}
          value={jangkaWaktu}
          onChangeText={setJangkaWaktu}
          keyboardType="number-pad"
          placeholder="Mis. 12"
          placeholderTextColor={colors.placeholder}
          invalid={!!errors.jangkaWaktu}
        />
        {errors.jangkaWaktu && <FieldError message={errors.jangkaWaktu} />}

        <View style={{ marginTop: spacing.md }}>
          <RekeningPicker label="Diterima di Rekening" value={rekening} onChange={setRekening} />
          {errors.rekening && <Text style={styles.errorText}>{errors.rekening}</Text>}
        </View>

        <Text style={styles.label}>Tanggal Transaksi *</Text>
        <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />

        <TouchableOpacity style={[styles.submitButton, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
          {submitting ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Ionicons name="save-outline" size={18} color={colors.white} />
              <Text style={styles.submitText}>Simpan</Text>
            </>
          )}
        </TouchableOpacity>
        </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  input: { ...formUi.inputStandalone },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
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

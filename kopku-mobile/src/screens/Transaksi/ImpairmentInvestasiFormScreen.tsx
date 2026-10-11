import React, { useEffect, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import InvestasiPicker from '@/components/InvestasiPicker';
import DatePicker from '@/components/DatePicker';
import CurrencyInput from '@/components/CurrencyInput';
import FocusTextInput from '@/components/FocusTextInput';
import FieldError from '@/components/FieldError';
import { InvestasiListItem } from '@/services/InvestasiService';
import {
  catatImpairmentInvestasi,
  getNilaiTercatatInvestasi,
  getIndikatorImpairmentUntukJenis,
} from '@/services/InvestasiImpairmentService';
import { getDb } from '@/database/db';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { formatRupiah } from '@/utils/money';
import { colors, iconSize, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * Sub-fitur "Impairment Investasi" (Phase 17 §8.2/§8.3). Nilai
 * impairment TIDAK dihitung otomatis oleh sistem (lihat komentar
 * panjang di InvestasiImpairmentService.ts — investasi di aplikasi
 * ini semuanya penyertaan tanpa harga pasar) — pengurus mengisi
 * berdasarkan penilaian sendiri, sistem hanya mencatat & memposting
 * jurnalnya secara terstruktur & auditable. Preview jurnal wajib
 * ditampilkan sebelum posting (§8.3).
 *
 * Audit ulang (permintaan pengguna, request baru §8 — "PALING
 * PENTING"): daftar "Indikasi Penurunan Nilai" SEKARANG DINAMIS
 * mengikuti Tujuan Investasi (`investasi.jenisInvestasi`) yang
 * dipilih di `InvestasiPicker` — lihat
 * `getIndikatorImpairmentUntukJenis()`. Saat investasi yang dipilih
 * berubah, indikator yang SUDAH DICENTANG direset (karena daftar
 * pilihannya berubah total) — ini hanya memengaruhi state form yang
 * BELUM disimpan, bukan data historis (indikator tersimpan sebagai
 * teks bebas, bukan referensi enum, jadi evaluasi lama yang sudah
 * diposting tetap terbaca apa adanya berapa pun perubahan daftar ini
 * di masa depan).
 */
export default function ImpairmentInvestasiFormScreen() {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [investasi, setInvestasi] = useState<InvestasiListItem | null>(null);
  const [nilaiTercatat, setNilaiTercatat] = useState<number | null>(null);
  const [loadingNilai, setLoadingNilai] = useState(false);

  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [indikasiTerpilih, setIndikasiTerpilih] = useState<string[]>([]);
  const [dasarPenilaian, setDasarPenilaian] = useState('');
  const [nilaiImpairment, setNilaiImpairment] = useState<number | ''>('');
  const [alasan, setAlasan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showPreview, setShowPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!investasi) {
      setNilaiTercatat(null);
      return;
    }
    setLoadingNilai(true);
    (async () => {
      const db = await getDb();
      const hasil = await getNilaiTercatatInvestasi(db, investasi.id);
      setNilaiTercatat(hasil.nilaiTercatat);
    })().finally(() => setLoadingNilai(false));
  }, [investasi]);

  // Audit ulang (permintaan pengguna §8): daftar indikator berubah
  // mengikuti jenis investasi yang dipilih — kalau investasi (atau
  // jenisnya) berganti, indikator yang SUDAH DICENTANG di form ini
  // (belum disimpan) direset supaya tidak ada centang "nyangkut" dari
  // daftar jenis sebelumnya yang sudah tidak relevan/tidak ditampilkan
  // lagi.
  const daftarIndikator = investasi ? getIndikatorImpairmentUntukJenis(investasi.jenisInvestasi) : [];
  useEffect(() => {
    setIndikasiTerpilih([]);
  }, [investasi?.jenisInvestasi]);

  const toggleIndikasi = (indikasi: string) => {
    setIndikasiTerpilih((prev) => (prev.includes(indikasi) ? prev.filter((i) => i !== indikasi) : [...prev, indikasi]));
  };

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!investasi) e.investasi = 'Pilih investasi yang akan dievaluasi';
    if (!indikasiTerpilih.length) e.indikasi = 'Pilih minimal satu indikasi penurunan nilai';
    if (!dasarPenilaian.trim()) e.dasarPenilaian = 'Dasar penilaian wajib diisi';
    if (nilaiImpairment === '' || nilaiImpairment <= 0) e.nilaiImpairment = 'Nilai impairment wajib diisi, lebih dari 0';
    if (nilaiTercatat !== null && nilaiImpairment !== '' && nilaiImpairment > nilaiTercatat) {
      e.nilaiImpairment = `Tidak boleh melebihi nilai tercatat saat ini (${formatRupiah(nilaiTercatat)})`;
    }
    if (!alasan.trim()) e.alasan = 'Alasan/catatan wajib diisi';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const lanjutKePreview = () => {
    if (!validate()) return;
    setShowPreview(true);
  };

  const submit = async () => {
    if (!investasi || !currentUser || nilaiImpairment === '') return;
    setSubmitting(true);
    try {
      await catatImpairmentInvestasi({
        investasiId: investasi.id,
        tanggal,
        indikasiTerpilih,
        dasarPenilaian: dasarPenilaian.trim(),
        nilaiImpairment,
        alasan: alasan.trim(),
        createdBy: currentUser.id,
      });
      notify('Berhasil', 'Penurunan nilai investasi berhasil dicatat dan diposting ke jurnal.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
      setShowPreview(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (showPreview && investasi && nilaiImpairment !== '') {
    const sisaSetelah = (nilaiTercatat ?? 0) - nilaiImpairment;
    return (
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        <Text style={styles.previewTitle}>Preview Jurnal</Text>
        <View style={styles.previewCard}>
          <Text style={styles.previewLabel}>Investasi</Text>
          <Text style={styles.previewValue}>{investasi.namaTujuan}</Text>

          <View style={styles.journalRow}>
            <Text style={styles.journalDebit}>DEBIT</Text>
            <Text style={styles.journalAkun}>Beban Penurunan Nilai Investasi</Text>
            <Text style={styles.journalNominal}>{formatRupiah(nilaiImpairment)}</Text>
          </View>
          <View style={styles.journalRow}>
            <Text style={styles.journalKredit}>KREDIT</Text>
            <Text style={styles.journalAkun}>Penyisihan Penurunan Nilai Investasi</Text>
            <Text style={styles.journalNominal}>{formatRupiah(nilaiImpairment)}</Text>
          </View>

          <View style={styles.divider} />
          <Text style={styles.previewLabel}>Nilai Tercatat Sebelum</Text>
          <Text style={styles.previewValue}>{formatRupiah(nilaiTercatat ?? 0)}</Text>
          <Text style={[styles.previewLabel, { marginTop: spacing.sm }]}>Nilai Tercatat Setelah</Text>
          <Text style={styles.previewValue}>{formatRupiah(sisaSetelah)}</Text>
        </View>

        <Text style={styles.previewNote}>
          Impairment investasi bersifat PERMANEN (tidak dapat di-reversal) — pastikan penilaian sudah benar sebelum
          diposting.
        </Text>

        <View style={styles.previewActions}>
          <TouchableOpacity style={styles.cancelButton} onPress={() => setShowPreview(false)} disabled={submitting}>
            <Text style={styles.cancelButtonText}>Kembali</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.submitButton, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
            {submitting ? <ActivityIndicator color={colors.white} /> : <Text style={styles.submitButtonText}>Posting Jurnal</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        <InvestasiPicker value={investasi} onChange={setInvestasi} error={errors.investasi} />

        {investasi && (
          <View style={styles.infoBox}>
            <Text style={styles.infoLabel}>Nilai Tercatat Saat Ini</Text>
            {loadingNilai ? (
              <ActivityIndicator style={{ marginTop: 4 }} />
            ) : (
              <Text style={styles.infoValue}>{formatRupiah(nilaiTercatat ?? 0)}</Text>
            )}
          </View>
        )}

        <Text style={styles.label}>Tanggal Evaluasi *</Text>
        <DatePicker value={tanggal} onChange={setTanggal} maximumDate={getWaktuSekarang()} />

        <Text style={[styles.label, { marginTop: spacing.md }]}>Indikasi Penurunan Nilai *</Text>
        {!investasi && <Text style={styles.hintText}>Pilih investasi terlebih dahulu untuk melihat indikator yang relevan.</Text>}
        {daftarIndikator.map((indikasi) => (
          <TouchableOpacity
            key={indikasi}
            style={styles.checkboxRow}
            onPress={() => toggleIndikasi(indikasi)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: indikasiTerpilih.includes(indikasi) }}
          >
            <View style={[styles.checkbox, indikasiTerpilih.includes(indikasi) && styles.checkboxChecked]}>
              {/* UI/UX FINAL POLISH (§18) — glyph '\u2713' diganti Ionicons. */}
              {indikasiTerpilih.includes(indikasi) && (
                <Ionicons name="checkmark" size={iconSize.sm - 2} color={colors.white} />
              )}
            </View>
            <Text style={styles.checkboxLabel}>{indikasi}</Text>
          </TouchableOpacity>
        ))}
        {errors.indikasi && <Text style={styles.errorText}>{errors.indikasi}</Text>}

        <Text style={[styles.label, { marginTop: spacing.md }]}>Dasar Penilaian *</Text>
        <FocusTextInput
          style={[styles.input, styles.textArea]}
          value={dasarPenilaian}
          onChangeText={setDasarPenilaian}
          placeholder="Jelaskan bagaimana nilai yang dapat dipulihkan ditentukan (mis. laporan keuangan unit usaha, estimasi pengurus)"
          placeholderTextColor={colors.placeholder}
          multiline
          invalid={!!errors.dasarPenilaian}
        />
        {errors.dasarPenilaian && <FieldError message={errors.dasarPenilaian} />}

        <Text style={[styles.label, { marginTop: spacing.md }]}>Nilai Impairment *</Text>
        <CurrencyInput value={nilaiImpairment} onChangeValue={setNilaiImpairment} error={errors.nilaiImpairment} />

        <Text style={[styles.label, { marginTop: spacing.md }]}>Alasan/Catatan *</Text>
        <FocusTextInput
          style={[styles.input, styles.textArea]}
          value={alasan}
          onChangeText={setAlasan}
          placeholder="Ringkasan alasan pencatatan impairment ini"
          placeholderTextColor={colors.placeholder}
          multiline
          invalid={!!errors.alasan}
        />
        {errors.alasan && <FieldError message={errors.alasan} />}

        <TouchableOpacity style={styles.submitButton} onPress={lanjutKePreview}>
          <Text style={styles.submitButtonText}>Lihat Preview Jurnal</Text>
        </TouchableOpacity>
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  infoBox: { backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  infoLabel: { fontSize: 11, color: colors.textMuted },
  infoValue: { fontSize: 18, fontWeight: '700', color: colors.primary, marginTop: 2 },
  label: { fontSize: 13, color: colors.text, marginBottom: 4, fontWeight: '600' },
  input: { ...formUi.inputStandalone },
  textArea: { ...formUi.inputStandaloneMultiline },
  errorText: { color: colors.danger, fontSize: 12, marginTop: 4 },
  hintText: { color: colors.textMuted, fontSize: 12, marginBottom: spacing.sm },
  checkboxRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkmark: { color: colors.white, fontSize: 13, fontWeight: '700' },
  checkboxLabel: { flex: 1, fontSize: 13, color: colors.text, lineHeight: 18 },
  submitButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  submitButtonText: { color: colors.white, fontWeight: '700', fontSize: 14 },
  disabled: { opacity: 0.6 },
  previewTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: spacing.md },
  previewCard: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border },
  previewLabel: { fontSize: 11, color: colors.textMuted, marginTop: spacing.sm },
  previewValue: { fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 2 },
  journalRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 8 },
  journalDebit: { width: 56, fontSize: 11, fontWeight: '700', color: colors.primary },
  journalKredit: { width: 56, fontSize: 11, fontWeight: '700', color: colors.danger },
  journalAkun: { flex: 1, fontSize: 13, color: colors.text },
  journalNominal: { fontSize: 13, fontWeight: '700', color: colors.text },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  previewNote: { fontSize: 11, color: colors.danger, marginTop: spacing.md, lineHeight: 16 },
  previewActions: { flexDirection: 'row', gap: 8, marginTop: spacing.lg },
  cancelButton: {
    flex: 1,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelButtonText: { color: colors.text, fontWeight: '700' },
});

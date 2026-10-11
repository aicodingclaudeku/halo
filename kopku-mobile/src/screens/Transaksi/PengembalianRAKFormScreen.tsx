import React, { useCallback, useEffect, useRef, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, FlatList, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import UnitUsahaPicker from '@/components/UnitUsahaPicker';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import EmptyState from '@/components/report/EmptyState';
import type { UnitUsahaRow } from '@/services/KoperasiMasterService';
import { RekeningItem } from '@/services/KasBankService';
import {
  catatPengembalianRAK,
  listRAKUntukPengembalian,
  listPengembalianRAK,
  RAKEligibleItem,
  PengembalianRAKRow,
  RAKUError,
} from '@/services/RAKUService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { modalUi } from '@/theme/modal';
import { formatRupiah } from '@/utils/money';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

/**
 * Pengembalian RAKU (PENGEMBALIAN_RAK) — dibuka dari Penerimaan > RAKU.
 * Dr Kas/Bank, Cr 1-1800; bukan pendapatan.
 *
 * Dicatat Dr Kas/Bank / Cr 1-1800 RAK — MENGURANGI RAK, BUKAN pendapatan.
 * Akun ditentukan aturan akuntansi di `RAKUService`, tidak dipilih operator.
 * Layar ini tidak menulis database; semua validasi otoritatif ada di service.
 */

const LABEL_ALOKASI: Record<string, string> = {
  MODAL_TETAP: 'Modal Tetap',
  MODAL_TAMBAHAN: 'Modal Tambahan',
  OPERASIONAL: 'Operasional',
};

function pesanOperator(e: unknown): string {
  if (e instanceof RAKUError) return e.message;
  const m = e instanceof Error ? e.message : '';
  if (!m || /sqlite|constraint|typeerror|undefined|\bnull\b|stack/i.test(m)) {
    return 'Transaksi belum dapat disimpan. Silakan coba lagi.';
  }
  return m;
}

export default function PengembalianRAKFormScreen() {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [unit, setUnit] = useState<UnitUsahaRow | null>(null);
  const [rakList, setRakList] = useState<RAKEligibleItem[]>([]);
  const [rak, setRak] = useState<RAKEligibleItem | null>(null);
  const [riwayat, setRiwayat] = useState<PengembalianRAKRow[]>([]);
  const [memuat, setMemuat] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rakPickerOpen, setRakPickerOpen] = useState(false);

  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [nominal, setNominal] = useState<number | ''>('');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [nomorDokumen, setNomorDokumen] = useState('');
  const [keterangan, setKeterangan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const sedangMengirim = useRef(false);

  const muatUnit = useCallback(async (u: UnitUsahaRow | null) => {
    if (!u) return;
    setMemuat(true);
    setLoadError(null);
    try {
      const [daftar, hist] = await Promise.all([listRAKUntukPengembalian(u.id), listPengembalianRAK({ unitUsahaId: u.id })]);
      setRakList(daftar);
      setRiwayat(hist);
      setRak((lama) => (lama ? daftar.find((d) => d.rakTransaksiId === lama.rakTransaksiId) ?? null : null));
    } catch {
      setLoadError('Data belum dapat dimuat. Silakan coba lagi.');
    } finally {
      setMemuat(false);
    }
  }, []);

  useEffect(() => {
    const unsub = navigation.addListener?.('focus', () => muatUnit(unit));
    return unsub;
  }, [navigation, unit, muatUnit]);

  const pilihUnit = (u: UnitUsahaRow) => {
    setUnit(u);
    setRak(null);
    setRakList([]);
    setRiwayat([]);
    muatUnit(u);
  };

  const outstandingUnit = rakList.reduce((s, r) => s + r.outstanding, 0);
  const totalRakUnit = rakList.reduce((s, r) => s + r.jumlah, 0);
  const totalKembaliUnit = rakList.reduce((s, r) => s + r.totalPengembalian, 0);
  const melebihi = rak !== null && nominal !== '' && nominal > rak.outstanding;

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!unit) e.unit = 'Unit usaha wajib dipilih.';
    if (!rak) e.rak = 'RAKU terkait wajib dipilih.';
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi.';
    if (nominal === '' || nominal <= 0) e.nominal = 'Nominal harus lebih besar dari 0.';
    else if (rak && nominal > rak.outstanding) e.nominal = 'Jumlah penerimaan melebihi saldo RAKU yang masih outstanding.';
    if (!rekening) e.rekening = 'Kas/Bank wajib dipilih.';
    if (!nomorDokumen.trim()) e.nomorDokumen = 'Nomor dokumen wajib diisi.';
    else if (nomorDokumen.includes('|')) e.nomorDokumen = 'Nomor dokumen tidak boleh memuat karakter "|".';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const kirim = async () => {
    if (sedangMengirim.current) return;
    if (!unit || !rak || !rekening || !currentUser || nominal === '') return;
    sedangMengirim.current = true;
    setSubmitting(true);
    try {
      const hasil = await catatPengembalianRAK({
        unitUsahaId: unit.id,
        rakTransaksiId: rak.rakTransaksiId,
        tanggal,
        jumlah: nominal,
        jenis: rekening.jenis,
        bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
        nomorDokumen,
        keterangan: keterangan || undefined,
        createdBy: currentUser.id,
      });
      notify('Berhasil', `Pengembalian RAKU dicatat. Sisa outstanding ${rak.nomorRak}: ${formatRupiah(hasil.outstandingSesudah)}.`, [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      notify('Gagal', pesanOperator(e));
      await muatUnit(unit);
    } finally {
      sedangMengirim.current = false;
      setSubmitting(false);
    }
  };

  const konfirmasi = () => {
    if (sedangMengirim.current) return;
    if (!validate() || !unit || !rak || nominal === '') return;
    notify(
      'Konfirmasi Pengembalian RAKU',
      `${unit.namaUsaha} · ${rak.nomorRak}\nNominal ${formatRupiah(nominal)} — mengurangi RAK (Dr Kas/Bank, Kr 1-1800), bukan pendapatan.\nDok ${nomorDokumen.trim()} · ${tanggal}`,
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Simpan', onPress: kirim },
      ]
    );
  };

  const bisaSimpan = !submitting && !!unit && !!rak && rak.outstanding > 0 && !melebihi;

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
            lewat Detail History Transaksi (satu pintu). */}
        <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="PENGEMBALIAN_RAKU" />
        {tabMenu === 'RIWAYAT' ? (
          <RiwayatTransaksiMenu menu="PENGEMBALIAN_RAKU" />
        ) : (
        <>
        <View style={styles.infoBox}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
          <Text style={styles.infoText}>
            Pengembalian dana RAK dari unit usaha dicatat Dr Kas/Bank, Kr 1-1800 RAK. Transaksi ini mengurangi saldo RAK
            unit dan tidak diakui sebagai pendapatan.
          </Text>
        </View>

        <UnitUsahaPicker value={unit} onChange={pilihUnit} error={errors.unit} />

        {unit ? (
          memuat ? (
            <View style={styles.centerRow}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : loadError ? (
            <View style={styles.warnBox} accessibilityRole="alert">
              <Ionicons name="warning-outline" size={16} color={colors.warning} />
              <Text style={styles.warnText}>{loadError}</Text>
              <TouchableOpacity accessibilityRole="button" onPress={() => muatUnit(unit)}>
                <Text style={styles.link}>Coba lagi</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={styles.summary}>
                <Text style={styles.summaryTitle}>Outstanding RAKU — {unit.namaUsaha}</Text>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Total RAKU aktif</Text>
                  <Text style={styles.summaryValue}>{formatRupiah(totalRakUnit)}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Pengembalian sebelumnya</Text>
                  <Text style={styles.summaryValue}>{formatRupiah(totalKembaliUnit)}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={[styles.summaryLabel, styles.bold]}>Outstanding</Text>
                  <Text style={[styles.summaryValue, styles.bold]}>{formatRupiah(outstandingUnit)}</Text>
                </View>
              </View>

              <Text style={[styles.label, { marginTop: spacing.md }]}>RAKU Terkait *</Text>
              {rakList.length === 0 ? (
                <Text style={styles.muted}>Unit ini belum memiliki transaksi RAKU aktif yang dapat dikembalikan.</Text>
              ) : (
                <TouchableOpacity
                  accessibilityRole="button"
                  style={[styles.selector, errors.rak && styles.selectorError]}
                  onPress={() => setRakPickerOpen(true)}
                >
                  <Ionicons name="git-branch-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
                  <Text style={rak ? styles.selectorText : styles.selectorPlaceholder} numberOfLines={2}>
                    {rak
                      ? `${rak.nomorRak} · ${LABEL_ALOKASI[rak.jenisAlokasi ?? ''] ?? 'Tanpa alokasi'} · sisa ${formatRupiah(rak.outstanding)}`
                      : 'Pilih transaksi RAKU...'}
                  </Text>
                  <Ionicons name="chevron-down" size={iconSize.md} color={colors.textMuted} style={{ flexShrink: 0 }} />
                </TouchableOpacity>
              )}
              {errors.rak ? <Text style={styles.errorText}>{errors.rak}</Text> : null}
            </>
          )
        ) : null}

        <Text style={[styles.label, { marginTop: spacing.md }]}>Tanggal *</Text>
        <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />

        <Text style={[styles.label, { marginTop: spacing.md }]}>Nominal (Rp) *</Text>
        <CurrencyInput value={nominal} onChangeValue={setNominal} error={errors.nominal} />
        {melebihi && !errors.nominal ? (
          <Text style={styles.errorText}>Jumlah penerimaan melebihi saldo RAKU yang masih outstanding.</Text>
        ) : null}

        <View style={{ marginTop: spacing.md }}>
          <RekeningPicker label="Diterima di Kas/Bank" value={rekening} onChange={setRekening} />
          {errors.rekening ? <Text style={styles.errorText}>{errors.rekening}</Text> : null}
        </View>

        <Text style={[styles.label, { marginTop: spacing.md }]}>Nomor Dokumen *</Text>
        <FocusTextInput
          style={styles.input}
          value={nomorDokumen}
          onChangeText={setNomorDokumen}
          placeholder="Mis. bukti setor / berita acara"
          placeholderTextColor={colors.placeholder}
          autoCapitalize="characters"
        />
        {errors.nomorDokumen ? <Text style={styles.errorText}>{errors.nomorDokumen}</Text> : null}

        <Text style={[styles.label, { marginTop: spacing.md }]}>Keterangan</Text>
        <FocusTextInput
          style={styles.inputMultiline}
          value={keterangan}
          onChangeText={setKeterangan}
          multiline
          placeholderTextColor={colors.placeholder}
        />

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ disabled: !bisaSimpan }}
          style={[styles.submitButton, !bisaSimpan && styles.disabled]}
          onPress={konfirmasi}
          disabled={!bisaSimpan}
        >
          {submitting ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Ionicons name="save-outline" size={18} color={colors.white} />
              <Text style={styles.submitText}>Simpan Pengembalian</Text>
            </>
          )}
        </TouchableOpacity>

        {unit && !memuat && !loadError ? (
          <>
            <Text style={styles.sectionLabel}>Riwayat Pengembalian — {unit.namaUsaha}</Text>
            {riwayat.length === 0 ? (
              <EmptyState message="Belum ada pengembalian RAK untuk unit ini." />
            ) : (
              riwayat.map((r) => (
                <TouchableOpacity
                  key={r.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Detail ${r.nomorTransaksi}`}
                  style={styles.histRow}
                  onPress={() => navigation.navigate('KasBankDetail', { jenis: r.jenis, id: r.id })}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.histTitle} numberOfLines={1}>
                      {r.nomorRak ?? '-'} · Dok {r.nomorDokumen}
                    </Text>
                    <Text style={styles.histSub}>
                      {r.tanggal} · {r.nomorTransaksi}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', flexShrink: 0 }}>
                    <Text style={[styles.histNominal, r.status === 'DIBATALKAN' && styles.coret]}>{formatRupiah(r.jumlah)}</Text>
                    <Text style={r.status === 'DIBATALKAN' ? styles.badgeWarn : styles.badge}>
                      {r.status === 'DIBATALKAN' ? 'Dibatalkan' : 'Aktif'}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
                </TouchableOpacity>
              ))
            )}
            <Text style={styles.footNote}>
              Ketuk transaksi untuk detail. Pembatalan memakai reversal existing (jurnal dibalik, tidak dihapus).
            </Text>
          </>
        ) : null}

        <Modal visible={rakPickerOpen} animationType="slide" onRequestClose={() => setRakPickerOpen(false)}>
          <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Pilih RAKU Terkait</Text>
              <TouchableOpacity accessibilityRole="button" style={styles.closeIcon} onPress={() => setRakPickerOpen(false)}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <FlatList
              keyboardShouldPersistTaps="handled"
              data={rakList}
              keyExtractor={(i) => i.rakTransaksiId}
              contentContainerStyle={{ padding: spacing.lg }}
              ListEmptyComponent={<Text style={styles.muted}>Tidak ada RAKU aktif.</Text>}
              renderItem={({ item }) => {
                const habis = item.outstanding <= 0;
                return (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityState={{ disabled: habis }}
                    disabled={habis}
                    style={[styles.pickRow, habis && styles.disabled, rak?.rakTransaksiId === item.rakTransaksiId && styles.pickRowActive]}
                    onPress={() => {
                      setRak(item);
                      setRakPickerOpen(false);
                    }}
                  >
                    <Text style={styles.histTitle}>
                      {item.nomorRak} · {LABEL_ALOKASI[item.jenisAlokasi ?? ''] ?? 'Tanpa alokasi'}
                    </Text>
                    <Text style={styles.histSub}>
                      {item.tanggal} · RAK {formatRupiah(item.jumlah)} · kembali {formatRupiah(item.totalPengembalian)}
                    </Text>
                    <Text style={[styles.histSub, styles.bold]}>
                      {habis ? 'Sudah kembali penuh' : `Outstanding ${formatRupiah(item.outstanding)}`}
                    </Text>
                  </TouchableOpacity>
                );
              }}
            />
          </SafeAreaView>
        </Modal>
        </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  centerRow: { paddingVertical: spacing.lg, alignItems: 'center' },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: spacing.xl, marginBottom: spacing.sm },
  muted: { fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  bold: { fontWeight: '700' },
  link: { color: colors.primary, fontWeight: '700', fontSize: 12 },
  input: { ...formUi.inputStandalone },
  inputMultiline: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
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
  warnBox: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  warnText: { flex: 1, fontSize: 12, color: colors.text },
  summary: {
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    gap: 4,
  },
  summaryTitle: { fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: 4 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  summaryLabel: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  summaryValue: { fontSize: 13, color: colors.text, flexShrink: 0 },
  selector: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  selectorError: { borderColor: colors.danger },
  selectorText: { flex: 1, fontSize: 14, color: colors.text, fontWeight: '600' },
  selectorPlaceholder: { flex: 1, fontSize: 14, color: colors.placeholder },
  submitButton: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
  },
  disabled: { opacity: 0.5 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  histRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  histTitle: { fontSize: 13, fontWeight: '600', color: colors.text },
  histSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  histNominal: { fontSize: 14, fontWeight: '700', color: colors.text },
  coret: { textDecorationLine: 'line-through', color: colors.textMuted },
  badge: { fontSize: 10, color: colors.success, fontWeight: '700', marginTop: 2 },
  badgeWarn: { fontSize: 10, color: colors.warning, fontWeight: '700', marginTop: 2 },
  footNote: { fontSize: 11, color: colors.textMuted, marginTop: spacing.md, marginBottom: 40, lineHeight: 16 },
  modalContainer: { flex: 1, backgroundColor: colors.background },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  modalTitle: { ...modalUi.title },
  closeIcon: { ...modalUi.closeIcon },
  pickRow: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  pickRowActive: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
});

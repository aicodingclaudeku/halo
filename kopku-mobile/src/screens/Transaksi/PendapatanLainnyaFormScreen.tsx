import React, { useEffect, useMemo, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, FlatList, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import SearchField from '@/components/SearchField';
import { RekeningItem } from '@/services/KasBankService';
import {
  tambahTransaksiPendapatan,
  listAkunPendapatanLainnya,
  AkunPendapatanLainnyaOption,
} from '@/services/PendapatanLainnyaService';
import { LHU_KLASIFIKASI_LABEL } from '@/repositories/AccountRepository';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

/**
 * Tambah Transaksi Pendapatan (Revisi LHU KOPKU, Bagian D). Akun
 * Pendapatan WAJIB dipilih dari COA existing (Bagian E) — dropdown
 * dari `listAkunPendapatanLainnya()`, bukan hard-code. Klasifikasi LHU
 * otomatis muncul read-only begitu akun dipilih (Bagian G) — user
 * TIDAK memilih ulang klasifikasi setiap transaksi.
 */
export default function PendapatanLainnyaFormScreen() {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [akunOptions, setAkunOptions] = useState<AkunPendapatanLainnyaOption[]>([]);
  const [accountId, setAccountId] = useState<string | undefined>(undefined);
  const [nominal, setNominal] = useState<number | ''>('');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [keterangan, setKeterangan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      setAkunOptions(await listAkunPendapatanLainnya());
      setLoading(false);
    })();
  }, []);

  const akunTerpilih = akunOptions.find((a) => a.accountId === accountId) ?? null;

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!accountId) e.accountId = 'Akun pendapatan wajib dipilih.';
    else if (!akunTerpilih?.klasifikasiLhu) e.accountId = 'Akun ini belum diklasifikasikan untuk LHU.';
    if (nominal === '' || nominal <= 0) e.nominal = 'Nominal harus lebih besar dari 0.';
    if (!rekening) e.rekening = 'Kas/Bank wajib dipilih.';
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate() || !rekening || !currentUser || nominal === '' || !accountId) return;
    setSubmitting(true);
    try {
      await tambahTransaksiPendapatan({
        tanggal,
        accountId,
        nominal,
        jenis: rekening.jenis,
        bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
        keterangan: keterangan || undefined,
        createdBy: currentUser.id,
      });
      notify('Berhasil', 'Transaksi pendapatan berhasil dicatat.', [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
            lewat Detail History Transaksi (satu pintu). */}
        <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="PENERIMAAN_LAIN" />
        {tabMenu === 'RIWAYAT' ? (
          <RiwayatTransaksiMenu menu="PENERIMAAN_LAIN" />
        ) : (
        <>
        <View style={styles.infoBox}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
          <Text style={styles.infoText}>Dijurnal Dr Kas/Bank, Kr akun Pendapatan yang dipilih (COA existing).</Text>
        </View>

        <Text style={styles.label}>Tanggal *</Text>
        <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />

        <Text style={[styles.sectionLabel, { marginTop: spacing.md }]}>Akun Pendapatan (COA) *</Text>
        {akunOptions.length === 0 ? (
          <Text style={styles.infoText}>
            Belum ada akun Pendapatan yang tersedia untuk menu ini. Tambahkan akun lewat Input Data &gt; Akun (kategori
            Pendapatan), lalu atur klasifikasi LHU-nya.
          </Text>
        ) : (
          <AkunPendapatanSelect
            options={akunOptions}
            value={akunTerpilih}
            onChange={(a) => setAccountId(a.accountId)}
            error={errors.accountId}
          />
        )}

        {akunTerpilih && (
          <>
            <Text style={[styles.label, { marginTop: spacing.md }]}>Klasifikasi LHU (otomatis)</Text>
            <View style={styles.readonlyBox}>
              <Text style={styles.readonlyText}>
                {akunTerpilih.klasifikasiLhu ? LHU_KLASIFIKASI_LABEL[akunTerpilih.klasifikasiLhu] : 'Belum diklasifikasikan'}
              </Text>
            </View>
          </>
        )}

        <Text style={[styles.label, { marginTop: spacing.md }]}>Nominal (Rp) *</Text>
        <CurrencyInput value={nominal} onChangeValue={setNominal} error={errors.nominal} />

        <View style={{ marginTop: spacing.md }}>
          <RekeningPicker label="Kas/Bank" value={rekening} onChange={setRekening} />
          {errors.rekening && <Text style={styles.errorText}>{errors.rekening}</Text>}
        </View>

        <Text style={[styles.label, { marginTop: spacing.md }]}>Keterangan</Text>
        <FocusTextInput
          style={styles.inputMultiline}
          value={keterangan}
          onChangeText={setKeterangan}
          multiline
          placeholderTextColor={colors.placeholder}
        />

        <TouchableOpacity style={[styles.submitButton, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
          {submitting ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Ionicons name="save-outline" size={18} color={colors.white} />
              <Text style={styles.submitText}>Simpan Transaksi</Text>
            </>
          )}
        </TouchableOpacity>
        </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

interface AkunPendapatanSelectProps {
  options: AkunPendapatanLainnyaOption[];
  value: AkunPendapatanLainnyaOption | null;
  onChange: (akun: AkunPendapatanLainnyaOption) => void;
  error?: string;
}

/**
 * Selector akun Pendapatan (COA) bergaya "select" dengan modal + pencarian,
 * menggantikan chip-row lama agar tetap rapi walau daftar akun panjang.
 * Pola visual mengikuti `AccountPicker.tsx` (picker akun global) supaya
 * konsisten dengan bagian lain aplikasi.
 */
function AkunPendapatanSelect({ options, value, onChange, error }: AkunPendapatanSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((a) => a.kode.toLowerCase().includes(q) || a.nama.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <View>
      <TouchableOpacity
        style={[styles.selector, error && styles.selectorError]}
        onPress={() => {
          setQuery('');
          setOpen(true);
        }}
      >
        <Ionicons name="pricetag-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
        <View style={{ flex: 1 }}>
          <Text style={value ? styles.selectorText : styles.selectorPlaceholder} numberOfLines={1}>
            {value ? `${value.kode} — ${value.nama}` : 'Pilih akun pendapatan...'}
          </Text>
        </View>
        <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
      </TouchableOpacity>
      {error && <Text style={styles.errorText}>{error}</Text>}

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          {/* RC-S120 — tanpa ini, saat mencari, butir terakhir daftar dan
              tombol di bawahnya berada di belakang papan ketik. */}
          <AreaAmanKeyboard varian="dialog" style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Pilih Akun Pendapatan</Text>
            <TouchableOpacity style={styles.closeIcon} onPress={() => setOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={{ paddingHorizontal: spacing.lg }}>
            <SearchField
              placeholder="Cari kode atau nama akun..."
              placeholderTextColor={colors.placeholder}
              value={query}
              onChangeText={setQuery}
              autoFocus
            />
          </View>

          <FlatList keyboardShouldPersistTaps="handled"
            data={results}
            keyExtractor={(item) => item.accountId}
            contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }}
            renderItem={({ item }) => {
              const active = value?.accountId === item.accountId;
              return (
                <TouchableOpacity
                  style={[styles.row, active && styles.rowActive]}
                  onPress={() => {
                    onChange(item);
                    setOpen(false);
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <View style={styles.rowTopLine}>
                      <Text style={styles.rowKode}>{item.kode}</Text>
                      {item.klasifikasiLhu ? (
                        <View style={styles.rowBadge}>
                          <Text style={styles.rowBadgeText}>{LHU_KLASIFIKASI_LABEL[item.klasifikasiLhu]}</Text>
                        </View>
                      ) : (
                        <View style={[styles.rowBadge, styles.rowBadgeWarn]}>
                          <Text style={[styles.rowBadgeText, styles.rowBadgeWarnText]}>Belum diklasifikasikan</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.rowNama}>{item.nama}</Text>
                  </View>
                  {active && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={<Text style={styles.emptyText}>Tidak ada akun ditemukan.</Text>}
          />

          <View style={styles.footer}>
            <TouchableOpacity style={styles.closeButton} onPress={() => setOpen(false)}>
              <Text style={styles.closeButtonText}>Tutup</Text>
            </TouchableOpacity>
          </View>
          </AreaAmanKeyboard>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginBottom: spacing.sm },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
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
  selectorText: { fontSize: 15, color: colors.text, fontWeight: '600' },
  selectorPlaceholder: { fontSize: 15, color: colors.placeholder },
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 12,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowActive: { backgroundColor: colors.primaryLight, borderRadius: radius.sm, borderBottomColor: 'transparent' },
  rowTopLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowKode: { fontSize: 12, color: colors.primary, fontWeight: '700' },
  rowNama: { fontSize: 15, fontWeight: '600', color: colors.text, marginTop: 2 },
  rowBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  rowBadgeText: { fontSize: 10, color: colors.textMuted, fontWeight: '600' },
  rowBadgeWarn: { backgroundColor: '#FEF3E2', borderColor: colors.warning },
  rowBadgeWarnText: { color: colors.warning },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: 24 },
  footer: { padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  closeButton: {
    borderRadius: radius.sm,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  closeButtonText: { color: colors.text, fontWeight: '700' },
  input: { ...formUi.inputStandalone },
  inputMultiline: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  readonlyBox: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.md },
  readonlyText: { fontSize: 14, color: colors.text, fontWeight: '600' },
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

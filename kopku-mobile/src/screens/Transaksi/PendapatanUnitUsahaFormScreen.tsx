import React, { useCallback, useEffect, useRef, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';
import UnitUsahaPicker from '@/components/UnitUsahaPicker';
import type { UnitUsahaRow } from '@/services/KoperasiMasterService';
import { newId } from '@/utils/id';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import FocusTextInput from '@/components/FocusTextInput';
import EmptyState from '@/components/report/EmptyState';
import { RekeningItem } from '@/services/KasBankService';
import {
  catatPendapatanUnitUsaha,
  getInfoPendapatanUnitUsaha,
  InfoPendapatanUnitUsaha,
} from '@/services/PendapatanUnitUsahaService';
import { LHU_KLASIFIKASI_LABEL } from '@/repositories/AccountRepository';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * Form "Pendapatan Unit Usaha" (Penerimaan > Pendapatan Koperasi).
 *
 * Mencatat PENDAPATAN unit usaha yang sudah menjadi hak koperasi dan sudah
 * diterima di kas/bank: Dr Kas/Bank, Cr 4-1400. BUKAN pengembalian RAKU —
 * itu layar lain (PengembalianRAKForm, Penerimaan > RAKU, Cr 1-1800).
 *
 * Akun TIDAK dipilih operator: 4-1400 ditampilkan read-only dan ditetapkan
 * service. Seluruh validasi otoritatif ada di `catatPendapatanUnitUsaha`;
 * validasi di sini hanya UX. Layar ini tidak menulis database.
 *
 * Poin 5 — Unit Usaha WAJIB dipilih dari master (UnitUsahaPicker existing,
 * hanya unit AKTIF) dan disimpan sebagai referensi. Field "Nomor Dokumen"
 * dihapus (tidak terhubung ke master mana pun).
 *
 * Idempotensi: kunci pengiriman dibuat SEKALI per isian form (`newId()`)
 * dan baru diganti setelah transaksi berhasil, sehingga retry setelah
 * galat tidak menggandakan jurnal. Kunci submit sinkron mencegah ketukan
 * ganda.
 */


function pesanUntukOperator(e: unknown): string {
  if (e && typeof e === 'object' && (e as { name?: string }).name === 'ClosedPeriodError') {
    return 'Periode akuntansi untuk tanggal ini sudah ditutup. Pilih tanggal pada periode yang masih terbuka.';
  }
  const pesan = e instanceof Error ? e.message : '';
  if (!pesan || /sqlite|constraint|typeerror|undefined|\bnull\b|stack/i.test(pesan)) {
    return 'Transaksi belum dapat disimpan. Silakan coba lagi.';
  }
  return pesan;
}

export default function PendapatanUnitUsahaFormScreen() {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [info, setInfo] = useState<InfoPendapatanUnitUsaha | null>(null);
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [unitUsaha, setUnitUsaha] = useState<UnitUsahaRow | null>(null);
  const kunciPengiriman = useRef(newId());
  const [nominal, setNominal] = useState<number | ''>('');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [keterangan, setKeterangan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const sedangMengirim = useRef(false);

  const muat = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setInfo(await getInfoPendapatanUnitUsaha());
    } catch {
      setLoadError('Data belum dapat dimuat. Silakan coba lagi.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    muat();
  }, [muat]);

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi.';
    if (!unitUsaha) e.unitUsaha = 'Unit usaha wajib dipilih.';
    if (nominal === '' || nominal <= 0) e.nominal = 'Nominal harus lebih besar dari 0.';
    if (!rekening) e.rekening = 'Kas/Bank wajib dipilih.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (sedangMengirim.current) return;
    if (!info?.akun || !currentUser) return;
    if (!validate() || !rekening || !unitUsaha || nominal === '') return;
    sedangMengirim.current = true;
    setSubmitting(true);
    try {
      await catatPendapatanUnitUsaha({
        tanggal,
        unitUsahaId: unitUsaha.id,
        idempotencyKey: kunciPengiriman.current,
        nominal,
        jenis: rekening.jenis,
        bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
        keterangan: keterangan || undefined,
        createdBy: currentUser.id,
      });
      kunciPengiriman.current = newId();
      notify('Berhasil', `${info.label} berhasil dicatat.`, [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (e) {
      notify('Gagal', pesanUntukOperator(e));
    } finally {
      sedangMengirim.current = false;
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

  if (loadError || !info) {
    return (
      <View style={styles.center}>
        <EmptyState icon="alert-circle-outline" title="Data belum dapat dimuat" message={loadError ?? 'Silakan coba lagi.'} />
        <TouchableOpacity accessibilityRole="button" style={styles.retryButton} onPress={muat}>
          <Text style={styles.retryText}>Coba lagi</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const bisaSimpan = !!info.akun && !submitting;

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl * 2 }}>
        {/* Pemisah bagian: Catat Pendapatan | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
            lewat Detail History Transaksi (satu pintu). */}
        <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="PENDAPATAN_UNIT_USAHA" />
        {tabMenu === 'RIWAYAT' ? (
          <RiwayatTransaksiMenu menu="PENDAPATAN_UNIT_USAHA" />
        ) : (
        <>
        <View style={styles.infoBox}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
          <Text style={styles.infoText}>
            Penerimaan pendapatan dari kegiatan unit usaha koperasi — dicatat ke COA {info.akunKode}. Dicatat saat kas/bank
            diterima: Dr Kas/Bank, Kr {info.akunKode}. Pengembalian dana RAKU BUKAN pendapatan — catat lewat Penerimaan › RAKU ›
            Pengembalian RAKU.
          </Text>
        </View>

        {info.masalah ? (
          <View style={styles.warnBox} accessibilityRole="alert">
            <Ionicons name="warning-outline" size={16} color={colors.warning} />
            <Text style={styles.warnText}>{info.masalah} Transaksi tidak dapat disimpan sampai akun tersedia.</Text>
          </View>
        ) : null}

        <Text style={styles.label}>Tanggal *</Text>
        <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />

        {/* Poin 5 — Unit Usaha dari master (hanya AKTIF); tidak membuat unit baru. */}
        <View style={{ marginTop: spacing.md }}>
          <UnitUsahaPicker value={unitUsaha} onChange={setUnitUsaha} error={errors.unitUsaha} />
        </View>

        <Text style={[styles.label, { marginTop: spacing.md }]}>COA Pendapatan</Text>
        <View style={styles.readonlyBox} accessibilityLabel={`COA Pendapatan ${info.akunKode}, ditetapkan sistem`}>
          <Text style={styles.readonlyText}>
            {info.akunKode} — {info.akun ? info.akun.nama : info.label}
          </Text>
          <Text style={styles.readonlySub}>
            {info.akun ? `${LHU_KLASIFIKASI_LABEL[info.akun.klasifikasiLhu]} · ` : ''}Ditetapkan sistem, tidak dapat diubah
          </Text>
        </View>

        <Text style={[styles.label, { marginTop: spacing.md }]}>Nominal (Rp) *</Text>
        <CurrencyInput value={nominal} onChangeValue={setNominal} error={errors.nominal} />

        <View style={{ marginTop: spacing.md }}>
          <RekeningPicker label="Diterima di Kas/Bank *" value={rekening} onChange={setRekening} />
          {errors.rekening ? <Text style={styles.errorText}>{errors.rekening}</Text> : null}
        </View>

        <Text style={[styles.label, { marginTop: spacing.md }]}>Keterangan</Text>
        <FocusTextInput
          style={styles.inputMultiline}
          value={keterangan}
          onChangeText={setKeterangan}
          multiline
          placeholder="Mis. uraian penerimaan"
          placeholderTextColor={colors.placeholder}
        />

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ disabled: !bisaSimpan }}
          style={[styles.submitButton, !bisaSimpan && styles.disabled]}
          onPress={submit}
          disabled={!bisaSimpan}
        >
          {submitting ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Ionicons name="save-outline" size={18} color={colors.white} />
              <Text style={styles.submitText}>Simpan Pendapatan</Text>
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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, backgroundColor: colors.background },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  readonlyBox: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: spacing.md },
  readonlyText: { fontSize: 14, color: colors.text, fontWeight: '600' },
  readonlySub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
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
    alignItems: 'flex-start',
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  warnText: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
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
  disabled: { opacity: 0.6 },
  submitText: { color: colors.white, fontWeight: '700', fontSize: 15 },
  retryButton: { marginTop: spacing.md, paddingVertical: 12, paddingHorizontal: spacing.xl, borderRadius: radius.sm, backgroundColor: colors.primary },
  retryText: { color: colors.white, fontWeight: '700' },
});

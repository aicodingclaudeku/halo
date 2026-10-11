import React, { useEffect, useState } from 'react';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import DataReferensiPicker from '@/components/DataReferensiPicker';
import FocusTextInput from '@/components/FocusTextInput';
import FieldError from '@/components/FieldError';
import { RekeningItem } from '@/services/KasBankService';
import { terimaUtang, JenisPemberi, JenisBunga, BasisBunga } from '@/services/UtangService';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

const JENIS_PEMBERI_OPTIONS: { value: Exclude<JenisPemberi, 'UTANG_USAHA'>; label: string }[] = [
  { value: 'BANK', label: 'Bank' },
  { value: 'PIHAK_LAIN', label: 'Pihak Lain' },
];

const BASIS_BUNGA_OPTIONS: { value: BasisBunga; label: string }[] = [
  { value: 'TAHUNAN', label: 'Per Tahun' },
  { value: 'BULANAN', label: 'Per Bulan' },
];

const JENIS_BUNGA_OPTIONS: { value: JenisBunga; label: string }[] = [
  { value: 'FLAT', label: 'Flat' },
  { value: 'EFEKTIF', label: 'Efektif' },
  { value: 'LAINNYA', label: 'Lainnya' },
];

/**
 * Sub-fitur "Utang Koperasi" (Penerimaan) — pinjaman diterima dari
 * LPDB/Koperasi Lain/Bank/Pihak Lain (pokok & bunga). Judul menu
 * diubah dari "Utang" menjadi "Utang Koperasi" (permintaan pengguna,
 * update pasca-Phase 18 §5) — nama service/tabel internal
 * (`UtangService`, tabel `utang`) TIDAK diubah, sesuai instruksi
 * ("internal service/class/table boleh tetap bernama existing").
 */
export default function UtangFormScreen() {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const requestStartupTask = useAppStore((s) => s.requestStartupTask);

  const [namaPemberi, setNamaPemberi] = useState('');
  const [jenisPemberi, setJenisPemberi] = useState<Exclude<JenisPemberi, 'UTANG_USAHA'>>('BANK');
  const [pokok, setPokok] = useState<number | ''>('');
  const [persenBunga, setPersenBunga] = useState('');
  const [jenisBunga, setJenisBunga] = useState<JenisBunga>('FLAT');
  /**
   * RC-S55 §3 — basis bunga TIDAK punya nilai awal yang dipilih.
   *
   * Memberi default 'TAHUNAN' atau 'BULANAN' di sini akan mengulang persis
   * kesalahan yang membuat seluruh data lama ambigu: angka bunga tersimpan
   * dengan basis yang tidak pernah benar-benar dipilih siapa pun.
   */
  const [basisBunga, setBasisBunga] = useState<BasisBunga | null>(null);
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [keterangan, setKeterangan] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Ganti jenis pemberi (Bank <-> Pihak Lain) berarti master data
  // sumbernya beda (PEMBERI_PINJAMAN_BANK vs PEMBERI_PINJAMAN_PIHAK_LAIN)
  // — nama yang sudah dipilih untuk jenis sebelumnya tidak relevan lagi.
  useEffect(() => {
    setNamaPemberi('');
  }, [jenisPemberi]);

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!namaPemberi.trim()) e.namaPemberi = `Nama ${jenisPemberi === 'BANK' ? 'bank' : 'pihak'} pemberi wajib diisi`;
    if (pokok === '' || pokok <= 0) e.pokok = 'Pinjaman pokok harus lebih dari 0';
    const bungaNum = parseFloat(persenBunga.replace(',', '.'));
    if (persenBunga !== '' && (isNaN(bungaNum) || bungaNum < 0)) e.persenBunga = 'Persentase bunga tidak valid';
    // Bunga > 0 tanpa basis = data yang tidak bisa diakru otomatis.
    if (!isNaN(bungaNum) && bungaNum > 0 && basisBunga === null) {
      e.basisBunga = 'Pilih basis bunga (Per Tahun / Per Bulan)';
    }
    if (!rekening) e.rekening = 'Rekening penerima dana wajib dipilih';
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate() || !rekening || !currentUser || pokok === '') return;
    setSubmitting(true);
    try {
      await terimaUtang({
        namaPemberi: namaPemberi.trim(),
        jenisPemberi,
        pokokPinjaman: pokok,
        persenBunga: parseFloat(persenBunga.replace(',', '.')) || 0,
        jenisBunga,
        basisBunga,
        tanggal,
        sumberDana: rekening.jenis === 'BANK' ? 'BANK' : 'KAS',
        bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
        keterangan: keterangan || undefined,
        createdBy: currentUser.id,
      });
      // RC-S74 FINAL FIX DELAY AKRUAL (§3/§4) — utang baru bisa butuh akrual
      // bunga otomatis. `navigation.goBack()` di bawah mengembalikan ke layar
      // Penerimaan, BUKAN ke Dashboard, dan koordinator StartupTasks tidak
      // dipanggil langsung dari sini (dilarang §1). Jadi hanya MENANDAI:
      // Dashboard yang akan menjalankan koordinator existing saat difokuskan.
      requestStartupTask();
      notify('Berhasil', 'Penerimaan utang berhasil dicatat.', [{ text: 'OK', onPress: () => navigation.goBack() }]);
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
        <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="UTANG" />
        {tabMenu === 'RIWAYAT' ? (
          <RiwayatTransaksiMenu menu="UTANG" />
        ) : (
        <>
        <Text style={styles.sectionLabel}>Jenis Pemberi</Text>
        <View style={styles.chipRow}>
          {JENIS_PEMBERI_OPTIONS.map((opt) => (
            <Chip key={opt.value} label={opt.label} active={jenisPemberi === opt.value} onPress={() => setJenisPemberi(opt.value)} />
          ))}
        </View>

        <Text style={styles.label}>{jenisPemberi === 'BANK' ? 'Nama Bank Pemberi Pinjaman *' : 'Nama Pihak Pemberi Pinjaman *'}</Text>
        <DataReferensiPicker
          jenis={jenisPemberi === 'BANK' ? 'PEMBERI_PINJAMAN_BANK' : 'PEMBERI_PINJAMAN_PIHAK_LAIN'}
          label={jenisPemberi === 'BANK' ? 'Bank Pemberi Pinjaman' : 'Pihak Pemberi Pinjaman'}
          value={namaPemberi}
          onChange={setNamaPemberi}
          error={errors.namaPemberi}
        />

        <Text style={[styles.label, { marginTop: spacing.md }]}>Pinjaman Pokok *</Text>
        <CurrencyInput value={pokok} onChangeValue={setPokok} error={errors.pokok} />

        <Text style={[styles.label, { marginTop: spacing.md }]}>Persentase Bunga (%)</Text>
        <FocusTextInput
          style={styles.input}
          value={persenBunga}
          onChangeText={setPersenBunga}
          keyboardType="decimal-pad"
          placeholder="Mis. 1.5"
          placeholderTextColor={colors.placeholder}
          invalid={!!errors.persenBunga}
        />
        {errors.persenBunga && <FieldError message={errors.persenBunga} />}

        <Text style={styles.sectionLabel}>Basis Bunga *</Text>
        <View style={styles.chipRow}>
          {BASIS_BUNGA_OPTIONS.map((opt) => (
            <Chip
              key={opt.value}
              label={opt.label}
              active={basisBunga === opt.value}
              onPress={() => setBasisBunga(opt.value)}
            />
          ))}
        </View>
        <Text style={styles.hint}>
          Menentukan apakah angka di atas berlaku per tahun atau per bulan. Wajib dipilih supaya bunga
          dapat diakru otomatis setiap bulan.
        </Text>
        {errors.basisBunga && <FieldError message={errors.basisBunga} />}

        <Text style={styles.sectionLabel}>Jenis Bunga</Text>
        <View style={styles.chipRow}>
          {JENIS_BUNGA_OPTIONS.map((opt) => (
            <Chip key={opt.value} label={opt.label} active={jenisBunga === opt.value} onPress={() => setJenisBunga(opt.value)} />
          ))}
        </View>

        <RekeningPicker label="Diterima di Rekening" value={rekening} onChange={setRekening} />
        {errors.rekening && <Text style={styles.errorText}>{errors.rekening}</Text>}

        <Text style={styles.label}>Tanggal *</Text>
        <DatePicker value={tanggal} onChange={setTanggal} error={errors.tanggal} maximumDate={getWaktuSekarang()} />

        <View style={{ marginTop: spacing.md }}>
          <Text style={styles.label}>Keterangan</Text>
          <FocusTextInput
            style={styles.inputMultiline}
            value={keterangan}
            onChangeText={setKeterangan}
            multiline
            placeholderTextColor={colors.placeholder}
          />
        </View>

        <TouchableOpacity style={[styles.submitButton, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
          {submitting ? (
            <ActivityIndicator color={colors.white} />
          ) : (
            <>
              <Ionicons name="save-outline" size={18} color={colors.white} />
              <Text style={styles.submitText}>Simpan Utang Koperasi</Text>
            </>
          )}
        </TouchableOpacity>
        </>
        )}
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
  hint: { fontSize: 11, color: colors.textMuted, marginTop: 6, lineHeight: 15 },
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: spacing.md, marginBottom: spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing.sm },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  input: { ...formUi.inputStandalone },
  inputMultiline: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
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

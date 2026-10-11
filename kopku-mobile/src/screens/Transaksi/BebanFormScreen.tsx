import React, { useCallback, useMemo, useState } from 'react';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, FlatList, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import RekeningPicker from '@/components/RekeningPicker';
import CurrencyInput from '@/components/CurrencyInput';
import DatePicker from '@/components/DatePicker';
import SearchField from '@/components/SearchField';
import { RekeningItem, catatPengeluaran } from '@/services/KasBankService';
import { listAccounts } from '@/repositories/AccountRepository';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, semantic, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { modalUi } from '@/theme/modal';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { listDataReferensi } from '@/services/DataReferensiService';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { cariOpsiKategoriBeban, OpsiKategoriBeban, susunOpsiKategoriBeban } from '@/utils/kategoriBeban';
import { getWaktuSekarang } from '@/services/DevClockService';
import RiwayatTransaksiMenu from '@/components/RiwayatTransaksiMenu';
import TabTransaksi, { type TabTransaksiNilai } from '@/components/transaksi/TabTransaksi';

/**
 * Daftar kategori disusun `susunOpsiKategoriBeban()` (src/utils/kategoriBeban.ts):
 * kategori tetap (nama = nama akun di defaultCOA.ts, dicocokkan by-name
 * seperti sebelumnya) + entri Data Beban Lain yang sudah diinput pengguna.
 * "Beban Imbalan Kerja" tidak ditawarkan (ada menu Imbalan Kerja sendiri);
 * "Beban Lainnya" generik digantikan oleh entri Data Beban Lain, yang
 * dibukukan ke akun yang sama (5-2000).
 */

/** Sub-fitur "Beban" (Pengeluaran) — kategori sudah ditentukan, tinggal pilih. */
export default function BebanFormScreen() {
  const [tabMenu, setTabMenu] = useState<TabTransaksiNilai>('BARU');
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [kategori, setKategori] = useState<OpsiKategoriBeban | null>(null);
  const [bebanLain, setBebanLain] = useState<{ id: string; nama: string; keterangan: string | null }[]>([]);
  const [memuatKategori, setMemuatKategori] = useState(true);

  // Dimuat ulang setiap layar kembali fokus — entri yang baru ditambah di
  // "Data Beban Lain" langsung muncul tanpa membuka ulang form.
  const muatBebanLain = useCallback(async () => {
    try {
      setBebanLain(await listDataReferensi('BEBAN_LAIN'));
    } catch {
      setBebanLain([]);
    } finally {
      setMemuatKategori(false);
    }
  }, []);
  useFocusRefresh(muatBebanLain, [muatBebanLain]);
  const opsiKategori = useMemo(() => susunOpsiKategoriBeban(bebanLain), [bebanLain]);
  const [nilai, setNilai] = useState<number | ''>('');
  const [rekening, setRekening] = useState<RekeningItem | null>(null);
  const [tanggal, setTanggal] = useState(getTanggalLokalHariIni());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!kategori) e.kategori = 'Pilih kategori beban';
    if (nilai === '' || nilai <= 0) e.nilai = 'Nilai transaksi harus lebih dari 0';
    if (!rekening) e.rekening = 'Rekening sumber pembayaran wajib dipilih';
    if (!tanggal) e.tanggal = 'Tanggal wajib diisi';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate() || !kategori || !rekening || !currentUser || nilai === '') return;
    setSubmitting(true);
    try {
      // Kategori tetap: dicocokkan by-name (seperti sebelumnya). Entri Data
      // Beban Lain: akun Beban Lainnya dicari by-kode supaya tetap benar
      // walau nama akunnya pernah diubah di COA.
      const akun =
        kategori.sumber === 'KATEGORI'
          ? (await listAccounts({ search: kategori.akunNama })).find((a) => a.nama === kategori.akunNama)
          : (await listAccounts({ search: kategori.akunKode })).find((a) => a.kode === kategori.akunKode);
      if (!akun) {
        throw new Error(
          kategori.sumber === 'KATEGORI'
            ? `Akun "${kategori.akunNama}" tidak ditemukan di Chart of Accounts.`
            : `Akun beban lain-lain (${kategori.akunKode}) tidak ditemukan di Chart of Accounts.`
        );
      }
      await catatPengeluaran({
        jenis: rekening.jenis,
        bankAccountId: rekening.jenis === 'BANK' ? rekening.id : undefined,
        tanggal,
        nominal: nilai,
        akunLawanId: akun.id,
        kategori: kategori.label,
        createdBy: currentUser.id,
      });
      notify('Berhasil', `${kategori.label} berhasil dicatat.`, [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        {/* Pemisah bagian: Transaksi Baru | Riwayat. Riwayat hanya membaca; koreksi/pembatalan
            lewat Detail History Transaksi (satu pintu). */}
        <TabTransaksi value={tabMenu} onChange={setTabMenu} menu="BEBAN" />
        {tabMenu === 'RIWAYAT' ? (
          <RiwayatTransaksiMenu menu="BEBAN" />
        ) : (
        <>
        <Text style={styles.sectionLabel}>Kategori Beban</Text>
        <KategoriBebanSelect
          options={opsiKategori}
          value={kategori}
          onChange={setKategori}
          error={errors.kategori}
          memuat={memuatKategori}
          onKelolaBebanLain={() => navigation.navigate('DataReferensiList', { jenis: 'BEBAN_LAIN' })}
        />
        {kategori?.sumber === 'BEBAN_LAIN' ? (
          <Text style={styles.hint}>
            Beban lain · dicatat ke akun {kategori.akunKode} Beban Lainnya{kategori.keterangan ? ` — ${kategori.keterangan}` : ''}
          </Text>
        ) : null}

        <Text style={[styles.label, { marginTop: spacing.md }]}>Nilai Transaksi *</Text>
        <CurrencyInput value={nilai} onChangeValue={setNilai} error={errors.nilai} />

        <View style={{ marginTop: spacing.md }}>
          <RekeningPicker label="Metode Pembayaran (Rekening)" value={rekening} onChange={setRekening} />
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
              <Text style={styles.submitText}>Simpan Beban</Text>
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
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowActive: { backgroundColor: colors.primaryLight, borderRadius: radius.sm, borderBottomColor: 'transparent' },
  rowText: { fontSize: 15, fontWeight: '600', color: colors.text, flex: 1 },
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
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  hint: { fontSize: 11, color: colors.textMuted, marginTop: spacing.xs, lineHeight: 16 },
  groupTitle: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', marginTop: spacing.md, marginBottom: 2, paddingHorizontal: spacing.sm },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  footerHint: { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginTop: spacing.lg, paddingHorizontal: spacing.md, lineHeight: 17 },
  kelolaButton: { flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  kelolaText: { color: colors.text, fontWeight: '700' },
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

interface KategoriBebanSelectProps {
  options: OpsiKategoriBeban[];
  value: OpsiKategoriBeban | null;
  onChange: (kategori: OpsiKategoriBeban) => void;
  error?: string;
  memuat: boolean;
  onKelolaBebanLain: () => void;
}

type BarisModal = { tipe: 'JUDUL'; key: string; judul: string } | { tipe: 'OPSI'; key: string; opsi: OpsiKategoriBeban };

/**
 * Selector Kategori Beban bergaya "select" dengan modal + pencarian.
 * Dua kelompok: "Kategori Beban" (tetap) dan "Beban Lain" (Data Beban
 * Lain yang diinput pengguna).
 */
function KategoriBebanSelect({ options, value, onChange, error, memuat, onKelolaBebanLain }: KategoriBebanSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const baris = useMemo<BarisModal[]>(() => {
    const hasil = cariOpsiKategoriBeban(options, query);
    const tetap = hasil.filter((o) => o.sumber === 'KATEGORI');
    const lain = hasil.filter((o) => o.sumber === 'BEBAN_LAIN');
    const out: BarisModal[] = [];
    if (tetap.length) {
      out.push({ tipe: 'JUDUL', key: 'j-tetap', judul: 'Kategori Beban' });
      tetap.forEach((o) => out.push({ tipe: 'OPSI', key: o.key, opsi: o }));
    }
    if (lain.length) {
      out.push({ tipe: 'JUDUL', key: 'j-lain', judul: 'Beban Lain' });
      lain.forEach((o) => out.push({ tipe: 'OPSI', key: o.key, opsi: o }));
    }
    return out;
  }, [options, query]);

  const adaBebanLain = options.some((o) => o.sumber === 'BEBAN_LAIN');

  return (
    <View>
      <TouchableOpacity
        style={[styles.selector, error && styles.selectorError]}
        onPress={() => {
          setQuery('');
          setOpen(true);
        }}
      >
        <Ionicons name="pricetags-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
        <View style={{ flex: 1 }}>
          <Text style={value ? styles.selectorText : styles.selectorPlaceholder} numberOfLines={1}>
            {value?.label ?? 'Pilih kategori beban...'}
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
            <Text style={styles.modalTitle}>Pilih Kategori Beban</Text>
            <TouchableOpacity style={styles.closeIcon} onPress={() => setOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={{ paddingHorizontal: spacing.lg }}>
            <SearchField
              placeholder="Cari kategori beban..."
              placeholderTextColor={colors.placeholder}
              value={query}
              onChangeText={setQuery}
              autoFocus
            />
          </View>

          <FlatList keyboardShouldPersistTaps="handled"
            data={baris}
            keyExtractor={(item) => item.key}
            contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }}
            renderItem={({ item }) => {
              if (item.tipe === 'JUDUL') return <Text style={styles.groupTitle}>{item.judul}</Text>;
              const o = item.opsi;
              const active = value?.key === o.key;
              return (
                <TouchableOpacity
                  style={[styles.row, active && styles.rowActive]}
                  onPress={() => {
                    onChange(o);
                    setOpen(false);
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowText}>{o.label}</Text>
                    {o.sumber === 'BEBAN_LAIN' && o.keterangan ? (
                      <Text style={styles.rowSub} numberOfLines={1}>{o.keterangan}</Text>
                    ) : null}
                  </View>
                  {/* RC-S70.1 — state TERPILIH pada kategori Beban memakai merah
                      Pengeluaran yang sama (satu token, tanpa varian merah baru). */}
                  {active && <Ionicons name="checkmark-circle" size={20} color={semantic.expenseIcon} />}
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={<Text style={styles.emptyText}>Tidak ada kategori ditemukan.</Text>}
            ListFooterComponent={
              memuat ? (
                <ActivityIndicator style={{ marginTop: spacing.md }} color={colors.primary} />
              ) : !adaBebanLain ? (
                <Text style={styles.footerHint}>
                  Belum ada Data Beban Lain. Tambahkan jenis beban di luar kategori di atas melalui "Kelola Data Beban Lain".
                </Text>
              ) : null
            }
          />

          <View style={[styles.footer, { gap: spacing.sm }]}>
            <TouchableOpacity
              style={styles.kelolaButton}
              onPress={() => {
                setOpen(false);
                onKelolaBebanLain();
              }}
            >
              <Ionicons name="add-circle-outline" size={18} color={colors.text} />
              <Text style={styles.kelolaText}>Kelola Data Beban Lain</Text>
            </TouchableOpacity>
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

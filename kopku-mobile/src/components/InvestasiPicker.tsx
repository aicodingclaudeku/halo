import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { listInvestasi, InvestasiListItem, LABEL_JENIS_INVESTASI } from '@/services/InvestasiService';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { modalUi } from '@/theme/modal';

/**
 * Picker investasi berstatus AKTIF — dipakai form Impairment Investasi
 * (Phase 17 §8.3), pola sama persis UtangPicker.
 *
 * RC-S53 hardening: `onlyJenisInvestasi` OPSIONAL dan tidak mengubah
 * perilaku pemanggil mana pun yang sudah ada — tanpa prop ini daftarnya
 * persis seperti sebelumnya. Dipakai layar yang memang hanya boleh
 * memilih satu jenis investasi (mis. penyusutan properti investasi),
 * supaya pengguna tidak dibiarkan memilih objek yang pasti ditolak
 * service. Ini perlindungan kegunaan; penjagaan akuntansinya tetap ada
 * di service dan TIDAK dihapus.
 */
export default function InvestasiPicker({
  value,
  onChange,
  error,
  onlyJenisInvestasi,
  emptyTitle,
  emptyMessage,
}: {
  value: InvestasiListItem | null;
  onChange: (i: InvestasiListItem) => void;
  error?: string;
  onlyJenisInvestasi?: InvestasiListItem['jenisInvestasi'];
  /**
   * Teks kosong khusus pemanggil (opsional). Tanpa prop ini tampilan
   * kosong persis seperti sebelumnya ("Tidak ada investasi aktif.").
   */
  emptyTitle?: string;
  emptyMessage?: string;
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<InvestasiListItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listInvestasi()
      .then((all) =>
        setResults(
          all.filter(
            (i) =>
              i.status === 'AKTIF' &&
              (!onlyJenisInvestasi || i.jenisInvestasi === onlyJenisInvestasi)
          )
        )
      )
      .finally(() => setLoading(false));
  }, [open, onlyJenisInvestasi]);

  return (
    <View style={styles.field}>
      <Text style={styles.label}>Investasi *</Text>
      <TouchableOpacity accessibilityRole="button" style={[styles.selector, error && styles.selectorError]} onPress={() => setOpen(true)}>
        <Ionicons name="trending-up-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
        <Text style={value ? styles.selectorText : styles.selectorPlaceholder}>
          {value ? `${value.namaTujuan} · ${value.nomorInvestasi} (${formatRupiah(value.jumlah)})` : 'Pilih investasi aktif...'}
        </Text>
        <Ionicons name="chevron-down" size={iconSize.md} color={colors.textMuted} style={pickerAffordance} />
      </TouchableOpacity>
      {error && <Text style={styles.errorText}>{error}</Text>}

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Pilih Investasi</Text>
            <TouchableOpacity style={styles.closeIcon} onPress={() => setOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <FlatList
            data={results}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.row}
                onPress={() => {
                  onChange(item);
                  setOpen(false);
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowNama}>{item.namaTujuan}</Text>
                  <Text style={styles.rowSub}>
                    {item.nomorInvestasi} · {LABEL_JENIS_INVESTASI[item.jenisInvestasi]}
                  </Text>
                </View>
                <Text style={styles.rowSaldo}>{formatRupiah(item.jumlah)}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              !loading ? (
                emptyTitle || emptyMessage ? (
                  <View style={styles.emptyBox}>
                    {emptyTitle ? <Text style={styles.emptyTitle}>{emptyTitle}</Text> : null}
                    {emptyMessage ? <Text style={styles.emptyText}>{emptyMessage}</Text> : null}
                  </View>
                ) : (
                  <Text style={styles.emptyText}>Tidak ada investasi aktif.</Text>
                )
              ) : null
            }
          />

          <View style={styles.footer}>
            <TouchableOpacity style={styles.closeButton} onPress={() => setOpen(false)}>
              <Text style={styles.closeButtonText}>Tutup</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

/** UI/UX REDESIGN — penanda visual bahwa field ini dapat dibuka (tidak mengubah onPress/opsi). */
const pickerAffordance = { flexShrink: 0 };

const styles = StyleSheet.create({
  field: { marginBottom: spacing.md },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  selector: { gap: 8,
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
  selectorText: { flex: 1, fontSize: 15, color: colors.text },
  selectorPlaceholder: { flex: 1, fontSize: 15, color: colors.placeholder },
  errorText: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
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
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowNama: { fontSize: 15, fontWeight: '600', color: colors.text },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  rowSaldo: { fontSize: 13, fontWeight: '700', color: colors.primary },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: 24 },
  emptyBox: { alignItems: 'center', paddingHorizontal: spacing.lg, marginTop: 24 },
  emptyTitle: { textAlign: 'center', color: colors.text, fontWeight: '700', fontSize: 14 },
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
});

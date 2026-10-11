import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { listUtang, UtangListItem, JenisPemberi } from '@/services/UtangService';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { modalUi } from '@/theme/modal';

/** Picker utang berstatus AKTIF (masih ada sisa pokok) — dipakai form Kewajiban (pelunasan utang). */
export default function UtangPicker({
  value,
  onChange,
  error,
  jenisPemberi,
}: {
  value: UtangListItem | null;
  onChange: (u: UtangListItem) => void;
  error?: string;
  /**
   * Revisi KOPKU (Bagian 2): kalau diisi, daftar HANYA berisi utang
   * dengan jenis pemberi ini — dipakai `BayarUtangFormScreen` setelah
   * user memilih akun COA Liabilitas tertentu (mis. akun "Utang Bank"
   * -> picker ini hanya menampilkan utang jenis BANK), supaya utang
   * yang muncul tetap konsisten dengan akun yang sudah dipilih.
   */
  jenisPemberi?: JenisPemberi;
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<UtangListItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listUtang({ status: 'AKTIF', jenisPemberi })
      .then(setResults)
      .finally(() => setLoading(false));
  }, [open, jenisPemberi]);

  return (
    <View style={styles.field}>
      <Text style={styles.label}>Utang Koperasi *</Text>
      <TouchableOpacity accessibilityRole="button" style={[styles.selector, error && styles.selectorError]} onPress={() => setOpen(true)}>
        <Ionicons name="document-text-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
        <Text style={value ? styles.selectorText : styles.selectorPlaceholder}>
          {value ? `${value.namaPemberi} · ${value.nomorUtang} (sisa ${formatRupiah(value.sisaPokok)})` : 'Pilih utang koperasi aktif...'}
        </Text>
        <Ionicons name="chevron-down" size={iconSize.md} color={colors.textMuted} style={pickerAffordance} />
      </TouchableOpacity>
      {error && <Text style={styles.errorText}>{error}</Text>}

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Pilih Utang Koperasi</Text>
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
                  <Text style={styles.rowNama}>{item.namaPemberi}</Text>
                  <Text style={styles.rowSub}>
                    {item.nomorUtang} ·{' '}
                    {item.jenisPemberi === 'BANK'
                      ? 'Bank'
                      : item.jenisPemberi === 'PIHAK_LAIN'
                      ? 'Pihak Lain'
                      : 'Utang Usaha (Pembelian Aset)'}
                    {item.jenisPemberi !== 'UTANG_USAHA' && ` · ${item.persenBunga}% (${item.jenisBunga})`}
                  </Text>
                </View>
                <Text style={styles.rowSaldo}>{formatRupiah(item.sisaPokok)}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              !loading ? <Text style={styles.emptyText}>Tidak ada utang koperasi aktif.</Text> : null
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

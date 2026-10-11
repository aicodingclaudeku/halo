import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { listPinjaman, PinjamanListItem } from '@/services/PinjamanService';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { modalUi } from '@/theme/modal';

import SearchField from '@/components/SearchField';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
/**
 * Picker pinjaman berstatus AKTIF (yang masih punya piutang berjalan)
 * dengan pencarian offline — dipakai di PenghapusanPiutangFormScreen.
 * Pola sama dengan AnggotaPicker.tsx.
 */
export default function PinjamanPicker({
  value,
  onChange,
  error,
}: {
  value: PinjamanListItem | null;
  onChange: (p: PinjamanListItem) => void;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PinjamanListItem[]>([]);

  useEffect(() => {
    if (!open) return;
    const timeout = setTimeout(async () => {
      const rows = await listPinjaman({ search: query, status: 'AKTIF', limit: 30 });
      setResults(rows);
    }, 200);
    return () => clearTimeout(timeout);
  }, [query, open]);

  return (
    <View style={styles.field}>
      <Text style={styles.label}>Pinjaman *</Text>
      <TouchableOpacity accessibilityRole="button" style={[styles.selector, error && styles.selectorError]} onPress={() => setOpen(true)}>
        <Ionicons name="cash-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
        <Text style={value ? styles.selectorText : styles.selectorPlaceholder}>
          {value ? `${value.namaAnggota} · ${value.nomorPinjaman} (sisa piutang ${formatRupiah(value.sisaPiutang)})` : 'Pilih pinjaman aktif...'}
        </Text>
        <Ionicons name="chevron-down" size={iconSize.md} color={colors.textMuted} style={pickerAffordance} />
      </TouchableOpacity>
      {error && <Text style={styles.errorText}>{error}</Text>}

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          {/* RC-S120 — tanpa ini, saat mencari, butir terakhir daftar dan
              tombol Tutup berada di belakang papan ketik. */}
          <AreaAmanKeyboard varian="dialog" style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Pilih Pinjaman</Text>
            <TouchableOpacity style={styles.closeIcon} onPress={() => setOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={{ paddingHorizontal: spacing.lg }}>
            <SearchField
              placeholder="Cari nama anggota atau nomor pinjaman..."
              placeholderTextColor={colors.placeholder}
              value={query}
              onChangeText={setQuery}
              autoFocus
            />
          </View>

          <FlatList keyboardShouldPersistTaps="handled"
            data={results}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingHorizontal: spacing.lg }}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.row}
                onPress={() => {
                  onChange(item);
                  setOpen(false);
                }}
              >
                <Text style={styles.rowNama}>{item.namaAnggota}</Text>
                <Text style={styles.rowSub}>
                  {item.nomorPinjaman} · Plafon {formatRupiah(item.jumlahPinjaman)} · {item.tenor} {item.satuanTenor.toLowerCase()}
                </Text>
                <Text style={styles.rowSisa}>Sisa piutang: {formatRupiah(item.sisaPiutang)}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={<Text style={styles.emptyText}>Tidak ada pinjaman aktif ditemukan.</Text>}
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
  row: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowNama: { fontSize: 15, fontWeight: '600', color: colors.text },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  rowSisa: { fontSize: 12, color: colors.primary, fontWeight: '700', marginTop: 2 },
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

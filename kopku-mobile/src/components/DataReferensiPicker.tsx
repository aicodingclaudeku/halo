import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  listDataReferensi,
  tambahDataReferensi,
  DataReferensiItem,
  JenisDataReferensi,
} from '@/services/DataReferensiService';
import { useAppStore } from '@/store/useAppStore';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { modalUi } from '@/theme/modal';

import SearchField from '@/components/SearchField';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
/**
 * Picker generik untuk Data Referensi (Pemasok/Pemberi Pinjaman/Beban
 * Lain) — dipakai di form transaksi (Pembelian Aset, Utang, dst.)
 * MENGGANTIKAN TextInput bebas polos. Beda dari picker lain
 * (AnggotaPicker/UtangPicker/dst.): kalau nama yang diketik belum ada
 * di master data, tombol "Tambah ... baru" muncul supaya bisa
 * langsung dibuat & dipilih tanpa keluar dari form transaksi — master
 * data terisi alami dari pemakaian, bukan harus diinput manual dulu
 * di layar terpisah sebelum bisa transaksi.
 */
export default function DataReferensiPicker({
  jenis,
  label,
  value,
  onChange,
  error,
}: {
  jenis: JenisDataReferensi;
  label: string;
  value: string;
  onChange: (nama: string) => void;
  error?: string;
}) {
  const currentUser = useAppStore((s) => s.currentUser);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DataReferensiItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listDataReferensi(jenis)
      .then(setResults)
      .finally(() => setLoading(false));
  }, [open, jenis]);

  const filtered = results.filter((r) => r.nama.toLowerCase().includes(query.trim().toLowerCase()));
  const persisAda = results.some((r) => r.nama.toLowerCase() === query.trim().toLowerCase());

  const pilih = (nama: string) => {
    onChange(nama);
    setOpen(false);
    setQuery('');
  };

  const tambahBaru = async () => {
    if (!query.trim() || !currentUser || creating) return;
    setCreating(true);
    try {
      const hasil = await tambahDataReferensi({ jenis, nama: query.trim(), createdBy: currentUser.id });
      pilih(hasil.nama);
    } finally {
      setCreating(false);
    }
  };

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TouchableOpacity accessibilityRole="button" style={[styles.selector, error && styles.selectorError]} onPress={() => setOpen(true)}>
        <Ionicons name="business-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
        <Text style={value ? styles.selectorText : styles.selectorPlaceholder}>{value || `Pilih atau tambah ${label.toLowerCase()}...`}</Text>
        <Ionicons name="chevron-down" size={iconSize.md} color={colors.textMuted} style={pickerAffordance} />
      </TouchableOpacity>
      {error && <Text style={styles.errorText}>{error}</Text>}

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          {/* RC-S120 — tanpa ini, saat mencari, butir terakhir daftar dan
              tombol Tutup berada di belakang papan ketik. */}
          <AreaAmanKeyboard varian="dialog" style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{label}</Text>
            <TouchableOpacity onPress={() => setOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={{ paddingHorizontal: spacing.lg }}>
            <SearchField
              placeholder="Cari atau ketik nama baru..."
              placeholderTextColor={colors.placeholder}
              value={query}
              onChangeText={setQuery}
              autoFocus
            />
          </View>

          {loading ? (
            <ActivityIndicator style={{ marginTop: 24 }} />
          ) : (
            <FlatList keyboardShouldPersistTaps="handled"
              data={filtered}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ paddingHorizontal: spacing.lg }}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.row} onPress={() => pilih(item.nama)}>
                  <Text style={styles.rowNama}>{item.nama}</Text>
                  {item.keterangan ? <Text style={styles.rowSub}>{item.keterangan}</Text> : null}
                </TouchableOpacity>
              )}
              ListEmptyComponent={<Text style={styles.emptyText}>Belum ada data. Ketik nama baru lalu tekan "Tambah".</Text>}
              ListFooterComponent={
                query.trim() && !persisAda ? (
                  <TouchableOpacity style={styles.addRow} onPress={tambahBaru} disabled={creating}>
                    {creating ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                      <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
                    )}
                    <Text style={styles.addRowText}>Tambah "{query.trim()}" sebagai {label.toLowerCase()} baru</Text>
                  </TouchableOpacity>
                ) : null
              }
            />
          )}
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
  row: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowNama: { fontSize: 15, fontWeight: '600', color: colors.text },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: 24, paddingHorizontal: spacing.lg },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
  },
  addRowText: { fontSize: 13, color: colors.primary, fontWeight: '600', flex: 1 },
});

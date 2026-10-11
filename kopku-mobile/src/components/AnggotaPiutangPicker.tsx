import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { listAnggotaDenganPiutangAktif, AnggotaPiutangItem } from '@/services/PinjamanService';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { modalUi } from '@/theme/modal';

import SearchField from '@/components/SearchField';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
/**
 * Picker anggota KHUSUS untuk "Bayar Piutang Anggota" — BEDA dari
 * AnggotaPicker generik (yang menampilkan SEMUA anggota AKTIF, dipakai
 * di form Simpanan/Pengajuan Pinjaman/dll). Di sini HANYA anggota yang
 * benar-benar punya piutang pinjaman outstanding (sisa piutang > 0)
 * yang boleh muncul — dibuat sebagai komponen terpisah (bukan
 * mengubah AnggotaPicker) supaya form lain yang sudah benar tidak
 * ikut terpengaruh. Sumber data: `listAnggotaDenganPiutangAktif()`
 * (PinjamanService.ts) yang memakai rumus outstanding PERSIS sama
 * dengan listPinjaman()/hapusPiutangPinjaman() — bukan query baru.
 */
export default function AnggotaPiutangPicker({
  value,
  onChange,
  error,
}: {
  value: AnggotaPiutangItem | null;
  onChange: (item: AnggotaPiutangItem) => void;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AnggotaPiutangItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const timeout = setTimeout(async () => {
      try {
        setResults(await listAnggotaDenganPiutangAktif({ search: query }));
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(timeout);
  }, [query, open]);

  return (
    <View style={styles.field}>
      <Text style={styles.label}>Anggota (dengan piutang outstanding) *</Text>
      <TouchableOpacity accessibilityRole="button" style={[styles.selector, error && styles.selectorError]} onPress={() => setOpen(true)}>
        <Ionicons name="person-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
        <Text style={value ? styles.selectorText : styles.selectorPlaceholder}>
          {value ? `${value.namaAnggota} (${value.nomorAnggota})` : 'Pilih anggota...'}
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
            <Text style={styles.modalTitle}>Pilih Anggota</Text>
            <TouchableOpacity style={styles.closeIcon} onPress={() => setOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          <View style={{ paddingHorizontal: spacing.lg }}>
            <SearchField
              placeholder="Cari nama, nomor anggota, atau NIK..."
              placeholderTextColor={colors.placeholder}
              value={query}
              onChangeText={setQuery}
              autoFocus
            />
          </View>

          {loading && <ActivityIndicator style={{ marginTop: 16 }} />}

          {!loading && (
            <FlatList keyboardShouldPersistTaps="handled"
              data={results}
              keyExtractor={(item) => item.anggotaId}
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
                    {item.nomorAnggota} · {item.jumlahPinjamanAktif} pinjaman aktif
                  </Text>
                  <Text style={styles.rowSisa}>Sisa piutang: {formatRupiah(item.totalSisaPiutang)}</Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <Text style={styles.emptyText}>
                  Tidak ada anggota dengan piutang outstanding{query ? ' yang cocok dengan pencarian.' : '.'}
                </Text>
              }
            />
          )}

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
  rowSisa: { fontSize: 12, fontWeight: '700', color: colors.primary, marginTop: 2 },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: 24, paddingHorizontal: spacing.lg },
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

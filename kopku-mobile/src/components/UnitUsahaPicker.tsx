import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { listUnitUsaha, UnitUsahaRow } from '@/services/KoperasiMasterService';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { modalUi } from '@/theme/modal';

/**
 * ============================================================
 * RC-S64 — PICKER UNIT USAHA (master `koperasi_unit_usaha`)
 * ============================================================
 *
 * Menggantikan deretan Chip di `RAKFormScreen`. Alasannya bukan selera:
 * deretan chip tidak punya keadaan "belum dipilih" yang jelas, melebar
 * tak terkendali begitu unit bertambah, dan tidak menyediakan tempat
 * untuk status/keterangan per unit.
 *
 * KONTRAK:
 *  - daftar HANYA berisi unit berstatus AKTIF (`listUnitUsaha(true)`);
 *  - `unitHistoris` dipakai saat MENGEDIT transaksi lama yang unitnya
 *    kini NONAKTIF: unit itu tetap TAMPIL sebagai nilai terpilih supaya
 *    histori terbaca, tetapi ia TIDAK masuk daftar pilihan — jadi tidak
 *    bisa dipakai transaksi baru;
 *  - komponen ini TIDAK pernah membuat unit baru. Master dikelola di
 *    layar Identitas Koperasi.
 *
 * Tidak ada dependency baru: Modal + FlatList bawaan React Native, pola
 * dan token tema mengikuti picker yang sudah ada di project.
 */
export default function UnitUsahaPicker({
  value,
  onChange,
  error,
  disabled,
  unitHistoris,
}: {
  value: UnitUsahaRow | null;
  onChange: (u: UnitUsahaRow) => void;
  error?: string;
  disabled?: boolean;
  /** Unit dari transaksi lama yang mungkin sudah NONAKTIF — hanya untuk ditampilkan. */
  unitHistoris?: UnitUsahaRow | null;
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<UnitUsahaRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listUnitUsaha(true)
      .then(setResults)
      .finally(() => setLoading(false));
  }, [open]);

  const terpilih = value ?? unitHistoris ?? null;
  const historisNonaktif = !!terpilih && terpilih.status !== 'AKTIF';

  return (
    <View style={styles.field}>
      <Text style={styles.label}>Unit Usaha *</Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityState={{ disabled: !!disabled }}
        style={[styles.selector, error && styles.selectorError, disabled && styles.selectorDisabled]}
        onPress={() => !disabled && setOpen(true)}
        disabled={disabled}
      >
        <Ionicons name="business-outline" size={18} color={colors.textMuted} style={{ marginRight: spacing.sm }} />
        <Text style={terpilih ? styles.selectorText : styles.selectorPlaceholder}>
          {terpilih ? terpilih.namaUsaha : 'Pilih Unit Usaha...'}
        </Text>
        <Ionicons name="chevron-down" size={iconSize.md} color={colors.textMuted} style={{ flexShrink: 0 }} />
      </TouchableOpacity>

      {terpilih && !historisNonaktif && (
        <Text style={styles.helper}>
          {terpilih.jenisUsaha ? `${terpilih.jenisUsaha}` : 'Unit usaha aktif'}
        </Text>
      )}
      {historisNonaktif && (
        <Text style={styles.helperWarn}>
          Unit ini berstatus NONAKTIF. Ditampilkan sebagai histori; tidak dapat dipakai untuk transaksi baru.
        </Text>
      )}
      {error && <Text style={styles.errorText}>{error}</Text>}

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Pilih Unit Usaha</Text>
            <TouchableOpacity style={styles.closeIcon} onPress={() => setOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : (
            <FlatList
              data={results}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}
              renderItem={({ item }) => {
                const aktifTerpilih = value?.id === item.id;
                return (
                  <TouchableOpacity
                    style={styles.row}
                    onPress={() => {
                      onChange(item);
                      setOpen(false);
                    }}
                  >
                    <Ionicons
                      name={aktifTerpilih ? 'radio-button-on' : 'radio-button-off'}
                      size={18}
                      color={aktifTerpilih ? colors.primary : colors.textMuted}
                      style={{ marginRight: spacing.sm }}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowNama}>{item.namaUsaha}</Text>
                      {!!item.jenisUsaha && <Text style={styles.rowSub}>{item.jenisUsaha}</Text>}
                    </View>
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <Text style={styles.emptyText}>
                  Belum ada Unit Usaha aktif. Tambahkan lebih dulu di Pengaturan {'>'} Identitas Koperasi {'>'} Unit Usaha.
                </Text>
              }
            />
          )}

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

const styles = StyleSheet.create({
  field: { marginBottom: spacing.md },
  label: { fontSize: 13, color: colors.text, fontWeight: '600', marginBottom: spacing.sm },
  selector: {
    gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  selectorDisabled: { opacity: 0.5 },
  selectorError: { borderColor: colors.danger },
  selectorText: { flex: 1, fontSize: 15, color: colors.text },
  selectorPlaceholder: { flex: 1, fontSize: 15, color: colors.placeholder },
  helper: { fontSize: 12, color: colors.textMuted, marginTop: spacing.xs },
  helperWarn: { fontSize: 12, color: colors.warning ?? colors.danger, marginTop: spacing.xs },
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
  },
  modalTitle: { ...modalUi.title },
  closeIcon: { ...modalUi.closeIcon },
  loadingBox: { paddingVertical: spacing.xl, alignItems: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowNama: { fontSize: 15, color: colors.text, fontWeight: '600' },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  emptyText: { color: colors.textMuted, fontSize: 13, textAlign: 'center', paddingVertical: spacing.xl },
  footer: { padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border },
  closeButton: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: 12,
    alignItems: 'center',
  },
  closeButtonText: { color: colors.text, fontWeight: '600' },
});

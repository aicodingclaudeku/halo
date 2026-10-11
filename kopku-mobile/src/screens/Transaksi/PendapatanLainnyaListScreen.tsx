import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator, Modal, ScrollView } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  listTransaksiPendapatan,
  koreksiTransaksiPendapatan,
  TransaksiPendapatanRow,
} from '@/services/PendapatanLainnyaService';
import { LHU_KLASIFIKASI_LABEL } from '@/repositories/AccountRepository';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';

import FocusTextInput from '@/components/FocusTextInput';
import SearchField from '@/components/SearchField';
/**
 * Daftar Pendapatan / Riwayat Pendapatan (Revisi LHU KOPKU, Bagian
 * C/Y) — SATU komponen dipakai untuk kedua entri menu (Bagian C:
 * "jangan membuat tabel duplikat jika tabel transaksi pendapatan
 * sudah tersedia"). Menampilkan: tanggal, akun COA, klasifikasi LHU,
 * nominal, kas/bank, keterangan, status.
 */
export default function PendapatanLainnyaListScreen() {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const [rows, setRows] = useState<TransaksiPendapatanRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [modalTarget, setModalTarget] = useState<TransaksiPendapatanRow | null>(null);
  const [alasan, setAlasan] = useState('');
  const [processing, setProcessing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listTransaksiPendapatan());
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const submitBatalkan = async () => {
    if (!currentUser || !modalTarget || !alasan.trim()) return;
    setProcessing(true);
    try {
      await koreksiTransaksiPendapatan(modalTarget.jenis, modalTarget.id, currentUser.id, alasan.trim());
      setModalTarget(null);
      setAlasan('');
      notify('Berhasil', 'Transaksi dibatalkan (jurnal di-reversal).');
      load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setProcessing(false);
    }
  };

  const filtered = search.trim()
    ? rows.filter(
        (r) =>
          r.akunNama.toLowerCase().includes(search.toLowerCase()) ||
          (r.keterangan ?? '').toLowerCase().includes(search.toLowerCase()) ||
          r.nomorTransaksi.toLowerCase().includes(search.toLowerCase())
      )
    : rows;

  return (
    <View style={styles.container}>
      <SearchField
        wrapStyle={styles.searchRow}
        placeholder="Cari akun, keterangan, atau nomor transaksi"
        placeholderTextColor={colors.placeholder}
        value={search}
        onChangeText={setSearch}
      />

      <TouchableOpacity style={styles.addButton} onPress={() => navigation.navigate('PendapatanLainnyaForm')}>
        <Ionicons name="add-circle-outline" size={18} color={colors.white} />
        <Text style={styles.addButtonText}>Tambah Transaksi Pendapatan</Text>
      </TouchableOpacity>

      {loading && <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />}

      {!loading && filtered.length === 0 && <Text style={styles.emptyText}>Belum ada transaksi pendapatan.</Text>}

      <FlatList keyboardShouldPersistTaps="handled"
        data={filtered}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ paddingBottom: 40 }}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardAkun}>{item.akunNama}</Text>
              <Text style={[styles.cardStatus, item.status === 'DIKOREKSI' && styles.cardStatusDikoreksi]}>
                {item.status === 'DIKOREKSI' ? 'Dibatalkan' : 'Aktif'}
              </Text>
            </View>
            <Text style={styles.cardSub}>{item.tanggal} · {item.akunKode}</Text>
            <Text style={styles.cardKlasifikasi}>
              {item.klasifikasiLhu ? LHU_KLASIFIKASI_LABEL[item.klasifikasiLhu] : 'Belum diklasifikasikan'}
            </Text>
            <View style={styles.cardRow}>
              <Text style={styles.cardValue}>{formatRupiah(item.nominal)}</Text>
              <Text style={styles.cardKasBank}>{item.kasBank}</Text>
            </View>
            {!!item.keterangan && <Text style={styles.cardKeterangan}>{item.keterangan}</Text>}
            {item.status === 'AKTIF' && (
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => {
                  setModalTarget(item);
                  setAlasan('');
                }}
              >
                <Text style={styles.cancelButtonText}>Batalkan</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      />

      <Modal visible={!!modalTarget} transparent animationType="fade" onRequestClose={() => setModalTarget(null)}>
        <AreaAmanKeyboard varian="dialog" style={styles.modalBackdrop}>
          <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Batalkan Transaksi Pendapatan</Text>
              <Text style={styles.modalSub}>
                Jurnal transaksi ini akan di-reversal (bukan dihapus) — audit trail tetap tersimpan sesuai koreksi
                transaksi lainnya di aplikasi ini.
              </Text>
              <FocusTextInput
                style={styles.modalInput}
                value={alasan}
                onChangeText={setAlasan}
                placeholder="Alasan pembatalan (wajib diisi)"
                placeholderTextColor={colors.placeholder}
                multiline
              />
              <View style={styles.modalActions}>
                <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setModalTarget(null)}>
                  <Text style={styles.modalCancelText}>Tutup</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalSubmitBtn, (!alasan.trim() || processing) && styles.disabled]}
                  onPress={submitBatalkan}
                  disabled={!alasan.trim() || processing}
                >
                  {processing ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalSubmitText}>Batalkan</Text>}
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </AreaAmanKeyboard>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.lg },
  searchRow: { marginBottom: spacing.md },
  addButton: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingVertical: 12,
    marginBottom: spacing.md,
  },
  addButtonText: { color: colors.white, fontWeight: '700', fontSize: 13 },
  emptyText: { color: colors.textMuted, textAlign: 'center', marginTop: 24 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardAkun: { fontSize: 14, fontWeight: '700', color: colors.text, flex: 1 },
  cardStatus: { fontSize: 11, fontWeight: '700', color: colors.primary },
  cardStatusDikoreksi: { color: colors.textMuted, textDecorationLine: 'line-through' },
  cardSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  cardKlasifikasi: { fontSize: 11, color: colors.primary, marginTop: 4, fontWeight: '600' },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  cardValue: { fontSize: 15, fontWeight: '700', color: colors.text },
  cardKasBank: { fontSize: 12, color: colors.textMuted },
  cardKeterangan: { fontSize: 12, color: colors.textMuted, marginTop: 4, fontStyle: 'italic' },
  cancelButton: { alignSelf: 'flex-start', marginTop: 8 },
  cancelButtonText: { fontSize: 12, color: colors.danger, fontWeight: '600' },
  modalBackdrop: { ...modalUi.backdrop },
  modalScrollContent: { ...modalUi.scrollContent },
  modalCard: { ...modalUi.card },
  modalTitle: { ...modalUi.title },
  modalSub: { ...modalUi.description },
  modalInput: { ...formUi.inputStandalone, ...formUi.inputStandaloneMultiline },
  modalActions: { ...modalUi.actions, marginTop: spacing.md },
  modalCancelBtn: { ...modalUi.secondaryButton },
  modalCancelText: { ...modalUi.secondaryText },
  modalSubmitBtn: { ...modalUi.destructiveButton },
  modalSubmitText: { ...modalUi.primaryText },
  disabled: { opacity: 0.6 },
});

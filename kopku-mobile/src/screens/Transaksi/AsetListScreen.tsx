import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet, Modal, ScrollView } from 'react-native';
import AreaAmanKeyboard from '@/components/AreaAmanKeyboard';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { listAsetDenganNilaiBuku, hapusAset, AsetDenganNilaiBukuItem } from '@/services/AsetService';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { usePermission } from '@/hooks/usePermission';
import { buildDaftarAsetExport } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import FocusTextInput from '@/components/FocusTextInput';
import SearchField from '@/components/SearchField';
import { colors, radius, spacing } from '@/theme/colors';
import { modalUi } from '@/theme/modal';
import { formUi } from '@/theme/form';

type Urutan = 'TANGGAL_TERBARU' | 'NAMA' | 'NILAI_TERBESAR';

/**
 * Daftar Aset Tetap (Transaksi > Pengeluaran > Pembelian Aset).
 *
 * Permintaan pengguna §10: `AsetDetailScreen` DIHAPUS — menekan baris
 * SEKARANG langsung membuka `AsetEditFormScreen` (sudah berfungsi
 * sebagai layar lihat+edit lengkap: menampilkan semua field, mengunci
 * field yang tidak boleh diubah lagi setelah aset pernah disusutkan/
 * diamortisasi — TIDAK ADA logic tampilan/edit kedua yang dibuat
 * ulang). Delete (long-press, §11) memakai `AsetService.hapusAset()`
 * yang SAMA dengan yang dipakai `DaftarAsetTetapScreen` — reversal
 * jurnal atau soft-deactivate, alasan wajib diisi, TIDAK PERNAH
 * hard-delete.
 */
export default function AsetListScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const koperasi = useAppStore((s) => s.koperasi);
  const currentUser = useAppStore((s) => s.currentUser);
  const { can } = usePermission();
  const canEdit = can('kas_bank', 'edit');
  const [data, setData] = useState<AsetDenganNilaiBukuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [urutan, setUrutan] = useState<Urutan>('TANGGAL_TERBARU');

  const [hapusTarget, setHapusTarget] = useState<AsetDenganNilaiBukuItem | null>(null);
  const [alasanHapus, setAlasanHapus] = useState('');
  const [processing, setProcessing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await listAsetDenganNilaiBuku());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat daftar aset.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation, load]);

  const submitHapus = async () => {
    if (!hapusTarget || !currentUser || !alasanHapus.trim()) return;
    setProcessing(true);
    try {
      const { direversal } = await hapusAset({ id: hapusTarget.id, alasan: alasanHapus.trim(), actingUserId: currentUser.id });
      setHapusTarget(null);
      setAlasanHapus('');
      await load();
      notify(
        'Berhasil',
        direversal
          ? 'Koreksi salah input dicatat: jurnal pembelian dibatalkan (reversal).'
          : 'Koreksi salah input dicatat (aset tanpa jurnal perolehan).'
      );
    } catch (e) {
      // RC-S54 T16 GAP 6: aset berpenyusutan ditolak service -> arahkan ke Pelepasan (Daftar Aset Tetap).
      notify('Gagal', (e instanceof Error ? e.message : 'Terjadi kesalahan.').replace(/^[A-Z][A-Z0-9_]+:\s*/, ''));
    } finally {
      setProcessing(false);
    }
  };

  const dataTampil = data
    .filter((d) => {
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      // Bug fix: aset lama/data korup bisa punya `namaAset`/`nomorAset`
      // null/undefined — sebelumnya `.toLowerCase()` dipanggil langsung
      // di atasnya, yang melempar TypeError dan menjatuhkan layar
      // begitu pencarian dipakai. `?? ''` membuatnya aman tanpa
      // mengubah data yang tersimpan.
      return (
        (d.namaAset ?? '').toLowerCase().includes(q) ||
        (d.nomorAset ?? '').toLowerCase().includes(q) ||
        (d.kelompokAset ?? '').toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      if (urutan === 'NAMA') return (a.namaAset ?? '').localeCompare(b.namaAset ?? '');
      if (urutan === 'NILAI_TERBESAR') return (b.nilaiPerolehan ?? 0) - (a.nilaiPerolehan ?? 0);
      return (b.tanggalPerolehan ?? '').localeCompare(a.tanggalPerolehan ?? '');
    });

  return (
    <View style={styles.container}>
      <SearchField
        wrapStyle={styles.searchBox}
        value={search}
        onChangeText={setSearch}
        placeholder="Cari nama/nomor aset/kelompok..."
        placeholderTextColor={colors.placeholder}
      />

      <View style={styles.sortRow}>
        {(['TANGGAL_TERBARU', 'NAMA', 'NILAI_TERBESAR'] as Urutan[]).map((u) => (
          <TouchableOpacity key={u} style={[styles.sortChip, urutan === u && styles.sortChipActive]} onPress={() => setUrutan(u)}>
            <Text style={[styles.sortChipText, urutan === u && styles.sortChipTextActive]}>
              {u === 'TANGGAL_TERBARU' ? 'Terbaru' : u === 'NAMA' ? 'Nama A-Z' : 'Nilai Terbesar'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading && <ActivityIndicator style={styles.center} color={colors.primary} />}

      {!loading && error && (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {!loading && !error && data.length === 0 && (
        <View style={styles.center}>
          <Text style={styles.emptyText}>Belum ada aset tetap. Tekan + untuk mencatat pembelian aset baru.</Text>
        </View>
      )}

      {!loading && !error && data.length > 0 && (
        <FlatList keyboardShouldPersistTaps="handled"
          data={dataTampil}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.sm }}
          ListHeaderComponent={
            <ExportButton
              data={
                koperasi && dataTampil.length > 0
                  ? buildDaftarAsetExport({ namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi }, dataTampil)
                  : null
              }
            />
          }
          ListEmptyComponent={<Text style={styles.emptyText}>Tidak ada aset yang cocok dengan pencarian.</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.card, item.status === 'DIHAPUS' && styles.cardNonaktif]}
              onPress={() => navigation.navigate('AsetEditForm', { asetId: item.id })}
              onLongPress={() => {
                if (canEdit && item.status === 'AKTIF') {
                  setHapusTarget(item);
                  setAlasanHapus('');
                }
              }}
            >
              <View style={styles.iconCircle}>
                <Ionicons name="cube-outline" size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.nama}>{item.namaAset}</Text>
                <Text style={styles.sub}>
                  {item.nomorAset} · {item.tanggalPerolehan} · {item.metodePembayaran === 'TUNAI' ? 'Tunai' : 'Kredit'}
                </Text>
                {item.jenisAset === 'TAK_BERWUJUD' && <Text style={styles.badgeTakBerwujud}>Aset Tak Berwujud</Text>}
                {item.status === 'DIHAPUS' && <Text style={styles.statusNonaktif}>Nonaktif</Text>}
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.nominal}>{formatRupiah(item.nilaiPerolehan)}</Text>
                <Text style={styles.sumber}>{item.sumber === 'MODAL_BARANG' ? 'Modal Koperasi' : 'Pembelian'}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </TouchableOpacity>
          )}
        />
      )}

      <TouchableOpacity
        style={[styles.fab, { bottom: 24 + insets.bottom }]}
        onPress={() => navigation.navigate('PembelianAsetForm')}
      >
        <Ionicons name="add" size={28} color={colors.white} />
      </TouchableOpacity>

      <Modal visible={!!hapusTarget} transparent animationType="fade" onRequestClose={() => setHapusTarget(null)}>
        <AreaAmanKeyboard varian="dialog" style={styles.modalBackdrop}>
          <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Koreksi Salah Input Aset</Text>
            <Text style={styles.modalSub}>
              Hanya untuk pembelian yang salah input dan belum pernah disusutkan/diamortisasi: jurnal pembelian dibatalkan (reversal).
              Aset yang sudah disusutkan ditolak — gunakan Pelepasan Aset Tetap di Daftar Aset Tetap bila aset dijual/dibuang.
            </Text>
            <FocusTextInput
              style={styles.modalInput}
              value={alasanHapus}
              onChangeText={setAlasanHapus}
              placeholder="Alasan penghapusan (wajib diisi)"
              placeholderTextColor={colors.placeholder}
              multiline
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setHapusTarget(null)}>
                <Text style={styles.modalCancelText}>Tutup</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmitBtn, (!alasanHapus.trim() || processing) && styles.disabled]}
                onPress={submitHapus}
                disabled={!alasanHapus.trim() || processing}
              >
                {processing ? <ActivityIndicator color={colors.white} /> : <Text style={styles.modalSubmitText}>Hapus</Text>}
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
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyText: { color: colors.textMuted, textAlign: 'center' },
  errorText: { color: colors.danger, textAlign: 'center' },
  searchBox: { marginHorizontal: spacing.lg, marginTop: spacing.lg },
  sortRow: { flexDirection: 'row', gap: 8, marginHorizontal: spacing.lg, marginTop: spacing.sm },
  sortChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  sortChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  sortChipText: { fontSize: 11, color: colors.text },
  sortChipTextActive: { color: colors.white },
  cardNonaktif: { opacity: 0.5 },
  statusNonaktif: { fontSize: 11, fontWeight: '700', color: colors.danger, marginTop: 2 },
  badgeTakBerwujud: { fontSize: 10, fontWeight: '700', color: colors.primary, marginTop: 2 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nama: { fontSize: 14, fontWeight: '700', color: colors.text },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  nominal: { fontSize: 14, fontWeight: '700', color: colors.text },
  sumber: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
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

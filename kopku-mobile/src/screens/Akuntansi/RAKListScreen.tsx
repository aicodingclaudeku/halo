import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet, RefreshControl } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { listRAK, RAKListItem, JENIS_RAK_LABEL } from '@/services/RAKService';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { usePermission } from '@/hooks/usePermission';
import ExportButton from '@/components/ExportButton';
import { buildRAKExport } from '@/export/ReportTableBuilders';
import { colors, radius, spacing } from '@/theme/colors';

/**
 * "Daftar Rekening Antar Kantor" (Laporan > Rincian Laporan Lainnya) —
 * murni halaman LAPORAN/list (permintaan pengguna §9): TOMBOL TAMBAH
 * (FAB "+") DIHAPUS dari sini — mencatat transaksi RAK baru SEKARANG
 * HANYA lewat Transaksi > Pengeluaran > Rekening Antar Kantor (RAK),
 * yang langsung membuka RAKFormScreen (lihat TransaksiPengeluaranScreen
 * & RootNavigator). RAKFormScreen TIDAK dihapus — tetap dipakai untuk
 * mode CATAT (dari Pengeluaran) maupun mode EDIT (link "Edit" di
 * bawah, koreksi transaksi yang SUDAH ADA, bukan entry point baru).
 * Aksi Edit/Batalkan tetap ada di sini (pola sama dengan
 * DaftarInvestasiScreen/DaftarUtangScreen) — itu koreksi transaksi
 * existing, bukan pintu masuk transaksi baru, jadi tidak melanggar
 * "tidak boleh ada tombol Tambah pada halaman laporan".
 */
export default function RAKListScreen() {
  const navigation = useNavigation<any>();
  const koperasi = useAppStore((s) => s.koperasi);
  const currentUser = useAppStore((s) => s.currentUser);
  const { can } = usePermission();
  const canEdit = can('rak', 'edit');
  const canExport = can('rak', 'export');

  const [data, setData] = useState<RAKListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);


  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      setData(await listRAK());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat daftar RAKU.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const unsub = navigation.addListener('focus', () => load(false));
    return unsub;
  }, [navigation, load]);

  const totalAktif = data.filter((d) => d.status === 'AKTIF').reduce((acc, d) => acc + d.jumlah, 0);


  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        style={styles.container}
        data={data}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: spacing.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
        ListHeaderComponent={
          <>
            {data.length > 0 && (
              <View style={styles.totalCard}>
                <Text style={styles.totalLabel}>Total RAKU Aktif</Text>
                <Text style={styles.totalValue}>{formatRupiah(totalAktif)}</Text>
                <Text style={styles.totalSub}>{data.length} transaksi RAKU</Text>
              </View>
            )}
            {canExport && (
              <ExportButton
                data={koperasi && data.length > 0 ? buildRAKExport({ namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi }, data) : null}
              />
            )}
          </>
        }
        ListEmptyComponent={
          <View style={styles.center}>
            {error ? (
              <Text style={styles.errorText}>{error}</Text>
            ) : (
              <Text style={styles.emptyText}>Belum ada transaksi RAKU. Catat lewat menu Pengeluaran &gt; Rekening Antar Kantor/Unit (RAKU).</Text>
            )}
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[styles.card, item.status === 'DIBATALKAN' && styles.cardDibatalkan]}
            onLongPress={() => {
              // Update pasca-Phase 18/19 §C.4: baris histori lama
              // SETORAN_DANA tidak bisa diedit (editRAK() hanya
              // menerima PENYALURAN_DANA untuk transaksi baru) —
              // hanya bisa dibatalkan lewat aksi di bawah.
              if (canEdit && item.tarikDana.kode === 'BOLEH' && item.jenisRak === 'PENYALURAN_DANA') {
                navigation.navigate('RAKForm', { rakId: item.id });
              }
            }}
          >
            <View style={styles.cardHeader}>
              <Text style={styles.nomor}>{item.nomorRak}</Text>
              <Text style={[styles.jenisBadge, item.jenisRak === 'PENYALURAN_DANA' ? styles.badgePenyaluran : styles.badgeSetoran]}>
                {JENIS_RAK_LABEL[item.jenisRak]}
              </Text>
            </View>
            <Text style={styles.namaUnit}>{item.namaUnit}</Text>
            {/*
              RC-S64 §15/§16 — jenis alokasi RAKU ditampilkan eksplisit supaya
              Modal Tetap, Modal Tambahan, dan Operasional dapat dibedakan
              sekilas. Baris RAK lama tidak punya kolom ini (NULL) dan sengaja
              TIDAK diberi nilai tebakan — barisnya cukup tidak menampilkan apa pun.
            */}
            {item.jenisAlokasi ? (
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Jenis Alokasi</Text>
                <Text style={styles.rowValue}>{item.jenisAlokasi.replace(/_/g, ' ')}</Text>
              </View>
            ) : null}
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Tanggal</Text>
              <Text style={styles.rowValue}>{item.tanggal}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Jumlah</Text>
              <Text style={styles.rowValueBold}>{formatRupiah(item.jumlah)}</Text>
            </View>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Sumber Dana</Text>
              <Text style={styles.rowValue}>{item.sumberDana === 'BANK' ? 'Bank' : 'Kas'}</Text>
            </View>
            {item.keterangan ? (
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Keterangan</Text>
                <Text style={styles.rowValue}>{item.keterangan}</Text>
              </View>
            ) : null}
            {item.status === 'DIBATALKAN' && item.alasanTarikDana ? (
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{item.jenisPenutupan === 'KOREKSI_EDIT' ? 'Alasan Koreksi' : 'Alasan Tarik Dana'}</Text>
                <Text style={styles.rowValue}>{item.alasanTarikDana}</Text>
              </View>
            ) : null}
            {item.status === 'DIBATALKAN' && <Text style={styles.statusDibatalkan}>DIBATALKAN</Text>}

            {/* RC-S54 POST-CLOSURE #19 — aksi "Tarik Dana RAK" DIHAPUS dari
                Rincian Laporan Lainnya (UI SAJA). RAKService, jurnal, ledger,
                tabel, laporan, dan RAKU di Transaksi > Pengeluaran TIDAK
                disentuh; pembatalan/koreksi RAK tetap tersedia lewat History
                Transaksi. Layar ini kini murni rincian/daftar; Edit tetap ada
                untuk penyaluran dana yang masih boleh dikoreksi. */}
            {canEdit && item.status === 'AKTIF' && item.tarikDana.kode === 'BOLEH' && item.jenisRak === 'PENYALURAN_DANA' && (
              <View style={styles.actionRow}>
                <TouchableOpacity style={styles.actionBtn} onPress={() => navigation.navigate('RAKForm', { rakId: item.id })}>
                  <Ionicons name="create-outline" size={16} color={colors.primary} />
                  <Text style={styles.actionText}>Edit</Text>
                </TouchableOpacity>
              </View>
            )}
          </TouchableOpacity>
        )}
      />

      {/* §9: FAB Tambah DIHAPUS — pencatatan RAK baru hanya lewat
          Transaksi > Pengeluaran > RAK (lihat komentar header). */}

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { color: colors.danger, textAlign: 'center' },
  emptyText: { color: colors.textMuted, textAlign: 'center' },
  totalCard: { backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: spacing.lg, marginBottom: spacing.md, alignItems: 'center' },
  totalLabel: { fontSize: 12, color: colors.textMuted },
  totalValue: { fontSize: 22, fontWeight: '700', color: colors.primary, marginTop: 4 },
  totalSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  cardDibatalkan: { opacity: 0.55 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  nomor: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  jenisBadge: { fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden' },
  badgePenyaluran: { backgroundColor: '#E3F2FD', color: '#1565C0' },
  badgeSetoran: { backgroundColor: '#FFF3E0', color: '#E65100' },
  namaUnit: { fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 4, marginBottom: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  rowLabel: { fontSize: 12, color: colors.textMuted },
  rowValue: { fontSize: 12, color: colors.text },
  rowValueBold: { fontSize: 13, color: colors.text, fontWeight: '700' },
  statusDibatalkan: { fontSize: 11, fontWeight: '700', color: colors.danger, marginTop: 6 },
  actionRow: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  fab: {
    position: 'absolute',
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  fabIcon: { color: colors.white, fontSize: 28, fontWeight: '700', marginTop: -2 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  modalScrollContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  modalCard: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg, width: '100%' },
  modalTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  modalSub: { fontSize: 12, color: colors.textMuted, marginTop: 6, marginBottom: spacing.md, lineHeight: 17 },
  modalInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.text,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  modalCancelBtn: { paddingHorizontal: spacing.md, paddingVertical: 10, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border },
  modalCancelText: { color: colors.text, fontWeight: '600' },
  modalSubmitBtn: { paddingHorizontal: spacing.md, paddingVertical: 10, borderRadius: radius.sm, backgroundColor: colors.danger, minWidth: 90, alignItems: 'center' },
  modalSubmitText: { color: colors.white, fontWeight: '700' },
  disabled: { opacity: 0.6 },
});

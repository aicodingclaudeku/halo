import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet, Modal } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  listHistoryTransaksi,
  listJenisTransaksiTersedia,
  HistoryTransaksiRow,
} from '@/services/HistoryTransaksiService';
import AccountPicker from '@/components/AccountPicker';
import DatePicker, { formatTanggalIndonesia } from '@/components/DatePicker';
import { AccountItem } from '@/repositories/AccountRepository';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { usePermission } from '@/hooks/usePermission';
import ExportButton from '@/components/ExportButton';
import { buildHistoryTransaksiExport } from '@/export/ReportTableBuilders';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { modalUi } from '@/theme/modal';
import { useReportRefreshHeader } from '@/components/report/ReportRefreshButton';

import SearchField from '@/components/SearchField';
import { getWaktuSekarang } from '@/services/DevClockService';
const STATUS_LABEL: Record<HistoryTransaksiRow['status'], string> = {
  DRAFT: 'Draft',
  POSTED: 'Aktif',
  VOID: 'Dibatalkan',
  REVERSED: 'Dikoreksi',
};
const STATUS_COLOR: Record<HistoryTransaksiRow['status'], string> = {
  DRAFT: colors.textMuted,
  POSTED: colors.primary,
  VOID: colors.danger,
  REVERSED: colors.warning,
};

/**
 * History Transaksi (Phase 18 §8/§12, permintaan pengguna) — SATU
 * layar yang menyatukan riwayat SEMUA transaksi finansial aplikasi
 * (lihat komentar HistoryTransaksiService.ts). Didaftarkan di
 * navigasi DATA, TRANSAKSI, dan LAPORAN (di bawah SHU) — komponennya
 * SAMA PERSIS di ketiganya (pola yang sama dengan RekeningList/
 * AsetList/InputDataHub yang juga terdaftar di lebih dari satu stack
 * navigator di app ini), bukan implementasi kedua/ketiga.
 */
export default function HistoryTransaksiScreen() {
  const navigation = useNavigation<any>();
  const koperasi = useAppStore((s) => s.koperasi);
  const { can } = usePermission();
  const canExport = can('history_transaksi', 'export');

  const [data, setData] = useState<HistoryTransaksiRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [tanggalMulai, setTanggalMulai] = useState('');
  const [tanggalSelesai, setTanggalSelesai] = useState('');
  const [jenisTerpilih, setJenisTerpilih] = useState<string[]>([]);
  const [statusTerpilih, setStatusTerpilih] = useState<HistoryTransaksiRow['status'][]>([]);
  const [akunFilter, setAkunFilter] = useState<AccountItem | null>(null);

  const [filterOpen, setFilterOpen] = useState(false);
  const [jenisOptions, setJenisOptions] = useState<{ jenis: string; label: string }[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listHistoryTransaksi({
        search: search || undefined,
        tanggalMulai: tanggalMulai || undefined,
        tanggalSelesai: tanggalSelesai || undefined,
        jenis: jenisTerpilih.length > 0 ? jenisTerpilih : undefined,
        status: statusTerpilih.length > 0 ? statusTerpilih : undefined,
        accountId: akunFilter?.id,
      });
      setData(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat history transaksi.');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, tanggalMulai, tanggalSelesai, jenisTerpilih, statusTerpilih, akunFilter]);

  useEffect(() => {
    listJenisTransaksiTersedia().then(setJenisOptions);
  }, []);

  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation, load]);

  // RC-S49b §A1 — TOMBOL REFRESH MANUAL. Memakai `load` yang SAMA
  // dengan focus listener di atas & debounce pencarian di bawah:
  // seluruh filter yang sedang aktif (pencarian, tanggal, jenis,
  // status, akun) ikut apa adanya. Tidak ada kueri kedua.
  useReportRefreshHeader(load, { loading, testID: 'refresh-history-transaksi' });

  useEffect(() => {
    const timeout = setTimeout(load, 300);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const toggleJenis = (j: string) => {
    setJenisTerpilih((prev) => (prev.includes(j) ? prev.filter((x) => x !== j) : [...prev, j]));
  };
  const toggleStatus = (s: HistoryTransaksiRow['status']) => {
    setStatusTerpilih((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };
  const resetFilter = () => {
    setTanggalMulai('');
    setTanggalSelesai('');
    setJenisTerpilih([]);
    setStatusTerpilih([]);
    setAkunFilter(null);
  };
  const jumlahFilterAktif =
    (tanggalMulai ? 1 : 0) + (tanggalSelesai ? 1 : 0) + jenisTerpilih.length + statusTerpilih.length + (akunFilter ? 1 : 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={styles.searchRow}>
        <SearchField
          wrapStyle={styles.searchBox}
          value={search}
          onChangeText={setSearch}
          placeholder="Cari nomor transaksi / deskripsi..."
          placeholderTextColor={colors.placeholder}
        />
        <TouchableOpacity style={styles.filterBtn} onPress={() => setFilterOpen(true)}>
          <Ionicons name="options-outline" size={18} color={colors.primary} />
          {jumlahFilterAktif > 0 && (
            <View style={styles.filterBadge}>
              <Text style={styles.filterBadgeText}>{jumlahFilterAktif}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {loading && (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      )}
      {!loading && error && (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {!loading && !error && (
        <FlatList keyboardShouldPersistTaps="handled"
          data={data}
          keyExtractor={(item) => item.journalId}
          contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.sm }}
          ListHeaderComponent={
            data.length > 0 && canExport ? (
              <ExportButton
                data={
                  koperasi
                    ? buildHistoryTransaksiExport({ namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi }, data)
                    : null
                }
              />
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyText}>
                {jumlahFilterAktif > 0 || search
                  ? 'Tidak ada transaksi yang cocok dengan pencarian/filter.'
                  : 'Belum ada transaksi tercatat.'}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.card} onPress={() => navigation.navigate('HistoryTransaksiDetail', { journalId: item.journalId })}>
              <View style={styles.cardHeader}>
                <Text style={styles.nomor}>{item.nomorTransaksi}</Text>
                <Text style={[styles.statusBadge, { color: STATUS_COLOR[item.status] }]}>{STATUS_LABEL[item.status]}</Text>
              </View>
              <Text style={styles.jenisLabel}>{item.jenisLabel}</Text>
              <Text style={styles.deskripsi} numberOfLines={2}>
                {item.deskripsi}
              </Text>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>{formatTanggalIndonesia(item.tanggal)}</Text>
                <Text style={styles.nominal}>{formatRupiah(item.nominal)}</Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      <Modal visible={filterOpen} animationType="slide" onRequestClose={() => setFilterOpen(false)}>
        <SafeAreaView style={styles.modalContainer} edges={['top', 'bottom']}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Filter Transaksi</Text>
            <TouchableOpacity onPress={() => setFilterOpen(false)}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg }}>
            <Text style={styles.sectionLabel}>Tanggal</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: spacing.md }}>
              <View style={{ flex: 1 }}>
                <DatePicker value={tanggalMulai} onChange={setTanggalMulai} maximumDate={getWaktuSekarang()} />
              </View>
              <View style={{ flex: 1 }}>
                <DatePicker value={tanggalSelesai} onChange={setTanggalSelesai} maximumDate={getWaktuSekarang()} />
              </View>
            </View>

            <Text style={styles.sectionLabel}>Jenis Transaksi</Text>
            <View style={styles.chipWrap}>
              {jenisOptions.map((o) => (
                <TouchableOpacity
                  key={o.jenis}
                  style={[styles.chip, jenisTerpilih.includes(o.jenis) && styles.chipActive]}
                  onPress={() => toggleJenis(o.jenis)}
                >
                  <Text style={[styles.chipText, jenisTerpilih.includes(o.jenis) && styles.chipTextActive]}>{o.label}</Text>
                </TouchableOpacity>
              ))}
              {jenisOptions.length === 0 && <Text style={styles.emptyText}>Belum ada transaksi.</Text>}
            </View>

            <Text style={styles.sectionLabel}>Status</Text>
            <View style={styles.chipWrap}>
              {(['POSTED', 'REVERSED', 'VOID', 'DRAFT'] as HistoryTransaksiRow['status'][]).map((s) => (
                <TouchableOpacity key={s} style={[styles.chip, statusTerpilih.includes(s) && styles.chipActive]} onPress={() => toggleStatus(s)}>
                  <Text style={[styles.chipText, statusTerpilih.includes(s) && styles.chipTextActive]}>{STATUS_LABEL[s]}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.sectionLabel}>Akun (opsional)</Text>
            <AccountPicker value={akunFilter} onChange={setAkunFilter} />
            {akunFilter && (
              <TouchableOpacity onPress={() => setAkunFilter(null)}>
                <Text style={styles.clearAkunText}>Hapus filter akun</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
          <View style={styles.modalFooter}>
            <TouchableOpacity style={styles.resetBtn} onPress={resetFilter}>
              <Text style={styles.resetBtnText}>Reset</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.applyBtn}
              onPress={() => {
                setFilterOpen(false);
                load();
              }}
            >
              <Text style={styles.applyBtnText}>Terapkan</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { color: colors.danger, textAlign: 'center' },
  emptyText: { color: colors.textMuted, textAlign: 'center' },
  searchRow: { flexDirection: 'row', gap: 8, padding: spacing.lg, paddingBottom: spacing.sm },
  searchBox: { flex: 1 },
  filterBtn: {
    width: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: colors.primary,
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  filterBadgeText: { color: colors.white, fontSize: 10, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  nomor: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  statusBadge: { fontSize: 11, fontWeight: '700' },
  jenisLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: 4 },
  deskripsi: { fontSize: 12, color: colors.text, marginTop: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, gap: spacing.sm, alignItems: 'flex-start' },
  rowLabel: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  nominal: { fontSize: 13, fontWeight: '700', color: colors.text, textAlign: 'right', fontVariant: ['tabular-nums'], flexShrink: 1 },
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
  sectionLabel: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: spacing.md, marginBottom: spacing.sm },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, color: colors.text },
  chipTextActive: { color: colors.white },
  clearAkunText: { color: colors.danger, fontSize: 12, marginTop: 4 },
  modalFooter: { flexDirection: 'row', gap: spacing.sm, padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  resetBtn: { flex: 1, paddingVertical: 12, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, alignItems: 'center' },
  resetBtnText: { color: colors.text, fontWeight: '700' },
  applyBtn: { flex: 2, paddingVertical: 12, borderRadius: radius.sm, backgroundColor: colors.primary, alignItems: 'center' },
  applyBtnText: { color: colors.white, fontWeight: '700' },
});

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { getRiwayatSHU, hapusKonfigurasiShu, ShuKonfigurasiRow } from '@/services/ShuService';
import { formatRupiah } from '@/utils/money';
import { notify } from '@/store/useNotifyStore';
import { useAppStore } from '@/store/useAppStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing } from '@/theme/colors';
import { useReportRefreshHeader } from '@/components/report/ReportRefreshButton';
import {
  URUTAN_STATUS_SHU,
  JUMLAH_TAHAP_SHU,
  tahapShu,
  tahapSudahDilewati,
  bolehDiubah,
  JUDUL_MODUL_SHU,
  type StatusShu,
} from '@/reports/StatusShuPlan';

/**
 * RC-S109 — WARNA LENCANA per tahap. Label & urutannya TIDAK ditulis
 * ulang di sini: keduanya dari `StatusShuPlan` (modul murni), supaya
 * layar, judul, dan penanda langkah mustahil berselisih istilah.
 */
const STATUS_STYLE: Record<StatusShu, { bg: string; fg: string }> = {
  DRAFT: { bg: '#F0F0F0', fg: colors.textMuted },
  DIHITUNG: { bg: '#FFF3E0', fg: colors.warning },
  DIAJUKAN_RAT: { bg: '#E3F2FD', fg: '#1565C0' },
  DISAHKAN_RAT: { bg: '#E8F5E9', fg: '#2E7D32' },
  DIBAGIKAN: { bg: colors.primaryLight, fg: colors.primary },
};

/**
 * Riwayat SHU seluruh tahun buku (PRD §29) — halaman awal modul SHU.
 * Phase 18 §6: tahun DIHITUNG punya tombol Edit eksplisit (pensil) di
 * samping status, selain tetap bisa dibuka lewat kartu untuk lihat
 * detail (ShuDetailScreen, yang juga punya tombol Edit — lihat file
 * itu). Tahun DRAFT tetap membuka ShuFormScreen langsung saat kartu
 * ditekan (belum ada apa-apa untuk dilihat). Tahun DIBAGIKAN final,
 * tidak ada tombol edit di mana pun.
 */
export default function ShuScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const [data, setData] = useState<ShuKonfigurasiRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingTahun, setDeletingTahun] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await getRiwayatSHU();
      setData(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat riwayat SHU.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation, load]);

  // RC-S49b §A1 — TOMBOL REFRESH MANUAL, memakai `load` yang SAMA
  // dengan focus listener di atas dan dengan pemuatan ulang setelah
  // hapus konfigurasi. Tidak ada perhitungan SHU yang dijalankan dari
  // sini: `getRiwayatSHU()` hanya MEMBACA konfigurasi & hasil yang
  // sudah tersimpan.
  useReportRefreshHeader(load, { loading, testID: 'refresh-shu' });

  /**
   * Hapus konfigurasi SHU (Phase 17 §F). Tombol hanya dirender untuk
   * status DRAFT/DIHITUNG (lihat renderItem) — status DIBAGIKAN sudah
   * final (ada jurnal + posted simpanan_transaksi) dan service layer
   * (`hapusKonfigurasiShu`) menolaknya juga kalau ada jalan lain yang
   * lolos dari UI ini.
   */
  const konfirmasiHapus = (item: ShuKonfigurasiRow) => {
    notify(
      'Hapus Konfigurasi SHU',
      `Hapus konfigurasi & hasil perhitungan SHU tahun buku ${item.tahunBuku}? Tindakan ini tidak bisa dibatalkan.`,
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Hapus', style: 'destructive', onPress: () => doHapus(item.tahunBuku) },
      ]
    );
  };

  const doHapus = async (tahunBuku: number) => {
    if (!currentUser) return;
    setDeletingTahun(tahunBuku);
    try {
      await hapusKonfigurasiShu(currentUser.id, tahunBuku);
      await load();
      notify('Berhasil', `Konfigurasi SHU tahun buku ${tahunBuku} telah dihapus.`);
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setDeletingTahun(null);
    }
  };

  return (
    <View style={styles.container}>
      {loading && <ActivityIndicator style={styles.center} />}

      {!loading && error && (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* RC-S109 — KOP MODUL. Menu ini dibuka setahun sekali; tanpa
          keterangan, pengurus harus mengingat sendiri bahwa pembagian
          SHU punya lima tahap dan bahwa RAT adalah gerbangnya. */}
      {!loading && !error && (
        <View style={styles.kop}>
          <Text style={styles.kopJudul}>{JUDUL_MODUL_SHU}</Text>
          <Text style={styles.kopSub}>
            Lima tahap: hitung &rarr; ajukan ke RAT &rarr; catat pengesahan &rarr; bagikan. SHU baru dapat dibagikan
            setelah Rapat Anggota Tahunan dilaksanakan.
          </Text>
        </View>
      )}

      {!loading && !error && data.length === 0 && (
        <View style={styles.center}>
          <Ionicons name="gift-outline" size={40} color={colors.textMuted} />
          <Text style={styles.emptyJudul}>Belum ada perhitungan</Text>
          <Text style={styles.emptyText}>
            Tekan tombol + untuk memulai perhitungan pembagian Sisa Hasil Usaha satu tahun buku.
          </Text>
        </View>
      )}

      {!loading && !error && data.length > 0 && (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item }) => {
            const tahap = tahapShu(item.status as StatusShu);
            const gaya = STATUS_STYLE[item.status as StatusShu];
            return (
              <TouchableOpacity
                style={styles.card}
                activeOpacity={0.8}
                onPress={() =>
                  item.status === 'DRAFT'
                    ? navigation.navigate('ShuForm', { tahunBuku: item.tahunBuku })
                    : navigation.navigate('ShuDetail', { tahunBuku: item.tahunBuku })
                }
              >
                {/* Baris 1 — tahun buku & lencana tahap */}
                <View style={styles.cardHeader}>
                  <Text style={styles.tahun}>Tahun Buku {item.tahunBuku}</Text>
                  <Text style={[styles.statusBadge, { backgroundColor: gaya.bg, color: gaya.fg }]}>
                    {tahap.label}
                  </Text>
                </View>

                {/* Baris 2 — nominal, dengan keterangan yang menerangkan
                    angkanya. Sebelumnya nominal tampil sebagai teks abu
                    kecil tanpa label, sehingga tidak jelas itu SHU apa. */}
                <Text style={styles.nominalLabel}>Sisa Hasil Usaha tahun buku ini</Text>
                <Text style={styles.nominal}>
                  {item.totalShu !== null ? formatRupiah(item.totalShu) : 'Belum dihitung'}
                </Text>

                {/* Baris 3 — penanda langkah. Pengurus yang membuka menu
                    ini setahun sekali perlu tahu ada di tahap keberapa
                    dan apa lanjutannya, bukan cuma nama statusnya. */}
                <View style={styles.langkahRow}>
                  {URUTAN_STATUS_SHU.map((st) => (
                    <View
                      key={st}
                      style={[
                        styles.langkahBatang,
                        tahapSudahDilewati(st, item.status as StatusShu) && { backgroundColor: gaya.fg },
                      ]}
                    />
                  ))}
                </View>
                <Text style={styles.langkahTeks}>
                  Tahap {tahap.nomor} dari {JUMLAH_TAHAP_SHU} · {tahap.tindakan}
                </Text>

                {/* Baris 4 — tindakan, kini BERLABEL. Dulu hanya dua ikon
                    tanpa teks, dan ikon pensil di samping lencana mudah
                    tertukar dengan bagian status. */}
                {bolehDiubah(item.status as StatusShu) && (
                  <View style={styles.aksiRow}>
                    <TouchableOpacity
                      style={styles.aksiBtn}
                      onPress={(e) => {
                        e.stopPropagation?.();
                        navigation.navigate('ShuForm', { tahunBuku: item.tahunBuku });
                      }}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Ionicons name="create-outline" size={16} color={colors.primary} />
                      <Text style={styles.aksiTeks}>Ubah</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.aksiBtn}
                      onPress={(e) => {
                        e.stopPropagation?.();
                        konfirmasiHapus(item);
                      }}
                      disabled={deletingTahun === item.tahunBuku}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      {deletingTahun === item.tahunBuku ? (
                        <ActivityIndicator size="small" color={colors.danger} />
                      ) : (
                        <>
                          <Ionicons name="trash-outline" size={16} color={colors.danger} />
                          <Text style={[styles.aksiTeks, { color: colors.danger }]}>Hapus</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
        />
      )}

      <TouchableOpacity style={[styles.fab, { bottom: 24 + insets.bottom }]} onPress={() => navigation.navigate('ShuForm', {})}>
        <Text style={styles.fabIcon}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  errorText: { color: colors.danger, textAlign: 'center' },
  emptyJudul: { fontSize: 14, fontWeight: '700', color: colors.text, marginTop: spacing.md },
  emptyText: { color: colors.textMuted, textAlign: 'center', marginTop: spacing.xs, lineHeight: 18 },

  kop: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  kopJudul: { fontSize: 15, fontWeight: '800', color: colors.primary },
  kopSub: { fontSize: 11.5, color: colors.textMuted, lineHeight: 17, marginTop: 4 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  tahun: { fontSize: 15, fontWeight: '800', color: colors.text, flexShrink: 1 },
  nominalLabel: { fontSize: 11, color: colors.textMuted, marginTop: spacing.md },
  nominal: { fontSize: 20, fontWeight: '800', color: colors.primary, marginTop: 2, fontVariant: ['tabular-nums'] },

  langkahRow: { flexDirection: 'row', gap: 4, marginTop: spacing.md },
  langkahBatang: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.border },
  langkahTeks: { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginTop: spacing.xs },

  aksiRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  aksiBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2 },
  aksiTeks: { fontSize: 12, fontWeight: '700', color: colors.primary },
  statusBadge: {
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
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
  fabIcon: { color: colors.white, fontSize: 28, lineHeight: 30 },
});

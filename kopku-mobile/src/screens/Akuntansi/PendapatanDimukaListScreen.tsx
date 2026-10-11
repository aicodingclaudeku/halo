import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, ActivityIndicator, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { listPendapatanDimuka, PendapatanDimukaListItem } from '@/services/PendapatanDimukaService';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';

const STATUS_LABEL: Record<PendapatanDimukaListItem['status'], string> = {
  AKTIF: 'Aktif',
  SELESAI: 'Selesai',
};
const STATUS_COLOR: Record<PendapatanDimukaListItem['status'], string> = {
  AKTIF: colors.warning,
  SELESAI: colors.primary,
};

/**
 * Daftar Pendapatan Dimuka — register (READ-ONLY) transaksi pendapatan
 * diterima dimuka pada tabel `pendapatan_diterima_dimuka`.
 *
 * RC-S121 — form input manualnya (rute `PendapatanDimukaForm`) sudah
 * dilepas dari UI karena pendapatan diterima dimuka dibentuk otomatis
 * oleh sistem. Layar ini DIPERTAHANKAN untuk monitoring data register
 * yang sudah ada; tidak ada tombol tambah/ubah di sini. Hanya teks
 * keadaan kosong yang diperbarui supaya tidak lagi menunjuk menu yang
 * sudah tidak ada. Query & service TIDAK diubah.
 */
export default function PendapatanDimukaListScreen() {
  const navigation = useNavigation<any>();
  const [data, setData] = useState<PendapatanDimukaListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await listPendapatanDimuka());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat daftar pendapatan dimuka.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation, load]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (data.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>
          Belum ada register pendapatan diterima dimuka. Pendapatan diterima dimuka atas pinjaman anggota dibentuk otomatis oleh sistem dan saldonya dapat dilihat di Buku Besar akun Pendapatan Diterima Dimuka.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={data}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ padding: spacing.lg }}
      renderItem={({ item }) => (
        <View style={styles.card}>
          <View style={styles.headerRow}>
            <Ionicons name="time-outline" size={18} color={colors.primary} style={{ marginRight: spacing.sm }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.nama}>{item.namaAnggota}</Text>
              <Text style={styles.sub}>
                {item.nomorTransaksi} · {item.tanggal} · {item.jangkaWaktuBulan} bulan
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.nominal}>{formatRupiah(item.jumlah)}</Text>
              <Text style={[styles.statusBadge, { color: STATUS_COLOR[item.status] }]}>{STATUS_LABEL[item.status]}</Text>
            </View>
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  errorText: { color: colors.danger, textAlign: 'center' },
  emptyText: { color: colors.textMuted, textAlign: 'center' },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  nama: { fontSize: 14, fontWeight: '700', color: colors.text },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  nominal: { fontSize: 14, fontWeight: '700', color: colors.text },
  statusBadge: { fontSize: 11, fontWeight: '700', marginTop: 2 },
});

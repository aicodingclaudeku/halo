import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, ActivityIndicator, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { listJurnalPenyusutan, AsetPenyusutanRow } from '@/services/PenyusutanService';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';

/** Jurnal Penyusutan — riwayat jurnal penyusutan yang sudah tercatat (bukan form input, murni riwayat). */
export default function JurnalPenyusutanScreen() {
  const navigation = useNavigation<any>();
  const [data, setData] = useState<AsetPenyusutanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await listJurnalPenyusutan());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat jurnal penyusutan.');
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
        <Text style={styles.emptyText}>Belum ada jurnal penyusutan. Proses lewat menu Status Periode.</Text>
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
        <View style={styles.row}>
          <View style={styles.iconCircle}>
            <Ionicons name="trending-down-outline" size={18} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.nama}>{item.namaAset}</Text>
            <Text style={styles.sub}>
              Periode {item.periode} · {item.tanggal} · {item.nomorJurnal ?? '-'}
            </Text>
          </View>
          <Text style={styles.nominal}>{formatRupiah(item.nilaiPenyusutan)}</Text>
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nama: { fontSize: 14, fontWeight: '700', color: colors.text },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  nominal: { fontSize: 14, fontWeight: '700', color: colors.primary },
});

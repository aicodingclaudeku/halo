import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { listRingkasanPenyusutanAset, RingkasanAsetPenyusutan } from '@/services/PenyusutanService';
import { formatRupiah } from '@/utils/money';
import { colors, spacing } from '@/theme/colors';
import RingkasanPenyusutanAsetList from './RingkasanPenyusutanAsetList';

/**
 * Daftar Penyusutan — ringkasan tiap aset tetap: nilai perolehan,
 * akumulasi penyusutan, dan nilai buku saat ini.
 *
 * RC-S50 §10/§10B — layar ini TIDAK LAGI PUNYA ENTRY MENU dan
 * registrasi rutenya sudah dilepas dari LaporanStack: isinya kini
 * tampil sebagai seksi "Daftar Aset" di dalam menu `Penyusutan Aset`
 * (StatusPeriodeScreen). Berkasnya SENGAJA DIPERTAHANKAN — pola yang
 * sama sudah dipakai `AsetListScreen` di project ini — dan sekarang
 * merender komponen bersama `RingkasanPenyusutanAsetList` yang sama,
 * sehingga tidak ada tampilan kedua yang bisa menyimpang bila suatu
 * saat rutenya dibutuhkan kembali.
 */
export default function PenyusutanListScreen() {
  const navigation = useNavigation<any>();
  const [data, setData] = useState<RingkasanAsetPenyusutan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await listRingkasanPenyusutanAset());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat daftar penyusutan.');
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
        <Text style={styles.emptyText}>Belum ada aset tetap. Tambahkan lewat Transaksi &gt; Pengeluaran &gt; Pembelian Aset.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
      <RingkasanPenyusutanAsetList data={data} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  errorText: { color: colors.danger, textAlign: 'center' },
  emptyText: { color: colors.textMuted, textAlign: 'center' },
});

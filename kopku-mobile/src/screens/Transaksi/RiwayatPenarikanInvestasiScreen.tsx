import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import EmptyState from '@/components/report/EmptyState';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { listRiwayatPenarikanInvestasi, type RiwayatPenarikanInvestasiRow } from '@/services/PenarikanInvestasiQuery';
import { colors, radius, spacing } from '@/theme/colors';
import { formatRupiah } from '@/utils/money';
import { tanggalRingkas } from '@/utils/tarikSimpananUi';
import { judulJenisPenarikan } from '@/utils/penarikanInvestasiUi';

/** Riwayat penarikan dana investasi — baca-saja (jurnal ber-sumber PELEPASAN_INVESTASI). */
export default function RiwayatPenarikanInvestasiScreen() {
  const navigation = useNavigation<any>();
  const [data, setData] = useState<RiwayatPenarikanInvestasiRow[]>([]);
  const [memuat, setMemuat] = useState(true);
  const [galat, setGalat] = useState<string | null>(null);

  const muat = useCallback(async () => {
    setMemuat(true);
    setGalat(null);
    try {
      setData(await listRiwayatPenarikanInvestasi());
    } catch {
      setGalat('Riwayat gagal dimuat.');
    } finally {
      setMemuat(false);
    }
  }, []);
  useFocusRefresh(() => {
    void muat();
  }, [muat]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.isi}>
      {memuat ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : galat ? (
        <TouchableOpacity onPress={() => void muat()}>
          <Text style={styles.errorText}>{galat} Ketuk untuk memuat ulang.</Text>
        </TouchableOpacity>
      ) : data.length === 0 ? (
        <EmptyState icon="time-outline" title="Belum ada penarikan" message="Penarikan dana investasi yang sudah diposting akan tampil di sini." />
      ) : (
        data.map((r) => (
          <TouchableOpacity
            key={r.journalId}
            style={styles.card}
            accessibilityRole="button"
            onPress={() => navigation.navigate('DetailPenarikanInvestasi', { journalId: r.journalId })}
          >
            <View style={styles.atas}>
              <Text style={styles.jenis}>{judulJenisPenarikan(r.jenisInvestasi)}</Text>
              <Text style={styles.tanggal}>{tanggalRingkas(r.tanggal.slice(0, 10))}</Text>
            </View>
            <Text style={styles.nama} numberOfLines={1}>
              {r.namaTujuan}
            </Text>
            <View style={styles.bawah}>
              <Text style={styles.nomor}>
                {r.nomorInvestasi} · {r.nomorJurnal}
              </Text>
              <Text style={styles.nominal}>{r.totalDiterima === null ? '-' : formatRupiah(r.totalDiterima)}</Text>
            </View>
            <View style={styles.tagRow}>
              <View style={[styles.tag, r.jenisPenarikan === 'SEBAGIAN' ? styles.tagWarn : styles.tagOk]}>
                <Text style={[styles.tagText, r.jenisPenarikan === 'SEBAGIAN' ? styles.tagTextWarn : styles.tagTextOk]}>
                  {r.jenisPenarikan === 'SEBAGIAN' ? 'Tarik sebagian' : 'Tarik seluruhnya'}
                </Text>
              </View>
              {r.bungaDiterima > 0 ? <Text style={styles.bunga}>termasuk bunga {formatRupiah(r.bungaDiterima)}</Text> : null}
            </View>
            {r.statusJurnal !== 'POSTED' ? <Text style={styles.status}>Jurnal {r.statusJurnal.toLowerCase()}</Text> : null}
            <Ionicons name="chevron-forward" size={16} color={colors.textFaint} style={styles.chevron} />
          </TouchableOpacity>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  isi: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  errorText: { color: colors.danger, textAlign: 'center', marginTop: spacing.lg },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    paddingRight: spacing.xl + spacing.sm,
    marginBottom: spacing.sm,
  },
  atas: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  jenis: { fontSize: 11, fontWeight: '700', color: colors.primary, textTransform: 'uppercase', letterSpacing: 0.3, flex: 1 },
  tanggal: { fontSize: 11.5, color: colors.textMuted },
  nama: { fontSize: 14, fontWeight: '700', color: colors.text, marginTop: 4 },
  bawah: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: spacing.sm, marginTop: 4 },
  nomor: { fontSize: 11.5, color: colors.textMuted, flex: 1 },
  nominal: { fontSize: 15, fontWeight: '700', color: colors.text },
  status: { fontSize: 11, color: colors.warning, marginTop: 2 },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 6 },
  tag: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  tagOk: { backgroundColor: colors.primaryLight },
  tagWarn: { backgroundColor: colors.warningBg },
  tagText: { fontSize: 10.5, fontWeight: '700' },
  tagTextOk: { color: colors.success },
  tagTextWarn: { color: colors.warning },
  bunga: { fontSize: 11, color: colors.textMuted },
  chevron: { position: 'absolute', right: spacing.md, top: '50%', marginTop: -8 },
});

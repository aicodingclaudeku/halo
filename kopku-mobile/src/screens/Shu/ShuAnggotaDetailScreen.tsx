import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { getShuKonfigurasiByTahun, getShuAnggotaDetail, ShuAnggotaRow } from '@/services/ShuService';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';

/** Detail perhitungan SHU satu anggota: basis, proporsi, hasil (PRD §29). */
export default function ShuAnggotaDetailScreen() {
  const route = useRoute<any>();
  // Bug fix: `route.params` bisa undefined kalau layar dibuka tanpa
  // parameter — destructuring langsung sebelumnya crash.
  const { tahunBuku, anggotaId } = route.params ?? {};

  const [detail, setDetail] = useState<ShuAnggotaRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tahunBuku || !anggotaId) {
      setError('Data SHU anggota tidak ditemukan (parameter tidak valid).');
      setLoading(false);
      return;
    }
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const konfigurasi = await getShuKonfigurasiByTahun(tahunBuku);
        if (!konfigurasi) {
          setError(`Konfigurasi SHU untuk tahun buku ${tahunBuku} tidak ditemukan.`);
          return;
        }
        const d = await getShuAnggotaDetail(konfigurasi.id, anggotaId);
        if (!d) {
          setError('Data SHU anggota ini tidak ditemukan.');
          return;
        }
        setDetail(d);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Gagal memuat detail SHU anggota.');
      } finally {
        setLoading(false);
      }
    })();
  }, [tahunBuku, anggotaId]);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  if (loading || !detail) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.nama}>{detail.namaAnggota}</Text>
      <Text style={styles.sub}>{detail.nomorAnggota} · Tahun Buku {tahunBuku}</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Jasa Modal</Text>
        <Row label="Basis (saldo simpanan)" value={formatRupiah(detail.basisSimpanan)} />
        <Row label="Hasil Jasa Modal" value={formatRupiah(detail.jasaModal)} bold />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Jasa Usaha</Text>
        <Row label="Basis (jasa pinjaman dibayar)" value={formatRupiah(detail.basisPartisipasiUsaha)} />
        <Row label="Hasil Jasa Usaha" value={formatRupiah(detail.jasaUsaha)} bold />
      </View>

      <View style={styles.totalCard}>
        <Text style={styles.totalLabel}>Total SHU Anggota</Text>
        <Text style={styles.totalValue}>{formatRupiah(detail.totalShuAnggota)}</Text>
      </View>

      <Text style={styles.hint}>
        Jasa Modal dihitung proporsional terhadap total saldo simpanan (pokok+wajib+sukarela)
        seluruh anggota aktif. Jasa Usaha dihitung proporsional terhadap total jasa pinjaman yang
        dibayarkan seluruh anggota selama tahun buku ini.
      </Text>
    </ScrollView>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, bold && styles.bold]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: colors.danger, textAlign: 'center', padding: spacing.xl },
  nama: { fontSize: 20, fontWeight: '700', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2, marginBottom: spacing.lg },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  cardTitle: { fontSize: 14, fontWeight: '700', marginBottom: spacing.sm, color: colors.primary },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  rowLabel: { color: colors.textMuted, flex: 1 },
  rowValue: { color: colors.text },
  bold: { fontWeight: '700' },
  totalCard: {
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  totalLabel: { fontSize: 12, color: colors.textMuted },
  totalValue: { fontSize: 22, fontWeight: '700', color: colors.primary, marginTop: 4 },
  hint: { fontSize: 12, color: colors.textMuted, lineHeight: 18 },
});

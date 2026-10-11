import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, ActivityIndicator, StyleSheet } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { getPendapatanAkunDetail, PendapatanAkunDetail } from '@/services/PendapatanLainnyaService';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';

/**
 * Detail akun nominal Pendapatan (Bagian 10, dibuka dari
 * DaftarPendapatanScreen). Menampilkan Kode Akun, Saldo Periode, dan
 * daftar transaksi (Tanggal/Keterangan/Debit/Kredit/Saldo) — SELURUHNYA
 * dari `PendapatanLainnyaService.getPendapatanAkunDetail()`, yang
 * murni REUSE `Ledger.getLedger()` existing. TIDAK ada tabel/query
 * transaksi baru di layar ini sama sekali.
 */
export default function PendapatanAkunDetailScreen() {
  const route = useRoute<any>();
  const { accountId, tanggalMulai, tanggalSelesai, periodeLabel } = route.params ?? {};

  const [detail, setDetail] = useState<PendapatanAkunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        setDetail(await getPendapatanAkunDetail(accountId, tanggalMulai, tanggalSelesai));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Gagal memuat detail akun.');
      } finally {
        setLoading(false);
      }
    })();
  }, [accountId, tanggalMulai, tanggalSelesai]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (error || !detail) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error ?? 'Akun tidak ditemukan.'}</Text>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={{ padding: spacing.lg }}
      data={detail.transaksi}
      keyExtractor={(item, idx) => `${item.nomorJurnal}-${idx}`}
      ListHeaderComponent={
        <>
          <Text style={styles.nama}>{detail.nama}</Text>
          <View style={styles.headerCard}>
            <View style={styles.headerRow}>
              <Text style={styles.headerLabel}>Kode Akun</Text>
              <Text style={styles.headerValue}>{detail.kode}</Text>
            </View>
            <View style={styles.headerRow}>
              <Text style={styles.headerLabel}>Saldo Periode</Text>
              <Text style={[styles.headerValueSaldo, detail.saldoPeriode < 0 && styles.negative]}>
                {formatRupiah(detail.saldoPeriode)}
              </Text>
            </View>
            {periodeLabel ? <Text style={styles.headerPeriode}>Untuk Periode: {periodeLabel}</Text> : null}
          </View>

          <Text style={styles.sectionTitle}>Daftar Transaksi</Text>
          {detail.transaksi.length === 0 && (
            <Text style={styles.emptyText}>Belum ada transaksi untuk akun ini pada periode yang dipilih.</Text>
          )}
        </>
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.rowHeader}>
            <Text style={styles.rowTanggal}>{item.tanggal}</Text>
            <Text style={styles.rowNomor}>{item.nomorJurnal}</Text>
          </View>
          <Text style={styles.rowKeterangan}>{item.keterangan}</Text>
          <View style={styles.rowAmounts}>
            <View style={styles.amountCol}>
              <Text style={styles.amountLabel}>Debit</Text>
              <Text style={styles.amountValue}>{item.debit > 0 ? formatRupiah(item.debit) : '-'}</Text>
            </View>
            <View style={styles.amountCol}>
              <Text style={styles.amountLabel}>Kredit</Text>
              <Text style={styles.amountValue}>{item.kredit > 0 ? formatRupiah(item.kredit) : '-'}</Text>
            </View>
            <View style={styles.amountCol}>
              <Text style={styles.amountLabel}>Saldo</Text>
              <Text style={[styles.amountValueSaldo, item.saldoBerjalan < 0 && styles.negative]}>
                {formatRupiah(item.saldoBerjalan)}
              </Text>
            </View>
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { color: colors.danger, textAlign: 'center' },
  nama: { fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  headerCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  headerLabel: { fontSize: 12, color: colors.textMuted },
  headerValue: { fontSize: 13, fontWeight: '600', color: colors.text },
  headerValueSaldo: { fontSize: 15, fontWeight: '700', color: colors.primary },
  headerPeriode: { fontSize: 11, color: colors.textMuted, marginTop: spacing.xs },
  negative: { color: colors.danger },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: colors.primary, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: spacing.sm },
  emptyText: { color: colors.textMuted, fontSize: 12, fontStyle: 'italic' },
  row: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  rowTanggal: { fontSize: 12, fontWeight: '600', color: colors.text },
  rowNomor: { fontSize: 11, color: colors.textMuted },
  rowKeterangan: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing.sm },
  rowAmounts: { flexDirection: 'row', justifyContent: 'space-between' },
  amountCol: { flex: 1 },
  amountLabel: { fontSize: 10, color: colors.textFaint, textTransform: 'uppercase' },
  amountValue: { fontSize: 12, color: colors.text, marginTop: 1 },
  amountValueSaldo: { fontSize: 12, fontWeight: '700', color: colors.text, marginTop: 1 },
});

import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  getPendapatanByClassification,
  PendapatanByClassificationResult,
  AkunPendapatanNominalRow,
} from '@/services/PendapatanLainnyaService';
import ReportPeriodPicker, { ResolvedReportPeriod } from '@/components/ReportPeriodPicker';
import ReportRow from '@/components/report/ReportRow';
import SectionHeader from '@/components/report/SectionHeader';
import SummaryCard from '@/components/report/SummaryCard';
import EmptyState from '@/components/report/EmptyState';
import SearchField from '@/components/SearchField';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';

/**
 * Revisi "Daftar Pendapatan" (audit menu Daftar Pendapatan) — TAMPILAN
 * UTAMA sekarang akun NOMINAL + saldo per kelompok LHU, BUKAN lagi
 * daftar transaksi individual (Bagian 1/21). Daftar transaksi
 * individual TIDAK dihapus — dipindah ke "Riwayat Pendapatan" (route
 * `PendapatanLainnyaList`, tidak diubah sama sekali, lihat
 * PendapatanLainnyaMenuScreen.tsx).
 *
 * REUSE PENUH komponen laporan existing (Bagian 17: "gunakan komponen
 * dan theme existing, jangan redesign") — `ReportPeriodPicker`/
 * `ReportRow`/`SectionHeader`/`SummaryCard`/`EmptyState`, PERSIS
 * komponen yang sama dipakai `LabaRugiScreen` (LHU). Data dari
 * `PendapatanLainnyaService.getPendapatanByClassification()`, yang
 * sendiri REUSE `Ledger.getLedger()` (Bagian 6/16 — satu sumber
 * kebenaran ledger, angka rekonsiliasi dengan Buku Besar/Laba Rugi).
 *
 * Setiap baris akun BISA DITEKAN -> buka detail transaksi akun itu
 * (Bagian 10, route `PendapatanAkunDetail`, lihat
 * PendapatanAkunDetailScreen.tsx).
 */
export default function DaftarPendapatanScreen() {
  const navigation = useNavigation<any>();
  const [periode, setPeriode] = useState<ResolvedReportPeriod | null>(null);
  const [data, setData] = useState<PendapatanByClassificationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async (mulai: string, selesai: string) => {
    if (!mulai || !selesai) return;
    setLoading(true);
    setError(null);
    try {
      setData(await getPendapatanByClassification(mulai, selesai));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat Daftar Pendapatan.');
    } finally {
      setLoading(false);
    }
  }, []);

  const onChangePeriode = (p: ResolvedReportPeriod) => {
    setPeriode(p);
    load(p.mulai, p.selesai);
  };

  // Bagian 11: search akun (nama/kode) TANPA merusak pengelompokan —
  // filter per kelompok, kelompok yang hasilnya kosong disembunyikan.
  // Total kelompok/Total Pendapatan SENGAJA TETAP menampilkan angka
  // periode PENUH (bukan hasil filter) — search hanya untuk MENCARI
  // baris, bukan mengubah angka laporan.
  const q = search.trim().toLowerCase();
  const cocok = (r: AkunPendapatanNominalRow) => !q || r.nama.toLowerCase().includes(q) || r.kode.toLowerCase().includes(q);

  const filteredUsahaLain = data ? data.pendapatanUsahaLain.filter(cocok) : [];
  const filteredHasilInvestasi = data ? data.hasilInvestasi.filter(cocok) : [];
  const filteredPendapatanLain = data ? data.pendapatanLain.filter(cocok) : [];
  const filteredBelumDiklasifikasikan = data ? data.belumDiklasifikasikan.filter(cocok) : [];

  const bukaDetail = (row: AkunPendapatanNominalRow) => {
    if (!periode) return;
    navigation.navigate('PendapatanAkunDetail', {
      accountId: row.accountId,
      nama: row.nama,
      kode: row.kode,
      tanggalMulai: periode.mulai,
      tanggalSelesai: periode.selesai,
      periodeLabel: periode.label,
    });
  };

  const kosong =
    !!data &&
    data.pendapatanUsahaLain.length === 0 &&
    data.hasilInvestasi.length === 0 &&
    data.pendapatanLain.length === 0 &&
    data.belumDiklasifikasikan.length === 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
      <Text style={styles.title}>Daftar Pendapatan</Text>
      <Text style={styles.sub}>Akun nominal Pendapatan dikelompokkan per klasifikasi LHU, dengan saldo periode berjalan.</Text>

      {periode && (
        <View style={styles.periodeBanner}>
          <Text style={styles.periodeBannerLabel}>Untuk Periode</Text>
          <Text style={styles.periodeBannerValue}>{periode.label}</Text>
        </View>
      )}

      <ReportPeriodPicker value={periode} onChange={onChangePeriode} />

      {data && !kosong && (
        <SearchField
          wrapStyle={styles.searchRow}
          placeholder="Cari nama atau kode akun..."
          placeholderTextColor={colors.placeholder}
          value={search}
          onChangeText={setSearch}
        />
      )}

      {loading && <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />}
      {!loading && error && <Text style={styles.errorText}>{error}</Text>}

      {!loading && !error && data && (
        <>
          {kosong ? (
            <EmptyState message="Belum ada akun Pendapatan yang terklasifikasi untuk LHU. Atur klasifikasi lewat Input Data > Akun." />
          ) : (
            <>
              {filteredBelumDiklasifikasikan.length > 0 && (
                <View style={styles.warningBanner}>
                  <Text style={styles.warningText}>
                    Ada akun Pendapatan yang belum diklasifikasikan (Pendapatan Usaha Lain / Hasil Investasi / Pendapatan
                    Lain) — lihat bagian "Pendapatan Belum Diklasifikasikan" di bawah. Atur klasifikasinya lewat Input Data
                    &gt; Akun supaya masuk hitungan Total Pendapatan.
                  </Text>
                </View>
              )}

              {filteredUsahaLain.length > 0 && (
                <View style={styles.section}>
                  <SectionHeader title="Pendapatan Usaha Lain" />
                  {filteredUsahaLain.map((r) => (
                    <AkunRow key={r.accountId} row={r} onPress={() => bukaDetail(r)} />
                  ))}
                  <ReportRow label="Total Pendapatan Usaha Lain" value={data.totalPendapatanUsahaLain} variant="subtotal" />
                </View>
              )}

              {filteredHasilInvestasi.length > 0 && (
                <View style={styles.section}>
                  <SectionHeader title="Pendapatan Hasil Investasi" />
                  {filteredHasilInvestasi.map((r) => (
                    <AkunRow key={r.accountId} row={r} onPress={() => bukaDetail(r)} />
                  ))}
                  <ReportRow label="Total Pendapatan Investasi" value={data.totalHasilInvestasi} variant="subtotal" />
                </View>
              )}

              {filteredPendapatanLain.length > 0 && (
                <View style={styles.section}>
                  <SectionHeader title="Pendapatan Lainnya" />
                  {filteredPendapatanLain.map((r) => (
                    <AkunRow key={r.accountId} row={r} onPress={() => bukaDetail(r)} />
                  ))}
                  <ReportRow label="Total Pendapatan Lainnya" value={data.totalPendapatanLain} variant="subtotal" />
                </View>
              )}

              {filteredBelumDiklasifikasikan.length > 0 && (
                <View style={styles.section}>
                  <SectionHeader title="Pendapatan Belum Diklasifikasikan" />
                  {filteredBelumDiklasifikasikan.map((r) => (
                    <AkunRow key={r.accountId} row={r} onPress={() => bukaDetail(r)} />
                  ))}
                  <ReportRow label="Total Belum Diklasifikasikan" value={data.totalBelumDiklasifikasikan} variant="subtotal" />
                </View>
              )}

              {!q && (
                <SummaryCard
                  label="Total Pendapatan"
                  value={data.totalPendapatan}
                  caption={periode ? `Untuk Periode: ${periode.label}` : undefined}
                />
              )}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

function AkunRow({ row, onPress }: { row: AkunPendapatanNominalRow; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.6}>
      <ReportRow label={`${row.kode} — ${row.nama}`} value={row.nominal} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing.md, lineHeight: 17 },
  periodeBanner: { backgroundColor: colors.primaryLight, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md, alignItems: 'center' },
  periodeBannerLabel: { fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  periodeBannerValue: { fontSize: 15, fontWeight: '700', color: colors.primary, marginTop: 2 },
  searchRow: { marginBottom: spacing.md },
  errorText: { color: colors.danger, textAlign: 'center', marginTop: 24 },
  warningBanner: { backgroundColor: '#FFF7E6', borderRadius: radius.sm, padding: spacing.sm, marginBottom: spacing.md },
  warningText: { fontSize: 12, color: '#8A6D3B', lineHeight: 16 },
  section: { marginBottom: spacing.lg },
});

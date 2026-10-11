import { Ionicons } from '@expo/vector-icons';
import AreaAmanKeyboard, { PROP_SCROLL_FORM } from '@/components/AreaAmanKeyboard';
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { getDb } from '@/database/db';
import { getTrialBalance, TrialBalanceResult } from '@/reports/FinancialReports';
import { formatRupiah } from '@/utils/money';
import { buildNeracaSaldoExport } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import DatePicker from '@/components/DatePicker';
import EmptyState from '@/components/report/EmptyState';
import TabelGeser, { SelNilai, lebarTabel, tabelUi } from '@/components/report/TabelGeser';
import { formatTanggalIndonesia } from '@/components/DatePicker';
import { useAppStore } from '@/store/useAppStore';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { useReportRefreshHeader } from '@/components/report/ReportRefreshButton';
import { getWaktuSekarang } from '@/services/DevClockService';

/**
 * Neraca Saldo (PRD §23) — kode akun, nama akun, debit, kredit, saldo,
 * validasi balance.
 *
 * BUG FIX (UI/UX): tanggal sebelumnya diketik bebas via TextInput
 * ("YYYY-MM-DD") — rawan salah format/typo dan tidak konsisten dengan
 * DatePicker native yang dipakai di seluruh layar lain. Diganti ke
 * DatePicker yang sama (refresh otomatis saat tanggal berubah, tidak
 * perlu tombol Refresh terpisah lagi).
 */
export default function NeracaSaldoScreen() {
  const koperasi = useAppStore((s) => s.koperasi);
  const [asOfDate, setAsOfDate] = useState(getTanggalLokalHariIni());
  const [data, setData] = useState<TrialBalanceResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (date: string) => {
    setLoading(true);
    setError(null);
    try {
      const db = await getDb();
      const result = await getTrialBalance(db, date);
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat neraca saldo.');
    } finally {
      setLoading(false);
    }
  }, []);

  // §6/§14 — refresh saat layar difokuskan (native-stack tidak
  // meng-unmount layar yang ditinggalkan).
  //
  // RC-S49b §A2 — callback inline diangkat menjadi `muat` supaya SATU
  // fungsi yang sama dipakai focus refresh DAN tombol Refresh manual.
  // Ini murni perubahan bentuk: isinya tetap `load(asOfDate)` yang
  // sama persis, tidak ada kueri kedua yang ditambahkan.
  const muat = useCallback(() => {
    load(asOfDate);
  }, [load, asOfDate]);

  useFocusRefresh(muat, [muat]);

  useReportRefreshHeader(muat, { loading, testID: 'refresh-neraca-saldo' });

  return (
    <AreaAmanKeyboard varian="layar" style={{ flex: 1 }}>
      <ScrollView {...PROP_SCROLL_FORM} style={styles.container} contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl * 2 }}>
        <View style={styles.kop}>
          <Text style={styles.title}>Neraca Saldo</Text>
          {koperasi?.nama ? <Text style={styles.sub}>{koperasi.nama}</Text> : null}
          <View style={styles.periodeCard}>
            <Text style={styles.periodeLabel}>PER TANGGAL</Text>
            <Text style={styles.periodeValue}>{formatTanggalIndonesia(asOfDate)}</Text>
          </View>
        </View>

        <View style={styles.pengaturan}>
          <Text style={styles.label}>Per Tanggal</Text>
          <DatePicker value={asOfDate} onChange={setAsOfDate} maximumDate={getWaktuSekarang()} />
        </View>

        {loading && <ActivityIndicator style={{ marginTop: 24 }} color={colors.primary} />}

        {!loading && error && <Text style={styles.errorText}>{error}</Text>}

        {!loading && !error && data && data.rows.length === 0 && (
          <EmptyState message="Belum ada mutasi jurnal sampai tanggal ini." />
        )}

        {!loading && !error && data && data.rows.length > 0 && (
          <>
            <ExportButton
              data={
                koperasi
                  ? buildNeracaSaldoExport(
                      { namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi },
                      data,
                      asOfDate
                    )
                  : null
              }
            />
            <TabelGeser lebarMinimum={lebarTabel(2)}>
              <View style={tabelUi.header}>
                <Text style={[tabelUi.th, tabelUi.kolomAkun]}>Akun</Text>
                <Text style={[tabelUi.th, tabelUi.thNilai]}>Debit</Text>
                <Text style={[tabelUi.th, tabelUi.thNilai]}>Kredit</Text>
              </View>
              {data.rows.map((r, idx) => (
                <View key={r.accountId} style={[tabelUi.baris, idx % 2 === 1 && tabelUi.barisGenap]}>
                  <View style={tabelUi.kolomAkun}>
                    <Text style={styles.kode}>{r.kode}</Text>
                    <Text style={styles.nama}>{r.nama}</Text>
                  </View>
                  {/* "-" HANYA untuk nilai persis 0; nilai negatif tetap
                      ditampilkan (bandingkan `!== 0`, bukan `> 0`). */}
                  <SelNilai style={[r.debit === 0 && tabelUi.nilaiRedup, r.debit < 0 && tabelUi.nilaiNegatif]}>
                    {r.debit !== 0 ? formatRupiah(r.debit) : '-'}
                  </SelNilai>
                  <SelNilai style={[r.kredit === 0 && tabelUi.nilaiRedup, r.kredit < 0 && tabelUi.nilaiNegatif]}>
                    {r.kredit !== 0 ? formatRupiah(r.kredit) : '-'}
                  </SelNilai>
                </View>
              ))}

              <View style={tabelUi.total}>
                <Text style={[tabelUi.labelTebal, tabelUi.kolomAkun]}>Total</Text>
                <SelNilai style={tabelUi.nilaiUtama}>{formatRupiah(data.totalDebit)}</SelNilai>
                <SelNilai style={tabelUi.nilaiUtama}>{formatRupiah(data.totalKredit)}</SelNilai>
              </View>
            </TabelGeser>

            <View style={[styles.validationBanner, data.isBalanced ? styles.validationOk : styles.validationWarn]}>
              {data.isBalanced ? <Ionicons name="checkmark-circle-outline" size={18} color={colors.success} /> : <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />}
              <Text style={styles.validationText}>
                {data.isBalanced
                  ? 'Seimbang — Total Debit = Total Kredit'
                  : `TIDAK SEIMBANG — selisih ${formatRupiah(Math.abs(data.totalDebit - data.totalKredit))}`}
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </AreaAmanKeyboard>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  kop: { marginBottom: spacing.md },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  periodeCard: { backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: spacing.md, alignItems: 'center', marginTop: spacing.md },
  periodeLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '700', letterSpacing: 0.5 },
  periodeValue: { fontSize: 18, fontWeight: '700', color: colors.primary, marginTop: 2 },
  pengaturan: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  label: { fontSize: 11, color: colors.textMuted, fontWeight: '700', marginBottom: spacing.xs, letterSpacing: 0.3, textTransform: 'uppercase' },
  errorText: { color: colors.danger, textAlign: 'center', marginTop: 24 },
  kode: { fontSize: 11, color: colors.primary, fontWeight: '700' },
  nama: { fontSize: 13, color: colors.text, marginTop: 1 },
  validationBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
    borderWidth: 1,
  },
  validationOk: { backgroundColor: colors.primaryLight, borderColor: colors.border },
  validationWarn: { backgroundColor: colors.dangerBg, borderColor: colors.danger },
  validationText: { flexShrink: 1, fontSize: 13, fontWeight: '700', color: colors.text, textAlign: 'center' },
});

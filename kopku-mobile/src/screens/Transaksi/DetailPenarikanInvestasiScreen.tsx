import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusRefresh } from '@/hooks/useFocusRefresh';
import { getDetailPenarikanInvestasi, type DetailPenarikanInvestasi } from '@/services/PenarikanInvestasiQuery';
import { colors, radius, spacing } from '@/theme/colors';
import { formatRupiah } from '@/utils/money';
import { tanggalRingkas } from '@/utils/tarikSimpananUi';
import { judulJenisPenarikan } from '@/utils/penarikanInvestasiUi';

/**
 * Detail transaksi penarikan dana investasi — BACA-SAJA. Tidak ada aksi
 * ubah/hapus: transaksi yang sudah diposting tidak dapat diubah dari sini.
 */
export default function DetailPenarikanInvestasiScreen({ route }: { route?: any }) {
  const journalId: string | undefined = route?.params?.journalId;
  const [d, setD] = useState<DetailPenarikanInvestasi | null>(null);
  const [memuat, setMemuat] = useState(true);

  const muat = useCallback(async () => {
    if (!journalId) return;
    setMemuat(true);
    try {
      setD(await getDetailPenarikanInvestasi(journalId));
    } catch {
      setD(null);
    } finally {
      setMemuat(false);
    }
  }, [journalId]);
  useFocusRefresh(() => {
    void muat();
  }, [muat]);

  if (memuat) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (!d) {
    return (
      <View style={styles.center}>
        <Ionicons name="alert-circle-outline" size={36} color={colors.textFaint} />
        <Text style={styles.centerText}>Transaksi tidak ditemukan.</Text>
      </View>
    );
  }

  const selisih = d.labaRugi;
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.isi}>
      <View style={styles.hero}>
        <Text style={styles.heroLabel}>Total dana diterima</Text>
        <Text style={styles.heroNominal}>{d.totalDiterima === null ? '-' : formatRupiah(d.totalDiterima)}</Text>
        <Text style={styles.heroSub}>{d.jenisPenarikan === 'SEBAGIAN' ? 'Penarikan sebagian' : 'Penarikan seluruhnya'}</Text>
        <View style={styles.statusPill}>
          <Ionicons name="lock-closed-outline" size={12} color={colors.success} />
          <Text style={styles.statusText}>{d.statusJurnal === 'POSTED' ? 'Diposting' : d.statusJurnal}</Text>
        </View>
      </View>

      <Kartu judul="Investasi">
        <Baris label="Jenis" nilai={judulJenisPenarikan(d.jenisInvestasi)} />
        <Baris label="Pihak / institusi" nilai={d.namaTujuan} />
        <Baris label="Nomor bukti" nilai={d.nomorInvestasi} />
      </Kartu>

      <Kartu judul="Rincian Penarikan">
        <Baris label="Tanggal transaksi" nilai={tanggalRingkas(d.tanggal.slice(0, 10))} />
        {d.biayaPerolehan !== null ? <Baris label="Nilai perolehan" nilai={formatRupiah(d.biayaPerolehan)} /> : null}
        {d.akumulasiPenyusutan ? <Baris label="Akumulasi penyusutan" nilai={`− ${formatRupiah(d.akumulasiPenyusutan)}`} /> : null}
        {d.akumulasiImpairment ? <Baris label="Penurunan nilai" nilai={`− ${formatRupiah(d.akumulasiImpairment)}`} /> : null}
        {d.danaDiterima !== null ? <Baris label="Jumlah penarikan (pokok)" nilai={formatRupiah(d.danaDiterima)} /> : null}
        {d.nilaiTercatat !== null ? <Baris label="Nilai investasi dikembalikan" nilai={formatRupiah(d.nilaiTercatat)} /> : null}
        {selisih !== null ? (
          <Baris
            label={selisih > 0 ? 'Keuntungan penarikan investasi' : selisih < 0 ? 'Kerugian penarikan investasi' : 'Selisih'}
            nilai={`${selisih < 0 ? '− ' : ''}${formatRupiah(Math.abs(selisih))}`}
          />
        ) : null}
        {d.bungaDiterima > 0 ? <Baris label="Bunga deposito diterima" nilai={formatRupiah(d.bungaDiterima)} /> : null}
        <Baris label="Diterima ke" nilai={d.rekening ?? '-'} />
        {d.keterangan ? <Baris label="Keterangan" nilai={d.keterangan} /> : null}
      </Kartu>

      <Kartu judul="Jurnal">
        <Text style={styles.jurnalNo}>
          {d.nomorJurnal}
          {d.nomorReferensi ? ` · Ref. ${d.nomorReferensi}` : ''}
        </Text>
        <TabelJurnal baris={d.baris} />
        {d.barisBunga.length > 0 ? (
          <>
            <Text style={[styles.jurnalNo, { marginTop: spacing.md }]}>
              Jurnal bunga deposito{d.nomorJurnalBunga ? ` · ${d.nomorJurnalBunga}` : ''}
            </Text>
            <TabelJurnal baris={d.barisBunga} />
          </>
        ) : null}
      </Kartu>

      <Kartu judul="Jejak Audit">
        <Baris label="Dicatat oleh" nilai={d.dicatatOleh ?? '-'} />
        <Baris label="Dicatat pada" nilai={d.dicatatPada.replace('T', ' ').slice(0, 16)} />
      </Kartu>
      <Text style={styles.footnote}>Transaksi yang sudah diposting hanya dapat dilihat dan tidak dapat diubah.</Text>
    </ScrollView>
  );
}

function TabelJurnal({ baris }: { baris: DetailPenarikanInvestasi['baris'] }) {
  return (
    <View style={styles.jurnal}>
      <View style={styles.jurnalHeader}>
        <Text style={[styles.jurnalTh, { flex: 1 }]}>Akun</Text>
        <Text style={[styles.jurnalTh, styles.jurnalNum]}>Debit</Text>
        <Text style={[styles.jurnalTh, styles.jurnalNum]}>Kredit</Text>
      </View>
      {baris.map((b, i) => (
        <View key={i} style={styles.jurnalRow}>
          <Text style={[styles.jurnalAkun, b.kredit > 0 && { paddingLeft: spacing.md }]}>
            {b.kode} {b.nama}
          </Text>
          <Text style={styles.jurnalNum} numberOfLines={1}>
            {b.debit > 0 ? formatRupiah(b.debit) : ''}
          </Text>
          <Text style={styles.jurnalNum} numberOfLines={1}>
            {b.kredit > 0 ? formatRupiah(b.kredit) : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Kartu({ judul, children }: { judul: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardJudul}>{judul}</Text>
      {children}
    </View>
  );
}

function Baris({ label, nilai }: { label: string; nilai: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowNilai}>{nilai}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  isi: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.background },
  centerText: { fontSize: 13, color: colors.textMuted },
  hero: {
    alignItems: 'center',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  heroLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5, textTransform: 'uppercase' },
  heroNominal: { fontSize: 26, fontWeight: '700', color: colors.primary, marginTop: 4 },
  heroSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginTop: spacing.sm,
  },
  statusText: { fontSize: 11, fontWeight: '700', color: colors.success },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  cardJudul: { fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 4 },
  rowLabel: { fontSize: 12.5, color: colors.textMuted, flex: 1 },
  rowNilai: { fontSize: 13, fontWeight: '600', color: colors.text, textAlign: 'right', flexShrink: 1 },
  jurnalNo: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.sm },
  jurnal: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, overflow: 'hidden' },
  jurnalHeader: { flexDirection: 'row', backgroundColor: colors.primaryLight, paddingHorizontal: spacing.sm, paddingVertical: 6 },
  jurnalTh: { fontSize: 10.5, fontWeight: '700', color: colors.primary, textTransform: 'uppercase' },
  jurnalRow: { flexDirection: 'row', paddingHorizontal: spacing.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border },
  jurnalAkun: { flex: 1, fontSize: 12, color: colors.text, paddingRight: spacing.xs },
  jurnalNum: { width: 104, textAlign: 'right', fontSize: 12, color: colors.text, fontVariant: ['tabular-nums'] },
  footnote: { fontSize: 11, color: colors.textFaint, textAlign: 'center', marginTop: spacing.sm },
});

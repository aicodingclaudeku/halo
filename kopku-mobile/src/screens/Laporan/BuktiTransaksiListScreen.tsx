import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, ActivityIndicator, StyleSheet } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import {
  listBuktiBayarPiutang,
  listBuktiBayarUtang,
  listBuktiBayarSimpanan,
  listBuktiTarikSimpanan,
  listBuktiKeluarAnggota,
  BuktiBayarPiutangRow,
  BuktiBayarUtangRow,
  BuktiBayarSimpananRow,
  BuktiTarikSimpananRow,
  BuktiKeluarAnggotaRow,
} from '@/services/BuktiTransaksiService';
import { formatRupiah } from '@/utils/money';
import { labelJenisSimpananBukti } from '@/export/ReportTableBuilders';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';
import { useReportRefreshHeader } from '@/components/report/ReportRefreshButton';

import SearchField from '@/components/SearchField';
export type JenisBukti = 'BAYAR_UTANG' | 'BAYAR_PIUTANG' | 'BAYAR_SIMPANAN' | 'TARIK_SIMPANAN' | 'KELUAR_ANGGOTA';

export const LABEL_JENIS_BUKTI: Record<JenisBukti, string> = {
  BAYAR_UTANG: 'Bukti Bayar Utang',
  BAYAR_PIUTANG: 'Bukti Bayar Piutang Anggota',
  BAYAR_SIMPANAN: 'Bukti Bayar Simpanan Anggota',
  TARIK_SIMPANAN: 'Bukti Tarik Simpanan Anggota',
  KELUAR_ANGGOTA: 'Bukti Keluar Anggota',
};

type BaseRow = { id: string; nomorBukti: string; tanggal: string; nomorAnggota: string; namaAnggota: string };

function toRow(
  jenis: JenisBukti,
  r: BuktiBayarPiutangRow | BuktiBayarUtangRow | BuktiBayarSimpananRow | BuktiTarikSimpananRow | BuktiKeluarAnggotaRow
): BaseRow & { nominal: number; sub: string } {
  if (jenis === 'BAYAR_UTANG') {
    const item = r as BuktiBayarUtangRow;
    return { id: item.id, nomorBukti: item.nomorBukti, tanggal: item.tanggal, nomorAnggota: item.nomorUtang, namaAnggota: item.namaPemberi, nominal: item.jumlahPembayaran, sub: `Utang ${item.nomorUtang}` };
  }
  if (jenis === 'BAYAR_PIUTANG') {
    const item = r as BuktiBayarPiutangRow;
    return { ...item, nominal: item.jumlahPembayaran, sub: `Pinjaman ${item.nomorPinjaman}` };
  }
  if (jenis === 'TARIK_SIMPANAN') {
    const item = r as BuktiTarikSimpananRow;
    const rb = item.rincianBerjangka;
    const sub = rb
      ? `${labelJenisSimpananBukti(item.jenisSimpanan)} · ${rb.nomorKontrak} · ${rb.jenisPencairan === 'DINI' ? 'Penarikan dini' : 'Jatuh tempo'}`
      : labelJenisSimpananBukti(item.jenisSimpanan);
    return { ...item, nominal: item.jumlah, sub };
  }
  if (jenis === 'BAYAR_SIMPANAN') {
    const item = r as BuktiBayarSimpananRow;
    return { ...item, nominal: item.jumlah, sub: labelJenisSimpananBukti(item.jenisSimpanan) };
  }
  const item = r as BuktiKeluarAnggotaRow;
  return { id: item.journalId, nomorBukti: item.nomorBukti, tanggal: item.tanggal, nomorAnggota: item.nomorAnggota, namaAnggota: item.namaAnggota, nominal: item.totalDikembalikan, sub: 'Saldo dikembalikan' };
}

/**
 * Layar daftar untuk 3 jenis "Bukti Transaksi" (Phase 17 §W/§X/§Y),
 * SATU komponen generik dipakai lewat route param `jenis` (pola sama
 * dengan DataReferensiListScreen) — semua datanya MURNI dibaca dari
 * transaksi yang sudah ada lewat BuktiTransaksiService (read-only, tidak
 * ada tombol tambah/edit/hapus di sini). Tap satu baris membuka
 * BuktiTransaksiDetailScreen untuk lihat rincian & export (§Z: bukti
 * harus bisa ditemukan dari transaksi aslinya, export hanya membaca
 * data existing).
 */
export default function BuktiTransaksiListScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const jenis: JenisBukti = route.params?.jenis;

  const [query, setQuery] = useState('');
  const [data, setData] = useState<ReturnType<typeof toRow>[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let rows: (BuktiBayarPiutangRow | BuktiBayarUtangRow | BuktiBayarSimpananRow | BuktiTarikSimpananRow | BuktiKeluarAnggotaRow)[];
      if (jenis === 'BAYAR_UTANG') rows = await listBuktiBayarUtang({ search: query || undefined });
      else if (jenis === 'BAYAR_PIUTANG') rows = await listBuktiBayarPiutang({ search: query || undefined });
      else if (jenis === 'BAYAR_SIMPANAN') rows = await listBuktiBayarSimpanan({ search: query || undefined });
      else if (jenis === 'TARIK_SIMPANAN') rows = await listBuktiTarikSimpanan({ search: query || undefined });
      else rows = await listBuktiKeluarAnggota({ search: query || undefined });
      setData(rows.map((r) => toRow(jenis, r)));
    } finally {
      setLoading(false);
    }
  }, [jenis, query]);

  useEffect(() => {
    navigation.setOptions({ title: LABEL_JENIS_BUKTI[jenis] });
    const timeout = setTimeout(load, 200);
    return () => clearTimeout(timeout);
  }, [navigation, load, jenis]);

  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation, load]);

  // RC-S49b §A1 — TOMBOL REFRESH MANUAL, memakai `load` yang SAMA
  // dengan focus listener di atas. `setOptions` di sini TIDAK
  // menimpa `title` yang disetel efek sebelumnya: React Navigation
  // menggabungkan options per-kunci, dan kedua efek menyetel kunci
  // yang berbeda (`title` vs `headerRight`).
  useReportRefreshHeader(load, { loading, testID: 'refresh-bukti-transaksi' });

  return (
    <View style={styles.container}>
      <SearchField
        wrapStyle={styles.searchBox}
        placeholder="Cari nama/nomor anggota..."
        placeholderTextColor={colors.placeholder}
        value={query}
        onChangeText={setQuery}
      />

      {loading && <ActivityIndicator style={{ marginTop: 24 }} />}

      {!loading && (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: spacing.lg, paddingTop: 0 }}
          ListEmptyComponent={<Text style={styles.emptyText}>Belum ada transaksi.</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.row}
              onPress={() => navigation.navigate('BuktiTransaksiDetail', { jenis, id: item.id })}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.rowNama}>{item.namaAnggota}</Text>
                <Text style={styles.rowSub}>
                  {item.nomorAnggota} · {item.sub} · {item.tanggal}
                </Text>
                <Text style={styles.rowBukti}>Bukti: {item.nomorBukti}</Text>
              </View>
              <Text style={styles.rowNominal}>{formatRupiah(item.nominal)}</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  searchBox: { margin: spacing.lg, marginBottom: spacing.sm },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: 24 },
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
  rowNama: { fontSize: 14, color: colors.text, fontWeight: '600', flexShrink: 1 },
  rowSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  rowBukti: { fontSize: 10, color: colors.textFaint, marginTop: 2 },
  rowNominal: { fontSize: 13, fontWeight: '700', color: colors.primary, textAlign: 'right', fontVariant: ['tabular-nums'], flexShrink: 1 },
});

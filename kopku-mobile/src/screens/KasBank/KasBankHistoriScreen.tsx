import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import {
  listRiwayatTransaksi,
  RiwayatTransaksiRow,
  KATEGORI_TRANSAKSI_DEFAULT,
  JenisRekening,
} from '@/services/KasBankService';
import { formatRupiah } from '@/utils/money';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DatePicker from '@/components/DatePicker';
import { colors, radius, spacing } from '@/theme/colors';
import { getWaktuSekarang } from '@/services/DevClockService';

const TIPE_WARNA: Record<string, string> = {
  PENERIMAAN: colors.primary,
  PENGELUARAN: colors.danger,
  TRANSFER: colors.warning,
  KOREKSI: colors.textMuted,
};

/** Riwayat transaksi kas/bank, dengan filter tanggal/rekening/kategori (fase 7 §15-16). */
export default function KasBankHistoriScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const jenisAwal: JenisRekening | undefined = route.params?.jenis;
  const bankAccountIdAwal: string | undefined = route.params?.bankAccountId;
  const namaRekening: string | undefined = route.params?.namaRekening;

  const [tanggalMulai, setTanggalMulai] = useState('');
  const [tanggalSelesai, setTanggalSelesai] = useState('');
  const [kategori, setKategori] = useState<string | null>(null);
  const [data, setData] = useState<RiwayatTransaksiRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const rows = await listRiwayatTransaksi({
      jenis: jenisAwal,
      bankAccountId: bankAccountIdAwal,
      tanggalMulai: tanggalMulai || undefined,
      tanggalSelesai: tanggalSelesai || undefined,
      kategori: kategori ?? undefined,
      limit: 100,
    });
    setData(rows);
    setLoading(false);
  }, [jenisAwal, bankAccountIdAwal, tanggalMulai, tanggalSelesai, kategori]);

  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation, load]);

  useEffect(() => {
    load();
  }, [tanggalMulai, tanggalSelesai, kategori, load]);

  // Kalau dibuka dari rekening tertentu, pakai nama rekening sebagai
  // judul HEADER NATIVE (bukan teks tambahan di body) — sebelumnya ada
  // dua "judul" tumpuk (judul header default "Riwayat Transaksi" +
  // teks nama rekening di bawahnya), yang bikin bagian atas layar
  // kelihatan lebih tinggi/padat dari seharusnya.
  useEffect(() => {
    if (namaRekening) navigation.setOptions({ title: namaRekening });
  }, [namaRekening, navigation]);

  return (
    <View style={styles.container}>
      <View style={styles.filterRow}>
        <View style={{ flex: 1 }}>
          <DatePicker value={tanggalMulai} onChange={setTanggalMulai} maximumDate={getWaktuSekarang()} />
        </View>
        <View style={{ flex: 1 }}>
          <DatePicker value={tanggalSelesai} onChange={setTanggalSelesai} maximumDate={getWaktuSekarang()} />
        </View>
      </View>

      <View style={styles.chipRow}>
        <Chip label="Semua Kategori" active={kategori === null} onPress={() => setKategori(null)} />
        {KATEGORI_TRANSAKSI_DEFAULT.map((k) => (
          <Chip key={k} label={k} active={kategori === k} onPress={() => setKategori(k)} />
        ))}
      </View>

      {loading && <ActivityIndicator style={styles.center} />}

      {!loading && data.length === 0 && (
        <View style={styles.center}>
          <Text style={styles.emptyText}>Tidak ada transaksi pada filter ini.</Text>
        </View>
      )}

      {!loading && data.length > 0 && (
        <FlatList
          data={data}
          keyExtractor={(item) => `${item.jenis}-${item.id}`}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.row}
              onPress={() => navigation.navigate('KasBankDetail', { jenis: item.jenis, id: item.id })}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.rekeningNama}>{item.rekeningNama}</Text>
                <Text style={styles.sub}>
                  {item.tanggal} · {item.kategori ?? item.tipe} {item.akunLawanNama ? `· ${item.akunLawanNama}` : ''}
                </Text>
                <Text style={styles.nomor}>{item.nomorTransaksi}</Text>
              </View>
              <Text style={[styles.nominal, { color: TIPE_WARNA[item.tipe] ?? colors.text }]}>
                {item.tipe === 'PENGELUARAN' ? '-' : '+'}
                {formatRupiah(item.nominal)}
              </Text>
            </TouchableOpacity>
          )}
        />
      )}

      <TouchableOpacity
        style={[styles.fab, { bottom: 24 + insets.bottom }]}
        onPress={() =>
          navigation.navigate('KasBankTransaksiForm', { tipe: 'PEMASUKAN' })
        }
      >
        <Text style={styles.fabIcon}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.chip, active && styles.chipActive]} onPress={onPress}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  headerTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginHorizontal: spacing.lg, marginTop: spacing.md },
  filterRow: { flexDirection: 'row', gap: 8, marginHorizontal: spacing.lg, marginTop: spacing.md },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginHorizontal: spacing.lg, marginTop: 10, marginBottom: 4 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 11, color: colors.text },
  chipTextActive: { color: colors.white },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyText: { color: colors.textMuted, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: '#EEE',
  },
  rekeningNama: { fontSize: 14, fontWeight: '600', color: colors.text },
  sub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  nomor: { fontSize: 10, color: colors.textFaint, marginTop: 2 },
  nominal: { fontSize: 14, fontWeight: '700' },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  fabIcon: { color: colors.white, fontSize: 28, lineHeight: 30 },
});

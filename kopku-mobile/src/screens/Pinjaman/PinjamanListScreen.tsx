import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { listPinjaman, PinjamanListItem } from '@/services/PinjamanService';
import { formatRupiah } from '@/utils/money';
import { useAppStore } from '@/store/useAppStore';
import { buildPinjamanExport } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import SearchField from '@/components/SearchField';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatTanggalIndonesia } from '@/components/DatePicker';
import { colors, elevation, radius, spacing } from '@/theme/colors';
import { getTanggalLokalHariIni } from '@/utils/tanggal';

/**
 * Badge status kartu pinjaman — label ramah baca + pasangan warna dari
 * token tema (tanpa hex baru). Nilai status di database TIDAK berubah;
 * ini murni lapisan tampilan.
 */
const STATUS_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  DIAJUKAN: { label: 'Diajukan', bg: colors.background, fg: colors.textMuted },
  DISETUJUI: { label: 'Disetujui', bg: colors.warningBg, fg: colors.warning },
  AKTIF: { label: 'Aktif', bg: colors.primaryLight, fg: colors.primary },
  LUNAS: { label: 'Lunas', bg: colors.background, fg: colors.textFaint },
  MACET: { label: 'Macet', bg: colors.dangerBg, fg: colors.danger },
  DITOLAK: { label: 'Ditolak', bg: colors.dangerBg, fg: colors.danger },
};

type StatusKategori = 'AKTIF' | 'BELUM_AKTIF' | 'DIBATALKAN';

// PHASE 4 §I (permintaan pengguna): filter Semua/Aktif/Belum Aktif/
// Dibatalkan — LUNAS SENGAJA tidak masuk kategori manapun di sini
// (instruksi eksplisit "Jangan masukkan LUNAS ke Aktif"); pinjaman
// LUNAS tetap terlihat lewat filter "Semua". Pola chip SAMA PERSIS
// dengan AnggotaListScreen (FILTER_STATUS) untuk konsistensi UI/UX.
const FILTER_STATUS: { value: StatusKategori | null; label: string }[] = [
  { value: null, label: 'Semua' },
  { value: 'AKTIF', label: 'Aktif' },
  { value: 'BELUM_AKTIF', label: 'Belum Aktif' },
  { value: 'DIBATALKAN', label: 'Dibatalkan' },
];

/**
 * Daftar pinjaman semua anggota (PRD §11).
 *
 * PHASE 4 §I/§J/§K (permintaan pengguna): search (nomor pinjaman/nama
 * anggota/nomor anggota) & filter status kategori ditambahkan —
 * KEDUANYA difilter lewat query backend (`listPinjaman({ search,
 * statusKategori })`, lihat PinjamanService.ts), BUKAN load semua
 * data lalu difilter di frontend — pola SAMA PERSIS dengan
 * AnggotaListScreen (debounce 250ms, reload saat screen fokus lagi).
 */
export default function PinjamanListScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const koperasi = useAppStore((s) => s.koperasi);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusKategori | null>(null);
  const [data, setData] = useState<PinjamanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (search: string, statusKategori: StatusKategori | null) => {
    setLoading(true);
    setError(null);
    try {
      // Ambil semua pinjaman yang cocok filter (bukan hanya 50
      // pertama) supaya export laporan "Pinjaman" (fase 6) & daftar
      // yang terlihat selalu lengkap.
      const rows = await listPinjaman({
        search: search || undefined,
        statusKategori: statusKategori ?? undefined,
        limit: 100000,
      });
      setData(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat daftar pinjaman.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => load(query, statusFilter), 250); // debounce search
    return () => clearTimeout(timeout);
  }, [query, statusFilter, load]);

  useEffect(() => {
    // Reload otomatis setiap kali layar ini kembali fokus (mis.
    // setelah pencairan/pelunasan/write-off/akad ulang di layar lain)
    // — pola sama dengan AnggotaListScreen.
    const unsub = navigation.addListener('focus', () => load(query, statusFilter));
    return unsub;
  }, [navigation, load, query, statusFilter]);

  const exportData = useMemo(
    () =>
      koperasi && data.length > 0
        ? buildPinjamanExport(
            { namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi },
            data,
            getTanggalLokalHariIni()
          )
        : null,
    [koperasi, data]
  );

  /**
   * Tombol Export di header navigasi, SEJAJAR judul "Pinjaman" — pola
   * yang sama dengan SimpananHistoriScreen. `useLayoutEffect` supaya
   * tombol sudah terpasang pada frame pertama (header tidak berkedip).
   * Data & logika export tidak berubah: tetap buildPinjamanExport atas
   * daftar yang sedang tampil (hasil search/filter).
   */
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <ExportButton variant="header" label="Export" data={exportData} />,
    });
  }, [navigation, exportData]);

  const totalSisa = useMemo(
    () => data.reduce((acc, p) => acc + (p.status === 'AKTIF' || p.status === 'MACET' ? p.sisaPiutang : 0), 0),
    [data]
  );

  return (
    <View style={styles.container}>
      <SearchField
        wrapStyle={styles.search}
        placeholder="Cari nomor pinjaman, nama, atau nomor anggota..."
        value={query}
        onChangeText={setQuery}
      />

      <View style={styles.filterRow}>
        {FILTER_STATUS.map((f) => (
          <TouchableOpacity
            key={f.label}
            style={[styles.filterChip, statusFilter === f.value && styles.filterChipActive]}
            onPress={() => setStatusFilter(f.value)}
          >
            <Text style={[styles.filterChipText, statusFilter === f.value && styles.filterChipTextActive]}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {!loading && !error && data.length > 0 && (
        <View style={styles.summaryRow}>
          <Text style={styles.summaryText}>
            <Text style={styles.summaryStrong}>{data.length}</Text> pinjaman
          </Text>
          <Text style={styles.summaryText}>
            Sisa piutang <Text style={styles.summaryStrong}>{formatRupiah(totalSisa)}</Text>
          </Text>
        </View>
      )}

      {loading && <ActivityIndicator style={styles.center} />}

      {!loading && error && (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => load(query, statusFilter)}>
            <Text style={styles.retry}>Coba lagi</Text>
          </TouchableOpacity>
        </View>
      )}

      {!loading && !error && data.length === 0 && (
        <View style={styles.center}>
          <Text style={styles.emptyText}>
            {query || statusFilter
              ? 'Tidak ada pinjaman yang cocok dengan pencarian/filter ini.'
              : 'Belum ada pinjaman. Tekan + untuk mengajukan pinjaman baru.'}
          </Text>
        </View>
      )}

      {!loading && !error && data.length > 0 && (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.listContent, { paddingBottom: 96 + insets.bottom }]}
          renderItem={({ item, index }) => {
            const badge = STATUS_BADGE[item.status] ?? { label: item.status, bg: colors.background, fg: colors.text };
            const berjalan = item.status === 'AKTIF' || item.status === 'MACET';
            return (
              <TouchableOpacity
                style={styles.card}
                activeOpacity={0.7}
                onPress={() => navigation.navigate('PinjamanDetail', { pinjamanId: item.id })}
                accessibilityRole="button"
                accessibilityLabel={`Pinjaman nomor ${index + 1}, ${item.namaAnggota}, ${item.nomorPinjaman}`}
              >
                {/* Baris atas: identitas di kiri, NOMOR URUT di kanan atas.
                    Nomor urut = posisi pada daftar yang sedang tampil
                    (index FlatList, ikut menyesuaikan search/filter) —
                    BUKAN nomor pinjaman/ID. Pola sama dengan
                    AnggotaListScreen; murni presentasi. */}
                <View style={styles.cardTop}>
                  <View style={styles.cardIdentitas}>
                    <Text style={styles.nama} numberOfLines={1}>
                      {item.namaAnggota}
                    </Text>
                    <Text style={styles.nomorPinjaman} numberOfLines={1}>
                      {item.nomorPinjaman}
                    </Text>
                  </View>
                  <View style={styles.nomorUrut}>
                    <Text style={styles.nomorUrutText}>{index + 1}</Text>
                  </View>
                </View>

                <View style={styles.cardDivider} />

                <View style={styles.cardNilai}>
                  <View style={styles.nilaiKolom}>
                    <Text style={styles.nilaiLabel}>Plafon</Text>
                    <Text style={styles.nominal}>{formatRupiah(item.jumlahPinjaman)}</Text>
                  </View>
                  <View style={[styles.nilaiKolom, styles.nilaiKolomKanan]}>
                    <Text style={styles.nilaiLabel}>Sisa Piutang</Text>
                    <Text style={[styles.nominal, berjalan && styles.sisa]}>
                      {berjalan ? formatRupiah(item.sisaPiutang) : '—'}
                    </Text>
                  </View>
                </View>

                <View style={styles.cardFooter}>
                  <View style={[styles.badge, { backgroundColor: badge.bg }]}>
                    <Text style={[styles.badgeText, { color: badge.fg }]}>{badge.label}</Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Ionicons name="time-outline" size={13} color={colors.textMuted} />
                    <Text style={styles.meta}>
                      {item.tenor} {item.satuanTenor.toLowerCase()}
                    </Text>
                    {!!item.tanggalJatuhTempo && (
                      <>
                        <Text style={styles.metaDot}>·</Text>
                        <Ionicons name="calendar-outline" size={13} color={colors.textMuted} />
                        <Text style={styles.meta}>{formatTanggalIndonesia(item.tanggalJatuhTempo)}</Text>
                      </>
                    )}
                  </View>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}

      <TouchableOpacity
        style={[styles.fab, { bottom: 24 + insets.bottom }]}
        onPress={() => navigation.navigate('PinjamanForm')}
        accessibilityRole="button"
        accessibilityLabel="Ajukan Pinjaman"
      >
        <Ionicons name="add" size={28} color={colors.white} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  search: { margin: spacing.md },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: spacing.md, marginBottom: spacing.sm },
  filterChip: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  filterChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterChipText: { fontSize: 12, color: colors.text },
  filterChipTextActive: { color: colors.white },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyText: { color: colors.textMuted, textAlign: 'center' },
  errorText: { color: colors.danger, marginBottom: spacing.sm, textAlign: 'center' },
  retry: { color: colors.primary, fontWeight: '700', textAlign: 'center' },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  summaryText: { fontSize: 12, color: colors.textMuted },
  summaryStrong: { fontWeight: '700', color: colors.text },
  listContent: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, gap: spacing.sm },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    ...elevation.card,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  cardIdentitas: { flex: 1, minWidth: 0 },
  nama: { fontSize: 15, fontWeight: '700', color: colors.text },
  nomorPinjaman: { fontSize: 12, color: colors.textMuted, marginTop: 2, fontVariant: ['tabular-nums'] },
  nomorUrut: {
    minWidth: 28,
    height: 28,
    paddingHorizontal: 6,
    borderRadius: 14,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nomorUrutText: { fontSize: 12, fontWeight: '700', color: colors.primary, fontVariant: ['tabular-nums'] },
  cardDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  cardNilai: { flexDirection: 'row', gap: spacing.md },
  nilaiKolom: { flex: 1 },
  nilaiKolomKanan: { alignItems: 'flex-end' },
  nilaiLabel: { fontSize: 11, color: colors.textMuted, marginBottom: 2 },
  nominal: { fontSize: 14, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  sisa: { color: colors.danger },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.pill },
  badgeText: { fontSize: 11, fontWeight: '700' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  meta: { fontSize: 11, color: colors.textMuted },
  metaDot: { fontSize: 11, color: colors.textFaint, marginHorizontal: 2 },
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
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
});

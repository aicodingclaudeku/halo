import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { View, Text, FlatList, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { listAnggota, Anggota, StatusAnggota } from '@/repositories/AnggotaRepository';
import { useAppStore } from '@/store/useAppStore';
import { buildDaftarAnggotaExport } from '@/export/ReportTableBuilders';
import ExportButton from '@/components/ExportButton';
import SearchField from '@/components/SearchField';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing } from '@/theme/colors';
import { getTanggalLokalHariIni } from '@/utils/tanggal';
import {
  JUDUL_MODUL_ANGGOTA,
  SUBJUDUL_MODUL_ANGGOTA,
  labelStatusAnggota,
  nadaStatusAnggota,
  inisialNama,
  ringkasDaftarAnggota,
} from '@/reports/TampilanAnggotaPlan';

const FILTER_STATUS: { value: StatusAnggota | null; label: string }[] = [
  { value: null, label: 'Semua' },
  { value: 'AKTIF', label: 'Aktif' },
  { value: 'TIDAK_AKTIF', label: 'Tidak Aktif' },
  { value: 'KELUAR', label: 'Keluar' },
  { value: 'MENINGGAL', label: 'Meninggal' },
];

/**
 * Contoh screen dengan loading/empty/error state (PRD §38) dan
 * pencarian offline (PRD §37). FAB "+Anggota" ditaruh di sini.
 *
 * Update pasca-Phase 18/19 (permintaan pengguna §Q): TIDAK LAGI
 * dibatasi 50 anggota — `listAnggota({ semuaData: true })` mengambil
 * SELURUH data (search & filter status tetap jalan di level query,
 * bukan dipotong setelahnya). Filter status ditambahkan (chip
 * Semua/Aktif/Tidak Aktif/Keluar/Meninggal). Picker anggota di
 * transaksi lain TIDAK disentuh — `listAnggota()` tetap `LIMIT 50`
 * default kalau `semuaData` tidak diisi, jadi tidak ada perubahan
 * perilaku di tempat lain yang sengaja membatasi.
 */
export default function AnggotaListScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const koperasi = useAppStore((s) => s.koperasi);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusAnggota | null>(null);
  const [data, setData] = useState<Anggota[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (search: string, status: StatusAnggota | null) => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listAnggota({ search, status: status ?? undefined, semuaData: true });
      setData(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat data anggota.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => load(query, statusFilter), 250); // debounce search
    return () => clearTimeout(timeout);
  }, [query, statusFilter, load]);

  useEffect(() => {
    // BUG SEBELUMNYA: daftar yang ditampilkan (`data`) cuma dimuat ulang
    // saat kata kunci pencarian berubah — jadi kalau ada anggota baru
    // ditambahkan (atau statusnya diubah jadi AKTIF) lalu kembali ke
    // layar ini, daftar yang terlihat tidak berubah sampai user
    // mengetik sesuatu di kolom pencarian. Sekarang daftar otomatis
    // dimuat ulang setiap kali layar ini kembali fokus (mis. setelah
    // simpan di AnggotaForm).
    const unsub = navigation.addListener('focus', () => load(query, statusFilter));
    return unsub;
  }, [navigation, load, query, statusFilter]);

  const ringkas = ringkasDaftarAnggota(data.map((a) => a.status));

  /**
   * Tombol Export di HEADER NAVIGASI, sejajar judul "Anggota"
   * (permintaan pengguna), mengikuti pola yang sudah dipakai layar
   * Simpanan.
   *
   * Sebelumnya tombol ini berada di dalam body layar, satu baris di
   * bawah chip penyaring — jadi ia selalu berada dua baris di bawah
   * judul dan ikut memakan tinggi yang seharusnya milik daftar.
   *
   * `useLayoutEffect` (bukan `useEffect`) supaya tombol sudah
   * terpasang pada frame pertama; dengan `useEffect`, header sempat
   * ter-render sekali tanpa tombol dan terlihat berkedip.
   *
   * Logika export TIDAK berpindah ke sini: `ExportButton` yang sama
   * dipakai apa adanya, hanya variannya yang ringkas.
   */
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <ExportButton
          variant="header"
          data={
            koperasi && data.length > 0
              ? buildDaftarAnggotaExport(
                  { namaKoperasi: koperasi.nama, standarAkuntansi: koperasi.standarAkuntansi },
                  data,
                  getTanggalLokalHariIni()
                )
              : null
          }
        />
      ),
    });
  }, [navigation, koperasi, data]);

  return (
    <View style={styles.container}>
      {/* KOP MODUL — menjelaskan layar ini apa dan berapa banyak yang
          sedang ditampilkan, sebelum pengguna menebaknya dari isi
          daftar. Hitungannya mengikuti pencarian & filter yang sedang
          aktif, sama seperti nomor urut baris. */}
      <View style={styles.kop}>
        <Text style={styles.kopJudul}>{JUDUL_MODUL_ANGGOTA}</Text>
        <Text style={styles.kopSub}>{SUBJUDUL_MODUL_ANGGOTA}</Text>
        {!loading && !error && <Text style={styles.kopHitung}>{ringkas.teks}</Text>}
      </View>

      <View style={styles.alatBaris}>
        <SearchField
          wrapStyle={styles.search}
          placeholder="Cari nama, nomor anggota, atau NIK..."
          value={query}
          onChangeText={setQuery}
        />

        {/* Lima penyaring tidak muat satu baris di layar sempit. Dulu
            ia membungkus jadi dua baris dengan tinggi yang berubah-ubah
            tergantung lebar layar; sekarang tetap SATU baris yang bisa
            digeser mendatar, sehingga tinggi area alat selalu sama dan
            daftar di bawahnya tidak ikut bergeser. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
          keyboardShouldPersistTaps="handled"
        >
          {FILTER_STATUS.map((f) => (
            <TouchableOpacity
              key={f.label}
              style={[styles.filterChip, statusFilter === f.value && styles.filterChipActive]}
              onPress={() => setStatusFilter(f.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: statusFilter === f.value }}
            >
              <Text style={[styles.filterChipText, statusFilter === f.value && styles.filterChipTextActive]}>{f.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

      </View>

      {loading && <ActivityIndicator style={styles.center} />}

      {!loading && error && (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={32} color={colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => load(query, statusFilter)} accessibilityRole="button">
            <Text style={styles.retry}>Coba lagi</Text>
          </TouchableOpacity>
        </View>
      )}

      {!loading && !error && data.length === 0 && (
        <View style={styles.center}>
          <Ionicons name="people-outline" size={32} color={colors.textMuted} />
          <Text style={styles.emptyJudul}>Belum ada anggota</Text>
          <Text style={styles.emptyText}>
            {query.trim() || statusFilter
              ? 'Tidak ada yang cocok dengan pencarian atau penyaring ini.'
              : 'Tekan tombol + di pojok kanan bawah untuk menambah anggota baru.'}
          </Text>
        </View>
      )}

      {!loading && !error && data.length > 0 && (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.daftar}
          renderItem={({ item, index }) => {
            const nada = nadaStatusAnggota(item.status);
            return (
              <TouchableOpacity
                style={styles.kartu}
                onPress={() => navigation.navigate('AnggotaDetail', { anggotaId: item.id })}
                accessibilityRole="button"
              >
                {/*
                  NOMOR URUT TAMPILAN (§E).

                  Diambil dari `index` FlatList — yaitu posisi item pada
                  DAFTAR YANG SEDANG TAMPIL. Konsekuensinya disengaja:
                  saat pencarian atau filter status mempersempit daftar,
                  penomoran ikut menyesuaikan dan selalu mulai dari 1.

                  Yang TIDAK dipakai: `item.id` (primary key) dan
                  `item.nomorAnggota`. Keduanya identitas anggota, bukan
                  posisi — memakainya sebagai nomor urut akan membuat
                  daftar terlihat melompat-lompat setelah difilter, dan
                  mengaburkan beda antara "anggota ke-3 di layar" dengan
                  "anggota nomor AGT-0003".

                  Tidak ada kolom baru di database: penomoran ini murni
                  lapisan presentasi.
                */}
                <Text style={styles.nomorUrut}>{index + 1}</Text>

                {/* Avatar inisial menggantikan baris teks polos: pada
                    daftar panjang, bentuk & huruf jauh lebih cepat
                    dipindai mata daripada deretan teks seukuran sama. */}
                <View style={[styles.avatar, styles[`avatar_${nada}`]]}>
                  <Text style={styles.avatarTeks}>{inisialNama(item.namaLengkap)}</Text>
                </View>

                <View style={styles.rowIsi}>
                  <Text style={styles.nama} numberOfLines={1}>
                    {item.namaLengkap}
                  </Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {item.nomorAnggota}
                  </Text>
                </View>

                {/* Status sebagai lencana berlabel manusiawi, bukan
                    nilai enum mentah "TIDAK_AKTIF" yang membuat daftar
                    terlihat seperti dump tabel. */}
                <View style={[styles.lencana, styles[`lencana_${nada}`]]}>
                  <Text style={[styles.lencanaTeks, styles[`lencanaTeks_${nada}`]]}>
                    {labelStatusAnggota(item.status)}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            );
          }}
        />
      )}

      <TouchableOpacity
        style={[styles.fab, { bottom: 24 + insets.bottom }]}
        onPress={() => navigation.navigate('AnggotaForm')}
        accessibilityLabel="Tambah Anggota"
        accessibilityRole="button"
      >
        <Ionicons name="add" size={28} color={colors.white} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  kop: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  kopJudul: { fontSize: 15, fontWeight: '800', color: colors.primary, letterSpacing: 0.3 },
  kopSub: { fontSize: 11.5, color: colors.textMuted, lineHeight: 17, marginTop: 4 },
  kopHitung: { fontSize: 11.5, color: colors.text, fontWeight: '700', marginTop: spacing.sm },

  alatBaris: { paddingLeft: spacing.md, paddingTop: spacing.md, gap: spacing.sm },
  search: { marginRight: spacing.md },
  filterRow: { flexDirection: 'row', gap: 8, paddingRight: spacing.md },
  filterChip: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  filterChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterChipText: { fontSize: 12, color: colors.text, fontWeight: '600' },
  filterChipTextActive: { color: colors.white },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  errorText: { color: colors.danger, textAlign: 'center' },
  retry: { color: colors.primary, fontWeight: '700' },
  emptyJudul: { fontSize: 14, fontWeight: '700', color: colors.text },
  emptyText: { color: colors.textMuted, textAlign: 'center', lineHeight: 18 },

  daftar: { padding: spacing.md, paddingBottom: 96 },
  kartu: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  /*
   * Lebar tetap 28 agar kolom nomor SEJAJAR antar-baris. Tanpa lebar
   * tetap, "1" dan "10" menggeser nama di sebelahnya dan daftar
   * terlihat bergerigi. `minWidth` dipakai (bukan `width`) supaya
   * nomor tiga digit tetap muat tanpa terpotong.
   */
  nomorUrut: {
    minWidth: 28,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    fontVariant: ['tabular-nums'],
  },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatar_aktif: { backgroundColor: colors.primary },
  avatar_netral: { backgroundColor: colors.textMuted },
  avatar_peringatan: { backgroundColor: colors.warning },
  avatar_berhenti: { backgroundColor: colors.danger },
  avatarTeks: { fontSize: 13, fontWeight: '800', color: colors.white },

  rowIsi: { flex: 1, minWidth: 0 },
  nama: { fontSize: 14.5, fontWeight: '700', color: colors.text },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 2, fontVariant: ['tabular-nums'] },

  lencana: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  lencana_aktif: { backgroundColor: colors.primaryLight },
  lencana_netral: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  lencana_peringatan: { backgroundColor: colors.warningBg },
  lencana_berhenti: { backgroundColor: colors.dangerBg },
  lencanaTeks: { fontSize: 10, fontWeight: '800' },
  lencanaTeks_aktif: { color: colors.primary },
  lencanaTeks_netral: { color: colors.textMuted },
  lencanaTeks_peringatan: { color: colors.warning },
  lencanaTeks_berhenti: { color: colors.danger },

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
});

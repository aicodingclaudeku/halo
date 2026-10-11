import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { listAsetKlasifikasi, AsetKlasifikasiItem } from '@/services/AsetKlasifikasiService';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';

import SearchField from '@/components/SearchField';
/**
 * "Data Klasifikasi Aset" (hub Input Data).
 *
 * Update pasca-Phase 18/19 (permintaan pengguna §B): UI disederhanakan
 * jadi READ-ONLY MURNI — HANYA search + daftar. Form Tambah, edit
 * inline masa manfaat, dan toggle aktif/nonaktif DIHAPUS dari layar
 * ini. Data klasifikasi TETAP dibaca sistem seperti biasa untuk
 * kebutuhan form Pembelian Aset/Saldo Awal Aset Tetap (lihat
 * `AsetKlasifikasiService.listAsetKlasifikasi`, TIDAK diubah).
 *
 * `AsetKlasifikasiService.tambahAsetKlasifikasi()`/`editAsetKlasifikasi()`
 * SENGAJA TIDAK DIHAPUS dari service (masih dipakai test & migration
 * v20 untuk seeding 4 kelompok bawaan) — hanya TIDAK DIPANGGIL lagi
 * dari layar ini, sesuai instruksi eksplisit.
 */
export default function DataKlasifikasiAsetScreen() {
  const [data, setData] = useState<AsetKlasifikasiItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pencarian, setPencarian] = useState('');
  const [filterKelompok, setFilterKelompok] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await listAsetKlasifikasi({ termasukNonaktif: true }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const daftarKelompok = Array.from(new Set(data.map((d) => d.kelompok))).sort();

  const dataTampil = data.filter((d) => {
    if (filterKelompok && d.kelompok !== filterKelompok) return false;
    if (pencarian.trim()) {
      const q = pencarian.trim().toLowerCase();
      if (!d.kelompok.toLowerCase().includes(q) && !d.subKelompok.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Data Klasifikasi Aset</Text>
        <Text style={styles.headerSub}>Master kelompok, sub kelompok & masa manfaat default untuk aset tetap.</Text>
      </View>

      <SearchField
        wrapStyle={styles.searchBox}
        value={pencarian}
        onChangeText={setPencarian}
        placeholder="Cari kelompok atau sub kelompok..."
        placeholderTextColor={colors.placeholder}
      />

      {daftarKelompok.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterRow}
          contentContainerStyle={styles.filterRowContent}
        >
          <TouchableOpacity style={[styles.filterChip, filterKelompok === null && styles.filterChipActive]} onPress={() => setFilterKelompok(null)}>
            <Text style={[styles.filterChipText, filterKelompok === null && styles.filterChipTextActive]} numberOfLines={1}>
              Semua
            </Text>
          </TouchableOpacity>
          {daftarKelompok.map((k) => (
            <TouchableOpacity key={k} style={[styles.filterChip, filterKelompok === k && styles.filterChipActive]} onPress={() => setFilterKelompok(k)}>
              <Text style={[styles.filterChipText, filterKelompok === k && styles.filterChipTextActive]} numberOfLines={1}>
                {k}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {loading && <ActivityIndicator style={{ marginTop: 24 }} />}

      {!loading && (
        <FlatList
          data={dataTampil}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.sm }}
          ListEmptyComponent={<Text style={styles.emptyText}>Tidak ada klasifikasi yang cocok.</Text>}
          renderItem={({ item }) => (
            <View style={[styles.card, !item.aktif && styles.cardNonaktif]}>
              <View style={styles.cardIconCircle}>
                <Ionicons name="cube-outline" size={18} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardKelompok}>{item.kelompok}</Text>
                <Text style={styles.cardSub}>{item.subKelompok}</Text>
                <Text style={styles.cardMasaManfaat}>
                  {item.masaManfaatBulanDefault !== null
                    ? `${item.masaManfaatBulanDefault} bulan masa manfaat`
                    : 'Masa manfaat belum ditentukan'}
                </Text>
              </View>
              <Text style={[styles.statusBadge, item.aktif ? styles.statusAktif : styles.statusNonaktif]}>
                {item.aktif ? 'Aktif' : 'Nonaktif'}
              </Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  headerTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  headerSub: { fontSize: 12, color: colors.textMuted, marginTop: 4, lineHeight: 17 },
  searchBox: { marginHorizontal: spacing.lg, marginBottom: spacing.sm },
  // Perbaikan §7 (permintaan pengguna): tab "Semua"/"Kelompok 1"/dst
  // sebelumnya terpotong. Chip sekarang diberi `flexShrink: 0` supaya
  // tidak ikut mengecil dan memotong teks di dalamnya saat layout
  // dihitung — horizontal ScrollView-nya sendiri sudah benar. Padding
  // ditambah supaya nyaman disentuh di mobile tanpa perlu mengecilkan
  // font.
  filterRow: { marginBottom: spacing.sm, flexGrow: 0 },
  filterRowContent: { paddingHorizontal: spacing.lg, gap: 8, flexDirection: 'row', alignItems: 'center' },
  filterChip: {
    flexShrink: 0,
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 36,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filterChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterChipText: { fontSize: 12, color: colors.text, flexShrink: 0 },
  filterChipTextActive: { color: colors.white },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: 24 },
  card: {
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
  cardNonaktif: { opacity: 0.5 },
  cardIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardKelompok: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  cardSub: { fontSize: 14, color: colors.text, fontWeight: '700', marginTop: 2 },
  cardMasaManfaat: { fontSize: 12, color: colors.primary, marginTop: 2 },
  statusBadge: { fontSize: 11, fontWeight: '700' },
  statusAktif: { color: colors.primary },
  statusNonaktif: { color: colors.danger },
});

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, ActivityIndicator, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  listAllAccounts,
  setAccountActive,
  isAccountInUse,
  AccountFull,
  FilterStatusAkun,
} from '@/repositories/AccountRepository';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import StatusBadge from '@/components/StatusBadge';
import SearchField from '@/components/SearchField';
import { colors, radius, spacing } from '@/theme/colors';
import { formUi } from '@/theme/form';

const KATEGORI_COLOR: Record<string, string> = {
  ASET: '#1976D2',
  LIABILITAS: '#E65100',
  EKUITAS: '#6A1B9A',
  PENDAPATAN: '#2E7D32',
  BEBAN: '#B00020',
};

/**
 * "Daftar Akun / COA" (Phase 17 §Q) — daftar SEMUA akun (termasuk
 * nonaktif, ditandai) dari tabel `account` yang sama dipakai
 * AccountingEngine/AccountMapping/seluruh laporan. Akun baru dari
 * "Input Akun" (AccountFormScreen) otomatis muncul di sini karena baca
 * dari sumber yang sama — bukan daftar terpisah.
 */
export default function AccountListScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);

  const [data, setData] = useState<AccountFull[]>([]);
  const [query, setQuery] = useState('');
  // REQUIREMENT 4 (permintaan pengguna): filter Active / Non-active / All.
  const [filterStatus, setFilterStatus] = useState<FilterStatusAkun>('SEMUA');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await listAllAccounts({ search: query || undefined, status: filterStatus }));
    } finally {
      setLoading(false);
    }
  }, [query, filterStatus]);

  useEffect(() => {
    const timeout = setTimeout(load, 200);
    return () => clearTimeout(timeout);
  }, [load]);

  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation, load]);

  /**
   * REQUIREMENT 4 — tombol "Delete" DIGANTI menjadi Active/Non-active.
   * Confirmation dialog diberikan untuk KEDUA arah (menonaktifkan MAUPUN
   * mengaktifkan kembali), bukan hanya saat menonaktifkan seperti
   * sebelumnya — mengaktifkan akun juga mengubah apa yang boleh dipakai
   * transaksi baru, jadi tetap perlu konfirmasi eksplisit.
   */
  const konfirmasiUbahStatus = async (item: AccountFull) => {
    if (!currentUser) return;
    if (item.isActive) {
      const dipakai = await isAccountInUse(item.id);
      notify(
        'Nonaktifkan Akun',
        dipakai
          ? `Akun "${item.kode} - ${item.nama}" sudah dipakai di jurnal/mapping.\n\nMenonaktifkan akun TIDAK menghapus apa pun: seluruh jurnal, transaksi, dan laporan periode lama tetap utuh dan tetap menampilkan akun ini. Yang berubah hanya satu — akun ini tidak lagi bisa dipilih untuk TRANSAKSI BARU.\n\nLanjutkan?`
          : `Nonaktifkan akun "${item.kode} - ${item.nama}"?\n\nAkun tidak akan bisa dipilih untuk transaksi baru, tapi tetap tersimpan dan bisa diaktifkan kembali kapan saja.`,
        [
          { text: 'Batal', style: 'cancel' },
          { text: 'Nonaktifkan', style: 'destructive', onPress: () => ubahStatus(item, false) },
        ]
      );
    } else {
      notify(
        'Aktifkan Akun',
        `Aktifkan kembali akun "${item.kode} - ${item.nama}"?\n\nSetelah aktif, akun ini kembali muncul di daftar pilihan akun dan bisa dipakai untuk transaksi baru.`,
        [
          { text: 'Batal', style: 'cancel' },
          { text: 'Aktifkan', onPress: () => ubahStatus(item, true) },
        ]
      );
    }
  };

  const ubahStatus = async (item: AccountFull, active: boolean) => {
    if (!currentUser) return;
    setBusyId(item.id);
    try {
      await setAccountActive(currentUser.id, item.id, active);
      await load();
    } catch (e) {
      notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <View style={styles.container}>
      <SearchField
        wrapStyle={styles.searchBox}
        placeholder="Cari kode atau nama akun..."
        placeholderTextColor={colors.placeholder}
        value={query}
        onChangeText={setQuery}
      />

      {/* REQUIREMENT 4 — filter Active / Non-active / All. Ditempatkan
          tepat di bawah pencarian supaya keduanya terbaca sebagai satu
          kelompok kontrol daftar. */}
      <View style={styles.filterRow}>
        {(
          [
            { value: 'SEMUA', label: 'Semua' },
            { value: 'AKTIF', label: 'Aktif' },
            { value: 'NONAKTIF', label: 'Nonaktif' },
          ] as { value: FilterStatusAkun; label: string }[]
        ).map((opt) => {
          const aktif = filterStatus === opt.value;
          return (
            <TouchableOpacity
              key={opt.value}
              style={[styles.filterChip, aktif && styles.filterChipActive]}
              onPress={() => setFilterStatus(opt.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: aktif }}
            >
              <Text style={[styles.filterChipText, aktif && styles.filterChipTextActive]}>{opt.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading && <ActivityIndicator style={{ marginTop: 24 }} />}

      {!loading && (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: spacing.lg, paddingTop: 0, paddingBottom: 100 }}
          ListEmptyComponent={<Text style={styles.emptyText}>Tidak ada akun ditemukan.</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.row, !item.isActive && styles.rowNonaktif]}
              onPress={() => navigation.navigate('AccountForm', { accountId: item.id })}
            >
              <View style={[styles.kategoriDot, { backgroundColor: KATEGORI_COLOR[item.kategori] ?? colors.textMuted }]} />
              <View style={{ flex: 1 }}>
                <View style={styles.rowNamaLine}>
                  <Text style={styles.rowNama} numberOfLines={2}>
                    {item.kode} · {item.nama}
                  </Text>
                </View>
                {/* REQUIREMENT 4 — status ditampilkan sebagai BADGE
                    eksplisit (bukan lagi cuma teks " · Nonaktif" yang
                    tenggelam di baris keterangan). */}
                <View style={styles.badgeRow}>
                  <StatusBadge
                    label={item.isActive ? 'ACTIVE' : 'NON-ACTIVE'}
                    bg={item.isActive ? colors.primaryLight : colors.dangerBg}
                    fg={item.isActive ? colors.primary : colors.danger}
                  />
                  {item.isSystem && <StatusBadge label="AKUN INTI" bg={colors.background} fg={colors.textMuted} />}
                </View>
                <Text style={styles.rowSub}>
                  {item.kategori} · Saldo Normal {item.normalBalance}
                  {item.parentNama ? ` · Induk: ${item.parentNama}` : ''}
                </Text>
              </View>
              {/* REQUIREMENT 4 — tombol Delete (ikon tong sampah) DIGANTI
                  tombol Aktif/Nonaktif berlabel teks. Akun inti (system)
                  tidak punya tombol ini karena dipakai mapping transaksi
                  otomatis — menonaktifkannya akan membuat transaksi
                  otomatis gagal total (ditolak juga di backend, lihat
                  setAccountActive). */}
              {!item.isSystem && (
                <TouchableOpacity
                  style={[styles.statusButton, item.isActive ? styles.statusButtonOff : styles.statusButtonOn]}
                  onPress={() => konfirmasiUbahStatus(item)}
                  disabled={busyId === item.id}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel={
                    item.isActive ? `Nonaktifkan akun ${item.kode}` : `Aktifkan akun ${item.kode}`
                  }
                >
                  {busyId === item.id ? (
                    <ActivityIndicator size="small" color={item.isActive ? colors.danger : colors.primary} />
                  ) : (
                    <>
                      <Ionicons
                        name={item.isActive ? 'pause-circle-outline' : 'play-circle-outline'}
                        size={15}
                        color={item.isActive ? colors.danger : colors.primary}
                      />
                      <Text style={[styles.statusButtonText, { color: item.isActive ? colors.danger : colors.primary }]}>
                        {item.isActive ? 'Nonaktifkan' : 'Aktifkan'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          )}
        />
      )}

      <TouchableOpacity
        style={[styles.fab, { bottom: 24 + insets.bottom }]}
        onPress={() => navigation.navigate('AccountForm', {})}
      >
        <Ionicons name="add" size={26} color={colors.white} />
      </TouchableOpacity>
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
  rowNonaktif: { opacity: 0.6, backgroundColor: colors.background },
  rowNamaLine: { flexDirection: 'row', alignItems: 'center' },
  badgeRow: { flexDirection: 'row', gap: spacing.xs, marginTop: 4, flexWrap: 'wrap' },
  filterRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filterChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterChipText: { fontSize: 12, color: colors.text, fontWeight: '600' },
  filterChipTextActive: { color: colors.white },
  statusButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1,
    minWidth: 104,
    justifyContent: 'center',
  },
  statusButtonOff: { borderColor: colors.danger, backgroundColor: colors.dangerBg },
  statusButtonOn: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  statusButtonText: { fontSize: 11, fontWeight: '700' },
  kategoriDot: { width: 10, height: 10, borderRadius: 5 },
  rowNama: { fontSize: 14, color: colors.text, fontWeight: '600' },
  rowSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  fab: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
});

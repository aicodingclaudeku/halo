import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View, Text, SectionList, TouchableOpacity, ActivityIndicator, StyleSheet, RefreshControl } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { listUsers, updateUserStatus, hapusUser, UserItem } from '@/services/UserManagementService';
import { ROLE_LABEL } from '@/config/defaultPermissions';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import EmptyState from '@/components/report/EmptyState';
import SearchField from '@/components/SearchField';
import { IKON_ROLE } from './ikonRole';
import { colors, elevation, radius, spacing, touchTarget, typography } from '@/theme/colors';

/** Dua huruf awal nama untuk avatar — hanya tampilan. */
function inisial(nama: string): string {
  const kata = nama.trim().split(/\s+/).filter(Boolean);
  if (kata.length === 0) return '?';
  const a = kata[0][0] ?? '';
  const b = kata.length > 1 ? kata[kata.length - 1][0] ?? '' : kata[0][1] ?? '';
  return (a + b).toUpperCase();
}

/**
 * Daftar user + kelola status — Admin only (fase 8 §1, §7-8).
 *
 * RC-S122 — TAMPILAN DIRAPIKAN (permintaan pengguna):
 *  - warna per role yang dulu memakai hex lepas ('#F57C00', '#6A1B9A')
 *    diganti ikon per role (`ikonRole.ts`) di samping labelnya;
 *  - ringkasan di atas: jumlah user, yang aktif, dan yang password-nya
 *    masih sama dengan PIN lama;
 *  - daftar dikelompokkan Aktif / Nonaktif; kartu dengan avatar inisial,
 *    role (ikon + label), dan badge status;
 *  - aksi dibuat eksplisit: "Sunting" dan "Nonaktifkan"/"Aktifkan" sebagai
 *    tombol berlabel. Dulu status ditampilkan sebagai pil "Aktif" yang
 *    ternyata tombol — tampak seperti badge, padahal mengubah akun;
 *  - akun yang sedang dipakai ditandai "Anda" dan TIDAK diberi tombol
 *    nonaktifkan, supaya admin tidak mengunci dirinya sendiri dari
 *    aplikasi (service hanya menjaga Admin terakhir);
 *  - perbaikan tata letak: kartu sebelumnya `flexDirection: 'row'`,
 *    sehingga peringatan password & tombol Sunting tampil berdampingan
 *    dengan identitas user, bukan di bawahnya;
 *  - dialog "Ubah Role" yang tidak pernah dapat dibuka (tidak ada
 *    pemanggil `setGantiRoleUser(user)`) DIHAPUS; role diubah lewat
 *    Sunting (UserFormScreen, RC-S117);
 *  - tombol tambah berlabel, tarik-untuk-muat-ulang, dan tombol "Coba
 *    lagi" saat gagal memuat.
 * `listUsers`, `updateUserStatus`, dan aturan izin TIDAK diubah.
 */
export default function UserManagementScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const [data, setData] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cari, setCari] = useState('');

  const load = useCallback(async () => {
    if (!currentUser) return;
    setError(null);
    try {
      const rows = await listUsers(currentUser.id);
      setData(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal memuat daftar user.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentUser]);

  useEffect(() => {
    const unsub = navigation.addListener('focus', load);
    return unsub;
  }, [navigation, load]);

  const muatUlang = () => {
    setRefreshing(true);
    load();
  };

  const toggleAktif = (user: UserItem) => {
    if (!currentUser) return;
    notify(
      user.aktif ? 'Nonaktifkan User' : 'Aktifkan User',
      user.aktif
        ? `${user.nama} tidak akan bisa masuk sampai diaktifkan kembali. Data dan riwayat transaksinya tetap tersimpan.`
        : `${user.nama} akan dapat masuk kembali dengan username dan password yang sama.`,
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: user.aktif ? 'Nonaktifkan' : 'Aktifkan',
          style: user.aktif ? 'destructive' : 'default',
          onPress: async () => {
            try {
              await updateUserStatus(currentUser.id, user.id, !user.aktif);
              await load();
            } catch (e) {
              notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
            }
          },
        },
      ]
    );
  };

  /**
   * RC-S133.5 — HAPUS user. Akun hilang dari daftar dan tidak bisa masuk
   * lagi; nama pembuat pada riwayat transaksi tetap tampil (lihat
   * `hapusUser`). Dua kali konfirmasi lewat dialog: tindakan tak bisa dibatalkan.
   */
  const hapus = (user: UserItem) => {
    if (!currentUser) return;
    notify(
      'Hapus user?',
      `Akun ${user.nama} (@${user.username}) akan dihapus dan tidak dapat masuk lagi. Riwayat transaksi yang pernah dicatatnya tetap tersimpan dengan namanya.` +
        (user.role === 'ANGGOTA' ? ' Anggota ini dapat dibuatkan akun baru kemudian.' : '') +
        ' Tindakan ini tidak dapat dibatalkan.',
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Hapus',
          style: 'destructive',
          onPress: async () => {
            try {
              await hapusUser(currentUser.id, user.id);
              await load();
              notify('User dihapus', `Akun ${user.nama} sudah dihapus.`, undefined, 'success');
            } catch (e) {
              notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.');
            }
          },
        },
      ]
    );
  };

  const ringkas = useMemo(
    () => ({
      total: data.length,
      aktif: data.filter((u) => u.aktif).length,
      warisan: data.filter((u) => u.passwordWarisan || u.wajibGantiPassword).length,
    }),
    [data]
  );

  /**
   * RC-S133.5 — setelah akun anggota dibuat massal daftar bisa ratusan baris:
   * pengurus & staf ditaruh paling atas (terpisah dari akun Anggota) dan ada
   * kolom cari (nama, username, nomor anggota).
   */
  const bagian = useMemo(() => {
    const q = cari.trim().toLowerCase();
    const cocok = (u: UserItem) =>
      !q ||
      u.nama.toLowerCase().includes(q) ||
      u.username.toLowerCase().includes(q) ||
      (u.nomorAnggota ?? '').toLowerCase().includes(q);
    const tampil = data.filter(cocok);
    const staf = tampil.filter((u) => u.aktif && u.role !== 'ANGGOTA');
    const anggota = tampil.filter((u) => u.aktif && u.role === 'ANGGOTA');
    const nonaktif = tampil.filter((u) => !u.aktif);
    const adaAnggota = data.some((u) => u.role === 'ANGGOTA');
    return [
      ...(staf.length > 0 ? [{ judul: adaAnggota ? 'Pengurus & staf' : 'Aktif', data: staf }] : []),
      ...(anggota.length > 0 ? [{ judul: 'Akun anggota', data: anggota }] : []),
      ...(nonaktif.length > 0 ? [{ judul: 'Nonaktif', data: nonaktif }] : []),
    ];
  }, [data, cari]);

  if (loading) {
    return (
      <View style={styles.tengah}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.tengah}>
        <Ionicons name="cloud-offline-outline" size={32} color={colors.textFaint} />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity
          style={styles.tombolUlang}
          onPress={() => {
            setLoading(true);
            load();
          }}
          accessibilityRole="button"
        >
          <Ionicons name="refresh" size={16} color={colors.primary} />
          <Text style={styles.tombolUlangTeks}>Coba lagi</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <SectionList
        sections={bagian}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={[styles.isi, { paddingBottom: 96 + insets.bottom }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={muatUlang} colors={[colors.primary]} />}
        ListHeaderComponent={
          <View>
          {/* RC-S133.5 — buat akun untuk semua anggota sekaligus. */}
          <TouchableOpacity
            style={styles.kartuMassal}
            onPress={() => navigation.navigate('AkunAnggotaMassal')}
            accessibilityRole="button"
            accessibilityLabel="Buat akun semua anggota"
            testID="buka-akun-anggota-massal"
          >
            <View style={styles.kartuMassalIkon}>
              <Ionicons name="people-circle-outline" size={22} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.kartuMassalJudul}>Buat akun semua anggota</Text>
              <Text style={styles.kartuMassalKet}>Username & password acak atau sama, sekaligus untuk semua anggota yang belum punya akun.</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </TouchableOpacity>
          {data.length > 0 ? (
            <View style={styles.statBaris}>
              <Stat label="Total user" nilai={ringkas.total} ikon="people-outline" />
              <Stat label="Aktif" nilai={ringkas.aktif} ikon="checkmark-circle-outline" />
              <Stat
                label="Perlu ganti password"
                nilai={ringkas.warisan}
                ikon="key-outline"
                peringatan={ringkas.warisan > 0}
              />
            </View>
          ) : null}
          {data.length > 8 ? (
            <SearchField
              wrapStyle={styles.cari}
              placeholder="Cari nama, username, atau nomor anggota…"
              value={cari}
              onChangeText={setCari}
              autoCapitalize="none"
              autoCorrect={false}
              testID="cari-user"
            />
          ) : null}
          {cari.trim() && bagian.length === 0 ? (
            <Text style={styles.cariKosong}>Tidak ada user yang cocok dengan “{cari.trim()}”.</Text>
          ) : null}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.bagianJudul} accessibilityRole="header">
            {section.judul} ({section.data.length})
          </Text>
        )}
        renderItem={({ item }) => {
          const akunSaya = item.id === currentUser?.id;
          return (
            <View style={[styles.card, !item.aktif && styles.cardNonAktif]}>
              <View style={styles.kartuBaris}>
                <View style={[styles.avatar, !item.aktif && styles.avatarNonaktif]}>
                  <Text style={[styles.avatarTeks, !item.aktif && styles.avatarTeksNonaktif]}>{inisial(item.nama)}</Text>
                </View>
                <View style={styles.identitas}>
                  <View style={styles.namaBaris}>
                    <Text style={styles.nama} numberOfLines={1}>
                      {item.nama}
                    </Text>
                    {akunSaya ? <Text style={styles.tandaAnda}>Anda</Text> : null}
                  </View>
                  <Text style={styles.username} numberOfLines={1}>
                    @{item.username}
                  </Text>
                  <View style={styles.metaBaris}>
                    <View style={styles.role}>
                      <Ionicons name={IKON_ROLE[item.role] as keyof typeof Ionicons.glyphMap} size={13} color={colors.primary} />
                      <Text style={styles.roleTeks}>{ROLE_LABEL[item.role]}</Text>
                    </View>
                    {/* RC-S132 — akun Anggota: tampilkan tautannya ke data anggota. */}
                    {item.role === 'ANGGOTA' ? (
                      <View style={styles.role}>
                        <Ionicons
                          name={item.anggotaId ? 'link-outline' : 'unlink-outline'}
                          size={13}
                          color={item.anggotaId ? colors.primary : colors.warning}
                        />
                        <Text style={[styles.roleTeks, !item.anggotaId && { color: colors.warning }]}>
                          {item.anggotaId ? `No. ${item.nomorAnggota ?? '-'}` : 'Belum ditautkan'}
                        </Text>
                      </View>
                    ) : null}
                    <View style={[styles.status, item.aktif ? styles.statusAktif : styles.statusNonaktif]}>
                      <View style={[styles.statusTitik, { backgroundColor: item.aktif ? colors.success : colors.textFaint }]} />
                      <Text style={[styles.statusTeks, { color: item.aktif ? colors.success : colors.textMuted }]}>
                        {item.aktif ? 'Aktif' : 'Nonaktif'}
                      </Text>
                    </View>
                  </View>
                </View>
              </View>

              {/* RC-S117 — ditandai apa adanya, bukan disembunyikan:
                  password hasil migrasi masih berupa PIN 6 digit lama
                  dan belum memenuhi kebijakan password baru. Admin
                  berhak tahu mana yang masih perlu diganti. */}
              {item.wajibGantiPassword ? (
                <View style={styles.tandaWarisan}>
                  <Ionicons name="key-outline" size={14} color={colors.warning} />
                  <Text style={styles.tandaWarisanTeks}>Password sementara — wajib diganti pemiliknya saat masuk pertama.</Text>
                </View>
              ) : null}
              {item.passwordWarisan && (
                <View style={styles.tandaWarisan}>
                  <Ionicons name="alert-circle-outline" size={14} color={colors.warning} />
                  <Text style={styles.tandaWarisanTeks}>
                    Password masih sama dengan PIN lama — sebaiknya diganti lewat Sunting.
                  </Text>
                </View>
              )}

              <View style={styles.aksiBaris}>
                {/* Tombol Sunting: sebelumnya hanya role yang bisa diubah,
                    lewat dialog terpisah. Salah ketik nama atau username
                    berarti user harus dinonaktifkan dan dibuat ulang —
                    yang memutus jejak audit atas namanya. */}
                <TouchableOpacity
                  style={styles.aksi}
                  onPress={() => navigation.navigate('UserForm', { userId: item.id })}
                  accessibilityRole="button"
                  accessibilityLabel={`Sunting ${item.nama}`}
                >
                  <Ionicons name="create-outline" size={16} color={colors.primary} />
                  <Text style={styles.aksiTeks}>Sunting</Text>
                </TouchableOpacity>
                {akunSaya ? (
                  <View style={[styles.aksi, styles.aksiDiam]}>
                    <Ionicons name="lock-closed-outline" size={14} color={colors.textMuted} />
                    <Text style={styles.aksiDiamTeks}>Akun yang sedang dipakai</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[styles.aksi, item.aktif && styles.aksiBahaya]}
                    onPress={() => toggleAktif(item)}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.aktif ? 'Nonaktifkan' : 'Aktifkan'} ${item.nama}`}
                  >
                    <Ionicons
                      name={item.aktif ? 'pause-circle-outline' : 'play-circle-outline'}
                      size={16}
                      color={item.aktif ? colors.danger : colors.primary}
                    />
                    <Text style={[styles.aksiTeks, item.aktif && { color: colors.danger }]}>
                      {item.aktif ? 'Nonaktifkan' : 'Aktifkan'}
                    </Text>
                  </TouchableOpacity>
                )}
                {akunSaya ? null : (
                  <TouchableOpacity
                    style={[styles.aksi, styles.aksiBahaya]}
                    onPress={() => hapus(item)}
                    accessibilityRole="button"
                    accessibilityLabel={`Hapus ${item.nama}`}
                    testID={`hapus-user-${item.username}`}
                  >
                    <Ionicons name="trash-outline" size={16} color={colors.danger} />
                    <Text style={[styles.aksiTeks, { color: colors.danger }]}>Hapus</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <EmptyState icon="people-outline" title="Belum ada user" message="Tambahkan user untuk petugas, bendahara, atau pengurus koperasi." />
        }
      />

      <TouchableOpacity
        style={[styles.fab, { bottom: spacing.xl + insets.bottom }]}
        onPress={() => navigation.navigate('UserForm')}
        accessibilityRole="button"
        accessibilityLabel="Tambah user"
      >
        <Ionicons name="person-add-outline" size={20} color={colors.white} />
        <Text style={styles.fabTeks}>Tambah User</Text>
      </TouchableOpacity>
    </View>
  );
}

function Stat({
  label,
  nilai,
  ikon,
  peringatan,
}: {
  label: string;
  nilai: number;
  ikon: keyof typeof Ionicons.glyphMap;
  peringatan?: boolean;
}) {
  return (
    <View style={[styles.stat, peringatan && styles.statPeringatan]} accessible accessibilityLabel={`${label}: ${nilai}`}>
      <Ionicons name={ikon} size={16} color={peringatan ? colors.warning : colors.primary} />
      <Text style={styles.statNilai}>{nilai}</Text>
      <Text style={styles.statLabel} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  kartuMassal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  kartuMassalIkon: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  kartuMassalJudul: { fontSize: typography.body, fontWeight: '700', color: colors.text },
  kartuMassalKet: { fontSize: typography.caption, color: colors.textMuted, marginTop: 2, lineHeight: 16 },
  tengah: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md, backgroundColor: colors.background },
  errorText: { color: colors.danger, textAlign: 'center', fontSize: typography.body, lineHeight: 20 },
  tombolUlang: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: touchTarget,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  tombolUlangTeks: { color: colors.primary, fontWeight: '700', fontSize: typography.subtitle },
  isi: { padding: spacing.lg },
  statBaris: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  cari: { marginTop: spacing.xs, marginBottom: spacing.xs },
  cariKosong: { color: colors.textMuted, fontSize: 13, textAlign: 'center', paddingVertical: spacing.lg },
  stat: {
    flex: 1,
    minWidth: 0,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  statPeringatan: { backgroundColor: colors.warningBg, borderColor: colors.warningBorder },
  statNilai: { fontSize: 22, fontWeight: '700', color: colors.text, marginTop: spacing.xs, fontVariant: ['tabular-nums'] },
  statLabel: { fontSize: 11.5, color: colors.textMuted, lineHeight: 15 },
  bagianJudul: {
    fontSize: typography.caption,
    fontWeight: '700',
    color: colors.textMuted,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    ...elevation.card,
  },
  cardNonAktif: { backgroundColor: colors.background },
  kartuBaris: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarNonaktif: { backgroundColor: colors.border },
  avatarTeks: { fontSize: 15, fontWeight: '700', color: colors.primary },
  avatarTeksNonaktif: { color: colors.textMuted },
  identitas: { flex: 1, minWidth: 0 },
  namaBaris: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  nama: { flexShrink: 1, fontSize: 15, fontWeight: '700', color: colors.text },
  tandaAnda: {
    fontSize: 10.5,
    fontWeight: '700',
    color: colors.primary,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  username: { fontSize: typography.caption, color: colors.textMuted, marginTop: 1 },
  metaBaris: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  role: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  roleTeks: { fontSize: typography.caption, fontWeight: '600', color: colors.text },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  statusAktif: { backgroundColor: colors.primaryLight },
  statusNonaktif: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  statusTitik: { width: 6, height: 6, borderRadius: 3 },
  statusTeks: { fontSize: 11, fontWeight: '700' },
  tandaWarisan: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    marginTop: spacing.md,
  },
  tandaWarisanTeks: { flex: 1, minWidth: 0, fontSize: 11.5, color: colors.text, lineHeight: 16 },
  aksiBaris: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  aksi: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    minHeight: touchTarget - 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  aksiBahaya: { borderColor: colors.dangerBg },
  aksiTeks: { fontSize: typography.subtitle, fontWeight: '700', color: colors.primary },
  aksiDiam: { backgroundColor: colors.background, borderStyle: 'dashed' },
  aksiDiamTeks: { fontSize: 11.5, color: colors.textMuted, fontWeight: '600' },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.lg + 2,
    borderRadius: 26,
    backgroundColor: colors.primary,
    ...elevation.card,
    elevation: 4,
  },
  fabTeks: { color: colors.white, fontWeight: '700', fontSize: 14 },
});

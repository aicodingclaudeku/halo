import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  getPermissionMatrix,
  getPermissionsForRole,
  terapkanKlikIzin,
  pulihkanIzinDefaultRole,
  updateRolePermission,
  PermissionMatrixRow,
} from '@/services/PermissionService';
import {
  AKSI_LABEL,
  DEFAULT_ROLE_PERMISSIONS,
  PermissionSet,
  RESOURCE_KETERANGAN,
  RESOURCE_LABEL,
  RESOURCES,
  ROLES,
  ROLE_LABEL,
  Role,
  Resource,
} from '@/config/defaultPermissions';
import { useAppStore } from '@/store/useAppStore';
import { notify } from '@/store/useNotifyStore';
import { colors, radius, spacing } from '@/theme/colors';
import { IKON_ROLE } from './ikonRole';

type KunciAksi = keyof PermissionSet;

const AKSI: { key: KunciAksi; label: string; ikon: string }[] = [
  { key: 'canView', label: AKSI_LABEL.view, ikon: 'eye-outline' },
  { key: 'canCreate', label: AKSI_LABEL.create, ikon: 'add-circle-outline' },
  { key: 'canEdit', label: AKSI_LABEL.edit, ikon: 'create-outline' },
  { key: 'canApprove', label: AKSI_LABEL.approve, ikon: 'checkmark-done-outline' },
  { key: 'canExport', label: AKSI_LABEL.export, ikon: 'download-outline' },
];

/** Penjelasan singkat tiap role — membantu Admin memahami maksud bawaan. */
const PERAN_KETERANGAN: Record<Role, string> = {
  ADMIN: 'Pengelola aplikasi. Izin selalu penuh dan dikunci agar koperasi tidak kehilangan akses pengelola.',
  PENGURUS: 'Pengurus koperasi: memantau dan menyetujui, umumnya tanpa input transaksi harian.',
  BENDAHARA: 'Mengelola keuangan: transaksi kas, simpanan, pinjaman, dan laporan.',
  PETUGAS: 'Petugas loket: mencatat transaksi harian anggota.',
  ANGGOTA: 'Akun anggota yang ditautkan ke data anggota: hanya melihat data dirinya sendiri lewat Portal Anggota.',
};

const samaIzin = (a: PermissionSet, b: PermissionSet) => AKSI.every(({ key }) => a[key] === b[key]);

/**
 * Permission Matrix — lihat & atur izin per role (fase 8 §3, §8).
 *
 * RC-S132: matrix kini BENAR-BENAR berlaku di aplikasi — selain service
 * (`requirePermission`), menu, tab, dan layar disaring sesuai izin
 * (`navigation/izinRute.ts`). Perubahan untuk role yang sedang login
 * langsung diterapkan ke sesi berjalan (cache `useAppStore.permissions`).
 */
export default function PermissionMatrixScreen() {
  const currentUser = useAppStore((s) => s.currentUser);
  const setPermissions = useAppStore((s) => s.setPermissions);
  const [roleTerpilih, setRoleTerpilih] = useState<Role>('PENGURUS');
  const [matrix, setMatrix] = useState<PermissionMatrixRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Resource | 'SEMUA' | null>(null);

  const load = useCallback(async () => {
    const rows = await getPermissionMatrix();
    setMatrix(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const barisUntukRole = useMemo(() => matrix.filter((m) => m.role === roleTerpilih), [matrix, roleTerpilih]);
  // RC-S133.5 — Anggota juga tetap: akunnya hanya membuka Portal Anggota (data diri sendiri).
  const peranAnggota = roleTerpilih === 'ANGGOTA';
  const terkunci = roleTerpilih === 'ADMIN' || peranAnggota;

  const ringkasan = useMemo(() => {
    const dilihat = barisUntukRole.filter((b) => b.permission.canView).length;
    const menulis = barisUntukRole.filter((b) => b.permission.canCreate || b.permission.canEdit).length;
    const ubahanDariDefault = barisUntukRole.filter(
      (b) => !samaIzin(b.permission, DEFAULT_ROLE_PERMISSIONS[roleTerpilih][b.resource])
    ).length;
    return { dilihat, menulis, ubahanDariDefault };
  }, [barisUntukRole, roleTerpilih]);

  /** Sesi berjalan memakai role yang baru diubah -> segarkan cache izin agar menu/tab langsung menyesuaikan. */
  const segarkanIzinSesi = async (role: Role) => {
    if (currentUser && currentUser.role === role) setPermissions(await getPermissionsForRole(role));
  };

  const toggle = async (resource: Resource, aksi: KunciAksi) => {
    if (!currentUser || terkunci || saving) return;
    const baris = barisUntukRole.find((b) => b.resource === resource);
    if (!baris) return;

    const permissionBaru = terapkanKlikIzin(baris.permission, aksi);
    // Optimistis: chip langsung berubah; dikembalikan dari database bila gagal.
    setMatrix((m) => m.map((r) => (r.role === roleTerpilih && r.resource === resource ? { ...r, permission: permissionBaru } : r)));
    setSaving(resource);
    try {
      await updateRolePermission(currentUser.id, roleTerpilih, resource, permissionBaru);
      await segarkanIzinSesi(roleTerpilih);
    } catch (e) {
      notify('Gagal menyimpan izin', e instanceof Error ? e.message : 'Terjadi kesalahan.', undefined, 'error');
    } finally {
      await load();
      setSaving(null);
    }
  };

  const pulihkan = () => {
    if (!currentUser || terkunci) return;
    notify(
      'Pulihkan izin bawaan?',
      `Seluruh izin role ${ROLE_LABEL[roleTerpilih]} dikembalikan ke pengaturan bawaan aplikasi. Perubahan yang pernah Anda buat untuk role ini akan hilang.`,
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Pulihkan',
          style: 'destructive',
          onPress: async () => {
            setSaving('SEMUA');
            try {
              await pulihkanIzinDefaultRole(currentUser.id, roleTerpilih);
              await segarkanIzinSesi(roleTerpilih);
              notify('Izin dipulihkan', `Izin role ${ROLE_LABEL[roleTerpilih]} kembali ke bawaan.`, undefined, 'success');
            } catch (e) {
              notify('Gagal', e instanceof Error ? e.message : 'Terjadi kesalahan.', undefined, 'error');
            } finally {
              await load();
              setSaving(null);
            }
          },
        },
      ],
      'warning'
    );
  };

  return (
    <View style={styles.layar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.roleTabBar}
        contentContainerStyle={styles.roleTabIsi}
      >
        {ROLES.map((role) => {
          const aktif = roleTerpilih === role;
          return (
            <TouchableOpacity
              key={role}
              style={[styles.roleTab, aktif && styles.roleTabActive]}
              onPress={() => setRoleTerpilih(role)}
              accessibilityRole="tab"
              accessibilityState={{ selected: aktif }}
            >
              <Ionicons
                name={IKON_ROLE[role] as keyof typeof Ionicons.glyphMap}
                size={14}
                color={aktif ? colors.white : colors.primary}
              />
              <Text style={[styles.roleTabText, aktif && styles.roleTabTextActive]}>{ROLE_LABEL[role]}</Text>
              {role === 'ADMIN' || role === 'ANGGOTA' ? (
                <Ionicons name="lock-closed" size={11} color={aktif ? colors.white : colors.textFaint} />
              ) : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {loading ? (
        <ActivityIndicator style={styles.center} color={colors.primary} />
      ) : (
        <ScrollView style={styles.container} contentContainerStyle={styles.isi}>
          <View style={styles.ringkasKartu}>
            <View style={styles.ringkasKepala}>
              <View style={styles.ringkasIkon}>
                <Ionicons name={IKON_ROLE[roleTerpilih] as keyof typeof Ionicons.glyphMap} size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.ringkasJudul}>{ROLE_LABEL[roleTerpilih]}</Text>
                <Text style={styles.ringkasKet}>{PERAN_KETERANGAN[roleTerpilih]}</Text>
              </View>
            </View>
            {peranAnggota ? null : (
            <View style={styles.statBaris}>
              <View style={styles.stat}>
                <Text style={styles.statAngka}>{ringkasan.dilihat}/{RESOURCES.length}</Text>
                <Text style={styles.statLabel}>modul terbuka</Text>
              </View>
              <View style={styles.statPemisah} />
              <View style={styles.stat}>
                <Text style={styles.statAngka}>{ringkasan.menulis}</Text>
                <Text style={styles.statLabel}>modul bisa input</Text>
              </View>
              <View style={styles.statPemisah} />
              <View style={styles.stat}>
                <Text style={styles.statAngka}>{ringkasan.ubahanDariDefault}</Text>
                <Text style={styles.statLabel}>beda dari bawaan</Text>
              </View>
            </View>
            )}
            {peranAnggota ? (
              <View style={styles.kunciBaris}>
                <Ionicons name="person-circle-outline" size={14} color={colors.primary} />
                <Text style={styles.kunciTeks}>
                  Akun Anggota hanya melihat data dirinya sendiri — sesuai anggota yang dipilih saat akun dibuat di User Management.
                </Text>
              </View>
            ) : terkunci ? (
              <View style={styles.kunciBaris}>
                <Ionicons name="lock-closed" size={14} color={colors.warning} />
                <Text style={styles.kunciTeks}>Role Admin selalu memiliki izin penuh dan tidak bisa diubah dari sini.</Text>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.tombolPulihkan, (ringkasan.ubahanDariDefault === 0 || !!saving) && styles.tombolNonaktif]}
                onPress={pulihkan}
                disabled={ringkasan.ubahanDariDefault === 0 || !!saving}
                accessibilityRole="button"
                accessibilityLabel="Pulihkan izin bawaan"
              >
                {saving === 'SEMUA' ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Ionicons name="refresh-outline" size={15} color={colors.primary} />
                )}
                <Text style={styles.tombolPulihkanTeks}>Pulihkan izin bawaan</Text>
              </TouchableOpacity>
            )}
          </View>

          {peranAnggota ? (
            <View style={styles.legenda} testID="matrix-anggota-data-sendiri">
              <Text style={styles.legendaJudul}>Yang dilihat akun Anggota (Portal Anggota)</Text>
              {[
                'Profil: nama, nomor anggota, tanggal bergabung',
                'Saldo simpanan miliknya (pokok, wajib, sukarela, dan kontrak simpanannya)',
                'Pinjaman miliknya: sisa pokok, sisa jasa, jadwal angsuran',
                'Riwayat transaksinya sendiri',
                'SHU miliknya yang sudah disahkan RAT',
              ].map((t) => (
                <View key={t} style={styles.legendaItem}>
                  <Ionicons name="checkmark-circle" size={13} color={colors.primary} />
                  <Text style={styles.legendaTeks}>{t}</Text>
                </View>
              ))}
              <Text style={[styles.legendaTeks, { marginTop: 6 }]}>
                Tidak dapat membuka data anggota lain, Dashboard & laporan koperasi, transaksi, maupun pengaturan. Tidak dapat menginput atau
                mengubah data. Data diambil dari anggota yang ditautkan ke akunnya — bukan dari pilihan di layar.
              </Text>
            </View>
          ) : null}

          {peranAnggota ? null : (
          <View style={styles.legenda}>
            <Text style={styles.legendaJudul}>Cara kerja</Text>
            <Text style={styles.legendaTeks}>
              Ketuk chip untuk menyalakan/mematikan izin; tersimpan otomatis. Modul tanpa izin <Text style={styles.tebal}>Lihat</Text> disembunyikan dari menu dan
              layarnya menampilkan "Akses dibatasi". Menyalakan Buat, Ubah, Setuju, atau Export otomatis menyalakan Lihat; mematikan Lihat menutup modul sepenuhnya.
            </Text>
            <View style={styles.legendaChipBaris}>
              {AKSI.map((a) => (
                <View key={a.key} style={styles.legendaItem}>
                  <Ionicons name={a.ikon as keyof typeof Ionicons.glyphMap} size={12} color={colors.textMuted} />
                  <Text style={styles.legendaItemTeks}>{a.label}</Text>
                </View>
              ))}
            </View>
          </View>

          )}

          {peranAnggota ? null : RESOURCES.map((resource) => {
            const baris = barisUntukRole.find((b) => b.resource === resource);
            if (!baris) return null;
            const tertutup = !baris.permission.canView;
            const beda = !samaIzin(baris.permission, DEFAULT_ROLE_PERMISSIONS[roleTerpilih][resource]);
            return (
              <View key={resource} style={[styles.resourceCard, tertutup && styles.resourceCardTertutup]}>
                <View style={styles.resourceHeader}>
                  <View style={{ flex: 1 }}>
                    <View style={styles.resourceJudulBaris}>
                      <Text style={styles.resourceLabel}>{RESOURCE_LABEL[resource]}</Text>
                      {tertutup ? (
                        <View style={styles.lencanaTertutup}>
                          <Text style={styles.lencanaTertutupTeks}>Tertutup</Text>
                        </View>
                      ) : null}
                      {beda && !terkunci ? (
                        <View style={styles.lencanaUbah}>
                          <Text style={styles.lencanaUbahTeks}>Diubah</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={styles.resourceKet}>{RESOURCE_KETERANGAN[resource]}</Text>
                  </View>
                  {saving === resource && <ActivityIndicator size="small" color={colors.primary} />}
                </View>
                <View style={styles.aksiRow}>
                  {AKSI.map((aksi) => {
                    const nyala = baris.permission[aksi.key];
                    return (
                      <TouchableOpacity
                        key={aksi.key}
                        style={[styles.aksiChip, nyala && styles.aksiChipActive, terkunci && styles.aksiChipTerkunci]}
                        onPress={() => toggle(resource, aksi.key)}
                        disabled={terkunci}
                        accessibilityRole="switch"
                        accessibilityState={{ checked: nyala, disabled: terkunci }}
                        accessibilityLabel={`${aksi.label} ${RESOURCE_LABEL[resource]}`}
                      >
                        <Ionicons
                          name={(nyala ? 'checkmark-circle' : aksi.ikon) as keyof typeof Ionicons.glyphMap}
                          size={13}
                          color={nyala ? colors.white : colors.textMuted}
                        />
                        <Text style={[styles.aksiChipText, nyala && styles.aksiChipTextActive]}>{aksi.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            );
          })}
          <Text style={styles.catatanAkhir}>
            Izin juga diperiksa ulang saat menyimpan data, jadi role tanpa izin tidak dapat menulis meskipun membuka layar lewat jalan pintas.
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  layar: { flex: 1, backgroundColor: colors.background },
  container: { flex: 1, backgroundColor: colors.background },
  isi: { padding: spacing.lg, paddingBottom: spacing.xl * 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  roleTabBar: { flexGrow: 0, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  roleTabIsi: { paddingHorizontal: spacing.md, paddingVertical: 10, gap: 8 },
  roleTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  roleTabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  roleTabText: { fontSize: 13, color: colors.text, fontWeight: '600' },
  roleTabTextActive: { color: colors.white, fontWeight: '700' },

  ringkasKartu: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  ringkasKepala: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  ringkasIkon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringkasJudul: { fontSize: 16, fontWeight: '800', color: colors.text },
  ringkasKet: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: 2 },
  statBaris: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.md,
    backgroundColor: colors.background,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
  },
  stat: { flex: 1, alignItems: 'center' },
  statAngka: { fontSize: 16, fontWeight: '800', color: colors.primary },
  statLabel: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  statPemisah: { width: 1, alignSelf: 'stretch', backgroundColor: colors.border },
  kunciBaris: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.md,
    backgroundColor: colors.warningBg,
    borderRadius: radius.sm,
    padding: spacing.sm,
  },
  kunciTeks: { flex: 1, fontSize: 12, color: colors.text, lineHeight: 17 },
  tombolPulihkan: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: spacing.md,
    minHeight: 40,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  tombolNonaktif: { opacity: 0.45 },
  tombolPulihkanTeks: { fontSize: 13, fontWeight: '700', color: colors.primary },

  legenda: {
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  legendaJudul: { fontSize: 12, fontWeight: '800', color: colors.primary, marginBottom: 4 },
  legendaTeks: { fontSize: 12, color: colors.text, lineHeight: 17 },
  tebal: { fontWeight: '700' },
  legendaChipBaris: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: spacing.sm },
  legendaItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  legendaItemTeks: { fontSize: 11, color: colors.textMuted },

  resourceCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  resourceCardTertutup: { backgroundColor: colors.background },
  resourceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: spacing.sm, gap: spacing.sm },
  resourceJudulBaris: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  resourceLabel: { fontSize: 14, fontWeight: '700', color: colors.text },
  resourceKet: { fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 15 },
  lencanaTertutup: { backgroundColor: colors.dangerBg, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 },
  lencanaTertutupTeks: { fontSize: 10, fontWeight: '700', color: colors.danger },
  lencanaUbah: { backgroundColor: colors.warningBg, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 },
  lencanaUbahTeks: { fontSize: 10, fontWeight: '700', color: colors.warning },
  aksiRow: { flexDirection: 'row', gap: 5 },
  aksiChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 2,
    minHeight: 36,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  aksiChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  aksiChipTerkunci: { opacity: 0.75 },
  aksiChipText: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  aksiChipTextActive: { color: colors.white, fontWeight: '700' },
  catatanAkhir: { fontSize: 11, color: colors.textFaint, textAlign: 'center', marginTop: spacing.md, lineHeight: 16 },
});

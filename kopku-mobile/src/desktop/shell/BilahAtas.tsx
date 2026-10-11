import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';
import { useAppStore } from '@/store/useAppStore';
import { useSyncStore } from '@/sync/SyncStore';
import { usePermission } from '@/hooks/usePermission';
import { bolehBukaRute } from '@/navigation/izinRute';
import { notify } from '@/store/useNotifyStore';
import { logout } from '@/services/AuthService';
import LoncengNotifikasi from '@/components/LoncengNotifikasi';
import { useUiDesktop } from '../uiDesktop';
import { shell } from '../temaDesktop';
import { inisial, LABEL_ROLE, STATUS_SINKRON, waktuRelatif } from './infoSinkron';

type Nav = { navigate: (...a: any[]) => void };

/**
 * BILAH ATAS KOPKU DESKTOP — pencarian global (Ctrl+K), status sinkron HP,
 * lonceng pengumuman/notifikasi, dan menu akun (termasuk Keluar, dengan
 * alur yang sama persis dengan tombol Keluar di layar Pengaturan).
 */
export default function BilahAtas({ navigation }: { navigation: Nav }) {
  const user = useAppStore((s) => s.currentUser);
  const sync = { status: useSyncStore((s) => s.status), terakhir: useSyncStore((s) => s.terakhirSinkron) };
  const bukaPalet = useUiDesktop((s) => s.bukaPalet);
  const alihSidebar = useUiDesktop((s) => s.alihSidebar);
  const [menuAkun, setMenuAkun] = useState(false);
  const st = STATUS_SINKRON[sync.status];

  return (
    <View style={s.bar}>
      <Pressable onPress={alihSidebar} style={({ hovered }: any) => [s.ikonTombol, hovered && s.hover]} accessibilityLabel="Ciutkan/lebarkan sidebar (Ctrl+\\)">
        <Ionicons name="menu-outline" size={20} color={colors.textMuted} />
      </Pressable>

      <Pressable onPress={bukaPalet} style={({ hovered }: any) => [s.cari, hovered && { borderColor: '#C9D1DB' }]} accessibilityRole="search" accessibilityLabel="Cari menu (Ctrl+K)">
        <Ionicons name="search-outline" size={16} color={colors.textFaint} />
        <Text style={s.cariTeks} numberOfLines={1}>
          Cari menu, transaksi, laporan…
        </Text>
        <View style={s.kbd}>
          <Text style={s.kbdTeks}>Ctrl K</Text>
        </View>
      </Pressable>

      <View style={{ flex: 1 }} />

      <Pressable
        onPress={() => navigation.navigate('Pengaturan', { screen: 'SinkronPerangkat', initial: false })}
        style={({ hovered }: any) => [s.pil, hovered && s.hover]}
        accessibilityLabel={`Sinkron HP: ${st.label}`}
      >
        {sync.status === 'MENYINKRONKAN' ? <ActivityIndicator size="small" color={st.warna} /> : <View style={[s.titik, { backgroundColor: st.warna }]} />}
        <Ionicons name="phone-portrait-outline" size={15} color={colors.textMuted} />
        <View>
          <Text style={s.pilJudul}>{st.label}</Text>
          {!!sync.terakhir && <Text style={s.pilSub}>Terakhir {waktuRelatif(sync.terakhir)}</Text>}
        </View>
      </Pressable>

      <View style={s.lonceng}>
        <LoncengNotifikasi />
      </View>

      <View style={s.pemisah} />

      <Pressable onPress={() => setMenuAkun(true)} style={({ hovered }: any) => [s.akun, hovered && s.hover]} accessibilityLabel="Menu akun">
        <View style={s.avatar}>
          <Text style={s.avatarTeks}>{inisial(user?.nama)}</Text>
        </View>
        <View style={{ maxWidth: 160 }}>
          <Text style={s.akunNama} numberOfLines={1}>
            {user?.nama ?? 'Belum masuk'}
          </Text>
          <Text style={s.akunRole}>{user ? LABEL_ROLE[user.role] ?? user.role : ''}</Text>
        </View>
        <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
      </Pressable>

      <MenuAkun terbuka={menuAkun} tutup={() => setMenuAkun(false)} navigation={navigation} />
    </View>
  );
}

function MenuAkun({ terbuka, tutup, navigation }: { terbuka: boolean; tutup: () => void; navigation: Nav }) {
  const user = useAppStore((s) => s.currentUser);
  const koperasi = useAppStore((s) => s.koperasi);
  const { permissions } = usePermission();
  const [keluarBerjalan, setKeluarBerjalan] = useState(false);

  const item: { ikon: keyof typeof Ionicons.glyphMap; label: string; aksi: () => void; rute?: string }[] = [
    { ikon: 'business-outline', label: 'Identitas Koperasi', rute: 'IdentitasKoperasi', aksi: () => navigation.navigate('IdentitasKoperasi') },
    { ikon: 'lock-closed-outline', label: 'Keamanan (PIN & password)', rute: 'Keamanan', aksi: () => navigation.navigate('Pengaturan', { screen: 'Keamanan', initial: false }) },
    { ikon: 'sync-outline', label: 'Sinkron HP', rute: 'SinkronPerangkat', aksi: () => navigation.navigate('Pengaturan', { screen: 'SinkronPerangkat', initial: false }) },
    { ikon: 'cloud-upload-outline', label: 'Backup & Restore', rute: 'BackupRestore', aksi: () => navigation.navigate('Pengaturan', { screen: 'BackupRestore', initial: false }) },
    { ikon: 'settings-outline', label: 'Semua pengaturan', aksi: () => navigation.navigate('Pengaturan', { screen: 'PengaturanMenu' }) },
  ];

  // Alur Keluar SAMA dengan PengaturanScreen (RC-S132).
  const keluar = () => {
    tutup();
    notify(
      'Keluar dari akun?',
      'Anda perlu masuk lagi dengan username dan password. Data koperasi tidak terpengaruh.',
      [
        { text: 'Batal', style: 'cancel' },
        {
          text: 'Keluar',
          style: 'destructive',
          onPress: async () => {
            setKeluarBerjalan(true);
            try {
              await logout();
            } finally {
              const toko = useAppStore.getState();
              toko.setPermissions(null);
              toko.setCurrentUser(null);
              toko.triggerRestoreReload();
            }
          },
        },
      ],
      'warning'
    );
  };

  return (
    <Modal visible={terbuka} transparent animationType="fade" onRequestClose={tutup}>
      <Pressable style={s.menuLatar} onPress={tutup}>
        <Pressable style={s.menu} onPress={() => undefined}>
          <View style={s.menuKepala}>
            <View style={[s.avatar, { width: 40, height: 40, borderRadius: 20 }]}>
              <Text style={[s.avatarTeks, { fontSize: 15 }]}>{inisial(user?.nama)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.menuNama} numberOfLines={1}>
                {user?.nama ?? '-'}
              </Text>
              <Text style={s.menuRole}>{user ? LABEL_ROLE[user.role] ?? user.role : ''}</Text>
              {!!koperasi?.nama && (
                <Text style={s.menuKop} numberOfLines={1}>
                  {koperasi.nama}
                </Text>
              )}
            </View>
          </View>
          {item
            .filter((x) => !x.rute || bolehBukaRute(x.rute, permissions))
            .map((x) => (
              <Pressable
                key={x.label}
                onPress={() => {
                  tutup();
                  x.aksi();
                }}
                style={({ hovered }: any) => [s.menuItem, hovered && s.hover]}
              >
                <Ionicons name={x.ikon} size={17} color={colors.textMuted} />
                <Text style={s.menuItemTeks}>{x.label}</Text>
              </Pressable>
            ))}
          <View style={s.menuGaris} />
          <Pressable onPress={keluar} disabled={keluarBerjalan} style={({ hovered }: any) => [s.menuItem, hovered && { backgroundColor: colors.dangerBg }]}>
            <Ionicons name="log-out-outline" size={17} color={colors.danger} />
            <Text style={[s.menuItemTeks, { color: colors.danger, fontWeight: '700' }]}>Keluar</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  bar: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    backgroundColor: shell.topbar,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ikonTombol: { width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  hover: { backgroundColor: shell.hover },
  cari: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    width: 420,
    maxWidth: '45%',
    height: 38,
    paddingHorizontal: 12,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#F7F8FA',
  } as any,
  cariTeks: { flex: 1, fontSize: 13.5, color: colors.textFaint },
  kbd: { borderWidth: 1, borderColor: colors.border, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1, backgroundColor: colors.surface },
  kbdTeks: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  pil: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, height: 40, borderRadius: 9, borderWidth: 1, borderColor: colors.border },
  titik: { width: 8, height: 8, borderRadius: 4 },
  pilJudul: { fontSize: 12.5, fontWeight: '700', color: colors.text },
  pilSub: { fontSize: 10.5, color: colors.textFaint },
  lonceng: { minWidth: 40, alignItems: 'center' },
  pemisah: { width: 1, height: 28, backgroundColor: colors.border, marginHorizontal: 2 },
  akun: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, height: 44, borderRadius: 10 },
  avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  avatarTeks: { color: '#fff', fontWeight: '800', fontSize: 12.5 },
  akunNama: { fontSize: 13, fontWeight: '700', color: colors.text },
  akunRole: { fontSize: 11, color: colors.textMuted },
  menuLatar: { flex: 1, alignItems: 'flex-end', paddingTop: 58, paddingRight: 14 },
  menu: {
    width: 290,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 6,
    shadowColor: '#0B1220',
    shadowOpacity: 0.16,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 10 },
  },
  menuKepala: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: 6 },
  menuNama: { fontSize: 14, fontWeight: '700', color: colors.text },
  menuRole: { fontSize: 12, color: colors.primary, fontWeight: '600' },
  menuKop: { fontSize: 11.5, color: colors.textMuted, marginTop: 2 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, height: 38, marginHorizontal: 6, borderRadius: 7 },
  menuItemTeks: { fontSize: 13.5, color: colors.text },
  menuGaris: { height: 1, backgroundColor: colors.border, marginVertical: 6 },
});

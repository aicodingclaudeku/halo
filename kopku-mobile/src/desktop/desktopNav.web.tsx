import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Image, ScrollView, Animated, Easing } from 'react-native';
import { useNavigationState } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useAppStore } from '@/store/useAppStore';
import { useSyncStore } from '@/sync/SyncStore';
import { usePermission } from '@/hooks/usePermission';
import { bridge } from './bridge';
import { shell, LEBAR_SIDEBAR, LEBAR_SIDEBAR_RINGKAS } from './temaDesktop';
import { useUiDesktop } from './uiDesktop';
import { bukaEntri, GRUP_TAB, katalogBoleh, type EntriMenu, type NamaTab } from './katalogMenu';
import { ruteTerdalam, STATUS_SINKRON, waktuRelatif } from './shell/infoSinkron';
import PaletPerintah from './shell/PaletPerintah';
import BilahAtas from './shell/BilahAtas';
import BilahStatus from './shell/BilahStatus';

/**
 * KERANGKA KOPKU DESKTOP (Windows & macOS).
 *
 * Tata letak aplikasi desktop profesional — bukan tab bawah HP:
 *   ┌──────────┬──────────────────────────────────────────┐
 *   │ SIDEBAR  │ BILAH ATAS: cari (Ctrl+K) · sinkron · akun │
 *   │ gelap,   ├──────────────────────────────────────────┤
 *   │ grup +   │ KONTEN (header halaman + layar)          │
 *   │ sub-menu ├──────────────────────────────────────────┤
 *   │          │ BILAH STATUS                             │
 *   └──────────┴──────────────────────────────────────────┘
 *
 * Rute, izin, dan isi kelima tab TIDAK berubah: sidebar menggambar ulang
 * tab bar `@react-navigation/bottom-tabs` (prop `tabBar`), dan sub-menu
 * membuka rute yang SAMA dengan menu hub (lihat katalogMenu.ts). Tab yang
 * disembunyikan Permission Matrix tetap tersembunyi.
 */

export const LEBAR_KONTEN_MAKS = 1320;

function SidebarDesktop({ state, descriptors, navigation }: BottomTabBarProps) {
  const koperasi = useAppStore((s) => s.koperasi);
  const status = useSyncStore((s) => s.status);
  const terakhir = useSyncStore((s) => s.terakhirSinkron);
  const ringkas = useUiDesktop((s) => s.sidebarRingkas);
  const bukaPalet = useUiDesktop((s) => s.bukaPalet);
  const alihSidebar = useUiDesktop((s) => s.alihSidebar);
  const { permissions } = usePermission();
  const st = STATUS_SINKRON[status];

  const tabAktif = state.routes[state.index]?.name as NamaTab;
  const dalam = ruteTerdalam(state.routes[state.index]);
  const [terbuka, setTerbuka] = useState<Record<string, boolean>>({ [tabAktif]: true });
  // Akordeon: grup tab yang aktif terbuka, grup lain menutup (tetap dapat dibuka manual).
  useEffect(() => setTerbuka({ [tabAktif]: true }), [tabAktif]);

  const katalog = useMemo(() => katalogBoleh(permissions), [permissions]);

  const lebar = useMemo(() => new Animated.Value(ringkas ? LEBAR_SIDEBAR_RINGKAS : LEBAR_SIDEBAR), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    Animated.timing(lebar, {
      toValue: ringkas ? LEBAR_SIDEBAR_RINGKAS : LEBAR_SIDEBAR,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [ringkas, lebar]);

  const bukaTab = (name: string, params?: object) => {
    const route = state.routes.find((r) => r.name === name);
    if (!route) return;
    const fokus = state.routes[state.index]?.key === route.key;
    const ev = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (!fokus && !ev.defaultPrevented) (navigation as any).navigate(name, params);
  };

  // Menu aplikasi (Electron) & pintasan keyboard.
  useEffect(() => {
    const b = bridge();
    const lepasMenu = b?.app.onMenu((cmd) => {
      if (cmd.startsWith('tab:')) bukaTab(cmd.slice(4));
      if (cmd === 'sinkron') (navigation as any).navigate('Pengaturan', { screen: 'SinkronPerangkat', initial: false });
      if (cmd === 'backup') (navigation as any).navigate('Pengaturan', { screen: 'BackupRestore', initial: false });
      if (cmd === 'cari') useUiDesktop.getState().bukaPalet();
      if (cmd === 'sidebar') useUiDesktop.getState().alihSidebar();
    });
    const tombol = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        useUiDesktop.getState().bukaPalet();
      }
    };
    globalThis.addEventListener?.('keydown', tombol as any);
    return () => {
      globalThis.removeEventListener?.('keydown', tombol as any);
      if (typeof lepasMenu === 'function') lepasMenu();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    useSyncStore.getState().setSidebarAktif(true);
    return () => useSyncStore.getState().setSidebarAktif(false);
  }, []);

  useEffect(() => {
    bridge()?.app.setTitle(koperasi?.nama ? `KOPKU Desktop — ${koperasi.nama}` : 'KOPKU Desktop');
  }, [koperasi?.nama]);

  const cocok = (x: EntriMenu) => {
    if (!dalam || x.tab !== tabAktif || x.rute !== dalam.name) return false;
    if (!x.params) return true;
    const p = dalam.params ?? {};
    return Object.keys(x.params).every((k) => JSON.stringify((x.params as any)[k]) === JSON.stringify((p as any)[k]));
  };

  return (
    <Animated.View style={[s.sidebar, { width: lebar }]}>
      <View style={[s.brand, ringkas && { justifyContent: 'center', paddingHorizontal: 0 }]}>
        <View style={s.logoBox}>
          <Image source={require('../../assets/img/logo-kopku.png')} style={s.logo} resizeMode="contain" />
        </View>
        {!ringkas && (
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.brandNama}>KOPKU</Text>
            <Text style={s.brandSub} numberOfLines={1}>
              {koperasi?.nama ?? 'Koperasi Simpan Pinjam'}
            </Text>
          </View>
        )}
      </View>

      {!ringkas ? (
        <Pressable onPress={bukaPalet} style={({ hovered }: any) => [s.cari, hovered && { backgroundColor: shell.sidebarHover }]} accessibilityLabel="Cari menu (Ctrl+K)">
          <Ionicons name="search" size={15} color={shell.sidebarMuted} />
          <Text style={s.cariTeks}>Cari menu…</Text>
          <Text style={s.kbd}>Ctrl K</Text>
        </Pressable>
      ) : (
        <Pressable onPress={bukaPalet} style={({ hovered }: any) => [s.itemRingkas, hovered && s.itemHover]} accessibilityLabel="Cari menu (Ctrl+K)">
          <Ionicons name="search" size={19} color={shell.sidebarMuted} />
        </Pressable>
      )}

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 14 }} showsVerticalScrollIndicator={false}>
        {!ringkas && <Text style={s.grupLabel}>NAVIGASI</Text>}
        {state.routes.map((route) => {
          const { options } = descriptors[route.key];
          const tersembunyi = (options.tabBarItemStyle as { display?: string } | undefined)?.display === 'none';
          if (tersembunyi) return null;
          const g = GRUP_TAB.find((x) => x.tab === route.name);
          if (!g) return null;
          const fokus = route.name === tabAktif;
          const sub = katalog.filter((x) => x.tab === g.tab && x.sidebar);
          const jumlahSemua = katalog.filter((x) => x.tab === g.tab).length;
          const buka = !!terbuka[g.tab] && sub.length > 0;

          if (ringkas) {
            return (
              <Pressable
                key={route.key}
                accessibilityRole="tab"
                accessibilityLabel={g.label}
                accessibilityState={{ selected: fokus }}
                onPress={() => bukaTab(route.name)}
                style={({ hovered }: any) => [s.itemRingkas, fokus && s.itemAktif, hovered && !fokus && s.itemHover]}
              >
                {fokus && <View style={s.penanda} />}
                <Ionicons name={fokus ? g.ikonAktif : g.ikon} size={20} color={fokus ? '#FFFFFF' : shell.sidebarMuted} />
              </Pressable>
            );
          }

          return (
            <View key={route.key} style={{ marginBottom: 2 }}>
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: fokus }}
                onPress={() => {
                  bukaTab(route.name);
                  if (sub.length > 0) setTerbuka((t) => ({ ...t, [g.tab]: fokus ? !t[g.tab] : true }));
                }}
                style={({ hovered }: any) => [s.item, fokus && s.itemAktif, hovered && !fokus && s.itemHover]}
              >
                {fokus && <View style={s.penanda} />}
                <Ionicons name={fokus ? g.ikonAktif : g.ikon} size={18} color={fokus ? shell.sidebarAccent : shell.sidebarMuted} />
                <Text style={[s.itemLabel, fokus && s.itemLabelAktif]} numberOfLines={1}>
                  {g.label}
                </Text>
                {sub.length > 0 && (
                  <Pressable
                    hitSlop={8}
                    onPress={(e: any) => {
                      e?.stopPropagation?.();
                      setTerbuka((t) => ({ ...t, [g.tab]: !t[g.tab] }));
                    }}
                    accessibilityLabel={buka ? `Ciutkan ${g.label}` : `Buka ${g.label}`}
                  >
                    <Ionicons name={buka ? 'chevron-down' : 'chevron-forward'} size={14} color={shell.sidebarFaint} />
                  </Pressable>
                )}
              </Pressable>
              {buka && (
                <View style={s.subWadah}>
                  {sub.map((x) => {
                    const aktif = cocok(x);
                    return (
                      <Pressable
                        key={x.id}
                        onPress={() => bukaEntri(navigation as any, x)}
                        style={({ hovered }: any) => [s.subItem, aktif && s.subAktif, hovered && !aktif && s.subHover]}
                      >
                        <View style={[s.subTitik, aktif && { backgroundColor: shell.sidebarAccent }]} />
                        <Text style={[s.subLabel, aktif && s.subLabelAktif]} numberOfLines={1}>
                          {x.judul}
                        </Text>
                      </Pressable>
                    );
                  })}
                  {jumlahSemua > sub.length && (
                    <Pressable onPress={() => bukaTab(route.name, { screen: g.akar })} style={({ hovered }: any) => [s.subItem, hovered && s.subHover]}>
                      <View style={[s.subTitik, { backgroundColor: 'transparent', borderWidth: 1, borderColor: shell.sidebarFaint }]} />
                      <Text style={[s.subLabel, { color: shell.sidebarFaint }]}>Semua {g.label.toLowerCase()} ({jumlahSemua})</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>

      <Pressable
        onPress={() => (navigation as any).navigate('Pengaturan', { screen: 'SinkronPerangkat', initial: false })}
        style={({ hovered }: any) => [s.kartuSync, ringkas && { justifyContent: 'center', paddingHorizontal: 0 }, hovered && { backgroundColor: shell.sidebarHover }]}
        accessibilityLabel={`Sinkron HP: ${st.label}`}
      >
        <View style={[s.syncIkon, { borderColor: st.warna }]}>
          <Ionicons name="phone-portrait-outline" size={15} color={st.warna} />
        </View>
        {!ringkas && (
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.syncJudul}>Sinkron HP</Text>
            <Text style={[s.syncStatus, { color: st.warna }]} numberOfLines={1}>
              {st.label}
            </Text>
            {!!terakhir && <Text style={s.syncWaktu}>Terakhir {waktuRelatif(terakhir)}</Text>}
          </View>
        )}
      </Pressable>

      <Pressable onPress={alihSidebar} style={({ hovered }: any) => [s.ciutkan, hovered && { backgroundColor: shell.sidebarHover }]} accessibilityLabel="Ciutkan sidebar (Ctrl+\\)">
        <Ionicons name={ringkas ? 'chevron-forward' : 'chevron-back'} size={15} color={shell.sidebarMuted} />
        {!ringkas && <Text style={s.ciutkanTeks}>Ciutkan sidebar</Text>}
      </Pressable>

      <PaletPerintah navigation={navigation as any} />
    </Animated.View>
  );
}

export const propsTabDesktop: Record<string, unknown> = {
  tabBar: (props: BottomTabBarProps) => <SidebarDesktop {...props} />,
  screenLayout: ({ children, navigation, route }: { children: React.ReactElement; navigation: any; route: any }) => (
    <BingkaiKonten navigation={navigation} route={route}>
      {children}
    </BingkaiKonten>
  ),
};

const RUTE_HUB = new Set([
  'InputDataHub', 'TransaksiHub', 'TransaksiPenerimaan', 'TransaksiPengeluaran', 'Penyesuaian', 'LaporanMenu',
  'PenyusutanDimukaMenu', 'PengaturanMenu', 'PajakMenu', 'PendapatanLainnyaMenu', 'KeluarAnggotaMenu',
]);

/** Lebar konten per jenis layar: menu & formulir tidak dibentangkan selebar monitor. */
function lebarUntuk(nama: string | undefined): number {
  if (!nama) return LEBAR_KONTEN_MAKS;
  // State stack anak belum tercatat di induk sebelum berubah pertama kali → pakai akar tab.
  const akar = GRUP_TAB.find((g) => g.tab === nama && g.tab !== 'Dashboard')?.akar;
  if (akar) nama = akar;
  if (nama === 'Dashboard') return 1480;
  if (RUTE_HUB.has(nama)) return 1000;
  if (/Form$/.test(nama) || nama === 'IdentitasKoperasi' || nama === 'Keamanan' || nama === 'BackupRestore') return 1000;
  return LEBAR_KONTEN_MAKS;
}

/** Bilah atas + konten (lebar nyaman dibaca) + bilah status. */
export function BingkaiKonten({ children, navigation, route }: { children: React.ReactElement; navigation?: any; route?: any }): React.ReactElement {
  // Rute terdalam yang sedang fokus di tab ini (berubah saat pengguna membuka sub-layar).
  const nama = useNavigationState((st: any) => {
    const r = st?.routes?.find((x: any) => x.key === route?.key) ?? st?.routes?.[st?.index ?? 0];
    return ruteTerdalam(r)?.name;
  });
  const maks = lebarUntuk(nama ?? route?.name);
  return (
    <View style={s.bingkai}>
      {navigation && <BilahAtas navigation={navigation} />}
      <View style={s.area}>
        <View style={[s.bingkaiDalam, { maxWidth: maks }]}>{children}</View>
      </View>
      <BilahStatus />
    </View>
  );
}

const s = StyleSheet.create({
  sidebar: {
    backgroundColor: shell.sidebar,
    borderRightWidth: 1,
    borderRightColor: shell.sidebarBorder,
    paddingTop: 16,
    paddingHorizontal: 12,
    overflow: 'hidden',
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 6, paddingBottom: 16, marginBottom: 12, borderBottomWidth: 1, borderBottomColor: shell.sidebarBorder },
  logoBox: { width: 38, height: 38, borderRadius: 10, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  logo: { width: 28, height: 28 },
  brandNama: { fontSize: 17, fontWeight: '800', color: '#FFFFFF', letterSpacing: 1.5 },
  brandSub: { fontSize: 11.5, color: shell.sidebarMuted, marginTop: 1 },
  cari: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 36, paddingHorizontal: 10, borderRadius: 8, backgroundColor: shell.sidebarRaised, borderWidth: 1, borderColor: shell.sidebarBorder, marginBottom: 14 },
  cariTeks: { flex: 1, fontSize: 13, color: shell.sidebarMuted },
  kbd: { fontSize: 10, color: shell.sidebarMuted, borderWidth: 1, borderColor: shell.sidebarBorder, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  grupLabel: { fontSize: 10.5, fontWeight: '700', color: shell.sidebarFaint, letterSpacing: 1.2, paddingHorizontal: 10, marginBottom: 6 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 11, height: 38, paddingHorizontal: 10, borderRadius: 8, position: 'relative' },
  itemRingkas: { height: 42, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginBottom: 4, position: 'relative' },
  itemHover: { backgroundColor: shell.sidebarHover },
  itemAktif: { backgroundColor: shell.sidebarActive },
  penanda: { position: 'absolute', left: -12, top: 9, bottom: 9, width: 3, borderTopRightRadius: 3, borderBottomRightRadius: 3, backgroundColor: shell.sidebarAccent },
  itemLabel: { flex: 1, fontSize: 13.5, fontWeight: '600', color: shell.sidebarText },
  itemLabelAktif: { color: '#FFFFFF', fontWeight: '700' },
  subWadah: { marginLeft: 19, paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: shell.sidebarBorder, marginTop: 2, marginBottom: 6 },
  subItem: { flexDirection: 'row', alignItems: 'center', height: 30, paddingHorizontal: 8, borderRadius: 6 },
  subHover: { backgroundColor: shell.sidebarHover },
  subAktif: { backgroundColor: shell.sidebarRaised },
  subTitik: { width: 5, height: 5, borderRadius: 3, backgroundColor: shell.sidebarFaint, marginRight: 10 },
  subLabel: { flex: 1, fontSize: 12.5, color: shell.sidebarMuted },
  subLabelAktif: { color: '#FFFFFF', fontWeight: '600' },
  kartuSync: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 10, padding: 10, backgroundColor: shell.sidebarRaised, borderWidth: 1, borderColor: shell.sidebarBorder, marginBottom: 8 },
  syncIkon: { width: 30, height: 30, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  syncJudul: { fontSize: 12.5, fontWeight: '700', color: shell.sidebarText },
  syncStatus: { fontSize: 11.5, fontWeight: '600', marginTop: 1 },
  syncWaktu: { fontSize: 10.5, color: shell.sidebarFaint, marginTop: 1 },
  ciutkan: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 34, borderRadius: 8, marginBottom: 10 },
  ciutkanTeks: { fontSize: 11.5, color: shell.sidebarMuted },
  bingkai: { flex: 1, backgroundColor: '#F1F3F6' },
  area: { flex: 1 },
  bingkaiDalam: { flex: 1, width: '100%', alignSelf: 'center' },
});

/** Opsi layar tab di desktop: tab bar menjadi sidebar kiri. */
export const opsiTabDesktop: Record<string, unknown> = { tabBarPosition: 'left' };

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';
import { useAppStore } from '@/store/useAppStore';
import { useSyncStore } from '@/sync/SyncStore';
import { getLicenseStatus, type LicenseStatus } from '@/services/LicenseService';
import { LABEL_TIPE_LISENSI } from '@/utils/licenseCountdown';
import { bridge } from '../bridge';
import { shell } from '../temaDesktop';
import { LABEL_ROLE, STATUS_SINKRON } from './infoSinkron';

/**
 * BILAH STATUS (bawah jendela) — informasi yang di HP tersebar di beberapa
 * layar, dirangkum satu baris: database lokal, koperasi & tahun buku,
 * pengguna, status sinkron, lisensi, dan versi aplikasi. Tampilan saja.
 */
export default function BilahStatus() {
  const koperasi = useAppStore((s) => s.koperasi);
  const user = useAppStore((s) => s.currentUser);
  const status = useSyncStore((s) => s.status);
  const [lisensi, setLisensi] = useState<LicenseStatus | null>(null);

  useEffect(() => {
    let hidup = true;
    const muat = () =>
      getLicenseStatus()
        .then((l) => hidup && setLisensi(l))
        .catch(() => undefined);
    void muat();
    const t = setInterval(muat, 5 * 60 * 1000);
    return () => {
      hidup = false;
      clearInterval(t);
    };
  }, []);

  const st = STATUS_SINKRON[status];
  const tipe = lisensi?.licenseType ?? null;

  return (
    <View style={s.bar}>
      <Item ikon="server-outline" teks="Database lokal · offline" warna={colors.success} />
      <Garis />
      {!!koperasi?.nama && <Item ikon="business-outline" teks={koperasi.nama} />}
      {!!koperasi?.tahunBukuAktif && <Item ikon="calendar-outline" teks={`Tahun Buku ${koperasi.tahunBukuAktif}`} />}
      {!!user && (
        <>
          <Garis />
          <Item ikon="person-outline" teks={`${user.nama} · ${LABEL_ROLE[user.role] ?? user.role}`} />
        </>
      )}
      <View style={{ flex: 1 }} />
      <Item ikon={st.ikon} teks={st.label} warna={st.warna} />
      <Garis />
      {tipe && (
        <>
          <Item
            ikon={lisensi?.allowAppAccess ? 'shield-checkmark-outline' : 'shield-outline'}
            teks={LABEL_TIPE_LISENSI[tipe]}
            warna={lisensi?.allowAppAccess ? colors.success : colors.danger}
          />
          <Garis />
        </>
      )}
      <Text style={s.versi} numberOfLines={1}>
        v{bridge()?.info.version ?? ''}
      </Text>
    </View>
  );
}

function Item({ ikon, teks, warna }: { ikon: keyof typeof Ionicons.glyphMap; teks: string; warna?: string }) {
  return (
    <View style={s.item}>
      <Ionicons name={ikon} size={12} color={warna ?? colors.textFaint} />
      <Text style={[s.teks, warna ? { color: warna } : null]} numberOfLines={1}>
        {teks}
      </Text>
    </View>
  );
}

function Garis() {
  return <View style={s.garis} />;
}

const s = StyleSheet.create({
  bar: {
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    backgroundColor: shell.statusbar,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  item: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: 280, flexShrink: 1, minWidth: 0 },
  teks: { fontSize: 11.5, color: colors.textMuted },
  garis: { width: 1, height: 12, backgroundColor: colors.border },
  versi: { fontSize: 11.5, color: colors.textFaint, flexShrink: 0 },
});

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { usePermission } from '@/hooks/usePermission';
import { useAppStore } from '@/store/useAppStore';
import { AKSI_LABEL, RESOURCE_LABEL, ROLE_LABEL } from '@/config/defaultPermissions';
import { bolehBukaRute, syaratRute } from '@/navigation/izinRute';
import { colors, radius, spacing, touchTarget } from '@/theme/colors';
import { modeHpBacaSajaAktif, PESAN_HP_CADANGAN } from '@/sync/SyncModeBacaSaja';

/**
 * RC-S132 — GERBANG IZIN LAYAR.
 *
 * Dipasang lewat `screenLayout` di setiap navigator (RootNavigator), jadi
 * SETIAP layar melewatinya — dari menu, kartu Dashboard, maupun tautan di
 * dalam layar lain. Bila role pengguna tidak memenuhi syarat rute
 * (`navigation/izinRute.ts`), yang tampil adalah penjelasan "Akses
 * dibatasi", bukan layar aslinya; layar asli tidak di-mount sehingga
 * datanya pun tidak dimuat.
 *
 * Murni lapisan UX di atas penjaga sesungguhnya: service tetap memanggil
 * `requirePermission()` sebelum menulis data.
 */
export default function GerbangIzinLayar({ route, children }: { route: { name: string }; children: React.ReactNode }) {
  const { permissions } = usePermission();
  if (bolehBukaRute(route.name, permissions)) return <>{children}</>;
  return <AksesDibatasi rute={route.name} />;
}

export function AksesDibatasi({ rute }: { rute: string }) {
  const navigation = useNavigation<any>();
  const currentUser = useAppStore((s) => s.currentUser);
  const syarat = syaratRute(rute);
  const aksi = syarat ? (Array.isArray(syarat.aksi) ? syarat.aksi : [syarat.aksi]) : [];
  const teksAksi = aksi.map((a) => AKSI_LABEL[a as keyof typeof AKSI_LABEL] ?? a).join(' / ');

  // Sinkron HP⇄Desktop: HP terpasang adalah penyimpanan cadangan baca-saja.
  const cadangan = modeHpBacaSajaAktif();

  const kembali = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Dashboard');
  };

  return (
    <View style={styles.wadah}>
      <View style={styles.kartu}>
        <View style={styles.ikon}>
          <Ionicons name={cadangan ? 'cloud-done-outline' : 'lock-closed'} size={28} color={colors.warning} />
        </View>
        <Text style={styles.judul}>{cadangan ? 'Mode cadangan KOPKU Desktop' : 'Akses dibatasi'}</Text>
        {cadangan ? (
          <Text style={styles.teks}>{PESAN_HP_CADANGAN} Data di HP ini diperbarui otomatis dari desktop dan tetap dapat dilihat, diekspor, dan dicadangkan.</Text>
        ) : (
        <Text style={styles.teks}>
          {syarat
            ? `Role ${currentUser ? ROLE_LABEL[currentUser.role] : 'Anda'} tidak memiliki izin "${teksAksi}" untuk modul ${RESOURCE_LABEL[syarat.resource]}.`
            : 'Halaman ini belum terdaftar pada pengaturan izin, sehingga ditutup demi keamanan.'}
        </Text>
        )}
        {!cadangan && <Text style={styles.catatan}>Hubungi Admin bila pekerjaan Anda memerlukan akses ini. Izin tiap role diatur di Pengaturan › Permission Matrix.</Text>}
        <TouchableOpacity style={styles.tombol} onPress={kembali} accessibilityRole="button" accessibilityLabel="Kembali">
          <Ionicons name="arrow-back" size={18} color={colors.white} />
          <Text style={styles.tombolTeks}>Kembali</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wadah: { flex: 1, backgroundColor: colors.background, justifyContent: 'center', padding: spacing.xl },
  kartu: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    alignItems: 'center',
  },
  ikon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.warningBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  judul: { fontSize: 18, fontWeight: '800', color: colors.text },
  teks: { fontSize: 13, color: colors.text, textAlign: 'center', lineHeight: 19, marginTop: spacing.sm },
  catatan: { fontSize: 12, color: colors.textMuted, textAlign: 'center', lineHeight: 17, marginTop: spacing.sm },
  tombol: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: touchTarget,
    alignSelf: 'stretch',
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    marginTop: spacing.lg,
  },
  tombolTeks: { color: colors.white, fontWeight: '700', fontSize: 14 },
});

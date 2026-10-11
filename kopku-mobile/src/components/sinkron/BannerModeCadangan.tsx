import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { colors } from '@/theme/colors';
import { modeHpBacaSajaAktif } from '@/sync/SyncModeBacaSaja';
import { useSyncStore } from '@/sync/SyncStore';
import { waktuLokal } from './UiSinkron';

/**
 * Banner di Dashboard HP saat HP menjadi penyimpanan cadangan KOPKU
 * Desktop. Tidak tampil sama sekali bila HP tidak dipasangkan (perilaku
 * Android lama tidak berubah).
 */
export default function BannerModeCadangan() {
  const navigation = useNavigation<any>();
  const terakhir = useSyncStore((s) => s.terakhirSinkron);
  useSyncStore((s) => s.status); // render ulang saat status sinkron berubah
  if (!modeHpBacaSajaAktif()) return null;
  return (
    <Pressable style={st.kotak} onPress={() => navigation.navigate('Pengaturan', { screen: 'SinkronPerangkat' })} accessibilityRole="button">
      <Ionicons name="cloud-done-outline" size={22} color={colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={st.judul}>Mode cadangan KOPKU Desktop</Text>
        <Text style={st.teks}>
          Transaksi & input data dilakukan di desktop. HP ini menyimpan salinan untuk dilihat, diekspor, dan dicadangkan · sinkron terakhir {waktuLokal(terakhir)}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

const st = StyleSheet.create({
  kotak: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.primaryLight, borderRadius: 14, padding: 12, marginBottom: 12 },
  judul: { fontSize: 14, fontWeight: '800', color: colors.primary },
  teks: { fontSize: 12, color: colors.text, marginTop: 2, lineHeight: 17 },
});

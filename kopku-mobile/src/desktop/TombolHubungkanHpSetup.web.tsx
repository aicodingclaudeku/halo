import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';
import { useSyncStore } from '@/sync/SyncStore';
import { useAppStore } from '@/store/useAppStore';
import PanelSinkronDesktop from '@/components/sinkron/PanelSinkronDesktop';
import { setKeputusan } from '@/sync/SyncServer';

/**
 * Layar setup desktop: "Sudah memakai KOPKU di HP?" — RC-S133.5:
 *  1. hubungkan HP lewat QR (hanya menghubungkan);
 *  2. kirim data HP → PC (dari HP, atau "Minta data dari HP" di sini).
 * Setelah data masuk, gerbang lisensi dievaluasi ulang (tanpa memuat ulang).
 */
export default function TombolHubungkanHpSetup() {
  const [buka, setBuka] = useState(false);
  const status = useSyncStore((s) => s.status);
  const pesan = useSyncStore((s) => s.pesan);
  const [mulai, setMulai] = useState(false);
  const terhubung = status !== 'BELUM_DIPASANGKAN';

  useEffect(() => {
    if (status === 'MENYINKRONKAN') setMulai(true);
    // Data HP sudah terpasang → minta gerbang lisensi mengevaluasi ulang
    // (setup kini "selesai" → layar aktivasi lisensi desktop). SENGAJA
    // tanpa memuat ulang halaman: memuat ulang mematikan server sinkron
    // sesaat sehingga HP yang sedang menunggu konfirmasi mendapat 503.
    if (mulai && status === 'SIAP') {
      const t = setTimeout(() => {
        setBuka(false);
        useAppStore.getState().triggerLicenseRecheck();
      }, 2500);
      return () => clearTimeout(t);
    }
  }, [status, mulai]);

  return (
    <>
      <Pressable onPress={() => setBuka(true)} style={({ hovered }: any) => [st.kartu, hovered && { borderColor: colors.primary }]}>
        <View style={st.ikon}>
          <Ionicons name="phone-portrait-outline" size={22} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={st.judul}>Sudah memakai KOPKU di HP?</Text>
          <Text style={st.sub}>Hubungkan HP lewat QR, lalu kirim data HP ke komputer ini.</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
      </Pressable>
      <Text style={st.atau}>— atau buat data koperasi baru di bawah —</Text>
      <Modal visible={buka} transparent animationType="fade" onRequestClose={() => setBuka(false)}>
        <View style={st.latar}>
          <View style={st.dialog}>
            <View style={st.kepala}>
              <Text style={st.dialogJudul}>Ambil data dari HP</Text>
              <Pressable onPress={() => setBuka(false)}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView>
              <PanelSinkronDesktop ringkas />
              <View style={st.langkah2}>
                <Text style={st.judul}>Langkah 2 — Kirim data HP → PC</Text>
                <Text style={st.sub}>
                  Setelah HP terhubung, di HP ketuk “Kirim data HP → PC” (Pengaturan › Sinkron Desktop), atau klik tombol di bawah lalu setujui di HP.
                </Text>
                {terhubung ? (
                  <Pressable
                    style={({ hovered }: any) => [st.tombol, hovered && { opacity: 0.9 }]}
                    onPress={() => void setKeputusan('PAKAI_HP')}
                    accessibilityRole="button"
                  >
                    <Ionicons name="cloud-download-outline" size={18} color="#fff" />
                    <Text style={st.tombolTeks}>Minta data dari HP</Text>
                  </Pressable>
                ) : null}
                {status !== 'BELUM_DIPASANGKAN' && pesan ? <Text style={[st.sub, { marginTop: 8 }]}>Status: {pesan}</Text> : null}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const st = StyleSheet.create({
  kartu: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: '#fff', borderRadius: 14, padding: 14, marginTop: 16 },
  ikon: { width: 44, height: 44, borderRadius: 12, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  judul: { fontSize: 15, fontWeight: '800', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2, lineHeight: 19 },
  atau: { textAlign: 'center', color: colors.textFaint, fontSize: 12, marginVertical: 14 },
  latar: { flex: 1, backgroundColor: 'rgba(16,24,16,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  dialog: { width: 760, maxWidth: '100%', maxHeight: '92%', backgroundColor: colors.background, borderRadius: 18, padding: 18 },
  kepala: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  dialogJudul: { fontSize: 20, fontWeight: '800', color: colors.text },
  langkah2: { backgroundColor: '#fff', borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 16, marginBottom: 8 },
  tombol: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', backgroundColor: colors.primary, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 11, marginTop: 12 },
  tombolTeks: { color: '#fff', fontWeight: '800', fontSize: 14 },
});

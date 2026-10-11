import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';

/**
 * KONFIRMASI "PUTUSKAN SINKRONISASI" (HP & desktop).
 *
 * Memutus pemasangan mengubah peran perangkat, jadi konfirmasinya dibuat
 * eksplisit: akibat ditulis satu per satu, pengguna wajib mencentang
 * "Saya mengerti", dan tombol Putuskan baru aktif setelah dicentang.
 */
export interface ButirAkibat {
  ikon: keyof typeof Ionicons.glyphMap;
  teks: string;
  peringatan?: boolean;
}

export default function DialogPutuskan({
  terlihat,
  judul,
  namaPerangkat,
  akibat,
  onBatal,
  onPutuskan,
}: {
  terlihat: boolean;
  judul: string;
  /** Perangkat pasangan yang akan diputus (ditampilkan tebal). */
  namaPerangkat?: string | null;
  akibat: ButirAkibat[];
  onBatal: () => void;
  onPutuskan: () => Promise<void> | void;
}) {
  const [mengerti, setMengerti] = useState(false);
  const [sibuk, setSibuk] = useState(false);

  useEffect(() => {
    if (terlihat) {
      setMengerti(false);
      setSibuk(false);
    }
  }, [terlihat]);

  const putuskan = async () => {
    if (!mengerti || sibuk) return;
    setSibuk(true);
    try {
      await onPutuskan();
    } finally {
      setSibuk(false);
    }
  };

  return (
    <Modal visible={terlihat} transparent animationType="fade" onRequestClose={onBatal}>
      <View style={st.latar}>
        <View style={st.kartu}>
          <ScrollView contentContainerStyle={{ padding: 20 }} bounces={false}>
            <View style={st.kepala}>
              <View style={st.ikonKepala}>
                <Ionicons name="unlink-outline" size={22} color={colors.danger} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={st.judul}>{judul}</Text>
                {!!namaPerangkat && (
                  <Text style={st.sub} numberOfLines={2}>
                    Pasangan: <Text style={{ fontWeight: '800', color: colors.text }}>{namaPerangkat}</Text>
                  </Text>
                )}
              </View>
            </View>

            <Text style={st.label}>Yang akan terjadi</Text>
            {akibat.map((a, i) => (
              <View key={i} style={st.butir}>
                <Ionicons name={a.ikon} size={18} color={a.peringatan ? colors.warning : colors.textMuted} style={{ marginTop: 1 }} />
                <Text style={[st.butirTeks, a.peringatan && { color: colors.text, fontWeight: '600' }]}>{a.teks}</Text>
              </View>
            ))}

            <Pressable
              onPress={() => setMengerti((v) => !v)}
              style={[st.centang, mengerti && st.centangAktif]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: mengerti }}
            >
              <View style={[st.kotak, mengerti && st.kotakAktif]}>{mengerti && <Ionicons name="checkmark" size={14} color={colors.white} />}</View>
              <Text style={st.centangTeks}>Saya mengerti akibatnya dan tetap ingin memutus sinkronisasi.</Text>
            </Pressable>

            <View style={st.aksi}>
              <Pressable onPress={onBatal} style={({ pressed }) => [st.tombol, st.tombolBatal, pressed && { opacity: 0.8 }]} accessibilityRole="button">
                <Text style={st.tombolBatalTeks}>Batal</Text>
              </Pressable>
              <Pressable
                onPress={() => void putuskan()}
                disabled={!mengerti || sibuk}
                style={({ pressed }) => [st.tombol, st.tombolPutus, (!mengerti || sibuk) && { opacity: 0.4 }, pressed && { opacity: 0.85 }]}
                accessibilityRole="button"
                accessibilityState={{ disabled: !mengerti || sibuk }}
              >
                {sibuk ? <ActivityIndicator size="small" color={colors.white} /> : <Ionicons name="unlink-outline" size={16} color={colors.white} />}
                <Text style={st.tombolPutusTeks}>Putuskan</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  latar: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  kartu: { width: '100%', maxWidth: 520, maxHeight: '90%', backgroundColor: colors.surface, borderRadius: 16, overflow: 'hidden' },
  kepala: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  ikonKepala: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.dangerBg, alignItems: 'center', justifyContent: 'center' },
  judul: { fontSize: 17, fontWeight: '800', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  label: { fontSize: 12, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 },
  butir: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 10 },
  butirTeks: { flex: 1, fontSize: 13.5, lineHeight: 20, color: colors.textMuted },
  centang: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, marginTop: 6 },
  centangAktif: { borderColor: colors.danger, backgroundColor: colors.dangerBg },
  kotak: { width: 20, height: 20, borderRadius: 5, borderWidth: 2, borderColor: colors.textFaint, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  kotakAktif: { backgroundColor: colors.danger, borderColor: colors.danger },
  centangTeks: { flex: 1, fontSize: 13.5, lineHeight: 20, color: colors.text, fontWeight: '600' },
  aksi: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 18 },
  tombol: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 44, paddingHorizontal: 18, borderRadius: 10 },
  tombolBatal: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  tombolBatalTeks: { fontSize: 14, fontWeight: '700', color: colors.text },
  tombolPutus: { backgroundColor: colors.danger },
  tombolPutusTeks: { fontSize: 14, fontWeight: '800', color: colors.white },
});

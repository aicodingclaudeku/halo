import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';
import { usePermission } from '@/hooks/usePermission';
import { useUiDesktop } from '../uiDesktop';
import { bukaEntri, cariKatalog, GRUP_TAB, katalogBoleh, type EntriMenu } from '../katalogMenu';

/**
 * PALET PERINTAH (Ctrl+K) — cari & buka menu, laporan, transaksi, atau
 * pengaturan apa pun dengan keyboard. Hanya entri yang diizinkan role
 * pengguna (Permission Matrix) yang muncul.
 */
export default function PaletPerintah({ navigation }: { navigation: { navigate: (...a: any[]) => void } }) {
  const terbuka = useUiDesktop((s) => s.paletTerbuka);
  const tutup = useUiDesktop((s) => s.tutupPalet);
  const { permissions } = usePermission();
  const [kueri, setKueri] = useState('');
  const [pilih, setPilih] = useState(0);
  const input = useRef<TextInput>(null);
  const gulir = useRef<any>(null);

  const semua = useMemo(() => katalogBoleh(permissions), [permissions]);
  const hasil = useMemo(() => cariKatalog(semua, kueri).slice(0, 60), [semua, kueri]);

  useEffect(() => {
    if (terbuka) {
      setKueri('');
      setPilih(0);
      setTimeout(() => input.current?.focus(), 30);
    }
  }, [terbuka]);
  useEffect(() => setPilih(0), [kueri]);

  const jalankan = (x: EntriMenu | undefined) => {
    if (!x) return;
    tutup();
    bukaEntri(navigation, x);
  };

  const tombol = (e: any) => {
    const k = e?.nativeEvent?.key;
    if (k === 'ArrowDown') {
      e.preventDefault?.();
      setPilih((p) => {
        const n = Math.min(hasil.length - 1, p + 1);
        gulir.current?.scrollTo({ y: Math.max(0, n * 44 - 220), animated: false });
        return n;
      });
    } else if (k === 'ArrowUp') {
      e.preventDefault?.();
      setPilih((p) => {
        const n = Math.max(0, p - 1);
        gulir.current?.scrollTo({ y: Math.max(0, n * 44 - 220), animated: false });
        return n;
      });
    } else if (k === 'Enter') {
      jalankan(hasil[pilih]);
    } else if (k === 'Escape') {
      tutup();
    }
  };

  const labelTab = (x: EntriMenu) => (x.tab === 'Root' ? 'Koperasi' : GRUP_TAB.find((g) => g.tab === x.tab)?.label ?? x.tab);

  return (
    <Modal visible={terbuka} transparent animationType="fade" onRequestClose={tutup}>
      <Pressable style={st.latar} onPress={tutup}>
        <Pressable style={st.kotak} onPress={() => undefined}>
          <View style={st.cari}>
            <Ionicons name="search" size={18} color={colors.textMuted} />
            <TextInput
              ref={input}
              value={kueri}
              onChangeText={setKueri}
              onKeyPress={tombol}
              placeholder="Cari menu, transaksi, laporan, pengaturan…"
              placeholderTextColor={colors.placeholder}
              style={st.input}
              accessibilityLabel="Cari menu"
            />
            <Text style={st.kbd}>Esc</Text>
          </View>
          <ScrollView ref={gulir} style={st.daftar} keyboardShouldPersistTaps="handled">
            {hasil.length === 0 ? (
              <View style={st.kosong}>
                <Ionicons name="search-outline" size={28} color={colors.textFaint} />
                <Text style={st.kosongTeks}>Tidak ada menu yang cocok dengan “{kueri}”.</Text>
              </View>
            ) : (
              hasil.map((x, i) => (
                <Pressable
                  key={x.id}
                  onPress={() => jalankan(x)}
                  onHoverIn={() => setPilih(i)}
                  style={[st.baris, i === pilih && st.barisAktif]}
                  accessibilityRole="button"
                >
                  <View style={[st.ikon, i === pilih && st.ikonAktif]}>
                    <Ionicons name={x.ikon} size={16} color={i === pilih ? colors.white : colors.primary} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={st.judul} numberOfLines={1}>
                      {x.judul}
                    </Text>
                    {!!x.ket && (
                      <Text style={st.ket} numberOfLines={1}>
                        {x.ket}
                      </Text>
                    )}
                  </View>
                  <Text style={st.lokasi} numberOfLines={1}>
                    {labelTab(x)} › {x.grup}
                  </Text>
                  {i === pilih && <Ionicons name="return-down-back" size={14} color={colors.textMuted} />}
                </Pressable>
              ))
            )}
          </ScrollView>
          <View style={st.kaki}>
            <Text style={st.kakiTeks}>
              <Text style={st.kbdKecil}>↑</Text> <Text style={st.kbdKecil}>↓</Text> pilih · <Text style={st.kbdKecil}>Enter</Text> buka ·{' '}
              <Text style={st.kbdKecil}>Esc</Text> tutup
            </Text>
            <Text style={st.kakiTeks}>{hasil.length} menu</Text>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const st = StyleSheet.create({
  latar: { flex: 1, backgroundColor: 'rgba(15,23,32,0.38)', alignItems: 'center', paddingTop: 96 },
  kotak: {
    width: '92%',
    maxWidth: 640,
    maxHeight: '75%',
    backgroundColor: colors.surface,
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#0B1220',
    shadowOpacity: 0.25,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 16 },
  },
  cari: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, height: 56, borderBottomWidth: 1, borderBottomColor: colors.border },
  input: { flex: 1, fontSize: 16, color: colors.text, outlineStyle: 'none' } as any,
  kbd: { fontSize: 11, color: colors.textMuted, borderWidth: 1, borderColor: colors.border, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  daftar: { maxHeight: 440, paddingVertical: 6 },
  baris: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 44, paddingHorizontal: 14, marginHorizontal: 6, borderRadius: 8 },
  barisAktif: { backgroundColor: '#EEF5F0' },
  ikon: { width: 28, height: 28, borderRadius: 7, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  ikonAktif: { backgroundColor: colors.primary },
  judul: { fontSize: 14, fontWeight: '600', color: colors.text },
  ket: { fontSize: 11.5, color: colors.textMuted },
  lokasi: { fontSize: 11.5, color: colors.textFaint, maxWidth: 200 },
  kosong: { alignItems: 'center', padding: 36, gap: 10 },
  kosongTeks: { fontSize: 13, color: colors.textMuted },
  kaki: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: '#FAFBFC' },
  kakiTeks: { fontSize: 11.5, color: colors.textMuted },
  kbdKecil: { fontSize: 11, color: colors.text, fontWeight: '700' },
});

import React from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/theme/colors';

/**
 * RC-S133.5 — LANGKAH 2 SINKRON: PILIH ARAH KIRIM DATA.
 *
 * Dipakai layar HP dan layar desktop. Dua pilihan, masing-masing dengan
 * akibat yang ditulis jelas (data penerima DIGANTI seluruhnya; backup
 * pengaman dibuat otomatis). Kedua perangkat tetap dapat dipakai setelahnya.
 */
export interface PilihanKirim {
  kunci: string;
  judul: string;
  dari: 'HP' | 'PC';
  ke: 'HP' | 'PC';
  keterangan: string;
  onPress: () => void;
  sibuk?: boolean;
}

export default function KartuKirimData({
  langkah = 2,
  judul = 'Kirim data',
  pilihan,
  disabled,
  catatan,
}: {
  langkah?: number;
  judul?: string;
  pilihan: PilihanKirim[];
  disabled?: boolean;
  catatan?: string;
}) {
  return (
    <View style={st.kartu} testID="kartu-kirim-data">
      <View style={st.kepala}>
        <View style={st.nomor}>
          <Text style={st.nomorTeks}>{langkah}</Text>
        </View>
        <Text style={st.judul}>{judul}</Text>
      </View>
      <Text style={st.sub}>Pilih arah pengiriman. Data di perangkat penerima diganti seluruhnya dengan data pengirim; backup pengaman dibuat otomatis lebih dulu.</Text>
      <View style={st.grid}>
        {pilihan.map((p) => (
          <Pressable
            key={p.kunci}
            accessibilityRole="button"
            accessibilityLabel={p.judul}
            testID={`kirim-${p.kunci}`}
            disabled={disabled || p.sibuk}
            onPress={p.onPress}
            style={({ pressed }) => [st.ubin, (disabled || p.sibuk) && { opacity: 0.5 }, pressed && { backgroundColor: colors.primaryLight }]}
          >
            <View style={st.arah}>
              <Perangkat jenis={p.dari} />
              {p.sibuk ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <Ionicons name="arrow-forward" size={22} color={colors.primary} />
              )}
              <Perangkat jenis={p.ke} />
            </View>
            <Text style={st.ubinJudul}>{p.judul}</Text>
            <Text style={st.ubinKet}>{p.keterangan}</Text>
          </Pressable>
        ))}
      </View>
      {catatan ? <Text style={st.catatan}>{catatan}</Text> : null}
    </View>
  );
}

function Perangkat({ jenis }: { jenis: 'HP' | 'PC' }) {
  return (
    <View style={st.perangkat}>
      <Ionicons name={jenis === 'HP' ? 'phone-portrait-outline' : 'desktop-outline'} size={22} color={colors.primary} />
      <Text style={st.perangkatTeks}>{jenis}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  kartu: { backgroundColor: '#fff', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.border, marginBottom: 14 },
  kepala: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  nomor: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  nomorTeks: { color: '#fff', fontWeight: '800', fontSize: 13 },
  judul: { fontSize: 16, fontWeight: '800', color: colors.text },
  sub: { fontSize: 12.5, color: colors.textMuted, lineHeight: 18, marginTop: 6, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  ubin: { flex: 1, minWidth: 220, borderWidth: 1.5, borderColor: colors.primary, borderRadius: 14, padding: 14, gap: 6, backgroundColor: '#fff' },
  arah: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, paddingVertical: 6 },
  perangkat: { alignItems: 'center', width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primaryLight, justifyContent: 'center' },
  perangkatTeks: { fontSize: 9.5, fontWeight: '800', color: colors.primary, marginTop: -1 },
  ubinJudul: { fontSize: 15, fontWeight: '800', color: colors.primary, textAlign: 'center' },
  ubinKet: { fontSize: 12.5, color: '#3A433A', lineHeight: 18, textAlign: 'center' },
  catatan: { fontSize: 12, color: colors.textMuted, lineHeight: 18, marginTop: 10 },
});

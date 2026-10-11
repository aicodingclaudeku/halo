import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '@/theme/colors';
import { CARA_KERJA_BERJANGKA } from '@/screens/Simpanan/tampilanBerjangka';

/**
 * RC-S129 — kartu "Cara kerja Simpanan Berjangka" yang bisa dibuka-tutup.
 * Isi poinnya satu sumber (`CARA_KERJA_BERJANGKA`) sehingga daftar, form
 * penempatan, dan detail kontrak menjelaskan hal yang sama dengan kalimat
 * yang sama. Murni teks — tidak membaca data apa pun.
 */
export default function CaraKerjaBerjangka({ awalTerbuka = false, judul = 'Cara kerja Simpanan Berjangka' }: { awalTerbuka?: boolean; judul?: string }) {
  const [terbuka, setTerbuka] = useState(awalTerbuka);
  return (
    <View style={styles.kartu}>
      <TouchableOpacity
        style={styles.kepala}
        onPress={() => setTerbuka((b) => !b)}
        accessibilityRole="button"
        accessibilityState={{ expanded: terbuka }}
        accessibilityLabel={judul}
      >
        <View style={styles.ikonWadah}>
          <Ionicons name="bulb-outline" size={16} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.judul}>{judul}</Text>
          {!terbuka ? <Text style={styles.ringkas}>Pokok ke anggota, bunga ke Simpanan Sukarela — semuanya otomatis.</Text> : null}
        </View>
        <Ionicons name={terbuka ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
      </TouchableOpacity>
      {terbuka ? (
        <View style={styles.isi}>
          {CARA_KERJA_BERJANGKA.map((p, i) => (
            <View key={p.judul} style={styles.poin}>
              <View style={styles.nomor}>
                <Text style={styles.nomorTeks}>{i + 1}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.poinJudul}>{p.judul}</Text>
                <Text style={styles.poinIsi}>{p.isi}</Text>
              </View>
            </View>
          ))}
          <View style={styles.alur}>
            <AlurItem ikon="person-outline" teks="Pokok" tujuan="ke anggota saat dicairkan" />
            <AlurItem ikon="add-circle-outline" teks="Bunga" tujuan="ke Simpanan Sukarela tiap bulan" />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function AlurItem({ ikon, teks, tujuan }: { ikon: 'person-outline' | 'add-circle-outline'; teks: string; tujuan: string }) {
  return (
    <View style={styles.alurItem}>
      <Ionicons name={ikon} size={16} color={colors.primary} />
      <Text style={styles.alurTeks}>
        <Text style={styles.alurTebal}>{teks}</Text> → {tujuan}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  kartu: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  kepala: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  ikonWadah: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  judul: { fontSize: 13, fontWeight: '700', color: colors.text },
  ringkas: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  isi: { paddingHorizontal: spacing.md, paddingBottom: spacing.md, borderTopWidth: 1, borderTopColor: colors.border },
  poin: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  nomor: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  nomorTeks: { color: colors.white, fontSize: 11, fontWeight: '700' },
  poinJudul: { fontSize: 12, fontWeight: '700', color: colors.text },
  poinIsi: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: 2 },
  alur: { marginTop: spacing.md, backgroundColor: colors.primaryLight, borderRadius: radius.sm, padding: spacing.sm, gap: 6 },
  alurItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  alurTeks: { fontSize: 12, color: colors.text, flex: 1 },
  alurTebal: { fontWeight: '700' },
});

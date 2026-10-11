import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing, typography } from '@/theme/colors';

export interface BarisRingkasan {
  label: string;
  nilai: string;
  /** Baris penutup (total/hasil) — dipisah garis dan ditebalkan. */
  tegas?: boolean;
}

/**
 * RC-S122 — RINGKASAN SEBELUM SIMPAN (presentasi murni).
 *
 * Menampilkan kembali isian form dalam bentuk yang mudah diperiksa
 * sebelum tombol simpan ditekan. Semua nilai datang sudah terformat dari
 * pemanggil — komponen ini tidak menghitung dan tidak memformat uang.
 *
 * `nada="bahaya"` untuk transaksi yang menghapus nilai (mis. hapus buku
 * piutang): batas & angka penutup memakai merah, teks tetap terbaca.
 */
export default function RingkasanTransaksi({
  judul = 'Ringkasan',
  baris,
  catatan,
  nada = 'utama',
}: {
  judul?: string;
  baris: BarisRingkasan[];
  catatan?: string;
  nada?: 'utama' | 'bahaya';
}) {
  const warna = nada === 'bahaya' ? colors.danger : colors.primary;
  return (
    <View style={[styles.kartu, { borderColor: warna }]} accessibilityRole="summary">
      <View style={styles.kepala}>
        <Ionicons name="receipt-outline" size={16} color={warna} />
        <Text style={[styles.judul, { color: warna }]}>{judul}</Text>
      </View>
      {baris.map((b, i) => (
        <View key={`${b.label}-${i}`}>
          {b.tegas ? <View style={styles.garis} /> : null}
          <View style={styles.baris}>
            <Text style={[styles.label, b.tegas && styles.labelTegas]}>{b.label}</Text>
            <Text
              style={[styles.nilai, b.tegas && styles.nilaiTegas, b.tegas && { color: warna }]}
              numberOfLines={2}
            >
              {b.nilai}
            </Text>
          </View>
        </View>
      ))}
      {catatan ? <Text style={styles.catatan}>{catatan}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  kartu: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  kepala: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  judul: { fontSize: typography.subtitle, fontWeight: '700' },
  baris: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: 5,
  },
  label: { flexShrink: 0, maxWidth: '48%', fontSize: typography.caption, color: colors.textMuted, lineHeight: 18 },
  labelTegas: { color: colors.text, fontWeight: '700' },
  nilai: {
    flex: 1,
    minWidth: 0,
    fontSize: typography.subtitle,
    color: colors.text,
    fontWeight: '600',
    textAlign: 'right',
    lineHeight: 18,
    fontVariant: ['tabular-nums'],
  },
  nilaiTegas: { fontSize: 16, fontWeight: '700', lineHeight: 22 },
  garis: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  catatan: { fontSize: 11.5, color: colors.textMuted, lineHeight: 16, marginTop: spacing.sm },
});

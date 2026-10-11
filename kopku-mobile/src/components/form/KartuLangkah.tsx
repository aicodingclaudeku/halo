import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, elevation, radius, spacing, typography } from '@/theme/colors';

/**
 * RC-S122 — KARTU LANGKAH FORM (presentasi murni).
 *
 * Satu bagian form transaksi: nomor langkah, judul, keterangan singkat,
 * lalu isiannya. Pola visual yang SAMA dengan `Section` di
 * PinjamanFormScreen (kartu bernomor), dipindah ke komponen bersama
 * supaya form Modal, Penarikan Bank, Penghapusan Piutang, Pemindahan
 * Saldo, dan User tidak menyalin gaya masing-masing.
 *
 * Nomor dipakai karena isian form memang berurutan. Tanpa `nomor`,
 * kartu menampilkan ikon saja (untuk bagian yang bukan langkah, mis.
 * informasi atau detail data terpilih).
 *
 * Tidak mengimpor service/store/utils; tidak punya state.
 */
export default function KartuLangkah({
  nomor,
  ikon,
  judul,
  keterangan,
  label,
  children,
}: {
  nomor?: number;
  ikon?: keyof typeof Ionicons.glyphMap;
  judul: string;
  keterangan?: string;
  /** Penanda kecil di kanan judul, mis. "Opsional". */
  label?: string;
  children?: React.ReactNode;
}) {
  return (
    <View style={styles.kartu}>
      <View style={styles.kepala}>
        {nomor !== undefined ? (
          <View style={styles.nomor} accessibilityElementsHidden importantForAccessibility="no">
            <Text style={styles.nomorTeks}>{nomor}</Text>
          </View>
        ) : ikon ? (
          <View style={styles.ikonWadah}>
            <Ionicons name={ikon} size={16} color={colors.primary} />
          </View>
        ) : null}
        <View style={styles.judulKolom}>
          <Text style={styles.judul} accessibilityRole="header">
            {judul}
          </Text>
          {keterangan ? <Text style={styles.keterangan}>{keterangan}</Text> : null}
        </View>
        {label ? <Text style={styles.label}>{label}</Text> : null}
      </View>
      {children ? <View style={styles.isi}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  kartu: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...elevation.card,
  },
  kepala: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  nomor: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    flexShrink: 0,
  },
  nomorTeks: { color: colors.white, fontSize: typography.caption, fontWeight: '700' },
  ikonWadah: {
    width: 26,
    height: 26,
    borderRadius: radius.sm,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    flexShrink: 0,
  },
  judulKolom: { flex: 1, minWidth: 0 },
  judul: { fontSize: typography.sectionTitle, fontWeight: '700', color: colors.text, lineHeight: 20 },
  keterangan: { fontSize: typography.caption, color: colors.textMuted, lineHeight: 17, marginTop: 2 },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    backgroundColor: colors.background,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    overflow: 'hidden',
    flexShrink: 0,
  },
  isi: { marginTop: spacing.lg },
});

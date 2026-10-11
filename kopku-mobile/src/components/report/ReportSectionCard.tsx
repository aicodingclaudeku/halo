import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, radius, spacing } from '@/theme/colors';

/**
 * RC-S98 — WADAH SEKSI LAPORAN (kartu berjudul).
 *
 * Sebelumnya seksi laporan hanya berupa `SectionHeader` + deretan
 * `ReportRow` yang melayang di atas latar layar, sehingga pada laporan
 * panjang seperti LHU batas antar seksi tidak terbaca: rincian akun,
 * subtotal, dan seksi berikutnya menempel jadi satu kolom angka.
 *
 * Komponen ini HANYA membungkus (presentasi murni): satu permukaan
 * kartu, judul seksi di bar atas, `nomor` opsional untuk urutan baku
 * laporan, dan `catatan` opsional di kaki kartu. TIDAK ada angka yang
 * dihitung di sini — isinya tetap `ReportRow` yang sudah ada, jadi
 * hierarki baris (default/subtotal/total) tetap satu sumber.
 *
 * Dibuat generik & reusable (bukan komponen khusus satu layar) dengan
 * alasan yang sama seperti `ReportRow`/`SectionHeader`: laporan lain
 * boleh mengikuti tanpa menyalin gaya.
 */
export default function ReportSectionCard({
  title,
  nomor,
  catatan,
  children,
  testID,
}: {
  title: string;
  /** Penanda urutan seksi (mis. "I", "II") — opsional, sekadar penuntun baca. */
  nomor?: string;
  catatan?: string;
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.headerBar}>
        {nomor ? (
          <View style={styles.nomorBadge}>
            <Text style={styles.nomorText}>{nomor}</Text>
          </View>
        ) : null}
        <Text style={styles.title}>{title}</Text>
      </View>
      <View style={styles.body}>{children}</View>
      {catatan ? <Text style={styles.catatan}>{catatan}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primaryLight,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  nomorBadge: {
    minWidth: 22,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nomorText: { fontSize: 10, fontWeight: '800', color: colors.white },
  title: {
    flex: 1,
    fontSize: 12,
    fontWeight: '800',
    color: colors.primary,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  body: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.sm },
  catatan: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    fontSize: 11,
    color: colors.textMuted,
    lineHeight: 15,
  },
});

import React, { useCallback, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '@/theme/colors';

/**
 * ============================================================
 * TOMBOL REFRESH LAPORAN (RC-S49b §A)
 * ============================================================
 *
 * SATU tombol untuk SEMUA layar laporan.
 *
 * KENAPA KOMPONEN BERSAMA, BUKAN TOMBOL PER LAYAR.
 * Sebelas layar laporan yang masing-masing menggambar tombolnya
 * sendiri berarti sebelas gaya, sebelas perilaku loading, dan sebelas
 * kesempatan untuk lupa mengunci tombol selagi kueri berjalan. Yang
 * dibagi di sini HANYA presentasi & penguncian tap — bukan pemuatan
 * datanya. Setiap layar tetap memuat lewat fungsi `load()/muat()`
 * MILIKNYA SENDIRI yang sudah ada sebelum RC ini.
 *
 * TOMBOL INI TIDAK PERNAH MENGHITUNG APA PUN.
 * Ia tidak menyentuh database, service keuangan, atau formula laporan.
 * Ia hanya memanggil kembali loader yang sudah dipakai initial load dan
 * `useFocusRefresh`. Alurnya persis:
 *
 *     tap -> loader existing -> setState -> render ulang
 *
 * ANTI SPAM TAP — dua lapis, dan keduanya memang perlu:
 *  - `loading` dari layar: sumber kebenaran sesungguhnya, karena layar
 *    itulah yang tahu kapan kuerinya selesai.
 *  - `sibukLokal`: menutup celah antara tap dan saat layar sempat
 *    menyetel `loading = true`. Tanpa ini, dua tap beruntun dalam satu
 *    frame masih bisa mengirim dua kueri.
 */

export interface ReportRefreshButtonProps {
  /**
   * Loader milik layar. WAJIB fungsi yang SUDAH ADA (initial load /
   * focus refresh), bukan kueri kedua yang dibuat khusus untuk tombol
   * ini.
   */
  readonly onRefresh: () => void | Promise<void>;
  /** Status loading layar. Selama true, tombol terkunci & menampilkan spinner. */
  readonly loading?: boolean;
  /** Terkunci karena prasyarat layar belum terpenuhi (mis. akun belum dipilih). */
  readonly disabled?: boolean;
  readonly testID?: string;
}

export default function ReportRefreshButton({
  onRefresh,
  loading = false,
  disabled = false,
  testID = 'report-refresh-button',
}: ReportRefreshButtonProps) {
  const [sibukLokal, setSibukLokal] = useState(false);
  const sibuk = loading || sibukLokal;
  const terkunci = sibuk || disabled;

  const tekan = useCallback(() => {
    if (terkunci) return;
    setSibukLokal(true);
    // Loader layar boleh sinkron (`void`) maupun asinkron. Dibungkus
    // Promise.resolve() supaya keduanya ditangani satu jalur, tanpa
    // memaksa layar mengubah tanda tangan fungsinya.
    void Promise.resolve()
      .then(() => onRefresh())
      .catch(() => {
        // Kegagalan pemuatan ditampilkan oleh LAYAR (state `error`-nya
        // sendiri). Tombol hanya perlu kembali normal — menelan error
        // di sini mencegah unhandled rejection, bukan menyembunyikan
        // kegagalan dari pengguna.
      })
      .finally(() => setSibukLokal(false));
  }, [terkunci, onRefresh]);

  return (
    <TouchableOpacity
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel="Muat ulang laporan"
      accessibilityState={{ disabled: terkunci, busy: sibuk }}
      onPress={tekan}
      disabled={terkunci}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={[styles.tombol, terkunci && styles.tombolTerkunci]}
    >
      {/* Lebar ikon dikunci supaya pergantian ikon <-> spinner tidak
          menggeser teks di sebelahnya. */}
      <View style={styles.slotIkon}>
        {sibuk ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Ionicons name="refresh-outline" size={16} color={colors.primary} />
        )}
      </View>
      <Text style={styles.teks}>Refresh</Text>
    </TouchableOpacity>
  );
}

/**
 * Memasang tombol di atas sebagai `headerRight` layar.
 *
 * KENAPA DI HEADER, BUKAN DI BADAN LAYAR.
 * Seluruh layar laporan hidup di `LaporanStack` yang sudah punya header
 * — tempat yang sama, tinggi yang sama, jarak yang sama di semua layar,
 * dan inset status bar ditangani header navigasi sendiri. Menyisipkan
 * tombol ke badan layar berarti menyentuh sebelas layout yang berbeda
 * (ScrollView, FlatList, layar dengan modal filter) dan menggeser
 * konten laporan.
 *
 * `useLayoutEffect` mengikuti konvensi yang sudah dipakai
 * SimpananHistoriScreen untuk `headerRight` Export — supaya header
 * tidak berkedip pada frame pertama.
 */
export function useReportRefreshHeader(
  muat: () => void | Promise<void>,
  opsi: { loading?: boolean; disabled?: boolean; testID?: string } = {}
): void {
  const navigation = useNavigation<any>();
  const { loading = false, disabled = false, testID } = opsi;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <ReportRefreshButton onRefresh={muat} loading={loading} disabled={disabled} testID={testID} />
      ),
    });
  }, [navigation, muat, loading, disabled, testID]);
}

const styles = StyleSheet.create({
  tombol: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.primaryLight,
  },
  tombolTerkunci: { opacity: 0.5 },
  slotIkon: { width: 18, alignItems: 'center', justifyContent: 'center' },
  teks: { fontSize: 12, fontWeight: '700', color: colors.primary },
});

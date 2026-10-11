import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { formatRupiah, formatRupiahPengurang } from '@/utils/money';
import { Ionicons } from '@expo/vector-icons';
import { colors, iconSize, spacing } from '@/theme/colors';

/**
 * Baris laporan generik (Revisi UI/UX §4/§17/§19): nama akun rata
 * kiri (boleh wrap ke baris berikutnya kalau panjang), nominal SELALU
 * rata kanan dan TIDAK PERNAH dipotong/ellipsis — nama yang menyerap
 * ruang kalau sempit (flex:1 + flexShrink), bukan nominal
 * (flexShrink: 0, lebar mengikuti konten). Dipakai di seluruh laporan
 * (LHU, Posisi Keuangan, dst) supaya konsisten — REUSE, bukan
 * komponen sejenis yang beda-beda per layar.
 */
export interface ReportRowProps {
  label: string;
  value: number;
  /** Baris subtotal ("Jumlah ...") — sedikit lebih tebal, garis pemisah tipis di atas. */
  variant?: 'default' | 'subtotal' | 'total';
  /** Tandai baris ini butuh perhatian (mis. akun belum diklasifikasikan LHU) — indikator non-blocking, TIDAK mengubah angka. */
  flagged?: boolean;
  flagLabel?: string;
  /**
   * RC-S98 (ADDITIVE, default false — laporan lain TIDAK berubah) —
   * sajikan nominal sebagai PENGURANG bergaya laporan resmi: "(Rp1.000)".
   * `value` tetap magnitudo positif; lihat `formatRupiahPengurang`. Dipakai
   * baris beban di LHU supaya kolomnya bisa dijumlahkan dengan mata seperti
   * contoh Juklat SOM 3/2025 Lampiran 1.
   */
  pengurang?: boolean;
  /**
   * RC-S98 (ADDITIVE, default false) — baris RINCIAN di bawah header
   * seksi: diberi indentasi kiri, seperti rincian akun pada contoh Juklat.
   * Subtotal & total dibiarkan rata kiri supaya hierarkinya terbaca.
   */
  indent?: boolean;
}

export default function ReportRow({
  label,
  value,
  variant = 'default',
  flagged,
  flagLabel,
  pengurang = false,
  indent = false,
}: ReportRowProps) {
  const isTotal = variant === 'total';
  const isSubtotal = variant === 'subtotal';
  return (
    <View
      style={[
        styles.row,
        indent && styles.rowIndent,
        (isSubtotal || isTotal) && styles.rowEmphasis,
        isTotal && styles.rowTotal,
      ]}
    >
      <Text
        style={[styles.label, (isSubtotal || isTotal) && styles.labelBold]}
        numberOfLines={2}
      >
        {label}
        {flagged ? ' ' : ''}
        {flagged ? <Ionicons name="warning-outline" size={iconSize.sm - 2} color={colors.warning} accessibilityLabel="Perlu perhatian" /> : null}
      </Text>
      <Text
        style={[
          styles.value,
          (isSubtotal || isTotal) && styles.valueBold,
          isTotal && styles.valueTotal,
          // Merah HANYA untuk nilai yang benar-benar negatif pada baris
          // biasa. Baris `pengurang` TIDAK PERNAH merah: pengurangan sudah
          // dinyatakan lewat tanda kurung (kalau tidak, seluruh seksi beban
          // jadi merah dan "merah" kehilangan artinya sebagai peringatan),
          // dan pengurang bernilai negatif justru MENAMBAH hasil usaha —
          // `formatRupiahPengurang` menyajikannya tanpa kurung, jadi merah
          // akan salah arti di kedua arah.
          !pengurang && value < 0 && styles.valueNegative,
        ]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.85}
      >
        {pengurang ? formatRupiahPengurang(value) : formatRupiah(value)}
      </Text>
      {flagged && flagLabel ? <Text style={styles.flagText}>{flagLabel}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 5,
  },
  // RC-S98 — indentasi rincian akun di bawah header seksi.
  rowIndent: { paddingLeft: spacing.md },
  rowEmphasis: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
  },
  rowTotal: {
    borderTopWidth: 2,
    borderTopColor: colors.text,
    paddingVertical: spacing.sm,
  },
  label: {
    flex: 1,
    flexShrink: 1,
    marginRight: spacing.md,
    minWidth: 0,
    fontSize: 13,
    color: colors.text,
    lineHeight: 18,
  },
  labelBold: { fontWeight: '700' },
  // UI/UX REDESIGN T2 — nominal rata kanan dengan angka tabular; boleh
  // menyusut sedikit (maks 62% lebar baris, font minimal 85%) supaya nominal
  // sangat besar tidak mendorong label habis atau keluar layar kecil.
  value: {
    flexShrink: 1,
    maxWidth: '62%',
    fontVariant: ['tabular-nums'],
    fontSize: 13,
    color: colors.text,
    textAlign: 'right',
    lineHeight: 18,
  },
  valueBold: { fontWeight: '700' },
  valueTotal: { fontSize: 15, color: colors.primary },
  valueNegative: { color: colors.danger },
  flagText: { width: '100%', fontSize: 10, color: colors.warning, textAlign: 'right', marginTop: 1 },
});

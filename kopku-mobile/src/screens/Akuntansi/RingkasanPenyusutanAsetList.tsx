import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { RingkasanAsetPenyusutan } from '@/services/PenyusutanService';
import { formatRupiah } from '@/utils/money';
import { colors, radius, spacing } from '@/theme/colors';

/**
 * ============================================================
 * RC-S50 §10 — KARTU RINGKASAN PENYUSUTAN PER ASET
 * ============================================================
 *
 * Diekstrak APA ADANYA dari `PenyusutanListScreen.tsx` — markup,
 * label, urutan kolom, dan pewarnaannya identik dengan sebelumnya.
 *
 * KENAPA DIEKSTRAK. Menu "Daftar Penyusutan" & "Status Periode
 * Penyusutan" digabung menjadi satu menu `Penyusutan Aset`, sehingga
 * daftar aset ini sekarang dirender di dalam `StatusPeriodeScreen`.
 * Menyalin markup-nya ke sana akan menghasilkan dua salinan tampilan
 * yang bisa menyimpang; mengekstraknya membuat keduanya mustahil
 * berbeda.
 *
 * MURNI PRESENTASI. Komponen ini tidak memanggil service, tidak
 * memuat data, dan tidak menghitung apa pun — seluruh angka
 * (`nilaiPenyusutanBulanan`, `akumulasiPenyusutan`, `nilaiBuku`)
 * datang siap pakai dari `listRingkasanPenyusutanAset()` di
 * PenyusutanService, yang TIDAK disentuh RC ini.
 */
export default function RingkasanPenyusutanAsetList({ data }: { data: RingkasanAsetPenyusutan[] }) {
  return (
    <>
      {data.map((item) => (
        <View key={item.asetId} style={styles.card}>
          <View style={styles.headerRow}>
            <Text style={styles.nama}>{item.namaAset}</Text>
            <Text style={styles.nomor}>{item.nomorAset}</Text>
          </View>
          <Text style={styles.sub}>
            Perolehan {item.tanggalPerolehan} · {item.masaManfaatBulan} bulan · {item.jumlahPeriodeDiproses}× diproses
          </Text>

          <View style={styles.rowValues}>
            <ValueCol label="Nilai Perolehan" value={formatRupiah(item.nilaiPerolehan)} />
            <ValueCol
              label={item.jenisAset === 'TAK_BERWUJUD' ? 'Amortisasi/bulan' : 'Penyusutan/bulan'}
              value={formatRupiah(item.nilaiPenyusutanBulanan)}
            />
          </View>
          <View style={styles.rowValues}>
            <ValueCol
              label={item.jenisAset === 'TAK_BERWUJUD' ? 'Akumulasi Amortisasi' : 'Akumulasi Penyusutan'}
              value={formatRupiah(item.akumulasiPenyusutan)}
              warn
            />
            <ValueCol label="Nilai Buku" value={formatRupiah(item.nilaiBuku)} highlight />
          </View>
        </View>
      ))}
    </>
  );
}

function ValueCol({ label, value, warn, highlight }: { label: string; value: string; warn?: boolean; highlight?: boolean }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.valueLabel}>{label}</Text>
      <Text style={[styles.valueText, warn && styles.valueWarn, highlight && styles.valueHighlight]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  nama: { fontSize: 15, fontWeight: '700', color: colors.text, flex: 1 },
  nomor: { fontSize: 11, color: colors.textFaint },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing.sm },
  rowValues: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xs },
  valueLabel: { fontSize: 11, color: colors.textMuted },
  valueText: { fontSize: 14, fontWeight: '700', color: colors.text, marginTop: 2 },
  valueWarn: { color: colors.warning },
  valueHighlight: { color: colors.primary },
});

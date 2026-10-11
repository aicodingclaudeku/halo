import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, iconSize } from '@/theme/colors';
import { ui, menuIconSize } from '@/theme/ui';
import { usePermission } from '@/hooks/usePermission';
import { bolehBukaRute } from '@/navigation/izinRute';

/**
 * HUB PENYESUAIAN (Fase 9). RC-S68: dijangkau langsung dari root
 * Transaksi (kategori utama), tidak lagi dari Pengeluaran. RC-S68.1:
 * penyegaran visual (a11y, umpan balik tekan, catatan netral).
 *
 * Tiga penyesuaian dikumpulkan di satu tempat. Urutannya mengikuti seberapa rutin
 * pekerjaannya: rekonsiliasi dilakukan tiap periode, penilaian nilai
 * wajar sesekali, impairment hanya bila ada indikasi.
 *
 * HUB INI TIDAK MEMEGANG LOGIKA AKUNTANSI APA PUN. Ia hanya
 * mengarahkan ke layar yang sudah ada; tidak ada service, tidak ada
 * kalkulasi, dan tidak ada jurnal di berkas ini.
 */

const MENU: {
  route: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  sub: string;
  catatan?: string;
}[] = [
  {
    // RC-S109 — KOLEKTIBILITAS DIPINDAH KE SINI dari menu Laporan
    // (permintaan pengguna). Layar ini bukan sekadar laporan: dari
    // situlah penggolongan kualitas piutang ditetapkan dan cadangan
    // penyisihannya dihitung, yaitu penyesuaian akhir periode.
    //
    // Poin 8 — kini PALING ATAS, sebelum Rekonsiliasi Kas/Bank dan
    // Penyesuaian Nilai Wajar. Rute & komponen TIDAK diubah.
    route: 'KolektibilitasPiutang',
    icon: 'analytics-outline',
    title: 'Kolektibilitas Piutang Pinjaman',
    sub: 'Aging & cadangan penyisihan: Lancar / Dalam Perhatian / Kurang Lancar / Diragukan / Macet',
  },
  {
    route: 'Rekonsiliasi',
    icon: 'git-compare-outline',
    title: 'Rekonsiliasi Kas/Bank',
    sub: 'Cocokkan saldo buku dengan saldo eksternal',
  },
  {
    route: 'PenyesuaianNilaiWajar',
    icon: 'stats-chart-outline',
    title: 'Penyesuaian Nilai Wajar',
    sub: 'Nilai wajar properti investasi & revaluasi aset tetap',
    catatan: 'Properti investasi: selisih ke laba rugi. Aset tetap: kenaikan ke penghasilan komprehensif lain (SAK EP).',
  },
  {
    // Poin 7 — DIPINDAH dari Laporan > Rincian Laporan Lainnya, tepat di
    // bawah Penyesuaian Nilai Wajar. Layar & service yang sama
    // (PenyusutanPropertiFormScreen / PenyusutanPropertiInvestasiService);
    // hanya penempatan menunya yang berubah. Rute lama di LaporanStack
    // tetap terdaftar supaya riwayat navigasi lama tidak patah.
    route: 'PenyusutanPropertiInvestasi',
    icon: 'home-outline',
    title: 'Penyusutan Properti Investasi',
    sub: 'Parameter penyusutan properti investasi, periode tertunggak, dan riwayat jurnalnya',
  },
  {
    // Bunga tabungan anggota (kebijakan koperasi, bisa dimatikan):
    // dibukukan setiap akhir bulan dan menambah saldo simpanan sukarela.
    route: 'BungaSimpananSukarela',
    icon: 'cash-outline',
    title: 'Bunga Simpanan Sukarela',
    sub: 'Bunga harian tabungan anggota: kebijakan, akrual otomatis tiap akhir bulan, dan panduan penggunaan',
  },
  {
    route: 'ImpairmentInvestasiForm',
    icon: 'trending-down-outline',
    title: 'Impairment Investasi',
    sub: 'Catat penurunan nilai investasi',
  },
];

export default function PenyesuaianScreen() {
  // RC-S132 — hanya entri yang rutenya diizinkan role ini.
  const { permissions } = usePermission();
  const menuTampil = MENU.filter((m) => bolehBukaRute(m.route, permissions));
  const navigation = useNavigation<any>();

  // RC-S68.1 — satu daftar kartu (tiga item; pengelompokan per bagian justru
  // menambah panjang tanpa menambah kejelasan). Gaya kartu sama dengan
  // Penerimaan/Pengeluaran; catatan kebijakan tampil sebagai keterangan
  // kecil netral, bukan warna peringatan.
  return (
    <ScrollView style={styles.container} contentContainerStyle={ui.screenContent}>
      <Text style={styles.subtitle}>Kelola koreksi dan penyesuaian transaksi koperasi.</Text>

      {menuTampil.map((m) => (
        <TouchableOpacity
          key={m.route}
          accessibilityRole="button"
          accessibilityLabel={m.title}
          accessibilityHint={m.sub}
          activeOpacity={0.7}
          style={styles.card}
          onPress={() => navigation.navigate(m.route)}
        >
          <View style={styles.ikonWrap}>
            <Ionicons name={m.icon} size={menuIconSize} color={colors.primary} />
          </View>
          <View style={styles.isi}>
            <Text style={styles.title}>{m.title}</Text>
            <Text style={styles.sub}>{m.sub}</Text>
            {m.catatan ? (
              <View style={styles.catatanRow}>
                <Ionicons name="information-circle-outline" size={14} color={colors.textMuted} />
                <Text style={styles.catatan}>{m.catatan}</Text>
              </View>
            ) : null}
          </View>
          <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={ui.chevron} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  subtitle: { ...ui.screenIntro },
  card: { ...ui.menuCard },
  ikonWrap: { ...ui.menuIcon },
  isi: { flex: 1, minWidth: 0 },
  title: { ...ui.menuTitle },
  sub: { ...ui.menuSub },
  catatanRow: { flexDirection: 'row', gap: 4, alignItems: 'flex-start', marginTop: spacing.xs },
  catatan: { flex: 1, fontSize: 11, color: colors.textMuted, lineHeight: 15 },
});

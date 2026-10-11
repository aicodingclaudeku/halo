import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { ui, menuIconSize } from '@/theme/ui';
import { usePermission } from '@/hooks/usePermission';
import { bolehBukaRute } from '@/navigation/izinRute';

/** Menu Laporan (PRD §24-28, §38) — bukan placeholder lagi. */
const MENU: { route: string; icon: keyof typeof Ionicons.glyphMap; title: string; sub: string }[] = [
  // RC-S49 (permintaan pengguna): LABEL TAMPILAN kelima laporan keuangan
  // utama diseragamkan dengan istilah SAK EP yang dipakai di judul layar
  // & di RootNavigator. Urutan menu SUDAH benar sejak awal (Posisi
  // Keuangan -> Hasil Usaha -> Perubahan Ekuitas -> Arus Kas -> Catatan
  // Atas Laporan Keuangan) dan TIDAK diubah. `route` TIDAK disentuh —
  // navigasi, nama screen, komponen, dan seluruh logika tetap sama;
  // hanya `title`/`sub` (teks yang dibaca pengguna) yang berubah.
  { route: 'PosisiKeuangan', icon: 'briefcase-outline', title: 'Laporan Posisi Keuangan', sub: 'Aset, Liabilitas, Ekuitas' },
  { route: 'LabaRugi', icon: 'bar-chart-outline', title: 'Laporan Perhitungan Hasil Usaha', sub: 'Pendapatan, Beban, hasil usaha periode' },
  { route: 'PerubahanEkuitas', icon: 'pie-chart-outline', title: 'Laporan Perubahan Ekuitas', sub: 'Saldo awal, mutasi, SHU, saldo akhir' },
  { route: 'ArusKas', icon: 'cash-outline', title: 'Laporan Arus Kas', sub: 'Operasi, investasi, pendanaan, rekonsiliasi kas' },
  {
    route: 'Calk',
    icon: 'reader-outline',
    title: 'Catatan Atas Laporan Keuangan',
    sub: 'Informasi umum, kebijakan akuntansi, rincian akun',
  },
  // RC-S109 (permintaan pengguna) — DUA ENTRI DIPINDAH KELUAR dari
  // menu Laporan, masing-masing ke tempat yang sesuai sifatnya:
  //
  //   "SHU"                     -> Transaksi > Pengeluaran, dengan nama
  //                                "Pembagian Sisa Hasil Usaha".
  //                                Pembagian SHU menjurnal, mengurangi
  //                                ekuitas, dan menambah simpanan
  //                                anggota — itu pengeluaran, bukan
  //                                laporan.
  //   "Kolektibilitas Piutang"  -> Transaksi > Penyesuaian. Di sanalah
  //                                kualitas piutang ditetapkan dan
  //                                cadangan penyisihannya dihitung,
  //                                yaitu penyesuaian akhir periode.
  //
  // Rute & komponen keduanya TIDAK diubah, dan masing-masing tetap
  // punya SATU pintu masuk di seluruh aplikasi — bukan ditambah di
  // tempat baru sambil dibiarkan di sini.
  { route: 'HistoryTransaksi', icon: 'time-outline', title: 'History Transaksi', sub: 'Riwayat semua transaksi finansial — cari, filter, detail jurnal' },
  {
    route: 'PenyusutanDimukaMenu',
    icon: 'folder-open-outline',
    title: 'Rincian Laporan Lainnya',
    sub: 'Neraca Saldo, Buku Besar, Daftar Investasi, Daftar Aset Tetap, penyusutan & pendapatan diterima dimuka',
  },
  // Audit ulang (permintaan pengguna §20): dipindah ke sini dari
  // "Rincian Laporan Lainnya" (dihapus dari sana, lihat
  // PenyusutanDimukaMenuScreen.tsx) — sekarang jadi menu level utama
  // Laporan, tepat DI BAWAH "Rincian Laporan Lainnya". Rute/komponen
  // TutupPeriodeScreen SAMA PERSIS — PeriodCloseService, aturan
  // penutupan periode, validasi, & jurnal penutupan TIDAK diubah.
  {
    route: 'TutupPeriode',
    icon: 'lock-closed-outline',
    title: 'Tutup Periode',
    sub: 'Kunci periode tahun buku setelah semua syarat terpenuhi',
  },
];

export default function LaporanScreen() {
  const navigation = useNavigation<any>();
  // RC-S132 — hanya laporan yang rutenya diizinkan role ini.
  const { permissions } = usePermission();
  const menuTampil = MENU.filter((item) => bolehBukaRute(item.route, permissions));

  return (
    <ScrollView style={styles.container} contentContainerStyle={ui.screenContent}>
      {menuTampil.length === 0 ? <Text style={styles.cardSub}>Tidak ada laporan yang dapat dibuka dengan role Anda saat ini.</Text> : null}
      {menuTampil.map((item) => (
        <TouchableOpacity key={item.route} accessibilityRole="button" style={styles.card} onPress={() => navigation.navigate(item.route)}>
          <View style={styles.iconCircle}>
            <Ionicons name={item.icon} size={menuIconSize} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>{item.title}</Text>
            <Text style={styles.cardSub}>{item.sub}</Text>
          </View>
          <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={ui.chevron} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  title: { fontSize: 20, fontWeight: '700', color: colors.text, marginBottom: spacing.lg },
  card: { ...ui.menuCard },
  iconCircle: { ...ui.menuIcon },
  cardTitle: { ...ui.menuTitle },
  cardSub: { ...ui.menuSub },
});

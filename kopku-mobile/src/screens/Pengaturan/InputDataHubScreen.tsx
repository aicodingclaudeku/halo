import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { ui, menuIconSize } from '@/theme/ui';
import { usePermission } from '@/hooks/usePermission';
import { bolehBukaRute, ruteDariAksi } from '@/navigation/izinRute';

interface SubFitur {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  sub: string;
  onPress: (nav: any) => void;
}

interface SeksiData {
  judul: string;
  item: SubFitur[];
}

/**
 * Hub "Data" — SATU pintu masuk untuk seluruh master data koperasi.
 *
 * MASALAH YANG DITUTUP (restrukturisasi ini). Sebelumnya master data
 * koperasi terbelah di dua tempat yang tidak berhubungan: sebagian di
 * hub ini, sebagian lagi tersembunyi sebagai daftar pintasan di
 * DALAM form "Identitas Koperasi" (Pengurus, Pengawas, Pengelola/
 * Karyawan/Pekerja, Perizinan, Unit Usaha, Peraturan Internal). Untuk
 * membuka Pengurus, pengguna harus menebak bahwa jalannya lewat
 * Pengaturan > Identitas Koperasi — layar yang namanya menjanjikan
 * data koperasi itu sendiri (nama, alamat, NPWP), bukan daftar orang.
 * Keenamnya sekarang berada di sini, satu tap dari tab Data, dan
 * Identitas Koperasi kembali hanya mengurus identitas koperasi.
 *
 * Daftar yang panjang dikelompokkan menjadi tiga bagian bermakna
 * daripada satu deret kartu tanpa hierarki: siapa orangnya, lembaga
 * koperasinya, lalu referensi yang dipakai form transaksi.
 *
 * "Data Klasifikasi Aset" DIHAPUS dari menu ini (permintaan
 * restrukturisasi). Yang hilang HANYA entry menunya: `AsetKlasifikasiService`
 * dan `defaultAsetKlasifikasi` tetap hidup dan tetap dipakai sebagai
 * picker oleh PembelianAsetForm, ModalForm, dan AsetEditForm.
 */
const SEKSI: SeksiData[] = [
  {
    judul: 'Keanggotaan & Personel',
    item: [
      {
        icon: 'people-outline',
        title: 'Anggota',
        sub: 'Daftar dan kelola anggota koperasi',
        onPress: (nav) => nav.navigate('AnggotaList'),
      },
      {
        icon: 'ribbon-outline',
        title: 'Pengurus',
        sub: 'Susunan, jabatan, dan masa jabatan pengurus',
        onPress: (nav) => nav.navigate('PersonelKoperasi', { kategori: ['PENGURUS'], judul: 'Pengurus' }),
      },
      {
        icon: 'eye-outline',
        title: 'Pengawas',
        sub: 'Susunan, jabatan, dan masa jabatan pengawas',
        onPress: (nav) => nav.navigate('PersonelKoperasi', { kategori: ['PENGAWAS'], judul: 'Pengawas' }),
      },
      {
        icon: 'briefcase-outline',
        title: 'Pengelola / Karyawan / Pekerja',
        sub: 'Kelola personel operasional koperasi',
        onPress: (nav) =>
          nav.navigate('PersonelKoperasi', {
            kategori: ['PENGELOLA', 'KARYAWAN', 'PEKERJA'],
            judul: 'Pengelola / Karyawan / Pekerja',
          }),
      },
    ],
  },
  {
    judul: 'Kelembagaan Koperasi',
    item: [
      {
        icon: 'shield-checkmark-outline',
        title: 'Perizinan yang Dimiliki',
        sub: 'Legalitas dan perizinan koperasi',
        onPress: (nav) => nav.navigate('PerizinanKoperasi'),
      },
      {
        icon: 'storefront-outline',
        title: 'Unit Usaha',
        sub: 'Daftar dan status unit usaha koperasi',
        onPress: (nav) => nav.navigate('UnitUsahaKoperasi'),
      },
      {
        icon: 'document-lock-outline',
        title: 'Peraturan Internal',
        sub: 'Peraturan, ketentuan, dan dokumen internal',
        onPress: (nav) => nav.navigate('PeraturanInternal'),
      },
      {
        icon: 'podium-outline',
        title: 'Pelaksanaan RAT',
        sub: 'Catatan pelaksanaan Rapat Anggota Tahunan',
        onPress: (nav) => nav.navigate('PelaksanaanRAT'),
      },
    ],
  },
  {
    judul: 'Referensi & Akuntansi',
    item: [
      {
        icon: 'library-outline',
        title: 'Akun',
        sub: 'Daftar Akun (COA) — tambah, ubah, nonaktifkan akun',
        onPress: (nav) => nav.navigate('AccountList'),
      },
      {
        icon: 'flag-outline',
        title: 'Saldo Awal',
        sub: 'Saldo awal setiap akun berdasarkan Daftar Akun (COA)',
        onPress: (nav) => nav.navigate('SaldoAwalAkunList'),
      },
      {
        icon: 'business-outline',
        title: 'Data Bank',
        sub: 'Rekening bank koperasi & riwayat transaksi kas/bank',
        onPress: (nav) => nav.navigate('RekeningList'),
      },
      {
        icon: 'storefront-outline',
        title: 'Data Pemasok',
        sub: 'Pemasok untuk pembelian aset secara kredit',
        onPress: (nav) => nav.navigate('DataReferensiList', { jenis: 'PEMASOK' }),
      },
      {
        icon: 'people-outline',
        title: 'Data Pemberi Pinjaman',
        sub: 'Pihak lain (non-bank) pemberi pinjaman/utang ke koperasi',
        onPress: (nav) => nav.navigate('DataReferensiList', { jenis: 'PEMBERI_PINJAMAN_PIHAK_LAIN' }),
      },
      {
        icon: 'card-outline',
        title: 'Data Bank Pemberi Pinjaman',
        sub: 'Bank pemberi pinjaman/utang ke koperasi',
        onPress: (nav) => nav.navigate('DataReferensiList', { jenis: 'PEMBERI_PINJAMAN_BANK' }),
      },
      {
        icon: 'receipt-outline',
        title: 'Data Beban Lain',
        sub: 'Referensi nama/deskripsi beban lain-lain',
        onPress: (nav) => nav.navigate('DataReferensiList', { jenis: 'BEBAN_LAIN' }),
      },
    ],
  },
];

export default function InputDataHubScreen() {
  const navigation = useNavigation<any>();
  // RC-S132 — hanya entri yang rutenya diizinkan role ini.
  const { permissions } = usePermission();
  const seksiTampil = SEKSI.map((seksi) => ({
    ...seksi,
    item: seksi.item.filter((f) => bolehBukaRute(ruteDariAksi(f.onPress) ?? '', permissions)),
  })).filter((seksi) => seksi.item.length > 0);

  return (
    <ScrollView style={styles.container} contentContainerStyle={ui.screenContent}>
      <Text style={styles.subtitle}>Kelola data anggota, kelembagaan, dan referensi koperasi.</Text>

      {seksiTampil.length === 0 ? (
        <Text style={styles.subtitle}>Tidak ada data yang dapat dibuka dengan role Anda saat ini.</Text>
      ) : null}
      {seksiTampil.map((seksi) => (
        <View key={seksi.judul}>
          <Text style={styles.sectionHeader}>{seksi.judul}</Text>
          {seksi.item.map((f) => (
            <TouchableOpacity
              key={f.title}
              accessibilityRole="button"
              accessibilityLabel={`${f.title}. ${f.sub}`}
              style={styles.card}
              onPress={() => f.onPress(navigation)}
            >
              <View style={styles.iconCircle}>
                <Ionicons name={f.icon} size={menuIconSize} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{f.title}</Text>
                <Text style={styles.cardSub}>{f.sub}</Text>
              </View>
              <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={ui.chevron} />
            </TouchableOpacity>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  subtitle: { ...ui.screenIntro },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    marginLeft: 4,
  },
  card: { ...ui.menuCard },
  iconCircle: { ...ui.menuIcon },
  cardTitle: { ...ui.menuTitle },
  cardSub: { ...ui.menuSub },
});

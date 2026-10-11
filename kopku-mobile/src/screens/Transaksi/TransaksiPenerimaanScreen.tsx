import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, iconSize } from '@/theme/colors';
import { ui, menuIconSize } from '@/theme/ui';
import { usePermission } from '@/hooks/usePermission';
import { bolehBukaRute, ruteDariAksi } from '@/navigation/izinRute';

type KodeGrup = 'ANGGOTA' | 'PENDANAAN' | 'PENDAPATAN' | 'RAKU' | 'KAS_BANK';

interface SubFitur {
  /** RC-S68.1 — kelompok tampilan (urutan array & rute tidak berubah). */
  grup: KodeGrup;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  sub: string;
  onPress: (nav: any) => void;
}

/**
 * Sub-fitur Penerimaan (menu Transaksi punya 3 kategori utama:
 * Penerimaan, Pengeluaran, Penyesuaian — lihat TransaksiScreen.tsx).
 *
 * "Setor Simpanan" & "Bayar Piutang Anggota" SENGAJA dipisah jadi dua
 * entri (sebelumnya satu entri "Simpanan" yang formnya juga punya
 * opsi "Tarik" — keliru, penarikan itu Pengeluaran, lihat
 * TarikSimpananFormScreen di TransaksiPengeluaranScreen.tsx). Kedua
 * entri ini sama-sama transaksi PENERIMAAN kas (uang MASUK ke
 * koperasi): setor simpanan dari anggota, atau anggota melunasi
 * piutang pinjamannya (angsuran) — makanya sekarang dikelompokkan
 * bersama di sini, bukan "Bayar Piutang Anggota" terkubur di menu
 * Pengeluaran > Pemberian Pinjaman > detail pinjaman seperti dulu.
 * Utang/Modal/Penarikan dari Bank masing-masing punya form khusus
 * dengan field sesuai permintaan (lihat UtangFormScreen,
 * ModalFormScreen, PenarikanBankFormScreen). Penghasilan Lain memakai
 * form Kas & Bank generik karena cukup jumlah+metode+tanggal saja.
 * (RC-S121: Pendapatan Diterima Dimuka tidak lagi punya entri manual —
 * dibentuk otomatis oleh sistem, lihat komentar di daftar di bawah.)
 *
 * PERBAIKAN: "Data Awal Simpanan Anggota" BUKAN transaksi/menu
 * terpisah — itu sebenarnya fungsi Setor Simpanan juga. Entri menu
 * khusus untuk itu (dan DataAwalSimpananFormScreen) sudah DIHAPUS —
 * satu-satunya pintu masuk sekarang "Setor Simpanan" di bawah ini,
 * yang formnya (SimpananFormScreen) sudah bisa menerima Simpanan
 * Pokok + Wajib + Sukarela sekaligus dalam satu kali submit (baik
 * untuk anggota baru maupun setoran rutin satu-jenis, mis. cicilan
 * Wajib bulanan).
 *
 * RC-S45 — "Simpanan Berjangka" DITAMBAHKAN ke daftar ini.
 *
 * Rutenya (`SimpananBerjangkaHistori`) sudah terdaftar di
 * RootNavigator sejak awal, tetapi TIDAK ADA satu pun layar yang
 * menavigasi ke sana — nol pemanggil. Akibatnya seluruh fitur simpanan
 * berjangka hanya dapat dicapai lewat deep link atau navigasi
 * programatik, dan dari sisi pengguna fiturnya seolah tidak ada.
 *
 * Ini kelas bug yang tidak akan pernah ditangkap typecheck maupun test
 * unit: rutenya sah, layarnya benar, servicenya jalan — yang hilang
 * hanya jalan masuknya. Karena itu ada test struktural yang memastikan
 * setiap rute Transaksi punya minimal satu pemanggil.
 *
 * Target §1/§2 (permintaan pengguna): label "Modal" -> "Modal
 * Koperasi" dan "Pendapatan Lainnya" -> "Pendapatan Koperasi" — MURNI
 * perubahan nomenklatur UI, route (`ModalForm`/`PendapatanLainnyaMenu`),
 * service, dan akun COA TIDAK diubah sama sekali. Transaksi lama tetap
 * terbaca apa adanya.
 */
const SUB_FITUR: SubFitur[] = [
  {
    grup: 'ANGGOTA',
    icon: 'wallet-outline',
    title: 'Setor Simpanan',
    sub: 'Setor simpanan pokok, wajib, dan/atau sukarela — bisa sekaligus dalam satu kali submit',
    onPress: (nav) => nav.navigate('SimpananHistori'),
  },
  {
    grup: 'ANGGOTA',
    icon: 'hourglass-outline',
    title: 'Simpanan Berjangka',
    sub: 'Penempatan simpanan berjangka anggota, akrual bunga, dan pencairan',
    onPress: (nav) => nav.navigate('SimpananBerjangkaHistori'),
  },
  {
    grup: 'ANGGOTA',
    icon: 'cash-outline',
    title: 'Bayar Piutang Anggota',
    sub: 'Terima pembayaran angsuran pinjaman dari anggota',
    onPress: (nav) => nav.navigate('BayarAngsuranForm'),
  },
  {
    grup: 'PENDANAAN',
    icon: 'document-text-outline',
    title: 'Utang Koperasi',
    sub: 'Pinjaman diterima dari LPDB/Koperasi Lain/Bank/Pihak Lain (pokok & bunga)',
    onPress: (nav) => nav.navigate('UtangForm'),
  },
  {
    grup: 'PENDANAAN',
    icon: 'pie-chart-outline',
    title: 'Modal Koperasi',
    sub: 'Setoran modal uang atau barang ke koperasi (hibah/donasi/simpanan khusus)',
    onPress: (nav) => nav.navigate('ModalForm'),
  },
  {
    grup: 'PENDAPATAN',
    icon: 'trending-up-outline',
    title: 'Pendapatan Koperasi',
    sub: 'Pendapatan investasi (Bagian SHU, bunga, sewa), unit usaha, penjualan aset, dan pendapatan lainnya',
    onPress: (nav) => nav.navigate('PendapatanLainnyaMenu'),
  },
  {
    // Pusat pencairan investasi koperasi (Penyertaan Koperasi Lain, Usaha
    // Lain, Deposito Berjangka) — memakai PelepasanInvestasiService.
    grup: 'PENDANAAN',
    icon: 'arrow-undo-outline',
    title: 'Penarikan Dana Investasi',
    sub: 'Terima kembali dana penyertaan pada koperasi/usaha lain dan pencairan deposito berjangka',
    onPress: (nav) => nav.navigate('PenarikanInvestasi'),
  },
  // RC-S67.8: entri "Bagian SHU Investasi" dihapus dari Penerimaan (duplikat).
  // Bagian SHU tetap tersedia di Pendapatan Koperasi › Penyertaan pada
  // Koperasi Lain › Bagian SHU (rute BagianShuForm tidak berubah).
  {
    grup: 'KAS_BANK',
    icon: 'swap-horizontal-outline',
    title: 'Penarikan dari Bank',
    sub: 'Kas menerima dana dari rekening bank',
    onPress: (nav) => nav.navigate('PenarikanBankForm'),
  },
  // RC-S121 — entri "Pendapatan Diterima Dimuka" (rute
  // `PendapatanDimukaForm`) DIKELUARKAN dari menu Penerimaan.
  //
  // UI SAJA. Pendapatan diterima dimuka pada aplikasi ini dibentuk
  // OTOMATIS oleh sistem (fee integral & jasa dimuka pinjaman ke akun
  // 2-1300 lewat PinjamanService/EirAccountingService/
  // AkrualJasaPinjamanService), sehingga form input manual berpotensi
  // menyebabkan pencatatan ganda. Service, akun COA 2-1300, mapping,
  // tabel, jurnal otomatis, dan pengakuan bertahap atas data lama TIDAK
  // disentuh. Data lama tetap terbaca di History Transaksi, Daftar
  // Pendapatan Dimuka, dan Status Periode Penyusutan.
  {
    // RAKU adalah posisi aset antar kantor/unit, BUKAN kategori pendapatan.
    // Pengembalian RAKU: Dr Kas/Bank, Cr 1-1800 (RAKUService).
    grup: 'RAKU',
    icon: 'return-down-back-outline',
    title: 'Pengembalian RAKU',
    sub: 'Penerimaan kembali dana RAKU dari unit usaha — mengurangi saldo RAKU, bukan pendapatan.',
    onPress: (nav) => nav.navigate('PengembalianRAKForm'),
  },
];

/**
 * RC-S68.1 — tampilan dikelompokkan per bagian agar mudah dipindai.
 * Satu warna ikon (brand) untuk semua kartu; warna status tidak dipakai
 * sekadar untuk membedakan menu.
 */
const GRUP: { kode: KodeGrup; label: string }[] = [
  { kode: 'ANGGOTA', label: 'Simpanan & Angsuran Anggota' },
  { kode: 'PENDANAAN', label: 'Pendanaan' },
  { kode: 'PENDAPATAN', label: 'Pendapatan' },
  { kode: 'RAKU', label: 'RAKU' },
  { kode: 'KAS_BANK', label: 'Kas & Bank' },
];

export default function TransaksiPenerimaanScreen() {
  const navigation = useNavigation<any>();
  // RC-S132 — entri yang rutenya tidak diizinkan role ini tidak ditampilkan.
  const { permissions } = usePermission();
  const bolehTampil = (f: SubFitur) => bolehBukaRute(ruteDariAksi(f.onPress) ?? '', permissions);

  return (
    <ScrollView style={styles.container} contentContainerStyle={ui.screenContent}>
      <Text style={styles.subtitle}>Pilih jenis penerimaan yang ingin dicatat.</Text>

      {GRUP.map((g) => {
        const item = SUB_FITUR.filter((f) => f.grup === g.kode);
        const itemTampil = item.filter(bolehTampil);
        if (itemTampil.length === 0) return null;
        return (
          <View key={g.kode} style={styles.section}>
            <Text style={styles.sectionLabel} accessibilityRole="header">
              {g.label}
            </Text>
            {itemTampil.map((f) => (
              <TouchableOpacity
                key={f.title}
                accessibilityRole="button"
                accessibilityLabel={f.title}
                accessibilityHint={f.sub}
                activeOpacity={0.7}
                style={styles.card}
                onPress={() => f.onPress(navigation)}
              >
                <View style={styles.iconCircle}>
                  <Ionicons name={f.icon} size={menuIconSize} color={colors.primary} />
                </View>
                <View style={styles.teks}>
                  <Text style={styles.cardTitle}>{f.title}</Text>
                  <Text style={styles.cardSub}>{f.sub}</Text>
                </View>
                <Ionicons name="chevron-forward" size={iconSize.md} color={colors.textFaint} style={ui.chevron} />
              </TouchableOpacity>
            ))}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  subtitle: { ...ui.screenIntro },
  section: { marginBottom: spacing.md },
  sectionLabel: { ...ui.sectionLabel },
  card: { ...ui.menuCard },
  iconCircle: { ...ui.menuIcon },
  teks: { flex: 1, minWidth: 0 },
  cardTitle: { ...ui.menuTitle },
  cardSub: { ...ui.menuSub },
});

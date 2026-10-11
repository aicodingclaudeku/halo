import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, semantic, spacing, iconSize } from '@/theme/colors';
import { ui, menuIconSize } from '@/theme/ui';
import { usePermission } from '@/hooks/usePermission';
import { bolehBukaRute, ruteDariAksi } from '@/navigation/izinRute';

type KodeGrup = 'ANGGOTA' | 'KEWAJIBAN' | 'INVESTASI_ASET' | 'BEBAN_PIUTANG' | 'KAS_BANK';

interface SubFitur {
  /** RC-S68.1 — kelompok tampilan (urutan array & rute tidak berubah). */
  grup: KodeGrup;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  sub: string;
  onPress: (nav: any) => void;
}

/**
 * Sub-fitur Pengeluaran (menu Transaksi punya 3 kategori utama:
 * Penerimaan, Pengeluaran, Penyesuaian — lihat TransaksiScreen.tsx).
 *
 * "Pemberian Pinjaman untuk Anggota" mengarah ke fitur Pinjaman yang
 * SUDAH ADA (ajukan/cairkan pinjaman) — bukan dibuat ulang di sini.
 * "Penghapusan Piutang" SENGAJA punya form sendiri (bukan lewat Kas &
 * Bank) karena murni jurnal non-kas — lihat
 * PenghapusanPiutangFormScreen.tsx & PinjamanService.hapusPiutangPinjaman.
 * "Pemindahan Saldo Rekening" memakai form Kas & Bank yang sudah ada,
 * mode Transfer (fitur transfer antar rekening TIDAK berubah, cuma
 * jalur masuknya lewat sini sekarang). Kewajiban/Pembelian Aset/Beban/
 * Keluar Anggota masing-masing punya form khusus dengan field sesuai
 * permintaan (lihat BayarUtangForm, PembelianAsetFormScreen,
 * BebanFormScreen, KeluarAnggotaFormScreen). "Kewajiban" sekarang
 * mendeteksi SEMUA utang koperasi termasuk utang usaha dari pembelian
 * aset kredit (lihat UtangService.catatUtangUsahaDariAset), bukan
 * cuma utang tunai dari bank/pihak lain — DAN (Revisi KOPKU Bagian 2)
 * sekarang juga bisa membayar kewajiban COA lain (Dana Pendidikan,
 * Utang Pajak, dst) langsung dari daftar akun Liabilitas, kecuali
 * Simpanan Sukarela (punya alur sendiri via "Tarik Simpanan Anggota"
 * di bawah). "Tarik Simpanan Anggota" dikelompokkan di sini juga
 * (kewajiban ke anggota), bukan di Penerimaan.
 */
const SUB_FITUR: SubFitur[] = [
  {
    grup: 'ANGGOTA',
    icon: 'cash-outline',
    title: 'Pemberian Pinjaman untuk Anggota',
    sub: 'Lihat, ajukan & cairkan pinjaman anggota',
    // BUG SEBELUMNYA: langsung nav.navigate('PinjamanForm') tanpa
    // lewat daftar — PinjamanListScreen (yang menampilkan semua
    // anggota yang mengajukan pinjaman & bisa ditekan untuk lihat
    // detail) jadi TIDAK PERNAH terjangkau dari menu manapun, padahal
    // sudah terdaftar di navigator. Sekarang arahkan ke daftar dulu;
    // tombol "+" di daftar itu yang membuka PinjamanForm.
    onPress: (nav) => nav.navigate('PinjamanList'),
  },
  {
    grup: 'ANGGOTA',
    icon: 'arrow-undo-outline',
    title: 'Tarik Simpanan Anggota',
    sub: 'Penarikan simpanan sukarela dan pencairan simpanan berjangka yang telah jatuh tempo',
    // Sebelumnya digabung dengan "Setor" lewat chip di form Simpanan
    // yang dipanggil dari menu Penerimaan — keliru, penarikan adalah
    // uang KELUAR (pelunasan kewajiban ke anggota), bukan penerimaan.
    // Servicenya (tarikSimpananSukarela) TIDAK berubah, cuma pintu
    // masuknya pindah ke sini, dikelompokkan dengan Kewajiban lain.
    // Audit ulang (permintaan pengguna §1): dipindah ke atas "Kewajiban"
    // (urutan sebelumnya: Kewajiban dulu baru Tarik Simpanan) — hanya
    // urutan tampilan yang berubah, onPress/service tetap persis sama.
    // RC-S70.1 — `aksen` HANYA penanda tampilan (lihat
    // TarikSimpananFormScreen). Layar itu dipakai juga oleh modul
    // Simpanan, jadi warnanya TIDAK diubah secara global; parameter ini
    // yang membuat ikonnya ikut merah hanya ketika dibuka dari
    // Pengeluaran. Tidak ada efek ke validasi/service/jurnal.
    onPress: (nav) => nav.navigate('TarikSimpananForm', { aksen: 'PENGELUARAN' }),
  },
  {
    grup: 'KEWAJIBAN',
    icon: 'card-outline',
    // RC-S74 §3 — label UI: "Kewajiban Koperasi" -> "Bayar Kewajiban".
    // Route, service, dan nama internal TIDAK berubah.
    title: 'Bayar Kewajiban',
    // Audit ulang (permintaan pengguna §1, sesi berikutnya): label menu
    // diubah dari "Kewajiban" -> "Kewajiban Koperasi". HANYA label UI —
    // route ('BayarUtangForm'), UtangService, KewajibanAkunPicker, dan
    // seluruh nama internal TIDAK berubah.
    sub: 'Bayar utang dan kewajiban yang sudah tercatat.',
    onPress: (nav) => nav.navigate('BayarUtangForm'),
  },
  // RC-S71: akrual bunga utang adalah infrastruktur akuntansi otomatis
  // (StartupTasks + gerbang tutup periode), bukan menu transaksi. Status
  // bunga per utang tampil di Laporan › Daftar Utang.
  {
    // Update pasca-Phase 18/19 (permintaan pengguna §C.3): dari menu
    // Transaksi > Pengeluaran, RAK langsung membuka form catat baru
    // (RAKFormScreen) — TIDAK lagi ke daftar/riwayat (RAKListScreen).
    // RAKListScreen TETAP ADA & TETAP DIPAKAI, dipindah ke Laporan >
    // Rincian Laporan Lainnya (lihat §C.5).
    // Update pasca-update-6-perbaikan §1: deskripsi disamakan persis
    // dengan JENIS_RAK_LABEL.PENYALURAN_DANA di RAKService.ts.
    grup: 'INVESTASI_ASET',
    icon: 'business-outline',
    // RC-S53 §T/§U — Label UI menjadi RAKU; deskripsi diperluas agar
    // mencakup modal tetap & modal tambahan, bukan hanya "penyaluran".
    // Nama tabel, kolom, jenis transaksi, dan jurnal RAK di database
    // TIDAK diubah — rename skema akan memutus histori tanpa menambah
    // kejelasan apa pun bagi pengguna.
    title: 'Rekening Antar Kantor/Unit (RAKU)',
    sub: 'Alokasi internal untuk modal tetap, modal tambahan atau operasional ke unit atau cabang',
    onPress: (nav) => nav.navigate('RAKForm', {}),
  },
  {
    grup: 'INVESTASI_ASET',
    icon: 'trending-up-outline',
    title: 'Investasi Koperasi',
    // Audit ulang (permintaan pengguna §2, sesi berikutnya): label menu
    // diubah dari "Investasi" -> "Investasi Koperasi". Route
    // ('InvestasiForm'), InvestasiService, dan enum/tipe internal TIDAK
    // berubah. "Impairment Investasi" di bawah SENGAJA tidak diubah —
    // itu istilah akuntansi (Penurunan Nilai Investasi), bukan menu ini.
    // Permintaan pengguna §6: deskripsi ditambahkan di sini juga, teks
    // PERSIS sama dengan yang ditampilkan di InvestasiFormScreen supaya
    // konsisten di seluruh halaman terkait.
    sub: 'Penyertaan pada koperasi lain, usaha lain, deposito berjangka, dan properti investasi',
    onPress: (nav) => nav.navigate('InvestasiForm'),
  },
  {
    grup: 'INVESTASI_ASET',
    icon: 'cart-outline',
    title: 'Pembelian Aset',
    sub: 'Catat pembelian aset baru, tunai atau kredit',
    // Permintaan pengguna §5: halaman perantara "Aset Tetap" (AsetList)
    // dihapus dari flow ini — Pembelian Aset sekarang langsung membuka
    // PembelianAsetForm, bukan lagi Pembelian Aset -> Aset Tetap -> Form.
    // Melihat/mengedit daftar aset yang sudah dibeli tetap tersedia
    // lewat Laporan > Rincian Laporan Lainnya > Daftar Aset Tetap
    // (DaftarAsetTetapScreen, komponen & data TIDAK dihapus/berubah).
    onPress: (nav) => nav.navigate('PembelianAsetForm'),
  },
  {
    grup: 'BEBAN_PIUTANG',
    icon: 'receipt-outline',
    title: 'Beban',
    sub: 'Tenaga kerja, sewa, transportasi, BBM, listrik, dan lainnya',
    onPress: (nav) => nav.navigate('BebanForm'),
  },
  {
    grup: 'KEWAJIBAN',
    icon: 'briefcase-outline',
    title: 'Imbalan Kerja',
    sub: 'Akrual kewajiban imbalan kerja (THR/bonus) yang belum dibayar',
    onPress: (nav) => nav.navigate('ImbalanKerjaForm'),
  },
  {
    // RC-S84 — hub Pajak di grup Kewajiban (pajak = kewajiban koperasi kepada
    // negara). Setoran pajak memakai mesin Bayar Kewajiban yang sama.
    grup: 'KEWAJIBAN',
    icon: 'calculator-outline',
    title: 'Pajak',
    sub: 'PPh Final, PPh 25/29, setor pajak, dan riwayatnya',
    onPress: (nav) => nav.navigate('PajakMenu'),
  },
  {
    grup: 'BEBAN_PIUTANG',
    icon: 'remove-circle-outline',
    title: 'Penghapusan Piutang',
    sub: 'Hapus buku piutang pinjaman tak tertagih (non-kas)',
    onPress: (nav) => nav.navigate('PenghapusanPiutangForm'),
  },
  {
    grup: 'KAS_BANK',
    icon: 'swap-horizontal-outline',
    title: 'Pemindahan Saldo Rekening',
    sub: 'Transfer saldo antar rekening kas/bank',
    onPress: (nav) =>
      nav.navigate('KasBankTransaksiForm', { tipe: 'TRANSFER', judul: 'Pengeluaran · Pemindahan Saldo Rekening' }),
  },
  // RC-S68: entri "Penyesuaian" DIHAPUS dari Pengeluaran — kini kategori
  // utama di root Transaksi (Transaksi → Penyesuaian). Rute tidak berubah.
  {
    // RC-S109 — PEMBAGIAN SHU DIPINDAH KE SINI dari menu Laporan
    // (permintaan pengguna). Pembagian SHU memang PENGELUARAN kepada
    // anggota, bukan laporan: ia menjurnal, mengurangi ekuitas, dan
    // menambah simpanan sukarela anggota. Menempatkannya di Laporan
    // membuatnya terbaca seolah sekadar tampilan angka.
    //
    // Rute, komponen, ShuService, dan seluruh perhitungannya TIDAK
    // diubah — hanya pintu masuknya yang pindah.
    grup: 'ANGGOTA',
    icon: 'gift-outline',
    title: 'Pembagian Sisa Hasil Usaha',
    sub: 'Perhitungan, pengesahan RAT, dan pembagian SHU kepada anggota',
    onPress: (nav) => nav.navigate('Shu'),
  },
  {
    grup: 'ANGGOTA',
    icon: 'exit-outline',
    title: 'Keluar Anggota',
    sub: 'Pengembalian saldo simpanan anggota yang keluar',
    // Menuju HUB, bukan langsung ke form: pengguna memilih Pengajuan
    // atau Daftar Pengajuan.
    onPress: (nav) => nav.navigate('KeluarAnggotaMenu'),
  },
];

/**
 * RC-S68.1 — tampilan dikelompokkan per bagian agar mudah dipindai.
 * RC-S70.1 — warna ikon kartu TIDAK lagi hijau brand melainkan satu
 * token merah Pengeluaran (`semantic.expenseIcon`), meneruskan aksen
 * yang sudah dipakai kartu "Pengeluaran" di hub Transaksi (RC-S68.2).
 * Tetap SATU warna untuk semua kartu — merah di sini adalah identitas
 * modul, bukan penanda status/bahaya per menu.
 */
const GRUP: { kode: KodeGrup; label: string }[] = [
  { kode: 'ANGGOTA', label: 'Anggota' },
  { kode: 'KEWAJIBAN', label: 'Kewajiban' },
  { kode: 'INVESTASI_ASET', label: 'Investasi & Aset' },
  { kode: 'BEBAN_PIUTANG', label: 'Beban & Piutang' },
  { kode: 'KAS_BANK', label: 'Kas & Bank' },
];

export default function TransaksiPengeluaranScreen() {
  const navigation = useNavigation<any>();
  // RC-S132 — entri yang rutenya tidak diizinkan role ini tidak ditampilkan.
  const { permissions } = usePermission();
  const bolehTampil = (f: SubFitur) => bolehBukaRute(ruteDariAksi(f.onPress) ?? '', permissions);
  /** RC-S70.1 — state tekan, hanya untuk tint wadah ikon (lihat §7). */
  const [ditekan, setDitekan] = useState<string | null>(null);

  return (
    <ScrollView style={styles.container} contentContainerStyle={ui.screenContent}>
      <Text style={styles.subtitle}>Pilih jenis pengeluaran yang ingin dicatat.</Text>

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
                onPressIn={() => setDitekan(f.title)}
                onPressOut={() => setDitekan(null)}
                onPress={() => f.onPress(navigation)}
              >
                <View style={[styles.iconCircle, ditekan === f.title && styles.iconCirclePressed]}>
                  <Ionicons
                    name={f.icon}
                    size={menuIconSize}
                    color={semantic.expenseIcon}
                  />
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
  // RC-S70.1 — bentuk/ukuran tetap `ui.menuIcon`; hanya latar yang
  // diganti tint merah halus lewat varian scoped Pengeluaran.
  iconCircle: { ...ui.menuIcon, ...ui.menuIconExpense },
  iconCirclePressed: { ...ui.menuIconExpensePressed },
  teks: { flex: 1, minWidth: 0 },
  cardTitle: { ...ui.menuTitle },
  cardSub: { ...ui.menuSub },
});

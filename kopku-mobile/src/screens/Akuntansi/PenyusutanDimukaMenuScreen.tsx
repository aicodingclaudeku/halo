import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing, iconSize } from '@/theme/colors';
import { ui, menuIconSize } from '@/theme/ui';

const MENU: { route: string; icon: keyof typeof Ionicons.glyphMap; title: string; sub: string; params?: Record<string, unknown> }[] = [
  /**
   * RC-S101 — LAPORAN PROMOSI EKONOMI ANGGOTA (LPEA).
   *
   * Juklak SOM No. 3/2025 menempatkannya sebagai salah satu unsur
   * laporan keuangan KSP/USP (butir 5.8 & butir 2 huruf b), tetapi di
   * aplikasi ini ia diletakkan di hub "Rincian Laporan Lainnya" sesuai
   * permintaan pengguna — URUTAN LIMA LAPORAN KEUANGAN UTAMA pada
   * LaporanScreen TIDAK diubah sama sekali.
   *
   * Ditempatkan paling atas di hub ini karena ia satu-satunya LAPORAN
   * KEUANGAN di sini; entri lainnya adalah daftar/rincian pendukung.
   */
  {
    route: 'Lpea',
    icon: 'people-circle-outline',
    title: 'Laporan Promosi Ekonomi Anggota',
    sub: 'Manfaat ekonomi anggota dari simpan pinjam & pembagian SHU (Juklak SOM 3/2025)',
  },
  { route: 'NeracaSaldo', icon: 'calculator-outline', title: 'Neraca Saldo', sub: 'Kode akun, debit, kredit, saldo per tanggal' },
  { route: 'BukuBesar', icon: 'book-outline', title: 'Buku Besar', sub: 'Mutasi per akun dengan saldo berjalan' },
  { route: 'DaftarInvestasi', icon: 'trending-up-outline', title: 'Daftar Investasi', sub: 'Rincian seluruh investasi unit usaha & koperasi lain' },
  { route: 'DaftarUtang', icon: 'document-text-outline', title: 'Daftar Utang', sub: 'Rincian seluruh utang koperasi (LPDB/Koperasi Lain/Bank/Pihak Lain)' },
  { route: 'RAKList', icon: 'git-branch-outline', title: 'Daftar Rekening Antar Kantor/Unit (RAKU)', sub: 'Rincian seluruh transaksi RAKU' },
  // RC-S54 POST-CLOSURE #7 — "Daftar Aset Tetap" + "Penyusutan Aset" DIGABUNG
  // menjadi SATU entry. Layar gabungan `DaftarAsetTetapScreen` menampilkan
  // daftar aset (nomor, tanggal perolehan, nilai perolehan, akumulasi
  // penyusutan, nilai buku, status) DAN ringkasan penyusutan per aset
  // (komponen bersama `RingkasanPenyusutanAsetList`, data dari
  // `listRingkasanPenyusutanAset()`), plus tombol ke "Status & Proses
  // Penyusutan" (rute `StatusPeriode` TETAP terdaftar, bukan dead route).
  // UI/navigasi saja: PenyusutanService, jadwal, jurnal penyusutan, dan
  // register akumulasi TIDAK disentuh.
  {
    route: 'DaftarAsetTetap',
    icon: 'business-outline',
    title: 'Daftar Aset Tetap & Penyusutan',
    sub: 'Rincian aset tetap, akumulasi penyusutan, nilai buku, ringkasan & proses penyusutan',
  },
  // Target §3 (permintaan pengguna): dipindah ke sini dari menu
  // Penerimaan langsung — TEPAT DI BAWAH "Daftar Aset Tetap" (posisi
  // eksplisit diminta). Route/komponen SAMA PERSIS (DaftarPendapatanScreen/
  // PendapatanLainnyaListScreen), registrasi ganda di LaporanStack —
  // lihat RootNavigator.tsx. Tidak ada menu "Daftar Pendapatan"/
  // "Riwayat Pendapatan" tersisa di lokasi lama (TransaksiPenerimaanScreen
  // sekarang hanya berisi entri "Pendapatan Koperasi" untuk transaksi baru).
  { route: 'DaftarPendapatan', icon: 'list-outline', title: 'Daftar Pendapatan', sub: 'Rekap pendapatan per akun COA, klasifikasi LHU' },
  // RC-S50 §9 — entry "Riwayat Pendapatan" DIHAPUS dari menu.
  //
  // UI SAJA. `PendapatanLainnyaService`, `PendapatanLainnyaListScreen`,
  // `DaftarPendapatanScreen`, tabel pendapatan, dan seluruh jurnal
  // pendapatan TIDAK disentuh. Rekap pendapatan tetap dapat dibaca
  // lewat "Daftar Pendapatan" di atas (per akun COA, klasifikasi LHU),
  // dan setiap transaksinya tetap muncul di History Transaksi.
  // RC-S50 §10 — "Status Periode Penyusutan" + "Daftar Penyusutan"
  // DIGABUNG menjadi SATU entry. Keduanya membicarakan satu hal yang
  // sama dari dua sisi (status proses vs hasil proses), dan memisahkan
  // keduanya memaksa pengguna berpindah layar untuk menjawab satu
  // pertanyaan: "penyusutan bulan ini sudah jalan, dan aset saya
  // sekarang nilai bukunya berapa?".
  //
  // Rute `StatusPeriode` dipakai apa adanya (layarnya yang menampung
  // seksi baru "Daftar Aset"); rute `PenyusutanList` dilepas dari
  // navigator supaya tidak ada dua pintu masuk / dead route (§10B).
  // Formula penyusutan, jadwal, service, dan jurnal otomatis TIDAK
  // disentuh sama sekali.
  // RC-S54 POST-CLOSURE #7 — entry "Penyusutan Aset" (rute `StatusPeriode`)
  // DILEPAS dari menu supaya tidak ada dua pintu masuk aset tetap. Rute,
  // layar, dan seluruh fungsinya TETAP ADA dan dijangkau dari layar gabungan
  // di atas (tombol "Status & Proses Penyusutan").
  // RC-S53 corrective — POLICY 03 = MODEL BIAYA, sehingga properti
  // investasi berupa bangunan juga disusutkan. Entri terpisah karena
  // sumber datanya berbeda (tabel investasi, bukan aset_tetap).
  // Poin 7 — entri "Penyusutan Properti Investasi" DIPINDAH ke
  // Transaksi > Penyesuaian (tepat di bawah Penyesuaian Nilai Wajar).
  // Rute, layar, dan service TIDAK dihapus.
  // RC-S50 §8 — entry "Jurnal Penyusutan" DIHAPUS dari menu.
  //
  // UI SAJA. `PenyusutanService`, `jalankanPenyusutanPeriode()`,
  // pembuatan jurnal penyusutan, mode OTOMATIS lewat
  // `PeriodCloseService.tutupPeriode()`, dan seluruh skedulnya TETAP
  // BERJALAN. Jurnal yang dihasilkan tetap terlihat di Buku Besar,
  // Neraca Saldo, dan History Transaksi.
  { route: 'PendapatanDimukaList', icon: 'calendar-outline', title: 'Daftar Pendapatan Dimuka', sub: 'Register pendapatan diterima dimuka' },
  // RC-S50 §8 — entry "Jurnal Pengakuan Pendapatan" DIHAPUS dari menu.
  //
  // UI SAJA. `PendapatanDimukaService.jalankanPengakuanPeriode()` dan
  // penjurnalan pengakuan bertahap TETAP BERJALAN (dipicu dari menu
  // "Penyusutan Aset" untuk mode manual, dan otomatis saat periode
  // ditutup). Registernya tetap dapat dibaca lewat "Daftar Pendapatan
  // Dimuka" di atas.
  // Audit ulang (permintaan pengguna, request baru §5): "Pelaksanaan
  // RAT" DIPINDAH KELUAR dari sini — sekarang berada di tab "Data"
  // (InputDataHubScreen.tsx), tepat di bawah "Data Beban Lain". Route
  // PelaksanaanRAT TIDAK lagi didaftarkan lewat LaporanStack (lihat
  // RootNavigator.tsx — sekarang lewat AnggotaStack/TransaksiStack,
  // pola sama seperti InputDataHub). Data RAT existing (tabel
  // `pelaksanaan_rat`, PeriodCloseService) TIDAK disentuh sama sekali.
  // Audit ulang (permintaan pengguna §20): "Tutup Periode" DIPINDAH
  // KELUAR dari sini — sekarang jadi menu level utama Laporan, tepat
  // di bawah "Rincian Laporan Lainnya" (lihat LaporanScreen.tsx).
  // Rute/komponen TutupPeriodeScreen SAMA PERSIS (masih terdaftar di
  // navigator yang sama, tidak ada layar baru) — PeriodCloseService,
  // aturan penutupan periode, validasi, & jurnal penutupan TIDAK
  // disentuh sama sekali. Ini SATU-SATUNYA entry menu untuk fitur ini
  // di seluruh app (dulu di sini, sekarang di LaporanScreen).
  // Update pasca-6-perbaikan (permintaan pengguna §2): "Bukti Bayar
  // Utang" DI ATAS "Bukti Bayar Piutang Anggota" (posisi eksplisit
  // diminta) — pola SAMA PERSIS bukti lain di bawahnya.
  { route: 'BuktiTransaksiList', icon: 'receipt-outline', title: 'Bukti Bayar Utang', sub: 'Daftar bukti pembayaran utang koperasi', params: { jenis: 'BAYAR_UTANG' } },
  { route: 'BuktiTransaksiList', icon: 'receipt-outline', title: 'Bukti Bayar Piutang Anggota', sub: 'Daftar bukti pembayaran piutang/angsuran pinjaman anggota', params: { jenis: 'BAYAR_PIUTANG' } },
  { route: 'BuktiTransaksiList', icon: 'receipt-outline', title: 'Bukti Bayar Simpanan Anggota', sub: 'Daftar bukti setoran simpanan anggota', params: { jenis: 'BAYAR_SIMPANAN' } },
  { route: 'BuktiTransaksiList', icon: 'receipt-outline', title: 'Bukti Tarik Simpanan Anggota', sub: 'Daftar bukti penarikan simpanan sukarela & pencairan simpanan berjangka', params: { jenis: 'TARIK_SIMPANAN' } },
  { route: 'BuktiTransaksiList', icon: 'receipt-outline', title: 'Bukti Keluar Anggota', sub: 'Daftar bukti pengembalian saldo anggota keluar', params: { jenis: 'KELUAR_ANGGOTA' } },
  // Menu "Aktivitas Log" DIHAPUS (permintaan pengguna) — entry, layar
  // `AktivitasLogScreen`, dan service `AuditLogService.ts` (read-only,
  // tidak dipakai fitur lain) dihapus. Pencatatan audit trail ke tabel
  // `audit_log` di berbagai service (KasBankService, RAKService, dst)
  // TIDAK disentuh sama sekali — hanya layar untuk melihatnya yang hilang.
];

/**
 * Hub "Rincian Laporan Lainnya" (Bagian F: nama diganti dari "Rincian
 * Fitur Transaksi Lainnya") — masuk dari menu Laporan.
 *
 * Sebelumnya bernama "Penyusutan & Pendapatan Dimuka" dan hanya berisi
 * 5 sub-fitur di atas; "Neraca Saldo" & "Buku Besar" dulu jadi entri
 * TERPISAH di level atas menu Laporan. Sekarang keduanya dipindah ke
 * sini juga (rute/komponen SAMA PERSIS — NeracaSaldoScreen &
 * BukuBesarScreen tidak berubah sama sekali, cuma pintu masuknya
 * pindah) supaya menu Laporan tingkat atas fokus ke laporan keuangan
 * utama (Posisi Keuangan/Laba Rugi/Perubahan Ekuitas/Arus Kas/CALK/SHU),
 * sementara laporan/proses yang lebih teknis & rinci dikumpulkan di
 * satu tempat — makanya nama hub ini diganti supaya cakupannya jelas.
 *
 * Phase 18 §13 (permintaan pengguna): entry "Rekonsiliasi Kas/Bank"
 * DIHAPUS dari daftar di atas — `RekonsiliasiScreen` &
 * `CashReconciliationService` TIDAK diubah/dihapus sama sekali (masih
 * dipakai fungsi accounting lain & masih terdaftar di navigator),
 * fitur ini tetap bisa dijangkau lewat Transaksi > Pengeluaran >
 * Pemindahan Saldo Rekening > Rekonsiliasi Kas/Bank (jalur yang sudah
 * ada sejak Phase 17 §S, TIDAK disentuh) — yang dihapus murni satu
 * entry duplikat di hub ini.
 *
 * Update pasca-Phase 18/19 (permintaan pengguna §Z): urutan disusun
 * ulang persis sesuai spesifikasi, dan "Kolektibilitas Piutang
 * Pinjaman Anggota" DIPINDAH KELUAR dari sini (sekarang di menu
 * Laporan, tepat setelah SHU — lihat LaporanScreen.tsx §T) supaya
 * hanya ada SATU entry menu untuk fitur itu di seluruh app. Entry baru:
 * Daftar Utang (§E), Daftar RAK (§C.5), Pelaksanaan RAT (§L), Bukti
 * Tarik Simpanan Anggota (§G/§W). "Status Periode" diganti judulnya
 * jadi "Status Periode Penyusutan" (rute & komponen SAMA, §F).
 */
export default function PenyusutanDimukaMenuScreen() {
  const navigation = useNavigation<any>();

  return (
    <ScrollView style={styles.container} contentContainerStyle={ui.screenContent}>
      {MENU.map((item) => (
        <TouchableOpacity
          key={`${item.route}-${item.title}`}
          accessibilityRole="button" style={styles.card}
          onPress={() => navigation.navigate(item.route, item.params)}
        >
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
  card: { ...ui.menuCard },
  iconCircle: { ...ui.menuIcon },
  cardTitle: { ...ui.menuTitle },
  cardSub: { ...ui.menuSub },
});

import React from 'react';
import { NavigationContainer, NavigationIndependentTree } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import GerbangIzinLayar from '@/components/GerbangIzinLayar';
import { usePermission } from '@/hooks/usePermission';
import { bolehLihatTab } from '@/navigation/izinRute';
import { Ionicons } from '@expo/vector-icons';
import { iconSize } from '@/theme/colors';
import { stackPresentationOptions, tabBarPresentationOptions } from '@/theme/navigation';
import AppHeader from '@/components/AppHeader';
// KOPKU Desktop — di Android kedua nilai ini kosong/tanpa efek (lihat src/desktop/desktopNav.tsx).
import { propsTabDesktop, opsiTabDesktop } from '@/desktop/desktopNav';

import DashboardScreen from '@/screens/Dashboard/DashboardScreen';
import AnggotaListScreen from '@/screens/Anggota/AnggotaListScreen';
import AnggotaDetailScreen from '@/screens/Anggota/AnggotaDetailScreen';
import AnggotaFormScreen from '@/screens/Anggota/AnggotaFormScreen';
import TransaksiScreen from '@/screens/Transaksi/TransaksiScreen';
import TransaksiPenerimaanScreen from '@/screens/Transaksi/TransaksiPenerimaanScreen';
import TransaksiPengeluaranScreen from '@/screens/Transaksi/TransaksiPengeluaranScreen';
import UtangFormScreen from '@/screens/Transaksi/UtangFormScreen';
import BayarUtangFormScreen from '@/screens/Transaksi/BayarUtangFormScreen';
import ImpairmentInvestasiFormScreen from '@/screens/Transaksi/ImpairmentInvestasiFormScreen';
import BagianShuFormScreen from '@/screens/Transaksi/BagianShuFormScreen';
import PenyesuaianScreen from '@/screens/Transaksi/PenyesuaianScreen';
import PenyesuaianNilaiWajarScreen from '@/screens/Transaksi/PenyesuaianNilaiWajarScreen';
import TarikSimpananFormScreen from '@/screens/Transaksi/TarikSimpananFormScreen';
import BayarAngsuranFormScreen from '@/screens/Transaksi/BayarAngsuranFormScreen';
import InvestasiFormScreen from '@/screens/Transaksi/InvestasiFormScreen';
import PendapatanLainnyaMenuScreen from '@/screens/Transaksi/PendapatanLainnyaMenuScreen';
import PendapatanLainnyaFormScreen from '@/screens/Transaksi/PendapatanLainnyaFormScreen';
import PendapatanInvestasiFormScreen from '@/screens/Transaksi/PendapatanInvestasiFormScreen';
import PenarikanInvestasiScreen from '@/screens/Transaksi/PenarikanInvestasiScreen';
import PenarikanInvestasiFormScreen from '@/screens/Transaksi/PenarikanInvestasiFormScreen';
import RiwayatPenarikanInvestasiScreen from '@/screens/Transaksi/RiwayatPenarikanInvestasiScreen';
import DetailPenarikanInvestasiScreen from '@/screens/Transaksi/DetailPenarikanInvestasiScreen';
import PendapatanUnitUsahaFormScreen from '@/screens/Transaksi/PendapatanUnitUsahaFormScreen';
import PengembalianRAKFormScreen from '@/screens/Transaksi/PengembalianRAKFormScreen';
import PelepasanAsetFormScreen from '@/screens/Transaksi/PelepasanAsetFormScreen';
import DaftarPendapatanScreen from '@/screens/Transaksi/DaftarPendapatanScreen';
import PendapatanAkunDetailScreen from '@/screens/Transaksi/PendapatanAkunDetailScreen';
import RAKFormScreen from '@/screens/Transaksi/RAKFormScreen';
import ModalFormScreen from '@/screens/Transaksi/ModalFormScreen';
import PenarikanBankFormScreen from '@/screens/Transaksi/PenarikanBankFormScreen';
import PembelianAsetFormScreen from '@/screens/Transaksi/PembelianAsetFormScreen';
import AsetEditFormScreen from '@/screens/Transaksi/AsetEditFormScreen';
import BebanFormScreen from '@/screens/Transaksi/BebanFormScreen';
import PajakMenuScreen from '@/screens/Pajak/PajakMenuScreen';
import PengaturanPajakScreen from '@/screens/Pajak/PengaturanPajakScreen';
import PphFinalFormScreen from '@/screens/Pajak/PphFinalFormScreen';
import AngsuranPph25FormScreen from '@/screens/Pajak/AngsuranPph25FormScreen';
import PphBadanFormScreen from '@/screens/Pajak/PphBadanFormScreen';
import SetorPajakFormScreen from '@/screens/Pajak/SetorPajakFormScreen';
import RiwayatPajakScreen from '@/screens/Pajak/RiwayatPajakScreen';
import BuktiPotongPphScreen from '@/screens/Pajak/BuktiPotongPphScreen';
import KoreksiFiskalScreen from '@/screens/Pajak/KoreksiFiskalScreen';
import ImbalanKerjaFormScreen from '@/screens/Transaksi/ImbalanKerjaFormScreen';
import KeluarAnggotaFormScreen from '@/screens/Transaksi/KeluarAnggotaFormScreen';
import KeluarAnggotaMenuScreen from '@/screens/Transaksi/KeluarAnggotaMenuScreen';
import DaftarKeluarAnggotaScreen from '@/screens/Transaksi/DaftarKeluarAnggotaScreen';
import KeluarAnggotaDetailScreen from '@/screens/Transaksi/KeluarAnggotaDetailScreen';
import PenghapusanPiutangFormScreen from '@/screens/Pinjaman/PenghapusanPiutangFormScreen';
import SimpananFormScreen from '@/screens/Simpanan/SimpananFormScreen';
import SimpananHistoriScreen from '@/screens/Simpanan/SimpananHistoriScreen';
import SimpananDetailScreen from '@/screens/Simpanan/SimpananDetailScreen';
import SimpananBerjangkaHistoriScreen from '@/screens/Simpanan/SimpananBerjangkaHistoriScreen';
import SimpananBerjangkaDetailScreen from '@/screens/Simpanan/SimpananBerjangkaDetailScreen';
import PinjamanListScreen from '@/screens/Pinjaman/PinjamanListScreen';
import PinjamanFormScreen from '@/screens/Pinjaman/PinjamanFormScreen';
import PinjamanDetailScreen from '@/screens/Pinjaman/PinjamanDetailScreen';
import PinjamanJadwalCustomScreen from '@/screens/Pinjaman/PinjamanJadwalCustomScreen';
import RekeningListScreen from '@/screens/KasBank/RekeningListScreen';
import InputDataHubScreen from '@/screens/Pengaturan/InputDataHubScreen';
import AccountListScreen from '@/screens/Pengaturan/AccountListScreen';
import AccountFormScreen from '@/screens/Pengaturan/AccountFormScreen';
import SaldoAwalFormScreen from '@/screens/Pengaturan/SaldoAwalFormScreen';
import SaldoAwalAkunListScreen from '@/screens/Pengaturan/SaldoAwalAkunListScreen';
// Audit ulang (permintaan pengguna, request baru §4): import
// DataHubScreen DIHAPUS — halaman itu sendiri HANYA berfungsi sebagai
// halaman perantara (satu kartu "Input Data" yang langsung membuka
// InputDataHubScreen) dan sudah dihapus, lihat AnggotaStackNavigator
// di bawah (initialRouteName sekarang langsung "InputDataHub"). File
// screen-nya (src/screens/Anggota/DataHubScreen.tsx) juga sudah
// dihapus dari source. Navigasi/tab "Data" TIDAK dihapus — tab bar
// masih berlabel "Data" (lihat tabBarLabel di bawah), hanya sekarang
// langsung membuka kumpulan menu data tanpa klik perantara.
import DataReferensiListScreen from '@/screens/Pengaturan/DataReferensiListScreen';
// RESTRUKTURISASI DATA — impor DataKlasifikasiAsetScreen dihapus bersama
// kedua registrasi rutenya (entry menunya di InputDataHubScreen sudah
// dihapus, jadi tidak ada pemanggil tersisa). File layarnya SENGAJA tidak
// dihapus dari repo, mengikuti pola AsetListScreen: kalau suatu saat
// pengelolaan master klasifikasi dibutuhkan lagi, tidak perlu ditulis
// ulang. AsetKlasifikasiService & defaultAsetKlasifikasi tetap dipakai
// form Pembelian Aset dan sama sekali tidak disentuh.
import DaftarInvestasiScreen from '@/screens/Akuntansi/DaftarInvestasiScreen';
import DaftarUtangScreen from '@/screens/Akuntansi/DaftarUtangScreen';
import PelaksanaanRATScreen from '@/screens/Akuntansi/PelaksanaanRATScreen';
import RAKListScreen from '@/screens/Akuntansi/RAKListScreen';
import HistoryTransaksiScreen from '@/screens/Laporan/HistoryTransaksiScreen';
import HistoryTransaksiDetailScreen from '@/screens/Laporan/HistoryTransaksiDetailScreen';
import DaftarAsetTetapScreen from '@/screens/Akuntansi/DaftarAsetTetapScreen';
import RekeningFormScreen from '@/screens/KasBank/RekeningFormScreen';
import KasBankTransaksiFormScreen from '@/screens/KasBank/KasBankTransaksiFormScreen';
import KasBankHistoriScreen from '@/screens/KasBank/KasBankHistoriScreen';
import KasBankDetailScreen from '@/screens/KasBank/KasBankDetailScreen';
import LaporanScreen from '@/screens/Laporan/LaporanScreen';
import PenyusutanDimukaMenuScreen from '@/screens/Akuntansi/PenyusutanDimukaMenuScreen';
import PenyusutanPropertiFormScreen from '@/screens/Akuntansi/PenyusutanPropertiFormScreen';
import KolektibilitasPiutangScreen from '@/screens/Laporan/KolektibilitasPiutangScreen';
import BuktiTransaksiListScreen from '@/screens/Laporan/BuktiTransaksiListScreen';
import BuktiTransaksiDetailScreen from '@/screens/Laporan/BuktiTransaksiDetailScreen';
import StatusPeriodeScreen from '@/screens/Akuntansi/StatusPeriodeScreen';
import RekonsiliasiScreen from '@/screens/Akuntansi/RekonsiliasiScreen';
import TutupPeriodeScreen from '@/screens/Akuntansi/TutupPeriodeScreen';
import PendapatanDimukaListScreen from '@/screens/Akuntansi/PendapatanDimukaListScreen';
import NeracaSaldoScreen from '@/screens/Laporan/NeracaSaldoScreen';
import BukuBesarScreen from '@/screens/Laporan/BukuBesarScreen';
import PosisiKeuanganScreen from '@/screens/Laporan/PosisiKeuanganScreen';
import LabaRugiScreen from '@/screens/Laporan/LabaRugiScreen';
import LpeaScreen from '@/screens/Laporan/LpeaScreen';
import PerubahanEkuitasScreen from '@/screens/Laporan/PerubahanEkuitasScreen';
import ArusKasScreen from '@/screens/Laporan/ArusKasScreen';
import CalkScreen from '@/screens/Laporan/CalkScreen';
import ShuScreen from '@/screens/Shu/ShuScreen';
import ShuFormScreen from '@/screens/Shu/ShuFormScreen';
import ShuDetailScreen from '@/screens/Shu/ShuDetailScreen';
import ShuAnggotaDetailScreen from '@/screens/Shu/ShuAnggotaDetailScreen';
import PengaturanScreen from '@/screens/Pengaturan/PengaturanScreen';
import KeamananScreen from '@/screens/Pengaturan/KeamananScreen';
import SinkronPerangkatScreen from '@/screens/Pengaturan/SinkronPerangkatScreen';
import { apakahDesktop } from '@/desktop/platformSinkron';
import BackupRestoreScreen from '@/screens/Pengaturan/BackupRestoreScreen';
import ImportDataAwalScreen from '@/screens/Pengaturan/ImportDataAwalScreen';
import StrukturTemplateScreen from '@/screens/Pengaturan/StrukturTemplateScreen';
import ResetDataScreen from '@/screens/Pengaturan/ResetDataScreen';
import RiwayatImportScreen from '@/screens/Pengaturan/RiwayatImportScreen';
import DeveloperScreen from '@/screens/Pengaturan/DeveloperScreen';
import UserManagementScreen from '@/screens/Pengaturan/UserManagementScreen';
import AkunAnggotaMassalScreen from '@/screens/Pengaturan/AkunAnggotaMassalScreen';
import UserFormScreen from '@/screens/Pengaturan/UserFormScreen';
import PermissionMatrixScreen from '@/screens/Pengaturan/PermissionMatrixScreen';
import IdentitasKoperasiScreen from '@/screens/Pengaturan/IdentitasKoperasiScreen';
import {
  PersonelKoperasiScreen,
  PerizinanKoperasiScreen,
  UnitUsahaKoperasiScreen,
  PeraturanInternalScreen,
} from '@/screens/Pengaturan/MasterKoperasiScreens';
import KebijakanPenarikanDiniScreen from '@/screens/Simpanan/KebijakanPenarikanDiniScreen';
import KebijakanProdukBerjangkaScreen from '@/screens/Simpanan/KebijakanProdukBerjangkaScreen';
import BungaSimpananSukarelaScreen from '@/screens/Simpanan/BungaSimpananSukarelaScreen';

/**
 * Bottom navigation sesuai PRD §38:
 * Dashboard | Anggota | Transaksi | Laporan | Pengaturan
 * FAB (+Anggota, +Simpanan, +Pinjaman) ada di masing-masing layar list.
 */

/**
 * UI/UX REDESIGN — opsi presentasi SEMUA stack: header compact `AppHeader`
 * (inset status bar dari safe-area-context, bar 56 dp) + latar konten.
 * Hanya tampilan header yang diganti; rute, judul, back, dan headerRight
 * tetap berasal dari navigator/layar seperti sebelumnya.
 */
const stackScreenOptions = {
  ...stackPresentationOptions,
  header: (props: any) => <AppHeader {...props} />,
};

const Tab = createBottomTabNavigator();
const AnggotaStack = createNativeStackNavigator();
const TransaksiStack = createNativeStackNavigator();
const LaporanStack = createNativeStackNavigator();
const PengaturanStack = createNativeStackNavigator();
/**
 * RC-S49b §B1 — STACK DI ATAS TAB BAR.
 *
 * Wadah untuk destination yang BUKAN milik salah satu tab. Sampai RC
 * ini isinya hanya `IdentitasKoperasi`: layar yang harus dapat dibuka
 * dari Dashboard tanpa menyeret tab Pengaturan ikut berpindah state.
 *
 * Pola ini standar di React Navigation (stack membungkus tab), dan ia
 * dipilih justru karena TIDAK mengubah apa pun di dalam kelima tab —
 * `Tab.Screen name="Dashboard"` tetap `DashboardScreen` langsung,
 * keempat stack tab lain tetap persis seperti sebelumnya.
 */
const RootStack = createNativeStackNavigator();

/**
 * RC-S132 — setiap layar di keempat stack melewati gerbang izin
 * (`navigation/izinRute.ts`). Rute yang tidak diizinkan role pengguna
 * menampilkan "Akses dibatasi" alih-alih layar aslinya.
 */
const tataLetakBerizin = ({ children, route }: { children: React.ReactElement; route: { name: string } }) => (
  <GerbangIzinLayar route={route}>{children}</GerbangIzinLayar>
);

function AnggotaStackNavigator() {
  return (
    <AnggotaStack.Navigator initialRouteName="InputDataHub" screenOptions={stackScreenOptions} screenLayout={tataLetakBerizin}>
      <AnggotaStack.Screen name="AnggotaList" component={AnggotaListScreen} options={{ title: 'Anggota' }} />
      <AnggotaStack.Screen name="AnggotaDetail" component={AnggotaDetailScreen} options={{ title: 'Detail Anggota' }} />
      <AnggotaStack.Screen name="AnggotaForm" component={AnggotaFormScreen} options={{ title: 'Form Anggota' }} />
      {/* Bagian J/K (permintaan pengguna): hub Input Data & seluruh
          sub-layarnya didaftarkan JUGA di sini (bukan dipindah dari
          TransaksiStack — pola registrasi ganda yang sama komponennya
          di dua navigator, aman & lazim di React Navigation) supaya
          bisa diakses langsung dari tab "Data" tanpa memutus rute yang
          masih dipakai layar-layar di dalam TransaksiStack (mis.
          picker di form transaksi). Komponennya SAMA PERSIS, tidak
          ada implementasi kedua. */}
      <AnggotaStack.Screen name="InputDataHub" component={InputDataHubScreen} options={{ title: 'Data' }} />
      <AnggotaStack.Screen name="AccountList" component={AccountListScreen} options={{ title: 'Daftar Akun' }} />
      <AnggotaStack.Screen name="AccountForm" component={AccountFormScreen} options={{ title: 'Input Akun' }} />
      <AnggotaStack.Screen name="SaldoAwalAkunList" component={SaldoAwalAkunListScreen} options={{ title: 'Saldo Awal' }} />
      <AnggotaStack.Screen name="RekeningList" component={RekeningListScreen} options={{ title: 'Data Bank' }} />
      <AnggotaStack.Screen name="RekeningForm" component={RekeningFormScreen} options={{ title: 'Edit Data Bank' }} />
      {/* Phase 18 §5 (masih berlaku): registrasi "AsetList" di
          AnggotaStack DIHAPUS — entry "Data Aset" yang dulu menavigasi
          ke sini dari InputDataHubScreen (dalam stack ini) sudah
          dihapus, jadi rute ini jadi dead route kalau tetap
          didaftarkan di sini.
          Permintaan pengguna §5 (sesi berikutnya): "AsetList"
          (AsetListScreen, layar perantara "Aset Tetap") SEKARANG JUGA
          dihapus dari TransaksiStack — Transaksi > Pengeluaran >
          Pembelian Aset sekarang langsung membuka PembelianAsetForm,
          tidak lewat daftar aset lagi. AsetListScreen.tsx file TIDAK
          dihapus (masih ada di repo, tidak lagi diregistrasikan di
          navigator manapun) supaya tidak ada logic kedua yang harus
          dibuat ulang kalau suatu saat dibutuhkan lagi. Melihat/
          mengedit aset yang sudah dibeli tetap tersedia lewat
          DaftarAsetTetapScreen (Laporan > Rincian Laporan Lainnya).
          "AsetDetail" (permintaan pengguna §10) SEKARANG dihapus
          total — lihat komentar registrasi TransaksiStack di bawah. */}
      <AnggotaStack.Screen name="DataReferensiList" component={DataReferensiListScreen} options={{ title: 'Data Referensi' }} />
      {/* RESTRUKTURISASI DATA — master kelembagaan & personel sekarang
          dibuka dari tab Data (InputDataHubScreen), bukan lagi dari
          dalam form Identitas Koperasi. Karena itu keempatnya
          didaftarkan DI SINI, stack yang sama dengan hub pemanggilnya,
          supaya tombol kembali membawa pengguna ke Data — bukan ke
          Identitas Koperasi, yang tidak lagi ada hubungannya.

          Registrasi lama di RootStack DIHAPUS (bukan dibiarkan ganda):
          setelah enam pintasan di IdentitasKoperasiScreen dihapus,
          tidak ada satu pun pemanggil yang tersisa di sana.
          Komponennya SAMA PERSIS — tidak ada implementasi kedua.

          "PersonelKoperasi" melayani KELIMA jenis personel; yang
          membedakan hanya parameter `kategori`. */}
      <AnggotaStack.Screen
        name="PersonelKoperasi"
        component={PersonelKoperasiScreen}
        options={({ route }) => ({
          title: (route.params as { judul?: string } | undefined)?.judul ?? 'Personel Koperasi',
        })}
      />
      <AnggotaStack.Screen name="PerizinanKoperasi" component={PerizinanKoperasiScreen} options={{ title: 'Perizinan yang Dimiliki' }} />
      <AnggotaStack.Screen name="UnitUsahaKoperasi" component={UnitUsahaKoperasiScreen} options={{ title: 'Unit Usaha' }} />
      <AnggotaStack.Screen name="PeraturanInternal" component={PeraturanInternalScreen} options={{ title: 'Peraturan Internal' }} />
      {/* RESTRUKTURISASI DATA — registrasi "DataKlasifikasiAset" DIHAPUS
          dari stack ini: entry menunya di InputDataHubScreen sudah
          dihapus, jadi rute ini tidak punya pemanggil lagi di sini dan
          akan menjadi dead route kalau dibiarkan.

          FITUR klasifikasi aset TIDAK dihapus: AsetKlasifikasiService &
          defaultAsetKlasifikasi tetap dipakai sebagai picker oleh
          PembelianAsetForm, ModalForm, dan AsetEditForm. Yang hilang
          hanya layar pengelolaan masternya dari menu. */}
      {/* Audit ulang (permintaan pengguna, request baru §5): "Pelaksanaan
          RAT" dipindah ke sini (tab "Data", di bawah "Data Beban Lain"
          di InputDataHubScreen.tsx) — registrasi ganda yang sama
          komponennya dengan LaporanStack di bawah (pola yang sama
          dengan InputDataHub dkk di atas), route lama di LaporanStack
          SUDAH DIHAPUS (lihat LaporanStackNavigator) supaya tidak ada
          dua pintu masuk menu yang membingungkan. Data RAT existing
          (tabel `pelaksanaan_rat`, PeriodCloseService, dst) tidak disentuh. */}
      <AnggotaStack.Screen name="PelaksanaanRAT" component={PelaksanaanRATScreen} options={{ title: 'Pelaksanaan RAT' }} />
      {/* Update pasca-Phase 18/19 (permintaan pengguna §A): shortcut
          History Transaksi DIHAPUS dari hub Data — entry menu yang
          dulu ada di DataHubScreen.tsx sudah dihapus, jadi registrasi
          di sini jadi dead route. Route TETAP terdaftar & aktif di
          LaporanStack (dijangkau dari Laporan, di bawah menu SHU) —
          komponennya (HistoryTransaksiScreen/HistoryTransaksiDetailScreen)
          TIDAK dihapus, seluruh data histori tetap ada.
          RAKForm juga DIHAPUS dari sini — sejak §A tidak ada lagi
          shortcut apa pun di AnggotaStack yang menavigasi ke RAKForm
          (dulu lewat History Transaksi -> RAK). Route TETAP terdaftar
          & aktif di TransaksiStack (entri menu langsung) & LaporanStack
          (dari RAKListScreen & HistoryTransaksiDetailScreen). */}
    </AnggotaStack.Navigator>
  );
}

function TransaksiStackNavigator() {
  return (
    <TransaksiStack.Navigator screenOptions={stackScreenOptions} screenLayout={tataLetakBerizin}>
      <TransaksiStack.Screen name="TransaksiHub" component={TransaksiScreen} options={{ title: 'Transaksi' }} />
      <TransaksiStack.Screen name="TransaksiPenerimaan" component={TransaksiPenerimaanScreen} options={{ title: 'Penerimaan' }} />
      <TransaksiStack.Screen name="TransaksiPengeluaran" component={TransaksiPengeluaranScreen} options={{ title: 'Pengeluaran' }} />
      {/* Update pasca-Phase 18/19 (permintaan pengguna §A): shortcut
          History Transaksi DIHAPUS dari hub Transaksi juga — sama
          seperti di atas, komponen & data TETAP ADA, dijangkau lewat
          Laporan. */}
      <TransaksiStack.Screen name="PenghapusanPiutangForm" component={PenghapusanPiutangFormScreen} options={{ title: 'Penghapusan Piutang' }} />
      <TransaksiStack.Screen name="UtangForm" component={UtangFormScreen} options={{ title: 'Utang Koperasi' }} />
      <TransaksiStack.Screen name="BayarUtangForm" component={BayarUtangFormScreen} options={{ title: 'Kewajiban Koperasi' }} />
      {/* RC-S84 — menu Pajak (Pengeluaran > Kewajiban > Pajak). */}
      <TransaksiStack.Screen name="PajakMenu" component={PajakMenuScreen} options={{ title: 'Pajak' }} />
      <TransaksiStack.Screen name="PengaturanPajak" component={PengaturanPajakScreen} options={{ title: 'Pengaturan Pajak' }} />
      <TransaksiStack.Screen name="PphFinalForm" component={PphFinalFormScreen} options={{ title: 'PPh Final 0,5%' }} />
      <TransaksiStack.Screen name="AngsuranPph25Form" component={AngsuranPph25FormScreen} options={{ title: 'Angsuran PPh 25' }} />
      <TransaksiStack.Screen name="PphBadanForm" component={PphBadanFormScreen} options={{ title: 'PPh Badan Akhir Tahun' }} />
      <TransaksiStack.Screen name="SetorPajakForm" component={SetorPajakFormScreen} options={{ title: 'Setor Pajak' }} />
      <TransaksiStack.Screen name="RiwayatPajak" component={RiwayatPajakScreen} options={{ title: 'Riwayat Pajak' }} />
      {/* RC-S127 — bukti potong PPh 4(2) bunga simpanan (Sukarela & Berjangka). */}
      <TransaksiStack.Screen name="BuktiPotongPph" component={BuktiPotongPphScreen} options={{ title: 'Bukti Potong Bunga Simpanan' }} />
      {/* RC-S87 — koreksi fiskal PPh Badan. */}
      <TransaksiStack.Screen name="KoreksiFiskal" component={KoreksiFiskalScreen} options={{ title: 'Koreksi Fiskal' }} />
      <TransaksiStack.Screen name="ImpairmentInvestasiForm" component={ImpairmentInvestasiFormScreen} options={{ title: 'Impairment Investasi' }} />
      <TransaksiStack.Screen name="BagianShuForm" component={BagianShuFormScreen} options={{ title: 'Bagian SHU Investasi' }} />
      <TransaksiStack.Screen name="TarikSimpananForm" component={TarikSimpananFormScreen} options={{ title: 'Tarik Simpanan Anggota' }} />
      {/* Kebijakan penarikan dini — DIPINDAH dari Pengaturan (permintaan
          pengguna: Pengaturan hanya untuk konfigurasi aplikasi; seluruh
          workflow penarikan/pencairan berpusat di Tarik Simpanan Anggota).
          Layar, service `simpanKebijakanDini()` (menuntut izin
          `pengaturan:edit`), versioning, dan audit trail TIDAK diubah —
          hanya stack tempat rutenya didaftarkan. Pintu masuknya kini dari
          Tarik Simpanan Anggota, digerbang izin `pengaturan:view` yang sama
          dengan menu Pengaturan sebelumnya. */}
      <TransaksiStack.Screen
        name="KebijakanPenarikanDini"
        component={KebijakanPenarikanDiniScreen}
        options={{ title: 'Kebijakan Penarikan Dini' }}
      />
      <TransaksiStack.Screen name="BayarAngsuranForm" component={BayarAngsuranFormScreen} options={{ title: 'Bayar Piutang Anggota' }} />
      <TransaksiStack.Screen name="InvestasiForm" component={InvestasiFormScreen} options={{ title: 'Investasi Koperasi' }} />
      {/* Target §1/§2/§3 (permintaan pengguna): menu diganti nama jadi
          "Pendapatan Koperasi" (PendapatanLainnyaMenuScreen.tsx) — nama
          route/komponen internal TETAP "PendapatanLainnya*" (tidak
          wajib rename). "Daftar Pendapatan"/"PendapatanAkunDetail"/
          "Riwayat Pendapatan" (`PendapatanLainnyaList`) DIHAPUS dari
          sini — sudah dipindah & didaftarkan ulang di LaporanStack
          (Laporan > Rincian Laporan Lainnya, di bawah "Daftar Aset
          Tetap"), supaya tidak ada dua pintu masuk / route mati di
          sini. Komponennya SAMA PERSIS, TIDAK dihapus/diubah. */}
      <TransaksiStack.Screen name="PendapatanLainnyaMenu" component={PendapatanLainnyaMenuScreen} options={{ title: 'Pendapatan Koperasi' }} />
      <TransaksiStack.Screen name="PendapatanLainnyaForm" component={PendapatanLainnyaFormScreen} options={{ title: 'Tambah Transaksi Pendapatan' }} />
      {/* RC-S67 — leaf Pendapatan Investasi (Usaha Lain · Bunga, Deposito · Bunga, Properti · Sewa) dari menu canonical Pendapatan Koperasi. Judul diganti layar sesuai kategori. */}
      <TransaksiStack.Screen name="PendapatanInvestasiForm" component={PendapatanInvestasiFormScreen} options={{ title: 'Pendapatan Investasi' }} />
      {/* Penerimaan Penarikan Dana Investasi — pusat pencairan investasi.
          Posting tetap lewat PelepasanInvestasiService (pratinjau == eksekusi). */}
      <TransaksiStack.Screen name="PenarikanInvestasi" component={PenarikanInvestasiScreen} options={{ title: 'Penarikan Dana Investasi' }} />
      <TransaksiStack.Screen name="PenarikanInvestasiForm" component={PenarikanInvestasiFormScreen} options={{ title: 'Penarikan Investasi' }} />
      <TransaksiStack.Screen name="RiwayatPenarikanInvestasi" component={RiwayatPenarikanInvestasiScreen} options={{ title: 'Riwayat Penarikan Investasi' }} />
      <TransaksiStack.Screen name="DetailPenarikanInvestasi" component={DetailPenarikanInvestasiScreen} options={{ title: 'Detail Penarikan Investasi' }} />
      {/* Pendapatan Unit Usaha: PENDAPATAN, Cr 4-1400. */}
      <TransaksiStack.Screen name="PendapatanUnitUsahaForm" component={PendapatanUnitUsahaFormScreen} options={{ title: 'Pendapatan Unit Usaha' }} />
      {/* Pengembalian RAKU: Dr Kas/Bank / Cr 1-1800, bukan pendapatan. */}
      <TransaksiStack.Screen name="PengembalianRAKForm" component={PengembalianRAKFormScreen} options={{ title: 'Pengembalian RAKU' }} />
      {/* RC-S67.7 — form transaksi Penjualan / Pelepasan Aset (PelepasanAsetTetapService existing). */}
      <TransaksiStack.Screen name="PelepasanAsetForm" component={PelepasanAsetFormScreen} options={{ title: 'Penjualan / Pelepasan Aset' }} />
      {/* Update pasca-Phase 18/19 (permintaan pengguna §C.3): dari
          Pengeluaran, RAK langsung ke form (RAKForm) — RAKList TIDAK
          lagi didaftarkan di TransaksiStack (dead route setelah entry
          menunya diarahkan langsung ke form), dipindah ke LaporanStack
          (§C.5, di bawah Rincian Laporan Lainnya). */}
      <TransaksiStack.Screen name="RAKForm" component={RAKFormScreen} options={{ title: 'Rekening Antar Kantor/Unit (RAKU)' }} />
      {/* RC-S70.2 — rute "PemberianPinjamanKoperasiForm" DIHAPUS bersama
          layar & service-nya: fitur "Pemberian Pinjaman untuk Koperasi"
          sudah ditetapkan dihapus dari aplikasi. JANGAN didaftarkan ulang
          dan jangan dibuatkan rute pengganti. Struktur tabel
          `pinjaman_koperasi` dan klasifikasi arus kas
          PEMBERIAN_PINJAMAN_KOPERASI sengaja DIPERTAHANKAN agar data &
          jurnal historis tetap terbaca — lihat RC-S70.2_LEGACY_REMOVAL_FINAL.md.
          Catatan: "Pemberian Pinjaman untuk ANGGOTA" (rute PinjamanList)
          adalah fitur LAIN dan tetap AKTIF. */}
      <TransaksiStack.Screen name="ModalForm" component={ModalFormScreen} options={{ title: 'Modal Koperasi' }} />
      <TransaksiStack.Screen name="PenarikanBankForm" component={PenarikanBankFormScreen} options={{ title: 'Penarikan dari Bank' }} />
      {/* RC-S121 — registrasi "PendapatanDimukaForm" DILEPAS bersamaan
          dengan entri menunya di Transaksi > Penerimaan. Pendapatan
          diterima dimuka dibentuk OTOMATIS oleh sistem (fee integral &
          jasa dimuka pinjaman -> akun 2-1300 lewat PinjamanService /
          EirAccountingService / AkrualJasaPinjamanService), sehingga input
          manual berisiko mencatat ganda. Rute yang tidak terdaftar tidak
          dapat dibuka dari UI mana pun (termasuk deep link).
          UI SAJA: `PendapatanDimukaService` (termasuk pengakuan bertahap
          atas data lama di Status Periode Penyusutan), akun COA 2-1300,
          mapping, tabel, migrasi, dan jurnal otomatis TIDAK disentuh.
          Berkas `PendapatanDimukaFormScreen.tsx` dibiarkan (tidak
          diimpor), pola yang sama dengan JurnalPengakuanDimukaScreen. */}
      <TransaksiStack.Screen name="PembelianAsetForm" component={PembelianAsetFormScreen} options={{ title: 'Pembelian Aset' }} />
      {/* "AsetDetail" DIHAPUS (permintaan pengguna §10) — Edit & Delete
          sekarang tersedia lewat DaftarAsetTetapScreen (Laporan >
          Rincian Laporan Lainnya > Daftar Aset Tetap, §11), memakai
          `AsetEditFormScreen`/`AsetService.hapusAset` — tidak ada logic
          edit/delete kedua yang dibuat. (AsetListScreen, yang dulu juga
          punya aksi Edit/Delete yang sama, sudah tidak diregistrasikan
          di navigator manapun sejak permintaan pengguna §5 — lihat
          komentar di AnggotaStack di atas.) */}
      <TransaksiStack.Screen name="AsetEditForm" component={AsetEditFormScreen} options={{ title: 'Aset Tetap' }} />
      <TransaksiStack.Screen name="BebanForm" component={BebanFormScreen} options={{ title: 'Beban' }} />
      <TransaksiStack.Screen name="ImbalanKerjaForm" component={ImbalanKerjaFormScreen} options={{ title: 'Imbalan Kerja' }} />
      {/* KELUAR ANGGOTA — HUB + dua tujuan. Sebelumnya "KeluarAnggotaForm"
          memuat form pengajuan DAN daftar pengajuan beserta aksi
          Setujui/Tolak/Bayar dalam satu gulungan panjang; daftar baru
          terlihat setelah pengguna menggulir melewati seluruh form.

          Sekarang menu Pengeluaran membuka hub, lalu pengguna memilih
          satu tujuan. Ketiganya di TransaksiStack yang sama — tanpa
          nested navigator — sehingga Back dari Pengajuan maupun Daftar
          kembali ke hub, dan Back dari hub kembali ke Transaksi.

          Rute "KeluarAnggotaForm" DIPERTAHANKAN (bukan diganti nama):
          ia tetap layar pengajuan, hanya isinya yang dipersempit. */}
      <TransaksiStack.Screen name="KeluarAnggotaMenu" component={KeluarAnggotaMenuScreen} options={{ title: 'Keluar Anggota' }} />
      <TransaksiStack.Screen name="KeluarAnggotaForm" component={KeluarAnggotaFormScreen} options={{ title: 'Pengajuan Keluar Anggota' }} />
      <TransaksiStack.Screen name="DaftarKeluarAnggota" component={DaftarKeluarAnggotaScreen} options={{ title: 'Daftar Pengajuan' }} />
      {/* RC-S75 — DETAIL PENGAJUAN. Seluruh aksi (Setujui/Tolak/Bayar)
          dan pemilih Sumber Pembayaran pindah dari kartu daftar ke sini,
          supaya keputusan dibuat pada SATU pengajuan yang identitas dan
          angkanya sedang terlihat penuh. Params-nya hanya
          `keluarAnggotaId`; datanya dibaca ulang dari service.
          Stack yang sama dengan hub/form/daftar — tanpa nested navigator,
          sehingga Back: Detail → Daftar → Keluar Anggota → Transaksi. */}
      <TransaksiStack.Screen name="KeluarAnggotaDetail" component={KeluarAnggotaDetailScreen} options={{ title: 'Detail Pengajuan' }} />
      <TransaksiStack.Screen name="Rekonsiliasi" component={RekonsiliasiScreen} options={{ title: 'Rekonsiliasi Kas/Bank' }} />
      {/*
        Fase 9 — HUB PENYESUAIAN. Rekonsiliasi, Penyesuaian Nilai Wajar,
        dan Impairment Investasi dikumpulkan di bawah satu pintu. Rute
        ketiganya TIDAK diduplikasi: hub hanya menavigasi ke rute yang
        sudah terdaftar di stack yang sama.
      */}
      <TransaksiStack.Screen name="Penyesuaian" component={PenyesuaianScreen} options={{ title: 'Penyesuaian' }} />
      <TransaksiStack.Screen name="PenyesuaianNilaiWajar" component={PenyesuaianNilaiWajarScreen} options={{ title: 'Penyesuaian Nilai Wajar' }} />
      {/* Poin 7 — Penyusutan Properti Investasi dijangkau dari hub
          Penyesuaian. Komponen SAMA dengan pendaftaran di LaporanStack
          (bukan salinan); pendaftaran lama dibiarkan agar tautan lama tidak patah. */}
      <TransaksiStack.Screen name="PenyusutanPropertiInvestasi" component={PenyusutanPropertiFormScreen} options={{ title: 'Penyusutan Properti Investasi' }} />
      {/* Tab "Riwayat" di setiap menu transaksi: baris riwayat membuka Detail
          History Transaksi (satu pintu koreksi/pembatalan) — di stack Transaksi
          supaya tombol Kembali kembali ke menu asal. Komponen SAMA dengan LaporanStack. */}
      <TransaksiStack.Screen name="HistoryTransaksiDetail" component={HistoryTransaksiDetailScreen} options={{ title: 'Detail Transaksi' }} />
      {/* Kebijakan & pembukuan akhir bulan bunga simpanan sukarela (Transaksi › Penyesuaian). */}
      <TransaksiStack.Screen name="BungaSimpananSukarela" component={BungaSimpananSukarelaScreen} options={{ title: 'Bunga Simpanan Sukarela' }} />
      {/* RC-S109 — KOLEKTIBILITAS & PEMBAGIAN SHU didaftarkan di stack
          Transaksi karena pintu masuknya pindah ke sini (Penyesuaian dan
          Pengeluaran). Komponennya SAMA dengan yang dipakai stack
          Laporan — bukan salinan — sehingga tidak ada layar maupun
          logika yang berganda. Pendaftaran di LaporanStack dibiarkan
          apa adanya supaya tautan/riwayat navigasi lama tidak patah. */}
      <TransaksiStack.Screen
        name="KolektibilitasPiutang"
        component={KolektibilitasPiutangScreen}
        options={{ title: 'Kolektibilitas Piutang' }}
      />
      <TransaksiStack.Screen name="Shu" component={ShuScreen} options={{ title: 'Pembagian Sisa Hasil Usaha' }} />
      <TransaksiStack.Screen name="ShuForm" component={ShuFormScreen} options={{ title: 'Hitung Pembagian SHU' }} />
      <TransaksiStack.Screen name="ShuDetail" component={ShuDetailScreen} options={{ title: 'Rincian Pembagian SHU' }} />
      <TransaksiStack.Screen
        name="ShuAnggotaDetail"
        component={ShuAnggotaDetailScreen}
        options={{ title: 'SHU per Anggota' }}
      />
      <TransaksiStack.Screen name="SimpananHistori" component={SimpananHistoriScreen} options={{ title: 'Simpanan' }} />
      {/* DETAIL SATU TRANSAKSI SIMPANAN. Sebelumnya menyentuh baris di
          "SimpananHistori" tidak melakukan apa pun — daftar itu jalan
          buntu, dan nomor transaksi, sumber dana, periode, serta status
          koreksi tidak terlihat di mana pun.

          Layar ini READ-ONLY: membaca `getSimpananDetailById()` dan
          `getRingkasanSaldoSimpananAnggota()` (keduanya memakai
          `getSaldoSimpanan` yang sama dengan seluruh aplikasi). Tidak
          ada jurnal, koreksi, atau mutasi apa pun dari sini.

          Didaftarkan HANYA di TransaksiStack — stack yang sama dengan
          `SimpananHistori` (satu-satunya pemanggilnya), jadi
          `navigate('SimpananDetail', { simpananId })` ditangani navigator
          ini juga, tanpa nested navigator dan tanpa rute duplikat.
          Detail Anggota SENGAJA tidak dipakai: itu ringkasan seluruh data
          anggota, bukan satu transaksi. */}
      <TransaksiStack.Screen
        name="SimpananDetail"
        component={SimpananDetailScreen}
        options={{ title: 'Detail Simpanan' }}
      />
      {/* RC-S47 §B/§C — judul header mengikuti JALUR yang membuka form.
          Dibuka tanpa `mode` (Setor Simpanan) judulnya tetap "Setor
          Simpanan"; dibuka dengan `mode: 'BERJANGKA'` dari layar
          dedicated, judulnya "Penempatan Simpanan Berjangka" — karena
          yang terjadi di sana adalah pembukaan kontrak, bukan setoran.
          Pola `options={({ route }) => ...}` sudah dipakai
          KasBankTransaksiForm di bawah; tidak ada pola baru. */}
      <TransaksiStack.Screen
        name="SimpananForm"
        component={SimpananFormScreen}
        options={({ route }) => ({
          title:
            (route.params as any)?.mode === 'BERJANGKA'
              ? 'Penempatan Simpanan Berjangka'
              : 'Setor Simpanan',
        })}
      />
      {/* §23 — histori simpanan berjangka. Layar TERPISAH dari
          "SimpananHistori" karena sumbernya subledger yang berbeda
          (`simpanan_berjangka`) dan kolom yang ditampilkan pun berbeda
          (tenor, rate, jatuh tempo, status kontrak). Menggabungkannya
          ke daftar simpanan reguler akan memaksa satu daftar
          menampilkan dua bentuk data yang tidak sebanding. */}
      <TransaksiStack.Screen name="SimpananBerjangkaHistori" component={SimpananBerjangkaHistoriScreen} options={{ title: 'Simpanan Berjangka' }} />
      {/* RC-S47 §E — DETAIL KONTRAK. Sebelumnya menyentuh kartu kontrak
          di layar histori tidak melakukan apa pun: daftar itu jalan
          buntu, dan satu-satunya aksi kontrak (pencairan) hanya bisa
          ditemukan lewat Pengeluaran › Tarik Simpanan Anggota.

          Layar ini TIDAK membawa data model baru: ia membaca subledger
          lewat `getSimpananBerjangka()` dan hasil service
          `previewPencairanDini()`/`getPencairanDiniKontrak()` yang sudah
          ada. Didaftarkan HANYA di TransaksiStack — satu-satunya stack
          yang punya `SimpananBerjangkaHistori` (pemanggilnya) dan
          `TarikSimpananForm` (tujuan CTA-nya). */}
      <TransaksiStack.Screen
        name="SimpananBerjangkaDetail"
        component={SimpananBerjangkaDetailScreen}
        options={{ title: 'Detail Simpanan Berjangka' }}
      />
      {/* RC-S128 — kebijakan produk simpanan berjangka (berversi). Pintu
          masuk: form penempatan berjangka & detail kontrak legacy. */}
      <TransaksiStack.Screen
        name="KebijakanProdukBerjangka"
        component={KebijakanProdukBerjangkaScreen}
        options={{ title: 'Kebijakan Produk Simpanan Berjangka' }}
      />
      <TransaksiStack.Screen name="PinjamanList" component={PinjamanListScreen} options={{ title: 'Pinjaman' }} />
      <TransaksiStack.Screen name="PinjamanForm" component={PinjamanFormScreen} options={{ title: 'Ajukan Pinjaman' }} />
      <TransaksiStack.Screen name="PinjamanDetail" component={PinjamanDetailScreen} options={{ title: 'Detail Pinjaman' }} />
      <TransaksiStack.Screen name="PinjamanJadwalCustom" component={PinjamanJadwalCustomScreen} options={{ title: 'Jadwal Angsuran Custom' }} />
      <TransaksiStack.Screen name="RekeningList" component={RekeningListScreen} options={{ title: 'Data Bank' }} />
      <TransaksiStack.Screen name="InputDataHub" component={InputDataHubScreen} options={{ title: 'Data' }} />
      <TransaksiStack.Screen name="AccountList" component={AccountListScreen} options={{ title: 'Daftar Akun' }} />
      <TransaksiStack.Screen name="AccountForm" component={AccountFormScreen} options={{ title: 'Input Akun' }} />
      <TransaksiStack.Screen name="SaldoAwalForm" component={SaldoAwalFormScreen} options={{ title: 'Saldo Awal Kas' }} />
      <TransaksiStack.Screen name="SaldoAwalAkunList" component={SaldoAwalAkunListScreen} options={{ title: 'Saldo Awal' }} />
      <TransaksiStack.Screen name="DataReferensiList" component={DataReferensiListScreen} options={{ title: 'Data Referensi' }} />
      {/* RESTRUKTURISASI DATA — "DataKlasifikasiAset" dihapus juga dari
          stack ini: satu-satunya pemanggilnya adalah entry menu di
          InputDataHubScreen yang sudah dihapus. Service klasifikasi aset
          tetap hidup dan tetap dipakai form Pembelian Aset. */}
      {/* Audit ulang (permintaan pengguna, request baru §5): registrasi
          ganda sama seperti AnggotaStack di atas — supaya menu
          "Pelaksanaan RAT" di InputDataHubScreen tetap bisa dijangkau
          walau layar itu diakses lewat TransaksiStack. */}
      <TransaksiStack.Screen name="PelaksanaanRAT" component={PelaksanaanRATScreen} options={{ title: 'Pelaksanaan RAT' }} />
      <TransaksiStack.Screen name="RekeningForm" component={RekeningFormScreen} options={{ title: 'Edit Data Bank' }} />
      <TransaksiStack.Screen
        name="KasBankTransaksiForm"
        component={KasBankTransaksiFormScreen}
        options={({ route }) => ({
          // Phase 17 §L: label default diganti "Penerimaan Lain"
          // (dulu "Transaksi Kas & Bank" — generik & tidak jelas
          // maksudnya). Layar ini juga dipakai untuk transfer antar
          // rekening (Pengeluaran -> Pemindahan Saldo Rekening) lewat
          // route.params.judul yang sudah ada — kalau judul itu diisi,
          // dipakai sebagai title header supaya konteksnya tetap jelas,
          // bukan selalu dipaksa "Penerimaan Lain".
          title: (route.params as any)?.judul ?? 'Penerimaan Lain',
        })}
      />
      <TransaksiStack.Screen name="KasBankHistori" component={KasBankHistoriScreen} options={{ title: 'Riwayat Transaksi' }} />
      <TransaksiStack.Screen name="KasBankDetail" component={KasBankDetailScreen} options={{ title: 'Detail Transaksi' }} />
    </TransaksiStack.Navigator>
  );
}

function LaporanStackNavigator() {
  return (
    <LaporanStack.Navigator screenOptions={stackScreenOptions} screenLayout={tataLetakBerizin}>
      <LaporanStack.Screen name="LaporanMenu" component={LaporanScreen} options={{ title: 'Laporan' }} />
      <LaporanStack.Screen name="PenyusutanDimukaMenu" component={PenyusutanDimukaMenuScreen} options={{ title: 'Rincian Laporan Lainnya' }} />
      {/* RC-S101 — "Laporan Promosi Ekonomi Anggota" (LPEA), Juklak SOM
          No. 3/2025 butir 5.8 & Lampiran butir 7. Didaftarkan di
          LaporanStack dan dijangkau dari hub "Rincian Laporan Lainnya"
          — URUTAN LIMA LAPORAN KEUANGAN UTAMA di LaporanScreen TIDAK
          disentuh sama sekali. */}
      <LaporanStack.Screen name="Lpea" component={LpeaScreen} options={{ title: 'Promosi Ekonomi Anggota' }} />
      {/* Update pasca-Phase 18/19 (permintaan pengguna §C.5): daftar
          RAK dipindah ke sini (dari Transaksi) — RAKListScreen SAMA
          PERSIS, RAKForm ikut didaftarkan karena RAKListScreen &
          HistoryTransaksiDetailScreen (yang sekarang hanya hidup di
          LaporanStack) menavigasi ke sana untuk edit/batalkan RAK. */}
      <LaporanStack.Screen name="RAKList" component={RAKListScreen} options={{ title: 'Rekening Antar Kantor/Unit (RAKU)' }} />
      <LaporanStack.Screen name="RAKForm" component={RAKFormScreen} options={{ title: 'Rekening Antar Kantor/Unit (RAKU)' }} />
      {/* RC-S70.2 — rute "PinjamanKoperasiList" DIHAPUS bersama
          DaftarPinjamanKoperasiScreen (fitur legacy "Pemberian Pinjaman
          untuk Koperasi"). Tidak ada rute pengganti. */}
      {/* RC-S50 §10 — judul header diseragamkan dengan label menu
          barunya (`Penyusutan Aset`). `name` rute & komponennya TIDAK
          diubah: seluruh navigasi existing ke 'StatusPeriode' tetap
          berfungsi persis sama. */}
      <LaporanStack.Screen name="StatusPeriode" component={StatusPeriodeScreen} options={{ title: 'Penyusutan Aset' }} />
      <LaporanStack.Screen name="PenyusutanPropertiInvestasi" component={PenyusutanPropertiFormScreen} options={{ title: 'Penyusutan Properti Investasi' }} />
      {/* Phase 18 §13: registrasi "Rekonsiliasi" di LaporanStack DIHAPUS
          — sudah tidak ada menu apa pun di stack ini yang menavigasi ke
          sana lagi (entry di PenyusutanDimukaMenuScreen sudah dihapus).
          Rute yang sama TETAP terdaftar & aktif di TransaksiStack
          (dijangkau dari Transaksi > Pengeluaran > Pemindahan Saldo
          Rekening > Rekonsiliasi Kas/Bank) — komponennya TIDAK dihapus,
          cuma pintu masuk yang duplikat di sini yang dibersihkan supaya
          tidak ada dead route. */}
      <LaporanStack.Screen name="TutupPeriode" component={TutupPeriodeScreen} options={{ title: 'Tutup Periode' }} />
      <LaporanStack.Screen
        name="KolektibilitasPiutang"
        component={KolektibilitasPiutangScreen}
        options={{ title: 'Kolektibilitas Piutang' }}
      />
      <LaporanStack.Screen
        name="BuktiTransaksiList"
        component={BuktiTransaksiListScreen}
        options={{ title: 'Bukti Transaksi' }}
      />
      <LaporanStack.Screen
        name="BuktiTransaksiDetail"
        component={BuktiTransaksiDetailScreen}
        options={{ title: 'Detail Bukti' }}
      />
      {/* RC-S50 §10B — registrasi "PenyusutanList" DILEPAS.
          Entry menunya sudah digabung ke `Penyusutan Aset`, jadi tidak
          ada lagi layar yang menavigasi ke rute ini — membiarkannya
          terdaftar berarti mengapalkan dead route. Berkas
          `PenyusutanListScreen.tsx` TIDAK dihapus (pola sama dengan
          AsetListScreen), dan PenyusutanService TIDAK disentuh. */}
      {/* RC-S50 §8/§10B — registrasi "JurnalPenyusutan" DILEPAS.
          Entry menunya dihapus, jadi tidak ada pemanggil yang tersisa
          (dead route). `JurnalPenyusutanScreen.tsx` TIDAK dihapus, dan
          PEMBUATAN jurnal penyusutan di PenyusutanService TETAP
          berjalan otomatis — yang hilang hanya layar untuk
          melihat daftarnya secara terpisah. Jurnalnya tetap terbaca di
          Buku Besar, Neraca Saldo, dan History Transaksi. */}
      <LaporanStack.Screen name="PendapatanDimukaList" component={PendapatanDimukaListScreen} options={{ title: 'Daftar Pendapatan Dimuka' }} />
      <LaporanStack.Screen name="DaftarInvestasi" component={DaftarInvestasiScreen} options={{ title: 'Daftar Investasi' }} />
      {/*
       * Update pasca-6-perbaikan (permintaan pengguna §4) — BUG
       * DITEMUKAN & PENYEBABNYA: DaftarInvestasiScreen (di LaporanStack)
       * menavigasi ke `navigate('InvestasiForm', { investasiId })` saat
       * tombol Edit ditekan, TAPI 'InvestasiForm' HANYA terdaftar di
       * TransaksiStack (rute Transaksi > Pengeluaran > Investasi) — dua
       * stack navigator yang TERPISAH (sibling tab, bukan nested).
       * React Navigation tidak bisa menemukan rute di stack lain yang
       * tidak terdaftar sebagai ancestor, jadi navigate() GAGAL TANPA
       * ERROR YANG TERLIHAT USER — layar tidak berpindah sama sekali,
       * persis gejala "Edit tidak berjalan" yang dilaporkan. INI BUKAN
       * bug di form/service/database — data & logic edit-nya (lihat
       * `InvestasiService.editInvestasi()`) sudah benar sejak awal,
       * screen tujuannya saja yang tidak bisa dijangkau. Pola FIX yang
       * SAMA PERSIS sudah dipakai untuk RAKForm (lihat 2 baris di atas)
       * — didaftarkan ulang di sini, komponen SAMA PERSIS, bukan
       * duplikat screen/logic baru.
       */}
      <LaporanStack.Screen name="InvestasiForm" component={InvestasiFormScreen} options={{ title: 'Investasi Koperasi' }} />
      <LaporanStack.Screen name="DaftarUtang" component={DaftarUtangScreen} options={{ title: 'Daftar Utang' }} />
      {/* Audit ulang (permintaan pengguna, request baru §5): registrasi
          "PelaksanaanRAT" di LaporanStack DIHAPUS — menu ini sudah
          pindah ke tab "Data" (lihat AnggotaStack/TransaksiStack di
          atas). Tidak ada lagi entry menu di LaporanStack yang
          menavigasi ke sini, jadi registrasi lama di sini jadi dead
          route kalau dibiarkan — dihapus supaya tidak ada dua jalur
          terdaftar untuk satu fitur (permintaan eksplisit: "Jangan
          membuat duplikasi menu"). Komponen PelaksanaanRATScreen &
          data RAT existing SAMA SEKALI TIDAK berubah. */}
      <LaporanStack.Screen name="DaftarAsetTetap" component={DaftarAsetTetapScreen} options={{ title: 'Daftar Aset Tetap & Penyusutan' }} />
      {/* Bug fix (ERROR "action NAVIGATE ... AsetEditForm was not
          handled by any navigator"): `DaftarAsetTetapScreen` di atas
          hidup di LaporanStack, tapi tombol Edit-nya memanggil
          `navigation.navigate('AsetEditForm', ...)` — route itu
          SEBELUMNYA cuma terdaftar di TransaksiStack (sibling
          navigator, bukan ancestor), jadi React Navigation tidak bisa
          menemukannya dari sini. Registrasi GANDA (komponen SAMA
          PERSIS, `AsetEditFormScreen`, TIDAK ada logic kedua) — pola
          yang sama sudah dipakai untuk InvestasiForm/RAKForm/
          PendapatanLainnyaForm di bawah, yang juga reachable dari dua
          hub (Transaksi & Laporan). AsetService/data aset TIDAK
          disentuh sama sekali. */}
      <LaporanStack.Screen name="AsetEditForm" component={AsetEditFormScreen} options={{ title: 'Aset Tetap' }} />
      {/* Target §3 (permintaan pengguna): "Daftar Pendapatan" & "Riwayat
          Pendapatan" dipindah ke Laporan > Rincian Laporan Lainnya
          ("Rincian Lainnya"), tepat di bawah "Daftar Aset Tetap" — lihat
          PenyusutanDimukaMenuScreen.tsx. Registrasi GANDA komponen yang
          SAMA PERSIS (pola sama dengan RAKForm/InvestasiForm di atas)
          supaya bisa dijangkau dari tab Laporan tanpa memutus rute lama
          di TransaksiStack (masih dipakai entri menu Penerimaan >
          Pendapatan Koperasi). PendapatanAkunDetail & PendapatanLainnyaForm
          ikut didaftarkan karena kedua layar Laporan ini menavigasi ke
          sana (detail akun / tambah transaksi). Data & service TIDAK
          disentuh sama sekali. */}
      <LaporanStack.Screen name="DaftarPendapatan" component={DaftarPendapatanScreen} options={{ title: 'Daftar Pendapatan' }} />
      <LaporanStack.Screen name="PendapatanAkunDetail" component={PendapatanAkunDetailScreen} options={{ title: 'Detail Akun Pendapatan' }} />
      {/* RC-S50 §9/§10B — registrasi "PendapatanLainnyaList" DILEPAS
          (dead route setelah entry menunya dihapus).
          `PendapatanLainnyaListScreen.tsx` & `PendapatanLainnyaService`
          TIDAK dihapus; pencatatan pendapatan lewat
          "PendapatanLainnyaForm" di bawah tetap berfungsi. */}
      <LaporanStack.Screen name="PendapatanLainnyaForm" component={PendapatanLainnyaFormScreen} options={{ title: 'Tambah Transaksi Pendapatan' }} />
      {/* RC-S50 §8/§10B — registrasi "JurnalPengakuanDimuka" DILEPAS
          (dead route setelah entry menunya dihapus). Layar & service
          pengakuan pendapatan dimuka TIDAK dihapus, dan
          `jalankanPengakuanPeriode()` TETAP dijalankan dari menu
          "Penyusutan Aset" serta otomatis saat periode ditutup. */}
      <LaporanStack.Screen name="NeracaSaldo" component={NeracaSaldoScreen} options={{ title: 'Neraca Saldo' }} />
      <LaporanStack.Screen name="BukuBesar" component={BukuBesarScreen} options={{ title: 'Buku Besar' }} />
      {/* RC-S49: hanya `options.title` (teks header yang dibaca pengguna)
          yang diseragamkan dengan label menu Laporan & judul di dalam
          layar. `name` rute, komponen, dan urutan pendaftaran TIDAK
          diubah — seluruh navigasi tetap persis sama. */}
      <LaporanStack.Screen name="PosisiKeuangan" component={PosisiKeuanganScreen} options={{ title: 'Laporan Posisi Keuangan' }} />
      <LaporanStack.Screen name="LabaRugi" component={LabaRugiScreen} options={{ title: 'Laporan Perhitungan Hasil Usaha' }} />
      <LaporanStack.Screen name="PerubahanEkuitas" component={PerubahanEkuitasScreen} options={{ title: 'Laporan Perubahan Ekuitas' }} />
      <LaporanStack.Screen name="ArusKas" component={ArusKasScreen} options={{ title: 'Laporan Arus Kas' }} />
      <LaporanStack.Screen name="Calk" component={CalkScreen} options={{ title: 'Catatan Atas Laporan Keuangan' }} />
      <LaporanStack.Screen name="Shu" component={ShuScreen} options={{ title: 'Pembagian Sisa Hasil Usaha' }} />
      <LaporanStack.Screen name="ShuForm" component={ShuFormScreen} options={{ title: 'Hitung Pembagian SHU' }} />
      <LaporanStack.Screen name="ShuDetail" component={ShuDetailScreen} options={{ title: 'Rincian Pembagian SHU' }} />
      <LaporanStack.Screen name="ShuAnggotaDetail" component={ShuAnggotaDetailScreen} options={{ title: 'SHU per Anggota' }} />
      <LaporanStack.Screen name="HistoryTransaksi" component={HistoryTransaksiScreen} options={{ title: 'History Transaksi' }} />
      {/* Menu "Aktivitas Log" DIHAPUS (permintaan pengguna) — layar
          `AktivitasLogScreen`, service `AuditLogService.ts` (read-only,
          hanya dipakai layar ini), dan entry menu di
          PenyusutanDimukaMenuScreen dihapus bersamaan. Tabel `audit_log`
          & SEMUA proses pencatatan audit trail (INSERT ke audit_log di
          KasBankService/RAKService/AsetService/dll) TIDAK disentuh —
          hanya layar untuk MELIHATNYA yang dihapus. */}
      <LaporanStack.Screen name="HistoryTransaksiDetail" component={HistoryTransaksiDetailScreen} options={{ title: 'Detail Transaksi' }} />
    </LaporanStack.Navigator>
  );
}

function PengaturanStackNavigator() {
  return (
    <PengaturanStack.Navigator screenOptions={stackScreenOptions} screenLayout={tataLetakBerizin}>
      <PengaturanStack.Screen name="PengaturanMenu" component={PengaturanScreen} options={{ title: 'Pengaturan' }} />
      <PengaturanStack.Screen name="BackupRestore" component={BackupRestoreScreen} options={{ title: 'Backup & Restore' }} />
      <PengaturanStack.Screen name="UserManagement" component={UserManagementScreen} options={{ title: 'User Management' }} />
      {/* RC-S117 — satu rute untuk DUA mode: judulnya mengikuti ada
          tidaknya `userId` di params, jadi tidak ada layar kedua yang
          harus dijaga tetap seragam dengan yang pertama. */}
      <PengaturanStack.Screen
        name="UserForm"
        component={UserFormScreen}
        options={({ route }: any) => ({ title: route.params?.userId ? 'Sunting User' : 'Tambah User' })}
      />
      {/* RC-S133.5 — buat akun ber-role Anggota untuk semua anggota sekaligus. */}
      <PengaturanStack.Screen name="AkunAnggotaMassal" component={AkunAnggotaMassalScreen} options={{ title: 'Akun Semua Anggota' }} />
      <PengaturanStack.Screen name="PermissionMatrix" component={PermissionMatrixScreen} options={{ title: 'Permission Matrix' }} />
      {/* "Developer" (mode pengujian waktu) — dikunci password, BUKAN
          permission role, jadi didaftarkan langsung di sini seperti
          "Lisensi", bukan lewat array MENU yang difilter `can()`.
          Lihat DeveloperScreen.tsx untuk gerbang passwordnya. */}
      <PengaturanStack.Screen
        name="ImportDataAwal"
        component={ImportDataAwalScreen}
        options={{ title: 'Import Data Awal' }}
      />
      {/* RC-S103 — "Saldo Awal Akun" juga didaftarkan di stack Pengaturan.
          Layar Import Data Awal menutup alurnya dengan tombol menuju layar
          ini: setelah saldo awal pinjaman/simpanan masuk sebagai buku
          pembantu, sisi buku besarnya harus diisi di sini. Tanpa
          pendaftaran ini navigasinya gagal, karena rute yang sama
          sebelumnya hanya ada di stack Anggota & Transaksi. Komponennya
          SAMA (bukan salinan), sehingga tidak ada logika yang berganda. */}
      <PengaturanStack.Screen
        name="SaldoAwalAkunList"
        component={SaldoAwalAkunListScreen}
        options={{ title: 'Saldo Awal' }}
      />
      {/* RC-S97 — "Struktur Template": menampilkan isi template Excel di
          dalam aplikasi. Rute tersendiri (bukan bagian layar Import)
          karena layar Import sudah memuat tiga tahap + pratinjau + hasil;
          menumpuknya jadi satu membuat keduanya sulit dibaca. SENGAJA
          tidak masuk array MENU Pengaturan: pintu masuknya dari layar
          Import Data Awal, tempat pengguna memang sedang membutuhkannya. */}
      <PengaturanStack.Screen
        name="StrukturTemplate"
        component={StrukturTemplateScreen}
        options={{ title: 'Struktur Template' }}
      />
      {/* RC-S100 — "Riwayat Import": log hasil import data awal
          (berhasil & gagal). Terdaftar di PengaturanStack tetapi SENGAJA
          tidak masuk array MENU — pintu masuknya ikon di pojok kanan atas
          layar Import Data Awal, tempat pengguna memang sedang
          membutuhkannya. Pola yang sama dengan 'StrukturTemplate'. */}
      <PengaturanStack.Screen
        name="RiwayatImport"
        component={RiwayatImportScreen}
        options={{ title: 'Riwayat Import' }}
      />
      {/* RC-S99 — "Reset Data". Rute tersendiri di PengaturanStack, dan
          entrinya ADA di array MENU (difilter `can('backup','approve')`)
          karena reset adalah tindakan yang harus bisa ditemukan pengguna
          tanpa trik — yang melindunginya adalah enam lapis konfirmasi di
          dalam layar, bukan menyembunyikan pintunya. Layar itu sendiri
          masih menolak siapa pun yang bukan ADMIN. */}
      <PengaturanStack.Screen name="ResetData" component={ResetDataScreen} options={{ title: 'Reset Data' }} />
      <PengaturanStack.Screen name="Developer" component={DeveloperScreen} options={{ title: 'Developer' }} />
      {/* RC-S121 — "Keamanan": PIN kunci aplikasi & login biometric,
          DIPINDAH dari layar PengaturanMenu ke layar tersendiri. Seperti
          'Developer', kartunya di luar array MENU (tidak digerbangi
          `can()`), karena sebelumnya pun pengaturan ini tampil untuk semua
          role. Logika PIN/biometric dipindah apa adanya. */}
      <PengaturanStack.Screen name="Keamanan" component={KeamananScreen} options={{ title: 'Keamanan' }} />
      {/* Sinkron HP ⇄ Desktop lewat Wi-Fi lokal (pemasangan QR). */}
      <PengaturanStack.Screen
        name="SinkronPerangkat"
        component={SinkronPerangkatScreen}
        options={{ title: apakahDesktop() ? 'Sinkron HP' : 'Sinkron Desktop' }}
      />
      {/* RC-S49b §B4 — registrasi "IdentitasKoperasi" DIHAPUS dari
          PengaturanStack.

          Sebelumnya layar itu hidup di sini, sehingga membukanya dari
          Dashboard menuntut `navigate('Pengaturan', { screen:
          'IdentitasKoperasi' })`. Navigasi bersarang itu MENGAKTIFKAN
          tab Pengaturan dan menaruh `PengaturanMenu` di bawah layar
          Identitas — pengguna mendarat di menu yang tidak pernah ia
          buka begitu menekan Back, dan tab Pengaturan berpindah state
          hanya karena sebuah kartu Dashboard ditekan.

          Rutenya sekarang didaftarkan SEKALI di RootStack (lihat
          RootNavigator di bawah) sebagai destination independen —
          bukan anak Pengaturan, bukan anak Dashboard.

          Yang dihapus HANYA registrasi rutenya. Berkas layar, service
          `getIdentitasKoperasi()`/`updateIdentitasKoperasi()`, dan
          seluruh data identitas TIDAK disentuh. */}
    </PengaturanStack.Navigator>
  );
}

function TabNavigator() {
  // RC-S132 — tab yang seluruh modulnya tidak dapat dilihat role ini
  // disembunyikan (rutenya tetap terdaftar; gerbang layar tetap berlaku).
  const { permissions } = usePermission();
  const sembunyi = (tab: string) => (bolehLihatTab(tab, permissions) ? {} : { tabBarItemStyle: { display: 'none' as const } });
  return (
    <Tab.Navigator
      {...propsTabDesktop}
      screenOptions={({ route }) => ({
        ...opsiTabDesktop,
        headerShown: false,
        // UI/UX POLISH — warna/garis/label tab dari token bersama; tinggi &
        // inset bawah TETAP diurus bottom-tabs (lihat src/theme/navigation.ts).
        ...tabBarPresentationOptions,
        tabBarIcon: ({ color, focused }) => {
          const iconByRoute: Record<string, [keyof typeof Ionicons.glyphMap, keyof typeof Ionicons.glyphMap]> = {
            Dashboard: ['grid-outline', 'grid'],
            // UI/UX REDESIGN — tab berlabel "Data" berisi anggota, akun, saldo awal,
            // bank, pemasok, pemberi pinjaman, RAT, klasifikasi aset: bukan
            // hanya orang. Ikon basis data lebih sesuai daripada ikon orang.
            Anggota: ['server-outline', 'server'],
            Transaksi: ['swap-horizontal-outline', 'swap-horizontal'],
            Laporan: ['bar-chart-outline', 'bar-chart'],
            Pengaturan: ['settings-outline', 'settings'],
          };
          const [outline, filled] = iconByRoute[route.name] ?? ['ellipse-outline', 'ellipse'];
          return <Ionicons name={focused ? filled : outline} size={iconSize.lg} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Dashboard" component={DashboardScreen} />
      <Tab.Screen name="Anggota" component={AnggotaStackNavigator} options={{ tabBarLabel: 'Data', ...sembunyi('Anggota') }} />
      <Tab.Screen name="Transaksi" component={TransaksiStackNavigator} options={sembunyi('Transaksi')} />
      <Tab.Screen name="Laporan" component={LaporanStackNavigator} options={sembunyi('Laporan')} />
      <Tab.Screen name="Pengaturan" component={PengaturanStackNavigator} />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  return (
    // NavigationIndependentTree: sejak migrasi ke Expo Router (SDK 54),
    // komponen ini dirender di dalam route `app/index.tsx`, yang sudah
    // berada dalam NavigationContainer milik Expo Router sendiri. React
    // Navigation v7 tidak lagi mengizinkan NavigationContainer bersarang
    // kecuali dibungkus wrapper ini (pengganti prop `independent` di v6) —
    // lihat https://reactnavigation.org/docs/navigation-container/#navigationindependenttree.
    <NavigationIndependentTree>
      <NavigationContainer>
        {/* RC-S49b §B1/§B3 — DESTINATION INDEPENDEN DI ATAS TAB BAR.

            `Tabs` adalah seluruh aplikasi ber-tab seperti sebelumnya;
            `headerShown: false` menjaga Tab.Navigator tetap menggambar
            dirinya persis seperti dulu (Dashboard tetap Tab.Screen
            langsung tanpa header — lihat SafeAreaView di
            DashboardScreen).

            `IdentitasKoperasi` berdiri SEJAJAR dengan `Tabs`, bukan di
            dalam salah satu tab. Konsekuensinya persis yang diminta:

              - Dashboard cukup `navigate('IdentitasKoperasi')`. Aksi
                itu naik dari Tab.Navigator ke stack ini, jadi tidak
                ada tab yang berpindah state dan menu Pengaturan tidak
                pernah ikut tersentuh.
              - Back = `goBack()` biasa: kembali ke `Tabs` dengan tab
                yang SEDANG aktif tetap aktif — dari Dashboard kembali
                ke Dashboard. Tidak ada reset/replace, riwayat utuh.
              - Tidak mungkin lagi ada tabrakan nama rute dengan layar
                di dalam PengaturanStack.

            Layar & service-nya SAMA PERSIS (satu berkas, satu
            implementasi); yang berubah hanya tempat pendaftarannya. */}
        <RootStack.Navigator screenOptions={stackScreenOptions}>
          <RootStack.Screen name="Tabs" component={TabNavigator} options={{ headerShown: false }} />
          <RootStack.Screen
            name="IdentitasKoperasi"
            component={IdentitasKoperasiScreen}
            options={{ title: 'Identitas Koperasi' }}
          />
          {/*
            RESTRUKTURISASI DATA — keempat master (PersonelKoperasi,
            PerizinanKoperasi, UnitUsahaKoperasi, PeraturanInternal)
            DIPINDAH ke AnggotaStack (tab Data); registrasinya di sini
            dihapus, bukan dibiarkan ganda.

            Alasannya bukan sekadar kerapian: selama rute ini masih
            terdaftar di RootStack, `navigate('PersonelKoperasi')` dari
            mana pun berpeluang dilayani wadah yang salah, dan tombol
            kembali akan membawa pengguna ke luar tab Data. Setelah
            enam pintasan di IdentitasKoperasiScreen dihapus, tidak ada
            pemanggil yang tersisa di RootStack.

            IdentitasKoperasi sendiri TETAP di sini — layarnya masih
            dibuka dari tab Pengaturan.
          */}
        </RootStack.Navigator>
      </NavigationContainer>
    </NavigationIndependentTree>
  );
}

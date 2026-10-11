import type { Ionicons } from '@expo/vector-icons';
import type { PermissionSet, Resource } from '@/config/defaultPermissions';
import { bolehBukaRute, bolehLihatTab } from '@/navigation/izinRute';

/**
 * KATALOG NAVIGASI KOPKU DESKTOP.
 *
 * Satu daftar tujuan yang dipakai sidebar (navigasi langsung ke sub-menu)
 * dan palet perintah Ctrl+K. Isinya SALINAN pintu masuk yang sudah ada di
 * menu hub aplikasi (Data, Penerimaan, Pengeluaran, Penyesuaian, Laporan,
 * Rincian Laporan Lainnya, Pengaturan) — rute & parameter sama persis,
 * jadi layar yang dibuka identik dengan membukanya lewat hub.
 *
 * Izin: setiap entri disaring `bolehBukaRute` (Permission Matrix RC-S132)
 * DAN `bolehLihatTab`. Gerbang layar tetap berlaku sebagai penjaga akhir.
 */
export type NamaTab = 'Dashboard' | 'Anggota' | 'Transaksi' | 'Laporan' | 'Pengaturan';
type Ikon = keyof typeof Ionicons.glyphMap;

export interface EntriMenu {
  id: string;
  tab: NamaTab | 'Root';
  rute: string;
  params?: Record<string, unknown>;
  judul: string;
  ket?: string;
  ikon: Ikon;
  grup: string;
  /** Tampil langsung sebagai sub-menu di sidebar. */
  sidebar?: boolean;
  kata?: string;
}

export interface GrupTab {
  tab: NamaTab;
  label: string;
  ikon: Ikon;
  ikonAktif: Ikon;
  akar: string;
  pintasan: string;
  ket: string;
}

export const GRUP_TAB: GrupTab[] = [
  { tab: 'Dashboard', label: 'Dashboard', ikon: 'grid-outline', ikonAktif: 'grid', akar: 'Dashboard', pintasan: '1', ket: 'Ringkasan koperasi' },
  { tab: 'Anggota', label: 'Data', ikon: 'server-outline', ikonAktif: 'server', akar: 'InputDataHub', pintasan: '2', ket: 'Anggota, akun & master data' },
  { tab: 'Transaksi', label: 'Transaksi', ikon: 'swap-horizontal-outline', ikonAktif: 'swap-horizontal', akar: 'TransaksiHub', pintasan: '3', ket: 'Penerimaan, pengeluaran, penyesuaian' },
  { tab: 'Laporan', label: 'Laporan', ikon: 'bar-chart-outline', ikonAktif: 'bar-chart', akar: 'LaporanMenu', pintasan: '4', ket: 'Laporan keuangan & rincian' },
  { tab: 'Pengaturan', label: 'Pengaturan', ikon: 'settings-outline', ikonAktif: 'settings', akar: 'PengaturanMenu', pintasan: '5', ket: 'Akun, keamanan, backup, sinkron' },
];

const e = (
  tab: EntriMenu['tab'],
  grup: string,
  rute: string,
  judul: string,
  ikon: Ikon,
  lain: Partial<Omit<EntriMenu, 'tab' | 'grup' | 'rute' | 'judul' | 'ikon'>> = {}
): EntriMenu => ({ id: `${tab}:${rute}:${lain.params ? JSON.stringify(lain.params) : ''}`, tab, grup, rute, judul, ikon, ...lain });

export const KATALOG: EntriMenu[] = [
  // ---------------- DASHBOARD
  e('Dashboard', 'Dashboard', 'Dashboard', 'Dashboard', 'grid-outline', { ket: 'Ringkasan simpanan, pinjaman & statistik', kata: 'beranda ringkasan home' }),
  e('Root', 'Dashboard', 'IdentitasKoperasi', 'Identitas Koperasi', 'business-outline', { ket: 'Nama, alamat, logo, badan hukum', kata: 'profil koperasi logo' }),

  // ---------------- DATA
  e('Anggota', 'Data', 'InputDataHub', 'Semua Data', 'apps-outline', { ket: 'Hub seluruh master data' }),
  e('Anggota', 'Data', 'AnggotaList', 'Anggota', 'people-outline', { ket: 'Daftar & profil anggota', sidebar: true, kata: 'member nasabah' }),
  e('Anggota', 'Data', 'PersonelKoperasi', 'Pengurus', 'ribbon-outline', { params: { kategori: ['PENGURUS'], judul: 'Pengurus' } }),
  e('Anggota', 'Data', 'PersonelKoperasi', 'Pengawas', 'eye-outline', { params: { kategori: ['PENGAWAS'], judul: 'Pengawas' } }),
  e('Anggota', 'Data', 'PersonelKoperasi', 'Pengelola / Karyawan / Pekerja', 'briefcase-outline', {
    params: { kategori: ['PENGELOLA', 'KARYAWAN', 'PEKERJA'], judul: 'Pengelola / Karyawan / Pekerja' },
  }),
  e('Anggota', 'Data', 'PerizinanKoperasi', 'Perizinan yang Dimiliki', 'document-attach-outline'),
  e('Anggota', 'Data', 'UnitUsahaKoperasi', 'Unit Usaha', 'storefront-outline'),
  e('Anggota', 'Data', 'PeraturanInternal', 'Peraturan Internal', 'library-outline'),
  e('Anggota', 'Data', 'PelaksanaanRAT', 'Pelaksanaan RAT', 'people-circle-outline', { kata: 'rapat anggota tahunan' }),
  e('Anggota', 'Data', 'AccountList', 'Daftar Akun', 'list-outline', { ket: 'Bagan akun (COA)', sidebar: true, kata: 'coa chart of account' }),
  e('Anggota', 'Data', 'SaldoAwalAkunList', 'Saldo Awal', 'wallet-outline', { sidebar: true }),
  e('Anggota', 'Data', 'RekeningList', 'Data Bank', 'card-outline', { sidebar: true, kata: 'rekening kas bank' }),
  e('Anggota', 'Data', 'DataReferensiList', 'Pemasok', 'cube-outline', { params: { jenis: 'PEMASOK' } }),
  e('Anggota', 'Data', 'DataReferensiList', 'Pemberi Pinjaman Pihak Lain', 'hand-left-outline', { params: { jenis: 'PEMBERI_PINJAMAN_PIHAK_LAIN' } }),
  e('Anggota', 'Data', 'DataReferensiList', 'Pemberi Pinjaman Bank', 'business-outline', { params: { jenis: 'PEMBERI_PINJAMAN_BANK' } }),
  e('Anggota', 'Data', 'DataReferensiList', 'Beban Lain', 'pricetags-outline', { params: { jenis: 'BEBAN_LAIN' } }),

  // ---------------- TRANSAKSI
  e('Transaksi', 'Transaksi', 'TransaksiHub', 'Semua Transaksi', 'apps-outline'),
  e('Transaksi', 'Transaksi', 'TransaksiPenerimaan', 'Penerimaan', 'arrow-down-circle-outline', { ket: 'Uang masuk', sidebar: true }),
  e('Transaksi', 'Transaksi', 'TransaksiPengeluaran', 'Pengeluaran', 'arrow-up-circle-outline', { ket: 'Uang keluar', sidebar: true }),
  e('Transaksi', 'Transaksi', 'Penyesuaian', 'Penyesuaian', 'git-compare-outline', { ket: 'Koreksi & penyesuaian akhir periode', sidebar: true }),
  e('Transaksi', 'Simpanan & Pinjaman', 'SimpananHistori', 'Simpanan', 'wallet-outline', { ket: 'Setor & riwayat simpanan', sidebar: true, kata: 'setor simpanan pokok wajib sukarela' }),
  e('Transaksi', 'Simpanan & Pinjaman', 'SimpananBerjangkaHistori', 'Simpanan Berjangka', 'hourglass-outline', { kata: 'deposito' }),
  e('Transaksi', 'Simpanan & Pinjaman', 'TarikSimpananForm', 'Tarik Simpanan Anggota', 'remove-circle-outline', { params: { aksen: 'PENGELUARAN' }, kata: 'penarikan' }),
  e('Transaksi', 'Simpanan & Pinjaman', 'PinjamanList', 'Pinjaman Anggota', 'cash-outline', { ket: 'Pemberian & daftar pinjaman', sidebar: true, kata: 'kredit' }),
  e('Transaksi', 'Simpanan & Pinjaman', 'BayarAngsuranForm', 'Bayar Piutang Anggota', 'receipt-outline', { sidebar: true, kata: 'angsuran cicilan' }),
  e('Transaksi', 'Penerimaan', 'UtangForm', 'Utang Koperasi', 'document-text-outline'),
  e('Transaksi', 'Penerimaan', 'ModalForm', 'Modal Koperasi', 'trending-up-outline', { kata: 'hibah donasi ekuitas' }),
  e('Transaksi', 'Penerimaan', 'PendapatanLainnyaMenu', 'Pendapatan Koperasi', 'add-circle-outline'),
  e('Transaksi', 'Penerimaan', 'PenarikanInvestasi', 'Penarikan Dana Investasi', 'trending-down-outline'),
  e('Transaksi', 'Penerimaan', 'PenarikanBankForm', 'Penarikan dari Bank', 'swap-horizontal-outline'),
  e('Transaksi', 'Penerimaan', 'PengembalianRAKForm', 'Pengembalian RAKU', 'return-down-back-outline'),
  e('Transaksi', 'Pengeluaran', 'BayarUtangForm', 'Bayar Kewajiban', 'card-outline', { kata: 'utang' }),
  e('Transaksi', 'Pengeluaran', 'RAKForm', 'Rekening Antar Kantor/Unit (RAKU)', 'git-branch-outline', { params: {} }),
  e('Transaksi', 'Pengeluaran', 'InvestasiForm', 'Investasi Koperasi', 'trending-up-outline'),
  e('Transaksi', 'Pengeluaran', 'PembelianAsetForm', 'Pembelian Aset', 'cart-outline', { kata: 'aset tetap inventaris' }),
  e('Transaksi', 'Pengeluaran', 'BebanForm', 'Beban', 'pricetag-outline', { kata: 'biaya' }),
  e('Transaksi', 'Pengeluaran', 'ImbalanKerjaForm', 'Imbalan Kerja', 'people-outline', { kata: 'gaji honor' }),
  e('Transaksi', 'Pengeluaran', 'PajakMenu', 'Pajak', 'document-outline', { kata: 'pph' }),
  e('Transaksi', 'Pengeluaran', 'PenghapusanPiutangForm', 'Penghapusan Piutang', 'close-circle-outline'),
  e('Transaksi', 'Pengeluaran', 'KasBankTransaksiForm', 'Pemindahan Saldo Rekening', 'repeat-outline', {
    params: { tipe: 'TRANSFER', judul: 'Pengeluaran · Pemindahan Saldo Rekening' },
    kata: 'transfer',
  }),
  e('Transaksi', 'Pengeluaran', 'Shu', 'Pembagian Sisa Hasil Usaha', 'pie-chart-outline', { kata: 'shu' }),
  e('Transaksi', 'Pengeluaran', 'KeluarAnggotaMenu', 'Keluar Anggota', 'exit-outline'),
  e('Transaksi', 'Penyesuaian', 'KolektibilitasPiutang', 'Kolektibilitas Piutang', 'shield-half-outline', { kata: 'tunggakan cadangan' }),
  e('Transaksi', 'Penyesuaian', 'Rekonsiliasi', 'Rekonsiliasi Kas/Bank', 'checkmark-done-outline'),
  e('Transaksi', 'Penyesuaian', 'PenyesuaianNilaiWajar', 'Penyesuaian Nilai Wajar', 'stats-chart-outline'),
  e('Transaksi', 'Penyesuaian', 'PenyusutanPropertiInvestasi', 'Penyusutan Properti Investasi', 'home-outline'),
  e('Transaksi', 'Penyesuaian', 'BungaSimpananSukarela', 'Bunga Simpanan Sukarela', 'sparkles-outline'),
  e('Transaksi', 'Penyesuaian', 'ImpairmentInvestasiForm', 'Impairment Investasi', 'trending-down-outline'),

  // ---------------- LAPORAN
  e('Laporan', 'Laporan', 'LaporanMenu', 'Semua Laporan', 'apps-outline'),
  e('Laporan', 'Laporan Keuangan', 'PosisiKeuangan', 'Posisi Keuangan', 'briefcase-outline', { ket: 'Neraca: aset, liabilitas, ekuitas', sidebar: true, kata: 'neraca' }),
  e('Laporan', 'Laporan Keuangan', 'LabaRugi', 'Perhitungan Hasil Usaha', 'bar-chart-outline', { ket: 'Pendapatan & beban', sidebar: true, kata: 'laba rugi phu' }),
  e('Laporan', 'Laporan Keuangan', 'PerubahanEkuitas', 'Perubahan Ekuitas', 'pie-chart-outline', { sidebar: true }),
  e('Laporan', 'Laporan Keuangan', 'ArusKas', 'Arus Kas', 'cash-outline', { sidebar: true }),
  e('Laporan', 'Laporan Keuangan', 'Calk', 'Catatan Atas Laporan Keuangan', 'reader-outline', { sidebar: true, kata: 'calk' }),
  e('Laporan', 'Laporan Keuangan', 'HistoryTransaksi', 'History Transaksi', 'time-outline', { sidebar: true, kata: 'jurnal riwayat' }),
  e('Laporan', 'Rincian', 'PenyusutanDimukaMenu', 'Rincian Laporan Lainnya', 'folder-open-outline'),
  e('Laporan', 'Rincian', 'NeracaSaldo', 'Neraca Saldo', 'calculator-outline', { sidebar: true, kata: 'trial balance' }),
  e('Laporan', 'Rincian', 'BukuBesar', 'Buku Besar', 'book-outline', { sidebar: true, kata: 'ledger' }),
  e('Laporan', 'Rincian', 'Lpea', 'Promosi Ekonomi Anggota', 'megaphone-outline', { kata: 'lpea' }),
  e('Laporan', 'Rincian', 'DaftarInvestasi', 'Daftar Investasi', 'trending-up-outline'),
  e('Laporan', 'Rincian', 'DaftarUtang', 'Daftar Utang', 'document-text-outline'),
  e('Laporan', 'Rincian', 'RAKList', 'Daftar RAKU', 'git-branch-outline'),
  e('Laporan', 'Rincian', 'DaftarAsetTetap', 'Daftar Aset Tetap & Penyusutan', 'construct-outline'),
  e('Laporan', 'Rincian', 'StatusPeriode', 'Penyusutan Aset', 'calendar-outline'),
  e('Laporan', 'Rincian', 'DaftarPendapatan', 'Daftar Pendapatan', 'list-outline'),
  e('Laporan', 'Rincian', 'PendapatanDimukaList', 'Daftar Pendapatan Dimuka', 'calendar-outline'),
  e('Laporan', 'Bukti Transaksi', 'BuktiTransaksiList', 'Bukti Bayar Utang', 'receipt-outline', { params: { jenis: 'BAYAR_UTANG' } }),
  e('Laporan', 'Bukti Transaksi', 'BuktiTransaksiList', 'Bukti Bayar Piutang Anggota', 'receipt-outline', { params: { jenis: 'BAYAR_PIUTANG' } }),
  e('Laporan', 'Bukti Transaksi', 'BuktiTransaksiList', 'Bukti Bayar Simpanan Anggota', 'receipt-outline', { params: { jenis: 'BAYAR_SIMPANAN' } }),
  e('Laporan', 'Bukti Transaksi', 'BuktiTransaksiList', 'Bukti Tarik Simpanan Anggota', 'receipt-outline', { params: { jenis: 'TARIK_SIMPANAN' } }),
  e('Laporan', 'Bukti Transaksi', 'BuktiTransaksiList', 'Bukti Keluar Anggota', 'receipt-outline', { params: { jenis: 'KELUAR_ANGGOTA' } }),
  e('Laporan', 'Periode', 'TutupPeriode', 'Tutup Periode', 'lock-closed-outline', { sidebar: true, kata: 'tutup buku closing' }),

  // ---------------- PENGATURAN
  e('Pengaturan', 'Pengaturan', 'PengaturanMenu', 'Semua Pengaturan', 'apps-outline'),
  e('Pengaturan', 'Pengaturan', 'SinkronPerangkat', 'Sinkron HP', 'sync-outline', { ket: 'Hubungkan HP lewat QR, kirim data HP ⇄ PC', sidebar: true, kata: 'pairing qr wifi kirim data' }),
  e('Pengaturan', 'Pengaturan', 'BackupRestore', 'Backup & Restore', 'cloud-upload-outline', { sidebar: true, kata: 'cadangan pulihkan kdb' }),
  e('Pengaturan', 'Pengaturan', 'ImportDataAwal', 'Import Data Awal', 'documents-outline', { kata: 'excel' }),
  e('Pengaturan', 'Pengaturan', 'UserManagement', 'User Management', 'people-outline', { sidebar: true, kata: 'pengguna akun role' }),
  e('Pengaturan', 'Pengaturan', 'PermissionMatrix', 'Permission Matrix', 'shield-checkmark-outline', { kata: 'izin hak akses' }),
  e('Pengaturan', 'Pengaturan', 'Keamanan', 'Keamanan', 'lock-closed-outline', { sidebar: true, kata: 'pin password' }),
  e('Pengaturan', 'Pengaturan', 'ResetData', 'Reset Data', 'trash-outline'),
];

type Izin = Readonly<Record<Resource, PermissionSet>> | null;

export function entriBoleh(x: EntriMenu, izin: Izin): boolean {
  if (x.tab !== 'Root' && x.tab !== 'Dashboard' && x.tab !== 'Pengaturan' && !bolehLihatTab(x.tab, izin)) return false;
  // Pengaturan: entri hub-nya sendiri disaring resource (lihat PengaturanScreen.MENU).
  return bolehBukaRute(x.rute, izin);
}

export function katalogBoleh(izin: Izin): EntriMenu[] {
  return KATALOG.filter((x) => entriBoleh(x, izin));
}

/** Cari entri (palet perintah). Skor sederhana: awalan judul > kata dalam judul > kata kunci/grup. */
export function cariKatalog(daftar: EntriMenu[], kueri: string): EntriMenu[] {
  const q = kueri.trim().toLowerCase();
  if (!q) return daftar;
  const kata = q.split(/\s+/);
  const skor = (x: EntriMenu): number => {
    const j = x.judul.toLowerCase();
    const semua = `${j} ${x.grup.toLowerCase()} ${(x.ket ?? '').toLowerCase()} ${(x.kata ?? '').toLowerCase()}`;
    if (!kata.every((k) => semua.includes(k))) return 0;
    if (j.startsWith(q)) return 3;
    if (j.includes(q)) return 2;
    return 1;
  };
  return daftar
    .map((x) => ({ x, s: skor(x) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((r) => r.x);
}

/**
 * Navigasi ke entri katalog dari navigator tab (atau anaknya).
 *
 * Di desktop, sidebar/palet adalah navigasi "lompat": tumpukan layar tab
 * tujuan lebih dulu dikembalikan ke akarnya (aksi POP_TO_TOP) supaya
 * riwayat tidak menumpuk dan jejak (breadcrumb) tetap "Tab › Layar".
 * Penjaga `beforeRemove` milik layar (mis. konfirmasi buang isian) tetap
 * berlaku karena memakai aksi navigasi standar.
 */
export function bukaEntri(navigation: { navigate: (...a: any[]) => void; dispatch?: (a: any) => void; getState?: () => any }, x: EntriMenu): void {
  if (x.tab === 'Root') {
    navigation.navigate(x.rute, x.params);
    return;
  }
  if (x.tab === 'Dashboard') {
    navigation.navigate('Dashboard');
    return;
  }
  const akar = GRUP_TAB.find((g) => g.tab === x.tab)?.akar;
  try {
    const st = navigation.getState?.();
    const tab = st?.routes?.find((r: any) => r.name === x.tab);
    const anak = tab?.state;
    if (anak?.key && typeof anak.index === 'number' && anak.index > 0 && navigation.dispatch) {
      // = StackActions.popToTop() (ditulis langsung agar modul ini bebas dependensi navigasi).
      navigation.dispatch({ type: 'POP_TO_TOP', target: anak.key });
    }
  } catch {
    /* tetap navigasi biasa */
  }
  navigation.navigate(x.tab, { screen: x.rute, params: x.params, initial: x.rute === akar });
}

import type { PermissionSet, Resource } from '@/config/defaultPermissions';
import { evaluasiIzin, type PermissionAction } from '@/security/permissions';

/**
 * ============================================================
 * RC-S132 — IZIN PER RUTE (PERMISSION MATRIX DI LAPISAN NAVIGASI)
 * ============================================================
 *
 * Sebelum RC-S132 permission matrix hanya ditegakkan di SERVICE
 * (`requirePermission`, ±140 titik) dan di segelintir tombol. Menu,
 * tab, dan layar tetap terbuka untuk semua role: Petugas atau Anggota
 * bisa membuka Laporan Keuangan, Backup, atau form transaksi — lalu baru
 * ditolak saat menekan Simpan (atau, untuk layar baca seperti laporan,
 * tidak ditolak sama sekali).
 *
 * Peta ini adalah SATU sumber syarat izin tiap rute. Dipakai oleh:
 *  - gerbang layar (`GerbangIzinLayar`, dipasang lewat `screenLayout`
 *    setiap navigator) -> rute tanpa izin menampilkan "Akses dibatasi",
 *    dari pintu masuk mana pun (menu, kartu Dashboard, tautan dalam layar);
 *  - penyaring menu hub (Data, Penerimaan, Pengeluaran, Penyesuaian,
 *    Laporan, …) -> entri tanpa izin tidak ditampilkan;
 *  - penyaring tab bawah.
 *
 * `null` = rute tanpa syarat (hub/menu yang isinya sudah disaring, dan
 * pengaturan pribadi seperti Keamanan). `aksi` berupa daftar berarti
 * CUKUP SALAH SATU (mis. form yang dipakai untuk tambah sekaligus ubah).
 * Syarat dipilih agar sama dengan izin yang ditegakkan service di balik
 * layar tersebut; service tetap menjadi penjaga terakhir.
 *
 * Rute yang TIDAK terdaftar diperlakukan TERTUTUP (fail-closed). Test
 * `PermissionMatrixUiRcS132` memastikan setiap rute di RootNavigator
 * terdaftar di sini.
 */
export interface SyaratIzin {
  resource: Resource;
  aksi: PermissionAction | readonly PermissionAction[];
}

const v = (resource: Resource): SyaratIzin => ({ resource, aksi: 'view' });
const c = (resource: Resource): SyaratIzin => ({ resource, aksi: 'create' });
const e = (resource: Resource): SyaratIzin => ({ resource, aksi: 'edit' });
const ce = (resource: Resource): SyaratIzin => ({ resource, aksi: ['create', 'edit'] });

export const IZIN_RUTE: Readonly<Record<string, SyaratIzin | null>> = {
  // ---- Tab & akar
  Tabs: null,
  Dashboard: null,
  Anggota: null,
  Transaksi: null,
  Laporan: null,
  Pengaturan: null,
  IdentitasKoperasi: null,

  // ---- Data (AnggotaStack)
  InputDataHub: null,
  AnggotaList: v('anggota'),
  AnggotaDetail: v('anggota'),
  AnggotaForm: ce('anggota'),
  PersonelKoperasi: v('anggota'),
  PerizinanKoperasi: v('anggota'),
  UnitUsahaKoperasi: v('anggota'),
  PeraturanInternal: v('anggota'),
  PelaksanaanRAT: v('shu'),
  AccountList: v('pengaturan'),
  AccountForm: e('pengaturan'),
  SaldoAwalAkunList: v('kas_bank'),
  SaldoAwalForm: ce('kas_bank'),
  RekeningList: v('kas_bank'),
  RekeningForm: ce('kas_bank'),
  DataReferensiList: v('kas_bank'),

  // ---- Transaksi: hub
  TransaksiHub: null,
  TransaksiPenerimaan: null,
  TransaksiPengeluaran: null,
  Penyesuaian: null,

  // ---- Simpanan
  SimpananHistori: v('simpanan'),
  SimpananDetail: v('simpanan'),
  SimpananForm: c('simpanan'),
  SimpananBerjangkaHistori: v('simpanan'),
  SimpananBerjangkaDetail: v('simpanan'),
  KebijakanProdukBerjangka: v('simpanan'),
  TarikSimpananForm: c('simpanan'),
  KebijakanPenarikanDini: v('pengaturan'),
  BungaSimpananSukarela: v('simpanan'),

  // ---- Pinjaman
  PinjamanList: v('pinjaman'),
  PinjamanDetail: v('pinjaman'),
  PinjamanForm: c('pinjaman'),
  PinjamanJadwalCustom: c('pinjaman'),
  BayarAngsuranForm: ce('pinjaman'),
  PenghapusanPiutangForm: e('pinjaman'),
  KolektibilitasPiutang: v('pinjaman'),

  // ---- Kas & Bank / operasional koperasi
  KasBankTransaksiForm: c('kas_bank'),
  KasBankHistori: v('kas_bank'),
  KasBankDetail: v('kas_bank'),
  UtangForm: c('kas_bank'),
  BayarUtangForm: c('kas_bank'),
  ModalForm: c('kas_bank'),
  PenarikanBankForm: c('kas_bank'),
  PembelianAsetForm: c('kas_bank'),
  AsetEditForm: e('kas_bank'),
  PelepasanAsetForm: e('kas_bank'),
  BebanForm: c('kas_bank'),
  ImbalanKerjaForm: c('kas_bank'),
  InvestasiForm: ce('kas_bank'),
  ImpairmentInvestasiForm: e('kas_bank'),
  BagianShuForm: e('kas_bank'),
  PendapatanLainnyaMenu: v('kas_bank'),
  PendapatanLainnyaForm: c('kas_bank'),
  PendapatanInvestasiForm: c('kas_bank'),
  PendapatanUnitUsahaForm: c('kas_bank'),
  PenarikanInvestasi: v('kas_bank'),
  PenarikanInvestasiForm: e('kas_bank'),
  RiwayatPenarikanInvestasi: v('kas_bank'),
  DetailPenarikanInvestasi: v('kas_bank'),
  Rekonsiliasi: c('kas_bank'),
  PenyesuaianNilaiWajar: c('kas_bank'),
  PenyusutanPropertiInvestasi: v('kas_bank'),

  // ---- Pajak
  PajakMenu: v('kas_bank'),
  PengaturanPajak: e('pengaturan'),
  PphFinalForm: c('kas_bank'),
  AngsuranPph25Form: c('kas_bank'),
  PphBadanForm: c('kas_bank'),
  SetorPajakForm: c('kas_bank'),
  RiwayatPajak: v('kas_bank'),
  BuktiPotongPph: v('kas_bank'),
  KoreksiFiskal: v('kas_bank'),

  // ---- RAK
  RAKForm: ce('rak'),
  PengembalianRAKForm: ce('rak'),
  RAKList: v('rak'),

  // ---- Keluar anggota
  KeluarAnggotaMenu: v('anggota'),
  KeluarAnggotaForm: e('anggota'),
  DaftarKeluarAnggota: v('anggota'),
  KeluarAnggotaDetail: v('anggota'),

  // ---- SHU
  Shu: v('shu'),
  ShuForm: c('shu'),
  ShuDetail: v('shu'),
  ShuAnggotaDetail: v('shu'),

  // ---- Riwayat transaksi
  HistoryTransaksi: v('history_transaksi'),
  HistoryTransaksiDetail: v('history_transaksi'),

  // ---- Laporan
  LaporanMenu: null,
  PenyusutanDimukaMenu: v('laporan'),
  Lpea: v('laporan'),
  StatusPeriode: v('laporan'),
  TutupPeriode: e('pengaturan'),
  BuktiTransaksiList: v('laporan'),
  BuktiTransaksiDetail: v('laporan'),
  PendapatanDimukaList: v('laporan'),
  DaftarInvestasi: v('laporan'),
  DaftarUtang: v('laporan'),
  DaftarAsetTetap: v('laporan'),
  DaftarPendapatan: v('laporan'),
  PendapatanAkunDetail: v('laporan'),
  NeracaSaldo: v('laporan'),
  BukuBesar: v('laporan'),
  PosisiKeuangan: v('laporan'),
  LabaRugi: v('laporan'),
  PerubahanEkuitas: v('laporan'),
  ArusKas: v('laporan'),
  Calk: v('laporan'),

  // ---- Pengaturan
  PengaturanMenu: null,
  Keamanan: null,
  Developer: null,
  BackupRestore: v('backup'),
  // Sinkron HP⇄Desktop: setara operasi data massal (backup/restore).
  SinkronPerangkat: v('backup'),
  ImportDataAwal: v('backup'),
  StrukturTemplate: v('backup'),
  RiwayatImport: v('backup'),
  ResetData: { resource: 'backup', aksi: 'approve' },
  UserManagement: v('user_management'),
  UserForm: ce('user_management'),
  // RC-S133.5 — membuat akun massal = menambah user (service tetap Admin-only).
  AkunAnggotaMassal: c('user_management'),
  PermissionMatrix: v('user_management'),
};

/** Syarat izin satu rute; `undefined` = rute tidak terdaftar (diperlakukan tertutup). */
export function syaratRute(rute: string): SyaratIzin | null | undefined {
  return Object.prototype.hasOwnProperty.call(IZIN_RUTE, rute) ? IZIN_RUTE[rute] : undefined;
}

/** Apakah izin yang dimuat memenuhi satu syarat (salah satu aksi cukup). */
export function memenuhiSyarat(
  syarat: SyaratIzin | null | undefined,
  izin: Readonly<Record<Resource, PermissionSet>> | null
): boolean {
  if (syarat === null) return true;
  if (syarat === undefined || !izin) return false; // tidak terdaftar / izin belum dimuat -> tertutup
  const daftar = Array.isArray(syarat.aksi) ? syarat.aksi : [syarat.aksi as PermissionAction];
  return daftar.some((a) => evaluasiIzin(izin[syarat.resource], a));
}

export function bolehBukaRute(rute: string, izin: Readonly<Record<Resource, PermissionSet>> | null): boolean {
  return memenuhiSyarat(syaratRute(rute), izin);
}

/**
 * Nama rute tujuan sebuah aksi menu `(nav) => nav.navigate('X', …)`, ditangkap
 * dengan navigator tiruan — tanpa menjalankan navigasi sungguhan. Dipakai hub
 * yang menyimpan aksi sebagai fungsi. `null` bila aksi tidak menavigasi.
 */
export function ruteDariAksi(aksi: (nav: any) => void): string | null {
  let rute: string | null = null;
  const tiruan = {
    navigate: (nama: string, params?: { screen?: string }) => {
      if (rute === null) rute = params && typeof params.screen === 'string' ? params.screen : nama;
    },
    push: (nama: string) => {
      if (rute === null) rute = nama;
    },
  };
  try {
    aksi(tiruan);
  } catch {
    return null;
  }
  return rute;
}

/** Syarat untuk menampilkan sebuah tab bawah: cukup salah satu resource dapat dilihat. */
export const RESOURCE_TAB: Readonly<Record<string, readonly Resource[] | null>> = {
  Dashboard: null,
  Anggota: ['anggota', 'kas_bank', 'pengaturan', 'shu'],
  Transaksi: ['simpanan', 'pinjaman', 'kas_bank', 'rak', 'shu', 'anggota'],
  // Akar tab Laporan (LaporanMenu) hanya berisi laporan keuangan & History
  // Transaksi; SHU/RAKU dibuka dari tab Transaksi. Tanpa keduanya tab ini
  // hanya akan menampilkan menu kosong, jadi disembunyikan.
  Laporan: ['laporan', 'history_transaksi'],
  Pengaturan: null,
};

export function bolehLihatTab(tab: string, izin: Readonly<Record<Resource, PermissionSet>> | null): boolean {
  const daftar = RESOURCE_TAB[tab];
  if (daftar === null || daftar === undefined) return true;
  if (!izin) return false;
  return daftar.some((r) => evaluasiIzin(izin[r], 'view'));
}

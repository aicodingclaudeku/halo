/**
 * Matrix permission default untuk 5 role (fase 8). Ini HANYA titik awal
 * — Admin bisa mengubahnya lewat Pengaturan > Permission Matrix (disimpan
 * di tabel `role_permission` yang sudah ada sejak skema awal, PRD §31).
 *
 * Resource merepresentasikan modul aplikasi; action merepresentasikan
 * kolom can_view/can_create/can_edit/can_approve/can_export di
 * role_permission. `user_management` SENGAJA hanya true untuk ADMIN di
 * semua role lain — pengelolaan user adalah aksi bootstrap-kritis yang
 * juga di-hardcode di UserManagementService.ts (pertahanan berlapis,
 * bukan cuma bergantung pada matrix yang bisa saja salah diedit admin).
 */

export type Role = 'ADMIN' | 'PENGURUS' | 'BENDAHARA' | 'PETUGAS' | 'ANGGOTA';

export const ROLES: Role[] = ['ADMIN', 'PENGURUS', 'BENDAHARA', 'PETUGAS', 'ANGGOTA'];

export const RESOURCES = [
  'anggota',
  'simpanan',
  'pinjaman',
  'kas_bank',
  'shu',
  'laporan',
  'backup',
  'export',
  'pengaturan',
  'user_management',
  // Phase 18 §3/§26: resource permission khusus RAK (Rekening Antar
  // Kantor) — dipisah dari kas_bank sesuai permintaan pengguna
  // ("rak create/edit/delete/export").
  'rak',
  // Phase 18 §8/§26: resource permission khusus History Transaksi —
  // "history_transaksi view/edit/delete/export" sesuai permintaan
  // pengguna. Delete memakai permission 'edit' yang sama (pola sama
  // dengan RAK/Kas&Bank — delete=koreksi/reversal, bukan DELETE SQL
  // mentah, jadi tidak ada kolom permission "delete" terpisah,
  // konsisten dengan matrix existing).
  'history_transaksi',
] as const;

export type Resource = (typeof RESOURCES)[number];

export interface PermissionSet {
  canView: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canApprove: boolean;
  canExport: boolean;
}

const FULL: PermissionSet = { canView: true, canCreate: true, canEdit: true, canApprove: true, canExport: true };
const NONE: PermissionSet = { canView: false, canCreate: false, canEdit: false, canApprove: false, canExport: false };
const VIEW_ONLY: PermissionSet = { ...NONE, canView: true };

/** Default matrix — 5 role x 10 resource, di-seed saat setup & self-heal untuk instalasi lama. */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, Record<Resource, PermissionSet>> = {
  ADMIN: {
    anggota: FULL,
    simpanan: FULL,
    pinjaman: FULL,
    kas_bank: FULL,
    rak: FULL,
    history_transaksi: FULL,
    shu: FULL,
    laporan: FULL,
    backup: FULL,
    export: FULL,
    pengaturan: FULL,
    user_management: FULL,
  },
  PENGURUS: {
    anggota: { canView: true, canCreate: true, canEdit: true, canApprove: true, canExport: true },
    simpanan: { canView: true, canCreate: true, canEdit: true, canApprove: false, canExport: true },
    pinjaman: { canView: true, canCreate: true, canEdit: true, canApprove: true, canExport: true },
    kas_bank: { canView: true, canCreate: true, canEdit: true, canApprove: false, canExport: true },
    rak: { canView: true, canCreate: true, canEdit: true, canApprove: false, canExport: true },
    history_transaksi: { ...NONE, canView: true, canEdit: true, canExport: true },
    shu: { canView: true, canCreate: true, canEdit: true, canApprove: true, canExport: true },
    laporan: { ...NONE, canView: true, canExport: true },
    backup: VIEW_ONLY,
    export: { ...NONE, canView: true, canExport: true },
    pengaturan: VIEW_ONLY,
    user_management: NONE,
  },
  BENDAHARA: {
    anggota: VIEW_ONLY,
    simpanan: { canView: true, canCreate: true, canEdit: true, canApprove: false, canExport: true },
    pinjaman: { canView: true, canCreate: true, canEdit: true, canApprove: false, canExport: true },
    kas_bank: { canView: true, canCreate: true, canEdit: true, canApprove: true, canExport: true },
    rak: { canView: true, canCreate: true, canEdit: true, canApprove: true, canExport: true },
    history_transaksi: { ...NONE, canView: true, canEdit: true, canExport: true },
    shu: { canView: true, canCreate: true, canEdit: false, canApprove: false, canExport: true },
    laporan: { ...NONE, canView: true, canExport: true },
    backup: { ...NONE, canView: true, canCreate: true },
    export: { ...NONE, canView: true, canExport: true },
    pengaturan: NONE,
    user_management: NONE,
  },
  PETUGAS: {
    anggota: { ...NONE, canView: true, canCreate: true },
    simpanan: { ...NONE, canView: true, canCreate: true },
    pinjaman: { ...NONE, canView: true, canCreate: true },
    kas_bank: { ...NONE, canView: true, canCreate: true },
    rak: { ...NONE, canView: true, canCreate: true },
    history_transaksi: VIEW_ONLY,
    shu: VIEW_ONLY,
    laporan: VIEW_ONLY,
    backup: NONE,
    export: NONE,
    pengaturan: NONE,
    user_management: NONE,
  },
  ANGGOTA: {
    anggota: VIEW_ONLY,
    simpanan: VIEW_ONLY,
    pinjaman: VIEW_ONLY,
    kas_bank: NONE,
    rak: NONE,
    history_transaksi: NONE,
    shu: VIEW_ONLY,
    laporan: NONE,
    backup: NONE,
    export: NONE,
    pengaturan: NONE,
    user_management: NONE,
  },
};

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Admin',
  PENGURUS: 'Pengurus',
  BENDAHARA: 'Bendahara',
  PETUGAS: 'Petugas',
  ANGGOTA: 'Anggota',
};

/** RC-S132 — label modul (resource) untuk layar Permission Matrix & "Akses dibatasi". */
export const RESOURCE_LABEL: Record<Resource, string> = {
  anggota: 'Anggota',
  simpanan: 'Simpanan',
  pinjaman: 'Pinjaman',
  kas_bank: 'Kas & Bank',
  rak: 'RAKU (Antar Kantor/Unit)',
  history_transaksi: 'History Transaksi',
  shu: 'SHU',
  laporan: 'Laporan',
  backup: 'Backup & Restore',
  export: 'Export',
  pengaturan: 'Pengaturan',
  user_management: 'User Management',
};

/** RC-S132 — keterangan singkat isi tiap modul (layar Permission Matrix). */
export const RESOURCE_KETERANGAN: Record<Resource, string> = {
  anggota: 'Data anggota, pengurus & organisasi, keluar anggota',
  simpanan: 'Setor/tarik simpanan, simpanan berjangka, bunga sukarela',
  pinjaman: 'Pemberian pinjaman, angsuran, kolektibilitas',
  kas_bank: 'Kas & bank, utang, modal, investasi, aset, pajak, beban',
  rak: 'Rekening antar kantor/unit usaha',
  history_transaksi: 'Riwayat transaksi, koreksi & pembatalan',
  shu: 'Perhitungan & pembagian SHU, pelaksanaan RAT',
  laporan: 'Laporan keuangan, buku besar, daftar aset/utang/investasi',
  backup: 'Backup, restore, import data awal, reset data',
  export: 'Export PDF/Excel',
  pengaturan: 'Bagan akun, periode, kebijakan & konfigurasi',
  user_management: 'Kelola user dan permission matrix',
};

/** RC-S132 — label aksi. */
export const AKSI_LABEL = {
  view: 'Lihat',
  create: 'Buat',
  edit: 'Ubah',
  approve: 'Setuju',
  export: 'Export',
} as const;

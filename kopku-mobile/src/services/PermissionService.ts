import * as SQLite from 'expo-sqlite';
import { getDb } from '@/database/db';
import { newId } from '@/utils/id';
import { DEFAULT_ROLE_PERMISSIONS, ROLES, RESOURCES, Role, Resource, PermissionSet } from '@/config/defaultPermissions';
import { evaluasiIzin, UnauthorizedError, UserNonaktifError, PermissionAction } from '@/security/permissions';

/**
 * Service Permission (fase 8 §3-6, §9-10). Sumber kebenaran matrix ada
 * di tabel `role_permission` (sudah ada di skema sejak awal, PRD §31).
 * `requirePermission()` adalah titik enforcement UTAMA — dipanggil dari
 * DALAM service lain (SimpananService, PinjamanService, KasBankService,
 * ShuService, BackupService, dst) sebelum aksi mutating dijalankan,
 * BUKAN cuma menyembunyikan tombol di UI (§10).
 */

/**
 * Self-heal (pola yang sama dengan pastikanMappingShu() di ShuService.ts
 * fase 4): pastikan matrix default ter-seed, baik untuk instalasi baru
 * maupun instalasi lama yang di-upgrade.
 *
 * Phase 18 (bug ditemukan saat menambah resource `rak`): implementasi
 * SEBELUMNYA berhenti total ("return") kalau `role_permission` sudah
 * punya BARIS APA PUN — artinya instalasi lama yang sudah pernah
 * ter-seed (tabel tidak kosong) TIDAK PERNAH kebagian resource BARU
 * yang ditambahkan di versi berikutnya (mis. `rak` di sini), membuat
 * requirePermission() menolak SEMUA role termasuk ADMIN untuk resource
 * baru itu — padahal baris untuk resource lain sudah ada duluan.
 * Diperbaiki jadi self-heal PER (role, resource) — pola yang SAMA
 * seperti self-heal COA di db.ts (cek existence per kode, cuma
 * menambah yang belum ada, tidak menyentuh baris yang sudah ada/sudah
 * diubah admin lewat Permission Matrix).
 */
export async function pastikanPermissionMatrix(db: SQLite.SQLiteDatabase): Promise<void> {
  const existingRows = await db.getAllAsync<{ role: string; resource: string }>(
    `SELECT role, resource FROM role_permission`
  );
  const existingKeys = new Set(existingRows.map((r) => `${r.role}::${r.resource}`));

  for (const role of ROLES) {
    for (const resource of RESOURCES) {
      if (existingKeys.has(`${role}::${resource}`)) continue;
      const p = DEFAULT_ROLE_PERMISSIONS[role][resource];
      await db.runAsync(
        `INSERT OR IGNORE INTO role_permission
          (id, role, resource, can_view, can_create, can_edit, can_approve, can_export)
         VALUES (?,?,?,?,?,?,?,?)`,
        newId(),
        role,
        resource,
        p.canView ? 1 : 0,
        p.canCreate ? 1 : 0,
        p.canEdit ? 1 : 0,
        p.canApprove ? 1 : 0,
        p.canExport ? 1 : 0
      );
    }
  }
}

export interface PermissionMatrixRow {
  role: Role;
  resource: Resource;
  permission: PermissionSet;
}

/** Seluruh matrix, dipakai layar Permission Matrix (Admin only). */
export async function getPermissionMatrix(): Promise<PermissionMatrixRow[]> {
  const db = await getDb();
  await pastikanPermissionMatrix(db);

  const rows = await db.getAllAsync<any>(
    `SELECT role, resource, can_view, can_create, can_edit, can_approve, can_export FROM role_permission`
  );
  return rows.map((r) => ({
    role: r.role,
    resource: r.resource,
    permission: {
      canView: !!r.can_view,
      canCreate: !!r.can_create,
      canEdit: !!r.can_edit,
      canApprove: !!r.can_approve,
      canExport: !!r.can_export,
    },
  }));
}

/** Ambil satu baris permission (role, resource) — dipakai hasPermission/requirePermission. */
async function getPermissionRow(
  db: SQLite.SQLiteDatabase,
  role: Role,
  resource: Resource
): Promise<PermissionSet | undefined> {
  await pastikanPermissionMatrix(db);
  const row = await db.getFirstAsync<any>(
    `SELECT can_view, can_create, can_edit, can_approve, can_export FROM role_permission WHERE role = ? AND resource = ?`,
    role,
    resource
  );
  if (!row) return undefined;
  return {
    canView: !!row.can_view,
    canCreate: !!row.can_create,
    canEdit: !!row.can_edit,
    canApprove: !!row.can_approve,
    canExport: !!row.can_export,
  };
}

/** Role & status aktif satu user — dipakai requirePermission untuk resolusi role dari userId. */
async function getUserRoleAktif(db: SQLite.SQLiteDatabase, userId: string): Promise<{ role: Role; aktif: boolean } | null> {
  const row = await db.getFirstAsync<{ role: Role; aktif: number }>(`SELECT role, aktif FROM app_user WHERE id = ?`, userId);
  if (!row) return null;
  return { role: row.role, aktif: !!row.aktif };
}

/** Cek izin tanpa melempar error — dipakai UI (hook usePermission) & pengecekan opsional. */
export async function hasPermission(userId: string, resource: Resource, action: PermissionAction): Promise<boolean> {
  const db = await getDb();
  const user = await getUserRoleAktif(db, userId);
  if (!user || !user.aktif) return false;
  const permission = await getPermissionRow(db, user.role, resource);
  return evaluasiIzin(permission, action);
}

/**
 * Ambil seluruh permission untuk SATU role, dibentuk jadi peta per
 * resource — dipakai App.tsx untuk mengisi cache `useAppStore.permissions`
 * setelah login/unlock (fase 8 §5, dasar untuk hook usePermission).
 */
export async function getPermissionsForRole(role: Role): Promise<Record<Resource, PermissionSet>> {
  const db = await getDb();
  await pastikanPermissionMatrix(db);

  const hasil = {} as Record<Resource, PermissionSet>;
  for (const resource of RESOURCES) {
    hasil[resource] = (await getPermissionRow(db, role, resource)) ?? {
      canView: false,
      canCreate: false,
      canEdit: false,
      canApprove: false,
      canExport: false,
    };
  }
  return hasil;
}

/**
 * Enforcement UTAMA (fase 8 §10) — dipanggil di DALAM service lain
 * sebelum aksi mutating. Melempar error jika user nonaktif atau tidak
 * berizin, sehingga aksi TIDAK bisa dilakukan meski UI-nya entah
 * bagaimana masih menampilkan tombolnya.
 */
export async function requirePermission(
  db: SQLite.SQLiteDatabase,
  userId: string,
  resource: Resource,
  action: PermissionAction
): Promise<void> {
  const user = await getUserRoleAktif(db, userId);
  if (!user) throw new UnauthorizedError(resource, action);
  if (!user.aktif) throw new UserNonaktifError();

  const permission = await getPermissionRow(db, user.role, resource);
  if (!evaluasiIzin(permission, action)) {
    throw new UnauthorizedError(resource, action);
  }
}

/**
 * PHASE 5 FINAL FIX (permintaan pengguna) — variant `requirePermission`
 * KHUSUS untuk automatic internal lifecycle maintenance (mis. trigger
 * penyusutan otomatis saat app dibuka, `PenyusutanService.
 * jalankanPenyusutanOtomatisJikaPerlu`) — BUKAN untuk dipanggil dari
 * mana pun yang berasal dari aksi/tombol UI pengguna.
 *
 * Bedanya dengan `requirePermission` biasa:
 *  - `isSystemTrigger = false` (default kalau tidak diisi eksplisit):
 *    PERSIS `requirePermission()` — user harus ada, aktif, DAN
 *    memiliki permission RBAC resource/action yang diminta. Ini yang
 *    dipakai SETIAP aksi manual dari UI, TIDAK ADA yang berubah.
 *  - `isSystemTrigger = true`: user tetap harus ADA & AKTIF (audit
 *    trail `created_by` tetap valid & bermakna — BUKAN user
 *    palsu/hardcode), TAPI pengecekan RBAC resource/action SPESIFIK
 *    DILEWATI — automatic accounting maintenance (penyusutan bulan
 *    berjalan, dst.) tidak boleh gagal senyap hanya karena role user
 *    yang KEBETULAN sedang login tidak diberi izin `kas_bank`/`create`
 *    secara eksplisit di menu Pengaturan > Hak Akses.
 *
 * KEAMANAN: fungsi ini TIDAK mengubah tabel `role_permission` (§2:
 * "jangan membuat semua user memiliki permission" — matrix permission
 * sama sekali tidak disentuh), TIDAK memalsukan/hardcode user ID
 * (`userId` yang diperiksa tetap persis user yang sedang login), dan
 * TIDAK menghapus `requirePermission()` (fungsi itu tetap ada & tetap
 * dipakai apa adanya oleh SELURUH pemanggil lain). `isSystemTrigger`
 * HANYA boleh bernilai `true` dari kode yang secara eksplisit
 * mendokumentasikan dirinya sebagai trusted lifecycle path (lihat
 * komentar di titik pemanggilan) — TIDAK PERNAH diteruskan dari
 * parameter yang berasal dari request/aksi pengguna.
 */
export async function requirePermissionAtauSystemTrigger(
  db: SQLite.SQLiteDatabase,
  userId: string,
  resource: Resource,
  action: PermissionAction,
  isSystemTrigger: boolean
): Promise<void> {
  if (!isSystemTrigger) {
    return requirePermission(db, userId, resource, action);
  }
  // System trigger: user tetap harus ada & aktif (audit trail valid),
  // permission RBAC resource/action SENGAJA dilewati — lihat komentar
  // di atas fungsi ini untuk alasan & batasan pemakaiannya.
  const user = await getUserRoleAktif(db, userId);
  if (!user) throw new UnauthorizedError(resource, action);
  if (!user.aktif) throw new UserNonaktifError();
}

/**
 * RC-S132 — aturan konsistensi satu baris izin: aksi apa pun (Buat/Ubah/
 * Setuju/Export) MENYIRATKAN Lihat. Tanpa ini Admin bisa menyimpan baris
 * "Buat tanpa Lihat" — role tsb tidak bisa membuka layarnya (gerbang
 * navigasi butuh Lihat/Buat) padahal service mengizinkan menulis.
 */
export function normalisasiIzin(p: PermissionSet): PermissionSet {
  const adaAksi = p.canCreate || p.canEdit || p.canApprove || p.canExport;
  return { ...p, canView: p.canView || adaAksi };
}

/**
 * RC-S132 — satu ketukan chip di layar Permission Matrix:
 *  - menyalakan Buat/Ubah/Setuju/Export ikut menyalakan Lihat;
 *  - mematikan Lihat mematikan semua aksi (modul tertutup total).
 */
export function terapkanKlikIzin(p: PermissionSet, aksi: keyof PermissionSet): PermissionSet {
  if (aksi === 'canView' && p.canView) {
    return { canView: false, canCreate: false, canEdit: false, canApprove: false, canExport: false };
  }
  return normalisasiIzin({ ...p, [aksi]: !p[aksi] });
}

/**
 * RC-S133.5 — role ANGGOTA tidak memakai matrix modul: akunnya dibuka di
 * Portal Anggota dan hanya melihat data anggota yang ditautkan.
 * Mengubah barisnya tidak berarti apa-apa, jadi ditolak supaya tidak
 * memberi kesan izin modul koperasi bisa dibuka untuk anggota.
 */
export class IzinAnggotaTetapError extends Error {
  constructor() {
    super('Akun Anggota selalu hanya melihat data dirinya sendiri (Portal Anggota); izinnya tidak diatur lewat matrix.');
    this.name = 'IzinAnggotaTetapError';
  }
}

export class IzinAdminTerkunciError extends Error {
  constructor() {
    super('Izin role Admin selalu penuh dan tidak dapat diubah, agar koperasi tidak kehilangan akses pengelola.');
    this.name = 'IzinAdminTerkunciError';
  }
}

async function catatAuditIzin(db: SQLite.SQLiteDatabase, userId: string, action: string, entityId: string, data: unknown) {
  const now = new Date();
  await db
    .runAsync(
      `INSERT INTO audit_log (id, user_id, tanggal, waktu, action, entity, entity_id, data_sesudah, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      newId(),
      userId,
      now.toISOString().slice(0, 10),
      now.toISOString().slice(11, 19),
      action,
      'role_permission',
      entityId,
      JSON.stringify(data),
      now.toISOString()
    )
    .catch(() => undefined);
}

/** Admin mengubah satu baris permission (fase 8 §3, §8 — "admin dapat mengubah role/izin"). */
export async function updateRolePermission(
  actingUserId: string,
  role: Role,
  resource: Resource,
  permission: PermissionSet
): Promise<void> {
  const db = await getDb();
  await requirePermission(db, actingUserId, 'user_management', 'edit');
  // RC-S132: sebelumnya hanya chip di UI yang dinonaktifkan untuk ADMIN;
  // service menerima pencabutan izin Admin (termasuk user_management
  // sendiri) -> koperasi bisa terkunci dari pengelolaan user.
  if (role === 'ADMIN') throw new IzinAdminTerkunciError();
  if (role === 'ANGGOTA') throw new IzinAnggotaTetapError();
  const izin = normalisasiIzin(permission);

  await pastikanPermissionMatrix(db);
  await db.runAsync(
    `UPDATE role_permission SET can_view=?, can_create=?, can_edit=?, can_approve=?, can_export=? WHERE role=? AND resource=?`,
    izin.canView ? 1 : 0,
    izin.canCreate ? 1 : 0,
    izin.canEdit ? 1 : 0,
    izin.canApprove ? 1 : 0,
    izin.canExport ? 1 : 0,
    role,
    resource
  );
  await catatAuditIzin(db, actingUserId, 'UPDATE_PERMISSION', `${role}:${resource}`, izin);
}

/** RC-S132 — kembalikan seluruh izin satu role ke bawaan aplikasi (DEFAULT_ROLE_PERMISSIONS). */
export async function pulihkanIzinDefaultRole(actingUserId: string, role: Role): Promise<void> {
  const db = await getDb();
  await requirePermission(db, actingUserId, 'user_management', 'edit');
  if (role === 'ADMIN') throw new IzinAdminTerkunciError();
  if (role === 'ANGGOTA') throw new IzinAnggotaTetapError();
  await pastikanPermissionMatrix(db);
  for (const resource of RESOURCES) {
    const p = DEFAULT_ROLE_PERMISSIONS[role][resource];
    await db.runAsync(
      `UPDATE role_permission SET can_view=?, can_create=?, can_edit=?, can_approve=?, can_export=? WHERE role=? AND resource=?`,
      p.canView ? 1 : 0,
      p.canCreate ? 1 : 0,
      p.canEdit ? 1 : 0,
      p.canApprove ? 1 : 0,
      p.canExport ? 1 : 0,
      role,
      resource
    );
  }
  await catatAuditIzin(db, actingUserId, 'RESET_PERMISSION_DEFAULT', role, { role });
}

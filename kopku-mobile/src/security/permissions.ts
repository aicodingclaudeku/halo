import { PermissionSet } from '@/config/defaultPermissions';

/**
 * Logika keputusan otorisasi MURNI (tanpa I/O) — dipisahkan dari
 * PermissionService.ts (yang mengambil data role/matrix dari SQLite)
 * supaya bisa diuji tanpa native module. Pola yang sama dengan
 * BackupValidator.ts, ShuCalculator.ts, ReportTableBuilders.ts.
 */

export type PermissionAction = 'view' | 'create' | 'edit' | 'approve' | 'export';

/** Evaluasi murni: dari satu baris PermissionSet, apakah action diizinkan? */
export function evaluasiIzin(permission: PermissionSet | undefined, action: PermissionAction): boolean {
  if (!permission) return false; // tidak ada baris matrix = tidak diizinkan (fail-closed, bukan fail-open)
  switch (action) {
    case 'view':
      return permission.canView;
    case 'create':
      return permission.canCreate;
    case 'edit':
      return permission.canEdit;
    case 'approve':
      return permission.canApprove;
    case 'export':
      return permission.canExport;
    default:
      return false;
  }
}

export class UnauthorizedError extends Error {
  constructor(resource: string, action: PermissionAction) {
    super(`Anda tidak memiliki izin untuk melakukan "${action}" pada "${resource}".`);
    this.name = 'UnauthorizedError';
  }
}

export class UserNonaktifError extends Error {
  constructor() {
    super('Akun Anda sudah dinonaktifkan. Hubungi Admin.');
    this.name = 'UserNonaktifError';
  }
}

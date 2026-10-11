import { useAppStore } from '@/store/useAppStore';
import { Resource } from '@/config/defaultPermissions';
import { evaluasiIzin, PermissionAction } from '@/security/permissions';

/**
 * Hook UI untuk proteksi halaman/tombol (fase 8 §5-6). Membaca cache
 * `permissions` di useAppStore (dimuat App.tsx setelah login/unlock).
 *
 * PENTING: ini HANYA untuk UX (sembunyikan/nonaktifkan tombol, redirect
 * halaman) — enforcement SEBENARNYA selalu ada di service lewat
 * requirePermission() (lihat PermissionService.ts), supaya tidak bisa
 * dilewati dengan memanggil service langsung (§10).
 */
export function usePermission() {
  const permissions = useAppStore((s) => s.permissions);

  const can = (resource: Resource, action: PermissionAction): boolean => {
    if (!permissions) return false; // belum termuat = fail-closed
    return evaluasiIzin(permissions[resource], action);
  };

  return { can, permissions };
}

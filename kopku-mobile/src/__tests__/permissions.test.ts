import { evaluasiIzin } from '@/security/permissions';
import { DEFAULT_ROLE_PERMISSIONS, ROLES, RESOURCES } from '@/config/defaultPermissions';

describe('evaluasiIzin (PRD fase 8 - logika otorisasi murni)', () => {
  test('permission undefined (tidak ada baris matrix) SELALU ditolak — fail-closed', () => {
    expect(evaluasiIzin(undefined, 'view')).toBe(false);
    expect(evaluasiIzin(undefined, 'create')).toBe(false);
    expect(evaluasiIzin(undefined, 'edit')).toBe(false);
    expect(evaluasiIzin(undefined, 'approve')).toBe(false);
    expect(evaluasiIzin(undefined, 'export')).toBe(false);
  });

  test('setiap action memetakan ke kolom PermissionSet yang benar', () => {
    const permission = { canView: true, canCreate: false, canEdit: true, canApprove: false, canExport: true };
    expect(evaluasiIzin(permission, 'view')).toBe(true);
    expect(evaluasiIzin(permission, 'create')).toBe(false);
    expect(evaluasiIzin(permission, 'edit')).toBe(true);
    expect(evaluasiIzin(permission, 'approve')).toBe(false);
    expect(evaluasiIzin(permission, 'export')).toBe(true);
  });
});

describe('DEFAULT_ROLE_PERMISSIONS (fase 8 - matrix default 5 role)', () => {
  test('matrix mencakup persis 5 role yang diminta: Admin, Pengurus, Bendahara, Petugas, Anggota', () => {
    expect(ROLES.sort()).toEqual(['ADMIN', 'ANGGOTA', 'BENDAHARA', 'PENGURUS', 'PETUGAS'].sort());
  });

  test('setiap role punya baris untuk SEMUA resource (tidak ada yang tertinggal)', () => {
    for (const role of ROLES) {
      for (const resource of RESOURCES) {
        expect(DEFAULT_ROLE_PERMISSIONS[role][resource]).toBeDefined();
      }
    }
  });

  describe('role ADMIN', () => {
    test('memiliki izin PENUH untuk semua resource termasuk user_management', () => {
      for (const resource of RESOURCES) {
        const p = DEFAULT_ROLE_PERMISSIONS.ADMIN[resource];
        expect(evaluasiIzin(p, 'view')).toBe(true);
        expect(evaluasiIzin(p, 'create')).toBe(true);
        expect(evaluasiIzin(p, 'edit')).toBe(true);
        expect(evaluasiIzin(p, 'approve')).toBe(true);
        expect(evaluasiIzin(p, 'export')).toBe(true);
      }
    });
  });

  describe('role PENGURUS', () => {
    test('bisa mengelola anggota, pinjaman, dan SHU (termasuk approve)', () => {
      expect(evaluasiIzin(DEFAULT_ROLE_PERMISSIONS.PENGURUS.anggota, 'approve')).toBe(true);
      expect(evaluasiIzin(DEFAULT_ROLE_PERMISSIONS.PENGURUS.pinjaman, 'approve')).toBe(true);
      expect(evaluasiIzin(DEFAULT_ROLE_PERMISSIONS.PENGURUS.shu, 'approve')).toBe(true);
    });

    test('TIDAK punya akses user_management sama sekali', () => {
      const p = DEFAULT_ROLE_PERMISSIONS.PENGURUS.user_management;
      expect(evaluasiIzin(p, 'view')).toBe(false);
      expect(evaluasiIzin(p, 'create')).toBe(false);
      expect(evaluasiIzin(p, 'edit')).toBe(false);
    });
  });

  describe('role BENDAHARA', () => {
    test('bisa kelola simpanan/pinjaman/kas_bank tapi TIDAK approve pinjaman', () => {
      expect(evaluasiIzin(DEFAULT_ROLE_PERMISSIONS.BENDAHARA.simpanan, 'create')).toBe(true);
      expect(evaluasiIzin(DEFAULT_ROLE_PERMISSIONS.BENDAHARA.pinjaman, 'approve')).toBe(false);
      expect(evaluasiIzin(DEFAULT_ROLE_PERMISSIONS.BENDAHARA.kas_bank, 'approve')).toBe(true);
    });

    test('hanya view untuk anggota (tidak create/edit)', () => {
      expect(evaluasiIzin(DEFAULT_ROLE_PERMISSIONS.BENDAHARA.anggota, 'view')).toBe(true);
      expect(evaluasiIzin(DEFAULT_ROLE_PERMISSIONS.BENDAHARA.anggota, 'create')).toBe(false);
    });

    test('TIDAK punya akses user_management', () => {
      expect(evaluasiIzin(DEFAULT_ROLE_PERMISSIONS.BENDAHARA.user_management, 'view')).toBe(false);
    });
  });

  describe('role PETUGAS', () => {
    test('bisa input data dasar (create) tapi TIDAK bisa edit/approve/export', () => {
      for (const resource of ['anggota', 'simpanan', 'pinjaman', 'kas_bank'] as const) {
        const p = DEFAULT_ROLE_PERMISSIONS.PETUGAS[resource];
        expect(evaluasiIzin(p, 'create')).toBe(true);
        expect(evaluasiIzin(p, 'edit')).toBe(false);
        expect(evaluasiIzin(p, 'approve')).toBe(false);
        expect(evaluasiIzin(p, 'export')).toBe(false);
      }
    });

    test('TIDAK punya akses backup, export, pengaturan, user_management sama sekali', () => {
      for (const resource of ['backup', 'export', 'pengaturan', 'user_management'] as const) {
        expect(evaluasiIzin(DEFAULT_ROLE_PERMISSIONS.PETUGAS[resource], 'view')).toBe(false);
      }
    });
  });

  describe('role ANGGOTA', () => {
    test('hanya bisa MELIHAT (view) data sendiri — anggota/simpanan/pinjaman/shu — tanpa create/edit/approve/export', () => {
      for (const resource of ['anggota', 'simpanan', 'pinjaman', 'shu'] as const) {
        const p = DEFAULT_ROLE_PERMISSIONS.ANGGOTA[resource];
        expect(evaluasiIzin(p, 'view')).toBe(true);
        expect(evaluasiIzin(p, 'create')).toBe(false);
        expect(evaluasiIzin(p, 'edit')).toBe(false);
        expect(evaluasiIzin(p, 'approve')).toBe(false);
        expect(evaluasiIzin(p, 'export')).toBe(false);
      }
    });

    test('TIDAK punya akses kas_bank, laporan, backup, export, pengaturan, user_management sama sekali', () => {
      for (const resource of ['kas_bank', 'laporan', 'backup', 'export', 'pengaturan', 'user_management'] as const) {
        expect(evaluasiIzin(DEFAULT_ROLE_PERMISSIONS.ANGGOTA[resource], 'view')).toBe(false);
      }
    });

    test('role paling terbatas di antara semua role (unauthorized access untuk hampir semua aksi mutasi)', () => {
      let totalIzinAnggota = 0;
      let totalIzinAdmin = 0;
      for (const resource of RESOURCES) {
        const pAnggota = DEFAULT_ROLE_PERMISSIONS.ANGGOTA[resource];
        const pAdmin = DEFAULT_ROLE_PERMISSIONS.ADMIN[resource];
        totalIzinAnggota += Object.values(pAnggota).filter(Boolean).length;
        totalIzinAdmin += Object.values(pAdmin).filter(Boolean).length;
      }
      expect(totalIzinAnggota).toBeLessThan(totalIzinAdmin);
    });
  });
});

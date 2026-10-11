import { createTestDb, TestDb } from './testDb';

/**
 * PermissionService.ts memakai getDb() dari database/db.ts secara
 * internal. Teknik mock di sini SAMA PERSIS dengan ShuService.test.ts —
 * lihat komentar di sana untuk penjelasan lengkap.
 */
let testDb: TestDb;

jest.mock('@/database/db', () => ({
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

// security/pin.ts mengimpor expo-secure-store (ESM murni) yang gagal
// di-parse Jest — sama seperti insiden expo-sqlite. Mock hashPin/
// generateSalt dengan implementasi JS biasa (bukan native module),
// SOURCE pin.ts asli TIDAK diubah sama sekali.
jest.mock('@/security/pin', () => ({
  hashPin: jest.fn(async (pin: string, salt: string) => `hashed:${salt}:${pin}`),
  generateSalt: jest.fn(() => 'test-salt'),
}));

import { hasPermission, requirePermission, getPermissionsForRole, updateRolePermission } from '@/services/PermissionService';
import { UnauthorizedError, UserNonaktifError } from '@/security/permissions';
import { createUser, updateUserRole, updateUserStatus, listUsers, HanyaAdminError } from '@/services/UserManagementService';

async function seedUser(id: string, role: string, aktif = true) {
  const now = new Date().toISOString();
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, biometric_enabled, aktif, created_at, updated_at)
     VALUES (?,?,?,?,?,?,0,?,?,?)`,
    id,
    `User ${role}`,
    `user-${id}`,
    role,
    'hash',
    'salt',
    aktif ? 1 : 0,
    now,
    now
  );
}

async function setupFixture(): Promise<void> {
  testDb = await createTestDb();
  await seedUser('admin-1', 'ADMIN');
  await seedUser('pengurus-1', 'PENGURUS');
  await seedUser('bendahara-1', 'BENDAHARA');
  await seedUser('petugas-1', 'PETUGAS');
  await seedUser('anggota-1', 'ANGGOTA');
  await seedUser('nonaktif-1', 'PETUGAS', false);
}

describe('PermissionService — hasPermission/requirePermission untuk 5 role (PRD fase 8)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('ADMIN: diizinkan untuk semua resource & action, termasuk user_management', async () => {
    expect(await hasPermission('admin-1', 'user_management', 'edit')).toBe(true);
    expect(await hasPermission('admin-1', 'kas_bank', 'approve')).toBe(true);
    await expect(requirePermission(testDb as any, 'admin-1', 'shu', 'approve')).resolves.not.toThrow();
  });

  test('PENGURUS: diizinkan approve pinjaman & shu, TAPI DITOLAK untuk user_management', async () => {
    expect(await hasPermission('pengurus-1', 'pinjaman', 'approve')).toBe(true);
    expect(await hasPermission('pengurus-1', 'shu', 'approve')).toBe(true);
    expect(await hasPermission('pengurus-1', 'user_management', 'view')).toBe(false);
    await expect(requirePermission(testDb as any, 'pengurus-1', 'user_management', 'edit')).rejects.toThrow(
      UnauthorizedError
    );
  });

  test('BENDAHARA: diizinkan kelola kas_bank & simpanan, TAPI DITOLAK approve pinjaman', async () => {
    expect(await hasPermission('bendahara-1', 'kas_bank', 'create')).toBe(true);
    expect(await hasPermission('bendahara-1', 'simpanan', 'create')).toBe(true);
    expect(await hasPermission('bendahara-1', 'pinjaman', 'approve')).toBe(false);
    await expect(requirePermission(testDb as any, 'bendahara-1', 'pinjaman', 'approve')).rejects.toThrow(
      UnauthorizedError
    );
  });

  test('PETUGAS: diizinkan create data dasar, TAPI DITOLAK edit/approve/export', async () => {
    expect(await hasPermission('petugas-1', 'anggota', 'create')).toBe(true);
    expect(await hasPermission('petugas-1', 'anggota', 'edit')).toBe(false);
    expect(await hasPermission('petugas-1', 'simpanan', 'export')).toBe(false);
    await expect(requirePermission(testDb as any, 'petugas-1', 'anggota', 'edit')).rejects.toThrow(UnauthorizedError);
  });

  test('ANGGOTA: hanya diizinkan view, DITOLAK untuk semua aksi mutasi (unauthorized access)', async () => {
    expect(await hasPermission('anggota-1', 'simpanan', 'view')).toBe(true);
    expect(await hasPermission('anggota-1', 'simpanan', 'create')).toBe(false);
    expect(await hasPermission('anggota-1', 'kas_bank', 'view')).toBe(false);
    await expect(requirePermission(testDb as any, 'anggota-1', 'simpanan', 'create')).rejects.toThrow(
      UnauthorizedError
    );
    await expect(requirePermission(testDb as any, 'anggota-1', 'pinjaman', 'approve')).rejects.toThrow(
      UnauthorizedError
    );
  });

  test('unauthorized access: user yang tidak ada di database DITOLAK', async () => {
    expect(await hasPermission('user-tidak-ada', 'anggota', 'view')).toBe(false);
    await expect(requirePermission(testDb as any, 'user-tidak-ada', 'anggota', 'view')).rejects.toThrow(
      UnauthorizedError
    );
  });

  test('unauthorized access: user NONAKTIF DITOLAK meski role-nya normalnya punya izin', async () => {
    expect(await hasPermission('nonaktif-1', 'anggota', 'create')).toBe(false);
    await expect(requirePermission(testDb as any, 'nonaktif-1', 'anggota', 'create')).rejects.toThrow(
      UserNonaktifError
    );
  });

  test('getPermissionsForRole mengembalikan peta lengkap semua resource untuk satu role', async () => {
    const permissions = await getPermissionsForRole('BENDAHARA' as any);
    expect(permissions.kas_bank.canCreate).toBe(true);
    expect(permissions.user_management.canView).toBe(false);
  });

  test('updateRolePermission oleh ADMIN berhasil mengubah matrix', async () => {
    await updateRolePermission('admin-1', 'PETUGAS' as any, 'anggota', {
      canView: true,
      canCreate: true,
      canEdit: true,
      canApprove: false,
      canExport: false,
    });
    expect(await hasPermission('petugas-1', 'anggota', 'edit')).toBe(true);
  });

  test('updateRolePermission oleh NON-ADMIN ditolak (hanya admin boleh ubah matrix)', async () => {
    await expect(
      updateRolePermission('pengurus-1', 'PETUGAS' as any, 'anggota', {
        canView: true,
        canCreate: true,
        canEdit: true,
        canApprove: false,
        canExport: false,
      })
    ).rejects.toThrow(UnauthorizedError);
  });
});

describe('UserManagementService — hanya Admin yang bisa mengelola user (PRD fase 8 §7-8)', () => {
  beforeEach(async () => {
    await setupFixture();
  });

  test('ADMIN bisa membuat user baru dengan role apapun', async () => {
    const { id } = await createUser('admin-1', { nama: 'Budi', username: 'budi', role: 'PETUGAS' as any, password: 'rahasia123' });
    expect(id).toBeDefined();
    const daftar = await listUsers('admin-1');
    expect(daftar.some((u) => u.username === 'budi')).toBe(true);
  });

  test('NON-ADMIN (Pengurus/Bendahara/Petugas/Anggota) DITOLAK membuat user — unauthorized access', async () => {
    for (const actingUserId of ['pengurus-1', 'bendahara-1', 'petugas-1', 'anggota-1']) {
      await expect(
        createUser(actingUserId, { nama: 'X', username: `x-${actingUserId}`, role: 'PETUGAS' as any, password: 'rahasia123' })
      ).rejects.toThrow(HanyaAdminError);
    }
  });

  test('NON-ADMIN DITOLAK melihat daftar user', async () => {
    await expect(listUsers('petugas-1')).rejects.toThrow(HanyaAdminError);
  });

  test('ADMIN bisa mengubah role user lain', async () => {
    await updateUserRole('admin-1', 'petugas-1', 'BENDAHARA' as any);
    const daftar = await listUsers('admin-1');
    const petugas = daftar.find((u) => u.id === 'petugas-1');
    expect(petugas?.role).toBe('BENDAHARA');
  });

  test('NON-ADMIN DITOLAK mengubah role siapapun', async () => {
    await expect(updateUserRole('pengurus-1', 'petugas-1', 'BENDAHARA' as any)).rejects.toThrow(HanyaAdminError);
  });

  test('tidak bisa menonaktifkan Admin TERAKHIR (proteksi bootstrap)', async () => {
    await expect(updateUserStatus('admin-1', 'admin-1', false)).rejects.toThrow(/Admin terakhir/);
  });

  test('tidak bisa mengubah role Admin TERAKHIR menjadi bukan Admin', async () => {
    await expect(updateUserRole('admin-1', 'admin-1', 'PETUGAS' as any)).rejects.toThrow(/Admin terakhir/);
  });

  test('BOLEH menonaktifkan Admin jika masih ada Admin aktif lainnya', async () => {
    await createUser('admin-1', { nama: 'Admin Kedua', username: 'admin2', role: 'ADMIN' as any, password: 'rahasia123' });
    await expect(updateUserStatus('admin-1', 'admin-1', false)).resolves.not.toThrow();
  });

  // DIPERBARUI RC-S117: user baru memakai PASSWORD, bukan PIN. PIN
  // tidak lagi menjadi kredensial masuk — ia hanya membuka kunci
  // aplikasi dan ditetapkan sendiri oleh pemiliknya. Kontraknya tetap
  // sama: kredensial yang tidak memenuhi syarat DITOLAK di service,
  // bukan hanya di UI.
  test('createUser menolak password yang terlalu pendek', async () => {
    await expect(
      createUser('admin-1', { nama: 'X', username: 'x1', role: 'PETUGAS' as any, password: 'abc' })
    ).rejects.toThrow(/minimal/i);
  });

  test('createUser menolak password yang hanya angka (itu PIN, bukan password)', async () => {
    await expect(
      createUser('admin-1', { nama: 'X', username: 'x2', role: 'PETUGAS' as any, password: '12345678' })
    ).rejects.toThrow(/hanya angka/i);
  });

  test('createUser menolak username yang sudah dipakai', async () => {
    await createUser('admin-1', { nama: 'Budi', username: 'budi', role: 'PETUGAS' as any, password: 'rahasia123' });
    await expect(
      createUser('admin-1', { nama: 'Budi Lain', username: 'budi', role: 'PETUGAS' as any, password: 'rahasia456' })
    ).rejects.toThrow(/sudah dipakai/);
  });

  test('password tersimpan dalam bentuk hash, BUKAN plaintext', async () => {
    await createUser('admin-1', { nama: 'Budi', username: 'budi', role: 'PETUGAS' as any, password: 'rahasia123' });
    const row = await testDb.getFirstAsync<{ password_hash: string; pin_hash: string }>(
      `SELECT password_hash, pin_hash FROM app_user WHERE username = ?`,
      'budi'
    );
    expect(row?.password_hash).not.toBe('rahasia123');
    expect((row?.password_hash ?? '').length).toBeGreaterThan(16);
    // RC-S117 — dan PIN-nya BUKAN salinan password. Menyalinnya akan
    // membuat password ikut menjadi kunci layar, yaitu penggabungan
    // dua peran yang justru dipisahkan di sini.
    expect(row?.pin_hash).not.toBe(row?.password_hash);
  });
});

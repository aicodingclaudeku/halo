import { readFileSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';
import * as SecureStoreMock from '../test-utils/expoSecureStoreMock';

/**
 * RC-S132 — Tombol Keluar, layar Login sesuai User Management, akun
 * Anggota ditautkan ke data anggota, dan Permission Matrix yang benar-
 * benar berlaku di menu/tab/layar.
 *
 * Integrasi memakai SQLite (node:sqlite) + scrypt @noble/hashes ASLI.
 * Bagian struktural membaca sumber layar (tanpa render perangkat).
 */
let testDb: TestDb;

jest.mock('@/database/db', () => ({
  ...jest.requireActual('@/database/db'),
  getDb: jest.fn(async () => testDb),
  withTransaction: jest.fn(async (fn: (db: TestDb) => Promise<unknown>) => {
    let result: unknown;
    await testDb.withTransactionAsync(async () => {
      result = await fn(testDb);
    });
    return result;
  }),
}));

import { DEFAULT_ROLE_PERMISSIONS, RESOURCES, ROLES, Role, Resource, PermissionSet } from '@/config/defaultPermissions';
import {
  IZIN_RUTE,
  bolehBukaRute,
  bolehLihatTab,
  memenuhiSyarat,
  ruteDariAksi,
  syaratRute,
} from '@/navigation/izinRute';
import {
  getPermissionsForRole,
  hasPermission,
  IzinAdminTerkunciError,
  normalisasiIzin,
  pulihkanIzinDefaultRole,
  terapkanKlikIzin,
  updateRolePermission,
} from '@/services/PermissionService';
import { createUser, listUsers, updateUser, updateUserRole } from '@/services/UserManagementService';
import { apakahKeluarManual, getUsernameTerakhir, KUNCI_KELUAR_MANUAL, login, logout } from '@/services/AuthService';
import { migrasiV80 } from '@/database/db';
import { SCHEMA_VERSION } from '@/database/schema';
import { deleteAnggota } from '@/repositories/AnggotaRepository';
import { resetDataTransaksiPadaDb } from '@/services/ResetDataTransaksi';
import { hashPinV2 } from '@/security/pinHash';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ss = SecureStoreMock as unknown as { __clear(): void; __dump(): Record<string, string> };

const izinDefault = (role: Role) => DEFAULT_ROLE_PERMISSIONS[role] as Record<Resource, PermissionSet>;

// ---------------------------------------------------------------------------
describe('RC-S132 §A — peta izin rute (navigasi mengikuti Permission Matrix)', () => {
  const rootNav = baca('src/navigation/RootNavigator.tsx');
  const ruteTerdaftar = Array.from(new Set(Array.from(rootNav.matchAll(/name="([A-Za-z0-9_]+)"/g)).map((m) => m[1])));

  it('SETIAP rute di RootNavigator punya keputusan izin (tidak ada yang lolos tanpa disadari)', () => {
    expect(ruteTerdaftar.length).toBeGreaterThan(100);
    const belum = ruteTerdaftar.filter((r) => syaratRute(r) === undefined);
    expect(belum).toEqual([]);
  });

  it('setiap syarat memakai resource & aksi yang sah', () => {
    const aksiSah = ['view', 'create', 'edit', 'approve', 'export'];
    for (const [rute, syarat] of Object.entries(IZIN_RUTE)) {
      if (syarat === null) continue;
      expect([rute, (RESOURCES as readonly string[]).includes(syarat.resource)]).toEqual([rute, true]);
      const daftar = Array.isArray(syarat.aksi) ? syarat.aksi : [syarat.aksi];
      for (const a of daftar) expect([rute, aksiSah.includes(a as string)]).toEqual([rute, true]);
    }
  });

  it('fail-closed: rute tak terdaftar ditutup; izin belum dimuat menutup rute bersyarat', () => {
    expect(bolehBukaRute('RuteYangTidakAda', izinDefault('ADMIN'))).toBe(false);
    expect(bolehBukaRute('LabaRugi', null)).toBe(false);
    expect(bolehBukaRute('Dashboard', null)).toBe(true);
    expect(bolehBukaRute('Keamanan', null)).toBe(true);
    expect(memenuhiSyarat(undefined, izinDefault('ADMIN'))).toBe(false);
  });

  it('Admin dapat membuka semua rute terdaftar', () => {
    for (const r of ruteTerdaftar) expect([r, bolehBukaRute(r, izinDefault('ADMIN'))]).toEqual([r, true]);
  });

  it('Anggota (bawaan): hanya lihat data anggota/simpanan/pinjaman/SHU — tanpa laporan, backup, user, form transaksi', () => {
    const iz = izinDefault('ANGGOTA');
    for (const r of ['AnggotaList', 'SimpananHistori', 'PinjamanList', 'Shu', 'Keamanan']) expect([r, bolehBukaRute(r, iz)]).toEqual([r, true]);
    for (const r of ['LabaRugi', 'NeracaSaldo', 'BackupRestore', 'ResetData', 'UserManagement', 'PermissionMatrix', 'SimpananForm', 'TarikSimpananForm', 'BayarAngsuranForm', 'AnggotaForm', 'KasBankTransaksiForm', 'AccountForm']) {
      expect([r, bolehBukaRute(r, iz)]).toEqual([r, false]);
    }
    expect(bolehLihatTab('Laporan', iz)).toBe(false);
    expect(bolehLihatTab('Transaksi', iz)).toBe(true);
    expect(bolehLihatTab('Dashboard', iz)).toBe(true);
    expect(bolehLihatTab('Pengaturan', iz)).toBe(true);
  });

  it('Petugas (bawaan): bisa input transaksi, tidak bisa kelola user/backup/akun', () => {
    const iz = izinDefault('PETUGAS');
    for (const r of ['SimpananForm', 'BayarAngsuranForm', 'KasBankTransaksiForm', 'LabaRugi', 'AnggotaForm']) expect([r, bolehBukaRute(r, iz)]).toEqual([r, true]);
    for (const r of ['UserManagement', 'UserForm', 'PermissionMatrix', 'BackupRestore', 'ResetData', 'AccountForm', 'TutupPeriode', 'PenghapusanPiutangForm']) {
      expect([r, bolehBukaRute(r, iz)]).toEqual([r, false]);
    }
  });

  it('form tambah/ubah: cukup SALAH SATU izin (create ATAU edit)', () => {
    const tanpa: PermissionSet = { canView: true, canCreate: false, canEdit: false, canApprove: false, canExport: false };
    const iz = { ...izinDefault('ANGGOTA'), anggota: tanpa };
    expect(bolehBukaRute('AnggotaForm', iz)).toBe(false);
    expect(bolehBukaRute('AnggotaForm', { ...iz, anggota: { ...tanpa, canEdit: true } })).toBe(true);
    expect(bolehBukaRute('AnggotaForm', { ...iz, anggota: { ...tanpa, canCreate: true } })).toBe(true);
  });

  it('ruteDariAksi menangkap tujuan menu tanpa menavigasi sungguhan', () => {
    expect(ruteDariAksi((n) => n.navigate('Transaksi', { screen: 'SimpananForm', initial: false }))).toBe('SimpananForm');
    expect(ruteDariAksi((n) => n.navigate('LabaRugi'))).toBe('LabaRugi');
    expect(ruteDariAksi((n) => n.push('ShuForm'))).toBe('ShuForm');
    expect(ruteDariAksi(() => undefined)).toBeNull();
    expect(
      ruteDariAksi(() => {
        throw new Error('x');
      })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('RC-S132 §B — aturan Permission Matrix (murni)', () => {
  const K: PermissionSet = { canView: false, canCreate: false, canEdit: false, canApprove: false, canExport: false };

  it('aksi apa pun menyiratkan Lihat; mematikan Lihat menutup modul', () => {
    expect(normalisasiIzin({ ...K, canCreate: true }).canView).toBe(true);
    expect(normalisasiIzin({ ...K, canExport: true }).canView).toBe(true);
    expect(normalisasiIzin(K)).toEqual(K);
    expect(terapkanKlikIzin(K, 'canEdit')).toEqual({ ...K, canView: true, canEdit: true });
    expect(terapkanKlikIzin({ ...K, canView: true, canCreate: true, canEdit: true }, 'canView')).toEqual(K);
    expect(terapkanKlikIzin({ ...K, canView: true, canCreate: true }, 'canCreate')).toEqual({ ...K, canView: true });
    expect(terapkanKlikIzin(K, 'canView')).toEqual({ ...K, canView: true });
  });

  it('matrix bawaan sudah konsisten dengan aturan tsb', () => {
    for (const role of ROLES) for (const r of RESOURCES) {
      const p = DEFAULT_ROLE_PERMISSIONS[role][r];
      expect([role, r, normalisasiIzin(p)]).toEqual([role, r, p]);
    }
  });
});

// ---------------------------------------------------------------------------
const now = () => new Date().toISOString();
const SALT_ADMIN = 'aa00aa00aa00aa00aa00aa00aa00aa00';
const SALT_PW = 'bb11bb11bb11bb11bb11bb11bb11bb11';

async function seedAdmin() {
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, pin_hash_versi,
       password_hash, password_salt, password_hash_versi, biometric_enabled, aktif, created_at, updated_at)
     VALUES ('admin-1','Admin','admin','ADMIN',?,?,2,?,?,2,0,1,?,?)`,
    hashPinV2('246810', SALT_ADMIN), SALT_ADMIN, hashPinV2('rahasiaAdmin1', SALT_PW), SALT_PW, now(), now()
  );
}

async function seedAnggota(id: string, nama: string, status = 'AKTIF') {
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    id, `A-${id}`, nama, '2024-01-01', status, now(), now()
  );
}

describe('RC-S132 §C — Permission Matrix di service (SQLite asli)', () => {
  beforeEach(async () => {
    ss.__clear();
    testDb = await createTestDb();
    await seedAdmin();
  });

  it('izin role Admin TIDAK dapat diubah lewat service (bukan hanya chip UI yang dikunci)', async () => {
    await expect(
      updateRolePermission('admin-1', 'ADMIN', 'user_management', { canView: false, canCreate: false, canEdit: false, canApprove: false, canExport: false })
    ).rejects.toThrow(IzinAdminTerkunciError);
    await expect(pulihkanIzinDefaultRole('admin-1', 'ADMIN')).rejects.toThrow(IzinAdminTerkunciError);
    expect((await getPermissionsForRole('ADMIN')).user_management.canEdit).toBe(true);
  });

  it('perubahan disimpan ternormalisasi, berlaku langsung, dan tercatat di audit log', async () => {
    await updateRolePermission('admin-1', 'PETUGAS', 'backup', { canView: false, canCreate: false, canEdit: false, canApprove: true, canExport: false });
    const p = (await getPermissionsForRole('PETUGAS')).backup;
    expect(p).toEqual({ canView: true, canCreate: false, canEdit: false, canApprove: true, canExport: false });
    expect(bolehBukaRute('ResetData', await getPermissionsForRole('PETUGAS'))).toBe(true);
    const audit = await testDb.getFirstAsync<any>(`SELECT * FROM audit_log WHERE action = 'UPDATE_PERMISSION' AND entity_id = 'PETUGAS:backup'`);
    expect(audit).toBeTruthy();
    expect(audit.user_id).toBe('admin-1');
  });

  it('Pulihkan bawaan mengembalikan seluruh izin satu role', async () => {
    await updateRolePermission('admin-1', 'PENGURUS', 'laporan', { canView: false, canCreate: false, canEdit: false, canApprove: false, canExport: false });
    await updateRolePermission('admin-1', 'PENGURUS', 'anggota', { canView: true, canCreate: true, canEdit: true, canApprove: true, canExport: true });
    await pulihkanIzinDefaultRole('admin-1', 'PENGURUS');
    expect(await getPermissionsForRole('PENGURUS')).toEqual(DEFAULT_ROLE_PERMISSIONS.PENGURUS);
  });

  it('non-Admin tidak dapat memulihkan/mengubah matrix', async () => {
    const { id } = await createUser('admin-1', { nama: 'Budi', username: 'budi', role: 'PETUGAS' as Role, password: 'rahasiaBudi9' });
    await expect(pulihkanIzinDefaultRole(id, 'ANGGOTA')).rejects.toThrow();
    await expect(
      updateRolePermission(id, 'ANGGOTA', 'laporan', { canView: true, canCreate: false, canEdit: false, canApprove: false, canExport: false })
    ).rejects.toThrow();
    expect(await hasPermission(id, 'user_management', 'view')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('RC-S132 §D — akun Anggota ditautkan ke data anggota (migrasi v80)', () => {
  beforeEach(async () => {
    ss.__clear();
    testDb = await createTestDb();
    await seedAdmin();
    await seedAnggota('ang-1', 'Siti Aminah');
    await seedAnggota('ang-2', 'Joko Susilo');
    await seedAnggota('ang-k', 'Pak Keluar', 'KELUAR');
  });

  it('skema v80: kolom app_user.anggota_id + indeks unik parsial', async () => {
    expect(SCHEMA_VERSION).toBe(82); // DIPERBARUI v82 (RC-S133.6.4: enam kolom pinjaman.penyelesaian_* untuk pencatatan penyelesaian Pengadilan/asuransi, aditif; migrasi milik RC-S133.6.4 — invarian test ini TIDAK berubah). DIPERBARUI v81 (RC-S133.6.2: tabel import_data_awal_sidik & koreksi_transaksi + 2 kolom riwayat import, aditif; migrasi milik RC-S133.6.2 — invarian test ini TIDAK berubah).
    const kolom = await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(app_user)`);
    expect(kolom.map((k) => k.name)).toContain('anggota_id');
    const idx = await testDb.getFirstAsync<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'idx_app_user_anggota'`);
    expect(idx?.sql).toMatch(/UNIQUE INDEX/);
    expect(idx?.sql).toMatch(/WHERE anggota_id IS NOT NULL/);
  });

  it('migrasiV80 menambah kolom pada instalasi lama, idempoten, data user utuh', async () => {
    // Bentuk ulang app_user seperti v79 (tanpa anggota_id).
    const asli = (await testDb.getFirstAsync<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type='table' AND name='app_user'`))!.sql;
    const lama = asli.replace(/,\s*(?:--[^\n]*\n\s*)*anggota_id TEXT REFERENCES anggota\(id\)/, '');
    expect(lama).not.toMatch(/anggota_id/);
    await testDb.execAsync(`PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;`);
    await testDb.execAsync(`DROP INDEX IF EXISTS idx_app_user_anggota;`);
    await testDb.execAsync(`ALTER TABLE app_user RENAME TO app_user_v80;`);
    await testDb.execAsync(lama + ';');
    const kolomLama = (await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(app_user)`)).map((k) => k.name);
    await testDb.execAsync(`INSERT INTO app_user (${kolomLama.join(',')}) SELECT ${kolomLama.join(',')} FROM app_user_v80; DROP TABLE app_user_v80;`);
    await testDb.execAsync(`PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;`);
    expect(kolomLama).not.toContain('anggota_id');

    await migrasiV80(testDb as never);
    await migrasiV80(testDb as never);
    const kolomBaru = (await testDb.getAllAsync<{ name: string }>(`PRAGMA table_info(app_user)`)).map((k) => k.name);
    expect(kolomBaru).toContain('anggota_id');
    expect((await testDb.getFirstAsync<any>(`SELECT username, anggota_id FROM app_user WHERE id='admin-1'`))).toEqual({ username: 'admin', anggota_id: null });
    expect(await testDb.getFirstAsync(`SELECT name FROM sqlite_master WHERE name = 'idx_app_user_anggota'`)).toBeTruthy();
  });

  it('akun Anggota WAJIB memilih anggota; nama akun mengikuti nama anggota', async () => {
    await expect(createUser('admin-1', { nama: '', username: 'siti', role: 'ANGGOTA' as Role, password: 'rahasiaSiti9' })).rejects.toThrow(/Pilih anggota/);
    const { id } = await createUser('admin-1', { nama: 'nama diketik', username: 'siti', role: 'ANGGOTA' as Role, password: 'rahasiaSiti9', anggotaId: 'ang-1' });
    const row = await testDb.getFirstAsync<any>(`SELECT nama, anggota_id FROM app_user WHERE id = ?`, id);
    expect(row).toEqual({ nama: 'Siti Aminah', anggota_id: 'ang-1' });
    const item = (await listUsers('admin-1')).find((u) => u.id === id)!;
    expect(item.anggotaId).toBe('ang-1');
    expect(item.nomorAnggota).toBe('A-ang-1');
  });

  it('satu anggota satu akun; anggota keluar ditolak; role non-Anggota tidak menautkan', async () => {
    await createUser('admin-1', { nama: '', username: 'siti', role: 'ANGGOTA' as Role, password: 'rahasiaSiti9', anggotaId: 'ang-1' });
    await expect(
      createUser('admin-1', { nama: '', username: 'siti2', role: 'ANGGOTA' as Role, password: 'rahasiaSiti9', anggotaId: 'ang-1' })
    ).rejects.toThrow(/sudah memiliki akun "siti"/);
    await expect(
      createUser('admin-1', { nama: '', username: 'pak', role: 'ANGGOTA' as Role, password: 'rahasiaPak99', anggotaId: 'ang-k' })
    ).rejects.toThrow(/keluar atau meninggal/);
    const { id } = await createUser('admin-1', { nama: 'Petugas A', username: 'petugas', role: 'PETUGAS' as Role, password: 'rahasiaPet9', anggotaId: 'ang-2' });
    expect((await testDb.getFirstAsync<any>(`SELECT anggota_id FROM app_user WHERE id = ?`, id)).anggota_id).toBeNull();
  });

  it('sunting akun Anggota: ganti anggota ikut mengganti nama; ganti role melepas tautan', async () => {
    const { id } = await createUser('admin-1', { nama: '', username: 'siti', role: 'ANGGOTA' as Role, password: 'rahasiaSiti9', anggotaId: 'ang-1' });
    await updateUser('admin-1', id, { nama: 'x', username: 'siti', role: 'ANGGOTA' as Role, anggotaId: 'ang-2' });
    expect(await testDb.getFirstAsync<any>(`SELECT nama, anggota_id FROM app_user WHERE id = ?`, id)).toEqual({ nama: 'Joko Susilo', anggota_id: 'ang-2' });
    await updateUserRole('admin-1', id, 'PETUGAS' as Role);
    expect((await testDb.getFirstAsync<any>(`SELECT anggota_id FROM app_user WHERE id = ?`, id)).anggota_id).toBeNull();
    // Menjadikan akun Anggota lewat dialog role saja ditolak: anggotanya harus dipilih di form.
    await expect(updateUserRole('admin-1', id, 'ANGGOTA' as Role)).rejects.toThrow();
  });

  it('anggota yang punya akun tidak dapat dihapus; Hapus Data Transaksi melepas tautan tanpa referensi menggantung', async () => {
    await createUser('admin-1', { nama: '', username: 'siti', role: 'ANGGOTA' as Role, password: 'rahasiaSiti9', anggotaId: 'ang-1' });
    await expect(deleteAnggota('admin-1', 'ang-1')).rejects.toThrow(/siti/);
    expect(await testDb.getFirstAsync(`SELECT id FROM anggota WHERE id = 'ang-1'`)).toBeTruthy();

    await testDb.execAsync(`PRAGMA foreign_keys = ON;`);
    await resetDataTransaksiPadaDb(testDb as never);
    expect(await testDb.getFirstAsync<any>(`SELECT username, anggota_id FROM app_user WHERE username = 'siti'`)).toEqual({ username: 'siti', anggota_id: null });
    expect((await testDb.getFirstAsync<any>(`SELECT COUNT(*) AS n FROM anggota`)).n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('RC-S132 §E — Keluar & Login', () => {
  beforeEach(async () => {
    ss.__clear();
    testDb = await createTestDb();
    await seedAdmin();
  });

  it('Keluar menandai "keluar manual" (tidak auto-masuk tanpa PIN); Login menghapus tanda & mengingat username', async () => {
    expect(await apakahKeluarManual()).toBe(false);
    await login('admin', 'rahasiaAdmin1');
    await logout();
    expect(ss.__dump()[KUNCI_KELUAR_MANUAL]).toBe('1');
    expect(await apakahKeluarManual()).toBe(true);

    await login('admin', 'rahasiaAdmin1');
    expect(await apakahKeluarManual()).toBe(false);
    expect(await getUsernameTerakhir()).toBe('admin');
  });

  it('akun Anggota masuk dengan password dari User Management; izin sesi = baris role ANGGOTA', async () => {
    await seedAnggota('ang-1', 'Siti Aminah');
    await createUser('admin-1', { nama: '', username: 'siti', role: 'ANGGOTA' as Role, password: 'rahasiaSiti9', anggotaId: 'ang-1' });
    const u = await login('siti', 'rahasiaSiti9');
    expect(u.role).toBe('ANGGOTA');
    const iz = await getPermissionsForRole(u.role);
    expect(bolehBukaRute('SimpananHistori', iz)).toBe(true);
    expect(bolehBukaRute('LabaRugi', iz)).toBe(false);
    await expect(login('siti', 'salahPassword1')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('RC-S132 §F — struktur layar', () => {
  it('Pengaturan: kartu akun + tombol Keluar dengan konfirmasi, lalu sesi dibersihkan', () => {
    const p = tanpaKomentar(baca('src/screens/Pengaturan/PengaturanScreen.tsx'));
    expect(p).toMatch(/accessibilityLabel="Keluar dari akun"/);
    const iKeluar = p.indexOf('const keluar');
    const blok = p.slice(iKeluar, iKeluar + 1600);
    expect(blok).toMatch(/notify\(/);
    expect(blok).toMatch(/style: 'destructive'/);
    expect(blok).toMatch(/await logout\(\)/);
    expect(blok).toMatch(/setPermissions\(null\)/);
    expect(blok).toMatch(/setCurrentUser\(null\)/);
  });

  it('startup: tanda keluar manual dicek SEBELUM sesi otomatis tanpa PIN', () => {
    const idx = tanpaKomentar(baca('app/index.tsx'));
    const iCek = idx.indexOf('await apakahKeluarManual()');
    const iAuto = idx.indexOf('await mulaiSesiTanpaPin()');
    expect(iCek).toBeGreaterThan(0);
    expect(iCek).toBeLessThan(iAuto);
  });

  it('Login: username diingat, password bisa ditampilkan, Enter mengirim', () => {
    const l = tanpaKomentar(baca('src/screens/Setup/LoginScreen.tsx'));
    expect(l).toMatch(/getUsernameTerakhir\(\)/);
    expect(l).toMatch(/secureTextEntry=\{!lihatPassword\}/);
    expect(l).toMatch(/onSubmitEditing/);
    expect(l).toMatch(/login\(username\.trim\(\), password\)/);
  });

  it('Form user: role dipilih dulu; role Anggota memakai pemilih anggota, bukan ketik Nama Lengkap', () => {
    const f = tanpaKomentar(baca('src/screens/Pengaturan/UserFormScreen.tsx'));
    expect(f).toMatch(/<AnggotaPicker/);
    expect(f).toMatch(/peranAnggota \?/);
    expect(f).toMatch(/anggotaId: peranAnggota \? anggota\?\.id : null/);
    expect(f.indexOf('judul="Hak akses"')).toBeLessThan(f.indexOf('<AnggotaPicker'));
  });

  it('gerbang izin terpasang di keempat stack, tab disaring, hub & Dashboard menyaring menu', () => {
    const nav = tanpaKomentar(baca('src/navigation/RootNavigator.tsx'));
    expect((nav.match(/screenLayout=\{tataLetakBerizin\}/g) ?? []).length).toBe(4);
    expect(nav).toMatch(/bolehLihatTab\(/);
    for (const f of [
      'src/screens/Transaksi/TransaksiPenerimaanScreen.tsx',
      'src/screens/Transaksi/TransaksiPengeluaranScreen.tsx',
      'src/screens/Laporan/LaporanScreen.tsx',
      'src/screens/Dashboard/DashboardScreen.tsx',
    ]) {
      expect([f, /bolehBukaRute\(/.test(baca(f))]).toEqual([f, true]);
    }
  });

  it('layar Permission Matrix: label bersama, aturan klik dari service, cache izin sesi disegarkan', () => {
    const m = tanpaKomentar(baca('src/screens/Pengaturan/PermissionMatrixScreen.tsx'));
    expect(m).not.toMatch(/const RESOURCE_LABEL/);
    expect(m).toMatch(/RESOURCE_KETERANGAN\[resource\]/);
    expect(m).toMatch(/terapkanKlikIzin\(baris\.permission, aksi\)/);
    expect(m).toMatch(/setPermissions\(await getPermissionsForRole\(role\)\)/);
    expect(m).toMatch(/pulihkanIzinDefaultRole\(/);
  });
});

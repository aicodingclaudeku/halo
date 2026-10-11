import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createTestDb, TestDb } from './testDb';
import * as SecureStoreMock from '../test-utils/expoSecureStoreMock';

/**
 * RC-S133.5 — (1) fitur Claude dihapus, (2) sinkron HP manual: hubungkan
 * dulu lalu pilih arah kirim, (3) akun Anggota hanya melihat data dirinya
 * sendiri, (4) hapus user, (5) buat akun semua anggota (acak / sama) +
 * wajib ganti password.
 *
 * Integrasi memakai SQLite (node:sqlite) + scrypt @noble/hashes ASLI.
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

import {
  apakahWajibGantiPassword,
  buatAkunAnggotaMassal,
  buatPasswordAcak,
  createUser,
  daftarCalonAkunAnggota,
  gantiPasswordSendiri,
  hapusUser,
  listUsers,
  PREFIX_USERNAME_DIHAPUS,
  usernameDariNomor,
} from '@/services/UserManagementService';
import { login, getUserById } from '@/services/AuthService';
import { muatDataSaya, anggotaIdMilikAkun, BukanAkunAnggotaError } from '@/services/PortalAnggotaService';
import { updateRolePermission, pulihkanIzinDefaultRole, IzinAnggotaTetapError } from '@/services/PermissionService';
import { IZIN_RUTE } from '@/navigation/izinRute';
import { hashPinV2 } from '@/security/pinHash';
import { periksaPassword } from '@/security/kebijakanPassword';
import { periksaUsername } from '@/security/kebijakanUsername';
import { modeHpBacaSajaAktif, MODE_HP_BACA_SAJA } from '@/sync/SyncModeBacaSaja';
import { MODE_SINKRON_MANUAL, pasangInfrastrukturSinkron } from '@/sync/SyncSchema';

const ROOT = join(__dirname, '..', '..');
const baca = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const ada = (rel: string) => existsSync(join(ROOT, rel));
const tanpaKomentar = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ss = SecureStoreMock as unknown as { __clear(): void };
const now = () => new Date().toISOString();

async function seedAdmin(id = 'admin-1', username = 'admin') {
  await testDb.runAsync(
    `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, pin_hash_versi,
       password_hash, password_salt, password_hash_versi, biometric_enabled, aktif, created_at, updated_at)
     VALUES (?,?,?,'ADMIN',?,?,2,?,?,2,0,1,?,?)`,
    id, `Admin ${id}`, username, hashPinV2('246810', 's1'), 's1', hashPinV2('rahasiaAdmin1', 's2'), 's2', now(), now()
  );
}
async function seedAnggota(id: string, nomor: string, nama: string, status = 'AKTIF') {
  await testDb.runAsync(
    `INSERT INTO anggota (id, nomor_anggota, nama_lengkap, tanggal_bergabung, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
    id, nomor, nama, '2024-01-01', status, now(), now()
  );
}
async function seedSimpanan(id: string, anggotaId: string, jenis: string, nominal: number) {
  await testDb.runAsync(
    `INSERT INTO simpanan_transaksi (id, anggota_id, jenis, tipe, tanggal, nominal, sumber_dana, nomor_transaksi, created_by, created_at)
     VALUES (?,?,?,'SETOR','2026-01-05',?,'KAS',?,'admin-1',?)`,
    id, anggotaId, jenis, nominal, `NT-${id}`, now()
  );
}
async function seedPinjaman(id: string, anggotaId: string, pokok: number) {
  await testDb.runAsync(
    `INSERT INTO pinjaman
      (id, nomor_pinjaman, anggota_id, tanggal, jumlah_pinjaman, tenor, satuan_tenor, metode_jasa,
       persentase_jasa, biaya_admin_tipe, biaya_admin_nilai, denda_aktif, denda_nilai,
       tanggal_jatuh_tempo, status, created_by, created_at, updated_at)
     VALUES (?,?,?,'2026-01-01',?,2,'BULAN','FLAT',1,'TIDAK_ADA',0,0,0,'2026-03-01','AKTIF','admin-1',?,?)`,
    id, `PJ-${id}`, anggotaId, pokok, now(), now()
  );
  for (const n of [1, 2]) {
    await testDb.runAsync(
      `INSERT INTO angsuran_jadwal (id, pinjaman_id, nomor_angsuran, tanggal_jatuh_tempo, pokok, jasa, denda, total, status)
       VALUES (?,?,?,?,?,?,0,?, 'BELUM_BAYAR')`,
      `${id}-j${n}`, id, n, `2026-0${n + 1}-01`, pokok / 2, 1000, pokok / 2 + 1000
    );
  }
}

// ---------------------------------------------------------------------------
describe('RC-S133.5 §1 — fitur Claude dihapus', () => {
  it('berkas Claude tidak ada lagi', () => {
    for (const f of [
      'src/services/ClaudeService.ts',
      'src/services/RingkasanDashboardService.ts',
      'src/screens/Pengaturan/AsistenClaudeScreen.tsx',
      'src/components/asisten/KonektorClaudeDesktop.tsx',
    ]) {
      expect([f, ada(f)]).toEqual([f, false]);
    }
  });

  it('tidak ada rute, izin, menu, katalog, maupun tipe jembatan Claude', () => {
    expect('AsistenClaude' in IZIN_RUTE).toBe(false);
    for (const f of [
      'src/navigation/RootNavigator.tsx',
      'src/navigation/izinRute.ts',
      'src/screens/Pengaturan/PengaturanScreen.tsx',
      'src/desktop/katalogMenu.ts',
      'src/desktop/bridge.ts',
    ]) {
      const s = tanpaKomentar(baca(f));
      expect([f, /claude|anthropic|AsistenClaude|StatusKonektorMcp|\bmcp\?/i.test(s)]).toEqual([f, false]);
    }
  });

  it('perbaikan Dashboard RC-S133.4.8 (Piutang Berjalan = sisa pokok) TETAP ada di HP & desktop', () => {
    // Fragmen dipindah dari AsistenClaudeRcS133_4_8.test.ts (dihapus bersama fiturnya).
    const fragmen = [
      "SELECT COUNT(*) as cnt FROM anggota WHERE status = 'AKTIF'",
      'SUM(aj.pokok - aj.pokok_terbayar)',
      'SUM(aj.jasa - aj.jasa_terbayar)',
    ];
    for (const f of ['src/screens/Dashboard/DashboardScreen.tsx', 'src/screens/Dashboard/DashboardScreen.web.tsx']) {
      const d = baca(f);
      for (const x of fragmen) expect([f, x, d.includes(x)]).toEqual([f, x, true]);
      expect(d).toMatch(/piutangPokok/);
    }
  });
});

// ---------------------------------------------------------------------------
describe('RC-S133.5 §2 — sinkron manual: hubungkan dulu, lalu pilih arah kirim', () => {
  beforeEach(async () => {
    ss.__clear();
    testDb = await createTestDb();
  });

  it('HP tidak lagi menjadi cadangan baca-saja', () => {
    expect(MODE_HP_BACA_SAJA).toBe(false);
    expect(modeHpBacaSajaAktif()).toBe(false);
  });

  it('infrastruktur sinkron manual: tabel ada, TANPA trigger changelog (changelog tidak membesar)', async () => {
    expect(MODE_SINKRON_MANUAL).toBe(true);
    await pasangInfrastrukturSinkron(testDb as never);
    const tabel = (await testDb.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sync_%'`)).map((r) => r.name);
    expect(tabel).toEqual(expect.arrayContaining(['sync_meta', 'sync_changelog', 'sync_peer', 'sync_riwayat']));
    const trig = await testDb.getAllAsync(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync_a%'`);
    expect(trig).toEqual([]);
    await seedAnggota('a1', 'A001', 'Budi');
    expect((await testDb.getFirstAsync<any>('SELECT COUNT(*) AS n FROM sync_changelog')).n).toBe(0);
  });

  it('trigger changelog lama (mode RC-S133.4) dibuang saat infrastruktur dipasang ulang', async () => {
    await testDb.execAsync(`CREATE TABLE IF NOT EXISTS sync_changelog (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, pk TEXT NOT NULL, pk_lama TEXT, op TEXT NOT NULL, data TEXT, ts TEXT);
      CREATE TRIGGER sync_ai_anggota AFTER INSERT ON anggota BEGIN INSERT INTO sync_changelog (tbl, pk, op) VALUES ('anggota', NEW.id, 'U'); END;`);
    await seedAnggota('a1', 'A001', 'Budi');
    await pasangInfrastrukturSinkron(testDb as never);
    expect(await testDb.getAllAsync(`SELECT name FROM sqlite_master WHERE type='trigger' AND name = 'sync_ai_anggota'`)).toEqual([]);
    expect((await testDb.getFirstAsync<any>('SELECT COUNT(*) AS n FROM sync_changelog')).n).toBe(0);
  });

  it('memindai QR hanya menghubungkan; kirim/ambil data memakai alasan MANUAL; permintaan desktop ditanyakan di HP', () => {
    const k = tanpaKomentar(baca('src/sync/SyncKlien.ts'));
    const pasang = k.slice(k.indexOf('export async function pasangDenganKode'), k.indexOf('export async function pasangSebagaiCadangan'));
    expect(pasang).not.toMatch(/ambilDataDesktop|kirimDataHp|pasangModeBacaSaja/);
    expect(pasang).toMatch(/pastikanModeManual\(\)/);
    expect(k).toMatch(/export async function cekPermintaanDesktop/);
    expect(k).toMatch(/kirimOp\('TOLAK_PERMINTAAN'/);
    const panelHp = tanpaKomentar(baca('src/components/sinkron/PanelSinkronHp.tsx'));
    expect(panelHp).toMatch(/pasangDenganKode\(teks\)/);
    expect(panelHp).not.toMatch(/pasangSebagaiCadangan|sinkronkanSekarang/);
    expect(panelHp).toMatch(/kirimDataHp\('MANUAL'\)/);
    expect(panelHp).toMatch(/ambilDataDesktop\('MANUAL'\)/);
    expect(panelHp).toMatch(/Kirim data HP → PC/);
    expect(panelHp).toMatch(/Ambil data PC → HP/);
    const agen = tanpaKomentar(baca('src/desktop/AgenSinkron.tsx'));
    expect(agen).not.toMatch(/sinkronkanSekarang/);
    expect(agen).toMatch(/cekPermintaanDesktop\(\)/);
    expect(agen).toMatch(/notify\(/);
  });

  it('desktop: langkah 2 berisi "Kirim data PC → HP" & "Minta data HP → PC" lewat permintaan (setKeputusan)', () => {
    const d = tanpaKomentar(baca('src/components/sinkron/PanelSinkronDesktop.tsx'));
    expect(d).toMatch(/<KartuKirimData/);
    expect(d).toMatch(/Kirim data PC → HP/);
    expect(d).toMatch(/Minta data HP → PC/);
    expect(d).toMatch(/setKeputusan\(k\)/);
    expect(d).toMatch(/setKeputusan\(null\)/);
    expect(d).not.toMatch(/buku induk|penyimpanan cadangan/i);
    const srv = tanpaKomentar(baca('src/sync/SyncServer.ts'));
    expect(srv).toMatch(/case 'TOLAK_PERMINTAAN'/);
    expect(srv).not.toMatch(/setStatus\('PERLU_DATA_AWAL'/);
  });
});

// ---------------------------------------------------------------------------
describe('RC-S133.5 §3 — akun Anggota hanya melihat data dirinya sendiri', () => {
  beforeEach(async () => {
    ss.__clear();
    testDb = await createTestDb();
    await seedAdmin();
    await seedAnggota('ang-1', 'A001', 'Siti Aminah');
    await seedAnggota('ang-2', 'A002', 'Joko Susilo');
    await seedSimpanan('s1', 'ang-1', 'POKOK', 100000);
    await seedSimpanan('s2', 'ang-1', 'WAJIB', 50000);
    await seedSimpanan('s3', 'ang-2', 'POKOK', 999000);
    await seedPinjaman('p1', 'ang-1', 2000000);
    await seedPinjaman('p2', 'ang-2', 7000000);
  });

  it('data portal = data anggota yang ditautkan, tidak pernah anggota lain', async () => {
    const { id } = await createUser('admin-1', { nama: '', username: 'siti', role: 'ANGGOTA', password: 'rahasiaSiti1', anggotaId: 'ang-1' });
    expect(await anggotaIdMilikAkun(id)).toBe('ang-1');
    const d = await muatDataSaya(id);
    expect(d.anggota).toMatchObject({ id: 'ang-1', nomorAnggota: 'A001', namaLengkap: 'Siti Aminah' });
    expect(d.simpanan).toEqual({ pokok: 100000, wajib: 50000, sukarela: 0, total: 150000 });
    expect(d.pinjaman.map((p) => p.id)).toEqual(['p1']);
    expect(d.pinjaman[0].jadwal.map((j) => j.nomorAngsuran)).toEqual([1, 2]);
    expect(d.ringkasanPinjaman.sisaPokok).toBe(2000000);
    expect(JSON.stringify(d)).not.toMatch(/ang-2|Joko|p2|999000|7000000/);
  });

  it('gagal tertutup: akun bukan Anggota, belum ditautkan, atau nonaktif ditolak', async () => {
    await expect(muatDataSaya('admin-1')).rejects.toThrow(BukanAkunAnggotaError);
    await testDb.runAsync(
      `INSERT INTO app_user (id, nama, username, role, pin_hash, pin_salt, password_hash, password_salt, aktif, created_at, updated_at)
       VALUES ('u-x','X','x-lepas','ANGGOTA','h','s','h','s',1,?,?)`,
      now(), now()
    );
    await expect(muatDataSaya('u-x')).rejects.toThrow(/tidak terhubung/);
    const { id } = await createUser('admin-1', { nama: '', username: 'joko', role: 'ANGGOTA', password: 'rahasiaJoko1', anggotaId: 'ang-2' });
    await testDb.runAsync(`UPDATE app_user SET aktif = 0 WHERE id = ?`, id);
    await expect(muatDataSaya(id)).rejects.toThrow(/tidak aktif/);
  });

  it('startup: akun Anggota masuk ke Portal Anggota, navigator koperasi tidak di-mount', () => {
    const idx = tanpaKomentar(baca('app/index.tsx'));
    expect(idx).toMatch(/user\.role === 'ANGGOTA'[\s\S]{0,200}setPhase\('PORTAL_ANGGOTA'\)/);
    expect(idx).toMatch(/phase === 'PORTAL_ANGGOTA'[\s\S]{0,120}<PortalAnggotaScreen/);
    // Portal memanggil service dengan id sesi, bukan anggotaId dari layar.
    const portal = tanpaKomentar(baca('src/screens/PortalAnggota/PortalAnggotaScreen.tsx'));
    expect(portal).toMatch(/muatDataSaya\(user\.id\)/);
    expect(portal).not.toMatch(/useRoute|navigation\.navigate/);
  });

  it('Permission Matrix: baris Anggota tetap (tidak bisa dibuka ke modul koperasi)', async () => {
    await expect(
      updateRolePermission('admin-1', 'ANGGOTA', 'laporan', { canView: true, canCreate: false, canEdit: false, canApprove: false, canExport: false })
    ).rejects.toThrow(IzinAnggotaTetapError);
    await expect(pulihkanIzinDefaultRole('admin-1', 'ANGGOTA')).rejects.toThrow(IzinAnggotaTetapError);
    const m = tanpaKomentar(baca('src/screens/Pengaturan/PermissionMatrixScreen.tsx'));
    expect(m).toMatch(/testID="matrix-anggota-data-sendiri"/);
    expect(m).toMatch(/roleTerpilih === 'ADMIN' \|\| peranAnggota/);
  });
});

// ---------------------------------------------------------------------------
describe('RC-S133.5 §4 — hapus user', () => {
  beforeEach(async () => {
    ss.__clear();
    testDb = await createTestDb();
    await seedAdmin();
    await seedAnggota('ang-1', 'A001', 'Siti Aminah');
  });

  it('akun hilang dari daftar, tidak bisa masuk, username & anggota bebas dipakai lagi, nama tetap untuk riwayat', async () => {
    const { id } = await createUser('admin-1', { nama: '', username: 'siti', role: 'ANGGOTA', password: 'rahasiaSiti1', anggotaId: 'ang-1' });
    await login('siti', 'rahasiaSiti1');
    await hapusUser('admin-1', id);
    expect((await listUsers('admin-1')).map((u) => u.id)).not.toContain(id);
    await expect(login('siti', 'rahasiaSiti1')).rejects.toThrow();
    const nisan = await testDb.getFirstAsync<any>(`SELECT * FROM app_user WHERE id = ?`, id);
    expect(nisan.nama).toBe('Siti Aminah');
    expect(nisan.aktif).toBe(0);
    expect(nisan.anggota_id).toBeNull();
    expect(nisan.username.startsWith(PREFIX_USERNAME_DIHAPUS)).toBe(true);
    expect(periksaUsername(nisan.username).sah).toBe(false); // tidak dapat diketik di Login
    // username & anggota dapat dipakai lagi
    await createUser('admin-1', { nama: '', username: 'siti', role: 'ANGGOTA', password: 'rahasiaSiti2', anggotaId: 'ang-1' });
    const audit = await testDb.getFirstAsync<any>(`SELECT * FROM audit_log WHERE action = 'DELETE' AND entity_id = ?`, id);
    expect(JSON.parse(audit.data_sesudah)).toMatchObject({ username: 'siti', nama: 'Siti Aminah' });
  });

  it('penjaga: bukan Admin, diri sendiri, Admin aktif terakhir', async () => {
    const { id: petugas } = await createUser('admin-1', { nama: 'Budi', username: 'budi', role: 'PETUGAS', password: 'rahasiaBudi9' });
    await expect(hapusUser(petugas, 'admin-1')).rejects.toThrow(/Hanya Admin/);
    await expect(hapusUser('admin-1', 'admin-1')).rejects.toThrow(/sedang dipakai/);
    const { id: admin2 } = await createUser('admin-1', { nama: 'Admin 2', username: 'admin2', role: 'ADMIN', password: 'rahasiaAdmin2' });
    await testDb.runAsync(`UPDATE app_user SET aktif = 0 WHERE id = 'admin-1'`);
    await testDb.runAsync(`UPDATE app_user SET aktif = 1 WHERE id = 'admin-1'`);
    await hapusUser('admin-1', admin2); // masih ada admin-1 aktif → boleh
    await expect(hapusUser('admin-1', admin2)).rejects.toThrow(/tidak ditemukan/);
  });
});

// ---------------------------------------------------------------------------
describe('RC-S133.5 §5 — buat akun semua anggota sekaligus', () => {
  beforeEach(async () => {
    ss.__clear();
    testDb = await createTestDb();
    await seedAdmin();
    await seedAnggota('ang-1', 'A001', 'Siti Aminah');
    await seedAnggota('ang-2', 'A-002', 'Joko Susilo');
    await seedAnggota('ang-3', '7', 'Rina');
    await seedAnggota('ang-k', 'A009', 'Pak Keluar', 'KELUAR');
  });

  it('calon = anggota aktif tanpa akun', async () => {
    await createUser('admin-1', { nama: '', username: 'siti', role: 'ANGGOTA', password: 'rahasiaSiti1', anggotaId: 'ang-1' });
    const ids = (await daftarCalonAkunAnggota('admin-1')).map((c) => c.anggotaId).sort();
    expect(ids).toEqual(['ang-2', 'ang-3']);
  });

  it('username = nomor anggota, password acak berbeda; semua bisa masuk & wajib ganti password', async () => {
    const progres: number[] = [];
    const hasil = await buatAkunAnggotaMassal('admin-1', { modeUsername: 'NOMOR_ANGGOTA', modePassword: 'ACAK' }, undefined, (s) => progres.push(s));
    expect(hasil.map((h) => h.username).sort()).toEqual(['a-002', 'a001', 'agt7']);
    expect(new Set(hasil.map((h) => h.password)).size).toBe(3);
    for (const h of hasil) {
      expect(periksaPassword({ password: h.password, username: h.username }).sah).toBe(true);
      const u = await login(h.username, h.password);
      expect(u.role).toBe('ANGGOTA');
      expect(await apakahWajibGantiPassword(u.id)).toBe(true);
      expect((await getUserById(u.id))?.anggotaId).toBe(h.anggotaId);
    }
    expect(progres).toEqual([1, 2, 3]);
    // password tidak tersimpan teks
    const rows = await testDb.getAllAsync<any>(`SELECT password_hash FROM app_user WHERE role = 'ANGGOTA'`);
    for (const r of rows) expect(hasil.map((h) => h.password)).not.toContain(r.password_hash);
    expect((await listUsers('admin-1')).filter((u) => u.wajibGantiPassword).length).toBe(3);
  });

  it('username acak + satu password sama untuk semua; tanpa wajib ganti bila dimatikan', async () => {
    const hasil = await buatAkunAnggotaMassal('admin-1', { modeUsername: 'ACAK', modePassword: 'SAMA', passwordSama: 'koperasi2026', wajibGanti: false });
    expect(hasil).toHaveLength(3);
    for (const h of hasil) {
      expect(h.username).toMatch(/^agt-[a-z2-9]{6}$/);
      expect(h.password).toBe('koperasi2026');
      const u = await login(h.username, 'koperasi2026');
      expect(await apakahWajibGantiPassword(u.id)).toBe(false);
    }
  });

  it('password sama yang lemah ditolak; username bentrok diberi akhiran; tidak dibuat dua kali', async () => {
    await expect(buatAkunAnggotaMassal('admin-1', { modeUsername: 'NOMOR_ANGGOTA', modePassword: 'SAMA', passwordSama: '12345678' })).rejects.toThrow(/angka/);
    expect(await testDb.getFirstAsync<any>(`SELECT COUNT(*) AS n FROM app_user WHERE role = 'ANGGOTA'`)).toEqual({ n: 0 });
    await createUser('admin-1', { nama: 'Petugas', username: 'agt7', role: 'PETUGAS', password: 'rahasiaPetugas1' });
    const hasil = await buatAkunAnggotaMassal('admin-1', { modeUsername: 'NOMOR_ANGGOTA', modePassword: 'ACAK' });
    expect(hasil.find((h) => h.anggotaId === 'ang-3')?.username).toBe('agt7-2');
    expect(await buatAkunAnggotaMassal('admin-1', { modeUsername: 'NOMOR_ANGGOTA', modePassword: 'ACAK' }).catch((e) => e.message)).toMatch(/sudah memiliki akun/);
  });

  it('hanya Admin', async () => {
    const { id } = await createUser('admin-1', { nama: 'Budi', username: 'budi', role: 'PETUGAS', password: 'rahasiaBudi9' });
    await expect(buatAkunAnggotaMassal(id, { modeUsername: 'ACAK', modePassword: 'ACAK' })).rejects.toThrow(/Hanya Admin/);
  });

  it('ganti password sendiri menghapus kewajiban; password lama salah / sama ditolak', async () => {
    const [h] = await buatAkunAnggotaMassal('admin-1', { modeUsername: 'NOMOR_ANGGOTA', modePassword: 'ACAK' }, ['ang-1']);
    await expect(gantiPasswordSendiri(h.userId, 'salahsalah1', 'barubaru123')).rejects.toThrow(/lama salah/);
    await expect(gantiPasswordSendiri(h.userId, h.password, h.password)).rejects.toThrow(/berbeda/);
    await gantiPasswordSendiri(h.userId, h.password, 'barubaru123');
    expect(await apakahWajibGantiPassword(h.userId)).toBe(false);
    await expect(login(h.username, h.password)).rejects.toThrow();
    await login(h.username, 'barubaru123');
  });

  it('fungsi bantu: username dari nomor & password acak', () => {
    expect(usernameDariNomor('A-0012')).toBe('a-0012');
    expect(usernameDariNomor('7')).toBe('agt7');
    expect(usernameDariNomor('No. 15/KSP')).toBe('no.15ksp');
    for (let i = 0; i < 50; i++) {
      const p = buatPasswordAcak();
      expect(p).toMatch(/^[a-km-np-z2-9]{10}$/);
      expect(periksaPassword({ password: p }).sah).toBe(true);
    }
  });

  it('startup: wajib ganti password dicek sebelum portal/aplikasi; layar & rute terdaftar', () => {
    const idx = tanpaKomentar(baca('app/index.tsx'));
    expect(idx.indexOf('apakahWajibGantiPassword(user.id)')).toBeGreaterThan(0);
    expect(idx.indexOf('apakahWajibGantiPassword(user.id)')).toBeLessThan(idx.indexOf("setPhase('PORTAL_ANGGOTA')"));
    expect(IZIN_RUTE.AkunAnggotaMassal).toEqual({ resource: 'user_management', aksi: 'create' });
    const um = tanpaKomentar(baca('src/screens/Pengaturan/UserManagementScreen.tsx'));
    expect(um).toMatch(/navigation\.navigate\('AkunAnggotaMassal'\)/);
    expect(um).toMatch(/hapusUser\(currentUser\.id, user\.id\)/);
    expect(um).toMatch(/\{akunSaya \? null : \(/);
  });
});

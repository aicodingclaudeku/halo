import { createTestDb, TestDb } from './testDb';

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

// security/pin.ts mengimpor 'expo-secure-store' (native module, tidak
// bisa di-transform Jest tanpa preset jest-expo — pola yang sama
// seperti FullMigration.test.ts memock 'expo-sqlite'). Di-mock minimal
// murni-fungsi supaya setupKoperasi() bisa diuji tanpa native binding.
jest.mock('@/security/pin', () => ({
  hashPin: jest.fn(async (pin: string, salt: string) => `hashed-${pin}-${salt}`),
  generateSalt: jest.fn(() => 'test-salt'),
}));

import { setupKoperasi, isSetupComplete, getActiveKoperasi } from '@/services/SetupService';

describe('SetupService.setupKoperasi', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  const input = {
    nama: 'Koperasi Uji Coba',
    tahunBuku: 2026,
    standarAkuntansi: 'SAK_EP' as const,
    adminNama: 'Admin Uji',
    adminUsername: 'admin-uji',
    adminPin: '123456',
  };

  test('setup pertama kali: koperasi, periode, COA, mapping, admin user semuanya tersimpan', async () => {
    expect(await isSetupComplete()).toBe(false);

    const { koperasiId, adminUserId } = await setupKoperasi(input);
    expect(koperasiId).toBeTruthy();
    expect(adminUserId).toBeTruthy();

    expect(await isSetupComplete()).toBe(true);
    const koperasi = await getActiveKoperasi();
    expect(koperasi?.nama).toBe('Koperasi Uji Coba');

    const akun = await testDb.getAllAsync<{ kode: string }>(`SELECT kode FROM account`);
    expect(akun.length).toBeGreaterThan(0);
    // Kas Kecil (1-1001) & Penyertaan pada Unit Usaha (1-1600) TIDAK
    // lagi dibuat pada instalasi baru (Phase 18 §4).
    expect(akun.find((a) => a.kode === '1-1001')).toBeUndefined();
    expect(akun.find((a) => a.kode === '1-1600')).toBeUndefined();
    // Akun baru Phase 18 §1/§3 ada sejak instalasi pertama.
    expect(akun.find((a) => a.kode === '1-1700')).toBeTruthy();
    expect(akun.find((a) => a.kode === '1-1800')).toBeTruthy();
    expect(akun.find((a) => a.kode === '2-1600')).toBeTruthy();
    expect(akun.find((a) => a.kode === '5-1310')).toBeTruthy();

    const mapping = await testDb.getAllAsync<{ transaction_type: string }>(`SELECT transaction_type FROM account_mapping`);
    expect(mapping.find((m) => m.transaction_type === 'KAS_KECIL')).toBeUndefined();
    expect(mapping.find((m) => m.transaction_type === 'INVESTASI_UNIT_USAHA')).toBeUndefined();
    expect(mapping.find((m) => m.transaction_type === 'RAK')).toBeTruthy();
  });

  test('update pasca-Phase 18/19 §N/§O: nama akun terbaru sejak instalasi pertama (bukan hasil rename migrasi)', async () => {
    await setupKoperasi(input);
    const akun = await testDb.getAllAsync<{ kode: string; nama: string }>(`SELECT kode, nama FROM account`);
    expect(akun.find((a) => a.kode === '3-3000')?.nama).toBe('Ekuitas Lainnya');
    expect(akun.find((a) => a.kode === '5-1050')?.nama).toBe('Beban Imbalan Kerja');
    expect(akun.find((a) => a.kode === '5-1900')?.nama).toBe('Beban Perkoperasian');
    // Akun baru §O.20 — kode diaudit dulu, 5-2200 belum dipakai.
    expect(akun.find((a) => a.kode === '5-2200')?.nama).toBe('Beban Pajak Penghasilan');
    expect(akun.find((a) => a.kode === '5-2200')?.nama).not.toBeUndefined();
  });

  test('Revisi KOPKU (Bagian 3A/3B): akun Pendapatan Hasil Investasi & Utang Pajak tersedia sejak instalasi pertama', async () => {
    await setupKoperasi(input);
    const akun = await testDb.getAllAsync<{ kode: string; nama: string; kategori: string; lhu_klasifikasi: string | null }>(
      `SELECT kode, nama, kategori, lhu_klasifikasi FROM account`
    );

    const hasilInvestasi = akun.find((a) => a.kode === '4-1300');
    expect(hasilInvestasi?.nama).toBe('Pendapatan Hasil Investasi');
    expect(hasilInvestasi?.kategori).toBe('PENDAPATAN');
    expect(hasilInvestasi?.lhu_klasifikasi).toBe('HASIL_INVESTASI');

    const utangPajak = akun.find((a) => a.kode === '2-1900');
    expect(utangPajak?.nama).toBe('Utang Pajak');
    expect(utangPajak?.kategori).toBe('LIABILITAS');

    // Beban Pajak Penghasilan (BEBAN) & Utang Pajak (LIABILITAS) harus
    // TERPISAH — bukan akun yang sama (Bagian 3B/4 audit ini).
    expect(utangPajak?.kode).not.toBe(akun.find((a) => a.nama === 'Beban Pajak Penghasilan')?.kode);

    // "Beban Usaha Lainnya" SENGAJA TIDAK dibuat sebagai akun baru —
    // "Beban Lainnya" (5-2000) sudah punya fungsi identik (kategori
    // BEBAN, lhuKlasifikasi BEBAN_USAHA). Lihat komentar di defaultCOA.ts.
    expect(akun.find((a) => a.nama === 'Beban Usaha Lainnya')).toBeUndefined();
    const bebanLainnya = akun.find((a) => a.kode === '5-2000');
    expect(bebanLainnya?.nama).toBe('Beban Lainnya');
    expect(bebanLainnya?.lhu_klasifikasi).toBe('BEBAN_USAHA');
  });

  test('setup pertama kali: master Kelompok Aset default (Phase 18 §14-19) langsung tersedia — TIDAK kosong lagi', async () => {
    await setupKoperasi(input);

    const semua = await testDb.getAllAsync<{ kelompok: string; sub_kelompok: string; masa_manfaat_bulan_default: number }>(
      `SELECT kelompok, sub_kelompok, masa_manfaat_bulan_default FROM aset_klasifikasi`
    );
    expect(semua.length).toBeGreaterThan(0);

    const kelompok = new Set(semua.map((s) => s.kelompok));
    // Audit ulang (permintaan pengguna §18): Kelompok 5 "Lainnya" ikut
    // tersedia sejak setup pertama kali (masa manfaat null/opsional).
    expect(kelompok).toEqual(new Set(['Kelompok 1', 'Kelompok 2', 'Kelompok 3', 'Kelompok 4', 'Kelompok 5']));

    const kelompok5 = semua.filter((s) => s.kelompok === 'Kelompok 5');
    expect(kelompok5).toHaveLength(1);
    expect(kelompok5[0].sub_kelompok).toBe('Lainnya');
    expect(kelompok5[0].masa_manfaat_bulan_default).toBeNull();

    const kelompok1 = semua.filter((s) => s.kelompok === 'Kelompok 1');
    expect(kelompok1).toHaveLength(11);
    expect(kelompok1.every((s) => s.masa_manfaat_bulan_default === 48)).toBe(true);

    const kelompok2 = semua.filter((s) => s.kelompok === 'Kelompok 2');
    expect(kelompok2).toHaveLength(11);
    expect(kelompok2.every((s) => s.masa_manfaat_bulan_default === 96)).toBe(true);

    const bangunanPermanen = semua.find((s) => s.sub_kelompok === 'Bangunan Permanen');
    expect(bangunanPermanen?.masa_manfaat_bulan_default).toBe(240);
    const bangunanTidakPermanen = semua.find((s) => s.sub_kelompok === 'Bangunan Tidak Permanen');
    expect(bangunanTidakPermanen?.masa_manfaat_bulan_default).toBe(120);
  });

  test('setup DITOLAK kalau sudah pernah diselesaikan sebelumnya', async () => {
    await setupKoperasi(input);
    await expect(setupKoperasi(input)).rejects.toThrow(/sudah pernah diselesaikan/);
  });
});

// ============================================================
// BUG FIX (dilaporkan pengguna via screenshot: "Gagal menyimpan setup
// — Call to function 'NativeStatement.finalizeAsync' has been
// rejected. Caused by: Error code [...]: UNIQUE constraint failed:
// account.kode"). Root cause: seeding COA/mapping/klasifikasi di
// setupKoperasi() sebelumnya TIDAK mengecek existence dulu (beda
// dengan pola self-heal di db.ts yang sudah benar) — begitu tabel
// `account`/`account_mapping`/`aset_klasifikasi` sudah ada isinya
// SEBELUM wizard ini dijalankan (mis. database lama/sisa pengujian
// terbawa, atau upaya submit setup sebelumnya sempat menulis sebagian
// data lalu gagal), INSERT akan menabrak UNIQUE constraint dan seluruh
// transaksi setup (termasuk baris koperasi yang baru dibuat) ikut
// batal — persis skenario yang direproduksi di bawah.
// ============================================================
describe('SetupService.setupKoperasi — idempoten terhadap data existing (bug fix UNIQUE constraint)', () => {
  beforeEach(async () => {
    testDb = await createTestDb();
  });

  const input = {
    nama: 'Koperasi Uji Coba',
    tahunBuku: 2026,
    standarAkuntansi: 'SAK_EP' as const,
    adminNama: 'Admin Uji',
    adminUsername: 'admin-uji',
    adminPin: '123456',
  };

  test('tabel account SUDAH berisi sebagian COA default (mis. dari self-heal migrasi sebelumnya) — setup TETAP BERHASIL, tidak UNIQUE constraint error', async () => {
    // Simulasikan kondisi yang memicu bug: satu akun dari DEFAULT_ACCOUNTS
    // ('1-1000' Kas) sudah ada di tabel SEBELUM setupKoperasi() dipanggil.
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-existing-kas','1-1000','Kas','ASET','DEBIT',1,1,?,?)`,
      now,
      now
    );

    await expect(setupKoperasi(input)).resolves.toHaveProperty('koperasiId');
    expect(await isSetupComplete()).toBe(true);

    // Tidak ada baris account.kode dobel untuk '1-1000'.
    const jumlahKas = await testDb.getFirstAsync<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM account WHERE kode = '1-1000'`);
    expect(jumlahKas?.cnt).toBe(1);

    // Akun EXISTING yang sudah ada sebelumnya (id lama) dipakai ulang
    // untuk mapping — bukan dibuat baris baru dengan id berbeda.
    const kasRow = await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM account WHERE kode = '1-1000'`);
    expect(kasRow?.id).toBe('acc-existing-kas');

    // Mapping yang butuh akun 1-1000 (mis. KAS_UMUM/DEFAULT) tetap
    // ter-seed dengan benar, menunjuk ke akun existing tsb.
    const mapping = await testDb.getFirstAsync<{ account_id: string }>(
      `SELECT account_id FROM account_mapping WHERE transaction_type = 'KAS_UMUM' AND role = 'DEFAULT'`
    );
    expect(mapping?.account_id).toBe('acc-existing-kas');
  });

  test('tabel account_mapping SUDAH berisi sebagian mapping — setup TETAP BERHASIL, tidak UNIQUE(transaction_type,role) error', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO account (id, kode, nama, kategori, normal_balance, is_active, is_system, created_at, updated_at)
       VALUES ('acc-existing-kas','1-1000','Kas','ASET','DEBIT',1,1,?,?)`,
      now,
      now
    );
    await testDb.runAsync(
      `INSERT INTO account_mapping (id, transaction_type, role, account_id) VALUES ('map-existing','KAS_UMUM','DEFAULT','acc-existing-kas')`
    );

    await expect(setupKoperasi(input)).resolves.toHaveProperty('koperasiId');

    const jumlahMapping = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM account_mapping WHERE transaction_type = 'KAS_UMUM' AND role = 'DEFAULT'`
    );
    expect(jumlahMapping?.cnt).toBe(1);
  });

  test('tabel aset_klasifikasi SUDAH berisi sebagian data — setup TETAP BERHASIL, tidak UNIQUE(kelompok,sub_kelompok) error', async () => {
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO aset_klasifikasi (id, kelompok, sub_kelompok, masa_manfaat_bulan_default, aktif, created_at, updated_at)
       VALUES ('kls-existing','Kelompok 1','Peralatan Kantor',48,1,?,?)`,
      now,
      now
    );

    await expect(setupKoperasi(input)).resolves.toHaveProperty('koperasiId');
    const jumlah = await testDb.getFirstAsync<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM aset_klasifikasi WHERE kelompok = 'Kelompok 1' AND sub_kelompok = 'Peralatan Kantor'`
    );
    expect(jumlah?.cnt).toBe(1);
  });
});

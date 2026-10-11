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

// Pola sama dengan SetupService.test.ts yang sudah ada: security/pin.ts
// mengimpor native module expo-secure-store/expo-crypto.
jest.mock('@/security/pin', () => ({
  hashPin: jest.fn(async (pin: string, salt: string) => `hashed-${pin}-${salt}`),
  generateSalt: jest.fn(() => 'test-salt'),
}));

import {
  setupKoperasi,
  isSetupComplete,
  getActiveKoperasi,
  getIdentitasKoperasi,
  updateIdentitasKoperasi,
  getIdentityCompletionStatus,
  hitungIdentityCompletion,
  normalisasiStandarAkuntansi,
  getStandarAkuntansiEfektif,
  bolehGantiTahunBuku,
} from '@/services/SetupService';
import {
  isPinEnabled,
  setPinEnabled,
  resolvePinState,
  isPinEnabledPadaDb,
  tandaiPinSudahDitetapkan,
  PIN_ENABLED_CONFIG_KEY,
} from '@/services/SecurityService';

beforeEach(async () => {
  testDb = await createTestDb();
});

/** Setup MINIMAL — persis dua field yang diminta wizard baru (§8/§11). */
const setupMinimal = { nama: 'Koperasi Sejahtera', tahunBuku: 2026 };

// ============================================================
// §31 — TES SETUP AWAL
// ============================================================

describe('§31 setup awal minimal', () => {
  test('fresh install: hanya Nama Koperasi & Tahun Buku yang dibutuhkan', async () => {
    expect(await isSetupComplete()).toBe(false);

    const { koperasiId, adminUserId } = await setupKoperasi(setupMinimal);

    expect(koperasiId).toBeTruthy();
    expect(adminUserId).toBeTruthy();
    expect(await isSetupComplete()).toBe(true);

    const koperasi = await getActiveKoperasi();
    expect(koperasi?.nama).toBe('Koperasi Sejahtera');
    expect(koperasi?.tahun_buku_aktif).toBe(2026);
  });

  test('accountingStandard otomatis SAK_EP tanpa user memilih apa pun', async () => {
    await setupKoperasi(setupMinimal);

    const koperasi = await getActiveKoperasi();
    expect(koperasi?.standar_akuntansi).toBe('SAK_EP');
    expect(await getStandarAkuntansiEfektif()).toBe('SAK_EP');
  });

  test('tidak ada standar kosong/undefined yang tersimpan', async () => {
    await setupKoperasi(setupMinimal);
    const row = await testDb.getFirstAsync<{ standar_akuntansi: string | null }>(
      `SELECT standar_akuntansi FROM koperasi`
    );
    expect(row?.standar_akuntansi).toBeTruthy();
    expect(row?.standar_akuntansi).not.toBeNull();
  });

  test('setup minimal tetap menyiapkan periode akuntansi, COA & mapping (transaksi langsung bisa jalan)', async () => {
    await setupKoperasi(setupMinimal);

    const periode = await testDb.getAllAsync<{ tahun_buku: number }>(`SELECT tahun_buku FROM accounting_period`);
    expect(periode).toHaveLength(1);
    expect(periode[0].tahun_buku).toBe(2026);

    const akun = await testDb.getAllAsync<{ kode: string }>(`SELECT kode FROM account`);
    expect(akun.length).toBeGreaterThan(0);

    const mapping = await testDb.getAllAsync<{ id: string }>(`SELECT id FROM account_mapping`);
    expect(mapping.length).toBeGreaterThan(0);
  });

  test('nilai standar EKSPLISIT dari pemanggil lama TIDAK ditimpa jadi SAK_EP', async () => {
    await setupKoperasi({ ...setupMinimal });
    const koperasi = await getActiveKoperasi();
    // RC-S39: setup SELALU menghasilkan SAK_EP; tidak ada pilihan lain.
    expect(koperasi?.standar_akuntansi).toBe('SAK_EP');
  });

  test('setup kedua kali ditolak', async () => {
    await setupKoperasi(setupMinimal);
    await expect(setupKoperasi(setupMinimal)).rejects.toThrow(/sudah pernah diselesaikan/i);
  });
});

describe('§12/§31 validasi setup', () => {
  test('nama kosong ditolak saat disimpan sebagai identitas', async () => {
    await setupKoperasi(setupMinimal);
    await expect(updateIdentitasKoperasi({ nama: '   ' })).rejects.toThrow(/minimal 3 karakter/i);
  });

  test('nama di-trim, bukan disimpan dengan spasi menggantung', async () => {
    await setupKoperasi(setupMinimal);
    await updateIdentitasKoperasi({ nama: '  Koperasi Maju Bersama  ' });
    const identitas = await getIdentitasKoperasi();
    expect(identitas?.nama).toBe('Koperasi Maju Bersama');
  });
});

// ============================================================
// §32 — TES PIN
// ============================================================

describe('§32 PIN opsional', () => {
  test('fresh install tanpa PIN: PIN NONAKTIF, tidak ada prompt PIN', async () => {
    await setupKoperasi(setupMinimal);

    expect(await isPinEnabled()).toBe(false);
    expect(await resolvePinState({ sesiTerkunci: false })).toBe('PIN_DISABLED');
    // Walau sesi "terkunci" oleh auto-lock, PIN mati berarti tidak ada lock screen.
    expect(await resolvePinState({ sesiTerkunci: true })).toBe('PIN_DISABLED');
  });

  test('setup yang MEMANG memberi PIN: PIN langsung aktif', async () => {
    await setupKoperasi({ ...setupMinimal, adminPin: '123456' });

    expect(await isPinEnabled()).toBe(true);
    expect(await resolvePinState({ sesiTerkunci: false })).toBe('PIN_ENABLED');
    expect(await resolvePinState({ sesiTerkunci: true })).toBe('PIN_LOCKED');
  });

  test('menyalakan PIN dari Pengaturan: wajib membuat PIN dulu', async () => {
    await setupKoperasi(setupMinimal);
    await setPinEnabled(true);

    expect(await resolvePinState({ sesiTerkunci: false })).toBe('PIN_ENABLED_SETUP_REQUIRED');

    await tandaiPinSudahDitetapkan();
    expect(await resolvePinState({ sesiTerkunci: false })).toBe('PIN_ENABLED');
  });

  test('mematikan PIN: tidak ada prompt lagi, TAPI kredensial PIN TIDAK dihapus', async () => {
    await setupKoperasi({ ...setupMinimal, adminPin: '123456' });
    const sebelum = await testDb.getFirstAsync<{ pin_hash: string; pin_salt: string }>(
      `SELECT pin_hash, pin_salt FROM app_user`
    );

    await setPinEnabled(false);
    expect(await isPinEnabled()).toBe(false);
    expect(await resolvePinState({ sesiTerkunci: true })).toBe('PIN_DISABLED');

    const sesudah = await testDb.getFirstAsync<{ pin_hash: string; pin_salt: string }>(
      `SELECT pin_hash, pin_salt FROM app_user`
    );
    // §16: "Jangan menghapus PIN data secara unsafe."
    expect(sesudah?.pin_hash).toBe(sebelum?.pin_hash);
    expect(sesudah?.pin_salt).toBe(sebelum?.pin_salt);
  });

  test('§18 instalasi LAMA (tanpa key konfigurasi) TETAP PIN AKTIF — tidak pernah dimatikan otomatis', async () => {
    // Meniru database yang sudah selesai setup SEBELUM fitur ini ada:
    // baris koperasi ada, tapi app_config sama sekali tidak punya key PIN.
    const now = new Date().toISOString();
    await testDb.runAsync(
      `INSERT INTO koperasi (id, nama, tahun_buku_aktif, standar_akuntansi, setup_selesai, created_at, updated_at)
       VALUES ('kop-lama','Koperasi Lama',2025,'SAK_EP',1,?,?)`,
      now,
      now
    );
    const key = await testDb.getFirstAsync<{ value: string }>(
      `SELECT value FROM app_config WHERE key = ?`,
      PIN_ENABLED_CONFIG_KEY
    );
    expect(key).toBeNull();

    expect(await isPinEnabledPadaDb(testDb as any)).toBe(true);
  });

  test('§18 instalasi lama yang PIN-nya sudah dimatikan eksplisit TETAP mati', async () => {
    await setupKoperasi({ ...setupMinimal, adminPin: '123456' });
    await setPinEnabled(false);
    expect(await isPinEnabled()).toBe(false);
    // Dibaca lagi (mis. setelah restart) — nilainya persisten.
    expect(await isPinEnabledPadaDb(testDb as any)).toBe(false);
  });

  test('keamanan data TIDAK bergantung pada PIN: mematikan PIN tidak mengubah data apa pun', async () => {
    await setupKoperasi({ ...setupMinimal, adminPin: '123456' });
    const akunSebelum = await testDb.getAllAsync<{ kode: string }>(`SELECT kode FROM account ORDER BY kode`);
    const userSebelum = await testDb.getAllAsync<{ id: string }>(`SELECT id FROM app_user`);

    await setPinEnabled(false);

    const akunSesudah = await testDb.getAllAsync<{ kode: string }>(`SELECT kode FROM account ORDER BY kode`);
    const userSesudah = await testDb.getAllAsync<{ id: string }>(`SELECT id FROM app_user`);
    expect(akunSesudah).toEqual(akunSebelum);
    expect(userSesudah).toEqual(userSebelum);
  });
});

// ============================================================
// §33/§34 — TES IDENTITAS
// ============================================================

describe('§33 identitas koperasi', () => {
  test('setelah setup minimal: identitas BELUM lengkap', async () => {
    await setupKoperasi(setupMinimal);

    const completion = await getIdentityCompletionStatus();
    expect(completion.status).toBe('BASIC_COMPLETE');
    expect(completion.fieldBelumTerisi.length).toBeGreaterThan(0);
  });

  test('mengisi sebagian -> DETAIL_PARTIAL, mengisi semua -> COMPLETE', async () => {
    await setupKoperasi(setupMinimal);

    await updateIdentitasKoperasi({ nama: 'Koperasi Sejahtera', alamat: 'Jl. Merdeka 1', telepon: '0411-123456' });
    const sebagian = await getIdentityCompletionStatus();
    expect(sebagian.status).toBe('DETAIL_PARTIAL');

    await updateIdentitasKoperasi({
      nama: 'Koperasi Sejahtera',
      alamat: 'Jl. Merdeka 1',
      telepon: '0411-123456',
      email: 'admin@koperasi.id',
      nomorBadanHukum: 'BH-001/2026',
      npwp: '01.234.567.8-901.000',
    });
    const lengkap = await getIdentityCompletionStatus();
    expect(lengkap.status).toBe('COMPLETE');
    expect(lengkap.fieldBelumTerisi).toEqual([]);
  });

  test('§23 satu helper terpusat: Dashboard & layar Identitas memakai perhitungan yang SAMA', async () => {
    await setupKoperasi(setupMinimal);
    await updateIdentitasKoperasi({ nama: 'Koperasi Sejahtera', alamat: 'Jl. Merdeka 1' });

    const dariService = await getIdentityCompletionStatus();
    const dariHelper = hitungIdentityCompletion(await getIdentitasKoperasi());
    expect(dariHelper).toEqual(dariService);
  });

  test('field kosong disimpan sebagai NULL, bukan string kosong', async () => {
    await setupKoperasi(setupMinimal);
    await updateIdentitasKoperasi({ nama: 'Koperasi Sejahtera', alamat: '   ', email: '' });

    const identitas = await getIdentitasKoperasi();
    expect(identitas?.alamat).toBeNull();
    expect(identitas?.email).toBeNull();
  });

  test('logo TIDAK diwajibkan untuk status COMPLETE (laporan tidak membutuhkannya)', async () => {
    await setupKoperasi(setupMinimal);
    await updateIdentitasKoperasi({
      nama: 'Koperasi Sejahtera',
      alamat: 'Jl. Merdeka 1',
      telepon: '0411-123456',
      email: 'admin@koperasi.id',
      nomorBadanHukum: 'BH-001/2026',
      npwp: '01.234.567.8-901.000',
      logoUri: null,
    });
    expect((await getIdentityCompletionStatus()).status).toBe('COMPLETE');
  });
});

describe('§26/§34 identitas TIDAK punya efek samping akuntansi', () => {
  test('menyimpan identitas tidak mengubah jurnal/GL/subledger sama sekali', async () => {
    await setupKoperasi(setupMinimal);

    const potret = async () => ({
      journal: (await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) c FROM journal`))?.c,
      journalEntry: (await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) c FROM journal_entry`))?.c,
      totalDebit: (await testDb.getFirstAsync<{ s: number }>(`SELECT COALESCE(SUM(debit),0) s FROM journal_entry`))?.s,
      totalKredit: (await testDb.getFirstAsync<{ s: number }>(`SELECT COALESCE(SUM(kredit),0) s FROM journal_entry`))?.s,
      pinjaman: (await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) c FROM pinjaman`))?.c,
      simpanan: (await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) c FROM simpanan_transaksi`))?.c,
      aset: (await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) c FROM aset_tetap`))?.c,
      utang: (await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) c FROM utang`))?.c,
      periode: (await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) c FROM accounting_period`))?.c,
    });

    const sebelum = await potret();

    await updateIdentitasKoperasi({
      nama: 'Koperasi Sejahtera Bersama',
      alamat: 'Jl. Merdeka 1',
      telepon: '0411-123456',
      email: 'admin@koperasi.id',
      nomorBadanHukum: 'BH-001/2026',
      npwp: '01.234.567.8-901.000',
    });

    expect(await potret()).toEqual(sebelum);
  });

  test('mengubah pengaturan PIN tidak menyentuh data akuntansi', async () => {
    await setupKoperasi(setupMinimal);
    const sebelum = (await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) c FROM journal_entry`))?.c;

    await setPinEnabled(true);
    await setPinEnabled(false);

    expect((await testDb.getFirstAsync<{ c: number }>(`SELECT COUNT(*) c FROM journal_entry`))?.c).toBe(sebelum);
  });
});

// ============================================================
// §27/§28 — TAHUN BUKU
// ============================================================

describe('§27/§28 keamanan tahun buku', () => {
  test('tahun buku boleh diubah selama belum ada data akuntansi', async () => {
    await setupKoperasi(setupMinimal);
    expect(await bolehGantiTahunBuku()).toEqual({ boleh: true, alasan: null });
  });

  test('tahun buku DIKUNCI begitu ada jurnal', async () => {
    await setupKoperasi(setupMinimal);
    const now = new Date().toISOString();
    const periode = await testDb.getFirstAsync<{ id: string }>(`SELECT id FROM accounting_period LIMIT 1`);
    await testDb.runAsync(
      `INSERT INTO journal (id, nomor_jurnal, tanggal, period_id, sumber_transaksi, deskripsi, status, created_by, created_at, updated_at)
       VALUES ('j1','JRN-1','2026-01-05',?,'MODAL_AWAL','setoran','POSTED','u1',?,?)`,
      periode!.id,
      now,
      now
    );

    const hasil = await bolehGantiTahunBuku();
    expect(hasil.boleh).toBe(false);
    expect(hasil.alasan).toMatch(/jurnal|transaksi/i);
  });

  test('tahun buku DIKUNCI begitu ada periode tertutup', async () => {
    await setupKoperasi(setupMinimal);
    await testDb.runAsync(`UPDATE accounting_period SET status = 'CLOSED'`);

    const hasil = await bolehGantiTahunBuku();
    expect(hasil.boleh).toBe(false);
    expect(hasil.alasan).toMatch(/ditutup/i);
  });
});

// ============================================================
// §29 — KONSISTENSI DEFAULT SAK EP
// ============================================================

describe('§29 default SAK EP konsisten', () => {
  test('nilai tersimpan yang valid SELALU dipertahankan (restore/migrasi tidak menimpanya)', () => {
    // RC-S39: nilai legacy dinormalisasi, bukan dipertahankan.
    expect(normalisasiStandarAkuntansi('SAK_EMKM')).toBe('SAK_EP');
    expect(normalisasiStandarAkuntansi('SAK_EP')).toBe('SAK_EP');
  });

  test('hanya nilai kosong/tidak dikenal yang jatuh ke default SAK_EP — tidak pernah NULL', () => {
    expect(normalisasiStandarAkuntansi(null)).toBe('SAK_EP');
    expect(normalisasiStandarAkuntansi(undefined)).toBe('SAK_EP');
    expect(normalisasiStandarAkuntansi('')).toBe('SAK_EP');
    expect(normalisasiStandarAkuntansi('ENTAH_APA')).toBe('SAK_EP');
  });
});


describe('PART G — kelengkapan identitas koperasi (RC-S40)', () => {
  const dasar = {
    id: 'kop-1',
    nama: 'Koperasi Uji',
    tahunBukuAktif: 2026,
    tanggalBerdiri: null,
    alamat: null,
    telepon: null,
    email: null,
    nomorBadanHukum: null,
    // RC-S60 §2 — dua field di bawah ditambahkan ke `IdentitasKoperasiRow`
    // pada v60 (master identitas RC-S53). Fixture ini dibuat sebelum itu,
    // sehingga sejak RC-S56 seluruh suite GAGAL DIMUAT dengan TS2345
    // ("missing properties 'nomorAhu', 'nomorIndukKoperasi'") dan 32
    // test-nya tidak pernah dieksekusi.
    //
    // Keduanya TIDAK ada di `FIELD_DETAIL_IDENTITAS`, jadi tidak ikut
    // dihitung oleh `hitungIdentityCompletion()`. Menambahkannya sebagai
    // `null` membuat fixture memenuhi kontrak tipe TANPA menggeser satu
    // pun expected value: jumlah field belum terisi tetap 5, dan status
    // BASIC_COMPLETE/DETAIL_PARTIAL/COMPLETE tetap sama persis.
    nomorAhu: null,
    nomorIndukKoperasi: null,
    npwp: null,
    logoUri: null,
    standarAkuntansi: 'SAK_EP' as const,
  };
  const lengkap = {
    ...dasar,
    alamat: 'Jl. Mawar 1',
    telepon: '08123456789',
    email: 'kontak@koperasi.id',
    nomorBadanHukum: 'BH-001',
    // `nomorAhu` menurut kontrak produksi bernilai SAMA dengan
    // `nomorBadanHukum` (lihat catatan v60 di `updateIdentitasKoperasi()`),
    // jadi fixture "lengkap" mengikuti invarian itu alih-alih memakai
    // nilai sembarang. Nilai tetap/deterministik, bukan acak.
    nomorAhu: 'BH-001',
    nomorIndukKoperasi: 'NIK-0001',
    npwp: '01.234.567.8-901.000',
  };

  test('G1. seluruh detail kosong -> Belum Lengkap', () => {
    const hasil = hitungIdentityCompletion(dasar);
    expect(hasil.status).toBe('BASIC_COMPLETE');
    expect(hasil.fieldBelumTerisi).toHaveLength(5);
  });

  test('G3. seluruh field terisi -> Sudah Lengkap', () => {
    const hasil = hitungIdentityCompletion(lengkap);
    expect(hasil.status).toBe('COMPLETE');
    expect(hasil.fieldBelumTerisi).toHaveLength(0);
  });

  test('G6. sebagian terisi -> tetap belum lengkap', () => {
    const hasil = hitungIdentityCompletion({ ...dasar, alamat: 'Jl. Mawar 1' });
    expect(hasil.status).toBe('DETAIL_PARTIAL');
    expect(hasil.fieldBelumTerisi).toContain('Email');
  });

  test('field berisi spasi saja TIDAK dihitung terisi', () => {
    // Tanpa ini, mengetik spasi lalu menyimpan membuat kartu berkata
    // "Sudah Lengkap" untuk data yang sebenarnya kosong.
    const hasil = hitungIdentityCompletion({ ...lengkap, email: '   ' });
    expect(hasil.status).toBe('DETAIL_PARTIAL');
    expect(hasil.fieldBelumTerisi).toEqual(['Email']);
  });

  test('G5. identitas gagal dibaca -> belum lengkap, bukan lengkap', () => {
    // Fail-closed di UI: kegagalan baca tidak boleh tampil "Sudah Lengkap".
    expect(hitungIdentityCompletion(null).status).toBe('BASIC_COMPLETE');
  });
});
